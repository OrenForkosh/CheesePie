// Preproc Filters: invert (CSS) and histogram equalization (canvas)
(function(){
  if (!window.Preproc) window.Preproc = {};

  function init(ctx){
    var v = ctx.video;
    var processed = document.getElementById('pp-processed');
    var vwrap = document.getElementById('pp-vwrap');
    var chipsWrap = document.getElementById('pp-filter-chips');
    var rafId = null;
    var state = { invert: false, histeq: false };

    function stopLoop(){ if (rafId){ cancelAnimationFrame(rafId); rafId = null; } }

    function histEqFrame(){
      if (!v || !processed) { return; }
      try{
        // Match canvas to displayed size
        var rect = v.getBoundingClientRect();
        if (processed.width !== Math.max(1, Math.round(rect.width)) || processed.height !== Math.max(1, Math.round(rect.height))){
          processed.width = Math.max(1, Math.round(rect.width));
          processed.height = Math.max(1, Math.round(rect.height));
        }
        var ctx2d = processed.getContext('2d');
        if (!ctx2d) return;
        // Preserve AR: draw scaled to fit
        var vw = v.videoWidth||0, vh=v.videoHeight||0;
        ctx2d.clearRect(0,0,processed.width,processed.height);
        if (vw>0 && vh>0){
          var scale = Math.min(processed.width/vw, processed.height/vh);
          var dw = Math.round(vw*scale), dh=Math.round(vh*scale);
          var dx=Math.round((processed.width-dw)/2), dy=Math.round((processed.height-dh)/2);
          ctx2d.drawImage(v, dx, dy, dw, dh);
        } else {
          ctx2d.drawImage(v, 0, 0, processed.width, processed.height);
        }
        var img = ctx2d.getImageData(0,0,processed.width,processed.height);
        var data = img.data;
        var n = data.length/4;
        var hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256);
        for (var i=0,p=0;i<n;i++,p+=4){ hr[data[p]]++; hg[data[p+1]]++; hb[data[p+2]]++; }
        var cdr=new Uint32Array(256), cdg=new Uint32Array(256), cdb=new Uint32Array(256);
        var sr=0, sg=0, sb=0;
        for (var j=0;j<256;j++){ sr+=hr[j]; sg+=hg[j]; sb+=hb[j]; cdr[j]=sr; cdg[j]=sg; cdb[j]=sb; }
        function lutFromCdf(cdf){
          var start=0; while(start<256 && cdf[start]===0) start++;
          var total = cdf[255]-cdf[start]; if (total<=0) total=1;
          var lut=new Uint8Array(256);
          for (var k=0;k<256;k++){
            var v=(cdf[k]-cdf[start])*255/total; if (v<0)v=0; if (v>255)v=255; lut[k]=v|0;
          }
          return lut;
        }
        var lr=lutFromCdf(cdr), lg=lutFromCdf(cdg), lb=lutFromCdf(cdb);
        for (var i2=0,p2=0;i2<n;i2++,p2+=4){ data[p2]=lr[data[p2]]; data[p2+1]=lg[data[p2+1]]; data[p2+2]=lb[data[p2+2]]; }
        ctx2d.putImageData(img, 0, 0);
      } catch(e) {}
      rafId = requestAnimationFrame(histEqFrame);
    }

    function setActiveChipStates(){
      try{
        if (!chipsWrap) return;
        var btns = chipsWrap.querySelectorAll('[data-filter]');
        for (var i=0;i<btns.length;i++){
          var b = btns[i];
          var key = b.getAttribute('data-filter');
          if (key === 'invert'){
            if (state.invert) b.classList.add('active'); else b.classList.remove('active');
          } else if (key === 'histeq'){
            if (state.histeq) b.classList.add('active'); else b.classList.remove('active');
          }
        }
      }catch(e){}
    }

    function applyFilterState(){
      // Persist
      try { localStorage.setItem('cheesepie.preproc.filter.invert', state.invert ? '1' : '0'); } catch(e){}
      try { localStorage.setItem('cheesepie.preproc.filter.histeq', state.histeq ? '1' : '0'); } catch(e){}
      setActiveChipStates();
      // CSS invert on wrapper
      if (vwrap) vwrap.style.filter = state.invert ? 'invert(1)' : '';
      // Histogram equalization loop
      stopLoop();
      if (state.histeq){
        if (processed) processed.style.display = '';
        rafId = requestAnimationFrame(histEqFrame);
      } else {
        if (processed) processed.style.display = 'none';
      }
    }

    // Wire chips
    if (chipsWrap){
      chipsWrap.addEventListener('click', function(ev){
        var t = ev.target && ev.target.closest ? ev.target.closest('[data-filter]') : null;
        if (!t) return;
        var mode = t.getAttribute('data-filter');
        ev.preventDefault();
        if (mode === 'invert'){
          state.invert = !state.invert;
        } else if (mode === 'histeq'){
          state.histeq = !state.histeq;
        }
        applyFilterState();
      });
    }
    // Initialize from saved or default
    try { state.invert = (localStorage.getItem('cheesepie.preproc.filter.invert') === '1'); } catch(e){}
    try { state.histeq = (localStorage.getItem('cheesepie.preproc.filter.histeq') === '1'); } catch(e){}
    applyFilterState();

    // Expose minimal API
    return { apply: applyFilterState, stop: stopLoop };
  }

  window.Preproc.Filters = { init };
})();
