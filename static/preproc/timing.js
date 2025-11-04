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
      const m = String(s).trim().match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
      if (!m) return null;
      const h = parseInt(m[1],10)||0;
      const mi = parseInt(m[2],10)||0;
      const se = parseInt(m[3],10)||0;
      const ms = parseInt(pad(m[4]||'0',3),10)||0;
      return ((h*60+mi)*60+se)*1000 + ms;
    } catch(e){ return null; }
  }

  function init(){
    const video = U.$('#pp-video');
    const cur = U.$('#exp-current');
    const startEl = U.$('#exp-start');
    const endEl = U.$('#exp-end');
    const setStart = U.$('#exp-set-start');
    const setEnd = U.$('#exp-set-end');
    const resetBtn = U.$('#exp-reset');
    const saveBtn = U.$('#exp-next');
    const status = U.$('#exp-status');

    function updateCurrent(){ try{ if (cur) cur.textContent = formatMs((video.currentTime||0)*1000); }catch(e){} }
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

    // Buttons
    if (setStart) setStart.addEventListener('click', function(){ if (!video) return; startEl.value = formatMs((video.currentTime||0)*1000); });
    if (setEnd) setEnd.addEventListener('click', function(){ if (!video) return; endEl.value = formatMs((video.currentTime||0)*1000); });
    if (resetBtn) resetBtn.addEventListener('click', function(){ if (!video) return; startEl.value='00:00:00.000'; endEl.value = formatMs((isFinite(video.duration)? video.duration*1000 : 0)); });
    if (saveBtn) saveBtn.addEventListener('click', function(){
      try{
        const vp = (Preproc.State && Preproc.State.videoPath) || '';
        if (!vp){ alert('Select a video first.'); return; }
        const s = (startEl && startEl.value || '').trim();
        const e = (endEl && endEl.value || '').trim();
        if (parseTime(s) == null || parseTime(e) == null){ alert('Enter times as HH:MM:SS.mmm'); return; }
        if (status) status.textContent = 'Saving…';
        fetch('/api/preproc/timing', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ video: vp, start_time: s, end_time: e }) })
          .then(r=>r.json().then(d=>({ok:!d.error, d, status:r.statusText})))
          .then(res=>{ if (status) status.textContent = res.ok ? 'Saved' : ('Error: ' + (res.d && res.d.error || res.status)); try{ document.dispatchEvent(new CustomEvent('preproc:go-next', { detail:{ from: 'timing' } })); }catch(e){} })
          .catch(err=>{ if (status) status.textContent = 'Error: ' + err; });
      } catch(e){}
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
