import Foundation

// Mirrors app/src/services/audio/protocol.ts. Change both together.

let protocolVersion = 1

struct Incoming: Decodable {
    let type: String
    var version: Int?
    var language: String?
    var languages: [String]?
    var muted: Bool?
    var id: String?
    var text: String?
}

enum Outgoing {
    case ready(models: [String], liveSpeakers: Bool)
    case status(String)
    case level(Float)
    case partial(text: String, speaker: Int?)
    case final(text: String, language: String?, speaker: Int?)
    case listenDone
    case speakDone(id: String)
    case error(String)

    var json: Data {
        var d: [String: Any]
        switch self {
        case let .ready(models, live): d = ["type": "ready", "version": protocolVersion, "models": models, "liveSpeakers": live]
        case let .status(m): d = ["type": "status", "message": m]
        case let .level(v): d = ["type": "level", "value": Double((v * 100).rounded() / 100)]
        case let .partial(t, s): d = ["type": "partial", "text": t]; if let s { d["speaker"] = s }
        case let .final(t, l, s):
            d = ["type": "final", "text": t]
            if let l { d["language"] = l }
            if let s { d["speaker"] = s }
        case .listenDone: d = ["type": "listen.done"]
        case let .speakDone(id): d = ["type": "speak.done", "id": id]
        case let .error(m): d = ["type": "error", "message": m]
        }
        return (try? JSONSerialization.data(withJSONObject: d)) ?? Data()
    }
}
