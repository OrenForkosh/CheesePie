function initTasks() {
    const listEl = document.getElementById("tasks-list");
    const toggleActiveOnly = document.getElementById("show-active-only");
    const refreshBtn = document.getElementById("refresh-tasks");
    const cancelAllBtn = document.getElementById("cancel-all");
    const titleEl = document.getElementById("tasks-title");
    const liveEl = document.getElementById("tasks-live");
    let pollTimer = null;
    let _pollDelay = 2000;
    const _POLL_MIN = 2000;
    const _POLL_MAX = 10000;

    if (window.__tasks_initialized) {
      try { window.__tasks_refresh && window.__tasks_refresh(); } catch { }
      return;
    }
    window.__tasks_initialized = true;

    const doneStates = ["DONE", "FAILED", "CANCELLED", "ERROR"];

    const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    function fmtTime(iso) {
      if (!iso) return "";
      try {
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? iso : dateTimeFormatter.format(d);
      } catch {
        return iso;
      }
    }

    function statusPill(status) {
      const st = String(status || "QUEUED").toUpperCase();
      const pill = document.createElement("span");
      pill.className = `status-pill status-${st}`;
      pill.textContent = st;
      return pill;
    }

    function taskStartValue(task) {
      const raw = task.started_at || task.created_at || task.finished_at || "";
      const t = Date.parse(raw);
      return Number.isFinite(t) ? t : 0;
    }

    function statusWeight(status) {
      const st = String(status || "").toUpperCase();
      if (st === "RUNNING") return 3;
      if (st === "QUEUED" || st === "PENDING") return 2;
      return 1;
    }

    function updateTitle(tasks) {
      if (!titleEl || !liveEl) return;
      const running = (tasks || []).filter(
        (t) => String(t.status || "").toUpperCase() === "RUNNING"
      ).length;
      if (running > 0) {
        titleEl.classList.add("running");
        const label = liveEl.querySelector(".label");
        if (label) label.textContent = running === 1 ? "1 Running" : `${running} Running`;
      } else {
        titleEl.classList.remove("running");
      }
    }

    // ── FFmpeg log viewer modal ───────────────────────────────────────────────
    const logModal = document.createElement("div");
    logModal.id = "ffmpeg-log-modal";
    Object.assign(logModal.style, {
      display: "none", position: "fixed", inset: "0", zIndex: "9999",
      background: "rgba(0,0,0,0.78)", backdropFilter: "blur(4px)",
      alignItems: "center", justifyContent: "center",
    });
    logModal.innerHTML = `
      <div style="background:#0d1117;border:1px solid #30363d;border-radius:12px;
                  width:min(920px,92vw);max-height:82vh;display:flex;flex-direction:column;
                  box-shadow:0 24px 64px rgba(0,0,0,0.7)">
        <div style="display:flex;align-items:center;justify-content:space-between;
                    padding:12px 16px;border-bottom:1px solid #30363d;flex-shrink:0;gap:10px">
          <span id="log-modal-title" style="font-weight:700;font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button class="btn mini" id="log-copy-btn">Copy</button>
            <button class="btn mini" id="log-download-btn">Download</button>
            <button class="btn mini" id="log-close-btn">✕</button>
          </div>
        </div>
        <pre id="log-modal-pre" style="margin:0;padding:14px 16px;overflow:auto;flex:1;
          font-family:ui-monospace,'Cascadia Code','Fira Code',Menlo,monospace;
          font-size:12px;line-height:1.65;color:#e6edf3;
          white-space:pre-wrap;word-break:break-all"></pre>
      </div>`;
    document.body.appendChild(logModal);

    let _logRaw = "", _logFilename = "ffmpeg.log";

    function renderLogLines(content, preEl) {
      preEl.innerHTML = "";
      const lines = (content || "(no output)").split("\n");
      lines.forEach((line, i) => {
        const span = document.createElement("span");
        if (/error|invalid|failed|no such file|cannot open|undefined/i.test(line)) {
          span.style.color = "#ff8a80";
        } else if (/warn/i.test(line)) {
          span.style.color = "#ffd166";
        } else if (/^\s*(Stream|Duration|Input|Output|encoder|Metadata)/i.test(line)) {
          span.style.color = "#79c0ff";
        }
        span.textContent = line + (i < lines.length - 1 ? "\n" : "");
        preEl.appendChild(span);
      });
    }

    function showFfmpegLog(title, content, filename) {
      _logRaw = content || "(no output)";
      _logFilename = filename || "ffmpeg.log";
      document.getElementById("log-modal-title").textContent = title;
      renderLogLines(_logRaw, document.getElementById("log-modal-pre"));
      logModal.style.display = "flex";
    }

    logModal.addEventListener("click", (e) => { if (e.target === logModal) logModal.style.display = "none"; });
    document.getElementById("log-close-btn").addEventListener("click", () => { logModal.style.display = "none"; });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && logModal.style.display === "flex") logModal.style.display = "none";
    });
    document.getElementById("log-copy-btn").addEventListener("click", () => {
      navigator.clipboard.writeText(_logRaw).then(() => {
        const btn = document.getElementById("log-copy-btn");
        const orig = btn.textContent; btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }).catch(() => {});
    });
    document.getElementById("log-download-btn").addEventListener("click", () => {
      const blob = new Blob([_logRaw], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = _logFilename;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    });

    function buildPlanDetails(plan, task) {
      const wrap = document.createElement("div");
      wrap.className = "task-details";
      const cams = plan && Array.isArray(plan.jobs) ? plan.jobs : Array.isArray(plan) ? plan : [];

      // If there's a top-level task error and no plan, show the message with a log button
      if (!cams.length) {
        if (task && task.message) {
          const msgEl = document.createElement("div");
          msgEl.className = "muted";
          msgEl.style.display = "flex";
          msgEl.style.alignItems = "center";
          msgEl.style.gap = "8px";
          msgEl.textContent = task.message;
          if (task.message.length > 60) {
            const logBtn = document.createElement("button");
            logBtn.className = "btn mini";
            logBtn.textContent = "View";
            logBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              showFfmpegLog(task.title || "Task Error", task.message, "task_error.log");
            });
            msgEl.appendChild(logBtn);
          }
          wrap.appendChild(msgEl);
        } else {
          wrap.innerHTML = '<div class="muted">No plan details.</div>';
        }
        return wrap;
      }

      const grid = document.createElement("div");
      grid.className = "plan-grid";
      cams.forEach((cam) => {
        const card = document.createElement("div");
        card.className = "plan-camera";
        const header = document.createElement("h4");
        header.textContent = `Camera ${cam.camera ?? "?"}`;
        card.appendChild(header);
        const days = Array.isArray(cam.days) ? cam.days : [];
        days.forEach((d) => {
          const row = document.createElement("div");
          row.className = "plan-day";
          const left = document.createElement("div");
          left.textContent = `Day ${d.day ?? "?"}`;
          const right = document.createElement("div");
          right.style.display = "flex";
          right.style.alignItems = "center";
          right.style.gap = "6px";
          right.appendChild(statusPill(d.status || "PENDING"));
          const segs = typeof d.segments === "number" ? d.segments : null;
          if (segs !== null && segs !== undefined) {
            const meta = document.createElement("div");
            meta.className = "muted";
            meta.textContent = `${segs} seg${segs === 1 ? "" : "s"}`;
            right.appendChild(meta);
          }
          // Show log button when ffmpeg output is available or day failed
          const logContent = d.ffmpeg || d.message || "";
          if (logContent) {
            const logBtn = document.createElement("button");
            logBtn.className = "btn mini";
            logBtn.textContent = "Log";
            logBtn.title = "View FFmpeg output for this day";
            logBtn.style.opacity = (d.status === "FAILED" || d.status === "ERROR") ? "1" : "0.55";
            logBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              const title = `Cam ${cam.camera ?? "?"} · Day ${d.day ?? "?"} — FFmpeg Output`;
              const fname = `ffmpeg_cam${cam.camera ?? 0}_day${d.day ?? 0}.log`;
              showFfmpegLog(title, logContent, fname);
            });
            right.appendChild(logBtn);
          }
          row.appendChild(left);
          row.appendChild(right);
          card.appendChild(row);
        });
        grid.appendChild(card);
      });
      wrap.appendChild(grid);
      return wrap;
    }

    function renderTasks(tasks) {
      if (!tasks || tasks.length === 0) {
        const emptyMsg =
          toggleActiveOnly && toggleActiveOnly.checked
            ? "No active tasks."
            : "No tasks yet.";
        listEl.innerHTML = `<div class="placeholder muted">${emptyMsg}</div>`;
        return;
      }
      listEl.innerHTML = "";
      const active = tasks.filter(
        (t) => !doneStates.includes(String(t.status || "").toUpperCase())
      );
      const history = tasks.filter(
        (t) => doneStates.includes(String(t.status || "").toUpperCase())
      );
      active.sort((a, b) => {
        const wa = statusWeight(a.status);
        const wb = statusWeight(b.status);
        if (wa !== wb) return wb - wa;
        return taskStartValue(b) - taskStartValue(a);
      });
      history.sort((a, b) => taskStartValue(b) - taskStartValue(a));

      function appendSectionTitle(text) {
        const header = document.createElement("div");
        header.className = "task-section-title";
        header.textContent = text;
        listEl.appendChild(header);
      }

      function appendTask(task) {
        const status = String(task.status || "QUEUED").toUpperCase();
        const pct =
          task.total && task.total > 0
            ? Math.min(100, Math.round(((task.progress || 0) / task.total) * 100))
            : doneStates.includes(status)
              ? 100
              : 0;
        const row = document.createElement("div");
        row.className = "task-row";
        row.dataset.open = "0";
        const main = document.createElement("div");
        main.className = "task-main";
        const title = document.createElement("div");
        title.className = "task-title";
        title.textContent = task.title || task.kind || "Task";
        const sub = document.createElement("div");
        sub.className = "task-sub";
        const kind = document.createElement("div");
        kind.textContent = task.kind || "task";
        const created = document.createElement("div");
        const startedAt = task.started_at || task.created_at;
        created.textContent = startedAt ? `Started: ${fmtTime(startedAt)}` : "";
        sub.appendChild(kind);
        if (created.textContent) sub.appendChild(created);
        if (doneStates.includes(status) && task.finished_at) {
          const finished = document.createElement("div");
          finished.textContent = `Finished: ${fmtTime(task.finished_at)}`;
          sub.appendChild(finished);
        }
        if (task.message) {
          const msg = document.createElement("div");
          msg.textContent = task.message;
          sub.appendChild(msg);
        }
        main.appendChild(title);
        main.appendChild(sub);
        const actions = document.createElement("div");
        actions.className = "task-actions";
        actions.appendChild(statusPill(status));
        const prog = document.createElement("div");
        prog.className = "progress-rail";
        const bar = document.createElement("div");
        bar.className = "progress-bar";
        bar.style.width = `${pct}%`;
        prog.appendChild(bar);
        actions.appendChild(prog);
        if (!doneStates.includes(status)) {
          const cancelBtn = document.createElement("button");
          cancelBtn.className = "btn mini";
          cancelBtn.textContent = "Cancel";
          cancelBtn.title = "Stop this task";
          cancelBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            try {
              await fetch("/api/tasks/cancel", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ task: task.id }),
              });
              loadTasks();
            } catch { }
          });
          actions.appendChild(cancelBtn);
        }
        if (status === "FAILED" && task.kind === "import.encode") {
          const retryBtn = document.createElement("button");
          retryBtn.className = "btn mini";
          retryBtn.textContent = "Retry Failed";
          retryBtn.title = "Re-run only the days that failed";
          retryBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            retryBtn.disabled = true;
            retryBtn.textContent = "Retrying…";
            try {
              const r = await fetch("/api/import/retry_failed", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ task_id: task.id }),
              });
              const d = await r.json();
              if (!r.ok || d.error) throw new Error(d.error || r.statusText);
              loadTasks();
            } catch (err) {
              retryBtn.disabled = false;
              retryBtn.textContent = "Retry Failed";
              const errMsg = document.createElement("div");
              errMsg.className = "muted";
              errMsg.style.fontSize = "11px";
              errMsg.textContent = String(err);
              sub.appendChild(errMsg);
            }
          });
          actions.appendChild(retryBtn);
        }
        row.appendChild(main);
        row.appendChild(actions);
        const details = buildPlanDetails((task.meta && task.meta.plan) || null, task);
        row.addEventListener("click", () => {
          const open = row.dataset.open === "1";
          row.dataset.open = open ? "0" : "1";
          details.style.display = open ? "none" : "block";
        });
        listEl.appendChild(row);
        listEl.appendChild(details);
      }

      if (active.length) {
        appendSectionTitle("Active");
        active.forEach(appendTask);
      }
      if (history.length) {
        appendSectionTitle("History");
        history.forEach(appendTask);
      }
    }

    function _schedulePoll(hasActive) {
      if (pollTimer) clearTimeout(pollTimer);
      _pollDelay = hasActive ? _POLL_MIN : Math.min(_pollDelay + 2000, _POLL_MAX);
      pollTimer = setTimeout(_pollLoad, _pollDelay);
    }

    async function _pollLoad() {
      const activeOnly = toggleActiveOnly && toggleActiveOnly.checked;
      const qs = activeOnly ? "?active=1&limit=0" : "?limit=0";
      let hasActive = false;
      try {
        const res = await fetch(`/api/tasks${qs}`);
        const data = await res.json();
        if (!res.ok || !data || data.error) {
          throw new Error((data && data.error) || res.statusText);
        }
        const tasks = data.tasks || [];
        hasActive = tasks.some(t => !doneStates.includes(String(t.status || '').toUpperCase()));
        updateTitle(tasks);
        renderTasks(tasks);
      } catch (e) {
        listEl.innerHTML = `<div class="muted">Failed to load tasks: ${e}</div>`;
      }
      _schedulePoll(hasActive);
    }

    function loadTasks() {
      _pollDelay = _POLL_MIN;
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
      _pollLoad();
    }

    refreshBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      loadTasks();
    });
    cancelAllBtn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      if (!confirm("Cancel all active tasks?")) return;
      try {
        await fetch("/api/tasks/cancel_all", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active_only: true }),
        });
      } catch { }
      loadTasks();
    });
    if (toggleActiveOnly) toggleActiveOnly.addEventListener("change", () => loadTasks());

    loadTasks();
    window.addEventListener("beforeunload", () => {
      if (pollTimer) clearTimeout(pollTimer);
    });
    window.__tasks_refresh = loadTasks;
    if (window.cheesepieRegisterPageRefresher) {
      window.cheesepieRegisterPageRefresher('tasks', loadTasks);
    }
  }
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", initTasks);
  } else {
    initTasks();
  }
