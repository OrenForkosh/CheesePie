# Repository Guidelines

This repo hosts a local Flask app for browsing, preprocessing, annotating, and importing media, with optional MATLAB Engine integration.

## Project Structure & Module Organization
- `app.py`: Flask app, routes, MATLAB helpers.
- `templates/`: Jinja2 views (e.g., `preproc.html`, `importer.html`).
- `static/`: client assets (CSS/JS/images).
- `matlab/`: MATLAB functions callable via the Engine (e.g., `segment_frame.m`).
- `scripts/`: utilities (e.g., `setup_matlab_engine.sh`).
- `config.json`: runtime settings; override with `CHEESEPIE_CONFIG`.
- `requirements.txt`: Python dependencies.

## Build, Test, and Development Commands
- Create venv: `python3 -m venv .venv && source .venv/bin/activate`
- Install deps: `pip install -r requirements.txt`
- Run app: `python app.py` (serves at `http://localhost:5000`)
- Setup MATLAB Engine (optional): `chmod +x scripts/setup_matlab_engine.sh && ./scripts/setup_matlab_engine.sh`
- Example API test (from README):
  `curl -s -X POST http://localhost:5000/api/matlab/segment_frame -H 'Content-Type: application/json' -d '{"path":"/abs/path/to/frame.png"}'`

## Coding Style & Naming Conventions
- Python: PEP 8, 4‑space indents, `snake_case` for modules/functions, `CamelCase` for classes.
- Prefer type hints (`typing`) as in `app.py`.
- Flask: group related routes; keep handlers small and pure where possible.
- Templates: descriptive lowercase names (e.g., `browser.html`); keep view logic minimal.
- No enforced formatter in repo; keep changes consistent with current style.

## Testing Guidelines
- No automated test suite yet. Validate endpoints with `curl` and UI flows.
- For pure helpers, add small unit tests under `tests/` (pytest recommended) if introducing new logic.
- Include repro steps or sample payloads in PR descriptions.

## Commit & Pull Request Guidelines
- Commits: concise, imperative subject (e.g., "Add MATLAB warmup"), optional short body for context.
- PRs: clear description, linked issues, screenshots or `curl` output for UI/API changes, and config notes if `config.json` keys change.

## Security & Configuration Tips
- Use `CHEESEPIE_CONFIG` to point to a per‑machine config file.
- MATLAB: restrict `matlab.whitelist` in `config.json` to approved functions; avoid broadening without review.
- Keep `matlab.paths` minimal and project‑scoped (e.g., `./matlab`).

