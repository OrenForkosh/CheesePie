// Preproc main orchestrator
(function(){
  var Preproc = window.Preproc || (window.Preproc = {});
  var U = Preproc.Util, S = Preproc.State;

  function init(){
    try { S.videoPath = String(window.PREPROC_VIDEO || ''); } catch(e) { S.videoPath = ''; }
    var v = U.$('#pp-video');
    var overlay = U.$('#pp-overlay');
    var markBtn = U.$('#arena-mark');
    var status = U.$('#arena-status');

    // Tabs
    var panes = {
      arena: U.$('#pane-arena'),
      background: U.$('#pane-background'),
      regions: U.$('#pane-regions'),
      colors: U.$('#pane-colors'),
      timing: U.$('#pane-timing'),
      save: U.$('#pane-save')
    };
    var tabs = {
      arena: U.$('#tab-arena'),
      background: U.$('#tab-background'),
      regions: U.$('#tab-regions'),
      colors: U.$('#tab-colors'),
      timing: U.$('#tab-timing'),
      save: U.$('#tab-save')
    };

    var isRegionsEditing = false;
    var order = ['arena','timing','background','regions','colors','save'];
    function nextOf(name){ var i = order.indexOf(name); return (i>=0 && i < order.length-1) ? order[i+1] : null; }
    function switchTab(name){
      // Guard against disabled tabs
      var btn = tabs[name];
      if (btn && btn.disabled) return;
      // Prevent switching away while region editing is active
      if (isRegionsEditing && name !== 'arena' && name !== 'regions'){
        alert('Finish editing the region first.');
        return;
      }
      U.showPane(name, panes);
      U.setActiveTab(name, tabs);
      // Allow overlay interactions in Arena (for marking) and in Colors (for segment marking)
      overlay.style.pointerEvents = ((name === 'arena' && S.marking) || name === 'colors') ? 'auto' : 'none';
      try{ document.dispatchEvent(new CustomEvent('preproc:tab-changed', { detail: { name: name } })); }catch(e){}
      try{ if (arena && arena.drawOverlay) arena.drawOverlay(); }catch(e){}
    }

    if (tabs.arena) tabs.arena.addEventListener('click', function(){ if (tabs.arena.disabled) return; switchTab('arena'); });
    if (tabs.timing) tabs.timing.addEventListener('click', function(){ if (tabs.timing.disabled) return; switchTab('timing'); });
    if (tabs.background) tabs.background.addEventListener('click', function(){ if (tabs.background.disabled) return; switchTab('background'); });
    if (tabs.regions) tabs.regions.addEventListener('click', function(){ if (tabs.regions.disabled) return; switchTab('regions'); });
    if (tabs.colors) tabs.colors.addEventListener('click', function(){ if (tabs.colors.disabled) return; switchTab('colors'); });
    if (tabs.timing) tabs.timing.addEventListener('click', function(){ if (tabs.timing.disabled) return; switchTab('timing'); });
    if (tabs.save) tabs.save.addEventListener('click', function(){ if (tabs.save.disabled) return; switchTab('save'); });

    // No file placeholder
    if (!S.videoPath){
      try{
        var ph = document.createElement('div'); ph.className='placeholder muted'; ph.textContent='No video selected. Choose a file from Browser to begin.';
        if (panes.arena) panes.arena.insertBefore(ph, panes.arena.firstChild);
      } catch(e){}
    } else {
      // Load video source
      try { v.src = '/media?path=' + encodeURIComponent(S.videoPath); v.load(); } catch(e) {}
    }

    // Export current frame as PNG
    (function wireExport(){
      var btn = U.$('#pp-export-frame'); if (!btn || !v) return;
      function tsString(sec){
        try{
          var totalMs = Math.max(0, Math.round((+sec||0)*1000));
          var s = (totalMs/1000)|0; var ms = totalMs % 1000;
          var h = (s/3600)|0; var m = ((s%3600)/60)|0; var ss = (s%60)|0;
          var pad2 = (n)=>String(n).padStart(2,'0'); var pad3=(n)=>String(n).padStart(3,'0');
          return (h? h+"-":"") + pad2(m) + '-' + pad2(ss) + '.' + pad3(ms);
        }catch(e){ return 'time'; }
      }
      btn.addEventListener('click', function(){
        try{
          if (!v.videoWidth){ alert('Video not ready'); return; }
          var cw = v.videoWidth, ch = v.videoHeight;
          var c = document.createElement('canvas'); c.width=cw; c.height=ch;
          var ctx = c.getContext('2d');
          ctx.drawImage(v, 0, 0, cw, ch);
          var dataUrl = c.toDataURL('image/png');
          var a = document.createElement('a');
          var base = (S.videoPath ? (S.videoPath.split('/').pop()||'video') : 'frame');
          var at = tsString(v.currentTime||0);
          a.download = base.replace(/\.[^.]+$/, '') + '.frame.' + at + '.png';
          a.href = dataUrl;
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
        } catch(e){ console.error('Export failed', e); }
      });
    })();

    // Facility select handling
    var facilitySel = U.$('#pp-facility');
    function getFacilities(){
      try{
        var cfg = window.CHEESEPIE || {};
        var facs = (cfg.importer && cfg.importer.facilities) || {};
        return facs;
      } catch(e){ return {}; }
    }
    // Pane interactivity + veil (no layout shift)
    var paneWrap = document.getElementById('pp-panes');
    var veil = null;
    function ensureVeil(){
      if (!paneWrap) return null;
      if (veil) return veil;
      veil = document.createElement('div');
      veil.className = 'disabled-veil';
      paneWrap.style.position = paneWrap.style.position || 'relative';
      paneWrap.appendChild(veil);
      return veil;
    }
    function setTreeDisabled(el, disabled){
      try{
        if (!el) return;
        // Avoid inert to prevent browser-level pointer blocking quirks
        var controls = el.querySelectorAll('input,button,select,textarea');
        for (var i=0;i<controls.length;i++){ controls[i].disabled = !!disabled; }
      } catch(e){}
    }
    function arenaIsValid(){
      try{
        var tl = S.tl, br = S.br;
        if (!tl || !br) return false;
        var minW = 10, minH = 10;
        return (br.x - tl.x) >= minW && (br.y - tl.y) >= minH;
      } catch(e){ return false; }
    }

    function setTabsEnabled(enabled){
      try{
        // Tabs button state
        Object.keys(tabs).forEach(function(k){ if (tabs[k]) { tabs[k].disabled = !enabled; tabs[k].title = enabled? '' : 'Select a facility to continue'; } });
        // Panes visibility and interactivity
        var v = ensureVeil();
        if (!enabled){
          // Disable only; keep layout stable
          if (v) v.classList.add('visible');
          Object.keys(panes).forEach(function(k){ if (panes[k]) { setTreeDisabled(panes[k], true); } });
        } else {
          if (v) v.classList.remove('visible');
          Object.keys(panes).forEach(function(k){ if (panes[k]) { setTreeDisabled(panes[k], false); } });
          // Additional gating: Regions/Save require a valid arena
          var okArena = arenaIsValid();
          if (tabs.timing){ tabs.timing.disabled = !okArena; tabs.timing.title = okArena? '' : 'Mark the arena first'; }
          if (tabs.regions){ tabs.regions.disabled = !okArena; tabs.regions.title = okArena? '' : 'Mark the arena first'; }
          if (tabs.save){ tabs.save.disabled = !okArena; tabs.save.title = okArena? '' : 'Mark the arena first'; }
          // Colors requires a computed or loaded background
          var hasBg = !!S.hasBackground;
          if (tabs.colors){ tabs.colors.disabled = (!hasBg); tabs.colors.title = hasBg? '' : 'Compute or load background first'; }
        }
      } catch(e){}
    }
    function applyRegionsEditingGating(){
      try{
        if (isRegionsEditing){
          // Disable navigation except Regions and Arena
          Object.keys(tabs).forEach(function(k){ if (!tabs[k]) return; if (k !== 'regions' && k !== 'arena'){ tabs[k].disabled = true; tabs[k].title = 'Finish editing the region first'; } });
        } else {
          // Recompute default gating based on current facility/arena state
          setTabsEnabled(!!(facilitySel && facilitySel.value));
        }
      } catch(e){}
    }
    function currentFacilityFromUrl(){
      try{
        var usp = new URLSearchParams(location.search);
        return usp.get('facility') || '';
      } catch(e){ return ''; }
    }
    function updateUrlWithFacility(fac){
      try{
        var url = new URL(window.location.href);
        if (fac) url.searchParams.set('facility', fac); else url.searchParams.delete('facility');
        history.replaceState(null, '', url.toString());
      } catch(e){}
    }
    function populateFacility(){
      if (!facilitySel) return;
      var facs = getFacilities();
      var keys = Object.keys(facs);
      facilitySel.innerHTML = '';
      // placeholder option
      var opt0 = document.createElement('option'); opt0.value=''; opt0.textContent='Select facility'; facilitySel.appendChild(opt0);
      keys.forEach(function(k){ var o = document.createElement('option'); o.value=k; o.textContent=k; facilitySel.appendChild(o); });
      // pick from URL or storage
      var fromUrl = currentFacilityFromUrl();
      var fromStore = '';
      try{ fromStore = localStorage.getItem('cheesepie.preproc.facility') || ''; } catch(e){}
      var chosen = fromUrl || fromStore;
      if (chosen && keys.indexOf(chosen) !== -1){ facilitySel.value = chosen; setTabsEnabled(true); }
      else { facilitySel.value = ''; setTabsEnabled(false); }
    }
    populateFacility();
    if (facilitySel){
      facilitySel.addEventListener('change', function(){
        var fac = facilitySel.value || '';
        try{ localStorage.setItem('cheesepie.preproc.facility', fac); } catch(e){}
        updateUrlWithFacility(fac);
        setTabsEnabled(!!fac);
        if (fac){ populateSetupsForFacility(fac); }
      });
    }

    // Setup dropdown and Save handling
    var setupSel = U.$('#pp-setup');
    var applySetupBtn = U.$('#pp-apply-setup');
    var saveSetupBtn = U.$('#pp-save-setup');
    var saveFinalBtn = U.$('#pp-save-final');
    var currentSetups = null;
    function normalizeSetups(raw){
      // Accept dict in target shape, or list in legacy shape, or null
      if (!raw) return null;
      if (!Array.isArray(raw) && typeof raw === 'object') return raw; // already dict
      if (Array.isArray(raw)){
        var out = {};
        raw.forEach(function(su){
          if (!su || typeof su !== 'object') return;
          var name = String(su.name||'default');
          var pp = su.preproc || {};
          // convert arena tl/br to rect if present
          var rect = null;
          if (pp.arena_tl && pp.arena_br){
            try{
              var ax = parseInt(pp.arena_tl.x)||0, ay = parseInt(pp.arena_tl.y)||0;
              var bx = parseInt(pp.arena_br.x)||ax, by = parseInt(pp.arena_br.y)||ay;
              rect = { x: ax, y: ay, width: Math.max(0,bx-ax), height: Math.max(0,by-ay) };
            } catch(e){}
          }
          // convert roi_sets list to roi map
          var roi = {};
          var rlist = su.roi_sets || [];
          if (Array.isArray(rlist)){
            rlist.forEach(function(r){
              if (!r || !r.name) return;
              roi[r.name] = { cells: (r.cells||[]), sheltered: !!r.sheltered };
            });
          }
          out[name] = {
            arena_width_cm: pp.arena_width_cm,
            arena_height_cm: pp.arena_height_cm,
            grid_cols: pp.grid_cols,
            grid_rows: pp.grid_rows,
            bg_frames: pp.bg_frames,
            bg_quantile: pp.bg_quantile,
            arena: rect,
            roi: roi
          };
        });
        return out;
      }
      return null;
    }

    function populateSetupsForFacility(fac){
      if (!setupSel) return;
      var facs = getFacilities();
      var setups = normalizeSetups(((facs[fac]||{}).setups) || null);
      // Back-compat: build setups from legacy roi_sets if needed
      if (!setups){
        var legacy = ((facs[fac]||{}).roi_sets) || [];
        if (legacy && legacy.length){
          setups = { 'default': { roi: legacy.reduce(function(m,it){ try{ m[it.name||'roi']={ cells:it.cells||[], sheltered:!!it.sheltered }; }catch(e){} return m; }, {} ) } };
        }
      }
      currentSetups = setups;
      setupSel.innerHTML = '';
      if (!setups || (typeof setups!=='object')){ return; }
      var names = Object.keys(setups);
      names.sort(function(a,b){ if (a==='default') return -1; if (b==='default') return 1; return a.localeCompare(b); });
      names.forEach(function(n){ var o=document.createElement('option'); o.value=n; o.textContent=n; setupSel.appendChild(o); });
      var chosen = names[0] || 'default';
      setupSel.value = chosen;
      applySetupDefaults(fac, setupSel.value, setups);
    }
    function applySetupDefaults(fac, name, setups){
      try{
        var s = setups && setups[name];
        if (!s) return;
        var pp = s || {};
        var cols = U.$('#grid-cols'), rows=U.$('#grid-rows'), wcm=U.$('#arena-wcm'), hcm=U.$('#arena-hcm');
        var bgf = U.$('#bg-frames'), bgq = U.$('#bg-quant');
        if (cols && pp.grid_cols!=null) cols.value = String(pp.grid_cols);
        if (rows && pp.grid_rows!=null) rows.value = String(pp.grid_rows);
        if (wcm && pp.arena_width_cm!=null) wcm.value = String(pp.arena_width_cm);
        if (hcm && pp.arena_height_cm!=null) hcm.value = String(pp.arena_height_cm);
        if (bgf && pp.bg_frames!=null) bgf.value = String(pp.bg_frames);
        if (bgq && pp.bg_quantile!=null) bgq.value = String(pp.bg_quantile);
        if (pp.arena && typeof pp.arena.x==='number' && typeof pp.arena.y==='number' && typeof pp.arena.width==='number' && typeof pp.arena.height==='number'){
          S.tl = { x: pp.arena.x|0, y: pp.arena.y|0 };
          S.br = { x: (pp.arena.x + pp.arena.width)|0, y: (pp.arena.y + pp.arena.height)|0 };
        }
        if (arena && arena.drawOverlay) arena.drawOverlay();
      } catch(e){}
    }
    if (setupSel){ setupSel.addEventListener('change', function(){ var fac = facilitySel?facilitySel.value:''; if (!currentSetups){ populateSetupsForFacility(fac); } applySetupDefaults(fac, setupSel.value, currentSetups); }); }
    if (applySetupBtn){ applySetupBtn.addEventListener('click', function(){ var fac = facilitySel?facilitySel.value:''; if (!fac){ alert('Select a facility first.'); return; } if (!currentSetups){ populateSetupsForFacility(fac); } applySetupDefaults(fac, setupSel && setupSel.value, currentSetups); }); }
    if (saveSetupBtn){
      saveSetupBtn.addEventListener('click', function(){
        var fac = facilitySel ? facilitySel.value : '';
        if (!fac){ alert('Select a facility first.'); return; }
        var name = (setupSel && setupSel.value) || 'default';
        if (!window.confirm('Are you sure you want to save this setup?')) return;
        var cols = parseInt((U.$('#grid-cols')||{}).value||'')||null;
        var rows = parseInt((U.$('#grid-rows')||{}).value||'')||null;
        var wcm = parseInt((U.$('#arena-wcm')||{}).value||'')||null;
        var hcm = parseInt((U.$('#arena-hcm')||{}).value||'')||null;
        var bgf = parseInt((U.$('#bg-frames')||{}).value||'')||null;
        var bgq = parseInt((U.$('#bg-quant')||{}).value||'')||null;
        var payload = {
          facility: fac,
          setup_name: name,
          setup: {
            arena_width_cm: wcm,
            arena_height_cm: hcm,
            grid_cols: cols,
            grid_rows: rows,
            bg_frames: bgf,
            bg_quantile: bgq,
            arena: (S.tl && S.br ? { x:S.tl.x, y:S.tl.y, width: Math.max(0,S.br.x-S.tl.x), height: Math.max(0,S.br.y-S.tl.y) } : null),
            roi: {}
          }
        };
        fetch('/api/preproc/setup/save', {
          method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)
        }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d, status:r.statusText}; }); })
          .then(function(res){ if (!res.ok || res.d.error){ alert('Save failed: ' + (res.d && res.d.error || res.status)); return; }
                 populateSetupsForFacility(fac); alert('Saved.'); })
          .catch(function(e){ alert('Save failed: ' + e); });
      });
    }

    // Save final preproc for current video next to the video file
    if (saveFinalBtn){
      saveFinalBtn.addEventListener('click', function(){
        var videoPath = (window.Preproc && window.Preproc.State && window.Preproc.State.videoPath) || '';
        if (!videoPath){ alert('Select a video first.'); return; }
        var statusEl = document.getElementById('pp-mday-status');
        if (statusEl) statusEl.textContent = 'Saving final preproc…';
        fetch('/api/preproc/save_final', {
          method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ video: videoPath })
        }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d, status:r.statusText}; }); })
          .then(function(res){ if (statusEl) statusEl.textContent = res.ok? ('Saved to ' + (res.d && res.d.path || '')) : ('Error: ' + (res.d && res.d.error || res.status)); })
          .catch(function(e){ if (statusEl) statusEl.textContent = 'Error: ' + e; });
      });
    }

    // Initialize modules
    var arena = Preproc.Arena && Preproc.Arena.init({ video: v, overlay: overlay, markBtn: markBtn, status: status });
    // Allow other modules to request a fresh overlay redraw (base layer)
    document.addEventListener('preproc:request-overlay-redraw', function(){
      try{ if (arena && arena.drawOverlay) arena.drawOverlay(); }catch(e){}
    });
    if (Preproc.Background) Preproc.Background.init({});
    if (Preproc.Filters) Preproc.Filters.init({ video: v });
    var regions = null; if (Preproc.Regions) regions = Preproc.Regions.init({});
    try { Preproc.__regions = regions; } catch(e){}
    var bg = null; if (Preproc.Background) bg = Preproc.Background.init({});
    if (Preproc.Colors) Preproc.Colors.init({});
    // Wire Save dialog button
    try {
      var openSaveBtn = U.$('#pp-open-save');
      if (openSaveBtn && Preproc.SaveDialog && Preproc.SaveDialog.open){
        openSaveBtn.addEventListener('click', function(){ Preproc.SaveDialog.open(); });
      }
    } catch(e){}

    // Only allow switching once a facility is set; otherwise show placeholder
    if (facilitySel && !facilitySel.value){
      setTabsEnabled(false);
    } else {
      setTabsEnabled(true);
      if (facilitySel && facilitySel.value){ populateSetupsForFacility(facilitySel.value); }
    }

    // Load saved preproc state (arena, background, etc.) for this video
    (function loadState(){
      if (!S.videoPath) return;
      try{
        fetch('/api/preproc/state?video=' + encodeURIComponent(S.videoPath))
          .then(function(r){ return r.json(); })
          .then(function(d){
            if (!d || d.error) return;
            if (d.arena){
              // Prefill grid/size inputs if present
              try{
                var colsEl = U.$('#grid-cols'), rowsEl = U.$('#grid-rows'), wcmEl = U.$('#arena-wcm'), hcmEl = U.$('#arena-hcm');
                if (colsEl && d.arena.grid_cols!=null) colsEl.value = String(d.arena.grid_cols);
                if (rowsEl && d.arena.grid_rows!=null) rowsEl.value = String(d.arena.grid_rows);
                if (wcmEl && d.arena.width_in_cm!=null) wcmEl.value = String(d.arena.width_in_cm);
                if (hcmEl && d.arena.height_in_cm!=null) hcmEl.value = String(d.arena.height_in_cm);
              } catch(e){}
              if (d.arena.tl && d.arena.br){
                S.tl = { x: (d.arena.tl.x|0), y: (d.arena.tl.y|0) };
                S.br = { x: (d.arena.br.x|0), y: (d.arena.br.y|0) };
              } else if (d.arena.bbox){
                var bb = d.arena.bbox; var ax = (bb.x|0), ay=(bb.y|0), w=(bb.width|0), h=(bb.height|0);
                S.tl = { x: ax, y: ay };
                S.br = { x: ax + Math.max(0,w), y: ay + Math.max(0,h) };
              }
              if (arena && arena.drawOverlay) arena.drawOverlay();
              // Update gating for Regions/Save
              setTabsEnabled(!!(facilitySel && facilitySel.value));
            }
            if (d.background){
              try{
                var bgCanvas = document.getElementById('bg-canvas');
                if (bgCanvas){
                  var img = new Image();
                  img.onload = function(){
                    try{
                      bgCanvas.width = img.width; bgCanvas.height = img.height;
                      var c = bgCanvas.getContext('2d'); c.drawImage(img, 0, 0);
                      S.hasBackground = true;
                      // Update gating now that background is available
                      setTabsEnabled(!!(facilitySel && facilitySel.value));
                    } catch(e){}
                  };
                  if (typeof d.background === 'string'){
                    // Back-compat path-based
                    img.src = '/media?path=' + encodeURIComponent(d.background);
                  } else if (d.background.image_b64){
                    img.src = d.background.image_b64;
                  }
                }
              } catch(e){}
            }
          })
          .catch(function(e){});
      } catch(e){}
    })();

    // React when background becomes ready during this session
    document.addEventListener('preproc:background-ready', function(){
      try{ S.hasBackground = true; setTabsEnabled(!!(facilitySel && facilitySel.value)); }catch(e){}
    });

    // React to arena changes to update gating
    document.addEventListener('preproc:arena-changed', function(){ if (!isRegionsEditing) setTabsEnabled(!!(facilitySel && facilitySel.value)); });
    document.addEventListener('preproc:regions-editing', function(ev){ isRegionsEditing = !!(ev && ev.detail && ev.detail.editing); applyRegionsEditingGating(); });
    // Removed legacy Next button handlers; saving happens via explicit buttons or dialogs.
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
