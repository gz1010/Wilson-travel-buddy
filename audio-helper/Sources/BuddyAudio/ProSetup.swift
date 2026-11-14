#if ARGMAX_PRO
import Argmax
import Foundation

// Argmax Pro SDK, step 1 of 2: the licence.
//
// The key is read from ARGMAX_API_KEY or ~/.travelbuddy/argmax-key, never from
// the repository. The SDK creates a licence the first time (online) and keeps
// it in the keychain; the hour-one test is whether a second start works with
// Wi-Fi off.
//
// Step 2, live speaker labels in the translator, is not wired yet: Pro's
// streaming diarization (Sortformer) needs Pro models prepared the way
// Argmax's sample app does it. A: follow these files in
// github.com/argmaxinc/argmax-sdk-swift-playground:
//   Services/ModelLoader.swift          prepare(...): download, then WhisperKitPro and SpeakerKitPro(SortformerConfig)
//   Views/Transcription/StreamViewModel.swift  startTranscribing(...):
//       let t = whisperKitPro.makeStreamSession(options: DecodingOptionsPro(base:..., alignTimestampsToGlobal: true))
//       let s = try await speakerKit.makeStreamSession(transcriptionSession: t, diarizationConfig: SortformerDiarizationOptions(...))
//       await s.start(audioInputStream: whisperKitPro.audioProcessor.startStreamingRecordingLive().0)
//       for try await r in s.results { r.text, r.confirmedWordsWithSpeakers, r.hypothesisWordsWithSpeakers }
// Then send .partial/.final with the speaker number and set liveSpeakers: true in "ready".
enum ProSetup {
    static func apiKey() -> String? {
        if let k = ProcessInfo.processInfo.environment["ARGMAX_API_KEY"], !k.isEmpty { return k }
        let file = NSString(string: "~/.travelbuddy/argmax-key").expandingTildeInPath
        return (try? String(contentsOfFile: file, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Starts the SDK and returns a line describing the licence, for the log.
    static func activate() async -> String {
        guard let key = apiKey(), key.hasPrefix("ax_") else {
            return "no key found (set ARGMAX_API_KEY or ~/.travelbuddy/argmax-key, starting with ax_)"
        }
        await ArgmaxSDK.with(ArgmaxConfig(apiKey: key))
        return String(describing: await ArgmaxSDK.licenseInfo())
    }
}
#endif
