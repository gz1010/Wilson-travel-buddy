import CoreLocation
import CoreServices
import CoreWLAN
import CryptoKit
import Foundation
import MachO

/// macOS asks for Location only on behalf of an app bundle. For a bare command-line tool,
/// CoreLocationAgent logs "client bundle is NULL. Skip showing AuthPrompt" and the request stays
/// "not determined" forever, even with an embedded Info.plist (checked on macOS 26). So before it
/// opens its port, the helper copies itself into a small app bundle,
/// ~/Library/Application Support/TravelBuddy/BuddyAudio.app (bundle id
/// com.travelbuddy.buddy-audio, signed ad hoc so macOS can read that id), and execv()s the copy:
/// same pid, same arguments, same stdout and stderr, so scripts/start.sh notices nothing.
/// The copy is refreshed whenever the built binary changes, and macOS then asks once more (the
/// ad hoc signature changes with every build). `--no-app-bundle` skips all this (the helper then
/// works as before, without macOS Location).
///
/// Camera and microphone permission do not move: macOS still asks for the app that started the
/// helper (Terminal, iTerm, or the Claude app's terminal), as before. See the README, "Location".
enum LocationAppBundle {
    /// Set in the copy's environment, so it never relaunches itself again.
    static let marker = "BUDDY_AUDIO_IN_APP_BUNDLE"
    static let app = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/TravelBuddy/BuddyAudio.app")

    static func relaunchInsideIfNeeded(_ arguments: [String]) {
        if ProcessInfo.processInfo.environment[marker] != nil || arguments.contains("--no-app-bundle") { return }
        guard let exe = Bundle.main.executableURL?.resolvingSymlinksInPath(),
              !exe.path.contains(".app/Contents/MacOS/") else { return }
        guard let plist = embeddedInfoPlist() else {
            return log("Location: this build has no embedded Info.plist, so macOS will not ask it for Location")
        }
        let target = app.appendingPathComponent("Contents/MacOS/BuddyAudio")
        do {
            try install(exe, plist: plist)
        } catch {
            return log("Location: could not set up \(app.path) (\(error.localizedDescription)); macOS will not ask this helper for Location")
        }
        // locationd keeps an answer only for a bundle Launch Services knows ("Launch Services does not
        // know the client as a plugin or app" otherwise). Cheap when nothing changed.
        let registered = LSRegisterURL(app as CFURL, false)
        if registered != noErr { log("Location: Launch Services did not register \(app.path) (\(registered))") }
        log("Location: running from \(app.path), so macOS can ask for Location")
        setenv(marker, "1", 1)
        var argv: [UnsafeMutablePointer<CChar>?] = ([target.path] + arguments.dropFirst()).map { strdup($0) }
        argv.append(nil)
        execv(target.path, argv)
        // Only reached if execv failed: carry on as a plain tool.
        unsetenv(marker)
        log("Location: could not run \(target.path) (\(String(cString: strerror(errno)))); macOS will not ask this helper for Location")
    }

    /// Support/Info.plist as linked into this binary by Package.swift (__TEXT,__info_plist).
    private static func embeddedInfoPlist() -> Data? {
        var size: UInt = 0
        let header = UnsafeRawPointer(#dsohandle).assumingMemoryBound(to: mach_header_64.self)
        guard let bytes = getsectiondata(header, "__TEXT", "__info_plist", &size), size > 0 else { return nil }
        return Data(bytes: bytes, count: Int(size))
    }

    /// (Re)builds the bundle when this binary or its Info.plist changed since the last install.
    private static func install(_ exe: URL, plist: Data) throws {
        let fm = FileManager.default
        let dir = app.deletingLastPathComponent()
        let stampURL = dir.appendingPathComponent("BuddyAudio.app.stamp")
        let hex = { (d: Data) in SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }
        let stamp = "\(hex(try Data(contentsOf: exe, options: .mappedIfSafe))) \(hex(plist))"
        let target = app.appendingPathComponent("Contents/MacOS/BuddyAudio")
        if (try? String(contentsOf: stampURL, encoding: .utf8)) == stamp, fm.isExecutableFile(atPath: target.path) { return }

        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let fresh = dir.appendingPathComponent("BuddyAudio.app.\(getpid()).new")
        try? fm.removeItem(at: fresh)
        defer { try? fm.removeItem(at: fresh) }
        try fm.createDirectory(at: fresh.appendingPathComponent("Contents/MacOS"), withIntermediateDirectories: true)
        try fm.copyItem(at: exe, to: fresh.appendingPathComponent("Contents/MacOS/BuddyAudio")) // an APFS clone
        try plist.write(to: fresh.appendingPathComponent("Contents/Info.plist"))
        // Ad hoc (no identity, offline). It binds the Info.plist, which is how macOS reads the bundle id.
        let sign = Process()
        sign.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        sign.arguments = ["--sign", "-", "--force", fresh.path]
        let errors = Pipe()
        sign.standardOutput = FileHandle.nullDevice
        sign.standardError = errors
        try sign.run()
        let output = errors.fileHandleForReading.readDataToEndOfFile()
        try? errors.fileHandleForReading.close() // not inherited by the execv'd copy
        sign.waitUntilExit()
        guard sign.terminationStatus == 0 else {
            throw NSError(domain: "codesign", code: Int(sign.terminationStatus), userInfo: [
                NSLocalizedDescriptionKey: "codesign failed: " + (String(data: output, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
            ])
        }
        // A helper still running from the old copy keeps its (unlinked) executable. If the old copy
        // can't be removed, stop here: running it would run an older build without saying so.
        do {
            try fm.removeItem(at: app)
        } catch CocoaError.fileNoSuchFile {}
        do {
            try fm.moveItem(at: fresh, to: app)
        } catch where fm.isExecutableFile(atPath: target.path) {
            return // another helper starting at the same moment installed it first
        }
        try stamp.write(to: stampURL, atomically: true, encoding: .utf8)
        log("Location: installed \(app.path)")
    }
}

/// macOS Location for the map's "locate me": `location.get {id}` is answered with
/// `location {id, lat, lon, accuracy, at}` or `location.error {id, message}`, within about 8 s.
///
/// A Mac has no GPS. macOS (its locationd daemon) works out where the Mac is from the Wi-Fi
/// networks it can see, so this needs Wi-Fi switched on (not necessarily joined to a network);
/// with Wi-Fi off it fails, and the app falls back to the last fix it saved, then to tapping the
/// map. The helper itself sends nothing over the network: it only asks locationd.
///
/// Permission: macOS asks once for "Travel Buddy audio helper" (the app bundle the helper runs
/// from, see LocationAppBundle above; its Info.plist is Support/Info.plist, linked into the binary
/// by Package.swift) and lists it under System Settings > Privacy & Security > Location Services.
/// See the README's "Location" section.
///
/// CLLocationManager delivers its callbacks on the run loop of the thread that created it, and
/// main.swift parks the main thread in dispatchMain() (no run loop), so the manager lives on a
/// thread of its own. Everything below runs on that thread.
final class LocationService: NSObject, CLLocationManagerDelegate, @unchecked Sendable {
    /// How long one location.get waits for macOS, including a permission prompt left unanswered.
    static let timeoutSeconds: TimeInterval = 8
    /// A fix macOS already has that is this recent answers at once, without asking again.
    static let reuseSeconds: TimeInterval = 60

    private let send: (Outgoing) -> Void
    private var runLoop: CFRunLoop?
    private let started = DispatchSemaphore(value: 0)

    // Only touched on the location thread.
    private var manager: CLLocationManager?
    /// Requests waiting for a fix, each with its timeout.
    private var waiting: [String: Timer] = [:]
    /// True while a requestLocation() is in flight (one serves every waiting request).
    private var requesting = false
    /// True once this run has asked macOS for permission (it prompts once).
    private var askedPermission = false
    /// Why the last attempt failed, for a request that then times out.
    private var lastFailure: String?

    init(send: @escaping (Outgoing) -> Void) {
        self.send = send
        super.init()
        let thread = Thread { [unowned self] in
            self.runLoop = CFRunLoopGetCurrent()
            // A port keeps the run loop alive while nothing else is scheduled on it.
            RunLoop.current.add(NSMachPort(), forMode: .default)
            self.started.signal()
            while true { _ = RunLoop.current.run(mode: .default, before: .distantFuture) }
        }
        thread.name = "buddy-audio.location"
        thread.start()
        started.wait()
    }

    // MARK: Messages (from main.swift's inbox)

    func handle(_ m: Incoming) {
        guard m.type == "location.get" else { return }
        let id = m.id ?? ""
        perform { self.get(id) }
    }

    private func perform(_ block: @escaping () -> Void) {
        guard let runLoop else { return }
        CFRunLoopPerformBlock(runLoop, CFRunLoopMode.defaultMode.rawValue, block)
        CFRunLoopWakeUp(runLoop)
    }

    // MARK: Requests

    private func get(_ id: String) {
        guard CLLocationManager.locationServicesEnabled() else {
            return reply(id, error: Self.servicesOff)
        }
        // Without Wi-Fi macOS has nothing to locate the Mac from: say so now, not in 8 s.
        // (A Mac with no Wi-Fi hardware has no interface; macOS may still try, so ask anyway.)
        if let wifi = CWWiFiClient.shared().interface(), !wifi.powerOn() {
            return reply(id, error: Self.wifiOff)
        }
        let manager = self.manager ?? makeManager()
        if manager.authorizationStatus.allowed, let fix = manager.location, Self.usable(fix),
           -fix.timestamp.timeIntervalSinceNow < Self.reuseSeconds {
            log(String(format: "Location: reusing a fix within %.0f m, %.0f s old", fix.horizontalAccuracy, -fix.timestamp.timeIntervalSinceNow))
            return reply(id, fix: fix)
        }
        waiting[id]?.invalidate()
        waiting[id] = Timer.scheduledTimer(withTimeInterval: Self.timeoutSeconds, repeats: false) { [weak self] _ in
            self?.timedOut(id)
        }
        lastFailure = nil
        proceed()
    }

    private func makeManager() -> CLLocationManager {
        let manager = CLLocationManager()
        // The map needs a street, not a doorway: a coarser fix comes back sooner.
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.delegate = self
        self.manager = manager
        log("Location: asking locationd as \(Bundle.main.bundleIdentifier ?? "a tool with no bundle id"); permission is \(manager.authorizationStatus.name)")
        return manager
    }

    /// Moves every waiting request on: asks for permission, asks for a fix, or refuses.
    private func proceed() {
        guard let manager, !waiting.isEmpty else { return }
        let status = manager.authorizationStatus
        if status.allowed {
            if !requesting {
                requesting = true
                manager.requestLocation()
            }
        } else if status == .notDetermined {
            // Prompts once; locationManagerDidChangeAuthorization calls proceed() with the answer.
            if !askedPermission {
                askedPermission = true
                log("Location: asking macOS for Location permission")
                manager.requestWhenInUseAuthorization()
            }
        } else {
            failAll(Self.refused)
        }
    }

    private func timedOut(_ id: String) {
        guard waiting.removeValue(forKey: id) != nil else { return }
        let status = manager?.authorizationStatus ?? .notDetermined
        let message = status == .notDetermined ? Self.notAsked : (lastFailure ?? Self.noFix)
        log("Location: gave up after \(Int(Self.timeoutSeconds)) s: \(message)")
        send(.locationError(id: id, message: message))
        if waiting.isEmpty { cancelRequest() }
    }

    private func reply(_ id: String, fix: CLLocation) {
        send(.location(
            id: id,
            lat: fix.coordinate.latitude,
            lon: fix.coordinate.longitude,
            accuracy: fix.horizontalAccuracy >= 0 ? fix.horizontalAccuracy : nil,
            at: Int((fix.timestamp.timeIntervalSince1970 * 1000).rounded())
        ))
    }

    private func reply(_ id: String, error message: String) {
        log("Location: \(message)")
        send(.locationError(id: id, message: message))
    }

    private func answerAll(_ fix: CLLocation) {
        let ids = Array(waiting.keys)
        waiting.values.forEach { $0.invalidate() }
        waiting = [:]
        log(String(format: "Location: fix within %.0f m, %.0f s old", fix.horizontalAccuracy, -fix.timestamp.timeIntervalSinceNow))
        for id in ids { reply(id, fix: fix) }
    }

    private func failAll(_ message: String) {
        let ids = Array(waiting.keys)
        waiting.values.forEach { $0.invalidate() }
        waiting = [:]
        cancelRequest()
        log("Location: \(message)")
        for id in ids { send(.locationError(id: id, message: message)) }
    }

    /// Stops a requestLocation() nobody waits for any more.
    private func cancelRequest() {
        if requesting { manager?.stopUpdatingLocation() }
        requesting = false
    }

    private static func usable(_ fix: CLLocation) -> Bool {
        fix.horizontalAccuracy >= 0 && CLLocationCoordinate2DIsValid(fix.coordinate)
    }

    // MARK: CLLocationManagerDelegate (on the location thread)

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        log("Location: permission is \(manager.authorizationStatus.name)")
        proceed()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        requesting = false
        guard let fix = locations.last(where: Self.usable) else { return proceed() }
        answerAll(fix)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        requesting = false
        guard !waiting.isEmpty else { return }
        switch (error as? CLError)?.code {
        case .denied?:
            failAll(Self.refused)
        case .locationUnknown?:
            // macOS has no fix yet (its Wi-Fi scan may still be running): try again until the
            // requests time out, then report this.
            lastFailure = Self.noFix
            log("Location: no fix yet, trying again")
            Timer.scheduledTimer(withTimeInterval: 1, repeats: false) { [weak self] _ in self?.proceed() }
        default:
            failAll("macOS could not locate this Mac: \(error.localizedDescription). \(Self.wifiHint)")
        }
    }

    // MARK: Messages for the app (it shows them and falls back to the saved fix or a tap)

    static let wifiHint = "A Mac has no GPS: macOS locates it from nearby Wi-Fi networks, so Wi-Fi must be on."
    static let wifiOff = "Wi-Fi is off, so macOS cannot locate this Mac (it has no GPS and works from nearby Wi-Fi networks)."
    static let noFix = "macOS could not locate this Mac. \(wifiHint)"
    static let servicesOff = "Location Services is off. Turn it on in System Settings > Privacy & Security > Location Services."
    static let refused = "Location access was refused. Turn on \"Travel Buddy audio helper\" in System Settings > Privacy & Security > Location Services, then try again."
    static var notAsked: String {
        Bundle.main.bundlePath.hasSuffix(".app")
            ? "macOS has not allowed Location yet. Answer its prompt for \"Travel Buddy audio helper\", or turn it on in System Settings > Privacy & Security > Location Services."
            : "macOS asks for Location only for an app bundle, and this helper runs as a plain tool (started with --no-app-bundle, or BuddyAudio.app could not be set up: see its log)."
    }
}

private extension CLAuthorizationStatus {
    /// macOS grants .authorizedAlways (3); 4 is iOS's "when in use", unavailable in Swift on macOS.
    var allowed: Bool { self == .authorizedAlways || rawValue == 4 }

    var name: String {
        switch self {
        case .notDetermined: return "not decided yet"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorizedAlways: return "allowed"
        @unknown default: return rawValue == 4 ? "allowed (when in use)" : "unknown (\(rawValue))"
        }
    }
}
