# Travel Buddy app (React Native for macOS)

See the repository README for setup. Layout:

| Path | What | Owner |
|---|---|---|
| `src/core/` | Types, scoring, sun maths, pack search, prompts, companion. No React imports; `npm test` runs it in Node | B |
| `src/services/llm/` | `llama-server` client (streaming over XMLHttpRequest), recorded-answer stand-in | B |
| `src/services/audio/` | Audio helper protocol and WebSocket client; typed stand-in | A |
| `src/ui/` | Screens and the `useBuddy` state hook | B |
| `src/ui/translator/` | Translator screen | A |
| `src/map/` | Offline MapLibre map in a web view | B |
| `src/pack/seville/` | Places, facts, phrases, forecast | B |
| `src/fixtures/` | Recorded model answers, scripted conversation | both |

`useBuddy` is the one shared conversation loop: typed text and the
microphone both go through `send()`, and every screen reads from it.

The macOS Xcode project is in `macos/`. Open `macos/TravelBuddy.xcworkspace`
after `pod install`, scheme `TravelBuddy-macOS`.
