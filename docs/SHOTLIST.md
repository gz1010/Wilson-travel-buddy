# Demo video: shot list (target 1:50, limit 2:00)

Record on A's Mac with Wi-Fi **off**, after `scripts/preflight.sh` passes.
Screen recording plus room audio (QuickTime: File > New Screen Recording, Options > microphone).
B plays the local in beat 6. Do a dry run first; three takes at most.

## Before you press record

- `scripts/start.sh`; wait until the app shows the home screen.
- In the app: **Start over** on the trip card (empty itinerary), clock **13:00** on day 1, location **Santa Cruz** (type "Santa Cruz" in *Where I am*).
- Close every other app; turn on Do Not Disturb; Low Power Mode **off**.
- Volume up so the voice is audible on the recording.

## Beats

| # | Time | Do | Say | Should see |
|---|---|---|---|---|
| 1 | 0:00–0:10 | Show the Wi-Fi menu turned off, then the app | *(narrate)* "No internet. Everything runs on this Mac." | "Offline · on-device" badge, model names in the header |
| 2 | 0:10–0:35 | Click the mic | "I'm here three days, staying near the old town. I love street food and architecture, and Tuesday afternoon I have a ticket for the Museum of Fine Arts." | Partial transcript while speaking; trip card fills in; Tuesday shows the museum at 15:00 with a ticket; spoken confirmation |
| 3 | 0:35–0:55 | Click the mic | "What should I do now?" | Three suggestions with reasons; the voice reads the top one; the map flies to it |
| 4 | 0:55–1:10 | Click **17:00** in the time controls | *(narrate)* "Later, rain is coming." | Weather shows rain from 16:00; suggestions switch to indoor places and the reason mentions rain |
| 5 | 1:10–1:20 | Click the mic | "Why does the Giralda have ramps instead of stairs?" | Spoken answer from the guide; the map moves to the Cathedral |
| 6 | 1:20–1:50 | Click **Translator**, **Start listening** | A: "Hi, how do I get to the cathedral?" — B: "Está a cinco minutos, todo recto." — A: "Is it open now?" — B: "Sí, hasta las cinco." | Each sentence on its side with "Argmax · speaker N", the translation spoken in the other language |

## If something goes wrong on the take

- **Beat 2 extracts the trip wrong:** fix it by voice ("move the museum to Tuesday afternoon") only if it is quick; otherwise retake.
- **Beat 3 is slow:** cut the wait in the edit, not the reasons.
- **Beat 6 puts a sentence on the wrong side:** switch to **Push-to-talk** and hold the buttons. Say so in the README.
- **Anything crashes:** submit the 1:30am backup recording.

## After recording

A hands the file to B. B trims to under 2:00, uploads, and posts in `#submissions` with team names, the one-sentence description (first line of README.md), the repository link and the video.
