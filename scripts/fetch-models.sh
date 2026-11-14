#!/usr/bin/env bash
# Downloads everything Travel Buddy needs, once, while online:
#   1. Bonsai-2 (GGUF) and PrismML's llama-server, via PrismML's own Bonsai-demo setup
#   2. Argmax speech, voice and speaker models (Apple Silicon only), via buddy-audio --prepare
# Afterwards the whole app runs with Wi-Fi off.
#
#   BONSAI_MODEL=4B scripts/fetch-models.sh      # 2B, 4B or 9B; run again for each size you want
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUPPORT="$HOME/Library/Application Support/TravelBuddy"
DEMO="$SUPPORT/Bonsai-demo"
export BONSAI_MODEL="${BONSAI_MODEL:-4B}"

mkdir -p "$SUPPORT"
if [ ! -d "$DEMO/.git" ]; then
  git clone --depth 1 https://github.com/PrismML-Eng/Bonsai-demo.git "$DEMO"
fi
echo "==> Bonsai-2 $BONSAI_MODEL and llama-server (PrismML Bonsai-demo setup; skipping MLX and Open WebUI)"
( cd "$DEMO" && BONSAI_FAMILY=bonsai2 BONSAI_SKIP_MLX=1 BONSAI_OPENWEBUI=0 BONSAI_CODE_INTERPRETER=0 ./setup.sh )

if [ "$(uname -m)" = "arm64" ]; then
  echo "==> Argmax models (speech-to-text, voice, speakers)"
  ( cd "$ROOT/audio-helper" && swift build -c release && .build/release/BuddyAudio --prepare )
else
  echo "==> Skipping Argmax: it needs Apple Silicon. The app will use typed input on this Mac."
fi
echo "Done. Start everything with scripts/start.sh"
