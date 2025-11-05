// Save dialog: select days in group, compute backgrounds for others, and save finals
(function(){
  if (!window.Preproc) window.Preproc = {};
  const Preproc = window.Preproc;

  function $(sel, el){ return (el||document).querySelector(sel); }
  function el(tag, props){ const e=document.createElement(tag); if(props){ Object.assign(e, props); } return e; }

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
    const ov = el('div'); ov.className='overlay'; ov.id='pp-save-overlay';
    const panel = el('div'); panel.className='overlay-panel';
    const head = el('div'); head.className='overlay-header';
    const title = el('h3'); title.textContent='Save Preproc to Days';
    const close = el('button'); close.className='icon-btn'; close.innerHTML='✕';
    close.addEventListener('click', ()=>{ ov.remove(); });
    head.appendChild(title); head.appendChild(close);
    const body = el('div');
    body.innerHTML = `
      <div class="muted" style="margin-bottom:8px">Select days in the same group to save preproc. Backgrounds will be computed per day using current settings.</div>
      <div id="pp-save-group" class="muted" style="margin:6px 0">Group: —</div>
      <div id="pp-save-list" style="max-height:220px; overflow:auto; border:1px solid var(--border); border-radius:8px; padding:6px"></div>
      <div style="display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap">
        <button class="btn mini" id="pp-save-all">All</button>
        <button class="btn mini" id="pp-save-none">None</button>
        <span class="muted" id="pp-save-count"></span>
      </div>
      <div class="progress" style="margin-top:10px"><div class="bar" id="pp-save-bar" style="width:0%"></div></div>
      <div class="muted" id="pp-save-status" style="margin-top:6px"></div>
      <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:10px">
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
        const hv = document.createElement('video'); hv.muted=true; hv.preload='auto'; hv.playsInline=true; hv.crossOrigin='anonymous';
        const src = document.createElement('source'); src.src = '/media?path=' + encodeURIComponent(videoPath); src.type='video/mp4'; hv.appendChild(src);
        document.body.appendChild(hv); hv.style.position='fixed'; hv.style.left='-9999px'; hv.style.top='0'; hv.style.visibility='hidden';
        await new Promise(res=>{ hv.addEventListener('loadedmetadata', res, {once:true}); hv.load(); });
        const maxW = 640; const scale = Math.min(1, maxW / (hv.videoWidth||maxW));
        const w = Math.max(1, Math.round((hv.videoWidth||maxW)*scale));
        const h = Math.max(1, Math.round((hv.videoHeight||maxW*9/16)*scale));
        const work = document.createElement('canvas'); work.width=w; work.height=h; const wctx=work.getContext('2d');
        function randTimes(cnt, dur){ const s=new Set(); for(let i=0;i<cnt*2 && s.size<cnt;i++){ s.add(Math.random()*Math.max(0.1, dur-0.2)+0.1); } return Array.from(s).slice(0,cnt).sort((a,b)=>a-b); }
        const times = randTimes(n, hv.duration||10);
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
    const total = selected.length * 3; let done=0;
    function step(){ done++; if(bar) bar.style.width = Math.round(100*done/Math.max(1,total))+'%'; }
    for (let i=0;i<selected.length;i++){
      const path = selected[i]; const isCurrent = String(path) === String(vp);
      status.textContent = 'Preparing '+(path.split('/').pop()||path)+'…';
      // 1) Background for non-current
      if (!isCurrent){ await computeBackgroundFor(path, params.n, params.q); }
      step();
      // 2) Copy arena + regions
      try{ await postJSON('/api/preproc/arena', { video: path, arena }); }catch(e){}
      try{ await postJSON('/api/preproc/regions', { video: path, regions }); }catch(e){}
      step();
      // 3) Save final
      try{ await postJSON('/api/preproc/save_final', { video: path }); }catch(e){}
      step();
    }
    status.textContent = 'Done';
  }

  async function open(){
    const ov = buildOverlay();
    const listEl = $('#pp-save-list'); const groupEl = $('#pp-save-group'); const countEl = $('#pp-save-count');
    const vp = (Preproc.State && Preproc.State.videoPath) || '';
    if (!vp){ groupEl.textContent='No video selected'; return; }
    const grp = await findGroupDays(vp);
    const items = (grp && grp.items) || [];
    const pat = grp && grp.pattern || null;
    groupEl.textContent = pat ? (pat.prefix + 'XX' + pat.suffix) : '—';
    function render(){
      listEl.innerHTML='';
      let chosen=0;
      items.forEach(it=>{
        const row = el('label'); row.style.display='flex'; row.style.alignItems='center'; row.style.gap='8px'; row.style.padding='4px 2px';
        const cb = el('input', { type:'checkbox' }); cb.checked = true; cb.disabled = (it.path === vp);
        if (cb.checked) chosen++;
        const name = el('div'); name.textContent = it.name + (it.path===vp ? ' (current)' : ''); name.style.flex='1';
        row.appendChild(cb); row.appendChild(name); listEl.appendChild(row);
        it._cb = cb;
        cb.addEventListener('change',()=>{ chosen = items.filter(x=> x._cb && x._cb.checked).length; countEl.textContent = chosen + ' selected'; });
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

