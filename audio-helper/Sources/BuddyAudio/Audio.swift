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

/// One speech stream's timeline: where each sentence's audio starts and ends among the seconds of
/// audio handed to the player, and which speak.started / speak.done have been sent.
final class SpeechTimeline: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [(id: String, start: Double, end: Double?)] = []
    private var told: Set<String> = []
    private var finished: Set<String> = []
    private var seconds = 0.0
    private var _flushed = false

    /// True once the pre-buffer has been released and audio plays as it arrives.
    var flushed: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _flushed }
        set { lock.lock(); _flushed = newValue; lock.unlock() }
    }
    var audioSeconds: Double { lock.lock(); defer { lock.unlock() }; return seconds }
    func add(seconds s: Double) { lock.lock(); seconds += s; lock.unlock() }
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
/// conversation at a time; speech is queued.
actor AudioService {
    enum Mode { case idle, listen, conversation }

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

    init(models: ArgmaxModels, voiceThreshold: Float, voices: [String: Qwen3Speaker], send: @escaping (Outgoing) -> Void) {
        self.models = models
        self.send = send
        self.voices = voices
        self.prints = VoicePrints(threshold: voiceThreshold)
        // BUDDY_LANG_TEST=/a.aiff,/b.wav checks language detection without a microphone (see languageTest).
        if let test = ProcessInfo.processInfo.environment["BUDDY_LANG_TEST"], !test.isEmpty {
            let paths = test.split(separator: ",").map { String($0) }
            Task { await self.languageTest(paths) }
        }
    }

    // MARK: Messages

    func handle(_ m: Incoming) async {
        switch m.type {
        case "listen.start": await start(.listen, languages: [], listenLanguage: m.language)
        case "listen.stop":
            if mode == .listen {
                if micTask == nil { startGeneration += 1; mode = .idle; send(.listenDone()) } // still waiting for permission
                else { await endListen() }
            }
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
            startGeneration += 1
            stopMic()
            mode = .idle
            resetConversation()
        case "mute":
            muted = m.muted ?? false
            // A held push-to-talk turn keeps what was said before the translation started playing;
            // chunks are still dropped while muted, so the voice is never recorded.
            if !(mode == .conversation && pushToTalk && pttActive) {
                utterance = []
                endpointer.reset()
            }
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
        mode = newMode
        startGeneration += 1
        let generation = startGeneration
        guard await AudioProcessor.requestRecordPermission() else {
            mode = .idle
            send(.error("Microphone access was refused. Allow it in System Settings > Privacy & Security > Microphone."))
            if newMode == .listen { send(.listenDone()) }
            return
        }
        // A stop (or another start) arrived while we waited for permission.
        guard generation == startGeneration, mode == newMode else { return }
        self.languages = languages
        self.listenLanguage = listenLanguage
        utterance = []
        heardSpeech = false
        endpointer.reset()
        listenStarted = Date()
        lastSpeechAt = nil
        let (stream, continuation) = models.whisper.audioProcessor.startStreamingRecordingLive(inputDeviceID: nil)
        micContinuation = continuation
        micTask = Task { [weak self] in
            do {
                for try await chunk in stream { await self?.onChunk(chunk) }
            } catch {
                await self?.report(error)
            }
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

    private func onChunk(_ chunk: [Float]) async {
        guard mode != .idle, !muted else { return }
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
            if ended || (heardSpeech && waited > 20) || (!heardSpeech && waited > 8) { await endListen() }
        case .conversation:
            if !pushToTalk, ended || (heardSpeech && utterance.count > 15 * sampleRate) {
                finishTurnNow()
            }
        case .idle: break
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
        guard mode != .idle, heardSpeech, utterance.count > sampleRate / 2 else { return }
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
        // when it passes its end.
        let watcher = Task {
            while !Task.isCancelled {
                let t = out.currentPlaybackTime
                let due = timeline.due(at: t)
                for id in due.started { sendOut(.speakStarted(id: id)) }
                for id in due.done { sendOut(.speakDone(id: id)) }
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
                        timeline.add(seconds: Double(progress.audio.count) / Double(rate))
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
        for id in timeline.remaining() { sendDone(id) }
    }

    private func sendDone(_ id: String) { send(.speakDone(id: id)) }

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
