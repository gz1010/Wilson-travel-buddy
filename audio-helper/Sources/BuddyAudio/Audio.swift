import Accelerate
import CoreML
import Foundation
import SpeakerKit
import TTSKit
import WhisperKit

let sampleRate = WhisperKit.sampleRate // 16 kHz

/// Finds where speech starts and stops in a stream of microphone chunks,
/// from loudness against an adaptive noise floor.
struct Endpointer {
    var silenceToEnd: Double = 1.0 // seconds of quiet that end an utterance
    var minSpeech: Double = 0.3
    private(set) var noiseFloor: Float = 0.003
    private(set) var inSpeech = false
    /// Whether the last chunk was speech (for timing when the person stopped talking).
    private(set) var chunkIsSpeech = false
    private var speechSamples = 0
    private var silenceSamples = 0
    /// Loudness of recent chunks. The noise floor is the quietest of the last few seconds:
    /// speech always has gaps, so it stays low while someone talks, but a new steady noise
    /// (a fan, a café) raises it within a few seconds and can't lock speech on.
    private var recent: [Float] = []

    /// Returns true when an utterance has just ended.
    mutating func feed(_ chunk: [Float]) -> (level: Float, ended: Bool) {
        var rms: Float = 0
        vDSP_rmsqv(chunk, 1, &rms, vDSP_Length(chunk.count))
        recent.append(rms)
        let window = max(1, Int(3.0 * Double(sampleRate) / Double(max(chunk.count, 1))))
        if recent.count > window { recent.removeFirst(recent.count - window) }
        noiseFloor = max(0.001, recent.min() ?? rms)
        let speech = rms > max(0.006, noiseFloor * 3)
        chunkIsSpeech = speech
        if speech {
            speechSamples += chunk.count
            silenceSamples = 0
            if Double(speechSamples) / Double(sampleRate) >= minSpeech { inSpeech = true }
        } else {
            silenceSamples += chunk.count
            if !inSpeech, Double(silenceSamples) / Double(sampleRate) > 0.5 { speechSamples = 0 }
        }
        let ended = inSpeech && Double(silenceSamples) / Double(sampleRate) >= silenceToEnd
        if ended { reset() }
        return (min(1, rms * 12), ended)
    }

    mutating func reset() {
        inSpeech = false
        speechSamples = 0
        silenceSamples = 0
    }
}

/// Remembers each speaker's voice print (a SpeakerKit centroid embedding) and
/// matches new utterances to them. SpeakerKit sets no universal threshold;
/// tune --voice-threshold on the demo room.
struct VoicePrints {
    var threshold: Float
    private var prints: [[Float]] = []

    /// Whose voice this is (prints.count for someone new), without learning from it: the translator
    /// asks before it knows whether the sentence was speech at all.
    func match(_ e: [Float]) -> Int {
        let sims = prints.map { cosine($0, e) }
        log("voice print similarity to known speakers: \(sims.map { String(format: "%.2f", $0) }) (threshold \(threshold))")
        if let best = sims.indices.max(by: { sims[$0] < sims[$1] }), sims[best] >= threshold || prints.count >= 2 {
            return best
        }
        return prints.count
    }

    /// Learns from a sentence that was speech: a known speaker's print moves toward it; a new one is kept.
    @discardableResult
    mutating func learn(_ e: [Float], as id: Int) -> Int {
        guard id < prints.count else {
            prints.append(e)
            return prints.count - 1
        }
        prints[id] = zip(prints[id], e).map { $0 * 0.7 + $1 * 0.3 }
        return id
    }

    mutating func reset() { prints = [] }

    private func cosine(_ a: [Float], _ b: [Float]) -> Float {
        guard a.count == b.count, !a.isEmpty else { return -1 }
        var dot: Float = 0, na: Float = 0, nb: Float = 0
        vDSP_dotpr(a, 1, b, 1, &dot, vDSP_Length(a.count))
        vDSP_svesq(a, 1, &na, vDSP_Length(a.count))
        vDSP_svesq(b, 1, &nb, vDSP_Length(b.count))
        return dot / (sqrt(na) * sqrt(nb) + 1e-9)
    }
}

/// The languages Argmax's voice (Qwen3-TTS) speaks, as Whisper codes: the translator listens for
/// these unless the app names its own (see ttsLanguage in Models.swift).
let voiceLanguages = ["en", "es", "fr", "de", "it", "pt", "ja", "ko", "zh", "ru"]

/// Whisper's probability for a language, over all of its ~100 languages.
typealias LanguageOdds = [(code: String, p: Float)]

/// The translator's language for each voice. Whisper's guess on one short sentence can be wrong
/// ("Sí." or "OK" heard as Italian), so a known speaker keeps their language unless Whisper is
/// sure of another one; a new voice, or a sentence without a voice print, takes Whisper's pick.
struct SpeakerLanguages {
    private var bySpeaker: [Int: String] = [:]

    /// How sure Whisper must be to move a known speaker to another language: surer on short
    /// sentences. `seconds` is the whole sentence as cut, with about 1.5 s of quiet around the speech
    /// (the half second kept before it and the second of silence that ended it), so 2.5 s is a word
    /// or two. Whisper gave "Sí." 0.91 and "Obrigado." 0.69 (Portuguese, against 0.27 Spanish) when
    /// cut like that from macOS voices.
    static func switchConfidence(seconds: Double) -> Float {
        seconds < 2.5 ? 0.9 : seconds < 4 ? 0.75 : 0.6
    }

    /// odds: the allowed languages, most likely first. Nil only when there are no odds and no memory.
    func choose(_ odds: LanguageOdds, speaker: Int?, seconds: Double) -> String? {
        let known = speaker.flatMap { bySpeaker[$0] }
        guard let best = odds.first else { return known }
        guard let known, known != best.code, odds.contains(where: { $0.code == known }) else { return best.code }
        return best.p >= Self.switchConfidence(seconds: seconds) ? best.code : known
    }

    mutating func remember(_ code: String, for speaker: Int) { bySpeaker[speaker] = code }

    mutating func reset() { bySpeaker = [:] }
}

/// "fr 0.93, it 0.04, es 0.01" for the log.
func oddsText(_ odds: LanguageOdds) -> String {
    odds.prefix(3).map { "\($0.code) \(String(format: "%.2f", $0.p))" }.joined(separator: ", ")
}

final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var _value = false
    var value: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _value }
        set { lock.lock(); _value = newValue; lock.unlock() }
    }
}

/// When the app last sent anything. The wake word keeps the microphone open, so it stops when the
/// app has gone quiet (quit or crashed): the server does not report disconnects.
final class Stamp: @unchecked Sendable {
    private let lock = NSLock()
    private var at = Date()
    func touch() { lock.lock(); at = Date(); lock.unlock() }
    var age: TimeInterval { lock.lock(); defer { lock.unlock() }; return Date().timeIntervalSince(at) }
}

/// One speech stream's timeline: where each sentence's audio starts and ends among the seconds of
/// audio handed to the player, and which speak.started / speak.done have been sent. It also keeps
/// the loudness of every 20 ms of that audio, for speak.level at the playhead.
final class SpeechTimeline: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [(id: String, start: Double, end: Double?)] = []
    private var told: Set<String> = []
    private var finished: Set<String> = []
    private var seconds = 0.0
    private var _flushed = false
    static let hop = 0.02
    private var envelope: [Float] = []
    private var carry: [Float] = []

    /// True once the pre-buffer has been released and audio plays as it arrives.
    var flushed: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _flushed }
        set { lock.lock(); _flushed = newValue; lock.unlock() }
    }
    var audioSeconds: Double { lock.lock(); defer { lock.unlock() }; return seconds }
    /// Audio handed to the player: counts its seconds and measures its loudness.
    func add(audio samples: [Float], rate: Double) {
        guard rate > 0 else { return }
        let hopSamples = max(1, Int(rate * Self.hop))
        lock.lock()
        seconds += Double(samples.count) / rate
        carry.append(contentsOf: samples)
        var i = 0
        while carry.count - i >= hopSamples {
            var rms: Float = 0
            carry.withUnsafeBufferPointer { vDSP_rmsqv($0.baseAddress! + i, 1, &rms, vDSP_Length(hopSamples)) }
            envelope.append(rms)
            i += hopSamples
        }
        carry.removeFirst(i)
        lock.unlock()
    }
    /// The loudness (RMS) of the audio at `t` seconds: the louder of this 20 ms and the next.
    func loudness(at t: Double) -> Float {
        lock.lock(); defer { lock.unlock() }
        let i = Int(t / Self.hop)
        guard t >= 0, i < envelope.count else { return 0 }
        return max(envelope[i], i + 1 < envelope.count ? envelope[i + 1] : 0)
    }
    /// For the log: the median and 95th-percentile loudness of the whole stream.
    func loudnessSummary() -> (median: Float, p95: Float) {
        lock.lock(); defer { lock.unlock() }
        let sorted = envelope.filter { $0 > 0.001 }.sorted()
        guard !sorted.isEmpty else { return (0, 0) }
        return (sorted[sorted.count / 2], sorted[min(sorted.count - 1, sorted.count * 95 / 100)])
    }
    func begin(_ id: String) { lock.lock(); entries.append((id, seconds, nil)); lock.unlock() }
    func end(_ id: String) {
        lock.lock()
        if let i = entries.firstIndex(where: { $0.id == id }) { entries[i].end = seconds }
        lock.unlock()
    }
    /// What to report now that the playhead is at `t` seconds.
    func due(at t: Double) -> (started: [String], done: [String]) {
        lock.lock(); defer { lock.unlock() }
        var started: [String] = []
        var done: [String] = []
        guard t > 0 else { return (started, done) }
        for e in entries {
            if !told.contains(e.id), t >= e.start {
                told.insert(e.id)
                started.append(e.id)
            }
            if let end = e.end, end > e.start, told.contains(e.id), !finished.contains(e.id), t >= end - 0.03 {
                finished.insert(e.id)
                done.append(e.id)
            }
        }
        return (started, done)
    }
    /// Every sentence not reported done yet (the stream has ended).
    func remaining() -> [String] {
        lock.lock(); defer { lock.unlock() }
        let ids = entries.map(\.id).filter { !finished.contains($0) }
        finished.formUnion(ids)
        return ids
    }
}

/// Everything audio, driven by messages from the app. One listen or one
/// conversation at a time; speech is queued. While neither runs, the wake word may listen.
actor AudioService {
    enum Mode { case idle, listen, conversation, wake }

    private let models: ArgmaxModels
    private let send: (Outgoing) -> Void
    private let voices: [String: Qwen3Speaker]

    private var mode: Mode = .idle
    private var micTask: Task<Void, Never>?
    private var micContinuation: AsyncThrowingStream<[Float], Error>.Continuation?
    private var endpointer = Endpointer()
    private var utterance: [Float] = []
    /// Translator: the conversation's audio so far (last 90 s), diarized as a whole after each sentence.
    private var session: [Float] = []
    private let sessionLimit = 90 * sampleRate
    private var heardSpeech = false
    private var listenLanguage: String?
    private var languages: [String] = ["en"]
    private var muted = false
    private var prints: VoicePrints
    /// Translator: each voice print's language, so short sentences do not flip it.
    private var spokenLanguages = SpeakerLanguages()
    private var partialTask: Task<Void, Never>?
    private var finals: Task<Void, Never> = Task {}
    private var listenStarted = Date()
    /// A listen with no speech ends after this many seconds (listen.start's quietMs, else 8).
    private var listenQuiet = 8.0
    private var lastLevelSent = Date.distantPast
    private var startGeneration = 0
    /// Translator fallback: record only between turn.start and turn.end (one button per person).
    private var pushToTalk = false
    private var pttActive = false
    /// The app's id for the held button's turn, echoed on its final so the app never pairs by order.
    private var pttTurn: String?
    /// The held button's language: Whisper transcribes in it instead of guessing.
    private var pttLanguage: String?
    /// When the person last made a sound in a listen, for "end of speech → first audio".
    private var lastSpeechAt: Date?

    private var speech: Task<Void, Never> = Task {}
    private var speechGeneration = 0
    private let cancelSpeech = Flag()

    // Wake word state (see "Wake word" below).
    private enum WakePhase { case waiting, checking, capturing, finishing, skipping }
    /// The app asked for the wake word (wake.start) and has not taken it back (wake.stop).
    private var wakeWanted = false
    private var wakePhase = WakePhase.waiting
    private var wakeEndpointer: Endpointer = {
        var e = Endpointer()
        e.silenceToEnd = 0.7
        e.minSpeech = 0.25
        return e
    }()
    /// The sentence so far, with half a second from before it.
    private var wakeAudio: [Float] = []
    /// Its loudest chunk (RMS), against the loudness floor.
    private var wakeLoudest: Float = 0
    /// The sentence has ended; nothing more is added to it.
    private var wakeEnded = false
    /// Goes up with every new sentence, so a late reading of an old one is dropped.
    private var wakeSentence = 0
    private var wakeLastSpeech: Date?
    /// When Whisper was last asked about a sentence (at most wakeChecksPerMinute).
    private var wakeChecks: [Date] = []
    private var wakeResume: Task<Void, Never>?
    private var wakeStateSent = false
    /// No listening until then: the end of the helper's own voice.
    private var wakeQuietUntil = Date.distantPast
    /// When macOS last refused the microphone to the wake word.
    private var wakeRefusedAt: Date?
    private let wakeFloor: Float
    private let wakePrompt: [Int]?
    /// When the app last sent a message (main.swift touches it on every one).
    nonisolated let appContact = Stamp()

    init(models: ArgmaxModels, voiceThreshold: Float, voices: [String: Qwen3Speaker], wakeFloor: Float = 0.012, send: @escaping (Outgoing) -> Void) {
        self.models = models
        self.send = send
        self.voices = voices
        self.prints = VoicePrints(threshold: voiceThreshold)
        self.wakeFloor = wakeFloor
        // Whisper reads the name as "Wilson" (not "Willson", "Will son") with it as the previous text.
        // BUDDY_WAKE_PROMPT="" turns that off, for comparing.
        let prompt = ProcessInfo.processInfo.environment["BUDDY_WAKE_PROMPT"] ?? " Wilson"
        self.wakePrompt = prompt.isEmpty ? nil : models.whisper.tokenizer.map { tokenizer in
            tokenizer.encode(text: prompt).filter { $0 < tokenizer.specialTokens.specialTokenBegin }
        }
        // BUDDY_LANG_TEST=/a.aiff,/b.wav checks language detection without a microphone (see languageTest).
        if let test = ProcessInfo.processInfo.environment["BUDDY_LANG_TEST"], !test.isEmpty {
            let paths = test.split(separator: ",").map { String($0) }
            Task { await self.languageTest(paths) }
        }
        // BUDDY_WAKE_TEST=/a.aiff,/b.aiff runs files through the wake word in real time (see wakeTest).
        if let test = ProcessInfo.processInfo.environment["BUDDY_WAKE_TEST"], !test.isEmpty {
            let paths = test.split(separator: ",").map { String($0) }
            Task { await self.wakeTest(paths) }
        }
    }

    nonisolated func heardFromApp() { appContact.touch() }

    // MARK: Messages

    func handle(_ m: Incoming) async {
        defer { updateWakeState() }
        switch m.type {
        case "listen.start":
            listenQuiet = m.quietMs.map { max(1, Double($0) / 1000) } ?? 8
            await start(.listen, languages: [], listenLanguage: m.language)
        case "listen.stop":
            if mode == .listen {
                if micTask == nil { startGeneration += 1; mode = .idle; send(.listenDone()); scheduleWakeResume() } // still waiting for permission
                else { await endListen() }
            } else if mode == .wake, wakePhase == .capturing {
                // A tap while Wilson listens after his name: what was said so far is the question.
                wakeEnded = true
                finishWake()
            }
        case "wake.start":
            // Also the app's keepalive while it wants the wake word: sent again every few seconds.
            wakeWanted = true
            if mode == .idle, wakeRefusedAt.map({ Date().timeIntervalSince($0) > 60 }) ?? true {
                wakeResume?.cancel()
                await start(.wake, languages: [], listenLanguage: "en")
            }
        case "wake.stop":
            wakeWanted = false
            stopWake()
        case "conversation.start":
            resetConversation()
            pushToTalk = m.pushToTalk ?? false
            // Each sentence may be in any of the app's languages (the first is the traveller's);
            // without a list, any language the voice speaks.
            let allowed = (m.languages ?? []).filter { !$0.isEmpty }
            await start(.conversation, languages: allowed.isEmpty ? voiceLanguages : allowed, listenLanguage: nil)
        case "turn.start":
            guard mode == .conversation, pushToTalk else { break }
            if pttActive { pttActive = false; finishTurnNow() } // a press without a release: close it first
            utterance = []
            heardSpeech = false
            endpointer.reset()
            pttTurn = m.turn
            pttLanguage = m.language.flatMap { languages.contains($0) ? $0 : nil }
            pttActive = true
        case "turn.end":
            guard mode == .conversation, pushToTalk, pttActive, m.turn == nil || m.turn == pttTurn else { break }
            pttActive = false
            finishTurnNow()
        case "conversation.stop":
            guard mode == .conversation else { break } // never stops a listen or the wake word
            startGeneration += 1
            stopMic()
            mode = .idle
            resetConversation()
            scheduleWakeResume()
        case "mute":
            muted = m.muted ?? false
            // A held push-to-talk turn keeps what was said before the translation started playing;
            // chunks are still dropped while muted, so the voice is never recorded.
            if !(mode == .conversation && pushToTalk && pttActive) {
                utterance = []
                endpointer.reset()
            }
            if muted, mode == .wake { resetWakeSentence() }
        case "speak": if let id = m.id, let text = m.text { speak(id: id, text: text, language: m.language ?? "en") }
        case "speak.stop":
            speechGeneration += 1
            cancelSpeech.value = true
            for s in sentences { sendDone(s.id) }
            sentences.removeAll()
            await models.tts.audioOutput.stopPlayback(waitForCompletion: false)
        default: break
        }
    }

    // MARK: Microphone

    private func start(_ newMode: Mode, languages: [String], listenLanguage: String?) async {
        stopMic()
        // A listen or a conversation takes the microphone from the wake word; it comes back after.
        wakeResume?.cancel()
        resetWakeSentence()
        mode = newMode
        startGeneration += 1
        let generation = startGeneration
        updateWakeState()
        guard await AudioProcessor.requestRecordPermission() else {
            mode = .idle
            // The wake word asks again at most once a minute (wake.start comes every few seconds), and says so once.
            if newMode != .wake || wakeRefusedAt == nil {
                send(.error("Microphone access was refused. Allow it in System Settings > Privacy & Security > Microphone."))
            }
            if newMode == .listen { send(.listenDone()) }
            if newMode == .wake { wakeRefusedAt = Date() }
            return
        }
        if newMode == .wake { wakeRefusedAt = nil }
        // A stop (or another start) arrived while we waited for permission.
        guard generation == startGeneration, mode == newMode else { return }
        if newMode != .wake {
            self.languages = languages
            self.listenLanguage = listenLanguage
        }
        utterance = []
        heardSpeech = false
        endpointer.reset()
        listenStarted = Date()
        lastSpeechAt = nil
        let (stream, continuation) = models.whisper.audioProcessor.startStreamingRecordingLive(inputDeviceID: nil)
        micContinuation = continuation
        micTask = Task { [weak self] in
            do {
                // The generation drops chunks still buffered from a stream that has been replaced.
                for try await chunk in stream { await self?.onChunk(chunk, generation: generation) }
            } catch {
                await self?.report(error)
            }
        }
        if newMode == .wake {
            updateWakeState()
            return
        }
        partialTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 600_000_000)
                await self?.partial()
            }
        }
    }

    private func report(_ error: Error) { send(.error("Microphone: \(error.localizedDescription)")) }

    private func stopMic() {
        partialTask?.cancel()
        partialTask = nil
        // Not cancelled: endListen() runs inside micTask, and a cancelled task makes WhisperKit
        // throw CancellationError. Finishing the stream below ends the loop instead.
        micTask = nil
        models.whisper.audioProcessor.stopRecording()
        micContinuation?.finish()
        micContinuation = nil
    }

    private func onChunk(_ chunk: [Float], generation: Int) async {
        guard generation == startGeneration, mode != .idle else { return }
        if mode == .wake {
            onWakeChunk(chunk)
            return
        }
        guard !muted else { return }
        // Push-to-talk: nothing is recorded until someone holds their button.
        if mode == .conversation, pushToTalk, !pttActive { return }
        // Push-to-talk cap: keep the first 30 s and wait for the release, which always sends the final.
        if mode == .conversation, pushToTalk, utterance.count >= 30 * sampleRate { return }
        let (level, ended) = endpointer.feed(chunk)
        if endpointer.chunkIsSpeech { lastSpeechAt = Date() }
        if Date().timeIntervalSince(lastLevelSent) > 0.1 {
            send(.level(level))
            lastLevelSent = Date()
        }
        if endpointer.inSpeech || (pushToTalk && pttActive) { heardSpeech = true }
        // Keep a little audio before speech starts so the first word is not clipped.
        utterance.append(contentsOf: chunk)
        if mode == .conversation {
            session.append(contentsOf: chunk)
            if session.count > sessionLimit { session.removeFirst(session.count - sessionLimit) }
        }
        if !heardSpeech, utterance.count > sampleRate { utterance.removeFirst(utterance.count - sampleRate / 2) }

        switch mode {
        case .listen:
            let waited = Date().timeIntervalSince(listenStarted)
            if ended || (heardSpeech && waited > 20) || (!heardSpeech && waited > listenQuiet) { await endListen() }
        case .conversation:
            if !pushToTalk, ended || (heardSpeech && utterance.count > 15 * sampleRate) {
                finishTurnNow()
            }
        case .idle, .wake: break
        }
    }

    /// What a queued sentence needs, captured when it ends: the session may change before it runs.
    struct TurnContext {
        let generation: Int
        let pushToTalk: Bool
        let languages: [String]
        let forcedLanguage: String?
        let turn: String?
    }

    /// Hands the current sentence to the translator pipeline (transcribe, label the speaker), in order.
    private func finishTurnNow() {
        endpointer.reset()
        let audio = utterance
        utterance = []
        heardSpeech = false
        let ctx = TurnContext(
            generation: startGeneration,
            pushToTalk: pushToTalk,
            languages: languages,
            forcedLanguage: pushToTalk ? pttLanguage : nil,
            turn: pushToTalk ? pttTurn : nil
        )
        let previous = finals
        let snapshot = session
        let range = max(0, snapshot.count - audio.count) ..< snapshot.count
        finals = Task { [weak self] in
            await previous.value
            await self?.finishConversationTurn(audio, session: snapshot, range: range, ctx: ctx)
        }
    }

    private func resetConversation() {
        finals.cancel()
        finals = Task {}
        prints.reset()
        spokenLanguages.reset()
        session = []
        utterance = []
        heardSpeech = false
        pttActive = false
        pttTurn = nil
        pttLanguage = nil
    }

    private func partial() async {
        guard mode == .listen || mode == .conversation, heardSpeech, utterance.count > sampleRate / 2 else { return }
        let lang = mode == .listen ? listenLanguage : (pushToTalk && pttActive ? pttLanguage : nil)
        let (text, heard) = await transcribe(utterance, language: lang)
        // In a conversation, the language heard so far (if it is one of the app's) tells the app who is talking.
        let language = mode == .conversation ? (lang ?? heard.flatMap { languages.contains($0) ? $0 : nil }) : nil
        if !text.isEmpty, mode != .idle { send(.partial(text: text, speaker: nil, language: language)) }
    }

    // MARK: Voice loop

    private func endListen() async {
        let audio = utterance
        let spoke = heardSpeech
        stopMic()
        mode = .idle
        let endedAt = lastSpeechAt ?? Date()
        if spoke {
            let language = listenLanguage
            let (text, lang) = await Task { await self.transcribe(audio, language: language, confirmedSpeech: true) }.value
            if !text.isEmpty { send(.final(text: text, language: lang ?? language, speaker: nil)) }
        }
        send(.listenDone(sinceEndMs: spoke ? Int(Date().timeIntervalSince(endedAt) * 1000) : nil))
        scheduleWakeResume()
        updateWakeState()
    }

    // MARK: Wake word

    // "Wilson, …" without a tap. While the app wants it (wake.start) and nothing else uses the
    // microphone (no listen, no conversation), the helper keeps the microphone open and cuts the
    // sound into sentences with its own Endpointer. Whisper reads only the start of each loud
    // enough sentence (the first ~2 s; a short sentence whole, never more than 6 s), in English,
    // with "Wilson" as the previous text. If it starts with the name, the app hears wake.heard
    // while the person is still talking, and wake {text} with the rest of the sentence when they
    // stop. Audio is dropped while the app's own voice plays (mute) or the helper speaks, and
    // nothing leaves the Mac: Argmax's Whisper runs here like everything else.

    /// Seconds into a sentence (with the half second kept from before it) when Whisper checks it.
    private let wakeCheckAt = 2.0
    /// The most Whisper reads to decide, for a sentence that has not been checked yet.
    private let wakeMaxCheck = 6.0
    /// A sentence after the name ends after this long at most (as a listen does).
    private let wakeMaxSentence = 20.0
    /// A busy café: at most this many checks a minute; other sentences are skipped.
    private let wakeChecksPerMinute = 20

    private func onWakeChunk(_ chunk: [Float]) {
        if appContact.age > 20 {
            // wake.start arrives every few seconds while the app wants the wake word.
            log("Wake word: nothing from the app for 20 s, so it has gone; microphone off")
            wakeWanted = false
            stopWake()
            return
        }
        if muted || speaking || Date() < wakeQuietUntil {
            if wakePhase != .waiting || !wakeAudio.isEmpty { resetWakeSentence() }
            return
        }
        // A sentence that has ended waits for Whisper; the next one starts afterwards.
        if wakeEnded { return }
        var rms: Float = 0
        vDSP_rmsqv(chunk, 1, &rms, vDSP_Length(chunk.count))
        let (level, ended) = wakeEndpointer.feed(chunk)
        if wakeEndpointer.chunkIsSpeech {
            wakeLastSpeech = Date()
            wakeLoudest = max(wakeLoudest, rms)
        }
        // After the name, Wilson's listening rings follow the voice, as in a listen.
        if wakePhase == .capturing, Date().timeIntervalSince(lastLevelSent) > 0.1 {
            send(.level(level))
            lastLevelSent = Date()
        }
        if wakePhase == .skipping {
            if ended { resetWakeSentence() }
            return
        }
        wakeAudio.append(contentsOf: chunk)
        let seconds = Double(wakeAudio.count) / Double(sampleRate)
        switch wakePhase {
        case .waiting:
            if ended {
                wakeEnded = true
                checkWake() // a short sentence: all of it
            } else if !wakeEndpointer.inSpeech {
                // Keep half a second from before speech starts, so the first word is not clipped.
                if wakeAudio.count > sampleRate { wakeAudio.removeFirst(wakeAudio.count - sampleRate / 2) }
            } else if seconds >= wakeCheckAt {
                checkWake() // the start of a longer one; it goes on being recorded meanwhile
            }
        case .checking:
            if ended || seconds > wakeMaxSentence { wakeEnded = true }
        case .capturing:
            if ended || seconds > wakeMaxSentence {
                wakeEnded = true
                finishWake()
            }
        case .finishing, .skipping:
            break
        }
    }

    /// Has Whisper read the start of the sentence, if it is loud enough and the rate allows.
    private func checkWake() {
        let now = Date()
        wakeChecks.removeAll { now.timeIntervalSince($0) > 60 }
        // Too quiet to be someone talking to the Mac (a far-off voice, the TV), or too many checks.
        guard wakeLoudest >= wakeFloor, wakeChecks.count < wakeChecksPerMinute else {
            if wakeEnded { resetWakeSentence() } else { wakePhase = .skipping }
            return
        }
        wakeChecks.append(now)
        wakePhase = .checking
        let audio = Array(wakeAudio.prefix(Int(wakeMaxCheck * Double(sampleRate))))
        let sentence = wakeSentence
        Task { [weak self] in
            guard let self else { return }
            let text = await self.readWake(audio, check: true)
            await self.wakeChecked(text, sentence: sentence, length: audio.count)
        }
    }

    private func wakeChecked(_ text: String, sentence: Int, length: Int) {
        guard sentence == wakeSentence, mode == .wake, wakePhase == .checking else { return }
        guard let rest = WakeWord.parse(text) else {
            if !text.isEmpty { log("wake word: not for Wilson: \(text)") }
            if wakeEnded { resetWakeSentence() } else { wakePhase = .skipping }
            return
        }
        log("wake word: heard \(text)")
        if wakeEnded, length >= wakeAudio.count {
            sendWake(rest, heard: text) // that was the whole sentence
        } else if wakeEnded {
            finishWake()
        } else {
            wakePhase = .capturing
            log("wake word -> app: wake.heard \(String(reflecting: rest))")
            send(.wakeHeard(text: rest))
        }
    }

    /// The sentence after the name has ended (or was cut short): Whisper reads all of it.
    private func finishWake() {
        guard wakePhase != .finishing else { return }
        wakePhase = .finishing
        let audio = wakeAudio
        let sentence = wakeSentence
        Task { [weak self] in
            guard let self else { return }
            let text = await self.readWake(audio, check: false)
            await self.wakeFinished(text, sentence: sentence)
        }
    }

    private func wakeFinished(_ text: String, sentence: Int) {
        guard sentence == wakeSentence, mode == .wake else { return }
        log("wake word: whole sentence \(text)")
        // The check heard the name; if the whole reading lost it, the app gets the sentence as read.
        sendWake(WakeWord.parse(text) ?? text, heard: text)
    }

    private func sendWake(_ rest: String, heard: String) {
        let since = wakeLastSpeech.map { Int(Date().timeIntervalSince($0) * 1000) }
        log("wake word -> app: wake \(String(reflecting: rest))\(since.map { ", \($0) ms after the speech ended" } ?? "")")
        send(.wake(text: rest, heard: heard, sinceEndMs: since))
        resetWakeSentence()
    }

    /// Whisper, in English, with the name as the previous text. A check reads a few seconds and
    /// takes Whisper's first reading (no retries at higher temperatures), so it stays quick.
    private func readWake(_ audio: [Float], check: Bool) async -> String {
        let options = DecodingOptions(
            task: .transcribe,
            language: "en",
            temperature: 0,
            temperatureFallbackCount: check ? 0 : 2,
            sampleLength: check ? 64 : Constants.maxTokenContext,
            usePrefillPrompt: true,
            detectLanguage: false,
            skipSpecialTokens: true,
            withoutTimestamps: true,
            promptTokens: wakePrompt
        )
        do {
            let results = try await models.whisper.transcribe(audioArray: audio, decodeOptions: options)
            return results.map(\.text).joined(separator: " ")
                .replacingOccurrences(of: "<\\|[^|]*\\|>", with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            log("Wake word transcription failed: \(error)")
            return ""
        }
    }

    private func resetWakeSentence() {
        wakeSentence += 1
        wakePhase = .waiting
        wakeAudio = []
        wakeLoudest = 0
        wakeEnded = false
        wakeEndpointer.reset()
    }

    private func stopWake() {
        wakeResume?.cancel()
        wakeResume = nil
        resetWakeSentence()
        if mode == .wake {
            startGeneration += 1
            stopMic()
            mode = .idle
        }
        updateWakeState()
    }

    /// After a listen or a conversation, the wake word comes back if the app still wants it.
    private func scheduleWakeResume(after seconds: Double = 0.5) {
        wakeResume?.cancel()
        guard wakeWanted else { return }
        wakeResume = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self?.resumeWake()
        }
    }

    private func resumeWake() async {
        wakeResume = nil
        guard wakeWanted, mode == .idle else { return }
        await start(.wake, languages: [], listenLanguage: "en")
    }

    /// Tells the app when the wake word starts or stops listening.
    private func updateWakeState() {
        let listening = mode == .wake && micTask != nil && !muted && !speaking
        guard listening != wakeStateSent else { return }
        wakeStateSent = listening
        send(.wakeState(listening: listening))
    }

    /// BUDDY_WAKE_TEST=/a.aiff,/b.aiff: on start, plays each file (16 kHz after loading) into the
    /// wake word in real time, between a second of near-silence before and two after, as if the
    /// microphone heard it, and logs what Whisper read and what the app would get. Check with
    /// `say -o wake.aiff "Wilson, where is the cathedral?"`. Needs no app; the helper carries on after.
    private func wakeTest(_ paths: [String]) async {
        for path in paths {
            guard let audio = try? AudioProcessor.loadAudioAsFloatArray(fromPath: path) else {
                log("wake test: could not read \(path)")
                continue
            }
            log("wake test \(URL(fileURLWithPath: path).lastPathComponent) (\(String(format: "%.1f", Double(audio.count) / Double(sampleRate))) s)")
            mode = .wake
            resetWakeSentence()
            var noise = (0 ..< sampleRate).map { _ in Float.random(in: -0.0008 ... 0.0008) }
            let samples = noise + audio + noise + noise
            noise = []
            let chunk = sampleRate / 10
            var i = 0
            let started = Date()
            while i < samples.count {
                appContact.touch()
                guard mode == .wake else { break }
                onWakeChunk(Array(samples[i ..< min(samples.count, i + chunk)]))
                i += chunk
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            // Whisper may still be reading the last sentence.
            for _ in 0 ..< 100 where wakePhase != .waiting { try? await Task.sleep(nanoseconds: 100_000_000) }
            log("wake test \(URL(fileURLWithPath: path).lastPathComponent): done after \(String(format: "%.1f", Date().timeIntervalSince(started))) s")
            if mode == .wake { mode = .idle }
            resetWakeSentence()
        }
        log("wake test done")
    }

    // MARK: Translator

    private func finishConversationTurn(_ audio: [Float], session: [Float], range: Range<Int>, ctx: TurnContext) async {
        // A sentence from a conversation that has since stopped or restarted is dropped.
        func current() -> Bool { ctx.generation == startGeneration && mode == .conversation }
        guard current() else { return }
        // Push-to-talk: every release gets exactly one final with its turn id, even when nothing was heard.
        guard audio.count > sampleRate * 3 / 10 else {
            if ctx.pushToTalk { send(.final(text: "", language: ctx.forcedLanguage, speaker: nil, turn: ctx.turn)) }
            return
        }
        // The pressed button's language if there is one; otherwise Whisper picks among the app's
        // languages, and a known voice keeps its language unless Whisper is sure of another. So who
        // is speaking comes first, without learning their voice yet: this may turn out not to be speech.
        var lang = ctx.forcedLanguage ?? (ctx.languages.count == 1 ? ctx.languages.first : nil)
        let detect = lang == nil
        var voice: [Float]?
        var guess: Int?
        if detect {
            voice = await speakerVoice(audio, session: session, range: range)
            guard current() else { return }
            guess = voice.map { prints.match($0) }
            let odds = await languageOdds(audio, among: ctx.languages)
            guard current() else { return }
            lang = spokenLanguages.choose(odds, speaker: guess, seconds: Double(audio.count) / Double(sampleRate))
            log("language: \(oddsText(odds)) -> \(lang ?? "Whisper's own guess")\(guess.map { " (speaker \($0))" } ?? "")")
        }
        let (text, heard) = await transcribe(audio, language: lang, confirmedSpeech: true)
        guard current() else { return }
        // No pick (detection failed): Whisper guessed while transcribing; keep that if the app allows it.
        if lang == nil { lang = heard.flatMap { ctx.languages.contains($0) ? $0 : nil } }
        guard !text.isEmpty else {
            if ctx.pushToTalk { send(.final(text: "", language: lang, speaker: nil, turn: ctx.turn)) }
            return
        }
        // It was speech: Argmax labels the speaker (in both modes) and remembers their language.
        if !detect {
            voice = await speakerVoice(audio, session: session, range: range)
            guard current() else { return }
            guess = voice.map { prints.match($0) }
        }
        var speaker: Int?
        if let voice, let guess {
            let id = prints.learn(voice, as: guess)
            if let lang { spokenLanguages.remember(lang, for: id) }
            speaker = id
        }
        send(.final(text: text, language: lang, speaker: speaker, turn: ctx.turn))
    }

    /// This sentence's voice print. Diarizing the whole conversation is far more reliable than one
    /// short sentence alone, so that comes first; the sentence's own print is the fallback.
    private func speakerVoice(_ audio: [Float], session: [Float], range: Range<Int>) async -> [Float]? {
        if let centroid = await sessionVoice(session, sentence: range) { return centroid }
        return await sentenceVoice(audio)
    }

    /// Runs SpeakerKit over the conversation so far and returns the centroid of the speaker cluster
    /// that overlaps this sentence most. Matching it to the prints seen before (VoicePrints) keeps the
    /// speaker numbers stable from one run to the next.
    private func sessionVoice(_ session: [Float], sentence range: Range<Int>) async -> [Float]? {
        guard let speakers = models.speakers, range.count > sampleRate / 2 else { return nil }
        do {
            let result = try await speakers.diarize(audioArray: session, options: PyannoteDiarizationOptions())
            let s0 = Float(range.lowerBound) / Float(sampleRate)
            let s1 = Float(range.upperBound) / Float(sampleRate)
            var overlap: [Int: Float] = [:]
            for segment in result.segments {
                guard let id = segment.speaker.speakerId else { continue }
                let o = min(segment.endTime, s1) - max(segment.startTime, s0)
                if o > 0 { overlap[id, default: 0] += o }
            }
            log("conversation diarization: \(result.speakerCount) speakers; this sentence overlaps \(overlap.mapValues { String(format: "%.1fs", $0) })")
            guard let cluster = overlap.max(by: { $0.value < $1.value })?.key else { return nil }
            return result.speakerCentroidEmbeddings[cluster]
        } catch {
            log("Conversation diarization failed: \(error)")
            return nil
        }
    }

    private func sentenceVoice(_ audio: [Float]) async -> [Float]? {
        // Short sentences give unreliable voice prints; the app falls back to language for those.
        guard let speakers = models.speakers, audio.count > sampleRate * 3 / 2 else { return nil }
        do {
            let result = try await speakers.diarize(audioArray: audio, options: PyannoteDiarizationOptions(numberOfSpeakers: 1))
            return result.speakerCentroidEmbeddings.sorted(by: { $0.key < $1.key }).first?.value
        } catch {
            log("Voice print failed: \(error)")
            return nil
        }
    }

    // MARK: Language detection

    private struct DetectionError: Error { let reason: String }

    /// Whisper's probability for each of `allowed`, most likely first. This is the pass WhisperKit's
    /// detectLangauge makes (the encoder on the first 30 s, then one decoder step from
    /// <|startoftranscript|>), but it keeps every language's score: WhisperKit returns only the
    /// winner's. The probabilities are over all of Whisper's languages, so they say how sure it is,
    /// not only which of ours is likeliest. Falls back to WhisperKit's own detection.
    private func languageOdds(_ audio: [Float], among allowed: [String]) async -> LanguageOdds {
        let whisper = models.whisper
        do {
            guard let tokenizer = whisper.tokenizer else { throw DetectionError(reason: "no tokenizer") }
            let sot = tokenizer.specialTokens.startOfTranscriptToken
            let window = whisper.featureExtractor.windowSamples ?? Constants.defaultWindowSamples
            guard let samples = whisper.audioProcessor.padOrTrim(fromArray: audio, startAt: 0, toLength: window),
                  let mel = try await whisper.featureExtractor.logMelSpectrogram(fromAudio: samples),
                  let encoded = try await whisper.audioEncoder.encodeFeatures(mel) as? MLMultiArray,
                  let inputs = try whisper.textDecoder.prepareDecoderInputs(withPrompt: [sot]) as? DecodingInputs
            else { throw DetectionError(reason: "no encoder output") }
            inputs.inputIds[0] = NSNumber(value: sot)
            inputs.cacheLength[0] = NSNumber(value: 0)
            let output = try await whisper.textDecoder.predictLogits(TextDecoderMLMultiArrayInputType(
                inputIds: inputs.inputIds,
                cacheLength: inputs.cacheLength,
                keyCache: inputs.keyCache,
                valueCache: inputs.valueCache,
                kvCacheUpdateMask: inputs.kvCacheUpdateMask,
                encoderOutputEmbeds: encoded,
                decoderKeyPaddingMask: inputs.decoderKeyPaddingMask
            ))
            guard let logits = (output as? TextDecoderMLMultiArrayOutputType)?.logits,
                  let vocab = logits.shape.last?.intValue
            else { throw DetectionError(reason: "no logits") }
            let lead = Array(repeating: NSNumber(value: 0), count: max(0, logits.shape.count - 1))
            var scores: [String: Float] = [:]
            for code in Set(Constants.languages.values) {
                guard let id = tokenizer.convertTokenToId("<|\(code)|>"), id > tokenizer.specialTokens.specialTokenBegin, id < vocab else { continue }
                let score = logits[lead + [NSNumber(value: id)]].floatValue
                if score.isFinite { scores[code] = score }
            }
            guard let top = scores.values.max() else { throw DetectionError(reason: "no language scores") }
            let total = scores.values.reduce(Float(0)) { $0 + exp($1 - top) }
            return allowed
                .compactMap { code in scores[code].map { (code: code, p: exp($0 - top) / total) } }
                .sorted { $0.p > $1.p }
        } catch {
            log("Language detection fell back to WhisperKit's: \(error)")
            guard let detected = try? await whisper.detectLangauge(audioArray: audio), allowed.contains(detected.language) else { return [] }
            // langProbs holds only the winner's log-probability.
            return [(code: detected.language, p: detected.langProbs[detected.language].map { exp($0) } ?? 0.5)]
        }
    }

    /// BUDDY_LANG_TEST=/a.aiff,/b.wav: on start, runs each file through the translator's language
    /// pick in order, as one speaker's sentences, and logs Whisper's odds, the pick and the text; then
    /// the helper carries on as usual. For checking detection without a microphone, e.g. with
    /// `say -v Thomas "Où est la cathédrale ?" -o fr.aiff`.
    private func languageTest(_ paths: [String]) async {
        var memory = SpeakerLanguages()
        for path in paths {
            guard let audio = try? AudioProcessor.loadAudioAsFloatArray(fromPath: path) else {
                log("language test: could not read \(path)")
                continue
            }
            let seconds = Double(audio.count) / Double(sampleRate)
            let odds = await languageOdds(audio, among: voiceLanguages)
            let pick = memory.choose(odds, speaker: 0, seconds: seconds)
            if let pick { memory.remember(pick, for: 0) }
            let own = try? await models.whisper.detectLangauge(audioArray: audio)
            let (text, _) = await transcribe(audio, language: pick, confirmedSpeech: true)
            log("language test \(URL(fileURLWithPath: path).lastPathComponent) (\(String(format: "%.1f", seconds)) s): \(oddsText(odds)); WhisperKit's pick \(own?.language ?? "?"); kept as \(pick ?? "?"): \(text)")
        }
        log("language test done")
    }

    // MARK: Whisper

    private func transcribe(_ audio: [Float], language: String?, confirmedSpeech: Bool = false) async -> (String, String?) {
        let options = DecodingOptions(
            task: .transcribe,
            language: language,
            temperature: 0,
            usePrefillPrompt: language != nil,
            detectLanguage: language == nil,
            skipSpecialTokens: true,
            withoutTimestamps: true
        )
        do {
            let results = try await models.whisper.transcribe(audioArray: audio, decodeOptions: options)
            let text = results.map(\.text).joined(separator: " ")
                .replacingOccurrences(of: "<\\|[^|]*\\|>", with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            // Phantom phrases ("Thank you.") are only filtered when the endpointer did not confirm speech,
            // so a real "Thank you" or "¡Gracias!" in the translator still gets through.
            return (!confirmedSpeech && isHallucination(text) ? "" : text, results.first?.language)
        } catch {
            log("Transcription failed: \(error)")
            return ("", nil)
        }
    }

    /// Whisper's well-known phantom phrases on near-silence.
    private func isHallucination(_ t: String) -> Bool {
        let s = t.lowercased().trimmingCharacters(in: .punctuationCharacters.union(.whitespaces))
        return s.isEmpty || ["thank you", "thanks for watching", "you", "subtitles by the amara.org community", "gracias", "¡gracias"].contains(s)
    }

    // MARK: Voice

    // Sentences are spoken back to back. Each one is generated (TTSKit's generate) as soon as the one
    // before it has been *generated*, not played, and its audio joins one continuous playback stream,
    // so the next sentence is ready before the current one ends: Qwen3-TTS runs faster than real time
    // on Apple Silicon. Before, every sentence waited for the previous one to finish playing and only
    // then started generating, which left 2-3 s of silence between sentences.
    private struct Sentence {
        let id: String
        let text: String
        let language: String
        let generation: Int
    }
    private var sentences: [Sentence] = []
    private var speaking = false

    private func speak(id: String, text: String, language: String) {
        sentences.append(Sentence(id: id, text: text, language: language, generation: speechGeneration))
        guard !speaking else { return } // the running stream takes it
        speaking = true
        speech = Task { [weak self] in await self?.speakQueued() }
    }

    private func speakQueued() async {
        while !sentences.isEmpty { await speakStream() }
        speaking = false
        // The wake word starts listening again a moment after the voice (and its echo) ends.
        wakeQuietUntil = Date().addingTimeInterval(0.4)
        updateWakeState()
    }

    /// One playback stream: generates the queued sentences one after another into it, takes the
    /// ones that arrive while it plays, and ends when it has played out (or speak.stop).
    private func speakStream() async {
        let tts = models.tts
        let out = tts.audioOutput
        let flag = cancelSpeech
        flag.value = false
        let timeline = SpeechTimeline()
        let sendOut = send
        let format: any SpeechGenerating
        do {
            format = try tts.createTask()
            try out.startPlayback(deferEngineStart: true)
        } catch {
            log("Speech failed to start: \(error)")
            for s in sentences { sendDone(s.id) }
            sentences.removeAll()
            return
        }
        let samplesPerFrame = format.samplesPerFrame
        let rate = format.sampleRate
        let minBuffer = format.minimumBufferDuration
        var options = GenerationOptions()
        options.concurrentWorkerCount = 1 // chunks must arrive in order
        let maxTokens = options.maxNewTokens

        // speak.started when the playhead reaches a sentence (sound is actually playing), speak.done
        // when it passes its end; speak.level about 20 times a second, from the loudness of the
        // audio at the playhead (Wilson's mouth opens with it).
        let watcher = Task {
            var lastLevel: Float = 0
            var lastLevelAt = Date.distantPast
            while !Task.isCancelled {
                let t = out.currentPlaybackTime
                let due = timeline.due(at: t)
                for id in due.started { sendOut(.speakStarted(id: id)) }
                for id in due.done { sendOut(.speakDone(id: id)) }
                if Date().timeIntervalSince(lastLevelAt) >= 0.035 {
                    let level = t > 0 ? voiceLevel(timeline.loudness(at: t)) : 0
                    if level > 0 || lastLevel > 0 { sendOut(.speakLevel(level)) }
                    lastLevel = level
                    lastLevelAt = Date()
                }
                try? await Task.sleep(nanoseconds: 20_000_000)
            }
        }

        stream: while true {
            while !sentences.isEmpty {
                let s = sentences.removeFirst()
                guard s.generation == speechGeneration, !flag.value else {
                    sendDone(s.id)
                    continue
                }
                timeline.begin(s.id)
                let speaker = voice(for: s.language)
                do {
                    _ = try await tts.generate(text: s.text, speaker: speaker, language: ttsLanguage(s.language), options: options) { progress in
                        if flag.value { return false }
                        // Until the stream is playing, pre-buffer as TTSKit's own play(.auto) does, sized
                        // from the measured step time so slow generation doesn't stutter.
                        if !timeline.flushed, let step = progress.stepTime {
                            out.setBufferDuration(PlaybackStrategy.requiredBuffer(
                                stepTime: step, maxNewTokens: maxTokens, samplesPerFrame: samplesPerFrame,
                                sampleRate: rate, minimumBuffer: minBuffer))
                        }
                        out.enqueueAudioChunk(progress.audio)
                        timeline.add(audio: progress.audio, rate: Double(rate))
                        return nil
                    }
                } catch {
                    if !flag.value { log("Speech failed: \(error)") }
                }
                timeline.end(s.id)
                if !timeline.flushed {
                    // The first sentence is fully generated: play whatever is held back, then stream.
                    out.setBufferDuration(0)
                    timeline.flushed = true
                }
                if flag.value { break stream }
            }
            // Nothing queued: let the stream play out, but take any sentence that arrives meanwhile.
            var last = -1.0
            var still = 0
            while sentences.isEmpty, !flag.value {
                let t = out.currentPlaybackTime
                let left = timeline.audioSeconds - t
                if left <= 0.03 { break }
                if t == last { still += 1 } else { still = 0; last = t }
                // The player keeps the very last chunk back for its fade-out until the stream stops:
                // once the playhead has stopped just short of the end, stop, which plays it out.
                if still >= 5, left < 0.5 { break }
                if still > 150 { break } // 3 s without the playhead moving: don't wait forever
                try? await Task.sleep(nanoseconds: 20_000_000)
            }
            if sentences.isEmpty || flag.value { break stream }
        }
        if !flag.value { await out.stopPlayback(waitForCompletion: true) }
        watcher.cancel()
        send(.speakLevel(0))
        let loud = timeline.loudnessSummary()
        log("voice loudness (RMS): median \(String(format: "%.3f", loud.median)), 95th percentile \(String(format: "%.3f", loud.p95))")
        for id in timeline.remaining() { sendDone(id) }
    }

    private func sendDone(_ id: String) { send(.speakDone(id: id)) }

    /// speak.level from the RMS of the voice at the playhead, 0-1. Measured on Qwen3-TTS (aiden):
    /// median 0.09, 95th percentile 0.24 (the "voice loudness" log line), so a typical syllable opens
    /// the mouth about 40% and only the loudest 5% fully; pauses close it.
    private nonisolated func voiceLevel(_ rms: Float) -> Float {
        rms < 0.004 ? 0 : min(1, rms * 4.5)
    }

    /// The voice for a language: the one the helper was given for it; else Qwen3-TTS's native voice
    /// for Japanese, Korean and Chinese; else the local's voice (the one for Spanish), so the two
    /// people's languages keep sounding different.
    private func voice(for language: String) -> Qwen3Speaker {
        if let v = voices[language] { return v }
        switch language {
        case "ja": return .onoAnna
        case "ko": return .sohee
        case "zh": return .vivian
        case "en": return voices["default"] ?? .aiden
        default: return voices["es"] ?? voices["default"] ?? .aiden
        }
    }
}
