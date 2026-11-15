#!/usr/bin/env bash
# Starts the two local helpers, then the app. This is what runs on camera.
#   scripts/start.sh                # helpers, then Metro and the Mac app in debug (Metro must be running for a debug build)
#   scripts/start.sh --app PATH     # helpers, then a built TravelBuddy.app
# Ctrl-C stops the helpers.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUPPORT="$HOME/Library/Application Support/TravelBuddy"
DEMO="$SUPPORT/Bonsai-demo"
LOGS="$SUPPORT/logs"
mkdir -p "$LOGS"
export BONSAI_MODEL="${BONSAI_MODEL:-4B}"
# M5 Macs on macOS 26.2-26.4 need this for llama.cpp's Metal backend; harmless elsewhere.
export GGML_METAL_TENSOR_DISABLE="${GGML_METAL_TENSOR_DISABLE:-1}"

# The app's setup must be done before anything else starts.
if [ "${1:-}" != "--app" ]; then
  if [ ! -x "$ROOT/app/node_modules/.bin/react-native" ]; then
    echo "The app's dependencies are not installed. Run once:"
    echo "  cd \"$ROOT/app\" && npm install && cd macos && pod install"
    exit 1
  fi
  if [ ! -d "$ROOT/app/macos/Pods" ]; then
    echo "CocoaPods have not been installed for the app. Run once:"
    echo "  cd \"$ROOT/app/macos\" && pod install"
    exit 1
  fi
fi

pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

if curl -s --max-time 1 http://127.0.0.1:8080/health >/dev/null; then
  echo "llama-server already running on :8080"
else
  echo "Starting Bonsai-2 $BONSAI_MODEL (log: $LOGS/llama-server.log)"
  # exec, so the PID we keep is llama-server itself and Ctrl-C really stops it.
  ( cd "$DEMO" && BONSAI_FAMILY=bonsai2 BONSAI_THINKING=0 PORT=8080 exec ./scripts/start_llama_server.sh ) >"$LOGS/llama-server.log" 2>&1 &
  LLAMA_PID=$!
  pids+=($LLAMA_PID)
fi

HELPER="$ROOT/audio-helper/.build/release/BuddyAudio"
if [ "$(uname -m)" = "arm64" ] && [ -x "$HELPER" ]; then
  echo "Starting the Argmax audio helper (log: $LOGS/buddy-audio.log)"
  "$HELPER" ${BUDDY_AUDIO_ARGS:-} >"$LOGS/buddy-audio.log" 2>&1 &
  pids+=($!)
else
  echo "No audio helper on this Mac: the app will use typed input."
fi

echo -n "Waiting for Bonsai-2"
llm_ok=0
for _ in $(seq 1 180); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 http://127.0.0.1:8080/health)" = "200" ]; then llm_ok=1; break; fi
  if [ -n "${LLAMA_PID:-}" ] && ! kill -0 "$LLAMA_PID" 2>/dev/null; then
    echo; echo "llama-server exited:"; tail -n 20 "$LOGS/llama-server.log"; break
  fi
  echo -n "."; sleep 1
done
echo
if [ "$llm_ok" = 1 ]; then
  # One short request so the first real reply is not slowed by a cold start.
  curl -s --max-time 60 http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
    -d '{"messages":[{"role":"user","content":"Hi"}],"max_tokens":4,"chat_template_kwargs":{"enable_thinking":false}}' >/dev/null || true
  echo "Bonsai-2 is warm."
else
  echo "Bonsai-2 is not available; the app will use recorded answers."
fi

if [ "${1:-}" = "--app" ] && [ -n "${2:-}" ]; then
  open "$2"
  echo "App opened. Press Ctrl-C here to stop the helpers when done."
  wait
else
  # run-macos only builds and opens the app; a debug build needs Metro for its JavaScript.
  if curl -s --max-time 1 http://127.0.0.1:8081/status | grep -q packager-status:running; then
    echo "Metro already running on :8081"
  else
    echo "Starting Metro (log: $LOGS/metro.log)"
    ( cd "$ROOT/app" && exec ./node_modules/.bin/react-native start --port 8081 ) >"$LOGS/metro.log" 2>&1 &
    pids+=($!)
    for _ in $(seq 1 60); do
      curl -s --max-time 1 http://127.0.0.1:8081/status | grep -q packager-status:running && break
      sleep 1
    done
  fi
  cd "$ROOT/app" && npm run macos
  echo "App opened. Press Ctrl-C here to stop Metro and the helpers when done."
  wait
fi
