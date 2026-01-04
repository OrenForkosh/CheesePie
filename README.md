# CheesePie Lab Tools

Local Flask app for browsing, preprocessing (arena/background/regions), annotating, and importing media. Now includes optional MATLAB Engine integration for running MATLAB functions from Python.

## Quick Start

- Python: create and activate a virtualenv (3.10/3.11 recommended)
  - `python3 -m venv .venv && source .venv/bin/activate`
  - `python -m pip install -r requirements.txt`
- Run the app: `python app.py` (or your preferred runner)
  
  Or start in one line:
  - `source .venv/bin/activate && pip install -r requirements.txt && python app.py`

### Start Script

- macOS/Linux:
  - `chmod +x start.sh && ./start.sh`
- Windows (PowerShell):
  - `pwsh -File scripts/start.ps1` (or `powershell -ExecutionPolicy Bypass -File scripts/start.ps1`)

What it does:
- Creates/activates `.venv`, installs `requirements.txt`, and runs `app.py`.
- Respects `PYTHON` to choose the interpreter and `PORT` to set the port (defaults to `8000`).
- MATLAB Engine auto-setup (optional):
  - If `matlab.enabled` is true and the engine is missing, you can auto-install before start:
    - `./start.sh --setup-matlab` (auto-detects MATLAB), or provide a path:
    - `./start.sh --setup-matlab --matlab-root "/Applications/MATLAB_R2025a.app"`
  - You can also run the helper directly: `bash scripts/setup_matlab_engine.sh [MATLAB_ROOT]`.

## MATLAB Engine Integration

You can call MATLAB functions from Python via the MATLAB Engine. The app exposes safe endpoints and a sample segmentation flow on the Preproc page.

### 1) Requirements

- MATLAB installed locally
- MATLAB Engine for Python installed into the same Python environment that runs this app
- (For the sample segmentation) Image Processing Toolbox

### 2) One‑liner setup (macOS/Linux)

Run the helper script to install the Engine binding into your current venv and verify:

```
# From the repo root (with your venv activated)
chmod +x scripts/setup_matlab_engine.sh
./scripts/setup_matlab_engine.sh
```

The script auto-detects a MATLAB install under `/Applications/MATLAB_*.app` (macOS) or `/usr/local/MATLAB/*` or `/opt/MATLAB/*` (Linux). You can override detection:

```
# Provide the MATLAB root explicitly (folder containing extern/engines/python)
./scripts/setup_matlab_engine.sh "/Applications/MATLAB_R2025a.app"
# or
MATLAB_ROOT="/usr/local/MATLAB/R2024b" ./scripts/setup_matlab_engine.sh
```

### 3) Manual install (alternative)

If you prefer the official steps:

```
# Activate your venv first
source .venv/bin/activate
# Then install the Engine binding from your MATLAB
cd "/Applications/MATLAB_R2025a.app/extern/engines/python"
python -m pip install .
```

Verify:

```
python - << 'PY'
import sys
print('python:', sys.executable)
import matlab.engine as me
print('import ok; found sessions:', me.find_matlab())
PY
```

If import fails, ensure your Python version is supported by your MATLAB release (check MathWorks docs) and that you installed into the same interpreter used by Flask.

### 4) Configure paths and whitelist

`config.json` has a `matlab` section:

```
"matlab": {
  "enabled": true,
  "mode": "engine",
  "binary": "/Applications/MATLAB_R2025a.app/bin/matlab",
  "paths": ["./matlab"],
  "whitelist": ["segment_frame"]
}
```

- `paths`: folders added to MATLAB path at engine start (we ship `matlab/segment_frame.m`).
- `whitelist`: list of MATLAB functions allowed to be called from the app.

### 5) Try the sample segmentation

- Open Preproc, click “Segment (MATLAB)”. You should see yellow boxes/centroids overlaid.
- Or call the endpoint directly:

```
curl -s -X POST http://localhost:5000/api/matlab/segment_frame \
  -H 'Content-Type: application/json' \
  -d '{"path":"/absolute/path/to/frame.png"}' | python -m json.tool
```

Common issues:

- `Import failed: No module named 'matlab.engine'` → install the engine into your venv (see steps above).
- Version mismatch → use a Python version supported by your MATLAB release (e.g., 3.10/3.11).

## Development Notes

- Preproc saves sidecars next to the video: `.preproc.json`, `.arena.json`, `.background.png`.
- The structure of `.preproc.json` files is documented in `preproc.schema.json` (JSON Schema 2020-12).
- Regions defaults (including cells) and Preproc defaults (grid, cm, background params) are stored in `config.json` under your Facility → Setup entries.
- The Preproc “Save…” drawer lets you persist the current settings back into `config.json` as a Setup.

## Modular App Structure

The app is split into small, focused modules and blueprints to keep files manageable:

- App factory: `cheesepie.create_app()` wires everything together and registers template filters.
- Blueprints (URLs unchanged):
  - `cheesepie/pages.py` → `/`, `/browser`, `/preproc`, `/annotator`, `/importer`, `/settings`
  - `cheesepie/browser.py` → `/api/list`, `/api/fileinfo`
  - `cheesepie/media.py` → `/api/media_meta`, `/media`
  - `cheesepie/preproc.py` → `/api/preproc/*`
  - `cheesepie/matlab.py` → `/api/matlab/*`
  - `cheesepie/importer.py` → `/api/import/*`
  - `cheesepie/annotations.py` → `/api/annotations`
- Config and helpers: `cheesepie/config.py` (loads `config.json`, exposes `cfg_*` helpers, and injects a safe `public_config` into templates).
- Template filters: `cheesepie/filters.py` (`filesize`, `fmt_time`).
- Entry point: `app.py` is a tiny runner that calls `create_app()`.

Adding a new endpoint

- Create a `cheesepie/<area>.py` with a `Blueprint` and route(s), then register it in `cheesepie/__init__.py` (or reuse an existing blueprint when appropriate). Prefer grouping by feature (e.g., new importer utilities under `importer.py`).
- Keep route handlers small and pure; push validation and filesystem logic into local helper functions for reuse and testability.

Notes

- You can override runtime config via `CHEESEPIE_CONFIG=/path/to/config.json`.
- Keep `matlab.whitelist` and `matlab.paths` tightly scoped; avoid broadening without review.
