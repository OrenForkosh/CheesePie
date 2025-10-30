from __future__ import annotations

import json
import mimetypes
import subprocess
from pathlib import Path
from typing import Any, Dict, Optional

from flask import Blueprint, jsonify, request, Response, send_file


bp = Blueprint('media_api', __name__)


def _ffprobe_exists() -> bool:
    return subprocess.run(['which', 'ffprobe'], capture_output=True).returncode == 0


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
    for src in (v, fmt):
        d = src.get('duration')
        if d:
            try:
                duration = float(d)
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
        "bit_rate": bit_rate,
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


@bp.route('/api/media_meta')
def api_media_meta():
    path = request.args.get('path', '').strip()
    if not path:
        return jsonify({"error": "No path provided"}), 400
    meta = probe_media(Path(path).expanduser())
    return jsonify(meta)


@bp.route('/media')
def media():
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
        try:
            units, rng = range_header.split('=', 1)
            if units.strip() != 'bytes':
                return _range_not_satisfiable()
            if ',' in rng:
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

    rv = send_file(str(path), mimetype=mime or 'application/octet-stream', conditional=True)
    rv.headers.add('Accept-Ranges', 'bytes')
    return rv


__all__ = ['bp', 'probe_media']
