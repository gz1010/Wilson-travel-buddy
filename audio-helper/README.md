# buddy-audio: the Argmax audio helper

A small Swift program that runs Argmax on the Apple Silicon Mac and serves
the React Native app over a WebSocket on `127.0.0.1:8765`. It also owns the
camera for the app's Look screen and asks macOS where the Mac is for the map
(see "Location" below). The message
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
- **speak**: Qwen3-TTS through TTSKit, queued, interruptible. While speech
  plays, `speak.level {value}` (0-1, about 20 a second) follows the loudness
  of the audio at the playhead, for Wilson's mouth; 0 when it stops.
- **wake word** ("Wilson, …"): see "Wake word" below.
- **mute**: drops microphone audio while the app's voice plays.
- **location** (the map): `location.get {id}` answers `location {id, lat, lon,
  accuracy, at}` or `location.error {id, message}`; see "Location" below.
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

## Wake word

"Wilson, where is the cathedral?" or "Hey Wilson" works without a tap, and
fully offline: no keyword-spotting service, just Argmax's Whisper (the same
model as listen) on short speech segments.

- `wake.start` turns it on; the app sends it again every 5 s as a keepalive.
  After 20 s without any message from the app (it quit or crashed), or when a
  new client connects, the helper turns the microphone off. `wake.stop` turns
  it off.
- It listens only while the microphone is free: a `listen.start` or
  `conversation.start` takes the microphone, and the wake word comes back
  half a second after they end. Audio is dropped while muted or speaking.
  `wake.state {listening}` says when it starts and stops listening.
- Its own Endpointer cuts the sound into sentences (0.7 s of quiet ends one).
  A sentence must reach a loudness floor (`--wake-floor`, microphone RMS,
  default 0.012) before Whisper reads it, and at most 20 sentences a minute
  are read. Whisper reads it in English, with " Wilson" as the previous text
  (prompt tokens) so the name comes out spelled that way; a short sentence is
  read whole, a longer one only its first 2 s (never more than 6 s), with no
  temperature fallback, so a check stays quick.
- If the reading starts with the name (after up to two words like "hey",
  "hi", "OK so"; accents, case and punctuation ignored; one letter of slack:
  Willson, Wilsen, Will son), the helper sends `wake.heard {text}` while the
  person is still talking (Wilson shows that he is listening, and `level`
  follows the voice), then `wake {text, heard, sinceEndMs}` when the sentence
  ends: `text` is the rest after the name ('' for "Wilson" alone), `heard`
  the whole sentence. `listen.stop` ends that sentence early. Other sentences
  are dropped and never leave the helper.
- The app (useBuddy) sends `text` as a question; for the name alone it says
  "Yes?" and listens. After a spoken answer it listens for a follow-up for 6 s
  (`listen.start {quietMs: 6000}`) without a tap. It turns the wake word off
  while Wilson listens, thinks or speaks, and while Translate is open.

Check it without a microphone (or the app):

```sh
.build/release/BuddyAudio --wake-selftest          # the name parsing, no models
say -o /tmp/w1.aiff "Wilson, where is the cathedral?"
say -o /tmp/w2.aiff "Will someone show me the cathedral?"
BUDDY_WAKE_TEST=/tmp/w1.aiff,/tmp/w2.aiff .build/release/BuddyAudio --port 8767 --no-app-bundle
# logs: wake word -> app: wake "Where is the cathedral?" … / not for Wilson: Will someone …
```

`BUDDY_WAKE_TEST` plays each file into the wake word in real time, as if the
microphone heard it; `BUDDY_WAKE_PROMPT=""` turns the prompt tokens off for
comparison. Stop that helper when done (it keeps running).

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

## Location

The map's locate button asks the helper (`location.get {id}`), the helper asks
macOS (CoreLocation, one `requestLocation`, up to 8 s) and answers `location
{id, lat, lon, accuracy, at}` (accuracy in metres, `at` in ms since 1970) or
`location.error {id, message}`. The app is sandboxed and makes no network
call; the helper sends nothing over the network either: it only asks macOS's
locationd.

**A Mac has no GPS.** macOS works out where it is from the Wi-Fi networks it
can see, so Wi-Fi must be switched **on** (it need not be joined to a network;
offline, macOS can only use what it has cached for the area, so it may fail
too). With Wi-Fi off the helper answers at once: "Wi-Fi is off, so macOS
cannot locate this Mac". The app then uses the last fix it saved (every macOS
fix inside the pack's map is saved, and the "You:" chip says how old it is,
e.g. "Plaza Nueva (last known, 2 h ago)"), and failing that asks you to tap the
map. A fix far from the pack's city (you are testing at home) moves no one: the
app says how far away macOS puts the Mac.

**Which app gets the permission.** macOS asks for Location only on behalf of
an app bundle: for a bare command-line tool it never shows the prompt and the
request stays "not determined" (CoreLocationAgent logs `client bundle is NULL.
Skip showing AuthPrompt`, even with an embedded Info.plist; checked on macOS
26). So at start the helper copies itself into
`~/Library/Application Support/TravelBuddy/BuddyAudio.app` (bundle id
`com.travelbuddy.buddy-audio`, Info.plist from `Support/Info.plist`, which
`Package.swift` also links into the binary; signed ad hoc with
`codesign --sign -`, offline) and `execv`s that copy: same pid, arguments and
log, so `scripts/start.sh` notices nothing. It refreshes the copy whenever the
build changes and registers it with Launch Services (locationd forgets the
answer for a bundle Launch Services does not know). The first `location.get`
then shows macOS's prompt for **"Travel Buddy audio helper"**, and it appears
under System Settings > Privacy & Security > Location Services under that name
(turn it on there if you clicked Don't Allow, then try again; Location
Services itself must be on). macOS asks again after every rebuild of the
helper (an ad hoc signature changes with each build) and if the bundle moves;
restarting an unchanged helper does not ask. `ps` shows the helper as
`.../BuddyAudio.app/Contents/MacOS/BuddyAudio`. `--no-app-bundle` turns the
copy off (no Location then). The app's startup locate asks once at launch, so
after a rebuild the prompt shows when the app starts.

Camera and microphone are unaffected: macOS still asks for the app that
started buddy-audio (see "Camera access"), whether or not it runs from the
bundle.

Test it without the app, with the helper running (Node 22+; prints the fix):

```bash
node -e "const w=new WebSocket('ws://127.0.0.1:8765');w.onopen=()=>w.send(JSON.stringify({type:'location.get',id:'t'}));w.onmessage=e=>{const m=JSON.parse(e.data);if(m.id==='t'){console.log(m);process.exit(0)}}"
```

The helper's log says what macOS decided: `Location: permission is allowed`,
`Location: fix within 40 m, 0 s old`, or the reason it gave up.

There is one `BuddyAudio.app` per user, shared by every copy of the helper. A
new build started on a spare port to test something else replaces it (and
macOS then asks for Location again), so start such a test with
`--no-app-bundle` unless you are testing Location.

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
