(() => {
  function fmtKey(key) {
    return `<span class="kbd">${key}</span>`;
  }

  function getKeyboardCfg() {
    return ((window.CHEESEPIE || {}).annotator || {}).keyboard || {};
  }

  let overlayEl = null;
  let overlayTitle = null;
  let overlayContent = null;
  let overlayClose = null;

  function ensureOverlay() {
    if (overlayEl) return true;
    overlayEl = document.getElementById("app-shortcuts-overlay");
    overlayTitle = document.getElementById("app-shortcuts-title");
    overlayContent = document.getElementById("app-shortcuts-content");
    overlayClose = document.getElementById("app-shortcuts-close");
    if (!overlayEl) return false;
    if (!overlayEl.dataset.bound) {
      overlayClose?.addEventListener("click", hideOverlay);
      overlayEl.addEventListener("click", (e) => {
        if (e.target === overlayEl) hideOverlay();
      });
      document.addEventListener("keydown", (e) => {
        if (!overlayEl || overlayEl.hidden) return;
        if (e.key === "Escape") {
          e.preventDefault();
          hideOverlay();
        }
      });
      overlayEl.dataset.bound = "1";
    }
    return true;
  }

  function showOverlay(title, items) {
    if (!ensureOverlay()) return;
    if (overlayTitle) overlayTitle.textContent = title || "Keyboard Shortcuts";
    if (overlayContent) overlayContent.innerHTML = items.join("");
    overlayEl.hidden = false;
  }

  function hideOverlay() {
    if (!overlayEl) return;
    overlayEl.hidden = true;
  }

  function isOverlayOpen() {
    return !!(overlayEl && !overlayEl.hidden);
  }

  function renderPlaybackShortcuts(options = {}) {
    const cfg = getKeyboardCfg();
    const jumps = cfg.jump_seconds || { left: 5, right: 5, shift: 1, alt: 0.5 };
    const frames = cfg.frame_step_keys || { prev: '[', next: ']' };
    const items = [];
    if (options.includePlay !== false) {
      items.push(`<div class="shortcut-item">${fmtKey('Space')} <span>Play / Pause</span></div>`);
    }
    items.push(`<div class="shortcut-item">${fmtKey('←')} <span>Jump back ${jumps.left || 0}s</span></div>`);
    items.push(`<div class="shortcut-item">${fmtKey('→')} <span>Jump forward ${jumps.right || 0}s</span></div>`);
    if (jumps.shift) {
      items.push(`<div class="shortcut-item">${fmtKey('Shift + ←/→')} <span>Jump ${jumps.shift}s</span></div>`);
    }
    if (jumps.alt) {
      items.push(`<div class="shortcut-item">${fmtKey('Alt + ←/→')} <span>Jump ${jumps.alt}s</span></div>`);
    }
    items.push(`<div class="shortcut-item">${fmtKey(frames.prev || '[')} <span>Previous frame</span></div>`);
    items.push(`<div class="shortcut-item">${fmtKey(frames.next || ']')} <span>Next frame</span></div>`);
    if (options.includeHelp !== false) {
      items.push(`<div class="shortcut-item">${fmtKey('?')} <span>Show shortcuts</span></div>`);
    }
    return items;
  }

  window.CheesePieShortcuts = {
    renderPlaybackShortcuts,
    showOverlay,
    hideOverlay,
    isOverlayOpen,
  };
})();
