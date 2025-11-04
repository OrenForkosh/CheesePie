// Regions tab: define grid-based ROIs and edit cell membership
(function(){
  if (!window.Preproc) window.Preproc = {};
  const Preproc = window.Preproc;
  const U = Preproc.Util || {
    $: (sel) => document.querySelector(sel),
    clamp: (x, lo, hi) => Math.max(lo, Math.min(hi, x)),
  };

  // Vibrant fixed colormap; index-based (1st region gets 1st color, etc.)
  const REGION_PALETTE = [
    '#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#a65628', '#f781bf', '#999999',
    '#66c2a5', '#e7298a', '#1f78b4', '#b2df8a', '#fb9a99', '#33a02c', '#cab2d6', '#fdbf6f', '#e31a1c', '#6a3d9a'
  ];
  function colorFor(ctx, name){
    try{
      const names = Object.keys(ctx.regions || {});
      const idx = Math.max(0, names.indexOf(String(name)));
      return REGION_PALETTE[idx % REGION_PALETTE.length] || '#4f8cff';
    } catch(e){ return '#4f8cff'; }
  }

  function overlayMetrics(){
    try{
      const video = U.$('#pp-video');
      const overlay = U.$('#pp-overlay');
      const rect = overlay.getBoundingClientRect();
      const vw = video.videoWidth||0, vh = video.videoHeight||0;
      const scaleX = vw? (rect.width / vw) : 1;
      const scaleY = vh? (rect.height / vh) : 1;
      return { video, overlay, rect, vw, vh, scaleX, scaleY };
    } catch(e){ return {}; }
  }

  function getGrid(){
    const cols = parseInt((U.$('#grid-cols')||{}).value||'',10) || 0;
    const rows = parseInt((U.$('#grid-rows')||{}).value||'',10) || 0;
    return { cols: Math.max(0, cols), rows: Math.max(0, rows) };
  }

  function getArenaBBox(){
    try{
      const S = Preproc.State || {};
      if (!S.tl || !S.br) return null;
      const ax = S.tl.x|0, ay=S.tl.y|0;
      const w = Math.max(0, (S.br.x|0) - ax);
      const h = Math.max(0, (S.br.y|0) - ay);
      return { x: ax, y: ay, width: w, height: h };
    } catch(e){ return null; }
  }

  function inEditState(ctx){ return !!ctx.editing; }

  function regionCellsSummary(cells){
    try{ return (Array.isArray(cells)?cells.length:0) + ' cells'; }catch(e){return '0 cells';}
  }

  function normalizeRegionsMap(regions){
    const out = {};
    if (regions && typeof regions === 'object' && !Array.isArray(regions)){
      Object.keys(regions).forEach((name) => {
        const r = regions[name] || {};
        out[String(name)] = {
          enabled: !!r.enabled,
          sheltered: !!r.sheltered,
          cells: Array.isArray(r.cells) ? r.cells.map((c)=>[parseInt(c[0])|0, parseInt(c[1])|0]) : [],
        };
      });
    }
    return out;
  }

  function serializeRegions(regions){
    const out = {};
    Object.keys(regions).forEach((k)=>{
      const r = regions[k];
      out[k] = {
        enabled: !!r.enabled,
        sheltered: !!r.sheltered,
        cells: Array.from(new Set((r.cells||[]).map((c)=> (c[0]|0)+','+(c[1]|0) )))
               .map((s)=> s.split(',').map((x)=>parseInt(x,10)))
      };
    });
    return out;
  }

  function drawRegionOverlay(ctx){
    try{
      if (!inEditState(ctx) && !ctx.showAll) return;
      const m = overlayMetrics();
      const g = m.overlay.getContext('2d');
      // Draw on top of existing overlay content (arena/grid)
      const bbox = getArenaBBox();
      const grid = getGrid();
      if (!bbox || !grid.cols || !grid.rows) return;
      const x = bbox.x * m.scaleX, y = bbox.y * m.scaleY;
      const w = bbox.width * m.scaleX, h = bbox.height * m.scaleY;
      const cw = w / grid.cols, ch = h / grid.rows;
      // Draw all regions in muted style (each with its own color)
      if (ctx.showAll){
        Object.keys(ctx.regions).forEach((name)=>{
          const rc = (ctx.regions[name] && ctx.regions[name].cells) || [];
          if (!rc.length) return;
          g.save(); g.globalAlpha = 0.35; g.fillStyle = colorFor(ctx, name);
          for (let i=0;i<rc.length;i++){
            const rr = rc[i][0]|0, cc = rc[i][1]|0;
            const cx = x + cc * cw; const cy = y + rr * ch;
            // Only draw if cell has some intersection with the visible canvas
            if (cx + cw >= 0 && cy + ch >= 0 && cx <= m.overlay.width && cy <= m.overlay.height){
              g.fillRect(Math.round(cx)+0.5, Math.round(cy)+0.5, Math.ceil(cw)-1, Math.ceil(ch)-1);
            }
          }
          g.restore();
        });
      }
      // If a row is hovered in the table, accent that region
      if (ctx.showAll && ctx.hover){
        const name = ctx.hover;
        const rc = (ctx.regions[name] && ctx.regions[name].cells) || [];
        if (rc.length){
          const col = colorFor(ctx, name);
          g.save(); g.globalAlpha = 0.6; g.fillStyle = col;
          for (let i=0;i<rc.length;i++){
            const rr = rc[i][0]|0, cc = rc[i][1]|0;
            const cx = x + cc * cw; const cy = y + rr * ch;
            if (cx + cw >= 0 && cy + ch >= 0 && cx <= m.overlay.width && cy <= m.overlay.height){
              g.fillRect(Math.round(cx)+0.5, Math.round(cy)+0.5, Math.ceil(cw)-1, Math.ceil(ch)-1);
            }
          }
          g.restore();
          g.save(); g.strokeStyle = col; g.lineWidth = 2.5;
          for (let i=0;i<rc.length;i++){
            const rr = rc[i][0]|0, cc = rc[i][1]|0;
            const cx = x + cc * cw; const cy = y + rr * ch;
            if (cx + cw >= 0 && cy + ch >= 0 && cx <= m.overlay.width && cy <= m.overlay.height){
              g.strokeRect(Math.round(cx)+0.5, Math.round(cy)+0.5, Math.ceil(cw)-1, Math.ceil(ch)-1);
            }
          }
          g.restore();
        }
      }
      // If editing, highlight current region on top
      if (ctx.editing){
        const r = ctx.regions[ctx.editing] || { cells: [] };
        const cells = r.cells || [];
        const col = colorFor(ctx, ctx.editing);
        g.save(); g.globalAlpha = 0.45; g.fillStyle = col;
        for (let i=0;i<cells.length;i++){
          const rr = cells[i][0]|0, cc = cells[i][1]|0;
          const cx = x + cc * cw; const cy = y + rr * ch;
          if (cx + cw >= 0 && cy + ch >= 0 && cx <= m.overlay.width && cy <= m.overlay.height){
            g.fillRect(Math.round(cx)+0.5, Math.round(cy)+0.5, Math.ceil(cw)-1, Math.ceil(ch)-1);
          }
        }
        g.restore();
        g.save(); g.strokeStyle = col; g.lineWidth = 2;
        for (let i=0;i<cells.length;i++){
          const rr = cells[i][0]|0, cc = cells[i][1]|0;
          const cx = x + cc * cw; const cy = y + rr * ch;
          if (cx + cw >= 0 && cy + ch >= 0 && cx <= m.overlay.width && cy <= m.overlay.height){
            g.strokeRect(Math.round(cx)+0.5, Math.round(cy)+0.5, Math.ceil(cw)-1, Math.ceil(ch)-1);
          }
        }
        g.restore();
      }
    } catch(e){}
  }

  function toggleCellAtEvent(ctx, ev){
    try{
      if (!ctx.editing) return;
      const m = overlayMetrics();
      const bbox = getArenaBBox();
      const grid = getGrid();
      if (!bbox || !grid.cols || !grid.rows) return;
      const px = U.clamp(Math.round((ev.clientX - m.rect.left) / m.rect.width * (m.vw||1)), 0, (m.vw||1)-1);
      const py = U.clamp(Math.round((ev.clientY - m.rect.top) / m.rect.height * (m.vh||1)), 0, (m.vh||1)-1);
      // Position relative to bbox; allow outside-of-bbox cells by extending grid virtually
      const dx = px - bbox.x, dy = py - bbox.y;
      const col = Math.floor(dx * grid.cols / Math.max(1,bbox.width));
      const row = Math.floor(dy * grid.rows / Math.max(1,bbox.height));
      const r = ctx.regions[ctx.editing] || (ctx.regions[ctx.editing] = { enabled:true, sheltered:false, cells:[] });
      const key = row+','+col;
      const idx = r.cells.findIndex((c)=> (c[0]+','+c[1]) === key);
      if (idx === -1) r.cells.push([row, col]); else r.cells.splice(idx,1);
      // Request a full base redraw; regions will paint on top afterward
      try{ document.dispatchEvent(new CustomEvent('preproc:request-overlay-redraw')); }catch(e){}
      // Update table count
      try{
        const tbody = U.$('#roi-table tbody');
        const rowEl = tbody && tbody.querySelector('tr[data-name="'+CSS.escape(ctx.editing)+'"]');
        if (rowEl){
          const cellCnt = rowEl.querySelector('[data-col="cells"]');
          if (cellCnt) cellCnt.textContent = regionCellsSummary(r.cells);
        }
      } catch(e){}
      scheduleSave(ctx);
    } catch(e){}
  }

  function scheduleSave(ctx){
    try{
      if (ctx._saveTimer) clearTimeout(ctx._saveTimer);
      ctx._saveTimer = setTimeout(function(){ saveRegions(ctx); }, 200);
    } catch(e){}
  }

  function saveRegions(ctx){
    try{
      const videoPath = (Preproc.State && Preproc.State.videoPath) || '';
      if (!videoPath) return;
      const payload = { video: videoPath, regions: serializeRegions(ctx.regions) };
      const status = U.$('#roi-status'); if (status) status.textContent = 'Saving…';
      fetch('/api/preproc/regions', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
        .then(r=>r.json().then(d=>({ok:!d.error, d, status:r.statusText})))
        .then(res=>{ const s=U.$('#roi-status'); if (s) s.textContent = res.ok ? 'Saved' : ('Error: ' + (res.d && res.d.error || res.status)); })
        .catch(e=>{ const s=U.$('#roi-status'); if (s) s.textContent = 'Error: ' + e; });
    } catch(e){}
  }

  function renderTable(ctx){
    const tbody = U.$('#roi-table tbody'); if (!tbody) return;
    tbody.innerHTML = '';
    const names = Object.keys(ctx.regions);
    names.forEach((name)=>{
      const r = ctx.regions[name];
      const tr = document.createElement('tr'); tr.dataset.name = name;
      // Hover highlight events
      tr.addEventListener('mouseenter', function(){ ctx.hover = name; if (ctx.showAll) try{ document.dispatchEvent(new CustomEvent('preproc:request-overlay-redraw')); }catch(e){} });
      tr.addEventListener('mouseleave', function(){ if (ctx.hover === name) { ctx.hover = null; if (ctx.showAll) try{ document.dispatchEvent(new CustomEvent('preproc:request-overlay-redraw')); }catch(e){} } });
      // Name (with color swatch)
      const tdName = document.createElement('td'); tdName.style.padding='6px';
      const sw = document.createElement('span');
      sw.style.display='inline-block'; sw.style.width='10px'; sw.style.height='10px'; sw.style.borderRadius='2px'; sw.style.marginRight='6px'; sw.style.verticalAlign='middle';
      sw.style.backgroundColor = colorFor(ctx, name);
      const nameSpan = document.createElement('span'); nameSpan.className = 'roi-name'; nameSpan.textContent = name; nameSpan.title='Click to rename'; nameSpan.style.cursor='pointer';
      nameSpan.addEventListener('click', ()=> renameRegion(ctx, name));
      const editHint = document.createElement('span'); editHint.className = 'roi-edit-hint'; editHint.textContent = '✎';
      tdName.appendChild(sw);
      tdName.appendChild(nameSpan);
      tdName.appendChild(editHint);
      // Enabled
      const tdEn = document.createElement('td'); tdEn.style.padding='6px';
      const en = document.createElement('input'); en.type='checkbox'; en.checked = !!r.enabled; en.addEventListener('change', ()=>{ r.enabled = !!en.checked; scheduleSave(ctx); });
      tdEn.appendChild(en);
      // Sheltered
      const tdSh = document.createElement('td'); tdSh.style.padding='6px';
      const sh = document.createElement('input'); sh.type='checkbox'; sh.checked = !!r.sheltered; sh.addEventListener('change', ()=>{ r.sheltered = !!sh.checked; scheduleSave(ctx); });
      tdSh.appendChild(sh);
      // Cells summary
      const tdCells = document.createElement('td'); tdCells.style.padding='6px'; tdCells.dataset.col='cells'; tdCells.textContent = regionCellsSummary(r.cells);
      // Actions
      const tdAct = document.createElement('td'); tdAct.style.padding='6px';
      const editBtn = document.createElement('button'); editBtn.className='btn mini'; editBtn.textContent = (ctx.editing===name)?'Done':'Edit';
      editBtn.addEventListener('click', ()=>{ if (ctx.editing===name) exitEdit(ctx); else enterEdit(ctx, name); });
      const delBtn = document.createElement('button'); delBtn.className='btn mini'; delBtn.style.marginLeft='6px'; delBtn.textContent='Delete';
      delBtn.addEventListener('click', ()=>{ deleteRegion(ctx, name); });
      tdAct.appendChild(editBtn); tdAct.appendChild(delBtn);

      tr.appendChild(tdName); tr.appendChild(tdEn); tr.appendChild(tdSh); tr.appendChild(tdCells); tr.appendChild(tdAct);
      tbody.appendChild(tr);
    });
  }

  function uniqueRegionName(ctx, base){
    const existing = new Set(Object.keys(ctx.regions).map((n)=>n.toLowerCase()));
    let i = 1; let name = base;
    while (!name || existing.has(name.toLowerCase())){ name = base + ' ' + (i++); }
    return name;
  }

  function addRegion(ctx){
    const name = uniqueRegionName(ctx, 'Region');
    ctx.regions[name] = { enabled: true, sheltered: false, cells: [] };
    renderTable(ctx);
    if (ctx.showAll) try{ document.dispatchEvent(new CustomEvent('preproc:request-overlay-redraw')); }catch(e){}
    scheduleSave(ctx);
  }

  function renameRegion(ctx, oldName){
    const current = String(oldName||'');
    const next = window.prompt('Rename region:', current);
    if (!next || next.trim() === '' || next === current) return;
    const name = next.trim();
    if (ctx.regions[name]){ alert('A region with that name already exists.'); return; }
    ctx.regions[name] = ctx.regions[oldName];
    delete ctx.regions[oldName];
    if (ctx.editing === oldName) ctx.editing = name;
    renderTable(ctx);
    if (ctx.showAll || ctx.editing) try{ document.dispatchEvent(new CustomEvent('preproc:request-overlay-redraw')); }catch(e){}
    scheduleSave(ctx);
  }

  function deleteRegion(ctx, name){
    if (!window.confirm('Delete region "' + name + '"?')) return;
    delete ctx.regions[name];
    if (ctx.editing === name) exitEdit(ctx);
    renderTable(ctx);
    if (ctx.showAll) try{ document.dispatchEvent(new CustomEvent('preproc:request-overlay-redraw')); }catch(e){}
    scheduleSave(ctx);
  }

  function enterEdit(ctx, name){
    ctx.editing = name;
    try{ document.dispatchEvent(new CustomEvent('preproc:regions-editing', { detail: { editing: true } })); }catch(e){}
    const overlay = U.$('#pp-overlay');
    if (overlay) overlay.style.pointerEvents = 'auto';
    // Add listeners
    if (!ctx._overlayClick){ ctx._overlayClick = (ev)=> toggleCellAtEvent(ctx, ev); }
    if (!ctx._escKey){ ctx._escKey = (ev)=>{ if (ev.key==='Escape'){ exitEdit(ctx); } }; }
    overlay && overlay.addEventListener('click', ctx._overlayClick);
    window.addEventListener('keydown', ctx._escKey);
    drawRegionOverlay(ctx);
    renderTable(ctx);
    const status = U.$('#roi-status'); if (status) status.textContent = 'Editing ' + name + '. Click cells to toggle. ESC to finish.';
  }

  function exitEdit(ctx){
    const overlay = U.$('#pp-overlay');
    if (overlay) overlay.style.pointerEvents = 'none';
    if (overlay && ctx._overlayClick){ overlay.removeEventListener('click', ctx._overlayClick); }
    if (ctx._escKey){ window.removeEventListener('keydown', ctx._escKey); }
    ctx.editing = null;
    try{ document.dispatchEvent(new CustomEvent('preproc:regions-editing', { detail: { editing: false } })); }catch(e){}
    // Redraw overlay to clear edit visuals: trigger arena redraw if available, else clear our overlay painting is ephemeral
    try{
      // Attempt to trigger an overlay redraw via resize to clear our strokes if needed
      const evt = document.createEvent('UIEvents'); evt.initUIEvent('resize', true, false, window, 0); window.dispatchEvent(evt);
    } catch(e){}
    renderTable(ctx);
    const status = U.$('#roi-status'); if (status) status.textContent = '';
    scheduleSave(ctx);
  }

  function dropOutOfRangeCells(ctx){
    // Preserve cells even if they fall outside the current bbox-aligned grid
    Object.keys(ctx.regions).forEach((name)=>{
      const r = ctx.regions[name];
      if (!Array.isArray(r.cells)) r.cells = [];
      r.cells = r.cells.filter((c)=> c && c.length>=2 && Number.isFinite(c[0]) && Number.isFinite(c[1]));
    });
  }

  function _getFacilities(){
    try { const cfg = window.CHEESEPIE || {}; return (cfg.importer && cfg.importer.facilities) || {}; } catch(e){ return {}; }
  }
  function _getDefaultRoiFromFacility(){
    try{
      const facSel = U.$('#pp-facility'); const setupSel = U.$('#pp-setup');
      const fac = (facSel && facSel.value) || '';
      if (!fac) return {};
      const facs = _getFacilities();
      const fcfg = facs[fac]; if (!fcfg) return {};
      const setups = fcfg.setups;
      if (setups && typeof setups === 'object' && !Array.isArray(setups)){
        const sname = (setupSel && setupSel.value) || Object.keys(setups)[0] || 'default';
        const s = setups[sname] || setups['default'] || null;
        const roi = s && s.roi; if (roi && typeof roi === 'object') return roi;
      }
      // Legacy: roi_sets list at facility level
      const legacy = Array.isArray(fcfg.roi_sets) ? fcfg.roi_sets : [];
      const out = {};
      legacy.forEach((it)=>{ try{ if (it && it.name){ out[it.name] = { cells: it.cells||[], sheltered: !!it.sheltered }; } }catch(e){} });
      return out;
    } catch(e){ return {}; }
  }

  function loadExisting(ctx){
    const videoPath = (Preproc.State && Preproc.State.videoPath) || '';
    if (!videoPath) return;
    fetch('/api/preproc/state?video=' + encodeURIComponent(videoPath))
      .then((r)=> r.json())
      .then((d)=>{
        if (!d || d.error) return;
        const tmpRoi = normalizeRegionsMap(d.roi || d.regions || {});
        if (Object.keys(tmpRoi).length){ ctx.regions = tmpRoi; }
        else { ctx.regions = normalizeRegionsMap(_getDefaultRoiFromFacility()); }
        dropOutOfRangeCells(ctx);
        renderTable(ctx);
      })
      .catch(()=>{});
  }

  function wireGridChange(ctx){
    try{
      const colsEl = U.$('#grid-cols');
      const rowsEl = U.$('#grid-rows');
      const redraw = ()=>{ dropOutOfRangeCells(ctx); renderTable(ctx); if (inEditState(ctx)) try{ document.dispatchEvent(new CustomEvent('preproc:request-overlay-redraw')); }catch(e){} };
      colsEl && colsEl.addEventListener('change', redraw);
      rowsEl && rowsEl.addEventListener('change', redraw);
      window.addEventListener('resize', ()=>{ if (inEditState(ctx)) drawRegionOverlay(ctx); });
    } catch(e){}
  }

  function init(ctx){
    const state = { regions: {}, editing: null, showAll: false, hover: null };
    // Wire add button
    const addBtn = U.$('#roi-add'); if (addBtn) addBtn.addEventListener('click', ()=> addRegion(state));
    // Initial data
    loadExisting(state);
    wireGridChange(state);
    // React to tab visibility
    document.addEventListener('preproc:tab-changed', function(ev){
      const name = (ev && ev.detail && ev.detail.name) || '';
      state.showAll = (name === 'regions');
      // Ensure overlay interactions only when editing
      const overlay = U.$('#pp-overlay'); if (overlay && !state.editing) overlay.style.pointerEvents = 'none';
      // Trigger redraw over the arena overlay when becoming visible
      if (state.showAll) try{ document.dispatchEvent(new CustomEvent('preproc:request-overlay-redraw')); }catch(e){}
    });
    // When arena overlay redraws, paint regions on top if needed
    document.addEventListener('preproc:overlay-redraw', function(){ drawRegionOverlay(state); });
    return {
      // Expose for potential use
      get regions(){ return state.regions; },
      isEditing: ()=> !!state.editing,
    };
  }

  window.Preproc.Regions = { init };
})();
