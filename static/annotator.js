(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const byId = (id) => document.getElementById(id);

  const root = byId('annotator');
  if (!root) return; // Only on annotator page

  const videoPath = (root.dataset.video || '').trim();
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
  const helpBtn = byId('help-shortcuts');
  const helpOverlay = byId('shortcuts-overlay');
  const helpClose = byId('close-shortcuts');
  const helpContent = byId('shortcuts-content');
  const timelineCanvas = byId('timeline');
  const legendEl = byId('legend');
  const detailsEl = byId('event-details');
  const videoPathEl = byId('video-path');
  const typesListEl = byId('types-list');
  const miceInput = byId('mice-input');
  const tblBody = $('#events-table tbody');

  // Type modal elements
  const addTypeOpenBtn = byId('open-add-type');
  const typeOverlay = byId('type-overlay');
  const typeTitle = byId('type-overlay-title');
  const typeNameModal = byId('type-name-modal');
  const typeModeModal = byId('type-mode-modal');
  const typeKeyModal = byId('type-key-modal');
  const typeColorModal = byId('type-color-modal');
  const typeSaveBtn = byId('type-save');
  const typeCancelBtn = byId('type-cancel');

  if (videoPathEl) videoPathEl.textContent = videoPath || 'No video selected';
  if (!videoPath) {
    detailsEl.textContent = 'No video path provided. Return to Browser and select a video.';
    return;
  }

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

  // Utilities
  const fmtTime = (t) => {
    if (!(t>=0)) return '—';
    const h = Math.floor(t/3600);
    const m = Math.floor((t%3600)/60);
    const s = Math.floor(t%60);
    const mm = (h? String(m).padStart(2,'0') : String(m));
    const ss = String(s).padStart(2,'0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
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
  const isPairMode = (mode) => (mode === 'dyadic' || mode === 'agonistic');

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

  // Try to set correct MIME via fileinfo (helps some browsers)
  fetch(`/api/fileinfo?path=${encodeURIComponent(videoPath)}`).then(r=>r.json()).then(info => {
    if (info && info.mime){
      const src = document.createElement('source');
      src.src = `/media?path=${encodeURIComponent(videoPath)}`;
      src.type = info.mime;
      try { while (videoEl.firstChild) videoEl.removeChild(videoEl.firstChild); } catch {}
      videoEl.appendChild(src);
    }
    loadVideo();
  }).catch(() => { loadVideo(); });

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
    resizeCanvas();
  }, {once:true});

  // Load annotations
  const LS_KEY = 'ann:' + videoPath;
  function loadAnnotations(){
    return fetch(`/api/annotations?video=${encodeURIComponent(videoPath)}`).then(async r => {
      const data = await r.json();
      if (!r.ok || data.error){ throw new Error(data.error || 'load failed'); }
      if (data.data){
        applyAnnotationData(data.data);
      } else {
        // Defaults when no file exists yet
        applyAnnotationData(defaultData());
      }
    }).catch(() => {
      // Fallback to localStorage
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (raw){ applyAnnotationData(JSON.parse(raw)); }
        else { applyAnnotationData(defaultData()); }
      } catch { applyAnnotationData(defaultData()); }
    });
  }

  function defaultData(){
    const types = configuredTypes.length ? configuredTypes.map((t,i)=>({id:i+1, ...t})) : [
      {id:1, name:'Grooming', color:'#4f8cff', key:'g', mode:'single'},
      {id:2, name:'Chasing', color:'#ff6b6b', key:'c', mode:'dyadic'},
      {id:3, name:'Sniffing', color:'#ffd166', key:'s', mode:'single'},
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
    state.types = (Array.isArray(d.types) ? d.types : []).map(t => ({...t}));
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
    }).catch(() => {
      try { localStorage.setItem(LS_KEY, JSON.stringify(payload.data)); } catch {}
    });
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
  // FPS is derived from media or config; no manual input UI
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
      setTimeout(() => { exportBtn.textContent = prevText; exportBtn.className = prevClass; exportBtn.disabled = false; }, 1200);
    } catch (err){
      exportBtn.textContent = 'Failed';
      exportBtn.className = prevClass;
      setTimeout(() => { exportBtn.textContent = prevText; exportBtn.disabled = false; }, 2000);
    }
  });

  function showShortcuts(){
    if (!helpOverlay || !helpContent) return;
    const frame = (keyboardCfg && keyboardCfg.frame_step_keys) || {prev:'[', next:']'};
    const jumps = (keyboardCfg && keyboardCfg.jump_seconds) || {left:300, right:300, shift:60, alt:10};
    const lines = [];
    lines.push(`<div class="shortcut-item"><span class="kbd">Space</span> <span>Play/Pause</span></div>`);
    lines.push(`<div class=\"shortcut-item\"><span class=\"kbd\">Enter</span> <span>Finish current event</span></div>`);
    lines.push(`<div class=\"shortcut-item\"><span class=\"kbd\">Esc</span> <span>Cancel current event</span></div>`);
    lines.push(`<div class="shortcut-item"><span class="kbd">${(frame.prev||'[')}</span> <span>Previous frame</span></div>`);
    lines.push(`<div class="shortcut-item"><span class="kbd">${(frame.next||']')}</span> <span>Next frame</span></div>`);
    lines.push(`<div class="shortcut-item"><span class="kbd">←</span> <span>Jump back ${Number(jumps.left||300)}s</span></div>`);
    lines.push(`<div class="shortcut-item"><span class="kbd">→</span> <span>Jump forward ${Number(jumps.right||300)}s</span></div>`);
    if (Number(jumps.shift||0) > 0) lines.push(`<div class="shortcut-item"><span class="kbd">Shift + ←/→</span> <span>Jump ${Number(jumps.shift)}s</span></div>`);
    if (Number(jumps.alt||0) > 0) lines.push(`<div class="shortcut-item"><span class="kbd">Alt + ←/→</span> <span>Jump ${Number(jumps.alt)}s</span></div>`);
    lines.push(`<div class="shortcut-item"><span class="kbd">1..9</span> <span>Select mice while editing (dyadic/agonistic: first press sets first, second sets second)</span></div>`);
    // behavior type keys
    state.types.forEach(t => {
      if (!t.key) return;
      lines.push(`<div class="shortcut-item"><span class="kbd">${String(t.key).toUpperCase()}</span> <span>Start/stop ${t.name}</span></div>`);
    });
    lines.push(`<div class="shortcut-item"><span class="kbd">Timeline click</span> <span>Seek to clicked time</span></div>`);
    lines.push(`<div class="shortcut-item"><span class="kbd">Event click</span> <span>Select event and jump to start</span></div>`);
    lines.push(`<div class="shortcut-item"><span class="kbd">Row double-click</span> <span>Jump to event start</span></div>`);
    helpContent.innerHTML = lines.join('');
    helpOverlay.hidden = false;
  }
  function hideShortcuts(){ if (helpOverlay) helpOverlay.hidden = true; }
  helpBtn?.addEventListener('click', showShortcuts);
  helpClose?.addEventListener('click', hideShortcuts);
  helpOverlay?.addEventListener('click', (e) => { if (e.target === helpOverlay) hideShortcuts(); });

  // Types management
  function renderTypes(){
    typesListEl.innerHTML = '';
    state.types.forEach(t => {
      const row = document.createElement('div'); row.className = 'type-item';
      row.innerHTML = `
        <span class="swatch" style="background:${t.color}"></span>
        <span class="tname">${t.name}</span>
        <span class="muted">(${t.mode}, key: ${t.key || '—'})</span>
        <span class="fill"></span>
        <button class="btn mini" data-act="edit">Edit</button>
        <button class="btn mini" data-act="del">Delete</button>
      `;
      row.querySelector('[data-act="edit"]').addEventListener('click', () => openTypeModal(t));
      row.querySelector('[data-act="del"]').addEventListener('click', () => {
        // Remove type and any open events of that type
        state.events = state.events.filter(e => e.typeId !== t.id);
        state.types = state.types.filter(x => x.id !== t.id);
        if (state.selectedEventId && !state.events.find(e => e.id === state.selectedEventId)) state.selectedEventId = null;
        maybeSave(); renderAll();
      });
      typesListEl.appendChild(row);
    });
    // Legend badges
    legendEl.innerHTML = '';
    state.types.forEach(t => {
      const b = document.createElement('span'); b.className='legend-badge';
      b.innerHTML = `<span class="dot" style="background:${t.color}"></span>${t.name} <span class="muted">[${(t.key||'').toUpperCase()}]</span>`;
      legendEl.appendChild(b);
    });
    resizeCanvas();
  }

  function openTypeModal(existing){
    if (existing){
      state.editingTypeId = existing.id;
      typeTitle.textContent = 'Edit Behavior Type';
      typeSaveBtn.textContent = 'Update';
      typeNameModal.value = existing.name || '';
      typeModeModal.value = existing.mode || 'single';
      typeKeyModal.value = (existing.key || '').slice(0,1);
      typeColorModal.value = existing.color || '#7c4dff';
    } else {
      state.editingTypeId = null;
      typeTitle.textContent = 'Add Behavior Type';
      typeSaveBtn.textContent = 'Add';
      typeNameModal.value = '';
      typeModeModal.value = 'single';
      typeKeyModal.value = '';
      typeColorModal.value = '#7c4dff';
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
    const name = (typeNameModal.value || '').trim(); if (!name) return;
    const selMode = (typeModeModal.value || '').toLowerCase();
    const mode = (selMode === 'dyadic' || selMode === 'agonistic') ? selMode : 'single';
    const key = (typeKeyModal.value || '').trim().slice(0,1);
    const color = typeColorModal.value || '#7c4dff';
    if (state.editingTypeId){
      const t = findTypeById(state.editingTypeId); if (t){ t.name=name; t.mode=mode; t.key=key; t.color=color; }
      state.editingTypeId = null;
    } else {
      state.types.push({id: nextId(), name, mode, key, color});
    }
    renderTypes(); maybeSave(); closeTypeModal();
  });

  // Modal keyboard shortcuts: Enter = save, Esc = cancel
  document.addEventListener('keydown', (e) => {
    if (!typeOverlay || typeOverlay.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeTypeModal(); return; }
    if (e.key === 'Enter') { e.preventDefault(); typeSaveBtn?.click(); return; }
  });

  miceInput.addEventListener('change', () => {
    const list = miceInput.value.split(',').map(s=>s.trim()).filter(Boolean);
    state.mice = list.slice(0, 20); maybeSave(); renderSelectedDetails(); renderTable();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && (e.target.tagName || '').toLowerCase());
    const isTyping = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
    // Space toggles play/pause
    if (!isTyping && (e.code === 'Space' || e.key === ' ')) {
      e.preventDefault(); if (videoEl.paused) videoEl.play(); else videoEl.pause(); return;
    }
    if (!isTyping) {
      // Finish/cancel current open event
      const openEvents = state.events.filter(ev => ev.end == null);
      const selectedOpen = openEvents.find(ev => ev.id === state.selectedEventId) || null;
      const targetOpen = selectedOpen || openEvents[openEvents.length - 1];
      if ((e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter') && targetOpen){
        e.preventDefault();
        const now = videoEl.currentTime || 0;
        targetOpen.end = Math.max(targetOpen.start || 0, now);
        state.selectedEventId = targetOpen.id;
        maybeSave();
        renderAll();
        return;
      }
      if ((e.key === 'Escape' || e.code === 'Escape') && targetOpen){
        e.preventDefault();
        // cancel = remove the open event entirely
        state.events = state.events.filter(ev => ev.id !== targetOpen.id);
        if (state.selectedEventId === targetOpen.id) state.selectedEventId = null;
        if (state.assignCycle.eventId === targetOpen.id) state.assignCycle = { eventId:null, nextSlot:0 };
        maybeSave();
        renderAll();
        return;
      }
      // Single-frame step (supports both key and code for layout robustness)
      if (e.key === '[' || e.code === 'BracketLeft') { e.preventDefault(); step(-1); return; }
      if (e.key === ']' || e.code === 'BracketRight') { e.preventDefault(); step(+1); return; }
      // Configurable jump amounts
      const jumps = (keyboardCfg && keyboardCfg.jump_seconds) || {};
      const baseLeft = Number(jumps.left || 300);
      const baseRight = Number(jumps.right || 300);
      const shift = Number(jumps.shift || 0);
      const alt = Number(jumps.alt || 0);
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const delta = -(e.shiftKey && shift ? shift : (e.altKey && alt ? alt : baseLeft));
        seekSeconds(delta); return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        const delta = (e.shiftKey && shift ? shift : (e.altKey && alt ? alt : baseRight));
        seekSeconds(delta); return;
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
            const t = findTypeById(ev.typeId) || {mode:'single'};
            if (isPairMode(t.mode)) {
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
            renderSelectedDetails();
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
    const now = videoEl.currentTime || 0;
    const open = openEventForType(t.id);
    if (open){
      open.end = Math.max(open.start, now);
      state.selectedEventId = open.id;
    } else {
      const ev = { id: nextId(), typeId: t.id, start: now, end: null, animals: [], note: '' };
      if (t.mode === 'single' && state.mice.length>0) ev.animals = [state.mice[0]];
      if (isPairMode(t.mode) && state.mice.length>1) ev.animals = [state.mice[0], state.mice[1]];
      state.events.push(ev); state.selectedEventId = ev.id;
    }
    renderAll(); maybeSave();
  });

  // Timeline rendering
  const laneH = 26, laneGap = 8, pad = 10;
  function resizeCanvas(){
    const lanes = Math.max(1, state.types.length);
    const h = pad + lanes*(laneH+laneGap) + 10;
    timelineCanvas.height = h;
    drawTimeline();
  }
  function drawTimeline(){
    const ctx = timelineCanvas.getContext('2d');
    const w = timelineCanvas.clientWidth || timelineCanvas.offsetWidth || 600;
    if (timelineCanvas.width !== w) timelineCanvas.width = w; // keep crisp
    const h = timelineCanvas.height;
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = '#0e1220'; ctx.fillRect(0,0,w,h);
    const dur = state.duration || videoEl.duration || 0; if (!(dur>0)) return;
    const pxPerSec = w / dur;
    state.hitboxes = [];
    // lanes background
    state.types.forEach((t, idx) => {
      const y = pad + idx*(laneH+laneGap);
      ctx.fillStyle = '#141a2b'; ctx.fillRect(0,y, w, laneH);
      // events for this type
      const evs = eventsByType(t.id).slice().sort((a,b)=>(a.start)-(b.start));
      evs.forEach(ev => {
        const x1 = Math.max(0, Math.round(ev.start * pxPerSec));
        const x2 = Math.round(((ev.end!=null?ev.end: (videoEl.currentTime||0)))*pxPerSec);
        const width = Math.max(2, x2-x1);
        ctx.globalAlpha = (ev.end==null) ? 0.5 : 0.9;
        ctx.fillStyle = t.color || '#7c4dff';
        ctx.fillRect(x1, y+2, width, laneH-4);
        ctx.globalAlpha = 1.0;
        // outline if selected
        if (ev.id === state.selectedEventId){
          ctx.strokeStyle = '#ffffffaa'; ctx.lineWidth = 2; ctx.strokeRect(x1+1, y+3, Math.max(0,width-2), Math.max(0,laneH-6));
        }
        state.hitboxes.push({x1, x2: x1+width, y1:y, y2:y+laneH, id: ev.id});
      });
    });
    // playhead
    const x = Math.round((videoEl.currentTime||0) * pxPerSec);
    ctx.strokeStyle = '#e4e7ee'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }

  window.addEventListener('resize', debounce(resizeCanvas, 100));
  videoEl.addEventListener('timeupdate', drawTimeline);

  // Timeline interaction
  timelineCanvas.addEventListener('click', (e) => {
    const rect = timelineCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left; const y = e.clientY - rect.top;
    // hit test events first
    const hb = state.hitboxes.find(h => x>=h.x1 && x<=h.x2 && y>=h.y1 && y<=h.y2);
    if (hb){
      const ev = state.events.find(ev => ev.id === hb.id);
      if (ev){ state.selectedEventId = ev.id; if (ev.start!=null) videoEl.currentTime = ev.start; renderAll(); }
      return;
    }
    // otherwise seek
    const dur = state.duration || videoEl.duration || 0; if (!(dur>0)) return;
    const t = (x / (timelineCanvas.width||1)) * dur;
    try { videoEl.currentTime = Math.max(0, Math.min(dur, t)); } catch {}
  });

  // Selected event details
  function renderSelectedDetails(){
    const ev = selectedEvent();
    if (!ev){ detailsEl.innerHTML = '<span class="muted">Select an event.</span>'; return; }
    const t = findTypeById(ev.typeId) || {name:'?'};
    const dur = (ev.end!=null && ev.start!=null) ? Math.max(0, ev.end - ev.start) : null;
    const opts = state.mice.map(m => `<option value="${m}">${m}</option>`).join('');
    const a1 = ev.animals && ev.animals[0] || '';
    const a2 = ev.animals && ev.animals[1] || '';
    detailsEl.innerHTML = `
      <div class="kv"><div class="k">Type</div><div>${t.name}</div></div>
      <div class="kv"><div class="k">Range</div>
        <div class="range-pair">
          <input id="ed-start" type="text" value="${fmtTime(ev.start||0)}">
          <span class="muted">–</span>
          <input id="ed-end" type="text" value="${ev.end!=null?fmtTime(ev.end):''}" placeholder="—">
        </div>
      </div>
      <div class="kv"><div class="k">Duration</div><div>${dur!=null?fmtTime(dur):'—'}</div></div>
      ${t.mode==='single' ? `
        <div class="kv"><div class="k">Mouse</div><div><select id="ed-a1"><option value=""></option>${opts}</select></div></div>
      ` : (t.mode==='agonistic' ? `
        <div class="kv"><div class="k">Pred</div><div><select id="ed-a1"><option value=""></option>${opts}</select></div></div>
        <div class="kv"><div class="k">Prey</div><div><select id="ed-a2"><option value=""></option>${opts}</select></div></div>
      ` : `
        <div class="kv"><div class="k">Mouse A</div><div><select id="ed-a1"><option value=""></option>${opts}</select></div></div>
        <div class="kv"><div class="k">Mouse B</div><div><select id="ed-a2"><option value=""></option>${opts}</select></div></div>
      `)}
      <div class="kv"><div class="k">Note</div><div><textarea id="ed-note" rows="3" placeholder="Optional"></textarea></div></div>
      <div class="row gap">
        <button class="btn" id="set-start">Set start</button>
        <button class="btn" id="set-end">Set end</button>
        <span class="fill"></span>
        <button class="btn" id="delete-ev">Delete</button>
      </div>
    `;
    // If agonistic, relabel the two animal roles
    if (t.mode === 'agonistic'){
      const a1wrap = byId('ed-a1')?.closest('.kv');
      const a2wrap = byId('ed-a2')?.closest('.kv');
      if (a1wrap) { const k = a1wrap.querySelector('.k'); if (k) k.textContent = 'Pred'; }
      if (a2wrap) { const k = a2wrap.querySelector('.k'); if (k) k.textContent = 'Prey'; }
    }
    const edStart = byId('ed-start'); const edEnd = byId('ed-end'); const edNote = byId('ed-note');
    const edA1 = byId('ed-a1'); const edA2 = byId('ed-a2');
    if (edNote) edNote.value = ev.note || '';
    if (edA1) edA1.value = a1; if (edA2) edA2.value = a2;

    edStart?.addEventListener('change', () => { const t = parseTime(edStart.value); if (t!=null){ ev.start = Math.max(0, t); if (ev.end!=null) ev.end=Math.max(ev.start, ev.end); maybeSave(); renderAll(); } });
    edEnd?.addEventListener('change', () => { const t = parseTime(edEnd.value); ev.end = (t==null? null : Math.max(ev.start||0, t)); maybeSave(); renderAll(); });
    edNote?.addEventListener('input', maybeSave);
    function enforceDistinct(evRef){
      const ty = findTypeById(evRef.typeId) || {mode:'single'};
      if (isPairMode(ty.mode)){
        if (evRef.animals && evRef.animals[0] && evRef.animals[1] && evRef.animals[0] === evRef.animals[1]){
          evRef.animals[1] = '';
          const a2sel = byId('ed-a2'); if (a2sel) a2sel.value = '';
        }
      }
    }
    if (edA1) edA1.addEventListener('change', () => { ev.animals = ev.animals || []; ev.animals[0] = edA1.value || ''; enforceDistinct(ev); maybeSave(); renderTable(); });
    if (edA2) edA2.addEventListener('change', () => { ev.animals = ev.animals || []; ev.animals[1] = edA2.value || ''; enforceDistinct(ev); maybeSave(); renderTable(); });
    byId('set-start')?.addEventListener('click', () => { ev.start = videoEl.currentTime||0; if (ev.end!=null) ev.end = Math.max(ev.start, ev.end); maybeSave(); renderAll(); });
    byId('set-end')?.addEventListener('click', () => { ev.end = Math.max(ev.start||0, videoEl.currentTime||0); maybeSave(); renderAll(); });
    byId('delete-ev')?.addEventListener('click', () => { state.events = state.events.filter(x => x.id !== ev.id); state.selectedEventId = null; maybeSave(); renderAll(); });
  }

  // Events table
  function renderTable(){
    const rows = state.events.slice().sort((a,b)=>(a.start)-(b.start));
    tblBody.innerHTML = '';
    rows.forEach(ev => {
      const t = findTypeById(ev.typeId) || {name:'?'};
      const tr = document.createElement('tr'); tr.dataset.id = String(ev.id);
      tr.innerHTML = `
        <td><span class="badge" style="border-color:transparent;background:${(t.color||'#7c4dff')}44"><span class="dot" style="background:${t.color||'#7c4dff'}"></span>${t.name}</span></td>
        <td contenteditable="true" data-f="start">${fmtTime(ev.start||0)}</td>
        <td contenteditable="true" data-f="end">${ev.end!=null?fmtTime(ev.end):''}</td>
        <td>${(ev.end!=null)?fmtTime(Math.max(0,ev.end-(ev.start||0))):'—'}</td>
        <td contenteditable="true" data-f="animals">${(ev.animals||[]).filter(Boolean).join(', ')}</td>
        <td contenteditable="true" data-f="note">${(ev.note||'').replace(/</g,'&lt;')}</td>
        <td><button class="btn mini" data-act="del">✕</button></td>
      `;
      tr.addEventListener('click', () => { state.selectedEventId = ev.id; renderAll(); });
      tr.addEventListener('dblclick', () => { if (ev.start!=null) { try{ videoEl.currentTime = ev.start; } catch{} } });
      tr.querySelector('[data-act="del"]').addEventListener('click', (e) => { e.stopPropagation(); state.events = state.events.filter(x => x.id !== ev.id); if (state.selectedEventId===ev.id) state.selectedEventId=null; maybeSave(); renderAll(); });
      // inline edits
      tr.querySelectorAll('[contenteditable="true"]').forEach(td => {
        td.addEventListener('blur', () => {
          const f = td.dataset.f;
          const text = td.textContent.trim();
          if (f === 'start' || f==='end'){
            const v = parseTime(text);
            if (v==null && f==='end') { ev.end = null; }
            else if (v!=null){ if (f==='start'){ ev.start = Math.max(0,v); if (ev.end!=null) ev.end=Math.max(ev.start, ev.end); } else { ev.end = Math.max(ev.start||0, v); } }
          } else if (f === 'note') {
            ev.note = text;
          } else if (f === 'animals') {
            ev.animals = text.split(',').map(s=>s.trim()).filter(Boolean).slice(0, (isPairMode(findTypeById(ev.typeId)?.mode)?2:1));
          }
          maybeSave(); renderAll();
        });
      });
      if (ev.id === state.selectedEventId) tr.classList.add('selected');
      tblBody.appendChild(tr);
    });
  }

  function renderAll(){
    renderTypes();
    renderTable();
    renderSelectedDetails();
    drawTimeline();
  }

  // Boot
  loadAnnotations();
})();
