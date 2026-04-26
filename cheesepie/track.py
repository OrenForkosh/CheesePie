from __future__ import annotations

import json
import logging
import os
import signal
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from subprocess import Popen
from typing import List, Optional, Dict, Any

from flask import Blueprint, jsonify, request

from .pathguard import assert_within_allowed_roots

bp = Blueprint('track', __name__)

_log = logging.getLogger(__name__)

_WORKING_DIR = Path(__file__).resolve().parent.parent / 'working'
_TRACK_JOBS_FILE = _WORKING_DIR / 'track_jobs.json'
_TRACK_PIDS_FILE = _WORKING_DIR / 'track_pids.json'
_TRACK_PIDS_LOCK = threading.Lock()
_TRACK_JOB_MAX_AGE_DAYS = 7


@dataclass
class TrackJob:
    id: str
    files: List[str]
    started_at: datetime
    done: bool = False
    error: Optional[str] = None
    current_index: int = 0      # 0-based index of the file currently being processed
    results: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    cancel_requested: bool = False
    proc: Optional[Popen] = None


JOBS: Dict[str, TrackJob] = {}
JOBS_LOCK = threading.Lock()


def _guard_track_files(raw_files: Any) -> List[str]:
    if not isinstance(raw_files, list) or not raw_files:
        raise ValueError('No files provided')
    guarded: List[str] = []
    for f in raw_files:
        try:
            guarded.append(str(assert_within_allowed_roots(str(f))))
        except Exception:
            raise PermissionError(f'Path not allowed: {f}')
    return guarded


# ── PID tracking ────────────────────────────────────────────────────────────

def _add_track_pid(pid: int) -> None:
    """Record a subprocess PID so it can be reaped on next startup."""
    with _TRACK_PIDS_LOCK:
        try:
            _TRACK_PIDS_FILE.parent.mkdir(parents=True, exist_ok=True)
            try:
                pids: List[int] = json.loads(_TRACK_PIDS_FILE.read_text(encoding='utf-8'))
                if not isinstance(pids, list):
                    pids = []
            except Exception:
                pids = []
            if pid not in pids:
                pids.append(pid)
            _TRACK_PIDS_FILE.write_text(json.dumps(pids), encoding='utf-8')
        except Exception as e:
            _log.warning("track: could not record pid %d: %s", pid, e)


def _remove_track_pid(pid: int) -> None:
    """Remove a PID from the on-disk record after the subprocess exits cleanly."""
    with _TRACK_PIDS_LOCK:
        try:
            if not _TRACK_PIDS_FILE.exists():
                return
            pids: List[int] = json.loads(_TRACK_PIDS_FILE.read_text(encoding='utf-8'))
            if not isinstance(pids, list):
                return
            pids = [p for p in pids if p != pid]
            _TRACK_PIDS_FILE.write_text(json.dumps(pids), encoding='utf-8')
        except Exception as e:
            _log.error("track: failed to update PID file: %s", e, exc_info=True)


def reap_orphan_track() -> int:
    """Kill tracking subprocesses left running by a previous server instance.

    Called once at app startup.  Returns the count of processes signalled.
    """
    killed = 0
    with _TRACK_PIDS_LOCK:
        try:
            if not _TRACK_PIDS_FILE.exists():
                return 0
            pids: List[int] = json.loads(_TRACK_PIDS_FILE.read_text(encoding='utf-8'))
            if not isinstance(pids, list):
                return 0
            for pid in pids:
                try:
                    pid = int(pid)
                    os.kill(pid, signal.SIGTERM)
                    killed += 1
                    _log.info("track: reaped orphan pid=%d", pid)
                except (ProcessLookupError, ValueError):
                    pass  # already gone
                except Exception as e:
                    _log.warning("track: could not reap pid %s: %s", pid, e)
            # Clear the file — all stale PIDs handled
            _TRACK_PIDS_FILE.write_text(json.dumps([]), encoding='utf-8')
        except Exception as e:
            _log.warning("track: reap_orphan_track failed: %s", e)
    return killed


# ── Job persistence ──────────────────────────────────────────────────────────

def _job_to_dict(job: TrackJob) -> Dict[str, Any]:
    return {
        'id': job.id,
        'files': job.files,
        'started_at': job.started_at.isoformat(),
        'done': job.done,
        'error': job.error,
        'current_index': job.current_index,
        'cancel_requested': job.cancel_requested,
    }


def _job_from_dict(data: Dict[str, Any]) -> TrackJob:
    try:
        started_at = datetime.fromisoformat(str(data.get('started_at') or ''))
    except Exception:
        started_at = datetime.utcnow()
    return TrackJob(
        id=str(data['id']),
        files=list(data.get('files') or []),
        started_at=started_at,
        done=bool(data.get('done', False)),
        error=data.get('error'),
        current_index=max(0, int(data.get('current_index') or 0)),
        cancel_requested=bool(data.get('cancel_requested', False)),
    )


def _persist_track_jobs() -> None:
    """Write all current jobs to disk (atomic rename)."""
    try:
        _TRACK_JOBS_FILE.parent.mkdir(parents=True, exist_ok=True)
        with JOBS_LOCK:
            data = [_job_to_dict(j) for j in JOBS.values()]
        tmp = _TRACK_JOBS_FILE.with_suffix('.json.tmp')
        tmp.write_text(json.dumps(data, indent=2), encoding='utf-8')
        tmp.replace(_TRACK_JOBS_FILE)
    except Exception as e:
        _log.error("track: persist failed: %s", e, exc_info=True)


def _prune_old_track_jobs() -> None:
    """Remove completed jobs older than _TRACK_JOB_MAX_AGE_DAYS from memory."""
    cutoff = datetime.utcnow() - timedelta(days=_TRACK_JOB_MAX_AGE_DAYS)
    with JOBS_LOCK:
        old = [jid for jid, j in JOBS.items()
               if j.done and j.started_at < cutoff]
        for jid in old:
            del JOBS[jid]


def _load_track_jobs() -> None:
    """Populate JOBS from the on-disk file at import time."""
    if not _TRACK_JOBS_FILE.exists():
        return
    try:
        data = json.loads(_TRACK_JOBS_FILE.read_text(encoding='utf-8'))
        if not isinstance(data, list):
            return
        for item in data:
            if not isinstance(item, dict) or not item.get('id'):
                continue
            try:
                job = _job_from_dict(item)
                JOBS[job.id] = job
            except Exception as e:
                _log.warning("track: skipped malformed job entry %s: %s", item.get('id', '?'), e)
    except Exception as e:
        _log.error("track: could not load jobs from disk: %s", e)


# Load persisted jobs at import time
_load_track_jobs()


def resume_track_jobs() -> None:
    """Restart worker threads for unfinished tracking jobs after a server restart.

    For each non-done job the log files are consulted to find the first file
    that did not finish, and the worker resumes from there.  Already-completed
    files (whose log shows RUN_END) are not re-processed.

    Call this from the app factory after resume_pending_tasks().
    """
    with JOBS_LOCK:
        jobs = list(JOBS.values())

    for job in jobs:
        if job.done or job.cancel_requested:
            continue

        # Determine actual resume point from log files
        resume_from = len(job.files)  # assume all done unless a log says otherwise
        for idx, f in enumerate(job.files):
            logp = Path(f + '.log')
            st = _parse_last_log_state(logp)
            ev = (st.get('event') or '').upper()
            if ev != 'RUN_END':
                resume_from = idx
                break

        if resume_from >= len(job.files):
            # Every file has a RUN_END log — mark done
            with JOBS_LOCK:
                job.done = True
            _log.info("track: job %s already complete per logs, marking done", job.id)
            continue

        _log.info("track: resuming job %s from file index %d / %d",
                  job.id, resume_from, len(job.files))
        with JOBS_LOCK:
            job.current_index = resume_from

        t = threading.Thread(target=_worker, args=(job,), daemon=True)
        t.start()

    _persist_track_jobs()


# ── Log parsing ──────────────────────────────────────────────────────────────

def _parse_last_log_state(log_path: Path) -> Dict[str, Any]:
    state: Dict[str, Any] = {
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


# ── Worker ───────────────────────────────────────────────────────────────────

def _worker(job: TrackJob) -> None:
    base_dir = Path(__file__).resolve().parent.parent
    script = base_dir / 'scripts' / 'fake_track.py'
    try:
        # Iterate files; honour current_index to support resume from mid-point
        for i, f in enumerate(job.files):
            with JOBS_LOCK:
                if i < job.current_index:
                    continue  # already processed in a previous run
                job.current_index = i

            try:
                proc = Popen(['python3', str(script), '--video', f])
                with JOBS_LOCK:
                    job.proc = proc
                _add_track_pid(proc.pid)

                try:
                    # Poll until done or cancelled
                    while True:
                        ret = proc.poll()
                        if ret is not None:
                            break
                        with JOBS_LOCK:
                            cancel = job.cancel_requested
                        if cancel:
                            try:
                                proc.terminate()
                            except Exception as e:
                                _log.warning("track: failed to terminate pid %s: %s", proc.pid, e)
                            try:
                                proc.wait(timeout=1.0)
                            except Exception:
                                try:
                                    proc.kill()
                                except Exception as e:
                                    _log.warning("track: failed to kill pid %s: %s", proc.pid, e)
                            break
                        time.sleep(0.2)
                finally:
                    _remove_track_pid(proc.pid)

            except Exception as e:
                with JOBS_LOCK:
                    job.error = str(e)
                _log.error("track: worker error on %s: %s", f, e, exc_info=True)
                break

            with JOBS_LOCK:
                if job.cancel_requested:
                    break

            # Persist progress after each file completes
            _persist_track_jobs()

        with JOBS_LOCK:
            job.done = True
            job.proc = None

    except Exception as e:
        with JOBS_LOCK:
            job.error = str(e)
            job.done = True
            job.proc = None
        _log.error("track: worker fatal error: %s", e, exc_info=True)

    _persist_track_jobs()


# ── Routes ───────────────────────────────────────────────────────────────────

@bp.route('/api/track/start', methods=['POST'])
def start_track():
    data = request.get_json(silent=True) or {}
    try:
        files = _guard_track_files(data.get('files') or [])
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except PermissionError as e:
        return jsonify({'error': str(e)}), 403

    _prune_old_track_jobs()

    jid = str(uuid.uuid4())
    job = TrackJob(id=jid, files=files, started_at=datetime.utcnow())
    with JOBS_LOCK:
        JOBS[jid] = job

    _persist_track_jobs()

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

    items = []
    for idx, f in enumerate(job.files):
        logp = Path(f + '.log')
        st = _parse_last_log_state(logp)
        ev = (st.get('event') or '').upper()
        if ev == 'RUN_END':
            status = 'DONE'
        elif ev == 'ERROR':
            status = 'ERROR'
        elif ev in ('RUN_START', 'STEP_START', 'STEP_END'):
            status = 'RUNNING'
        else:
            status = 'PENDING'
        with JOBS_LOCK:
            cancel = job.cancel_requested
            cur = job.current_index
            jdone = job.done
        if cancel and idx == cur and not jdone and status not in ('DONE', 'ERROR'):
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

    overall = (
        'DONE' if all(x['status'] == 'DONE' for x in items)
        else 'ERROR' if any(x['status'] in ('ERROR', 'CANCELLED') for x in items)
        else 'RUNNING'
    )
    with JOBS_LOCK:
        err = job.error
        done = job.done
    return jsonify({
        'ok': True, 'job': jid,
        'status': overall if not err else 'ERROR',
        'done': done, 'error': err, 'items': items,
    })


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
        except Exception as e:
            _log.warning("track: failed to terminate pid %s on cancel: %s", getattr(proc, 'pid', '?'), e)
    _persist_track_jobs()
    return jsonify({'ok': True})


@bp.route('/api/track/retry', methods=['POST'])
def retry_track():
    data = request.get_json(silent=True) or {}
    try:
        files = _guard_track_files(data.get('files') or [])
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except PermissionError as e:
        return jsonify({'error': str(e)}), 403

    _prune_old_track_jobs()

    jid = str(uuid.uuid4())
    job = TrackJob(id=jid, files=files, started_at=datetime.utcnow())
    with JOBS_LOCK:
        JOBS[jid] = job

    _persist_track_jobs()

    t = threading.Thread(target=_worker, args=(job,), daemon=True)
    t.start()
    return jsonify({'ok': True, 'job': jid})
