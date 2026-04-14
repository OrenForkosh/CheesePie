# CLAUDE.md

CheesePie is a local Flask web app for behavioral neuroscience research — video browsing, preprocessing (arena/background/regions), frame-by-frame annotation, and batch importing. Optional MATLAB Engine integration for running segmentation functions. See `README.md` for full setup and `AGENTS.md` for coding conventions.

## Development Commands

```bash
# Setup
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Run
python app.py                  # serves at http://localhost:8000
./run.sh                       # convenience wrapper

# MATLAB Engine (optional)
./scripts/setup_matlab_engine.sh [/path/to/MATLAB.app]
```

Key environment variables: `PORT` (default 8000), `HOST`, `DEBUG`, `CHEESEPIE_CONFIG` (custom config path), `CHEESEPIE_AUTH_FILE`.

## Architecture

**Backend** — Flask with blueprints, one module per feature area:

| Module | Blueprint prefix | Responsibility |
|--------|-----------------|----------------|
| `cheesepie/pages.py` | `/`, `/browser`, `/preproc`, `/annotator`, `/importer`, `/settings`, `/tasks` | Page routes |
| `cheesepie/browser.py` | `/api/list`, `/api/fileinfo` | File listing |
| `cheesepie/media.py` | `/api/media_meta`, `/media/*` | FFprobe wrapper |
| `cheesepie/preproc.py` | `/api/preproc/*` | Arena/background/regions |
| `cheesepie/annotations.py` | `/api/annotations` | Load/save annotation JSON |
| `cheesepie/importer.py` | `/api/import/*` | Batch transcode via FFmpeg |
| `cheesepie/analyze.py` | `/api/analyze/*` | Load MATLAB `.obj.mat` tracking data |
| `cheesepie/track.py` | `/api/track/*` | Background job tracking |
| `cheesepie/tasks.py` | `/api/tasks/*` | Task queue (persisted to `working/tasks.json`) |
| `cheesepie/auth.py` | `/auth/*` | HMAC-based session tokens |
| `cheesepie/config.py` | `/api/config/*` | `config.json` loading; `cfg_*` accessor helpers |
| `cheesepie/matlab.py` | `/api/matlab/*` | Whitelisted MATLAB Engine calls |

App factory: `cheesepie.create_app()` in `cheesepie/__init__.py`.

**Frontend** — vanilla JS + Jinja2 templates. No build step. Static assets in `static/`; preproc-specific JS under `static/preproc/`.

## Key Data & Files

- **Sidecars** (stored alongside each video): `.preproc.json`, `.arena.json`, `.background.png`, `.json` (annotations). Schema in `preproc.schema.json`.
- **Config**: `config.json` — facilities, setups, annotator behaviors, importer settings, MATLAB options.
- **Auth state**: `.cheesepie_auth.json` — Flask secret key + password hash.
- **Task queue**: `working/tasks.json` — persisted task list.

## Adding a New Endpoint

1. Create or extend `cheesepie/<feature>.py` with a `Blueprint`.
2. Register it in `cheesepie/__init__.py`.
3. Keep route handlers thin; push logic into helper functions.

## Important Constraints

- **MATLAB whitelist**: only functions listed in `config.json → matlab.whitelist` may be called. Do not broaden without explicit review.
- **Auth gate**: all non-auth routes require a valid HMAC token. Do not bypass the `@require_auth` decorator.
- **No automated test suite** — validate API changes with `curl` and manual UI flows.
- **Config keys**: if you add or rename `config.json` keys, update `config.example.json` and note it in the PR description.
- The app must run without MATLAB installed; all MATLAB-dependent code paths must degrade gracefully.
