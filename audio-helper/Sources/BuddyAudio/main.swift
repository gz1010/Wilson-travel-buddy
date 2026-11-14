import Foundation
import TTSKit

// buddy-audio [--port 8765] [--models-dir DIR] [--whisper-model NAME]
//             [--voice-threshold 0.55] [--prepare] [--pro]
//
// --prepare downloads every model while online, writes the manifest, and exits.
// After that, the helper starts with Wi-Fi off.

let args = CommandLine.arguments
func arg(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}
let port = UInt16(arg("--port") ?? "8765") ?? 8765
let modelsDir = URL(fileURLWithPath: arg("--models-dir") ?? NSString(string: "~/Library/Application Support/TravelBuddy/argmax").expandingTildeInPath)
// The 626 MB large-v3 build is Argmax's multilingual pick for M1; try "small" if partials feel slow.
let whisperModel = arg("--whisper-model") ?? "large-v3-v20240930_626MB"
let voiceThreshold = Float(arg("--voice-threshold") ?? "0.55") ?? 0.55
let voices: [String: Qwen3Speaker] = ["en": .aiden, "es": .serena, "default": .aiden]

if args.contains("--prepare") {
    Task {
        do {
            _ = try await ArgmaxModels.load(dir: modelsDir, whisperModel: whisperModel) { log($0) }
            log("All models downloaded to \(modelsDir.path). You can now run buddy-audio with Wi-Fi off.")
            exit(0)
        } catch {
            log("Preparing models failed: \(error)")
            exit(1)
        }
    }
    dispatchMain()
}

let server = try WebSocketServer(port: port)
let (inbox, inboxContinuation) = AsyncStream<Incoming>.makeStream()
var service: AudioService?
var readyMessage: Outgoing?
var lastStatus = Outgoing.status("Starting the audio helper…")

// No greeting on connect: clients say "hello" and get one "ready" (or status) back.
// Sending both made clients act on "ready" twice (the test script spoke twice).
server.onMessage = { data in
    guard let m = try? JSONDecoder().decode(Incoming.self, from: data) else { return }
    if m.type == "hello" {
        server.send(readyMessage ?? lastStatus)
        return
    }
    guard service != nil else {
        if m.type == "listen.start" { server.send(.error("Still loading models")); server.send(.listenDone) }
        if m.type == "speak", let id = m.id { server.send(.speakDone(id: id)) }
        return
    }
    inboxContinuation.yield(m)
}
// One consumer, so messages reach the audio service in the order the app sent them.
Task {
    for await m in inbox { await service?.handle(m) }
}
server.start()
log("Listening on ws://127.0.0.1:\(port)")

Task {
    do {
        #if ARGMAX_PRO
        if args.contains("--pro") {
            log("Pro mode: \(await ProSetup.activate())")
        }
        #endif
        let models = try await ArgmaxModels.load(dir: modelsDir, whisperModel: whisperModel) { message in
            log(message)
            lastStatus = .status(message)
            server.send(lastStatus)
        }
        service = AudioService(models: models, voiceThreshold: voiceThreshold, voices: voices) { server.send($0) }
        readyMessage = .ready(models: models.names, liveSpeakers: false)
        server.send(readyMessage!)
        log("Ready: \(models.names.joined(separator: ", "))")
    } catch {
        log("Could not load models: \(error)")
        lastStatus = .error("Could not load speech models: \(error.localizedDescription). Run buddy-audio --prepare while online.")
        server.send(lastStatus)
    }
}

dispatchMain()
