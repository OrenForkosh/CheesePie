// Colors tab — segmentation + marking + per-frame save (clean)
(function(){
  if (!window.Preproc) window.Preproc = {};

  function init(){
    const tab = document.getElementById('tab-colors');
    const pane = document.getElementById('pane-colors');
    const v = document.getElementById('pp-video');
    const processed = document.getElementById('pp-processed');
    const overlay = document.getElementById('pp-overlay');
    const zoom = document.getElementById('pp-zoom');
    function ensureZoomSize(){
      try{
        if (!zoom) return false;
        const ZW = Math.max(1, zoom.clientWidth|0), ZH = Math.max(1, zoom.clientHeight|0);
        let changed = false;
        if (zoom.width !== ZW){ zoom.width = ZW; changed = true; }
        if (zoom.height !== ZH){ zoom.height = ZH; changed = true; }
        return changed || true;
      }catch(e){ return false; }
    }
    function drawZoomPlaceholder(){
      try{
        if (!zoom) return;
        ensureZoomSize();
        const ZW = zoom.width|0, ZH = zoom.height|0;
        const ctx = zoom.getContext('2d');
        ctx.save();
        ctx.clearRect(0,0,ZW,ZH);
        // Subtle background
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--border') || '#444';
        ctx.globalAlpha = 0.12; ctx.fillRect(0,0,ZW,ZH); ctx.globalAlpha = 1.0;
        // Placeholder crosshair
        ctx.strokeStyle='rgba(255,255,255,0.25)'; ctx.lineWidth=1; ctx.beginPath();
        ctx.moveTo(ZW/2,0); ctx.lineTo(ZW/2,ZH); ctx.moveTo(0,ZH/2); ctx.lineTo(ZW,ZH/2); ctx.stroke();
        // Text
        ctx.fillStyle='rgba(255,255,255,0.45)'; ctx.font='12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto'; ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillText('Hover to zoom', ZW/2, ZH/2);
        ctx.restore();
      }catch(e){}
    }
    const statusEl = document.getElementById('pp-colors-status');
    const segCountEl = document.getElementById('pp-colors-segcount');
    const indicatorEl = document.getElementById('pp-colors-indicator');
    const runBtn = document.getElementById('pp-colors-run');
    const randBtn = document.getElementById('pp-colors-random');
    const showOnlyBtn = document.getElementById('pp-colors-show-only');
    const saveBtn = document.getElementById('pp-colors-save');
    const clearBtn = document.getElementById('pp-colors-clear');
    const clearAllBtn = document.getElementById('pp-colors-clear-all');
    const listBtn = document.getElementById('pp-colors-list');
    const listEl = document.getElementById('pp-colors-marks');
    const histEl = document.getElementById('pp-colors-hist');
    const mouseChips = document.getElementById('pp-mouse-chips');

    let lastIndex = null; let lastSize = { w:0, h:0 }; let savedFrames = null; let currentMouse = 'R'; const marks = {};
    let cached = { time: null, image: null, labels: null };
    const lastSavedSigByTime = {};
    const setStatus = (m)=>{ if (statusEl) statusEl.textContent = m||''; };
    const setIndicator = (t)=>{ if (indicatorEl) indicatorEl.textContent = t||''; };
    const timeKey = ()=>{ try{ return (v.currentTime||0).toFixed(3);}catch(e){ return '0.000'; } };
    const markColor = (code)=>({R:'#ff4f4f',G:'#33cc66',B:'#4f8cff',Y:'#ffd166',BG:'#ffffff'}[code]||'#ffffff');
    const snapshotDataURL = ()=>{ if(!v||!v.videoWidth) return {frame:null,width:0,height:0}; const bg=document.getElementById('bg-canvas'); const tw=(bg&&bg.width)||v.videoWidth; const th=(bg&&bg.height)||v.videoHeight; const c=document.createElement('canvas'); c.width=tw; c.height=th; const ctx=c.getContext('2d'); try{ ctx.drawImage(v,0,0,tw,th);}catch(e){} return { frame:c.toDataURL('image/png'), width:tw, height:th}; };
    const fitRect = (sw,sh,dw,dh)=>{ if(!sw||!sh||!dw||!dh) return {dx:0,dy:0,dw:dw,dh:dh}; const s=Math.min(dw/sw, dh/sh); const rw=Math.round(sw*s), rh=Math.round(sh*s); return { dx:Math.floor((dw-rw)/2), dy:Math.floor((dh-rh)/2), dw:rw, dh:rh } };

    function renderMouseSelection(){ if (!mouseChips) return; mouseChips.querySelectorAll('button[data-mouse]')?.forEach(btn=>{ const m=btn.getAttribute('data-mouse'); if(m===currentMouse) btn.classList.add('primary'); else btn.classList.remove('primary'); }); }
    function setMouse(m){ currentMouse=m; renderMouseSelection(); }
    mouseChips?.addEventListener('click',(ev)=>{ const t=ev.target.closest('button[data-mouse]'); if(!t) return; setMouse(t.getAttribute('data-mouse')||'R'); });
    document.addEventListener('keydown',(ev)=>{ if(!pane||pane.style.display==='none') return; const k=ev.key; if(k==='1') setMouse('R'); else if(k==='2') setMouse('G'); else if(k==='3') setMouse('B'); else if(k==='4') setMouse('Y'); else if(k==='0') setMouse('BG'); else if(k===' '){ ev.preventDefault(); if (v && isFinite(v.duration) && v.duration>0){ autoSaveIfNeeded?.(); const t = Math.random()*Math.max(0.1, v.duration-0.2)+0.1; v.currentTime = t; } } });

    // ---- Drag markers dock (top-left) ----
    const host = document.getElementById('pp-vwrap');
    (function buildDock(){
      try{
        const host = document.getElementById('pp-vwrap');
        if (!host) return;
        const dock = document.createElement('div');
        dock.id = 'pp-color-dock';
        dock.style.position = 'absolute';
        dock.style.left = '8px';
        dock.style.top = '8px';
        dock.style.zIndex = '10';
        dock.style.display = 'none';
        dock.style.flexDirection = 'column';
        dock.style.gap = '8px';
        host.appendChild(dock);

        const defs = [
          { id:'R', color:'#ff4f4f' },
          { id:'G', color:'#33cc66' },
          { id:'B', color:'#4f8cff' },
          { id:'Y', color:'#ffd166' },
          { id:'BG', color:'#000000' },
        ];
        const state = {};
        const homeOf = {};
        defs.forEach((d, i) => {
          const el = document.createElement('div');
          el.className = 'pp-marker';
          el.setAttribute('data-mouse', d.id);
          el.title = d.id;
          el.style.width = '18px'; el.style.height = '18px';
          el.style.borderRadius = '50%';
          el.style.background = d.color;
          el.style.border = '2px solid #fff';
          el.style.boxShadow = '0 1px 4px rgba(0,0,0,0.35)';
          el.style.cursor = 'grab';
          el.style.position = 'relative';
          dock.appendChild(el);
          homeOf[d.id] = null; // relative inside dock; restore by re-append

          let dragging = false; let startX=0, startY=0; let origLeft=0, origTop=0; let ghost = null;
          function onDown(ev){
            try{ ev.preventDefault(); }catch(e){}
            dragging = true; el.style.cursor = 'grabbing';
            const hostRect = host.getBoundingClientRect();
            const px = (ev.touches? ev.touches[0].clientX : ev.clientX);
            const py = (ev.touches? ev.touches[0].clientY : ev.clientY);
            startX = px; startY = py;
            // Create ghost absolutely positioned within host
            ghost = document.createElement('div');
            ghost.style.position = 'absolute';
            ghost.style.left = (hostRect.left)+'px';
            ghost.style.top = (hostRect.top)+'px';
            ghost.style.width = (hostRect.width)+'px';
            ghost.style.height = (hostRect.height)+'px';
            ghost.style.zIndex='11';
            ghost.style.pointerEvents='none';
            document.body.appendChild(ghost);
            // Clone visual for dragging within host
            const drag = el.cloneNode(true); drag.style.position='absolute';
            // initial position at dock icon location
            const elRect = el.getBoundingClientRect();
            // position relative to ghost/host
            drag.style.left = (elRect.left - hostRect.left) + 'px';
            drag.style.top  = (elRect.top  - hostRect.top)  + 'px';
            drag.style.transform = 'translate(0,0)';
            drag.classList.add('dragging');
            ghost.appendChild(drag);
            state[d.id] = { dragEl: drag };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
            window.addEventListener('touchmove', onMove, {passive:false});
            window.addEventListener('touchend', onUp);
          }
          function onMove(ev){ if (!dragging) return; try{ ev.preventDefault(); }catch(e){}
            const px = (ev.touches? ev.touches[0].clientX : ev.clientX);
            const py = (ev.touches? ev.touches[0].clientY : ev.clientY);
            const dx = px - startX; const dy = py - startY;
            const drag = state[d.id] && state[d.id].dragEl; if (!drag) return;
            drag.style.transform = `translate(${dx}px, ${dy}px)`;
          }
          function onUp(ev){ if (!dragging) return; dragging=false; el.style.cursor='grab';
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            window.removeEventListener('touchmove', onMove);
            window.removeEventListener('touchend', onUp);
            // Determine drop position relative to overlay
            try{
              const px = (ev.changedTouches? ev.changedTouches[0].clientX : ev.clientX);
              const py = (ev.changedTouches? ev.changedTouches[0].clientY : ev.clientY);
              const oRect = overlay.getBoundingClientRect();
              const mx = px - oRect.left, my = py - oRect.top;
              // Map to label coords
              const vw = overlay.clientWidth, vh = overlay.clientHeight;
              const W = lastSize.w, H = lastSize.h;
              const r = fitRect(W, H, vw, vh);
              // If outside video letterbox, revert
              if (mx < r.dx || my < r.dy || mx > r.dx + r.dw || my > r.dy + r.dh){ cleanup(false); return; }
              const lx = Math.round((mx - r.dx) * (W / r.dw));
              const ly = Math.round((my - r.dy) * (H / r.dh));
              const labelAt=(x,y)=>{ if(y<0||y>=H||x<0||x>=W) return 0; const row=lastIndex? (lastIndex[y]||[]) : []; return row[x]|0; };
              let lab = labelAt(lx, ly);
              if (lab === 0){ // small neighborhood search
                const rad = 2; outer: for(let dy=-rad;dy<=rad;dy++){ for(let dx=-rad;dx<=rad;dx++){ const l2=labelAt(lx+dx,ly+dy); if(l2>0){ lab=l2; break outer; } } }
              }
              if (lab === 0){ cleanup(false); setStatus('Drop onto a segment'); return; }
              // Use drop location as the anchor point (so the marker stays where dropped)
              const cx = lx, cy = ly;
              const t = timeKey(); if (!marks[t]) marks[t]=[]; marks[t] = marks[t].filter(m=> m.segment_label !== lab);
              marks[t].push({ mouse: d.id, segment_label: lab, centroid: { x: cx, y: cy } });
              drawMarks(); updateIndicator();
              cleanup(true);
            } catch(e){ cleanup(false); }
          }
          function cleanup(ok){ try{ const drag=state[d.id] && state[d.id].dragEl; if (drag && drag.parentNode) drag.parentNode.remove(); }catch(e){} state[d.id]=null; if (!ok){ /* revert: nothing to do since we used ghost */ } }
          el.addEventListener('mousedown', onDown); el.addEventListener('touchstart', onDown, {passive:false});
        });
      }catch(e){}
    })();

    // Toggle dock visibility with tab changes and auto-save when leaving Colors
    let __wasOnColors = false;
    let __suppressClickUntil = 0;
    document.addEventListener('preproc:tab-changed', function(ev){
      try{
        const name = ev && ev.detail && ev.detail.name;
        const dock = document.getElementById('pp-color-dock');
        const onColors = (name === 'colors');
        if (__wasOnColors && !onColors){ try{ autoSaveIfNeeded(); }catch(e){} }
        __wasOnColors = onColors;
        if (dock) dock.style.display = onColors ? 'flex' : 'none';
        // Hide processed segmentation overlay when leaving Colors
        if (!onColors && processed){ processed.style.display = 'none'; }
        // Ensure interactive overlay receives input when on Colors
        try{
          if (onColors){ if(processed) processed.style.pointerEvents='none'; if(overlay) overlay.style.pointerEvents='auto'; }
        }catch(e){}
      } catch(e){}
    });

    // ---- Drag existing placed marks on overlay ----
    function screenPosForMark(m){
      try{
        const vw = overlay.clientWidth, vh = overlay.clientHeight;
        const W = lastSize.w, H = lastSize.h; if (!W||!H||!vw||!vh) return null;
        const r = fitRect(W, H, vw, vh);
        const cx = r.dx + (m.centroid.x * (r.dw / W));
        const cy = r.dy + (m.centroid.y * (r.dh / H));
        return { x: cx, y: cy };
      } catch(e){ return null; }
    }

    function findPlacedMarkAt(px, py){
      try{
        const t = _nearestMarksKey(timeKey()); const list = marks[t] || [];
        let best = null, bestD2 = Infinity; const R = 16;
        for (let i=0;i<list.length;i++){
          const sp = screenPosForMark(list[i]); if (!sp) continue;
          const dx = px - sp.x, dy = py - sp.y; const d2 = dx*dx + dy*dy;
          if (d2 < R*R && d2 < bestD2){ best = { idx:i, mark: list[i] }; bestD2 = d2; }
        }
        return best;
      } catch(e){ return null; }
    }

    (function enablePlacedDrag(){
      if (!overlay) return;
      let dragging = null; // { idx, mark, ghost, startX, startY, hostRect, dot, initialLeft, initialTop }
      function onDown(ev){
        try{
          const oRect = overlay.getBoundingClientRect();
          const px = (ev.touches? ev.touches[0].clientX : ev.clientX) - oRect.left;
          const py = (ev.touches? ev.touches[0].clientY : ev.clientY) - oRect.top;
          const hit = findPlacedMarkAt(px, py);
          if (!hit) return; // let other handlers (like click-to-assign) run
          ev.preventDefault(); ev.stopPropagation(); overlay.style.cursor='grabbing';
          const hostRect = host.getBoundingClientRect();
          // Ghost container
          const ghost = document.createElement('div');
          ghost.style.position = 'absolute'; ghost.style.left = hostRect.left+'px'; ghost.style.top = hostRect.top+'px'; ghost.style.width = hostRect.width+'px'; ghost.style.height = hostRect.height+'px'; ghost.style.zIndex='12'; ghost.style.pointerEvents='none';
          document.body.appendChild(ghost);
          // Visual
          const dot = document.createElement('div'); dot.style.position='absolute'; dot.style.width='18px'; dot.style.height='18px'; dot.style.borderRadius='50%'; dot.style.border='2px solid #fff'; dot.style.boxShadow='0 1px 4px rgba(0,0,0,0.35)'; dot.style.background = markColor(hit.mark.mouse);
          const sp = screenPosForMark(hit.mark);
          const initialLeft = sp ? sp.x : px;
          const initialTop = sp ? sp.y : py;
          dot.style.left = initialLeft + 'px';
          dot.style.top = initialTop + 'px';
          dot.style.transform='translate(-50%,-50%)';
          ghost.appendChild(dot);
          dragging = { idx: hit.idx, mark: hit.mark, ghost, startX: (ev.touches? ev.touches[0].clientX : ev.clientX), startY: (ev.touches? ev.touches[0].clientY : ev.clientY), hostRect, dot, initialLeft, initialTop };
          window.addEventListener('mousemove', onMove, { passive:false });
          window.addEventListener('mouseup', onUp);
          window.addEventListener('touchmove', onMove, { passive:false });
          window.addEventListener('touchend', onUp);
        } catch(e){}
      }
      function onMove(ev){ if (!dragging) return; try{ ev.preventDefault(); }catch(e){}
        const px = (ev.touches? ev.touches[0].clientX : ev.clientX);
        const py = (ev.touches? ev.touches[0].clientY : ev.clientY);
        const dx = px - dragging.startX;
        const dy = py - dragging.startY;
        dragging.dot.style.left = (dragging.initialLeft + dx) + 'px';
        dragging.dot.style.top = (dragging.initialTop + dy) + 'px';
      }
      function onUp(ev){ if (!dragging) return; const ctx = dragging; dragging = null; overlay.style.cursor='default';
        window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
        window.removeEventListener('touchmove', onMove); window.removeEventListener('touchend', onUp);
        try{ if (ctx.ghost && ctx.ghost.parentNode) ctx.ghost.parentNode.removeChild(ctx.ghost); }catch(e){}
        try{
          // Determine drop location and reassign
          const px = (ev.changedTouches? ev.changedTouches[0].clientX : ev.clientX);
          const py = (ev.changedTouches? ev.changedTouches[0].clientY : ev.clientY);
          const oRect = overlay.getBoundingClientRect();
          const mx = px - oRect.left, my = py - oRect.top;
          const vw = overlay.clientWidth, vh = overlay.clientHeight; const W = lastSize.w, H = lastSize.h; const r = fitRect(W,H,vw,vh);
          const t=_nearestMarksKey(timeKey()); const list=marks[t]||[];
          if (mx < r.dx || my < r.dy || mx > r.dx + r.dw || my > r.dy + r.dh){
            // Remove the mark if dropped outside the video area
            if (list.length){ list.splice(ctx.idx, 1); marks[t] = list; }
            drawMarks(); updateIndicator(); renderHistogram(); setStatus('Removed mark');
            return;
          }
          const lx = Math.round((mx - r.dx) * (W / r.dw)); const ly = Math.round((my - r.dy) * (H / r.dh));
          const labelAt=(x,y)=>{ if(y<0||y>=H||x<0||x>=W) return 0; const row=lastIndex? (lastIndex[y]||[]) : []; return row[x]|0; };
          let lab = labelAt(lx, ly); if (lab===0){ const rad=2; outer: for(let dy=-rad;dy<=rad;dy++){ for(let dx=-rad;dx<=rad;dx++){ const l2=labelAt(lx+dx,ly+dy); if(l2>0){ lab=l2; break outer; } } } }
          if (lab === 0){
            // Remove the mark if dropped onto background
            if (list.length){ list.splice(ctx.idx, 1); marks[t] = list; }
            drawMarks(); updateIndicator(); setStatus('Removed mark');
            return;
          }
          // Use drop location as anchor point
          const cx = lx, cy = ly;
          if (!list.length) return;
          // Replace the dragged mark entry (keep mouse id but new label/centroid)
          list[ctx.idx] = { mouse: ctx.mark.mouse, segment_label: lab, centroid: { x: cx, y: cy } };
          marks[t] = list; drawMarks(); updateIndicator(); renderHistogram();
          // Suppress the subsequent click event from re-assigning via currentMouse
          __suppressClickUntil = Date.now() + 300;
        }catch(e){}
      }
      overlay.addEventListener('mousedown', onDown);
      overlay.addEventListener('touchstart', onDown, { passive:false });

      // Cursor hint: show grab cursor when hovering a placed mark
      overlay.addEventListener('mousemove', function(ev){
        try{
          const rect = overlay.getBoundingClientRect();
          const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
          const hit = findPlacedMarkAt(px, py);
          overlay.style.cursor = hit ? 'grab' : 'default';
          // Update zoom preview
          try{
            if (!zoom) return;
            const vw = overlay.clientWidth, vh = overlay.clientHeight;
            if (!vw || !vh) return;
            const Vw = (v && v.videoWidth)|0, Vh = (v && v.videoHeight)|0;
            if (!Vw || !Vh) return;
            const r = fitRect(Vw, Vh, vw, vh);
            const inside = (px >= r.dx && py >= r.dy && px <= r.dx + r.dw && py <= r.dy + r.dh);
            if (!inside){ drawZoomPlaceholder(); return; }
            // Prepare zoom canvas backing size to match CSS
            ensureZoomSize();
            const ZW = zoom.width|0, ZH = zoom.height|0;
            const ctx = zoom.getContext('2d');
            ctx.imageSmoothingEnabled = false;
            // Map mouse to video pixels
            const mx = px, my = py;
            const sx = (mx - r.dx) * (Vw / r.dw);
            const sy = (my - r.dy) * (Vh / r.dh);
            const scale = 3.0; // zoom factor
            const srcW = Math.max(1, Math.round(ZW / scale));
            const srcH = Math.max(1, Math.round(ZH / scale));
            const srcX = Math.max(0, Math.min(Math.round(sx - srcW/2), Vw - srcW));
            const srcY = Math.max(0, Math.min(Math.round(sy - srcH/2), Vh - srcH));
            // Draw base video
            ctx.clearRect(0,0,ZW,ZH);
            ctx.drawImage(v, srcX, srcY, srcW, srcH, 0, 0, ZW, ZH);
            // Draw processed overlay portion if available
            try{
              if (processed && processed.width>0 && processed.height>0){
                const srcWo = Math.round(ZW / scale), srcHo = Math.round(ZH / scale);
                const srcXo = Math.round(mx - srcWo/2);
                const srcYo = Math.round(my - srcHo/2);
                ctx.drawImage(processed, srcXo, srcYo, srcWo, srcHo, 0, 0, ZW, ZH);
              }
            }catch(e){}
            // Optional: draw a subtle crosshair
            try{ ctx.strokeStyle='rgba(255,255,255,0.5)'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(ZW/2,0); ctx.lineTo(ZW/2,ZH); ctx.moveTo(0,ZH/2); ctx.lineTo(ZW,ZH/2); ctx.stroke(); }catch(e){}
            // keep visible at all times
          }catch(e){}
        }catch(e){}
      });
      overlay.addEventListener('mouseenter', function(){ try{ if(zoom) drawZoomPlaceholder(); }catch(e){} });
      overlay.addEventListener('mouseleave', function(){ try{ if(zoom) drawZoomPlaceholder(); }catch(e){} });
      // Initialize placeholder
      try{ drawZoomPlaceholder(); }catch(e){}
    })();

    async function ensureSavedFrames(){ try{ if(savedFrames!==null) return; const vp=(window.Preproc&&window.Preproc.State&&window.Preproc.State.videoPath)||''; if(!vp){ savedFrames={}; return;} const r=await fetch('/api/preproc/state?video='+encodeURIComponent(vp)); const d=await r.json(); const colors=d&&d.colors||null; savedFrames=(colors&&colors.frames)||{}; }catch(e){ savedFrames={}; } finally { try{ renderHistogram(); }catch(e){} } }
    function nearestKey(tk){ try{ if(!savedFrames) return tk; if(savedFrames[tk]) return tk; const keys=Object.keys(savedFrames||{}); if(!keys.length) return tk; const t=parseFloat(tk); let best=tk,d=Infinity; keys.forEach(k=>{ const v=Math.abs(parseFloat(k)-t); if(v<d){ d=v; best=k; } }); return d<=0.05?best:tk; }catch(e){ return tk; } }
    function updateIndicator(){ try{ const t=_nearestMarksKey(timeKey()); const list=marks[t]||[]; const c={R:0,G:0,B:0,Y:0,BG:0}; list.forEach(m=>{ if(c[m.mouse]!==undefined) c[m.mouse]++; }); setIndicator(`R:${c.R} G:${c.G} B:${c.B} Y:${c.Y} BG:${c.BG}`);}catch(e){ setIndicator(''); } }
    function computeHistogramCounts(){
      try{
        const codes=['R','G','B','Y','BG'];
        const counts = {R:0,G:0,B:0,Y:0,BG:0};
        // Sum saved frames
        const frames = savedFrames||{};
        Object.keys(frames).forEach(function(k){ const fr=frames[k]; const ms=(fr&&fr.marks)||[]; for(let i=0;i<ms.length;i++){ const m=ms[i]; const c=m&&m.mouse; if(counts[c]!=null) counts[c]++; } });
        // Adjust for current frame unsaved edits: replace saved count with current marks for this time
        const tk=timeKey(); const current=(marks[tk]||[]); const saved=(frames[tk]&&frames[tk].marks)||[];
        // subtract saved for tk
        for(let i=0;i<saved.length;i++){ const c=saved[i]&&saved[i].mouse; if(counts[c]!=null) counts[c]--; }
        // add current for tk
        for(let i=0;i<current.length;i++){ const c=current[i]&&current[i].mouse; if(counts[c]!=null) counts[c]++; }
        return counts;
      }catch(e){ return {R:0,G:0,B:0,Y:0,BG:0}; }
    }
    function renderHistogram(){ try{
      if(!histEl) return; const counts=computeHistogramCounts(); const order=['R','G','B','Y','BG']; const max=Math.max(1,...order.map(k=>counts[k]||0));
      let html='';
      for(let i=0;i<order.length;i++){
        const k=order[i]; const n=counts[k]||0; const pct = Math.round((n/max)*100);
        const color = (k==='BG') ? '#999' : markColor(k);
        html += `<div style="display:flex; align-items:center; gap:8px; margin:2px 0">
          <div style="width:18px; height:18px; border-radius:50%; background:${color}; border:2px solid #fff; box-shadow:0 1px 2px rgba(0,0,0,.2)"></div>
          <div style="width:100px; font-weight:600">${k}</div>
          <div style="flex:1; height:8px; background:var(--border); border-radius:4px; overflow:hidden">
            <div style="width:${pct}%; height:100%; background:${color}; opacity:0.8"></div>
          </div>
          <div style="width:36px; text-align:right; font-variant-numeric: tabular-nums">${n}</div>
        </div>`;
      }
      histEl.innerHTML = html;
      try{ document.dispatchEvent(new CustomEvent('preproc:colors-counts', { detail: { counts: counts } })); }catch(e){}
    }catch(e){} }
    function _nearestMarksKey(tk){
      try{
        const keys = Object.keys(marks||{}); if (!keys.length) return tk;
        if (marks[tk]) return tk;
        const t = parseFloat(tk);
        let best = tk, dmin = Infinity;
        for (let i=0;i<keys.length;i++){
          const k = keys[i]; const v = Math.abs(parseFloat(k) - t);
          if (v < dmin){ dmin = v; best = k; }
        }
        return (dmin <= 0.05) ? best : tk; // 50ms tolerance
      }catch(e){ return tk; }
    }
    function drawMarks(){ if(!overlay) return; const vw=overlay.clientWidth||overlay.width||0; const vh=overlay.clientHeight||overlay.height||0; if(!vw||!vh) return; overlay.width=vw; overlay.height=vh; const ctx=overlay.getContext('2d'); ctx.clearRect(0,0,vw,vh); const W=lastSize.w,H=lastSize.h; if(!W||!H) return; const r=fitRect(W,H,vw,vh); const key=_nearestMarksKey(timeKey()); const list=marks[key]||[]; list.forEach(m=>{ const cx=r.dx+(m.centroid.x*(r.dw/W)); const cy=r.dy+(m.centroid.y*(r.dh/H)); ctx.beginPath(); ctx.arc(cx,cy,6,0,Math.PI*2); ctx.fillStyle='rgba(0,0,0,0.6)'; ctx.fill(); ctx.beginPath(); ctx.arc(cx,cy,4,0,Math.PI*2); ctx.fillStyle=markColor(m.mouse||'BG'); ctx.fill(); ctx.fillStyle='#000'; ctx.font='10px ui-monospace, Menlo, monospace'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(m.mouse||'', cx, cy-12); }); }
    function syncFromSaved(){ try{ if(!savedFrames) return; const tk=timeKey(); const key=nearestKey(tk); const fr=savedFrames[key]; if(!fr) return; if(Array.isArray(fr.marks)) marks[tk]=fr.marks.map(m=>({mouse:m.mouse, segment_label:m.segment_label, centroid:m.centroid})); if(Array.isArray(fr.labels)&&fr.labels.length){ lastIndex=fr.labels; lastSize={h:fr.labels.length|0,w:(fr.labels[0]||[]).length|0}; } }catch(e){} }

    function setSegCountFromIndex(index){
      try{
        if (!segCountEl){ return; }
        if (!index || !Array.isArray(index) || !index.length){ segCountEl.textContent = 'Found: 0'; return; }
        let maxW = 0; try{ maxW = (index[0]||[]).length|0; }catch(e){}
        let seen = new Set();
        for (let y=0; y<index.length; y++){
          const row = index[y]||[];
          for (let x=0; x<row.length; x++){
            const v = row[x]|0; if (v>0) seen.add(v);
          }
          // small optimization: bail if set grows large; keep scanning anyway typically fast
        }
        segCountEl.textContent = 'Found: ' + String(seen.size|0);
      }catch(e){ try{ if(segCountEl) segCountEl.textContent='Found: —'; }catch(_){} }
    }

    async function run(){
      const snap=snapshotDataURL(); const dataUrl=snap.frame; if(!dataUrl){ setStatus('Video not ready'); return; }
      setStatus('Segmenting…');
      try{
        await ensureSavedFrames();
        let background=null; try{ const bg=document.getElementById('bg-canvas'); if(bg&&bg.width&&bg.height) background=bg.toDataURL('image/png'); }catch(e){}
        const resp=await fetch('/api/preproc/segment_simple',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ image:dataUrl, background })});
        const data=await resp.json(); if(!resp.ok||!data||!data.ok){ setStatus('Error: '+(data&&data.error||resp.statusText)); return; }
        if(data.stats&&typeof data.stats.nonzero==='number'){
          // keep status reserved but do not persist a message here; seg count is shown separately
          if(data.stats.nonzero===0) setStatus('No segments detected (try a different frame or compute background)');
        }
        if(Array.isArray(data.index)&&data.index.length){ lastIndex=data.index; lastSize={h:data.index.length|0,w:(data.index[0]||[]).length|0}; setSegCountFromIndex(lastIndex); }
        cached = { time: timeKey(), image: dataUrl, labels: lastIndex };
        // Draw either the server-provided overlay image (base) or the color map
        const overlayImg=data.overlay_b64; if(!overlayImg){ setStatus('No overlay returned'); return; }
        const vw=v&&v.clientWidth?v.clientWidth:(processed&&processed.clientWidth)||0; const vh=v&&v.clientHeight?v.clientHeight:(processed&&processed.clientHeight)||0; if(!vw||!vh){ setStatus('Video panel not ready'); return; }
        if (segmentsOn){ await showSegmentsOnly(); }
        else {
          const img=new Image(); await new Promise(res=>{ img.onload=()=>res(); img.onerror=()=>res(); img.src=overlayImg;});
          processed.width=vw; processed.height=vh;
          const pctx=processed.getContext('2d'); pctx.imageSmoothingEnabled=false; pctx.clearRect(0,0,vw,vh); const r=fitRect(img.naturalWidth||img.width, img.naturalHeight||img.height, vw, vh); pctx.drawImage(img,r.dx,r.dy,r.dw,r.dh);
          processed.style.display='';
          try{ processed.style.pointerEvents = 'none'; }catch(e){}
        }
        syncFromSaved(); drawMarks(); updateIndicator(); renderHistogram(); setStatus('');
      }catch(e){ setStatus('Error: '+e); }
    }

    async function autoSaveIfNeeded(){
      try{
        const t=cached.time, image=cached.image, labels=cached.labels;
        if (!t || !image || !labels) return;
        const list=marks[t]||[]; if (!list.length) return;
        const norm=list.map(m=>({ mouse:m.mouse, segment_label:m.segment_label, centroid:m.centroid }));
        const sig=JSON.stringify(norm);
        if (lastSavedSigByTime[t] === sig) return; // no change since last save for this frame
        const frameObj={ image_b64:image, labels:labels, marks:norm };
        const body={ video: (window.Preproc&&window.Preproc.State&&window.Preproc.State.videoPath)||'', colors:{ frames:{ [t]: frameObj } } };
        const resp = await fetch('/api/preproc/colors',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
        if (resp && resp.ok){ lastSavedSigByTime[t] = sig; try{ await ensureSavedFrames(); savedFrames[t]=frameObj; renderHistogram(); }catch(e){} }
      }catch(e){}
    }

    function colorForLabel(l){ if(!l||l<=0) return [0,0,0,0]; const hue=(l*137.508)%360; const s=0.7,vv=0.95; const c=vv*s,x=c*(1-Math.abs(((hue/60)%2)-1)),m=vv-c; let r=0,g=0,b=0; if(0<=hue&&hue<60){r=c;g=x;b=0;} else if(60<=hue&&hue<120){r=x;g=c;b=0;} else if(120<=hue&&hue<180){r=0;g=c;b=x;} else if(180<=hue&&hue<240){r=0;g=x;b=c;} else if(240<=hue&&hue<300){r=x;g=0;b=c;} else {r=c;g=0;b=x;} return [Math.round((r+m)*255),Math.round((g+m)*255),Math.round((b+m)*255),255]; }
    async function showSegmentsOnly(){ try{ if(!lastIndex){ await run(); } if(!lastIndex){ setStatus('No labels available'); return;} const W=lastSize.w,H=lastSize.h; if(!W||!H){ setStatus('No labels available'); return;} const vw=v&&v.clientWidth?v.clientWidth:(processed&&processed.clientWidth)||0; const vh=v&&v.clientHeight?v.clientHeight:(processed&&processed.clientHeight)||0; if(!vw||!vh){ setStatus('Video panel not ready'); return;} const off=document.createElement('canvas'); off.width=W; off.height=H; const octx=off.getContext('2d'); const img=octx.createImageData(W,H); const d=img.data; for(let y=0,p=0;y<H;y++){ const row=lastIndex[y]||[]; for(let x=0;x<W;x++,p+=4){ const l=row[x]|0; const c=colorForLabel(l); d[p]=c[0]; d[p+1]=c[1]; d[p+2]=c[2]; d[p+3]=c[3]; } } octx.putImageData(img,0,0); processed.width=vw; processed.height=vh; processed.style.display=''; try{ processed.style.pointerEvents='none'; }catch(e){} const pctx=processed.getContext('2d'); pctx.imageSmoothingEnabled=false; pctx.clearRect(0,0,vw,vh); const r=fitRect(W,H,vw,vh); pctx.drawImage(off,r.dx,r.dy,r.dw,r.dh); setStatus(''); }catch(e){ setStatus('Error: '+e); } }

    function drawSegmentOutlines(){
      try{
        if(!lastIndex){ return; }
        const W=lastSize.w,H=lastSize.h; if(!W||!H) return;
        const vw=v&&v.clientWidth?v.clientWidth:(processed&&processed.clientWidth)||0; const vh=v&&v.clientHeight?v.clientHeight:(processed&&processed.clientHeight)||0; if(!vw||!vh) return;
        const off=document.createElement('canvas'); off.width=W; off.height=H; const octx=off.getContext('2d');
        const img=octx.createImageData(W,H); const d=img.data;
        function setPx(x,y){ const p=((y*W+x)|0)*4; d[p]=255; d[p+1]=255; d[p+2]=255; d[p+3]=255; }
        for(let y=0;y<H;y++){
          const row=lastIndex[y]||[]; const rowD = (y+1<H)? (lastIndex[y+1]||[]) : null;
          for(let x=0;x<W;x++){
            const l = row[x]|0; const r = (x+1<W)? (row[x+1]|0) : l; const dwn = rowD? (rowD[x]|0) : l;
            if (l !== r || l !== dwn){ setPx(x,y); }
          }
        }
        octx.putImageData(img,0,0);
        processed.width=vw; processed.height=vh; processed.style.display='';
        const pctx=processed.getContext('2d'); pctx.imageSmoothingEnabled=false; pctx.clearRect(0,0,vw,vh); const r=fitRect(W,H,vw,vh); pctx.drawImage(off,r.dx,r.dy,r.dw,r.dh);
      }catch(e){}
    }

    // Toggle state for segments overlay
    let segmentsOn = false;
    function setSegmentsMode(on){
      try{
        segmentsOn = !!on;
        if (showOnlyBtn){ showOnlyBtn.classList.toggle('primary', segmentsOn); }
        // Re-render current frame according to toggle; run() draws base overlay
        if (segmentsOn){ showSegmentsOnly(); }
        else { run(); }
      }catch(e){}
    }

    runBtn?.addEventListener('click', run);
    // Jump to a random frame when clicking Random
    randBtn?.addEventListener('click', ()=>{
      try{
        if (!v || !isFinite(v.duration) || v.duration <= 0){ setStatus('Video not ready'); return; }
        autoSaveIfNeeded?.();
        const t = Math.random() * Math.max(0.1, (v.duration||0) - 0.2) + 0.1;
        v.currentTime = t;
      }catch(e){ setStatus('Error: '+e); }
    });
    showOnlyBtn?.addEventListener('click', ()=>{ setSegmentsMode(!segmentsOn); });
    renderMouseSelection();
    // Wire export labels button
    (function wireExportLabels(){
      try{
        const btn = document.getElementById('pp-colors-export-labels');
        if (!btn) return;
        btn.addEventListener('click', async function(){
          try{
            if (!lastIndex || !lastIndex.length){ setStatus('No segments to export'); return; }
            const H = lastIndex.length|0; const W = (lastIndex[0]||[]).length|0; if(!H||!W){ setStatus('No segments to export'); return; }
            // Ask backend to encode as 16-bit PNG
            const resp = await fetch('/api/preproc/labels_png', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ labels: lastIndex }) });
            const d = await resp.json();
            if (!resp.ok || !d || !d.ok || !d.image_b64){ setStatus('Export failed: ' + (d&&d.error||resp.statusText)); return; }
            let base=(window.Preproc&&window.Preproc.State&&window.Preproc.State.videoPath)||'labels';
            try{ base=(base.split('/').pop()||base).replace(/\.[^.]+$/, ''); }catch(e){}
            // Timestamp like frame export (H-MM-SS.mmm; hours omitted if 0)
            const sec = (v && isFinite(v.currentTime)) ? Number(v.currentTime||0) : 0;
            const totalMs = Math.max(0, Math.round(sec*1000));
            const s = (totalMs/1000)|0; const ms = totalMs % 1000;
            const h = (s/3600)|0; const m = ((s%3600)/60)|0; const ss = (s%60)|0;
            const pad2=(n)=>String(n).padStart(2,'0'), pad3=(n)=>String(n).padStart(3,'0');
            const at = (h? String(h)+'-':'') + pad2(m) + '-' + pad2(ss) + '.' + pad3(ms);
            const a=document.createElement('a'); a.download = base + '.labels.' + at + '.png'; a.href=d.image_b64; document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setStatus('Labels exported');
          }catch(e){ setStatus('Export failed: '+e); }
        });
      }catch(e){}
    })();

    tab?.addEventListener('click', async ()=>{ if(pane) pane.style.display=''; await ensureSavedFrames(); syncFromSaved(); drawMarks(); updateIndicator(); renderHistogram(); run(); });
    v?.addEventListener('seeking', ()=>{ if(pane&&pane.style.display!=='none'){ autoSaveIfNeeded(); } });
    v?.addEventListener('play', ()=>{ if(pane&&pane.style.display!=='none'){ autoSaveIfNeeded(); } });
    v?.addEventListener('seeked', ()=>{ if(pane&&pane.style.display!=='none'){ syncFromSaved(); drawMarks(); updateIndicator(); renderHistogram(); run(); } });

    overlay?.addEventListener('click', (ev)=>{ try{ if(Date.now() < __suppressClickUntil){ ev.preventDefault(); ev.stopPropagation(); return; } if(!lastIndex){ setStatus('Run segmentation first'); return;} const rect=overlay.getBoundingClientRect(); const mx=ev.clientX-rect.left, my=ev.clientY-rect.top; const vw=overlay.clientWidth, vh=overlay.clientHeight; const W=lastSize.w,H=lastSize.h; const r=fitRect(W,H,vw,vh); if(mx<r.dx||my<r.dy||mx>r.dx+r.dw||my>r.dy+r.dh){ setStatus('Click inside the video area'); return;} const lx=Math.round((mx-r.dx)*(W/r.dw)); const ly=Math.round((my-r.dy)*(H/r.dh)); const labelAt=(x,y)=>{ if(y<0||y>=H||x<0||x>=W) return 0; const row=lastIndex[y]||[]; return row[x]|0; }; let lab=labelAt(lx,ly); if(lab===0){ const rad=2; outer: for(let dy=-rad;dy<=rad;dy++){ for(let dx=-rad;dx<=rad;dx++){ const l2=labelAt(lx+dx,ly+dy); if(l2>0){ lab=l2; break outer; } } } } if(lab===0 && currentMouse!=='BG'){ setStatus('No segment here'); return;} let sumx=0,sumy=0,cnt=0; for(let y=0;y<H;y++){ const row=lastIndex[y]||[]; for(let x=0;x<W;x++){ if((row[x]|0)===lab){ sumx+=x; sumy+=y; cnt++; } } } const cx=cnt?(sumx/cnt):lx; const cy=cnt?(sumy/cnt):ly; const t=timeKey(); if(!marks[t]) marks[t]=[]; marks[t]=marks[t].filter(m=>m.segment_label!==lab); marks[t].push({ mouse:currentMouse, segment_label:lab, centroid:{x:cx,y:cy} }); drawMarks(); updateIndicator(); renderHistogram(); }catch(e){ setStatus('Error: '+e); } });

    // Manual save removed in favor of auto-save
    clearBtn?.addEventListener('click', ()=>{ const t=timeKey(); marks[t]=[]; drawMarks(); setIndicator(''); renderHistogram(); if(listEl) listEl.style.display='none'; setStatus('Cleared'); });
    clearAllBtn?.addEventListener('click', async ()=>{
      try{
        await ensureSavedFrames();
        // Build payload to clear marks for all known frames
        const frames = savedFrames || {};
        const out = {};
        Object.keys(frames).forEach((k)=>{ out[k] = { marks: [] }; });
        // Also clear current in-memory marks
        for (const k in marks){ if (Object.prototype.hasOwnProperty.call(marks,k)) delete marks[k]; }
        const body = { video: (window.Preproc&&window.Preproc.State&&window.Preproc.State.videoPath)||'', colors:{ frames: out } };
        const resp = await fetch('/api/preproc/colors',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
        const ok = resp && resp.ok;
        // Update local cache regardless to reflect UI immediately
        Object.keys(frames).forEach((k)=>{ if (!frames[k]) frames[k]={}; frames[k].marks = []; });
        drawMarks(); renderHistogram(); setStatus(ok ? 'Cleared all' : 'Cleared all (local)');
      }catch(e){ setStatus('Error: '+e); }
    });
    listBtn?.addEventListener('click', ()=>{ if(!listEl) return; const t=timeKey(); const list=marks[t]||[]; if(!list.length){ listEl.textContent='No marks for this frame.'; listEl.style.display=''; return;} listEl.innerHTML=list.map(m=>`<div>${m.mouse} • label ${m.segment_label} • (${Math.round(m.centroid.x)}, ${Math.round(m.centroid.y)})</div>`).join(''); listEl.style.display = listEl.style.display==='none' ? '' : 'none'; });

    return { run };
  }
  window.Preproc.Colors = { init };
})();
