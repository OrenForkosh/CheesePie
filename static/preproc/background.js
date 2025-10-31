// Background tab (minimal wiring to avoid script blockers)
(function(){
  if (!window.Preproc) window.Preproc = {};
  function init(ctx){
    try{
      var runBtn = document.getElementById('bg-run');
      var saveBtn = document.getElementById('bg-save');
      var status = document.getElementById('bg-status');
      if (runBtn) runBtn.addEventListener('click', function(){ if (status) status.textContent = 'Background computation not implemented in this refactor yet.'; });
      if (saveBtn) saveBtn.addEventListener('click', function(){ if (status) status.textContent = 'Use previous version for full background save.'; });
    } catch(e) {}
    return {};
  }
  window.Preproc.Background = { init };
})();

