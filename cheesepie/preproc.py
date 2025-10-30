from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from flask import Blueprint, jsonify, request

from .config import CONFIG, _config_path


bp = Blueprint('preproc', __name__)


def _parse_video_name(name: str):
    m = re.match(r'^([A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)?)\.exp(\d{4})\.day(\d{2})\.cam(\d{2})\.(mp4|avi)$', name)
    if not m:
        return None
    return {
        'group': m.group(1),
        'exp': m.group(2),
        'day': m.group(3),
        'cam': m.group(4),
        'ext': m.group(5),
    }


@bp.route('/group')
def api_preproc_group():
    video = request.args.get('video', '').strip()
    if not video:
        return jsonify({'error': 'Missing video'}), 400
    vpath = Path(video).expanduser()
    if not vpath.exists() or not vpath.is_file():
        return jsonify({'error': 'Video not found'}), 404
    parts = _parse_video_name(vpath.name)
    if not parts:
        return jsonify({'error': 'Filename does not match expected pattern'}), 400
    parent = vpath.parent
    items: List[Dict[str, Any]] = []
    for entry in sorted(parent.iterdir()):
        if not entry.is_file():
            continue
        p2 = _parse_video_name(entry.name)
        if not p2:
            continue
        if p2['group'] == parts['group'] and p2['exp'] == parts['exp'] and p2['cam'] == parts['cam'] and p2['ext'] == parts['ext']:
            day = p2['day']
            arena_path = entry.with_suffix('.arena.json')
            preproc_path = entry.with_suffix('.preproc.json')
            bg_path = entry.with_suffix('.background.png')
            items.append({
                'day': day,
                'name': entry.name,
                'path': str(entry.resolve()),
                'has_arena': arena_path.exists(),
                'has_preproc': preproc_path.exists(),
                'has_background': bg_path.exists(),
            })
    try:
        items.sort(key=lambda x: int(x['day']))
    except Exception:
        items.sort(key=lambda x: x['day'])
    group_key = f"{parts['group']}.exp{parts['exp']}.cam{parts['cam']}.{parts['ext']}"
    return jsonify({'ok': True, 'group': group_key, 'items': items, 'active': str(vpath.resolve())})


@bp.route('/apply_settings', methods=['POST'])
def api_preproc_apply_settings():
    payload = request.json or {}
    src = str(payload.get('from', '')).strip()
    targets = payload.get('to') or []
    if not src or not isinstance(targets, list) or not targets:
        return jsonify({'error': 'Missing from/to'}), 400
    spath = Path(src).expanduser()
    if not spath.exists() or not spath.is_file():
        return jsonify({'error': 'Source video not found'}), 404
    src_arena = None
    src_regions = None
    src_colors = None
    preproc_src = spath.with_suffix('.preproc.json')
    if preproc_src.exists():
        try:
            st = json.loads(preproc_src.read_text(encoding='utf-8'))
            src_arena = st.get('arena')
            src_regions = st.get('regions')
            src_colors = st.get('colors')
        except Exception:
            pass
    if src_arena is None:
        a_path = spath.with_suffix('.arena.json')
        if a_path.exists():
            try:
                src_arena = json.loads(a_path.read_text(encoding='utf-8'))
            except Exception:
                pass
    if src_arena is None and src_regions is None and src_colors is None:
        return jsonify({'error': 'No source arena/regions found'}), 400

    results = []
    for t in targets:
        try:
            tpath = Path(str(t)).expanduser()
            if not tpath.exists() or not tpath.is_file():
                results.append({'path': str(t), 'ok': False, 'error': 'Target not found'})
                continue
            tp = tpath.with_suffix('.preproc.json')
            try:
                dst = json.loads(tp.read_text(encoding='utf-8')) if tp.exists() else {}
            except Exception:
                dst = {}
            if src_arena is not None:
                dst['arena'] = src_arena
            if src_regions is not None:
                dst['regions'] = src_regions
            if src_colors is not None:
                dst['colors'] = src_colors
            tp.write_text(json.dumps(dst, ensure_ascii=False, indent=2), encoding='utf-8')
            if src_arena is not None:
                tpath.with_suffix('.arena.json').write_text(json.dumps(src_arena, ensure_ascii=False, indent=2), encoding='utf-8')
            results.append({'path': str(tpath), 'ok': True})
        except Exception as e:
            results.append({'path': str(t), 'ok': False, 'error': str(e)})
    return jsonify({'ok': True, 'results': results})


def _arena_path_for(video_path: Path) -> Path:
    return video_path.with_suffix('.arena.json')


def _background_path_for(video_path: Path) -> Path:
    return video_path.with_suffix('.background.png')


def _preproc_state_path_for(video_path: Path) -> Path:
    return video_path.with_suffix('.preproc.json')


@bp.route('/state')
def api_preproc_state():
    video = request.args.get('video', '').strip()
    if not video:
        return jsonify({'error': 'No video path provided'}), 400
    vpath = Path(video).expanduser()
    if not vpath.exists() or not vpath.is_file():
        return jsonify({'error': 'Video file not found'}), 404
    s_path = _preproc_state_path_for(vpath)
    arena = None
    bg = None
    colors = None
    if s_path.exists():
        try:
            st = json.loads(s_path.read_text(encoding='utf-8'))
            arena = st.get('arena')
            bg = st.get('background')
            regions = st.get('regions')
            colors = st.get('colors')
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
    return jsonify({'ok': True, 'arena': arena, 'background': bg, 'regions': regions if 'regions' in locals() else None, 'colors': colors})


@bp.route('/save_multi', methods=['POST'])
def api_preproc_save_multi():
    payload = request.json or {}
    targets = payload.get('targets') or []
    preproc = payload.get('preproc') or {}
    if not isinstance(targets, list) or not targets:
        return jsonify({'error': 'Missing targets'}), 400
    arena = preproc.get('arena')
    regions = preproc.get('regions')
    colors = preproc.get('colors')
    if not isinstance(arena, dict) or not isinstance(arena.get('tl'), dict) or not isinstance(arena.get('br'), dict):
        return jsonify({'error': 'Arena not marked'}), 400
    if not isinstance(regions, dict) or 'items' not in regions or not isinstance(regions['items'], list):
        return jsonify({'error': 'Regions not marked'}), 400
    if not isinstance(colors, dict):
        return jsonify({'error': 'Colors not marked'}), 400
    marks = colors.get('marks') or []
    mice = colors.get('mice') or []
    if not isinstance(marks, list) or not marks:
        return jsonify({'error': 'Colors not marked'}), 400
    if isinstance(mice, list) and mice:
        have_per_mouse = {i+1: False for i in range(len(mice))}
        for m in marks:
            try:
                mm = int(m.get('mouse'))
                if mm in have_per_mouse:
                    have_per_mouse[mm] = True
            except Exception:
                pass
        if not all(have_per_mouse.values()):
            return jsonify({'error': 'Colors must include at least one mark per mouse'}), 400

    results = []
    for t in targets:
        try:
            tpath = Path(str(t)).expanduser()
            if not tpath.exists() or not tpath.is_file():
                results.append({'path': str(t), 'ok': False, 'error': 'Target not found'})
                continue
            s_path = _preproc_state_path_for(tpath)
            try:
                st = json.loads(s_path.read_text(encoding='utf-8')) if s_path.exists() else {}
            except Exception:
                st = {}
            st['arena'] = arena
            st['regions'] = regions
            st['colors'] = colors
            s_path.parent.mkdir(parents=True, exist_ok=True)
            s_path.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding='utf-8')
            if arena is not None:
                tpath.with_suffix('.arena.json').write_text(json.dumps(arena, ensure_ascii=False, indent=2), encoding='utf-8')
            results.append({'path': str(tpath), 'ok': True})
        except Exception as e:
            results.append({'path': str(t), 'ok': False, 'error': str(e)})
    return jsonify({'ok': True, 'results': results})


@bp.route('/arena', methods=['POST'])
def api_preproc_arena():
    payload = request.json or {}
    video = str(payload.get('video', '')).strip()
    arena = payload.get('arena')
    if not video or not isinstance(arena, dict):
        return jsonify({'error': 'Missing video or arena'}), 400
    vpath = Path(video).expanduser()
    if not vpath.exists() or not vpath.is_file():
        return jsonify({'error': 'Video file not found'}), 404
    s_path = _preproc_state_path_for(vpath)
    try:
        st = json.loads(s_path.read_text(encoding='utf-8')) if s_path.exists() else {}
    except Exception:
        st = {}
    st['arena'] = arena
    try:
        s_path.parent.mkdir(parents=True, exist_ok=True)
        s_path.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding='utf-8')
        vpath.with_suffix('.arena.json').write_text(json.dumps(arena, ensure_ascii=False, indent=2), encoding='utf-8')
        return jsonify({'ok': True, 'state': str(s_path)})
    except Exception as e:
        return jsonify({'error': f'Failed to save arena: {e}'}), 500


@bp.route('/background', methods=['POST'])
def api_preproc_background():
    payload = request.json or {}
    video = str(payload.get('video', '')).strip()
    image = payload.get('image')
    if not video or not image:
        return jsonify({'error': 'Missing video or background'}), 400
    vpath = Path(video).expanduser()
    if not vpath.exists() or not vpath.is_file():
        return jsonify({'error': 'Video file not found'}), 404
    try:
        import base64
        idx = image.find('base64,') if isinstance(image, str) else -1
        b64 = image[idx+7:] if idx >= 0 else image
        raw = base64.b64decode(b64)
        bpath = _background_path_for(vpath)
        bpath.write_bytes(raw)
        s_path = _preproc_state_path_for(vpath)
        try:
            st = json.loads(s_path.read_text(encoding='utf-8')) if s_path.exists() else {}
        except Exception:
            st = {}
        st['background'] = str(bpath)
        s_path.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding='utf-8')
        return jsonify({'ok': True, 'background': str(bpath)})
    except Exception as e:
        return jsonify({'error': f'Failed to save background: {e}'}), 500


@bp.route('/regions', methods=['POST'])
def api_preproc_regions():
    payload = request.json or {}
    video = str(payload.get('video', '')).strip()
    regions = payload.get('regions')
    if not video or not regions:
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


@bp.route('/setup/save', methods=['POST'])
def api_preproc_setup_save():
    payload = request.json or {}
    facility = str(payload.get('facility', '')).strip()
    setup_name = str(payload.get('setup_name', '')).strip()
    preproc = payload.get('preproc') or {}
    items = payload.get('items') or []
    if not facility or not setup_name:
        return jsonify({'error': 'Missing facility or setup_name'}), 400
    facilities = CONFIG.get('facilities')
    if not isinstance(facilities, dict):
        facilities = CONFIG.setdefault('importer', {}).get('facilities', {})
    if facility not in facilities:
        return jsonify({'error': 'Unknown facility'}), 404
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

    roi_sets = facilities[facility].setdefault('roi_sets', [])
    replaced = False
    for i, s in enumerate(roi_sets):
        if isinstance(s, dict) and str(s.get('name', '')).strip() == setup_name:
            roi_sets[i] = setup_obj
            replaced = True
            break
    if not replaced:
        roi_sets.append(setup_obj)

    try:
        path = _config_path()
        path.write_text(json.dumps(CONFIG, ensure_ascii=False, indent=2), encoding='utf-8')
    except Exception as e:
        return jsonify({'error': f'Failed to write config: {e}'}), 500
    return jsonify({'ok': True, 'facility': facility, 'setup': setup_name, 'path': str(_config_path())})


__all__ = ['bp']

