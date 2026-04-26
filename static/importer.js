var _importerAC = null;
var _importerCleanup = null;

function initImporter() {
    // Tear down previous run: clear timers and abort old document/window listeners.
    if (typeof _importerCleanup === "function") { try { _importerCleanup(); } catch {} }
    _importerCleanup = null;
    if (_importerAC) { _importerAC.abort(); }
    _importerAC = new AbortController();
    const { signal } = _importerAC;

    const CFG = window.CHEESEPIE || {};
    const FACS = (CFG.importer && CFG.importer.facilities) || {};

    const $ = (s, el = document) => el.querySelector(s);
    const facilitySel = document.getElementById("app-facility");
    const experimentSel = $("#experiment-select");
    const treatmentSel = $("#treatment-select");
    const srcDir = $("#source-dir");
    const startDate = $("#start-date");
    const endDate = $("#end-date");
    const daysInput = $("#days-input");
    const startTime = $("#start-time");
    const endTime = $("#end-time");
    const durationInput = $("#duration-input");
    const camsWrap = $("#cameras-wrap");
    const camsToolbar = $("#cams-toolbar");
    const camsRow = $("#cams-row");
    const camsAllBtn = $("#cams-all");
    const camsNoneBtn = $("#cams-none");
    const batchInput = $("#batch-input");
    const batchHint = $("#batch-hint");
    const listBtn = document.getElementById("list-btn");
    const camsHint = $("#cameras-hint");
    const importBtn = document.getElementById("import-btn");
    const listImportBtn = document.getElementById("list-import-btn");
    const openImportBtn = document.getElementById('open-import');
    const runTopBtn = document.getElementById("run-btn");
    let _ibData = null;
    let _ibCam = null;
    let _ibDate = null;
    let scanController = null;
    let scanAnimTimer = null;
    let scanDotsTimer = null;
    let scanDotsBase = "";
    let scanAutoRun = true;
    let scanMode = "import";
    let scanFilterInRange = false;
    let scanSeenPaths = new Set();
    let scanFilesMap = {};       // { "cam-day": [file, ...] }
    let expandedPlanRows = new Set(); // src row IDs currently open
    let batchAvailable = true;
    let batchAutoMode = true;   // true = always track next available batch
    let batchCheckTimer = null;
    let batchCheckSeq = 0;

    function loadScanMode() {
      let mode = "import";
      try { mode = localStorage.getItem('cheesepie.scan_mode') || 'import'; } catch { }
      scanMode = mode === "list" || mode === "list-filtered" ? mode : "import";
      scanAutoRun = scanMode === "import";
      scanFilterInRange = scanMode === "list-filtered";
    }

    function setScanMode(mode) {
      if (mode === "list-filtered") {
        scanMode = "list-filtered";
        scanFilterInRange = true;
      } else if (mode === "list") {
        scanMode = "list";
        scanFilterInRange = false;
      } else {
        scanMode = "import";
        scanFilterInRange = false;
      }
      scanAutoRun = scanMode === "import";
      try { localStorage.setItem('cheesepie.scan_mode', scanMode); } catch { }
    }

    function clearScanMode() {
      scanMode = "import";
      scanAutoRun = true;
      scanFilterInRange = false;
      try { localStorage.removeItem('cheesepie.scan_mode'); } catch { }
    }

    function setListBtnState(state) {
      if (!listBtn) return;
      if (state === "running") {
        listBtn.disabled = true;
        listBtn.textContent = "Listing…";
      } else if (state === "disabled") {
        listBtn.disabled = true;
        listBtn.textContent = "List";
      } else {
        listBtn.disabled = false;
        listBtn.textContent = "List";
      }
    }

    function setListImportBtnState(state) {
      if (!listImportBtn) return;
      if (state === "running") {
        listImportBtn.disabled = true;
        listImportBtn.textContent = "Listing…";
      } else if (state === "disabled") {
        listImportBtn.disabled = true;
        listImportBtn.textContent = "List";
      } else {
        listImportBtn.disabled = false;
        listImportBtn.textContent = "List";
      }
    }

    function setImportBtnStateIdle() {
      if (!openImportBtn) return;
      openImportBtn.disabled = false;
      openImportBtn.textContent = "Import";
      openImportBtn.style.background = "";
      openImportBtn.style.color = "";
      openImportBtn.dataset.running = "0";
      openImportBtn.title = "";
    }

    function setImportBtnStateScanning() {
      if (!openImportBtn) return;
      openImportBtn.disabled = true;
      openImportBtn.textContent = "Scanning…";
      openImportBtn.style.background = "";
      openImportBtn.style.color = "";
      openImportBtn.dataset.running = "0";
      openImportBtn.title = "Scan in progress";
    }
    // Resume any in-progress scan/encode when returning to Importer
    async function resumeJobs() {
      try {
        loadScanMode();
        let jid = null;
        try { const cur = await fetch('/api/import/scan_prepare/current').then(r => r.json()).catch(() => null); if (cur && cur.ok && cur.job_id) jid = cur.job_id; } catch { }
        if (!jid) { try { jid = localStorage.getItem('cheesepie.scan_job') || ''; } catch { } }
        if (jid) {
          const active = await isScanActive(jid);
          if (!active) {
            clearScanJob();
            jid = null;
          }
        }
        if (jid) {
          window.__SCAN_JOB_ID__ = jid;
          ensureScanPanel(); ensureDaysPanel();
          if (scanMode === "list") {
            setListBtnState("running");
            setListImportBtnState("disabled");
          } else if (scanMode === "list-filtered") {
            setListImportBtnState("running");
            setListBtnState("disabled");
          } else {
            setImportBtnStateScanning();
            setListBtnState("disabled");
            setListImportBtnState("disabled");
          }
          try { if (scanPollTimer) { clearInterval(scanPollTimer); } } catch { }
          // Make sure the scan modal is visible when resuming
          try { setScanPanelCollapsed(false); } catch { }
          scanPollTimer = setInterval(() => { pollScanStatus(jid); }, 1000);
          // Trigger an immediate poll instead of waiting for the first interval
          try { await pollScanStatus(jid); } catch { }
        }
      } catch { }
      try {
        let ejid = null; try { ejid = localStorage.getItem('cheesepie.encode_job') || ''; } catch { }
        if (ejid) {
          encodeJobId = ejid; try { window.__ENCODE_JOB_ID__ = ejid; } catch { };
          // Reflect Stop/Cancel state on the top Import button
          try { const btn = document.getElementById('open-import'); if (btn) { btn.disabled = false; btn.textContent = 'Cancel'; btn.style.background = '#b71c1c'; btn.style.color = '#fff'; btn.dataset.running = '1'; } } catch { }
          pollEncode();
        }
      } catch { }
    }

    // Ensure days panel exists; scan modal is static
    try { ensureDaysPanel(); } catch (e) { }

    function pad2(n) {
      return String(n).padStart(2, "0");
    }

    function ensureErrorBanner() {
      let eb = document.getElementById("error-banner");
      if (!eb) {
        eb = document.createElement("div");
        eb.id = "error-banner";
        eb.className = "error-banner";
        eb.style.display = "none";
        const container =
          document.querySelector("#importer .importer-grid") || document.body;
        container.parentElement.insertBefore(eb, container);
      }
      return eb;
    }
    function hideErrorBanner() {
      try {
        const eb = document.getElementById("error-banner");
        if (eb) { eb.style.display = 'none'; eb.textContent = ''; }
      } catch { }
    }
    function parseStackLoc(err) {
      try {
        const lines = String((err && err.stack) || "").split("\n");
        for (const line of lines) {
          const m = line.match(/([^\s\(]+):(\d+):(\d+)/);
          if (m) {
            return { file: m[1], line: Number(m[2]), col: Number(m[3]) };
          }
        }
      } catch { }
      return null;
    }
    function showError(context, err) {
      const eb = ensureErrorBanner();
      const msg = err && err.message ? err.message : String(err);
      const loc = parseStackLoc(err);
      const locTxt = loc ? ` (at ${loc.file}:${loc.line}:${loc.col})` : "";
      eb.textContent = `${context}: ${msg}${locTxt}`;
      eb.style.display = "block";
      try {
        console.error(context, err);
      } catch { }
    }
    window.addEventListener("error", (e) => {
      showError("Unhandled error", (e && e.error) || e.message);
    }, { signal });
    window.addEventListener("unhandledrejection", (e) => {
      showError("Unhandled promise", (e && e.reason) || "");
    }, { signal });

    function formatDate(d) {
      const y = d.getFullYear();
      const m = pad2(d.getMonth() + 1);
      const day = pad2(d.getDate());
      return `${y}-${m}-${day}`;
    }

    function combinedSourcePattern(fac) {
      const f = FACS[fac] || {};
      const src = (f && f.source_dir) || "";
      const glob = (f && (f.camera_pattern || f.camera_glob)) || "";
      if (!src) return "";
      if (!glob) return src;
      if (/^\//.test(glob)) return glob;
      return src.replace(/\/+$/, "") + "/" + glob.replace(/^\/+/, "");
    }

    function getSelectedCameras() {
      return Array.from(camsRow.querySelectorAll(".cam-btn.active"))
        .map((x) => Number(x.dataset.cam))
        .filter((n) => Number.isFinite(n));
    }

    function setSelectedCameras(list) {
      const want = new Set((list || []).map((n) => String(Number(n))));
      camsRow.querySelectorAll(".cam-btn").forEach((el) => {
        if (want.has(el.dataset.cam)) el.classList.add("active");
        else el.classList.remove("active");
      });
    }

    function getBatchValue() {
      const raw = (batchInput.value || "").trim();
      if (!raw) return 0;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? Math.max(0, n) : 0;
    }

    function _updateBatchAutoBtn() {
      const btn = document.getElementById('batch-auto-btn');
      if (btn) btn.classList.toggle('active', batchAutoMode);
    }

    function setBatchAvailability(ok, message = "") {
      batchAvailable = ok !== false;
      if (batchHint) {
        batchHint.textContent = message || "";
        batchHint.style.color = batchAvailable ? "" : "#b71c1c";
      }
      if (batchInput) {
        batchInput.style.borderColor = batchAvailable ? "" : "#b71c1c";
      }
      validate();
    }

    async function checkBatchAvailability() {
      const fac = facilitySel.value;
      const exp = experimentSel.value;
      const trt = treatmentSel.value;
      if (!fac || !exp || !trt) {
        setBatchAvailability(true, "");
        return;
      }
      const batch = getBatchValue();
      const seq = ++batchCheckSeq;
      if (batchHint) {
        batchHint.textContent = "Checking batch availability…";
        batchHint.style.color = "";
      }
      try {
        const url = `/api/import/next_batch?facility=${encodeURIComponent(
          fac
        )}&experiment=${encodeURIComponent(exp)}&treatment=${encodeURIComponent(
          trt
        )}&batch=${encodeURIComponent(batch)}`;
        const res = await fetch(url);
        const data = await res.json();
        if (seq !== batchCheckSeq) return;
        if (!res.ok || !data || data.error) {
          throw new Error((data && data.error) || res.statusText);
        }
        if (data.available === false) {
          const out = data.output_dir ? ` (${data.output_dir})` : "";
          setBatchAvailability(
            false,
            `Batch ${batch} already exists in output folder${out}.`
          );
          return;
        }
        setBatchAvailability(true, "");
      } catch (e) {
        if (seq !== batchCheckSeq) return;
        setBatchAvailability(false, "Unable to verify batch availability.");
      }
    }

    function scheduleBatchCheck(delay = 200) {
      if (batchCheckTimer) clearTimeout(batchCheckTimer);
      batchCheckTimer = setTimeout(() => {
        checkBatchAvailability();
      }, delay);
    }

    function updateUrl() {
      const params = new URLSearchParams();
      if (experimentSel.value) params.set("experiment", experimentSel.value);
      if (treatmentSel.value) params.set("treatment", treatmentSel.value);
      const bRaw = (batchInput.value || "").trim();
      if (bRaw) params.set("batch", String(getBatchValue()));
      if (startDate.value) params.set("start_date", startDate.value);
      if (endDate.value) params.set("end_date", endDate.value);
      if (startTime.value) params.set("start_time", startTime.value);
      if (endTime.value) params.set("end_time", endTime.value);
      const cams = getSelectedCameras();
      if (cams.length) params.set("cameras", cams.join(","));
      const qs = params.toString();
      const url = qs ? `${location.pathname}?${qs}` : location.pathname;
      window.history.replaceState({}, "", url);
      // Mirror to localStorage so fresh navigation (no URL params) can restore state
      try {
        localStorage.setItem("cheesepie.importer.prefs", JSON.stringify({
          experiment: experimentSel.value || "",
          treatment:  treatmentSel.value  || "",
          batch:      bRaw,
          batch_auto: batchAutoMode,
          start_date: startDate.value  || "",
          end_date:   endDate.value    || "",
          start_time: startTime.value  || "",
          end_time:   endTime.value    || "",
          cameras:    cams.join(","),
        }));
      } catch (e) {}
      // Also save per-facility camera preference
      const _facKey = facilitySel && facilitySel.value;
      if (_facKey) {
        try { localStorage.setItem(`cheesepie.importer.cameras.${_facKey}`, cams.join(",")); } catch (e) {}
      }
    }

    function ensureDefaultDates() {
      const today = new Date();
      if (!endDate.value) endDate.value = formatDate(today);
      if (!startDate.value) {
        const d30 = new Date(today);
        d30.setDate(d30.getDate() - 30);
        startDate.value = formatDate(d30);
      }
    }

    async function initFromUrl() {
      const params = new URLSearchParams(location.search);
      // Fall back to localStorage when the URL has no query string (fresh navigation)
      let stored = {};
      if (!location.search) {
        try { stored = JSON.parse(localStorage.getItem("cheesepie.importer.prefs") || "{}"); } catch (e) {}
      }
      const fac =
        params.get("facility") || (facilitySel && facilitySel.value) || "";
      const exp = (params.get("experiment") || stored.experiment || "").toUpperCase();
      const trt = (params.get("treatment") || stored.treatment || "").toLowerCase();
      const b = params.get("batch") || stored.batch || "";
      // Restore auto mode: default true unless explicitly saved as false
      const storedAuto = stored.batch_auto;
      batchAutoMode = (storedAuto === undefined || storedAuto === null) ? true : !!storedAuto;
      // If a batch param came from the URL (shared link), treat it as manual
      if (params.get("batch")) batchAutoMode = false;
      _updateBatchAutoBtn();
      const sd = params.get("start_date") || stored.start_date || "";
      const ed = params.get("end_date") || stored.end_date || "";
      const st = params.get("start_time") || stored.start_time || "";
      const et = params.get("end_time") || stored.end_time || "";
      const camParam = (params.get("cameras") || stored.cameras || "").trim();
      const camList = camParam
        ? camParam
          .split(",")
          .map((s) => parseInt(s, 10))
          .filter((n) => Number.isFinite(n))
        : [];

      if (sd) startDate.value = sd;
      if (ed) endDate.value = ed;
      ensureDefaultDates();
      syncDays();

      if (fac && FACS[fac]) {
        facilitySel.value = fac;
        facilitySel.dispatchEvent(new Event("change"));
        if (exp) {
          experimentSel.value = exp;
          experimentSel.dispatchEvent(new Event("change"));
        }
        if (trt) {
          treatmentSel.value = trt;
          treatmentSel.dispatchEvent(new Event("change"));
        }
        if (camList.length) {
          setSelectedCameras(camList);
        }
        if (!batchAutoMode && b) {
          batchInput.value = String(Math.max(0, parseInt(b, 10) || 1));
          await checkBatchAvailability();
        } else {
          await refreshBatch();
        }
        if (st) startTime.value = st;
        if (et) endTime.value = et;
        syncDuration();
        updateUrl();
        validate();
      } else {
        ensureDefaultDates();
        // If header already selected a facility, apply it now (without emitting 'change')
        if (facilitySel && facilitySel.value) {
          try {
            refreshFacility();
          } catch (e) { }
        }
        if (st) startTime.value = st;
        if (et) endTime.value = et;
        syncDuration();
        updateUrl();
      }
    }

    // React to global facility changes from header
    function refreshFacility() {
      try {
        const fac = facilitySel && facilitySel.value;
        if (!fac || !FACS[fac]) return;
        srcDir.value = combinedSourcePattern(fac);
        populateExperiments(fac);
        populateCameras(fac);
        const exps = Object.keys((FACS[fac] || {}).experiments || {}).sort();
        if (exps.length > 0) {
          experimentSel.value = exps[0];
          populateTreatments(fac, experimentSel.value);
          const trts =
            ((FACS[fac] || {}).experiments || {})[experimentSel.value] || [];
          if (trts.length > 0) {
            treatmentSel.value = trts[0];
            applyTreatmentDefaults(
              fac,
              experimentSel.value,
              treatmentSel.value
            );
          } else {
            startTime.value = "";
            endTime.value = "";
            durationInput.value = "";
          }
        } else {
          experimentSel.value = "";
          treatmentSel.value = "";
          startTime.value = "";
          endTime.value = "";
          durationInput.value = "";
        }
        validate();
        updateUrl();
        loadImporterBrowser(fac);
      } catch (e) { }
    }
    document.addEventListener("app:facility-changed", function () {
      try {
        updateUrl();
        refreshFacility();
      } catch (e) { }
    }, { signal });

    function setDisabled(el, dis) {
      el.disabled = !!dis;
      if (dis) el.value = "";
    }

    function populateFacilities() {
      if (!facilitySel) return;
      const cur = (facilitySel && facilitySel.value) || "";
      const keys = Object.keys(FACS).sort();
      // Rebuild options but preserve current selection if present
      const hasCur = cur && keys.indexOf(cur) !== -1;
      facilitySel.innerHTML = hasCur
        ? ""
        : '<option value="">Select facility…</option>';
      keys.forEach((k) => {
        const opt = document.createElement("option");
        opt.value = k;
        opt.textContent = k;
        facilitySel.appendChild(opt);
      });
      if (hasCur) {
        facilitySel.value = cur;
      }
    }

    function populateExperiments(fac) {
      experimentSel.innerHTML = "";
      setDisabled(experimentSel, true);
      setDisabled(treatmentSel, true);
      treatmentSel.innerHTML = "";
      if (!fac || !FACS[fac]) return;
      const exps = FACS[fac].experiments || {};
      const names = Object.keys(exps).sort();
      experimentSel.innerHTML = '<option value="">Select experiment…</option>';
      names.forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        experimentSel.appendChild(opt);
      });
      setDisabled(experimentSel, false);
      refreshBatch();
    }

    function populateTreatments(fac, exp) {
      treatmentSel.innerHTML = "";
      setDisabled(treatmentSel, true);
      if (!fac || !exp || !FACS[fac]) return;
      const arr = (FACS[fac].experiments || {})[exp] || [];
      treatmentSel.innerHTML = '<option value="">Select treatment…</option>';
      arr.forEach((t) => {
        const opt = document.createElement("option");
        opt.value = t;
        opt.textContent = t;
        treatmentSel.appendChild(opt);
      });
      setDisabled(treatmentSel, false);
    }

    function applyTreatmentDefaults(fac, exp, trt) {
      if (!fac || !exp || !trt) return;
      const defs =
        (((FACS[fac] || {}).treatment_defaults || {})[exp] || {})[trt] || {};
      if (defs.start_time) startTime.value = defs.start_time;
      if (defs.end_time) endTime.value = defs.end_time;
      syncDuration();
    }

    function populateCameras(fac) {
      camsRow.innerHTML = "";
      const list =
        FACS[fac] && Array.isArray(FACS[fac].camera_list)
          ? FACS[fac].camera_list
          : null;
      const n =
        list && list.length
          ? list.length
          : (FACS[fac] && Number(FACS[fac].cameras)) || 0;
      camsToolbar.hidden = !n;
      if (!n) {
        camsHint.textContent = fac
          ? "No cameras configured for this facility."
          : "Select a facility to load available cameras.";
        camsHint.style.color = fac ? 'var(--error, #b71c1c)' : '';
        return;
      }
      camsHint.style.color = '';
      camsHint.textContent = `Pick from ${n} camera(s).`;

      const items =
        list && list.length
          ? list.slice()
          : Array.from({ length: n }, (_, i) => i + 1);
      items.forEach((camNum) => {
        const btn = document.createElement("div");
        btn.className = "cam-btn active";
        btn.dataset.cam = String(camNum);
        btn.textContent = String(camNum);
        btn.addEventListener("click", () => {
          btn.classList.toggle("active");
          validate();
          updateUrl();
        });
        camsRow.appendChild(btn);
      });

      // Restore saved camera selection for this facility (URL params override later if present)
      try {
        const _savedCamRaw = localStorage.getItem(`cheesepie.importer.cameras.${fac}`);
        if (_savedCamRaw) {
          const _savedCams = _savedCamRaw.split(",").map(s => parseInt(s, 10)).filter(n => Number.isFinite(n));
          if (_savedCams.length) {
            camsRow.querySelectorAll(".cam-btn").forEach(btn => {
              if (_savedCams.includes(Number(btn.dataset.cam))) {
                btn.classList.add("active");
              } else {
                btn.classList.remove("active");
              }
            });
          }
        }
      } catch (e) {}

      camsAllBtn.onclick = () => {
        camsRow
          .querySelectorAll(".cam-btn")
          .forEach((el) => el.classList.add("active"));
        validate();
        updateUrl();
      };
      camsNoneBtn.onclick = () => {
        camsRow
          .querySelectorAll(".cam-btn")
          .forEach((el) => el.classList.remove("active"));
        validate();
        updateUrl();
      };
    }

    function validate() {
      const hasFac = !!facilitySel.value;
      const hasExp = !!experimentSel.value;
      const hasTrt = !!treatmentSel.value;
      const hasDates = !!startDate.value && !!endDate.value;
      // Date order check
      let dateOrderOk = true;
      if (hasDates) {
        dateOrderOk = new Date(endDate.value) >= new Date(startDate.value);
        endDate.style.borderColor = dateOrderOk ? '' : '#b71c1c';
        const hint = document.getElementById('date-range-hint');
        if (hint) { hint.textContent = dateOrderOk ? '' : 'End date must be after start date'; hint.style.color = '#b71c1c'; }
      } else {
        endDate.style.borderColor = '';
        const hint = document.getElementById('date-range-hint');
        if (hint) hint.textContent = '';
      }
      const hasTimes = !!startTime.value && !!endTime.value;
      const anyCam = !!camsRow.querySelector(".cam-btn.active");
      const batchOk = batchAvailable !== false;
      let scanActive = false;
      try { scanActive = !!window.__SCAN_JOB_ID__ || !!scanController; } catch { }
      let reason = "";
      if (!hasFac) reason = "Select a facility";
      else if (!hasExp || !hasTrt) reason = "Pick experiment and treatment";
      else if (!hasDates) reason = "Set start/end dates";
      else if (!dateOrderOk) reason = "End date must be after start date";
      else if (!hasTimes) reason = "Set start/end times";
      else if (!anyCam) reason = "Pick at least one camera";
      else if (!batchOk) reason = "Batch already exists";
      if (importBtn) {
        importBtn.disabled = !(
          hasFac &&
          hasExp &&
          hasTrt &&
          hasDates &&
          dateOrderOk &&
          hasTimes &&
          anyCam &&
          batchOk
        );
        importBtn.title = importBtn.disabled
          ? reason || "Complete selections to enable scan"
          : "";
      }
      if (listImportBtn) {
        listImportBtn.disabled = !(
          hasFac &&
          hasExp &&
          hasTrt &&
          hasDates &&
          dateOrderOk &&
          hasTimes &&
          anyCam
        ) || scanActive;
        listImportBtn.title = listImportBtn.disabled
          ? reason || "Complete selections to list files"
          : "List files that match your selection";
      }
      // If no plan yet, keep Run disabled with tooltip
      if (
        runTopBtn &&
        (!window.__DAYS_PLAN__ ||
          !Array.isArray(window.__DAYS_PLAN__) ||
          window.__DAYS_PLAN__.length === 0)
      ) {
        runTopBtn.disabled = true;
        runTopBtn.classList.remove("primary");
        runTopBtn.title = "Run is available after a successful scan";
      }
      // Batch conflicts are handled inside the modal with an inline warning, not here
    }

    facilitySel.addEventListener("change", () => {
      const fac = facilitySel.value;
      srcDir.value = combinedSourcePattern(fac);
      populateExperiments(fac);
      populateCameras(fac);
      // Preselect first experiment and treatment (if available) and apply defaults
      const exps = Object.keys((FACS[fac] || {}).experiments || {}).sort();
      if (exps.length > 0) {
        experimentSel.value = exps[0];
        populateTreatments(fac, experimentSel.value);
        const trts =
          ((FACS[fac] || {}).experiments || {})[experimentSel.value] || [];
        if (trts.length > 0) {
          treatmentSel.value = trts[0];
          applyTreatmentDefaults(fac, experimentSel.value, treatmentSel.value);
        } else {
          // no treatments; clear times
          startTime.value = "";
          endTime.value = "";
          durationInput.value = "";
        }
      } else {
        // no experiments; clear times
        startTime.value = "";
        endTime.value = "";
        durationInput.value = "";
      }
      refreshBatch();
      validate();
      updateUrl();
      loadImporterBrowser(fac);
    });
    experimentSel.addEventListener("change", () => {
      populateTreatments(facilitySel.value, experimentSel.value);
      // clear times when experiment changes; treatment selection will set defaults
      startTime.value = "";
      endTime.value = "";
      durationInput.value = "";
      refreshBatch();
      validate();
      updateUrl();
    });
    treatmentSel.addEventListener("change", () => {
      applyTreatmentDefaults(
        facilitySel.value,
        experimentSel.value,
        treatmentSel.value
      );
      refreshBatch();
      validate();
      updateUrl();
    });
    // ── Days / Duration derived fields ───────────────────────────────────────

    function syncDays() {
      if (!startDate.value || !endDate.value) { daysInput.value = ""; return; }
      const ms = new Date(endDate.value) - new Date(startDate.value);
      const d = Math.round(ms / 86400000);
      daysInput.value = d >= 0 ? d : "";
    }

    function applyDays() {
      const d = parseInt(daysInput.value, 10);
      if (!startDate.value || isNaN(d) || d < 0) return;
      const end = new Date(startDate.value);
      end.setDate(end.getDate() + d);
      endDate.value = end.toISOString().slice(0, 10);
    }

    function syncDuration() {
      if (!startTime.value || !endTime.value) { durationInput.value = ""; return; }
      const [sh, sm] = startTime.value.split(":").map(Number);
      const [eh, em] = endTime.value.split(":").map(Number);
      let mins = (eh * 60 + em) - (sh * 60 + sm);
      if (mins <= 0) mins += 24 * 60; // wraps past midnight
      durationInput.value = Math.round(mins / 60 * 2) / 2; // round to 0.5h
    }

    function applyDuration() {
      const hrs = parseFloat(durationInput.value);
      if (!startTime.value || isNaN(hrs) || hrs <= 0) return;
      const [sh, sm] = startTime.value.split(":").map(Number);
      const startMins = sh * 60 + sm;
      const totalMins = (startMins + Math.round(hrs * 60)) % (24 * 60);
      const eh = Math.floor(totalMins / 60), em = totalMins % 60;
      endTime.value = String(eh).padStart(2, "0") + ":" + String(em).padStart(2, "0");
    }

    startDate.addEventListener("change", () => {
      syncDays();
      validate();
      updateUrl();
      refreshIBDateHighlights();
    });
    endDate.addEventListener("change", () => {
      syncDays();
      validate();
      updateUrl();
      refreshIBDateHighlights();
    });
    daysInput.addEventListener("change", () => {
      applyDays();
      syncDays(); // normalise display after clamp
      validate();
      updateUrl();
      refreshIBDateHighlights();
    });
    startTime.addEventListener("change", () => {
      syncDuration();
      validate();
      updateUrl();
    });
    endTime.addEventListener("change", () => {
      syncDuration();
      validate();
      updateUrl();
    });
    durationInput.addEventListener("change", () => {
      applyDuration();
      syncDuration(); // normalise display
      validate();
      updateUrl();
    });
    batchInput.addEventListener("input", () => {
      // User typed something → switch to manual mode
      if (batchAutoMode) {
        batchAutoMode = false;
        _updateBatchAutoBtn();
      }
      updateUrl();
      scheduleBatchCheck();
    });
    batchInput.addEventListener("change", () => {
      batchInput.value = String(getBatchValue());
      updateUrl();
      scheduleBatchCheck(0);
    });
    const batchAutoBtn = document.getElementById('batch-auto-btn');
    if (batchAutoBtn) {
      batchAutoBtn.addEventListener('click', async () => {
        batchAutoMode = !batchAutoMode;
        _updateBatchAutoBtn();
        if (batchAutoMode) {
          await refreshBatch();
        }
        updateUrl();
      });
    }

    // reset button removed

    // removed Scan button and handler

    // List button: stream full scan with date/time for in-range and day assignment
    if (listBtn) {
      listBtn.addEventListener("click", async () => {
        hideErrorBanner();
        const fac = facilitySel.value;
        if (!fac) { alert("Please select a facility first."); return; }
        setScanMode("list");
        setListBtnState("running");
        setListImportBtnState("disabled");
        try {
          const chk = await fetch(`/api/import/check_source?facility=${encodeURIComponent(fac)}`);
          if (!chk.ok) {
            const d = await chk.json().catch(() => ({}));
            throw new Error((d && d.error) || "Source folder not accessible");
          }
          // Use background scan/prepare job but do not auto-run encode
          await startScanAndRun(false, "list");
        } catch (e) {
          showError("List error", e);
          stopScanProgress();
          setListBtnState("idle");
          setListImportBtnState("idle");
        }
      });
    }

    if (listImportBtn) {
      listImportBtn.addEventListener("click", async () => {
        hideErrorBanner();
        const fac = facilitySel.value;
        const exp = experimentSel.value;
        const trt = treatmentSel.value;
        const sDate = startDate.value;
        const eDate = endDate.value;
        const sTime = startTime.value;
        const eTime = endTime.value;
        const cams = getSelectedCameras();
        if (!fac || !exp || !trt || !sDate || !eDate || !sTime || !eTime || cams.length === 0) {
          showError("List", new Error("Complete selections first."));
          return;
        }
        setScanMode("list-filtered");
        setListImportBtnState("running");
        setListBtnState("disabled");
        try {
          const chk = await fetch(`/api/import/check_source?facility=${encodeURIComponent(fac)}`);
          if (!chk.ok) {
            const d = await chk.json().catch(() => ({}));
            throw new Error((d && d.error) || "Source folder not accessible");
          }
          await startScanAndRun(false, "list-filtered");
        } catch (e) {
          showError("List error", e);
          stopScanProgress();
          setListImportBtnState("idle");
          setListBtnState("idle");
        }
      });
    }

    // Import button: stream scan then prepare per-day lists
    async function onStartScan() {
      hideErrorBanner();
      const fac = facilitySel.value;
      const exp = experimentSel.value;
      const trt = treatmentSel.value;
      const sDate = startDate.value;
      const eDate = endDate.value;
      const sTime = startTime.value;
      const eTime = endTime.value;
      const cams = getSelectedCameras();
      const batch = getBatchValue();
      if (batchAvailable === false) {
        showError("Import", new Error("Batch already exists in output folder."));
        return;
      }
      if (
        !fac ||
        !exp ||
        !trt ||
        !sDate ||
        !eDate ||
        !sTime ||
        !eTime ||
        cams.length === 0
      ) {
        alert(
          "Please complete selections (facility/experiment/treatment/dates/times/cameras)."
        );
        return;
      }
      setScanMode("import");
      setListBtnState("disabled");
      setListImportBtnState("disabled");
      const trigBtn = document.getElementById('import-btn') || document.getElementById('open-import');
      if (trigBtn) { trigBtn.disabled = true; trigBtn.textContent = "Scanning…"; }
      try {
        const rb = document.getElementById("run-btn");
        if (rb) {
          rb.disabled = true;
          rb.classList.remove("primary");
          rb.title = "Run available after scan completes";
        }
      } catch { }
      try {
        const chk = await fetch(
          `/api/import/check_source?facility=${encodeURIComponent(fac)}`
        );
        if (!chk.ok) {
          const d = await chk.json().catch(() => ({}));
          throw new Error((d && d.error) || "Source folder not accessible");
        }
        ensureScanPanel();
        startScanProgress(
          `Import prep – scanning in ${combinedSourcePattern(fac)} …`,
          false
        );
        const pattern =
          (FACS[fac] && (FACS[fac].camera_pattern || FACS[fac].camera_glob)) ||
          "";
        const qs = new URLSearchParams({
          facility: fac,
          cameras: cams.join(","),
          camera_pattern: pattern,
          start_date: sDate,
          end_date: eDate,
          start_time: sTime,
          end_time: eTime,
        });
        const es = new EventSource(
          `/api/import/scan_full_stream?${qs.toString()}`
        );
        scanController = { close: () => es.close() };
        const files = [];
        es.addEventListener("camera", (ev) => {
          try {
            const d = JSON.parse(ev.data);
            if (d && d.camera) {
              setScanMeta(
                `Camera cam${String(d.camera).padStart(2, "0")} — ${d.root}${d.exists ? "" : " (missing)"
                }`
              );
              appendDirRow({
                camera: d.camera,
                path: d.root,
                header: true,
                exists: d.exists,
              });
            }
          } catch { }
        });
        es.addEventListener("dir", (ev) => {
          try {
            const d = JSON.parse(ev.data);
            if (d && d.path) {
              const run = document.getElementById("scan-running-meta");
              if (run) run.textContent = `Scanning: ${d.path}`;
              appendDirRow(d);
            }
          } catch { }
        });
        es.addEventListener("file", (ev) => {
          try {
            const d = JSON.parse(ev.data);
            if (d && d.path) {
              files.push(d);
              appendScanRow(d);
            }
          } catch { }
        });
        es.addEventListener("done", async () => {
          try {
            es.close();
            stopScanProgress();
            scanController = null;
            try { setListBtnState("idle"); } catch { }
            try { setListImportBtnState("idle"); } catch { }
            try { clearScanMode(); } catch { }
            // Update collapsed header with total files found
            try {
              setScanHeaderMeta(formatCount(files.length));
            } catch { }
            ensureDaysPanel();
            const res = await fetch("/api/import/prepare_from_manifest", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                facility: fac,
                experiment: exp,
                treatment: trt,
                batch,
                start_date: sDate,
                end_date: eDate,
                start_time: sTime,
                end_time: eTime,
                cameras: cams,
                files,
              }),
            });
            const data = await res.json();
            if (!res.ok || !data || data.error) {
              throw new Error((data && data.error) || res.statusText);
            }
            renderDaysPlan(data);
            // Start encoding automatically after preparing the plan
            await onRunEncode();
          } catch (e) {
            showError("Prepare error", e);
            expandScanPanelOnError(String((e && e.message) || e || ""));
          } finally {
            if (trigBtn) {
              try {
                if (isEncoding && isEncoding()) {
                  trigBtn.disabled = false;
                  trigBtn.textContent = 'Cancel';
                  trigBtn.style.background = '#b71c1c';
                  trigBtn.style.color = '#fff';
                  trigBtn.dataset.running = '1';
                } else {
                  trigBtn.disabled = false;
                  trigBtn.textContent = 'Rescan';
                  trigBtn.style.background = '';
                  trigBtn.style.color = '';
                  trigBtn.dataset.running = '0';
                }
              } catch (e) { }
            }
            try { validate(); } catch { }
          }
        });
        es.onerror = () => {
          es.close();
          stopScanDots();
          stopScanProgress();
          scanController = null;
          if (trigBtn) { trigBtn.disabled = false; trigBtn.textContent = "Rescan"; }
          try { setListBtnState("idle"); } catch { }
          try { setListImportBtnState("idle"); } catch { }
          try { clearScanMode(); } catch { }
          try { validate(); } catch { }
          expandScanPanelOnError("Scan error");
        };
      } catch (e) {
        showError("Scan error", e);
        expandScanPanelOnError(String((e && e.message) || e || ""));
        if (trigBtn) { trigBtn.disabled = false; trigBtn.textContent = "Rescan"; }
        try { setListBtnState("idle"); } catch { }
        try { setListImportBtnState("idle"); } catch { }
        try { clearScanMode(); } catch { }
        try { validate(); } catch { }
      }
    }
    if (importBtn) importBtn.addEventListener("click", onStartScan);
    function setImportBtnStateRunning(running) {
      try {
        const btn = document.getElementById('open-import');
        if (!btn) return;
        if (running) {
          btn.disabled = false;
          btn.textContent = 'Cancel';
          btn.style.background = '#b71c1c';
          btn.style.color = '#fff';
          btn.dataset.running = '1';
        } else {
          btn.disabled = false;
          btn.textContent = 'Import';
          btn.style.background = '';
          btn.style.color = '';
          btn.dataset.running = '0';
        }
      } catch (e) { }
    }

    function isEncoding() { try { return !!window.__ENCODE_JOB_ID__; } catch { return false; } }

    let scanPollTimer = null;
    function stopScanPolling() { if (scanPollTimer) { clearInterval(scanPollTimer); scanPollTimer = null; } }
    async function isScanActive(jobId) {
      if (!jobId) return false;
      try {
        const r = await fetch(`/api/import/scan_prepare/status?job=${encodeURIComponent(jobId)}`);
        const d = await r.json();
        if (!r.ok || d.error) return false;
        const status = String(d.status || "").toUpperCase();
        return status === "RUNNING" || status === "QUEUED";
      } catch {
        return false;
      }
    }
    function clearScanJob() {
      try { localStorage.removeItem('cheesepie.scan_job'); } catch { }
      try { window.__SCAN_JOB_ID__ = null; } catch { }
    }
    async function pollScanStatus(jobId) {
      try {
        const r = await fetch(`/api/import/scan_prepare/status?job=${encodeURIComponent(jobId)}`);
        const d = await r.json();
        if (!r.ok || d.error) {
          if (d && d.error) { try { clearScanJob(); } catch { } }
          throw new Error(d && d.error || r.statusText);
        }
        const status = String(d.status || "").toUpperCase();
        // Update Available Files table
        ensureScanPanel();
        try { renderScanResults({ total: d.total || 0, files: d.files || [] }); } catch { }
        try {
          const total = Number(d.total || 0);
          const shown = scanSeenPaths.size || 0;
          if (status === "RUNNING" || status === "QUEUED") {
            if (total > 0) {
              if (scanFilterInRange) {
                setScanMeta(`Found ${total.toLocaleString()} file(s) • in range ${shown.toLocaleString()}`);
              } else {
                setScanMeta(`Found ${total.toLocaleString()} file(s)${shown ? ` • showing ${shown.toLocaleString()}` : ""}`);
              }
            } else {
              setScanMeta("Scanning…");
            }
          }
        } catch { }
        // If plan present, render Day Preparation
        if (d.plan && d.plan.plan) { try { renderDaysPlan(d.plan); } catch { } }
        // Handle terminal states
        if (status === "DONE") {
          // Scan finished: stop progress and polling
          stopScanPolling();
          try {
            stopScanProgress();
            const total = Number(d.total || 0) || 0;
            const shown = scanSeenPaths.size || 0;
            const headerTotal = scanFilterInRange ? shown : (total || shown);
            const headerTxt = scanFilterInRange
              ? `${formatCount(headerTotal)} in range`
              : formatCount(headerTotal);
            setScanHeaderMeta(headerTxt);
            if (scanFilterInRange) {
              setScanMeta(shown ? `Scan complete. ${shown.toLocaleString()} file(s) in range.` : "Scan complete. No files in range.");
            } else {
              const finalCount = total || shown;
              setScanMeta(finalCount ? `Scan complete. Found ${finalCount.toLocaleString()} file(s).` : "Scan complete. No files found.");
            }
            if (scanFilterInRange ? shown === 0 : (total === 0 && shown === 0)) {
              const empty = document.querySelector("#scan-empty td");
              if (empty) empty.textContent = scanFilterInRange ? "No files in range." : "No files found.";
            }
          } catch { }
          // Auto start encode OR enable the modal Run button for manual start
          if (scanAutoRun) {
            try { setImportBtnStateIdle(); } catch { }
            try { await onRunEncode(); } catch { }
          } else {
            if (!isEncoding()) { try { setImportBtnStateIdle(); } catch { } }
            // Enable "Start Import" in modal
            try {
              const rb = document.getElementById("run-btn");
              if (rb) { rb.disabled = false; rb.textContent = "Start Import"; }
            } catch { }
          }
          try { setListBtnState("idle"); } catch { }
          try { setListImportBtnState("idle"); } catch { }
          try { validate(); } catch { }
          try { clearScanMode(); } catch { }
          try { localStorage.removeItem('cheesepie.scan_job'); } catch { }
          try { window.__SCAN_JOB_ID__ = null; } catch { }
        } else if (status === "CANCELLED" || status === "ERROR" || status === "FAILED") {
          stopScanPolling();
          setScanMeta(status === "CANCELLED" ? "Scan canceled." : "Scan error.");
          stopScanProgress();
          try { setListBtnState("idle"); } catch { }
          try { setListImportBtnState("idle"); } catch { }
          try { validate(); } catch { }
          if (!isEncoding()) { try { setImportBtnStateIdle(); } catch { } }
          try { clearScanMode(); } catch { }
          try { localStorage.removeItem('cheesepie.scan_job'); } catch { }
          try { window.__SCAN_JOB_ID__ = null; } catch { }
        }
      } catch (e) {
        stopScanPolling();
        try { stopScanProgress(); } catch { }
        try { setListBtnState("idle"); } catch { }
        try { setListImportBtnState("idle"); } catch { }
        try { validate(); } catch { }
        if (!isEncoding()) { try { setImportBtnStateIdle(); } catch { } }
        try { clearScanMode(); } catch { }
        try { showError('Scan status', e); } catch { }
      }
    }
    async function startScanAndRun(autoRun = true, modeOverride) {
      if (modeOverride) {
        setScanMode(modeOverride);
      } else {
        setScanMode(autoRun ? "import" : "list");
      }
      ensureScanPanel(); ensureDaysPanel();
      if (scanMode === "list") {
        setListBtnState("running");
        setListImportBtnState("disabled");
      } else if (scanMode === "list-filtered") {
        setListImportBtnState("running");
        setListBtnState("disabled");
      } else {
        setListBtnState("disabled");
        setListImportBtnState("disabled");
      }
      // Kick background Scan/Prepare job
      const fac = facilitySel.value;
      const exp = experimentSel.value;
      const trt = treatmentSel.value;
      const sDate = startDate.value;
      const eDate = endDate.value;
      const sTime = startTime.value;
      const eTime = endTime.value;
      const cams = getSelectedCameras();
      const batch = getBatchValue();
      // Show progress UI
      let msgBase = "Import prep – scanning in";
      if (scanMode === "list-filtered") msgBase = "Listing in-range files in";
      else if (scanMode === "list") msgBase = "Full scan in";
      startScanProgress(`${msgBase} ${combinedSourcePattern(fac)} …`, true);
      try {
        const res = await fetch('/api/import/scan_prepare/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ facility: fac, experiment: exp, treatment: trt, batch, start_date: sDate, end_date: eDate, start_time: sTime, end_time: eTime, cameras: cams, camera_pattern: (FACS[fac] && (FACS[fac].camera_pattern || FACS[fac].camera_glob)) || '' }) });
        const d = await res.json();
        if (!res.ok || !d || d.error || !d.job_id) { throw new Error((d && d.error) || res.statusText); }
        window.__SCAN_JOB_ID__ = d.job_id;
        try { localStorage.setItem('cheesepie.scan_job', d.job_id); } catch { }
        stopScanPolling();
        scanPollTimer = setInterval(() => { pollScanStatus(d.job_id); }, 1000);
        try { await pollScanStatus(d.job_id); } catch { }
      } catch (e) {
        stopScanProgress();
        try { showError('Scan start', e); } catch { }
        // Reset Import button state
        try { setImportBtnStateIdle(); } catch { }
        try { setListBtnState("idle"); } catch { }
        try { setListImportBtnState("idle"); } catch { }
        try { clearScanMode(); } catch { }
      }
    }

    if (openImportBtn) openImportBtn.addEventListener('click', async () => {
      try {
        hideErrorBanner();
        ensureScanPanel(); ensureDaysPanel();
        // If encoding is running → cancel encode
        try {
          const ejid = (window.__ENCODE_JOB_ID__ || localStorage.getItem('cheesepie.encode_job') || '').trim();
          if (ejid) { await onStopEncode(); setImportBtnStateRunning(false); return; }
        } catch { }
        // If scan is running, open the modal to show progress
        try {
          const sjid = (window.__SCAN_JOB_ID__ || localStorage.getItem('cheesepie.scan_job') || '').trim();
          if (sjid) {
            const active = await isScanActive(sjid);
            if (active) {
              setScanPanelCollapsed(false);
              setScanMeta("Scan already running. Use Cancel Scan to stop.");
              return;
            }
            clearScanJob();
          }
        } catch { }
        // Otherwise, start scan+prepare
        const ready = !!(facilitySel && facilitySel.value) && !!experimentSel.value && !!treatmentSel.value && !!startDate.value && !!endDate.value && !!startTime.value && !!endTime.value && getSelectedCameras().length > 0;
        validate();
        if (!ready) {
          showError('Import', new Error('Complete selections first.'));
          return;
        }
        setScanMode("import");
        scanAutoRun = false; // user presses "Start Import" manually in the modal
        setListBtnState("disabled");
        setListImportBtnState("disabled");
        setImportBtnStateScanning();
        await startScanAndRun();
      } catch (e) { try { showError('Import start error', e); } catch { } }
    });

    // ── Importer Column Browser ──────────────────────────────────────────────

    function _ibDateRange() {
      try {
        const s = startDate && startDate.value ? new Date(startDate.value + "T00:00:00") : null;
        const e = endDate && endDate.value ? new Date(endDate.value + "T00:00:00") : null;
        return { start: s, end: e };
      } catch { return { start: null, end: null }; }
    }

    function _ibFolderClass(folderDate) {
      if (!folderDate) return "";
      const { start, end } = _ibDateRange();
      if (!start && !end) return "";
      try {
        const d = new Date(folderDate + "T00:00:00");
        if (isNaN(d)) return "";
        if (start && end) {
          if (d >= start && d <= end) return "in-range";
          const bs = new Date(start); bs.setDate(bs.getDate() - 1);
          const be = new Date(end); be.setDate(be.getDate() + 1);
          if (d >= bs && d <= be) return "buffer";
          return "out-of-range";
        }
        const ref = start || end;
        const bs = new Date(ref); bs.setDate(bs.getDate() - 1);
        const be = new Date(ref); be.setDate(be.getDate() + 1);
        if (d.getTime() === ref.getTime()) return "in-range";
        if (d >= bs && d <= be) return "buffer";
        return "out-of-range";
      } catch { return ""; }
    }

    async function loadImporterBrowser(fac) {
      const panel = document.getElementById("importer-browser");
      const status = document.getElementById("importer-browser-status");
      if (!panel) return;
      if (!fac) { panel.style.display = "none"; return; }
      panel.style.display = "";
      _ibData = null; _ibCam = null; _ibDate = null;
      if (status) status.textContent = "Loading…";
      const colCams = document.getElementById("importer-col-cams");
      const colDates = document.getElementById("importer-col-dates");
      const colFiles = document.getElementById("importer-col-files");
      if (colCams) colCams.innerHTML = `<div class="importer-col-empty muted">Loading…</div>`;
      if (colDates) colDates.innerHTML = `<div class="importer-col-empty muted">Select a camera</div>`;
      if (colFiles) colFiles.innerHTML = `<div class="importer-col-empty muted">Select a date folder</div>`;
      try {
        const r = await fetch(`/api/import/browse_source?facility=${encodeURIComponent(fac)}`);
        const d = await r.json().catch(() => ({}));
        if (!d.ok) throw new Error(d.error || "Browse failed");
        _ibData = d;
        if (status) status.textContent = "";
        renderIBCams();
        // Auto-select first camera that exists
        const first = (_ibData.cameras || []).find(c => c.exists);
        if (first) selectIBCamera(first.camera);
      } catch (e) {
        if (status) status.textContent = String(e.message || e);
        if (colCams) colCams.innerHTML = `<div class="importer-col-empty muted">Could not load source.</div>`;
      }
    }

    function renderIBCams() {
      const col = document.getElementById("importer-col-cams");
      if (!col || !_ibData) return;
      col.innerHTML = "";
      (_ibData.cameras || []).forEach(cam => {
        const item = document.createElement("div");
        item.className = "importer-col-item" + (cam.camera === _ibCam ? " active" : "");
        if (!cam.exists) item.style.opacity = "0.4";
        const label = cam.folder || `Cam ${cam.camera}`;
        const count = cam.exists ? cam.date_folders.length : 0;
        item.innerHTML = `<span class="ic-name">${label}</span><span class="ic-meta">${count}</span>`;
        item.title = cam.exists ? `${count} date folder(s)` : "Folder not found";
        item.addEventListener("click", () => { if (cam.exists) selectIBCamera(cam.camera); });
        col.appendChild(item);
      });
    }

    function selectIBCamera(camIdx) {
      _ibCam = camIdx;
      _ibDate = null;
      // Update active state in col 1
      const col1 = document.getElementById("importer-col-cams");
      if (col1) col1.querySelectorAll(".importer-col-item").forEach((el, i) => {
        const cam = (_ibData.cameras || [])[i];
        el.classList.toggle("active", cam && cam.camera === camIdx);
      });
      // Clear cols 2 & 3
      const col3 = document.getElementById("importer-col-files");
      if (col3) col3.innerHTML = `<div class="importer-col-empty muted">Select a date folder</div>`;
      renderIBDates();
    }

    function renderIBDates() {
      const col = document.getElementById("importer-col-dates");
      if (!col || !_ibData) return;
      const camData = (_ibData.cameras || []).find(c => c.camera === _ibCam);
      if (!camData || !camData.exists) {
        col.innerHTML = `<div class="importer-col-empty muted">Camera not found</div>`;
        return;
      }
      col.innerHTML = "";
      (camData.date_folders || []).forEach(df => {
        const cls = _ibFolderClass(df.date);
        const item = document.createElement("div");
        item.className = "importer-col-item" + (cls ? " " + cls : "") + (df.name === _ibDate ? " active" : "");
        item.dataset.folder = df.name;
        item.innerHTML = `<span class="ic-name">${df.name}</span><span class="ic-meta">${df.file_count}</span>`;
        item.title = df.date ? `${df.date} — ${df.file_count} file(s)` : `${df.file_count} file(s)`;
        item.addEventListener("click", () => selectIBDate(df.name));
        col.appendChild(item);
      });
      if (!camData.date_folders || camData.date_folders.length === 0) {
        col.innerHTML = `<div class="importer-col-empty muted">No subfolders found</div>`;
      }
    }

    async function selectIBDate(folderName) {
      _ibDate = folderName;
      // Update active state in col 2
      const col2 = document.getElementById("importer-col-dates");
      if (col2) col2.querySelectorAll(".importer-col-item").forEach(el => {
        el.classList.toggle("active", el.dataset.folder === folderName);
      });
      const col3 = document.getElementById("importer-col-files");
      const fac = facilitySel && facilitySel.value;
      if (!col3 || !fac || _ibCam == null) return;
      col3.innerHTML = `<div class="importer-col-empty muted">Loading…</div>`;
      try {
        const url = `/api/import/browse_folder?facility=${encodeURIComponent(fac)}&camera=${encodeURIComponent(_ibCam)}&subfolder=${encodeURIComponent(folderName)}`;
        const r = await fetch(url);
        const d = await r.json().catch(() => ({}));
        if (!d.ok) throw new Error(d.error || "Failed");
        renderIBFiles(d.files || []);
      } catch (e) {
        col3.innerHTML = `<div class="importer-col-empty muted">${e.message || "Error"}</div>`;
      }
    }

    function renderIBFiles(files) {
      const col = document.getElementById("importer-col-files");
      if (!col) return;
      col.innerHTML = "";
      if (!files.length) {
        col.innerHTML = `<div class="importer-col-empty muted">No files</div>`;
        return;
      }
      files.forEach(f => {
        const item = document.createElement("div");
        item.className = "importer-col-item";
        item.innerHTML = `<span class="ic-name">${f.name}</span><span class="ic-meta">${f.timestamp || ""}</span>`;
        col.appendChild(item);
      });
    }

    function refreshIBDateHighlights() {
      if (!_ibData || _ibCam == null) return;
      const col2 = document.getElementById("importer-col-dates");
      if (!col2) return;
      const camData = (_ibData.cameras || []).find(c => c.camera === _ibCam);
      if (!camData || !camData.exists) return;
      col2.querySelectorAll(".importer-col-item").forEach((el, i) => {
        const df = (camData.date_folders || [])[i];
        if (!df) return;
        el.className = "importer-col-item";
        if (df.name === _ibDate) el.classList.add("active");
        const cls = _ibFolderClass(df.date);
        if (cls) el.classList.add(cls);
      });
    }

    // ── End Importer Column Browser ───────────────────────────────────────────

    // Kick resume once UI is ready
    resumeJobs();

    // Day Preparation — elements live inside #importer-browser; just ensure panel is visible
    function ensureDaysPanel() {
      const panel = document.getElementById("importer-browser");
      if (panel) panel.style.display = "";
    }

    // Simple status panel under the form
    function ensureStatusPanel() {
      let panel = document.getElementById("import-status");
      if (!panel) {
        panel = document.createElement("div");
        panel.id = "import-status";
        panel.className = "panel";
        panel.style.marginTop = "16px";
        panel.innerHTML = `
        <div class="panel-header"><h1>Import Status</h1></div>
        <div class="table-wrap">
          <div style="margin: 8px 0">
            <div id="overall-text" class="muted">Queued…</div>
            <div class="progress"><div id="overall-bar" class="bar" style="width:0%"></div></div>
          </div>
          <table id="status-table" style="width:100%; border-collapse:collapse; font-size:13px">
            <thead>
              <tr><th style="text-align:left; padding:6px 4px">Camera</th><th style="text-align:left; padding:6px 4px">Day</th><th style="text-align:left; padding:6px 4px">Segments</th><th style="text-align:left; padding:6px 4px">Status</th></tr>
            </thead>
            <tbody id="status-body"></tbody>
          </table>
        </div>`;
        document.getElementById("importer").after(panel);
        try {
          const hdr = panel.querySelector(".panel-header");
          if (hdr) {
            hdr.style.padding = "8px 12px";
            hdr.style.alignItems = "center";
          }
        } catch { }
      }
    }

    // Scan modal is static in the DOM — nothing to create dynamically
    function ensureScanPanel() { /* no-op: scan modal is static */ }

    function setScanMeta(text) {
      const meta = document.getElementById("scan-meta");
      if (meta) meta.textContent = text || "";
    }

    function setScanHeaderMeta(text) {
      const m = document.getElementById("scan-header-meta");
      if (m) m.textContent = text || "";
      // Badge CSS shows via :not(:empty) — no extra work needed
    }

    function startScanDots(base) {
      try { stopScanDots(); } catch { }
      scanDotsBase = (base && String(base)) || "Scanning";
      let i = 0;
      const el = document.getElementById("scan-running-meta");
      if (el) el.textContent = scanDotsBase + "…";
      scanDotsTimer = setInterval(() => {
        i = (i + 1) % 4;
        const e = document.getElementById("scan-running-meta");
        if (e) e.textContent = scanDotsBase + (i === 0 ? "…" : ".".repeat(i));
      }, 400);
    }

    function stopScanDots() {
      if (scanDotsTimer) { clearInterval(scanDotsTimer); scanDotsTimer = null; }
      const el = document.getElementById("scan-running-meta");
      if (el) el.textContent = "";
    }

    function formatCount(n) {
      try {
        const v = Number(n || 0);
        return `${v.toLocaleString()} file(s)`;
      } catch {
        return `${n} file(s)`;
      }
    }

    function isScanPanelCollapsed() {
      const modal = document.getElementById("scan-modal");
      return !modal || modal.hasAttribute("hidden");
    }

    function setScanPanelCollapsed(collapsed) {
      try {
        const modal = document.getElementById("scan-modal");
        if (!modal) return;
        if (collapsed) {
          modal.setAttribute("hidden", "");
        } else {
          modal.removeAttribute("hidden");
        }
      } catch { }
    }

    function resetScanTable() {
      scanSeenPaths = new Set();
      scanFilesMap = {};
      expandedPlanRows = new Set();
      const wrap = document.getElementById("scan-list");
      if (wrap) wrap.innerHTML = `<div class="plan-waiting">${scanMode === 'import' ? 'Building file plan…' : 'Listing files…'}</div>`;
    }

    // ── Plan-in-modal helpers ────────────────────────────────────────────────

    function _planStatusBadge(status, segs) {
      if (status === 'MISSING' || segs === 0)
        return `<span class="plan-badge plan-badge-missing">${status === 'MISSING' ? 'Missing' : 'No segments'}</span>`;
      if (status === 'DONE')
        return `<span class="plan-badge plan-badge-done">Done</span>`;
      if (status === 'RUNNING')
        return `<span class="plan-badge plan-badge-running">Running</span>`;
      if (status === 'FAIL' || status === 'FAILED')
        return `<span class="plan-badge plan-badge-fail">Failed</span>`;
      if (status === 'CANCELLED')
        return `<span class="plan-badge plan-badge-fail">Cancelled</span>`;
      return `<span class="plan-badge plan-badge-ready">Ready</span>`;
    }

    function _srcFileTr(f) {
      const fname = (f.path || '').split(/[\\/]/).pop();
      const dateStr = (f.start || '').split('T')[0] || '—';
      const startStr = (f.start_hms || '').slice(0, 5) || '—';
      const badge = f.in_range
        ? `<span class="scan-badge-range">In range</span>`
        : `<span class="plan-badge plan-badge-out">Out of range</span>`;
      return `<td class="scan-mono">${dateStr}</td><td class="scan-mono">${startStr}</td>` +
        `<td class="scan-path" title="${f.path || ''}">${fname}</td><td>${badge}</td>`;
    }

    function _srcBlock(files) {
      if (!files || !files.length)
        return '<div class="plan-src-empty">No source files accumulated yet.</div>';
      const rows = files.map(f => `<tr>${_srcFileTr(f)}</tr>`).join('');
      return `<div class="plan-src-inner"><table class="plan-src-table">
        <thead><tr><th>Date</th><th>Start</th><th>Filename</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
    }

    function _escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    function _stderrExpandBlock(stderr) {
      if (!stderr) return '';
      return `<div class="plan-src-inner" style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin-bottom:4px;">FFmpeg output</div>
        <pre style="font-size:11px;color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:6px 8px;margin:0;white-space:pre-wrap;word-break:break-all;max-height:160px;overflow-y:auto;">${_escHtml(stderr)}</pre>
      </div>`;
    }

function renderPlanInModal(plan) {
      if (!Array.isArray(plan) || !plan.length) return;
      const wrap = document.getElementById("scan-list");
      if (!wrap) return;
      // Preserve scroll position across re-renders
      const scrollContainer = document.getElementById('scan-content');
      const savedScroll = scrollContainer ? scrollContainer.scrollTop : 0;

      let html = `<table id="scan-table"><thead><tr>
        <th>Camera</th><th>Output file</th><th>Day</th><th>Sources</th><th>Status</th><th class="plan-th-expand"></th>
      </tr></thead><tbody>`;

      for (const cam of plan) {
        const camNum = cam.camera != null ? String(cam.camera).padStart(2, '0') : '??';
        for (const d of Array.isArray(cam.days) ? cam.days : []) {
          const dayNum = d.day != null ? String(d.day).padStart(2, '0') : '??';
          const status = String(d.status || '').toUpperCase();
          const mapKey = `${cam.camera}-${d.day}`;
          const srcFiles = scanFilesMap[mapKey] || [];
          const segs = srcFiles.length > 0 ? srcFiles.length
            : (typeof d.segments === 'number' ? d.segments : 0);
          const path = d.output || d.list_path || '';
          const fname = path.split(/[\\/]/).pop().replace(/\.txt$/i, '') || '—';
          const rowId = `plan-row-${camNum}-${dayNum}`;
          const srcId = `plan-src-${camNum}-${dayNum}`;
          const isOpen = expandedPlanRows.has(srcId);
          const stderr = (d.ffmpeg || '').trim();
          // Truncated snippet: last 3 non-empty lines for failed/cancelled rows
          let stderrSnip = '';
          if ((status === 'FAIL' || status === 'FAILED' || status === 'CANCELLED') && stderr) {
            const last3 = stderr.split('\n').map(l => l.trim()).filter(Boolean).slice(-3).join('\n');
            stderrSnip = `<div style="font-size:10px;color:var(--muted);margin-top:3px;font-family:monospace;white-space:pre-wrap;word-break:break-all;line-clamp:3;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;">${_escHtml(last3)}</div>`;
          }
          const stderrAttr = stderr ? ` data-stderr="${_escHtml(stderr).replace(/"/g, '&quot;')}"` : '';
          html += `<tr id="${rowId}" class="plan-output-row${status === 'MISSING' || segs === 0 ? ' plan-missing' : ''}">
            <td><span class="scan-cam-pill">Cam ${camNum}</span></td>
            <td class="plan-fname" title="${path}">${fname}</td>
            <td class="plan-day-cell">Day ${dayNum}</td>
            <td class="plan-segs">${segs}</td>
            <td>${_planStatusBadge(status, segs)}${stderrSnip}</td>
            <td><button class="plan-expand-btn${isOpen ? ' open' : ''}" data-target="${srcId}" data-mapkey="${mapKey}"${stderrAttr}>${isOpen ? '▾' : '▸'}</button></td>
          </tr>`;
          html += `<tr id="${srcId}" class="plan-src-row"${isOpen ? '' : ' style="display:none"'}>
            <td colspan="6">${isOpen ? (_srcBlock(scanFilesMap[mapKey] || []) + _stderrExpandBlock(stderr)) : ''}</td>
          </tr>`;
        }
      }
      html += '</tbody></table>';
      wrap.innerHTML = html;
      // Restore scroll after re-render
      if (scrollContainer && savedScroll > 0) scrollContainer.scrollTop = savedScroll;

      // Wire expand toggles — refresh source block lazily from current scanFilesMap
      wrap.querySelectorAll('.plan-expand-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const sid = btn.dataset.target;
          const row = document.getElementById(sid);
          if (!row) return;
          const opening = row.style.display === 'none';
          if (opening) {
            const td = row.querySelector('td');
            const stderr = btn.dataset.stderr || '';
            if (td) td.innerHTML = _srcBlock(scanFilesMap[btn.dataset.mapkey] || []) + _stderrExpandBlock(stderr);
          }
          row.style.display = opening ? '' : 'none';
          btn.textContent = opening ? '▾' : '▸';
          btn.classList.toggle('open', opening);
          if (opening) expandedPlanRows.add(sid);
          else expandedPlanRows.delete(sid);
        });
      });

    }

    // Expose for renderDaysPlan (defined outside initImporter)
    window.__renderPlanInModal = renderPlanInModal;

    function ensureScanTable() { /* no-op: plan table built by renderPlanInModal */ }
    function clearScanPlaceholder() { /* no-op */ }

    function startScanProgress(message) {
      const box = document.getElementById("scan-progress");
      const bar = document.getElementById("scan-bar");
      const cancelBtn = document.getElementById("scan-cancel");
      const runBtn = document.getElementById("run-btn");
      const statsRow = document.getElementById("scan-stats-row");
      // Open the scan modal
      setScanPanelCollapsed(false);
      // Show cancel, disable run, hide stats
      if (cancelBtn) cancelBtn.style.display = "";
      if (runBtn) { runBtn.disabled = true; runBtn.textContent = "Start Import"; }
      if (statsRow) statsRow.style.display = "none";
      startScanDots(scanMode === "import" ? "Scanning" : "Listing");
      if (box) box.style.display = "";
      // CSS indeterminate animation — no setInterval needed
      if (bar) { bar.classList.add("indeterminate"); bar.style.width = ""; }
      if (scanAnimTimer) { clearInterval(scanAnimTimer); scanAnimTimer = null; }
      setScanMeta("");
      resetScanTable();
    }

    function stopScanProgress() {
      const box = document.getElementById("scan-progress");
      if (box) box.style.display = "none";
      stopScanDots();
      setScanHeaderMeta("");
      if (scanAnimTimer) { clearInterval(scanAnimTimer); scanAnimTimer = null; }
      const bar = document.getElementById("scan-bar");
      if (bar) { bar.classList.remove("indeterminate"); bar.style.width = "0%"; }
      const cancelBtn = document.getElementById("scan-cancel");
      if (cancelBtn) cancelBtn.style.display = "none";
    }

    function expandScanPanelOnError(message) {
      try {
        setScanPanelCollapsed(false);
        setScanHeaderMeta("Error");
        const meta = document.getElementById("scan-meta");
        if (meta && message) meta.textContent = message;
      } catch { }
    }

    function _updateScanStats() {
      try {
        let totalFiles = 0, inRange = 0;
        const cams = new Set();
        for (const [key, files] of Object.entries(scanFilesMap)) {
          totalFiles += files.length;
          const camPart = key.split('-')[0];
          if (camPart) cams.add(camPart);
          for (const f of files) { if (f.in_range) inRange++; }
        }
        const statCams = document.getElementById("stat-cams");
        const statFiles = document.getElementById("stat-files");
        const statRange = document.getElementById("stat-range");
        if (statCams) statCams.textContent = cams.size;
        if (statFiles) statFiles.textContent = totalFiles;
        if (statRange) statRange.textContent = inRange;
        const statsRow = document.getElementById("scan-stats-row");
        if (statsRow && totalFiles > 0) statsRow.style.display = "";
      } catch { }
    }

    function renderScanResults(data) {
      ensureScanTable();
      const files = Array.isArray(data.files) ? data.files : [];
      if (!files.length && scanSeenPaths.size === 0) return;
      updateScanRows(files);
    }

    function updateScanRows(files) {
      if (!Array.isArray(files)) return;
      for (const f of files) {
        const key = (f && f.path) ? String(f.path) : "";
        if (!key || scanSeenPaths.has(key)) continue;
        if (scanFilterInRange && !f.in_range) continue;
        scanSeenPaths.add(key);
        appendScanRow(f);
      }
    }

    function appendScanRow(f) {
      if (!f || !f.path) return;
      // Accumulate in map
      const mapKey = `${f.camera}-${f.day != null ? f.day : 'x'}`;
      if (!scanFilesMap[mapKey]) scanFilesMap[mapKey] = [];
      scanFilesMap[mapKey].push(f);
      _updateScanStats();

      if (scanMode !== 'import') {
        // List mode: render a raw file row directly into the table
        _appendRawFileRow(f);
        return;
      }

      // Import mode: incremental DOM update if plan is already rendered
      const camNum = f.camera != null ? String(f.camera).padStart(2, '0') : '??';
      const dayNum = f.day != null ? String(f.day).padStart(2, '0') : '??';
      const srcId = `plan-src-${camNum}-${dayNum}`;
      const srcRow = document.getElementById(srcId);
      if (srcRow) {
        const tbody = srcRow.querySelector('tbody');
        if (tbody) {
          const tr = document.createElement('tr');
          tr.innerHTML = _srcFileTr(f);
          tbody.appendChild(tr);
        } else {
          const td = srcRow.querySelector('td');
          if (td) td.innerHTML = _srcBlock(scanFilesMap[mapKey]);
        }
        const planRow = document.getElementById(`plan-row-${camNum}-${dayNum}`);
        if (planRow) {
          const cell = planRow.querySelector('.plan-segs');
          if (cell) cell.textContent = scanFilesMap[mapKey].length;
        }
      }
    }

    function _appendRawFileRow(f) {
      // Ensure a basic table exists for list-mode scans
      const wrap = document.getElementById("scan-list");
      if (!wrap) return;
      let tbody = document.getElementById("scan-tbody");
      if (!tbody) {
        wrap.innerHTML = `<table id="scan-table"><thead><tr>
          <th>Camera</th><th>Date</th><th>Start</th><th>Filename</th><th>Status</th>
        </tr></thead><tbody id="scan-tbody"></tbody></table>`;
        tbody = document.getElementById("scan-tbody");
      }
      if (!tbody) return;
      const camNum = f.camera != null ? String(f.camera).padStart(2, '0') : '—';
      const startTxt = (f.start || '').replace('T', ' ');
      const parts = startTxt.split(' ');
      const dateStr = parts[0] || '—';
      const startStr = (f.start_hms || parts[1] || '—').slice(0, 5);
      const fname = (f.path || '').split(/[\\/]/).pop() || f.path || '';
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><span class="scan-cam-pill">Cam ${camNum}</span></td>
        <td>${dateStr}</td><td class="scan-mono">${startStr}</td>
        <td class="scan-path" title="${f.path || ''}">${fname}</td>
        <td>${f.in_range ? '<span class="scan-badge-range">In range</span>' : ''}</td>`;
      tbody.appendChild(tr);
    }

    function renderPlan(data) {
      const body = document.getElementById("status-body");
      if (!body) return;
      const bar = document.getElementById("overall-bar");
      const txt = document.getElementById("overall-text");
      let rows = "";
      for (const cam of data.jobs) {
        for (const d of cam.days) {
          rows += `<tr>
          <td style="padding:6px 4px">cam${String(cam.camera).padStart(
            2,
            "0"
          )}</td>
          <td style="padding:6px 4px">${String(d.day).padStart(2, "0")}</td>
          <td style="padding:6px 4px">${d.segments || 0}</td>
          <td style="padding:6px 4px">${d.status || ""}</td>
        </tr>`;
        }
      }
      body.innerHTML =
        rows ||
        '<tr><td colspan="4" class="muted" style="padding:6px">No jobs.</td></tr>';
      if (
        typeof data.progress === "number" &&
        typeof data.total === "number" &&
        data.total > 0
      ) {
        const pct = Math.round((100 * data.progress) / data.total);
        bar.style.width = pct + "%";
        txt.textContent = `Progress: ${data.progress}/${data.total}`;
      }
    }

    async function pollStatus(jobId) {
      const url = `/api/import/status?job=${encodeURIComponent(jobId)}`;
      const timer = setInterval(async () => {
        try {
          const r = await fetch(url);
          const s = await r.json();
          if (!r.ok || !s || s.error) {
            throw new Error((s && s.error) || r.statusText);
          }
          const merged = Object.assign({}, s.plan, {
            progress: s.progress,
            total: s.total,
          });
          renderPlan(merged);
          if (s.status === "DONE") {
            clearInterval(timer);
          }
        } catch (e) {
          clearInterval(timer);
        }
      }, 2000);
    }

    // Initialize
    populateFacilities();
    initFromUrl();
    validate();
    if (runTopBtn)
      runTopBtn.addEventListener("click", () => {
        const rb = document.getElementById("run-btn");
        if (rb && rb.dataset && rb.dataset.running === "1") {
          onStopEncode();
        } else {
          onRunEncode();
        }
      });

    // Scan modal close helpers
    async function closeScanModal() {
      try {
        const sjid = (window.__SCAN_JOB_ID__ || '').trim();
        if (sjid) {
          const active = await isScanActive(sjid);
          if (active) {
            try { if (scanPollTimer) { clearInterval(scanPollTimer); scanPollTimer = null; } } catch { }
            try { await fetch(`/api/import/scan_prepare/cancel?job=${encodeURIComponent(sjid)}`, { method: 'POST' }); } catch { }
            scanController = null;
            stopScanProgress();
            setScanMeta("Scan canceled.");
            try { localStorage.removeItem('cheesepie.scan_job'); } catch { }
            try { window.__SCAN_JOB_ID__ = null; } catch { }
            try { clearScanMode(); } catch { }
            try { setListBtnState("idle"); } catch { }
            try { setListImportBtnState("idle"); } catch { }
            if (!isEncoding()) { try { setImportBtnStateIdle(); } catch { } }
          }
        }
      } catch { }
      setScanPanelCollapsed(true);
    }
    // Wire close buttons
    const scanModalX = document.getElementById("scan-modal-x");
    const scanModalCancel = document.getElementById("scan-modal-cancel");
    const scanCancelBtn = document.getElementById("scan-cancel");
    if (scanModalX) scanModalX.addEventListener("click", closeScanModal);
    if (scanModalCancel) scanModalCancel.addEventListener("click", closeScanModal);
    if (scanCancelBtn) scanCancelBtn.addEventListener("click", async () => {
      // Show Cancelling… immediately, prevent double-click
      if (scanCancelBtn.dataset.cancelling === '1') return;
      scanCancelBtn.dataset.cancelling = '1';
      scanCancelBtn.disabled = true;
      scanCancelBtn.textContent = 'Cancelling…';
      try { if (scanPollTimer) { clearInterval(scanPollTimer); scanPollTimer = null; } } catch { }
      try {
        const jid = (window.__SCAN_JOB_ID__ || '').trim();
        if (jid) { await fetch(`/api/import/scan_prepare/cancel?job=${encodeURIComponent(jid)}`, { method: 'POST' }); }
      } catch { }
      scanCancelBtn.dataset.cancelling = '0';
      scanCancelBtn.disabled = false;
      scanCancelBtn.textContent = 'Cancel Scan';
      scanController = null;
      stopScanProgress();
      setScanMeta("Scan canceled.");
      try { localStorage.removeItem('cheesepie.scan_job'); } catch { }
      try { window.__SCAN_JOB_ID__ = null; } catch { }
      try { clearScanMode(); } catch { }
      try { setListBtnState("idle"); } catch { }
      try { setListImportBtnState("idle"); } catch { }
      if (!isEncoding()) { try { setImportBtnStateIdle(); } catch { } }
    });
    // Close on Escape key
    document.addEventListener("keydown", (e) => {
      try {
        const scanModal = document.getElementById("scan-modal");
        if (!scanModal || scanModal.hasAttribute("hidden")) return;
        if (e.key === "Escape") { e.preventDefault(); closeScanModal(); }
      } catch { }
    }, { signal });
    // Close on backdrop click
    const scanModalEl = document.getElementById("scan-modal");
    if (scanModalEl) {
      scanModalEl.addEventListener("click", (e) => {
        if (e.target === scanModalEl) closeScanModal();
      });
    }

    async function refreshBatch() {
      if (!batchAutoMode) {
        // In manual mode just verify the current value
        scheduleBatchCheck(0);
        return;
      }
      const exp = experimentSel.value;
      const trt = treatmentSel.value;
      const fac = facilitySel.value;
      if (!exp || !trt) {
        batchInput.value = "1";
        setBatchAvailability(true, "");
        return;
      }
      try {
        const r = await fetch(
          `/api/import/next_batch?facility=${encodeURIComponent(
            fac
          )}&experiment=${encodeURIComponent(exp)}&treatment=${encodeURIComponent(
            trt
          )}`
        );
        const d = await r.json();
        if (r.ok && d && d.ok) {
          batchInput.value = d.next_batch;
          setBatchAvailability(true, "");
        } else {
          batchInput.value = "1";
          setBatchAvailability(false, "Unable to verify batch availability.");
        }
      } catch {
        batchInput.value = "1";
        setBatchAvailability(false, "Unable to verify batch availability.");
      }
      updateUrl();
    }

    async function showBatchConflictWarning(conflictBatch) {
      const m = document.getElementById('scan-meta');
      if (!m) return;
      let nextBatch = conflictBatch + 1;
      try {
        const r = await fetch(`/api/import/next_batch?facility=${encodeURIComponent(facilitySel.value)}&experiment=${encodeURIComponent(experimentSel.value)}&treatment=${encodeURIComponent(treatmentSel.value)}`);
        const d = await r.json();
        if (d && d.next_batch) nextBatch = d.next_batch;
      } catch { }
      m.innerHTML = '';
      m.appendChild(document.createTextNode(`Batch ${conflictBatch} already has encoded files. `));
      const fix = document.createElement('button');
      fix.className = 'btn mini';
      fix.textContent = `Use batch ${nextBatch}`;
      fix.style.cssText = 'font-size:11px;padding:1px 8px;vertical-align:middle;margin-left:4px;';
      fix.addEventListener('click', async () => {
        batchInput.value = String(nextBatch);
        await checkBatchAvailability();
        m.textContent = '';
        const rb = document.getElementById('run-btn');
        if (rb && window.__DAYS_PLAN__ && window.__DAYS_PLAN__.length > 0) {
          rb.disabled = false;
          rb.textContent = 'Start Import';
          rb.classList.add('primary');
        }
        validate();
      });
      m.appendChild(fix);
    }

    let encodeJobId = null;
    let encodeTaskId = null;          // task_id of the running/last encode job (for retry)
    let encodeTimer = null;
    let _lastLoggedCmd = null;
    let currentRunPlan = null;
    let encodeStartWallTime = null;   // Date.now() when first RUNNING progress seen
    let encodeStartPct = 0;           // pct value at that moment (for rate calc)
    let encodeJobStartTime = null;    // Date.now() when job was submitted (for wall time)
    async function onRunEncode() {
      const fac = facilitySel.value;
      const exp = experimentSel.value;
      const trt = treatmentSel.value;
      const batch = getBatchValue();
      const plan = currentRunPlan || window.__DAYS_PLAN__ || [];
      const runBtn = document.getElementById("run-btn");
      const importBtnTop = document.getElementById('open-import');
      if (batchAvailable === false) {
        await showBatchConflictWarning(getBatchValue());
        if (runBtn) { runBtn.disabled = false; runBtn.textContent = "Start Import"; }
        return;
      }
      // Warn if any days have no source files and will be skipped
      const missingDays = plan.filter(item => {
        const st = (item.status || '').toUpperCase();
        const segs = parseInt(item.segments, 10);
        return st === 'MISSING' || segs === 0;
      });
      if (missingDays.length > 0) {
        const camDayList = missingDays.slice(0, 5)
          .map(m => `cam ${m.cam ?? m.camera ?? '?'} day ${m.day ?? '?'}`)
          .join(', ') + (missingDays.length > 5 ? ` … (+${missingDays.length - 5} more)` : '');
        const ok = window.confirm(
          `${missingDays.length} day${missingDays.length === 1 ? '' : 's'} have no source files and will be skipped:\n${camDayList}\n\nContinue anyway?`
        );
        if (!ok) {
          if (runBtn) { runBtn.disabled = false; runBtn.textContent = "Start Import"; }
          return;
        }
      }
      if (runBtn) {
        runBtn.disabled = true;
        runBtn.textContent = "Running…";
      }
      try {
        encodeStartWallTime = null;
        encodeStartPct = 0;
        encodeTaskId = null;
        encodeJobStartTime = Date.now();
        try { _clearFfmpegLog(); } catch { }
        try { const rb = document.getElementById('retry-failed-btn'); if (rb) rb.style.display = 'none'; } catch { }
        try { const hb = document.getElementById('health-warn-banner'); if (hb) { hb.style.display = 'none'; hb.textContent = ''; } } catch { }
        const progBox = document.getElementById("encode-progress");
        const progBar = document.getElementById("encode-bar");
        const progTxt = document.getElementById("encode-text");
        // Hide overall progress; we'll reflect progress in-row instead
        if (progBox) progBox.style.display = "none";
        if (progBar) progBar.style.width = "0%";
        if (progTxt) progTxt.textContent = "";
        const res = await fetch("/api/import/encode_days", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            facility: fac,
            experiment: exp,
            treatment: trt,
            batch,
            plan,
            start_date: startDate.value || "",
            end_date: endDate.value || "",
            start_time: startTime.value || "",
            end_time: endTime.value || "",
          }),
        });
        const data = await res.json();
        if (!res.ok || !data || data.error) {
          throw new Error((data && data.error) || res.statusText);
        }
        // If server returned a background job id, poll status.
        if (data.job_id) {
          encodeJobId = data.job_id;
          try {
            window.__ENCODE_JOB_ID__ = encodeJobId;
          } catch { }
          try { localStorage.setItem('cheesepie.encode_job', encodeJobId); } catch { }
          const rb = document.getElementById("run-btn");
          if (rb) {
            rb.disabled = false;
            rb.textContent = "Stop";
            rb.style.background = "#b71c1c";
            rb.style.color = "#fff";
            rb.title = "Cancel encoding";
            rb.dataset.running = "1";
          }
          if (importBtnTop) { importBtnTop.disabled = false; importBtnTop.textContent = 'Cancel'; importBtnTop.style.background = '#b71c1c'; importBtnTop.style.color = '#fff'; importBtnTop.dataset.running = '1'; }
          // Optimistically flag first runnable item as RUNNING
          try {
            const planArr = Array.isArray(window.__DAYS_PLAN__)
              ? window.__DAYS_PLAN__
              : [];
            let marked = false;
            for (const cam of planArr) {
              const days = Array.isArray(cam.days) ? cam.days : [];
              for (const d of days) {
                const st = String(d.status || "").toUpperCase();
                const segs =
                  typeof d.segments === "number"
                    ? d.segments
                    : st === "MISSING"
                      ? 0
                      : 1;
                if (
                  segs > 0 &&
                  st !== "DONE" &&
                  st !== "FAIL" &&
                  st !== "FAILED"
                ) {
                  d.status = "RUNNING";
                  marked = true;
                  break;
                }
              }
              if (marked) break;
            }
            if (marked) renderDaysPlan({ plan: planArr, status: "RUNNING" });
          } catch { }
          pollEncode();
        } else {
          // Fallback: render immediate plan (sync encode flow)
          if (data && data.plan) {
            try {
              renderDaysPlan(data);
            } catch (e) {
              // no-op; UI error surface elsewhere
            }
          }
          if (runBtn) {
            runBtn.disabled = false;
            runBtn.textContent = "Start Import";
          }
          if (importBtnTop) { importBtnTop.disabled = false; importBtnTop.textContent = "Import"; importBtnTop.style.background = ""; importBtnTop.style.color = ""; importBtnTop.dataset.running = "0"; }
        }
      } catch (e) {
        const errMsg = String((e && e.message) || e || "Unknown error");
        const isBatchConflict = /already exists/i.test(errMsg);
        if (isBatchConflict) {
          const bm = errMsg.match(/Batch (\d+)/i);
          await showBatchConflictWarning(bm ? parseInt(bm[1]) : getBatchValue());
        } else {
          try { const m = document.getElementById('scan-meta'); if (m) m.textContent = `Error: ${errMsg}`; } catch { }
          showError("Run error", e);
        }
        if (runBtn) {
          runBtn.disabled = false;
          runBtn.textContent = "Start Import";
        }
        if (runBtn) runBtn.title = isBatchConflict ? '' : errMsg;
        // Reset Import button and clear any encode state
        try {
          const ib = document.getElementById('open-import');
          if (ib) { ib.disabled = false; ib.textContent = 'Import'; ib.style.background = ''; ib.style.color = ''; ib.dataset.running = '0'; }
        } catch { }
        try { window.__ENCODE_JOB_ID__ = null; } catch { }
        try { localStorage.removeItem('cheesepie.encode_job'); } catch { }
      }
    }

    async function pollEncode() {
      if (!encodeJobId) return;
      // Guard: never run two timers for the same job
      if (encodeTimer) { clearInterval(encodeTimer); encodeTimer = null; }
      const runBtn = document.getElementById("run-btn");
      const importBtnTop = document.getElementById('open-import');
      encodeTimer = setInterval(async () => {
        try {
          const r = await fetch(
            `/api/import/encode_status?job=${encodeURIComponent(encodeJobId)}`
          );
          const s = await r.json();
          if (!r.ok || !s || s.error) {
            throw new Error((s && s.error) || r.statusText);
          }
          if (s && s.plan) {
            renderDaysPlan(s);
          }
          // Track task_id for retry
          if (s && s.task_id) encodeTaskId = s.task_id;
          // Append new ffmpeg commands to the log panel
          try {
            const cmd = s && s.current_cmd;
            if (cmd && cmd !== _lastLoggedCmd) {
              _lastLoggedCmd = cmd;
              _appendFfmpegLog(cmd);
            }
          } catch { }
          // While encoding is active, ensure Import button is in Cancel state
          try {
            const st = String(s.status || '').toUpperCase();
            const ib = document.getElementById('open-import');
            if (ib) {
              if (st === 'RUNNING' || st === 'QUEUED') {
                ib.disabled = false; ib.textContent = 'Cancel'; ib.style.background = '#b71c1c'; ib.style.color = '#fff'; ib.dataset.running = '1';
              }
            }
          } catch { }
          if (s.status === "DONE" || s.status === "CANCELLED") {
            clearInterval(encodeTimer);
            encodeTimer = null;
            encodeStartWallTime = null;
            if (runBtn) {
              runBtn.disabled = false;
              runBtn.textContent = "Start Import";
              runBtn.style.background = "";
              runBtn.style.color = "";
              runBtn.dataset.running = "0";
              runBtn.title = "";
            }
            if (importBtnTop) { importBtnTop.disabled = false; importBtnTop.textContent = "Import"; importBtnTop.style.background = ""; importBtnTop.style.color = ""; importBtnTop.dataset.running = "0"; importBtnTop.title = ""; }
            currentRunPlan = null;
            try {
              window.__ENCODE_JOB_ID__ = null;
            } catch { }
            try { localStorage.removeItem('cheesepie.encode_job'); } catch { }
          }
        } catch (err) {
          clearInterval(encodeTimer);
          encodeTimer = null;
          encodeStartWallTime = null;
          if (runBtn) {
            runBtn.disabled = false;
            runBtn.textContent = "Start Import";
            runBtn.style.background = "";
            runBtn.style.color = "";
            runBtn.dataset.running = "0";
            runBtn.title = "";
          }
          if (importBtnTop) { importBtnTop.disabled = false; importBtnTop.textContent = "Import"; importBtnTop.style.background = ""; importBtnTop.style.color = ""; importBtnTop.dataset.running = "0"; importBtnTop.title = ""; }
          try {
            window.__ENCODE_JOB_ID__ = null;
          } catch { }
          try { localStorage.removeItem('cheesepie.encode_job'); } catch { }
        }
      }, 2000);
    }

    async function onStopEncode() {
      if (!encodeJobId) return;
      const rb = document.getElementById("run-btn");
      if (rb) {
        rb.disabled = true;
        rb.textContent = "Stopping…";
        rb.style.background = "#b71c1c";
        rb.style.color = "#fff";
      }
      try {
        const r = await fetch(
          `/api/import/encode_cancel?job=${encodeURIComponent(encodeJobId)}`,
          { method: "POST" }
        );
        const s = await r.json();
        if (!r.ok || !s || s.error)
          throw new Error((s && s.error) || r.statusText);
      } catch (e) {
        showError("Cancel error", e);
        if (rb) {
          rb.disabled = false;
          rb.textContent = "Stop";
          rb.style.background = "#b71c1c";
          rb.style.color = "#fff";
          rb.title = "Cancel encoding";
        }
      }
    }

    // Retry Failed
    async function onRetryFailed() {
      if (!encodeTaskId) return;
      const retryBtn = document.getElementById('retry-failed-btn');
      if (retryBtn) { retryBtn.disabled = true; retryBtn.textContent = 'Retrying…'; }
      try {
        encodeStartWallTime = null;
        encodeStartPct = 0;
        encodeJobStartTime = Date.now();
        try { _clearFfmpegLog(); } catch { }
        try { const hb = document.getElementById('health-warn-banner'); if (hb) { hb.style.display = 'none'; hb.textContent = ''; } } catch { }
        const res = await fetch('/api/import/retry_failed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task_id: encodeTaskId }),
        });
        const data = await res.json();
        if (!res.ok || !data || data.error) throw new Error((data && data.error) || res.statusText);
        encodeJobId = data.job_id;
        encodeTaskId = null;
        try { window.__ENCODE_JOB_ID__ = encodeJobId; } catch { }
        try { localStorage.setItem('cheesepie.encode_job', encodeJobId); } catch { }
        if (retryBtn) { retryBtn.style.display = 'none'; retryBtn.disabled = false; retryBtn.textContent = 'Retry Failed'; }
        pollEncode();
      } catch (e) {
        if (retryBtn) { retryBtn.disabled = false; retryBtn.textContent = 'Retry Failed'; }
        showError('Retry error', e);
      }
    }

    const retryFailedBtn = document.getElementById('retry-failed-btn');
    if (retryFailedBtn) retryFailedBtn.addEventListener('click', onRetryFailed);

    // Register cleanup so the next initImporter() call can clear these timers.
    _importerCleanup = function () {
      if (scanPollTimer) { clearInterval(scanPollTimer); }
      if (scanDotsTimer) { clearInterval(scanDotsTimer); }
      if (batchCheckTimer) { clearInterval(batchCheckTimer); }
      if (encodeTimer) { clearInterval(encodeTimer); }
    };
  }
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", initImporter);
  } else {
    initImporter();
  }
  window.cheesepieRegisterPageRefresher?.("importer", initImporter);

  // Renders the Day Preparation plan into the table and updates controls
  function _appendFfmpegLog(cmd) {
    const panel = document.getElementById('ffmpeg-log-panel');
    const entries = document.getElementById('ffmpeg-log-entries');
    const toggle = document.getElementById('ffmpeg-log-toggle');
    if (!panel || !entries) return;
    panel.style.display = '';
    // Bind toggle once
    if (toggle && !toggle._bound) {
      toggle._bound = true;
      toggle.addEventListener('click', () => {
        const open = entries.style.display !== 'none';
        entries.style.display = open ? 'none' : '';
        toggle.setAttribute('aria-expanded', String(!open));
        toggle.querySelector('.ffmpeg-log-arrow').textContent = open ? '▶' : '▼';
        if (!open) entries.scrollTop = entries.scrollHeight;
      });
    }
    const ts = new Date().toTimeString().slice(0, 8);
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const row = document.createElement('div');
    row.className = 'ffmpeg-log-entry';
    row.innerHTML = `<span class="ffmpeg-log-ts">${ts}</span><code class="ffmpeg-log-cmd">${esc(cmd)}</code><button class="ffmpeg-log-copy" title="Copy command">⎘</button>`;
    const copyBtn = row.querySelector('.ffmpeg-log-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(cmd);
          copyBtn.textContent = '✓';
          setTimeout(() => { copyBtn.textContent = '⎘'; }, 1500);
        } catch { copyBtn.textContent = '✗'; setTimeout(() => { copyBtn.textContent = '⎘'; }, 1500); }
      });
    }
    entries.appendChild(row);
    if (entries.style.display !== 'none') entries.scrollTop = entries.scrollHeight;
  }

  function _clearFfmpegLog() {
    _lastLoggedCmd = null;
    const panel = document.getElementById('ffmpeg-log-panel');
    const entries = document.getElementById('ffmpeg-log-entries');
    const toggle = document.getElementById('ffmpeg-log-toggle');
    if (entries) { entries.innerHTML = ''; entries.style.display = 'none'; }
    if (toggle) { toggle.setAttribute('aria-expanded', 'false'); const arr = toggle.querySelector('.ffmpeg-log-arrow'); if (arr) arr.textContent = '▶'; toggle._bound = false; }
    if (panel) panel.style.display = 'none';
  }

  function renderDaysPlan(data) {
    try {
      // Ensure the panel exists
      (function ensure() {
        if (!document.getElementById("days-body")) {
          if (typeof ensureDaysPanel === "function") ensureDaysPanel();
        }
      })();
      const body = document.getElementById("days-body");
      const runBtn = document.getElementById("run-btn");
      if (!body) return;
      const plan = Array.isArray(data && data.plan) ? data.plan : [];
      window.__DAYS_PLAN__ = plan;
      try { if (typeof window.__renderPlanInModal === 'function') window.__renderPlanInModal(plan); } catch { }

      let rows = "";
      let anyWait = false;
      for (const cam of plan) {
        const camStr =
          cam && cam.camera != null
            ? String(cam.camera).padStart(2, "0")
            : "??";
        const days = Array.isArray(cam && cam.days) ? cam.days : [];
        for (const d of days) {
          const dayStr =
            d && d.day != null ? String(d.day).padStart(2, "0") : "??";
          const statusRaw = String((d && d.status) || "");
          const status = statusRaw.toUpperCase();
          const segs =
            typeof d.segments === "number"
              ? d.segments
              : status === "MISSING"
                ? 0
                : 1;
          // Any item with segments that hasn't finished counts as runnable
          if (segs > 0 && status !== "DONE" && status !== "FAIL" && status !== "FAILED" && status !== "CANCELLED" && status !== "MISSING" && status !== "RUNNING")
            anyWait = true;
          // Status with color badges
          let statusHtml = status;
          if (status === "RUNNING") {
            statusHtml = `<span style="background:#00A0B0;color:#D8F9FF;padding:2px 6px;border-radius:10px;font-weight:600">RUNNING</span>`;
          } else if (status === "DONE") {
            statusHtml = `<span style="background:#A2D15C;color:#335500;padding:2px 6px;border-radius:10px;font-weight:600">DONE</span>`;
          } else if (status === "FAIL" || status === "FAILED") {
            statusHtml = `<span style="background:#CC333F;color:#FFD6D9;padding:2px 6px;border-radius:10px;font-weight:600">FAILED</span>`;
          } else if (status === "CANCELLED") {
            statusHtml = `<span style="background:#CC333F;color:#FFD6D9;padding:2px 6px;border-radius:10px;font-weight:600">CANCELLED</span>`;
          } else if (status === "PENDING") {
            statusHtml = `<span style="background:#EDC951;color:#7A5F00;padding:2px 6px;border-radius:10px;font-weight:600">PENDING</span>`;
          } else if (status === "MISSING") {
            statusHtml = `<span style="background:#CC333F;color:#FFD6D9;padding:2px 6px;border-radius:10px;font-weight:600">MISSING</span>`;
          } else if (status === "WAITING" || status === "PLANNED") {
            statusHtml = `<span style="background:#A19381;color:#3F2D18;padding:2px 6px;border-radius:10px;font-weight:600">${status}</span>`;
          }
          // Duration cell
          let durTxt = "";
          const toHMS = (secs) => {
            if (typeof secs !== "number" || !isFinite(secs) || secs <= 0)
              return "";
            const s = Math.floor(secs);
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const sec = s % 60;
            const pad = (n) => String(n).padStart(2, "0");
            return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
          };
          if (d && d.duration != null) {
            durTxt = toHMS(Number(d.duration));
          } else if (d && d.health && typeof d.health.actual === "number") {
            durTxt = toHMS(Number(d.health.actual));
          }

          let healthTxt = "";
          if (d && d.health && typeof d.health === "object") {
            const ok = !!d.health.ok;
            healthTxt = ok
              ? `<span style=\"background:#A2D15C;color:#ffffff;padding:2px 6px;border-radius:10px;font-weight:600\">GOOD</span>`
              : `<span style=\"background:#CC333F;color:#ffffff;padding:2px 6px;border-radius:10px;font-weight:600\">POOR</span>`;
          }
          const path = (d && (d.output || d.list_path)) || "";
          rows += `<tr>
            <td style=\"padding:6px 4px\">${camStr}</td>
            <td style=\"padding:6px 4px\">${dayStr}</td>
            <td style=\"padding:6px 4px\">${segs}</td>
            <td style=\"padding:6px 4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis\">${(path && !/\.txt$/i.test(path)) ? `<a href=\"#\" class=\"dp-preview\" data-path=\"${encodeURIComponent(path)}\" title=\"Preview video\">${path}</a>` : (path || '')}</td>
            <td style=\"padding:6px 4px\">${durTxt}</td>
            <td style=\"padding:6px 4px\">${statusHtml}</td>
            <td style=\"padding:6px 4px\">${healthTxt}</td>
          </tr>`;
        }
      }
      // Update table body (sb-days-section stays hidden; modal is the only UI)
      body.innerHTML = rows || '';

      // ── Modal encode-progress feedback ──────────────────────────────────────
      try {
        const encodeSt = String((data && data.status) || '').toUpperCase();
        let totalRunnable = 0, doneCount = 0, failCount = 0;
        for (const cam of plan) {
          for (const d of (Array.isArray(cam.days) ? cam.days : [])) {
            const st = String(d.status || '').toUpperCase();
            const segs = typeof d.segments === 'number' ? d.segments : (st === 'MISSING' ? 0 : 1);
            if (segs > 0 && st !== 'MISSING') {
              totalRunnable++;
              if (st === 'DONE') doneCount++;
              else if (st === 'FAIL' || st === 'FAILED') failCount++;
            }
          }
        }
        const progBox = document.getElementById('scan-progress');
        const progBar = document.getElementById('scan-bar');
        const progMeta = document.getElementById('scan-running-meta');
        const metaEl = document.getElementById('scan-meta');
        const cancelBtn = document.getElementById('scan-cancel');
        if (encodeSt === 'RUNNING' || encodeSt === 'QUEUED') {
          if (cancelBtn) cancelBtn.style.display = 'none';
          if (progBox) progBox.style.display = '';

          // Fine-grained progress: count done files + fractional progress of current file
          const outTimeUs = (data && data.out_time_us) || 0;
          const totalDur  = (data && data.current_total_duration) || 0;
          const fps       = (data && data.fps)   || 0;
          const speed     = (data && data.speed) || 0;   // plain float from backend
          const fileFrac  = (totalDur > 0) ? Math.min(outTimeUs / 1e6 / totalDur, 1) : 0;
          const pct = totalRunnable > 0
            ? Math.round((doneCount + fileFrac) / totalRunnable * 100)
            : 0;
          if (progBar) { progBar.classList.remove('indeterminate'); progBar.style.width = pct + '%'; }

          // Fallback wall-clock ETA (used only when server eta_seconds is unavailable)
          if (pct > 0 && encodeStartWallTime === null) {
            encodeStartWallTime = Date.now();
            encodeStartPct = pct;
          }

          // Build status text
          const fmtTime = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s/3600), m = Math.floor(s%3600/60), sec = s%60; return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; };
          const activeDayNum = Math.min(doneCount + 1, totalRunnable);
          let txt = `Encoding day ${activeDayNum} of ${totalRunnable}`;
          if (doneCount > 0) txt += ` (${doneCount} done)`;
          if (totalDur > 0 && outTimeUs > 0) {
            txt += `  ·  ${fmtTime(outTimeUs / 1e6)} / ${fmtTime(totalDur)}`;
          }
          // fps is only meaningful for transcode; skip in copy mode (astronomically high)
          if (fps > 0 && fps < 500) txt += `  ·  ${fps.toFixed(1)} fps`;
          // speed is a plain float — format cleanly, skip if >= 100× (copy mode)
          if (speed > 0 && speed < 100) {
            txt += `  ·  ${speed >= 10 ? Math.round(speed) : speed.toFixed(2)}×`;
          }
          // ETA: prefer server-computed value; fall back to wall-clock rate
          try {
            const serverEta = (data && typeof data.eta_seconds === 'number') ? data.eta_seconds : null;
            if (serverEta !== null && serverEta > 0) {
              txt += `  ·  ~${fmtTime(serverEta)} left`;
            } else if (encodeStartWallTime !== null && pct > encodeStartPct) {
              const elapsed = (Date.now() - encodeStartWallTime) / 1000;
              const rate = (pct - encodeStartPct) / elapsed; // % per second
              if (rate > 0) {
                const eta = (100 - pct) / rate;
                txt += `  ·  ~${fmtTime(eta)} left`;
              }
            }
          } catch { }
          if (progMeta) progMeta.textContent = txt;
          if (metaEl) metaEl.textContent = '';
        } else if (encodeSt === 'DONE' || encodeSt === 'CANCELLED') {
          // Compute wall time before clearing encodeJobStartTime
          let wallTimeTxt = '';
          try {
            if (encodeJobStartTime) {
              const elapsedSec = Math.round((Date.now() - encodeJobStartTime) / 1000);
              const wh = Math.floor(elapsedSec / 3600);
              const wm = Math.floor((elapsedSec % 3600) / 60);
              const ws = elapsedSec % 60;
              wallTimeTxt = wh > 0
                ? ` · ${wh}h ${wm}m wall time`
                : wm > 0 ? ` · ${wm}m ${ws}s wall time`
                : ` · ${ws}s wall time`;
            }
          } catch { }
          encodeStartWallTime = null;
          if (progBox) progBox.style.display = 'none';
          if (progBar) { progBar.classList.remove('indeterminate'); progBar.style.width = '0%'; }
          // Count health warnings
          let healthWarnCount = 0;
          try {
            for (const cam of plan) {
              for (const d of (Array.isArray(cam.days) ? cam.days : [])) {
                if (d.health && d.health.ok === false) healthWarnCount++;
              }
            }
          } catch { }
          let msg;
          if (encodeSt === 'DONE') {
            const parts = [`${doneCount} file${doneCount !== 1 ? 's' : ''} encoded`];
            if (failCount > 0) parts.push(`${failCount} failed`);
            if (healthWarnCount > 0) parts.push(`${healthWarnCount} health warning${healthWarnCount !== 1 ? 's' : ''}`);
            msg = `Import complete — ${parts.join(', ')}${wallTimeTxt}.`;
          } else {
            msg = `Import cancelled${wallTimeTxt}.`;
          }
          if (metaEl) metaEl.textContent = msg;
          // Health warning banner
          try {
            const hb = document.getElementById('health-warn-banner');
            if (hb) {
              if (encodeSt === 'DONE' && healthWarnCount > 0) {
                hb.textContent = `⚠ ${healthWarnCount} output file${healthWarnCount !== 1 ? 's have' : ' has'} unexpected duration. Expand the row(s) marked Poor to review.`;
                hb.style.display = '';
              } else {
                hb.style.display = 'none';
                hb.textContent = '';
              }
            }
          } catch { }
        }
      } catch { }

      // Enable/disable Run + Retry buttons
      if (runBtn) {
        const st = String((data && data.status) || "").toUpperCase();
        const jobId =
          typeof window !== "undefined" && window.__ENCODE_JOB_ID__
            ? window.__ENCODE_JOB_ID__
            : null;
        if (st === "RUNNING" || st === "QUEUED") {
          // If a job is active, allow stopping via the Run button
          if (jobId) {
            runBtn.disabled = false;
            runBtn.textContent = "Stop";
            runBtn.style.background = "#b71c1c";
            runBtn.style.color = "#fff";
            runBtn.dataset.running = "1";
            runBtn.classList.remove("primary");
            runBtn.title = "Cancel encoding";
          } else {
            runBtn.disabled = true;
            runBtn.textContent = st === "RUNNING" ? "Running…" : "Queued…";
            runBtn.classList.remove("primary");
            runBtn.title = "Encoding in progress";
          }
        } else {
          runBtn.disabled = !anyWait;
          runBtn.textContent = "Start Import";
          runBtn.style.background = "";
          runBtn.style.color = "";
          runBtn.dataset.running = "0";
          if (!anyWait) {
            runBtn.classList.remove("primary");
            runBtn.title = "No runnable days (pending segments)";
          } else {
            runBtn.classList.add("primary");
            runBtn.title = "";
          }
        }
      }
      // Show/hide Retry Failed button
      try {
        const retryBtn = document.getElementById('retry-failed-btn');
        if (retryBtn) {
          const st = String((data && data.status) || '').toUpperCase();
          retryBtn.style.display = (st === 'DONE' && failCount > 0) ? '' : 'none';
        }
      } catch { }
    } catch (err) {
      try {
        showError("Render plan error", err);
      } catch { }
    }
  }

  // Lightweight video preview overlay for Day Preparation paths
  (function setupDayPreview() {
    function closeOverlay() {
      try { const ov = document.getElementById('dp-video-preview'); if (ov) ov.remove(); } catch (e) { }
      try { document.removeEventListener('keydown', onKey); } catch (e) { }
    }
    function onKey(ev) { if (ev.key === 'Escape') { ev.preventDefault(); closeOverlay(); } }
    function openPreview(path) {
      try {
        const decPath = decodeURIComponent(path || '');
        if (/\.txt$/i.test(decPath)) return; // ignore text lists
        // Build overlay
        const ov = document.createElement('div'); ov.id = 'dp-video-preview';
        ov.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:2000; display:flex; align-items:center; justify-content:center; padding:20px;';
        const panel = document.createElement('div');
        panel.style.cssText = 'background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:10px; box-shadow:0 10px 30px var(--shadow); width:min(1000px,96vw); max-width:96vw;';
        const header = document.createElement('div'); header.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid var(--border,#ddd)';
        const title = document.createElement('div'); title.textContent = (decPath.split('/').pop() || decPath); title.style.cssText = 'font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
        const actions = document.createElement('div'); actions.style.cssText = 'display:flex; gap:8px; align-items:center';
        const analyze = document.createElement('a'); analyze.className = 'btn mini'; analyze.textContent = 'Open in Preview'; analyze.href = '/preview?video=' + encodeURIComponent(decPath);
        const close = document.createElement('button'); close.className = 'btn'; close.textContent = '✕'; close.title = 'Close'; close.style.cssText = 'font-weight:700; width:32px; height:32px; padding:0; display:inline-flex; align-items:center; justify-content:center';
        close.addEventListener('click', closeOverlay);
        actions.appendChild(analyze); actions.appendChild(close);
        header.appendChild(title); header.appendChild(actions);
        const body = document.createElement('div'); body.style.cssText = 'padding:8px 12px;';
        const video = document.createElement('video');
        video.controls = true; video.preload = 'metadata'; video.style.cssText = 'width:100%; height:auto; background:var(--surface);';
        const src = document.createElement('source'); src.src = '/media?path=' + encodeURIComponent(decPath);
        video.appendChild(src);
        body.appendChild(video);
        panel.appendChild(header); panel.appendChild(body); ov.appendChild(panel);
        ov.addEventListener('click', (e) => { if (e.target === ov) closeOverlay(); });
        document.body.appendChild(ov);
        document.addEventListener('keydown', onKey);
        try { video.load(); } catch (e) { }
      } catch (e) { try { showError('Preview error', e); } catch (_) { } }
    }
    if (!window._importerDayPreviewBound) {
      window._importerDayPreviewBound = true;
      document.addEventListener('click', function (ev) {
        const a = ev.target && (ev.target.closest ? ev.target.closest('a.dp-preview') : null);
        if (!a) return;
        ev.preventDefault();
        const p = a.getAttribute('data-path') || a.textContent || '';
        openPreview(p);
      });
    }
  })();

  function appendDirRow(d) {
    if (!d || !d.header) return;
    const wrap = document.getElementById("scan-list");
    if (!wrap) return;
    let tbody = document.getElementById("scan-tbody");
    if (!tbody) {
      wrap.innerHTML = `
        <table id="scan-table">
          <thead>
            <tr>
              <th>Camera</th>
              <th>Date</th>
              <th>Start</th>
              <th>Filename</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="scan-tbody"></tbody>
        </table>`;
      tbody = document.getElementById("scan-tbody");
    }
    if (!tbody) return;
    const empty = document.getElementById("scan-empty");
    if (empty && empty.parentElement) empty.parentElement.removeChild(empty);
    const camNum = d.camera != null ? String(d.camera).padStart(2, "0") : "—";
    const tr = document.createElement("tr");
    tr.className = "scan-dir-row";
    const tdCam = document.createElement("td");
    tdCam.innerHTML = `<span class="scan-cam-pill">Cam ${camNum}</span>`;
    const tdPath = document.createElement("td");
    tdPath.colSpan = 4;
    const missing = d.exists === false ? " (missing)" : "";
    tdPath.className = "scan-dir-path";
    tdPath.textContent = `📁 ${d.path || d.root || ""}${missing}`;
    tr.appendChild(tdCam);
    tr.appendChild(tdPath);
    tbody.appendChild(tr);
  }
