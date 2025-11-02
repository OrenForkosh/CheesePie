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

    function setStatus(msg){ if (status) status.textContent = msg; }

    function randTimes(n, dur){
      var s = new Set();
      for (var i=0;i<n*2 && s.size<n;i++){
        s.add(Math.random()*Math.max(0.1, dur-0.2)+0.1);
      }
      return Array.from(s).slice(0,n).sort(function(a,b){return a-b;});
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
        var work = document.createElement('canvas'); work.width=w; work.height=h; var wctx=work.getContext('2d');
        var times = randTimes(n, hv.duration||v.duration||10);
        var frames = [];
        var origT = (v && v.currentTime) || 0;
        for (let i=0;i<times.length;i++){
          await new Promise(function(resolve){
            function onSeeked(){ try{ wctx.drawImage(hv, 0, 0, w, h); var id=wctx.getImageData(0,0,w,h); frames.push(id.data.slice(0)); }catch(e){} hv.removeEventListener('seeked', onSeeked); resolve(); }
            hv.addEventListener('seeked', onSeeked);
            try{ hv.currentTime = Math.min(Math.max(0.05, times[i]), Math.max(0.05, (hv.duration||10)-0.05)); }catch(e){ hv.removeEventListener('seeked', onSeeked); resolve(); }
          });
          // Show the sampled frame in the preview panel
          try{
            if (v){
              var tShow = Math.min(Math.max(0.05, times[i]), Math.max(0.05, (v.duration||10)-0.05));
              v.pause();
              v.currentTime = tShow;
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
              .then(function(res){ setStatus(res.ok? 'Background saved' : ('Error saving background: ' + (res.d && res.d.error || res.status))); })
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

    return { computeBackground, saveBackground };
  }

  window.Preproc.Background = { init };
})();
