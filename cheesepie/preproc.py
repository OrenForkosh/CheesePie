from __future__ import annotations

import json
import re
from pathlib import Path
import tempfile
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


def _tmp_base(video_path: Path) -> Path:
    """Return base temp path for this video (without specific suffix)."""
    # Prefer /tmp explicitly if present (per request), else fall back to system temp
    tmp_root = Path('/tmp')
    if not tmp_root.exists() or not tmp_root.is_dir():
        tmp_root = Path(tempfile.gettempdir())
    tmpdir = tmp_root
    base = video_path.stem  # drop last extension
    return tmpdir / base


def _arena_path_for(video_path: Path) -> Path:
    # Legacy compatibility file in tmp
    return _tmp_base(video_path).with_suffix('.arena.json')


def _background_path_for(video_path: Path) -> Path:
    return _tmp_base(video_path).with_suffix('.background.png')


def _preproc_state_path_for(video_path: Path) -> Path:
    # Persist all per-video preproc state under system temp dir
    return _tmp_base(video_path).with_suffix('.preproc.json')


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
    meta = None
    if s_path.exists():
        try:
            st = json.loads(s_path.read_text(encoding='utf-8'))
            arena = st.get('arena')
            bg = st.get('background')
            regions = st.get('roi') or st.get('regions')
            colors = st.get('colors')
            meta = st.get('meta')
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
    return jsonify({'ok': True, 'arena': arena, 'background': bg, 'roi': regions if 'regions' in locals() else None, 'colors': colors, 'meta': meta})


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
            # Arena with bbox (+ optional grid/size)
            try:
                tl = arena.get('tl') if isinstance(arena, dict) else None
                br = arena.get('br') if isinstance(arena, dict) else None
                arena_out: Dict[str, Any] = {}
                if isinstance(tl, dict) and isinstance(br, dict):
                    ax = int(tl.get('x', 0)); ay = int(tl.get('y', 0))
                    bx = int(br.get('x', ax)); by = int(br.get('y', ay))
                    arena_out['bbox'] = {'x': ax, 'y': ay, 'width': max(0, bx-ax), 'height': max(0, by-ay)}
                # Optional numeric fields if present in input
                def _set_int(k):
                    try:
                        if isinstance(arena, dict) and k in arena and arena.get(k) is not None:
                            arena_out[k] = int(arena.get(k))
                    except Exception:
                        pass
                for k in ('grid_cols','grid_rows','width_in_cm','height_in_cm'):
                    _set_int(k)
            except Exception:
                arena_out = arena if isinstance(arena, dict) else {}
            st['arena'] = arena_out
            # Normalize regions to roi mapping
            roi_map: Dict[str, Any] = {}
            if isinstance(regions, dict):
                for rname, rcfg in regions.items():
                    try:
                        if not isinstance(rcfg, dict):
                            continue
                        cells = rcfg.get('cells', []) if isinstance(rcfg.get('cells', []), list) else []
                        roi_map[str(rname)] = {
                            'cells': [[int(c[0]), int(c[1])] for c in cells if isinstance(c, (list, tuple)) and len(c) >= 2],
                            'sheltered': bool(rcfg.get('sheltered', False)),
                            'enabled': bool(rcfg.get('enabled', True)),
                        }
                    except Exception:
                        continue
            elif isinstance(regions, list):
                for it2 in regions:
                    try:
                        if not isinstance(it2, dict):
                            continue
                        name = str(it2.get('name', '')).strip()
                        if not name:
                            continue
                        cells_raw = it2.get('cells') or []
                        cells_out: List[List[int]] = []
                        if isinstance(cells_raw, list):
                            for c in cells_raw:
                                if isinstance(c, (list, tuple)) and len(c) >= 2:
                                    cells_out.append([int(c[0]), int(c[1])])
                        roi_map[name] = {
                            'cells': cells_out,
                            'sheltered': bool(it2.get('sheltered', False)),
                            'enabled': bool(it2.get('enabled', True)),
                        }
                    except Exception:
                        continue
            st['roi'] = roi_map
            # Colors: keep marks with label,pos,time,color and histograms; drop mouse (use label as mouse id)
            if isinstance(colors, dict):
                cols_out = dict(colors)
                try:
                    marks_in = colors.get('marks', [])
                    if isinstance(marks_in, list):
                        marks_out = []
                        for mk in marks_in:
                            if not isinstance(mk, dict):
                                continue
                            mko = dict(mk)
                            # If 'mouse' present, set/keep label then drop mouse
                            try:
                                if 'mouse' in mko and 'label' not in mko:
                                    mko['label'] = int(mko.get('mouse'))
                            except Exception:
                                pass
                            mko.pop('mouse', None)
                            marks_out.append(mko)
                        cols_out['marks'] = marks_out
                except Exception:
                    pass
                st['colors'] = cols_out
            s_path.parent.mkdir(parents=True, exist_ok=True)
            s_path.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding='utf-8')
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
    # Compute bbox and store under arena; also persist optional grid/size metadata
    try:
        tl = arena.get('tl') if isinstance(arena, dict) else None
        br = arena.get('br') if isinstance(arena, dict) else None
        arena_out: Dict[str, Any] = {}
        if isinstance(tl, dict) and isinstance(br, dict):
            ax = int(tl.get('x', 0)); ay = int(tl.get('y', 0))
            bx = int(br.get('x', ax)); by = int(br.get('y', ay))
            arena_out['bbox'] = {'x': ax, 'y': ay, 'width': max(0, bx-ax), 'height': max(0, by-ay)}
        # Optional numeric fields from client
        def _set_int(key_in: str, key_out: str):
            try:
                if key_in in arena and arena.get(key_in) is not None:
                    arena_out[key_out] = int(arena.get(key_in))
            except Exception:
                pass
        _set_int('grid_cols', 'grid_cols')
        _set_int('grid_rows', 'grid_rows')
        _set_int('width_in_cm', 'width_in_cm')
        _set_int('height_in_cm', 'height_in_cm')
    except Exception:
        arena_out = arena if isinstance(arena, dict) else {}
    st['arena'] = arena_out
    try:
        s_path.parent.mkdir(parents=True, exist_ok=True)
        s_path.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding='utf-8')
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
        # Store background image as Base64 in preproc JSON
        s_path = _preproc_state_path_for(vpath)
        try:
            st = json.loads(s_path.read_text(encoding='utf-8')) if s_path.exists() else {}
        except Exception:
            st = {}
        # Optional params if provided
        bg = {
            'image_b64': image,
        }
        try:
            if 'nframes' in payload: bg['nframes'] = int(payload.get('nframes'))
        except Exception:
            pass
        try:
            if 'quantile' in payload: bg['quantile'] = int(payload.get('quantile'))
        except Exception:
            pass
        st['background'] = bg
        s_path.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding='utf-8')
        return jsonify({'ok': True, 'background': bg})
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
    # Normalize to mapping: name -> {cells, sheltered, enabled}
    roi_map: Dict[str, Any] = {}
    if isinstance(regions, dict):
        for rname, rcfg in regions.items():
            try:
                if not isinstance(rcfg, dict):
                    continue
                cells = rcfg.get('cells', []) if isinstance(rcfg.get('cells', []), list) else []
                roi_map[str(rname)] = {
                    'cells': [[int(c[0]), int(c[1])] for c in cells if isinstance(c, (list, tuple)) and len(c) >= 2],
                    'sheltered': bool(rcfg.get('sheltered', False)),
                    'enabled': bool(rcfg.get('enabled', True)),
                }
            except Exception:
                continue
    elif isinstance(regions, list):
        for it in regions:
            try:
                if not isinstance(it, dict):
                    continue
                name = str(it.get('name', '')).strip()
                if not name:
                    continue
                cells_raw = it.get('cells') or []
                cells_out: List[List[int]] = []
                if isinstance(cells_raw, list):
                    for c in cells_raw:
                        if isinstance(c, (list, tuple)) and len(c) >= 2:
                            cells_out.append([int(c[0]), int(c[1])])
                roi_map[name] = {
                    'cells': cells_out,
                    'sheltered': bool(it.get('sheltered', False)),
                    'enabled': bool(it.get('enabled', True)),
                }
            except Exception:
                continue
    st['roi'] = roi_map
    try:
        s_path.parent.mkdir(parents=True, exist_ok=True)
        s_path.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding='utf-8')
        return jsonify({'ok': True, 'state': str(s_path)})
    except Exception as e:
        return jsonify({'error': f'Failed to save regions: {e}'}), 500


@bp.route('/colors', methods=['POST'])
def api_preproc_colors():
    payload = request.json or {}
    video = str(payload.get('video', '')).strip()
    colors = payload.get('colors')
    if not video or not isinstance(colors, dict):
        return jsonify({'error': 'Missing video or colors'}), 400
    vpath = Path(video).expanduser()
    if not vpath.exists() or not vpath.is_file():
        return jsonify({'error': 'Video file not found'}), 404
    s_path = _preproc_state_path_for(vpath)
    try:
        st = json.loads(s_path.read_text(encoding='utf-8')) if s_path.exists() else {}
    except Exception:
        st = {}
    # Merge frames and marks as provided; do not alter 'mouse' field
    st_colors: Dict[str, Any] = st.get('colors') if isinstance(st.get('colors'), dict) else {}
    # Frames: merge by time key; store marks per frame to avoid duplication
    frames_in = colors.get('frames') if isinstance(colors.get('frames'), dict) else {}
    frames_out = st_colors.get('frames') if isinstance(st_colors.get('frames'), dict) else {}
    try:
        for k, v in frames_in.items():
            if not isinstance(v, dict):
                continue
            tk = str(k)
            cur = frames_out.get(tk) if isinstance(frames_out.get(tk), dict) else {}
            # Merge image
            if 'image_b64' in v:
                cur['image_b64'] = v.get('image_b64')
            # Encode labels as grayscale PNG (uint8), store as data URL, drop raw list
            if 'labels' in v and v.get('labels') is not None:
                try:
                    import numpy as _np  # type: ignore
                    from PIL import Image  # type: ignore
                    import io as _io, base64 as _b64
                    arr = _np.array(v.get('labels'), dtype=_np.uint8)
                    if arr.ndim == 3 and arr.shape[-1] in (3,4):
                        arr = arr[...,0]
                    img = Image.fromarray(arr, mode='L')
                    buf = _io.BytesIO()
                    img.save(buf, format='PNG')
                    cur['labels_b64'] = 'data:image/png;base64,' + _b64.b64encode(buf.getvalue()).decode('ascii')
                    # ensure we don't keep raw labels
                    cur.pop('labels', None)
                except Exception:
                    # fallback: keep labels as-is if encoding fails
                    cur['labels'] = v.get('labels')
            # Marks provided under this frame: replace existing marks for this time key
            if isinstance(v.get('marks'), list):
                cur['marks'] = v.get('marks')
            frames_out[tk] = cur
    except Exception:
        pass
    st_colors['frames'] = frames_out
    # Drop top-level marks append behavior; keep marks inside frames only
    st['colors'] = st_colors
    try:
        s_path.parent.mkdir(parents=True, exist_ok=True)
        s_path.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding='utf-8')
        return jsonify({'ok': True, 'state': str(s_path), 'colors': st_colors})
    except Exception as e:
        return jsonify({'error': f'Failed to save colors: {e}'}), 500


@bp.route('/timing', methods=['POST'])
def api_preproc_timing():
    payload = request.json or {}
    video = str(payload.get('video', '')).strip()
    start_time = str(payload.get('start_time', '')).strip()
    end_time = str(payload.get('end_time', '')).strip()
    if not video:
        return jsonify({'error': 'Missing video'}), 400
    vpath = Path(video).expanduser()
    if not vpath.exists() or not vpath.is_file():
        return jsonify({'error': 'Video file not found'}), 404
    s_path = _preproc_state_path_for(vpath)
    try:
        st = json.loads(s_path.read_text(encoding='utf-8')) if s_path.exists() else {}
    except Exception:
        st = {}
    meta = st.get('meta') if isinstance(st.get('meta'), dict) else {}
    if start_time:
        meta['start_time'] = start_time
    if end_time:
        meta['end_time'] = end_time
    st['meta'] = meta
    try:
        s_path.parent.mkdir(parents=True, exist_ok=True)
        s_path.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding='utf-8')
        return jsonify({'ok': True, 'state': str(s_path), 'meta': meta})
    except Exception as e:
        return jsonify({'error': f'Failed to save timing: {e}'}), 500

@bp.route('/save_final', methods=['POST'])
def api_preproc_save_final():
    payload = request.json or {}
    video = str(payload.get('video', '')).strip()
    if not video:
        return jsonify({'error': 'Missing video'}), 400
    vpath = Path(video).expanduser()
    if not vpath.exists() or not vpath.is_file():
        return jsonify({'error': 'Video file not found'}), 404
    # Load temp state
    s_path = _preproc_state_path_for(vpath)
    try:
        st = json.loads(s_path.read_text(encoding='utf-8')) if s_path.exists() else {}
    except Exception:
        st = {}
    # Ensure schema alignment: arena only bbox, roi mapping exists, colors marks w/o mouse
    try:
        ar = st.get('arena') or {}
        if isinstance(ar, dict):
            if 'tl' in ar and 'br' in ar:
                try:
                    ax = int(ar['tl'].get('x', 0)); ay = int(ar['tl'].get('y', 0))
                    bx = int(ar['br'].get('x', ax)); by = int(ar['br'].get('y', ay))
                    st['arena'] = {'bbox': {'x': ax, 'y': ay, 'width': max(0,bx-ax), 'height': max(0,by-ay)}}
                except Exception:
                    pass
        # Normalize regions->roi
        if 'regions' in st and 'roi' not in st:
            regs = st.get('regions')
            roi_map: Dict[str, Any] = {}
            if isinstance(regs, dict):
                for rname, rcfg in regs.items():
                    try:
                        if not isinstance(rcfg, dict):
                            continue
                        cells = rcfg.get('cells', []) if isinstance(rcfg.get('cells', []), list) else []
                        roi_map[str(rname)] = {
                            'cells': [[int(c[0]), int(c[1])] for c in cells if isinstance(c,(list,tuple)) and len(c)>=2],
                            'sheltered': bool(rcfg.get('sheltered', False)),
                            'enabled': bool(rcfg.get('enabled', True)),
                        }
                    except Exception:
                        continue
            st['roi'] = roi_map
            st.pop('regions', None)
        # Colors marks drop mouse
        cols = st.get('colors')
        if isinstance(cols, dict):
            marks = cols.get('marks', [])
            if isinstance(marks, list):
                out = []
                for mk in marks:
                    if not isinstance(mk, dict):
                        continue
                    mko = dict(mk)
                    try:
                        if 'mouse' in mko and 'label' not in mko:
                            mko['label'] = int(mko.get('mouse'))
                    except Exception:
                        pass
                    mko.pop('mouse', None)
                    out.append(mko)
                st['colors']['marks'] = out
    except Exception:
        pass
    # Final file next to video: append suffix without replacing original extension
    final_path = vpath.parent / f"{vpath.name}.preproc.json"
    try:
        final_path.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding='utf-8')
        return jsonify({'ok': True, 'path': str(final_path)})
    except Exception as e:
        return jsonify({'error': f'Failed to write final preproc: {e}'}), 500

@bp.route('/setup/save', methods=['POST'])
def api_preproc_setup_save():
    payload = request.json or {}
    facility = str(payload.get('facility', '')).strip()
    setup_name = str(payload.get('setup_name', '')).strip()
    setup_in = payload.get('setup') or {}
    preproc = payload.get('preproc') or {}
    # ROI configuration per setup (list of region definitions or mapping)
    roi_sets = payload.get('items') or payload.get('roi_sets') or []
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
    # Target structure: setups is a dict: { setup_name: { arena_width_cm, ..., arena:{x,y,width,height}, roi:{ name: {...} } } }
    setup_obj: Dict[str, Any]
    if isinstance(setup_in, dict) and setup_in:
        # Trust provided shape (sanitize ints where appropriate)
        su = dict(setup_in)
        # Normalize integers where possible
        def _norm_int(k):
            if k in su and su[k] is not None:
                try:
                    su[k] = int(su[k])
                except Exception:
                    pass
        for k in ('arena_width_cm','arena_height_cm','grid_cols','grid_rows','bg_frames','bg_quantile'):
            _norm_int(k)
        setup_obj = su
    else:
        # Build from legacy 'preproc' + 'roi_sets/items'
        arena_rect = None
        try:
            tl = preproc.get('arena_tl'); br = preproc.get('arena_br')
            if isinstance(tl, dict) and isinstance(br, dict):
                ax = int(tl.get('x', 0)); ay = int(tl.get('y', 0))
                bx = int(br.get('x', ax)); by = int(br.get('y', ay))
                arena_rect = {'x': ax, 'y': ay, 'width': max(0, bx-ax), 'height': max(0, by-ay)}
        except Exception:
            arena_rect = None
        roi_map: Dict[str, Any] = {}
        if isinstance(roi_sets, dict):
            # Already mapping
            for rname, rcfg in roi_sets.items():
                try:
                    cells = rcfg.get('cells', []) if isinstance(rcfg, dict) else []
                    roi_map[str(rname)] = {
                        'cells': [[int(x[0]), int(x[1])] for x in cells if isinstance(x, (list, tuple)) and len(x) >= 2],
                        'sheltered': bool(rcfg.get('sheltered', False)) if isinstance(rcfg, dict) else False,
                    }
                except Exception:
                    continue
        else:
            # From list of dicts
            for it in roi_sets:
                if not isinstance(it, dict):
                    continue
                name = str(it.get('name', '')).strip()
                if not name:
                    continue
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
                roi_map[name] = {'cells': cells_out, 'sheltered': bool(it.get('sheltered', False))}
        setup_obj = {
            'arena_width_cm': _to_int(preproc.get('arena_width_cm')),
            'arena_height_cm': _to_int(preproc.get('arena_height_cm')),
            'grid_cols': _to_int(preproc.get('grid_cols')),
            'grid_rows': _to_int(preproc.get('grid_rows')),
            'bg_frames': _to_int(preproc.get('bg_frames')),
            'bg_quantile': _to_int(preproc.get('bg_quantile')),
            'arena': arena_rect,
            'roi': roi_map,
        }
    # Ensure 'setups' exists; migrate legacy roi_sets into default setup if needed
    fac = facilities[facility]
    # Use dict for setups as requested
    setups = fac.setdefault('setups', {})
    if not isinstance(setups, dict):
        # migrate list to dict
        try:
            newset: Dict[str, Any] = {}
            for s in setups:
                if isinstance(s, dict):
                    n = str(s.get('name','') or 'default')
                    newset[n] = s
            fac['setups'] = setups = newset
        except Exception:
            fac['setups'] = setups = {}
    setups[setup_name or 'default'] = setup_obj

    try:
        path = _config_path()
        path.write_text(json.dumps(CONFIG, ensure_ascii=False, indent=2), encoding='utf-8')
    except Exception as e:
        return jsonify({'error': f'Failed to write config: {e}'}), 500
    return jsonify({'ok': True, 'facility': facility, 'setup': setup_name, 'path': str(_config_path())})


__all__ = ['bp']


@bp.route('/segment_simple', methods=['POST'])
def api_preproc_segment_simple():
    """Segment a frame with background using cheesepie.segment.simple.

    Accepts JSON with either data URLs or file paths:
      - image: data URL for current frame or 'path'
      - background: data URL for background or 'background_path'

    Returns
      { ok: True, index: [[uint8...], ...] }
    """
    payload = request.json or {}
    image_data = payload.get('image')
    image_path = payload.get('path')
    bg_data = payload.get('background')
    bg_path = payload.get('background_path')
    params = payload.get('params') or {}
    if not (image_data or image_path):
        return jsonify({'error': 'Provide image (data URL) or path'}), 400
    try:
        from PIL import Image
        import base64
        import io
        import numpy as np  # type: ignore
    except Exception as e:
        return jsonify({'error': f'Missing dependency: {e}'}), 500

    def _from_dataurl(url: str) -> Image.Image:
        try:
            idx = url.find('base64,')
            b64 = url[idx+7:] if idx >= 0 else url
            raw = base64.b64decode(b64)
            return Image.open(io.BytesIO(raw)).convert('RGB')
        except Exception as e:
            raise ValueError(f'Failed to decode image: {e}')

    try:
        if image_data and not image_path:
            img = _from_dataurl(str(image_data))
        else:
            from pathlib import Path
            img = Image.open(str(Path(str(image_path)).expanduser())).convert('RGB')
        bkg = None
        try:
            if bg_data and not bg_path:
                bkg = _from_dataurl(str(bg_data))
            elif bg_path:
                from pathlib import Path
                bkg = Image.open(str(Path(str(bg_path)).expanduser())).convert('RGB')
        except Exception:
            bkg = None

        # Ensure both inputs are same size if background is provided
        if bkg is not None and bkg.size != img.size:
            bkg = bkg.resize(img.size, Image.BILINEAR)

        # Import cheesepie.segment lazily to avoid app startup failures if optional deps are missing
        try:
            from . import segment as _seg
        except Exception as e:
            return jsonify({'error': f'Failed to import segmenter: {e}. Install optional dependencies (e.g., scikit-image).'}), 500
        # Resolve function name: prefer 'simple', fallback to 'simple_segment'
        seg_fn = getattr(_seg, 'simple', None)
        if seg_fn is None:
            seg_fn = getattr(_seg, 'simple_segment', None)
        if seg_fn is None:
            return jsonify({'error': "Segmenter function not found (expected 'simple' or 'simple_segment')"}), 500
        # segment.simple now returns (labels_img, overlay_img) with same size as inputs.
        # If Options dataclass exists, allow tuning via params
        opt = None
        try:
            OptCls = getattr(_seg, 'Options', None)
            if OptCls is not None:
                opt = OptCls(
                    height=int(img.height),
                    width=int(img.width),
                    noiseThresh=int(params.get('noiseThresh', 10)),
                    maxNumObjects=int(params.get('maxNumObjects', 20)),
                    minNumPixels=int(params.get('minNumPixels', 25)),
                )
        except Exception:
            opt = None
        # Call signatures supported:
        # - simple(frame) -> (labels, overlay)
        # - simple(frame, bkg) -> (labels, overlay)
        # - simple(frame, bkg, opt)
        if bkg is None:
            # Try calling with just frame; fallback to passing frame as background
            try:
                result = seg_fn(img, opt=opt) if opt is not None else seg_fn(img)
            except TypeError:
                try:
                    result = seg_fn(img, img, opt=opt) if opt is not None else seg_fn(img, img)
                except TypeError:
                    # Last resort: assume signature (frame, bkg) without opt
                    result = seg_fn(img, img)
        else:
            try:
                result = seg_fn(img, bkg, opt=opt) if opt is not None else seg_fn(img, bkg)
            except TypeError:
                result = seg_fn(img, bkg)
        overlay_b64 = None
        labels_img: Image.Image
        if isinstance(result, (list, tuple)) and len(result) >= 2:
            labels_img = result[0]
            overlay_img = result[1]
            try:
                buf = io.BytesIO()
                overlay_img.save(buf, format='PNG')
                overlay_b64 = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')
            except Exception:
                overlay_b64 = None
        else:
            labels_img = result  # backward compatibility
        arr = np.array(labels_img, dtype=np.uint8)
        index = arr.tolist()
        # Basic stats for debugging
        try:
            import numpy as _np
            uniq = _np.unique(arr)
            nonzero = int((_np.count_nonzero(arr)))
            stats = {'shape': [int(arr.shape[0]), int(arr.shape[1])], 'unique': [int(x) for x in uniq.tolist()[:64]], 'nonzero': nonzero}
        except Exception:
            stats = None
        payload_out = {'ok': True, 'index': index}
        if stats is not None:
            payload_out['stats'] = stats
        if overlay_b64 is not None:
            payload_out['overlay_b64'] = overlay_b64
        return jsonify(payload_out)
    except Exception as e:
        return jsonify({'error': f'segment.simple failed: {e}'}), 500
