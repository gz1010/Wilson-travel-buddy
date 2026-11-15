import AVFoundation
import CoreImage
import Foundation
import ImageIO
import QuartzCore

/// The camera, driven by messages from the app (camera.start, camera.snap, camera.stop,
/// camera.alive). The helper owns it, as it owns the microphone: it runs outside the app's
/// sandbox, so the app needs no camera entitlement. macOS asks for camera access for the
/// process that started buddy-audio (the terminal).
///
/// While running it sends preview frames (`camera.frame`, ~1000 px wide, JPEG quality 0.75, at
/// most 6 a second) and answers each snap with the next frame at ~1600 px, quality 0.85.
/// It captures the camera's 4:3 format of about 1760×1328 when it has one (the Scan preview is
/// taller than it is wide, so a 4:3 frame loses less to the crop), else 1920×1080.
/// Everything below runs on one serial queue, which is also the capture output's queue.
final class CameraService: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    /// The preview fills the top ~520 pt of a 390 pt window (1040 px tall on a Retina screen).
    /// 1000 px wide is ~750 px tall in 4:3: about 200 KB of base64 a frame, 1.2 MB/s at 6 fps.
    static let previewWidth: CGFloat = 1000
    static let previewQuality: CGFloat = 0.75
    static let previewInterval: CFTimeInterval = 1.0 / 6
    /// At most this much base64 a second of preview (a clear frame is ~200 KB, so 6 a second fit;
    /// a grainy one in a dim room can be 550 KB, and then the frames come ~3.5 a second).
    static let previewBytesPerSecond: Double = 2_000_000
    /// What the person froze, shown full screen and sent to Bonsai-2 (llama-server scales it to
    /// its --image-max-tokens budget, so a bigger photo costs no more than ~1024 vision tokens).
    static let snapWidth: CGFloat = 1600
    static let snapQuality: CGFloat = 0.85
    /// The app sends camera.alive every few seconds while it shows the preview; without any
    /// message from it for this long (the app quit or crashed), the camera turns itself off.
    static let leaseSeconds: CFTimeInterval = 15

    private let send: (Outgoing) -> Void
    private let queue = DispatchQueue(label: "buddy-audio.camera")
    private let context = CIContext()
    private let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

    private var session: AVCaptureSession?
    private var observers: [NSObjectProtocol] = []
    /// Goes up on every start and stop, so a permission answer or a failure from an older start is ignored.
    private var generation = 0
    private var wanted = false
    private var lastFrameAt: CFTimeInterval = 0
    /// The wait before the next preview frame: previewInterval, longer after a big frame.
    private var previewGap: CFTimeInterval = CameraService.previewInterval
    /// The first frame's size goes in the log once per start, to see which format the camera gave.
    private var loggedSize = false
    private var pendingSnaps: [String] = []
    private var lastHeardAt = CACurrentMediaTime()
    private var watchdog: DispatchSourceTimer?

    init(send: @escaping (Outgoing) -> Void) {
        self.send = send
    }

    // MARK: Messages (in the order the app sent them, from main.swift's inbox)

    func handle(_ m: Incoming) {
        queue.async { [self] in
            lastHeardAt = CACurrentMediaTime()
            switch m.type {
            case "camera.start": start()
            case "camera.snap":
                guard let id = m.id else { break }
                if session?.isRunning == true { pendingSnaps.append(id) } // answered with the next frame
                else { send(.cameraSnapped(id: id, jpeg: nil)) }
            case "camera.stop": stop()
            default: break // camera.alive: lastHeardAt is enough
            }
        }
    }

    /// Any message from the app shows it is still there (called for every message, before the inbox).
    func heardFromApp() {
        queue.async { [self] in lastHeardAt = CACurrentMediaTime() }
    }

    // MARK: Session

    private func start() {
        if wanted, session?.isRunning == true { return } // already running: the preview keeps going
        stop()
        wanted = true
        generation += 1
        let gen = generation
        startWatchdog()
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            begin(gen)
        case .notDetermined:
            log("Camera: asking macOS for camera access")
            AVCaptureDevice.requestAccess(for: .video) { granted in
                self.queue.async {
                    guard gen == self.generation, self.wanted else { return } // stopped while the prompt was up
                    if granted { self.begin(gen) } else { self.fail(Self.refused) }
                }
            }
        case .denied, .restricted:
            fail(Self.refused)
        @unknown default:
            fail(Self.refused)
        }
    }

    static let refused = "Camera access was refused. Allow it for the terminal running buddy-audio in System Settings > Privacy & Security > Camera, then restart buddy-audio."

    /// The camera's landscape 4:3 format at least as wide as a snap and at most 2048 px (no 4K),
    /// e.g. 1760×1328 on a MacBook's FaceTime HD camera or 1920×1440 on an iPhone. Of two the
    /// same size, the lower frame rate (the preview needs 6 a second). Nil: keep the preset's.
    static func captureFormat(of device: AVCaptureDevice) -> AVCaptureDevice.Format? {
        let fits = device.formats.compactMap { format -> (format: AVCaptureDevice.Format, width: Int32, fps: Float64)? in
            let size = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            guard CGFloat(size.width) >= snapWidth, size.width <= 2048, size.width > size.height,
                  abs(Int(size.width) * 3 - Int(size.height) * 4) <= Int(size.width) / 25 else { return nil }
            guard let fps = format.videoSupportedFrameRateRanges.map(\.maxFrameRate).max(), fps >= 15 else { return nil }
            return (format, size.width, fps)
        }
        return fits.min { a, b in a.width != b.width ? a.width < b.width : a.fps < b.fps }?.format
    }

    private func begin(_ gen: Int) {
        guard let device = AVCaptureDevice.default(for: .video) else {
            fail("No camera found on this Mac.")
            return
        }
        let session = AVCaptureSession()
        session.beginConfiguration()
        do {
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else { throw CameraError.cannotUse(device.localizedName) }
            session.addInput(input)
        } catch {
            session.commitConfiguration()
            fail("Could not open the camera (\(device.localizedName)): \(error.localizedDescription)")
            return
        }
        // The preset once the camera is in (canSetSessionPreset then asks this camera; set before,
        // a 1080p preset could keep a 720p-only camera from being added at all).
        if session.canSetSessionPreset(.hd1920x1080) { session.sessionPreset = .hd1920x1080 }
        else if session.canSetSessionPreset(.hd1280x720) { session.sessionPreset = .hd1280x720 }
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            fail("Could not read frames from the camera (\(device.localizedName)).")
            return
        }
        session.addOutput(output)
        // Never mirrored: the model must see writing the right way round.
        if let connection = output.connection(with: .video), connection.isVideoMirroringSupported {
            connection.automaticallyAdjustsVideoMirroring = false
            connection.isVideoMirrored = false
        }
        // The 4:3 format, set after the preset (which applies its own format). On macOS the
        // session may put its preset's format back when it starts, unless the device stays locked
        // until it is running; if the lock fails, the preset's 1920×1080 is fine too.
        var locked = false
        if let format = Self.captureFormat(of: device), (try? device.lockForConfiguration()) != nil {
            device.activeFormat = format
            locked = true
        }
        session.commitConfiguration()

        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { [weak self] note in
                let error = note.userInfo?[AVCaptureSessionErrorKey] as? Error
                self?.queue.async {
                    guard let self, gen == self.generation else { return }
                    self.fail("The camera stopped: \(error?.localizedDescription ?? "unknown error").")
                }
            },
            center.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: device, queue: nil) { [weak self] _ in
                self?.queue.async {
                    guard let self, gen == self.generation else { return }
                    self.fail("The camera was disconnected.")
                }
            },
        ]
        self.session = session
        lastFrameAt = 0
        previewGap = Self.previewInterval
        loggedSize = false
        session.startRunning() // blocks this queue until running; frames queue up behind it
        if locked { device.unlockForConfiguration() }
        guard gen == generation else { return }
        if session.isRunning {
            log("Camera: started (\(device.localizedName))")
        } else {
            fail("The camera (\(device.localizedName)) did not start. Is another app using it?")
        }
    }

    /// Turns the camera off. Safe to call when it is already off.
    private func stop() {
        generation += 1
        wanted = false
        watchdog?.cancel()
        watchdog = nil
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers = []
        for id in pendingSnaps { send(.cameraSnapped(id: id, jpeg: nil)) }
        pendingSnaps = []
        if let session {
            session.stopRunning()
            for output in session.outputs { (output as? AVCaptureVideoDataOutput)?.setSampleBufferDelegate(nil, queue: nil) }
            session.outputs.forEach { session.removeOutput($0) }
            session.inputs.forEach { session.removeInput($0) }
            self.session = nil
            log("Camera: stopped")
        }
    }

    private func fail(_ message: String) {
        log("Camera: \(message)")
        stop()
        send(.cameraError(message))
    }

    private func startWatchdog() {
        watchdog?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 2, repeating: 2)
        timer.setEventHandler { [weak self] in
            guard let self, self.wanted else { return }
            if CACurrentMediaTime() - self.lastHeardAt > Self.leaseSeconds {
                log("Camera: nothing from the app for \(Int(Self.leaseSeconds)) s; stopping the camera")
                self.stop()
            }
        }
        timer.resume()
        watchdog = timer
    }

    // MARK: Frames

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard wanted, session != nil, let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let now = CACurrentMediaTime()
        let previewDue = now - lastFrameAt >= previewGap
        guard previewDue || !pendingSnaps.isEmpty else { return } // most of the 30 a second
        let image = CIImage(cvPixelBuffer: pixels)
        if !pendingSnaps.isEmpty {
            let jpeg = encode(image, width: Self.snapWidth, quality: Self.snapQuality, sharp: true)
            log("Camera: snap, \(Self.describe(image, width: Self.snapWidth, jpeg))")
            for id in pendingSnaps { send(.cameraSnapped(id: id, jpeg: jpeg)) }
            pendingSnaps = []
        }
        guard previewDue else { return }
        lastFrameAt = now
        guard let jpeg = encode(image, width: Self.previewWidth, quality: Self.previewQuality, sharp: true) else { return }
        // A grainy (dim) picture compresses badly: fewer frames rather than flooding the app.
        previewGap = max(Self.previewInterval, Double(jpeg.utf8.count) / Self.previewBytesPerSecond)
        if !loggedSize {
            loggedSize = true
            log("Camera: frames \(Int(image.extent.width))×\(Int(image.extent.height)); preview \(Self.describe(image, width: Self.previewWidth, jpeg))")
        }
        send(.cameraFrame(jpeg: jpeg))
    }

    /// "1600×1207, 480 KB" for the log: the encoded size and the base64 length.
    private static func describe(_ image: CIImage, width: CGFloat, _ jpeg: String?) -> String {
        let scale = min(1, width / max(1, image.extent.width))
        return "\(Int(floor(image.extent.width * scale)))×\(Int(floor(image.extent.height * scale))), \((jpeg?.utf8.count ?? 0) / 1024) KB"
    }

    /// Scales down to `width` (never up) and encodes a base64 JPEG with Core Image.
    /// Internal rather than private so a scratch harness can check sizes without a camera.
    func encode(_ image: CIImage, width: CGFloat, quality: CGFloat, sharp: Bool) -> String? {
        let extent = image.extent
        guard extent.width > 0, extent.height > 0 else { return nil }
        let scale = min(1, width / extent.width)
        var scaled = image
        if scale < 1 {
            scaled = sharp
                ? image.applyingFilter("CILanczosScaleTransform", parameters: [kCIInputScaleKey: scale, kCIInputAspectRatioKey: 1])
                : image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            scaled = scaled.cropped(to: CGRect(x: 0, y: 0, width: floor(extent.width * scale), height: floor(extent.height * scale)))
        }
        let options = [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): quality]
        return context.jpegRepresentation(of: scaled, colorSpace: sRGB, options: options)?.base64EncodedString()
    }
}

enum CameraError: LocalizedError {
    case cannotUse(String)
    var errorDescription: String? {
        switch self {
        case let .cannotUse(name): return "\(name) cannot be used by this app"
        }
    }
}
