#!/usr/bin/env bash
# Start whisper-server, llama-server, and the FastAPI bridge.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODELS="$ROOT/models"

# Tunable via env (defaults aimed at <1500 ms on Dimensity 7200 with base):
#   WHISPER_MODEL=models/ggml-base-q5_1.bin
#   WHISPER_AC=384
#   WHISPER_THREADS=4
WHISPER_MODEL="${WHISPER_MODEL:-models/ggml-base-q5_1.bin}"
WHISPER_AC="${WHISPER_AC:-384}"
WHISPER_THREADS="${WHISPER_THREADS:-4}"
if [[ "$WHISPER_MODEL" != /* ]]; then
  WHISPER_MODEL="$ROOT/$WHISPER_MODEL"
fi
LLAMA_MODEL="${LLAMA_MODEL:-$MODELS/qwen2.5-1.5b-instruct-q4_0.gguf}"
if [[ "$LLAMA_MODEL" != /* ]]; then
  LLAMA_MODEL="$ROOT/$LLAMA_MODEL"
fi

WHISPER_BIN="${WHISPER_BIN:-}"
LLAMA_BIN="${LLAMA_BIN:-}"
if [[ -z "$WHISPER_BIN" ]]; then
  if [[ -x "$ROOT/deps/whisper.cpp/build/bin/whisper-server" ]]; then
    WHISPER_BIN="$ROOT/deps/whisper.cpp/build/bin/whisper-server"
  else
    WHISPER_BIN="$(command -v whisper-server || true)"
  fi
fi
if [[ -z "$LLAMA_BIN" ]]; then
  if [[ -x "$ROOT/deps/llama.cpp/build/bin/llama-server" ]]; then
    LLAMA_BIN="$ROOT/deps/llama.cpp/build/bin/llama-server"
  else
    LLAMA_BIN="$(command -v llama-server || true)"
  fi
fi

WHISPER_PORT=8081
LLAMA_PORT=8082
BRIDGE_PORT=8080

WHISPER_PID=""
LLAMA_PID=""
BRIDGE_PID=""

cleanup() {
  echo
  echo "Shutting down..."
  for pid in "$BRIDGE_PID" "$LLAMA_PID" "$WHISPER_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  if command -v termux-wake-unlock >/dev/null 2>&1; then
    termux-wake-unlock 2>/dev/null || true
  fi
  echo "Stopped."
}
trap cleanup EXIT INT TERM

if [[ -z "$WHISPER_BIN" || ! -x "$WHISPER_BIN" ]]; then
  echo "ERROR: whisper-server not found. Build deps/whisper.cpp or install it on PATH." >&2
  exit 1
fi
if [[ -z "$LLAMA_BIN" || ! -x "$LLAMA_BIN" ]]; then
  echo "ERROR: llama-server not found. Build deps/llama.cpp or install it on PATH." >&2
  exit 1
fi

if [[ -x "$ROOT/.venv/bin/uvicorn" ]]; then
  UVICORN="$ROOT/.venv/bin/uvicorn"
elif command -v uvicorn >/dev/null 2>&1; then
  UVICORN="$(command -v uvicorn)"
else
  echo "ERROR: uvicorn not found — pip install -r backend/requirements.txt" >&2
  exit 1
fi

if [[ ! -f "$WHISPER_MODEL" ]]; then
  echo "ERROR: missing $WHISPER_MODEL — download base with scripts/setup_models.sh" >&2
  exit 1
fi
if [[ ! -f "$LLAMA_MODEL" ]]; then
  echo "ERROR: missing $LLAMA_MODEL — run scripts/setup_models.sh first" >&2
  exit 1
fi

if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
  echo "Wake lock acquired"
fi

export LD_LIBRARY_PATH="$(dirname "$WHISPER_BIN"):$(dirname "$LLAMA_BIN"):${LD_LIBRARY_PATH:-}"

WHISPER_HELP="$("$WHISPER_BIN" -h 2>&1 || true)"
whisper_has() {
  echo "$WHISPER_HELP" | grep -qE -- "(^|[[:space:]])$1([[:space:],]|$)"
}

DROPPED=()
WHISPER_ARGS=(
  -m "$WHISPER_MODEL"
  -t "$WHISPER_THREADS"
  --host 127.0.0.1
  --port "$WHISPER_PORT"
)

try_flag() {
  local flag="$1"
  shift
  if whisper_has "$flag"; then
    WHISPER_ARGS+=("$flag" "$@")
  else
    DROPPED+=("$flag")
    echo "WARNING: dropped unsupported whisper flag: $flag" >&2
  fi
}

# -ac shrinks encoder context (faster short clips)
# -bs 1 / -bo 1 greedy decode
# -fa flash attention
# --no-fallback no temperature retries
try_flag -ac "$WHISPER_AC"
try_flag -bs 1
try_flag -bo 1
if whisper_has -fa || whisper_has --flash-attn; then
  WHISPER_ARGS+=(-fa)
else
  DROPPED+=(-fa)
  echo "WARNING: dropped unsupported whisper flag: -fa" >&2
fi
if whisper_has --no-fallback || whisper_has -nf; then
  WHISPER_ARGS+=(--no-fallback)
else
  DROPPED+=(--no-fallback)
  echo "WARNING: dropped unsupported whisper flag: --no-fallback" >&2
fi

echo "============================================================"
echo "FINAL whisper-server command:"
echo "  $WHISPER_BIN ${WHISPER_ARGS[*]}"
if ((${#DROPPED[@]})); then
  echo "DROPPED FLAGS: ${DROPPED[*]}"
else
  echo "All requested speed flags accepted by this build."
fi
echo "  WHISPER_MODEL=$WHISPER_MODEL"
echo "  WHISPER_AC=$WHISPER_AC  WHISPER_THREADS=$WHISPER_THREADS"
echo "============================================================"

: >"$ROOT/whisper-server.log"
"$WHISPER_BIN" "${WHISPER_ARGS[@]}" \
  >>"$ROOT/whisper-server.log" 2>&1 &
WHISPER_PID=$!

echo "Starting llama-server on :$LLAMA_PORT ..."
: >"$ROOT/llama-server.log"
"$LLAMA_BIN" \
  -m "$LLAMA_MODEL" \
  -t 4 \
  -c 512 \
  --host 127.0.0.1 \
  --port "$LLAMA_PORT" \
  >>"$ROOT/llama-server.log" 2>&1 &
LLAMA_PID=$!

wait_http() {
  local url="$1"
  local name="$2"
  local tries=90
  local i=0
  echo -n "Waiting for $name"
  while (( i < tries )); do
    code="$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 "$url" 2>/dev/null || true)"
    if [[ -n "$code" && "$code" != "000" ]]; then
      echo " ready (HTTP $code)"
      return 0
    fi
    echo -n "."
    sleep 2
    i=$((i + 1))
  done
  echo
  echo "ERROR: $name did not become ready at $url" >&2
  exit 1
}

wait_http "http://127.0.0.1:$WHISPER_PORT/" "whisper-server"
wait_http "http://127.0.0.1:$LLAMA_PORT/health" "llama-server"

# CPU feature check (DOTPROD / MATMUL_INT8) from server system_info lines.
check_cpu_features() {
  local logf="$1"
  local name="$2"
  sleep 0.5
  local info
  info="$(grep -iE 'system_info|DOTPROD|MATMUL_INT8|AVX' "$logf" 2>/dev/null | head -n 5 || true)"
  echo "---- $name CPU features ----"
  if [[ -n "$info" ]]; then
    echo "$info"
  else
    echo "(no system_info line found yet in $logf)"
  fi
  local line
  line="$(grep -i 'DOTPROD' "$logf" 2>/dev/null | head -n 1 || true)"
  local dotprod="?"
  local matmul="?"
  if [[ "$line" =~ DOTPROD[[:space:]]*=[[:space:]]*([0-9]+) ]]; then
    dotprod="${BASH_REMATCH[1]}"
  fi
  if [[ "$line" =~ MATMUL_INT8[[:space:]]*=[[:space:]]*([0-9]+) ]]; then
    matmul="${BASH_REMATCH[1]}"
  fi
  # Also scan full log for standalone assignments
  if [[ "$dotprod" == "?" ]]; then
    dotprod="$(grep -oE 'DOTPROD[[:space:]]*=[[:space:]]*[0-9]+' "$logf" 2>/dev/null | head -n1 | grep -oE '[0-9]+$' || echo '?')"
  fi
  if [[ "$matmul" == "?" ]]; then
    matmul="$(grep -oE 'MATMUL_INT8[[:space:]]*=[[:space:]]*[0-9]+' "$logf" 2>/dev/null | head -n1 | grep -oE '[0-9]+$' || echo '?')"
  fi
  echo "  parsed: DOTPROD=$dotprod  MATMUL_INT8=$matmul"
  if [[ "$dotprod" == "0" || "$matmul" == "0" ]]; then
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
    echo "WARNING: $name reports DOTPROD=$dotprod MATMUL_INT8=$matmul" >&2
    echo "  On Dimensity 7200 / Armv9 these should be 1." >&2
    echo "  Rebuild with: scripts/build_engines.sh (GGML_NATIVE=ON +" >&2
    echo "  GGML_CPU_ARM_ARCH=armv8.6-a+dotprod+i8mm on aarch64)." >&2
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
  fi
}

check_cpu_features "$ROOT/whisper-server.log" "whisper-server"
check_cpu_features "$ROOT/llama-server.log" "llama-server"

export WHISPER_URL="http://127.0.0.1:$WHISPER_PORT"
export LLAMA_URL="http://127.0.0.1:$LLAMA_PORT"
export BRIDGE_HOST="0.0.0.0"
export BRIDGE_PORT="$BRIDGE_PORT"

echo "Starting bridge on 0.0.0.0:$BRIDGE_PORT ..."
cd "$ROOT"
"$UVICORN" backend.bridge:app --host 0.0.0.0 --port "$BRIDGE_PORT" --log-level info \
  >"$ROOT/bridge.log" 2>&1 &
BRIDGE_PID=$!

echo
echo "Dragoman is up."
echo "  Open http://127.0.0.1:$BRIDGE_PORT/ on this device"
echo "  Debug clip: http://127.0.0.1:$BRIDGE_PORT/api/debug/last"
echo "  Logs: whisper-server.log, llama-server.log, bridge.log"
echo "Press Ctrl+C to stop."

wait "$BRIDGE_PID"
