(() => {
  // ── Helpers ──────────────────────────────────────────────────────────────
  const byId  = (id) => document.getElementById(id);
  const panel = byId('calibration-panel');
  if (!panel) return;

  const state = {
    ip:          null,   // selected camera IP
    profile:     null,   // selected profile token
    mode:        'snap', // 'snap' | 'auto' | 'live'
    autoTimer:   null,
    maskImg:     null,   // HTMLImageElement for mask PNG
    maskLoaded:  false,
    frameLoaded: false,  // has at least one frame been displayed
    ptzActive:   null,   // currently held PTZ action
  };

  // DOM refs
  const scanBtn        = byId('cal-scan-btn');
  const scanStatus     = byId('cal-scan-status');
  const cameraList     = byId('cal-camera-list');
  const profileGroup   = byId('cal-profile-group');
  const profileSelect  = byId('cal-profile-select');
  const previewCtrls   = byId('cal-preview-controls');
  const previewStatus  = byId('cal-preview-status');
  const maskGroup      = byId('cal-mask-group');
  const maskOpacity    = byId('cal-mask-opacity');
  const maskOpacityVal = byId('cal-mask-opacity-val');
  const ptzGroup       = byId('cal-ptz-group');
  const ptzStatus      = byId('cal-ptz-status');
  const grabBtn        = byId('cal-grab-btn');
  const autoBtn        = byId('cal-auto-btn');
  const liveBtn        = byId('cal-live-btn');
  const placeholder    = byId('cal-placeholder');
  const layers         = byId('cal-layers');
  const frameImg       = byId('cal-frame-img');
  const streamImg      = byId('cal-stream-img');
  const maskCanvas     = byId('cal-mask-canvas');
  const interactCanvas = byId('cal-interact-canvas');
  const pixelBar       = byId('cal-pixel-bar');
  const pixelCoords    = byId('cal-pixel-coords');
  const pixelRgb       = byId('cal-pixel-rgb');
  const pixelSwatch    = byId('cal-pixel-swatch');
  const histPanel      = byId('cal-hist-panel');
  const histCanvas     = byId('cal-hist-canvas');
  const chLum          = byId('cal-ch-lum');
  const chR            = byId('cal-ch-r');
  const chG            = byId('cal-ch-g');
  const chB            = byId('cal-ch-b');

  // ── Mask loading ──────────────────────────────────────────────────────────
  function loadMask() {
    const img = new Image();
    img.onload  = () => { state.maskImg = img; state.maskLoaded = true; drawMask(); };
    img.onerror = () => { state.maskLoaded = false; };
    img.src     = '/api/calibration/mask';
  }
  loadMask();

  // ── Camera discovery ──────────────────────────────────────────────────────
  scanBtn.addEventListener('click', () => {
    scanStatus.textContent = 'Scanning 10.0.0.x … this may take a few seconds.';
    cameraList.innerHTML   = '';
    scanBtn.disabled       = true;

    fetch('/api/calibration/discover')
      .then(r => r.json())
      .then(data => {
        scanBtn.disabled = false;
        const cams = data.cameras || [];
        if (!cams.length) {
          scanStatus.textContent = 'No cameras found on 10.0.0.x.';
          return;
        }
        scanStatus.textContent = `Found ${cams.length} device${cams.length > 1 ? 's' : ''}.`;
        cams.forEach(cam => {
          const li = document.createElement('li');
          li.className = 'cal-camera-item';
          li.innerHTML = `<div class="cal-cam-name">${esc(cam.name || cam.ip)}</div>`
                       + `<div class="cal-cam-ip">${esc(cam.ip)}</div>`;
          li.addEventListener('click', () => selectCamera(cam, li));
          cameraList.appendChild(li);
        });
      })
      .catch(err => {
        scanBtn.disabled   = false;
        scanStatus.textContent = `Error: ${err.message}`;
      });
  });

  function selectCamera(cam, liEl) {
    document.querySelectorAll('.cal-camera-item').forEach(el => el.classList.remove('active'));
    liEl.classList.add('active');
    state.ip = cam.ip;
    stopAuto(); stopLive();
    profileGroup.style.display  = '';
    previewCtrls.style.display  = '';
    maskGroup.style.display     = '';
    ptzGroup.style.display      = '';
    profileSelect.innerHTML     = '<option value="">Loading…</option>';
    profileSelect.disabled      = true;

    fetch(`/api/calibration/profiles?ip=${encodeURIComponent(cam.ip)}`)
      .then(r => r.json())
      .then(data => {
        profileSelect.innerHTML = '';
        (data.profiles || []).forEach(p => {
          const opt = document.createElement('option');
          opt.value       = p.token;
          opt.textContent = p.name + (p.width ? ` (${p.width}×${p.height} ${p.encoding || ''})` : '');
          profileSelect.appendChild(opt);
        });
        profileSelect.disabled = false;
        if (profileSelect.options.length) {
          state.profile = profileSelect.value;
        }
      })
      .catch(err => {
        profileSelect.innerHTML = `<option value="">Error: ${err.message}</option>`;
        profileSelect.disabled  = false;
      });
  }

  profileSelect.addEventListener('change', () => {
    state.profile = profileSelect.value;
    stopAuto(); stopLive();
  });

  // ── Snapshot / auto / live ────────────────────────────────────────────────
  function snapshotUrl() {
    return `/api/calibration/snapshot?ip=${encodeURIComponent(state.ip)}`
         + `&profile=${encodeURIComponent(state.profile)}`
         + `&_t=${Date.now()}`;
  }

  function grabFrame() {
    if (!state.ip || !state.profile) {
      previewStatus.textContent = 'Select a camera and profile first.';
      return;
    }
    previewStatus.textContent = 'Fetching frame…';
    setMode('snap');
    frameImg.style.display  = '';
    streamImg.style.display = 'none';
    frameImg.onload  = () => { onFrameReady(); previewStatus.textContent = ''; };
    frameImg.onerror = () => { previewStatus.textContent = 'Failed to load frame.'; };
    frameImg.src     = snapshotUrl();
  }

  function startAuto() {
    if (!state.ip || !state.profile) return;
    stopLive();
    setMode('auto');
    autoBtn.classList.add('active');
    previewStatus.textContent = 'Auto-refresh on (1 fps)…';
    grabFrame();
    state.autoTimer = setInterval(grabFrame, 1000);
  }

  function stopAuto() {
    if (state.autoTimer) { clearInterval(state.autoTimer); state.autoTimer = null; }
    if (state.mode === 'auto') {
      autoBtn.classList.remove('active');
      previewStatus.textContent = '';
      setMode('snap');
    }
  }

  function startLive() {
    if (!state.ip || !state.profile) return;
    stopAuto();
    setMode('live');
    liveBtn.classList.add('active');
    previewStatus.textContent = 'Connecting live stream…';

    const url = `/api/calibration/stream?ip=${encodeURIComponent(state.ip)}`
              + `&profile=${encodeURIComponent(state.profile)}`;
    frameImg.style.display  = 'none';
    streamImg.style.display = '';
    streamImg.onload = () => {
      onFrameReady();
      previewStatus.textContent = 'Live';
    };
    streamImg.src = url;
  }

  function stopLive() {
    if (state.mode === 'live') {
      streamImg.src = '';
      streamImg.style.display = 'none';
      frameImg.style.display  = '';
      liveBtn.classList.remove('active');
      previewStatus.textContent = '';
      setMode('snap');
    }
  }

  function setMode(m) { state.mode = m; }

  grabBtn.addEventListener('click', () => { stopAuto(); stopLive(); grabFrame(); });
  autoBtn.addEventListener('click', () => state.mode === 'auto' ? stopAuto() : startAuto());
  liveBtn.addEventListener('click', () => state.mode === 'live' ? stopLive() : startLive());

  // ── Frame ready: show layers, sync canvases, draw histogram ──────────────
  function onFrameReady() {
    if (!state.frameLoaded) {
      state.frameLoaded = true;
      placeholder.style.display = 'none';
      layers.style.display      = '';
      pixelBar.style.display    = '';
      histPanel.style.display   = '';
    }
    syncCanvasSize();
    drawMask();
    updateHistogram();
  }

  // ── Canvas sizing ─────────────────────────────────────────────────────────
  function syncCanvasSize() {
    const srcImg = state.mode === 'live' ? streamImg : frameImg;
    const w = srcImg.offsetWidth  || srcImg.clientWidth  || 640;
    const h = srcImg.offsetHeight || srcImg.clientHeight || 480;
    if (maskCanvas.width !== w || maskCanvas.height !== h) {
      maskCanvas.width      = w;
      maskCanvas.height     = h;
      interactCanvas.width  = w;
      interactCanvas.height = h;
    }
  }

  window.addEventListener('resize', () => { syncCanvasSize(); drawMask(); });

  // ── Mask drawing ──────────────────────────────────────────────────────────
  function drawMask() {
    if (!state.maskLoaded || !state.frameLoaded) return;
    syncCanvasSize();
    const ctx = maskCanvas.getContext('2d');
    ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    ctx.globalAlpha = parseFloat(maskOpacity.value) || 0.4;
    ctx.drawImage(state.maskImg, 0, 0, maskCanvas.width, maskCanvas.height);
    ctx.globalAlpha = 1;
  }

  maskOpacity.addEventListener('input', () => {
    maskOpacityVal.textContent = Math.round(maskOpacity.value * 100) + '%';
    drawMask();
  });

  // ── Pixel inspection ──────────────────────────────────────────────────────
  interactCanvas.addEventListener('click', (e) => {
    const srcImg = state.mode === 'live' ? streamImg : frameImg;
    if (!srcImg.naturalWidth) return;

    const rect   = interactCanvas.getBoundingClientRect();
    const cx     = e.clientX - rect.left;
    const cy     = e.clientY - rect.top;
    const px     = Math.round((cx / rect.width)  * srcImg.naturalWidth);
    const py     = Math.round((cy / rect.height) * srcImg.naturalHeight);

    if (state.mode === 'live') {
      // For live stream, grab a fresh snapshot to inspect the pixel
      const tmp = new Image();
      tmp.crossOrigin = 'anonymous';
      tmp.onload = () => samplePixel(tmp, px, py, cx, cy, rect);
      tmp.src    = snapshotUrl();
    } else {
      samplePixel(srcImg, px, py, cx, cy, rect);
    }

    // Draw crosshair
    const ctx = interactCanvas.getContext('2d');
    ctx.clearRect(0, 0, interactCanvas.width, interactCanvas.height);
    ctx.strokeStyle = 'rgba(255,255,80,0.9)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(cx, 0);      ctx.lineTo(cx, interactCanvas.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,  cy);     ctx.lineTo(interactCanvas.width, cy);  ctx.stroke();
    ctx.setLineDash([]);
  });

  function samplePixel(img, px, py, cx, cy, rect) {
    const tmp = document.createElement('canvas');
    tmp.width  = img.naturalWidth  || img.width;
    tmp.height = img.naturalHeight || img.height;
    const ctx  = tmp.getContext('2d');
    ctx.drawImage(img, 0, 0, tmp.width, tmp.height);
    try {
      const d = ctx.getImageData(px, py, 1, 1).data;
      const r = d[0], g = d[1], b = d[2];
      pixelCoords.textContent = `(${px}, ${py})`;
      pixelRgb.textContent    = `R:${r}  G:${g}  B:${b}`;
      pixelSwatch.style.background = `rgb(${r},${g},${b})`;
      pixelBar.style.display = '';
    } catch (err) {
      pixelCoords.textContent = `(${px}, ${py})`;
      pixelRgb.textContent    = 'Pixel unavailable';
    }
  }

  // ── Histogram ─────────────────────────────────────────────────────────────
  function updateHistogram() {
    const srcImg = state.mode === 'live' ? streamImg : frameImg;
    if (!srcImg.naturalWidth) return;
    const tmp = document.createElement('canvas');
    tmp.width  = srcImg.naturalWidth;
    tmp.height = srcImg.naturalHeight;
    const ctx  = tmp.getContext('2d');
    ctx.drawImage(srcImg, 0, 0, tmp.width, tmp.height);
    let data;
    try {
      data = ctx.getImageData(0, 0, tmp.width, tmp.height).data;
    } catch { return; }

    const bins = 256;
    const lumH = new Float32Array(bins);
    const rH   = new Float32Array(bins);
    const gH   = new Float32Array(bins);
    const bH   = new Float32Array(bins);

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2];
      rH[r]++; gH[g]++; bH[b]++;
      const lum = Math.round(0.299*r + 0.587*g + 0.114*b);
      lumH[lum]++;
    }
    drawHistogram({ lum: lumH, r: rH, g: gH, b: bH });
  }

  function drawHistogram({ lum, r, g, b }) {
    const canvas = histCanvas;
    const W = canvas.offsetWidth || 400;
    const H = canvas.offsetHeight || 100;
    if (canvas.width !== W) canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0a0d14';
    ctx.fillRect(0, 0, W, H);

    const showLum = chLum.checked;
    const showR   = chR.checked;
    const showG   = chG.checked;
    const showB   = chB.checked;

    let max = 1;
    for (let i = 0; i < 256; i++) {
      if (showLum && lum[i] > max) max = lum[i];
      if (showR   && r[i]   > max) max = r[i];
      if (showG   && g[i]   > max) max = g[i];
      if (showB   && b[i]   > max) max = b[i];
    }

    const channels = [
      showLum && { data: lum, color: 'rgba(200,200,200,0.55)' },
      showR   && { data: r,   color: 'rgba(255,100,90,0.55)'  },
      showG   && { data: g,   color: 'rgba(80,220,100,0.55)'  },
      showB   && { data: b,   color: 'rgba(80,140,255,0.55)'  },
    ].filter(Boolean);

    channels.forEach(({ data, color }) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      const barW = W / 256;
      for (let i = 0; i < 256; i++) {
        const bh = Math.round((data[i] / max) * H);
        ctx.fillRect(i * barW, H - bh, barW + 0.5, bh);
      }
    });
  }

  [chLum, chR, chG, chB].forEach(ch => ch.addEventListener('change', updateHistogram));

  // ── PTZ controls ──────────────────────────────────────────────────────────
  function sendPtz(action, speed = 0.5) {
    if (!state.ip) return;
    fetch('/api/calibration/ptz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ip: state.ip,
        profile: state.profile || '',
        action,
        speed,
      }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.error) ptzStatus.textContent = d.error;
        else if (d.note) ptzStatus.textContent = d.note;
        else ptzStatus.textContent = '';
      })
      .catch(err => { ptzStatus.textContent = err.message; });
  }

  document.querySelectorAll('.cal-ptz-btn').forEach(btn => {
    const action = btn.dataset.action;
    btn.addEventListener('mousedown', () => { state.ptzActive = action; sendPtz(action); });
    btn.addEventListener('mouseup',   () => { if (state.ptzActive === action) { sendPtz('stop'); state.ptzActive = null; } });
    btn.addEventListener('mouseleave',() => { if (state.ptzActive === action) { sendPtz('stop'); state.ptzActive = null; } });
    btn.addEventListener('touchstart', (e) => { e.preventDefault(); state.ptzActive = action; sendPtz(action); }, { passive: false });
    btn.addEventListener('touchend',   ()  => { if (state.ptzActive === action) { sendPtz('stop'); state.ptzActive = null; } });
  });

  // ── Utilities ─────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
