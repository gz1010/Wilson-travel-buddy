# Travel Buddy

An offline travel companion for the Mac that plans around your trip, tells
you what to do next, answers questions about the city aloud, and translates
conversations with locals, with Wi-Fi off.

<!-- TODO before submitting: team member names, demo video link. -->

Built for the "Recreate" hackathon: it remakes a trip planner, a voice
assistant, a maps app and a translator fully on-device, for the one place
the cloud versions fail: somewhere with no signal. The destination is
Seville (Spanish ↔ English).

- **Language model:** Bonsai-2 (4B), served on 127.0.0.1 by PrismML's `llama-server`.
- **Speech:** the Argmax SDK for speech-to-text, the voice, and telling speakers apart, in a small Swift helper (`buddy-audio`) on 127.0.0.1.
- **App:** React Native for macOS (TypeScript). The map is MapLibre GL JS with bundled OpenStreetMap tiles.

Nothing connects outside the Mac at runtime. Models, map tiles, places and
the weather forecast are all on disk before launch.

## What it does

1. **Trip setup by voice.** "I'm here three days, staying near the old town,
   I love street food and architecture, Tuesday afternoon I have a museum
   ticket." Bonsai-2 turns that into an itinerary you can confirm or correct.
2. **What to do now.** Code ranks the destination's places by distance,
   opening hours, weather, time of day, your interests and your next
   booking; Bonsai-2 picks three and explains why. Change the clock or your
   location and the suggestions change.
3. **Voice guide.** Ask about the city; answers come only from the bundled
   guide, and it says so when the guide has no answer.
4. **Translator.** Talk with a local across the Mac. Each sentence is
   labelled with its speaker, translated and spoken.
5. **Offline map** with your stops and suggestions, and an **environment
   panel** with the saved forecast (and its age) and sunrise and sunset
   computed on-device.

## Setup (once, while online)

Needs an Apple Silicon Mac with macOS 14 or later, Xcode 16, Node 20 or
later, and CocoaPods.

```bash
cd app
npm install
cd macos && pod install && cd ..
node ../scripts/build-tiles.mjs          # Seville map tiles into the app
```

<!-- TODO(A): fetch-models.sh (Bonsai-2 GGUF, llama-server, Argmax models)
     and the Argmax key/provisioning steps from audio-helper/README.md. -->

## Run it offline

1. Turn Wi-Fi off.
2. <!-- TODO(A): scripts/start.sh starts llama-server and buddy-audio, then the app. -->

If the model server or the audio helper is not running, the app still
opens: typing replaces the microphone, replies are shown instead of spoken,
and recorded answers replace the model.

## Development

`app/src/core` holds all the logic (trip extraction, scoring,
recommendations, guide, translation, sun and time maths) with no React
imports, so it runs and is tested in Node on any machine:

```bash
cd app
npm test && npx tsc --noEmit
```

Pack data lives in `app/src/pack/seville/`. To add places, look them up in
OpenStreetMap with `node scripts/fetch-places.mjs --compact "Place name"`;
`docs/PACK-CHECKLIST.md` lists what still needs checking.
`node scripts/fetch-forecast.mjs` saves a real Open-Meteo forecast.

How the work was split and why is in [PLAN.md](PLAN.md); the full brief is
in [SPEC.md](SPEC.md).

## Credits

Map data © OpenStreetMap contributors (ODbL), tiles via Protomaps. Weather
by Open-Meteo.com (CC BY 4.0).
