#!/usr/bin/env bash
# Download Whisper and LLM models into ./models (skips files that already exist).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODELS="$ROOT/models"
mkdir -p "$MODELS"

BASE_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

download() {
  local url="$1"
  local dest="$2"
  local name
  name="$(basename "$dest")"
  if [[ -f "$dest" ]]; then
    echo "SKIP  $name (already exists)"
    return 0
  fi
  echo "GET   $name"
  if command -v curl >/dev/null 2>&1; then
    curl -L --fail --progress-bar -o "$dest.partial" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget --show-progress -O "$dest.partial" "$url"
  else
    echo "ERROR: need curl or wget" >&2
    exit 1
  fi
  mv "$dest.partial" "$dest"
  echo "OK    $name"
}

# Default runtime model is base-q5_1; keep small/tiny for bench.sh sweeps.
download "$BASE_URL/ggml-base-q5_1.bin" "$MODELS/ggml-base-q5_1.bin"
download "$BASE_URL/ggml-tiny-q5_1.bin" "$MODELS/ggml-tiny-q5_1.bin"
download "$BASE_URL/ggml-small-q5_1.bin" "$MODELS/ggml-small-q5_1.bin"

LLAMA_URL="https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_0.gguf"
LLAMA_FILE="$MODELS/qwen2.5-1.5b-instruct-q4_0.gguf"
download "$LLAMA_URL" "$LLAMA_FILE"

echo
echo "Models in $MODELS:"
if command -v du >/dev/null 2>&1; then
  du -h "$MODELS"/ggml-*-q5_1.bin "$LLAMA_FILE" 2>/dev/null || true
  total="$(du -ch "$MODELS"/ggml-*-q5_1.bin "$LLAMA_FILE" 2>/dev/null | tail -n1 | awk '{print $1}')"
  echo "Total: ${total:-unknown}"
else
  ls -lh "$MODELS"
fi
