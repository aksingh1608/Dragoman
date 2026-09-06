#!/usr/bin/env bash
# Termux helper: install FastAPI stack when pip has no Android wheels for pydantic.
set -euo pipefail

echo "Upgrading pip..."
python -m pip install -U pip setuptools wheel

if ! python -c "import fastapi" 2>/dev/null; then
  echo "Trying binary wheels first..."
  if python -m pip install --only-binary=:all: -r backend/requirements.txt; then
    echo "OK (wheels)"
    exit 0
  fi
  echo "No wheels for this Python — installing Termux rust to build pydantic-core..."
  if command -v pkg >/dev/null 2>&1; then
    pkg install -y rust binutils
  else
    echo "ERROR: install rust (pkg install rust) then re-run pip install -r backend/requirements.txt" >&2
    exit 1
  fi
  # Prefer Termux rustc over broken rustup android triple
  export CARGO_BUILD_TARGET=""
  python -m pip install -r backend/requirements.txt
fi

python -c "import fastapi, uvicorn, httpx; print('Python deps OK')"
