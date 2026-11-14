import Accelerate
import Foundation
import SpeakerKit
import TTSKit
import WhisperKit

let sampleRate = WhisperKit.sampleRate // 16 kHz

/// Finds where speech starts and stops in a stream of microphone chunks,
/// from loudness against an adaptive noise floor.
struct Endpointer {
    var silenceToEnd: Double = 0.8 // seconds of quiet that end an utterance
    var minSpeech: Double = 0.3
    private(set) var noiseFloor: Float = 0.003
    private(set) var inSpeech = false
    private var speechSamples = 0
    private var silenceSamples = 0

    /// Returns true when an utterance has just ended.
    mutating func feed(_ chunk: [Float]) -> (level: Float, ended: Bool) {
        var rms: Float = 0
        vDSP_rmsqv(chunk, 1, &rms, vDSP_Length(chunk.count))
        let speech = rms > max(0.006, noiseFloor * 3)
        if !speech { noiseFloor = noiseFloor * 0.95 + rms * 0.05 }
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
    private var heardSpeech = false
    private var listenLanguage: String?
    private var languages: [String] = ["en"]
    private var muted = false
    private var prints: VoicePrints
    private var partialTask: Task<Void, Never>?
    private var finals: Task<Void, Never> = Task {}
    private var listenStarted = Date()
    private var lastLevelSent = Date.distantPast

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
        case "listen.stop": if mode == .listen { await endListen() }
        case "conversation.start":
            prints.reset()
            await start(.conversation, languages: m.languages ?? ["en", "es"], listenLanguage: nil)
        case "conversation.stop": stopMic(); mode = .idle
        case "mute":
            muted = m.muted ?? false
            utterance = []
            endpointer.reset()
        case "speak": if let id = m.id, let text = m.text { speak(id: id, text: text, language: m.language ?? "en") }
        case "speak.stop":
            speechGeneration += 1
            cancelSpeech.value = true
        default: break
        }
    }

    // MARK: Microphone

    private func start(_ newMode: Mode, languages: [String], listenLanguage: String?) async {
        stopMic()
        guard await AudioProcessor.requestRecordPermission() else {
            send(.error("Microphone access was refused. Allow it in System Settings > Privacy & Security > Microphone."))
            if newMode == .listen { send(.listenDone) }
            return
        }
        mode = newMode
        self.languages = languages
        self.listenLanguage = listenLanguage
        utterance = []
        heardSpeech = false
        endpointer.reset()
        listenStarted = Date()
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
        micTask?.cancel()
        micTask = nil
        models.whisper.audioProcessor.stopRecording()
        micContinuation?.finish()
        micContinuation = nil
    }

    private func onChunk(_ chunk: [Float]) async {
        guard mode != .idle, !muted else { return }
        let (level, ended) = endpointer.feed(chunk)
        if Date().timeIntervalSince(lastLevelSent) > 0.1 {
            send(.level(level))
            lastLevelSent = Date()
        }
        if endpointer.inSpeech { heardSpeech = true }
        // Keep a little audio before speech starts so the first word is not clipped.
        utterance.append(contentsOf: chunk)
        if !heardSpeech, utterance.count > sampleRate { utterance.removeFirst(utterance.count - sampleRate / 2) }

        switch mode {
        case .listen:
            let waited = Date().timeIntervalSince(listenStarted)
            if ended || (heardSpeech && waited > 20) || (!heardSpeech && waited > 8) { await endListen() }
        case .conversation:
            if ended {
                let audio = utterance
                utterance = []
                heardSpeech = false
                let previous = finals
                finals = Task { [weak self] in
                    await previous.value
                    await self?.finishConversationTurn(audio)
                }
            }
        case .idle: break
        }
    }

    private func partial() async {
        guard mode != .idle, heardSpeech, utterance.count > sampleRate / 2 else { return }
        let lang = mode == .listen ? listenLanguage : nil
        let (text, _) = await transcribe(utterance, language: lang)
        if !text.isEmpty, mode != .idle { send(.partial(text: text, speaker: nil)) }
    }

    // MARK: Voice loop

    private func endListen() async {
        let audio = utterance
        let spoke = heardSpeech
        stopMic()
        mode = .idle
        if spoke {
            let (text, lang) = await transcribe(audio, language: listenLanguage)
            if !text.isEmpty { send(.final(text: text, language: lang ?? listenLanguage, speaker: nil)) }
        }
        send(.listenDone)
    }

    // MARK: Translator

    private func finishConversationTurn(_ audio: [Float]) async {
        // Pick the more likely of the two conversation languages, then transcribe in it.
        var lang = languages.first
        if languages.count > 1, let detected = try? await models.whisper.detectLangauge(audioArray: audio) {
            lang = languages.max { (detected.langProbs[$0] ?? 0) < (detected.langProbs[$1] ?? 0) }
        }
        let (text, _) = await transcribe(audio, language: lang)
        guard !text.isEmpty else { return }
        let speaker = await voicePrint(audio)
        send(.final(text: text, language: lang, speaker: speaker))
    }

    private func voicePrint(_ audio: [Float]) async -> Int? {
        guard let speakers = models.speakers, audio.count > sampleRate else { return nil }
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

    private func transcribe(_ audio: [Float], language: String?) async -> (String, String?) {
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
            return (isHallucination(text) ? "" : text, results.first?.language)
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
        speech = Task { [weak self] in
            await previous.value
            let current = await self?.speechGeneration ?? -1
            if current == generation {
                flag.value = false
                do {
                    _ = try await tts.play(text: text, speaker: voice, language: ttsLanguage(language), playbackStrategy: .auto) { _ in
                        flag.value ? false : nil
                    }
                } catch {
                    log("Speech failed: \(error)")
                }
            }
            await self?.sendDone(id)
        }
    }

    private func sendDone(_ id: String) { send(.speakDone(id: id)) }
}
