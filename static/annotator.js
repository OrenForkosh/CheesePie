(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const byId = (id) => document.getElementById(id);

  const root = byId('annotator');
  if (!root) return; // Only on annotator page

  const videoPath = (root.dataset.video || '').trim();
  if (window.cheesepieSetModuleVideo) {
    window.cheesepieSetModuleVideo('annotator', videoPath);
  } else {
    try {
      if (videoPath) localStorage.setItem('cheesepie.annotator.video', videoPath);
      else localStorage.removeItem('cheesepie.annotator.video');
    } catch {}
  }
  let defaultMice;
  try {
    defaultMice = JSON.parse(root.dataset.defaultMice || '[]');
  } catch { defaultMice = []; }
  if (!Array.isArray(defaultMice) || defaultMice.length === 0) defaultMice = ['R','G','B','Y'];
  let defaultFps = 30;
  try { defaultFps = JSON.parse(root.dataset.defaultFps || '30') || 30; } catch {}
  if (!(defaultFps>0)) defaultFps = 30;
  let configuredTypes = [];
  try { configuredTypes = JSON.parse(root.dataset.defaultTypes || '[]'); } catch {}
  if (!Array.isArray(configuredTypes)) configuredTypes = [];
  let keyboardCfg = {};
  try { keyboardCfg = JSON.parse(root.dataset.keyboard || '{}') || {}; } catch {}
  const videoEl = byId('ann-video');
  const rateInput = byId('rate');
  const rateVal = byId('rate-val');
  const rateBubble = byId('rate-bubble');
  const exportBtn = byId('export-json');
  let dirty = false;
  const globalCfg = (window.CHEESEPIE || {});
  const autosaveEnabled = !!(globalCfg.annotator && globalCfg.annotator.autosave);

  // Ensure "Saved" label doesn't change button width
  if (exportBtn){
    try {
      const measure = document.createElement('span');
      measure.className = exportBtn.className;
      measure.style.visibility = 'hidden';
      measure.style.position = 'absolute';
      measure.style.whiteSpace = 'nowrap';
      measure.textContent = 'Saved';
      document.body.appendChild(measure);
      const w = Math.ceil(measure.getBoundingClientRect().width);
      document.body.removeChild(measure);
      if (w > 0) exportBtn.style.minWidth = w + 'px';
    } catch {}
  }
  function markDirty() {
    dirty = true;
    if (exportBtn) exportBtn.classList.add('dirty');
  }
  function markClean() {
    dirty = false;
    if (exportBtn) exportBtn.classList.remove('dirty');
  }

  const helpBtn = byId('help-shortcuts');
  const timelineCanvas = byId('timeline');
  const detailsEl = byId('event-details');
  const annotVideoPathEl = byId('annotator-video-path');
  const typesListEl = byId('types-list');
  const miceInput = byId('mice-input');
  const tblBody = $('#events-table tbody');

  // Type modal elements
  const addTypeOpenBtn  = byId('open-add-type');
  const typeOverlay     = byId('type-overlay');
  const typeTitle       = byId('type-overlay-title');
  const typeNameModal   = byId('type-name-modal');
  const typeNameHeModal = byId('type-name-he-modal');
  const typeModeModal   = byId('type-mode-modal');
  const typeKeyModal    = byId('type-key-modal');
  const typeColorModal  = byId('type-color-modal');
  const typeDescModal   = byId('type-desc-modal');
  const typeDescHeModal = byId('type-desc-he-modal');
  const typeSaveBtn     = byId('type-save');
  const typeCancelBtn   = byId('type-cancel');

  // Language toggle (EN / HE) — persisted in localStorage
  const LANG_KEY = 'cheesepie.annotator.lang';
  let annLang = (() => { try { return localStorage.getItem(LANG_KEY) || 'en'; } catch { return 'en'; } })();

  function typeName(t)  { return (annLang === 'he' && t.nameHe)  ? t.nameHe  : (t.name  || '?'); }
  function typeDesc(t)  { return (annLang === 'he' && t.descHe)  ? t.descHe  : (t.description || ''); }

  function updateLangToggle() {
    const seg = byId('ann-lang-seg');
    if (!seg) return;
    seg.querySelectorAll('.ann-lang-btn').forEach(b => b.classList.toggle('active', b.dataset.lang === annLang));
    root.classList.toggle('ann-lang-he', annLang === 'he');
  }

  byId('ann-lang-seg')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.ann-lang-btn');
    if (!btn) return;
    annLang = btn.dataset.lang;
    try { localStorage.setItem(LANG_KEY, annLang); } catch {}
    updateLangToggle();
    renderAll();
  });

  updateLangToggle();

  if (annotVideoPathEl) annotVideoPathEl.value = videoPath || '';
  if (!videoPath) {
    if (typesListEl) typesListEl.textContent = 'No video path provided. Return to Browser and select a video.';
    return;
  }

  // Persist/resume video context (position, rate, paused)
  const CTX_KEY = 'annctx:' + videoPath;
  function loadCtx(){
    try { const raw = localStorage.getItem(CTX_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
  }
  function saveCtx(){
    try {
      const data = { position: videoEl.currentTime||0, rate: videoEl.playbackRate||1, paused: !!videoEl.paused, ts: Date.now() };
      localStorage.setItem(CTX_KEY, JSON.stringify(data));
    } catch {}
  }
  const saveCtxDebounced = (() => { let to=null; return ()=>{ clearTimeout(to); to=setTimeout(saveCtx, 400); }; })();

  // State
  const state = {
    video: videoPath,
    fps: defaultFps,
    duration: 0,
    types: [], // {id, name, color, key, mode}
    events: [], // {id, typeId, start, end|null, animals:[], note:''}
    mice: [],
    selectedEventId: null,
    editingTypeId: null,
    nextId: 1,
    hitboxes: [],
    assignCycle: { eventId: null, nextSlot: 0 },
  };

  // Filter state
  let filterTypeId = '', filterAnimal = '';
  // Snap-to-frame state

  // Utilities
  const fmtTime = (t) => {
    if (!(t>=0)) return '—';
    const h  = Math.floor(t/3600);
    const m  = Math.floor((t%3600)/60);
    const s  = Math.floor(t%60);
    const ms = Math.round((t%1)*1000);
    const mm = (h ? String(m).padStart(2,'0') : String(m));
    const ss = String(s).padStart(2,'0');
    const sms = String(ms).padStart(3,'0');
    return h ? `${h}:${mm}:${ss}.${sms}` : `${mm}:${ss}.${sms}`;
  };
  const parseTime = (str) => {
    if (str == null) return null;
    const s = String(str).trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    const parts = s.split(':').map(Number);
    if (parts.some(n => isNaN(n))) return null;
    if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
    if (parts.length === 2) return parts[0]*60 + parts[1];
    return null;
  };
  const debounce = (fn, ms=250) => { let to; return (...a)=>{ clearTimeout(to); to=setTimeout(()=>fn(...a), ms); }; };
  const isPairMode = (mode) => (mode === 'mutual' || mode === 'directed');
  function snapTime(t) {
    if (!(state.fps > 0)) return t;
    return Math.round(t * state.fps) / state.fps;
  }

  function nextId(){ return state.nextId++; }
  function findTypeByKey(key){ return state.types.find(t => (t.key||'').toLowerCase() === key.toLowerCase()); }
  function findTypeById(id){ return state.types.find(t => t.id === id); }
  function eventsByType(typeId){ return state.events.filter(e => e.typeId === typeId); }
  function openEventForType(typeId){ return state.events.find(e => e.typeId === typeId && (e.end==null)); }
  function selectedEvent(){ return state.events.find(e => e.id === state.selectedEventId) || null; }

  // Load video with detected MIME and error handling
  function loadVideo(){
    // Clear old sources
    try { while (videoEl.firstChild) videoEl.removeChild(videoEl.firstChild); } catch {}
    const srcUrl = `/media?path=${encodeURIComponent(videoPath)}`;
    const source = document.createElement('source');
    source.src = srcUrl;
    videoEl.setAttribute('playsinline', '');
    videoEl.controls = true;
    videoEl.appendChild(source);
    videoEl.load();
  }

  // Helper to read current facility from header
  function curFacility(){ try{ const sel=document.getElementById('app-facility'); return (sel && sel.value) || ''; }catch(e){ return ''; } }

  // Try to set correct MIME via fileinfo (helps some browsers); skip if no facility
  const _fac = curFacility();
  if (_fac) {
    fetch(`/api/fileinfo?path=${encodeURIComponent(videoPath)}&facility=${encodeURIComponent(_fac)}`).then(r=>r.json()).then(info => {
      if (info && info.mime){
        const src = document.createElement('source');
        src.src = `/media?path=${encodeURIComponent(videoPath)}`;
        src.type = info.mime;
        try { while (videoEl.firstChild) videoEl.removeChild(videoEl.firstChild); } catch {}
        videoEl.appendChild(src);
      }
      loadVideo();
    }).catch(() => { loadVideo(); });
  } else {
    loadVideo();
  }

  videoEl.addEventListener('error', () => {
    const code = (videoEl.error && videoEl.error.code) || 0;
    const msg = {
      1: 'Aborted', 2: 'Network error', 3: 'Decode error', 4: 'Format not supported'
    }[code] || 'Unknown error';
    const box = document.createElement('div');
    box.className = 'placeholder muted';
    box.textContent = `Failed to load video (${msg}). Check path permissions.`;
    const wrap = videoEl.parentElement; if (wrap) wrap.appendChild(box);
  }, { once:true });

  // Fetch metadata (fps/duration)
  fetch(`/api/media_meta?path=${encodeURIComponent(videoPath)}`).then(r=>r.json()).then(meta => {
    if (meta && meta.streams && meta.streams.video && typeof meta.streams.video.fps === 'number'){
      state.fps = Math.max(1, Math.round(meta.streams.video.fps));
    }
    if (typeof meta.duration === 'number') state.duration = meta.duration;
    resizeCanvas();
  }).catch(()=>{});

  videoEl.addEventListener('loadedmetadata', () => {
    if (!state.duration || !isFinite(state.duration)) state.duration = videoEl.duration || 0;
    // Restore context
    const ctx = loadCtx();
    if (ctx){
      try { videoEl.playbackRate = Math.max(0.25, Math.min(3, Number(ctx.rate)||1)); } catch {}
      try {
        const dur = videoEl.duration || 0;
        if (dur>0 && ctx.position!=null){
          const pos = Math.max(0, Math.min(dur-0.05, Number(ctx.position)||0));
          videoEl.currentTime = pos;
        }
      } catch {}
      try { if (ctx.paused === false) videoEl.play(); } catch {}
    }
    resizeCanvas();
  }, {once:true});

  // Handle space in the capture phase so it fires before native video control keyboard handling.
  // Using capture + stopImmediatePropagation means the bubble-phase document handler never sees
  // the space key, eliminating the double-toggle.
  document.addEventListener('keydown', (e) => {
    if (window.cheesepieIsActivePage && !window.cheesepieIsActivePage('/annotator')) return;
    const overlayOpen = window.CheesePieShortcuts?.isOverlayOpen?.();
    if (overlayOpen) return;
    const tag = ((e.target && e.target.tagName) || '').toLowerCase();
    const isTyping = tag === 'input' || tag === 'textarea' || !!(e.target && e.target.isContentEditable);
    if (!isTyping && (e.code === 'Space' || e.key === ' ')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (videoEl.paused) videoEl.play(); else videoEl.pause();
    }
  }, true); // capture phase

  // Save context on changes
  videoEl.addEventListener('timeupdate', saveCtxDebounced);
  videoEl.addEventListener('play', saveCtxDebounced);
  videoEl.addEventListener('pause', saveCtxDebounced);
  window.addEventListener('beforeunload', saveCtx);
  window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // Load annotations
  const LS_KEY = 'ann:' + videoPath;
  function loadAnnotations(){
    return fetch(`/api/annotations?video=${encodeURIComponent(videoPath)}`).then(async r => {
      const data = await r.json();
      if (!r.ok || data.error){ throw new Error(data.error || 'load failed'); }
      if (data.data){
        if (validateAnnotationData(data.data)) {
          applyAnnotationData(data.data);
        } else {
          console.warn('CheesePie: annotation file failed validation, using defaults');
          applyAnnotationData(defaultData());
        }
      } else {
        // Defaults when no file exists yet
        applyAnnotationData(defaultData());
      }
    }).catch((err) => {
      // Fallback to localStorage; notify user if both fail
      let restoredFromLocal = false;
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (raw) {
          applyAnnotationData(JSON.parse(raw));
          restoredFromLocal = true;
        }
      } catch { /* localStorage also failed */ }
      if (!restoredFromLocal) {
        applyAnnotationData(defaultData());
      }
      // Show a persistent warning so the user knows the state of their data
      const msg = restoredFromLocal
        ? 'Could not load annotations from server — showing local backup. Save to sync.'
        : 'Could not load annotations — starting fresh. Previous data may be on the server.';
      console.warn('CheesePie annotator: load failed:', err);
      if (exportBtn) {
        exportBtn.title = msg;
        exportBtn.classList.add('dirty');
      }
      // Surface the message in a temporary toast if available, else alert once
      const toast = byId('ann-toast') || byId('notify');
      if (toast) {
        toast.textContent = msg;
        toast.style.display = '';
      }
    });
  }

  function defaultData(){
    const types = configuredTypes.length ? configuredTypes.map((t,i)=>({id:i+1, ...t})) : [
      {id:1, name:'Grooming',  color:'#4f8cff', key:'g', mode:'individual'},
      {id:2, name:'Fighting',  color:'#ff6b6b', key:'f', mode:'mutual'},
      {id:3, name:'Chasing',   color:'#ffd166', key:'c', mode:'directed'},
    ];
    return {
      version: 1,
      video: videoPath,
      fps: state.fps,
      mice: defaultMice.slice(),
      types,
      events: [],
      nextId: 100,
    };
  }

  function applyAnnotationData(d){
    state.fps = Math.max(1, parseInt(d.fps || state.fps, 10));
    state.mice = Array.isArray(d.mice) && d.mice.length > 0 ? d.mice.slice(0, 20) : defaultMice.slice();
    miceInput.value = state.mice.join(',');
    const modeMap = { single: 'individual', dyadic: 'mutual', agonistic: 'directed' };
    state.types = (Array.isArray(d.types) ? d.types : []).map(t => ({
      ...t,
      mode: modeMap[t.mode] || t.mode || 'individual',
    }));
    // Ensure id uniqueness
    let maxId = 0;
    state.types.forEach(t => { if (t.id>maxId) maxId=t.id; });
    state.events = (Array.isArray(d.events) ? d.events : []).map(e => ({...e}));
    state.events.forEach(e => { if (e.id>maxId) maxId=e.id; if (!Array.isArray(e.animals)) e.animals = []; });
    state.nextId = Math.max(maxId+1, d.nextId || 1);
    renderAll();
  }

  const saveDebounced = debounce(saveAnnotations, 400);
  function maybeSave(){ if (autosaveEnabled) saveDebounced(); }
  function currentData(){
    return {
      version: 1,
      video: state.video,
      fps: state.fps,
      mice: state.mice,
      types: state.types,
      events: state.events,
      nextId: state.nextId,
    };
  }
  function saveAnnotations(){
    const payload = { video: videoPath, data: currentData() };
    fetch('/api/annotations', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
    }).then(async r => {
      if (!r.ok){ throw new Error('save failed'); }
      markClean();
    }).catch(() => {
      try { localStorage.setItem(LS_KEY, JSON.stringify(payload.data)); } catch {}
    });
  }

  // ── Undo / Redo ───────────────────────────────────────────────────────────
  const _history = [], _future = [];
  function pushHistory() {
    const snap = JSON.stringify(currentData());
    if (_history.length > 0 && _history[_history.length - 1] === snap) return;
    _history.push(snap);
    if (_history.length > 60) _history.shift();
    _future.length = 0;
    markDirty();
  }
  function undo() {
    if (!_history.length) return;
    _future.push(JSON.stringify(currentData()));
    applyAnnotationData(JSON.parse(_history.pop()));
    markDirty();
  }
  function redo() {
    if (!_future.length) return;
    _history.push(JSON.stringify(currentData()));
    applyAnnotationData(JSON.parse(_future.pop()));
    markDirty();
  }

  function validateAnnotationData(d) {
    if (!d || typeof d !== 'object') return false;
    if (!Array.isArray(d.types) || !Array.isArray(d.events)) return false;
    return true;
  }

  // Controls
  function updateRateUI(v){
    const min = Number(rateInput.min)||0.25, max = Number(rateInput.max)||3;
    const pct = Math.max(0, Math.min(1, (v - min) / (max - min)));
    rateInput.style.setProperty('--pct', (pct*100)+'%');
    rateVal.textContent = v.toFixed(2)+'×';
    // bubble position
    if (rateBubble){
      const rect = rateInput.getBoundingClientRect();
      const x = rect.left + rect.width * pct;
      rateBubble.style.left = Math.round(x - rect.left) + 'px';
      rateBubble.textContent = v.toFixed(2)+'×';
    }
    // update chips
    document.querySelectorAll('.rate-presets .chip').forEach(ch => {
      const r = Number(ch.dataset.rate||'0');
      if (Math.abs(r - v) < 0.01) ch.classList.add('active'); else ch.classList.remove('active');
    });
  }
  function setRate(v){
    const val = Math.max(Number(rateInput.min)||0.25, Math.min(Number(rateInput.max)||3, v));
    videoEl.playbackRate = val; rateInput.value = String(val); updateRateUI(val);
    saveCtxDebounced();
  }
  // init
  setRate(parseFloat(rateInput.value)||1);
  rateInput.addEventListener('input', () => { setRate(parseFloat(rateInput.value)||1); rateBubble?.removeAttribute('hidden'); });
  rateInput.addEventListener('change', () => { rateBubble?.setAttribute('hidden',''); });
  rateInput.addEventListener('pointerdown', () => { rateBubble?.removeAttribute('hidden'); });
  document.addEventListener('pointerup', () => { rateBubble?.setAttribute('hidden',''); }, {capture:true});
  document.querySelectorAll('.rate-presets .chip').forEach(ch => {
    ch.addEventListener('click', () => { const r = Number(ch.dataset.rate||'1'); setRate(r); });
  });

  function step(by){
    const dt = 1/Math.max(1, state.fps);
    videoEl.pause();
    try { videoEl.currentTime = Math.max(0, Math.min((state.duration||videoEl.duration||0), (videoEl.currentTime + by*dt))); }
    catch {}
  }
  function seekSeconds(delta){
    const dur = state.duration || videoEl.duration || 0;
    if (!(dur>0)) return;
    const target = Math.max(0, Math.min(dur, (videoEl.currentTime||0) + delta));
    try { videoEl.currentTime = target; } catch {}
  }
  const saveStatus = byId('save-status');
  exportBtn.addEventListener('click', async () => {
    // Save to same folder as video via backend
    const payload = { video: videoPath, data: currentData() };
    const prevText = exportBtn.textContent;
    const prevClass = exportBtn.className;
    exportBtn.disabled = true; exportBtn.textContent = 'Saving…';
    try {
      const r = await fetch('/api/annotations', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
      });
      const resp = await r.json().catch(() => ({}));
      if (!r.ok || resp.error){ throw new Error(resp.error || 'Save failed'); }
      exportBtn.textContent = 'Saved';
      exportBtn.classList.add('success');
      markClean();
      setTimeout(() => { exportBtn.textContent = prevText; exportBtn.className = prevClass; exportBtn.disabled = false; }, 1200);
    } catch (err){
      exportBtn.textContent = 'Failed';
      exportBtn.className = prevClass;
      setTimeout(() => { exportBtn.textContent = prevText; exportBtn.disabled = false; }, 2000);
    }
  });

  function showShortcuts(){
    const lines = [];
    if (window.CheesePieShortcuts && window.CheesePieShortcuts.renderPlaybackShortcuts) {
      lines.push(...window.CheesePieShortcuts.renderPlaybackShortcuts({ includeHelp: false }));
    } else {
      lines.push(`<div class="shortcut-item"><span class="kbd">Space</span> <span>Play / Pause</span></div>`);
    }
    lines.push(`<div class="shortcut-item"><span class="kbd">← / →</span> <span>Step one frame</span></div>`);
    lines.push(`<div class="shortcut-item"><span class="kbd">Shift + ← / →</span> <span>Jump ±2 s</span></div>`);
    lines.push(`<div class="shortcut-item"><span class="kbd">Alt + ← / →</span> <span>Jump ±10 s</span></div>`);
    lines.push(`<div class="shortcut-item"><span class="kbd">Ctrl + ← / →</span> <span>Jump ±60 s</span></div>`);
    lines.push(`<div class="shortcut-item"><span class="kbd">Enter</span> <span>Finish current event</span></div>`);
    lines.push(`<div class="shortcut-item"><span class="kbd">Esc</span> <span>Cancel current event</span></div>`);
    lines.push(`<div class="shortcut-item"><span class="kbd">Ctrl+Z</span> <span>Undo</span></div>`);
    lines.push(`<div class="shortcut-item"><span class="kbd">Ctrl+Y / Ctrl+Shift+Z</span> <span>Redo</span></div>`);
    lines.push(`<div class="shortcut-item"><span class="kbd">Ctrl+D</span> <span>Duplicate selected event at current time</span></div>`);
    lines.push(`<div class="shortcut-item"><span class="kbd">1..9</span> <span>Assign animals (pair: alternates A/B; polyadic: toggles)</span></div>`);
    lines.push(`<div class="shortcut-item"><span class="kbd">Timeline click</span> <span>Seek to clicked time</span></div>`);
    lines.push(`<div class="shortcut-item"><span class="kbd">Row dbl-click</span> <span>Jump to event start</span></div>`);
    lines.push(`<div class="shortcut-item"><span class="kbd">Shift + row dbl-click</span> <span>Jump to event end</span></div>`);
    lines.push(`<div class="shortcut-item"><span class="kbd">Zoom: draw rect</span> <span>Zoom into area · click to zoom out</span></div>`);
    lines.push(`<div class="shortcut-item"><span class="kbd">Alt + drag</span> <span>Pan while zoomed</span></div>`);
    if (window.CheesePieShortcuts && window.CheesePieShortcuts.showOverlay) {
      window.CheesePieShortcuts.showOverlay('Keyboard Shortcuts', lines);
    }
  }
  helpBtn?.addEventListener('click', showShortcuts);

  // CSV export
  const exportCsvBtn = byId('export-csv');
  exportCsvBtn?.addEventListener('click', () => {
    const header = ['Type','Mode','Start_s','End_s','Duration_s','Animals','Note'];
    const rows = state.events.slice().sort((a,b) => a.start - b.start).map(ev => {
      const t = findTypeById(ev.typeId) || {name:'?', mode:'?'};
      const dur = ev.end != null ? (ev.end - ev.start).toFixed(3) : '';
      return [
        typeName(t), t.mode,
        (ev.start||0).toFixed(3),
        ev.end != null ? ev.end.toFixed(3) : '',
        dur,
        (ev.animals||[]).filter(Boolean).join(';'),
        (ev.note||'').replace(/\n/g,' '),
      ].map(c => `"${String(c).replace(/"/g,'""')}"`).join(',');
    });
    const csv = [header.join(','), ...rows].join('\n');
    const blob = new Blob([csv], {type:'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = videoPath.split('/').pop().replace(/\.[^.]+$/, '') + '_annotations.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // Types management — collapsible with inline event details
  function _buildExpandedForm(t, ev) {
    const dur = (ev.end != null && ev.start != null) ? Math.max(0, ev.end - ev.start) : null;
    const opts = state.mice.map((m, i) => `<option value="${m}">${i+1} – ${m}</option>`).join('');
    const activeSlot = (state.assignCycle.eventId === ev.id) ? state.assignCycle.nextSlot : 0;
    let animalsHtml = '';
    if (state.mice.length) {
      if (t.mode === 'individual') {
        animalsHtml = `<div class="ed-animals-row">
          <span class="ed-lbl">Animal</span>
          <select class="ed-a1"><option value=""></option>${opts}</select>
        </div>`;
      } else if (t.mode === 'mutual') {
        animalsHtml = `<div class="ed-animals-row">
          <span class="ed-lbl ${activeSlot===0?'ed-slot-active':''}">A</span>
          <select class="ed-a1 ${activeSlot===0?'ed-slot-active':''}"><option value=""></option>${opts}</select>
          <span class="ed-lbl ${activeSlot===1?'ed-slot-active':''}">B</span>
          <select class="ed-a2 ${activeSlot===1?'ed-slot-active':''}"><option value=""></option>${opts}</select>
        </div>`;
      } else if (t.mode === 'directed') {
        animalsHtml = `<div class="ed-animals-row">
          <span class="ed-lbl ${activeSlot===0?'ed-slot-active':''}">Init.</span>
          <select class="ed-a1 ${activeSlot===0?'ed-slot-active':''}"><option value=""></option>${opts}</select>
          <span class="ed-lbl ${activeSlot===1?'ed-slot-active':''}">Recip.</span>
          <select class="ed-a2 ${activeSlot===1?'ed-slot-active':''}"><option value=""></option>${opts}</select>
        </div>`;
      } else if (t.mode === 'polyadic') {
        animalsHtml = `<div class="polyadic-checks">${
          state.mice.map((m, i) => `<label class="polyadic-check"><input type="checkbox" class="poly-cb" value="${m}"${(ev.animals||[]).includes(m)?' checked':''}> <span class="poly-num">${i+1}</span> ${m}</label>`).join('')
        }</div>`;
      }
    }
    return `<div class="type-expand">
      <div class="ed-range-row">
        <span class="ed-lbl">Range</span>
        <input class="ed-start" type="text" value="${fmtTime(ev.start||0)}">
        <span class="muted">–</span>
        <input class="ed-end" type="text" value="${ev.end!=null?fmtTime(ev.end):''}" placeholder="—">
        <span class="fill"></span>
        <span class="ed-lbl">Dur</span><span class="ed-dur">&nbsp;${dur!=null?fmtTime(dur):'—'}</span>
      </div>
      ${animalsHtml}
      ${typeDesc(t) ? `<div class="ed-desc muted">${typeDesc(t)}</div>` : ''}
      <input class="ed-note" type="text" placeholder="Note (optional)">
      <div class="ed-actions-row">
        <button class="btn mini ed-set-start">Set start</button>
        <button class="btn mini ed-set-end">Set end</button>
        <button class="btn mini ed-goto-end">→end</button>
        <span class="fill"></span>
        <button class="btn mini ed-delete-ev">Delete</button>
      </div>
    </div>`;
  }

  function _wireExpandedForm(t, ev, container) {
    const edStart = container.querySelector('.ed-start');
    const edEnd   = container.querySelector('.ed-end');
    const edNote  = container.querySelector('.ed-note');
    const edA1    = container.querySelector('.ed-a1');
    const edA2    = container.querySelector('.ed-a2');
    if (edNote) edNote.value = ev.note || '';
    if (edA1) edA1.value = ev.animals && ev.animals[0] || '';
    if (edA2) edA2.value = ev.animals && ev.animals[1] || '';
    container.querySelectorAll('.poly-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        pushHistory();
        ev.animals = Array.from(container.querySelectorAll('.poly-cb:checked')).map(c => c.value);
        maybeSave(); renderTable();
      });
    });
    function enforceDistinct() {
      if (isPairMode(t.mode) && ev.animals && ev.animals[0] && ev.animals[1] && ev.animals[0] === ev.animals[1]) {
        ev.animals[1] = '';
        if (edA2) edA2.value = '';
      }
    }
    edStart?.addEventListener('change', () => { const v=parseTime(edStart.value); if (v!=null){ pushHistory(); ev.start=Math.max(0,v); if (ev.end!=null) ev.end=Math.max(ev.start,ev.end); maybeSave(); renderAll(); } });
    edEnd?.addEventListener('change', () => {
      const v = parseTime(edEnd.value);
      if (v == null || v <= (ev.start || 0)) { edEnd.value = ev.end != null ? fmtTime(ev.end) : ''; return; }
      const snapped = snapTime(v);
      if (snapped === ev.end) return;
      pushHistory();
      if (ev.end == null) { _stopEvent(ev, snapped); } else { ev.end = snapped; }
      maybeSave(); renderAll();
    });
    edNote?.addEventListener('input', maybeSave);
    if (edA1) edA1.addEventListener('change', () => { pushHistory(); ev.animals=ev.animals||[]; ev.animals[0]=edA1.value||''; enforceDistinct(); maybeSave(); renderTable(); });
    if (edA2) edA2.addEventListener('change', () => { pushHistory(); ev.animals=ev.animals||[]; ev.animals[1]=edA2.value||''; enforceDistinct(); maybeSave(); renderTable(); });
    container.querySelector('.ed-set-start')?.addEventListener('click', () => { pushHistory(); ev.start=snapTime(videoEl.currentTime||0); if (ev.end!=null) ev.end=Math.max(ev.start,ev.end); maybeSave(); renderAll(); });
    container.querySelector('.ed-set-end')?.addEventListener('click', () => {
      const endTime = snapTime(videoEl.currentTime || 0);
      if (endTime <= (ev.start || 0)) return; // zero duration — ignore
      pushHistory();
      if (ev.end == null) { _stopEvent(ev, endTime); } else { ev.end = endTime; }
      maybeSave(); renderAll();
    });
    container.querySelector('.ed-goto-end')?.addEventListener('click', () => { if (ev.end!=null){ try{ videoEl.currentTime=ev.end; }catch{} } });
    container.querySelector('.ed-delete-ev')?.addEventListener('click', () => { pushHistory(); state.events=state.events.filter(x=>x.id!==ev.id); state.selectedEventId=null; maybeSave(); renderAll(); });
  }

  function renderTypes(){
    typesListEl.innerHTML = '';
    const selEv = state.selectedEventId ? state.events.find(e => e.id === state.selectedEventId) : null;
    state.types.forEach(t => {
      const isSelType = !!(selEv && selEv.typeId === t.id);
      const ev = isSelType ? selEv : null;
      const row = document.createElement('div');
      row.className = 'type-item' + (isSelType ? ' expanded' : '');
      row.innerHTML = `
        <div class="type-header" title="${typeDesc(t).replace(/"/g,'&quot;')}">
          <span class="swatch" style="background:${t.color}"></span>
          <span class="tname">${typeName(t)}</span>
          <span class="type-meta">${t.key ? '['+t.key.toUpperCase()+']' : ''}</span>
          <span class="fill"></span>
          <button class="btn mini" data-act="edit">Edit</button>
          <button class="btn mini" data-act="del">✕</button>
        </div>
        ${ev ? _buildExpandedForm(t, ev) : ''}
      `;
      row.querySelector('.type-header').addEventListener('click', (e) => {
        if (e.target.closest('button')) return; // let Edit/Delete handle themselves
        triggerType(t);
      });
      row.querySelector('[data-act="edit"]').addEventListener('click', (e) => { e.stopPropagation(); openTypeModal(t); });
      row.querySelector('[data-act="del"]').addEventListener('click', (e) => {
        e.stopPropagation();
        pushHistory();
        state.events = state.events.filter(ev => ev.typeId !== t.id);
        state.types = state.types.filter(x => x.id !== t.id);
        if (state.selectedEventId && !state.events.find(e => e.id === state.selectedEventId)) state.selectedEventId = null;
        saveDebounced(); renderAll();
      });
      if (ev) _wireExpandedForm(t, ev, row);
      typesListEl.appendChild(row);
    });
    resizeCanvas();
  }

  const _COLOR_PALETTE = [
    '#4f8cff','#ff6b6b','#ffd166','#06d6a0','#a29bfe',
    '#fd79a8','#e17055','#00cec9','#6c5ce7','#00b894',
    '#fdcb6e','#e84393','#74b9ff','#55efc4','#ff9f43',
  ];
  function _nextColor() {
    const used = new Set(state.types.map(t => (t.color || '').toLowerCase()));
    return _COLOR_PALETTE.find(c => !used.has(c.toLowerCase()))
        || _COLOR_PALETTE[state.types.length % _COLOR_PALETTE.length];
  }

  function openTypeModal(existing){
    if (existing){
      state.editingTypeId = existing.id;
      typeTitle.textContent = 'Edit Behavior Type';
      typeSaveBtn.textContent = 'Update';
      typeNameModal.value = existing.name || '';
      if (typeNameHeModal) typeNameHeModal.value = existing.nameHe || '';
      typeModeModal.value = existing.mode || 'individual';
      typeKeyModal.value = (existing.key || '').slice(0,1);
      typeColorModal.value = existing.color || '#7c4dff';
      if (typeDescModal) typeDescModal.value = existing.description || '';
      if (typeDescHeModal) typeDescHeModal.value = existing.descHe || '';
    } else {
      state.editingTypeId = null;
      typeTitle.textContent = 'Add Behavior Type';
      typeSaveBtn.textContent = 'Add';
      typeNameModal.value = '';
      if (typeNameHeModal) typeNameHeModal.value = '';
      typeModeModal.value = 'individual';
      typeKeyModal.value = '';
      typeColorModal.value = _nextColor();
      if (typeDescModal) typeDescModal.value = '';
      if (typeDescHeModal) typeDescHeModal.value = '';
    }
    if (typeOverlay) {
      typeOverlay.hidden = false;
      // Focus first field for quick typing
      setTimeout(() => { try { typeNameModal?.focus(); typeNameModal?.select?.(); } catch {} }, 0);
    }
  }

  function closeTypeModal(){ if (typeOverlay) typeOverlay.hidden = true; }

  addTypeOpenBtn?.addEventListener('click', () => openTypeModal(null));
  typeCancelBtn?.addEventListener('click', closeTypeModal);
  typeOverlay?.addEventListener('click', (e) => { if (e.target === typeOverlay) closeTypeModal(); });

  typeSaveBtn?.addEventListener('click', () => {
    pushHistory();
    const name = (typeNameModal.value || '').trim(); if (!name) return;
    const nameHe = (typeNameHeModal?.value || '').trim();
    const selMode = (typeModeModal.value || '').toLowerCase();
    const mode = ['individual','mutual','directed','polyadic'].includes(selMode) ? selMode : 'individual';
    const key = (typeKeyModal.value || '').trim().slice(0,1);
    const color = typeColorModal.value || '#7c4dff';
    const description = (typeDescModal?.value || '').trim();
    const descHe = (typeDescHeModal?.value || '').trim();
    if (state.editingTypeId){
      const t = findTypeById(state.editingTypeId); if (t){ t.name=name; t.nameHe=nameHe; t.mode=mode; t.key=key; t.color=color; t.description=description; t.descHe=descHe; }
      state.editingTypeId = null;
    } else {
      state.types.push({id: nextId(), name, nameHe, mode, key, color, description, descHe});
    }
    renderTypes(); saveDebounced(); closeTypeModal();
  });

  // Modal keyboard shortcuts: Enter = save, Esc = cancel
  document.addEventListener('keydown', (e) => {
    if (window.cheesepieIsActivePage && !window.cheesepieIsActivePage('/annotator')) return;
    const overlayOpen = window.CheesePieShortcuts && window.CheesePieShortcuts.isOverlayOpen && window.CheesePieShortcuts.isOverlayOpen();
    if (overlayOpen) {
      if (e.key === 'Escape') { return; }
      return;
    }
    if (!typeOverlay || typeOverlay.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeTypeModal(); return; }
    if (e.key === 'Enter') { e.preventDefault(); typeSaveBtn?.click(); return; }
  });

  miceInput.addEventListener('change', () => {
    pushHistory();
    const seen = new Set();
    const list = miceInput.value.split(',').map(s=>s.trim()).filter(s => {
      if (!s || seen.has(s)) return false;
      seen.add(s); return true;
    });
    state.mice = list.slice(0, 20);
    miceInput.value = state.mice.join(','); // normalize display
    saveDebounced(); renderAll();
  });

  // Commit an end time onto an open event; discards the event if duration is zero.
  // Returns true if the event was kept, false if discarded.
  function _stopEvent(ev, endTime) {
    const snapped = snapTime(endTime);
    if (snapped <= (ev.start || 0)) {
      state.events = state.events.filter(x => x.id !== ev.id);
      if (state.selectedEventId === ev.id) state.selectedEventId = null;
      if (state.assignCycle.eventId === ev.id) state.assignCycle = { eventId: null, nextSlot: 0 };
      return false;
    }
    ev.end = snapped;
    return true;
  }

  // Start/stop recording for a behavior type (shared by keyboard shortcut and click)
  function triggerType(t) {
    pushHistory();
    const now = videoEl.currentTime || 0;
    const open = openEventForType(t.id);
    if (open) {
      const kept = _stopEvent(open, now);
      if (kept) state.selectedEventId = open.id;
    } else {
      const ev = { id: nextId(), typeId: t.id, start: now, end: null, animals: [], note: '' };
      if (t.mode === 'individual' && state.mice.length > 0) ev.animals = [state.mice[0]];
      if (isPairMode(t.mode) && state.mice.length > 1) ev.animals = [state.mice[0], state.mice[1]];
      if (t.mode === 'polyadic') ev.animals = [];
      state.events.push(ev);
      state.selectedEventId = ev.id;
    }
    renderAll(); maybeSave();
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (window.cheesepieIsActivePage && !window.cheesepieIsActivePage('/annotator')) return;
    const overlayOpen = window.CheesePieShortcuts && window.CheesePieShortcuts.isOverlayOpen && window.CheesePieShortcuts.isOverlayOpen();
    if (overlayOpen) {
      if (e.key === 'Escape') { return; }
      return;
    }
    // Undo / Redo — works even while typing in details panel
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); redo(); return; }
    const tag = (e.target && (e.target.tagName || '').toLowerCase());
    const isTyping = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
    if (!isTyping && (e.key === '?' || (e.key === '/' && e.shiftKey))) {
      e.preventDefault();
      showShortcuts();
      return;
    }
    if (!isTyping) {
      // Duplicate selected event (Ctrl+D)
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        e.preventDefault();
        const ev = selectedEvent();
        if (ev) {
          pushHistory();
          const copy = { ...ev, id: nextId(), start: videoEl.currentTime||0, end: null };
          state.events.push(copy);
          state.selectedEventId = copy.id;
          markDirty(); renderAll();
        }
        return;
      }
      // Finish/cancel current open event
      const openEvents = state.events.filter(ev => ev.end == null);
      const selectedOpen = openEvents.find(ev => ev.id === state.selectedEventId) || null;
      const targetOpen = selectedOpen || openEvents[openEvents.length - 1];
      if ((e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter') && targetOpen){
        e.preventDefault();
        pushHistory();
        const kept = _stopEvent(targetOpen, videoEl.currentTime || 0);
        if (kept) state.selectedEventId = targetOpen.id;
        maybeSave();
        renderAll();
        return;
      }
      if ((e.key === 'Escape' || e.code === 'Escape') && targetOpen){
        e.preventDefault();
        pushHistory();
        // cancel = remove the open event entirely
        state.events = state.events.filter(ev => ev.id !== targetOpen.id);
        if (state.selectedEventId === targetOpen.id) state.selectedEventId = null;
        if (state.assignCycle.eventId === targetOpen.id) state.assignCycle = { eventId:null, nextSlot:0 };
        maybeSave();
        renderAll();
        return;
      }
      // Arrow keys: bare = single frame; Shift = 2s; Alt = 10s; Ctrl = 60s
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const sign = e.key === 'ArrowLeft' ? -1 : 1;
        if (e.ctrlKey || e.metaKey) { seekSeconds(sign * 60); }
        else if (e.altKey)          { seekSeconds(sign * 10); }
        else if (e.shiftKey)        { seekSeconds(sign * 2); }
        else                        { step(sign); }
        return;
      }

      // Number keys to assign animals when editing a selected event
      const ev = selectedEvent();
      if (ev) {
        let num = null;
        // prefer key if it's a single digit 0-9
        if (/^[0-9]$/.test(e.key)) num = parseInt(e.key, 10);
        else if ((e.code || '').startsWith('Numpad')) {
          const d = e.code.replace('Numpad', '');
          if (/^\d$/.test(d)) num = parseInt(d, 10);
        }
        if (num != null && num >= 1) {
          e.preventDefault();
          const idx = num - 1;
          if (idx < state.mice.length) {
            const t = findTypeById(ev.typeId) || {mode:'individual'};
            if (t.mode === 'polyadic') {
              // Toggle the selected mouse in/out of animals array
              ev.animals = ev.animals || [];
              const mouse = state.mice[idx];
              const pos = ev.animals.indexOf(mouse);
              if (pos >= 0) ev.animals.splice(pos, 1); else ev.animals.push(mouse);
            } else if (isPairMode(t.mode)) {
              if (state.assignCycle.eventId !== ev.id) state.assignCycle = { eventId: ev.id, nextSlot: 0 };
              const slot = state.assignCycle.nextSlot;
              ev.animals = ev.animals || [];
              ev.animals[slot] = state.mice[idx];
              // prevent duplicate selection for pair modes
              if (ev.animals[0] && ev.animals[1] && ev.animals[0] === ev.animals[1]){
                ev.animals[slot] = '';
              } else {
                state.assignCycle.nextSlot = (slot === 0 ? 1 : 0);
              }
            } else {
              ev.animals = [state.mice[idx]];
            }
            maybeSave();
            renderTypes();
            renderTable();
            return;
          }
        }
      }
    }
    if (isTyping) return;
    const key = e.key.toLowerCase();
    const t = findTypeByKey(key);
    if (!t) return;
    e.preventDefault();
    triggerType(t);
    return;
  });

  // Timeline rendering
  const pad = 6, tickH = 22, tlPadBottom = 6;
  let tlCompact = (() => { try { return localStorage.getItem('cheesepie.annotator.tlCompact') !== 'false'; } catch { return true; } })();
  const tlCompactBtn = byId('tl-compact-toggle');
  if (tlCompactBtn) {
    tlCompactBtn.classList.toggle('active', tlCompact);
    tlCompactBtn.addEventListener('click', () => {
      tlCompact = !tlCompact;
      try { localStorage.setItem('cheesepie.annotator.tlCompact', String(tlCompact)); } catch {}
      tlCompactBtn.classList.toggle('active', tlCompact);
      resizeCanvas();
    });
  }
  let timelineWindow = null; // null = full view, number = seconds window
  let windowBase = 0;       // start of the currently displayed page (paged scrolling)
  let _tlView = { tStart: 0, pxPerSec: 1 }; // updated each draw, used by click handler

  function niceTickInterval(dur) {
    const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const raw = dur / 7;
    return candidates.find(c => c >= raw) || candidates[candidates.length - 1];
  }

  function resizeCanvas(){
    const laneH = tlCompact ? 8 : 26, laneGap = tlCompact ? 2 : 8;
    const lanes = Math.max(1, state.types.length);
    timelineCanvas.height = tickH + pad + lanes*(laneH+laneGap) + tlPadBottom;
    drawTimeline();
  }

  function drawTimeline(){
    const ctx = timelineCanvas.getContext('2d');
    const w = timelineCanvas.clientWidth || timelineCanvas.offsetWidth || 600;
    if (timelineCanvas.width !== w) timelineCanvas.width = w;
    const h = timelineCanvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0e1220'; ctx.fillRect(0, 0, w, h);
    const dur = state.duration || videoEl.duration || 0; if (!(dur>0)) return;
    const cur = videoEl.currentTime || 0;

    // ── Compute visible window (page-based: marker moves L→R, pages on exit) ──
    let tStart = 0, tEnd = dur;
    if (timelineWindow && timelineWindow < dur) {
      // Page forward when marker exits right edge; page back when seeking left
      if (cur >= windowBase + timelineWindow || cur < windowBase) {
        windowBase = Math.floor(cur / timelineWindow) * timelineWindow;
      }
      tStart = windowBase;
      tEnd   = Math.min(dur, windowBase + timelineWindow);
    }
    const visibleDur = tEnd - tStart;
    const pxPerSec = w / visibleDur;
    _tlView = { tStart, pxPerSec };
    const tx = (t) => (t - tStart) * pxPerSec; // time → x

    // ── Time ruler ───────────────────────────────────────────────────────────
    ctx.fillStyle = '#111828'; ctx.fillRect(0, 0, w, tickH);

    const interval = niceTickInterval(visibleDur);
    const subInterval = interval / 5;

    // Sub-ticks
    ctx.strokeStyle = '#1c2540'; ctx.lineWidth = 1;
    let st = Math.ceil(tStart / subInterval - 0.001) * subInterval;
    while (st <= tEnd + 0.001) {
      const x = Math.round(tx(st)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, tickH - 5); ctx.lineTo(x, tickH); ctx.stroke();
      st += subInterval;
    }

    // Major ticks + labels
    ctx.font = '9px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    let mt = Math.ceil(tStart / interval - 0.001) * interval;
    while (mt <= tEnd + 0.001) {
      const x = Math.round(tx(mt)) + 0.5;
      ctx.strokeStyle = '#3a4468'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, tickH - 10); ctx.lineTo(x, tickH); ctx.stroke();
      ctx.fillStyle = '#7788bb';
      ctx.textAlign = x < 24 ? 'left' : (x > w - 24 ? 'right' : 'center');
      ctx.fillText(fmtTime(mt), Math.max(2, Math.min(w - 2, x)), 2);
      mt += interval;
    }

    // Ruler / lane divider
    ctx.strokeStyle = '#2a3356'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, tickH - 0.5); ctx.lineTo(w, tickH - 0.5); ctx.stroke();

    // ── Event lanes ──────────────────────────────────────────────────────────
    const laneH = tlCompact ? 8 : 26, laneGap = tlCompact ? 2 : 8;
    const evPad = tlCompact ? 1 : 2;
    const selEv = state.selectedEventId ? state.events.find(e => e.id === state.selectedEventId) : null;
    const selTypeId = selEv ? selEv.typeId : null;
    state.hitboxes = [];
    state.types.forEach((t, idx) => {
      const y = tickH + pad + idx * (laneH + laneGap);
      const isSelLane = t.id === selTypeId;

      // Lane background
      ctx.fillStyle = '#141a2b'; ctx.fillRect(0, y, w, laneH);

      if (tlCompact) {
        // Colored left-edge strip identifies the lane
        ctx.fillStyle = t.color || '#7c4dff';
        ctx.globalAlpha = isSelLane ? 1 : 0.4;
        ctx.fillRect(0, y, 3, laneH);
        ctx.globalAlpha = 1;
        // Subtle background tint for selected lane
        if (isSelLane) {
          ctx.fillStyle = t.color || '#7c4dff';
          ctx.globalAlpha = 0.1;
          ctx.fillRect(3, y, w - 3, laneH);
          ctx.globalAlpha = 1;
        }
      } else {
        // Full mode: type label on the left
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillStyle = t.color || '#7c4dff';
        ctx.globalAlpha = 0.7;
        ctx.fillText(typeName(t), 4, y + laneH / 2);
        ctx.globalAlpha = 1;
      }

      const evs = eventsByType(t.id).slice().sort((a,b) => a.start - b.start);
      evs.forEach(ev => {
        const rawX1 = tx(ev.start);
        const rawX2 = tx(ev.end != null ? ev.end : cur);
        if (rawX2 < 0 || rawX1 > w) return; // outside view
        const x1 = Math.max(0, Math.round(rawX1));
        const x2 = Math.min(w, Math.round(rawX2));
        const width = Math.max(2, x2 - x1);
        ctx.globalAlpha = ev.end == null ? 0.5 : 0.9;
        ctx.fillStyle = t.color || '#7c4dff';
        ctx.fillRect(x1, y + evPad, width, laneH - evPad * 2);
        ctx.globalAlpha = 1;
        if (ev.id === state.selectedEventId) {
          ctx.strokeStyle = '#ffffffaa'; ctx.lineWidth = 2;
          ctx.strokeRect(x1 + 1, y + evPad + 1, Math.max(0, width - 2), Math.max(0, laneH - evPad * 2 - 2));
        }
        state.hitboxes.push({ x1, x2: x1 + width, y1: y, y2: y + laneH, id: ev.id });
      });
      // Overlap detection — draw hatching where events overlap (full mode only; too small in compact)
      if (!tlCompact) {
        const sorted = evs.filter(ev => ev.end != null);
        for (let i = 0; i < sorted.length - 1; i++) {
          const a = sorted[i], b = sorted[i+1];
          if (b.start < a.end) {
            const ox1 = Math.round(tx(b.start));
            const ox2 = Math.round(tx(Math.min(a.end, b.end)));
            if (ox2 > ox1) {
              ctx.save();
              ctx.globalAlpha = 0.6;
              ctx.strokeStyle = '#fff';
              ctx.lineWidth = 1;
              const step = 4;
              ctx.beginPath();
              for (let sx = ox1 - laneH; sx < ox2 + laneH; sx += step) {
                ctx.moveTo(sx, y + evPad);
                ctx.lineTo(sx + laneH, y + laneH - evPad);
              }
              ctx.stroke();
              ctx.restore();
            }
          }
        }
      }
    });

    // ── Playhead ─────────────────────────────────────────────────────────────
    const px = Math.round(tx(cur));
    if (px >= 0 && px <= w) {
      ctx.strokeStyle = '#e4e7ee'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px + 0.5, 0); ctx.lineTo(px + 0.5, h); ctx.stroke();
      // Triangle marker at top
      ctx.fillStyle = '#e4e7ee';
      ctx.beginPath(); ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px + 0.5, 9); ctx.closePath(); ctx.fill();
    }
  }

  window.addEventListener('resize', debounce(resizeCanvas, 100));
  videoEl.addEventListener('timeupdate', drawTimeline);
  videoEl.addEventListener('timeupdate', () => {
    state.events.filter(ev => ev.end == null).forEach(ev => {
      const el = byId('oet-' + ev.id);
      if (el) el.textContent = fmtTime((videoEl.currentTime||0) - (ev.start||0));
    });
  });

  // ── Overview minimap (below video) ─────────────────────────────────────────
  const minimapCanvas = byId('timeline-minimap');
  function drawMinimap() {
    if (!minimapCanvas) return;
    const dur = state.duration || videoEl.duration || 0;
    const mw = minimapCanvas.clientWidth || minimapCanvas.offsetWidth || 400;
    if (minimapCanvas.width !== mw) minimapCanvas.width = mw;
    const mh = minimapCanvas.height;
    const ctx = minimapCanvas.getContext('2d');
    ctx.clearRect(0, 0, mw, mh);
    ctx.fillStyle = '#0e1220'; ctx.fillRect(0, 0, mw, mh);
    if (!(dur > 0)) return;

    const tx = (t) => (t / dur) * mw;

    // Event bars (thin, mid-height)
    const barY = Math.round(mh * 0.25), barH = Math.round(mh * 0.5);
    state.types.forEach(t => {
      eventsByType(t.id).forEach(ev => {
        const x1 = Math.round(tx(ev.start));
        const x2 = Math.max(x1 + 1, Math.round(tx(ev.end != null ? ev.end : (videoEl.currentTime || 0))));
        ctx.globalAlpha = ev.end == null ? 0.5 : 0.85;
        ctx.fillStyle = t.color || '#7c4dff';
        ctx.fillRect(x1, barY, x2 - x1, barH);
        ctx.globalAlpha = 1;
      });
    });

    // Current window highlight (only when a window is active)
    if (timelineWindow) {
      const wx1 = Math.round(tx(windowBase));
      const wx2 = Math.round(tx(Math.min(dur, windowBase + timelineWindow)));
      // Dim regions outside the window
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, wx1, mh);
      ctx.fillRect(wx2, 0, mw - wx2, mh);
      // Window border
      ctx.strokeStyle = 'rgba(79,140,255,0.8)';
      ctx.lineWidth = 1;
      ctx.strokeRect(wx1 + 0.5, 0.5, wx2 - wx1 - 1, mh - 1);
    }

    // Playhead
    const px = Math.round(tx(videoEl.currentTime || 0));
    ctx.strokeStyle = '#e4e7ee'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px + 0.5, 0); ctx.lineTo(px + 0.5, mh); ctx.stroke();
  }

  videoEl.addEventListener('timeupdate', drawMinimap);
  window.addEventListener('resize', debounce(drawMinimap, 100));

  // Minimap click → seek
  minimapCanvas?.addEventListener('click', (e) => {
    const dur = state.duration || videoEl.duration || 0; if (!(dur > 0)) return;
    const rect = minimapCanvas.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * dur;
    try { videoEl.currentTime = Math.max(0, Math.min(dur, t)); } catch {}
  });

  // Timeline window preset buttons
  document.querySelectorAll('.tl-zoom').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.window;
      timelineWindow = val ? Number(val) : null;
      // Align page to current position
      const cur = videoEl.currentTime || 0;
      windowBase = timelineWindow ? Math.floor(cur / timelineWindow) * timelineWindow : 0;
      document.querySelectorAll('.tl-zoom').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      drawTimeline();
      drawMinimap();
    });
  });

  // Timeline interaction
  timelineCanvas.addEventListener('click', (e) => {
    const rect = timelineCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left; const y = e.clientY - rect.top;
    // Hit-test events first (skip ruler area)
    if (y > tickH) {
      const hb = state.hitboxes.find(h => x>=h.x1 && x<=h.x2 && y>=h.y1 && y<=h.y2);
      if (hb){
        const ev = state.events.find(ev => ev.id === hb.id);
        if (ev){ state.selectedEventId = ev.id; if (ev.start!=null) videoEl.currentTime = ev.start; renderAll(); }
        return;
      }
    }
    // Seek to clicked time (works in both full and zoomed views)
    const dur = state.duration || videoEl.duration || 0; if (!(dur>0)) return;
    const seekTime = _tlView.tStart + x / _tlView.pxPerSec;
    try { videoEl.currentTime = Math.max(0, Math.min(dur, seekTime)); } catch {}
  });

  // Event details are now rendered inline inside each expanded type item (renderTypes).
  function renderSelectedDetails(){ /* no-op — handled by renderTypes() */ }

  // Filter selects
  byId('tbl-filter-type')?.addEventListener('change', (e) => { filterTypeId = e.target.value; renderTable(); });
  byId('tbl-filter-animal')?.addEventListener('change', (e) => { filterAnimal = e.target.value; renderTable(); });

  // Events table
  function renderTable(){
    let rows = state.events.filter(ev => ev.end != null).sort((a,b)=>(a.start)-(b.start));
    // Apply filters
    if (filterTypeId) rows = rows.filter(ev => String(ev.typeId) === filterTypeId);
    if (filterAnimal) rows = rows.filter(ev => (ev.animals||[]).includes(filterAnimal));
    tblBody.innerHTML = '';
    rows.forEach(ev => {
      const t = findTypeById(ev.typeId) || {name:'?'};
      const tr = document.createElement('tr'); tr.dataset.id = String(ev.id);
      tr.innerHTML = `
        <td><span class="badge" style="border-color:transparent;background:${(t.color||'#7c4dff')}44"><span class="dot" style="background:${t.color||'#7c4dff'}"></span>${typeName(t)}</span></td>
        <td contenteditable="true" data-f="start">${fmtTime(ev.start||0)}</td>
        <td contenteditable="true" data-f="end">${ev.end!=null?fmtTime(ev.end):''}</td>
        <td>${(ev.end!=null)?fmtTime(Math.max(0,ev.end-(ev.start||0))):'—'}</td>
        <td contenteditable="true" data-f="animals">${(ev.animals||[]).filter(Boolean).join(', ')}</td>
        <td contenteditable="true" data-f="note">${(ev.note||'').replace(/</g,'&lt;')}</td>
        <td><button class="btn mini" data-act="del">✕</button></td>
      `;
      tr.addEventListener('click', () => { state.selectedEventId = ev.id; renderAll(); });
      tr.addEventListener('dblclick', (e) => {
        if (e.shiftKey && ev.end != null) { try { videoEl.currentTime = ev.end; } catch {} }
        else if (ev.start != null) { try { videoEl.currentTime = ev.start; } catch {} }
      });
      tr.querySelector('[data-act="del"]').addEventListener('click', (e) => { e.stopPropagation(); pushHistory(); state.events = state.events.filter(x => x.id !== ev.id); if (state.selectedEventId===ev.id) state.selectedEventId=null; maybeSave(); renderAll(); });
      // inline edits
      tr.querySelectorAll('[contenteditable="true"]').forEach(td => {
        td.addEventListener('blur', () => {
          const f = td.dataset.f;
          const text = td.textContent.trim();
          if (f === 'start' || f==='end'){
            const v = parseTime(text);
            if (v==null && f==='end') { pushHistory(); ev.end = null; }
            else if (v!=null){ pushHistory(); if (f==='start'){ ev.start = Math.max(0,v); if (ev.end!=null) ev.end=Math.max(ev.start, ev.end); } else { ev.end = Math.max(ev.start||0, v); } }
            else { return; } // invalid start input — no change, skip save/render
          } else if (f === 'note') {
            pushHistory(); ev.note = text;
          } else if (f === 'animals') {
            pushHistory();
            const mode = findTypeById(ev.typeId)?.mode;
            const limit = mode === 'polyadic' ? state.mice.length : isPairMode(mode) ? 2 : 1;
            ev.animals = text.split(',').map(s=>s.trim()).filter(Boolean).slice(0, limit);
          }
          maybeSave(); renderAll();
        });
      });
      if (ev.id === state.selectedEventId) tr.classList.add('selected');
      tblBody.appendChild(tr);
    });
  }

  function updateFilterOptions() {
    const typeSel = byId('tbl-filter-type');
    const animalSel = byId('tbl-filter-animal');
    if (typeSel) {
      const cur = typeSel.value;
      typeSel.innerHTML = '<option value="">All types</option>' +
        state.types.map(t => `<option value="${t.id}"${String(t.id)===cur?' selected':''}>${typeName(t)}</option>`).join('');
    }
    if (animalSel) {
      const cur = animalSel.value;
      animalSel.innerHTML = '<option value="">All animals</option>' +
        state.mice.map(m => `<option value="${m}"${m===cur?' selected':''}>${m}</option>`).join('');
    }
  }

  function updateOpenEventBar() {
    const bar = byId('open-event-bar');
    if (bar) bar.hidden = true;
  }

  function renderAll(){
    updateFilterOptions();
    renderTypes();
    renderTable();
    renderSelectedDetails();
    updateOpenEventBar();
    drawTimeline();
    drawMinimap();
  }

  // ── Zoom ───────────────────────────────────────────────────────────────────
  (function initZoom() {
    const videoWrap = videoEl.closest('.video-wrap');
    const overlay   = byId('zoom-overlay');
    const selBox    = byId('zoom-selection');
    const toggleBtn = byId('zoom-toggle');
    if (!videoWrap || !overlay || !toggleBtn) return;

    const z = { active: false, level: 1, panX: 0, panY: 0 };
    let drawing = false, startX = 0, startY = 0;
    let panning = false, panStartX = 0, panStartY = 0, panOriginX = 0, panOriginY = 0;
    let altHeld = false;

    videoEl.style.transformOrigin = '0 0';
    videoEl.style.willChange = 'transform';

    function applyTransform() {
      videoEl.style.transform = (z.level === 1 && z.panX === 0 && z.panY === 0)
        ? '' : `translate(${z.panX}px,${z.panY}px) scale(${z.level})`;
    }

    function clampPan() {
      if (z.level <= 1) { z.panX = 0; z.panY = 0; return; }
      const w = videoEl.offsetWidth;
      const h = videoEl.offsetHeight;
      z.panX = Math.max((1 - z.level) * w, Math.min(0, z.panX));
      z.panY = Math.max((1 - z.level) * h, Math.min(0, z.panY));
    }

    function reset() {
      z.level = 1; z.panX = 0; z.panY = 0;
      applyTransform();
    }

    // rect args are in video-content coordinates
    function zoomToRect(cvx, cvy, cvw, cvh) {
      const W = videoEl.offsetWidth;
      const H = videoEl.offsetHeight;
      z.level = Math.max(1, Math.min(16, Math.min(W / cvw, H / cvh)));
      z.panX  = W / 2 - (cvx + cvw / 2) * z.level;
      z.panY  = H / 2 - (cvy + cvh / 2) * z.level;
      clampPan();
      applyTransform();
    }

    function updateCursor() {
      if (!z.active) return;
      if (panning) { overlay.style.cursor = 'grabbing'; return; }
      overlay.style.cursor = (altHeld && z.level > 1) ? 'grab' : 'crosshair';
    }

    function setActive(on) {
      z.active = on;
      overlay.hidden = !on;
      videoWrap.classList.toggle('zoom-active', on);
      toggleBtn.classList.toggle('active', on);
      if (!on) { reset(); if (selBox) selBox.hidden = true; panning = false; altHeld = false; }
    }

    toggleBtn.addEventListener('click', () => setActive(!z.active));

    // Track Alt key for pan mode
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Alt' && z.active && z.level > 1) {
        altHeld = true;
        updateCursor();
        e.preventDefault(); // suppress browser Alt-focus on some platforms
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.key === 'Alt') { altHeld = false; updateCursor(); }
    });

    overlay.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (altHeld && z.level > 1) {
        // Start panning
        panning = true;
        panStartX = e.clientX;
        panStartY = e.clientY;
        panOriginX = z.panX;
        panOriginY = z.panY;
        updateCursor();
        return;
      }
      // Start drawing a selection rect
      const rect = overlay.getBoundingClientRect();
      startX = e.clientX - rect.left;
      startY = e.clientY - rect.top;
      drawing = true;
      if (selBox) selBox.hidden = true;
    });

    document.addEventListener('mousemove', (e) => {
      if (panning) {
        z.panX = panOriginX + (e.clientX - panStartX);
        z.panY = panOriginY + (e.clientY - panStartY);
        clampPan();
        applyTransform();
        return;
      }
      if (!drawing) return;
      // Stretch the selection rect while dragging (clamped to overlay bounds)
      const rect = overlay.getBoundingClientRect();
      const curX = Math.max(0, Math.min(rect.width,  e.clientX - rect.left));
      const curY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
      const x = Math.min(startX, curX), y = Math.min(startY, curY);
      const w = Math.abs(curX - startX), h = Math.abs(curY - startY);
      if (selBox && (w > 4 || h > 4)) {
        selBox.hidden = false;
        selBox.style.left   = x + 'px';
        selBox.style.top    = y + 'px';
        selBox.style.width  = w + 'px';
        selBox.style.height = h + 'px';
      }
    });

    document.addEventListener('mouseup', (e) => {
      if (panning) {
        panning = false;
        updateCursor();
        return;
      }
      if (!drawing) return;
      drawing = false;
      if (selBox) selBox.hidden = true;
      if (!z.active) return;
      // On release: zoom to rect, or reset on bare click
      const rect = overlay.getBoundingClientRect();
      const curX = Math.max(0, Math.min(rect.width,  e.clientX - rect.left));
      const curY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
      const sw = Math.abs(curX - startX), sh = Math.abs(curY - startY);
      if (sw < 5 && sh < 5) {
        // Bare click → zoom out
        reset();
      } else {
        // Convert screen coords → video-content coords (handles already-zoomed case)
        const cvx = (Math.min(startX, curX) - z.panX) / z.level;
        const cvy = (Math.min(startY, curY) - z.panY) / z.level;
        zoomToRect(cvx, cvy, sw / z.level, sh / z.level);
      }
    });

    // Expose pan shortcut label for help overlay
    initZoom._panKey = 'Alt';
  })();

  // ── Panel resizer ─────────────────────────────────────────────────────────
  (() => {
    const split    = byId('ann-split');
    const left     = byId('ann-left');
    const resizer  = byId('ann-resizer');
    if (!split || !left || !resizer) return;

    const LS_KEY = 'cheesepie.annotator.splitPct';
    const clamp  = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    function applyPct(pct) {
      split.style.setProperty('--ann-left-w', pct.toFixed(2) + '%');
    }

    // Restore saved split
    try {
      const saved = parseFloat(localStorage.getItem(LS_KEY));
      if (saved >= 20 && saved <= 80) applyPct(saved);
    } catch {}

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      resizer.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (ev) => {
        const rect = split.getBoundingClientRect();
        const pct  = clamp((ev.clientX - rect.left) / rect.width * 100, 20, 80);
        applyPct(pct);
      };

      const onUp = (ev) => {
        resizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        // Persist
        const rect = split.getBoundingClientRect();
        const pct  = clamp((ev.clientX - rect.left) / rect.width * 100, 20, 80);
        try { localStorage.setItem(LS_KEY, pct.toFixed(2)); } catch {}
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  })();

  // ── Video height resizer ───────────────────────────────────────────────────
  (function initVidResize() {
    const resizer = byId('vid-resizer');
    if (!resizer) return;

    const LS_KEY = 'cheesepie.annotator.videoH';

    function applyH(h) {
      videoEl.style.height = Math.round(h) + 'px';
    }

    // Restore saved height
    try {
      const saved = Number(localStorage.getItem(LS_KEY));
      if (saved >= 80) applyH(saved);
    } catch {}

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = videoEl.getBoundingClientRect().height;
      resizer.classList.add('dragging');
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';

      const onMove = (e) => {
        applyH(Math.max(80, startH + (e.clientY - startY)));
      };
      const onUp = () => {
        resizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        try { localStorage.setItem(LS_KEY, Math.round(videoEl.getBoundingClientRect().height)); } catch {}
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  })();

  // Boot
  loadAnnotations();
})();
