// Preproc shared namespace and utilities
(function(){
  if (!window.Preproc) window.Preproc = {};
  const Preproc = window.Preproc;

  Preproc.State = {
    videoPath: '',
    marking: false,
    tl: null,
    br: null,
    hasBackground: false,
  };

  Preproc.Util = {
    $(sel, el){ return (el||document).querySelector(sel); },
    showPane(name, panes){
      Object.keys(panes).forEach(k => { if (panes[k]) panes[k].style.display = (k===name?'':'none'); });
    },
    setActiveTab(name, tabs){
      Object.keys(tabs).forEach(k => { if (tabs[k]) tabs[k].classList.remove('primary'); });
      if (tabs[name]) tabs[name].classList.add('primary');
    },
    clamp(v, a, b){ return Math.max(a, Math.min(b, v)); },
  };
})();

