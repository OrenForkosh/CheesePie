from __future__ import annotations

import logging
import mimetypes
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from flask import Blueprint, jsonify, request
from .config import cfg_importer_facilities

from .config import cfg_browser_visible_extensions, cfg_browser_required_filename_regex


bp = Blueprint('browser_api', __name__)
_log = logging.getLogger(__name__)

_SORT_KEYS = {'name', 'date', 'size'}


def list_dir_contents(
    directory: Path,
    query: str | None = None,
    sort_by: str = 'name',
    sort_order: str = 'asc',
) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    if not directory.exists() or not directory.is_dir():
        return items

    q = (query or "").strip()
    q_lower = q.lower()
    allowed_exts = set(cfg_browser_visible_extensions())
    name_re = cfg_browser_required_filename_regex()
    descending = sort_order.lower() == 'desc'

    for entry in directory.iterdir():
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
        try:
            stat = entry.stat()
        except OSError as e:
            _log.warning("browser: skipping %s — stat failed: %s", entry, e)
            continue
        item: Dict[str, Any] = {
            "name": entry.name,
            "path": str(entry.resolve()),
            "is_dir": entry.is_dir(),
            "size": stat.st_size,
            "modified": stat.st_mtime,
            "ext": entry.suffix.lower(),
        }
        if entry.is_file():
            item["has_preproc"] = (
                (entry.parent / f"{entry.name}.preproc.json").exists()
                or entry.with_suffix(".preproc.json").exists()
            )
            item["has_annotations"] = entry.with_suffix(".json").exists()
        items.append(item)

    # Sort: directories always first, then apply sort_by within each group
    sort_by = sort_by if sort_by in _SORT_KEYS else 'name'
    dirs = [x for x in items if x['is_dir']]
    files = [x for x in items if not x['is_dir']]

    if sort_by == 'date':
        sort_key = lambda x: x['modified']
    elif sort_by == 'size':
        sort_key = lambda x: x['size']
    else:
        sort_key = lambda x: x['name'].lower()

    dirs.sort(key=sort_key, reverse=descending)
    files.sort(key=sort_key, reverse=descending)
    return dirs + files


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
    facility = (request.args.get('facility') or '').strip().lower()
    facs = cfg_importer_facilities()
    if not facility or facility not in facs:
        return jsonify({"items": [], "error": "Invalid or missing facility"}), 400
    base = Path(facs[facility].get('output_dir') or '').expanduser().resolve()
    if not base.exists() or not base.is_dir():
        return jsonify({"items": [], "error": "Facility output_dir not available"}), 400
    directory = request.args.get('dir', '').strip()
    query = request.args.get('q', '').strip()
    sort_by = request.args.get('sort', 'name').strip().lower()
    sort_order = request.args.get('order', 'asc').strip().lower()
    if not directory:
        return jsonify({"items": [], "error": "No directory provided"}), 400
    path = Path(directory).expanduser().resolve()
    try:
        path.relative_to(base)
    except Exception:
        return jsonify({"items": [], "error": "Path outside facility scope"}), 403
    items = list_dir_contents(path, query, sort_by=sort_by, sort_order=sort_order)
    return jsonify({"items": items, "sort": sort_by, "order": sort_order})


@bp.route('/fileinfo')
def api_fileinfo():
    facility = (request.args.get('facility') or '').strip().lower()
    facs = cfg_importer_facilities()
    if not facility or facility not in facs:
        return jsonify({"error": "Invalid or missing facility"}), 400
    base = Path(facs[facility].get('output_dir') or '').expanduser().resolve()
    if not base.exists() or not base.is_dir():
        return jsonify({"error": "Facility output_dir not available"}), 400
    path_str = request.args.get('path', '').strip()
    if not path_str:
        return jsonify({"error": "No path provided"}), 400
    p = Path(path_str).expanduser().resolve()
    try:
        p.relative_to(base)
    except Exception:
        return jsonify({"error": "Path outside facility scope"}), 403
    info = file_info(p)
    return jsonify(info)


__all__ = ['bp', 'list_dir_contents', 'file_info']
