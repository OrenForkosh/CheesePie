from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

import os
import tempfile
import time
from flask import Blueprint, jsonify, request, Response
from flask import stream_with_context

from .config import (
    cfg_importer_facilities,
    cfg_importer_working_dir,
    cfg_importer_source_exts,
    cfg_importer_ignore_dir_regex,
    cfg_importer_health_tolerance_seconds,
)
from .media import probe_media


bp = Blueprint('import_api', __name__)


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


def _file_time_range(path: Path) -> Optional[tuple[float, float]]:
    meta = probe_media(path)
    if not meta.get('available') or meta.get('error'):
        return None
    dur = meta.get('duration')
    if not isinstance(dur, (int, float)) or dur <= 0:
        return None
    try:
        end_ts = path.stat().st_mtime
        start_ts = end_ts - float(dur)
        return (start_ts, end_ts)
    except Exception:
        return None


def _overlaps(a_start: float, a_end: float, b_start: float, b_end: float) -> bool:
    return (a_start < b_end) and (b_start < a_end)


def _ensure_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


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


def _run_ffmpeg_concat(list_file: Path, out_path: Path) -> tuple[int, str]:
    cmd = [
        'ffmpeg', '-v', 'quiet', '-stats', '-y', '-threads', '4',
        '-f', 'concat', '-safe', '0', '-i', str(list_file),
        '-vcodec', 'copy', '-an', '-copytb', '0', str(out_path)
    ]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True)
        return (p.returncode, p.stderr or p.stdout)
    except Exception as e:
        return (1, str(e))


JOBS: Dict[str, Dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()

# Async encode job state for /encode_days + /encode_status
ENCODE_JOBS: Dict[str, Dict[str, Any]] = {}
ENCODE_LOCK = threading.Lock()
ENCODE_PROCS: Dict[str, subprocess.Popen] = {}

def _set_job_proc(job_id: str, proc: Optional[subprocess.Popen]) -> None:
    with ENCODE_LOCK:
        if proc is None:
            ENCODE_PROCS.pop(job_id, None)
        else:
            ENCODE_PROCS[job_id] = proc

# Background Scan/Prepare jobs (navigation-resumable)
SCAN_JOBS: Dict[str, Dict[str, Any]] = {}
SCAN_LOCK = threading.Lock()

def _job_cancelled(job_id: str) -> bool:
    with ENCODE_LOCK:
        j = ENCODE_JOBS.get(job_id)
        return bool(j and j.get('cancel'))

def _run_ffmpeg_concat_monitored(list_file: Path, out_path: Path, job_id: str) -> tuple[int, str, bool]:
    """Run ffmpeg concat with ability to cancel via ENCODE_JOBS[job]['cancel'].
    Returns (returncode, message, cancelled_flag).
    """
    cmd = [
        'ffmpeg', '-v', 'quiet', '-stats', '-y', '-threads', '4',
        '-f', 'concat', '-safe', '0', '-i', str(list_file),
        '-vcodec', 'copy', '-an', '-copytb', '0', str(out_path)
    ]
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        _set_job_proc(job_id, p)
        cancelled = False
        out_buf: List[str] = []
        err_buf: List[str] = []
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
                        p.kill()
                except Exception:
                    pass
                cancelled = True
                break
            try:
                # non-blocking small reads
                out = p.stdout.readline() if p.stdout else ''
                err = p.stderr.readline() if p.stderr else ''
                if out:
                    out_buf.append(out)
                if err:
                    err_buf.append(err)
            except Exception:
                pass
            time.sleep(0.1)
        try:
            # Drain remaining
            if p.stdout:
                o, _ = p.communicate(timeout=0.2)
                if o:
                    out_buf.append(o)
        except Exception:
            pass
        msg = (''.join(err_buf) or ''.join(out_buf) or '').strip()
        rc = p.returncode if p.returncode is not None else (1 if cancelled else 1)
        return (rc, msg if msg else ('cancelled' if cancelled else ''), cancelled)
    except Exception as e:
        return (1, str(e), False)
    finally:
        _set_job_proc(job_id, None)


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
        ws = win_start.timestamp() if win_start else None
        we = win_end.timestamp() if win_end else None

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
                        except Exception:
                            pass
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
                                if ts and ws is not None and we is not None:
                                    f_start = ts.timestamp()
                                    max_dur_sec = _parse_dur_to_seconds(fac.get('max_file_duration'))
                                    f_end = f_start + max_dur_sec
                                    in_range = _overlaps(f_start, f_end, ws, we)
                                    start_iso = ts.isoformat(sep=' ')
                                    start_hms = ts.strftime('%H:%M:%S')
                            except Exception:
                                pass
                            total += 1
                            files.append({'camera': cam, 'path': fp, 'match_regex': mr, 'in_range': in_range, 'day': day_idx, 'start': start_iso, 'start_hms': start_hms})
                            with SCAN_LOCK:
                                j = SCAN_JOBS.get(job_id)
                                if j:
                                    j['files'] = files[-2000:] if len(files) > 2000 else list(files)
                                    j['total'] = total
                        except Exception:
                            continue
        if cancelled():
            with SCAN_LOCK:
                j = SCAN_JOBS.get(job_id)
                if j:
                    j['status'] = 'CANCELLED'
            return
        try:
            plan = _prepare_plan_from_manifest(facility, experiment, treatment, batch, start_date, end_date, start_time, end_time, cameras, files)
            with SCAN_LOCK:
                j = SCAN_JOBS.get(job_id)
                if j:
                    j['plan'] = plan
                    j['status'] = 'DONE'
        except Exception as e:
            with SCAN_LOCK:
                j = SCAN_JOBS.get(job_id)
                if j:
                    j['status'] = 'ERROR'
                    j['error'] = str(e)
    except Exception as e:
        with SCAN_LOCK:
            j = SCAN_JOBS.get(job_id)
            if j:
                j['status'] = 'ERROR'
                j['error'] = str(e)

def _prepare_plan_from_manifest(facility: str, experiment: str, treatment: str, batch: int, start_date: str, end_date: str, start_time: str, end_time: str, cameras: List[int], files: List[Dict[str, Any]]):
    facs = cfg_importer_facilities()
    fac = facs[facility]
    day_windows = _day_windows(start_date, end_date, start_time, end_time)
    tmp_dir = Path(tempfile.gettempdir())
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
        try:
            cam = int(f.get('camera'))
        except Exception:
            continue
        if cam not in by_cam:
            continue
        p = Path(str(f.get('path') or '')).expanduser()
        ts = _parse_start_from_stem(p.stem) or _parse_time_from_path(p, str(fac.get('path_time_regex') or ''))
        if not ts:
            continue
        by_cam[cam].append({'path': p, 'start': ts.timestamp(), 'end': ts.timestamp() + float(max_dur_sec)})
    out: List[Dict[str, Any]] = []
    for cam in cameras:
        segs = by_cam.get(cam) or []
        if not segs:
            out.append({'camera': cam, 'days': [{'day': di, 'status': 'MISSING', 'segments': 0, 'list_path': str(tmp_dir.joinpath(f"{experiment}-{treatment}.exp{batch:03d}{cam}.day{di:02d}.cam{cam:02d}.txt"))} for di, _ in enumerate(day_windows, start=1)]})
            continue
        segs.sort(key=lambda s: s['start'])
        for i in range(len(segs)):
            if i+1 < len(segs):
                ns = segs[i+1]['start']
                if ns > segs[i]['start']:
                    segs[i]['end'] = min(segs[i]['end'], ns)
        cam_days: List[Dict[str, Any]] = []
        for di, win in enumerate(day_windows, start=1):
            ws = win['start'].timestamp()
            we = win['end'].timestamp()
            items: List[Dict[str, Any]] = []
            cover = ws
            for s in segs:
                if not _overlaps(s['start'], s['end'], ws, we):
                    continue
                eff_start = max(s['start'], ws, cover)
                eff_end = min(s['end'], we)
                if eff_start >= eff_end:
                    continue
                inpoint = max(0.0, eff_start - s['start'])
                outpoint = None
                if eff_end < s['end']:
                    outpoint = max(0.0, eff_end - s['start'])
                items.append({'path': str(s['path']).replace('\\', '/'), 'inpoint': inpoint, 'outpoint': outpoint})
                cover = eff_end
            list_name = f"{experiment}-{treatment}.exp{batch:03d}{cam}.day{di:02d}.cam{cam:02d}.txt"
            list_path = tmp_dir.joinpath(list_name)
            if items:
                _write_concat_list(list_path, items)
                cam_days.append({'day': di, 'status': 'PENDING', 'segments': len(items), 'list_path': str(list_path)})
            else:
                try:
                    with list_path.open('w', encoding='utf-8') as f:
                        pass
                except Exception:
                    pass
                cam_days.append({'day': di, 'status': 'MISSING', 'segments': 0, 'list_path': str(list_path)})
        out.append({'camera': cam, 'days': cam_days})
    return {'ok': True, 'tmp_dir': str(tmp_dir), 'plan': out}

@bp.route('/scan_prepare/start', methods=['POST'])
def api_scan_prepare_start():
    payload = request.json or {}
    facility = str(payload.get('facility', '')).strip().lower()
    experiment = str(payload.get('experiment', '')).strip()
    treatment = str(payload.get('treatment', '')).strip()
    start_date = str(payload.get('start_date', '')).strip()
    end_date = str(payload.get('end_date', '')).strip()
    start_time = str(payload.get('start_time', '')).strip()
    end_time = str(payload.get('end_time', '')).strip()
    cameras = payload.get('cameras') or []
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
                'cameras': cams, 'camera_pattern': str(payload.get('camera_pattern') or ''), 'batch': int(payload.get('batch') or 1),
            },
            'files': [], 'total': 0, 'cancel': False,
        }
    t = threading.Thread(target=_scan_prepare_worker, args=(job_id,), daemon=True)
    t.start()
    with SCAN_LOCK:
        SCAN_JOBS[job_id]['status'] = 'RUNNING'
    return jsonify({'ok': True, 'job_id': job_id})

@bp.route('/scan_prepare/status')
def api_scan_prepare_status():
    job_id = (request.args.get('job') or '').strip()
    if not job_id:
        return jsonify({'error': 'Missing job'}), 400
    with SCAN_LOCK:
        job = SCAN_JOBS.get(job_id)
        if not job:
            return jsonify({'error': 'Not found'}), 404
        out = {k: job.get(k) for k in ('id','status','total','files','error') if k in job}
        if 'plan' in job:
            out['plan'] = job['plan']
    return jsonify(out)

@bp.route('/scan_prepare/cancel', methods=['POST'])
def api_scan_prepare_cancel():
    job_id = (request.args.get('job') or '').strip()
    if not job_id:
        return jsonify({'error': 'Missing job'}), 400
    with SCAN_LOCK:
        job = SCAN_JOBS.get(job_id)
        if not job:
            return jsonify({'error': 'Not found'}), 404
        job['cancel'] = True
    return jsonify({'ok': True})

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


def _file_time_range_with_regex(path: Path, regex: str) -> Optional[tuple[float, float]]:
    meta = probe_media(path)
    if not meta.get('available') or meta.get('error'):
        return None
    dur = meta.get('duration')
    if not isinstance(dur, (int, float)) or dur <= 0:
        return None
    ts = _parse_time_from_path(path, regex)
    if not ts:
        return None
    start_ts = ts.timestamp()
    end_ts = start_ts + float(dur)
    return (start_ts, end_ts)


def _parse_start_from_stem(stem: str) -> Optional[datetime]:
    """Parse start datetime (with milliseconds if available) from filename stem.
    Pattern: <camera>-<YYYYMMDD>-<HHMMSS>-<epoch_ms>-<seq>
    Falls back to YYYYMMDD-HHMMSS if epoch_ms is not present.
    """
    try:
        parts = stem.split('-')
        if len(parts) < 3:
            return None
        date_s = parts[1]
        time_s = parts[2]
        if len(date_s) != 8 or len(time_s) != 6:
            return None
        # If epoch milliseconds token is present, use it for precise time
        if len(parts) >= 4:
            ep = parts[3].strip()
            if ep.isdigit() and len(ep) >= 13:
                try:
                    return datetime.fromtimestamp(int(ep) / 1000.0)
                except Exception:
                    pass
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


def _next_batch_number(exp: str, trt: str) -> int:
    base = cfg_importer_working_dir().joinpath(str(exp).upper(), str(trt).lower())
    if not base.exists() or not base.is_dir():
        return 1
    pat = re.compile(r"\.exp(\d{4})", re.IGNORECASE)
    mx = 0
    try:
        for p in base.iterdir():
            m = pat.search(p.name)
            if m:
                try:
                    val = int(m.group(1))
                    if val > mx:
                        mx = val
                except Exception:
                    pass
    except Exception:
        pass
    return (mx + 1) if mx > 0 else 1


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

    jobs: List[Dict[str, Any]] = []
    ptre = regex_override or fac.get('path_time_regex', '')
    batch = int(payload.get('batch', 1))
    if batch < 0:
        batch = 0
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
            ws = win['start'].timestamp()
            we = win['end'].timestamp()
            segs = [s for s in timeline if _overlaps(s['start'], s['end'], ws, we)]
            items: List[Dict[str, Any]] = []
            if segs:
                for s in segs:
                    inpoint = max(0.0, ws - s['start'])
                    outpoint = None
                    if s['end'] > we:
                        outpoint = max(0.0, we - s['start'])
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
                if not dry_run and _ffmpeg_exists():
                    code, msg = _run_ffmpeg_concat(list_path, out_path)
                    status = 'DONE' if code == 0 else 'FAILED'
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
    async_mode = bool(payload.get('async', True)) and _ffmpeg_exists() and not dry_run
    if async_mode:
        job_id = uuid.uuid4().hex
        with JOBS_LOCK:
            JOBS[job_id] = {
                'id': job_id,
                'status': 'QUEUED',
                'progress': 0,
                'total': sum(len(c['days']) for c in jobs),
                'plan': plan,
            }
        t = threading.Thread(target=_run_import_job, args=(job_id, plan), daemon=True)
        t.start()
        return jsonify({'ok': True, 'job_id': job_id, **plan})
    else:
        return jsonify(plan)


@bp.route('/status')
def api_import_status():
    job_id = request.args.get('job', '').strip()
    if not job_id:
        return jsonify({'error': 'Missing job id'}), 400
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return jsonify({'error': 'Job not found'}), 404
        return jsonify({'ok': True, **job})


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
    if not exp or not trt:
        return jsonify({'error': 'Missing experiment or treatment'}), 400
    nb = _next_batch_number(exp, trt)
    return jsonify({'ok': True, 'next_batch': nb})


__all__ = ['bp']

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
                    segments.append({'path': p, 'start': ts.timestamp(), 'end': ts.timestamp() + float(max_dur_sec)})
        except Exception:
            pass

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
            ws = win['start'].timestamp()
            we = win['end'].timestamp()
            items: List[Dict[str, Any]] = []
            cover = ws
            for s in segments:
                if not _overlaps(s['start'], s['end'], ws, we):
                    continue
                eff_start = max(s['start'], ws, cover)
                eff_end = min(s['end'], we)
                if eff_start >= eff_end:
                    continue
                inpoint = max(0.0, eff_start - s['start'])
                outpoint = None
                if eff_end < s['end']:
                    outpoint = max(0.0, eff_end - s['start'])
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
    """Scan and prepare per-day ffmpeg concat list files in temp, using
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

    tmp_dir = Path(tempfile.gettempdir())
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
                    segments.append({'path': p, 'start': ts.timestamp(), 'end': ts.timestamp() + float(dur)})
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
            ws = win['start'].timestamp()
            we = win['end'].timestamp()
            items: List[Dict[str, Any]] = []
            for s in segments:
                if not _overlaps(s['start'], s['end'], ws, we):
                    continue
                inpoint = max(0.0, ws - s['start'])
                outpoint = None
                if s['end'] > we:
                    outpoint = max(0.0, we - s['start'])
                items.append({'path': str(s['path']).replace('\\\\', '/'), 'inpoint': inpoint, 'outpoint': outpoint})

            # <Experiment>-<Treatment>.exp<Batch:03d><Camera>.day<Day:02d>.cam<Camera:02d>.txt
            list_name = f"{experiment}-{treatment}.exp{batch:03d}{cam}.day{di:02d}.cam{cam:02d}.txt"
            list_path = tmp_dir.joinpath(list_name)
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

    return jsonify({'ok': True, 'tmp_dir': str(tmp_dir), 'plan': out})


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
    ws = win_start.timestamp() if win_start else None
    we = win_end.timestamp() if win_end else None

    # Build per-day windows for day assignment
    day_windows = _day_windows(start_date, end_date, start_time, end_time)
    day_spans: List[tuple[int, float, float]] = []
    try:
        for i, w in enumerate(day_windows, start=1):
            day_spans.append((i, w['start'].timestamp(), w['end'].timestamp()))
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
                            if ts and ws is not None and we is not None:
                                f_start = ts.timestamp()
                                f_end = f_start + max_dur_sec
                                in_range = _overlaps(f_start, f_end, ws, we)
                                start_iso = ts.isoformat(sep=' ')
                                start_hms = ts.strftime('%H:%M:%S')
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
    tmp_dir = Path(tempfile.gettempdir())

    # Normalize manifest entries per camera
    by_cam = {c: [] for c in cameras}
    for f in files:
        try:
            cam = int(f.get('camera'))
        except Exception:
            continue
        if cam not in by_cam:
            continue
        p = Path(str(f.get('path') or '')).expanduser()
        # prefer provided start iso, else parse from name
        ts = None
        siso = f.get('start')
        if siso:
            try:
                ts = datetime.fromisoformat(str(siso).replace('T', ' ').strip())
            except Exception:
                ts = None
        if ts is None:
            ts = _parse_start_from_stem(p.stem) or _parse_time_from_path(p, str(fac.get('path_time_regex') or ''))
        if not ts:
            continue
        by_cam[cam].append({'path': p, 'start': ts.timestamp(), 'end': ts.timestamp() + float(max_dur_sec)})

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
            ws = win['start'].timestamp()
            we = win['end'].timestamp()
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
                inpoint = max(0.0, eff_start - s['start'])
                outpoint = None
                if eff_end < s['end']:
                    outpoint = max(0.0, eff_end - s['start'])
                items.append({'path': str(s['path']).replace('\\', '/'), 'inpoint': inpoint, 'outpoint': outpoint})
                cover = eff_end
            list_name = f"{experiment}-{treatment}.exp{batch:03d}{cam}.day{di:02d}.cam{cam:02d}.txt"
            list_path = tmp_dir.joinpath(list_name)
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

    return jsonify({'ok': True, 'tmp_dir': str(tmp_dir), 'plan': out})


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
    base_dir = Path(out_base).expanduser().joinpath(experiment, treatment)
    try:
        base_dir.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        return jsonify({'error': f'Cannot create output dir: {e}', 'path': str(base_dir)}), 500

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

        def _run_encode_job():
            with ENCODE_LOCK:
                job = ENCODE_JOBS.get(job_id)
                if not job:
                    return
                job['status'] = 'RUNNING'

            prog = 0
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
                            if st == 'MISSING' or segs <= 0:
                                out_days.append({**bd, 'status': 'MISSING'})
                            else:
                                # Not yet processed — keep visible as PENDING
                                tmp = dict(bd)
                                tmp['status'] = 'PENDING'
                                out_days.append(tmp)
                    full.append({'camera': cam_id, 'days': out_days})
                return full
            for cam_entry in plan:
                cam = cam_entry.get('camera')
                out_days: List[Dict[str, Any]] = []
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
                        out_days.append({'day': d.get('day'), 'status': 'MISSING', 'segments': 0, 'output': str(out_path), 'list_path': str(list_path)})
                        continue
                    if not list_path.exists():
                        out_days.append({'day': d.get('day'), 'status': 'FAILED', 'segments': segments, 'message': 'list not found', 'output': str(out_path), 'list_path': str(list_path)})
                        prog += 1
                        with ENCODE_LOCK:
                            j = ENCODE_JOBS.get(job_id)
                            if j:
                                j['progress'] = prog
                                j['plan'] = results + [{'camera': cam, 'days': out_days}]
                        continue
                    # mark running and push update
                    running_entry: Dict[str, Any] = {
                        'day': d.get('day'),
                        'status': 'RUNNING',
                        'segments': segments,
                        'output': str(out_path),
                        'list_path': str(list_path),
                    }
                    out_days.append(running_entry)
                    with ENCODE_LOCK:
                        j = ENCODE_JOBS.get(job_id)
                        if j:
                            j['plan'] = _snapshot_plan(cur_cam=cam, cur_days=out_days)

                    # if cancelled before starting, exit
                    if _job_cancelled(job_id):
                        # replace RUNNING with CANCELLED and break
                        out_days[-1] = {
                            'day': d.get('day'),
                            'status': 'CANCELLED',
                            'segments': segments,
                            'output': str(out_path),
                        }
                        with ENCODE_LOCK:
                            j = ENCODE_JOBS.get(job_id)
                            if j:
                                j['plan'] = _snapshot_plan(cur_cam=cam, cur_days=out_days)
                                j['status'] = 'CANCELLED'
                        break

                    code, msg, cancelled = _run_ffmpeg_concat_monitored(list_path, out_path, job_id)
                    entry: Dict[str, Any] = {
                        'day': d.get('day'),
                        'status': ('CANCELLED' if cancelled else ('DONE' if code == 0 else 'FAILED')),
                        'segments': segments,
                        'output': str(out_path),
                        'ffmpeg': msg,
                        'list_path': str(list_path),
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
                    except Exception:
                        pass
                    # replace RUNNING entry with final entry
                    out_days[-1] = entry
                    if cancelled:
                        with ENCODE_LOCK:
                            j = ENCODE_JOBS.get(job_id)
                            if j:
                                j['plan'] = _snapshot_plan(cur_cam=cam, cur_days=out_days)
                                j['status'] = 'CANCELLED'
                        break
                    prog += 1
                    with ENCODE_LOCK:
                        j = ENCODE_JOBS.get(job_id)
                        if j:
                            j['progress'] = prog
                            j['plan'] = _snapshot_plan(cur_cam=cam, cur_days=out_days)

                results.append({'camera': cam, 'days': out_days})

            with ENCODE_LOCK:
                job = ENCODE_JOBS.get(job_id)
                if job:
                    if job.get('status') != 'CANCELLED':
                        job['status'] = 'DONE'
                    job['plan'] = _snapshot_plan()

        t = threading.Thread(target=_run_encode_job, daemon=True)
        t.start()
        return jsonify({'ok': True, 'job_id': job_id, 'status': 'QUEUED', 'progress': 0, 'total': ENCODE_JOBS[job_id]['total'], 'plan': plan})

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
            except Exception:
                pass
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
            return jsonify({'error': 'Job not found'}), 404
        return jsonify({'ok': True, **job})


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
        if not job:
            return jsonify({'error': 'Job not found'}), 404
        job['cancel'] = True
        proc = ENCODE_PROCS.get(jid)
        if proc and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass
    return jsonify({'ok': True, 'status': 'CANCELLING', 'job': jid})
