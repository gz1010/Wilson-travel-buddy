import Accelerate
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

    mutating func identify(_ e: [Float]) -> Int {
        let sims = prints.map { cosine($0, e) }
        log("voice print similarity to known speakers: \(sims.map { String(format: "%.2f", $0) }) (threshold \(threshold))")
        if let best = sims.indices.max(by: { sims[$0] < sims[$1] }), sims[best] >= threshold || prints.count >= 2 {
            prints[best] = zip(prints[best], e).map { $0 * 0.7 + $1 * 0.3 }
            return best
        }
        prints.append(e)
        return prints.count - 1
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

final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var _value = false
    var value: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _value }
        set { lock.lock(); _value = newValue; lock.unlock() }
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
            await start(.conversation, languages: m.languages ?? ["en", "es"], listenLanguage: nil)
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
            let out = models.tts.audioOutput
            Task { await out.stopPlayback(waitForCompletion: false) }
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
        let (text, _) = await transcribe(utterance, language: lang)
        if !text.isEmpty, mode != .idle { send(.partial(text: text, speaker: nil)) }
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
        // The pressed button's language if there is one; otherwise the more likely of the two.
        var lang = ctx.forcedLanguage ?? ctx.languages.first
        // langProbs holds only the sampled language's log-probability, so use the detected code directly.
        if ctx.forcedLanguage == nil, ctx.languages.count > 1, let detected = try? await models.whisper.detectLangauge(audioArray: audio) {
            lang = ctx.languages.contains(detected.language) ? detected.language : ctx.languages.first
        }
        let (text, _) = await transcribe(audio, language: lang, confirmedSpeech: true)
        guard current() else { return }
        guard !text.isEmpty else {
            if ctx.pushToTalk { send(.final(text: "", language: lang, speaker: nil, turn: ctx.turn)) }
            return
        }
        // Diarizing the whole conversation is far more reliable than one short sentence alone;
        // the per-sentence voice print is the fallback. Argmax labels speakers in both modes.
        var speaker = await sessionSpeaker(session, sentence: range)
        if speaker == nil { speaker = await voicePrint(audio) }
        guard current() else { return }
        send(.final(text: text, language: lang, speaker: speaker, turn: ctx.turn))
    }

    /// Runs SpeakerKit over the conversation so far, finds the speaker cluster that overlaps this
    /// sentence most, and matches that cluster's centroid to the speakers seen before, so the
    /// numbers stay stable from one run to the next.
    private func sessionSpeaker(_ session: [Float], sentence range: Range<Int>) async -> Int? {
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
            guard let cluster = overlap.max(by: { $0.value < $1.value })?.key,
                  let centroid = result.speakerCentroidEmbeddings[cluster] else { return nil }
            return prints.identify(centroid)
        } catch {
            log("Conversation diarization failed: \(error)")
            return nil
        }
    }

    private func voicePrint(_ audio: [Float]) async -> Int? {
        // Short sentences give unreliable voice prints; the app falls back to language for those.
        guard let speakers = models.speakers, audio.count > sampleRate * 3 / 2 else { return nil }
        do {
            let result = try await speakers.diarize(audioArray: audio, options: PyannoteDiarizationOptions(numberOfSpeakers: 1))
            guard let embedding = result.speakerCentroidEmbeddings.sorted(by: { $0.key < $1.key }).first?.value else { return nil }
            return prints.identify(embedding)
        } catch {
            log("Voice print failed: \(error)")
            return nil
        }
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

    private func speak(id: String, text: String, language: String) {
        let generation = speechGeneration
        let previous = speech
        let tts = models.tts
        let flag = cancelSpeech
        let voice = voices[language] ?? voices["default"] ?? .aiden
        let sendStarted = send
        let audioOut = tts.audioOutput
        speech = Task { [weak self] in
            await previous.value
            let current = await self?.speechGeneration ?? -1
            if current == generation {
                flag.value = false
                // speak.started fires when sound is actually playing (the player's clock moves),
                // not when the first audio is generated: TTSKit pre-buffers before playing.
                let watcher = Task {
                    while !Task.isCancelled {
                        if audioOut.currentPlaybackTime > 0 {
                            sendStarted(.speakStarted(id: id))
                            return
                        }
                        try? await Task.sleep(nanoseconds: 20_000_000)
                    }
                }
                do {
                    _ = try await tts.play(text: text, speaker: voice, language: ttsLanguage(language), playbackStrategy: .auto) { _ in
                        flag.value ? false : nil
                    }
                } catch {
                    log("Speech failed: \(error)")
                }
                watcher.cancel()
            }
            await self?.sendDone(id)
        }
    }

    private func sendDone(_ id: String) { send(.speakDone(id: id)) }
}
