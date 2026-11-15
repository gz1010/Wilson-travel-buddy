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
/// While running it sends small preview frames (`camera.frame`, ~480 px wide, JPEG quality 0.5,
/// at most 6 a second) and answers each snap with the next frame at ~1024 px, quality 0.8.
/// Everything below runs on one serial queue, which is also the capture output's queue.
final class CameraService: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    static let previewWidth: CGFloat = 480
    static let previewQuality: CGFloat = 0.5
    static let previewInterval: CFTimeInterval = 1.0 / 6
    static let snapWidth: CGFloat = 1024
    static let snapQuality: CGFloat = 0.8
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

    private func begin(_ gen: Int) {
        guard let device = AVCaptureDevice.default(for: .video) else {
            fail("No camera found on this Mac.")
            return
        }
        let session = AVCaptureSession()
        session.beginConfiguration()
        if session.canSetSessionPreset(.hd1280x720) { session.sessionPreset = .hd1280x720 }
        else if session.canSetSessionPreset(.high) { session.sessionPreset = .high }
        do {
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else { throw CameraError.cannotUse(device.localizedName) }
            session.addInput(input)
        } catch {
            session.commitConfiguration()
            fail("Could not open the camera (\(device.localizedName)): \(error.localizedDescription)")
            return
        }
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
        session.startRunning() // blocks this queue until running; frames queue up behind it
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
        let image = CIImage(cvPixelBuffer: pixels)
        if !pendingSnaps.isEmpty {
            let jpeg = encode(image, width: Self.snapWidth, quality: Self.snapQuality, sharp: true)
            for id in pendingSnaps { send(.cameraSnapped(id: id, jpeg: jpeg)) }
            pendingSnaps = []
        }
        let now = CACurrentMediaTime()
        guard now - lastFrameAt >= Self.previewInterval else { return }
        lastFrameAt = now
        if let jpeg = encode(image, width: Self.previewWidth, quality: Self.previewQuality, sharp: false) {
            send(.cameraFrame(jpeg: jpeg))
        }
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
