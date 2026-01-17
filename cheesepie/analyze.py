from __future__ import annotations

import os
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from flask import Blueprint, jsonify, request

bp = Blueprint('analyze_api', __name__)


@dataclass
class TrackData:
    x: np.ndarray
    y: np.ndarray
    colors: List[str]


def _track_path_for_video(video: Path) -> Path:
    # Append .obj.mat to the video filename (keeping original extension)
    return video.with_name(video.name + '.obj.mat')


def _decode_mat_string(data: Any) -> Optional[str]:
    if data is None:
        return None
    if isinstance(data, bytes):
        return data.decode('utf-8', errors='ignore')
    if isinstance(data, str):
        return data
    if isinstance(data, np.ndarray):
        if data.dtype.kind in ('U', 'S'):
            parts: List[str] = []
            for item in data.flatten():
                if isinstance(item, bytes):
                    parts.append(item.decode('utf-8', errors='ignore'))
                else:
                    parts.append(str(item))
            return ''.join(parts).strip()
        if np.issubdtype(data.dtype, np.integer):
            chars = [chr(int(x)) for x in data.flatten() if int(x) > 0]
            return ''.join(chars).strip()
    return None


def _normalize_colors(raw: Any) -> List[str]:
    if raw is None:
        return []
    if isinstance(raw, (list, tuple)):
        items = list(raw)
    elif isinstance(raw, np.ndarray):
        if raw.size == 1:
            items = [raw.item()]
        else:
            items = [item for item in raw.flatten()]
    else:
        items = [raw]
    tokens: List[str] = []
    for item in items:
        if item is None:
            continue
        s = str(item).strip()
        if not s:
            continue
        if ',' in s:
            tokens.extend([p.strip() for p in s.split(',') if p.strip()])
        elif ' ' in s:
            tokens.extend([p.strip() for p in s.split() if p.strip()])
        elif len(s) > 1 and s.isalpha() and s.upper() == s:
            tokens.extend(list(s))
        else:
            tokens.append(s)
    return tokens


def _orient_pair(x: np.ndarray, y: np.ndarray) -> Optional[Tuple[np.ndarray, np.ndarray]]:
    if x.shape != y.shape:
        return None
    if x.shape[0] <= x.shape[1]:
        return x, y
    return x.T, y.T


def _load_mat_tracks(mat_path: Path) -> Optional[TrackData]:
    """Attempt to load x/y track arrays (and optional colors) from a MATLAB .obj.mat file."""
    if not mat_path.exists() or not mat_path.is_file():
        return None
    track = _load_mat_tracks_hdf5(mat_path)
    if track:
        return track
    track = _load_mat_tracks_scipy(mat_path)
    if track:
        return track
    return _load_mat_tracks_matlab(mat_path)


def _load_mat_tracks_hdf5(mat_path: Path) -> Optional[TrackData]:
    try:
        with mat_path.open('rb') as fh:
            sig = fh.read(4)
        if sig != b'\x89HDF':
            return None
    except Exception:
        return None
    try:
        import h5py  # type: ignore
    except Exception:
        return None
    try:
        with h5py.File(str(mat_path), 'r') as f:
            class MatReader:
                def __init__(self, hf):
                    self._f = hf

                @staticmethod
                def _is_ref(ds: h5py.Dataset) -> bool:
                    try:
                        return ds.dtype == h5py.ref_dtype or ds.dtype.kind == 'O'
                    except Exception:
                        return False

                def _first_ref(self, ds: h5py.Dataset) -> Optional[h5py.Reference]:
                    try:
                        data = ds[()]
                    except Exception:
                        return None
                    if isinstance(data, h5py.Reference):
                        return data
                    if isinstance(data, np.ndarray) and data.dtype in (h5py.ref_dtype, object):
                        for ref in data.flatten():
                            if isinstance(ref, h5py.Reference):
                                return ref
                    return None

                def _deref(self, obj: Any) -> Any:
                    if isinstance(obj, h5py.Dataset) and self._is_ref(obj):
                        ref = self._first_ref(obj)
                        if ref:
                            try:
                                return self._f[ref]
                            except Exception:
                                return obj
                    return obj

                def resolve(self, path: str, deref_last: bool = True) -> Optional[Any]:
                    parts = [p for p in path.split('/') if p]
                    obj: Any = self._f
                    for idx, part in enumerate(parts):
                        if not isinstance(obj, (h5py.File, h5py.Group)):
                            return None
                        if part not in obj:
                            return None
                        obj = obj[part]
                        if deref_last or idx < len(parts) - 1:
                            obj = self._deref(obj)
                    return obj

                def read_array(self, path: str) -> Optional[np.ndarray]:
                    return self._read_numeric(self.resolve(path))

                def _read_numeric(self, obj: Any) -> Optional[np.ndarray]:
                    if obj is None:
                        return None
                    obj = self._deref(obj)
                    if isinstance(obj, h5py.Dataset) and self._is_ref(obj):
                        ref = self._first_ref(obj)
                        if ref:
                            return self._read_numeric(self._f[ref])
                    if not isinstance(obj, h5py.Dataset):
                        return None
                    try:
                        arr = np.array(obj)
                    except Exception:
                        return None
                    if arr.dtype == object or arr.dtype == h5py.ref_dtype:
                        return None
                    arr = np.squeeze(arr)
                    if arr.ndim == 0:
                        return None
                    if arr.ndim == 1:
                        arr = arr.reshape(1, -1)
                    if arr.ndim != 2:
                        return None
                    return arr

                def read_strings(self, path: str) -> List[str]:
                    return self._read_strings(self.resolve(path, deref_last=False))

                def _read_strings(self, obj: Any) -> List[str]:
                    if obj is None:
                        return []
                    obj = self._deref(obj)
                    if isinstance(obj, h5py.Dataset) and self._is_ref(obj):
                        refs: List[h5py.Reference] = []
                        try:
                            data = obj[()]
                        except Exception:
                            data = None
                        if isinstance(data, h5py.Reference):
                            refs = [data]
                        elif isinstance(data, np.ndarray) and data.dtype in (h5py.ref_dtype, object):
                            refs = [ref for ref in data.flatten() if isinstance(ref, h5py.Reference)]
                        items: List[str] = []
                        for ref in refs:
                            sub = self._read_strings(self._f[ref])
                            items.extend([s for s in sub if s])
                        return items
                    if isinstance(obj, h5py.Dataset):
                        try:
                            data = obj[()]
                        except Exception:
                            return []
                        s = _decode_mat_string(data)
                        return [s] if s else []
                    return []

            reader = MatReader(f)

            def read_first(paths: List[str]) -> Optional[np.ndarray]:
                for path in paths:
                    arr = reader.read_array(path)
                    if arr is not None:
                        return arr
                return None

            track_specs = [
                (['self/tracking/x', 'self/tracking/X'], ['self/tracking/y', 'self/tracking/Y', 'self/tracking/t'], 'self/colors/mice'),
                (['Tracking/x', 'Tracking/X'], ['Tracking/y', 'Tracking/Y', 'Tracking/t'], 'Meta/Colors'),
            ]
            for x_paths, y_paths, color_path in track_specs:
                x = read_first(x_paths)
                y = read_first(y_paths)
                if x is None or y is None:
                    continue
                oriented = _orient_pair(x, y)
                if not oriented:
                    continue
                colors = _normalize_colors(reader.read_strings(color_path))
                return TrackData(oriented[0], oriented[1], colors)

            candidates: Dict[str, Tuple[np.ndarray, np.ndarray]] = {}

            def visit(name, obj):
                try:
                    if not isinstance(obj, h5py.Group):
                        return
                    dx = reader.read_array(f"{name}/x") or reader.read_array(f"{name}/X")
                    dy = reader.read_array(f"{name}/y") or reader.read_array(f"{name}/Y") or reader.read_array(f"{name}/t")
                    if dx is None or dy is None:
                        return
                    oriented = _orient_pair(dx, dy)
                    if not oriented:
                        return
                    candidates[name] = oriented
                except Exception:
                    return

            f.visititems(visit)

            if not candidates:
                return None
            best = None
            best_score = -1
            for _, (x, y) in candidates.items():
                score = x.shape[1]
                if score > best_score:
                    best = (x, y)
                    best_score = score
            if not best:
                return None
            colors = _normalize_colors(reader.read_strings('self/colors/mice'))
            if not colors:
                colors = _normalize_colors(reader.read_strings('Meta/Colors'))
            return TrackData(best[0], best[1], colors)
    except Exception:
        return None


def _load_mat_tracks_scipy(mat_path: Path) -> Optional[TrackData]:
    try:
        from scipy.io import loadmat  # type: ignore
        from scipy.io.matlab import MatReadWarning  # type: ignore
    except Exception:
        return None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', MatReadWarning)
            data = loadmat(
                str(mat_path),
                squeeze_me=True,
                struct_as_record=False,
                variable_names=['self', 'Tracking', 'tracking', 'Meta', 'meta'],
            )
    except Exception:
        return None

    def unwrap(obj: Any) -> Any:
        if isinstance(obj, np.ndarray) and obj.size == 1:
            try:
                return unwrap(obj.item())
            except Exception:
                return obj
        return obj

    def get_field(obj: Any, name: str) -> Any:
        obj = unwrap(obj)
        if obj is None:
            return None
        if isinstance(obj, dict):
            for key, val in obj.items():
                if key.lower() == name.lower():
                    return val
            return None
        if hasattr(obj, name):
            return getattr(obj, name)
        if hasattr(obj, name.lower()):
            return getattr(obj, name.lower())
        if hasattr(obj, name.upper()):
            return getattr(obj, name.upper())
        return None

    def first_value(*values: Any) -> Any:
        for value in values:
            if value is not None:
                return value
        return None

    def get_first(dct: Dict[str, Any], *names: str) -> Any:
        for name in names:
            for key in dct.keys():
                if key.lower() == name.lower():
                    return dct[key]
        return None

    top_self = get_first(data, 'self')
    if top_self is not None:
        tracking = get_field(top_self, 'tracking')
        x = first_value(get_field(tracking, 'x'), get_field(tracking, 'X'))
        y = first_value(get_field(tracking, 'y'), get_field(tracking, 'Y'), get_field(tracking, 't'))
        if x is not None and y is not None:
            x = np.array(x)
            y = np.array(y)
            oriented = _orient_pair(x, y)
            if oriented:
                colors = _normalize_colors(get_field(get_field(top_self, 'colors'), 'mice'))
                return TrackData(oriented[0], oriented[1], colors)

    tracking = get_first(data, 'Tracking', 'tracking')
    if tracking is not None:
        x = first_value(get_field(tracking, 'x'), get_field(tracking, 'X'))
        y = first_value(get_field(tracking, 'y'), get_field(tracking, 'Y'), get_field(tracking, 't'))
        if x is not None and y is not None:
            x = np.array(x)
            y = np.array(y)
            oriented = _orient_pair(x, y)
            if oriented:
                meta = get_first(data, 'Meta', 'meta')
                colors = _normalize_colors(get_field(meta, 'Colors') if meta is not None else None)
                return TrackData(oriented[0], oriented[1], colors)

    return None


def _load_mat_tracks_matlab(mat_path: Path) -> Optional[TrackData]:
    try:
        from .matlab import _ensure_matlab_started, MATLAB_LOCK, _mat_to_py, cfg_matlab
    except Exception:
        return None
    try:
        if not cfg_matlab().get('enabled', True):
            return None
    except Exception:
        return None
    try:
        eng = _ensure_matlab_started()
    except Exception:
        eng = None
    if eng is None:
        return None
    try:
        with MATLAB_LOCK:
            out = eng.load_tracking_obj(str(mat_path), nargout=1)
    except Exception:
        return None
    data = _mat_to_py(out)
    if not isinstance(data, dict):
        return None
    x_raw = data.get('x')
    y_raw = data.get('y')
    if x_raw is None or y_raw is None:
        return None
    try:
        x = np.array(x_raw, dtype=float)
        y = np.array(y_raw, dtype=float)
    except Exception:
        return None
    if x.ndim == 1:
        x = x.reshape(1, -1)
    if y.ndim == 1:
        y = y.reshape(1, -1)
    oriented = _orient_pair(x, y)
    if not oriented:
        return None
    colors = _normalize_colors(data.get('colors'))
    return TrackData(oriented[0], oriented[1], colors)


def _slice_tracks(x: np.ndarray, y: np.ndarray, start: int, count: int) -> Tuple[np.ndarray, np.ndarray]:
    start = max(0, int(start))
    count = max(1, min(2000, int(count)))
    end = min(start + count, x.shape[1])
    xs = x[:, start:end]
    ys = y[:, start:end]
    return xs, ys


@bp.route('/api/analyze/info')
def api_analyze_info():
    video = Path((request.args.get('video') or '').strip())
    if not video:
        return jsonify({'error': 'Missing video'}), 400
    mat = _track_path_for_video(video)
    if not mat.exists():
        return jsonify({
            'ok': False,
            'track': str(mat),
            'mice': 0,
            'frames': 0,
            'reason': 'missing_file',
        })
    track = _load_mat_tracks(mat)
    if not track:
        return jsonify({
            'ok': False,
            'track': str(mat),
            'mice': 0,
            'frames': 0,
            'reason': 'missing_data',
        })
    return jsonify({
        'ok': True,
        'track': str(mat),
        'mice': int(track.x.shape[0]),
        'frames': int(track.x.shape[1]),
        'colors': track.colors,
    })


@bp.route('/api/analyze/positions')
def api_analyze_positions():
    video = Path((request.args.get('video') or '').strip())
    if not video:
        return jsonify({'error': 'Missing video'}), 400
    try:
        start = int(request.args.get('start') or '0')
        count = int(request.args.get('count') or '240')
    except Exception:
        return jsonify({'error': 'Invalid start/count'}), 400
    mat = _track_path_for_video(video)
    track = _load_mat_tracks(mat)
    if not track:
        return jsonify({'error': 'Tracking not found'}), 404
    xs, ys = _slice_tracks(track.x, track.y, start, count)
    # Convert to mice-major arrays of arrays per frame index within chunk
    return jsonify({
        'ok': True,
        'start': start,
        'count': int(xs.shape[1]),
        'x': xs.tolist(),
        'y': ys.tolist(),
    })


__all__ = ['bp']
