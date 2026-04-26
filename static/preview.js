var _previewAC = null;

function initPreview() {
  // Tear down previous run's document/window listeners before re-registering.
  if (_previewAC) { _previewAC.abort(); }
  _previewAC = new AbortController();
  const { signal } = _previewAC;

    let videoPath = (document.getElementById('preview-chip') || {}).dataset.video || '';
  const v = document.getElementById('an-video');
  const c = document.getElementById('an-canvas');
  const fpsEl = document.getElementById('an-fps');
  const framesEl = document.getElementById('an-frames');
  const msgEl = document.getElementById('an-msg');
  const nameEl = document.getElementById('an-name');
  const timeEl = document.getElementById('an-time');
  const helpBtn = document.getElementById('preview-help-shortcuts');
  const dropTarget = document.getElementById('preview-drop-target');
  const facilitySel = document.getElementById('app-facility');
  let fac = facilitySel && facilitySel.value || '';
  document.addEventListener('app:facility-changed', (e) => { try { fac = (e && e.detail && e.detail.name) || ''; } catch { } }, { signal })

  function hasDragFiles(ev) {
    try {
      const types = ev && ev.dataTransfer && ev.dataTransfer.types;
      if (types && Array.from(types).includes('Files')) return true;
      return Boolean(ev && ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length);
    } catch (_) {
      return false;
    }
  }

  function setDropActive(active) {
    if (!dropTarget) return;
    if (active) dropTarget.classList.add('drag-active');
    else dropTarget.classList.remove('drag-active');
  }

  async function uploadDropFile(file) {
    if (!file) return;
    if (msgEl) msgEl.textContent = `Uploading ${file.name}...`;
    const body = new FormData();
    body.append('file', file);
    let resp = null;
    try {
      resp = await fetch('/api/preview_upload', { method: 'POST', body });
    } catch (e) {
      if (msgEl) msgEl.textContent = 'Upload failed. Check connection.';
      return;
    }
    if (!resp || !resp.ok) {
      let errMsg = '';
      try {
        const err = await resp.json();
        errMsg = err && err.error ? err.error : '';
      } catch (_) {
        try { errMsg = await resp.text(); } catch (_) { }
      }
      if (msgEl) msgEl.textContent = `Upload failed${errMsg ? `: ${errMsg}` : ''}.`;
      return;
    }
    let data = null;
    try { data = await resp.json(); } catch (_) { }
    const newPath = data && data.path ? String(data.path) : '';
    if (!newPath) {
      if (msgEl) msgEl.textContent = 'Upload failed: no path returned.';
      return;
    }
    if (nameEl) nameEl.value = newPath;
    if (window.cheesepieSetModuleVideo) window.cheesepieSetModuleVideo('preview', newPath);
    try { localStorage.setItem('cheesepie.preview.lastVideo', newPath); } catch (_) { }
    if (msgEl) msgEl.textContent = 'Upload complete. Loading preview...';
    window.location.href = '/preview?video=' + encodeURIComponent(newPath);
  }

  function setupDropTarget() {
    if (!dropTarget) return;
    let dragDepth = 0;
    const onDragEnter = (e) => {
      if (!hasDragFiles(e)) return;
      e.preventDefault();
      dragDepth += 1;
      setDropActive(true);
    };
    const onDragOver = (e) => {
      if (!hasDragFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setDropActive(true);
    };
    const onDragLeave = (e) => {
      if (!hasDragFiles(e)) return;
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDropActive(false);
    };
    const onDrop = (e) => {
      if (!hasDragFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepth = 0;
      setDropActive(false);
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      uploadDropFile(files[0]);
    };
    dropTarget.addEventListener('dragenter', onDragEnter);
    dropTarget.addEventListener('dragover', onDragOver);
    dropTarget.addEventListener('dragleave', onDragLeave);
    dropTarget.addEventListener('drop', onDrop);
    if (!window.CHEESEPIE_PREVIEW_DROP_LISTENERS) {
      window.CHEESEPIE_PREVIEW_DROP_LISTENERS = true;
      document.addEventListener('dragover', (e) => {
        if (window.cheesepieIsActivePage && !window.cheesepieIsActivePage('/preview')) return;
        if (hasDragFiles(e)) e.preventDefault();
      });
      document.addEventListener('drop', (e) => {
        if (window.cheesepieIsActivePage && !window.cheesepieIsActivePage('/preview')) return;
        if (hasDragFiles(e)) e.preventDefault();
      });
    }
  }

  setupDropTarget();

  // Reuse last previewed video if none provided (remember across tabs)
  if (!videoPath) {
    try { videoPath = localStorage.getItem('cheesepie.preview.lastVideo') || ''; } catch (_) { videoPath = ''; }
    if (videoPath && nameEl) nameEl.value = videoPath;
  }
  if (window.cheesepieSetModuleVideo) {
    window.cheesepieSetModuleVideo('preview', videoPath || '');
  } else {
    try {
      if (videoPath) localStorage.setItem('cheesepie.preview.video', videoPath);
      else localStorage.removeItem('cheesepie.preview.video');
    } catch {}
  }
  if (!videoPath) { msgEl.textContent = 'No video provided. Drag a video here or open from Browser → Preview.'; return; }
  try { localStorage.setItem('cheesepie.preview.lastVideo', videoPath); } catch (_) { }
  // Load video
  (function loadVideo() { try { const s = document.createElement('source'); s.src = '/media?path=' + encodeURIComponent(videoPath); v.appendChild(s); v.load(); } catch (e) { } })();
  // Fetch meta and positions via existing analyze API
  let fps = 0, frames = 0, hasTracking = false;
  let trackColors = [];
  let trackMice = 0;
  let videoWidth = 0;
  let videoHeight = 0;
  const colorMap = { R: '#ff6b6b', G: '#4ade80', B: '#60a5fa', Y: '#facc15' };
  const fallbackColors = ['#ff6b6b', '#4ade80', '#60a5fa', '#facc15', '#f472b6', '#fb923c'];
  const chunkSize = 300; // frames
  let lastChunkStart = -1;
  let currentChunk = null;
  let durationSec = 0;

  function updateFpsFromVideo() {
    if (durationSec <= 0 && isFinite(v.duration) && v.duration > 0) {
      durationSec = v.duration;
    }
    if (!fps && frames > 0 && durationSec > 0) {
      fps = Math.max(1, Math.round(frames / durationSec));
      fpsEl.textContent = String(fps);
    }
  }

  function normalizeColors(raw) {
    if (!raw) return [];
    const entries = Array.isArray(raw) ? raw : [raw];
    const tokens = [];
    entries.forEach((entry) => {
      if (entry == null) return;
      const s = String(entry).trim();
      if (!s) return;
      if (s.includes(',')) {
        s.split(',').forEach((p) => { const t = p.trim(); if (t) tokens.push(t); });
      } else if (s.includes(' ')) {
        s.split(' ').forEach((p) => { const t = p.trim(); if (t) tokens.push(t); });
      } else if (s.length > 1 && /^[A-Za-z]+$/.test(s)) {
        s.split('').forEach((ch) => tokens.push(ch));
      } else {
        tokens.push(s);
      }
    });
    return tokens;
  }

  function mouseColor(idx) {
    const raw = trackColors[idx];
    if (raw) {
      const key = String(raw).trim();
      if (key) {
        const upper = key.toUpperCase();
        if (colorMap[upper]) return colorMap[upper];
        return key;
      }
    }
    return fallbackColors[idx % fallbackColors.length];
  }

  function updateVideoDims() {
    if (v.videoWidth) videoWidth = v.videoWidth;
    if (v.videoHeight) videoHeight = v.videoHeight;
  }

  // Fallback: probe media metadata for fps and frame count
  fetch('/api/media_meta?path=' + encodeURIComponent(videoPath))
    .then(r => r.ok ? r.json() : null)
    .then(meta => {
      if (!meta) return;
      const mfps = meta?.streams?.video?.fps;
      const mframes = meta?.streams?.video?.nb_frames;
      const mdur = meta?.duration;
      if (!fps && mfps && isFinite(mfps)) {
        fps = Math.max(1, Math.round(mfps));
        fpsEl.textContent = String(fps);
      }
      if (!frames && mframes && isFinite(mframes)) {
        frames = Math.max(0, Math.round(mframes));
        framesEl.textContent = frames ? String(frames) : '—';
      }
      if (!durationSec && mdur && isFinite(mdur)) {
        durationSec = mdur;
      }
      updateFpsFromVideo();
    }).catch(() => { });

  fetch('/api/analyze/info?video=' + encodeURIComponent(videoPath) + (fac ? ('&facility=' + encodeURIComponent(fac)) : ''))
    .then(r => r.json()).then(info => {
      frames = Math.max(0, Math.round((info && info.frames) || 0));
      framesEl.textContent = frames ? String(frames) : '—';
      hasTracking = Boolean(info && info.ok);
      if (!hasTracking) {
        const reason = info && info.reason;
        if (reason === 'missing_file') {
          msgEl.textContent = `Tracking file not found: ${(info && info.track) || ''}`.trim();
        } else if (reason === 'missing_data') {
          msgEl.textContent = `Tracking file found but no tracking data: ${(info && info.track) || ''}`.trim();
        } else {
          msgEl.textContent = 'No tracking found for this video.';
        }
        return;
      }
      trackMice = Math.max(0, Math.round((info && info.mice) || 0));
      trackColors = normalizeColors(info && info.colors);
      const colorLabel = trackColors.length ? ` (colors: ${trackColors.join(', ')})` : '';
      msgEl.textContent = `Tracking loaded${trackMice ? `: ${trackMice} mice${colorLabel}` : colorLabel}.`;
      fps = Math.max(0, Math.round((info && info.fps) || 0));
      fpsEl.textContent = fps ? String(fps) : '—';
      updateFpsFromVideo();
    }).catch(() => { msgEl.textContent = 'Failed to load tracking info.'; });
  // Draw positions in chunks as video plays
  const ctx = c.getContext('2d');
  function resize() { try { const r = v.getBoundingClientRect(); c.width = Math.max(1, Math.round(r.width)); c.height = Math.max(1, Math.round(r.height)); } catch (e) { } }
  window.addEventListener('resize', resize, { signal }); v.addEventListener('loadedmetadata', () => { updateVideoDims(); resize(); updateFpsFromVideo(); }); if (v.readyState >= 1) { updateVideoDims(); resize(); updateFpsFromVideo(); }
  // simple streaming draw example
  function fetchAndDraw(start) {
    if (!hasTracking) return;
    const url = '/api/analyze/positions?video=' + encodeURIComponent(videoPath) + '&start=' + start + '&count=' + chunkSize + (fac ? ('&facility=' + encodeURIComponent(fac)) : '');
    fetch(url).then(r => r.ok ? r.json() : null).then(d => {
      if (!d || !d.ok || !Array.isArray(d.x) || !Array.isArray(d.y)) return;
      const normalized = detectNormalized(d.x, d.y);
      currentChunk = { start: d.start || start, x: d.x, y: d.y, normalized };
      drawFrame(Math.floor((v.currentTime || 0) * (fps || 0)));
    }).catch(() => { });
  }
  function detectNormalized(xs, ys) {
    let maxAbs = 0;
    for (let i = 0; i < xs.length; i++) {
      const rowX = xs[i] || [];
      const rowY = ys[i] || [];
      const cols = Math.min(rowX.length, rowY.length);
      for (let j = 0; j < cols; j++) {
        const vx = rowX[j];
        const vy = rowY[j];
        if (isFinite(vx)) maxAbs = Math.max(maxAbs, Math.abs(vx));
        if (isFinite(vy)) maxAbs = Math.max(maxAbs, Math.abs(vy));
      }
    }
    return maxAbs <= 2;
  }
  function drawFrame(frame) {
    try {
      ctx.clearRect(0, 0, c.width, c.height);
      if (!currentChunk || !fps) return;
      const rel = frame - (currentChunk.start || 0);
      const xs = currentChunk.x || [];
      const ys = currentChunk.y || [];
      if (rel < 0 || !xs.length || !ys.length || rel >= (xs[0] ? xs[0].length || 0 : 0)) return;
      const normalized = currentChunk.normalized !== false;
      const scaleX = videoWidth ? (c.width / videoWidth) : 1;
      const scaleY = videoHeight ? (c.height / videoHeight) : 1;
      const mice = Math.min(xs.length, ys.length);
      for (let i = 0; i < mice; i++) {
        const px = xs[i] && xs[i][rel]; const py = ys[i] && ys[i][rel];
        if (!isFinite(px) || !isFinite(py)) continue;
        const x = normalized ? (px * c.width) : (px * scaleX);
        const y = normalized ? (py * c.height) : (py * scaleY);
        ctx.fillStyle = mouseColor(i);
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      }
    } catch (e) { }
  }
  function updateTimeLabel() {
    if (!timeEl) return;
    const t = v.currentTime || 0;
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const ms = Math.floor((t - Math.floor(t)) * 1000);
    timeEl.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }

  v.addEventListener('timeupdate', () => {
    updateTimeLabel();
    if (!hasTracking || !fps) return; const frame = Math.floor((v.currentTime || 0) * fps);
    const chunkStart = Math.floor(frame / chunkSize) * chunkSize;
    if (!currentChunk || frame < (currentChunk.start || 0) || frame >= (currentChunk.start || 0) + chunkSize) { currentChunk = null; }
    if (chunkStart !== lastChunkStart) { lastChunkStart = chunkStart; fetchAndDraw(chunkStart); }
    drawFrame(frame);
  });
  v.addEventListener('seeking', () => { currentChunk = null; });
  v.addEventListener('play', () => { if (hasTracking && fps) fetchAndDraw(Math.floor((v.currentTime || 0) * fps / chunkSize) * chunkSize); });
  v.addEventListener('pause', () => { updateTimeLabel(); drawFrame(Math.floor((v.currentTime || 0) * (fps || 0))); });
  // ensure first draw when ready
  v.addEventListener('canplay', () => { updateVideoDims(); updateTimeLabel(); if (fps) drawFrame(Math.floor((v.currentTime || 0) * fps)); });
  if (v.readyState >= 2) { updateVideoDims(); updateTimeLabel(); if (fps) drawFrame(Math.floor((v.currentTime || 0) * fps)); }

  // Keyboard shortcuts
  const keyboardCfg = ((window.CHEESEPIE || {}).annotator || {}).keyboard || {};
  const jumpCfg = keyboardCfg.jump_seconds || { left: 5, right: 5, shift: 1, alt: 0.5 };
  const frameCfg = keyboardCfg.frame_step_keys || { prev: '[', next: ']' };

  function seekSeconds(delta) {
    const dur = v.duration || 0; if (!(dur > 0)) return;
    const t = Math.max(0, Math.min(dur, (v.currentTime || 0) + delta));
    try { v.currentTime = t; } catch { }
  }
  function stepFrame(dir) {
    if (!fps) {
      // If still unknown, try to estimate from metadata or duration/frames
      updateFpsFromVideo();
      if (!fps) return;
    }
    v.pause();
    const delta = dir / fps;
    seekSeconds(delta);
  }
  function openShortcuts() {
    if (window.CheesePieShortcuts && window.CheesePieShortcuts.renderPlaybackShortcuts) {
      const rows = window.CheesePieShortcuts.renderPlaybackShortcuts();
      window.CheesePieShortcuts.showOverlay('Keyboard Shortcuts', rows);
      return;
    }
  }
  helpBtn?.addEventListener('click', openShortcuts);

  document.addEventListener('keydown', (e) => {
    if (window.cheesepieIsActivePage && !window.cheesepieIsActivePage('/preview')) return;
    const tag = (e.target && (e.target.tagName || '').toLowerCase());
    const isTyping = tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable);
    const overlayOpen = window.CheesePieShortcuts && window.CheesePieShortcuts.isOverlayOpen && window.CheesePieShortcuts.isOverlayOpen();
    if (overlayOpen) {
      if (e.key === 'Escape') { return; }
      return;
    }
    if (isTyping) return;
    if (e.key === '?' || (e.key === '/' && e.shiftKey)) { e.preventDefault(); openShortcuts(); return; }
    if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); if (v.paused) v.play(); else v.pause(); return; }
    if (e.key === (frameCfg.prev || '[') || e.code === 'BracketLeft') { e.preventDefault(); stepFrame(-1); return; }
    if (e.key === (frameCfg.next || ']') || e.code === 'BracketRight') { e.preventDefault(); stepFrame(1); return; }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const delta = -(e.shiftKey && jumpCfg.shift ? jumpCfg.shift : (e.altKey && jumpCfg.alt ? jumpCfg.alt : (jumpCfg.left || 0)));
      seekSeconds(delta); return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const delta = (e.shiftKey && jumpCfg.shift ? jumpCfg.shift : (e.altKey && jumpCfg.alt ? jumpCfg.alt : (jumpCfg.right || 0)));
      seekSeconds(delta); return;
    }
  }, { signal });
  }
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', initPreview);
  } else {
    initPreview();
  }
