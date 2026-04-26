from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
import uuid
from datetime import datetime, timedelta
from functools import partial
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional, Set, Tuple

import logging
import os
import signal
import tempfile
import time
from flask import Blueprint, jsonify, request, Response
from flask import stream_with_context

_log = logging.getLogger(__name__)

from .config import (
    cfg_importer_facilities,
    cfg_importer_working_dir,
    cfg_importer_source_exts,
    cfg_importer_ignore_dir_regex,
    cfg_importer_health_tolerance_seconds,
)
from .media import probe_media
from .tasks import (
    TaskContext,
    cancel_task as cancel_task_record,
    enqueue_task,
    get_task,
    list_tasks,
    register_task_resumer,
    set_task_cancel_hook,
    update_task,
)


bp = Blueprint('import_api', __name__)

# ── Orphan-process tracking ──────────────────────────────────────────────────
# ffmpeg PIDs are written here so the next server start can kill any stragglers
# left by a crash.  The file holds a plain JSON object: {job_id: pid}.
_FFMPEG_PIDS_FILE = Path(__file__).resolve().parent.parent / 'working' / 'ffmpeg_pids.json'
_FFMPEG_PIDS_LOCK = threading.Lock()

# ── Scan plan persistence ────────────────────────────────────────────────────
_LAST_SCAN_FILE = Path(__file__).resolve().parent.parent / 'working' / 'last_scan.json'


def _persist_last_scan(params: Dict[str, Any], plan: Dict[str, Any]) -> None:
    """Write the most recent completed scan+plan to disk for cross-navigation restore."""
    try:
        _LAST_SCAN_FILE.parent.mkdir(parents=True, exist_ok=True)
        _LAST_SCAN_FILE.write_text(
            json.dumps({'params': params, 'plan': plan, 'saved_at': time.time()},
                       ensure_ascii=False),
            encoding='utf-8',
        )
    except Exception as e:
        _log.warning("importer: could not persist last scan: %s", e)


def _load_last_scan() -> Optional[Dict[str, Any]]:
    try:
        if not _LAST_SCAN_FILE.exists():
            return None
        data = json.loads(_LAST_SCAN_FILE.read_text(encoding='utf-8'))
        if not isinstance(data, dict) or 'plan' not in data:
            return None
        return data
    except Exception:
        return None


def _write_ffmpeg_pid(job_id: str, pid: int) -> None:
    """Append pid to the list stored under job_id. Format: {job_id: [pid, ...]}."""
    with _FFMPEG_PIDS_LOCK:
        try:
            _FFMPEG_PIDS_FILE.parent.mkdir(parents=True, exist_ok=True)
            try:
                data: Dict[str, List[int]] = json.loads(_FFMPEG_PIDS_FILE.read_text(encoding='utf-8'))
                if not isinstance(data, dict):
                    data = {}
            except Exception:
                data = {}
            # Migrate legacy scalar values to lists
            existing = data.get(job_id)
            if isinstance(existing, int):
                existing = [existing]
            elif not isinstance(existing, list):
                existing = []
            if pid not in existing:
                existing.append(pid)
            data[job_id] = existing
            _FFMPEG_PIDS_FILE.write_text(json.dumps(data), encoding='utf-8')
        except Exception as e:
            _log.warning("importer: could not write ffmpeg pid: %s", e)


def _clear_ffmpeg_pid(job_id: str, pid: Optional[int] = None) -> None:
    """Remove a specific pid (or the entire job entry) from the PID file."""
    with _FFMPEG_PIDS_LOCK:
        try:
            if not _FFMPEG_PIDS_FILE.exists():
                return
            data: Dict[str, Any] = json.loads(_FFMPEG_PIDS_FILE.read_text(encoding='utf-8'))
            if not isinstance(data, dict) or job_id not in data:
                return
            if pid is None:
                del data[job_id]
            else:
                existing = data[job_id]
                if isinstance(existing, list):
                    try:
                        existing.remove(pid)
                    except ValueError:
                        pass
                    if existing:
                        data[job_id] = existing
                    else:
                        del data[job_id]
                else:
                    del data[job_id]
            _FFMPEG_PIDS_FILE.write_text(json.dumps(data), encoding='utf-8')
        except Exception as e:
            _log.error("importer: failed to update ffmpeg PID file: %s", e, exc_info=True)


def reap_orphan_ffmpeg() -> int:
    """Kill any ffmpeg processes recorded by a previous server run.

    Called once at app startup before resume_pending_tasks().  Returns the
    number of processes that were successfully signalled.
    Format: {job_id: [pid1, pid2, ...]} — supports parallel workers per job.
    """
    killed = 0
    with _FFMPEG_PIDS_LOCK:
        try:
            if not _FFMPEG_PIDS_FILE.exists():
                return 0
            data = json.loads(_FFMPEG_PIDS_FILE.read_text(encoding='utf-8'))
            if not isinstance(data, dict):
                return 0
            for job_id, pids in list(data.items()):
                # Support both legacy scalar and new list format
                if isinstance(pids, int):
                    pids = [pids]
                elif not isinstance(pids, list):
                    continue
                for pid in pids:
                    try:
                        pid = int(pid)
                        os.kill(pid, signal.SIGTERM)
                        killed += 1
                        _log.info("importer: reaped orphan ffmpeg pid=%d (job %s)", pid, job_id)
                    except (ProcessLookupError, ValueError):
                        pass  # already gone
                    except Exception as e:
                        _log.warning("importer: could not reap pid %s: %s", pid, e)
            # Reset the file — all prior PIDs are now handled
            _FFMPEG_PIDS_FILE.write_text(json.dumps({}), encoding='utf-8')
        except Exception as e:
            _log.warning("importer: reap_orphan_ffmpeg failed: %s", e)
    return killed


def _ffmpeg_exists() -> bool:
    return shutil.which('ffmpeg') is not None


def _safe_time_str(s: str) -> Optional[str]:
    try:
        s = str(s).strip()
        hh, mm = s.split(':', 1)
        h = int(hh); m = int(mm)
        if 0 <= h <= 23 and 0 <= m <= 59:
            return f"{h:02d}:{m:02d}"
    except Exception:
        pass
    return None


def _combine_date_time(date_str: str, time_str: str) -> Optional[datetime]:
    try:
        ds = str(date_str).strip()
        ts = _safe_time_str(time_str)
        if not ds or not ts:
            return None
        return datetime.strptime(ds + ' ' + ts, '%Y-%m-%d %H:%M')
    except Exception:
        return None


def _day_windows(start_date: str, end_date: str, start_time: str, end_time: str) -> List[Dict[str, datetime]]:
    start_dt = _combine_date_time(start_date, start_time)
    end_dt_ref = _combine_date_time(end_date, start_time)
    if not start_dt or not end_dt_ref:
        return []
    days = (end_dt_ref.date() - start_dt.date()).days + 1
    windows: List[Dict[str, datetime]] = []
    st_hhmm = _safe_time_str(start_time) or '00:00'
    et_hhmm = _safe_time_str(end_time) or st_hhmm
    sh, sm = map(int, st_hhmm.split(':'))
    eh, em = map(int, et_hhmm.split(':'))
    for i in range(max(1, days)):
        base = datetime(start_dt.year, start_dt.month, start_dt.day, sh, sm) + timedelta(days=i)
        end_base = datetime(base.year, base.month, base.day, eh, em)
        if end_base <= base:
            end_base = end_base + timedelta(days=1)
        windows.append({'start': base, 'end': end_base})
    return windows


def _format_cam_glob(pattern: str, cam_idx: int) -> str:
    try:
        if '{cam:02d}' in pattern:
            pattern = pattern.replace('{cam:02d}', f'{cam_idx:02d}')
        return pattern.replace('{cam}', str(cam_idx))
    except Exception:
        return pattern


def _iter_files_for_camera(source_dir: Path, cam_idx: int, exts: List[str], camera_pattern: str | None = None) -> List[Path]:
    res: List[Path] = []
    try:
        if camera_pattern:
            # Treat as a subfolder name pattern, not a wildcard glob
            sub = _format_cam_glob(camera_pattern, cam_idx)
            root = source_dir.joinpath(sub)
            if root.exists() and root.is_dir():
                for cur, _dirnames, filenames in os.walk(root):
                    for fn in filenames:
                        p = Path(cur) / fn
                        if p.suffix.lower() in exts:
                            res.append(p)
        else:
            tag = f"cam{cam_idx:02d}"
            for p in source_dir.rglob('*'):
                if not p.is_file():
                    continue
                if p.suffix.lower() not in exts:
                    continue
                if tag in p.name.lower():
                    res.append(p)
    except Exception:
        pass
    return res


def _file_time_range(path: Path) -> Optional[tuple[datetime, datetime]]:
    meta = probe_media(path)
    if not meta.get('available') or meta.get('error'):
        return None
    dur = meta.get('duration')
    if not isinstance(dur, (int, float)) or dur <= 0:
        return None
    start_dt = _parse_start_from_stem(path.stem)
    if not start_dt:
        return None
    return (start_dt, start_dt + timedelta(seconds=float(dur)))


def _overlaps(a_start, a_end, b_start, b_end) -> bool:
    return (a_start < b_end) and (b_start < a_end)


def _ensure_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def _path_endswith_parts(path: Path, parts: List[str]) -> bool:
    if not parts:
        return False
    if len(path.parts) < len(parts):
        return False
    tail = path.parts[-len(parts):]
    return [p.lower() for p in tail] == [p.lower() for p in parts]


def _resolve_output_dir(out_base: str, experiment: str, treatment: str) -> Path:
    base = Path(str(out_base or '')).expanduser()
    exp = str(experiment or '').strip()
    trt = str(treatment or '').strip()
    if not exp and not trt:
        return base
    if exp and trt:
        if _path_endswith_parts(base, [exp, trt]):
            return base
        if _path_endswith_parts(base, [exp]):
            return base.joinpath(trt)
    elif exp:
        if _path_endswith_parts(base, [exp]):
            return base
    return base.joinpath(*(p for p in (exp, trt) if p))


def _format_hhmmss(seconds: float) -> str:
    try:
        if seconds is None or seconds < 0:
            seconds = 0.0
        ms = int(round((seconds - int(seconds)) * 1000))
        s = int(seconds) % 60
        m = (int(seconds) // 60) % 60
        h = int(seconds) // 3600
        return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"
    except Exception:
        return "00:00:00.000"


def _parse_dur_to_seconds(val: str | int | float | None) -> int:
    """Parse duration like '4:00' (HH:MM) or seconds into integer seconds.
    Module-level helper so background workers can reuse it.
    """
    try:
        if isinstance(val, (int, float)):
            return max(0, int(val))
        s = str(val or '').strip()
        if not s:
            return 4 * 3600
        if ':' in s:
            hh, mm = s.split(':', 1)
            return max(0, int(hh) * 3600 + int(mm) * 60)
        return max(0, int(s))
    except Exception:
        return 4 * 3600


def _write_concat_list(list_path: Path, items: List[Dict[str, Any]]) -> None:
    """Write an ffmpeg concat demuxer list with file/inpoint/outpoint per item.

    - file 'path'
    - inpoint HH:MM:SS.mmm (if present)
    - outpoint HH:MM:SS.mmm (if present)
    """
    with list_path.open('w', encoding='utf-8') as f:
        for it in items:
            fn = it['path']
            q = "'" + str(fn).replace("'", "'\\''") + "'"
            f.write(f"file {q}\n")
            if it.get('inpoint') is not None:
                f.write(f"inpoint {_format_hhmmss(float(it['inpoint']))}\n")
            if it.get('outpoint') is not None:
                f.write(f"outpoint {_format_hhmmss(float(it['outpoint']))}\n")


def _probe_concat_duration(list_path: Path) -> Optional[float]:
    """Return total duration (seconds) of a concat list via ffprobe, or None on error."""
    try:
        cmd = [
            'ffprobe', '-v', 'quiet',
            '-f', 'concat', '-safe', '0', '-i', str(list_path),
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return float(r.stdout.strip())
    except Exception:
        return None


def _run_ffmpeg_concat(list_file: Path, out_path: Path) -> tuple[int, str]:
    cmd = [
        'ffmpeg', '-v', 'quiet', '-y', '-threads', '4',
        '-f', 'concat', '-safe', '0', '-i', str(list_file),
        '-vcodec', 'copy', '-an', '-copytb', '0', str(out_path)
    ]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True)
        return (p.returncode, p.stderr or p.stdout)
    except Exception as e:
        return (1, str(e))


def _resolve_manifest_source_path(source_dir: Path, raw_path: Any) -> Path:
    raw = str(raw_path or '').strip()
    if not raw:
        raise ValueError('Missing manifest file path')
    try:
        source_root = source_dir.expanduser().resolve()
        path = Path(raw).expanduser().resolve()
    except Exception as e:
        raise ValueError(f'Invalid manifest file path: {e}')
    try:
        path.relative_to(source_root)
    except ValueError:
        raise PermissionError(f'Manifest path outside facility source_dir: {path}')
    if not path.exists() or not path.is_file():
        raise FileNotFoundError(f'Manifest file not found: {path}')
    return path


# Async encode job state for /encode_days + /encode_status
ENCODE_JOBS: Dict[str, Dict[str, Any]] = {}
ENCODE_LOCK = threading.Lock()
ENCODE_PROCS: Dict[str, Set[subprocess.Popen]] = {}  # set of live procs per job
_ENCODE_MAX_WORKERS = 2  # days encoded in parallel per job

_STALE_JOB_MAX_AGE = 3600.0  # seconds before a terminal job is evicted from memory


def _prune_stale_jobs() -> None:
    """Remove completed/failed/cancelled jobs older than _STALE_JOB_MAX_AGE.

    Called before creating each new job so dicts don't grow unboundedly in
    long-running deployments.
    """
    cutoff = time.time() - _STALE_JOB_MAX_AGE
    terminal = {'DONE', 'FAILED', 'CANCELLED', 'ERROR'}
    with SCAN_LOCK:
        stale_scan = [
            jid for jid, j in SCAN_JOBS.items()
            if str(j.get('status', '')).upper() in terminal
            and float(j.get('created_at', 0)) < cutoff
        ]
        for jid in stale_scan:
            SCAN_JOBS.pop(jid, None)
    with ENCODE_LOCK:
        stale_enc = [
            jid for jid, j in ENCODE_JOBS.items()
            if str(j.get('status', '')).upper() in terminal
            and float(j.get('created_at', 0)) < cutoff
        ]
        for jid in stale_enc:
            ENCODE_JOBS.pop(jid, None)


def _task_total_steps(plan: Dict[str, Any]) -> int:
    try:
        return sum(
            1
            for cam_entry in (plan.get('jobs') or [])
            for d in (cam_entry.get('days') or [])
            if int(d.get('segments') or 0) > 0
            and str(d.get('status') or '').upper() not in ('MISSING', 'EMPTY')
        )
    except Exception:
        return 0


def _find_task_by_payload(kind: str, key: str, value: str) -> Optional[Dict[str, Any]]:
    try:
        tasks = list_tasks(active_only=False, limit=500)
    except Exception:
        tasks = []
    for t in tasks:
        if str(t.get('kind') or '') != kind:
            continue
        payload = t.get('payload') or {}
        if str(payload.get(key) or '') == value:
            return t
    return None


def _run_import_job(ctx: TaskContext, plan: Dict[str, Any]) -> None:
    total = _task_total_steps(plan)
    jobs = plan.get('jobs') or []
    completed = 0
    for cam_entry in jobs:
        for day_entry in cam_entry.get('days', []):
            st = str(day_entry.get('status') or '').upper()
            segs = int(day_entry.get('segments') or 0)
            if segs <= 0 or st in ('MISSING', 'EMPTY'):
                continue
            if st in ('DONE', 'FAILED', 'CANCELLED'):
                completed += 1
    prog = completed
    if total > 0:
        ctx.set_progress(prog, total=total)
    jobs = plan.get('jobs') or []
    for cam_entry in jobs:
        cam = cam_entry.get('camera')
        for day_entry in cam_entry.get('days', []):
            segments = int(day_entry.get('segments') or 0)
            st = str(day_entry.get('status') or '').upper()
            if segments <= 0 or st in ('MISSING', 'EMPTY'):
                day_entry['status'] = 'MISSING' if segments <= 0 else st
                continue
            if st in ('DONE', 'FAILED', 'CANCELLED'):
                continue
            if ctx.cancelled():
                day_entry['status'] = 'CANCELLED'
                update_task(ctx.task_id, status='CANCELLED', progress=prog, meta={'plan': plan}, message='Cancelled')
                return
            list_path = Path(str(day_entry.get('concat_list') or day_entry.get('list_path') or '')).expanduser()
            out_path = Path(str(day_entry.get('output') or '')).expanduser()
            try:
                _ensure_dir(out_path.parent)
            except Exception as e:
                _log.error("importer: failed to create output directory %s: %s", out_path.parent, e, exc_info=True)
            day_entry['status'] = 'RUNNING'
            update_task(ctx.task_id, status='RUNNING', progress=prog, meta={'plan': plan}, message=f'Camera {cam} day {day_entry.get("day")} running')
            code, msg = _run_ffmpeg_concat(list_path, out_path)
            if code == 0:
                try:
                    list_path.unlink(missing_ok=True)
                except OSError as _ue:
                    _log.warning("importer: could not remove concat list %s: %s", list_path, _ue)
            prog += 1
            day_entry['ffmpeg'] = msg
            day_entry['status'] = 'DONE' if code == 0 else 'FAILED'
            day_entry['message'] = msg
            update_task(ctx.task_id, progress=prog, meta={'plan': plan}, message=msg or '')
            if ctx.cancelled():
                day_entry['status'] = 'CANCELLED'
                update_task(ctx.task_id, status='CANCELLED', progress=prog, meta={'plan': plan}, message='Cancelled')
                return
    final_status = 'CANCELLED' if ctx.cancelled() else 'DONE'
    update_task(ctx.task_id, status=final_status, progress=prog, meta={'plan': plan})


def _scan_task_runner(ctx: TaskContext, payload: Dict[str, Any]) -> None:
    job_id = str(payload.get('job_id') or uuid.uuid4().hex)
    params = payload.get('params') or {}
    set_task_cancel_hook(ctx.task_id, lambda: _cancel_scan_job(job_id))
    _prune_stale_jobs()
    with SCAN_LOCK:
        if job_id not in SCAN_JOBS:
            SCAN_JOBS[job_id] = {
                'id': job_id,
                'status': 'QUEUED',
                'params': params,
                'files': [],
                'total': 0,
                'cancel': False,
                'created_at': time.time(),
            }
        SCAN_JOBS[job_id]['task_id'] = ctx.task_id
    if ctx.cancelled():
        with SCAN_LOCK:
            job = SCAN_JOBS.get(job_id)
            if job:
                job['status'] = 'CANCELLED'
        _update_scan_task(job_id, status='CANCELLED', message='Cancelled')
        return
    _scan_prepare_worker(job_id)


def _estimate_source_bytes(plan: List[Dict[str, Any]]) -> int:
    """Sum sizes of source files referenced in concat lists as a disk-space estimate."""
    total = 0
    seen: set = set()
    for cam_entry in plan:
        for d in (cam_entry.get('days') or []):
            lp_str = str(d.get('list_path') or d.get('concat_list') or '')
            if not lp_str:
                continue
            lp = Path(lp_str).expanduser()
            if not lp.exists():
                continue
            try:
                for line in lp.read_text(encoding='utf-8').splitlines():
                    line = line.strip()
                    if line.startswith('file '):
                        raw = line[5:].strip().strip("'\"")
                        p = Path(raw)
                        if p not in seen and p.exists():
                            seen.add(p)
                            total += p.stat().st_size
            except Exception as e:
                _log.warning("importer: error reading list file %s for size calculation: %s", lp, e)
    return total


def _encode_task_runner(ctx: TaskContext, payload: Dict[str, Any]) -> None:
    facility = str(payload.get('facility', '')).strip().lower()
    experiment = str(payload.get('experiment', '')).strip()
    treatment = str(payload.get('treatment', '')).strip()
    try:
        batch = int(payload.get('batch', 1))
    except Exception:
        batch = 1
    if batch < 0:
        batch = 0
    is_retry = bool(payload.get('is_retry', False))
    plan = payload.get('plan') or payload.get('lists') or []
    start_date = str(payload.get('start_date', '')).strip()
    end_date = str(payload.get('end_date', '')).strip()
    start_time = str(payload.get('start_time', '')).strip()
    end_time = str(payload.get('end_time', '')).strip()
    job_id = str(payload.get('job_id') or uuid.uuid4().hex)
    set_task_cancel_hook(ctx.task_id, lambda: _cancel_encode_job(job_id))
    if ctx.cancelled():
        update_task(ctx.task_id, status='CANCELLED', message='Cancelled')
        return

    facs = cfg_importer_facilities()
    if facility not in facs:
        update_task(ctx.task_id, status='FAILED', message='Unknown facility')
        return
    fac = facs[facility]
    out_base = str(payload.get('output_dir') or fac.get('output_dir') or '').strip() or str(cfg_importer_working_dir())
    base_dir = _resolve_output_dir(out_base, experiment, treatment)
    try:
        base_dir.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        update_task(ctx.task_id, status='FAILED', message=f'Cannot create output dir: {e}')
        return

    used_batches = _collect_used_batches(base_dir)
    if not is_retry and batch in used_batches:
        msg = f'Batch {batch} already exists in output folder'
        update_task(ctx.task_id, status='FAILED', message=msg, meta={'output_dir': str(base_dir), 'used_batches': used_batches})
        with ENCODE_LOCK:
            j = ENCODE_JOBS.get(job_id)
            if j:
                j['status'] = 'FAILED'
                j['message'] = msg
                j['used_batches'] = used_batches
        return

    if not _ffmpeg_exists():
        update_task(ctx.task_id, status='FAILED', message='ffmpeg not available')
        return

    # Disk space check — estimate from source file sizes (copy mode: output ≈ input)
    try:
        needed = _estimate_source_bytes(plan)
        free = shutil.disk_usage(str(base_dir)).free
        if needed > 0 and free < needed:
            msg = (f'Insufficient disk space: need ~{_format_bytes(needed)}, '
                   f'only {_format_bytes(free)} free on {base_dir}')
            update_task(ctx.task_id, status='FAILED', message=msg)
            with ENCODE_LOCK:
                j = ENCODE_JOBS.get(job_id)
                if j:
                    j['status'] = 'FAILED'
                    j['message'] = msg
            return
    except Exception as _dsk:
        _log.warning("importer: disk space check failed: %s", _dsk)

    # Expected window seconds per day
    day_expected: Dict[int, float] = {}
    try:
        for i, w in enumerate(_day_windows(start_date, end_date, start_time, end_time), start=1):
            day_expected[i] = (w['end'] - w['start']).total_seconds()
    except Exception:
        day_expected = {}

    # Health tolerance seconds (facility override or global default)
    try:
        tol = float(fac.get('health_tolerance_seconds')) if fac.get('health_tolerance_seconds') is not None else cfg_importer_health_tolerance_seconds()
        if tol < 0:
            tol = 0.0
    except Exception:
        tol = cfg_importer_health_tolerance_seconds()

    try:
        total = sum(
            1
            for cam_entry in plan
            for d in (cam_entry.get('days') or [])
            if int(d.get('segments') or 0) > 0 and str(d.get('status','')).upper() != 'MISSING'
        )
    except Exception:
        total = sum(len(cam_entry.get('days') or []) for cam_entry in plan)
    prog = 0
    for cam_entry in plan:
        for d in (cam_entry.get('days') or []):
            segs = int(d.get('segments') or 0) if 'segments' in d else 0
            st = str(d.get('status') or '').upper()
            if segs <= 0 or st == 'MISSING':
                continue
            if st in ('DONE', 'FAILED', 'CANCELLED'):
                prog += 1

    _prune_stale_jobs()
    with ENCODE_LOCK:
        ENCODE_JOBS[job_id] = {
            'id': job_id,
            'status': 'RUNNING',
            'progress': prog,
            'total': total,
            'plan': plan,
            'output_dir': str(base_dir),
            'cancel': False,
            'task_id': ctx.task_id,
            'created_at': time.time(),
        }

    results: List[Dict[str, Any]] = []
    base_plan: List[Dict[str, Any]] = plan

    def _snapshot_plan(cur_cam: Optional[int] = None, cur_days: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
        processed: Dict[int, Dict[int, Dict[str, Any]]] = {}
        for ce in results:
            c = int(ce.get('camera'))
            dmap: Dict[int, Dict[str, Any]] = {}
            for de in ce.get('days', []) or []:
                try:
                    dmap[int(de.get('day'))] = de
                except Exception:
                    pass
            processed[c] = dmap
        if cur_cam is not None and cur_days is not None:
            dmap = processed.get(int(cur_cam), {})
            for de in cur_days:
                try:
                    dmap[int(de.get('day'))] = de
                except Exception:
                    pass
            processed[int(cur_cam)] = dmap

        full: List[Dict[str, Any]] = []
        for bc in base_plan:
            cam_id = bc.get('camera')
            base_days = bc.get('days') or []
            out_days: List[Dict[str, Any]] = []
            done_map = processed.get(int(cam_id), {})
            for bd in base_days:
                try:
                    di = int(bd.get('day') or 0)
                except Exception:
                    di = 0
                if di in done_map:
                    out_days.append(done_map[di])
                else:
                    segs = int(bd.get('segments') or 0) if 'segments' in bd else 0
                    st = str(bd.get('status') or '').upper()
                    if st in ('DONE', 'FAILED', 'CANCELLED'):
                        out_days.append({**bd, 'status': st})
                    elif st == 'MISSING' or segs <= 0:
                        out_days.append({**bd, 'status': 'MISSING'})
                    else:
                        tmp = dict(bd)
                        tmp['status'] = 'PENDING'
                        out_days.append(tmp)
            full.append({'camera': cam_id, 'days': out_days})
        return full

    def _publish(status: Optional[str] = None, plan_state: Optional[List[Dict[str, Any]]] = None, message: Optional[str] = None) -> None:
        fields: Dict[str, Any] = {'total': total, 'progress': prog}
        if status:
            fields['status'] = status
        if message is not None:
            fields['message'] = message
        if plan_state is not None:
            fields['meta'] = {'plan': plan_state}
        update_task(ctx.task_id, **fields)
        with ENCODE_LOCK:
            j = ENCODE_JOBS.get(job_id)
            if j:
                if status:
                    j['status'] = status
                j['progress'] = prog
                j['plan'] = plan_state or j.get('plan')

    _publish(status='RUNNING', plan_state=_snapshot_plan())

    # ── Parallel day encoding ────────────────────────────────────────────────
    _state_lock = threading.Lock()
    prog_ref: List[int] = [prog]
    day_result_map: Dict[Tuple[int, int], Dict[str, Any]] = {}

    def _snap_par() -> List[Dict[str, Any]]:
        """Rebuild plan snapshot from day_result_map (called under _state_lock)."""
        full: List[Dict[str, Any]] = []
        for bc in base_plan:
            cam_id = bc.get('camera')
            snap_days: List[Dict[str, Any]] = []
            for bd in (bc.get('days') or []):
                try:
                    key: Tuple[int, int] = (int(cam_id), int(bd.get('day') or 0))
                except Exception:
                    key = (0, 0)
                if key in day_result_map:
                    snap_days.append(day_result_map[key])
                else:
                    segs = int(bd.get('segments') or 0) if 'segments' in bd else 0
                    st2 = str(bd.get('status') or '').upper()
                    if st2 in ('DONE', 'FAILED', 'CANCELLED'):
                        snap_days.append({**bd})
                    elif st2 == 'MISSING' or segs <= 0:
                        snap_days.append({**bd, 'status': 'MISSING'})
                    else:
                        snap_days.append({**bd, 'status': 'PENDING'})
            full.append({'camera': cam_id, 'days': snap_days})
        return full

    def _pub_par(status: Optional[str] = None, plan_state: Optional[List[Dict[str, Any]]] = None, message: Optional[str] = None) -> None:
        cur_prog = prog_ref[0]
        fields: Dict[str, Any] = {'total': total, 'progress': cur_prog}
        if status:
            fields['status'] = status
        if message is not None:
            fields['message'] = message
        if plan_state is not None:
            fields['meta'] = {'plan': plan_state}
        update_task(ctx.task_id, **fields)
        with ENCODE_LOCK:
            j = ENCODE_JOBS.get(job_id)
            if j:
                if status:
                    j['status'] = status
                j['progress'] = cur_prog
                j['plan'] = plan_state or j.get('plan')

    def _process_day_item(cam: Any, d: Dict[str, Any]) -> None:
        try:
            cam_int = int(cam)
        except Exception:
            cam_int = 0
        try:
            day_int = int(d.get('day') or 0)
        except Exception:
            day_int = 0
        key: Tuple[int, int] = (cam_int, day_int)

        list_path = Path(str(d.get('list_path') or '')).expanduser()
        segments = int(d.get('segments') or 0) if 'segments' in d else (
            0 if str(d.get('status', '')).upper() == 'MISSING' else 1)
        st = str(d.get('status') or '').upper()
        out_name = (list_path.name[:-4] + '.mp4') if list_path.name.endswith('.txt') else (
            f"{experiment}-{treatment}.exp{batch:03d}{cam}.day{day_int:02d}.cam{cam_int:02d}.mp4")
        out_path = base_dir.joinpath(out_name)

        # Already-finished items from a previous/retry run
        if segments <= 0 or st == 'MISSING':
            with _state_lock:
                day_result_map[key] = {'day': d.get('day'), 'status': 'MISSING', 'segments': 0,
                                       'output': str(out_path), 'list_path': str(list_path)}
            return
        if st in ('DONE', 'FAILED', 'CANCELLED'):
            with _state_lock:
                day_result_map[key] = {**d, 'output': str(out_path), 'list_path': str(list_path)}
            return

        # Idempotent: healthy output already exists from a previous run
        if out_path.exists():
            try:
                existing_meta = probe_media(out_path)
                existing_dur = existing_meta.get('duration') if isinstance(existing_meta, dict) else None
                if isinstance(existing_dur, (int, float)) and existing_dur > 0:
                    _day_num_chk = int(d.get('day') or 0)
                    exp_len_chk = day_expected.get(_day_num_chk)
                    healthy = (exp_len_chk is None) or (abs(existing_dur - exp_len_chk) <= float(tol))
                    if healthy:
                        skip_entry: Dict[str, Any] = {
                            **d, 'status': 'DONE', 'output': str(out_path),
                            'list_path': str(list_path), 'duration': existing_dur, 'skipped': True,
                        }
                        if exp_len_chk is not None:
                            delta_chk = existing_dur - exp_len_chk
                            skip_entry['health'] = {'expected': float(exp_len_chk), 'actual': existing_dur,
                                                    'delta': delta_chk, 'ok': True}
                        with _state_lock:
                            day_result_map[key] = skip_entry
                            prog_ref[0] += 1
                            snap = _snap_par()
                        _pub_par(plan_state=snap, message=f'Day {d.get("day")} cam {cam}: already encoded, skipping')
                        return
            except Exception as e:
                _log.warning("importer: error checking existing output for %s day %s: %s", cam, d.get('day'), e, exc_info=True)

        # Unhealthy or unreadable output exists — remove before re-encoding
        if out_path.exists():
            try:
                out_path.unlink()
                _log.info("importer: removed unhealthy/partial output %s before re-encode", out_path)
            except OSError as e:
                _log.warning("importer: could not remove partial output %s: %s", out_path, e)

        if not list_path.exists():
            with _state_lock:
                day_result_map[key] = {'day': d.get('day'), 'status': 'FAILED', 'segments': segments,
                                       'message': 'list not found', 'output': str(out_path), 'list_path': str(list_path)}
                prog_ref[0] += 1
                snap = _snap_par()
            _pub_par(plan_state=snap, message='List not found')
            return

        _ffmpeg_cmd = ' '.join([
            'ffmpeg', '-v', 'quiet', '-y', '-threads', '4',
            '-f', 'concat', '-safe', '0', '-i', str(list_path),
            '-vcodec', 'copy', '-an', '-copytb', '0',
            '-progress', 'pipe:1', str(out_path),
        ])
        with _state_lock:
            day_result_map[key] = {'day': d.get('day'), 'status': 'RUNNING', 'segments': segments,
                                   'output': str(out_path), 'list_path': str(list_path), 'cmd': _ffmpeg_cmd}
            snap = _snap_par()
        _pub_par(plan_state=snap)

        if _job_cancelled(job_id) or ctx.cancelled():
            with _state_lock:
                day_result_map[key] = {'day': d.get('day'), 'status': 'CANCELLED',
                                       'segments': segments, 'output': str(out_path)}
                snap = _snap_par()
            _pub_par(status='CANCELLED', plan_state=snap, message='Cancelled')
            return

        try:
            _day_num_key = int(d.get('day') or 0)
        except Exception:
            _day_num_key = 0
        total_dur = day_expected.get(_day_num_key) or _probe_concat_duration(list_path)
        code, msg, cancelled = _run_ffmpeg_concat_monitored(list_path, out_path, job_id, total_duration=total_dur)
        entry: Dict[str, Any] = {
            'day': d.get('day'),
            'status': ('CANCELLED' if cancelled else ('DONE' if code == 0 else 'FAILED')),
            'segments': segments, 'output': str(out_path),
            'ffmpeg': msg, 'list_path': str(list_path), 'cmd': _ffmpeg_cmd,
        }
        try:
            exp_len = day_expected.get(int(d.get('day') or 0))
            actual = None
            if out_path.exists():
                meta = probe_media(out_path)
                dur = meta.get('duration') if isinstance(meta, dict) else None
                if isinstance(dur, (int, float)):
                    actual = float(dur)
            if actual is not None:
                entry['duration'] = actual
            if exp_len is not None and actual is not None:
                delta = actual - float(exp_len)
                ok = abs(delta) <= float(tol)
                entry['health'] = {'expected': float(exp_len), 'actual': actual, 'delta': delta, 'ok': ok}
        except Exception as e:
            _log.warning("importer: error computing health for %s day %s: %s", out_path, d.get('day'), e)
        if (cancelled or code != 0) and out_path.exists():
            try:
                out_path.unlink()
            except OSError as _ue:
                _log.warning("importer: could not remove partial output %s: %s", out_path, _ue)
        if code == 0 and not cancelled:
            try:
                list_path.unlink(missing_ok=True)
            except OSError as _ue:
                _log.warning("importer: could not remove concat list %s: %s", list_path, _ue)

        with _state_lock:
            day_result_map[key] = entry
            if not cancelled:
                prog_ref[0] += 1
            snap = _snap_par()
        if cancelled:
            _pub_par(status='CANCELLED', plan_state=snap, message=msg or 'Cancelled')
        else:
            _pub_par(plan_state=snap, message=msg or '')

    # Flatten and submit all (cam, day) work items
    all_items: List[Tuple[Any, Dict[str, Any]]] = [
        (ce.get('camera'), d) for ce in plan for d in (ce.get('days') or [])
    ]
    with ThreadPoolExecutor(max_workers=_ENCODE_MAX_WORKERS) as executor:
        futs = {executor.submit(_process_day_item, cam, d): (cam, d) for cam, d in all_items}
        for fut in as_completed(futs):
            try:
                fut.result()
            except Exception as exc:
                _log.error("importer: day worker error: %s", exc, exc_info=True)

    # Build results list for _snapshot_plan (used in final publish)
    for ce in plan:
        cam = ce.get('camera')
        cam_days: List[Dict[str, Any]] = []
        for bd in (ce.get('days') or []):
            try:
                rkey: Tuple[int, int] = (int(cam), int(bd.get('day') or 0))
            except Exception:
                rkey = (0, 0)
            cam_days.append(day_result_map.get(rkey, bd))
        results.append({'camera': cam, 'days': cam_days})

    any_cancelled = any(
        str(v.get('status', '')).upper() == 'CANCELLED' for v in day_result_map.values()
    )
    final_plan = _snapshot_plan()
    _pub_par(status='CANCELLED' if any_cancelled else 'DONE', plan_state=final_plan)

def _set_job_proc(job_id: str, proc: Optional[subprocess.Popen], remove: bool = False) -> None:
    with ENCODE_LOCK:
        if proc is None or remove:
            if proc is not None:
                ENCODE_PROCS.get(job_id, set()).discard(proc)
            elif not remove:
                ENCODE_PROCS.pop(job_id, None)
        else:
            ENCODE_PROCS.setdefault(job_id, set()).add(proc)

# Background Scan/Prepare jobs (navigation-resumable)
SCAN_JOBS: Dict[str, Dict[str, Any]] = {}
SCAN_LOCK = threading.Lock()

def _cancel_scan_job(job_id: str) -> None:
    with SCAN_LOCK:
        job = SCAN_JOBS.get(job_id)
        if job:
            job['cancel'] = True


def _update_scan_task(job_id: str, **fields: Any) -> None:
    task_id = None
    with SCAN_LOCK:
        job = SCAN_JOBS.get(job_id)
        if job:
            task_id = job.get('task_id')
    if task_id:
        update_task(task_id, **fields)


def _job_cancelled(job_id: str) -> bool:
    with ENCODE_LOCK:
        j = ENCODE_JOBS.get(job_id)
        return bool(j and j.get('cancel'))


def _cancel_encode_job(job_id: str) -> None:
    with ENCODE_LOCK:
        job = ENCODE_JOBS.get(job_id)
        if job:
            job['cancel'] = True
        procs = set(ENCODE_PROCS.get(job_id) or [])
    for proc in procs:
        if proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass


def _run_ffmpeg_concat_monitored(
    list_file: Path, out_path: Path, job_id: str,
    total_duration: Optional[float] = None,
) -> tuple[int, str, bool]:
    """Run ffmpeg concat with progress reporting and cancellation support.
    Parses -progress pipe:1 output and writes frame/time/fps/speed into
    ENCODE_JOBS[job_id] so /encode_status can return live progress.
    Returns (returncode, message, cancelled_flag).
    """
    cmd = [
        'ffmpeg', '-v', 'quiet', '-y', '-threads', '4',
        '-f', 'concat', '-safe', '0', '-i', str(list_file),
        '-vcodec', 'copy', '-an', '-copytb', '0',
        '-progress', 'pipe:1',
        str(out_path),
    ]
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        _set_job_proc(job_id, p)   # adds to set
        _write_ffmpeg_pid(job_id, p.pid)
        with ENCODE_LOCK:
            j = ENCODE_JOBS.get(job_id)
            if j:
                j['current_cmd'] = ' '.join(cmd)
        cancelled = False
        err_buf: List[str] = []
        prog_block: Dict[str, str] = {}

        # Drain stderr in a background thread to prevent pipe-buffer deadlock.
        # If we read stdout (progress) and stderr alternately in one thread,
        # a full stderr buffer will block ffmpeg while we wait on stdout.readline().
        def _drain_stderr() -> None:
            try:
                for line in p.stderr:  # type: ignore[union-attr]
                    err_buf.append(line)
            except Exception:
                pass

        stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
        stderr_thread.start()

        # Seed total_duration in the job so the frontend can show it immediately
        if total_duration is not None:
            with ENCODE_LOCK:
                j = ENCODE_JOBS.get(job_id)
                if j:
                    j['current_total_duration'] = total_duration
                    j['current_frame'] = 0
                    j['out_time_us'] = 0
                    j['fps'] = 0.0
                    j['speed'] = ''

        while True:
            rc = p.poll()
            if rc is not None:
                break
            if _job_cancelled(job_id):
                try:
                    p.terminate()
                    try:
                        p.wait(timeout=3)
                    except Exception:
                        try:
                            p.kill()
                        except Exception as e:
                            _log.warning("importer: failed to kill ffmpeg pid %s: %s", p.pid, e)
                except Exception as e:
                    _log.warning("importer: failed to terminate ffmpeg pid %s: %s", p.pid, e)
                cancelled = True
                break
            try:
                line = p.stdout.readline() if p.stdout else ''
                if not line:
                    # stdout EOF or nothing yet — process has likely exited
                    time.sleep(0.05)
                    continue
                line = line.strip()
                if '=' in line:
                    k, _, v = line.partition('=')
                    prog_block[k.strip()] = v.strip()
                if line.startswith('progress='):
                    # One complete progress block received — update job
                    try:
                        frame = int(prog_block.get('frame', 0) or 0)
                        # ffmpeg emits INT64_MIN before first packet; clamp to 0
                        out_time_us = max(0, int(prog_block.get('out_time_us', 0) or 0))
                        fps_raw = prog_block.get('fps', '0')
                        try:
                            fps = float(fps_raw) if fps_raw not in ('', 'N/A') else 0.0
                        except ValueError:
                            fps = 0.0
                        # Parse speed ("1.23x", "3.07e+03x") → plain float
                        speed_raw = prog_block.get('speed', '')
                        try:
                            speed = float(speed_raw.rstrip('x')) if speed_raw not in ('', 'N/A') else 0.0
                        except (ValueError, AttributeError):
                            speed = 0.0
                        with ENCODE_LOCK:
                            j = ENCODE_JOBS.get(job_id)
                            if j:
                                j['current_frame'] = frame
                                j['out_time_us'] = out_time_us
                                j['fps'] = fps
                                j['speed'] = speed
                    except Exception:
                        pass
                    prog_block = {}
            except Exception:
                time.sleep(0.05)

        stderr_thread.join(timeout=5)

        # Clear per-file progress fields from job when done
        with ENCODE_LOCK:
            j = ENCODE_JOBS.get(job_id)
            if j:
                j.pop('current_frame', None)
                j.pop('out_time_us', None)
                j.pop('fps', None)
                j.pop('speed', None)
                j.pop('current_total_duration', None)

        msg = ''.join(err_buf).strip()
        rc = p.returncode if p.returncode is not None else 1
        return (rc, msg if msg else ('cancelled' if cancelled else ''), cancelled)
    except Exception as e:
        return (1, str(e), False)
    finally:
        _set_job_proc(job_id, p, remove=True)  # removes this proc from set
        try:
            _clear_ffmpeg_pid(job_id, p.pid)
        except Exception as e:
            _log.warning("importer: failed to clear ffmpeg PID for job %s: %s", job_id, e)


def _parse_time_from_path(p: Path, regex: str) -> Optional[datetime]:
    if not regex:
        return None
    try:
        s = p.as_posix()
        m = re.search(regex, s)
        if not m:
            return None
        gd = m.groupdict() if hasattr(m, 'groupdict') else {}
        year = int(gd.get('year')) if gd.get('year') else None
        month = int(gd.get('month')) if gd.get('month') else None
        day = int(gd.get('day')) if gd.get('day') else None
        hour = int(gd.get('hour')) if gd.get('hour') else 0
        minute = int(gd.get('minute')) if gd.get('minute') else 0
        second = int(gd.get('second')) if gd.get('second') else 0
        if year and month and day:
            return datetime(year, month, day, hour, minute, second)
        return None
    except Exception:
        return None

# -- Scan/Prepare background support --
def _scan_prepare_worker(job_id: str) -> None:
    with SCAN_LOCK:
        job = SCAN_JOBS.get(job_id)
    if not job:
        return
    with SCAN_LOCK:
        job = SCAN_JOBS.get(job_id)
        if job:
            job['status'] = 'RUNNING'
    _update_scan_task(job_id, status='RUNNING', message='Scanning source directories')
    try:
        params = job.get('params', {})
        facility = str(params.get('facility', '')).strip().lower()
        cameras = list(params.get('cameras') or [])
        camera_pattern_override = str(params.get('camera_pattern') or '').strip()
        start_date = str(params.get('start_date') or '').strip()
        end_date = str(params.get('end_date') or '').strip()
        start_time = str(params.get('start_time') or '').strip()
        end_time = str(params.get('end_time') or '').strip()
        experiment = str(params.get('experiment') or '').strip()
        treatment = str(params.get('treatment') or '').strip()
        batch = int(params.get('batch') or 1)

        facs = cfg_importer_facilities()
        fac = facs.get(facility) or {}
        source_dir = Path(fac.get('source_dir', '')).expanduser()
        exts = set(cfg_importer_source_exts())
        ig_pat = str(fac.get('ignore_dir_regex') or cfg_importer_ignore_dir_regex() or '')
        try:
            ig_re = re.compile(ig_pat) if ig_pat else None
        except re.error:
            ig_re = None
        ptre = str(fac.get('path_time_regex') or '')
        try:
            rx = re.compile(ptre) if ptre else None
        except re.error:
            rx = None

        win_start = _combine_date_time(start_date, start_time)
        win_end = _combine_date_time(end_date, end_time)
        ws = win_start if win_start else None
        we = win_end if win_end else None

        if not cameras:
            try:
                cameras = list(fac.get('camera_list') or [])
                cameras = [int(c) for c in cameras] if cameras else []
            except Exception:
                cameras = []
            if not cameras:
                try:
                    n = int(fac.get('cameras') or 0)
                except Exception:
                    n = 0
                cameras = list(range(1, max(0, n) + 1)) if n > 0 else []

        cam_pat = camera_pattern_override or fac.get('camera_pattern', '')

        def cancelled() -> bool:
            with SCAN_LOCK:
                return bool(SCAN_JOBS.get(job_id, {}).get('cancel', False))

        files: List[Dict[str, Any]] = []
        total = 0
        last_push = 0
        _update_scan_task(job_id, status='RUNNING', meta={'total': total})
        if source_dir.exists() and source_dir.is_dir():
            for cam in cameras:
                if cancelled(): break
                sub = _format_cam_glob(cam_pat or '{cam}', cam)
                root = source_dir.joinpath(sub)
                if not (root.exists() and root.is_dir()):
                    continue
                for cur, dirnames, filenames in os.walk(root):
                    if cancelled(): break
                    if ig_re:
                        try:
                            dirnames[:] = [d for d in dirnames if not ig_re.search(d)]
                        except Exception as e:
                            _log.warning("importer: error applying ignore_dir_regex in %s: %s", cur, e)
                    for fn in filenames:
                        if cancelled(): break
                        try:
                            if Path(fn).suffix.lower() not in exts:
                                continue
                            fp = os.path.join(cur, fn)
                            mr = False
                            if rx:
                                try:
                                    mr = bool(rx.search(Path(fp).as_posix()))
                                except Exception:
                                    mr = False
                            in_range = False
                            day_idx = None
                            start_iso = None
                            start_hms = None
                            try:
                                ts_name = _parse_start_from_stem(Path(fp).stem)
                                ts = ts_name or (_parse_time_from_path(Path(fp), ptre) if rx else None)
                                if ts:
                                    start_iso = ts.isoformat(sep=' ')
                                    start_hms = ts.strftime('%H:%M:%S')
                                    if ws is not None and we is not None:
                                        f_start = ts
                                        max_dur_sec = _parse_dur_to_seconds(fac.get('max_file_duration'))
                                        f_end = f_start + timedelta(seconds=max_dur_sec)
                                        in_range = _overlaps(f_start, f_end, ws, we)
                            except Exception:
                                pass
                            total += 1
                            files.append({'camera': cam, 'path': fp, 'match_regex': mr, 'in_range': in_range, 'day': day_idx, 'start': start_iso, 'start_hms': start_hms})
                            with SCAN_LOCK:
                                j = SCAN_JOBS.get(job_id)
                                if j:
                                    j['files'] = files[-2000:] if len(files) > 2000 else list(files)
                                    j['total'] = total
                            if total - last_push >= 200:
                                _update_scan_task(job_id, status='RUNNING', meta={'total': total})
                                last_push = total
                        except Exception as e:
                            _log.warning("importer: skipped file %s during scan: %s", fn, e, exc_info=True)
                            continue
        if cancelled():
            with SCAN_LOCK:
                j = SCAN_JOBS.get(job_id)
                if j:
                    j['status'] = 'CANCELLED'
            _update_scan_task(job_id, status='CANCELLED', meta={'total': total}, message='Scan cancelled')
            return
        try:
            plan = _prepare_plan_from_manifest(facility, experiment, treatment, batch, start_date, end_date, start_time, end_time, cameras, files)
            with SCAN_LOCK:
                j = SCAN_JOBS.get(job_id)
                if j:
                    j['plan'] = plan
                    j['status'] = 'DONE'
            _update_scan_task(job_id, status='DONE', meta={'plan': plan, 'total': total})
            with SCAN_LOCK:
                j = SCAN_JOBS.get(job_id)
                params = j.get('params', {}) if j else {}
            _persist_last_scan(params, plan)
        except Exception as e:
            with SCAN_LOCK:
                j = SCAN_JOBS.get(job_id)
                if j:
                    j['status'] = 'ERROR'
                    j['error'] = str(e)
            _update_scan_task(job_id, status='FAILED', message=str(e))
    except Exception as e:
        with SCAN_LOCK:
            j = SCAN_JOBS.get(job_id)
            if j:
                j['status'] = 'ERROR'
                j['error'] = str(e)
        _update_scan_task(job_id, status='FAILED', message=str(e))

def _prepare_plan_from_manifest(facility: str, experiment: str, treatment: str, batch: int, start_date: str, end_date: str, start_time: str, end_time: str, cameras: List[int], files: List[Dict[str, Any]]):
    facs = cfg_importer_facilities()
    fac = facs[facility]
    source_dir = Path(fac.get('source_dir', '')).expanduser()
    if not source_dir.exists() or not source_dir.is_dir():
        raise RuntimeError(f'Source folder not found: {source_dir}')
    day_windows = _day_windows(start_date, end_date, start_time, end_time)
    out_dir = _resolve_import_output_dir(facility, experiment, treatment)
    try:
        _ensure_dir(out_dir)
    except Exception as e:
        raise RuntimeError(f'Cannot create output dir: {e}')
    def _parse_dur_to_seconds(val: str | int | float | None) -> int:
        try:
            if isinstance(val, (int, float)):
                return max(0, int(val))
            s = str(val or '').strip()
            if not s:
                return 4 * 3600
            if ':' in s:
                hh, mm = s.split(':', 1)
                return max(0, int(hh) * 3600 + int(mm) * 60)
            return max(0, int(s))
        except Exception:
            return 4 * 3600
    max_dur_sec = _parse_dur_to_seconds(fac.get('max_file_duration'))
    by_cam: Dict[int, List[Dict[str, Any]]] = {c: [] for c in cameras}
    for f in files:
        if not isinstance(f, dict):
            raise RuntimeError('Invalid manifest entry')
        try:
            cam = int(f.get('camera'))
        except Exception:
            continue
        if cam not in by_cam:
            continue
        try:
            p = _resolve_manifest_source_path(source_dir, f.get('path'))
        except Exception as e:
            raise RuntimeError(f'Invalid manifest path for camera {cam}: {e}')
        ts = _parse_start_from_stem(p.stem) or _parse_time_from_path(p, str(fac.get('path_time_regex') or ''))
        if not ts:
            continue
        start_dt = ts
        by_cam[cam].append({'path': p, 'start': start_dt, 'end': start_dt + timedelta(seconds=float(max_dur_sec))})
    out: List[Dict[str, Any]] = []
    for cam in cameras:
        segs = by_cam.get(cam) or []
        if not segs:
            out.append({'camera': cam, 'days': [{'day': di, 'status': 'MISSING', 'segments': 0, 'list_path': str(out_dir.joinpath(f"{experiment}-{treatment}.exp{batch:03d}{cam}.day{di:02d}.cam{cam:02d}.txt"))} for di, _ in enumerate(day_windows, start=1)]})
            continue
        segs.sort(key=lambda s: s['start'])
        for i in range(len(segs)):
            if i+1 < len(segs):
                ns = segs[i+1]['start']
                if ns > segs[i]['start']:
                    segs[i]['end'] = min(segs[i]['end'], ns)
        cam_days: List[Dict[str, Any]] = []
        for di, win in enumerate(day_windows, start=1):
            ws = win['start']
            we = win['end']
            items: List[Dict[str, Any]] = []
            cover = ws
            for s in segs:
                if not _overlaps(s['start'], s['end'], ws, we):
                    continue
                eff_start = max(s['start'], ws, cover)
                eff_end = min(s['end'], we)
                if eff_start >= eff_end:
                    continue
                inpoint = max(0.0, (eff_start - s['start']).total_seconds())
                outpoint = None
                if eff_end < s['end']:
                    outpoint = max(0.0, (eff_end - s['start']).total_seconds())
                items.append({'path': str(s['path']).replace('\\', '/'), 'inpoint': inpoint, 'outpoint': outpoint})
                cover = eff_end
            list_name = f"{experiment}-{treatment}.exp{batch:03d}{cam}.day{di:02d}.cam{cam:02d}.txt"
            list_path = out_dir.joinpath(list_name)
            if items:
                _write_concat_list(list_path, items)
                cam_days.append({'day': di, 'status': 'PENDING', 'segments': len(items), 'list_path': str(list_path)})
            else:
                try:
                    with list_path.open('w', encoding='utf-8') as f:
                        pass
                except Exception as e:
                    _log.error("importer: failed to write empty concat list %s: %s", list_path, e, exc_info=True)
                cam_days.append({'day': di, 'status': 'MISSING', 'segments': 0, 'list_path': str(list_path)})
        out.append({'camera': cam, 'days': cam_days})
    return {'ok': True, 'tmp_dir': str(out_dir), 'plan': out}

@bp.route('/scan_prepare/start', methods=['POST'])
def api_scan_prepare_start():
    req = request.json or {}
    facility = str(req.get('facility', '')).strip().lower()
    experiment = str(req.get('experiment', '')).strip()
    treatment = str(req.get('treatment', '')).strip()
    start_date = str(req.get('start_date', '')).strip()
    end_date = str(req.get('end_date', '')).strip()
    start_time = str(req.get('start_time', '')).strip()
    end_time = str(req.get('end_time', '')).strip()
    cameras = req.get('cameras') or []
    try:
        cams = sorted({int(c) for c in cameras})
    except Exception:
        cams = []
    if not facility or not experiment or not treatment:
        return jsonify({'error': 'Missing required params'}), 400
    job_id = uuid.uuid4().hex
    with SCAN_LOCK:
        SCAN_JOBS[job_id] = {
            'id': job_id,
            'status': 'QUEUED',
            'params': {
                'facility': facility, 'experiment': experiment, 'treatment': treatment,
                'start_date': start_date, 'end_date': end_date, 'start_time': start_time, 'end_time': end_time,
                'cameras': cams, 'camera_pattern': str(req.get('camera_pattern') or ''), 'batch': int(req.get('batch') or 1),
            },
            'files': [], 'total': 0, 'cancel': False,
        }
    task_payload = {
        'job_id': job_id,
        'params': {
            'facility': facility, 'experiment': experiment, 'treatment': treatment,
            'start_date': start_date, 'end_date': end_date, 'start_time': start_time, 'end_time': end_time,
            'cameras': cams, 'camera_pattern': str(req.get('camera_pattern') or ''), 'batch': int(req.get('batch') or 1),
        },
    }
    task_entry = enqueue_task(
        title=f"Scan {facility} {experiment}-{treatment}",
        kind='import.scan',
        runner=lambda ctx, payload=task_payload: _scan_task_runner(ctx, payload),
        total=0,
        meta={'params': task_payload['params']},
        payload=task_payload,
        on_cancel=lambda: _cancel_scan_job(job_id),
    )
    with SCAN_LOCK:
        SCAN_JOBS[job_id]['task_id'] = task_entry['id']
    return jsonify({'ok': True, 'job_id': job_id})

@bp.route('/scan_prepare/status')
def api_scan_prepare_status():
    job_id = (request.args.get('job') or '').strip()
    if not job_id:
        return jsonify({'error': 'Missing job'}), 400
    with SCAN_LOCK:
        job = SCAN_JOBS.get(job_id)
        if not job:
            job = None
        if job:
            out = {k: job.get(k) for k in ('id','status','total','files','error') if k in job}
            if 'plan' in job:
                out['plan'] = job['plan']
            if job.get('task_id'):
                out['task_id'] = job.get('task_id')
            return jsonify(out)
    task = _find_task_by_payload('import.scan', 'job_id', job_id)
    if task:
        meta = task.get('meta') or {}
        resp = {
            'id': job_id,
            'status': task.get('status'),
            'total': meta.get('total', 0),
            'files': meta.get('files', []),
            'error': task.get('message'),
            'plan': meta.get('plan'),
            'task_id': task.get('id'),
        }
        return jsonify(resp)
    return jsonify({'error': 'Not found'}), 404

@bp.route('/scan_prepare/cancel', methods=['POST'])
def api_scan_prepare_cancel():
    job_id = (request.args.get('job') or '').strip()
    if not job_id:
        return jsonify({'error': 'Missing job'}), 400
    task_id = None
    with SCAN_LOCK:
        job = SCAN_JOBS.get(job_id)
        if job:
            job['cancel'] = True
            task_id = job.get('task_id')
        else:
            job = None
    if not job:
        task = _find_task_by_payload('import.scan', 'job_id', job_id)
        if not task:
            return jsonify({'error': 'Not found'}), 404
        task_id = task.get('id')
    if task_id:
        try:
            cancel_task_record(task_id)
        except Exception as e:
            _log.warning("importer: failed to cancel task record %s: %s", task_id, e)
    return jsonify({'ok': True})

@bp.route('/scan_prepare/last')
def api_scan_prepare_last():
    """Return the most recently completed scan plan saved to disk."""
    data = _load_last_scan()
    if not data:
        return jsonify({'ok': False, 'reason': 'no_saved_scan'})
    return jsonify({'ok': True, 'params': data.get('params', {}),
                    'plan': data.get('plan'), 'saved_at': data.get('saved_at')})


@bp.route('/scan_prepare/current')
def api_scan_prepare_current():
    with SCAN_LOCK:
        for jid, job in SCAN_JOBS.items():
            if job.get('status') in ('QUEUED','RUNNING'):
                return jsonify({'ok': True, 'job_id': jid})
    return jsonify({'ok': True, 'job_id': None})
    try:
        m = re.search(regex, p.as_posix())
        if not m:
            return None
        gd = m.groupdict()
        y = int(gd.get('year')) if gd.get('year') else None
        mo = int(gd.get('month')) if gd.get('month') else 1
        d = int(gd.get('day')) if gd.get('day') else 1
        hh = int(gd.get('hour')) if gd.get('hour') else 0
        mm = int(gd.get('minute')) if gd.get('minute') else 0
        ss = int(gd.get('second')) if gd.get('second') else 0
        if not y:
            return None
        return datetime(y, mo, d, hh, mm, ss)
    except Exception:
        return None


def _file_time_range_with_regex(path: Path, regex: str) -> Optional[tuple[datetime, datetime]]:
    meta = probe_media(path)
    if not meta.get('available') or meta.get('error'):
        return None
    dur = meta.get('duration')
    if not isinstance(dur, (int, float)) or dur <= 0:
        return None
    start_dt = _parse_time_from_path(path, regex)
    if not start_dt:
        return None
    end_dt = start_dt + timedelta(seconds=float(dur))
    return (start_dt, end_dt)


def _parse_start_from_stem(stem: str) -> Optional[datetime]:
    """Parse start datetime from filename stem.
    Pattern: <camera>-<YYYYMMDD>-<HHMMSS>-<epoch_ms>-<seq>
    Epoch field is ignored; YYYYMMDD-HHMMSS is the source of truth.
    """
    try:
        parts = stem.split('-')
        if len(parts) < 3:
            return None
        date_s = parts[1]
        time_s = parts[2]
        if len(date_s) != 8 or len(time_s) != 6:
            return None
        # Fallback to second resolution
        y = int(date_s[0:4])
        mo = int(date_s[4:6])
        d = int(date_s[6:8])
        hh = int(time_s[0:2])
        mm = int(time_s[2:4])
        ss = int(time_s[4:6])
        return datetime(y, mo, d, hh, mm, ss)
    except Exception:
        return None


def _resolve_import_output_dir(facility: str, experiment: str, treatment: str) -> Path:
    out_base = ''
    try:
        facs = cfg_importer_facilities()
        fac = facs.get(str(facility or '').lower()) if isinstance(facs, dict) else None
        if fac:
            out_base = str(fac.get('output_dir') or '').strip()
    except Exception:
        out_base = ''
    if not out_base:
        out_base = str(cfg_importer_working_dir())
    return _resolve_output_dir(out_base, experiment, treatment)


def _batch_from_exp_name(name: str) -> Optional[int]:
    m = re.search(r"\.exp(\d{3,})", name, re.IGNORECASE)
    if not m:
        return None
    digits = m.group(1)
    if len(digits) < 3:
        return None
    try:
        return int(digits[:3])
    except Exception:
        return None


def _collect_used_batches(base_dir: Path) -> List[int]:
    used = set()
    try:
        if not base_dir.exists() or not base_dir.is_dir():
            return []
        for p in base_dir.iterdir():
            if not p.is_file():
                continue
            # Skip concat-list .txt files written during scan/prepare — only
            # actual encoded output files (e.g. .mp4, .avi) count as a used batch
            if p.suffix.lower() in ('.txt', '.src', '.log', '.json'):
                continue
            b = _batch_from_exp_name(p.name)
            if b is not None:
                used.add(b)
    except Exception:
        return []
    return sorted(used)


def _next_batch_number(exp: str, trt: str, facility: str = '') -> int:
    base = _resolve_import_output_dir(facility, exp, trt)
    used = _collect_used_batches(base)
    return (max(used) + 1) if used else 1


def _format_bytes(n: int) -> str:
    step = 1024.0
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if n < step:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= step
    return f"{n:.1f} PB"


@bp.app_template_filter('filesize')
def filesize(n):
    try:
        return _format_bytes(int(n))
    except Exception:
        return str(n)


@bp.route('/start', methods=['POST'])
def api_import_start():
    payload = request.json or {}
    facility = str(payload.get('facility', '')).strip().lower()
    exp_name = str(payload.get('experiment', '')).strip().upper()
    treatment = str(payload.get('treatment', '')).strip().lower()
    start_date = str(payload.get('start_date', '')).strip()
    end_date = str(payload.get('end_date', '')).strip()
    start_time = str(payload.get('start_time', '')).strip()
    end_time = str(payload.get('end_time', '')).strip()
    cameras = payload.get('cameras', []) or []
    regex_override = str(payload.get('path_time_regex', '') or '').strip()
    camera_pattern_override = str(payload.get('camera_pattern', '') or '').strip()
    dry_run = bool(payload.get('dry_run', False))
    async_requested = bool(payload.get('async', True))

    facs = cfg_importer_facilities()
    if facility not in facs:
        return jsonify({'error': 'Unknown facility'}), 400
    if not exp_name or not treatment:
        return jsonify({'error': 'Missing experiment or treatment'}), 400
    windows = _day_windows(start_date, end_date, start_time, end_time)
    if not windows:
        return jsonify({'error': 'Invalid date/time range'}), 400
    try:
        cams = sorted({int(c) for c in cameras})
    except Exception:
        return jsonify({'error': 'Invalid cameras'}), 400
    if not cams:
        return jsonify({'error': 'No cameras selected'}), 400

    fac = facs[facility]
    try:
        allowed = set(int(x) for x in (fac.get('camera_list') or []))
    except Exception:
        allowed = set()
    if allowed and not set(cams).issubset(allowed):
        return jsonify({'error': 'Selected cameras not allowed for facility', 'allowed': sorted(allowed)}), 400
    source_dir = Path(fac.get('source_dir', '')).expanduser()
    if not source_dir.exists():
        return jsonify({'error': 'Source folder not found', 'path': str(source_dir)}), 400
    work_base = cfg_importer_working_dir().joinpath(exp_name, treatment)
    _ensure_dir(work_base)

    exts = cfg_importer_source_exts()
    can_async = async_requested and _ffmpeg_exists() and not dry_run

    jobs: List[Dict[str, Any]] = []
    ptre = regex_override or fac.get('path_time_regex', '')
    batch = int(payload.get('batch', 1))
    if batch < 0:
        batch = 0
    used_batches = _collect_used_batches(work_base)
    if batch in used_batches:
        return jsonify({
            'error': f'Batch {batch} already exists in output folder',
            'output_dir': str(work_base),
            'used_batches': used_batches,
        }), 409
    for cam in cams:
        files = _iter_files_for_camera(source_dir, cam, exts, camera_pattern_override or fac.get('camera_pattern', ''))
        timeline: List[Dict[str, Any]] = []
        for f in files:
            tr = _file_time_range_with_regex(f, ptre) or _file_time_range(f)
            if not tr:
                continue
            timeline.append({'path': f, 'start': tr[0], 'end': tr[1]})
        if not timeline:
            jobs.append({'camera': cam, 'days': [], 'warning': 'No files found'})
            continue
        timeline.sort(key=lambda x: x['start'])

        day_entries: List[Dict[str, Any]] = []
        for di, win in enumerate(windows, start=1):
            ws = win['start']
            we = win['end']
            segs = [s for s in timeline if _overlaps(s['start'], s['end'], ws, we)]
            items: List[Dict[str, Any]] = []
            if segs:
                for s in segs:
                    inpoint = max(0.0, (ws - s['start']).total_seconds())
                    outpoint = None
                    if s['end'] > we:
                        outpoint = max(0.0, (we - s['start']).total_seconds())
                    items.append({'path': str(s['path']).replace('\\\\', '/'), 'inpoint': inpoint, 'outpoint': outpoint})
            out_name = f"{exp_name}-{treatment}.exp{batch:04d}.day{di:02d}.cam{cam:02d}{exts[0]}"
            out_path = work_base.joinpath(out_name)
            # Write concat list next to the output, appending .src (keep original extension)
            list_path = Path(str(out_path) + '.src')
            if items:
                try:
                    _write_concat_list(list_path, items)
                except Exception as e:
                    return jsonify({'error': f'Failed to write list: {e}', 'path': str(list_path)}), 500
                if can_async:
                    status = 'PENDING'
                    msg = 'Queued for background import'
                elif not dry_run and _ffmpeg_exists():
                    code, msg = _run_ffmpeg_concat(list_path, out_path)
                    status = 'DONE' if code == 0 else 'FAILED'
                    if code == 0:
                        try:
                            list_path.unlink(missing_ok=True)
                        except OSError as _ue:
                            _log.warning("importer: could not remove concat list %s: %s", list_path, _ue)
                else:
                    status = 'PLANNED' if items else 'SKIPPED'
                    msg = 'dry-run or ffmpeg not available'
            else:
                status = 'EMPTY'
                msg = 'No overlapping files for this window'
            day_entries.append({
                'day': di,
                'concat_list': str(list_path),
                'output': str(out_path),
                'segments': len(items),
                'status': status,
                'message': msg,
            })
        jobs.append({'camera': cam, 'days': day_entries})

    plan = {
        'ok': True,
        'working_dir': str(work_base),
        'ffmpeg': _ffmpeg_exists(),
        'jobs': jobs,
    }
    if can_async:
        total_steps = _task_total_steps(plan)
        task = enqueue_task(
            title=f"Import {exp_name}-{treatment} batch {batch}",
            kind='import.concat',
            runner=partial(_run_import_job, plan=plan),
            total=total_steps,
            meta={'plan': plan},
            payload={'plan': plan},
        )
        return jsonify({'ok': True, 'job_id': task['id'], 'task_id': task['id'], **plan})
    return jsonify(plan)


@bp.route('/status')
def api_import_status():
    job_id = request.args.get('job', '').strip()
    if not job_id:
        return jsonify({'error': 'Missing job id'}), 400
    task = get_task(job_id)
    if task:
        meta = task.get('meta') or {}
        resp = {
            'id': task.get('id'),
            'status': task.get('status'),
            'progress': task.get('progress', 0),
            'total': task.get('total', 0),
            'message': task.get('message', ''),
        }
        if 'plan' in meta:
            resp['plan'] = meta['plan']
        return jsonify({'ok': True, **resp})
    return jsonify({'error': 'Job not found'}), 404


@bp.route('/test_regex', methods=['POST'])
def api_import_test_regex():
    payload = request.json or {}
    regex = str(payload.get('regex', '') or '').strip()
    sample = str(payload.get('sample', '') or '').strip()
    if not regex:
        return jsonify({'error': 'Missing regex'}), 400
    if not sample:
        return jsonify({'error': 'Missing sample path'}), 400
    try:
        ts = _parse_time_from_path(Path(sample), regex)
        if ts:
            return jsonify({'ok': True, 'timestamp': ts.isoformat(), 'year': ts.year, 'month': ts.month, 'day': ts.day, 'hour': ts.hour, 'minute': ts.minute, 'second': ts.second})
        m = re.search(regex, Path(sample).as_posix())
        if m:
            return jsonify({'ok': False, 'message': 'Matched but missing required groups (year)', 'groups': m.groupdict()})
        return jsonify({'ok': False, 'message': 'No match'})
    except re.error as e:
        return jsonify({'error': f'Invalid regex: {e}'}), 400


@bp.route('/next_batch')
def api_import_next_batch():
    exp = (request.args.get('experiment') or '').strip()
    trt = (request.args.get('treatment') or '').strip()
    facility = (request.args.get('facility') or '').strip().lower()
    req_batch = (request.args.get('batch') or '').strip()
    if not exp or not trt:
        return jsonify({'error': 'Missing experiment or treatment'}), 400
    base_dir = _resolve_import_output_dir(facility, exp, trt)
    used = _collect_used_batches(base_dir)
    nb = (max(used) + 1) if used else 1
    resp: Dict[str, Any] = {'ok': True, 'next_batch': nb, 'used_batches': used, 'output_dir': str(base_dir)}
    if req_batch:
        try:
            b = int(req_batch)
            resp['available'] = b not in used
        except Exception:
            return jsonify({'error': 'Invalid batch'}), 400
    return jsonify(resp)


__all__ = ['bp']


def _parse_date_folder(name: str) -> Optional[str]:
    """Extract ISO date from folder names like YYYYMMDDXX → 'YYYY-MM-DD', or None."""
    m = re.match(r'^(\d{4})(\d{2})(\d{2})', name)
    if not m:
        return None
    try:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        datetime(y, mo, d)
        return f"{y:04d}-{mo:02d}-{d:02d}"
    except Exception:
        return None


@bp.route('/browse_source')
def api_import_browse_source():
    """Browse source directory: return camera folders and date subfolders with file counts."""
    facility = str((request.args.get('facility') or '').strip().lower())
    facs = cfg_importer_facilities()
    if facility not in facs:
        return jsonify({'error': 'Unknown facility'}), 400
    fac = facs[facility]
    source_dir = Path(fac.get('source_dir', '')).expanduser()
    if not source_dir.exists() or not source_dir.is_dir():
        return jsonify({'error': 'Source folder not found', 'path': str(source_dir)}), 400

    exts = set(cfg_importer_source_exts())
    cam_pat = str(fac.get('camera_pattern', '') or '')

    try:
        cam_list = [int(c) for c in (fac.get('camera_list') or [])]
    except Exception:
        cam_list = []
    if not cam_list:
        try:
            n = int(fac.get('cameras') or 0)
            cam_list = list(range(1, n + 1)) if n > 0 else []
        except Exception:
            cam_list = []

    cameras = []
    for cam in cam_list:
        sub = _format_cam_glob(cam_pat or '{cam}', cam)
        root = source_dir / sub
        if not root.exists() or not root.is_dir():
            cameras.append({'camera': cam, 'folder': sub, 'exists': False, 'date_folders': []})
            continue

        date_folders = []
        try:
            for child in sorted(root.iterdir()):
                if not child.is_dir():
                    continue
                file_count = sum(
                    1 for f in child.iterdir()
                    if f.is_file() and f.suffix.lower() in exts
                )
                folder_date = _parse_date_folder(child.name)
                date_folders.append({
                    'name': child.name,
                    'date': folder_date,
                    'file_count': file_count,
                })
        except Exception as e:
            _log.error("importer: error scanning date folders for cam %s in %s: %s", cam, sub, e, exc_info=True)

        cameras.append({'camera': cam, 'folder': sub, 'exists': True, 'date_folders': date_folders})

    return jsonify({'ok': True, 'source_dir': str(source_dir), 'cameras': cameras})


@bp.route('/browse_folder')
def api_import_browse_folder():
    """List video files in source_dir/camera_folder/date_subfolder."""
    facility = str((request.args.get('facility') or '').strip().lower())
    try:
        camera = int(request.args.get('camera', '0'))
    except (ValueError, TypeError):
        return jsonify({'error': 'Invalid camera'}), 400
    subfolder = str(request.args.get('subfolder') or '').strip()
    if not subfolder:
        return jsonify({'error': 'subfolder required'}), 400

    facs = cfg_importer_facilities()
    if facility not in facs:
        return jsonify({'error': 'Unknown facility'}), 400
    fac = facs[facility]
    source_dir = Path(fac.get('source_dir', '')).expanduser()
    cam_pat = str(fac.get('camera_pattern', '') or '')
    cam_folder = _format_cam_glob(cam_pat or '{cam}', camera)
    folder_path = source_dir / cam_folder / subfolder

    if not folder_path.exists() or not folder_path.is_dir():
        return jsonify({'error': 'Folder not found', 'path': str(folder_path)}), 400

    exts = set(cfg_importer_source_exts())
    files = []
    try:
        for p in sorted(folder_path.iterdir()):
            if p.is_file() and p.suffix.lower() in exts:
                ts = _parse_start_from_stem(p.stem)
                try:
                    size = p.stat().st_size
                except OSError:
                    size = None
                files.append({
                    'name': p.name,
                    'size': size,
                    'timestamp': ts.strftime('%H:%M:%S') if ts else None,
                })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    return jsonify({'ok': True, 'files': files, 'folder': str(folder_path)})


@bp.route('/check_source')
def api_import_check_source():
    """Verify that a facility's source_dir exists and is accessible."""
    facility = str((request.args.get('facility') or '').strip().lower())
    facs = cfg_importer_facilities()
    if facility not in facs:
        return jsonify({'error': 'Unknown facility'}), 400
    fac = facs[facility]
    source_dir = Path(fac.get('source_dir', '')).expanduser()
    if not source_dir.exists() or not source_dir.is_dir():
        return jsonify({'error': 'Source folder not found', 'path': str(source_dir)}), 400
    # Optionally check readability by attempting to list a small iterator
    try:
        next(source_dir.iterdir()) if source_dir.exists() else None
    except Exception as e:
        return jsonify({'error': f'Cannot access source folder: {e}', 'path': str(source_dir)}), 400
    return jsonify({'ok': True, 'path': str(source_dir)})



@bp.route('/scan', methods=['GET', 'POST'])
def api_import_scan():
    """Scan a facility's source_dir for files matching its camera_glob.
    Returns a flat list of files with associated camera indices.
    """
    if request.method == 'POST':
        payload = request.json or {}
        facility = str(payload.get('facility', '')).strip().lower()
        camera_pattern_override = str(payload.get('camera_pattern', '') or '').strip()
    else:
        facility = str((request.args.get('facility') or '').strip().lower())
        camera_pattern_override = str((request.args.get('camera_pattern') or '').strip())

    facs = cfg_importer_facilities()
    if facility not in facs:
        return jsonify({'error': 'Unknown facility'}), 400

    fac = facs[facility]
    source_dir = Path(fac.get('source_dir', '')).expanduser()
    if not source_dir.exists() or not source_dir.is_dir():
        return jsonify({'error': 'Source folder not found', 'path': str(source_dir)}), 400

    exts = cfg_importer_source_exts()
    try:
        cam_list = list(fac.get('camera_list') or [])
        cam_list = [int(c) for c in cam_list] if cam_list else []
    except Exception:
        cam_list = []
    if not cam_list:
        # fallback to 1..cameras
        try:
            n = int(fac.get('cameras') or 0)
        except Exception:
            n = 0
        cam_list = list(range(1, max(0, n) + 1)) if n > 0 else []

    cam_pat = camera_pattern_override or fac.get('camera_pattern', '')

    results: List[Dict[str, Any]] = []
    total = 0
    for cam in cam_list:
        files = _iter_files_for_camera(source_dir, cam, exts, cam_pat)
        files.sort()
        for f in files:
            results.append({'camera': cam, 'path': str(f)})
        total += len(files)

    return jsonify({
        'ok': True,
        'facility': facility,
        'source_dir': str(source_dir),
        'camera_pattern': cam_pat,
        'extensions': exts,
        'total': total,
        'files': results,
    })


def _sse_event(event: str, data: Dict[str, Any]) -> str:
    import json as _json
    return f"event: {event}\n" + "data: " + _json.dumps(data, default=str) + "\n\n"


@bp.route('/scan_stream')
def api_import_scan_stream():
    """Stream a scan by walking camera-specific root folders and reporting progress.
    Query params: facility, cameras=1,2,3, camera_pattern (optional override)
    Emits SSE events: 'dir' with current directory, 'file' per discovered file, and 'done' summary.
    Respects optional ignore_dir_regex from config/facility.
    """
    facility = str((request.args.get('facility') or '').strip().lower())
    cams_param = (request.args.get('cameras') or '').strip()
    camera_pattern_override = str((request.args.get('camera_pattern') or '').strip())

    facs = cfg_importer_facilities()
    if facility not in facs:
        return jsonify({'error': 'Unknown facility'}), 400
    fac = facs[facility]
    source_dir = Path(fac.get('source_dir', '')).expanduser()
    if not source_dir.exists() or not source_dir.is_dir():
        return jsonify({'error': 'Source folder not found', 'path': str(source_dir)}), 400

    exts = set(cfg_importer_source_exts())
    ig_pat = str(fac.get('ignore_dir_regex') or cfg_importer_ignore_dir_regex() or '')
    try:
        ig_re = re.compile(ig_pat) if ig_pat else None
    except re.error:
        ig_re = None

    # Cameras
    try:
        if cams_param:
            cam_list = [int(x) for x in cams_param.split(',') if x.strip()]
        else:
            cam_list = list(fac.get('camera_list') or [])
            if not cam_list:
                n = int(fac.get('cameras') or 0)
                cam_list = list(range(1, max(0, n) + 1)) if n > 0 else []
    except Exception:
        cam_list = []

    cam_pat = camera_pattern_override or fac.get('camera_pattern', '')

    def walker():
        total_files = 0
        roots = []
        # Resolve camera roots by formatting pattern
        for cam in cam_list:
            sub = _format_cam_glob(cam_pat or '{cam}', cam)
            if not sub:
                continue
            p = source_dir.joinpath(sub)
            roots.append((cam, p))
        # Walk each root sequentially
        for cam, root in roots:
            if not root.exists() or not root.is_dir():
                yield _sse_event('dir', {'camera': cam, 'path': str(root), 'exists': False})
                continue
            for cur, dirnames, filenames in os.walk(root):
                # Report current directory
                yield _sse_event('dir', {'camera': cam, 'path': cur, 'exists': True})
                # Apply ignore-dir regex
                if ig_re:
                    dirnames[:] = [d for d in dirnames if not ig_re.search(d)]
                # Collect files
                for fn in filenames:
                    if Path(fn).suffix.lower() in exts:
                        fp = os.path.join(cur, fn)
                        total_files += 1
                        yield _sse_event('file', {'camera': cam, 'path': fp})
        yield _sse_event('done', {'ok': True, 'total': total_files})

    return Response(stream_with_context(walker()), mimetype='text/event-stream')


@bp.route('/make_day_lists', methods=['POST'])
def api_import_make_day_lists():
    """Create per-day ffmpeg concat list files in the system temp folder.
    Body JSON:
      facility, cameras [list], start_date, end_date, start_time, end_time,
      optional: camera_pattern
    Returns JSON with created list file paths per camera/day and segment counts.
    """
    payload = request.json or {}
    facility = str(payload.get('facility', '')).strip().lower()
    start_date = str(payload.get('start_date', '')).strip()
    end_date = str(payload.get('end_date', '')).strip()
    start_time = str(payload.get('start_time', '')).strip()
    end_time = str(payload.get('end_time', '')).strip()
    camera_pattern_override = str(payload.get('camera_pattern', '') or '').strip()
    try:
        cameras = sorted({int(c) for c in (payload.get('cameras') or [])})
    except Exception:
        return jsonify({'error': 'Invalid cameras'}), 400

    day_windows = _day_windows(start_date, end_date, start_time, end_time)
    if not day_windows:
        return jsonify({'error': 'Invalid date/time range'}), 400

    facs = cfg_importer_facilities()
    if facility not in facs:
        return jsonify({'error': 'Unknown facility'}), 400
    fac = facs[facility]
    source_dir = Path(fac.get('source_dir', '')).expanduser()
    if not source_dir.exists() or not source_dir.is_dir():
        return jsonify({'error': 'Source folder not found', 'path': str(source_dir)}), 400

    exts = set(cfg_importer_source_exts())
    ig_pat = str(fac.get('ignore_dir_regex') or cfg_importer_ignore_dir_regex() or '')
    try:
        ig_re = re.compile(ig_pat) if ig_pat else None
    except re.error:
        ig_re = None

    # duration fallback
    def _parse_dur_to_seconds(val: str | int | float | None) -> int:
        try:
            if isinstance(val, (int, float)):
                return max(0, int(val))
            s = str(val or '').strip()
            if not s:
                return 4 * 3600
            if ':' in s:
                hh, mm = s.split(':', 1)
                return max(0, int(hh) * 3600 + int(mm) * 60)
            return max(0, int(s))
        except Exception:
            return 4 * 3600

    max_dur_sec = _parse_dur_to_seconds(fac.get('max_file_duration'))
    cam_pat = camera_pattern_override or fac.get('camera_pattern', '')

    # Build a timeline per camera
    results: List[Dict[str, Any]] = []
    tmp_dir = Path(tempfile.gettempdir())

    for cam in cameras:
        # Gather files under camera root
        segments: List[Dict[str, Any]] = []
        try:
            sub = _format_cam_glob(cam_pat or '{cam}', cam)
            root = source_dir.joinpath(sub)
            if not (root.exists() and root.is_dir()):
                results.append({'camera': cam, 'days': [], 'warning': f'Camera root not found: {root}'})
                continue
            for cur, dirnames, filenames in os.walk(root):
                if ig_re:
                    dirnames[:] = [d for d in dirnames if not ig_re.search(d)]
                for fn in filenames:
                    p = Path(cur) / fn
                    if p.suffix.lower() not in exts:
                        continue
                    ts = _parse_start_from_stem(p.stem) or _parse_time_from_path(p, str(fac.get('path_time_regex') or ''))
                    if not ts:
                        continue
                    # actual duration if available
                    # Avoid expensive per-file probing here for responsiveness.
                    # Use facility max duration as an upper bound; concat demuxer will stop at file end.
                    start_dt = ts
                    segments.append({'path': p, 'start': start_dt, 'end': start_dt + timedelta(seconds=float(max_dur_sec))})
        except Exception as e:
            _log.error("importer: error walking source directory for cam %s: %s", cam, e, exc_info=True)

        if not segments:
            results.append({'camera': cam, 'days': [], 'warning': 'No files found'})
            continue
        segments.sort(key=lambda s: s['start'])
        # Adjust segment end to the next segment's start to avoid overlap
        for i in range(len(segments)):
            if i+1 < len(segments):
                ns = segments[i+1]['start']
                if ns > segments[i]['start']:
                    segments[i]['end'] = min(segments[i]['end'], ns)
        # Build per-day items and write list file per day
        day_entries: List[Dict[str, Any]] = []
        for di, win in enumerate(day_windows, start=1):
            ws = win['start']
            we = win['end']
            items: List[Dict[str, Any]] = []
            cover = ws
            for s in segments:
                if not _overlaps(s['start'], s['end'], ws, we):
                    continue
                eff_start = max(s['start'], ws, cover)
                eff_end = min(s['end'], we)
                if eff_start >= eff_end:
                    continue
                inpoint = max(0.0, (eff_start - s['start']).total_seconds())
                outpoint = None
                if eff_end < s['end']:
                    outpoint = max(0.0, (eff_end - s['start']).total_seconds())
                items.append({'path': str(s['path']).replace('\\\\', '/'), 'inpoint': inpoint, 'outpoint': outpoint})
                cover = eff_end

            list_path = tmp_dir.joinpath(f"{facility}.cam{cam:02d}.day{di:02d}.src")
            if items:
                try:
                    _write_concat_list(list_path, items)
                except Exception as e:
                    return jsonify({'error': f'Failed to write list: {e}', 'path': str(list_path)}), 500
                day_entries.append({'day': di, 'segments': len(items), 'list_path': str(list_path)})
            else:
                try:
                    with list_path.open('w', encoding='utf-8') as f:
                        pass
                except Exception:
                    pass
                day_entries.append({'day': di, 'segments': 0, 'list_path': str(list_path)})

        results.append({'camera': cam, 'days': day_entries})

    return jsonify({'ok': True, 'tmp_dir': str(tmp_dir), 'lists': results})


@bp.route('/prepare_days', methods=['POST'])
def api_import_prepare_days():
    """Scan and prepare per-day ffmpeg concat list files in the output directory, using
    experiment/treatment/batch naming.
    Body JSON:
      facility, cameras [list], experiment, treatment, batch,
      start_date, end_date, start_time, end_time, optional camera_pattern
    """
    payload = request.json or {}
    facility = str(payload.get('facility', '')).strip().lower()
    experiment = str(payload.get('experiment', '')).strip()
    treatment = str(payload.get('treatment', '')).strip()
    try:
        batch = int(payload.get('batch', 1))
    except Exception:
        batch = 1
    start_date = str(payload.get('start_date', '')).strip()
    end_date = str(payload.get('end_date', '')).strip()
    start_time = str(payload.get('start_time', '')).strip()
    end_time = str(payload.get('end_time', '')).strip()
    camera_pattern_override = str(payload.get('camera_pattern', '') or '').strip()
    try:
        cameras = sorted({int(c) for c in (payload.get('cameras') or [])})
    except Exception:
        return jsonify({'error': 'Invalid cameras'}), 400

    if not experiment or not treatment:
        return jsonify({'error': 'Missing experiment or treatment'}), 400

    day_windows = _day_windows(start_date, end_date, start_time, end_time)
    if not day_windows:
        return jsonify({'error': 'Invalid date/time range'}), 400

    facs = cfg_importer_facilities()
    if facility not in facs:
        return jsonify({'error': 'Unknown facility'}), 400
    fac = facs[facility]
    source_dir = Path(fac.get('source_dir', '')).expanduser()
    if not source_dir.exists() or not source_dir.is_dir():
        return jsonify({'error': 'Source folder not found', 'path': str(source_dir)}), 400

    exts = set(cfg_importer_source_exts())
    ig_pat = str(fac.get('ignore_dir_regex') or cfg_importer_ignore_dir_regex() or '')
    try:
        ig_re = re.compile(ig_pat) if ig_pat else None
    except re.error:
        ig_re = None

    # duration fallback
    def _parse_dur_to_seconds(val: str | int | float | None) -> int:
        try:
            if isinstance(val, (int, float)):
                return max(0, int(val))
            s = str(val or '').strip()
            if not s:
                return 4 * 3600
            if ':' in s:
                hh, mm = s.split(':', 1)
                return max(0, int(hh) * 3600 + int(mm) * 60)
            return max(0, int(s))
        except Exception:
            return 4 * 3600

    max_dur_sec = _parse_dur_to_seconds(fac.get('max_file_duration'))
    cam_pat = camera_pattern_override or fac.get('camera_pattern', '')

    out_dir = _resolve_import_output_dir(facility, experiment, treatment)
    try:
        _ensure_dir(out_dir)
    except Exception as e:
        return jsonify({'error': f'Cannot create output dir: {e}', 'path': str(out_dir)}), 500
    out: List[Dict[str, Any]] = []

    for cam in cameras:
        segments: List[Dict[str, Any]] = []
        try:
            sub = _format_cam_glob(cam_pat or '{cam}', cam)
            root = source_dir.joinpath(sub)
            if not (root.exists() and root.is_dir()):
                out.append({'camera': cam, 'days': [], 'warning': f'Camera root not found: {root}'})
                continue
            for cur, dirnames, filenames in os.walk(root):
                if ig_re:
                    dirnames[:] = [d for d in dirnames if not ig_re.search(d)]
                for fn in filenames:
                    p = Path(cur) / fn
                    if p.suffix.lower() not in exts:
                        continue
                    ts = _parse_start_from_stem(p.stem) or _parse_time_from_path(p, str(fac.get('path_time_regex') or ''))
                    if not ts:
                        continue
                    meta = probe_media(p)
                    dur = meta.get('duration') if isinstance(meta, dict) else None
                    if not isinstance(dur, (int, float)) or dur <= 0:
                        dur = max_dur_sec
                    start_dt = ts
                    segments.append({'path': p, 'start': start_dt, 'end': start_dt + timedelta(seconds=float(dur))})
        except Exception:
            pass

        if not segments:
            cam_days = []
            for di, _ in enumerate(day_windows, start=1):
                cam_days.append({'day': di, 'status': 'MISSING', 'segments': 0})
            out.append({'camera': cam, 'days': cam_days})
            continue
        segments.sort(key=lambda s: s['start'])
        for i in range(len(segments)):
            if i+1 < len(segments):
                ns = segments[i+1]['start']
                if ns > segments[i]['start']:
                    segments[i]['end'] = min(segments[i]['end'], ns)

        cam_days: List[Dict[str, Any]] = []
        for di, win in enumerate(day_windows, start=1):
            ws = win['start']
            we = win['end']
            items: List[Dict[str, Any]] = []
            for s in segments:
                if not _overlaps(s['start'], s['end'], ws, we):
                    continue
                inpoint = max(0.0, (ws - s['start']).total_seconds())
                outpoint = None
                if s['end'] > we:
                    outpoint = max(0.0, (we - s['start']).total_seconds())
                items.append({'path': str(s['path']).replace('\\\\', '/'), 'inpoint': inpoint, 'outpoint': outpoint})

            # <Experiment>-<Treatment>.exp<Batch:03d><Camera>.day<Day:02d>.cam<Camera:02d>.txt
            list_name = f"{experiment}-{treatment}.exp{batch:03d}{cam}.day{di:02d}.cam{cam:02d}.txt"
            list_path = out_dir.joinpath(list_name)
            if items:
                try:
                    _write_concat_list(list_path, items)
                    cam_days.append({'day': di, 'status': 'PENDING', 'segments': len(items), 'list_path': str(list_path)})
                except Exception as e:
                    return jsonify({'error': f'Failed to write list: {e}', 'path': str(list_path)}), 500
            else:
                try:
                    with list_path.open('w', encoding='utf-8') as f:
                        pass
                except Exception:
                    pass
                cam_days.append({'day': di, 'status': 'MISSING', 'segments': 0, 'list_path': str(list_path)})

        out.append({'camera': cam, 'days': cam_days})

    return jsonify({'ok': True, 'tmp_dir': str(out_dir), 'plan': out})


@bp.route('/scan_full_stream')
def api_import_scan_full_stream():
    """Stream a full scan per camera with live camera + directory progress.
    Query params: facility, cameras=1,2,3, camera_pattern (optional override), path_time_regex (optional override)
    Events:
      - camera: {camera, root, exists}
      - dir: {camera, path}
      - file: {camera, path, match_regex}
      - done: {ok, total}
    """
    facility = str((request.args.get('facility') or '').strip().lower())
    cams_param = (request.args.get('cameras') or '').strip()
    camera_pattern_override = str((request.args.get('camera_pattern') or '').strip())
    regex_override = str((request.args.get('path_time_regex') or '').strip())
    start_date = str((request.args.get('start_date') or '').strip())
    end_date = str((request.args.get('end_date') or '').strip())
    start_time = str((request.args.get('start_time') or '').strip())
    end_time = str((request.args.get('end_time') or '').strip())

    facs = cfg_importer_facilities()
    if facility not in facs:
        return jsonify({'error': 'Unknown facility'}), 400
    fac = facs[facility]
    source_dir = Path(fac.get('source_dir', '')).expanduser()
    if not source_dir.exists() or not source_dir.is_dir():
        return jsonify({'error': 'Source folder not found', 'path': str(source_dir)}), 400

    exts = set(cfg_importer_source_exts())
    ig_pat = str(fac.get('ignore_dir_regex') or cfg_importer_ignore_dir_regex() or '')
    try:
        ig_re = re.compile(ig_pat) if ig_pat else None
    except re.error:
        ig_re = None

    ptre = regex_override or fac.get('path_time_regex', '')
    try:
        rx = re.compile(ptre) if ptre else None
    except re.error:
        rx = None

    # Determine window timestamps
    win_start = _combine_date_time(start_date, start_time)
    win_end = _combine_date_time(end_date, end_time)
    ws = win_start if win_start else None
    we = win_end if win_end else None

    # Build per-day windows for day assignment
    day_windows = _day_windows(start_date, end_date, start_time, end_time)
    day_spans: List[tuple[int, datetime, datetime]] = []
    try:
        for i, w in enumerate(day_windows, start=1):
            day_spans.append((i, w['start'], w['end']))
    except Exception:
        day_spans = []

    # Parse max file duration (facility override or default 4h)
    def _parse_dur_to_seconds(val: str | int | float | None) -> int:
        try:
            if isinstance(val, (int, float)):
                return max(0, int(val))
            s = str(val or '').strip()
            if not s:
                return 4 * 3600
            if ':' in s:
                hh, mm = s.split(':', 1)
                return max(0, int(hh) * 3600 + int(mm) * 60)
            return max(0, int(s))
        except Exception:
            return 4 * 3600

    max_dur_sec = _parse_dur_to_seconds(fac.get('max_file_duration'))

    # Cameras
    try:
        if cams_param:
            cam_list = [int(x) for x in cams_param.split(',') if x.strip()]
        else:
            cam_list = list(fac.get('camera_list') or [])
            if not cam_list:
                n = int(fac.get('cameras') or 0)
                cam_list = list(range(1, max(0, n) + 1)) if n > 0 else []
    except Exception:
        cam_list = []

    cam_pat = camera_pattern_override or fac.get('camera_pattern', '')

    def walker():
        total = 0
        for cam in cam_list:
            sub = _format_cam_glob(cam_pat or '{cam}', cam)
            root = source_dir.joinpath(sub)
            exists = root.exists() and root.is_dir()
            yield _sse_event('camera', {'camera': cam, 'root': str(root), 'exists': bool(exists)})
            if not exists:
                continue
            for cur, dirnames, filenames in os.walk(root):
                # emit current dir for progress
                yield _sse_event('dir', {'camera': cam, 'path': cur})
                # apply ignore filter
                if ig_re:
                    dirnames[:] = [d for d in dirnames if not ig_re.search(d)]
                # list files
                for fn in filenames:
                    if Path(fn).suffix.lower() in exts:
                        fp = os.path.join(cur, fn)
                        mr = False
                        if rx:
                            try:
                                mr = bool(rx.search(Path(fp).as_posix()))
                            except Exception:
                                mr = False
                        # Check time range overlap if we have regex-derived start time and window
                        in_range = False
                        day_idx = None
                        start_iso = None
                        start_hms = None
                        end_hms = None
                        try:
                            ts_name = _parse_start_from_stem(Path(fp).stem)
                            ts = ts_name or (_parse_time_from_path(Path(fp), ptre) if rx else None)
                            if ts:
                                start_iso = ts.isoformat(sep=' ')
                                start_hms = ts.strftime('%H:%M:%S')
                                if ws is not None and we is not None:
                                    f_start = ts
                                    f_end = f_start + timedelta(seconds=max_dur_sec)
                                    in_range = _overlaps(f_start, f_end, ws, we)
                                    if day_spans:
                                        for di, dws, dwe in day_spans:
                                            if _overlaps(f_start, f_end, dws, dwe):
                                                day_idx = di
                                                break
                        except Exception:
                            in_range = False
                            day_idx = None
                        total += 1
                        # If file is in range, try to get actual duration to compute end time
                        if in_range:
                            try:
                                meta = probe_media(Path(fp))
                                dur = meta.get('duration') if isinstance(meta, dict) else None
                                if isinstance(dur, (int, float)) and start_hms:
                                    # recompute precise end_hms based on parsed start
                                    ts2 = ts_name or (_parse_time_from_path(Path(fp), ptre) if rx else None)
                                    if ts2:
                                        end_iso_dt = ts2 + timedelta(seconds=float(dur))
                                        end_hms = f"{end_iso_dt.strftime('%H:%M:%S')}.{int(end_iso_dt.microsecond/1000):03d}"
                            except Exception:
                                pass
                        yield _sse_event('file', {
                            'camera': cam,
                            'path': fp,
                            'match_regex': mr,
                            'in_range': in_range,
                            'day': day_idx,
                            'start': start_iso,
                            'start_hms': start_hms,
                            'end_hms': end_hms,
                        })
        yield _sse_event('done', {'ok': True, 'total': total})

    return Response(stream_with_context(walker()), mimetype='text/event-stream')


@bp.route('/scan_full', methods=['GET', 'POST'])
def api_import_scan_full():
    """Full scan of source_dir, listing all files with flags for glob/regex match.
    Only considers files with configured source extensions.
    """
    if request.method == 'POST':
        payload = request.json or {}
        facility = str(payload.get('facility', '')).strip().lower()
        camera_pattern_override = str(payload.get('camera_pattern', '') or '').strip()
        regex_override = str(payload.get('path_time_regex', '') or '').strip()
    else:
        facility = str((request.args.get('facility') or '').strip().lower())
        camera_pattern_override = str((request.args.get('camera_pattern') or '').strip())
        regex_override = str((request.args.get('path_time_regex') or '').strip())

    facs = cfg_importer_facilities()
    if facility not in facs:
        return jsonify({'error': 'Unknown facility'}), 400

    fac = facs[facility]
    source_dir = Path(fac.get('source_dir', '')).expanduser()
    if not source_dir.exists() or not source_dir.is_dir():
        return jsonify({'error': 'Source folder not found', 'path': str(source_dir)}), 400

    exts = cfg_importer_source_exts()
    try:
        cam_list = list(fac.get('camera_list') or [])
        cam_list = [int(c) for c in cam_list] if cam_list else []
    except Exception:
        cam_list = []
    if not cam_list:
        try:
            n = int(fac.get('cameras') or 0)
        except Exception:
            n = 0
        cam_list = list(range(1, max(0, n) + 1)) if n > 0 else []

    cam_pat = camera_pattern_override or fac.get('camera_pattern', '')
    ptre = regex_override or fac.get('path_time_regex', '')

    # Precompute camera roots by enumerating cams and formatting folder names.
    path_to_cam: Dict[Path, int] = {}
    roots: List[tuple[int, Path]] = []
    if cam_pat:
        for cam in cam_list:
            sub = _format_cam_glob(cam_pat, cam)
            if not sub:
                continue
            roots.append((cam, source_dir.joinpath(sub)))

    results: List[Dict[str, Any]] = []
    total = 0
    try:
        for p in source_dir.rglob('*'):
            if not p.is_file():
                continue
            if p.suffix.lower() not in exts:
                continue
            total += 1
            pr = p.resolve()
            cam = None
            mg = False
            for c, root in roots:
                try:
                    rp = pr.as_posix()
                    rps = root.resolve().as_posix().rstrip('/') + '/'
                    if rp.startswith(rps):
                        cam = c; mg = True; break
                except Exception:
                    continue
            mr = False
            if ptre:
                try:
                    import re as _re
                    m = _re.search(ptre, p.as_posix())
                    mr = bool(m)
                except Exception:
                    mr = False
            results.append({
                'path': str(p),
                'camera': cam,
                'match_pattern': mg,
                'match_regex': mr,
            })
    except Exception as e:
        return jsonify({'error': f'scan failed: {e}'}), 500

    # Sort by path for stable UI
    results.sort(key=lambda x: x['path'])

    return jsonify({
        'ok': True,
        'facility': facility,
        'source_dir': str(source_dir),
        'camera_pattern': cam_pat,
        'path_time_regex': ptre,
        'extensions': exts,
        'total': total,
        'files': results,
    })


@bp.route('/prepare_from_manifest', methods=['POST'])
def api_import_prepare_from_manifest():
    """Prepare per-day concat list files from a client-provided file manifest.
    Body JSON must include: facility, experiment, treatment, batch, cameras[],
    start_date, end_date, start_time, end_time, files: [{camera, path, start?}]
    """
    payload = request.json or {}
    facility = str(payload.get('facility', '')).strip().lower()
    experiment = str(payload.get('experiment', '')).strip()
    treatment = str(payload.get('treatment', '')).strip()
    try:
        batch = int(payload.get('batch', 1))
    except Exception:
        batch = 1
    start_date = str(payload.get('start_date', '')).strip()
    end_date = str(payload.get('end_date', '')).strip()
    start_time = str(payload.get('start_time', '')).strip()
    end_time = str(payload.get('end_time', '')).strip()
    files = payload.get('files') or []
    try:
        cameras = sorted({int(c) for c in (payload.get('cameras') or [])})
    except Exception:
        return jsonify({'error': 'Invalid cameras'}), 400

    if not experiment or not treatment:
        return jsonify({'error': 'Missing experiment or treatment'}), 400
    if not isinstance(files, list):
        return jsonify({'error': 'Missing or invalid files manifest'}), 400

    day_windows = _day_windows(start_date, end_date, start_time, end_time)
    if not day_windows:
        return jsonify({'error': 'Invalid date/time range'}), 400

    facs = cfg_importer_facilities()
    if facility not in facs:
        return jsonify({'error': 'Unknown facility'}), 400
    fac = facs[facility]
    source_dir = Path(fac.get('source_dir', '')).expanduser()
    if not source_dir.exists() or not source_dir.is_dir():
        return jsonify({'error': 'Source folder not found', 'path': str(source_dir)}), 400

    # duration fallback
    def _parse_dur_to_seconds(val: str | int | float | None) -> int:
        try:
            if isinstance(val, (int, float)):
                return max(0, int(val))
            s = str(val or '').strip()
            if not s:
                return 4 * 3600
            if ':' in s:
                hh, mm = s.split(':', 1)
                return max(0, int(hh) * 3600 + int(mm) * 60)
            return max(0, int(s))
        except Exception:
            return 4 * 3600

    max_dur_sec = _parse_dur_to_seconds(fac.get('max_file_duration'))
    out_dir = _resolve_import_output_dir(facility, experiment, treatment)
    try:
        _ensure_dir(out_dir)
    except Exception as e:
        return jsonify({'error': f'Cannot create output dir: {e}', 'path': str(out_dir)}), 500

    # Normalize manifest entries per camera
    by_cam = {c: [] for c in cameras}
    for f in files:
        if not isinstance(f, dict):
            return jsonify({'error': 'Invalid files manifest entry'}), 400
        try:
            cam = int(f.get('camera'))
        except Exception:
            continue
        if cam not in by_cam:
            continue
        try:
            p = _resolve_manifest_source_path(source_dir, f.get('path'))
        except PermissionError as e:
            return jsonify({'error': str(e), 'path': str(f.get('path') or '')}), 403
        except (ValueError, FileNotFoundError) as e:
            return jsonify({'error': str(e), 'path': str(f.get('path') or '')}), 400
        # prefer provided start iso, else parse from name
        ts = None
        siso = f.get('start')
        if siso:
            try:
                ts = datetime.fromisoformat(str(siso).replace('T', ' ').strip())
                if ts.tzinfo is not None:
                    ts = ts.replace(tzinfo=None)
            except Exception:
                ts = None
        if ts is None:
            ts = _parse_start_from_stem(p.stem) or _parse_time_from_path(p, str(fac.get('path_time_regex') or ''))
        if not ts:
            continue
        start_dt = ts
        by_cam[cam].append({'path': p, 'start': start_dt, 'end': start_dt + timedelta(seconds=float(max_dur_sec))})

    out = []
    for cam in cameras:
        segs = by_cam.get(cam) or []
        if not segs:
            cam_days = [{'day': di, 'status': 'MISSING', 'segments': 0} for di, _ in enumerate(day_windows, start=1)]
            out.append({'camera': cam, 'days': cam_days})
            continue
        segs.sort(key=lambda s: s['start'])
        for i in range(len(segs)):
            if i+1 < len(segs):
                ns = segs[i+1]['start']
                if ns > segs[i]['start']:
                    segs[i]['end'] = min(segs[i]['end'], ns)
        cam_days = []
        for di, win in enumerate(day_windows, start=1):
            ws = win['start']
            we = win['end']
            items = []
            cover = ws
            for s in segs:
                # Skip segments fully outside the day window
                if not _overlaps(s['start'], s['end'], ws, we):
                    continue
                # Trim to remove overlap with prior coverage and clamp to [ws,we]
                eff_start = max(s['start'], ws, cover)
                eff_end = min(s['end'], we)
                if eff_start >= eff_end:
                    continue
                inpoint = max(0.0, (eff_start - s['start']).total_seconds())
                outpoint = None
                if eff_end < s['end']:
                    outpoint = max(0.0, (eff_end - s['start']).total_seconds())
                items.append({'path': str(s['path']).replace('\\', '/'), 'inpoint': inpoint, 'outpoint': outpoint})
                cover = eff_end
            list_name = f"{experiment}-{treatment}.exp{batch:03d}{cam}.day{di:02d}.cam{cam:02d}.txt"
            list_path = out_dir.joinpath(list_name)
            if items:
                try:
                    _write_concat_list(list_path, items)
                    cam_days.append({'day': di, 'status': 'PENDING', 'segments': len(items), 'list_path': str(list_path)})
                except Exception as e:
                    return jsonify({'error': f'Failed to write list: {e}', 'path': str(list_path)}), 500
            else:
                try:
                    with list_path.open('w', encoding='utf-8') as f:
                        pass
                except Exception as e:
                    _log.error("importer: failed to write empty concat list %s: %s", list_path, e, exc_info=True)
                cam_days.append({'day': di, 'status': 'MISSING', 'segments': 0, 'list_path': str(list_path)})
        out.append({'camera': cam, 'days': cam_days})

    return jsonify({'ok': True, 'tmp_dir': str(out_dir), 'plan': out})


@bp.route('/encode_days', methods=['POST'])
def api_import_encode_days():
    payload = request.json or {}
    facility = str(payload.get('facility', '')).strip().lower()
    experiment = str(payload.get('experiment', '')).strip()
    treatment = str(payload.get('treatment', '')).strip()
    try:
        batch = int(payload.get('batch', 1))
    except Exception:
        batch = 1
    plan = payload.get('plan') or payload.get('lists') or []
    start_date = str(payload.get('start_date', '')).strip()
    end_date = str(payload.get('end_date', '')).strip()
    start_time = str(payload.get('start_time', '')).strip()
    end_time = str(payload.get('end_time', '')).strip()

    facs = cfg_importer_facilities()
    if facility not in facs:
        return jsonify({'error': 'Unknown facility'}), 400
    fac = facs[facility]
    out_base = str(fac.get('output_dir') or '').strip() or str(cfg_importer_working_dir())
    base_dir = _resolve_output_dir(out_base, experiment, treatment)
    try:
        base_dir.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        return jsonify({'error': f'Cannot create output dir: {e}', 'path': str(base_dir)}), 500

    used_batches = _collect_used_batches(base_dir)
    if batch in used_batches:
        return jsonify({
            'error': f'Batch {batch} already exists in output folder',
            'output_dir': str(base_dir),
            'used_batches': used_batches,
        }), 409

    if not _ffmpeg_exists():
        return jsonify({'error': 'ffmpeg not available'}), 400

    # Expected window seconds per day
    day_expected: Dict[int, float] = {}
    try:
        for i, w in enumerate(_day_windows(start_date, end_date, start_time, end_time), start=1):
            day_expected[i] = (w['end'] - w['start']).total_seconds()
    except Exception:
        day_expected = {}

    # Health tolerance seconds (facility override or global default)
    try:
        tol = float(fac.get('health_tolerance_seconds')) if fac.get('health_tolerance_seconds') is not None else cfg_importer_health_tolerance_seconds()
        if tol < 0:
            tol = 0.0
    except Exception:
        tol = cfg_importer_health_tolerance_seconds()

    # async mode: process in background and poll via /encode_status
    async_mode = bool(payload.get('async', True))
    if async_mode:
        # compute total across items with segments > 0
        try:
            total = sum(
                1
                for cam_entry in plan
                for d in (cam_entry.get('days') or [])
                if int(d.get('segments') or 0) > 0 and str(d.get('status','')).upper() != 'MISSING'
            )
        except Exception:
            total = sum(len(cam_entry.get('days') or []) for cam_entry in plan)

        job_id = uuid.uuid4().hex
        with ENCODE_LOCK:
            ENCODE_JOBS[job_id] = {
                'id': job_id,
                'status': 'QUEUED',
                'progress': 0,
                'total': total,
                'plan': plan,
                'output_dir': str(base_dir),
                'cancel': False,
            }
        task_payload = {
            'job_id': job_id,
            'facility': facility,
            'experiment': experiment,
            'treatment': treatment,
            'batch': batch,
            'plan': plan,
            'start_date': start_date,
            'end_date': end_date,
            'start_time': start_time,
            'end_time': end_time,
            'output_dir': str(base_dir),
        }
        task_entry = enqueue_task(
            title=f"Encode {experiment}-{treatment} batch {batch}",
            kind='import.encode',
            runner=lambda ctx, payload=task_payload: _encode_task_runner(ctx, payload),
            total=total,
            meta={'plan': plan, 'output_dir': str(base_dir)},
            payload=task_payload,
            on_cancel=lambda: _cancel_encode_job(job_id),
        )
        with ENCODE_LOCK:
            ENCODE_JOBS[job_id]['task_id'] = task_entry['id']
        return jsonify({'ok': True, 'job_id': job_id, 'task_id': task_entry['id'], 'status': 'QUEUED', 'progress': 0, 'total': ENCODE_JOBS[job_id]['total'], 'plan': plan})

    # sync mode: process now and return plan
    results = []
    for cam_entry in plan:
        cam = cam_entry.get('camera')
        days = []
        for d in cam_entry.get('days', []):
            list_path = Path(str(d.get('list_path') or '')).expanduser()
            segments = int(d.get('segments') or 0) if 'segments' in d else (0 if str(d.get('status','')).upper()=='MISSING' else 1)
            if list_path.name.endswith('.txt'):
                out_name = list_path.name[:-4] + '.mp4'
            else:
                day_num = int(d.get('day') or 0)
                out_name = f"{experiment}-{treatment}.exp{batch:03d}{cam}.day{day_num:02d}.cam{int(cam):02d}.mp4"
            out_path = base_dir.joinpath(out_name)
            if segments <= 0:
                days.append({'day': d.get('day'), 'status': 'MISSING', 'segments': 0, 'output': str(out_path), 'list_path': str(list_path)})
                continue
            if not list_path.exists():
                days.append({'day': d.get('day'), 'status': 'FAILED', 'segments': segments, 'message': 'list not found', 'output': str(out_path), 'list_path': str(list_path)})
                continue
            code, msg = _run_ffmpeg_concat(list_path, out_path)
            if code == 0:
                try:
                    list_path.unlink(missing_ok=True)
                except OSError as _ue:
                    _log.warning("importer: could not remove concat list %s: %s", list_path, _ue)
            entry = {'day': d.get('day'), 'status': ('DONE' if code == 0 else 'FAILED'), 'segments': segments, 'output': str(out_path), 'ffmpeg': msg, 'list_path': str(list_path)}
            try:
                exp_len = day_expected.get(int(d.get('day') or 0))
                actual = None
                if out_path.exists():
                    meta = probe_media(out_path)
                    dur = meta.get('duration') if isinstance(meta, dict) else None
                    if isinstance(dur, (int, float)):
                        actual = float(dur)
                if actual is not None:
                    entry['duration'] = actual
                if exp_len is not None and actual is not None:
                    delta = actual - float(exp_len)
                    ok = abs(delta) <= float(tol)
                    entry['health'] = {'expected': float(exp_len), 'actual': actual, 'delta': delta, 'ok': ok}
            except Exception as e:
                _log.warning("importer: error computing health for %s day %s (encode_days): %s", out_path, d.get('day'), e)
            days.append(entry)
        results.append({'camera': cam, 'days': days})

    return jsonify({'ok': True, 'output_dir': str(base_dir), 'plan': results})


@bp.route('/encode_status')
def api_import_encode_status():
    jid = (request.args.get('job') or '').strip()
    if not jid:
        return jsonify({'error': 'Missing job id'}), 400
    with ENCODE_LOCK:
        job = ENCODE_JOBS.get(jid)
        if not job:
            job = None
        if job:
            resp = dict(job)
            if job.get('task_id'):
                resp['task_id'] = job.get('task_id')
            # Compute server-side ETA so the frontend doesn't need wall-clock math
            try:
                spd = float(resp.get('speed') or 0)
                total_dur = float(resp.get('current_total_duration') or 0)
                done_us = int(resp.get('out_time_us') or 0)
                if spd > 0 and total_dur > 0:
                    done_s = done_us / 1_000_000
                    remaining_s = max(0.0, total_dur - done_s)
                    resp['eta_seconds'] = round(remaining_s / spd, 1)
            except Exception:
                pass
            return jsonify({'ok': True, **resp})
    task = _find_task_by_payload('import.encode', 'job_id', jid)
    if task:
        meta = task.get('meta') or {}
        resp = {
            'id': jid,
            'status': task.get('status'),
            'progress': task.get('progress', 0),
            'total': task.get('total', 0),
            'plan': meta.get('plan'),
            'output_dir': meta.get('output_dir'),
            'task_id': task.get('id'),
        }
        return jsonify({'ok': True, **resp})
    return jsonify({'error': 'Job not found'}), 404


@bp.route('/encode_cancel', methods=['POST'])
def api_import_encode_cancel():
    jid = ''
    try:
        if request.is_json:
            payload = request.get_json(silent=True) or {}
            jid = str(payload.get('job') or '').strip()
    except Exception:
        jid = ''
    if not jid:
        jid = str((request.args.get('job') or '').strip())
    if not jid:
        return jsonify({'error': 'Missing job id'}), 400
    with ENCODE_LOCK:
        job = ENCODE_JOBS.get(jid)
        task_id = None
        procs: Set[subprocess.Popen] = set()
        if job:
            job['cancel'] = True
            task_id = job.get('task_id')
            procs = set(ENCODE_PROCS.get(jid) or [])
    for proc in procs:
        try:
            if proc.poll() is None:
                proc.terminate()
        except Exception as e:
            _log.warning("importer: failed to terminate encode proc %s: %s", getattr(proc, 'pid', '?'), e)
    if not job:
        task = _find_task_by_payload('import.encode', 'job_id', jid)
        if not task:
            return jsonify({'error': 'Job not found'}), 404
        try:
            cancel_task_record(task.get('id'))
        except Exception as e:
            _log.warning("importer: failed to cancel orphan task record: %s", e)
        return jsonify({'ok': True, 'status': 'CANCELLING', 'job': jid})
    try:
        if task_id:
            cancel_task_record(task_id)
    except Exception as e:
        _log.warning("importer: failed to cancel task record %s: %s", task_id, e)
    return jsonify({'ok': True, 'status': 'CANCELLING', 'job': jid})


@bp.route('/retry_failed', methods=['POST'])
def api_import_retry_failed():
    """Re-queue only the FAILED/MISSING/PENDING days from a completed encode task.

    Body JSON: {"task_id": "<task id of the original import.encode task>"}

    The new task shares the same facility/experiment/treatment/batch as the
    original.  The batch-existence check is bypassed because the output folder
    already exists.
    """
    payload = request.get_json(silent=True) or {}
    task_id = str(payload.get('task_id') or '').strip()
    if not task_id:
        return jsonify({'error': 'Missing task_id'}), 400

    task = get_task(task_id)
    if not task:
        return jsonify({'error': 'Task not found'}), 404
    if str(task.get('kind') or '') != 'import.encode':
        return jsonify({'error': 'Task is not an import.encode task'}), 400

    original_payload = task.get('payload') or {}
    meta = task.get('meta') or {}
    plan = meta.get('plan') or original_payload.get('plan') or []

    # Build a plan containing only days that need to be (re-)run
    retry_plan: List[Dict[str, Any]] = []
    for cam_entry in plan:
        retry_days = [
            {**d, 'status': 'PENDING'}
            for d in (cam_entry.get('days') or [])
            if str(d.get('status') or '').upper() in ('FAILED', 'MISSING', 'PENDING')
        ]
        if retry_days:
            retry_plan.append({'camera': cam_entry.get('camera'), 'days': retry_days})

    if not retry_plan:
        return jsonify({'error': 'No failed or pending days to retry'}), 400

    retry_total = sum(
        1 for c in retry_plan
        for d in (c.get('days') or [])
        if int(d.get('segments') or 1) > 0 and str(d.get('status') or '').upper() != 'MISSING'
    )

    new_job_id = uuid.uuid4().hex
    new_task_payload = {
        **original_payload,
        'plan': retry_plan,
        'job_id': new_job_id,
        'is_retry': True,
    }

    with ENCODE_LOCK:
        ENCODE_JOBS[new_job_id] = {
            'id': new_job_id,
            'status': 'QUEUED',
            'progress': 0,
            'total': retry_total,
            'plan': retry_plan,
            'cancel': False,
            'created_at': time.time(),
        }

    new_task = enqueue_task(
        title=f"Retry: {task.get('title', 'Encode')}",
        kind='import.encode',
        runner=lambda ctx, p=new_task_payload: _encode_task_runner(ctx, p),
        total=retry_total,
        meta={'plan': retry_plan},
        payload=new_task_payload,
        on_cancel=lambda: _cancel_encode_job(new_job_id),
    )
    with ENCODE_LOCK:
        j = ENCODE_JOBS.get(new_job_id)
        if j:
            j['task_id'] = new_task['id']

    return jsonify({'ok': True, 'task_id': new_task['id'], 'job_id': new_job_id, 'total': retry_total})


def _resume_import_concat(ctx: TaskContext, payload: Dict[str, Any]) -> None:
    plan = payload.get('plan') or {}
    if not plan:
        update_task(ctx.task_id, status='FAILED', message='Missing import plan')
        return
    _run_import_job(ctx, plan)


def _resume_import_scan(ctx: TaskContext, payload: Dict[str, Any]) -> None:
    _scan_task_runner(ctx, payload)


def _resume_import_encode(ctx: TaskContext, payload: Dict[str, Any]) -> None:
    _encode_task_runner(ctx, payload)


register_task_resumer('import.concat', _resume_import_concat)
register_task_resumer('import.scan', _resume_import_scan)
register_task_resumer('import.encode', _resume_import_encode)
