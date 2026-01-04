from __future__ import annotations

import json
import threading
import uuid
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Deque, Dict, List, Optional

from flask import Blueprint, jsonify, request

TaskRunner = Callable[['TaskContext'], None]
TaskResumer = Callable[['TaskContext', Dict[str, Any]], None]
CancelHook = Callable[[], None]

bp = Blueprint('tasks', __name__)

# In-memory task registry and queue
TASKS: Dict[str, Dict[str, Any]] = {}
TASK_RUNNERS: Dict[str, TaskRunner] = {}
TASK_CANCELS: Dict[str, CancelHook] = {}
TASK_RESUMERS: Dict[str, TaskResumer] = {}
TASK_QUEUE: Deque[str] = deque()
TASK_LOCK = threading.Lock()
TASK_EVENT = threading.Event()
_WORKER_STARTED = False
_RESUME_STARTED = False
TASKS_FILE = Path(__file__).resolve().parent.parent.joinpath('working', 'tasks.json')

TERMINAL_STATES = {'DONE', 'FAILED', 'CANCELLED'}

def _now_iso() -> str:
    return datetime.utcnow().isoformat() + 'Z'


def _ensure_worker() -> None:
    global _WORKER_STARTED
    if _WORKER_STARTED:
        return
    _WORKER_STARTED = True
    t = threading.Thread(target=_task_worker, daemon=True)
    t.start()


def _persist_tasks() -> None:
    """Persist current task list to disk as JSON."""
    try:
        TASKS_FILE.parent.mkdir(parents=True, exist_ok=True)
        with TASK_LOCK:
            data = list(TASKS.values())
        tmp = TASKS_FILE.with_suffix('.json.tmp')
        tmp.write_text(json.dumps(data, default=str, indent=2), encoding='utf-8')
        tmp.replace(TASKS_FILE)
    except Exception:
        pass


def _load_tasks() -> None:
    """Load persisted tasks from disk into memory."""
    if not TASKS_FILE.exists():
        try:
            TASKS_FILE.parent.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass
        return
    try:
        data = json.loads(TASKS_FILE.read_text(encoding='utf-8'))
        if not isinstance(data, list):
            return
        for t in data:
            if not isinstance(t, dict):
                continue
            tid = str(t.get('id') or uuid.uuid4().hex)
            t['id'] = tid
            if 'cancel' not in t:
                t['cancel'] = False
            TASKS[tid] = t
    except Exception:
        pass


# Load persisted tasks at import time
_load_tasks()


class TaskContext:
    """Context passed to task runners for progress updates and cancellation."""

    def __init__(self, task_id: str):
        self.task_id = task_id

    def update(self, **fields: Any) -> None:
        _update_task(self.task_id, **fields)

    def set_progress(self, progress: int, total: Optional[int] = None) -> None:
        updates: Dict[str, Any] = {'progress': progress}
        if total is not None:
            updates['total'] = total
        _update_task(self.task_id, **updates)

    def cancelled(self) -> bool:
        with TASK_LOCK:
            task = TASKS.get(self.task_id)
            return bool(task and task.get('cancel'))


def _create_task(
    title: str,
    kind: str,
    total: int = 0,
    meta: Optional[Dict[str, Any]] = None,
    runner: Optional[TaskRunner] = None,
    payload: Optional[Dict[str, Any]] = None,
    start_immediately: bool = False,
    on_cancel: Optional[CancelHook] = None,
) -> Dict[str, Any]:
    tid = uuid.uuid4().hex
    task = {
        'id': tid,
        'title': title,
        'kind': kind,
        'status': 'QUEUED' if runner else ('RUNNING' if start_immediately else 'QUEUED'),
        'progress': 0,
        'total': int(total or 0),
        'message': '',
        'created_at': _now_iso(),
        'started_at': _now_iso() if start_immediately and not runner else None,
        'finished_at': None,
        'meta': meta or {},
        'cancel': False,
    }
    if payload is not None:
        task['payload'] = payload
    persisted = False
    with TASK_LOCK:
        TASKS[tid] = task
        if runner:
            TASK_RUNNERS[tid] = runner
            TASK_QUEUE.append(tid)
            TASK_EVENT.set()
        if on_cancel:
            TASK_CANCELS[tid] = on_cancel
        persisted = True
    _ensure_worker()
    if persisted:
        _persist_tasks()
    return task


def _update_task(task_id: str, **fields: Any) -> bool:
    updated = False
    with TASK_LOCK:
        task = TASKS.get(task_id)
        if not task:
            return False
        # Merge meta dictionaries instead of replacing outright
        meta_update = fields.pop('meta', None)
        if meta_update:
            base = dict(task.get('meta') or {})
            base.update(meta_update)
            task['meta'] = base
        for k, v in fields.items():
            task[k] = v
        status = str(task.get('status') or '').upper()
        if status in TERMINAL_STATES:
            task['finished_at'] = task.get('finished_at') or _now_iso()
        updated = True
    if updated:
        _persist_tasks()
    return updated


def register_task_resumer(kind: str, runner: TaskResumer) -> None:
    if not kind:
        return
    TASK_RESUMERS[str(kind)] = runner


def _enqueue_existing_task(task_id: str, runner: TaskRunner) -> None:
    with TASK_LOCK:
        TASK_RUNNERS[task_id] = runner
        TASK_QUEUE.append(task_id)
        TASK_EVENT.set()
    _ensure_worker()


def resume_pending_tasks() -> None:
    """Resume non-terminal tasks that have registered resumers."""
    global _RESUME_STARTED
    if _RESUME_STARTED:
        return
    _RESUME_STARTED = True
    with TASK_LOCK:
        tasks = list(TASKS.values())
    tasks.sort(key=lambda t: t.get('created_at') or '')
    for task in tasks:
        tid = task.get('id')
        if not tid:
            continue
        status = str(task.get('status') or 'QUEUED').upper()
        if status in TERMINAL_STATES:
            continue
        if task.get('cancel'):
            update_task(tid, status='CANCELLED', message='Cancelled before restart')
            continue
        kind = str(task.get('kind') or '')
        resumer = TASK_RESUMERS.get(kind)
        if not resumer:
            update_task(tid, status='CANCELLED', message='No resume handler for task kind')
            continue
        payload = task.get('payload') or {}
        if not payload:
            update_task(tid, status='CANCELLED', message='Missing task payload for resume')
            continue
        def _runner(ctx: TaskContext, payload=payload, resumer=resumer):
            resumer(ctx, payload)
        update_task(tid, status='QUEUED', message='Resuming after restart', started_at=None, finished_at=None)
        _enqueue_existing_task(tid, _runner)


def enqueue_task(
    title: str,
    kind: str,
    runner: TaskRunner,
    total: int = 0,
    meta: Optional[Dict[str, Any]] = None,
    payload: Optional[Dict[str, Any]] = None,
    on_cancel: Optional[CancelHook] = None,
) -> Dict[str, Any]:
    """Create a task that will be executed by the background worker."""
    return _create_task(
        title,
        kind,
        total=total,
        meta=meta,
        runner=runner,
        payload=payload,
        start_immediately=False,
        on_cancel=on_cancel,
    )


def register_task(
    title: str,
    kind: str,
    total: int = 0,
    meta: Optional[Dict[str, Any]] = None,
    start_immediately: bool = True,
    on_cancel: Optional[CancelHook] = None,
) -> Dict[str, Any]:
    """Create a task that is updated externally (no runner)."""
    return _create_task(title, kind, total=total, meta=meta, runner=None, start_immediately=start_immediately, on_cancel=on_cancel)


def get_task(task_id: str) -> Optional[Dict[str, Any]]:
    with TASK_LOCK:
        t = TASKS.get(task_id)
        return dict(t) if t else None


def list_tasks(active_only: bool = False, limit: int = 50) -> List[Dict[str, Any]]:
    with TASK_LOCK:
        vals = list(TASKS.values())
    vals.sort(key=lambda t: t.get('created_at') or '', reverse=True)
    if active_only:
        vals = [t for t in vals if str(t.get('status')).upper() not in TERMINAL_STATES]
    return vals[: max(1, int(limit))] if limit else vals


def cancel_task(task_id: str) -> bool:
    with TASK_LOCK:
        task = TASKS.get(task_id)
        if not task:
            return False
        task['cancel'] = True
        cb = TASK_CANCELS.get(task_id)
        changed = True
    if cb:
        try:
            cb()
        except Exception:
            pass
    if changed:
        _persist_tasks()
    return True


def set_task_cancel_hook(task_id: str, hook: CancelHook) -> None:
    if not task_id or hook is None:
        return
    with TASK_LOCK:
        TASK_CANCELS[task_id] = hook


def cancel_all_tasks(active_only: bool = True) -> Dict[str, int]:
    cancelled = 0
    skipped = 0
    with TASK_LOCK:
        ids = [t['id'] for t in TASKS.values() if t.get('id')]
    for tid in ids:
        task = get_task(tid)
        if not task:
            continue
        status = str(task.get('status') or '').upper()
        if active_only and status in TERMINAL_STATES:
            skipped += 1
            continue
        if cancel_task(tid):
            cancelled += 1
    return {'cancelled': cancelled, 'skipped': skipped}


def update_task(task_id: str, **fields: Any) -> bool:
    """Public wrapper to update a task from external workers."""
    return _update_task(task_id, **fields)


def _task_worker():
    while True:
        TASK_EVENT.wait()
        while True:
            with TASK_LOCK:
                if not TASK_QUEUE:
                    TASK_EVENT.clear()
                    break
                tid = TASK_QUEUE.popleft()
                task = TASKS.get(tid)
                runner = TASK_RUNNERS.get(tid)
                if not task or not runner:
                    continue
                task['status'] = 'RUNNING'
                task['started_at'] = task.get('started_at') or _now_iso()
            ctx = TaskContext(tid)
            try:
                runner(ctx)
                # Runner is responsible for setting final status; default to DONE if still running
                with TASK_LOCK:
                    t = TASKS.get(tid)
                    if t and str(t.get('status')).upper() not in TERMINAL_STATES:
                        t['status'] = 'DONE'
                        t['finished_at'] = _now_iso()
                _persist_tasks()
            except Exception as e:
                _update_task(tid, status='FAILED', message=str(e), finished_at=_now_iso())


@bp.route('/')
def api_tasks_list():
    try:
        limit = int(request.args.get('limit', 50))
    except Exception:
        limit = 50
    active_only = str(request.args.get('active', '')).lower() in ('1', 'true', 'yes')
    return jsonify({'ok': True, 'tasks': list_tasks(active_only=active_only, limit=limit)})


@bp.route('/<task_id>')
def api_task_detail(task_id: str):
    task = get_task(task_id.strip())
    if not task:
        return jsonify({'error': 'Task not found'}), 404
    return jsonify({'ok': True, **task})


@bp.route('/cancel', methods=['POST'])
def api_task_cancel():
    task_id = ''
    try:
        payload = request.get_json(silent=True) or {}
        task_id = str(payload.get('task') or payload.get('id') or '').strip()
    except Exception:
        task_id = ''
    if not task_id:
        task_id = str((request.args.get('task') or '').strip())
    if not task_id:
        return jsonify({'error': 'Missing task id'}), 400
    ok = cancel_task(task_id)
    if not ok:
        return jsonify({'error': 'Task not found'}), 404
    return jsonify({'ok': True, 'task': task_id})


@bp.route('/cancel_all', methods=['POST'])
def api_task_cancel_all():
    active_only = True
    try:
        payload = request.get_json(silent=True) or {}
        active_only = bool(payload.get('active_only', True))
    except Exception:
        active_only = True
    result = cancel_all_tasks(active_only=active_only)
    return jsonify({'ok': True, **result})


__all__ = [
    'bp',
    'enqueue_task',
    'register_task',
    'register_task_resumer',
    'resume_pending_tasks',
    'update_task',
    'get_task',
    'list_tasks',
    'cancel_task',
    'set_task_cancel_hook',
    'cancel_all_tasks',
    'TaskContext',
]
