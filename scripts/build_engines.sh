#!/usr/bin/env bash
# Build whisper.cpp + llama.cpp with ARM dotprod/i8mm when on aarch64.
# Usage: scripts/build_engines.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPS="$ROOT/deps"
mkdir -p "$DEPS"

ARCH="$(uname -m)"
JOBS="${JOBS:-8}"

cmake_common_args() {
  # On aarch64 (Termux / phone): enable NATIVE + Armv8.6 dotprod/i8mm.
  # On x86_64 laptop: NATIVE=ON only (ARM_ARCH flag is ignored / unsupported).
  if [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then
    echo "-DGGML_NATIVE=ON -DGGML_CPU_ARM_ARCH=armv8.6-a+dotprod+i8mm"
  else
    echo "-DGGML_NATIVE=ON"
  fi
}

build_one() {
  local name="$1"
  local url="$2"
  local extra="$3"
  local dir="$DEPS/$name"
  if [[ ! -d "$dir/.git" ]]; then
    git clone --depth 1 "$url" "$dir"
  fi
  echo "==== Building $name ($ARCH) ===="
  # shellcheck disable=SC2086
  cmake -B "$dir/build" $extra $(cmake_common_args)
  cmake --build "$dir/build" -j"$JOBS" --config Release
  echo "OK  $dir/build/bin"
}

build_one whisper.cpp https://github.com/ggerganov/whisper.cpp.git "-DWHISPER_SDL2=OFF"
build_one llama.cpp https://github.com/ggerganov/llama.cpp.git ""

echo
echo "Binaries:"
ls -la "$DEPS/whisper.cpp/build/bin/whisper-server" \
       "$DEPS/llama.cpp/build/bin/llama-server"
echo "On Termux you can also: cp ... \$PREFIX/bin/"
