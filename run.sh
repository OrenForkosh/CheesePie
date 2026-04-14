#!/usr/bin/env bash
set -euo pipefail

log() { printf "[start] %s\n" "$*"; }
err() { printf "[start] ERROR: %s\n" "$*" >&2; }

# Repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"
cd "$ROOT_DIR"

git pull https://github.com/OrenForkosh/CheesePie

# Choose Python (allow override via $PYTHON)
PY_BIN="${PYTHON:-}"
if [[ -z "$PY_BIN" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    PY_BIN="python3"
  elif command -v python >/dev/null 2>&1; then
    PY_BIN="python"
  else
    err "Python not found. Install Python 3.10/3.11 and retry."
    exit 1
  fi
fi

log "Using Python: $(command -v "$PY_BIN" || echo "$PY_BIN")"

# Optional flags
# --setup-matlab      Attempt to install MATLAB Engine if missing
# --matlab-root PATH  Provide MATLAB root (folder containing extern/engines/python)
SETUP_MATLAB=0
MATLAB_ROOT_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --setup-matlab)
      SETUP_MATLAB=1; shift ;;
    --matlab-root)
      MATLAB_ROOT_ARG="${2:-}"; shift 2 ;;
    --)
      shift; break ;;
    *)
      # Ignore unknown args (reserved)
      shift ;;
  esac
done

# Create/activate venv
VENV_DIR="$ROOT_DIR/.venv"
if [[ ! -f "$VENV_DIR/bin/activate" ]]; then
  log "Creating virtual environment in .venv ..."
  "$PY_BIN" -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1090
source "$VENV_DIR/bin/activate"
log "Venv: $VIRTUAL_ENV"

# Ensure pip is available and reasonably up to date
python -m pip --version >/dev/null 2>&1 || { err "pip missing in venv"; exit 1; }
python -m pip install --upgrade pip >/dev/null 2>&1 || true

# Install Python dependencies
if [[ -f "requirements.txt" ]]; then
  log "Installing requirements from requirements.txt ..."
  python -m pip install -r requirements.txt
else
  log "requirements.txt not found; skipping install"
fi

# MATLAB Engine: detect need and optionally install
NEED_MATLAB=$(python - <<'PY'
import json, os
cfg_path = os.environ.get('CHEESEPIE_CONFIG') or os.path.join(os.getcwd(), 'config.json')
try:
    with open(cfg_path, 'r', encoding='utf-8') as f:
        cfg = json.load(f)
    m = (cfg or {}).get('matlab', {})
    enabled = bool(m.get('enabled', True))
    mode = (m.get('mode') or 'engine').strip()
    if enabled and mode == 'engine':
        try:
            import matlab.engine  # type: ignore
            print('0')
        except Exception:
            print('1')
    else:
        print('0')
except Exception:
    print('0')
PY
)

if [[ "$SETUP_MATLAB" = "1" && "$NEED_MATLAB" = "1" ]]; then
  log "Attempting MATLAB Engine setup..."
  if [[ -n "$MATLAB_ROOT_ARG" ]]; then
    MATLAB_ROOT="$MATLAB_ROOT_ARG" bash ./scripts/setup_matlab_engine.sh "$MATLAB_ROOT_ARG" || true
  else
    bash ./scripts/setup_matlab_engine.sh || true
  fi
  if python -c 'import matlab.engine' >/dev/null 2>&1; then
    log "MATLAB Engine installed."
  else
    err "MATLAB Engine still not importable. Specify --matlab-root to your MATLAB install."
  fi
fi
if [[ "$SETUP_MATLAB" = "0" && "$NEED_MATLAB" = "1" ]]; then
  log "NOTE: MATLAB Engine enabled in config, but not importable."
  log "      Run ./start.sh --setup-matlab [--matlab-root \"/path/to/MATLAB_R20xx*/\"] to install."
fi

# Run the app with auto-reload in development
# Export env so Flask process (and its reloader child) sees them
export DEBUG="${DEBUG:-1}"               # set to 0 to disable auto-reload
export PORT="${PORT:-8000}"
export HOST="${HOST:-127.0.0.1}"

log "Starting app on http://${HOST}:${PORT} (DEBUG=${DEBUG}) ..."
while true; do
  if python app.py; then
    code=0
  else
    code=$?
  fi
  if [[ "$code" -eq 143 ]]; then
    log "App requested restart; relaunching..."
    continue
  fi
  if [[ "$code" -eq 0 ]]; then
    log "App exited cleanly."
    exit 0
  fi
  err "App exited with code $code."
  exit "$code"
done
