from __future__ import annotations

import json
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from subprocess import Popen
from typing import List, Optional, Dict, Any

from flask import Blueprint, jsonify, request


bp = Blueprint('track', __name__)


@dataclass
class TrackJob:
    id: str
    files: List[str]
    started_at: datetime
    done: bool = False
    error: Optional[str] = None
    current_index: int = 0  # 0-based index of file being processed
    results: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    cancel_requested: bool = False
    proc: Optional[Popen] = None


JOBS: Dict[str, TrackJob] = {}
JOBS_LOCK = threading.Lock()


def _parse_last_log_state(log_path: Path) -> Dict[str, Any]:
    state = {
        'event': 'PENDING',
        'step': None,
        'index': 0,
        'total': 0,
        'msg': '',
    }
    try:
        if not log_path.exists():
            return state
        last = None
        with log_path.open('r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    last = json.loads(line)
                except Exception:
                    continue
        if not last:
            return state
        state.update({
            'event': last.get('event') or state['event'],
            'step': last.get('step'),
            'index': last.get('index') or 0,
            'total': last.get('total') or 0,
            'msg': last.get('msg') or '',
        })
        return state
    except Exception:
        return state


def _worker(job: TrackJob):
    base_dir = Path(__file__).resolve().parent.parent
    script = base_dir / 'scripts' / 'fake_track.py'
    try:
        for i, f in enumerate(job.files):
            with JOBS_LOCK:
                job.current_index = i
            # Run the fake script sequentially for each file
            try:
                proc = Popen(['python3', str(script), '--video', f])
                with JOBS_LOCK:
                    job.proc = proc
                # Poll and allow cancellation
                while True:
                    ret = proc.poll()
                    if ret is not None:
                        break
                    with JOBS_LOCK:
                        if job.cancel_requested:
                            try:
                                proc.terminate()
                            except Exception:
                                pass
                            # give it a moment, then kill if needed
                            try:
                                proc.wait(timeout=1.0)
                            except Exception:
                                try:
                                    proc.kill()
                                except Exception:
                                    pass
                            break
                    # sleep a bit to avoid CPU spin
                    import time as _t
                    _t.sleep(0.2)
                # If cancelled, stop processing further files
                with JOBS_LOCK:
                    if job.cancel_requested:
                        break
            except Exception as e:
                with JOBS_LOCK:
                    job.error = str(e)
                break
        with JOBS_LOCK:
            job.done = True
    except Exception as e:
        with JOBS_LOCK:
            job.error = str(e)
            job.done = True


@bp.route('/api/track/start', methods=['POST'])
def start_track():
    data = request.get_json(silent=True) or {}
    files = data.get('files') or []
    if not isinstance(files, list) or not files:
        return jsonify({'error': 'No files provided'}), 400
    # Normalize as strings
    files = [str(x) for x in files]
    jid = str(uuid.uuid4())
    job = TrackJob(id=jid, files=files, started_at=datetime.utcnow())
    with JOBS_LOCK:
        JOBS[jid] = job
    t = threading.Thread(target=_worker, args=(job,), daemon=True)
    t.start()
    return jsonify({'ok': True, 'job': jid})


@bp.route('/api/track/status', methods=['GET'])
def status_track():
    jid = request.args.get('job') or ''
    with JOBS_LOCK:
        job = JOBS.get(jid)
    if not job:
        return jsonify({'error': 'Job not found'}), 404
    # Build items by reading logs
    items = []
    for idx, f in enumerate(job.files):
        logp = Path(f + '.log')
        st = _parse_last_log_state(logp)
        # Derive status
        ev = (st.get('event') or '').upper()
        if ev == 'RUN_END':
            status = 'DONE'
        elif ev == 'ERROR':
            status = 'ERROR'
        elif ev in ('RUN_START', 'STEP_START', 'STEP_END'):
            status = 'RUNNING'
        else:
            status = 'PENDING'
        # If cancellation requested and this is the current file and job not done, reflect CANCELLED
        with JOBS_LOCK:
            cancel = job.cancel_requested
            cur = job.current_index
            jdone = job.done
        if cancel and (idx == cur) and not jdone and status not in ('DONE', 'ERROR'):
            status = 'CANCELLED'
        items.append({
            'file': f,
            'event': st.get('event'),
            'step': st.get('step'),
            'index': st.get('index'),
            'total': st.get('total'),
            'msg': st.get('msg'),
            'status': status,
        })
    overall = 'DONE' if all(x['status'] == 'DONE' for x in items) else ('ERROR' if any(x['status'] in ('ERROR', 'CANCELLED') for x in items) else 'RUNNING')
    with JOBS_LOCK:
        err = job.error
        done = job.done
    return jsonify({'ok': True, 'job': jid, 'status': overall if not err else 'ERROR', 'done': done, 'error': err, 'items': items})


@bp.route('/api/track/cancel', methods=['POST'])
def cancel_track():
    jid = request.args.get('job') or ''
    with JOBS_LOCK:
        job = JOBS.get(jid)
    if not job:
        return jsonify({'error': 'Job not found'}), 404
    with JOBS_LOCK:
        job.cancel_requested = True
        proc = job.proc
    if proc is not None:
        try:
            proc.terminate()
        except Exception:
            pass
    return jsonify({'ok': True})


@bp.route('/api/track/retry', methods=['POST'])
def retry_track():
    data = request.get_json(silent=True) or {}
    files = data.get('files') or []
    if not isinstance(files, list) or not files:
        return jsonify({'error': 'No files provided'}), 400
    jid = str(uuid.uuid4())
    job = TrackJob(id=jid, files=[str(x) for x in files], started_at=datetime.utcnow())
    with JOBS_LOCK:
        JOBS[jid] = job
    t = threading.Thread(target=_worker, args=(job,), daemon=True)
    t.start()
    return jsonify({'ok': True, 'job': jid})
