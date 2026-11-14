# Travel Buddy — build spec

Who builds what, and by when, is in [PLAN.md](PLAN.md). Where the two files
differ, PLAN.md wins.

Build a macOS app called Travel Buddy for a hackathon, in React Native
(react-native-macos) and TypeScript. Submissions close at
noon on Sunday 11/15, so scope is fixed by the clock: a small app that works
flawlessly beats a large one that stutters.

## What it is

An offline travel companion that knows your trip. You tell it your itinerary
and what you like; from then on it suggests where to go and what to do next
based on your plans, where you are, the time of day, and the weather. It
also answers questions about the place aloud, shows you the map, and
translates conversations with locals. All of it runs on a Mac with Wi-Fi
turned off.

The hackathon theme is "Recreate": remaking cloud AI apps fully on-device.
Our pitch is that this replaces the cloud apps a traveler depends on (a trip
planner, a voice assistant, a maps app, and a translator) in the one place
they all fail: somewhere with no signal. It should feel like one companion,
not four tools: a single conversation and a single home screen, with
translation as a mode you switch into.

## Hard rules from the organizers

- Language modeling must use Bonsai-2 (2B, 4B, or 9B variants).
- Audio must use the Argmax SDK on-device: speech-to-text, text-to-speech,
  and speaker diarization.
- The app is judged running locally on a Mac with Wi-Fi off. Any network
  call at runtime is a disqualifying bug. All models, map data, and content
  ship with the app or are already on disk before launch.

## How it is judged (design for these)

1. Use of Bonsai and Argmax: effective and creative, not just present.
2. Creativity and fit with the "Recreate" theme.
3. Wow factor: polish and the impression of the live experience.
4. Technical impressiveness: smooth local performance and offline reliability.

## Features, in priority order

1. **Trip setup by voice.** The user describes their trip in their own words
   ("I'm here three days, staying near the old town, I love street food and
   architecture, Tuesday afternoon I have a museum ticket"). Bonsai-2 turns
   that into a structured itinerary and a list of interests, shown on screen
   for the user to confirm or correct by voice or by editing. Save it so it
   survives relaunch.

2. **Recommendations (the centerpiece).** The home screen shows a short list
   of suggestions for right now, each with a one-line reason tied to the
   user's situation: "Ten minutes' walk from your 2pm museum slot, and you
   said you like street food" or "Rain is likely after 4, so this covered
   market fits better than the viewpoint". Inputs are the itinerary, the
   interests, the user's current location, the time of day, the saved
   forecast, and sunrise/sunset. Suggestions refresh when any of those
   change, and the companion can speak the top one aloud when asked "what
   should I do now?". Selecting a suggestion shows it on the map and lets
   the user add it to the itinerary.

   Split the work: code does the filtering and scoring (distance, opening
   hours, weather suitability, interest match, not already visited), then
   Bonsai-2 picks among the top candidates and writes the reasons. Do not
   ask the model to compute distances or times; small models get that wrong.
   Every recommended place must come from the destination pack, never from
   the model's memory.

3. **Voice guide.** In the same conversation, the user asks questions aloud
   about the destination ("what should I know before visiting this
   temple?"). Bonsai-2 answers from the destination pack and says so when
   the pack has no answer. The reply streams as text and is spoken. The
   guide knows the itinerary, so "what's near my hotel?" and "move the
   museum to tomorrow" both work.

4. **Conversation translator.** A mode for talking to a local across the
   Mac. Argmax transcribes and uses diarization to tell the two speakers
   apart automatically, so nobody presses a button to take turns. Bonsai-2
   translates each utterance and Argmax speaks it. The screen shows a
   two-sided transcript with original and translation. We have an Argmax
   Pro SDK key, whose streaming diarization labels speakers live, while
   they talk. If the Pro licence does not work with Wi-Fi off, use the
   open-source SDK, which labels each sentence after it ends by comparing
   voice prints. If that proves unreliable too, fall back to a push-to-talk
   button per speaker and say so.

5. **Offline map.** A bundled map of the destination with itinerary stops
   and recommended places marked. When the companion mentions a place, the
   map moves to it. A Mac has no usable location with Wi-Fi off, so the user
   sets "where I am" by clicking the map or naming a place. No turn-by-turn
   routing; show distance and direction to the selected place.

6. **Environmental panel.** Temperature and chance of precipitation from a
   forecast saved in the pack, shown with its age. Sunrise and sunset
   computed on-device from date and coordinates.

Include a small control to set the current time and day, alongside the
click-to-set location. It makes the recommendations testable and lets the
demo show them changing as the day and the user's position move.

Cut unless everything above is finished and polished: downloading packs for
arbitrary destinations, walking directions, camera-based visual inspection.

## Destination pack

Ship one destination, bundled with the app (Seville, Spanish and English,
unless the hour-one language check fails): map tiles, cultural and
historical facts, common phrases, a saved forecast, and a places list. Each
place needs coordinates, a category, opening hours, a typical visit length,
whether it is indoor or outdoor, and tags that match likely interests (food,
architecture, nature, nightlife, and so on); recommendations are only as
good as this data. Aim for 60 to 100 places with good coverage across
categories. Pick a destination whose language Bonsai-2 translates well and
Argmax can both transcribe and speak; verify that before building content.
Ship it as JSON inside the app and search it in memory with MiniSearch;
at this size (100 places, a few hundred facts) no database is needed.

## Stack

The app is three local processes that talk over 127.0.0.1, which works with
Wi-Fi off:

- **The app:** React Native for macOS (react-native-macos 0.81) in
  TypeScript. All screens and all logic live here: trip extraction,
  scoring, recommendations, the guide, translation prompts.
- **Bonsai-2:** PrismML's `llama-server` with the GGUF model, called over
  its OpenAI-compatible HTTP API with streaming. Benchmark the 2B, 4B, and
  9B variants on the Apple Silicon Mac early and report the numbers.
  Translation needs the fastest variant that is accurate; itinerary
  extraction and recommendation reasons need reliable structured output,
  which may favor a larger one.
- **Argmax audio helper:** a small Swift program that runs Argmax and
  exposes speech-to-text, text-to-speech, and diarization to the app over a
  local WebSocket. Argmax has no React Native SDK (only Swift and Kotlin),
  so this helper is how the app uses it. Speech-to-text and diarization use
  the Argmax Pro SDK if its licence works offline, otherwise the
  open-source WhisperKit and SpeakerKit; the voice is TTSKit.
- **Map:** MapLibre GL JS inside `react-native-webview`, with OpenStreetMap
  vector tiles bundled into the app.

The Argmax Pro key never goes in the repository. The helper reads it from
the `ARGMAX_API_KEY` environment variable or from `~/.travelbuddy/argmax-key`.

Read the current Bonsai-2 and Argmax documentation before writing
integration code; do not guess their APIs. If either cannot do something
this spec assumes (a language pair, real-time diarization, structured
output, streaming), stop and raise it so the plan can change early rather
than at 11am.

## Experience

- The home screen is the companion: today's itinerary, the current
  suggestions, the map, and a microphone. Translation is one tap or one
  spoken request away.
- Show a visible "Offline" indicator, and the on-device model names, in the
  interface. Judges should see at a glance that nothing leaves the machine.
- Show partial transcripts as people speak and stream model output. Never
  leave the screen still while something is processing.
- Load models at launch behind a short loading screen so the first
  interaction is instant.
- Every spoken interaction is also fully readable on screen.

## Order of work

1. Bonsai-2 and Argmax each running in a bare Mac app; benchmarks reported.
2. Voice loop end to end: speak, transcribe in the audio helper, the app's
   model answers, spoken reply.
3. Destination pack built, and the voice guide answering from it.
4. Trip setup by voice, producing a confirmed itinerary.
5. Recommendations: scoring in code, reasons from the model, home screen.
6. Map, linked to recommendations, itinerary stops, and guide answers.
7. Translator mode, then diarization for automatic turn-taking.
8. Environmental panel.
9. Polish, then a full run-through with Wi-Fi off from a cold launch.

Show each step working before starting the next. Keep the repository ready
to submit at all times: a README with a one-sentence description, setup
steps, and how to run it offline.

## Demo

The submission includes a video under two minutes. Once step 5 works, write
a shot list for it: turn Wi-Fi off on camera, describe a trip by voice and
watch the itinerary appear, ask "what should I do now?" and get a reasoned
suggestion that moves the map, change the time or weather situation and see
the suggestions change, then a short translated exchange with a local.
Build toward that script; a feature that is not in the video is lower
priority than polish on one that is.

## Submission checklist

Post in the Discord `#submissions` channel before noon on Sunday 11/15:

- Names of team members
- A one-sentence project description
- Link to this repository
- A working video demo under two minutes
