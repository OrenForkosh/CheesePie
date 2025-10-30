from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from flask import Blueprint, jsonify, request


bp = Blueprint('annotations_api', __name__)


def _annotation_path_for(video_path: Path) -> Path:
    return video_path.with_suffix('.json')


@bp.route('/annotations', methods=['GET', 'POST'])
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


__all__ = ['bp']

