"""pathguard.py — centralised filesystem access control.

Every route that accepts a user-supplied file path must call one of the
helpers here before opening, probing, or writing the file.  The helpers
resolve the path, compare it against the set of allowed roots derived from
the current config, and abort with 403 if the path escapes those roots.

Usage
-----
    from .pathguard import assert_within_allowed_roots

    @bp.route('/foo')
    def my_route():
        raw = request.args.get('path', '')
        path = assert_within_allowed_roots(raw)   # raises Forbidden on violation
        ...use path...

Allowed roots (evaluated at request time so config switches take effect):
  • Each facility's source_dir
  • Each facility's output_dir
  • The global importer working_dir
  • The app-specific temp dir (CHEESEPIE_TMP_ROOT) for preview uploads
"""
from __future__ import annotations

import tempfile
from pathlib import Path
from typing import List

from flask import abort


def get_app_tmp_root() -> Path:
    """Return (and create) the app-specific temp directory.

    Uses /tmp/cheesepie when /tmp is writable, otherwise falls back to a
    cheesepie/ subdirectory inside the system temp dir.  This narrow root
    is used for preview uploads instead of whitelisting all of /tmp.
    """
    candidates = [
        Path('/tmp') / 'cheesepie',
        Path(tempfile.gettempdir()) / 'cheesepie',
    ]
    for candidate in candidates:
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            return candidate.resolve()
        except Exception:
            continue
    raise RuntimeError(
        "cheesepie: could not create app temp directory — "
        "tried: " + ", ".join(str(c) for c in candidates)
    )


def _allowed_roots() -> List[Path]:
    """Return the list of resolved Path objects that are permitted roots."""
    from .config import cfg_importer_facilities, cfg_importer_working_dir  # local to avoid cycles

    roots: List[Path] = []

    # Facility source and output dirs
    try:
        for fac in cfg_importer_facilities().values():
            sd = str(fac.get('source_dir') or '').strip()
            if sd:
                try:
                    roots.append(Path(sd).expanduser().resolve())
                except Exception:
                    pass
            od = str(fac.get('output_dir') or '').strip()
            if od:
                try:
                    roots.append(Path(od).expanduser().resolve())
                except Exception:
                    pass
    except Exception:
        pass

    # Global working dir
    try:
        roots.append(cfg_importer_working_dir().resolve())
    except Exception:
        pass

    # App-specific temp dir (preview uploads only — not all of /tmp)
    try:
        roots.append(get_app_tmp_root())
    except Exception:
        pass

    return roots


def assert_within_allowed_roots(raw_path: str) -> Path:
    """Resolve *raw_path* and verify it sits under an allowed root.

    Returns the resolved Path on success.
    Calls flask.abort(403) if the path escapes all allowed roots.
    Calls flask.abort(400) if raw_path is empty.
    """
    if not raw_path or not raw_path.strip():
        abort(400, description="No path provided")

    try:
        resolved = Path(raw_path).expanduser().resolve()
    except Exception:
        abort(400, description="Invalid path")

    for root in _allowed_roots():
        try:
            resolved.relative_to(root)
            return resolved          # within this root — allowed
        except ValueError:
            continue

    abort(403, description="Path is outside allowed directories")
