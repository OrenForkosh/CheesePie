// Timing tab: set experiment start/end with millisecond precision
(function(){
  if (!window.Preproc) window.Preproc = {};
  const Preproc = window.Preproc;
  const U = Preproc.Util || { $: (sel)=>document.querySelector(sel) };

  function pad(n, w){ n = String(n); return n.length>=w? n : new Array(w-n.length+1).join('0')+n; }
  function formatMs(ms){
    if (!isFinite(ms) || ms<0) ms = 0;
    const total = Math.floor(ms);
    const msec = total % 1000;
    const secAll = Math.floor(total / 1000);
    const s = secAll % 60;
    const minAll = Math.floor(secAll / 60);
    const m = minAll % 60;
    const h = Math.floor(minAll / 60);
    return pad(h,2)+":"+pad(m,2)+":"+pad(s,2)+"."+pad(msec,3);
  }
  function parseTime(s){
    if (!s) return 0;
    try{
      const str = String(s).trim();
      // Flexible: ss(.mmm), mm:ss(.mmm), hh:mm:ss(.mmm)
      const m = str.match(/^(\d+)(?::(\d+))?(?::(\d+))?(?:\.(\d{1,3}))?$/);
      if (!m) return null;
      let h=0, mi=0, se=0, ms=0;
      if (m[3] != null){ // hh:mm:ss
        h = parseInt(m[1],10)||0; mi = parseInt(m[2],10)||0; se = parseInt(m[3],10)||0;
      } else if (m[2] != null){ // mm:ss
        mi = parseInt(m[1],10)||0; se = parseInt(m[2],10)||0;
      } else { // ss
        se = parseFloat(m[1])||0;
      }
      if (m[4] != null){ ms = parseInt(pad(m[4],3),10)||0; }
      return ((h*60+mi)*60+se)*1000 + ms;
    } catch(e){ return null; }
  }

  function init(){
    const video = U.$('#pp-video');
    const pane = U.$('#pane-timing');
    const cur = U.$('#exp-current');
    const startEl = U.$('#exp-start');
    const endEl = U.$('#exp-end');
    const setStart = U.$('#exp-set-start');
    const setEnd = U.$('#exp-set-end');
    const jumpStart = U.$('#exp-jump-start');
    const jumpEnd = U.$('#exp-jump-end');
    const resetBtn = U.$('#exp-reset');
    const saveBtn = U.$('#exp-next');
    const status = U.$('#exp-status');

    function updateCurrent(){
      try{
        const val = formatMs((video.currentTime||0)*1000);
        if (!cur) return;
        if ((cur.tagName||'').toLowerCase()==='input') cur.value = val; else cur.textContent = val;
      }catch(e){}
    }
    video && video.addEventListener('timeupdate', updateCurrent);
    video && video.addEventListener('seeked', updateCurrent);
    video && video.addEventListener('loadedmetadata', function(){
      // If fields empty, initialize defaults
      try{
        const dur = isFinite(video.duration)? video.duration*1000 : 0;
        if (startEl && !startEl.value) startEl.value = '00:00:00.000';
        if (endEl && !endEl.value) endEl.value = formatMs(dur);
      } catch(e){}
      updateCurrent();
    });

    // Load saved state
    (function load(){
      try{
        const vp = (Preproc.State && Preproc.State.videoPath) || '';
        if (!vp) return;
        fetch('/api/preproc/state?video=' + encodeURIComponent(vp))
          .then(r=>r.json())
          .then(d=>{
            if (!d || d.error) return;
            const meta = d.meta || {};
            if (startEl && typeof meta.start_time === 'string') startEl.value = meta.start_time;
            if (endEl && typeof meta.end_time === 'string') endEl.value = meta.end_time;
          })
          .catch(()=>{});
      } catch(e){}
    })();

    // Save helper (reused by various triggers)
    async function saveTiming(){
      try{
        const vp = (Preproc.State && Preproc.State.videoPath) || '';
        if (!vp){ if (status) status.textContent='Select a video first.'; return; }
        const s = (startEl && startEl.value || '').trim();
        const e = (endEl && endEl.value || '').trim();
        if (parseTime(s) == null || parseTime(e) == null){ if (status) status.textContent='Enter times as HH:MM:SS.mmm'; return; }
        if (status) status.textContent = 'Saving…';
        const r = await fetch('/api/preproc/timing', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ video: vp, start_time: s, end_time: e }) });
        const d = await r.json();
        if (status) status.textContent = (!d || d.error) ? ('Error: ' + (d && d.error || r.statusText)) : 'Saved';
      } catch(e){ if (status) status.textContent = 'Error: ' + e; }
    }
    let saveTimer = null;
    function scheduleSave(){ try{ if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(saveTiming, 400); }catch(e){} }
    // Buttons
    if (setStart) setStart.addEventListener('click', function(){ try{ if (!video) return; startEl.value = formatMs((video.currentTime||0)*1000); saveTiming(); }catch(e){} });
    if (setEnd) setEnd.addEventListener('click', function(){ try{ if (!video) return; endEl.value = formatMs((video.currentTime||0)*1000); saveTiming(); }catch(e){} });
    if (jumpStart) jumpStart.addEventListener('click', function(){
      try{
        if (!video) return; const tms = parseTime((startEl && startEl.value)||''); if (tms==null){ if(status) status.textContent='Enter times as HH:MM:SS.mmm'; return; }
        const t = Math.max(0, (tms/1000)|0); try{ video.pause(); }catch(e){} video.currentTime = Math.min(Math.max(0, tms/1000), Math.max(0,(video.duration||0)-1e-6));
      }catch(e){}
    });
    if (jumpEnd) jumpEnd.addEventListener('click', function(){
      try{
        if (!video) return; const tms = parseTime((endEl && endEl.value)||''); if (tms==null){ if(status) status.textContent='Enter times as HH:MM:SS.mmm'; return; }
        try{ video.pause(); }catch(e){} video.currentTime = Math.min(Math.max(0, tms/1000), Math.max(0,(video.duration||0)-1e-6));
      }catch(e){}
    });
    if (resetBtn) resetBtn.addEventListener('click', function(){ try{ if (!video) return; startEl.value='00:00:00.000'; endEl.value = formatMs((isFinite(video.duration)? video.duration*1000 : 0)); saveTiming(); }catch(e){} });
    if (saveBtn) saveBtn.addEventListener('click', function(){
      saveTiming();
    });
    // Jump to time by editing the Current field (Enter or blur)
    if (cur && (cur.tagName||'').toLowerCase()==='input'){
      cur.addEventListener('keydown', function(ev){
        if (ev.key==='Enter'){
          ev.preventDefault();
          const ms = parseTime(cur.value||'');
          if (ms==null){ if(status) status.textContent='Enter time as HH:MM:SS.mmm'; return; }
          try{ video.pause(); }catch(e){}
          video.currentTime = Math.min(Math.max(0, ms/1000), Math.max(0,(video.duration||0)-1e-6));
        }
      });
      cur.addEventListener('blur', function(){
        const ms = parseTime(cur.value||''); if (ms==null) return;
        try{ video.pause(); }catch(e){}
        video.currentTime = Math.min(Math.max(0, ms/1000), Math.max(0,(video.duration||0)-1e-6));
      });
    }
    // Auto-save on editing inputs
    if (startEl){ startEl.addEventListener('input', scheduleSave); startEl.addEventListener('change', saveTiming); startEl.addEventListener('keydown', function(ev){ if (ev.key==='Enter'){ ev.preventDefault(); saveTiming(); } }); }
    if (endEl){ endEl.addEventListener('input', scheduleSave); endEl.addEventListener('change', saveTiming); endEl.addEventListener('keydown', function(ev){ if (ev.key==='Enter'){ ev.preventDefault(); saveTiming(); } }); }

    // Keyboard: Arrow keys step by frames when Timing tab is active
    function cfgFps(){
      try{ const cfg = window.CHEESEPIE || {}; const afps = (cfg.annotator && cfg.annotator.default_fps) || 30; const n = parseInt(afps,10)||30; return Math.max(1, Math.min(300, n)); }catch(e){ return 30; }
    }
    function paneActive(){ try{ return pane && pane.style.display !== 'none'; }catch(e){ return false; } }
    function isTypingTarget(t){ try{ if(!t) return false; const tag = (t.tagName||'').toLowerCase(); return tag==='input' || tag==='textarea' || t.isContentEditable; }catch(e){ return false; } }
    document.addEventListener('keydown', function(ev){
      try{
        if (!paneActive()) return;
        if (!video || !isFinite(video.duration)) return;
        if (isTypingTarget(ev.target)) return; // don't hijack while typing
        const k = ev.key;
        const code = ev.code;
        let dt = null; // seconds delta
        // [ / ] step by one frame
        if (k === '[' || code === 'BracketLeft'){
          dt = -1 / cfgFps();
        } else if (k === ']' || code === 'BracketRight'){
          dt = +1 / cfgFps();
        } else if (k === 'ArrowLeft' || k === 'ArrowRight'){
          // Arrow keys jump seconds: 1s, or 5s with Shift
          const jump = ev.shiftKey ? 5 : 1;
          dt = (k === 'ArrowRight' ? +jump : -jump);
        } else {
          return;
        }
        let t = (video.currentTime || 0) + dt;
        t = Math.max(0, Math.min(t, Math.max(0, (video.duration||0)-1e-6)));
        ev.preventDefault(); ev.stopPropagation();
        try{ video.pause(); }catch(e){}
        video.currentTime = t;
      }catch(e){}
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
