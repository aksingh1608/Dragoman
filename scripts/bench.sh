#!/usr/bin/env bash
# Benchmark whisper-cli across models × audio-ctx × thread pinning.
# Usage: scripts/bench.sh path/to/clip.wav
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODELS="$ROOT/models"
WAV="${1:-}"

if [[ -z "$WAV" || ! -f "$WAV" ]]; then
  echo "Usage: $0 path/to/clip.wav" >&2
  exit 1
fi

WHISPER_CLI="${WHISPER_CLI:-}"
if [[ -z "$WHISPER_CLI" ]]; then
  if [[ -x "$ROOT/deps/whisper.cpp/build/bin/whisper-cli" ]]; then
    WHISPER_CLI="$ROOT/deps/whisper.cpp/build/bin/whisper-cli"
  else
    WHISPER_CLI="$(command -v whisper-cli || true)"
  fi
fi
if [[ -z "$WHISPER_CLI" || ! -x "$WHISPER_CLI" ]]; then
  echo "ERROR: whisper-cli not found" >&2
  exit 1
fi

export LD_LIBRARY_PATH="$(dirname "$WHISPER_CLI"):${LD_LIBRARY_PATH:-}"

HELP="$("$WHISPER_CLI" -h 2>&1 || true)"
has_flag() {
  echo "$HELP" | grep -qE -- "(^|[[:space:]])$1([[:space:],]|$)"
}

BASE_EXTRA=()
has_flag -bs && BASE_EXTRA+=(-bs 1) || echo "WARNING: no -bs" >&2
has_flag -bo && BASE_EXTRA+=(-bo 1) || echo "WARNING: no -bo" >&2
if has_flag -fa || has_flag --flash-attn; then BASE_EXTRA+=(-fa); else echo "WARNING: no -fa" >&2; fi
if has_flag --no-fallback || has_flag -nf; then BASE_EXTRA+=(--no-fallback); else echo "WARNING: no --no-fallback" >&2; fi
HAS_AC=0
has_flag -ac && HAS_AC=1 || echo "WARNING: no -ac" >&2

MODELS_LIST=(tiny-q5_1 base-q5_1 small-q5_1)
AC_LIST=(256 384 768)

# Thread configs: label|threads|optional taskset prefix
# Unpinned -t 4 vs performance-core pin (cores 6,7 on Dimensity 7200) -t 2
THREAD_CFGS=(
  "t4_unpinned|4|"
  "t2_pin67|2|taskset -c 6,7"
)

printf "%-12s  %5s  %-12s  %8s  %s\n" "MODEL" "AC" "THREADS" "WALL_MS" "TRANSCRIPT"
printf "%-12s  %5s  %-12s  %8s  %s\n" "------------" "-----" "------------" "--------" "----------"

run_one() {
  local model_path="$1"
  local ac="$2"
  local label="$3"
  local threads="$4"
  local pin_prefix="$5"

  local args=(-m "$model_path" -t "$threads")
  args+=("${BASE_EXTRA[@]}")
  if [[ "$HAS_AC" == "1" ]]; then
    args+=(-ac "$ac")
  fi
  args+=(-f "$WAV" -nt -l auto)

  local tmp out_err
  tmp="$(mktemp)"
  out_err="$(mktemp)"
  local start end elapsed_ms text
  start=$(date +%s%N)
  # shellcheck disable=SC2086
  if [[ -n "$pin_prefix" ]]; then
    if command -v taskset >/dev/null 2>&1; then
      $pin_prefix "$WHISPER_CLI" "${args[@]}" >"$tmp" 2>"$out_err" || true
    else
      echo "WARNING: taskset missing — running unpinned for $label" >&2
      "$WHISPER_CLI" "${args[@]}" >"$tmp" 2>"$out_err" || true
    fi
  else
    "$WHISPER_CLI" "${args[@]}" >"$tmp" 2>"$out_err" || true
  fi
  end=$(date +%s%N)
  elapsed_ms=$(awk -v s="$start" -v e="$end" 'BEGIN { printf "%d", (e - s) / 1000000 }')
  text="$(grep -v '^$' "$tmp" | tail -n 1 | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g')"
  rm -f "$tmp" "$out_err"
  printf "%-12s  %5s  %-12s  %8s  %s\n" "$(basename "$model_path" .bin | sed 's/^ggml-//')" "$ac" "$label" "$elapsed_ms" "${text:-(empty)}"
}

for name in "${MODELS_LIST[@]}"; do
  model="$MODELS/ggml-${name}.bin"
  if [[ ! -f "$model" ]]; then
    printf "%-12s  %5s  %-12s  %8s  %s\n" "$name" "-" "-" "SKIP" "(not downloaded)"
    continue
  fi
  for ac in "${AC_LIST[@]}"; do
    for cfg in "${THREAD_CFGS[@]}"; do
      IFS='|' read -r label threads pin <<<"$cfg"
      run_one "$model" "$ac" "$label" "$threads" "$pin"
    done
  done
done
