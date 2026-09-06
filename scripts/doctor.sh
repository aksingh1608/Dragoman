#!/usr/bin/env bash
# Quick health check for Dragoman on Termux / laptop.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Dragoman doctor ==="
echo "ROOT=$ROOT"
echo "arch=$(uname -m)"
echo

ok() { echo "OK   $1"; }
bad() { echo "FAIL $1"; }

[[ -x .venv/bin/python ]] && ok "venv python" || bad "venv missing — python -m venv .venv"
.venv/bin/python -c "import fastapi,uvicorn,httpx" 2>/dev/null && ok "fastapi/uvicorn/httpx" || bad "pip deps — pip install -r backend/requirements.txt"

[[ -x deps/whisper.cpp/build/bin/whisper-server ]] && ok "whisper-server binary" || bad "whisper-server — ./scripts/build_engines.sh"
[[ -x deps/llama.cpp/build/bin/llama-server ]] && ok "llama-server binary" || bad "llama-server — ./scripts/build_engines.sh"

[[ -f models/ggml-tiny-q5_1.bin ]] && ok "tiny model" || bad "tiny model — ./scripts/setup_models.sh"
[[ -f models/ggml-base-q5_1.bin ]] && ok "base model" || bad "base model — ./scripts/setup_models.sh"
[[ -f models/qwen2.5-1.5b-instruct-q4_0.gguf ]] && ok "qwen model" || bad "qwen model — ./scripts/setup_models.sh"

echo
echo "=== Ports / processes ==="
for p in 8080 8081 8082; do
  code="$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 1 "http://127.0.0.1:$p/" 2>/dev/null || echo 000)"
  echo "port $p -> HTTP $code"
done
ps aux 2>/dev/null | grep -E 'whisper-server|llama-server|uvicorn' | grep -v grep || echo "(no servers running)"

echo
echo "=== Recent logs (if any) ==="
for f in bridge.log whisper-server.log llama-server.log; do
  if [[ -f $f ]]; then
    echo "--- $f (last 15 lines) ---"
    tail -n 15 "$f" || true
  fi
done

echo
echo "=== What to do ==="
echo "1) Fix any FAIL lines above"
echo "2) Start: source .venv/bin/activate && WHISPER_MODEL=models/ggml-tiny-q5_1.bin WHISPER_AC=256 WHISPER_THREADS=2 ./scripts/run.sh"
echo "3) Leave Termux open; Chrome -> http://127.0.0.1:8080/"
echo "4) HEALTH must be green; install offline DE+EN TTS voices if red banner"
