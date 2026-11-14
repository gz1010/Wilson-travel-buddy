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

**Two voices:** the translator needs two different people at hour one, at the
1:30am run-through and at the recording. Whenever B is not in the room, B is
the local over a phone call on speaker, held near the Mac. Settle this on the
first call.

## What the base code already does

The base code on `main` has a first version of every feature, so the job
from here is to make each one real, fast and reliable rather than to build
it from nothing.

| Piece | State |
|---|---|
| Core logic (`app/src/core`): trip extraction, scoring, recommendations, guide, intent routing, translation, sunrise and sunset | Written and covered by 34 Node tests (`npm test`) |
| Screens (`app/src/ui`): home, suggestions, itinerary, conversation, time/place/weather controls, translator, loading | Written, type-checked, bundled for macOS. **Never run on a Mac** |
| Offline map (`app/src/map`) | Written; tiles come from `scripts/build-tiles.mjs`. **Never run** |
| Bonsai-2 client | Streams from `llama-server`; falls back to recorded answers |
| Audio helper (`audio-helper/`, open-source Argmax) | Written against the SDK's source. **Never compiled**: expect fixes on the first build |
| Argmax Pro | Licence step only; live speaker labels not wired (see `audio-helper/README.md`) |
| Seville pack | 25 seed places, 25 facts, 20 phrases, sample forecast. Coordinates approximate, hours unverified |

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
| Argmax | Start on the **open-source SDK** (what the base code uses); try **Pro** for live speaker labels as a stretch | The open-source path is written; Pro needs its models wired (see `audio-helper/README.md`). |
| Diarization floor | SpeakerKit runs in the judged build however turns are taken, and its labels are on screen and in the video | It is a hard rule. Turn-taking can fall back; diarization cannot. |
| Turn-taking ladder | (1) Pro live labels, (2) voice prints after each sentence (base code), (3) push-to-talk per speaker, with SpeakerKit still labelling each recorded sentence | Each step down keeps Argmax diarization in the app. |
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

`Companion` is the seam between the two halves; `useBuddy`
(`app/src/ui/useBuddy.ts`) is the one loop that drives it. Typed text and the
microphone both go through `send()`, every screen reads from the hook, and
nobody writes a second loop. A owns the voice parts of the hook (`talk`,
`say`, muting); B owns the rest.

### Between the app and the audio helper (WebSocket, JSON messages)

| App → helper | Helper → app |
|---|---|
| `hello` | `ready` with the model names and whether Pro is active |
| `listen.start` / `listen.stop` | `partial {text}`, then one `final {text, language}` |
| `conversation.start {languages}` / `conversation.stop` | `partial {text, speaker}`, `final {text, language, speaker}` |
| `mute {muted}`: while muted the helper drops microphone audio and starts from an empty buffer on unmute | `level {value}` for the microphone meter |
| `speak {id, text, language}` / `speak.stop` | `speak.done {id}`, sent when playback has finished (check TTSKit's `play` returns after playback, not after generation) |
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

Hour one answers three questions for the 5:30 sync: does the app run on
both Macs, does Spanish work on Bonsai-2, and does the audio helper run.

**Now, before the call:** both start the downloads (`scripts/fetch-models.sh`;
on B's Mac it skips Argmax). They take a while.

**Both, first 10 minutes on a call:** agree the contracts above, settle the
two-voices question, and create `main` from the base-code branch.

**A**
1. Ask in Discord: is it fine for the app to run `llama-server` and an
   audio helper as local processes; must the submission use Argmax
   diarization or are speech-to-text and voice enough; and is the video a
   file in the post or a link?
2. `cd audio-helper && swift build -c release`. It has never been compiled;
   fix what breaks. Then `.build/release/BuddyAudio --prepare`, turn Wi-Fi
   off, and run it again: it must log `Ready`.
3. With the app open, prove the three audio pieces: the microphone button
   (English), a spoken reply, and the translator on a two-person exchange.
4. Run 2B and 4B; record tokens per second and time to first token in
   `docs/BENCHMARKS.md`. Translate ten traveller sentences each way and grade
   them. This is the go/no-go on Spanish.

**B**
1. `cd app && npm install && npm test`; then `cd macos && pod install`, and
   run the app from Xcode (scheme `TravelBuddy-macOS`) or with
   `npm run macos`. It should open on stand-ins. Fix what breaks: it has
   never run on a Mac.
2. Run the Intel `llama-server` with 2B (`scripts/start.sh` does it) and
   time one reply of about 100 tokens. Under 8 tokens per second is too slow:
   A then runs a second `llama-server` for development, and B points
   `LLM_URL` in `app/src/config.ts` at it locally, never committed.
3. Map: `node scripts/build-tiles.mjs`, restart Metro with
   `--reset-cache`, and check the map shows streets with Wi-Fi off. If not
   within 45 minutes, the map stays pins on a plain background.

**5:30 sync (15 minutes):** confirm the app runs on both Macs, language,
model size, and the map route.

## The video (1:50, budgeted now)

The rule is under 2:00; the script targets 1:50. Change it only at a sync.

| Beat | Seconds | On screen | Needs |
|---|---|---|---|
| 1 | 10 | Wi-Fi switched off; "Offline" badge and model names in frame | Launch |
| 2 | 25 | A says the spec's example sentence; the itinerary appears with the Tuesday museum slot | Feature 1 |
| 3 | 20 | Clock at 13:00, "What should I do now?"; spoken reason; map flies to the place | Features 2, 5 |
| 4 | 15 | Clock to 17:00 (rain at 16:00); the list switches to indoor places, the reason cites rain | Features 2, 6 |
| 5 | 10 | A guide question answered aloud from the pack | Feature 3 |
| 6 | 30 | Two people talk across the Mac; sides labelled by Argmax, each translation spoken | Feature 4 |

**Owners:** A records (screen recording plus room audio). B trims, writes
the one-sentence description (the README's first line), and posts in
`#submissions` with team names, repository link and video.

## Schedule

| When | A | B | At the checkpoint; if behind, cut |
|---|---|---|---|
| Sat 5:30–8:00 | Voice loop working end to end in the app: microphone → companion → voice, with sentence-by-sentence speech and muting | Real Seville data: places from OpenStreetMap with hours checked, to 40; replace `src/fixtures/llmAnswers.ts` with real Bonsai output | **8:00 merge:** beats 1–2 by voice; first Wi-Fi-off cold launch on A |
| 8:30–11:00 | Translator: voice prints after each sentence, tune `--voice-threshold`; push-to-talk fallback with SpeakerKit labels | Tune recommendations against the real model (beats 3–4); map tiles and polish | **11:00 merge:** beats 1–5 by voice. Behind: itinerary edits by voice go; editing on screen stays |
| 11:00–1:30 | Stretch: Pro live speaker labels. Otherwise translator polish | Guide answers (beat 5), environment panel with a real forecast, pack to 60 places | **1:30 merge:** full shot list once with Wi-Fi off; **A records it as the backup video** |
| 2:00–7:00 | Sleep | Sleep | |
| Sun 7:00–9:00 | Speed: first reply, first audio | Pack fixes, README, check the backup video's timing | **9:00 freeze:** tag it. A feature failing its "done when" drops to its fallback in the cut order; it is hidden only if it crashes |
| 9:00–9:45 | Restart, Wi-Fi off, cold launch, shot list twice, confirm nothing connects outward | Fresh clone, set up using only the README | Bug fixes only |
| 9:45–10:45 | Record, three takes at most | Plays the local | If no take is better, submit the 1:30 backup |
| 10:45–11:15 | Hand over the file | Trim to under 2:00, upload | |
| **11:15** | | Post in `#submissions` | Hard stop 11:30 |

Order of cuts when time runs out: itinerary edits by voice, then live
speaker labels (step down the turn-taking ladder; diarization stays), then
the environment panel (one line of text), then map tiles (pins only). Trip
setup, recommendations, the time control and Argmax diarization are never
cut; they are the demo.

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
