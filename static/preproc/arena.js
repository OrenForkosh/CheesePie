// Arena tab: marking and overlay
(function(){
  if (!window.Preproc) window.Preproc = {};
  const { State, Util } = window.Preproc;

  const MIN_W = 10; // minimum width in video pixels
  const MIN_H = 10; // minimum height in video pixels

  function overlayMetrics(ctx){
    const v = ctx.video;
    const overlay = ctx.overlay;
    const rect = overlay.getBoundingClientRect();
    const vw = v.videoWidth||0, vh=v.videoHeight||0;
    const scaleX = vw? (rect.width / vw) : 1;
    const scaleY = vh? (rect.height / vh) : 1;
    return { rect, vw, vh, scaleX, scaleY };
  }

  function updateHandles(ctx){
    try{
      const hTL = ctx.hTL, hBR = ctx.hBR;
      if (!hTL || !hBR){ return; }
      if (!(State.tl && State.br)){
        hTL.style.display = 'none';
        hBR.style.display = 'none';
        return;
      }
      const m = overlayMetrics(ctx);
      const x1 = Math.round(State.tl.x * m.scaleX);
      const y1 = Math.round(State.tl.y * m.scaleY);
      const x2 = Math.round(State.br.x * m.scaleX);
      const y2 = Math.round(State.br.y * m.scaleY);
      hTL.style.left = x1 + 'px'; hTL.style.top = y1 + 'px'; hTL.style.display = '';
      hBR.style.left = x2 + 'px'; hBR.style.top = y2 + 'px'; hBR.style.display = '';
      // Active handle highlight
      hTL.classList.toggle('active', ctx.activeHandle === 'tl');
      hBR.classList.toggle('active', ctx.activeHandle === 'br');
    } catch(e){}
  }

  function drawOverlay(ctx){
    try{
      const overlay = ctx.overlay;
      const v = ctx.video;
      const g = overlay.getContext('2d');
      g.clearRect(0,0,overlay.width, overlay.height);
      const rect = v.getBoundingClientRect();
      overlay.width = rect.width; overlay.height = rect.height;
      // Always update handles visibility/position even if no rectangle yet
      updateHandles(ctx);
      if (!(State.tl && (State.br||ctx._hoverBR))) return;
      const vw = v.videoWidth||0, vh = v.videoHeight||0;
      if (!vw || !vh) return;
      const scaleX = rect.width / vw;
      const scaleY = rect.height / vh;
      const br = State.br || ctx._hoverBR;
      const x = State.tl.x * scaleX;
      const y = State.tl.y * scaleY;
      const w = (br.x - State.tl.x) * scaleX;
      const h = (br.y - State.tl.y) * scaleY;
      g.strokeStyle = '#4f8cff'; g.lineWidth = 2; g.strokeRect(x, y, w, h);

      // Draw grid when not in marking mode
      if (!State.marking){
        try{
          var colsEl = document.getElementById('grid-cols');
          var rowsEl = document.getElementById('grid-rows');
          var cols = parseInt((colsEl&&colsEl.value)||'')||6;
          var rows = parseInt((rowsEl&&rowsEl.value)||'')||4;
          cols = Math.max(1, Math.min(200, cols));
          rows = Math.max(1, Math.min(200, rows));
          g.save();
          g.strokeStyle = 'rgba(79,140,255,0.35)';
          g.lineWidth = 1;
          // Vertical lines
          for (var c=1;c<cols;c++){
            var gx = x + (w * c / cols);
            g.beginPath(); g.moveTo(gx, y); g.lineTo(gx, y+h); g.stroke();
          }
          // Horizontal lines
          for (var r=1;r<rows;r++){
            var gy = y + (h * r / rows);
            g.beginPath(); g.moveTo(x, gy); g.lineTo(x+w, gy); g.stroke();
          }
          g.restore();
        } catch(e){}
      }
    } catch(e) {}
  }

  function handleClick(ctx, ev){
    if (!State.marking) return;
    const overlay = ctx.overlay;
    const r = overlay.getBoundingClientRect();
    const v = ctx.video;
    const px = Util.clamp(Math.round((ev.clientX - r.left) / r.width * (v.videoWidth||1)), 0, (v.videoWidth||1)-1);
    const py = Util.clamp(Math.round((ev.clientY - r.top) / r.height * (v.videoHeight||1)), 0, (v.videoHeight||1)-1);
    if (!State.tl){ State.tl = {x:px, y:py}; State.br = null; ctx._hoverBR = null; }
    else if (!State.br){
      State.br = {x: Math.max(px, State.tl.x+MIN_W), y: Math.max(py, State.tl.y+MIN_H)};
      // Save immediately after completing BR placement
      scheduleSave(ctx);
    }
    drawOverlay(ctx); notifyChanged();
  }

  function handleMove(ctx, ev){
    if (!State.marking || State.br) return;
    const overlay = ctx.overlay;
    const v = ctx.video;
    const r = overlay.getBoundingClientRect();
    const px = Util.clamp(Math.round((ev.clientX - r.left) / r.width * (v.videoWidth||1)), 0, (v.videoWidth||1)-1);
    const py = Util.clamp(Math.round((ev.clientY - r.top) / r.height * (v.videoHeight||1)), 0, (v.videoHeight||1)-1);
    ctx._hoverBR = { x: Math.max(px, (State.tl?State.tl.x:0)+MIN_W), y: Math.max(py, (State.tl?State.tl.y:0)+MIN_H) };
    drawOverlay(ctx);
  }

  function setMarking(ctx, on, opts){
    State.marking = !!on;
    if (ctx.markBtn){
      if (State.marking){ ctx.markBtn.classList.add('primary'); ctx.markBtn.textContent = 'Marking…'; if (ctx.status) ctx.status.textContent = 'Click top-left then bottom-right'; }
      else { ctx.markBtn.classList.remove('primary'); ctx.markBtn.textContent = 'Mark'; if (ctx.status) ctx.status.textContent=''; }
    }
    ctx.overlay.style.pointerEvents = State.marking ? 'auto' : 'none';
    if (State.marking){
      // When entering marking from the button, reset TL/BR; when entering via handles, preserve
      var preserve = opts && !!opts.preserve;
      if (!preserve){ State.tl = null; State.br = null; ctx._hoverBR = null; }
      ctx.activeHandle = null;
    } else {
      // leaving marking: clear active highlight
      ctx.activeHandle = null;
      if (State.tl && State.br){ scheduleSave(ctx); notifyChanged(); }
    }
    drawOverlay(ctx);
  }

  function toggleMark(ctx){ setMarking(ctx, !State.marking); }

  function attachHandleDrag(ctx, el, corner){
    if (!el) return;
    var dragging = false;
    function onDown(ev){ ev.preventDefault(); if (!State.marking) setMarking(ctx, true, {preserve:true}); ctx.activeHandle = corner; dragging = true; el.classList.add('dragging'); updateHandles(ctx); document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp, { once:true }); }
    function onMove(ev){
      if (!dragging) return;
      const m = overlayMetrics(ctx);
      const r = ctx.overlay.getBoundingClientRect();
      const px = Util.clamp(Math.round((ev.clientX - r.left) / r.width * (m.vw||1)), 0, (m.vw||1)-1);
      const py = Util.clamp(Math.round((ev.clientY - r.top) / r.height * (m.vh||1)), 0, (m.vh||1)-1);
      if (!(State.tl && State.br)) return;
      if (corner==='tl'){
        State.tl = { x: Math.min(px, State.br.x-MIN_W), y: Math.min(py, State.br.y-MIN_H) };
      } else {
        State.br = { x: Math.max(px, State.tl.x+MIN_W), y: Math.max(py, State.tl.y+MIN_H) };
      }
      drawOverlay(ctx); notifyChanged();
    }
    function onUp(){ dragging = false; el.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); updateHandles(ctx); scheduleSave(ctx); }
    el.addEventListener('mousedown', onDown);
    el.addEventListener('click', function(){ if (!State.marking) setMarking(ctx, true, {preserve:true}); ctx.activeHandle = corner; updateHandles(ctx); });
  }

  // Debounced save to backend
  function scheduleSave(ctx){
    try{
      if (!(State.tl && State.br)) return;
      if (ctx._saveTimer) clearTimeout(ctx._saveTimer);
      ctx._saveTimer = setTimeout(function(){ saveArena(ctx); }, 150);
    } catch(e){}
  }

  function saveArena(ctx){
    try{
      if (!(State.tl && State.br)) return;
      var videoPath = (window.Preproc && window.Preproc.State && window.Preproc.State.videoPath) || '';
      if (!videoPath) return;
      if (ctx.status) ctx.status.textContent = 'Saving…';
      // Read grid/size controls to persist alongside bbox
      var colsEl = document.getElementById('grid-cols');
      var rowsEl = document.getElementById('grid-rows');
      var wcmEl = document.getElementById('arena-wcm');
      var hcmEl = document.getElementById('arena-hcm');
      var cols = parseInt((colsEl && colsEl.value) || '', 10);
      var rows = parseInt((rowsEl && rowsEl.value) || '', 10);
      var wcm = parseInt((wcmEl && wcmEl.value) || '', 10);
      var hcm = parseInt((hcmEl && hcmEl.value) || '', 10);
      var payload = { video: videoPath, arena: { tl: {x:State.tl.x, y:State.tl.y}, br: {x:State.br.x, y:State.br.y} } };
      // Attach only if valid numbers
      if (!isNaN(cols) && cols > 0) payload.arena.grid_cols = cols;
      if (!isNaN(rows) && rows > 0) payload.arena.grid_rows = rows;
      if (!isNaN(wcm) && wcm > 0) payload.arena.width_in_cm = wcm;
      if (!isNaN(hcm) && hcm > 0) payload.arena.height_in_cm = hcm;
      fetch('/api/preproc/arena', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
        .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d, status:r.statusText}; }); })
        .then(function(res){ if (ctx.status) ctx.status.textContent = res.ok ? 'Saved' : ('Error: ' + (res.d && res.d.error || res.status)); })
        .catch(function(e){ if (ctx.status) ctx.status.textContent = 'Error: ' + e; });
    } catch(e){}
  }

  function notifyChanged(){
    try{
      var tl = State.tl, br = State.br;
      var ok = !!(tl && br && br.x - tl.x >= MIN_W && br.y - tl.y >= MIN_H);
      document.dispatchEvent(new CustomEvent('preproc:arena-changed', { detail:{ valid: ok } }));
    } catch(e){}
  }

  function init(ctx){
    try{
      ctx.overlay.addEventListener('click', ev => handleClick(ctx, ev));
      ctx.overlay.addEventListener('mousemove', ev => handleMove(ctx, ev));
      if (ctx.markBtn) ctx.markBtn.addEventListener('click', () => toggleMark(ctx));
      window.addEventListener('resize', () => drawOverlay(ctx));
      ctx.video.addEventListener('loadedmetadata', () => drawOverlay(ctx));
      // Handles
      ctx.hTL = document.getElementById('pp-handle-tl');
      ctx.hBR = document.getElementById('pp-handle-br');
      attachHandleDrag(ctx, ctx.hTL, 'tl');
      attachHandleDrag(ctx, ctx.hBR, 'br');

      // Redraw grid when grid inputs change
      try{
        var colsEl = document.getElementById('grid-cols');
        var rowsEl = document.getElementById('grid-rows');
        if (colsEl) colsEl.addEventListener('change', function(){ drawOverlay(ctx); });
        if (rowsEl) rowsEl.addEventListener('change', function(){ drawOverlay(ctx); });
      } catch(e){}

      // Keyboard nudging
      window.addEventListener('keydown', function(ev){
        try{
          var tag = (ev.target && ev.target.tagName || '').toLowerCase();
          if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
          // Escape cancels marking mode
          if (ev.key === 'Escape'){
            if (State.marking){ toggleMark(ctx); ev.preventDefault(); }
            return;
          }
          // Enter/Space while marking ends marking
          if (State.marking && (ev.key === 'Enter' || ev.key === ' ')){
            setMarking(ctx, false); ev.preventDefault(); return;
          }
          if (!(State.tl && State.br)) return;
          var step = ev.shiftKey ? 10 : 1;
          var h = ctx.activeHandle || 'br';
          var tl = { x: State.tl.x, y: State.tl.y };
          var br = { x: State.br.x, y: State.br.y };
          var handled = false;
          if (h === 'tl'){
            if (ev.key === 'ArrowLeft'){ tl.x = Math.max(0, tl.x - step); tl.x = Math.min(tl.x, br.x-1); handled = true; }
            if (ev.key === 'ArrowRight'){ tl.x = Math.min(br.x-1, tl.x + step); handled = true; }
            if (ev.key === 'ArrowUp'){ tl.y = Math.max(0, tl.y - step); tl.y = Math.min(tl.y, br.y-1); handled = true; }
            if (ev.key === 'ArrowDown'){ tl.y = Math.min(br.y-1, tl.y + step); handled = true; }
            if (handled){
              // enforce minimum
              tl.x = Math.min(tl.x, br.x - MIN_W);
              tl.y = Math.min(tl.y, br.y - MIN_H);
              State.tl = tl; drawOverlay(ctx); scheduleSave(ctx); notifyChanged(); ev.preventDefault();
            }
          } else {
            if (ev.key === 'ArrowLeft'){ br.x = Math.max(tl.x+1, br.x - step); handled = true; }
            if (ev.key === 'ArrowRight'){ br.x = br.x + step; handled = true; }
            if (ev.key === 'ArrowUp'){ br.y = Math.max(tl.y+1, br.y - step); handled = true; }
            if (ev.key === 'ArrowDown'){ br.y = br.y + step; handled = true; }
            if (handled){
              // clamp to video bounds
              var m = overlayMetrics(ctx);
              br.x = Math.min(br.x, (m.vw||1)-1);
              br.y = Math.min(br.y, (m.vh||1)-1);
              // enforce minimum
              br.x = Math.max(br.x, State.tl.x + MIN_W);
              br.y = Math.max(br.y, State.tl.y + MIN_H);
              State.br = br; drawOverlay(ctx); scheduleSave(ctx); notifyChanged(); ev.preventDefault();
            }
          }
        } catch(e){}
      });
      drawOverlay(ctx);
    } catch(e) {}
    return { drawOverlay: () => drawOverlay(ctx) };
  }

  window.Preproc.Arena = { init };
})();
