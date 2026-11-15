import Foundation

// Mirrors app/src/services/audio/protocol.ts. Change both together.

let protocolVersion = 1

/// From the app. Camera messages: camera.start, camera.snap {id}, camera.stop, and
/// camera.alive (sent every few seconds while the preview shows; see Camera.swift).
/// Location: location.get {id} (see Location.swift).
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
    /// language: what Whisper hears so far in a conversation (one of the app's languages), so the app
    /// can light up the half of whoever is talking before the sentence ends.
    case partial(text: String, speaker: Int?, language: String? = nil)
    case final(text: String, language: String?, speaker: Int?, turn: String? = nil)
    /// sinceEndMs: how long ago the person stopped speaking (for the latency readout).
    case listenDone(sinceEndMs: Int? = nil)
    case speakStarted(id: String)
    case speakDone(id: String)
    case error(String)
    /// A live preview frame: base64 JPEG, ~1000 px wide (quality 0.75), at most 6 a second, fewer when frames are big.
    case cameraFrame(jpeg: String)
    /// The answer to camera.snap: base64 JPEG, ~1600 px wide (quality 0.85); nil when the camera is not running.
    case cameraSnapped(id: String, jpeg: String?)
    case cameraError(String)
    /// The answer to location.get: where macOS says the Mac is. accuracy: metres (nil if unknown);
    /// at: when macOS made the fix, ms since 1970.
    case location(id: String, lat: Double, lon: Double, accuracy: Double?, at: Int)
    /// macOS could not locate the Mac (Wi-Fi off, Location Services off, permission refused).
    case locationError(id: String, message: String)

    var json: Data {
        var d: [String: Any]
        switch self {
        case let .ready(models, live): d = ["type": "ready", "version": protocolVersion, "models": models, "liveSpeakers": live]
        case let .status(m): d = ["type": "status", "message": m]
        case let .level(v): d = ["type": "level", "value": Double((v * 100).rounded() / 100)]
        case let .partial(t, s, l):
            d = ["type": "partial", "text": t]
            if let s { d["speaker"] = s }
            if let l { d["language"] = l }
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
        case let .location(id, lat, lon, accuracy, at):
            d = ["type": "location", "id": id, "lat": lat, "lon": lon, "at": at]
            if let accuracy { d["accuracy"] = accuracy.rounded() }
        case let .locationError(id, m): d = ["type": "location.error", "id": id, "message": m]
        }
        return (try? JSONSerialization.data(withJSONObject: d)) ?? Data()
    }
}
