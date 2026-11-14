import Foundation
import SpeakerKit
import TTSKit
import WhisperKit

/// Where each model lives on disk after the first (online) run. With this
/// file present, every model loads from local folders with downloads off, so
/// a cold start works with Wi-Fi off.
struct Manifest: Codable {
    var whisperModel: String
    var whisperFolder: String
    var ttsFolder: String
    var ttsTokenizerFolder: String?
    var speakerFolder: String?
}

final class ArgmaxModels {
    let whisper: WhisperKit
    let tts: TTSKit
    let speakers: SpeakerKit?
    let names: [String]

    private init(whisper: WhisperKit, tts: TTSKit, speakers: SpeakerKit?, names: [String]) {
        self.whisper = whisper
        self.tts = tts
        self.speakers = speakers
        self.names = names
    }

    static func manifestURL(_ dir: URL) -> URL { dir.appendingPathComponent("manifest.json") }

    /// Loads all three models. Without a manifest it downloads them into `dir`
    /// (needs the network once) and writes the manifest.
    static func load(dir: URL, whisperModel: String, status: (String) -> Void) async throws -> ArgmaxModels {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let manifest = (try? Data(contentsOf: manifestURL(dir))).flatMap { try? JSONDecoder().decode(Manifest.self, from: $0) }
        let offline = manifest != nil && manifest?.whisperModel == whisperModel
        status(offline ? "Loading speech models from disk…" : "Downloading speech models (first run only, needs internet)…")

        // Speech-to-text. The tokenizer is looked for under downloadBase/models/openai/… first.
        let whisper = try await WhisperKit(WhisperKitConfig(
            model: whisperModel,
            downloadBase: dir,
            modelFolder: offline ? manifest!.whisperFolder : nil,
            tokenizerFolder: dir,
            verbose: false,
            logLevel: .error,
            prewarm: true,
            load: true,
            download: !offline
        ))
        status("Loading the voice…")

        // Text-to-speech. Its tokenizer comes from a separate repo (Qwen/Qwen3-0.6B).
        let tts = try await TTSKit(TTSKitConfig(
            model: .qwen3TTS_0_6b,
            modelFolder: offline ? URL(fileURLWithPath: manifest!.ttsFolder) : nil,
            downloadBase: dir,
            tokenizerFolder: offline ? manifest!.ttsTokenizerFolder.map { URL(fileURLWithPath: $0) } : nil,
            verbose: false,
            logLevel: .error,
            download: !offline,
            prewarm: true,
            load: true
        ))
        status("Loading speaker recognition…")

        // Diarization: used for voice prints in the translator. Optional; the app falls back to language.
        var speakers: SpeakerKit?
        do {
            speakers = try await SpeakerKit(PyannoteConfig(
                downloadBase: dir.path,
                modelFolder: offline ? manifest!.speakerFolder : nil,
                download: !offline,
                load: true,
                verbose: false,
                logLevel: .error
            ))
        } catch {
            log("SpeakerKit failed to load (\(error)); the translator will use language to tell speakers apart.")
        }

        if !offline {
            let m = Manifest(
                whisperModel: whisperModel,
                whisperFolder: whisper.modelFolder?.path ?? "",
                ttsFolder: tts.modelFolder?.path ?? "",
                ttsTokenizerFolder: findTokenizer(named: "Qwen3-0.6B", under: [dir, FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("huggingface")])?.path,
                // SpeakerKit only reports a folder it was given, so fall back to where the Hub put it.
                speakerFolder: speakers?.diarizer.modelFolder?.path ?? existingFolder(dir.appendingPathComponent("models/argmaxinc/speakerkit-coreml"))
            )
            let data = try JSONEncoder().encode(m)
            try data.write(to: manifestURL(dir))
            log("Wrote \(manifestURL(dir).path):\n\(String(data: data, encoding: .utf8) ?? "")")
            if m.speakerFolder == nil {
                log("WARNING: could not find the speaker models on disk; the translator may not label speakers offline.")
            }
            if m.ttsTokenizerFolder == nil {
                log("WARNING: could not find the Qwen3 tokenizer on disk; an offline start may fail. Check ~/Documents/huggingface.")
            }
        }

        let names = [
            "Whisper \(whisperModel) (Argmax)",
            "Qwen3-TTS 0.6B (Argmax)",
        ] + (speakers != nil ? ["Pyannote speakers (Argmax)"] : [])
        return ArgmaxModels(whisper: whisper, tts: tts, speakers: speakers, names: names)
    }

    private static func existingFolder(_ url: URL) -> String? {
        FileManager.default.fileExists(atPath: url.path) ? url.path : nil
    }

    /// Finds a folder with this name that holds a tokenizer.json.
    private static func findTokenizer(named name: String, under roots: [URL]) -> URL? {
        for root in roots {
            guard let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else { continue }
            for case let url as URL in e where url.lastPathComponent == name {
                if FileManager.default.fileExists(atPath: url.appendingPathComponent("tokenizer.json").path) { return url }
            }
        }
        return nil
    }
}

/// Whisper language codes to the voice's languages.
func ttsLanguage(_ code: String) -> Qwen3Language {
    switch code {
    case "es": return .spanish
    case "fr": return .french
    case "de": return .german
    case "it": return .italian
    case "pt": return .portuguese
    case "ja": return .japanese
    case "ko": return .korean
    case "zh": return .chinese
    case "ru": return .russian
    default: return .english
    }
}
