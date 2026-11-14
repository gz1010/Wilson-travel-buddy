# Travel Buddy — two-person build plan

What we are building is in [SPEC.md](SPEC.md). This file is who builds what,
in what order, and by when. Where the two differ, this file wins.

- **A** = the Apple Silicon Mac. Owns everything audio (Argmax), the app
  shell, every Wi-Fi-off test, and the recording. The judged build runs here.
- **B** = the second computer, assumed to be an Intel Mac. Owns the
  destination pack, the logic, the prompts, and every screen that is not
  audio. B never compiles Argmax. (If B is on Windows or Linux, see the last
  section.)

Times are Eastern. Sunday's times are fixed by the noon deadline; if Saturday
starts late, shorten Saturday's blocks, not Sunday's.

## How we work feature by feature

Every feature is built twice, in this order:

1. **B builds it on typed text.** A text field stands in for the microphone
   and silence stands in for the voice. B merges when the feature works that
   way.
2. **A lights it up with voice.** A's voice loop feeds real transcripts into
   the same entry point and speaks what comes back.

B is never waiting for A's machine, and A never has to understand B's
feature to wire it. The translator is the one feature A builds alone.

## Decisions already made

Each is checked in hour one and confirmed or changed at the 5:15 sync. After
that they do not change.

| Decision | Choice | Why |
|---|---|---|
| Destination | Seville, Spanish ↔ English | Argmax's voice speaks only ten languages (English, Chinese, Japanese, Korean, German, French, Russian, Portuguese, Spanish, Italian). Spanish is the safest of them for a small model. One of you has to speak it on camera; if neither can, pick a language from that list that one of you speaks. |
| Argmax | The open-source SDK: WhisperKit (speech-to-text), TTSKit (voice), SpeakerKit (who is speaking) | No key or licence, so nothing to activate online. |
| Turn-taking in the translator | Label the speaker after each finished sentence, not live | The open-source SpeakerKit only works on finished audio; live speaker labels are a paid feature. Fallback is a push-to-talk button per speaker. |
| Bonsai-2 runtime | PrismML's `llama-server` with the GGUF model file, on both machines, called at `127.0.0.1:8080` | It runs on Intel too (CPU only), so B can test prompts on the real model. The app starts the server itself; localhost works with Wi-Fi off. |
| Bonsai-2 size | 4B for everything | Drop to 2B if a 12-word sentence takes over 1.5 s to translate on A. Move to 9B only if 4B fails the JSON fixtures. |
| Map | MapLibre GL JS inside a web view, reading bundled tiles | Works on both machines. The native MapLibre package's macOS support is unverified and not worth the risk. |

Model settings that matter: turn thinking off on every request
(`chat_template_kwargs: {"enable_thinking": false}`, temperature 0.7,
top_p 0.8, top_k 20, presence_penalty 1.5), and use
`response_format: json_schema` for anything the code parses.

## Contracts

These live in `Packages/BuddyKit/Sources/BuddyCore` and are the first thing
on `main`. They change only at a sync, announced first.

```swift
protocol SpeechToText { func transcripts() -> AsyncStream<TranscriptEvent>; func stop() }
                        // TranscriptEvent: .partial(String) | .final(text, language)
protocol TextToSpeech { func speak(_ text: String, language: Lang) async; func stop() }
protocol TurnSource   { func turns() -> AsyncStream<Utterance> }
                        // Utterance: speaker (.traveler | .local), text, language
protocol LLMClient    { func stream(_ r: ChatRequest) -> AsyncThrowingStream<String, Error>
                        func json<T: Decodable>(_ r: ChatRequest, schema: JSONSchema) async throws -> T }
protocol Companion    { func handle(_ text: String) -> AsyncStream<CompanionEvent> }
                        // CompanionEvent: .token(String) | .focus(PlaceID) | .itineraryChanged | .enterTranslator
```

`Companion` is the seam between the two halves: A sends it text and speaks
its `.token` events; everything behind it is B's.

Shared types: `Place`, `Itinerary`, `Stop`, `Interests`, `Situation` (time,
location, forecast, sun), `Candidate`, `Recommendation(placeID, reason)`.

| Stand-in | Used by | What it does |
|---|---|---|
| `TypedSTT` | B | A text field that emits word-by-word partials |
| `SilentTTS` | B | Does nothing |
| `ScriptedTurns` | B | Replays `Fixtures/translator_es_en.json` |
| `FixtureLLM` | B | Replays recorded answers when no server is running |
| `EchoCompanion` | A | Repeats what it hears, until B's first merge |

Stand-ins are only ever constructed by B's dev app, never by the judged
build.

## Who builds what

| Feature | B builds (on typed text) | A builds (voice) | Done when |
|---|---|---|---|
| 1. Trip setup | Extraction prompt and schema, confirm/edit screen, saving | Microphone → the same entry point, with partial transcripts on screen | A says the example sentence from the spec; the itinerary shows the Tuesday museum slot and survives relaunch |
| 2. Recommendations | Scoring in code; the model picks 3 of the top 8 by ID and writes reasons; an unknown ID is rejected and gets a code-written reason; home list; time, day and location controls | "What should I do now?" speaks the top one | Moving the clock from 13:00 to 17:00 with rain forecast after 16:00 drops the outdoor viewpoint; every place is in the pack; refresh under 3 s on A |
| 3. Voice guide | Search over the pack, a prompt that says "not in my pack", "move the museum to tomorrow" | The voice loop: streamed text, spoken sentence by sentence, microphone muted while speaking | A pack question is answered from a pack row; an off-pack question is declined; first audio within 2.5 s of speech ending |
| 4. Translator | Nothing (phrases in the pack) | All of it: speech → language → speaker → translation → voice, plus the two-sided transcript | Six alternating turns, no buttons, at least five on the correct side. Otherwise ship push-to-talk and say so in the README |
| 5. Map | All of it: bundled tiles, pins, move to a place, click to set "where I am", distance and direction in code | Nothing | Renders with Wi-Fi off; choosing a suggestion moves it |
| 6. Environment panel | All of it: forecast with its age, sunrise and sunset in code | Nothing | Sunrise within two minutes of a published value |
| Launch | Layout | Starts `llama-server`, preloads models, loading screen, "Offline" badge, model names | First reply needs no warm-up |

## Hour one (4:15–5:15)

**Both, first 15 minutes on a call:** read the contracts above and agree
them. B pushes `BuddyCore` right after.

**A**
1. Ask in Discord: is open-source Argmax enough, and is it fine for the app
   to start a bundled `llama-server`?
2. Start the model downloads. Then prove the three audio pieces from the
   command line, before any app code: `argmax-cli transcribe --stream` in
   Spanish and English, `argmax-cli tts --play --language spanish`, and
   `argmax-cli diarize --num-speakers 2` on a 30-second two-person recording.
3. Run PrismML's `Bonsai-demo` setup for 2B, 4B and 9B. Record tokens per
   second and time to first token in `docs/BENCHMARKS.md`.
4. Translate ten traveller sentences each way on 2B and 4B and grade them.
   This is the go/no-go on Spanish.
5. Turn Wi-Fi off and reload the speech and voice models from local folders
   with downloads disabled. Their tokenizers come from separate
   repositories, so fetch those too or this step fails.
6. Create the app shell that links B's package and the audio package; push.

**B**
1. Report your macOS and Xcode versions. The package targets the older of
   the two machines.
2. Push `BuddyCore` and the stand-ins; get the dev app showing a window.
3. Run the Intel build of `llama-server` with 2B and note the speed. If it
   is too slow to work with, use `FixtureLLM`.
4. Map spike, 45 minutes: a web view showing bundled Seville tiles with
   labels, Wi-Fi off. If it is not rendering by then, the map becomes a
   static image with pins.

**5:15 sync (15 minutes):** confirm language, model size and the map route.

## Schedule

| When | A | B | At the checkpoint; if behind, cut |
|---|---|---|---|
| Sat 5:15–8:00 | Voice loop in the app on `EchoCompanion`; 45-minute spike on per-sentence speaker labels | Pack schema and the first 20 places; `LLMClient`; feature 1 on typed text | **8:00 merge:** feature 1 by voice; first Wi-Fi-off cold launch on A. Behind: cap the pack at 40 places |
| 8:30–11:00 | Starts `llama-server` from the app; loading screen; translator with push-to-talk | Feature 2, then feature 3, on typed text | **11:00 merge:** features 2 and 3 by voice. Behind: itinerary edits by voice go; editing on screen stays |
| 11:00–1:30 | Translator with automatic turn-taking; write the shot list | Map, environment panel, pack to 60 places | **1:30 merge:** every feature in, full shot list once with Wi-Fi off. Speaker labels under 5 of 6: ship push-to-talk |
| 2:00–7:00 | Sleep | Sleep | |
| Sun 7:00–9:00 | Speed, badge, model names | Pack fixes, README, `fetch-models.sh` | **9:00 freeze:** tag it. Anything failing its "done when" leaves the app |
| 9:00–9:45 | Restart, Wi-Fi off, cold launch, shot list twice, confirm nothing connects outward | Build from a fresh clone using only the README | Bug fixes only |
| 9:45–10:45 | Record, three takes at most | Plays the local | |
| 10:45–11:15 | | Trim the video to under 2:00 | |
| **11:15** | Post in `#submissions` | | Hard stop 11:30 |

Order of cuts when time runs out: itinerary edits by voice, then automatic
turn-taking (push-to-talk instead), then the environment panel (one line of
text), then the live map (static image). Trip setup, recommendations and the
time control are never cut; they are the demo.

## Repository and git

```
App/                      A     Xcode project, entry point, real services wired in
Packages/BuddyAudio/      A     the only package that depends on Argmax
Packages/BuddyKit/Sources/
  BuddyCore/              both  contracts, shared types, stand-ins
  BuddyTranslate/         A     translator logic and view
  BuddyLLM/               B     LLMClient over HTTP (A adds the server launcher)
  BuddyData/              B     pack store, scoring, sun maths, itinerary saving
  BuddyBrain/             B     trip extraction, recommender, guide, prompts
  BuddyUI/                B     every other screen
  BuddyDev/               B     dev app: the full UI on stand-ins
Pack/                     B     places, facts, phrases, forecast, tiles, build script
Fixtures/  Scripts/  docs/
```

- **No Xcode conflicts.** All code lives in Swift packages, so adding a file
  never touches the project file. Only A opens or commits `App/`. B opens
  `Packages/BuddyKit/Package.swift` in Xcode and runs `BuddyDev`.
- **B's build never sees Argmax.** `BuddyKit` does not depend on
  `BuddyAudio`; only `App/` links both.
- **Branches:** `a/<feature>` and `b/<feature>`. Rebase onto `main` and push
  when the "done when" check passes, and at every checkpoint. `main` always
  launches. No review step; there is no time.
- **Never committed:** speech and voice models, the Bonsai model files, the
  `llama-server` binary. `Scripts/fetch-models.sh` downloads them, and the
  README says to run it once while online.
- **Pack content:** pull place names, coordinates and opening hours from the
  OpenStreetMap extract by script rather than typing them; hand-write the
  interest tags and facts. Start with the 20 places around the demo route.
- The app runs without the App Sandbox, so it can start `llama-server` and
  read the downloaded models.

## Risks and fallbacks

| Risk | Fallback |
|---|---|
| Per-sentence speaker labels are slow or flip sides | Use the detected language to pick the side; then push-to-talk |
| Spanish translation is weak on 4B | 9B for translation; exact phrasebook matches skip the model |
| A cold launch reaches for the network (tokenizers, map fonts) | Local folders with downloads off; fonts bundled; tested at 8:00pm, 1:30am and 9:00am |
| The model returns bad JSON or invents a place | Schema-constrained output, IDs checked in code, code-written reasons |
| Organizers reject a helper process | Swap in llama.cpp's in-process framework behind `LLMClient`; A does it, translator polish pays for it |
| The voice feeds back into the microphone | Ignore microphone audio while speaking |
| A becomes the bottleneck | Every B feature merges working on typed text, so A's part is only swapping in the microphone |
| An M5 Mac on macOS 26.2–26.4 fails to start the model | Set `GGML_METAL_TENSOR_DISABLE=1`. Also keep Low Power Mode off |

## If B's computer is Windows or Linux

B cannot build the app. B keeps the pack, the prompts with recorded
fixtures, and the scoring and extraction logic as plain Swift tested with
`swift test`. A takes every screen, so from the start: the map is a static
image, the translator is push-to-talk, and the environment panel is one line.
