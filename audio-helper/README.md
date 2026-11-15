# buddy-audio: the Argmax audio helper

A small Swift program that runs Argmax on the Apple Silicon Mac and serves
the React Native app over a WebSocket on `127.0.0.1:8765`. It also owns the
camera for the app's Look screen. The message
protocol is in `app/src/services/audio/protocol.ts` and
`Sources/BuddyAudio/Protocol.swift`; keep them in step.

Argmax has no React Native SDK, which is why this is a separate program and
not a native module: it keeps Argmax out of the app's Xcode project, so the
Intel Mac never has to build it.

## Build and prepare (online, once)

```bash
cd audio-helper && swift build -c release
```

```bash
.build/release/BuddyAudio --prepare
```

`--prepare` downloads Whisper, Qwen3-TTS and Pyannote into
`~/Library/Application Support/TravelBuddy/argmax` and writes `manifest.json`
there. From then on every model loads from disk with downloads off. Test it:
turn Wi-Fi off and run `.build/release/BuddyAudio`; it should log `Ready`.

Options: `--port 8765`, `--models-dir DIR`, `--whisper-model NAME` (default
`large-v3-v20240930_626MB`; try `small` if partial transcripts lag),
`--voice-threshold 0.55` (how alike two sentences' voices must be to count as
the same speaker; tune it in the demo room).

## What it does

- **listen** (voice loop): records until about 0.8 s of silence, streams
  partial transcripts, then sends the final text and its language.
- **conversation** (translator): listens continuously; for each sentence it
  picks the likelier of the two languages, transcribes, and labels the
  speaker by comparing SpeakerKit voice prints. Labels arrive when each
  sentence ends, not live.
- **speak**: Qwen3-TTS through TTSKit, queued, interruptible.
- **mute**: drops microphone audio while the app's voice plays.
- **camera** (Look): `camera.start` turns the Mac's camera on (AVFoundation)
  and streams `camera.frame` previews (base64 JPEG, ~480 px wide, quality
  0.5, at most 6 a second); `camera.snap {id}` answers with `camera.snapped
  {id, jpeg}` (~1024 px, quality 0.8) from the next frame; `camera.stop`
  turns it off; `camera.error {message}` says why there is no picture (no
  camera, access refused, the session failed). Frames are never mirrored, so
  writing reads the right way round. The camera needs no models, so it works
  while the speech models are still loading. It also turns itself off when a
  new client connects (the app reloaded) or when it hears nothing from the
  app for 15 s (the app sends `camera.alive` every 4 s while the preview
  shows), so the camera light never stays on after the app quits. The app
  sends the snapped photo to Bonsai-2's vision on llama-server; nothing
  leaves the Mac.

## Camera access

macOS asks for camera access the first time Look starts the camera, and it
asks for **the app that started buddy-audio**: Terminal (or iTerm, or VS
Code) when you run `scripts/start.sh`. Allow it, or later turn it on in System
Settings > Privacy & Security > Camera for that terminal, then restart
buddy-audio. TravelBuddy.app itself needs no camera entitlement or usage
string: it never touches the camera, it only shows the frames the helper
sends. If access is refused, Look shows the helper's message instead of a
preview.

Test it without the app (Node 22+), with the helper running:

```bash
node -e "const w=new WebSocket('ws://127.0.0.1:8765');let n=0;w.onopen=()=>w.send(JSON.stringify({type:'camera.start'}));w.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='camera.frame'&&++n===12){console.log('12 frames, last',m.jpeg.length,'base64 chars');w.send(JSON.stringify({type:'camera.stop'}));process.exit(0)}if(m.type==='camera.error'){console.log(m.message);process.exit(1)}}"
```

## Argmax Pro mode (live speaker labels)

Pro's streaming diarization labels speakers while they talk. To try it:

1. Follow Argmax's installation guide (app.argmaxinc.com/docs, "Upgrading to
   Pro SDK"): it logs SwiftPM in to Argmax's package registry with the
   `axst_…` provisioning token.
2. Put the `ax_…` key in `~/.travelbuddy/argmax-key` (or `ARGMAX_API_KEY`).
   Never commit it.
3. `touch audio-helper/.use-argmax-pro`, then `swift build -c release` and run
   with `--pro`. It activates the licence and logs its status.
4. Turn Wi-Fi off and run it again. If the licence fails offline, delete
   `.use-argmax-pro` and stay on the open-source SDK.

Status: the licence step is in `Sources/BuddyAudio/ProSetup.swift`. The live
conversation stream is not wired yet; that file lists the exact calls from
Argmax's sample app to copy. If SwiftPM reports duplicate modules in Pro mode,
remove the open-source package from the Pro branch of `Package.swift`.

## Not compiled yet

This was written against the open-source SDK's source (argmax-oss-swift
v1.1.1) on a machine without macOS, so it has never been compiled. Expect a
few small fixes on the first `swift build`.
