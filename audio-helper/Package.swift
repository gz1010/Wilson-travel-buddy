// swift-tools-version: 5.10
//
// buddy-audio: Travel Buddy's Argmax audio helper. Runs on the Apple Silicon
// Mac only, and serves speech-to-text, text-to-speech and speaker labels to
// the React Native app over a WebSocket on 127.0.0.1:8765.
//
// Two modes, chosen by a marker file next to this manifest:
//   (default)        open-source Argmax SDK: WhisperKit, TTSKit, SpeakerKit
//   .use-argmax-pro  Argmax Pro SDK (live speaker labels). Needs the private
//                    registry login from Argmax's installation guide first.
// See README.md.

import Foundation
import PackageDescription

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path
let usePro = FileManager.default.fileExists(atPath: "\(root)/.use-argmax-pro")

let ossDeps: [Package.Dependency] = [
    .package(url: "https://github.com/argmaxinc/argmax-oss-swift", from: "1.1.1"),
]
let ossProducts: [Target.Dependency] = [
    .product(name: "WhisperKit", package: "argmax-oss-swift"),
    .product(name: "TTSKit", package: "argmax-oss-swift"),
    .product(name: "SpeakerKit", package: "argmax-oss-swift"),
]
// The Pro SDK is a registry package (argmaxinc.argmax-sdk-swift). Its sample
// app imports WhisperKit through it, so the open-source package may not be
// needed alongside it; if SwiftPM reports duplicate modules, delete ossDeps
// from the Pro line below.
let proDeps: [Package.Dependency] = [.package(id: "argmaxinc.argmax-sdk-swift", from: "3.0.6")]
let proProducts: [Target.Dependency] = [.product(name: "Argmax", package: "argmaxinc.argmax-sdk-swift")]

// Links Support/Info.plist into the binary (__TEXT,__info_plist): a command-line tool needs a
// bundle id and NSLocation*UsageDescription before macOS Location Services will consider it.
// unsafeFlags are fine here because this is always the root package. See README.md, "Location".
let infoPlist: [LinkerSetting] = [
    .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", "\(root)/Support/Info.plist"]),
]

let package = Package(
    name: "buddy-audio",
    platforms: [.macOS("15.0")], // TTSKit needs macOS 15 (string form: .v15 needs tools 6.0)
    dependencies: usePro ? proDeps + ossDeps : ossDeps,
    targets: [
        .executableTarget(
            name: "BuddyAudio",
            dependencies: usePro ? proProducts + ossProducts : ossProducts,
            path: "Sources/BuddyAudio",
            swiftSettings: usePro ? [.define("ARGMAX_PRO")] : [],
            linkerSettings: infoPlist
        ),
    ]
)
