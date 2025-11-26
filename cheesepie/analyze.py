from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import numpy as np
from flask import Blueprint, jsonify, request

bp = Blueprint('analyze_api', __name__)


def _track_path_for_video(video: Path) -> Path:
    # Append .obj.mat to the video filename (keeping original extension)
    return video.with_name(video.name + '.obj.mat')


def _load_mat_tracks(mat_path: Path) -> Optional[Tuple[np.ndarray, np.ndarray]]:
    """Attempt to load x/y track arrays from a MATLAB v7.3 .obj.mat (HDF5) file.

    Returns (x, y) as 2D numpy arrays shaped (mice, frames), or None if not found.
    """
    try:
        import h5py  # type: ignore
    except Exception:
        return None
    if not mat_path.exists() or not mat_path.is_file():
        return None
    try:
        with h5py.File(str(mat_path), 'r') as f:
            candidates: Dict[str, Tuple[np.ndarray, np.ndarray]] = {}

            def as_array(ds):
                try:
                    a = np.array(ds)
                    if a.ndim == 2:
                        return a
                except Exception:
                    pass
                return None

            def add_pair(base: str, dx, dy):
                x = as_array(dx); y = as_array(dy)
                if x is None or y is None:
                    return
                # Orient to (mice, frames)
                def orient(a: np.ndarray) -> np.ndarray:
                    if a.shape[0] <= a.shape[1]:
                        return a
                    return a.T
                x2 = orient(x)
                y2 = orient(y)
                if x2.shape != y2.shape:
                    return
                candidates[base] = (x2, y2)

            # Direct common paths
            for base in ['Tracking', 'tracking', 'self/tracking', 'self/Tracking']:
                try:
                    grp = f
                    for part in base.split('/'):
                        if not part:
                            continue
                        if part in grp:
                            grp = grp[part]
                        else:
                            grp = None
                            break
                    if grp is not None and isinstance(grp, h5py.Group):
                        dx = grp.get('x') or grp.get('X')
                        dy = grp.get('y') or grp.get('Y') or grp.get('t')
                        if dx is not None and dy is not None:
                            add_pair(base, dx, dy)
                except Exception:
                    pass

            # Fallback: search for any groups containing x/y datasets
            if not candidates:
                def visit(name, obj):
                    try:
                        if isinstance(obj, h5py.Group):
                            dx = obj.get('x') or obj.get('X')
                            dy = obj.get('y') or obj.get('Y') or obj.get('t')
                            if dx is not None and dy is not None:
                                add_pair(name, dx, dy)
                    except Exception:
                        pass
                f.visititems(visit)

            if not candidates:
                return None
            # Pick the pair with the largest frame dimension
            best = None
            best_score = -1
            for _, (x, y) in candidates.items():
                score = x.shape[1]
                if score > best_score:
                    best = (x, y)
                    best_score = score
            return best
    except Exception:
        return None


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
    x_y = _load_mat_tracks(mat)
    if not x_y:
        return jsonify({'ok': False, 'track': str(mat), 'mice': 0})
    x, y = x_y
    return jsonify({'ok': True, 'track': str(mat), 'mice': int(x.shape[0])})


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
    x_y = _load_mat_tracks(mat)
    if not x_y:
        return jsonify({'error': 'Tracking not found'}), 404
    x, y = x_y
    xs, ys = _slice_tracks(x, y, start, count)
    # Convert to mice-major arrays of arrays per frame index within chunk
    return jsonify({
        'ok': True,
        'start': start,
        'count': int(xs.shape[1]),
        'x': xs.tolist(),
        'y': ys.tolist(),
    })


__all__ = ['bp']

