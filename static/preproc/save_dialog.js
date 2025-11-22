// Save dialog: select days in group, compute backgrounds for others, and save finals
(function(){
  if (!window.Preproc) window.Preproc = {};
  const Preproc = window.Preproc;

  function $(sel, el){ return (el||document).querySelector(sel); }
  function el(tag, props){ const e=document.createElement(tag); if(props){ Object.assign(e, props); } return e; }

  // (toast removed per request)

  function parseDayPattern(name){
    try{
      const m = name.match(/^(.*?\.day)(\d+)(\..*)$/i);
      if (!m) return null;
      return { prefix: m[1], day: m[2], suffix: m[3] };
    } catch(e){ return null; }
  }

  async function listSiblings(dir){
    try{
      const r = await fetch('/api/list?dir=' + encodeURIComponent(dir));
      const d = await r.json();
      return Array.isArray(d.items) ? d.items : [];
    }catch(e){ return []; }
  }
  async function fileInfo(path){
    try{
      const r = await fetch('/api/fileinfo?path=' + encodeURIComponent(path));
      const d = await r.json();
      return d || {};
    }catch(e){ return {}; }
  }

  async function findGroupDays(curPath){
    const info = await fileInfo(curPath);
    const parent = info && info.parent || '';
    const name = info && info.name || '';
    const pat = parseDayPattern(name);
    if (!pat || !parent) return [];
    const siblings = await listSiblings(parent);
    const out = [];
    siblings.forEach(it=>{
      if (!it || !it.name || !it.path || it.is_dir) return;
      const p = parseDayPattern(it.name);
      if (!p) return;
      if (p.prefix === pat.prefix && p.suffix === pat.suffix){
        const n = parseInt(p.day, 10) || 0;
        out.push({ name: it.name, path: it.path, day: n });
      }
    });
    out.sort((a,b)=> a.day - b.day);
    return { items: out, pattern: pat };
  }

  function buildOverlay(){
    const ov = el('div'); ov.id='pp-save-overlay'; ov.className='pp-save-overlay';
    const panel = el('div'); panel.className='pp-save-panel';
    const head = el('div'); head.className='pp-save-header';
    const title = el('div'); title.className='pp-save-title'; title.textContent='Save Preproc to Days';
    const close = el('button'); close.className='pp-save-close icon-btn'; close.innerHTML='✕'; close.addEventListener('click', ()=>{ ov.remove(); });
    head.appendChild(title); head.appendChild(close);
    const body = el('div'); body.className='pp-save-body';
    body.innerHTML = `
      <div class="muted pp-save-intro">Select days in the same group to save preproc. Backgrounds will be computed per day using current settings.</div>
      <div id="pp-save-group" class="muted pp-save-group">Group: —</div>
      <div id="pp-save-list" class="pp-save-list"></div>
      <div class="pp-save-controls">
        <div class="left">
          <button class="btn mini" id="pp-save-all">All</button>
          <button class="btn mini" id="pp-save-none">None</button>
        </div>
        <span class="muted" id="pp-save-count"></span>
      </div>
      <div class="pp-save-progress"><div class="bar" id="pp-save-bar"></div></div>
      <div class="muted pp-save-status" id="pp-save-status"></div>
      <div class="pp-save-actions">
        <button class="btn" id="pp-save-cancel">Cancel</button>
        <button class="btn success" id="pp-save-run">Save</button>
      </div>
    `;
    panel.appendChild(head); panel.appendChild(body); ov.appendChild(panel);
    document.body.appendChild(ov);
    return ov;
  }

  function bgParams(){
    try{
      const n = parseInt(($('#bg-frames')||{}).value||'25',10) || 25;
      const q = parseInt(($('#bg-quant')||{}).value||'50',10) || 50;
      return { n, q };
    }catch(e){ return { n:25, q:50 }; }
  }

  async function computeBackgroundFor(videoPath, n, q){
    // Compute background using hidden video element
    return new Promise(async (resolve)=>{
      try{
        // Try to fetch timing window for this video
        let startSec = 0, endSec = null;
        try{
          const rs = await fetch('/api/preproc/state?video=' + encodeURIComponent(videoPath));
          const ds = await rs.json();
          const meta = ds && ds.meta || {};
          function parseTimeText(s){ try{ const str=String(s||'').trim(); const m=str.match(/^(\d+)(?::(\d+))?(?::(\d+))?(?:\.(\d{1,3}))?$/); if(!m) return null; let h=0,mi=0,se=0,ms=0; if(m[3]!=null){h=parseInt(m[1],10)||0;mi=parseInt(m[2],10)||0;se=parseInt(m[3],10)||0;} else if(m[2]!=null){mi=parseInt(m[1],10)||0;se=parseInt(m[2],10)||0;} else { se=parseFloat(m[1])||0; } if(m[4]!=null){ ms=parseInt((m[4]+'').padEnd(3,'0'),10)||0; } return h*3600+mi*60+se+(ms/1000); }catch(e){ return null; } }
          const ps = parseTimeText(meta && meta.start_time);
          const pe = parseTimeText(meta && meta.end_time);
          if (ps!=null) startSec = ps;
          if (pe!=null) endSec = pe;
        }catch(e){}
        const hv = document.createElement('video'); hv.muted=true; hv.preload='auto'; hv.playsInline=true; hv.crossOrigin='anonymous';
        const src = document.createElement('source'); src.src = '/media?path=' + encodeURIComponent(videoPath); src.type='video/mp4'; hv.appendChild(src);
        document.body.appendChild(hv); hv.style.position='fixed'; hv.style.left='-9999px'; hv.style.top='0'; hv.style.visibility='hidden';
        await new Promise(res=>{ hv.addEventListener('loadedmetadata', res, {once:true}); hv.load(); });
        const maxW = 640; const scale = Math.min(1, maxW / (hv.videoWidth||maxW));
        const w = Math.max(1, Math.round((hv.videoWidth||maxW)*scale));
        const h = Math.max(1, Math.round((hv.videoHeight||maxW*9/16)*scale));
        const work = document.createElement('canvas'); work.width=w; work.height=h; const wctx=work.getContext('2d');
        function randTimesInRange(cnt, lo, hi){ const out=new Set(); lo=Math.max(0,Number(lo||0)); hi=Math.max(lo,Number(hi||0)); const span=Math.max(0,hi-lo); if(span<=0) return [Math.max(0.05, lo)]; for(let i=0;i<cnt*4 && out.size<cnt;i++){ let t=lo+Math.random()*span; t=Math.max(lo+0.05, Math.min(hi-0.05, t)); out.add(t);} return Array.from(out).slice(0,cnt).sort((a,b)=>a-b);} 
        // Clamp timing window to duration
        let lo = startSec||0; let hi = (endSec!=null? endSec : (hv.duration||0));
        lo = Math.max(0, Math.min(lo, Math.max(0, hv.duration||0)));
        hi = Math.max(lo+0.001, Math.min(hi, Math.max(0, hv.duration||0)));
        const times = randTimesInRange(n, lo, hi);
        const frames = [];
        for (let i=0;i<times.length;i++){
          await new Promise(res=>{ const onSeeked=()=>{ try{ wctx.drawImage(hv,0,0,w,h); const id=wctx.getImageData(0,0,w,h); frames.push(id.data.slice(0)); }catch(e){} hv.removeEventListener('seeked', onSeeked); res(); }; hv.addEventListener('seeked', onSeeked); try{ hv.currentTime = Math.min(Math.max(0.05, times[i]), Math.max(0.05, (hv.duration||10)-0.05)); }catch(e){ hv.removeEventListener('seeked', onSeeked); res(); } });
        }
        if (!frames.length){ document.body.removeChild(hv); resolve(null); return; }
        const out = new Uint8ClampedArray(w*h*4); const K=frames.length; const qi=Math.max(0, Math.min(K-1, Math.round((q/100)*(K-1))));
        for(let i=0,p=0;i<w*h;i++,p+=4){ const r=new Uint8Array(K), g=new Uint8Array(K), b=new Uint8Array(K); for(let k=0;k<K;k++){ const f=frames[k]; r[k]=f[p]; g[k]=f[p+1]; b[k]=f[p+2]; } r.sort(); g.sort(); b.sort(); out[p]=r[qi]; out[p+1]=g[qi]; out[p+2]=b[qi]; out[p+3]=255; }
        const canvas=document.createElement('canvas'); canvas.width=w; canvas.height=h; canvas.getContext('2d').putImageData(new ImageData(out,w,h),0,0);
        const dataUrl = canvas.toDataURL('image/png');
        document.body.removeChild(hv);
        // Persist to backend for target video
        await fetch('/api/preproc/background',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ video: videoPath, image: dataUrl, nframes: n, quantile: q }) });
        resolve(dataUrl);
      }catch(e){ resolve(null); }
    });
  }

  async function postJSON(url, body){ const r=await fetch(url,{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)}); return r.json().then(d=>({ok:!d.error, d, status:r.statusText})); }

  function currentArena(){
    try{
      const S = Preproc.State||{}; const tl=S.tl, br=S.br; if(!(tl&&br)) return null;
      const getInt=(id)=>{ const el=$(id); const v=el && parseInt(el.value,10); return (isFinite(v)? v : null); };
      const cols=getInt('#grid-cols'), rows=getInt('#grid-rows'), wcm=getInt('#arena-wcm'), hcm=getInt('#arena-hcm');
      const out={ tl:{x:tl.x,y:tl.y}, br:{x:br.x,y:br.y} };
      if (cols!=null) out.grid_cols=cols; if (rows!=null) out.grid_rows=rows; if (wcm!=null) out.width_in_cm=wcm; if (hcm!=null) out.height_in_cm=hcm;
      return out;
    }catch(e){ return null; }
  }
  function currentRegions(){ try{ const rm = (Preproc.__regions && Preproc.__regions.regions) ? Preproc.__regions.regions : {}; return rm || {}; }catch(e){ return {}; } }

  async function runSave(selected){
    const ov = $('#pp-save-overlay'); const bar=$('#pp-save-bar'); const status=$('#pp-save-status');
    const vp = (Preproc.State && Preproc.State.videoPath) || '';
    const arena = currentArena(); const regions = currentRegions();
    if (!vp || !arena){ status.textContent='Mark the arena first'; return; }
    const params = bgParams();
    const startVal = ($('#exp-start') && $('#exp-start').value || '').trim();
    const endVal = ($('#exp-end') && $('#exp-end').value || '').trim();
    // Steps per file: timing + background + (arena+regions) + save_final = 4 steps
    const total = Math.max(1, selected.length * 4); let done=0;
    function step(){ done++; if(bar) bar.style.width = Math.round(100*done/Math.max(1,total))+'%'; }
    for (let i=0;i<selected.length;i++){
      const path = selected[i]; const isCurrent = String(path) === String(vp);
      status.textContent = 'Preparing '+(path.split('/').pop()||path)+'…';
      const row = document.querySelector(`label[data-path="${CSS.escape(path)}"]`);
      const img = row && row.querySelector('img.pp-save-preview');
      const times = row && row.querySelector('.pp-save-times');
      // 1) Set timing first (required before background)
      try{ await postJSON('/api/preproc/timing', { video: path, start_time: startVal, end_time: endVal }); if (times) times.textContent = `Start: ${startVal || '—'}  End: ${endVal || '—'}`; }catch(e){}
      step();
      // 2) Background for non-current (and show preview)
      if (!isCurrent){
        const bg = await computeBackgroundFor(path, params.n, params.q);
        if (img && bg) img.src = bg;
      } else {
        // For current video, if background canvas exists, show it
        try{
          const bgCanvas = document.getElementById('bg-canvas');
          if (img && bgCanvas && bgCanvas.width && bgCanvas.height){ img.src = bgCanvas.toDataURL('image/png'); }
        }catch(e){}
      }
      step();
      // 3) Copy arena + regions
      try{ await postJSON('/api/preproc/arena', { video: path, arena }); }catch(e){}
      try{ await postJSON('/api/preproc/regions', { video: path, regions }); }catch(e){}
      step();
      // 4) Save final
      try{ await postJSON('/api/preproc/save_final', { video: path }); }catch(e){}
      step();
    }
    status.textContent = 'Done';
    if (bar) bar.style.width = '100%';
    // Replace footer buttons with a single OK to let user review previews
    try {
      const runBtn = document.getElementById('pp-save-run');
      const cancelBtn = document.getElementById('pp-save-cancel');
      const footer = runBtn ? runBtn.parentNode : (cancelBtn ? cancelBtn.parentNode : null);
      if (runBtn) runBtn.style.display = 'none';
      if (cancelBtn) cancelBtn.style.display = 'none';
      if (footer && !document.getElementById('pp-save-ok')){
        const ok = document.createElement('button');
        ok.id = 'pp-save-ok';
        ok.className = 'btn primary';
        ok.textContent = 'OK';
        ok.addEventListener('click', function(){
          const ovNow = document.getElementById('pp-save-overlay');
          if (ovNow && ovNow.parentNode) ovNow.parentNode.removeChild(ovNow);
        });
        footer.appendChild(ok);
      }
    } catch(e){}
    // No toast; user reviews previews then clicks OK
  }

  async function open(){
    const ov = buildOverlay();
    const listEl = $('#pp-save-list'); const groupEl = $('#pp-save-group'); const countEl = $('#pp-save-count');
    const vp = (Preproc.State && Preproc.State.videoPath) || '';
    // Determine preview placeholder aspect ratio from current video's background canvas if available
    let prevW = 120;
    let prevAR = 4/3; // default aspect ratio
    try {
      const bgCanvas = document.getElementById('bg-canvas');
      if (bgCanvas && bgCanvas.width && bgCanvas.height){
        prevAR = Math.max(0.01, (bgCanvas.width / bgCanvas.height));
      } else {
        const pv = document.getElementById('pp-video');
        if (pv && pv.videoWidth && pv.videoHeight){ prevAR = Math.max(0.01, (pv.videoWidth / pv.videoHeight)); }
      }
    } catch(e){}
    const prevH = Math.max(1, Math.round(prevW / prevAR));
    if (!vp){ groupEl.textContent='No video selected'; return; }
    const grp = await findGroupDays(vp);
    const items = (grp && grp.items) || [];
    const pat = grp && grp.pattern || null;
    groupEl.textContent = pat ? (pat.prefix + 'XX' + pat.suffix) : '—';
    function render(){
      listEl.innerHTML='';
      let chosen=0;
      items.forEach(it=>{
        const row = el('label'); row.dataset.path = it.path; row.className='pp-save-row';
        const cb = el('input', { type:'checkbox' }); cb.checked = true; cb.disabled = (it.path === vp);
        if (cb.checked) chosen++;
        const metaWrap = el('div'); metaWrap.className='pp-save-meta';
        const name = el('div'); name.className='pp-save-name'; name.textContent = it.name + (it.path===vp ? ' (current)' : '');
        const times = el('div'); times.className='pp-save-times';
        try{ const s = ($('#exp-start')&&$('#exp-start').value)||''; const e = ($('#exp-end')&&$('#exp-end').value)||''; times.textContent = `Start: ${s||'—'}  End: ${e||'—'}`; }catch(e){}
        metaWrap.appendChild(name); metaWrap.appendChild(times);
        const preview = el('img'); preview.className='pp-save-preview';
        // Avoid broken-image icon and alt text; start with transparent pixel
        try{ preview.alt = ''; }catch(e){}
        try{ preview.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='; }catch(e){}
        // Reserve space with the same proportions as the background image
        preview.style.width = prevW + 'px';
        preview.style.height = prevH + 'px';
        row.appendChild(cb); row.appendChild(metaWrap); row.appendChild(preview);
        listEl.appendChild(row);
        it._cb = cb;
        cb.addEventListener('change',()=>{ chosen = items.filter(x=> x._cb && x._cb.checked).length; countEl.textContent = chosen + ' selected'; });
        // Clicking the filename opens it in Preproc
        name.addEventListener('click', function(ev){
          ev.preventDefault(); ev.stopPropagation();
          try{
            const step = localStorage.getItem('cheesepie.preproc.step') || '';
            const url = `/preproc?video=${encodeURIComponent(it.path)}${step?`&step=${encodeURIComponent(step)}`:''}`;
            window.location.href = url;
          }catch(e){ window.location.href = `/preproc?video=${encodeURIComponent(it.path)}`; }
        });
      });
      countEl.textContent = chosen + ' selected';
    }
    render();
    $('#pp-save-all').addEventListener('click', ()=>{ items.forEach(it=>{ if(!it._cb.disabled) it._cb.checked=true; }); countEl.textContent = items.filter(x=>x._cb.checked).length + ' selected'; });
    $('#pp-save-none').addEventListener('click', ()=>{ items.forEach(it=>{ if(!it._cb.disabled) it._cb.checked=false; }); countEl.textContent = items.filter(x=>x._cb.checked).length + ' selected'; });
    $('#pp-save-cancel').addEventListener('click', ()=>{ ov.remove(); });
    $('#pp-save-run').addEventListener('click', async ()=>{
      const selected = items.filter(it=> it._cb && it._cb.checked).map(it=> it.path);
      if (!selected.length){ alert('Select at least one day'); return; }
      try{ await runSave(selected); }catch(e){}
    });
  }

  Preproc.SaveDialog = { open };
})();
