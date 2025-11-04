from __future__ import annotations

import json
import threading
from pathlib import Path
import os
from typing import Any, Dict, Optional

from flask import Blueprint, jsonify, request

from .config import CONFIG


bp = Blueprint('matlab_api', __name__)


# ----- MATLAB Engine integration -----
MATLAB_ENG = None
MATLAB_LOCK = threading.Lock()
MATLAB_INIT_ERR = None  # store last init error string for diagnostics
MATLAB_WARM_THREAD: Optional[threading.Thread] = None
_WARM_KICKED = False


def cfg_matlab() -> Dict[str, Any]:
    m = CONFIG.get('matlab', {})
    raw_wl = m.get('whitelist', ['segment_frame'])
    wl_set = set()
    if isinstance(raw_wl, list):
        for f in raw_wl:
            try:
                s = str(f).strip()
                if s:
                    wl_set.add(s)
            except Exception:
                continue
    wl_set.update({'segment_frame', 'Segment'})
    return {
        'enabled': bool(m.get('enabled', True)),
        'mode': str(m.get('mode', 'engine')).strip() or 'engine',
        'binary': str(m.get('binary', '/Applications/MATLAB_R2025a.app/bin/matlab')).strip(),
        'paths': m.get('paths', ['./matlab']),
        'whitelist': sorted(wl_set)
    }


def _mat_to_py(obj):
    try:
        import matlab
    except Exception:
        matlab = None
    if obj is None:
        return None
    if hasattr(obj, '__class__') and obj.__class__.__name__ in (
        'double', 'single', 'int8', 'uint8', 'int16', 'uint16', 'int32', 'uint32', 'int64', 'uint64'
    ):
        try:
            return [list(row) for row in obj]
        except Exception:
            try:
                return list(obj)
            except Exception:
                return obj
    if hasattr(obj, '__class__') and obj.__class__.__name__ == 'logical':
        try:
            return [[bool(v) for v in row] for row in obj]
        except Exception:
            try:
                return [bool(v) for v in obj]
            except Exception:
                return bool(obj)
    if isinstance(obj, str):
        return obj
    if hasattr(obj, '_fieldnames'):
        out_list = []
        try:
            for i in range(len(obj)):
                s = obj[i]
                d = {}
                for f in s._fieldnames:
                    d[str(f)] = _mat_to_py(getattr(s, f))
                out_list.append(d)
            return out_list
        except Exception:
            d = {}
            try:
                for f in obj._fieldnames:
                    d[str(f)] = _mat_to_py(getattr(obj, f))
                return d
            except Exception:
                return str(obj)
    try:
        if hasattr(obj, '__len__') and not isinstance(obj, (dict, str, bytes)):
            return [_mat_to_py(x) for x in obj]
    except Exception:
        pass
    try:
        return json.loads(json.dumps(obj))
    except Exception:
        return str(obj)


def _ensure_matlab_started():
    global MATLAB_ENG, MATLAB_INIT_ERR
    if MATLAB_ENG is not None:
        return MATLAB_ENG
    if not cfg_matlab().get('enabled', True):
        return None
    try:
        import matlab.engine
    except Exception as e:
        MATLAB_INIT_ERR = f"Import failed: {e}"
        return None
    try:
        MATLAB_ENG = matlab.engine.start_matlab()
        for p in cfg_matlab().get('paths', []):
            try:
                MATLAB_ENG.addpath(str(Path(p).expanduser().resolve()), nargout=0)
            except Exception:
                pass
        return MATLAB_ENG
    except Exception as e:
        MATLAB_ENG = None
        MATLAB_INIT_ERR = f"Start failed: {e}"
        return None


def warmup_matlab_async() -> None:
    global MATLAB_WARM_THREAD
    if not cfg_matlab().get('enabled', True):
        return
    if MATLAB_ENG is not None:
        return
    if MATLAB_WARM_THREAD is not None and MATLAB_WARM_THREAD.is_alive():
        return

    def _bg_start():
        try:
            _ensure_matlab_started()
        except Exception:
            pass

    t = threading.Thread(target=_bg_start, name='matlab-warmup', daemon=True)
    MATLAB_WARM_THREAD = t
    t.start()


def init_app(app):
    """Register request hooks and trigger a warmup on first request/import."""
    @app.before_request
    def _kickoff():
        global _WARM_KICKED
        if _WARM_KICKED:
            return
        _WARM_KICKED = True
        try:
            warmup_matlab_async()
        except Exception:
            pass

    try:
        flag = os.environ.get('WERKZEUG_RUN_MAIN')
        if flag == 'true' or flag is None:
            warmup_matlab_async()
    except Exception:
        pass


@bp.route('/engine', methods=['POST'])
def api_matlab_engine():
    cfg = cfg_matlab()
    if not cfg.get('enabled', True):
        return jsonify({'error': 'MATLAB integration disabled'}), 503
    eng = _ensure_matlab_started()
    if eng is None:
        return jsonify({'error': 'MATLAB Engine not available', 'details': MATLAB_INIT_ERR}), 503
    payload = request.json or {}
    func = str(payload.get('func', '')).strip()
    args = payload.get('args', [])
    nout = payload.get('nargout', 1)
    if not func:
        return jsonify({'error': 'Missing func'}), 400
    wl = set(cfg.get('whitelist', []))
    if wl and func not in wl:
        return jsonify({'error': 'Function not allowed'}), 403
    margs = []
    try:
        import matlab
    except Exception:
        matlab = None
    try:
        for a in (args or []):
            if isinstance(a, (int, float)):
                margs.append(a)
            elif isinstance(a, str):
                margs.append(a)
            elif isinstance(a, list):
                try:
                    margs.append(matlab.double(a))
                except Exception:
                    margs.append(a)
            else:
                margs.append(a)
    except Exception:
        margs = args or []
    try:
        with MATLAB_LOCK:
            out = eng.feval(func, *margs, nargout=int(nout) if isinstance(nout, int) else 1)
        res = _mat_to_py(out)
        return jsonify({'ok': True, 'data': res})
    except Exception as e:
        return jsonify({'error': f'MATLAB call failed: {e}'}), 500


@bp.route('/segment_frame', methods=['POST'])
def api_matlab_segment_frame():
    cfg = cfg_matlab()
    if not cfg.get('enabled', True):
        return jsonify({'error': 'MATLAB integration disabled'}), 503
    eng = _ensure_matlab_started()
    if eng is None:
        return jsonify({'error': 'MATLAB Engine not available', 'details': MATLAB_INIT_ERR}), 503
    payload = request.json or {}
    image_data = payload.get('image')
    image_path = payload.get('path')
    if not image_data and not image_path:
        return jsonify({'error': 'Provide image (data URL) or path'}), 400
    tmp_path: Optional[Path] = None
    try:
        if image_data and not image_path:
            import base64
            idx = image_data.find('base64,')
            b64 = image_data[idx+7:] if idx >= 0 else image_data
            raw = base64.b64decode(b64)
            from tempfile import NamedTemporaryFile
            f = NamedTemporaryFile(delete=False, suffix='.png')
            f.write(raw); f.flush(); f.close()
            tmp_path = Path(f.name)
            image_path = str(tmp_path)
        func = 'segment_frame'
        wl = set(cfg.get('whitelist', []))
        if wl and func not in wl:
            return jsonify({'error': 'Function not allowed'}), 403
        with MATLAB_LOCK:
            out = eng.feval(func, str(image_path), nargout=1)
        mask = _mat_to_py(out)
        return jsonify({'ok': True, 'mask': mask})
    except Exception as e:
        return jsonify({'error': f'Segmentation failed: {e}'}), 500
    finally:
        try:
            if tmp_path and tmp_path.exists():
                tmp_path.unlink(missing_ok=True)
        except Exception:
            pass


@bp.route('/segment_colors', methods=['POST'])
def api_matlab_segment_colors():
    cfg = cfg_matlab()
    if not cfg.get('enabled', True):
        return jsonify({'error': 'MATLAB integration disabled'}), 503
    eng = _ensure_matlab_started()
    if eng is None:
        return jsonify({'error': 'MATLAB Engine not available', 'details': MATLAB_INIT_ERR}), 503
    payload = request.json or {}
    image_data = payload.get('image')
    image_path = payload.get('path')
    bg_data = payload.get('background')
    bg_path = payload.get('background_path')
    if not (image_data or image_path):
        return jsonify({'error': 'Provide image (data URL) or path'}), 400
    if not (bg_data or bg_path):
        return jsonify({'error': 'Provide background (data URL) or background_path'}), 400
    tmp_path: Optional[Path] = None
    try:
        if image_data and not image_path:
            import base64
            idx = image_data.find('base64,')
            b64 = image_data[idx+7:] if idx >= 0 else image_data
            raw = base64.b64decode(b64)
            from tempfile import NamedTemporaryFile
            f = NamedTemporaryFile(delete=False, suffix='.png')
            f.write(raw); f.flush(); f.close()
            tmp_path = Path(f.name)
            image_path = str(tmp_path)
        tmp_bg: Optional[Path] = None
        if bg_data and not bg_path:
            import base64
            idx2 = bg_data.find('base64,')
            b64b = bg_data[idx2+7:] if idx2 >= 0 else bg_data
            rawb = base64.b64decode(b64b)
            from tempfile import NamedTemporaryFile
            fb = NamedTemporaryFile(delete=False, suffix='.png')
            fb.write(rawb); fb.flush(); fb.close()
            tmp_bg = Path(fb.name)
            bg_path = str(tmp_bg)
        func = 'Segment'
        wl = set(cfg.get('whitelist', []))
        if wl and func not in wl:
            return jsonify({'error': 'Function not allowed'}), 403
        with MATLAB_LOCK:
            out = eng.feval(func, str(image_path), str(bg_path), nargout=1)
        index_map = _mat_to_py(out)
        return jsonify({'ok': True, 'index': index_map})
    except Exception as e:
        return jsonify({'error': f'Color segmentation failed: {e}'}), 500
    finally:
        try:
            if tmp_path and tmp_path.exists():
                tmp_path.unlink(missing_ok=True)
            if 'tmp_bg' in locals() and tmp_bg and tmp_bg.exists():
                tmp_bg.unlink(missing_ok=True)
        except Exception:
            pass


@bp.route('/status')
def api_matlab_status():
    cfg = cfg_matlab()
    enabled = bool(cfg.get('enabled', True))
    if enabled:
        try:
            warmup_matlab_async()
        except Exception:
            pass
    ready = MATLAB_ENG is not None
    starting = enabled and not ready and (MATLAB_WARM_THREAD is not None and MATLAB_WARM_THREAD.is_alive())
    return jsonify({
        'ok': True,
        'enabled': enabled,
        'ready': bool(ready),
        'starting': bool(starting),
        'error': MATLAB_INIT_ERR,
    })


__all__ = ['bp', 'init_app', 'cfg_matlab', 'warmup_matlab_async']


# ----- Native simpleSegment wrapper endpoint -----
@bp.route('/simple_segment', methods=['POST'])
def api_simple_segment_native():
    """Run color segmentation via compiled simpleSegment (no MATLAB Engine).

    Expects JSON with either data URLs or paths:
      - image: data URL for current frame (preferred) or 'path'
      - background: data URL for background (preferred) or 'background_path'

    Returns
      { ok: True, index: [[uint8 ...], ...] }
    """
    payload = request.json or {}
    image_data = payload.get('image')
    image_path = payload.get('path')
    bg_data = payload.get('background')
    bg_path = payload.get('background_path')
    if not (image_data or image_path):
        return jsonify({'error': 'Provide image (data URL) or path'}), 400
    if not (bg_data or bg_path):
        return jsonify({'error': 'Provide background (data URL) or background_path'}), 400

    # Lazy imports to avoid requiring deps if unused
    try:
        import numpy as np  # type: ignore
        from PIL import Image  # type: ignore
        import io
        import importlib.util
        from pathlib import Path as _Path
    except Exception as e:
        return jsonify({'error': f'Missing dependency: {e}'}), 500

    # Load matlab/simpleSegment.py as a module without colliding with matlab.engine
    try:
        mod = getattr(api_simple_segment_native, '_ss_mod', None)
        if mod is None:
            ss_path = _Path(__file__).parent.parent / 'matlab' / 'simpleSegment.py'
            spec = importlib.util.spec_from_file_location('simpleSegment_native', str(ss_path))
            if spec is None or spec.loader is None:
                return jsonify({'error': 'Failed to locate simpleSegment.py'}), 500
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)  # type: ignore
            setattr(api_simple_segment_native, '_ss_mod', mod)
    except Exception as e:
        return jsonify({'error': f'Failed to load simpleSegment: {e}'}), 500

    def _img_from_dataurl(data_url: str) -> Image.Image:
        try:
            idx = data_url.find('base64,')
            b64 = data_url[idx+7:] if idx >= 0 else data_url
            raw = base64.b64decode(b64)
        except Exception:
            # If not base64, try treat as raw bytes
            try:
                raw = data_url.encode('utf-8')
            except Exception as e:
                raise ValueError(f'Bad image data: {e}')
        try:
            return Image.open(io.BytesIO(raw)).convert('RGB')
        except Exception as e:
            raise ValueError(f'Failed to decode image: {e}')

    import base64  # stdlib

    try:
        if image_data and not image_path:
            img = _img_from_dataurl(str(image_data))
        else:
            img = Image.open(str(image_path)).convert('RGB')
        if bg_data and not bg_path:
            bkg = _img_from_dataurl(str(bg_data))
        else:
            bkg = Image.open(str(bg_path)).convert('RGB')

        # Ensure same size
        if bkg.size != img.size:
            bkg = bkg.resize(img.size, Image.BILINEAR)

        frame_np = np.array(img, dtype=np.uint8)
        bkg_np   = np.array(bkg, dtype=np.uint8)
        # Expect HWC
        if frame_np.ndim == 2:
            frame_np = np.stack([frame_np]*3, axis=-1)
        if bkg_np.ndim == 2:
            bkg_np = np.stack([bkg_np]*3, axis=-1)

        labels = mod.run_simple_segment(frame_np, bkg_np)
        try:
            # Convert compactly: list of rows
            out = labels.astype('uint8').tolist()
        except Exception:
            out = [[int(x) for x in row] for row in labels]
        return jsonify({'ok': True, 'index': out})
    except Exception as e:
        return jsonify({'error': f'simpleSegment failed: {e}'}), 500
