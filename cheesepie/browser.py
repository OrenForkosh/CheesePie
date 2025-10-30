from __future__ import annotations

import mimetypes
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from flask import Blueprint, jsonify, request

from .config import cfg_browser_visible_extensions, cfg_browser_required_filename_regex


bp = Blueprint('browser_api', __name__)


def list_dir_contents(directory: Path, query: str | None = None) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    if not directory.exists() or not directory.is_dir():
        return items

    q = (query or "").strip()
    q_lower = q.lower()
    allowed_exts = set(cfg_browser_visible_extensions())
    name_re = cfg_browser_required_filename_regex()

    for entry in sorted(directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        if entry.name.startswith('.'):
            continue
        name_lower = entry.name.lower()
        if q and (q_lower not in name_lower):
            continue
        if entry.is_file():
            if entry.suffix.lower() not in allowed_exts:
                continue
            if name_re is not None and not name_re.match(entry.name):
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


@bp.route('/list')
def api_list():
    directory = request.args.get('dir', '').strip()
    query = request.args.get('q', '').strip()
    if not directory:
        return jsonify({"items": [], "error": "No directory provided"})
    path = Path(directory).expanduser()
    items = list_dir_contents(path, query)
    return jsonify({"items": items})


@bp.route('/fileinfo')
def api_fileinfo():
    path = request.args.get('path', '').strip()
    if not path:
        return jsonify({"error": "No path provided"}), 400
    info = file_info(Path(path).expanduser())
    return jsonify(info)


__all__ = ['bp', 'list_dir_contents', 'file_info']

