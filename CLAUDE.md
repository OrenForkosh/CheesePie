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

## UI / UX Guidelines

These rules keep all modules visually and behaviourally consistent. Follow them when building or editing any page.

### Layout

- Every module uses a **two-column CSS grid**: a fixed-width sidebar (250–280 px) on the left, flexible main content on the right.
- Grid declaration: `display:grid; grid-template-columns: 256px 1fr; gap:14px; padding:14px; align-items:start;`
- There is no fixed footer; no footer-clearance `padding-bottom` is needed on layout grids.

### Sidebar

- The sidebar uses the shared `subpanel` wrapper **with its padding overridden to 0** (`padding:0 !important; height:auto !important`). Individual sections control their own padding via `.cal-section` (12 px top/bottom, 16 px left/right).
- Sections are separated by `<hr class="*-divider">` (border-top only, no margin on the hr itself; top margin belongs to the section label).
- **No `<h1>` title inside the sidebar.** The active tab in the nav is already the module's identity. Use a section label as the first element instead.
- The section-label + divider pattern suits **sidebar-only control panels** (like Calibration) where controls are sparse and the extra vertical rhythm helps. It is **not appropriate for dense form layouts** (like the Importer) where the extra space is wasteful.

### Section Labels (sidebar control panels only)

```css
font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
text-transform: uppercase; color: var(--muted);
margin-bottom: 8px;
```

Labels may carry an inline badge for auxiliary info (e.g. a live percentage value):

```css
.badge { font-size:10px; font-weight:400; text-transform:none; letter-spacing:0;
         background:var(--surface); border:1px solid var(--border);
         border-radius:4px; padding:1px 5px; color:var(--muted); }
```

### Status Lines

Every action area has a **status line** below it for feedback and errors:

```css
font-size: 11px; color: var(--muted); min-height: 15px; margin-top: 5px; line-height: 1.4;
```

`min-height` prevents layout shift when the text appears or disappears.

### Interactive Controls

| Pattern | When to use |
|---------|-------------|
| **Segmented control** (bordered pill strip, active segment filled with `var(--primary)`) | Mutually exclusive modes — e.g. Snap / Auto / Live |
| **Pill toggle buttons** (rounded border, active filled with `var(--primary)`) | On/off display options — e.g. Equalize / Invert |
| **Icon button** (`opacity: 0.55`, `transition: opacity 0.15s`, hover → `opacity: 1`) | Secondary actions alongside a primary control — e.g. ⚙ settings |
| **Save / action row** (`display:flex; gap:6px`) | Select or type input paired with a submit button on the same line |
| **Spinner inside button** (CSS `animation: spin 0.7s linear infinite` on an inner `<span>`) | Long-running async actions (scan, fetch) — applied to a class, removed on completion |

### Progressive Disclosure

Controls appear progressively as the user completes earlier steps. Initially show only the minimum needed to start; reveal each group (`style.display = ''`) once its prerequisite is satisfied. This keeps the UI uncluttered and guides the workflow.

### Modals / Dialogs

Use the existing `.overlay` + `.overlay-panel` classes. Always include:
- A header row with a title and a `×` close button.
- A status line at the bottom for save errors.
- Backdrop click (`if (e.target === overlay) close()`) to dismiss.

### Avoid

- Inline `style=""` attributes for anything other than one-off grid-column spans. Extract to named CSS classes.
- Redundant `<h1>` / `<h2>` page titles inside sidebar panels.
- Module CSS that hard-codes colours — always use CSS custom properties (`var(--primary)`, `var(--border)`, `var(--muted)`, etc.).

---

## Important Constraints

- **MATLAB whitelist**: only functions listed in `config.json → matlab.whitelist` may be called. Do not broaden without explicit review.
- **Auth gate**: all non-auth routes require a valid HMAC token. Do not bypass the `@require_auth` decorator.
- **No automated test suite** — validate API changes with `curl` and manual UI flows.
- **Config keys**: if you add or rename `config.json` keys, update `config.example.json` and note it in the PR description.
- The app must run without MATLAB installed; all MATLAB-dependent code paths must degrade gracefully.
