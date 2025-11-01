from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional


def _config_path() -> Path:
    cfg_path = os.getenv('CHEESEPIE_CONFIG')
    if cfg_path:
        return Path(cfg_path).expanduser()
    return Path(__file__).resolve().parent.parent.joinpath('config.json')


def load_config() -> Dict[str, Any]:
    cfg_path = os.getenv('CHEESEPIE_CONFIG')
    if cfg_path:
        p = Path(cfg_path).expanduser()
        if p.exists():
            try:
                return json.loads(p.read_text(encoding='utf-8'))
            except Exception:
                pass
    # fallback to project-local config.json
    local = Path(__file__).resolve().parent.parent.joinpath('config.json')
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
    raw = CONFIG.get('facilities') or CONFIG.get('importer', {}).get('facilities', {})
    out: Dict[str, Any] = {}
    if isinstance(raw, dict):
        for fname, fcfg in raw.items():
            try:
                if not isinstance(fcfg, dict):
                    continue
                source_dir = str(fcfg.get('source_dir', '')).strip()
                cams = 0
                try:
                    cams = int(fcfg.get('cameras', 0))
                except Exception:
                    cams = 0
                cams = max(0, min(512, cams))
                cam_list_in = fcfg.get('camera_list', [])
                cam_list: List[int] = []
                if isinstance(cam_list_in, list):
                    for c in cam_list_in:
                        try:
                            cam_list.append(int(c))
                        except Exception:
                            continue
                    cam_list = sorted({c for c in cam_list if 0 <= c <= 999})
                if not cam_list and cams > 0:
                    cam_list = list(range(1, cams + 1))
                if cam_list:
                    cams = len(cam_list)
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
                                    def _ok(tm: str) -> bool:
                                        if len(tm) not in (4, 5):
                                            return False
                                        if ':' not in tm:
                                            return False
                                        hh, mm = tm.split(':', 1)
                                        if not (hh.isdigit() and mm.isdigit()):
                                            return False
                                        h = int(hh); m = int(mm)
                                        return 0 <= h <= 23 and 0 <= m <= 59
                                    d: Dict[str, str] = {}
                                    if _ok(st):
                                        d['start_time'] = st
                                    if _ok(et):
                                        d['end_time'] = et
                                    if d:
                                        tdefs[tname] = d
                                else:
                                    s = str(t).strip().lower()
                                    if s:
                                        tlist.append(s)
                        seen = set()
                        tlist = [x for x in tlist if not (x in seen or seen.add(x))]
                        exps_out[exp_key] = tlist
                        if tdefs:
                            def_times[exp_key] = tdefs
                # Support new camera_pattern; keep camera_glob for backward compat
                cam_pat = ''
                try:
                    cam_pat = str(fcfg.get('camera_pattern') or fcfg.get('camera_glob') or '').strip()
                except Exception:
                    cam_pat = ''
                # Build setups for public config; support both dict (new) and list (legacy) without forcing a single shape
                setups_out: Any = None
                try:
                    raw_setups = fcfg.get('setups') if isinstance(fcfg, dict) else None
                    if isinstance(raw_setups, dict):
                        # New shape: pass through as-is
                        setups_out = raw_setups
                    elif isinstance(raw_setups, list):
                        # Legacy list of named setups with preproc/roi_sets
                        setups_list: List[Dict[str, Any]] = []
                        for su in raw_setups:
                            if not isinstance(su, dict):
                                continue
                            sname = str(su.get('name', '')).strip() or 'default'
                            spreproc = su.get('preproc') if isinstance(su.get('preproc'), dict) else {}
                            srois = su.get('roi_sets') if isinstance(su.get('roi_sets'), list) else []
                            setups_list.append({'name': sname, 'preproc': spreproc, 'roi_sets': srois})
                        # keep list (frontend will normalize)
                        setups_out = setups_list
                except Exception:
                    setups_out = None
                # Fallback: if no setups defined but legacy roi_sets exist at facility level
                legacy_roi_sets = fcfg.get('roi_sets', []) if isinstance(fcfg, dict) else []
                if setups_out is None:
                    setups_out = [{
                        'name': 'default',
                        'preproc': {},
                        'roi_sets': legacy_roi_sets if isinstance(legacy_roi_sets, list) else []
                    }]
                out[str(fname).strip().lower()] = {
                    'source_dir': source_dir,
                    'cameras': cams,
                    'experiments': exps_out,
                    'treatment_defaults': def_times,
                    'path_time_regex': str(fcfg.get('path_time_regex', '')).strip() if isinstance(fcfg, dict) else '',
                    'camera_pattern': cam_pat,
                    'camera_list': cam_list,
                    # Keep legacy roi_sets for backward compatibility
                    'roi_sets': legacy_roi_sets if isinstance(legacy_roi_sets, list) else [],
                    # New structure (supports dict or list; frontend normalizes):
                    'setups': setups_out,
                    'ignore_dir_regex': str(fcfg.get('ignore_dir_regex', '')).strip() if isinstance(fcfg, dict) else '',
                    'output_dir': str(fcfg.get('output_dir', '')).strip() if isinstance(fcfg, dict) else '',
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


def cfg_importer_ignore_dir_regex() -> str:
    try:
        s = str(CONFIG.get('importer', {}).get('ignore_dir_regex', '')).strip()
        return s
    except Exception:
        return ''


def cfg_importer_health_tolerance_seconds() -> float:
    try:
        v = CONFIG.get('importer', {}).get('health_tolerance_seconds', 300)
        f = float(v)
        if f < 0:
            f = 0.0
        return f
    except Exception:
        return 300.0


def cfg_browser_required_filename_regex():
    pat = CONFIG.get('browser', {}).get(
        'required_filename_regex',
        r'^([A-Za-z0-9_]+)(?:-[A-Za-z0-9_]+)?\.exp\d{4}\.day\d{2}\.cam\d{2}\.(mp4|avi)$'
    )
    try:
        s = str(pat).strip()
        if not s:
            return None
        return re.compile(s)
    except Exception:
        return None


def inject_public_config():
    colors_cfg = CONFIG.get('colors', {}) if isinstance(CONFIG.get('colors', {}), dict) else {}
    mice = colors_cfg.get('mice', ['R', 'G', 'B', 'Y'])
    if not isinstance(mice, list):
        mice = ['R', 'G', 'B', 'Y']
    mice_out: List[str] = []
    for m in mice[:4]:
        try:
            s = str(m).strip()
            if s:
                mice_out.append(s)
        except Exception:
            continue
    if not mice_out:
        mice_out = ['R', 'G', 'B', 'Y']
    default_palette = {
        'R': '#ff4f4f',
        'G': '#34c759',
        'B': '#4f8cff',
        'Y': '#ffd166',
    }
    pal_cfg = colors_cfg.get('palette', {}) if isinstance(colors_cfg.get('palette', {}), dict) else {}
    palette_out = dict(default_palette)
    for k, v in pal_cfg.items():
        try:
            ks = str(k).strip()
            vs = str(v).strip()
            if ks and vs:
                palette_out[ks] = vs
        except Exception:
            continue
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
            'colors': {
                'mice': mice_out,
                'palette': palette_out,
            }
        }
    }


__all__ = [
    'CONFIG', 'load_config', '_config_path',
    'cfg_default_animals', 'cfg_default_fps', 'cfg_default_types', 'cfg_keyboard',
    'cfg_preview_thumbnails', 'cfg_browser_visible_extensions', 'cfg_browser_required_filename_regex',
    'cfg_importer_facilities', 'cfg_importer_working_dir', 'cfg_importer_source_exts', 'cfg_importer_ignore_dir_regex', 'cfg_importer_health_tolerance_seconds',
    'inject_public_config',
]
