# Handoff: round 2 (Mac feedback, Wi-Fi preparation, camera)

Written Saturday 11/14, 10:40pm ET, at commit `12e3bfa` on branch
`claude/wizardly-keller-bpuomh`. The work moves from a cloud session to a
Claude Code session on Person A's M3 Mac, because the Mac can do what the
cloud container could not: build the Swift helper and the macOS app, run
Bonsai-2 and Argmax, reach Wikipedia, and use the camera.

## Update, Sunday 11/15: what Person B finished from Windows

Everything below that doesn't need a Mac is done, type-checked, linted and covered by tests.
What is left needs the Mac: the Swift camera and on-screen checks. Don't redo tasks 1 to 4.

| Task | State |
|---|---|
| 1. Map and Place | Done. Map: "You: …" chip with "Tap the map to move", Focus / I'm here on a search match, "I'm here" on the card, "At my hotel". Place: every fact, Wikipedia credit line, the asked question and its streamed answer on top with SPEAKING, starter questions when the guide has under two facts, a scroll area that stops above the buttons. |
| 2. Plan text input | Done. Always-visible glass pill with a send button; Enter sends. The macOS focus ring is turned off. A smaller orb when the window is under 800 px tall. |
| 3. Translate | Done apart from the check on the Mac. Visible copy says Translate, a fixed 72 px band for the pill, line counts fitted to each half, 100 px kept for the tab bar (no mic orb there). **Flip fix:** the transform moved to an inner opaque view with an explicit `transformOrigin: '50% 50%'`. RCTView's `displayLayer` recentres `layer.transform` on every redraw, so after a resize a plain rotate was recentred twice and drifted out of the half. With a transformOrigin set, `reactSetFrame` resets the transform first. **Confirm on the Mac that the top half is upside down, including after resizing the window.** If it still isn't, try `scaleX: -1, scaleY: -1` in `FLIPPED` in `TalkScreen.tsx`. |
| 4. Prepared pack | Done and run for real: `fetch-facts.mjs`, `prepare-pack.mjs`, `build-photos.mjs` (1200 px places, 1600 px heroes taken from place photos), `prepared.json`, the Welcome line, README licences. Result: 79 facts (42 from Wikipedia; 18 of those exist only on Spanish Wikipedia, so they read in Spanish), 48 place photos, and all 4 city photos (Plaza de España, the Cathedral, Torre del Oro, Las Setas). Wrong Wikipedia matches are fixed in `app/src/pack/seville/wiki-overrides.json`. Ten places whose every photo hit was wrong (a portrait, a museum in the Caribbean, an opera title page…) are set to `null` in `photos/overrides.json`, so they show their drawn scene tile. City photos now come only from landmark place photos, never a search (a search gave a painting). The forecast was skipped (`--skip forecast`) so the demo's sample rain stays. **Look at the photos on the Mac** and fix any bad pick in `photos/overrides.json`. Tiles are gitignored: run `node scripts/prepare-pack.mjs --skip facts,photos,forecast` on the Mac. |
| 5. Camera and Look | **TypeScript side done; the Swift side is yours.** Done: `protocol.ts` messages, `AudioClient.startCamera` / `snap` (helper client and typed stand-in), `ChatMessage.images` sent as `image_url` parts, `core/vision.ts` (`Looker`) with tests, `prompts.look`, `LookScreen.tsx`, the Look tab, the Talk tab renamed Translate, the tab bar on talk and look, and the projector check in `start.sh`. |
| 6. Integration | Run on Windows: `tsc`, `eslint` (B's two lint errors fixed), `jest`. Everything else needs the Mac. |

**For A, the Swift camera (task 5 step 1), matching `app/src/services/audio/protocol.ts`:**

- Add `camera: true` to the `ready` message once `Camera.swift` exists. The app only sends
  `camera.*` messages to a helper that says so; older builds get "This buddy-audio build has
  no camera yet".
- `camera.start` → a stream of `camera.frame {jpeg}`, `camera.snap {id}` → `camera.snapped {id, jpeg}`,
  `camera.stop`. Failures send `camera.error {message, id?}`, with the snap's id when a snap failed.
  `jpeg` is base64 with no `data:` prefix. If access is refused, say "denied" in the message: the
  Look screen then tells the person where to allow it.
- Then check on the Mac: Look with a real sign and a dish, `start.sh` printing "Vision projector: …",
  and llama-server's log showing `Vision:`.

## How to run this on the Mac

1. Commit or stash local changes, then pull this branch (see the commands in
   the chat, or below).
2. In the repo, start Claude Code and paste:

   > Read docs/HANDOFF.md. Use a workflow: run tasks 1 to 5 in parallel, each
   > agent editing only the files its task lists, then run task 6
   > (integration) and show me the results. Build and run things for real on
   > this Mac where a task says so.

The five tasks touch separate files, so they can share one working tree. Two
files are shared on purpose and each brief says which part is whose:
`app/src/core/types.ts` (task 4 owns `Fact`, task 5 owns `AudioClient` and
`ChatMessage`) and `app/src/ui/DuskRoot.tsx` (task 4 passes one Welcome prop,
task 5 owns routing and the tab bar). Agents re-read those two files right
before each edit.

## Where things stand

Done and pushed: the base app, the Argmax helper (listen, speak,
conversation with diarization, push-to-talk with turn ids), Bonsai-2 through
llama-server, the pack, recommendations, the guide, the trip planner, the map,
190 passing tests, and the Dusk · liquid glass redesign (all six screens).
Commit `12e3bfa` fixed the Mac layout (an onLayout-based `useScreenSize`
instead of `useWindowDimensions`), switched to native glass (`BuddyGlassView`
in `AppDelegate.mm`: `NSGlassEffectView` on macOS 26, a light blur before
that), and made the glass place names visible (SVG text with a gradient
fill).

Turn the Dusk UI on locally with `UI_DESIGN = 'dusk'` in `app/src/config.ts`
(the committed default is still `'classic'`; flip it in task 6 once Dusk is
signed off).

## Rules that stay

- Language: Bonsai-2 only (2B, 4B or 9B; we use 4B). Audio: Argmax only.
- No network at runtime in the app or the helpers. The network is used only
  by the preparation scripts, run once while online. A runtime network call
  is a disqualifying bug.
- The model never fetches or chooses images. Code picks photos.
- Keep the "Offline" chip and the on-device model names visible.
- macOS only, React Native for macOS (no iOS). Old architecture.
- Never use `useWindowDimensions` (it reports the whole display on macOS):
  use `useScreenSize()` from `app/src/ui/dusk/Screen.tsx`. Fonts only via
  `font()` from `app/src/ui/dusk/tokens.ts`; colours from tokens.
- The Argmax Pro key never goes in the repo or the chat. The helper reads
  `ARGMAX_API_KEY` or `~/.travelbuddy/argmax-key`.
- Person B's parts (pack search in `app/src/core/pack.ts`, the guide,
  recommend, trip logic, their lint errors in `src/core/__live__/live.test.ts`
  and `src/core/__tests__/trip.test.ts`) are theirs. Don't change them here.
- Design mockups (390×844): `docs/design/dusk/*.dc.html`.

## What Person A reported from the Mac

- Glass looked old (fixed in `12e3bfa`; check it on the Mac).
- Photos look compressed: low resolution, and the midday city photo was a bad
  pick (a tile mural).
- Map: can't locate myself. "About it" opens a page that is empty at the
  bottom with no facts.
- Plan: wants a text input too.
- Talk: rename to Translate; the status pill covers the phrases; no way back
  to other pages; the top half isn't upside down on the Mac.
- Data: the intended design was to fetch facts and photos with Wi-Fi first,
  then run offline.
- Camera and image recognition for unfamiliar food, road signs and markings,
  menus. Build in parallel.

## Task 1: Map and Place

Files: `app/src/ui/screens/MapScreen.tsx`, `app/src/ui/screens/PlaceScreen.tsx`.

1. Map: a Mac has no GPS and can't locate itself with Wi-Fi off, so the user
   sets their location; make that obvious. Add a small clear-glass chip under
   the search bar, "You: <b.situation.locationLabel>", with the hint "Tap the
   map to move". Tapping the map already calls `b.setLocation`; keep that.
   When the search text matches a place (`b.index.findPlace`), offer "Focus"
   (the existing behaviour) and "I'm here" (`b.setLocation(place.point,
   place.name)`). Give the bottom card a small "I'm here" text button. If the
   trip has a base with a point, add an "At my hotel" chip.
2. Place: never empty. Under the title and distance line, show the place
   summary, then a "From your <city> guide" glass card listing every
   `b.index.facts(place.id)` (title bold 13, body 14), inside a ScrollView
   that fills the space above the bottom buttons. Show a small attribution
   line when a fact has `source`/`license` (task 4 adds these fields; read
   them defensively so it compiles either way). If the person asked about
   this place, show the question and the streamed answer at the top of the
   card, with "SPEAKING" while `b.speaking`. With few or no facts, show three
   question chips ("What's special here?", "When is it quietest?", "Is it
   worth it in the rain?") that call `b.send('<q> (about <name>)')`. Keep Add
   to day, map and mic. No empty band at the bottom.

## Task 2: Plan text input

File: `app/src/ui/screens/SetupScreen.tsx`.

Add an always-visible text row between the trip card and the mic orb: a
clear-glass pill (radius 999, 48 tall) with a TextInput "Or type your
plans…" (pending-colour placeholder, white text, Manrope 500 15) and a small
prominent glass send button (svg arrow, accessibilityLabel "Send"). It calls
`b.send(text)`, clears, and also submits on Enter. Remove the full-width grey
bar where the old input was. Make it fit at 390×844 and shorter windows
(shrink the mic area if needed). After sending, the transcript shows the
typed line.

## Task 3: Talk becomes Translate

File: `app/src/ui/screens/TalkScreen.tsx` (and the Talk assertion in
`app/src/ui/screens/__tests__/screens.smoke.test.tsx` if it must change).

1. Rename the visible copy to Translate. The tab label is task 5's.
2. Reserve a fixed ~72 px band in the middle for the status pill, which sits
   on the divider. Constrain each half's text to its half minus that band
   (numberOfLines plus adjustsFontSizeToFit, so long translations shrink
   instead of overlapping). Leave the bottom ~100 px free for the tab bar
   (task 5 renders it on this screen). Move the Push-to-talk chip and the
   footer above it.
3. The top half's `transform: [{ rotate: '180deg' }]` doesn't show on the
   Mac. Look at `node_modules/react-native-macos/React/Views/RCTView.m`
   (around line 1250, where the macOS display update re-reads
   `layer.transform` and compensates when `anchorPoint` is {0,0}) and
   `UIView+React.m` (`setReactTransform` → `updateTransform`). Likely fixes:
   give the rotated container an opaque background, put the transform on an
   inner view, or use `scaleX: -1, scaleY: -1`. Run the app on the Mac and
   confirm the top half is upside down.
4. Leave the translator logic alone (SideAssigner, turn ids, push-to-talk,
   muting, speaker labels).

## Task 4: prepare the pack with Wi-Fi, then run offline

Files: `scripts/fetch-facts.mjs` (new), `scripts/prepare-pack.mjs` (new),
`scripts/build-photos.mjs`, `README.md` (setup section),
`app/src/pack/seville/prepared.json` (new), `app/src/pack/seville/*` (what the
scripts write), `app/src/ui/screens/WelcomeScreen.tsx`,
`app/src/ui/screens/types.ts`, `app/src/ui/DuskRoot.tsx` (only to pass the
Welcome prop), `app/src/core/types.ts` (only the `Fact` interface).

1. `fetch-facts.mjs`: for each place in `places.json`, find its Wikipedia
   article. Search with the MediaWiki API on en, then es, using the
   name/localName plus the city. From an es article, follow langlinks to en
   when one exists. Fetch `/api/rest_v1/page/summary/<title>`. Skip
   disambiguation pages and titles that share no significant word with the
   place. Add facts `{ id: "wiki-<placeId>", placeId, title, body (≤ ~600
   chars, cut at a sentence end), tags: place tags, source: article URL,
   license: "CC BY-SA 4.0" }`. Keep the hand-written facts and replace old
   `wiki-*` entries. Use a generic User-Agent naming the tool, wait 200 ms
   between requests, and support `--dry-run`. Add `source?` and `license?`
   to `Fact`.
2. `build-photos.mjs`: default widths of 1600 for heroes and 1200 for places
   (keep `--width`). Pick the city heroes from the place photos: midday
   `plaza-espana`, afternoon `catedral`, dusk `torre-oro` or
   `puente-triana`, night `setas` (check the ids). Keep `overrides.json`.
   Keep the old Commons search only as a fallback.
3. `prepare-pack.mjs`: one command that runs fetch-facts, build-photos,
   fetch-forecast and build-tiles in order, reports each step and continues
   past failures, then writes `prepared.json` with `{ preparedAt, facts,
   wikiFacts, photos, heroes, tiles, forecastFrom, forecastTo }`. Commit a
   placeholder with `preparedAt: null` first so imports work.
4. Welcome shows "Seville guide prepared Nov 14 · 72 places · 210 facts · 64
   photos", or "Not prepared yet: run node scripts/prepare-pack.mjs while
   online" when `preparedAt` is null (text2 colour, Manrope 500 12). Pass it
   from DuskRoot through a new optional `WelcomeProps.prepared`.
5. In the README, replace the separate online steps with `node
   scripts/prepare-pack.mjs` and list the licences (Wikipedia text CC
   BY-SA 4.0, Commons per-photo licences with credits, OpenStreetMap ODbL,
   Open-Meteo CC BY 4.0).
6. On the Mac: run it for real while online, check the photos are sharp and
   the heroes are right, and commit the regenerated pack.

## Task 5: camera and image recognition

Files: `audio-helper/Sources/BuddyAudio/Camera.swift` (new), `Protocol.swift`,
`main.swift`, `Audio.swift` (routing only), `audio-helper/README.md`,
`app/src/services/audio/protocol.ts`, `helperClient.ts`, `typedAudio.ts`
(plus any other `AudioClient` fakes found with grep),
`app/src/core/types.ts` (only `AudioClient` and `ChatMessage`),
`app/src/core/vision.ts` (new), `app/src/core/__tests__/vision.test.ts`
(new), `app/src/core/prompts.ts` (one new entry),
`app/src/services/llm/llamaClient.ts` (image content only),
`app/src/ui/screens/LookScreen.tsx` (new), `app/src/ui/dusk/Nav.tsx`,
`app/src/ui/DuskRoot.tsx` (routing and tab bar), `scripts/start.sh`.

The helper owns the camera, as it already owns the microphone and runs
outside the app's sandbox. The app shows the preview and asks Bonsai-2.

Vision check first. PrismML's `download_models.sh` fetches
`*mmproj-Q8_0.gguf` (the vision projector) for the whole `bonsai2` family,
and `start_llama_server.sh` loads any `*mmproj*.gguf` it finds in the model
folder and prints `Vision: <file>`. Check:

    ls "$HOME/Library/Application Support/TravelBuddy/Bonsai-demo/models/bonsai2-gguf/4B/"
    grep Vision "$HOME/Library/Application Support/TravelBuddy/logs/llama-server.log"

- If the projector is there, use Bonsai-2 4B vision: send OpenAI-style
  `image_url` parts with a data URI. The start script caps images at 1024
  vision tokens on Metal, which is fine for photos. For small print, crop or
  send a ~1024 px frame.
- If it isn't, rerun the demo's `download_models.sh` while online. If 4B has
  no projector at all, fall back to Apple's on-device Vision framework in the
  helper: `VNRecognizeTextRequest` (OCR, recognition languages es/en) and
  `VNClassifyImageRequest` (labels). Bonsai-2 then explains and translates
  the recognised text and labels. Apple Vision isn't a language model, so the
  Bonsai rule still holds. You can also combine the two: OCR text plus the
  image works best for signs and menus.

Build:

1. `Camera.swift`: AVFoundation (`AVCaptureSession`, `AVCaptureVideoDataOutput`
   on a serial queue), `AVCaptureDevice.requestAccess(for: .video)`.
   Messages: `camera.start` → `camera.frame` {jpeg} (~480 px wide, quality
   0.5, ≤ 6 fps, base64); `camera.snap` {id} → `camera.snapped` {id, jpeg}
   (~1024 px, quality 0.8); `camera.stop`; `camera.error` {message}. Use
   CoreImage for scaling and JPEG. Route the messages through the existing
   inbox so their order holds. Swift 5.10, macOS 14+. Run `swift build -c
   release` and test with `scripts/test-audio.mjs`-style messages.
2. Mirror the messages in `protocol.ts`. Add `startCamera(onFrame, onError?)
   => stop` and `snap(): Promise<string | undefined>` to `AudioClient`,
   implemented in `helperClient.ts`. In `typedAudio.ts`, `startCamera`
   reports "No camera without the audio helper" and `snap` returns
   undefined.
3. Add `ChatMessage.images?: string[]`. `llamaClient` sends content parts
   `[{type:'text'},{type:'image_url',image_url:{url:'data:image/jpeg;base64,…'}}]`;
   FixtureLLM ignores images.
4. `core/vision.ts`: a `Looker` with `describe(image, question?, onToken)`,
   thinking off, ~220 tokens. For a traveller in <city> it says what the
   thing is (dish, sign, road marking, building, text), translates visible
   text into English, gives one practical tip, and names a pack place if it
   matches one. At most 4 short sentences. Test it with FixtureLLM.
5. `LookScreen.tsx` (Dusk style, like AntPlace/AntNow): a live preview in the
   top ~520 px with a dark fade, the Offline chip, and a glass orb shutter
   (svg camera icon) that freezes the frame and streams the answer into a
   glass card ("WHAT YOU'RE LOOKING AT · <model> ON THIS MAC"). Add an "Ask
   about it" mic (listen, describe with the question, speak with `b.say`), a
   Retake button, and a clear message when there's no camera or permission
   is refused. Leave the bottom ~100 px for the tab bar.
6. In `Nav.tsx`, add the `look` screen and a "Look" tab, and rename the
   "Talk" tab label to "Translate" (the screen name stays `talk`). In
   `DuskRoot.tsx`, render LookScreen, and show the TabBar on now, map, talk
   and look. It must fit at 390 px with the mic orb.
7. `start.sh`: make sure the projector is used when present, and warn
   clearly when it isn't. In the README, macOS asks for camera access for
   the terminal running buddy-audio; the app itself needs no camera
   entitlement.

## Task 6: integration (after 1 to 5)

- In `app/`: `npx tsc --noEmit`, `npx eslint src/ui src/services src/core`
  (B's two known lint files excepted), `npx jest`; fix everything.
- `Protocol.swift` and `protocol.ts` match field for field. Every
  `AudioClient` implements the new methods.
- `cd audio-helper && swift build -c release`, then `cd app/macos && pod
  install` if needed, then `scripts/start.sh`.
- Check on the Mac with `UI_DESIGN = 'dusk'`: every screen at 430×900 and at
  the 390×700 minimum; glass; sharp photos; Map "I'm here"; Place facts; Plan
  typing; Translate flip, pill and tab bar; Look with a real photo of a sign
  and a dish; Welcome's "prepared" line.
- Run the whole thing once with Wi-Fi off from a cold launch.
- Commit in small pieces and push to `claude/wizardly-keller-bpuomh`. Update
  `docs/SHOTLIST.md` if Look makes the video.
