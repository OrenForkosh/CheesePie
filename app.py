from __future__ import annotations

import os
import mimetypes
import json
import shutil
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Dict, Any, Optional
import re
import threading
import uuid

from flask import Flask, render_template, request, jsonify, Response, send_file


app = Flask(__name__)


# ----- App configuration -----
def load_config() -> Dict[str, Any]:
    """Load configuration from CHEESEPIE_CONFIG or ./config.json. Provide defaults."""
    cfg_path = os.getenv('CHEESEPIE_CONFIG')
    if cfg_path:
        p = Path(cfg_path).expanduser()
        if p.exists():
            try:
                return json.loads(p.read_text(encoding='utf-8'))
            except Exception:
                pass
    # fallback to project-local config.json
    local = Path(__file__).parent.joinpath('config.json')
    if local.exists():
        try:
            return json.loads(local.read_text(encoding='utf-8'))
        except Exception:
            pass
    # defaults
    return {
        "annotator": {
            "default_animals": ["R", "G", "B", "Y"],
        }
    }


CONFIG: Dict[str, Any] = load_config()


def _config_path() -> Path:
    cfg_path = os.getenv('CHEESEPIE_CONFIG')
    if cfg_path:
        return Path(cfg_path).expanduser()
    return Path(__file__).parent.joinpath('config.json')


def cfg_default_animals() -> List[str]:
    vals = CONFIG.get('annotator', {}).get('default_animals', ["R", "G", "B", "Y"])
    if not isinstance(vals, list):
        return ["R", "G", "B", "Y"]
    out = []
    for v in vals:
        try:
            s = str(v).strip()
            if s:
                out.append(s)
        except Exception:
            continue
    return out or ["R", "G", "B", "Y"]


def cfg_default_fps() -> int:
    try:
        v = int(CONFIG.get('annotator', {}).get('default_fps', 30))
        return max(1, min(300, v))
    except Exception:
        return 30


def cfg_default_types() -> List[Dict[str, Any]]:
    raw = CONFIG.get('annotator', {}).get('default_types', [])
    out: List[Dict[str, Any]] = []
    if isinstance(raw, list):
        for t in raw:
            if not isinstance(t, dict):
                continue
            name = str(t.get('name', '')).strip()
            if not name:
                continue
            mode = str(t.get('mode', 'single')).strip().lower()
            if mode not in ('single', 'dyadic'):
                mode = 'single'
            key = str(t.get('key', '')).strip()[:1]
            color = str(t.get('color', '#7c4dff')).strip() or '#7c4dff'
            out.append({'name': name, 'mode': mode, 'key': key, 'color': color})
    if not out:
        out = [
            {'name': 'Grooming', 'key': 'g', 'mode': 'single', 'color': '#4f8cff'},
            {'name': 'Chasing', 'key': 'c', 'mode': 'dyadic', 'color': '#ff6b6b'},
            {'name': 'Sniffing', 'key': 's', 'mode': 'single', 'color': '#ffd166'},
        ]
    return out


def cfg_keyboard() -> Dict[str, Any]:
    kb = CONFIG.get('annotator', {}).get('keyboard', {})
    # Defaults
    frame = {'prev': '[', 'next': ']'}
    jumps = {'left': 300, 'right': 300, 'shift': 60, 'alt': 10}
    try:
        if isinstance(kb.get('frame_step_keys'), dict):
            frame.update({k: str(v) for k, v in kb['frame_step_keys'].items() if v is not None})
        if isinstance(kb.get('jump_seconds'), dict):
            for k, v in kb['jump_seconds'].items():
                try:
                    jumps[k] = int(v)
                except Exception:
                    pass
    except Exception:
        pass
    return {'frame_step_keys': frame, 'jump_seconds': jumps}


def cfg_preview_thumbnails() -> int:
    try:
        v = int(CONFIG.get('browser', {}).get('preview_thumbnails', 8))
        return max(0, min(24, v))
    except Exception:
        return 8


def cfg_browser_visible_extensions() -> List[str]:
    """List of file extensions to show in the browser (lowercase, dot-prefixed)."""
    raw = CONFIG.get('browser', {}).get('visible_extensions', [".mp4", ".avi"])
    exts: List[str] = []
    if isinstance(raw, list):
        for e in raw:
            try:
                s = str(e).strip().lower()
                if not s:
                    continue
                if not s.startswith('.'):
                    s = '.' + s
                exts.append(s)
            except Exception:
                continue
    if not exts:
        exts = [".mp4", ".avi"]
    return exts


def cfg_importer_facilities() -> Dict[str, Any]:
    """Return validated facilities configuration for the importer.
    Shape: { facility: { source_dir:str, cameras:int, experiments:{ NAME:[treatments...] } } }
    """
    raw = CONFIG.get('importer', {}).get('facilities', {})
    out: Dict[str, Any] = {}
    if isinstance(raw, dict):
        for fname, fcfg in raw.items():
            try:
                if not isinstance(fcfg, dict):
                    continue
                source_dir = str(fcfg.get('source_dir', '')).strip()
                try:
                    cams = int(fcfg.get('cameras', 0))
                except Exception:
                    cams = 0
                cams = max(0, min(128, cams))
                exps_in = fcfg.get('experiments', {})
                exps_out: Dict[str, List[str]] = {}
                def_times: Dict[str, Dict[str, Dict[str, str]]] = {}
                if isinstance(exps_in, dict):
                    for ename, treats in exps_in.items():
                        if not ename:
                            continue
                        exp_key = str(ename).strip().upper()
                        tlist: List[str] = []
                        tdefs: Dict[str, Dict[str, str]] = {}
                        if isinstance(treats, list):
                            for t in treats:
                                if isinstance(t, dict):
                                    tname = str(t.get('name', '')).strip().lower()
                                    if not tname:
                                        continue
                                    tlist.append(tname)
                                    st = str(t.get('start_time', '')).strip()
                                    et = str(t.get('end_time', '')).strip()
                                    # basic HH:MM guard
                                    def _ok(tm: str) -> bool:
                                        if len(tm) not in (4,5):
                                            return False
                                        if ':' not in tm:
                                            return False
                                        hh, mm = tm.split(':', 1)
                                        if not (hh.isdigit() and mm.isdigit()):
                                            return False
                                        h = int(hh); m = int(mm)
                                        return 0 <= h <= 23 and 0 <= m <= 59
                                    d: Dict[str, str] = {}
                                    if _ok(st): d['start_time'] = st
                                    if _ok(et): d['end_time'] = et
                                    if d:
                                        tdefs[tname] = d
                                else:
                                    s = str(t).strip().lower()
                                    if s:
                                        tlist.append(s)
                        # de-dupe while preserving order
                        seen = set()
                        tlist = [x for x in tlist if not (x in seen or seen.add(x))]
                        exps_out[exp_key] = tlist
                        if tdefs:
                            def_times[exp_key] = tdefs
                out[str(fname).strip().lower()] = {
                    'source_dir': source_dir,
                    'cameras': cams,
                    'experiments': exps_out,
                    'treatment_defaults': def_times,
                    'path_time_regex': str(fcfg.get('path_time_regex', '')).strip() if isinstance(fcfg, dict) else '',
                    'camera_glob': str(fcfg.get('camera_glob', '')).strip() if isinstance(fcfg, dict) else '',
                    'roi_sets': fcfg.get('roi_sets', []) if isinstance(fcfg, dict) else [],
                }
            except Exception:
                continue
    return out


def cfg_importer_working_dir() -> Path:
    base = CONFIG.get('importer', {}).get('working_dir', './working')
    try:
        p = Path(base).expanduser().resolve()
    except Exception:
        p = Path('./working').resolve()
    return p


def cfg_importer_source_exts() -> List[str]:
    raw = CONFIG.get('importer', {}).get('source_extensions', ['.mp4'])
    out: List[str] = []
    if isinstance(raw, list):
        for e in raw:
            try:
                s = str(e).strip().lower()
                if not s:
                    continue
                if not s.startswith('.'):
                    s = '.' + s
                out.append(s)
            except Exception:
                pass
    return out or ['.mp4']


@app.context_processor
def inject_public_config():
    return {
        'public_config': {
            'annotator': {
                'default_animals': cfg_default_animals(),
                'default_fps': cfg_default_fps(),
                'default_types': cfg_default_types(),
                'keyboard': cfg_keyboard(),
                'autosave': bool(CONFIG.get('annotator', {}).get('autosave', False)),
            },
            'browser': {
                'preview_thumbnails': cfg_preview_thumbnails(),
                'visible_extensions': cfg_browser_visible_extensions(),
            },
            'importer': {
                'facilities': cfg_importer_facilities(),
            },
        }
    }


def list_dir_contents(directory: Path, query: str | None = None) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    if not directory.exists() or not directory.is_dir():
        return items

    q = (query or "").strip()
    q_lower = q.lower()
    allowed_exts = set(cfg_browser_visible_extensions())

    for entry in sorted(directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        # Skip hidden files by default
        if entry.name.startswith('.'):
            continue

        name_lower = entry.name.lower()
        if q:
            # Simple contains match; users can type partial names
            if q_lower not in name_lower:
                continue

        # Filter files by configured extensions; keep directories for navigation
        if entry.is_file():
            if entry.suffix.lower() not in allowed_exts:
                continue

        stat = entry.stat()
        items.append(
            {
                "name": entry.name,
                "path": str(entry.resolve()),
                "is_dir": entry.is_dir(),
                "size": stat.st_size,
                "modified": stat.st_mtime,
                "ext": entry.suffix.lower(),
            }
        )
    return items


def file_info(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {"error": "File not found"}
    stat = path.stat()
    mime, _ = mimetypes.guess_type(str(path))
    return {
        "name": path.name,
        "path": str(path.resolve()),
        "parent": str(path.parent.resolve()),
        "is_dir": path.is_dir(),
        "size": stat.st_size,
        "modified": stat.st_mtime,
        "mime": mime or "application/octet-stream",
        "ext": path.suffix.lower(),
    }


@app.route('/')
def home():
    return render_template('browser.html', active_tab='browser')


@app.route('/browser')
def browser():
    return render_template('browser.html', active_tab='browser')


@app.route('/preproc')
def preproc():
    video = request.args.get('video')
    return render_template('preproc.html', active_tab='preproc', video=video)


# ----- Preproc sidecars (arena/background) -----
def _arena_path_for(video_path: Path) -> Path:
    return video_path.with_suffix('.arena.json')


def _background_path_for(video_path: Path) -> Path:
    return video_path.with_suffix('.background.png')


def _preproc_state_path_for(video_path: Path) -> Path:
    return video_path.with_suffix('.preproc.json')


@app.route('/api/preproc/state')
def api_preproc_state():
    video = request.args.get('video', '').strip()
    if not video:
        return jsonify({'error': 'No video path provided'}), 400
    vpath = Path(video).expanduser()
    if not vpath.exists() or not vpath.is_file():
        return jsonify({'error': 'Video file not found'}), 404
    # Prefer combined preproc state if present
    s_path = _preproc_state_path_for(vpath)
    arena = None
    bg = None
    if s_path.exists():
        try:
            st = json.loads(s_path.read_text(encoding='utf-8'))
            arena = st.get('arena')
            bg = st.get('background')
            regions = st.get('regions')
        except Exception:
            arena = None; bg = None; regions = None
    if arena is None:
        a_path = _arena_path_for(vpath)
        if a_path.exists():
            try:
                arena = json.loads(a_path.read_text(encoding='utf-8'))
            except Exception:
                arena = None
    if bg is None:
        b_path = _background_path_for(vpath)
        if b_path.exists():
            bg = str(b_path)
    return jsonify({'ok': True, 'arena': arena, 'background': bg, 'regions': regions if 'regions' in locals() else None})


@app.route('/api/preproc/arena', methods=['POST'])
def api_preproc_arena():
    payload = request.json or {}
    video = str(payload.get('video', '')).strip()
    arena = payload.get('arena')
    if not video or not isinstance(arena, dict):
        return jsonify({'error': 'Missing video or arena'}), 400
    vpath = Path(video).expanduser()
    if not vpath.exists() or not vpath.is_file():
        return jsonify({'error': 'Video file not found'}), 404
    # Minimal validation
    tl = arena.get('tl') or {}
    br = arena.get('br') or {}
    for k in ('x', 'y'):
        if k not in tl or k not in br:
            return jsonify({'error': 'Invalid arena coordinates'}), 400
    try:
        apath = _arena_path_for(vpath)
        apath.parent.mkdir(parents=True, exist_ok=True)
        apath.write_text(json.dumps(arena, ensure_ascii=False, indent=2), encoding='utf-8')
        # Update combined state
        s_path = _preproc_state_path_for(vpath)
        try:
            st = json.loads(s_path.read_text(encoding='utf-8')) if s_path.exists() else {}
        except Exception:
            st = {}
        st['arena'] = arena
        s_path.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding='utf-8')
        return jsonify({'ok': True, 'path': str(apath), 'state': str(s_path)})
    except Exception as e:
        return jsonify({'error': f'Failed to save arena: {e}'}), 500


@app.route('/api/preproc/background', methods=['POST'])
def api_preproc_background():
    payload = request.json or {}
    video = str(payload.get('video', '')).strip()
    image_data = payload.get('image')
    if not video or not image_data:
        return jsonify({'error': 'Missing video or image'}), 400
    vpath = Path(video).expanduser()
    if not vpath.exists() or not vpath.is_file():
        return jsonify({'error': 'Video file not found'}), 404
    # Expect data URL: data:image/png;base64,....
    try:
        prefix = 'base64,'
        idx = image_data.find(prefix)
        if idx >= 0:
            b64 = image_data[idx+len(prefix):]
        else:
            b64 = image_data
        import base64
        raw = base64.b64decode(b64)
        bpath = _background_path_for(vpath)
        bpath.parent.mkdir(parents=True, exist_ok=True)
        with bpath.open('wb') as f:
            f.write(raw)
        # Update combined state
        s_path = _preproc_state_path_for(vpath)
        try:
            st = json.loads(s_path.read_text(encoding='utf-8')) if s_path.exists() else {}
        except Exception:
            st = {}
        st['background'] = str(bpath)
        s_path.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding='utf-8')
        return jsonify({'ok': True, 'path': str(bpath), 'state': str(s_path)})
    except Exception as e:
        return jsonify({'error': f'Failed to save background: {e}'}), 500


@app.route('/api/preproc/regions', methods=['POST'])
def api_preproc_regions():
    payload = request.json or {}
    video = str(payload.get('video', '')).strip()
    regions = payload.get('regions')
    if not video or not isinstance(regions, dict):
        return jsonify({'error': 'Missing video or regions'}), 400
    vpath = Path(video).expanduser()
    if not vpath.exists() or not vpath.is_file():
        return jsonify({'error': 'Video file not found'}), 404
    s_path = _preproc_state_path_for(vpath)
    try:
        st = json.loads(s_path.read_text(encoding='utf-8')) if s_path.exists() else {}
    except Exception:
        st = {}
    st['regions'] = regions
    try:
        s_path.parent.mkdir(parents=True, exist_ok=True)
        s_path.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding='utf-8')
        return jsonify({'ok': True, 'state': str(s_path)})
    except Exception as e:
        return jsonify({'error': f'Failed to save regions: {e}'}), 500


@app.route('/api/preproc/setup/save', methods=['POST'])
def api_preproc_setup_save():
    payload = request.json or {}
    facility = str(payload.get('facility', '')).strip()
    setup_name = str(payload.get('setup_name', '')).strip()
    preproc = payload.get('preproc') or {}
    items = payload.get('items') or []
    if not facility or not setup_name:
        return jsonify({'error': 'Missing facility or setup_name'}), 400
    facilities = CONFIG.get('importer', {}).get('facilities', {})
    if facility not in facilities:
        return jsonify({'error': 'Unknown facility'}), 404
    # Build setup structure
    def _to_int(x, default=None):
        try:
            return int(x)
        except Exception:
            return default
    setup_obj: Dict[str, Any] = {
        'name': setup_name,
        'preproc': {
            'arena_width_cm': _to_int(preproc.get('arena_width_cm')),
            'arena_height_cm': _to_int(preproc.get('arena_height_cm')),
            'grid_cols': _to_int(preproc.get('grid_cols')),
            'grid_rows': _to_int(preproc.get('grid_rows')),
            'bg_frames': _to_int(preproc.get('bg_frames')),
            'bg_quantile': _to_int(preproc.get('bg_quantile')),
        },
        'items': [],
    }
    for it in items:
        if not isinstance(it, dict):
            continue
        name = str(it.get('name', '')).strip()
        if not name:
            continue
        enabled = bool(it.get('enabled', False))
        sheltered = bool(it.get('sheltered', False))
        cells_raw = it.get('cells') or []
        cells_out: List[List[int]] = []
        if isinstance(cells_raw, list):
            for c in cells_raw:
                try:
                    if isinstance(c, (list, tuple)) and len(c) >= 2:
                        r = int(c[0]); c2 = int(c[1])
                    elif isinstance(c, dict) and 'r' in c and 'c' in c:
                        r = int(c.get('r')); c2 = int(c.get('c'))
                    else:
                        continue
                    cells_out.append([r, c2])
                except Exception:
                    continue
        setup_obj['items'].append({'name': name, 'enabled': enabled, 'sheltered': sheltered, 'cells': cells_out})

    # Insert or replace setup in CONFIG
    roi_sets = facilities[facility].setdefault('roi_sets', [])
    replaced = False
    for i, s in enumerate(roi_sets):
        if isinstance(s, dict) and str(s.get('name', '')).strip() == setup_name:
            roi_sets[i] = setup_obj
            replaced = True
            break
    if not replaced:
        roi_sets.append(setup_obj)

    # Persist CONFIG to disk
    try:
        path = _config_path()
        path.write_text(json.dumps(CONFIG, ensure_ascii=False, indent=2), encoding='utf-8')
    except Exception as e:
        return jsonify({'error': f'Failed to write config: {e}'}), 500
    return jsonify({'ok': True, 'facility': facility, 'setup': setup_name, 'path': str(_config_path())})


@app.route('/annotator')
def annotator():
    video = request.args.get('video')
    return render_template(
        'annotator.html',
        active_tab='annotator',
        video=video,
        default_mice=cfg_default_animals(),
        default_fps=cfg_default_fps(),
        default_types=cfg_default_types(),
        keyboard=cfg_keyboard(),
    )


def _annotation_path_for(video_path: Path) -> Path:
    # Save JSON next to the video with same basename and .json extension
    # e.g., session1.mp4 -> session1.json
    return video_path.with_suffix('.json')


@app.route('/api/annotations', methods=['GET', 'POST'])
def api_annotations():
    video = request.args.get('video') if request.method == 'GET' else (request.json or {}).get('video')
    if not video:
        return jsonify({"error": "No video path provided"}), 400
    vpath = Path(video).expanduser()
    if not vpath.exists() or not vpath.is_file():
        return jsonify({"error": "Video file not found"}), 404
    apath = _annotation_path_for(vpath)

    if request.method == 'GET':
        if apath.exists() and apath.is_file():
            try:
                with apath.open('r', encoding='utf-8') as f:
                    data = json.load(f)
                return jsonify({"ok": True, "data": data, "path": str(apath)})
            except Exception as e:
                return jsonify({"error": f"Failed to read annotations: {e}"}), 500
        else:
            return jsonify({"ok": True, "data": None, "path": str(apath)}), 200

    # POST: save
    payload = request.json or {}
    data = payload.get('data')
    if data is None:
        return jsonify({"error": "Missing data"}), 400
    try:
        apath.parent.mkdir(parents=True, exist_ok=True)
        with apath.open('w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return jsonify({"ok": True, "path": str(apath)})
    except Exception as e:
        return jsonify({"error": f"Failed to save: {e}"}), 500


@app.route('/importer')
def importer():
    facilities = cfg_importer_facilities()
    return render_template('importer.html', active_tab='importer', facilities=facilities)


def _ffmpeg_exists() -> bool:
    return shutil.which('ffmpeg') is not None


def _safe_time_str(s: str) -> Optional[str]:
    try:
        s = str(s).strip()
        hh, mm = s.split(':', 1)
        h = int(hh); m = int(mm)
        if 0 <= h <= 23 and 0 <= m <= 59:
            return f"{h:02d}:{m:02d}"
    except Exception:
        pass
    return None


def _combine_date_time(date_str: str, time_str: str) -> Optional[datetime]:
    try:
        ds = str(date_str).strip()
        ts = _safe_time_str(time_str)
        if not ds or not ts:
            return None
        return datetime.strptime(ds + ' ' + ts, '%Y-%m-%d %H:%M')
    except Exception:
        return None


def _day_windows(start_date: str, end_date: str, start_time: str, end_time: str) -> List[Dict[str, datetime]]:
    """Build daily windows. If end_time <= start_time, window crosses midnight."""
    start_dt = _combine_date_time(start_date, start_time)
    end_dt_ref = _combine_date_time(end_date, start_time)  # reference for number of days
    if not start_dt or not end_dt_ref:
        return []
    days = (end_dt_ref.date() - start_dt.date()).days + 1
    windows: List[Dict[str, datetime]] = []
    st_hhmm = _safe_time_str(start_time) or '00:00'
    et_hhmm = _safe_time_str(end_time) or st_hhmm
    sh, sm = map(int, st_hhmm.split(':'))
    eh, em = map(int, et_hhmm.split(':'))
    for i in range(max(1, days)):
        base = datetime(start_dt.year, start_dt.month, start_dt.day, sh, sm) + timedelta(days=i)
        end_base = datetime(base.year, base.month, base.day, eh, em)
        if end_base <= base:
            end_base = end_base + timedelta(days=1)
        windows.append({'start': base, 'end': end_base})
    return windows


def _format_cam_glob(pattern: str, cam_idx: int) -> str:
    try:
        if '{cam:02d}' in pattern:
            pattern = pattern.replace('{cam:02d}', f'{cam_idx:02d}')
        return pattern.replace('{cam}', str(cam_idx))
    except Exception:
        return pattern


def _iter_files_for_camera(source_dir: Path, cam_idx: int, exts: List[str], camera_glob: str | None = None) -> List[Path]:
    """Find files for a camera.
    Prefer facility-specific glob pattern with {cam} or {cam:02d}; fallback to name contains 'camNN'.
    """
    res: List[Path] = []
    try:
        if camera_glob:
            pat = _format_cam_glob(camera_glob, cam_idx)
            for p in source_dir.rglob(pat):
                if p.is_file() and p.suffix.lower() in exts:
                    res.append(p)
        else:
            tag = f"cam{cam_idx:02d}"
            for p in source_dir.rglob('*'):
                if not p.is_file():
                    continue
                if p.suffix.lower() not in exts:
                    continue
                if tag in p.name.lower():
                    res.append(p)
    except Exception:
        pass
    return res


def _file_time_range(path: Path) -> Optional[tuple[float, float]]:
    """Estimate (start_ts, end_ts) epoch seconds for a file.
    Uses optional regex-configured timestamp in the path if available; 
    otherwise falls back to mtime-duration heuristic.
    """
    meta = probe_media(path)
    if not meta.get('available') or meta.get('error'):
        return None
    dur = meta.get('duration')
    if not isinstance(dur, (int, float)) or dur <= 0:
        return None
    try:
        end_ts = path.stat().st_mtime
        start_ts = end_ts - float(dur)
        return (start_ts, end_ts)
    except Exception:
        return None


def _overlaps(a_start: float, a_end: float, b_start: float, b_end: float) -> bool:
    return (a_start < b_end) and (b_start < a_end)


def _ensure_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def _write_concat_list(list_path: Path, items: List[Dict[str, Any]]) -> None:
    with list_path.open('w', encoding='utf-8') as f:
        for it in items:
            fn = it['path']
            # Quote path for concat demuxer; escape single quotes
            q = "'" + str(fn).replace("'", "'\\''") + "'"
            f.write(f"file {q}\n")
            if it.get('inpoint') is not None:
                f.write(f"inpoint {it['inpoint']:.3f}\n")
            if it.get('outpoint') is not None:
                f.write(f"outpoint {it['outpoint']:.3f}\n")


def _run_ffmpeg_concat(list_file: Path, out_path: Path) -> tuple[int, str]:
    cmd = [
        'ffmpeg', '-v', 'quiet', '-stats', '-y', '-threads', '4',
        '-f', 'concat', '-safe', '0', '-i', str(list_file),
        '-vcodec', 'copy', '-an', '-copytb', '0', str(out_path)
    ]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True)
        return (p.returncode, p.stderr or p.stdout)
    except Exception as e:
        return (1, str(e))


JOBS: Dict[str, Dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()


def _parse_time_from_path(p: Path, regex: str) -> Optional[datetime]:
    if not regex:
        return None
    try:
        m = re.search(regex, p.as_posix())
        if not m:
            return None
        gd = m.groupdict()
        y = int(gd.get('year')) if gd.get('year') else None
        mo = int(gd.get('month')) if gd.get('month') else 1
        d = int(gd.get('day')) if gd.get('day') else 1
        hh = int(gd.get('hour')) if gd.get('hour') else 0
        mm = int(gd.get('minute')) if gd.get('minute') else 0
        ss = int(gd.get('second')) if gd.get('second') else 0
        if not y:
            return None
        return datetime(y, mo, d, hh, mm, ss)
    except Exception:
        return None


def _file_time_range_with_regex(path: Path, regex: str) -> Optional[tuple[float, float]]:
    meta = probe_media(path)
    if not meta.get('available') or meta.get('error'):
        return None
    dur = meta.get('duration')
    if not isinstance(dur, (int, float)) or dur <= 0:
        return None
    ts = _parse_time_from_path(path, regex)
    if not ts:
        return None
    start_ts = ts.timestamp()
    end_ts = start_ts + float(dur)
    return (start_ts, end_ts)


def _run_import_job(job_id: str, plan: Dict[str, Any]):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        job['status'] = 'RUNNING'
    # iterate and execute
    total = sum(len(c['days']) for c in plan['jobs'])
    completed = 0
    for cam_entry in plan['jobs']:
        for day in cam_entry['days']:
            if day.get('segments', 0) <= 0:
                day['status'] = 'EMPTY'
                completed += 1
                with JOBS_LOCK:
                    JOBS[job_id]['progress'] = completed
                continue
            list_path = Path(day['concat_list'])
            out_path = Path(day['output'])
            day['status'] = 'RUNNING'
            with JOBS_LOCK:
                JOBS[job_id]['progress'] = completed
            code, msg = _run_ffmpeg_concat(list_path, out_path)
            day['status'] = 'DONE' if code == 0 else 'FAIL'
            day['message'] = msg
            completed += 1
            with JOBS_LOCK:
                JOBS[job_id]['progress'] = completed
    with JOBS_LOCK:
        JOBS[job_id]['status'] = 'DONE'


@app.route('/api/import/start', methods=['POST'])
def api_import_start():
    payload = request.json or {}
    facility = str(payload.get('facility', '')).strip().lower()
    exp_name = str(payload.get('experiment', '')).strip().upper()
    treatment = str(payload.get('treatment', '')).strip().lower()
    start_date = str(payload.get('start_date', '')).strip()
    end_date = str(payload.get('end_date', '')).strip()
    start_time = str(payload.get('start_time', '')).strip()
    end_time = str(payload.get('end_time', '')).strip()
    cameras = payload.get('cameras', []) or []
    regex_override = str(payload.get('path_time_regex', '') or '').strip()
    camera_glob_override = str(payload.get('camera_glob', '') or '').strip()
    dry_run = bool(payload.get('dry_run', False))

    facs = cfg_importer_facilities()
    if facility not in facs:
        return jsonify({'error': 'Unknown facility'}), 400
    if not exp_name or not treatment:
        return jsonify({'error': 'Missing experiment or treatment'}), 400
    windows = _day_windows(start_date, end_date, start_time, end_time)
    if not windows:
        return jsonify({'error': 'Invalid date/time range'}), 400
    try:
        cams = sorted({int(c) for c in cameras})
    except Exception:
        return jsonify({'error': 'Invalid cameras'}), 400
    if not cams:
        return jsonify({'error': 'No cameras selected'}), 400

    fac = facs[facility]
    source_dir = Path(fac.get('source_dir', '')).expanduser()
    if not source_dir.exists():
        return jsonify({'error': 'Source folder not found', 'path': str(source_dir)}), 400
    work_base = cfg_importer_working_dir().joinpath(exp_name, treatment)
    _ensure_dir(work_base)

    exts = cfg_importer_source_exts()

    jobs: List[Dict[str, Any]] = []
    ptre = regex_override or fac.get('path_time_regex', '')
    batch = int(payload.get('batch', 1))
    if batch < 0:
        batch = 0
    for cam in cams:
        # Find candidate files for camera
        files = _iter_files_for_camera(source_dir, cam, exts, camera_glob_override or fac.get('camera_glob', ''))
        # Precompute time ranges
        timeline: List[Dict[str, Any]] = []
        for f in files:
            tr = _file_time_range_with_regex(f, ptre) or _file_time_range(f)
            if not tr:
                continue
            timeline.append({'path': f, 'start': tr[0], 'end': tr[1]})
        if not timeline:
            jobs.append({'camera': cam, 'days': [], 'warning': 'No files found'})
            continue
        # Sort by start time
        timeline.sort(key=lambda x: x['start'])

        day_entries: List[Dict[str, Any]] = []
        for di, win in enumerate(windows, start=1):
            ws = win['start'].timestamp()
            we = win['end'].timestamp()
            # Select overlapping segments
            segs = [s for s in timeline if _overlaps(s['start'], s['end'], ws, we)]
            items: List[Dict[str, Any]] = []
            if segs:
                # Build concat list items with in/out points
                for s in segs:
                    inpoint = max(0.0, ws - s['start'])
                    outpoint = None
                    if s['end'] > we:
                        outpoint = max(0.0, we - s['start'])
                    items.append({'path': str(s['path']).replace('\\', '/'), 'inpoint': inpoint, 'outpoint': outpoint})
            out_name = f"{exp_name}-{treatment}.exp{batch:04d}.day{di:02d}.cam{cam:02d}{exts[0]}"
            out_path = work_base.joinpath(out_name)
            list_path = work_base.joinpath(f"{exp_name}-{treatment}.day{di:02d}.cam{cam:02d}.src")
            if items:
                try:
                    _write_concat_list(list_path, items)
                except Exception as e:
                    return jsonify({'error': f'Failed to write list: {e}', 'path': str(list_path)}), 500
                if not dry_run and _ffmpeg_exists():
                    code, msg = _run_ffmpeg_concat(list_path, out_path)
                    status = 'DONE' if code == 0 else 'FAIL'
                else:
                    status = 'PLANNED' if items else 'SKIPPED'
                    msg = 'dry-run or ffmpeg not available'
            else:
                status = 'EMPTY'
                msg = 'No overlapping files for this window'
            day_entries.append({
                'day': di,
                'concat_list': str(list_path),
                'output': str(out_path),
                'segments': len(items),
                'status': status,
                'message': msg,
            })
        jobs.append({'camera': cam, 'days': day_entries})

    # Build initial plan response
    plan = {
        'ok': True,
        'working_dir': str(work_base),
        'ffmpeg': _ffmpeg_exists(),
        'jobs': jobs,
    }
    # Async execution if requested and ffmpeg available
    async_mode = bool(payload.get('async', True)) and _ffmpeg_exists() and not dry_run
    if async_mode:
        job_id = uuid.uuid4().hex
        with JOBS_LOCK:
            JOBS[job_id] = {
                'id': job_id,
                'status': 'QUEUED',
                'progress': 0,
                'total': sum(len(c['days']) for c in jobs),
                'plan': plan,
            }
        t = threading.Thread(target=_run_import_job, args=(job_id, plan), daemon=True)
        t.start()
        return jsonify({'ok': True, 'job_id': job_id, **plan})
    else:
        # Synchronous (already executed above if not dry-run)
        return jsonify(plan)


@app.route('/api/import/status')
def api_import_status():
    job_id = request.args.get('job', '').strip()
    if not job_id:
        return jsonify({'error': 'Missing job id'}), 400
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return jsonify({'error': 'Job not found'}), 404
        return jsonify({'ok': True, **job})


@app.route('/api/import/test_regex', methods=['POST'])
def api_import_test_regex():
    payload = request.json or {}
    regex = str(payload.get('regex', '') or '').strip()
    sample = str(payload.get('sample', '') or '').strip()
    if not regex:
        return jsonify({'error': 'Missing regex'}), 400
    if not sample:
        return jsonify({'error': 'Missing sample path'}), 400
    try:
        ts = _parse_time_from_path(Path(sample), regex)
        if ts:
            return jsonify({'ok': True, 'timestamp': ts.isoformat(), 'year': ts.year, 'month': ts.month, 'day': ts.day, 'hour': ts.hour, 'minute': ts.minute, 'second': ts.second})
        # If no timestamp, at least return matched groups (if any)
        m = re.search(regex, Path(sample).as_posix())
        if m:
            return jsonify({'ok': False, 'message': 'Matched but missing required groups (year)', 'groups': m.groupdict()})
        return jsonify({'ok': False, 'message': 'No match'})
    except re.error as e:
        return jsonify({'error': f'Invalid regex: {e}'}), 400


@app.route('/settings')
def settings():
    return render_template('settings.html', active_tab='settings')


@app.route('/api/list')
def api_list():
    directory = request.args.get('dir', '').strip()
    query = request.args.get('q', '').strip()
    if not directory:
        return jsonify({"items": [], "error": "No directory provided"})
    path = Path(directory).expanduser()
    items = list_dir_contents(path, query)
    return jsonify({"items": items})


@app.route('/api/fileinfo')
def api_fileinfo():
    path = request.args.get('path', '').strip()
    if not path:
        return jsonify({"error": "No path provided"}), 400
    info = file_info(Path(path).expanduser())
    return jsonify(info)


def _ffprobe_exists() -> bool:
    return shutil.which('ffprobe') is not None


def _parse_fraction(fr: Optional[str]) -> Optional[float]:
    if not fr:
        return None
    try:
        if '/' in fr:
            a, b = fr.split('/', 1)
            a = float(a)
            b = float(b)
            return a / b if b else None
        return float(fr)
    except Exception:
        return None


def probe_media(path: Path) -> Dict[str, Any]:
    if not _ffprobe_exists():
        return {"available": False, "error": "ffprobe not found"}
    if not path.exists() or not path.is_file():
        return {"available": True, "error": "File not found"}
    cmd = [
        'ffprobe', '-v', 'error', '-print_format', 'json',
        '-show_format', '-show_streams', str(path)
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if proc.returncode != 0:
            return {"available": True, "error": proc.stderr.strip() or 'ffprobe failed'}
        data = json.loads(proc.stdout or '{}')
    except Exception as e:
        return {"available": True, "error": str(e)}

    fmt = data.get('format', {})
    streams = data.get('streams', [])
    vstreams = [s for s in streams if s.get('codec_type') == 'video']
    astreams = [s for s in streams if s.get('codec_type') == 'audio']
    v = vstreams[0] if vstreams else {}

    duration = None
    for key in ('duration',):
        if fmt.get(key):
            try:
                duration = float(fmt.get(key))
                break
            except Exception:
                pass
    if duration is None and v.get('duration'):
        try:
            duration = float(v.get('duration'))
        except Exception:
            duration = None

    fps = _parse_fraction(v.get('avg_frame_rate') or v.get('r_frame_rate'))
    bit_rate = None
    # Prefer overall format bitrate; fallback to video stream
    for src in (fmt, v):
        br = src.get('bit_rate')
        if br:
            try:
                bit_rate = int(br)
                break
            except Exception:
                pass

    info = {
        "available": True,
        "container": fmt.get('format_name'),
        "duration": duration,
        "bit_rate": bit_rate,  # bits per second
        "streams": {
            "video": {
                "codec": v.get('codec_name'),
                "profile": v.get('profile'),
                "width": v.get('width'),
                "height": v.get('height'),
                "fps": fps,
                "pix_fmt": v.get('pix_fmt'),
            },
            "audio": {
                "count": len(astreams),
                "codecs": list({s.get('codec_name') for s in astreams if s.get('codec_name')})
            }
        }
    }
    return info


@app.route('/api/media_meta')
def api_media_meta():
    path = request.args.get('path', '').strip()
    if not path:
        return jsonify({"error": "No path provided"}), 400
    meta = probe_media(Path(path).expanduser())
    return jsonify(meta)


@app.route('/media')
def media():
    """Stream local media files with partial content support for video preview.
    Note: This serves files given by absolute path; intended for local usage.
    """
    path_str = request.args.get('path', '').strip()
    if not path_str:
        return jsonify({"error": "No path provided"}), 400

    path = Path(path_str).expanduser()
    if not path.exists() or not path.is_file():
        return jsonify({"error": "File not found"}), 404

    file_size = path.stat().st_size
    mime, _ = mimetypes.guess_type(str(path))
    range_header = request.headers.get('Range', None)

    def _range_not_satisfiable():
        rv = Response(status=416)
        rv.headers.add('Content-Range', f'bytes */{file_size}')
        rv.headers.add('Accept-Ranges', 'bytes')
        return rv

    if range_header:
        # Example: Range: bytes=START-END (single range only)
        try:
            units, rng = range_header.split('=', 1)
            if units.strip() != 'bytes':
                return _range_not_satisfiable()
            if ',' in rng:
                # Multiple ranges not supported
                return _range_not_satisfiable()
            start_str, end_str = (rng.split('-', 1) + [''])[:2]
            start = int(start_str) if start_str else 0
            end = int(end_str) if end_str else file_size - 1
            if start < 0 or end < start:
                return _range_not_satisfiable()
            start = max(0, min(start, file_size - 1))
            end = max(start, min(end, file_size - 1))
            length = (end - start + 1)

            def generate():
                chunk_size = 8192
                with path.open('rb') as f:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        data = f.read(min(chunk_size, remaining))
                        if not data:
                            break
                        remaining -= len(data)
                        yield data

            rv = Response(generate(), 206, mimetype=mime or 'application/octet-stream')
            rv.headers.add('Content-Range', f'bytes {start}-{end}/{file_size}')
            rv.headers.add('Accept-Ranges', 'bytes')
            rv.headers.add('Content-Length', str(length))
            return rv
        except Exception:
            return _range_not_satisfiable()

    # No Range header: send full file
    rv = send_file(str(path), mimetype=mime or 'application/octet-stream', conditional=True)
    rv.headers.add('Accept-Ranges', 'bytes')
    return rv


def _next_batch_number(exp: str, trt: str) -> int:
    base = cfg_importer_working_dir().joinpath(str(exp).upper(), str(trt).lower())
    if not base.exists() or not base.is_dir():
        return 1
    pat = re.compile(r"\.exp(\d{4})", re.IGNORECASE)
    mx = 0
    try:
        for p in base.iterdir():
            m = pat.search(p.name)
            if m:
                try:
                    val = int(m.group(1))
                    if val > mx:
                        mx = val
                except Exception:
                    pass
    except Exception:
        pass
    return (mx + 1) if mx > 0 else 1


@app.route('/api/import/next_batch')
def api_import_next_batch():
    exp = (request.args.get('experiment') or '').strip()
    trt = (request.args.get('treatment') or '').strip()
    if not exp or not trt:
        return jsonify({'error': 'Missing experiment or treatment'}), 400
    nb = _next_batch_number(exp, trt)
    return jsonify({'ok': True, 'next_batch': nb})


def _format_bytes(n: int) -> str:
    step = 1024.0
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if n < step:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= step
    return f"{n:.1f} PB"


@app.template_filter('filesize')
def filesize(n):
    try:
        return _format_bytes(int(n))
    except Exception:
        return str(n)


@app.template_filter('fmt_time')
def fmt_time(ts):
    try:
        return datetime.fromtimestamp(float(ts)).strftime('%Y-%m-%d %H:%M')
    except Exception:
        return str(ts)


if __name__ == '__main__':
    port = int(os.getenv('PORT', '8000'))
    app.run(host='127.0.0.1', port=port, debug=True)
