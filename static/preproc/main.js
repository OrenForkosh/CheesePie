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
      save: U.$('#pane-save')
    };
    var tabs = {
      arena: U.$('#tab-arena'),
      background: U.$('#tab-background'),
      regions: U.$('#tab-regions'),
      colors: U.$('#tab-colors'),
      save: U.$('#tab-save')
    };

    function switchTab(name){
      U.showPane(name, panes);
      U.setActiveTab(name, tabs);
      overlay.style.pointerEvents = (name === 'arena' && S.marking) ? 'auto' : 'none';
    }

    if (tabs.arena) tabs.arena.addEventListener('click', function(){ switchTab('arena'); });
    if (tabs.background) tabs.background.addEventListener('click', function(){ switchTab('background'); });
    if (tabs.regions) tabs.regions.addEventListener('click', function(){ switchTab('regions'); });
    if (tabs.colors) tabs.colors.addEventListener('click', function(){ switchTab('colors'); });
    if (tabs.save) tabs.save.addEventListener('click', function(){ switchTab('save'); });

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

    // Initialize modules
    var arena = Preproc.Arena && Preproc.Arena.init({ video: v, overlay: overlay, markBtn: markBtn, status: status });
    if (Preproc.Background) Preproc.Background.init({});
    if (Preproc.Regions) Preproc.Regions.init({});
    if (Preproc.Colors) Preproc.Colors.init({});

    switchTab('arena');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

