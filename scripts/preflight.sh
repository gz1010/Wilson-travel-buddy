#!/usr/bin/env bash
# Checks everything before recording or judging. Run with scripts/start.sh already running.
#   scripts/preflight.sh
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUPPORT="$HOME/Library/Application Support/TravelBuddy"
fails=0
ok()   { echo "  OK    $1"; }
bad()  { echo "  FIX   $1"; fails=$((fails + 1)); }
warn() { echo "  NOTE  $1"; }

echo "Offline"
if networksetup -getairportpower en0 2>/dev/null | grep -q "Off"; then ok "Wi-Fi is off"; else bad "Wi-Fi is on: turn it off for the demo"; fi
if curl -s --max-time 3 -o /dev/null https://example.com; then bad "The internet is reachable (Ethernet or hotspot?)"; else ok "No internet access"; fi

echo "Bonsai-2"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:8080/health)
if [ "$code" = "200" ]; then
  ok "llama-server ready on :8080 ($(curl -s --max-time 2 http://127.0.0.1:8080/v1/models | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'))"
else bad "llama-server not ready (HTTP $code): run scripts/start.sh"; fi

echo "Argmax audio helper"
if nc -z 127.0.0.1 8765 2>/dev/null; then ok "buddy-audio listening on :8765"; else bad "buddy-audio not running: build it (audio-helper/README.md) and run scripts/start.sh"; fi
if [ -f "$SUPPORT/argmax/manifest.json" ]; then
  ok "Argmax models prepared for offline use"
  grep -q speakerFolder "$SUPPORT/argmax/manifest.json" || bad "manifest has no speakerFolder: rerun BuddyAudio --prepare while online"
else bad "No Argmax manifest: run audio-helper/.build/release/BuddyAudio --prepare while online"; fi
if grep -q "Ready" "$SUPPORT/logs/buddy-audio.log" 2>/dev/null; then ok "buddy-audio loaded its models"; else warn "buddy-audio log has no 'Ready' yet (still loading?)"; fi

echo "App"
if curl -s --max-time 1 http://127.0.0.1:8081/status | grep -q running; then ok "Metro running"; else warn "Metro not running (fine for a Release build)"; fi
if [ -f "$ROOT/app/src/map/generated/tiles.js" ]; then ok "Map tiles bundled"; else warn "No map tiles: the map shows pins only (node scripts/build-tiles.mjs while online)"; fi
if grep -q "Sample data" "$ROOT/app/src/pack/seville/forecast.json"; then warn "Forecast is sample data (fine for the demo; node scripts/fetch-forecast.mjs for a real one)"; else ok "Real forecast saved"; fi

echo "Mac"
if pmset -g 2>/dev/null | grep -q "lowpowermode *1"; then bad "Low Power Mode is on: it throttles the model"; else ok "Low Power Mode off"; fi
outbound=$(lsof -nP -iTCP -sTCP:ESTABLISHED 2>/dev/null | grep -E "llama|BuddyAudi|TravelBud" | grep -v -E "127\.0\.0\.1|\[::1\]|localhost")
if [ -n "$outbound" ]; then bad "Our processes have outbound connections:"; echo "$outbound"; else ok "No outbound connections from our processes"; fi

echo
if [ "$fails" = 0 ]; then echo "All checks passed. Ready to record."; else echo "$fails thing(s) to fix."; exit 1; fi
