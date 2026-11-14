#!/usr/bin/env bash
# Starts the two local helpers, then the app. This is what runs on camera.
#   scripts/start.sh                # helpers, then Metro and the app in debug
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

pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

if curl -s --max-time 1 http://127.0.0.1:8080/health >/dev/null; then
  echo "llama-server already running on :8080"
else
  echo "Starting Bonsai-2 $BONSAI_MODEL (log: $LOGS/llama-server.log)"
  ( cd "$DEMO" && BONSAI_FAMILY=bonsai2 BONSAI_THINKING=0 PORT=8080 ./scripts/start_llama_server.sh ) >"$LOGS/llama-server.log" 2>&1 &
  pids+=($!)
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
for _ in $(seq 1 180); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 http://127.0.0.1:8080/health)" = "200" ] && break
  echo -n "."; sleep 1
done
echo
# One short request so the first real reply is not slowed by a cold start.
curl -s --max-time 60 http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Hi"}],"max_tokens":4,"chat_template_kwargs":{"enable_thinking":false}}' >/dev/null || true
echo "Bonsai-2 is warm."

if [ "${1:-}" = "--app" ] && [ -n "${2:-}" ]; then
  open "$2"
  echo "App opened. Press Ctrl-C here to stop the helpers when done."
  wait
else
  cd "$ROOT/app" && npm run macos
  wait
fi
