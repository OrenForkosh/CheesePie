// Background tab (minimal wiring to avoid script blockers)
(function(){
  if (!window.Preproc) window.Preproc = {};

  function init(){
    var v = document.getElementById('pp-video');
    var status = document.getElementById('bg-status');
    var canvas = document.getElementById('bg-canvas');
    var framesEl = document.getElementById('bg-frames');
    var quantEl = document.getElementById('bg-quant');
    var runBtn = document.getElementById('bg-run');
    var saveBtn = document.getElementById('bg-save');
    var exportBtn = document.getElementById('pp-export-background');

    function setStatus(msg){ if (status) status.textContent = msg; }

    function parseTimeText(s){
      try{
        var str = String(s||'').trim(); if (!str) return null;
        var m = str.match(/^(\d+)(?::(\d+))?(?::(\d+))?(?:\.(\d{1,3}))?$/);
        if (!m) return null;
        var h=0, mi=0, se=0, ms=0;
        if (m[3]!=null){ h=parseInt(m[1],10)||0; mi=parseInt(m[2],10)||0; se=parseInt(m[3],10)||0; }
        else if (m[2]!=null){ mi=parseInt(m[1],10)||0; se=parseInt(m[2],10)||0; }
        else { se=parseFloat(m[1])||0; }
        if (m[4]!=null){ ms=parseInt((m[4]+'').padEnd(3,'0'),10)||0; }
        return h*3600 + mi*60 + se + (ms/1000);
      }catch(e){ return null; }
    }
    function randTimesInRange(n, startSec, endSec){
      var out = new Set();
      var lo = Math.max(0, Number(startSec||0));
      var hi = Math.max(lo, Number(endSec||0));
      var span = Math.max(0, hi - lo);
      if (span <= 0){ return [Math.max(0.05, lo)]; }
      for (var i=0;i<n*4 && out.size<n;i++){
        var t = lo + Math.random()*span;
        t = Math.max(lo+0.05, Math.min(hi-0.05, t));
        out.add(t);
      }
      return Array.from(out).slice(0,n).sort(function(a,b){return a-b;});
    }

    async function computeBackground(){
      try{
        var n = parseInt((framesEl&&framesEl.value)||'25')||25;
        var qPct = parseInt((quantEl&&quantEl.value)||'50')||50;
        var q = Math.max(0, Math.min(100, qPct))/100;
        if (!v || !v.duration || !v.videoWidth){ setStatus('Video not ready'); return; }
        setStatus('Sampling frames…');

        var hv = document.createElement('video');
        hv.muted=true; hv.preload='auto'; hv.playsInline=true; hv.crossOrigin='anonymous';
        var src = document.createElement('source');
        src.src = v.currentSrc || v.src; src.type = 'video/mp4';
        hv.appendChild(src);
        document.body.appendChild(hv); hv.style.position='fixed'; hv.style.left='-9999px'; hv.style.top='0'; hv.style.visibility='hidden';
        await new Promise(function(res){ hv.addEventListener('loadedmetadata', res, {once:true}); hv.load(); });

        var maxW = 640; var scale = Math.min(1, maxW / (hv.videoWidth||maxW));
        var w = Math.max(1, Math.round((hv.videoWidth||maxW)*scale));
        var h = Math.max(1, Math.round((hv.videoHeight||maxW*9/16)*scale));
        var work = document.createElement('canvas'); work.width=w; work.height=h;
        // Hint to browser that we'll be calling getImageData repeatedly
        var wctx = work.getContext('2d', { willReadFrequently: true });
        // Determine timing window from Timing tab (if available)
        var startSec = 0, endSec = hv.duration||v.duration||0;
        try{
          var stEl = document.getElementById('exp-start');
          var enEl = document.getElementById('exp-end');
          var ps = parseTimeText(stEl && stEl.value);
          var pe = parseTimeText(enEl && enEl.value);
          if (ps!=null) startSec = ps;
          if (pe!=null) endSec = pe;
        }catch(e){}
        // Clamp to video duration
        try{ startSec = Math.max(0, Math.min(startSec, Math.max(0, (hv.duration||0)))); }catch(e){}
        try{ endSec = Math.max(0, Math.min(endSec, Math.max(0, (hv.duration||0)))); }catch(e){}
        if (!isFinite(startSec)) startSec = 0; if (!isFinite(endSec) || endSec<=0) endSec = hv.duration||v.duration||0;
        if (endSec <= startSec){ endSec = Math.max(startSec + 0.5, (hv.duration||0)); }
        var times = randTimesInRange(n, startSec, endSec);
        var frames = [];
        var origT = (v && v.currentTime) || 0;
        for (let i=0;i<times.length;i++){
          // Seek hidden worker video and grab pixel data
          await new Promise(function(resolve){
            function onSeeked(){
              try{
                wctx.drawImage(hv, 0, 0, w, h);
                var id=wctx.getImageData(0,0,w,h);
                frames.push(id.data.slice(0));
              }catch(e){}
              hv.removeEventListener('seeked', onSeeked);
              resolve();
            }
            hv.addEventListener('seeked', onSeeked);
            try{
              hv.currentTime = Math.min(Math.max(0.05, times[i]), Math.max(0.05, (hv.duration||10)-0.05));
            }catch(e){ hv.removeEventListener('seeked', onSeeked); resolve(); }
          });
          // Show the sampled frame in the preview panel and wait until it renders
          try{
            if (v){
              var tShow = Math.min(Math.max(0.05, times[i]), Math.max(0.05, (v.duration||10)-0.05));
              v.pause();
              await new Promise(function(resolve){
                var done = function(){
                  // Wait a couple of RAFs to ensure paint
                  try{ requestAnimationFrame(function(){ requestAnimationFrame(resolve); }); }
                  catch(e){ resolve(); }
                };
                var handler = function(){ v.removeEventListener('seeked', handler); done(); };
                try{
                  v.addEventListener('seeked', handler, { once:true });
                  if (typeof v.fastSeek === 'function') { try{ v.fastSeek(tShow); }catch(e){ v.currentTime = tShow; } }
                  else { v.currentTime = tShow; }
                }catch(e){ resolve(); }
              });
            }
          } catch(e){}
          setStatus('Sampling frames… ' + (i+1) + '/' + times.length + ' (showing)');
        }
        if (!frames.length){ setStatus('No frames captured'); return; }
        setStatus('Computing background…');
        var out = new Uint8ClampedArray(w*h*4);
        var K = frames.length; var qi = Math.max(0, Math.min(K-1, Math.round(q*(K-1))));
        for (var i=0,p=0;i<w*h;i++,p+=4){
          var r=new Uint8Array(K), g=new Uint8Array(K), b=new Uint8Array(K);
          for (var k=0;k<K;k++){ var f=frames[k]; r[k]=f[p]; g[k]=f[p+1]; b[k]=f[p+2]; }
          r.sort(); g.sort(); b.sort();
          out[p]=r[qi]; out[p+1]=g[qi]; out[p+2]=b[qi]; out[p+3]=255;
        }
        if (canvas){ canvas.width=w; canvas.height=h; var ctx2=canvas.getContext('2d'); var img=new ImageData(out,w,h); ctx2.putImageData(img,0,0); }
        try{ document.body.removeChild(hv); }catch(e){}
        // Restore original preview time
        try{ if (v){ v.currentTime = origT; } } catch(e){}
        setStatus('Background ready — saving…');
        // Persist automatically to /tmp preproc JSON
        try{
          var dataUrl = canvas ? canvas.toDataURL('image/png') : null;
          var videoPath = (window.Preproc && window.Preproc.State && window.Preproc.State.videoPath) || '';
          if (dataUrl && videoPath){
            fetch('/api/preproc/background', {
              method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({ video: videoPath, image: dataUrl, nframes: (framesEl&&framesEl.value)||n, quantile: (quantEl&&quantEl.value)||Math.round(q*100) })
            }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d, status:r.statusText}; }); })
              .then(function(res){
                setStatus(res.ok? 'Background saved' : ('Error saving background: ' + (res.d && res.d.error || res.status)));
                try{ if (res.ok){ if (window.Preproc && window.Preproc.State) window.Preproc.State.hasBackground = true; document.dispatchEvent(new CustomEvent('preproc:background-ready')); } }catch(e){}
              })
              .catch(function(e){ setStatus('Error saving background: ' + e); });
          } else {
            setStatus('Background ready');
          }
        } catch(e){ setStatus('Background ready'); }
      } catch(e){ setStatus('Error: ' + e); }
    }

    function saveBackground(){
      try{
        if (!canvas){ setStatus('No background'); return; }
        var dataUrl = canvas.toDataURL('image/png');
        var videoPath = (window.Preproc && window.Preproc.State && window.Preproc.State.videoPath) || '';
        if (!videoPath){ setStatus('No video'); return; }
        var n = parseInt((framesEl&&framesEl.value)||'25')||25;
        var qPct = parseInt((quantEl&&quantEl.value)||'50')||50;
        setStatus('Saving…');
        fetch('/api/preproc/background', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ video: videoPath, image: dataUrl, nframes: n, quantile: qPct })
        }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d, status:r.statusText}; }); })
          .then(function(res){ setStatus(res.ok? 'Saved' : ('Error: ' + (res.d && res.d.error || res.status))); })
          .catch(function(e){ setStatus('Error: ' + e); });
      } catch(e){ setStatus('Error: ' + e); }
    }

    if (runBtn) runBtn.addEventListener('click', computeBackground);
    if (saveBtn) saveBtn.addEventListener('click', saveBackground);
    if (exportBtn) exportBtn.addEventListener('click', function(){
      try{
        if (!canvas || !canvas.width || !canvas.height){ setStatus('No background'); return; }
        var dataUrl = canvas.toDataURL('image/png');
        var base = (window.Preproc && window.Preproc.State && window.Preproc.State.videoPath) || 'background';
        try{ base = (base.split('/').pop()||base).replace(/\.[^.]+$/, ''); }catch(e){}
        var a = document.createElement('a');
        a.download = base + '.background.png';
        a.href = dataUrl;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      } catch(e){ setStatus('Export failed: ' + e); }
    });

    return { computeBackground, saveBackground };
  }

  window.Preproc.Background = { init };
})();
