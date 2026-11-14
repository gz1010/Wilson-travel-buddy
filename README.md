# Travel Buddy

An offline travel companion for the Mac that knows your trip, suggests what to do right now, answers questions about the city out loud, and translates conversations with locals, all on-device with Wi-Fi off, using Bonsai-2 and Argmax.

- What we are building: [SPEC.md](SPEC.md)
- Who builds what, and when: [PLAN.md](PLAN.md)

<!-- TODO before submitting: team member names and the demo video link. -->

## What it does

1. **Trip setup by voice.** "I'm here three days, staying near the old town, I love street food and architecture, Tuesday afternoon I have a museum ticket." Bonsai-2 turns that into an itinerary to confirm or correct.
2. **What to do now.** Code ranks the city's places by distance, opening hours, weather, time of day, interests and the next booking; Bonsai-2 picks three and says why. Move the clock or your location and the suggestions change.
3. **Voice guide.** Answers come only from the bundled guide, and it says so when the guide has no answer.
4. **Translator.** Talk with a local across the Mac; each sentence is labelled with its speaker, translated and spoken.
5. **Offline map** with stops and suggestions, and an **environment panel**: the saved forecast with its age, and sunrise and sunset computed on-device.

## How it fits together

| Process | What | Where |
|---|---|---|
| The app | React Native for macOS (react-native-macos 0.81), TypeScript: screens, trip logic, recommendations, guide, translator, offline map | `app/` |
| `llama-server` | Bonsai-2 (4B by default) through PrismML's llama.cpp fork, on `127.0.0.1:8080` | downloaded by `scripts/fetch-models.sh` |
| `buddy-audio` | Swift helper running Argmax: speech-to-text, voice, speaker recognition, on `ws://127.0.0.1:8765` | `audio-helper/` (Apple Silicon only) |

If either helper is not running, the app still opens: typed input replaces the microphone, and recorded answers replace the model.

## Set up (once, online)

Needs macOS 15, Xcode 16.1 or newer (full Xcode, not just the Command Line Tools: `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`), Node 20.19.4 or newer, CocoaPods.

```bash
cd app && npm install && cd macos && pod install && cd ../..
```

```bash
BONSAI_MODEL=4B scripts/fetch-models.sh
```

```bash
node scripts/build-tiles.mjs
```

```bash
node scripts/fetch-forecast.mjs
```

- `fetch-models.sh` gets Bonsai-2 and `llama-server` through PrismML's Bonsai-demo setup, and on Apple Silicon builds `buddy-audio` and downloads the Argmax models.
- `build-tiles.mjs` bakes OpenStreetMap tiles for Seville into the app (gitignored). Without it the map shows pins only.
- `fetch-forecast.mjs` saves a real forecast. The committed one is sample data.

## Run (Wi-Fi off is fine)

```bash
scripts/start.sh
```

It starts `llama-server`, `buddy-audio` and Metro (React Native's JavaScript server), waits for the model, then builds and opens the app. Logs go to `~/Library/Application Support/TravelBuddy/logs/`. The first time, macOS asks for microphone access for the terminal running `buddy-audio`.

To work on the app without the helpers: `cd app && npm start` in one terminal and `cd app && npm run macos` in another.

## Develop

```bash
cd app && npm test && npm run typecheck
```

All logic in `app/src/core` is plain TypeScript with no React Native imports, tested in Node.

Pack data is in `app/src/pack/seville/`. To add a place, look it up in OpenStreetMap with `node scripts/fetch-places.mjs --compact "Place name"`. [docs/PACK-CHECKLIST.md](docs/PACK-CHECKLIST.md) lists what still needs checking.

## Credits

Map data © OpenStreetMap contributors, tiles via Protomaps. Forecast from Open-Meteo. Bonsai-2 by PrismML. Speech by Argmax.
