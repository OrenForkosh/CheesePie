from __future__ import annotations

from datetime import datetime
from typing import Any


def _format_bytes(n: int) -> str:
    step = 1024.0
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if n < step:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= step
    return f"{n:.1f} PB"


def filesize(n: Any):
    try:
        return _format_bytes(int(n))
    except Exception:
        return str(n)


def fmt_time(ts: Any):
    try:
        return datetime.fromtimestamp(float(ts)).strftime('%Y-%m-%d %H:%M')
    except Exception:
        return str(ts)


def register_filters(app):
    app.add_template_filter(filesize, 'filesize')
    app.add_template_filter(fmt_time, 'fmt_time')


__all__ = ['register_filters', 'filesize', 'fmt_time']

