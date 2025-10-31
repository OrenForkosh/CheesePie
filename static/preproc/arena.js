// Arena tab: marking and overlay
(function(){
  if (!window.Preproc) window.Preproc = {};
  const { State, Util } = window.Preproc;

  function drawOverlay(ctx){
    try{
      const overlay = ctx.overlay;
      const v = ctx.video;
      const g = overlay.getContext('2d');
      g.clearRect(0,0,overlay.width, overlay.height);
      const rect = v.getBoundingClientRect();
      overlay.width = rect.width; overlay.height = rect.height;
      if (!(State.tl && (State.br||ctx._hoverBR))) return;
      const vw = v.videoWidth||0, vh = v.videoHeight||0;
      if (!vw || !vh) return;
      const scaleX = rect.width / vw;
      const scaleY = rect.height / vh;
      const br = State.br || ctx._hoverBR;
      const x = State.tl.x * scaleX;
      const y = State.tl.y * scaleY;
      const w = (br.x - State.tl.x) * scaleX;
      const h = (br.y - State.tl.y) * scaleY;
      g.strokeStyle = '#4f8cff'; g.lineWidth = 2; g.strokeRect(x, y, w, h);
    } catch(e) {}
  }

  function handleClick(ctx, ev){
    if (!State.marking) return;
    const overlay = ctx.overlay;
    const r = overlay.getBoundingClientRect();
    const v = ctx.video;
    const px = Util.clamp(Math.round((ev.clientX - r.left) / r.width * (v.videoWidth||1)), 0, (v.videoWidth||1)-1);
    const py = Util.clamp(Math.round((ev.clientY - r.top) / r.height * (v.videoHeight||1)), 0, (v.videoHeight||1)-1);
    if (!State.tl){ State.tl = {x:px, y:py}; State.br = null; ctx._hoverBR = null; }
    else if (!State.br){ State.br = {x: Math.max(px, State.tl.x+1), y: Math.max(py, State.tl.y+1)}; }
    drawOverlay(ctx);
  }

  function handleMove(ctx, ev){
    if (!State.marking || State.br) return;
    const overlay = ctx.overlay;
    const v = ctx.video;
    const r = overlay.getBoundingClientRect();
    const px = Util.clamp(Math.round((ev.clientX - r.left) / r.width * (v.videoWidth||1)), 0, (v.videoWidth||1)-1);
    const py = Util.clamp(Math.round((ev.clientY - r.top) / r.height * (v.videoHeight||1)), 0, (v.videoHeight||1)-1);
    ctx._hoverBR = { x: Math.max(px, (State.tl?State.tl.x:0)+1), y: Math.max(py, (State.tl?State.tl.y:0)+1) };
    drawOverlay(ctx);
  }

  function toggleMark(ctx){
    State.marking = !State.marking;
    if (ctx.markBtn){
      if (State.marking){ ctx.markBtn.classList.add('primary'); ctx.markBtn.textContent = 'Marking…'; if (ctx.status) ctx.status.textContent = 'Click top-left then bottom-right'; }
      else { ctx.markBtn.classList.remove('primary'); ctx.markBtn.textContent = 'Mark'; if (ctx.status) ctx.status.textContent=''; }
    }
    ctx.overlay.style.pointerEvents = State.marking ? 'auto' : 'none';
    if (State.marking){ State.tl = null; State.br = null; ctx._hoverBR = null; }
    drawOverlay(ctx);
  }

  function init(ctx){
    try{
      ctx.overlay.addEventListener('click', ev => handleClick(ctx, ev));
      ctx.overlay.addEventListener('mousemove', ev => handleMove(ctx, ev));
      if (ctx.markBtn) ctx.markBtn.addEventListener('click', () => toggleMark(ctx));
      window.addEventListener('resize', () => drawOverlay(ctx));
      ctx.video.addEventListener('loadedmetadata', () => drawOverlay(ctx));
      drawOverlay(ctx);
    } catch(e) {}
    return { drawOverlay: () => drawOverlay(ctx) };
  }

  window.Preproc.Arena = { init };
})();

