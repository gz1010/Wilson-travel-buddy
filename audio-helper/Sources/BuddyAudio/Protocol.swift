import Foundation

// Mirrors app/src/services/audio/protocol.ts. Change both together.

let protocolVersion = 1

/// From the app. Camera messages: camera.start, camera.snap {id}, camera.stop, and
/// camera.alive (sent every few seconds while the preview shows; see Camera.swift).
struct Incoming: Decodable {
    let type: String
    var version: Int?
    var language: String?
    var languages: [String]?
    var muted: Bool?
    var pushToTalk: Bool?
    var turn: String?
    var id: String?
    var text: String?
}

enum Outgoing {
    case ready(models: [String], liveSpeakers: Bool)
    case status(String)
    case level(Float)
    case partial(text: String, speaker: Int?)
    case final(text: String, language: String?, speaker: Int?, turn: String? = nil)
    /// sinceEndMs: how long ago the person stopped speaking (for the latency readout).
    case listenDone(sinceEndMs: Int? = nil)
    case speakStarted(id: String)
    case speakDone(id: String)
    case error(String)
    /// A live preview frame: base64 JPEG, ~480 px wide.
    case cameraFrame(jpeg: String)
    /// The answer to camera.snap: base64 JPEG, ~1024 px wide; nil when the camera is not running.
    case cameraSnapped(id: String, jpeg: String?)
    case cameraError(String)

    var json: Data {
        var d: [String: Any]
        switch self {
        case let .ready(models, live): d = ["type": "ready", "version": protocolVersion, "models": models, "liveSpeakers": live]
        case let .status(m): d = ["type": "status", "message": m]
        case let .level(v): d = ["type": "level", "value": Double((v * 100).rounded() / 100)]
        case let .partial(t, s): d = ["type": "partial", "text": t]; if let s { d["speaker"] = s }
        case let .final(t, l, s, turn):
            d = ["type": "final", "text": t]
            if let l { d["language"] = l }
            if let s { d["speaker"] = s }
            if let turn { d["turn"] = turn }
        case let .listenDone(since):
            d = ["type": "listen.done"]
            if let since { d["sinceEndMs"] = since }
        case let .speakStarted(id): d = ["type": "speak.started", "id": id]
        case let .speakDone(id): d = ["type": "speak.done", "id": id]
        case let .error(m): d = ["type": "error", "message": m]
        case let .cameraFrame(jpeg): d = ["type": "camera.frame", "jpeg": jpeg]
        case let .cameraSnapped(id, jpeg): d = ["type": "camera.snapped", "id": id]; if let jpeg { d["jpeg"] = jpeg }
        case let .cameraError(m): d = ["type": "camera.error", "message": m]
        }
        return (try? JSONSerialization.data(withJSONObject: d)) ?? Data()
    }
}
