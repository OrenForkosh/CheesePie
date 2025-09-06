#!/usr/bin/env bash
set -euo pipefail

log(){ printf "[setup] %s\n" "$*"; }
err(){ printf "[setup] ERROR: %s\n" "$*" >&2; }

PY_BIN="${PYTHON:-python3}"

detect_matlab_root(){
  # 1) Explicit arg wins
  if [[ $# -ge 1 && -n "${1:-}" ]]; then
    echo "$1"
    return 0
  fi
  # 2) Env var
  if [[ -n "${MATLAB_ROOT:-}" ]]; then
    echo "$MATLAB_ROOT"
    return 0
  fi
  # 3) macOS default detection: latest /Applications/MATLAB_*.app
  if [[ -d "/Applications" ]]; then
    local latest
    latest=$(ls -1d /Applications/MATLAB_*.app 2>/dev/null | sort -Vr | head -n1 || true)
    if [[ -n "$latest" ]]; then
      echo "$latest"
      return 0
    fi
  fi
  # 4) Linux common locations
  for base in /usr/local/MATLAB /opt/MATLAB; do
    if [[ -d "$base" ]]; then
      local latest
      latest=$(ls -1d "$base"/* 2>/dev/null | sort -Vr | head -n1 || true)
      if [[ -n "$latest" ]]; then
        echo "$latest"
        return 0
      fi
    fi
  done
  return 1
}

MATLAB_ROOT_DIR="$(detect_matlab_root "$@" || true)"
if [[ -z "$MATLAB_ROOT_DIR" ]]; then
  err "Could not detect MATLAB installation. Set MATLAB_ROOT or pass the path, e.g. ./scripts/setup_matlab_engine.sh /Applications/MATLAB_R2025a.app"
  exit 1
fi

ENG_DIR="$MATLAB_ROOT_DIR/extern/engines/python"
if [[ ! -d "$ENG_DIR" ]]; then
  err "Engine dir not found: $ENG_DIR"
  exit 1
fi

log "Using Python: $(command -v "$PY_BIN" || echo "$PY_BIN")"
log "MATLAB root: $MATLAB_ROOT_DIR"
log "Engine path: $ENG_DIR"

"$PY_BIN" -m pip --version >/dev/null 2>&1 || { err "pip not found for $PY_BIN"; exit 1; }

log "Installing MATLAB Engine for Python..."
"$PY_BIN" -m pip install "$ENG_DIR"

log "Verifying import..."
"$PY_BIN" - << 'PY'
import sys
print('python:', sys.executable)
try:
    import matlab.engine as me
    print('matlab.engine import: OK')
    try:
        print('find_matlab:', me.find_matlab())
    except Exception as e:
        print('find_matlab failed:', e)
except Exception as e:
    print('matlab.engine import failed:', e)
    raise
PY

log "Done. If import failed, check that your Python version is supported by your MATLAB release and re-run this script with the correct venv active."

