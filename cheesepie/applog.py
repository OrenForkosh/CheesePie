"""applog.py — app-wide log file endpoint.

Provides GET /api/logs (tail the rotating log) and DELETE /api/logs (clear it).
The log file lives at working/app.log and is written to by the RotatingFileHandler
configured in create_app().
"""
from __future__ import annotations

from pathlib import Path

from flask import Blueprint, jsonify, request


bp = Blueprint('applog', __name__)

_LOG_FILE = Path(__file__).resolve().parent.parent / 'working' / 'app.log'


@bp.route('/api/logs')
def api_get_logs():
    try:
        n = min(int(request.args.get('lines', '1000')), 20000)
    except (ValueError, TypeError):
        n = 1000
    level = (request.args.get('level') or '').lower()

    if not _LOG_FILE.exists():
        return jsonify({'ok': True, 'lines': [], 'total': 0, 'path': str(_LOG_FILE)})

    try:
        with _LOG_FILE.open('r', encoding='utf-8', errors='replace') as f:
            all_lines = f.readlines()
    except Exception as e:
        return jsonify({'error': f'Failed to read log: {e}'}), 500

    if level == 'error':
        all_lines = [l for l in all_lines if ' ERROR ' in l or ' CRITICAL ' in l]
    elif level == 'warning':
        all_lines = [l for l in all_lines if ' ERROR ' in l or ' CRITICAL ' in l or ' WARNING ' in l]

    total = len(all_lines)
    tail = all_lines[-n:]
    return jsonify({
        'ok': True,
        'lines': [l.rstrip('\n') for l in tail],
        'total': total,
        'path': str(_LOG_FILE),
    })


@bp.route('/api/logs', methods=['DELETE'])
def api_clear_logs():
    try:
        _LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        _LOG_FILE.write_text('', encoding='utf-8')
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


__all__ = ['bp']
