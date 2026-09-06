#!/usr/bin/env bash
# Build whisper.cpp + llama.cpp for Dragoman.
# Usage: scripts/build_engines.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPS="$ROOT/deps"
mkdir -p "$DEPS"

ARCH="$(uname -m)"
# Phones OOMing/crashing clang at -j8 is common; default lower on Android/Termux.
if [[ -n "${JOBS:-}" ]]; then
  :
elif [[ -d /data/data/com.termux ]] || [[ "${PREFIX:-}" == *com.termux* ]]; then
  JOBS=2
else
  JOBS="$(nproc 2>/dev/null || echo 4)"
fi

cmake_common_args() {
  # x86_64 laptop: let cmake use host native ISA.
  if [[ "$ARCH" != "aarch64" && "$ARCH" != "arm64" ]]; then
    echo "-DGGML_NATIVE=ON -DGGML_CCACHE=OFF"
    return
  fi

  # aarch64 / Termux:
  # GGML_NATIVE=ON auto-enables SVE on many phones; Clang in Termux often
  # crashes compiling ggml ARM repack with +sve (exit 134).
  # Keep DOTPROD + i8mm (needed for Dimensity 7200 speed) without SVE.
  echo "-DGGML_NATIVE=OFF -DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+i8mm -DGGML_CCACHE=OFF"
}

build_one() {
  local name="$1"
  local url="$2"
  local extra="$3"
  local dir="$DEPS/$name"
  if [[ ! -d "$dir/.git" ]]; then
    git clone --depth 1 "$url" "$dir"
  fi
  echo "==== Building $name ($ARCH) jobs=$JOBS ===="
  echo "  cmake args: $extra $(cmake_common_args)"
  rm -rf "$dir/build"
  # -S source dir is required; -B alone uses cwd and breaks when run from repo root.
  # shellcheck disable=SC2086
  cmake -S "$dir" -B "$dir/build" $extra $(cmake_common_args)
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
