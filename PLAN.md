# Travel Buddy — two-person build plan

What we are building is in [SPEC.md](SPEC.md). This file is who builds what,
in what order, and by when. Where the two differ, this file wins.

- **A** = the Apple Silicon Mac. Owns the Argmax audio helper, the audio
  client in the app, the translator, the launch scripts, every Wi-Fi-off
  test, and the recording. The judged build runs here.
- **B** = the second computer, assumed to be an Intel Mac. Owns the app's
  logic and screens, the destination pack, the prompts and the map. B writes
  only TypeScript and never builds the audio helper.

Times are Eastern. Sunday's times are fixed by the noon deadline.

## How the app is put together

Three local processes, all on 127.0.0.1, so everything works with Wi-Fi off:

```
┌───────────────────────────────┐   HTTP + streaming   ┌──────────────────────┐
│ React Native macOS app (TS)   │ ───────────────────▶ │ llama-server :8080   │
│ screens, logic, prompts, map  │                      │ Bonsai-2 GGUF        │
│                               │   WebSocket          ├──────────────────────┤
│                               │ ◀──────────────────▶ │ buddy-audio :8765    │
└───────────────────────────────┘                      │ Swift + Argmax       │
                                                        │ mic, voice, speakers │
                                                        └──────────────────────┘
```

- **Why a helper for audio:** Argmax has no React Native SDK, only Swift
  and Kotlin. A standalone Swift program keeps Argmax out of the app's Xcode
  project, so B's build never touches it, and A can swap Pro for open-source
  without either of you editing app code.
- **Without the helper** (always on B's machine), the app falls back on its
  own: typed input instead of the microphone, on-screen text instead of the
  voice, and a scripted conversation for the translator.
- **Starting it:** `scripts/start.sh` starts `llama-server` and
  `buddy-audio`, then the app. That script is what runs on camera.

## How we work feature by feature

Every feature is built twice, in this order:

1. **B builds it on typed text** in the app, and merges when it works that
   way.
2. **A lights it up with voice.** The microphone produces the same text,
   and the reply goes to the voice as well as the screen.

B is never waiting on A's machine. The translator is the one feature A
builds end to end.

## Decisions already made

Each is checked in hour one and confirmed or changed at the 5:30 sync.
After that they do not change.

| Decision | Choice | Why |
|---|---|---|
| Framework | react-native-macos **0.81** (with react-native 0.81.6), TypeScript | 0.83.0 is a six-week-old dot-zero release. 0.81 still allows old-style native modules if anything needs one. |
| Destination | Seville, Spanish ↔ English | Argmax's voice speaks only ten languages (English, Chinese, Japanese, Korean, German, French, Russian, Portuguese, Spanish, Italian). Spanish is the safest of them for a small model. One of you has to speak it on camera; if neither can, pick a language from that list that one of you speaks. |
| Argmax | **Pro SDK** for speech-to-text and live speaker labels; open-source **TTSKit** for the voice | Pro's streaming diarization labels speakers while they talk, which makes the translator. Fallback: the open-source SDK for everything, labelling each sentence after it ends by comparing voice prints. |
| Pro key | Read by the helper from `ARGMAX_API_KEY` or `~/.travelbuddy/argmax-key` | Never in the repository, never in the app. |
| Bonsai-2 runtime | PrismML's `llama-server` with the GGUF file, on both machines, at `127.0.0.1:8080` | It runs on Intel too (CPU only), so B can test prompts against the real model. |
| Bonsai-2 size | 4B for everything | Drop to 2B if a 12-word sentence takes over 1.5 s to translate on A. Move to 9B only if 4B fails the JSON tests. |
| Pack search | Bundled JSON, searched in memory with MiniSearch | 100 places need no database, and the same code runs in Node tests. |
| Map | MapLibre GL JS in `react-native-webview`; tiles converted to one bundled file | No local server or file-access tricks; without tiles it still shows the pins. |

Model settings that matter: turn thinking off on every request
(`chat_template_kwargs: {"enable_thinking": false}`, temperature 0.7,
top_p 0.8, top_k 20, presence_penalty 1.5), and use
`response_format: json_schema` for anything the code parses.

## Contracts

### In the app (`app/src/core/types.ts`)

```ts
interface LLMClient {
  stream(req: ChatRequest, onToken: (t: string) => void): Promise<string>;
  json<T>(req: ChatRequest, schema: JSONSchema): Promise<T>;
}
interface AudioClient {
  listen(onPartial: (text: string) => void): Promise<Heard>;   // one utterance; resolves on silence
  speak(text: string, lang: Lang): Promise<void>;
  conversation(onEvent: (e: TurnEvent) => void): () => void;   // translator; returns stop()
}
interface Companion {
  handle(text: string, onEvent: (e: CompanionEvent) => void): Promise<void>;
}
```

`Companion` is the seam between the two halves: A's voice loop hands it
text and speaks what comes back; everything behind it is B's.

### Between the app and the audio helper (WebSocket, JSON messages)

| App → helper | Helper → app |
|---|---|
| `hello` | `ready` with the model names and whether Pro is active |
| `listen.start` / `listen.stop` | `partial {text}`, then one `final {text, language}` |
| `conversation.start {languages}` / `conversation.stop` | `partial {text, speaker}`, `final {text, language, speaker}` |
| `mute {muted}` (while the app's voice is speaking) | `level {value}` for the microphone meter |
| `speak {id, text, language}` / `speak.stop` | `speak.done {id}` |
| | `status {message}`, `error {message}` |

The full message shapes are in `app/src/services/audioProtocol.ts`; the
helper must match it.

### Stand-ins (used automatically when the helper is not running)

| Stand-in | What it does |
|---|---|
| `TypedAudio` | The text box is the microphone; speaking only shows text |
| `ScriptedConversation` | Replays `app/src/fixtures/conversation_es_en.json` for the translator |
| `FixtureLLM` | Recorded answers, for when no `llama-server` is running |

## Who builds what

| Feature | B builds (on typed text) | A builds (voice) | Done when |
|---|---|---|---|
| 1. Trip setup | Extraction prompt and schema, confirm/edit screen, saving | Microphone into the same entry point, with partial transcripts on screen | A says the example sentence from the spec; the itinerary shows the Tuesday museum slot and survives relaunch |
| 2. Recommendations | Scoring in code; the model picks 3 of the top 8 and writes reasons, with place IDs fixed by the schema; code-written reasons if it fails; home list; time, day and location controls | "What should I do now?" speaks the top one | Moving the clock from 13:00 to 17:00 with rain forecast after 16:00 drops the outdoor viewpoint; every place is in the pack; refresh under 3 s on A |
| 3. Voice guide | Search over the pack, a prompt that says "not in my guide", "move the museum to tomorrow" | The voice loop: streamed text, spoken sentence by sentence, microphone muted while speaking | A pack question is answered from the pack; an off-pack question is declined; first audio within 2.5 s of speech ending |
| 4. Translator | Nothing beyond the phrasebook | All of it: helper conversation mode, speaker → traveller or local, translation, voice, the two-sided screen | Six alternating turns, no buttons, at least five on the correct side. Otherwise ship push-to-talk and say so in the README |
| 5. Map | All of it: web view, pins, move to a place, click to set "where I am", distance and direction in code, tile build script | Nothing | Renders with Wi-Fi off; choosing a suggestion moves it |
| 6. Environment panel | All of it: forecast with its age, sunrise and sunset in code | Nothing | Sunrise within two minutes of a published value |
| Launch | Loading screen layout | `scripts/start.sh`, waiting for both helpers, "Offline" badge, model names | First reply needs no warm-up |

## Hour one (4:30–5:30)

**Both, first 15 minutes on a call:** read the contracts above and agree
them. Create `main` from the base-code branch and pull it.

**A**
1. Ask in Discord: is it fine for the app to run `llama-server` and an
   audio helper as local processes?
2. Pro SDK: follow Argmax's installation guide (it needs the provisioning
   token, `axst_…`, as well as the `ax_…` key), build `buddy-audio` in Pro
   mode, run it online once so the licence activates, then **turn Wi-Fi off
   and run it again**. If it fails offline, switch to open-source mode
   (`audio-helper/README.md`) and do not revisit.
3. Prove the three audio pieces through the helper: `listen` in Spanish and
   English, `speak` in Spanish, and live speaker labels on a two-person
   exchange.
4. Run PrismML's `Bonsai-demo` setup for 2B, 4B and 9B. Record tokens per
   second and time to first token in `docs/BENCHMARKS.md`. Translate ten
   traveller sentences each way on 2B and 4B and grade them. This is the
   go/no-go on Spanish.
5. With Wi-Fi off, cold-start the helper and `llama-server` from
   `scripts/start.sh`.

**B**
1. `cd app && npm install && npm test`; then `cd macos && pod install`, and
   run the app from Xcode (scheme `TravelBuddy-macOS`) or with
   `npm run macos`. It should open on stand-ins.
2. Run the Intel build of `llama-server` with 2B and note the speed. If it
   is too slow to work with, the app uses `FixtureLLM` automatically.
3. Map spike, 45 minutes: run `scripts/build-tiles.mjs` for Seville, then
   check the map shows streets and pins with Wi-Fi off. If not by then, the
   map stays pins on a plain background.

**5:30 sync (15 minutes):** confirm language, model size, Pro or
open-source, and the map route.

## Schedule

| When | A | B | At the checkpoint; if behind, cut |
|---|---|---|---|
| Sat 5:30–8:00 | Voice loop: `listen` → `Companion` → `speak`, on the base code's simple companion | Pack to 30 places; feature 1 on typed text | **8:00 merge:** feature 1 by voice; first Wi-Fi-off cold launch on A. Behind: cap the pack at 40 places |
| 8:30–11:00 | Loading screen and `start.sh`; translator with push-to-talk | Feature 2, then feature 3, on typed text | **11:00 merge:** features 2 and 3 by voice. Behind: itinerary edits by voice go; editing on screen stays |
| 11:00–1:30 | Translator with live speaker labels; write the shot list | Map, environment panel, pack to 60 places | **1:30 merge:** every feature in, full shot list once with Wi-Fi off. Speaker labels under 5 of 6: ship push-to-talk |
| 2:00–7:00 | Sleep | Sleep | |
| Sun 7:00–9:00 | Speed, badge, model names | Pack fixes, README | **9:00 freeze:** tag it. Anything failing its "done when" leaves the app |
| 9:00–9:45 | Restart, Wi-Fi off, cold launch, shot list twice, confirm nothing connects outward | Fresh clone, set up using only the README | Bug fixes only |
| 9:45–10:45 | Record, three takes at most | Plays the local | |
| 10:45–11:15 | | Trim the video to under 2:00 | |
| **11:15** | Post in `#submissions` | | Hard stop 11:30 |

Order of cuts when time runs out: itinerary edits by voice, then live
speaker labels (push-to-talk instead), then the environment panel (one line
of text), then map tiles (pins only). Trip setup, recommendations and the
time control are never cut; they are the demo.

## Repository and git

```
app/                          React Native macOS app
  macos/                      Xcode project (generated; only add files through Xcode, and say so)
  src/core/             B     types, geo, sun, scoring, pack search, prompts, companion. No React imports, so Node tests run it
  src/services/llm/     B     llama-server client, FixtureLLM
  src/services/audio*   A     audio helper client and protocol; TypedAudio stand-in
  src/ui/               B     every screen except the translator
  src/ui/translator/    A     translator screen
  src/map/              B     web view map and its HTML
  src/pack/seville/     B     places, facts, phrases, forecast
  src/fixtures/         both  recorded model answers, scripted conversation
audio-helper/           A     Swift package: buddy-audio (Argmax)
scripts/                A     start.sh, fetch-models.sh; B owns build-tiles.mjs
docs/                         benchmarks, shot list
```

- **Xcode project:** the only shared native file is
  `app/macos/TravelBuddy.xcodeproj/project.pbxproj`. Nobody needs to edit it
  for JavaScript work. Anyone adding a native dependency runs `pod install`
  and commits the result in its own commit, announced first.
- **Tests:** `npm test` in `app/` runs everything in `src/core` in Node, on
  any machine. B's merge gate is `npm test && npx tsc --noEmit`; A's is the
  app launching with the helper.
- **Branches:** `a/<feature>` and `b/<feature>`. Rebase onto `main` and push
  when the "done when" check passes, and at every checkpoint. `main` always
  launches. No review step; there is no time.
- **Never committed:** the Argmax key and provisioning token, model files,
  the `llama-server` binary, built map tiles. `scripts/fetch-models.sh` and
  `scripts/build-tiles.mjs` recreate them; the README says to run them once
  while online.
- **Pack content:** pull place names, coordinates and opening hours from
  OpenStreetMap by script rather than typing them; hand-write the interest
  tags and facts. Start with the 20 places around the demo route.

## Risks and fallbacks

| Risk | Fallback |
|---|---|
| The Pro licence needs the network at launch | Open-source mode in the helper, decided in hour one |
| The Pro and open-source Argmax packages conflict in one build | Pro mode takes TTS from whatever Pro ships; if it has none, use open-source for everything |
| Live speaker labels flip sides | Use the detected language to pick the side; then push-to-talk |
| Spanish translation is weak on 4B | 9B for translation; exact phrasebook matches skip the model |
| react-native-macos build trouble on one machine | Stay on 0.81; the other person's machine is the reference; core logic keeps moving under `npm test` |
| A cold launch reaches for the network (Argmax tokenizers, map fonts) | Models fetched to local folders and loaded with downloads off; no map fonts (pins are HTML); tested at 8:00pm, 1:30am and 9:00am |
| The model returns bad JSON or invents a place | Schema-constrained output with place IDs as an enum, code-written reasons |
| Organizers reject helper processes | Unlikely to come up; if it does, A moves the helper into the app as a native module behind the same `AudioClient` |
| The voice feeds back into the microphone | `mute` while speaking |
| An M5 Mac on macOS 26.2–26.4 fails to start the model | Set `GGML_METAL_TENSOR_DISABLE=1`. Also keep Low Power Mode off |

## If B's computer is Windows or Linux

react-native-macos needs a Mac, so B cannot run the app. B keeps
everything in `app/src/core` (it runs under `npm test` anywhere), the pack,
the prompts with recorded fixtures, and the tile build script. A takes the
screens, so from the start the map is pins only and the environment panel is
one line.
