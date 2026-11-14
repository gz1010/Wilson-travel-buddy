# Travel Buddy

An offline travel companion for the Mac that knows your trip, suggests what to do right now, answers questions about the city out loud, and translates conversations with locals, all on-device with Wi-Fi off, using Bonsai-2 and Argmax.

- What we are building: [SPEC.md](SPEC.md)
- Who builds what, and when: [PLAN.md](PLAN.md)

## How it fits together

| Process | What | Where |
|---|---|---|
| The app | React Native for macOS (react-native-macos 0.81), TypeScript: screens, trip logic, recommendations, guide, translator, offline map | `app/` |
| `llama-server` | Bonsai-2 (4B by default) through PrismML's llama.cpp fork, on `127.0.0.1:8080` | downloaded by `scripts/fetch-models.sh` |
| `buddy-audio` | Swift helper running Argmax: speech-to-text, voice, speaker recognition, on `ws://127.0.0.1:8765` | `audio-helper/` (Apple Silicon only) |

If either helper is not running, the app still opens: typed input replaces the microphone, and recorded answers replace the model.

## Set up (once, online)

Needs macOS 15, Xcode 16, Node 20+, CocoaPods.

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

It starts `llama-server` and `buddy-audio`, waits for the model, then builds and opens the app. Logs go to `~/Library/Application Support/TravelBuddy/logs/`. The first time, macOS asks for microphone access for the terminal running `buddy-audio`.

To work on the app without the helpers: `cd app && npm run macos`.

## Develop

```bash
cd app && npm test && npm run typecheck
```

All logic in `app/src/core` is plain TypeScript with no React Native imports, tested in Node.

## Credits

Map data © OpenStreetMap contributors, tiles via Protomaps. Forecast from Open-Meteo. Bonsai-2 by PrismML. Speech by Argmax.
