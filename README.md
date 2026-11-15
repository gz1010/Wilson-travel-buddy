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
node scripts/prepare-pack.mjs
```

- `fetch-models.sh` gets Bonsai-2 and `llama-server` through PrismML's Bonsai-demo setup, and on Apple Silicon builds `buddy-audio` and downloads the Argmax models.
- `prepare-pack.mjs` fetches everything the city pack needs while you are online, then the app runs with Wi-Fi off. It runs four steps in order, reports each, and carries on past one that fails:
  1. `fetch-facts.mjs`: each place's Wikipedia article (English, else Spanish), checked against the place's name, location and kind, saved as a short fact with its source.
  2. `build-photos.mjs`: one photo per place (the matched article's main image, else a Commons search) at 1200 px, and the four time-of-day city photos at 1600 px, picked from the place photos. Fix a bad pick in `app/src/pack/seville/photos/overrides.json`.
  3. `fetch-forecast.mjs`: a 7-day hourly forecast. The app shows its age offline.
  4. `build-tiles.mjs`: OpenStreetMap vector tiles for Seville (gitignored, so run it on every clone). Without them the map shows pins only.

  It then writes `app/src/pack/seville/prepared.json`, which the Welcome screen shows ("Seville guide prepared Nov 14 · 60 places · …"). Each step also runs on its own, e.g. `node scripts/fetch-facts.mjs --dry-run`. Wikimedia lets clients without contact details make 10 requests a minute, so the facts and photos steps pace themselves to that (about 20 minutes); `WIKIMEDIA_CONTACT=you@example.org node scripts/prepare-pack.mjs` is allowed 200 a minute (the address goes only into the User-Agent sent to Wikimedia).

Licences of what the pack contains:

| Data | Source | Licence |
|---|---|---|
| Place facts marked with a source | Wikipedia | CC BY-SA 4.0 (each fact keeps its article URL) |
| Photos | Wikimedia Commons | Per photo (CC0, public domain, CC BY or CC BY-SA), with author and file page in `places.json` and `destination.json` |
| Map tiles | OpenStreetMap contributors, via Protomaps | ODbL |
| Forecast | Open-Meteo.com | CC BY 4.0 |

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

Map data © OpenStreetMap contributors (ODbL), tiles via Protomaps. Forecast from Open-Meteo.com (CC BY 4.0). Place texts from Wikipedia (CC BY-SA 4.0). Photos from Wikimedia Commons, each under its own licence with its author credited in the pack. Bonsai-2 by PrismML. Speech by Argmax.
