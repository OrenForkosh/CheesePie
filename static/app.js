(() => {
  // Global auth-aware fetch wrapper to surface session expiry
  try {
    const origFetch = window.fetch.bind(window);
    function showAuthOverlay(){
      if (document.getElementById('auth-expired-overlay')) return;
      const ov = document.createElement('div');
      ov.id = 'auth-expired-overlay';
      ov.style.position = 'fixed';
      ov.style.left = '0'; ov.style.top = '0'; ov.style.right = '0'; ov.style.bottom = '0';
      ov.style.background = 'rgba(0,0,0,0.6)'; ov.style.zIndex = '9999';
      ov.style.display = 'flex'; ov.style.alignItems = 'center'; ov.style.justifyContent = 'center';
      const panel = document.createElement('div');
      panel.style.background = 'var(--panel-bg, #fff)'; panel.style.color = 'var(--text, #111)';
      panel.style.borderRadius = '12px'; panel.style.boxShadow = '0 4px 24px rgba(0,0,0,0.35)';
      panel.style.padding = '20px 24px'; panel.style.minWidth = '280px'; panel.style.maxWidth = '90%';
      panel.style.textAlign = 'center';
      const h = document.createElement('div'); h.textContent = 'Session expired'; h.style.fontSize='18px'; h.style.fontWeight='700'; h.style.marginBottom='6px';
      const p = document.createElement('div'); p.textContent = 'Please log in again to continue.'; p.style.marginBottom='12px'; p.className='muted';
      const btn = document.createElement('a'); btn.textContent='Login'; btn.className='btn primary'; btn.style.display='inline-block'; btn.href = '/auth/login?next=' + encodeURIComponent(location.pathname + location.search);
      panel.appendChild(h); panel.appendChild(p); panel.appendChild(btn);
      ov.appendChild(panel);
      document.body.appendChild(ov);
    }
    window.fetch = function(input, init){
      return origFetch(input, init).then((resp) => {
        try{
          if (resp && (resp.status === 401 || (resp.redirected && String(resp.url).indexOf('/auth/login') !== -1))){
            showAuthOverlay();
            // Reject to stop downstream handlers expecting JSON
            const err = new Error('Unauthorized'); err.response = resp; throw err;
          }
        }catch(e){}
        return resp;
      });
    };
  } catch (e) { /* no-op */ }
  const $ = (sel, el = document) => el.querySelector(sel);
  // Global MATLAB status indicator in header
  const mlDot = $('#ml-dot');
  const listEl = $('#file-list');
  // App-level script runs on all pages; guard browser-only bits.
  const detailsEl = $('#details');
  const actionsEl = $('#actions');
  const sidebarEl = $('#sidebar');
  const dirInput = $('#dir-input');
  const searchInput = $('#search-input');
  const clearBtn = $('#clear-search');
  const loadBtn = $('#load-btn');
  const upBtn = $('#up-btn');
  const themeSelect = document.querySelector('#theme-select');
  const applyThemeBtn = document.querySelector('#apply-theme');

  let currentDir = '';
  let currentSelection = null; // last focused row for range
  let selectedSet = new Set(); // of row DOM nodes
  let lastAnchorIndex = -1; // for shift range
  let debounceTimer = null;
  const LS_KEY = 'cheesepie.lastDir';

  function humanSize(bytes){
    const thresh = 1024; if (Math.abs(bytes) < thresh) return bytes + ' B';
    const units = ['KB','MB','GB','TB']; let u = -1;
    do { bytes /= thresh; ++u; } while (Math.abs(bytes) >= thresh && u < units.length - 1);
    return bytes.toFixed(1)+' '+units[u];
  }

  function fmtTime(ts){
    const d = new Date(ts*1000);
    return d.toLocaleString();
  }

  function clearSelections(){
    selectedSet.forEach(row => row.classList.remove('active'));
    selectedSet.clear();
    currentSelection = null;
    lastAnchorIndex = -1;
  }

  function rowIndexOf(el){
    return Array.prototype.indexOf.call(listEl.children, el);
  }

  function selectRow(row, additive=false){
    if (!additive){ clearSelections(); }
    row.classList.add('active');
    selectedSet.add(row);
    currentSelection = row;
    lastAnchorIndex = rowIndexOf(row);
  }

  function toggleRow(row){
    if (selectedSet.has(row)){
      row.classList.remove('active');
      selectedSet.delete(row);
    } else {
      row.classList.add('active');
      selectedSet.add(row);
      currentSelection = row;
      lastAnchorIndex = rowIndexOf(row);
    }
  }

  function selectRange(toRow){
    if (lastAnchorIndex < 0){ selectRow(toRow, false); return; }
    const toIdx = rowIndexOf(toRow);
    const [a,b] = lastAnchorIndex <= toIdx ? [lastAnchorIndex, toIdx] : [toIdx, lastAnchorIndex];
    clearSelections();
    for (let i=a; i<=b; i++){
      const r = listEl.children[i];
      if (!r) continue;
      r.classList.add('active');
      selectedSet.add(r);
    }
    currentSelection = toRow;
  }

  function renderList(items){
    clearSelections();
    if (!items || items.length === 0){
      listEl.innerHTML = '<div class="placeholder muted">No items found.</div>';
      return;
    }
    listEl.innerHTML = '';
    items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'file-item';
      row.dataset.path = item.path;
      row.dataset.isdir = item.is_dir ? '1' : '0';
      const icon = document.createElement('div');
      icon.className = 'icon ' + (item.is_dir ? 'folder' : 'file');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = item.name;
      const meta = document.createElement('div');
      meta.className = 'meta';
      const size = item.is_dir ? '—' : humanSize(item.size);
      meta.textContent = `${size} · ${fmtTime(item.modified)}`;
      row.appendChild(icon); row.appendChild(name); row.appendChild(meta);
      row.addEventListener('click', (ev) => {
        if (ev.shiftKey){
          selectRange(row);
          updateSelectionDetails();
          return;
        }
        if (ev.metaKey || ev.ctrlKey){
          toggleRow(row);
          updateSelectionDetails();
          return;
        }
        selectRow(row, false);
        updateSelectionDetails();
      });
      row.addEventListener('dblclick', () => {
        if (row.dataset.isdir === '1') {
          currentDir = row.dataset.path;
          if (dirInput) dirInput.value = currentDir;
          try { localStorage.setItem(LS_KEY, currentDir); } catch {}
          loadList();
        }
      });
      listEl.appendChild(row);
    });
  }

  function updateSelectionDetails(){
    const rows = Array.from(selectedSet);
    const placeholder = document.getElementById('details-placeholder');
    if (rows.length === 0){
      if (placeholder) placeholder.style.display = '';
      detailsEl.innerHTML = '';
      updateActionsPanel();
      return;
    }
    if (rows.length === 1){
      const path = rows[0].dataset.path;
      fetch(`/api/fileinfo?path=${encodeURIComponent(path)}`)
        .then(r => r.json())
        .then(info => { try { localStorage.setItem('cheesepie.lastVideo', info.path); } catch {} renderDetails(info); updateActionsPanel(info); })
        .catch(() => { detailsEl.innerHTML = '<div class="muted">Failed to load details.</div>'; updateActionsPanel(); });
      if (placeholder) placeholder.style.display = 'none';
      return;
    }
    // Multi-selection summary
    const files = rows.filter(r => r.dataset.isdir === '0');
    const dirs = rows.length - files.length;
    const listHtml = rows.slice(0,6).map(r => `<div class="muted">${r.dataset.path}</div>`).join('');
    detailsEl.innerHTML = `
      <div style="margin:10px 0 12px"><span class="badge"><span class="dot"></span>${rows.length} selected</span></div>
      <div class="detail-grid">
        <div class="key">Files</div><div>${files.length}</div>
        <div class="key">Folders</div><div>${dirs}</div>
      </div>
      <div style="margin-top:10px">${listHtml}${rows.length>6?'<div class="muted">…</div>':''}</div>
    `;
    if (placeholder) placeholder.style.display = 'none';
    updateActionsPanel();
  }

  function renderDetails(info){
    if (!info || info.error){
      detailsEl.innerHTML = `<div class="muted">${info?.error || 'No details.'}</div>`;
      return;
    }
    const kind = info.is_dir ? 'Folder' : 'File';
    const badge = `<span class="badge"><span class="dot"></span>${kind}</span>`;
    const size = info.is_dir ? '—' : humanSize(info.size);
    const isVideo = (info.mime || '').startsWith('video/');
    const ext = (info.ext || '').toLowerCase();
    const CFG = window.CHEESEPIE || {};
    const VISIBLE_EXTS = (CFG.browser && CFG.browser.visible_extensions) || ['.mp4', '.avi'];
    const isSupportedVideo = VISIBLE_EXTS.includes(ext);
    const video = isVideo ? `
      <div class="video-preview">
        <video id="preview-video" controls preload="metadata">
          <source src="/media?path=${encodeURIComponent(info.path)}" type="${info.mime}">
          Your browser does not support the video tag.
        </video>
      </div>
      <div class="video-meta">
        <div class="key">Duration</div><div id="meta-duration">—</div>
        <div class="key">Resolution</div><div id="meta-resolution">—</div>
        <div class="key">Codec</div><div id="meta-codec">—</div>
        <div class="key">Frame rate</div><div id="meta-fps">—</div>
        <div class="key">Bitrate</div><div id="meta-bitrate">—</div>
      </div>
      <div class="thumb-strip" id="thumb-strip"><div class="placeholder muted">Generating thumbnails…</div></div>
    ` : '';
    updateActionsPanel(info);

    const html = `
      <div style="margin:10px 0 12px">${badge}</div>
      <div class="detail-grid">
        <div class="key">Name</div><div>${info.name}</div>
        <div class="key">Type</div><div>${info.mime || info.ext || '—'}</div>
        <div class="key">Size</div><div>${size}</div>
        <div class="key">Modified</div><div>${fmtTime(info.modified)}</div>
      </div>
      ${video}
    `;
    detailsEl.innerHTML = html;
    const detailsPlaceholder = document.getElementById('details-placeholder');
    if (detailsPlaceholder) detailsPlaceholder.style.display = 'none';
    if (isVideo) { setupVideoEnhancements(info); }

    // Wire up buttons handled in updateActionsPanel
  }

  function updateActionsPanel(currentInfo){
    if (!actionsEl) return;
    const rows = Array.from(selectedSet);
    const placeholder = document.getElementById('actions-placeholder');
    const CFG = window.CHEESEPIE || {};
    const VISIBLE_EXTS = (CFG.browser && CFG.browser.visible_extensions) || ['.mp4', '.avi'];
    // If multi-select > 1, show batch actions (Track/Analyze) and Clear selection
    const selFiles = rows.filter(r => r.dataset.isdir === '0');
    if (selFiles.length > 1){
      actionsEl.innerHTML = `
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:12px">
          <button class="btn mini" id="clear-selection">Clear selection</button>
          <span class="muted">${rows.length} selected</span>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px">
          <button class="btn themed-track" id="act-track">Track</button>
          <button class="btn themed-analyze" id="act-analyze">Analyze</button>
        </div>
      `;
      if (placeholder) placeholder.style.display = 'none';
      const clearBtn = document.getElementById('clear-selection');
      clearBtn?.addEventListener('click', () => { clearSelections(); updateSelectionDetails(); });
      return;
    }
    // Single selection: keep Annotate for supported video
    if (currentInfo){
      const isVideo = (currentInfo.mime || '').startsWith('video/');
      const ext = (currentInfo.ext || '').toLowerCase();
      const isSupportedVideo = VISIBLE_EXTS.includes(ext);
      const topBar = `
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:12px">
          <button class="btn mini" id="clear-selection">Clear selection</button>
          <span class="muted">1 selected</span>
        </div>`;
      const annotatePart = isSupportedVideo ? `<button class=\"btn themed-annotator\" id=\"open-annotator\" title=\"Annotate selected video\">Annotate</button>` : (isVideo ? `<div class=\"muted\">Only ${VISIBLE_EXTS.join(', ')} videos can be opened in the Annotator for now.</div>` : '');
      const preprocPart = `<button class=\"btn themed-preproc\" id=\"act-preproc\">Preproc</button>`;
      const trackAnalyze = `<button class=\"btn themed-track\" id=\"act-track\">Track</button><button class=\"btn themed-analyze\" id=\"act-analyze\">Analyze</button>`;
      actionsEl.innerHTML = `${topBar}<div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px">${annotatePart} ${preprocPart} ${trackAnalyze}</div>`;
      if (placeholder) placeholder.style.display = 'none';
      const clearBtn = document.getElementById('clear-selection');
      clearBtn?.addEventListener('click', () => { clearSelections(); updateSelectionDetails(); });
      const openAnnotBtn = document.getElementById('open-annotator');
      if (openAnnotBtn){
        openAnnotBtn.addEventListener('click', () => {
          try { localStorage.setItem('cheesepie.lastVideo', currentInfo.path); } catch {}
          const url = `/annotator?video=${encodeURIComponent(currentInfo.path)}`;
          window.location.href = url;
        });
      }
      const preprocBtn = document.getElementById('act-preproc');
      if (preprocBtn){
        preprocBtn.addEventListener('click', () => {
          try { localStorage.setItem('cheesepie.lastVideo', currentInfo.path); } catch {}
          let step = '';
          try { step = localStorage.getItem('cheesepie.preproc.step') || ''; } catch {}
          const url = `/preproc?video=${encodeURIComponent(currentInfo.path)}${step?`&step=${encodeURIComponent(step)}`:''}`;
          window.location.href = url;
        });
      }
      return;
    }
    // Default: clear actions
    actionsEl.innerHTML = '';
    if (placeholder) placeholder.style.display = '';
  }

  function formatDuration(sec){
    if (!isFinite(sec) || sec <= 0) return '—';
    const h = Math.floor(sec/3600);
    const m = Math.floor((sec%3600)/60);
    const s = Math.floor(sec%60);
    const mm = h ? String(m).padStart(2,'0') : String(m);
    const ss = String(s).padStart(2,'0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  let thumbJobId = 0;
  function setupVideoEnhancements(info){
    const video = document.getElementById('preview-video');
    const durEl = document.getElementById('meta-duration');
    const resEl = document.getElementById('meta-resolution');
    const codecEl = document.getElementById('meta-codec');
    const fpsEl = document.getElementById('meta-fps');
    const brEl = document.getElementById('meta-bitrate');
    const strip = document.getElementById('thumb-strip');
    if (!video || !durEl || !resEl || !strip) return;

    const onMeta = () => {
      durEl.textContent = formatDuration(video.duration);
      if (video.videoWidth && video.videoHeight){
        resEl.textContent = `${video.videoWidth} × ${video.videoHeight}`;
      }
      generateThumbnails(info, strip, video.duration, video.videoWidth, video.videoHeight);
    };
    if (video.readyState >= 1) { onMeta(); }
    video.addEventListener('loadedmetadata', onMeta, { once: true });

    // Try server-side metadata via ffprobe
    fetch(`/api/media_meta?path=${encodeURIComponent(info.path)}`)
      .then(r => r.json())
      .then(meta => {
        if (!meta || meta.error || meta.available === false) return;
        const v = meta.streams && meta.streams.video || {};
        if (codecEl && v.codec){ codecEl.textContent = v.codec + (v.profile ? ` (${v.profile})` : ''); }
        if (fpsEl && typeof v.fps === 'number' && isFinite(v.fps)){
          fpsEl.textContent = v.fps.toFixed(v.fps < 10 ? 2 : 2) + ' fps';
        }
        if (resEl && v.width && v.height){ resEl.textContent = `${v.width} × ${v.height}`; }
        const br = meta.bit_rate;
        if (brEl && typeof br === 'number' && br > 0){ brEl.textContent = humanBitrate(br); }
        if (durEl && typeof meta.duration === 'number' && meta.duration > 0){ durEl.textContent = formatDuration(meta.duration); }
      })
      .catch(() => {});
  }

  function humanBitrate(bps){
    const kbps = bps / 1000;
    if (kbps < 1000) return `${Math.round(kbps)} kb/s`;
    const mbps = kbps / 1000;
    return `${mbps.toFixed(2)} Mb/s`;
  }

  function generateThumbnails(info, strip, duration, vWidth, vHeight){
    const jobId = ++thumbJobId;
    strip.innerHTML = '<div class="placeholder muted">Generating thumbnails…</div>';
    const CFG = window.CHEESEPIE || {};
    const THUMBS = (CFG.browser && CFG.browser.preview_thumbnails) || 8;
    const N = Math.max(0, Math.min(24, Number(THUMBS) || 8));
    if (!isFinite(duration) || duration <= 0){
      strip.innerHTML = '<div class="placeholder muted">No timeline available.</div>';
      return;
    }
    const times = Array.from({length:N}, (_,i) => (duration * (i+1)/(N+1)));
    // Hidden video clone to avoid disturbing preview playback
    const hv = document.createElement('video');
    hv.muted = true; hv.preload = 'auto'; hv.playsInline = true; hv.crossOrigin = 'anonymous';
    hv.style.position = 'fixed'; hv.style.left = '-9999px'; hv.style.top = '0'; hv.style.width = '160px'; hv.style.visibility = 'hidden';
    const src = document.createElement('source');
    src.src = `/media?path=${encodeURIComponent(info.path)}`; src.type = info.mime || '';
    hv.appendChild(src);
    document.body.appendChild(hv);

    const canvas = document.createElement('canvas');
    const targetW = 240; // capture larger then scale in CSS for crisper thumbs
    const aspect = (vWidth && vHeight) ? (vWidth / vHeight) : (16/9);
    canvas.width = targetW; canvas.height = Math.round(targetW / aspect);
    const ctx = canvas.getContext('2d');

    const thumbs = [];
    const preview = document.getElementById('preview-video');

    const next = (i) => {
      if (jobId !== thumbJobId) return cleanup();
      if (i >= times.length){
        if (thumbs.length === 0){ strip.innerHTML = '<div class="placeholder muted">No thumbnails.</div>'; }
        else {
          strip.innerHTML = '';
          thumbs.forEach(({dataUrl, t}) => {
            const w = document.createElement('div'); w.className = 'thumb'; w.title = formatDuration(t);
            const img = document.createElement('img'); img.src = dataUrl; w.appendChild(img);
            const tag = document.createElement('div'); tag.className = 'time'; tag.textContent = formatDuration(t); w.appendChild(tag);
            w.addEventListener('click', () => { if (preview){ preview.currentTime = t; preview.play(); } });
            strip.appendChild(w);
          });
        }
        return cleanup();
      }
      const t = times[i];
      const onSeeked = () => {
        if (jobId !== thumbJobId) { hv.removeEventListener('seeked', onSeeked); return cleanup(); }
        try {
          ctx.drawImage(hv, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
          thumbs.push({dataUrl, t});
        } catch (e) {}
        hv.removeEventListener('seeked', onSeeked);
        next(i+1);
      };
      hv.addEventListener('seeked', onSeeked);
      try { hv.currentTime = Math.min(Math.max(0.1, t), Math.max(0.1, duration-0.1)); }
      catch(e){ hv.removeEventListener('seeked', onSeeked); next(i+1); }
    };

    const onLoaded = () => { next(0); };
    hv.addEventListener('loadedmetadata', onLoaded, { once:true });
    hv.load();

    function cleanup(){
      try { document.body.removeChild(hv); } catch {}
    }
  }

  function loadList(){
    const q = searchInput.value || '';
    if (!currentDir){
      listEl.innerHTML = '<div class="placeholder muted">Enter a folder path and click Load.</div>';
      return;
    }
    listEl.innerHTML = '<div class="placeholder muted">Loading…</div>';
    fetch(`/api/list?dir=${encodeURIComponent(currentDir)}&q=${encodeURIComponent(q)}`)
      .then(r => r.json())
      .then(data => {
        renderList(data.items);
      })
      .catch(() => {
        listEl.innerHTML = '<div class="placeholder muted">Failed to load folder.</div>';
      });
  }

  function debounce(fn, ms){
    return (...args) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => fn.apply(null, args), ms);
    };
  }

  function parentDir(p){
    if (!p) return '';
    let s = String(p).trim();
    // Normalize separators; keep original for indices
    const isWindows = /^[A-Za-z]:/.test(s);
    // Trim trailing separators except root
    const sepRegex = /[\\/]+$/;
    if (isWindows) {
      // Preserve e.g. C:\ as root
      if (/^[A-Za-z]:[\\/]?$/.test(s)) return s.replace('/', '\\').replace(/$/, '\\');
      s = s.replace(sepRegex, '');
      const idx = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
      if (idx <= 2) return s.slice(0, 3).replace('/', '\\'); // C:\
      return s.slice(0, idx);
    } else {
      if (s === '/') return '/';
      s = s.replace(sepRegex, '');
      const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
      if (idx <= 0) return '/';
      return s.slice(0, idx) || '/';
    }
  }

  function setDirAndLoad(dir){
    const d = (dir || '').trim();
    if (!d){
      listEl.innerHTML = '<div class="placeholder muted">Please enter a valid folder path.</div>';
      return;
    }
    currentDir = d;
    try { localStorage.setItem(LS_KEY, currentDir); } catch {}
    loadList();
  }

  loadBtn?.addEventListener('click', () => {
    setDirAndLoad(dirInput?.value || '');
  });

  // Pressing Enter in the Folder path field triggers Load
  dirInput?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter'){
      ev.preventDefault();
      setDirAndLoad(dirInput.value || '');
    }
  });

  searchInput?.addEventListener('input', debounce(loadList, 150));

  // clear search 'x'
  function toggleClear(){
    if (!clearBtn) return;
    const hasText = (searchInput?.value || '').length > 0;
    clearBtn.hidden = !hasText;
  }
  searchInput?.addEventListener('input', toggleClear);
  clearBtn?.addEventListener('click', () => {
    if (!searchInput) return;
    searchInput.value = '';
    toggleClear();
    loadList();
  });

  upBtn?.addEventListener('click', () => {
    const current = (dirInput?.value || currentDir || '').trim();
    if (!current) return;
    const parent = parentDir(current);
    if (!parent || parent === current) return;
    currentDir = parent;
    if (dirInput) dirInput.value = parent;
    try { localStorage.setItem(LS_KEY, currentDir); } catch {}
    loadList();
  });

  // load last context (prefer last selected video)
  try {
    if (listEl){
      const lastVideo = localStorage.getItem('cheesepie.lastVideo');
      if (lastVideo){
        const pdir = parentDir(lastVideo);
        if (pdir){ currentDir = pdir; if (dirInput) dirInput.value = pdir; try { localStorage.setItem(LS_KEY, pdir); } catch {} }
        desiredSelectPath = lastVideo;
        loadList();
      } else {
        const last = localStorage.getItem(LS_KEY);
        if (last){ currentDir = last; if (dirInput) dirInput.value = currentDir; loadList(); }
      }
    }
  } catch {}

  // Enhance top nav: attach last video to Annotator/Preproc links
  try {
    const lastVideo = localStorage.getItem('cheesepie.lastVideo');
    if (lastVideo){
      const annTab = document.querySelector('a.tab[href="/annotator"]');
      const ppTab = document.querySelector('a.tab[href="/preproc"]');
      if (annTab){ annTab.addEventListener('click', (e) => { e.preventDefault(); window.location.href = `/annotator?video=${encodeURIComponent(lastVideo)}`; }); }
      if (ppTab){ ppTab.addEventListener('click', (e) => { e.preventDefault(); const step = localStorage.getItem('cheesepie.preproc.step') || ''; window.location.href = `/preproc?video=${encodeURIComponent(lastVideo)}${step?`&step=${encodeURIComponent(step)}`:''}`; }); }
    }
  } catch {}

  // Settings page: theme handling
  function applyTheme(theme){
    const allowed = ['dark','light','ocean','forest','plum','contrast','mouse'];
    const t = allowed.includes(theme) ? theme : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('cheesepie.theme', t); } catch {}
    if (themeSelect) themeSelect.value = t;
  }
  if (themeSelect){
    try {
      const saved = localStorage.getItem('cheesepie.theme') || 'dark';
      themeSelect.value = saved;
    } catch {}
  }
  themeSelect?.addEventListener('change', () => {
    applyTheme(themeSelect.value);
  });
  applyThemeBtn?.addEventListener('click', () => {
    applyTheme(themeSelect?.value || 'dark');
  });

  // MATLAB status polling removed
})();

// Bootstrap Preproc video controls defensively in case template script fails
(function(){
  try{
    const v = document.getElementById('pp-video');
    const playBtn = document.getElementById('pp-play');
    const seek = document.getElementById('pp-seek');
    const timeLbl = document.getElementById('pp-time');
    const timeCur = document.getElementById('pp-time-cur');
    const timeDur = document.getElementById('pp-time-dur');
    if (!v || !playBtn || !seek || (!timeLbl && !(timeCur && timeDur))) return;
    const fmt = (sec) => {
      if (!isFinite(sec)) return '00:00.000';
      const h = Math.floor(sec/3600);
      const m = Math.floor((sec%3600)/60);
      const s = Math.floor(sec%60);
      const ms = Math.floor((sec - Math.floor(sec)) * 1000);
      const pad2 = (n)=>String(n).padStart(2,'0');
      const pad3 = (n)=>String(n).padStart(3,'0');
      return h ? `${h}:${pad2(m)}:${pad2(s)}.${pad3(ms)}` : `${pad2(m)}:${pad2(s)}.${pad3(ms)}`;
    };
    const parse = (str) => {
      try{
        const s = String(str||'').trim();
        if (!s) return null;
        // Accept flexible forms: ss(.mmm), mm:ss(.mmm), hh:mm:ss(.mmm)
        const m = s.match(/^(\d+)(?::(\d+))?(?::(\d+))?(?:\.(\d{1,3}))?$/);
        if (!m) return null;
        let h=0, mi=0, se=0, ms=0;
        if (m[3] != null){ // hh:mm:ss[.mmm]
          h = parseInt(m[1],10)||0; mi = parseInt(m[2],10)||0; se = parseInt(m[3],10)||0;
        } else if (m[2] != null){ // mm:ss[.mmm]
          mi = parseInt(m[1],10)||0; se = parseInt(m[2],10)||0;
        } else { // ss[.mmm]
          se = parseFloat(m[1])||0;
        }
        if (m[4] != null){ ms = parseInt(String(m[4]).padEnd(3,'0'),10)||0; }
        return h*3600 + mi*60 + se + (ms/1000);
      }catch(e){ return null; }
    };
    const updateTime = () => {
      const cur = Number(v.currentTime||0);
      const dur = Number(v.duration||0);
      if (timeCur && timeDur){
        timeCur.value = fmt(cur);
        timeDur.textContent = fmt(dur);
        // Match input width to duration label width (max possible)
        try{
          // Force same font on both and measure duration width
          const durRect = timeDur.getBoundingClientRect();
          // Add small padding to account for input padding
          const padLeft = parseFloat(getComputedStyle(timeCur).paddingLeft||'0')||0;
          const padRight = parseFloat(getComputedStyle(timeCur).paddingRight||'0')||0;
          const extra = Math.ceil(padLeft + padRight + 2); // +2 for caret space
          timeCur.style.width = Math.max(60, Math.ceil(durRect.width) + extra) + 'px';
        }catch(e){}
      }
      else if (timeLbl){ timeLbl.textContent = `${fmt(cur)} / ${fmt(dur)}`; }
      if (!seek.dragging) seek.value = String(cur);
    };
    const updateMax = () => { try{ seek.max = String(Math.max(0, Number(v.duration||0))); updateTime(); } catch{} };
    const updatePlayUI = () => {
      const paused = !!v.paused;
      playBtn.textContent = paused ? '▶' : '⏸';
      playBtn.title = paused ? 'Play' : 'Pause';
      playBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    };
    v.addEventListener('loadedmetadata', updateMax);
    v.addEventListener('durationchange', updateMax);
    v.addEventListener('timeupdate', updateTime);
    v.addEventListener('play', updatePlayUI);
    v.addEventListener('pause', updatePlayUI);
    playBtn.addEventListener('click', () => { try{ v.paused ? v.play() : v.pause(); } catch{} });
    seek.addEventListener('input', () => { seek.dragging = true; try{ v.currentTime = Number(seek.value||0); } catch{} });
    seek.addEventListener('change', () => { seek.dragging = false; });
    if (timeCur){
      const jump = () => {
        try{
          const t = parse(timeCur.value);
          if (t == null) return;
          const target = Math.min(Math.max(0, t), Math.max(0, Number(v.duration||0)-1e-6));
          try{ v.pause(); }catch(e){}
          v.currentTime = target; updateTime();
        }catch(e){}
      };
      timeCur.addEventListener('keydown', (ev)=>{ if (ev.key==='Enter'){ ev.preventDefault(); jump(); } });
      timeCur.addEventListener('blur', jump);
    }
    if (v.readyState >= 1) { updateMax(); updatePlayUI(); }
  } catch{}
})();
