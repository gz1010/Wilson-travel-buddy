import Foundation

// Mirrors app/src/services/audio/protocol.ts. Change both together.

let protocolVersion = 1

/// From the app. Camera messages: camera.start, camera.snap {id}, camera.stop, and
/// camera.alive (sent every few seconds while the preview shows; see Camera.swift).
/// Location: location.get {id} (see Location.swift).
/// Wake word: wake.start (also sent every few seconds as a keepalive while the app wants it) and
/// wake.stop; see "Wake word" in Audio.swift.
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
    /// listen.start: end the listen if nobody starts speaking within this many ms (the follow-up
    /// after a spoken answer); without it, 8 s.
    var quietMs: Int?
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
    /// How loud the speech playing right now is, 0-1, about 20 times a second while it plays (for
    /// Wilson's mouth); 0 once it stops.
    case speakLevel(Float)
    /// The wake word is listening (true) or not (false: stopped, the microphone is in use, or the
    /// app's voice is playing). Sent when it changes.
    case wakeState(listening: Bool)
    /// "Wilson" was heard at the start of a sentence that is still going on; text: what follows it
    /// so far. The rest arrives in .wake when the sentence ends.
    case wakeHeard(text: String)
    /// A sentence that started with the wake word. text: the words after it ("" for "Wilson"
    /// alone); heard: the whole sentence as Whisper read it; sinceEndMs: how long ago it ended.
    case wake(text: String, heard: String, sinceEndMs: Int?)
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
        case let .ready(models, live): d = ["type": "ready", "version": protocolVersion, "models": models, "liveSpeakers": live, "camera": true, "wake": true]
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
        case let .speakLevel(v): d = ["type": "speak.level", "value": Double((v * 100).rounded() / 100)]
        case let .wakeState(listening): d = ["type": "wake.state", "listening": listening]
        case let .wakeHeard(t): d = ["type": "wake.heard", "text": t]
        case let .wake(t, heard, since):
            d = ["type": "wake", "text": t, "heard": heard]
            if let since { d["sinceEndMs"] = since }
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
