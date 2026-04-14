(() => {
  // Global auth-aware fetch wrapper to surface session expiry
  try {
    const origFetch = window.fetch.bind(window);
    function showAuthOverlay() {
      if (document.getElementById("auth-expired-overlay")) return;
      const ov = document.createElement("div");
      ov.id = "auth-expired-overlay";
      ov.style.position = "fixed";
      ov.style.left = "0";
      ov.style.top = "0";
      ov.style.right = "0";
      ov.style.bottom = "0";
      ov.style.background = "rgba(0,0,0,0.6)";
      ov.style.zIndex = "9999";
      ov.style.display = "flex";
      ov.style.alignItems = "center";
      ov.style.justifyContent = "center";
      const panel = document.createElement("div");
      panel.style.background = "var(--panel-bg, #fff)";
      panel.style.color = "var(--text, #111)";
      panel.style.borderRadius = "12px";
      panel.style.boxShadow = "0 4px 24px rgba(0,0,0,0.35)";
      panel.style.padding = "20px 24px";
      panel.style.minWidth = "280px";
      panel.style.maxWidth = "90%";
      panel.style.textAlign = "center";
      const h = document.createElement("div");
      h.textContent = "Session expired";
      h.style.fontSize = "18px";
      h.style.fontWeight = "700";
      h.style.marginBottom = "6px";
      const p = document.createElement("div");
      p.textContent = "Please log in again to continue.";
      p.style.marginBottom = "12px";
      p.className = "muted";
      const btn = document.createElement("a");
      btn.textContent = "Login";
      btn.className = "btn primary";
      btn.style.display = "inline-block";
      btn.href =
        "/auth/login?next=" +
        encodeURIComponent(location.pathname + location.search);
      panel.appendChild(h);
      panel.appendChild(p);
      panel.appendChild(btn);
      ov.appendChild(panel);
      document.body.appendChild(ov);
    }
    window.fetch = function (input, init) {
      return origFetch(input, init).then((resp) => {
        try {
          if (
            resp &&
            (resp.status === 401 ||
              (resp.redirected &&
                String(resp.url).indexOf("/auth/login") !== -1))
          ) {
            showAuthOverlay();
            // Reject to stop downstream handlers expecting JSON
            const err = new Error("Unauthorized");
            err.response = resp;
            throw err;
          }
        } catch (e) { }
        return resp;
      });
    };
  } catch (e) {
    /* no-op */
  }
  const $ = (sel, el = document) => el.querySelector(sel);
  const mainEl = document.getElementById("app-main");
  const cacheEl = document.getElementById("app-cache");
  const pageCache = new Map();
  let currentPage = null;
  const loadedCss = new Set();
  const loadedScripts = new Set();
  const PAGE_CSS = {
    "/browser": ["browser.css"],
    "/preproc": ["preproc.css"],
    "/annotator": ["annotator.css"],
    "/importer": ["importer.css"],
    "/calibration": ["calibration.css"],
  };
  const QUERY_SENSITIVE = new Set(["/preproc", "/annotator", "/preview"]);
  const MODAL_PAGES = new Set(["/preproc", "/annotator", "/preview"]);
  const MODULE_VIDEO_KEYS = {
    preproc: "cheesepie.preproc.video",
    annotator: "cheesepie.annotator.video",
    preview: "cheesepie.preview.video",
  };
  const pageRefreshers = {};

  function setActivePage(pathname) {
    const active = normalizePath(pathname);
    window.CHEESEPIE_ACTIVE_PAGE = active;
    try { document.body.setAttribute("data-active-page", active); } catch { }
    try { document.dispatchEvent(new CustomEvent("app:page-changed", { detail: { path: active } })); } catch { }
  }

  window.cheesepieIsActivePage = function (path) {
    try {
      const active = window.CHEESEPIE_ACTIVE_PAGE || normalizePath(window.location.pathname);
      return normalizePath(path) === normalizePath(active);
    } catch (e) {
      return true;
    }
  };

  window.cheesepieRegisterPageRefresher = function (name, fn) {
    if (!name || typeof fn !== "function") return;
    pageRefreshers[String(name)] = fn;
  };

  function refreshPage(pathname) {
    const key = normalizePath(pathname).replace("/", "") || "browser";
    const fn = pageRefreshers[key];
    if (typeof fn === "function") {
      try { fn(); } catch { }
    }
  }

  function getModuleVideo(name) {
    const key = MODULE_VIDEO_KEYS[name];
    if (!key) return "";
    try {
      return (localStorage.getItem(key) || "").trim();
    } catch {
      return "";
    }
  }

  function setModuleVideo(name, path) {
    const key = MODULE_VIDEO_KEYS[name];
    if (!key) return;
    try {
      const val = (path || "").trim();
      if (val) {
        localStorage.setItem(key, val);
      } else {
        localStorage.removeItem(key);
      }
    } catch { }
    try { document.dispatchEvent(new CustomEvent("app:module-video-changed", { detail: { name, path } })); } catch { }
  }

  window.cheesepieSetModuleVideo = setModuleVideo;

  function normalizePath(path) {
    return path === "/" ? "/browser" : path;
  }

  function getPathInfo(url) {
    const u = new URL(url, window.location.origin);
    const pathname = normalizePath(u.pathname);
    return { pathname, search: u.search, full: pathname + u.search };
  }

  function ensureCss(pathname) {
    const files = PAGE_CSS[pathname] || [];
    files.forEach((file) => {
      const href = new URL(`/static/${file}`, window.location.origin).toString();
      if (loadedCss.has(href)) return;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      document.head.appendChild(link);
      loadedCss.add(href);
    });
  }

  function primeCssCache() {
    document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
      if (link && link.href) loadedCss.add(link.href);
    });
  }

  function wrapInitialPage() {
    if (!mainEl || !cacheEl) return;
    const wrapper = document.createElement("div");
    wrapper.className = "page-frame";
    wrapper.dataset.pagePath = normalizePath(window.location.pathname);
    wrapper.dataset.pageUrl = normalizePath(window.location.pathname) + window.location.search;
    while (mainEl.firstChild) {
      wrapper.appendChild(mainEl.firstChild);
    }
    mainEl.appendChild(wrapper);
    pageCache.set(wrapper.dataset.pagePath, {
      node: wrapper,
      url: wrapper.dataset.pageUrl,
      scrollY: window.scrollY || 0,
    });
    currentPage = wrapper.dataset.pagePath;
    setActivePage(wrapper.dataset.pagePath);
    ensureCss(wrapper.dataset.pagePath);
  }

  function updateActiveTab(pathname) {
    setActivePage(pathname);
    const target = normalizePath(pathname);
    const tabs = document.querySelectorAll("nav.tabs .tab");
    tabs.forEach((tab) => tab.classList.remove("active"));
    const selectors = {
      "/browser": ".tab-browser",
      "/preproc": ".tab-preproc",
      "/annotator": ".tab-annotator",
      "/preview": ".tab-preview",
      "/importer": ".tab-importer",
      "/calibration": ".tab-calibration",
      "/tasks": ".tab-tasks",
      "/settings": ".tab-settings",
    };
    const sel = selectors[target];
    const el = sel ? document.querySelector(sel) : null;
    if (el) el.classList.add("active");
    refreshPage(pathname);
  }

  function parseFragment(html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html.trim();
    const fragment = tpl.content;
    const scripts = Array.from(fragment.querySelectorAll("script"));
    scripts.forEach((script) => script.remove());
    return { fragment, scripts };
  }

  function loadScriptTag(script) {
    return new Promise((resolve, reject) => {
      const src = script.getAttribute("src");
      if (src) {
        const abs = new URL(src, window.location.origin).toString();
        if (loadedScripts.has(abs)) {
          resolve();
          return;
        }
        const tag = document.createElement("script");
        tag.src = abs;
        if (script.type) tag.type = script.type;
        tag.async = false;
        tag.onload = () => {
          loadedScripts.add(abs);
          resolve();
        };
        tag.onerror = () => reject(new Error(`Failed to load ${abs}`));
        document.body.appendChild(tag);
      } else {
        const tag = document.createElement("script");
        if (script.type) tag.type = script.type;
        tag.textContent = script.textContent || "";
        document.body.appendChild(tag);
        document.body.removeChild(tag);
        resolve();
      }
    });
  }

  async function runScripts(scripts) {
    for (const script of scripts) {
      try {
        await loadScriptTag(script);
      } catch (e) {
        throw e;
      }
    }
  }

  // Like loadScriptTag but always re-executes even if already loaded.
  // Used for modal pages whose init() must run on every open.
  function loadScriptTagForce(script) {
    return new Promise((resolve, reject) => {
      const src = script.getAttribute("src");
      if (src) {
        const abs = new URL(src, window.location.origin).toString();
        const tag = document.createElement("script");
        tag.src = abs;
        if (script.type) tag.type = script.type;
        tag.async = false;
        tag.onload = () => { loadedScripts.add(abs); resolve(); };
        tag.onerror = () => reject(new Error(`Failed to load ${abs}`));
        document.body.appendChild(tag);
      } else {
        const tag = document.createElement("script");
        if (script.type) tag.type = script.type;
        tag.textContent = script.textContent || "";
        document.body.appendChild(tag);
        document.body.removeChild(tag);
        resolve();
      }
    });
  }

  async function runScriptsForModal(scripts) {
    for (const script of scripts) {
      try {
        await loadScriptTagForce(script);
      } catch (e) {
        throw e;
      }
    }
  }

  function cacheEntry(pathname) {
    return pageCache.get(pathname);
  }

  function showPage(pathname) {
    if (!mainEl || !cacheEl) return;
    if (currentPage && currentPage !== pathname) {
      const current = cacheEntry(currentPage);
      if (current && current.node) {
        current.scrollY = window.scrollY || 0;
        cacheEl.appendChild(current.node);
      }
    }
    const entry = cacheEntry(pathname);
    if (!entry || !entry.node) return;
    mainEl.appendChild(entry.node);
    currentPage = pathname;
    updateActiveTab(pathname);
    const scrollY = entry.scrollY || 0;
    window.scrollTo(0, scrollY);
  }

  async function fetchPartial(url, pathname, search) {
    const partialUrl = `/partials${pathname}${search || ""}`;
    const resp = await fetch(partialUrl, { headers: { "X-Requested-With": "cheesepie" } });
    if (!resp.ok) {
      throw new Error(`Failed to load ${partialUrl}`);
    }
    const html = await resp.text();
    const { fragment, scripts } = parseFragment(html);
    const wrapper = document.createElement("div");
    wrapper.className = "page-frame";
    wrapper.dataset.pagePath = pathname;
    wrapper.dataset.pageUrl = pathname + (search || "");
    wrapper.appendChild(fragment);
    pageCache.set(pathname, {
      node: wrapper,
      url: wrapper.dataset.pageUrl,
      scrollY: 0,
    });
    showPage(pathname);
    await runScripts(scripts);
    refreshPage(pathname);
  }

  function shouldSoftNavigate(url) {
    if (!mainEl || !cacheEl) return false;
    const u = new URL(url, window.location.origin);
    const pathname = normalizePath(u.pathname);
    const allowed = new Set([
      "/browser",
      "/preproc",
      "/annotator",
      "/preview",
      "/importer",
      "/calibration",
      "/tasks",
      "/settings",
    ]);
    if (!allowed.has(pathname)) return false;
    if (u.pathname.startsWith("/auth")) return false;
    return true;
  }

  function closeModuleModal() {
    const modal = document.getElementById("module-modal");
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.classList.remove("modal-open");
  }

  async function openModuleModal(pathname, search, full, opts) {
    const modal = document.getElementById("module-modal");
    const content = document.getElementById("module-modal-content");
    if (!modal || !content) { window.location.href = full; return; }
    ensureCss(pathname);
    content.innerHTML = '<div class="placeholder muted" style="padding:48px;text-align:center">Loading…</div>';
    modal.hidden = false;
    document.body.classList.add("modal-open");
    try {
      const partialUrl = `/partials${pathname}${search || ""}`;
      const resp = await fetch(partialUrl, { headers: { "X-Requested-With": "cheesepie" } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const html = await resp.text();
      const { fragment, scripts } = parseFragment(html);
      content.innerHTML = "";
      content.appendChild(fragment);
      await runScriptsForModal(scripts);
      refreshPage(pathname);
    } catch (e) {
      content.innerHTML = `<div class="muted" style="padding:48px;text-align:center">Failed to load. <a href="${full}">Open directly</a></div>`;
    }
    updateActiveTab(pathname);
    if (!opts.fromPop) {
      history.pushState({ url: full, isModal: true }, "", full);
    }
  }

  async function navigateSoft(url, opts = {}) {
    if (!shouldSoftNavigate(url)) {
      window.location.href = url;
      return;
    }
    const { pathname, search, full } = getPathInfo(url);

    // Modal pages: render in overlay, keep background page intact
    if (MODAL_PAGES.has(pathname)) {
      await openModuleModal(pathname, search, full, opts);
      return;
    }

    // Non-modal navigation: close any open modal first
    closeModuleModal();

    const existing = cacheEntry(pathname);
    if (QUERY_SENSITIVE.has(pathname) && existing && existing.url !== full) {
      window.location.href = url;
      return;
    }
    if (existing && existing.url !== full) {
      try {
        if (existing.node && existing.node.parentElement) {
          existing.node.parentElement.removeChild(existing.node);
        }
      } catch { }
      pageCache.delete(pathname);
    }
    ensureCss(pathname);
    if (existing && existing.url === full) {
      showPage(pathname);
    } else {
      try {
        await fetchPartial(url, pathname, search);
      } catch (e) {
        window.location.href = url;
        return;
      }
    }
    if (!opts.fromPop) {
      if (opts.replace) history.replaceState({ url: full }, "", full);
      else history.pushState({ url: full }, "", full);
    }
  }

  function initSoftNav() {
    if (!mainEl || !cacheEl) return;
    primeCssCache();
    wrapInitialPage();
    const nav = document.querySelector("nav.tabs");
    if (nav) {
      nav.addEventListener("click", (e) => {
        if (e.defaultPrevented) return;
        const link = e.target && e.target.closest ? e.target.closest("a.tab") : null;
        if (!link) return;
        if (link.getAttribute("aria-disabled") === "true") return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const href = link.getAttribute("href");
        if (!href || href.startsWith("#") || href.startsWith("mailto:")) return;
        if (!shouldSoftNavigate(href)) return;
        e.preventDefault();
        navigateSoft(href);
      });
    }
    window.addEventListener("popstate", () => {
      const pathname = normalizePath(window.location.pathname);
      if (MODAL_PAGES.has(pathname)) {
        // Forward navigation into a modal URL
        navigateSoft(window.location.pathname + window.location.search, { fromPop: true });
      } else {
        // Back navigation out of a modal - close it, then show the target page
        closeModuleModal();
        navigateSoft(window.location.pathname + window.location.search, { fromPop: true, replace: true });
      }
    });

    // Modal close button
    const modalCloseBtn = document.getElementById("module-modal-close");
    if (modalCloseBtn && !modalCloseBtn.dataset.bound) {
      modalCloseBtn.addEventListener("click", () => history.back());
      modalCloseBtn.dataset.bound = "1";
    }

    // Backdrop click closes modal
    const modalEl = document.getElementById("module-modal");
    if (modalEl && !modalEl.dataset.bound) {
      modalEl.addEventListener("click", (e) => {
        if (e.target === modalEl) history.back();
      });
      modalEl.dataset.bound = "1";
    }

    // Escape key closes modal (but not if the shortcuts overlay is open)
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (window.CheesePieShortcuts && window.CheesePieShortcuts.isOverlayOpen()) return;
        const m = document.getElementById("module-modal");
        if (m && !m.hidden) history.back();
      }
    });
  }
  // Global MATLAB status indicator in header
  const mlDot = $("#ml-dot");
  let listEl = $("#file-list");
  // App-level script runs on all pages; guard browser-only bits.
  let detailsEl = $("#details");
  let actionsEl = $("#actions");
  let sidebarEl = $("#sidebar");
  let searchInput = $("#search-input");
  let clearBtn = $("#clear-search");
  const themeSelect = document.querySelector("#theme-select");
  const applyThemeBtn = document.querySelector("#apply-theme");
  initSoftNav();
  window.cheesepieNavigate = function (url) { navigateSoft(url); };

  function updateLayoutVars() {
    try {
      const header = document.querySelector(".app-header");
      const footer = document.querySelector(".app-footer");
      if (header) document.documentElement.style.setProperty("--header-height", `${header.offsetHeight}px`);
      if (footer) document.documentElement.style.setProperty("--footer-height", `${footer.offsetHeight}px`);
    } catch { }
  }
  updateLayoutVars();
  let layoutTimer = null;
  window.addEventListener("resize", () => {
    if (layoutTimer) clearTimeout(layoutTimer);
    layoutTimer = setTimeout(updateLayoutVars, 120);
  });

  function refreshBrowserRefs() {
    listEl = $("#file-list");
    detailsEl = $("#details");
    actionsEl = $("#actions");
    sidebarEl = $("#sidebar");
    searchInput = $("#search-input");
    clearBtn = $("#clear-search");
  }

  let currentDir = "";
  let currentFacility = "";
  let facilityBaseDir = "";
  let facilitySourceDir = "";
  let currentSelection = null; // last focused row for range
  let selectedSet = new Set(); // of row DOM nodes
  let lastAnchorIndex = -1; // for shift range
  let debounceTimer = null;
  const LS_KEY = "cheesepie.lastDir";
  let browserFacilityBound = false;
  let desiredSelectPath = null;

  function humanSize(bytes) {
    const thresh = 1024;
    if (Math.abs(bytes) < thresh) return bytes + " B";
    const units = ["KB", "MB", "GB", "TB"];
    let u = -1;
    do {
      bytes /= thresh;
      ++u;
    } while (Math.abs(bytes) >= thresh && u < units.length - 1);
    return bytes.toFixed(1) + " " + units[u];
  }

  const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  function fmtTime(ts) {
    const d = new Date(ts * 1000);
    return Number.isNaN(d.getTime()) ? "—" : dateTimeFormatter.format(d);
  }

  function updateNavAvailability() {
    const lastVideo = localStorage.getItem("cheesepie.lastVideo");
    const disabled = !lastVideo;
    const tabs = [".tab-preproc", ".tab-annotator", ".tab-preview"];
    tabs.forEach((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        if (disabled) el.classList.add("disabled");
        else el.classList.remove("disabled");
      }
    });
  }
  // Initial check
  updateNavAvailability();

  function resolveFacilityConfig(name) {
    try {
      const cfg = window.CHEESEPIE || {};
      const facs = (cfg.importer && cfg.importer.facilities) || {};
      return name ? facs[name] : null;
    } catch (e) {
      return null;
    }
  }

  function resolveFacilityBase(name) {
    const fc = resolveFacilityConfig(name);
    return (fc && fc.output_dir) || "";
  }

  function resolveFacilitySource(name) {
    const fc = resolveFacilityConfig(name);
    return (fc && fc.source_dir) || "";
  }

  function syncFacilityBase() {
    const facilitySel = document.getElementById("app-facility");
    const name = facilitySel ? facilitySel.value : "";
    if (name) currentFacility = String(name);
    const out = resolveFacilityBase(name);
    const src = resolveFacilitySource(name);
    if (out) facilityBaseDir = out;
    facilitySourceDir = src || "";
    return { name, out, src };
  }

  function applyFacilityBase(name, opts = {}) {
    const out = resolveFacilityBase(name);
    const src = resolveFacilitySource(name);
    if (!out) return false;
    currentFacility = String(name || "");
    facilityBaseDir = out;
    facilitySourceDir = src || "";
    if (opts.setDir) {
      currentDir = out;
      persistCurrentDir(out);
    }
    if (opts.load && listEl) {
      loadList();
    }
    return true;
  }

  function setupBrowserFacilityListener() {
    if (browserFacilityBound) return;
    browserFacilityBound = true;
    document.addEventListener("app:facility-changed", function (ev) {
      try {
        const name = ev && ev.detail && ev.detail.name;
        applyFacilityBase(name, { setDir: true, load: !!listEl });
      } catch (e) { }
    });
  }

  function persistCurrentDir(dir = currentDir) {
    const next = String(dir || "").trim();
    if (!next) return;
    try {
      localStorage.setItem(LS_KEY, next);
    } catch { }
  }

  function clearSelections() {
    selectedSet.forEach((row) => row.classList.remove("active"));
    selectedSet.clear();
    currentSelection = null;
    lastAnchorIndex = -1;
  }

  function rowIndexOf(el) {
    if (!listEl) return -1;
    return Array.prototype.indexOf.call(listEl.children, el);
  }

  function selectRow(row, additive = false) {
    if (!additive) {
      clearSelections();
    }
    row.classList.add("active");
    selectedSet.add(row);
    currentSelection = row;
    lastAnchorIndex = rowIndexOf(row);
  }

  function toggleRow(row) {
    if (selectedSet.has(row)) {
      row.classList.remove("active");
      selectedSet.delete(row);
    } else {
      row.classList.add("active");
      selectedSet.add(row);
      currentSelection = row;
      lastAnchorIndex = rowIndexOf(row);
    }
  }

  function selectRange(toRow) {
    if (lastAnchorIndex < 0) {
      selectRow(toRow, false);
      return;
    }
    const toIdx = rowIndexOf(toRow);
    const [a, b] =
      lastAnchorIndex <= toIdx
        ? [lastAnchorIndex, toIdx]
        : [toIdx, lastAnchorIndex];
    clearSelections();
    for (let i = a; i <= b; i++) {
      const r = listEl.children[i];
      if (!r) continue;
      r.classList.add("active");
      selectedSet.add(r);
    }
    currentSelection = toRow;
  }

  function renderList(items) {
    if (!listEl) return;
    clearSelections();
    if (!items || items.length === 0) {
      listEl.innerHTML = '<div class="placeholder muted">No items found.</div>';
      return;
    }
    listEl.innerHTML = "";
    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "file-item";
      row.dataset.path = item.path;
      row.dataset.isdir = item.is_dir ? "1" : "0";
      const icon = document.createElement("div");
      icon.className = "icon " + (item.is_dir ? "folder" : "file");
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = item.name;
      const meta = document.createElement("div");
      meta.className = "meta";
      const size = item.is_dir ? "—" : humanSize(item.size);
      meta.textContent = `${size} · ${fmtTime(item.modified)}`;
      row.appendChild(icon);
      row.appendChild(name);
      if (!item.is_dir && (item.has_preproc || item.has_annotations)) {
        const badges = document.createElement("div");
        badges.className = "file-badges";
        if (item.has_preproc) {
          const b = document.createElement("span");
          b.className = "file-badge badge-preproc";
          b.title = "Preprocessing done";
          b.textContent = "P";
          badges.appendChild(b);
        }
        if (item.has_annotations) {
          const b = document.createElement("span");
          b.className = "file-badge badge-annot";
          b.title = "Annotations exist";
          b.textContent = "A";
          badges.appendChild(b);
        }
        row.appendChild(badges);
      }
      row.appendChild(meta);
      row.addEventListener("click", (ev) => {
        if (ev.shiftKey) {
          selectRange(row);
          updateSelectionDetails();
          return;
        }
        if (ev.metaKey || ev.ctrlKey) {
          toggleRow(row);
          updateSelectionDetails();
          return;
        }
        selectRow(row, false);
        updateSelectionDetails();
      });
      row.addEventListener("dblclick", () => {
        if (row.dataset.isdir === "1") {
          navigateToDir(row.dataset.path);
        }
      });
      listEl.appendChild(row);
    });
    if (desiredSelectPath) {
      const target = Array.from(listEl.children).find(
        (r) => r.dataset && r.dataset.path === desiredSelectPath
      );
      if (target) {
        selectRow(target, false);
        target.scrollIntoView({ block: "nearest" });
        updateSelectionDetails();
      }
      desiredSelectPath = null;
    }
  }

  function updateSelectionDetails() {
    if (!detailsEl || !actionsEl) return;
    const rows = Array.from(selectedSet);
    const placeholder = document.getElementById("details-placeholder");
    if (rows.length === 0) {
      if (placeholder) placeholder.style.display = "";
      detailsEl.innerHTML = "";
      updateActionsPanel();
      return;
    }
    if (rows.length === 1) {
      const path = rows[0].dataset.path;
      const fac = String(currentFacility || "");
      fetch(
        `/api/fileinfo?path=${encodeURIComponent(
          path
        )}&facility=${encodeURIComponent(fac)}`
      )
        .then((r) => r.json())
        .then((info) => {
          try {
            localStorage.setItem("cheesepie.lastVideo", info.path);
            updateNavAvailability();
          } catch { }
          if (!info.is_dir) {
            setModuleVideo("preproc", info.path);
            setModuleVideo("annotator", info.path);
            setModuleVideo("preview", info.path);
          }
          renderDetails(info);
          updateActionsPanel(info);
        })
        .catch(() => {
          detailsEl.innerHTML =
            '<div class="muted">Failed to load details.</div>';
          updateActionsPanel();
        });
      if (placeholder) placeholder.style.display = "none";
      return;
    }
    // Multi-selection summary
    const files = rows.filter((r) => r.dataset.isdir === "0");
    const dirs = rows.length - files.length;
    const listHtml = rows
      .slice(0, 6)
      .map((r) => {
        const name = r.dataset.path.split(/[/\\]/).pop();
        return `<div class="muted browser-summary-item">${name}</div>`;
      })
      .join("");
    detailsEl.innerHTML = `
      <div class="browser-summary">
        <div class="browser-summary-head">
          <span class="badge"><span class="dot"></span>${rows.length} selected</span>
        </div>
        <div class="detail-grid">
          <div class="key">Files</div><div>${files.length}</div>
          <div class="key">Folders</div><div>${dirs}</div>
        </div>
        <div class="browser-summary-list">${listHtml}${rows.length > 6 ? '<div class="muted browser-summary-item">…</div>' : ""
      }</div>
      </div>
    `;
    if (placeholder) placeholder.style.display = "none";
    updateActionsPanel();
  }

  function renderDetails(info) {
    if (!info || info.error) {
      detailsEl.innerHTML = `<div class="muted">${info?.error || "No details."
        }</div>`;
      return;
    }
    const kind = info.is_dir ? "Folder" : "File";
    const badge = `<span class="badge"><span class="dot"></span>${kind}</span>`;
    const size = info.is_dir ? "—" : humanSize(info.size);
    const isVideo = (info.mime || "").startsWith("video/");
    const ext = (info.ext || "").toLowerCase();
    const CFG = window.CHEESEPIE || {};
    const VISIBLE_EXTS = (CFG.browser && CFG.browser.visible_extensions) || [
      ".mp4",
      ".avi",
    ];
    const isSupportedVideo = VISIBLE_EXTS.includes(ext);
    const video = isVideo
      ? `
      <div class="video-preview">
        <video id="preview-video" controls preload="metadata">
          <source src="/media?path=${encodeURIComponent(info.path)}" type="${info.mime
      }">
          Your browser does not support the video tag.
        </video>
      </div>
      <div class="video-meta">
        <div class="key">Duration</div><div id="meta-duration">—</div>
        <div class="key">Resolution</div><div id="meta-resolution">—</div>
        <div class="key">Codec</div><div id="meta-codec">—</div>
        <div class="key">Frame rate</div><div id="meta-fps">—</div>
        <div class="key">Bitrate</div><div id="meta-bitrate">—</div>
      </div>
    `
      : "";
    updateActionsPanel(info);

    const html = `
      <div class="browser-detail-block">
        <div class="browser-summary-head">${badge}</div>
        <div class="detail-grid">
          <div class="key">Type</div><div>${info.mime || info.ext || "—"}</div>
          <div class="key">Size</div><div>${size}</div>
          <div class="key">Modified</div><div>${fmtTime(info.modified)}</div>
        </div>
        ${video}
      </div>
    `;
    detailsEl.innerHTML = html;
    const detailsPlaceholder = document.getElementById("details-placeholder");
    if (detailsPlaceholder) detailsPlaceholder.style.display = "none";
    if (isVideo) {
      setupVideoEnhancements(info);
    }

    // Wire up buttons handled in updateActionsPanel
  }

  function updateSelectedVideoPanel() {
    if (!actionsEl) return;
    if (selectedSet && selectedSet.size > 0) return;
    const ph = document.getElementById("actions-placeholder");
    const modules = [
      { label: "Preproc", key: "preproc" },
      { label: "Annotator", key: "annotator" },
      { label: "Preview", key: "preview" },
    ];
    const rows = modules
      .map((m) => {
        const v = getModuleVideo(m.key);
        const fname = v ? v.split(/[/\\]/).pop() : "";
        return `<div class="mod-row">
          <div class="mod-label">${m.label}</div>
          <div class="mod-file${fname ? "" : " muted"}" title="${v || ""}">${fname || "—"}</div>
        </div>`;
      })
      .join("");
    if (ph) ph.style.display = "none";
    actionsEl.innerHTML = `<div class="mod-state"><div class="mod-heading">Active files</div>${rows}</div>`;
  }

  function updateActionsPanel(currentInfo) {
    if (!actionsEl) return;
    const rows = Array.from(selectedSet);
    const placeholder = document.getElementById("actions-placeholder");
    const CFG = window.CHEESEPIE || {};
    const VISIBLE_EXTS = (CFG.browser && CFG.browser.visible_extensions) || [
      ".mp4",
      ".avi",
    ];
    // If multi-select > 1, show batch actions (Track/Preview) and Clear selection
    const selFiles = rows.filter((r) => r.dataset.isdir === "0");
    if (selFiles.length > 1) {
      actionsEl.innerHTML = `
        <div class="browser-action-stack">
          <div class="browser-action-toolbar">
            <button class="btn mini" id="clear-selection">Clear</button>
            <span class="muted">${rows.length} selected</span>
          </div>
          <div class="browser-action-buttons">
            <button class="btn themed-track" id="act-track">Track</button>
            <button class="btn themed-preview" id="act-preview">Preview</button>
          </div>
        </div>
      `;
      if (placeholder) placeholder.style.display = "none";
      const clearBtn = document.getElementById("clear-selection");
      clearBtn?.addEventListener("click", () => {
        clearSelections();
        updateSelectionDetails();
      });
      const trackBtn = document.getElementById("act-track");
      if (trackBtn) {
        trackBtn.addEventListener("click", () => {
          const files = selFiles.map((r) => r.dataset.path);
          startTracking(files);
        });
      }
      return;
    }
    // Single selection: keep Annotate for supported video
    if (currentInfo) {
      const isVideo = (currentInfo.mime || "").startsWith("video/");
      const ext = (currentInfo.ext || "").toLowerCase();
      const isSupportedVideo = VISIBLE_EXTS.includes(ext);
      const topBar = `
        <div class="browser-action-toolbar">
          <button class="btn mini" id="clear-selection">Clear</button>
          <span class="muted">1 selected</span>
        </div>`;
      const annotatePart = isSupportedVideo
        ? `<button class=\"btn themed-annotator\" id=\"open-annotator\" title=\"Annotate selected video\">Annotate</button>`
        : isVideo
          ? `<div class=\"muted browser-action-note\">Only ${VISIBLE_EXTS.join(
            ", "
          )} videos can be opened in the Annotator for now.</div>`
          : "";
      const preprocPart = `<button class=\"btn themed-preproc\" id=\"act-preproc\">Preproc</button>`;
      const trackAnalyze = `<button class=\"btn themed-track\" id=\"act-track\">Track</button><button class=\"btn themed-preview\" id=\"act-preview\">Preview</button>`;
      actionsEl.innerHTML = `
        <div class="browser-action-stack">
          ${topBar}
          <div class="browser-action-buttons">${annotatePart} ${preprocPart} ${trackAnalyze}</div>
        </div>
      `;
      if (placeholder) placeholder.style.display = "none";
      const clearBtn = document.getElementById("clear-selection");
      clearBtn?.addEventListener("click", () => {
        clearSelections();
        updateSelectionDetails();
      });
      const openAnnotBtn = document.getElementById("open-annotator");
      if (openAnnotBtn) {
        openAnnotBtn.addEventListener("click", () => {
          try {
            localStorage.setItem("cheesepie.lastVideo", currentInfo.path);
          } catch { }
          const url = `/annotator?video=${encodeURIComponent(
            currentInfo.path
          )}`;
          setModuleVideo("annotator", currentInfo.path);
          navigateSoft(url);
        });
      }
      const preprocBtn = document.getElementById("act-preproc");
      if (preprocBtn) {
        preprocBtn.addEventListener("click", () => {
          try {
            localStorage.setItem("cheesepie.lastVideo", currentInfo.path);
          } catch { }
          let step = "";
          try {
            step = localStorage.getItem("cheesepie.preproc.step") || "";
          } catch { }
          const url = `/preproc?video=${encodeURIComponent(currentInfo.path)}${step ? `&step=${encodeURIComponent(step)}` : ""
            }`;
          setModuleVideo("preproc", currentInfo.path);
          navigateSoft(url);
        });
      }
      const analyzeBtn = document.getElementById("act-preview");
      if (analyzeBtn) {
        analyzeBtn.addEventListener("click", () => {
          try {
            localStorage.setItem("cheesepie.lastVideo", currentInfo.path);
          } catch { }
          const url = `/preview?video=${encodeURIComponent(currentInfo.path)}`;
          setModuleVideo("preview", currentInfo.path);
          navigateSoft(url);
        });
      }
      const trackBtn = document.getElementById("act-track");
      if (trackBtn) {
        trackBtn.addEventListener("click", () => {
          const files = [currentInfo.path];
          startTracking(files);
        });
      }
      return;
    }
    // Default: show module state in idle sidebar
    updateSelectedVideoPanel();
  }

  function formatDuration(sec) {
    if (!isFinite(sec) || sec <= 0) return "—";
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const mm = h ? String(m).padStart(2, "0") : String(m);
    const ss = String(s).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // Tracking UI + polling
  let trackPollTimer = null;
  let currentTrackJob = null;

  function ensureBrowserTrackPanel() {
    const panel = document.getElementById("browser-track");
    if (panel) {
      panel.hidden = false;
    }
  }


  function populateTrackRows(files) {
    const body = document.getElementById("track-body");
    if (!body) return;
    body.innerHTML = files
      .map(
        (f) =>
          `<tr data-file="${f}"><td class="browser-track-file">${f}</td><td>PENDING</td><td>—</td><td>0/0</td><td><a href="/media?path=${encodeURIComponent(
            f + ".log"
          )}" target="_blank" rel="noopener">Show</a></td></tr>`
      )
      .join("");
  }

  function trackingStatusBadge(status) {
    const s = String(status || "").toUpperCase();
    if (s === "RUNNING") {
      return '<span style="background:#00A0B0;color:#D8F9FF;padding:2px 6px;border-radius:10px;font-weight:600;display:inline-block;width:8ch">RUNNING</span>';
    }
    if (s === "DONE") {
      return '<span style="background:#A2D15C;color:#335500;padding:2px 6px;border-radius:10px;font-weight:600;display:inline-block;width:8ch">DONE</span>';
    }
    if (s === "FAILED" || s === "FAIL" || s === "ERROR") {
      return '<span style="background:#CC333F;color:#FFD6D9;padding:2px 6px;border-radius:10px;font-weight:600;display:inline-block;width:8ch">FAILED</span>';
    }
    if (s === "CANCELLED" || s === "CANCELED") {
      return '<span style="background:#CC333F;color:#FFD6D9;padding:2px 6px;border-radius:10px;font-weight:600;display:inline-block;width:8ch">CANCELLED</span>';
    }
    if (s === "PENDING") {
      return '<span style="background:#EDC951;color:#7A5F00;padding:2px 6px;border-radius:10px;font-weight:600;display:inline-block;width:8ch">PENDING</span>';
    }
    // default: plain text
    return s || "";
  }

  function updateTrackUI(state) {
    const body = document.getElementById("track-body");
    const statusEl = document.getElementById("track-status");
    const cancelBtn = document.getElementById("track-cancel");
    const retryBtn = document.getElementById("track-retry");
    if (!body || !statusEl || !cancelBtn || !retryBtn) return;
    const items = state.items || [];
    items.forEach((it) => {
      const tr = body.querySelector(`tr[data-file="${CSS.escape(it.file)}"]`);
      if (!tr) return;
      const tds = tr.children;
      const status = (it.status || "").toUpperCase();
      const step = it.step || "—";
      const idx = Number(it.index || 0);
      const tot = Number(it.total || 0);
      if (tds[1]) tds[1].innerHTML = trackingStatusBadge(status);
      if (tds[2]) tds[2].textContent = step;
      if (tds[3]) tds[3].textContent = `${idx}/${tot}`;
    });
    const st = String(state.status || "").toUpperCase();
    const done = !!state.done;
    statusEl.textContent = st || (done ? "DONE" : "RUNNING");
    cancelBtn.disabled = done || st === "ERROR" || st === "DONE";
    retryBtn.disabled =
      !done ||
      items.every((x) => String(x.status || "").toUpperCase() === "DONE");
    if (cancelBtn && currentTrackJob) {
      cancelBtn.onclick = () => {
        fetch("/api/track/cancel?job=" + encodeURIComponent(currentTrackJob), {
          method: "POST",
        }).catch(() => { });
      };
    }
    if (retryBtn && done) {
      const failed = items
        .filter((x) => String(x.status || "").toUpperCase() !== "DONE")
        .map((x) => x.file);
      retryBtn.onclick = () => {
        if (failed.length) {
          startTracking(failed);
        }
      };
    }
  }

  function startTracking(files) {
    if (!Array.isArray(files) || files.length === 0) return;
    ensureBrowserTrackPanel();
    populateTrackRows(files);
    fetch("/api/track/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d || !d.ok || !d.job) {
          throw new Error((d && d.error) || "Failed to start");
        }
        const job = d.job;
        currentTrackJob = job;
        if (trackPollTimer) {
          clearInterval(trackPollTimer);
          trackPollTimer = null;
        }
        const poll = () => {
          fetch("/api/track/status?job=" + encodeURIComponent(job))
            .then((r) => r.json())
            .then((s) => {
              if (!s || !s.ok) return;
              updateTrackUI(s);
              if (s.done) {
                clearInterval(trackPollTimer);
                trackPollTimer = null;
              }
            })
            .catch(() => { });
        };
        poll();
        trackPollTimer = setInterval(poll, 1000);
      })
      .catch((e) => {
        const panel = document.getElementById("track-panel");
        if (panel) {
          panel.innerHTML = `<div class="muted">Error: ${String(e)}</div>`;
        }
      });
  }

  let thumbJobId = 0;
  function setupVideoEnhancements(info) {
    const video = document.getElementById("preview-video");
    const durEl = document.getElementById("meta-duration");
    const resEl = document.getElementById("meta-resolution");
    const codecEl = document.getElementById("meta-codec");
    const fpsEl = document.getElementById("meta-fps");
    const brEl = document.getElementById("meta-bitrate");
    if (!video || !durEl || !resEl) return;

    const onMeta = () => {
      durEl.textContent = formatDuration(video.duration);
      if (video.videoWidth && video.videoHeight) {
        resEl.textContent = `${video.videoWidth} × ${video.videoHeight}`;
      }
      // Thumbnails disabled by request; no generation.
    };
    if (video.readyState >= 1) {
      onMeta();
    }
    video.addEventListener("loadedmetadata", onMeta, { once: true });

    // Try server-side metadata via ffprobe
    fetch(`/api/media_meta?path=${encodeURIComponent(info.path)}`)
      .then((r) => r.json())
      .then((meta) => {
        if (!meta || meta.error || meta.available === false) return;
        const v = (meta.streams && meta.streams.video) || {};
        if (codecEl && v.codec) {
          codecEl.textContent = v.codec + (v.profile ? ` (${v.profile})` : "");
        }
        if (fpsEl && typeof v.fps === "number" && isFinite(v.fps)) {
          fpsEl.textContent = v.fps.toFixed(v.fps < 10 ? 2 : 2) + " fps";
        }
        if (resEl && v.width && v.height) {
          resEl.textContent = `${v.width} × ${v.height}`;
        }
        const br = meta.bit_rate;
        if (brEl && typeof br === "number" && br > 0) {
          brEl.textContent = humanBitrate(br);
        }
        if (durEl && typeof meta.duration === "number" && meta.duration > 0) {
          durEl.textContent = formatDuration(meta.duration);
        }
      })
      .catch(() => { });
  }

  function humanBitrate(bps) {
    const kbps = bps / 1000;
    if (kbps < 1000) return `${Math.round(kbps)} kb/s`;
    const mbps = kbps / 1000;
    return `${mbps.toFixed(2)} Mb/s`;
  }

  function generateThumbnails(info, strip, duration, vWidth, vHeight) {
    const jobId = ++thumbJobId;
    strip.innerHTML =
      '<div class="placeholder muted">Generating thumbnails…</div>';
    const CFG = window.CHEESEPIE || {};
    const THUMBS = (CFG.browser && CFG.browser.preview_thumbnails) || 8;
    const N = Math.max(0, Math.min(24, Number(THUMBS) || 8));
    if (!isFinite(duration) || duration <= 0) {
      strip.innerHTML =
        '<div class="placeholder muted">No timeline available.</div>';
      return;
    }
    const times = Array.from(
      { length: N },
      (_, i) => (duration * (i + 1)) / (N + 1)
    );
    // Hidden video clone to avoid disturbing preview playback
    const hv = document.createElement("video");
    hv.muted = true;
    hv.preload = "auto";
    hv.playsInline = true;
    hv.crossOrigin = "anonymous";
    hv.style.position = "fixed";
    hv.style.left = "-9999px";
    hv.style.top = "0";
    hv.style.width = "160px";
    hv.style.visibility = "hidden";
    const src = document.createElement("source");
    src.src = `/media?path=${encodeURIComponent(info.path)}`;
    src.type = info.mime || "";
    hv.appendChild(src);
    document.body.appendChild(hv);

    const canvas = document.createElement("canvas");
    const targetW = 240; // capture larger then scale in CSS for crisper thumbs
    const aspect = vWidth && vHeight ? vWidth / vHeight : 16 / 9;
    canvas.width = targetW;
    canvas.height = Math.round(targetW / aspect);
    const ctx = canvas.getContext("2d");

    const thumbs = [];
    const preview = document.getElementById("preview-video");

    const next = (i) => {
      if (jobId !== thumbJobId) return cleanup();
      if (i >= times.length) {
        if (thumbs.length === 0) {
          strip.innerHTML =
            '<div class="placeholder muted">No thumbnails.</div>';
        } else {
          strip.innerHTML = "";
          thumbs.forEach(({ dataUrl, t }) => {
            const w = document.createElement("div");
            w.className = "thumb";
            w.title = formatDuration(t);
            const img = document.createElement("img");
            img.src = dataUrl;
            w.appendChild(img);
            const tag = document.createElement("div");
            tag.className = "time";
            tag.textContent = formatDuration(t);
            w.appendChild(tag);
            w.addEventListener("click", () => {
              if (preview) {
                preview.currentTime = t;
                preview.play();
              }
            });
            strip.appendChild(w);
          });
        }
        return cleanup();
      }
      const t = times[i];
      const onSeeked = () => {
        if (jobId !== thumbJobId) {
          hv.removeEventListener("seeked", onSeeked);
          return cleanup();
        }
        try {
          ctx.drawImage(hv, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
          thumbs.push({ dataUrl, t });
        } catch (e) { }
        hv.removeEventListener("seeked", onSeeked);
        next(i + 1);
      };
      hv.addEventListener("seeked", onSeeked);
      try {
        hv.currentTime = Math.min(
          Math.max(0.1, t),
          Math.max(0.1, duration - 0.1)
        );
      } catch (e) {
        hv.removeEventListener("seeked", onSeeked);
        next(i + 1);
      }
    };

    const onLoaded = () => {
      next(0);
    };
    hv.addEventListener("loadedmetadata", onLoaded, { once: true });
    hv.load();

    function cleanup() {
      try {
        document.body.removeChild(hv);
      } catch { }
    }
  }

  function describeFsPath(path) {
    const raw = String(path || "").trim();
    const isWindows = /^[A-Za-z]:/.test(raw);
    let normalized = raw.replace(/\\/g, "/");
    if (isWindows) {
      normalized = normalized.replace(/\/+$/, "");
      if (/^[A-Za-z]:$/.test(normalized)) normalized += "/";
    } else {
      if (!normalized.startsWith("/")) normalized = "/" + normalized;
      if (normalized !== "/") normalized = normalized.replace(/\/+$/, "");
    }
    const root = isWindows ? normalized.slice(0, 2) : "/";
    const rest = isWindows
      ? normalized.slice(2).replace(/^\/+/, "")
      : normalized.replace(/^\/+/, "");
    const parts = rest ? rest.split("/").filter(Boolean) : [];
    return { raw, normalized, isWindows, root, parts };
  }

  function buildFsPath(info, parts) {
    if (info.isWindows) {
      return parts.length ? `${info.root}\\${parts.join("\\")}` : `${info.root}\\`;
    }
    return parts.length ? `/${parts.join("/")}` : "/";
  }

  function buildBreadcrumbEntries(dir) {
    const current = describeFsPath(dir);
    if (!current.raw) return [];
    const useBase =
      facilityBaseDir &&
      isUnderBase(current.normalized, facilityBaseDir);
    if (useBase) {
      const base = describeFsPath(facilityBaseDir);
      const baseParts = base.parts.slice();
      const relParts = current.parts.slice(baseParts.length);
      const rootLabel = baseParts.length > 0
        ? baseParts[baseParts.length - 1]
        : (base.isWindows ? base.root : "/");
      const crumbs = [{
        label: rootLabel,
        path: buildFsPath(base, baseParts),
      }];
      relParts.forEach((part, i) => {
        const fullParts = baseParts.concat(relParts.slice(0, i + 1));
        crumbs.push({ label: part, path: buildFsPath(base, fullParts) });
      });
      return crumbs;
    }
    // No base dir known yet — show only the current folder name, never the full path
    const label = current.parts.length > 0
      ? current.parts[current.parts.length - 1]
      : (current.isWindows ? current.root : "/");
    return [{ label, path: dir }];
  }

  function renderBreadcrumb(dir) {
    const bar = document.getElementById("breadcrumb-bar");
    if (!bar) return;
    updateBrowserNavControls();
    if (!dir) {
      bar.innerHTML = '<span class="bc-empty muted">Select a facility to browse files.</span>';
      return;
    }
    const crumbs = buildBreadcrumbEntries(dir);
    bar.innerHTML = "";
    crumbs.forEach((c, i) => {
      const isLast = i === crumbs.length - 1;
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "bc-sep";
        sep.textContent = "›";
        sep.setAttribute("aria-hidden", "true");
        bar.appendChild(sep);
      }
      const seg = document.createElement(isLast ? "span" : "button");
      if (seg.tagName === "BUTTON") seg.type = "button";
      seg.className = isLast ? "bc-segment bc-current" : "bc-segment bc-link";
      seg.textContent = c.label;
      seg.title = c.path;
      if (!isLast) {
        seg.addEventListener("click", () => {
          navigateToDir(c.path);
        });
      } else {
        seg.setAttribute("aria-current", "location");
      }
      bar.appendChild(seg);
    });
  }

  function loadList() {
    if (!listEl) return;
    renderBreadcrumb(currentDir);
    const q = searchInput ? (searchInput.value || "") : "";
    if (!currentDir) {
      listEl.innerHTML =
        '<div class="placeholder muted">Select a facility to load files.</div>';
      return;
    }
    listEl.innerHTML = '<div class="placeholder muted">Loading…</div>';
    const fac = String(currentFacility || "");
    fetch(
      `/api/list?dir=${encodeURIComponent(currentDir)}&q=${encodeURIComponent(
        q
      )}&facility=${encodeURIComponent(fac)}`
    )
      .then((r) => r.json())
      .then((data) => {
        renderList(data.items);
      })
      .catch(() => {
        listEl.innerHTML =
          '<div class="placeholder muted">Failed to load folder.</div>';
      });
  }

  function debounce(fn, ms) {
    return (...args) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => fn.apply(null, args), ms);
    };
  }

  function parentDir(p) {
    if (!p) return "";
    let s = String(p).trim();
    // Normalize separators; keep original for indices
    const isWindows = /^[A-Za-z]:/.test(s);
    // Trim trailing separators except root
    const sepRegex = /[\\/]+$/;
    if (isWindows) {
      // Preserve e.g. C:\ as root
      if (/^[A-Za-z]:[\\/]?$/.test(s))
        return s.replace("/", "\\").replace(/$/, "\\");
      s = s.replace(sepRegex, "");
      const idx = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
      if (idx <= 2) return s.slice(0, 3).replace("/", "\\"); // C:\
      return s.slice(0, idx);
    } else {
      if (s === "/") return "/";
      s = s.replace(sepRegex, "");
      const idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
      if (idx <= 0) return "/";
      return s.slice(0, idx) || "/";
    }
  }

  function isUnderBase(p, base) {
    try {
      const norm = (s) => {
        const t = String(s || "").trim();
        return t.replace(/\\/g, "/");
      };
      const P = norm(p),
        B = norm(base);
      if (!P || !B) return false;
      if (P === B) return true;
      return P.startsWith(B.endsWith("/") ? B : B + "/");
    } catch (e) {
      return false;
    }
  }

  function clampDirToBase(dir) {
    const d = String(dir || "").trim();
    if (!d) return "";
    if (facilityBaseDir && !isUnderBase(d, facilityBaseDir)) {
      return facilityBaseDir;
    }
    return d;
  }

  function updateBrowserNavControls() {
    // no-op: up button removed
  }

  function navigateToDir(dir) {
    currentDir = clampDirToBase(dir);
    if (currentDir) {
      persistCurrentDir(currentDir);
    }
    loadList();
  }

  // clear search 'x'
  function toggleClear() {
    if (!clearBtn) return;
    const hasText = (searchInput?.value || "").length > 0;
    clearBtn.hidden = !hasText;
  }

  function bindBrowserControls() {
    if (!listEl) return;
    if (searchInput && !searchInput.dataset.bound) {
      searchInput.addEventListener("input", debounce(loadList, 150));
      searchInput.addEventListener("input", toggleClear);
      searchInput.dataset.bound = "1";
    }

    if (clearBtn && !clearBtn.dataset.bound) {
      clearBtn.addEventListener("click", () => {
        if (!searchInput) return;
        searchInput.value = "";
        toggleClear();
        loadList();
      });
      clearBtn.dataset.bound = "1";
    }

    toggleClear();
    renderBreadcrumb(currentDir);
  }

  function initialBrowserLoad() {
    if (!listEl) return;
    syncFacilityBase();
    try {
      const lastVideo = localStorage.getItem("cheesepie.lastVideo");
      if (lastVideo) {
        const pdir = parentDir(lastVideo);
        if (pdir && (!facilityBaseDir || isUnderBase(pdir, facilityBaseDir))) {
          currentDir = pdir;
          persistCurrentDir(pdir);
        } else if (facilityBaseDir) {
          currentDir = facilityBaseDir;
        }
        desiredSelectPath = lastVideo;
        loadList();
        return;
      }
      const last = localStorage.getItem(LS_KEY);
      if (last && (!facilityBaseDir || isUnderBase(last, facilityBaseDir))) {
        currentDir = last;
        loadList();
      } else if (facilityBaseDir) {
        currentDir = facilityBaseDir;
        loadList();
      } else {
        try {
          const cfg = window.CHEESEPIE || {};
          const def = (cfg.browser && cfg.browser.default_dir) || "";
          if (def) {
            currentDir = def;
            loadList();
          }
        } catch (e) { }
      }
    } catch (e) { }
  }

  function initBrowserPage() {
    refreshBrowserRefs();
    if (!listEl) return;
    setupBrowserFacilityListener();
    bindBrowserControls();
    updateSelectedVideoPanel();
    if (!listEl.dataset.bound) {
      listEl.dataset.bound = "1";
      initialBrowserLoad();
    }
  }

  // Enhance top nav: disable Preproc/Annotator/Preview when no selected video
  function updateModuleTabsDisabled() {
    try {
      const annTab = document.querySelector('a.tab[href="/annotator"]');
      const ppTab = document.querySelector('a.tab[href="/preproc"]');
      const anTab = document.querySelector('a.tab[href="/preview"]');
      const step = (() => {
        try {
          return localStorage.getItem("cheesepie.preproc.step") || "";
        } catch (e) {
          return "";
        }
      })();
      const setState = (el, video, hrefWhenHas, baseHref) => {
        if (!el) return;
        if (video) {
          el.setAttribute("aria-disabled", "false");
          el.removeAttribute("tabindex");
          el.style.pointerEvents = "";
          el.style.opacity = "";
          el.style.cursor = "";
          el.title = "";
          el.setAttribute("href", hrefWhenHas);
        } else {
          el.setAttribute("aria-disabled", "true");
          el.setAttribute("tabindex", "-1");
          el.style.pointerEvents = "none";
          el.style.opacity = "0.5";
          el.style.cursor = "not-allowed";
          el.title = "Select a video in Browser";
          el.setAttribute("href", baseHref);
        }
      };
      const annVideo = getModuleVideo("annotator");
      const ppVideo = getModuleVideo("preproc");
      const prevVideo = getModuleVideo("preview");
      setState(
        annTab,
        annVideo,
        `/annotator?video=${encodeURIComponent(annVideo)}`,
        "/annotator"
      );
      setState(
        ppTab,
        ppVideo,
        `/preproc?video=${encodeURIComponent(ppVideo)}${step ? `&step=${encodeURIComponent(step)}` : ""}`,
        "/preproc"
      );
      setState(
        anTab,
        prevVideo,
        `/preview?video=${encodeURIComponent(prevVideo)}`,
        "/preview"
      );
    } catch (e) { }
  }
  try {
    updateSelectedVideoPanel();
    updateModuleTabsDisabled();
    window.addEventListener("storage", (ev) => {
      if (ev && ev.key === "cheesepie.lastVideo") {
        updateSelectedVideoPanel();
        updateModuleTabsDisabled();
      }
    });
    document.addEventListener("app:selected-video-changed", () => {
      updateSelectedVideoPanel();
      updateModuleTabsDisabled();
    });
    document.addEventListener("app:module-video-changed", () => {
      updateModuleTabsDisabled();
    });
  } catch { }

  // Settings page handlers (rebind on soft navigation)
  function applyTheme(theme, selectEl) {
    const allowed = [
      "dark",
      "light",
      "ocean",
      "forest",
      "plum",
      "contrast",
      "mouse",
    ];
    const t = allowed.includes(theme) ? theme : "dark";
    document.documentElement.setAttribute("data-theme", t);
    try {
      localStorage.setItem("cheesepie.theme", t);
    } catch { }
    if (selectEl) selectEl.value = t;
    else if (themeSelect) themeSelect.value = t;
  }

  function initThemeControls() {
    const selectEl = document.getElementById("theme-select");
    const applyBtnEl = document.getElementById("apply-theme");
    if (!selectEl) return;
    try {
      const saved = localStorage.getItem("cheesepie.theme") || "dark";
      applyTheme(saved, selectEl);
    } catch { }
    if (!selectEl.dataset.bound) {
      selectEl.addEventListener("change", () => {
        applyTheme(selectEl.value, selectEl);
      });
      selectEl.dataset.bound = "1";
    }
    if (applyBtnEl && !applyBtnEl.dataset.bound) {
      applyBtnEl.addEventListener("click", () => {
        applyTheme(selectEl.value || "dark", selectEl);
      });
      applyBtnEl.dataset.bound = "1";
    }
  }

  function loadConfigList(select, status) {
    fetch("/api/config/list")
      .then((r) => r.json())
      .then((d) => {
        if (!d || d.error) return;
        select._cfgList = d;
        const items = d.items || [];
        const cur = d.current || "";
        const origin = d.origin || "default";
        select.innerHTML = "";
        items.forEach((it) => {
          const opt = document.createElement("option");
          opt.value = String(it.path || "");
          opt.textContent = String(it.label || it.path || "");
          select.appendChild(opt);
        });
        if (cur && !Array.from(select.options).some((o) => o.value === cur)) {
          const opt = document.createElement("option");
          opt.value = cur;
          opt.textContent = (cur.split("/").pop() || cur) + " (custom)";
          select.insertBefore(opt, select.firstChild);
        }
        if (cur) {
          select.value = cur;
        }
        if (status) {
          status.textContent = `Using ${origin === "env" ? "override" : "default"} config`;
        }
      })
      .catch(() => { });
  }

  function initConfigSwitcher() {
    const select = document.getElementById("cfg-select");
    const btn = document.getElementById("apply-config");
    const resetBtn = document.getElementById("reset-config");
    const status = document.getElementById("cfg-status");
    if (!select || !btn) return;
    if (!select.dataset.bound) {
      btn.addEventListener("click", () => {
        const path = (select.value || "").trim();
        if (!path) {
          status.textContent = "Enter a config path.";
          return;
        }
        status.textContent = "Applying…";
        fetch("/api/config/switch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        })
          .then((r) =>
            r.json().then((d) => ({
              ok: r.ok && d && !d.error,
              d,
              status: r.statusText,
            }))
          )
          .then((res) => {
            if (!res.ok) {
              status.textContent =
                "Error: " + ((res.d && res.d.error) || res.status);
              return;
            }
            status.textContent = "Applied. Reloading…";
            setTimeout(() => {
              location.reload();
            }, 600);
          })
          .catch((e) => {
            status.textContent = "Error: " + e;
          });
      });

      if (resetBtn) {
        resetBtn.addEventListener("click", () => {
          try {
            const cfgList = select._cfgList || { items: [] };
            const def = (cfgList.items || []).find((it) => it && it.default);
            if (!def || !def.path) {
              status.textContent = "Default config not found.";
              return;
            }
            status.textContent = "Resetting…";
            fetch("/api/config/switch", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: def.path }),
            })
              .then((r) =>
                r.json().then((d) => ({
                  ok: r.ok && d && !d.error,
                  d,
                  status: r.statusText,
                }))
              )
              .then((res) => {
                if (!res.ok) {
                  status.textContent =
                    "Error: " + ((res.d && res.d.error) || res.status);
                  return;
                }
                status.textContent = "Reset to default. Reloading…";
                setTimeout(() => {
                  location.reload();
                }, 600);
              })
              .catch((e) => {
                status.textContent = "Error: " + e;
              });
          } catch (e) {
            status.textContent = "Error: " + e;
          }
        });
      }
      select.dataset.bound = "1";
    }
    loadConfigList(select, status);
  }

  function initRestartControl() {
    const btn = document.getElementById("restart-app");
    const status = document.getElementById("restart-status");
    if (!btn) return;
    if (btn.dataset.bound) return;
    btn.addEventListener("click", () => {
      if (!confirm("Restart the CheesePie server now?")) return;
      btn.disabled = true;
      if (status) status.textContent = "Restarting…";
      fetch("/api/config/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      })
        .then((r) => r.json().then((d) => ({ ok: r.ok && d && !d.error, d })))
        .then((res) => {
          if (!res.ok) {
            if (status) status.textContent = "Error: " + (res.d && res.d.error);
            btn.disabled = false;
            return;
          }
          if (status) status.textContent = "Restart requested. Reconnecting…";
          setTimeout(() => {
            location.reload();
          }, 4000);
        })
        .catch((e) => {
          if (status) status.textContent = "Error: " + e;
          btn.disabled = false;
        });
    });
    btn.dataset.bound = "1";
  }

  function initUpdateControl() {
    const btn = document.getElementById("update-app");
    const status = document.getElementById("update-status");
    if (!btn) return;
    if (btn.dataset.bound) return;
    btn.addEventListener("click", () => {
      const msg =
        "Pull latest code from GitHub and restart the server?\n" +
        "This will fail if there are local changes.";
      if (!confirm(msg)) return;
      btn.disabled = true;
      if (status) status.textContent = "Updating…";
      fetch("/api/config/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      })
        .then((r) => r.json().then((d) => ({ ok: r.ok && d && !d.error, d })))
        .then((res) => {
          if (!res.ok) {
            if (status) status.textContent = "Error: " + (res.d && res.d.error);
            btn.disabled = false;
            return;
          }
          if (status) {
            const out = (res.d && res.d.output) || "Update complete.";
            status.textContent = out + " Restarting…";
          }
          setTimeout(() => {
            location.reload();
          }, 5000);
        })
        .catch((e) => {
          if (status) status.textContent = "Error: " + e;
          btn.disabled = false;
        });
    });
    btn.dataset.bound = "1";
  }

  function initSettingsPage() {
    initThemeControls();
    initConfigSwitcher();
    initRestartControl();
    initUpdateControl();
  }

  function initModuleFileChip() {
    const chip = document.querySelector(".module-file-chip[data-module]");
    if (!chip) return;
    const moduleKey = chip.dataset.module;

    function getPath() {
      const v = getModuleVideo(moduleKey);
      if (v) return v;
      return chip.dataset.video || "";
    }

    function render() {
      const path = getPath();
      const fname = path ? path.split(/[/\\]/).pop() : "";
      chip.innerHTML = "";
      if (path) {
        const icon = document.createElement("span");
        icon.className = "mfc-icon";
        chip.appendChild(icon);
        const name = document.createElement("span");
        name.className = "mfc-name";
        name.textContent = fname;
        name.title = path;
        chip.appendChild(name);
      } else {
        const empty = document.createElement("span");
        empty.className = "mfc-empty muted";
        empty.textContent = "No file selected";
        chip.appendChild(empty);
      }
      const browse = document.createElement("button");
      browse.className = "mfc-browse btn mini";
      browse.textContent = "Browse";
      browse.type = "button";
      browse.addEventListener("click", () => {
        const inModal = !!chip.closest("#module-modal-content");
        if (inModal) {
          history.back();
        } else if (window.cheesepieNavigate) {
          window.cheesepieNavigate("/browser");
        } else {
          window.location.href = "/browser";
        }
      });
      chip.appendChild(browse);
    }

    render();
    if (!chip.dataset.chipBound) {
      chip.dataset.chipBound = "1";
      document.addEventListener("app:module-video-changed", (e) => {
        if (e && e.detail && e.detail.name === moduleKey) {
          chip.dataset.video = e.detail.path || "";
          render();
        }
      });
    }
  }

  function initPreprocVideoControls() {
    try {
      const v = document.getElementById("pp-video");
      const playBtn = document.getElementById("pp-play");
      const seek = document.getElementById("pp-seek");
      const timeLbl = document.getElementById("pp-time");
      const timeCur = document.getElementById("pp-time-cur");
      const timeDur = document.getElementById("pp-time-dur");
      if (!v || !playBtn || !seek || (!timeLbl && !(timeCur && timeDur))) return;
      if (v.dataset.controlsBound) return;
      v.dataset.controlsBound = "1";
      const fmt = (sec) => {
        if (!isFinite(sec)) return "00:00.000";
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        const ms = Math.floor((sec - Math.floor(sec)) * 1000);
        const pad2 = (n) => String(n).padStart(2, "0");
        const pad3 = (n) => String(n).padStart(3, "0");
        return h
          ? `${h}:${pad2(m)}:${pad2(s)}.${pad3(ms)}`
          : `${pad2(m)}:${pad2(s)}.${pad3(ms)}`;
      };
      const parse = (str) => {
        try {
          const s = String(str || "").trim();
          if (!s) return null;
          const m = s.match(/^(\d+)(?::(\d+))?(?::(\d+))?(?:\.(\d{1,3}))?$/);
          if (!m) return null;
          let h = 0, mi = 0, se = 0, ms = 0;
          if (m[3] != null) {
            h = parseInt(m[1], 10) || 0;
            mi = parseInt(m[2], 10) || 0;
            se = parseInt(m[3], 10) || 0;
          } else if (m[2] != null) {
            mi = parseInt(m[1], 10) || 0;
            se = parseInt(m[2], 10) || 0;
          } else {
            se = parseFloat(m[1]) || 0;
          }
          if (m[4] != null) {
            ms = parseInt(String(m[4]).padEnd(3, "0"), 10) || 0;
          }
          return h * 3600 + mi * 60 + se + ms / 1000;
        } catch (e) {
          return null;
        }
      };
      const updateTime = () => {
        const cur = Number(v.currentTime || 0);
        const dur = Number(v.duration || 0);
        if (timeCur && timeDur) {
          timeCur.value = fmt(cur);
          timeDur.textContent = fmt(dur);
          try {
            const durRect = timeDur.getBoundingClientRect();
            const padLeft = parseFloat(getComputedStyle(timeCur).paddingLeft || "0") || 0;
            const padRight = parseFloat(getComputedStyle(timeCur).paddingRight || "0") || 0;
            const extra = Math.ceil(padLeft + padRight + 2);
            timeCur.style.width = Math.max(60, Math.ceil(durRect.width) + extra) + "px";
          } catch (e) { }
        } else if (timeLbl) {
          timeLbl.textContent = `${fmt(cur)} / ${fmt(dur)}`;
        }
        if (!seek.dragging) seek.value = String(cur);
      };
      const updateMax = () => {
        try {
          seek.max = String(Math.max(0, Number(v.duration || 0)));
          updateTime();
        } catch { }
      };
      const updatePlayUI = () => {
        const paused = !!v.paused;
        playBtn.textContent = paused ? "▶" : "⏸";
        playBtn.title = paused ? "Play" : "Pause";
        playBtn.setAttribute("aria-label", paused ? "Play" : "Pause");
      };
      v.addEventListener("loadedmetadata", updateMax);
      v.addEventListener("durationchange", updateMax);
      v.addEventListener("timeupdate", updateTime);
      v.addEventListener("play", updatePlayUI);
      v.addEventListener("pause", updatePlayUI);
      playBtn.addEventListener("click", () => {
        try { v.paused ? v.play() : v.pause(); } catch { }
      });
      seek.addEventListener("input", () => {
        seek.dragging = true;
        try { v.currentTime = Number(seek.value || 0); } catch { }
      });
      seek.addEventListener("change", () => { seek.dragging = false; });
      if (timeCur) {
        const jump = () => {
          try {
            const t = parse(timeCur.value);
            if (t == null) return;
            const target = Math.min(Math.max(0, t), Math.max(0, Number(v.duration || 0) - 1e-6));
            try { v.pause(); } catch (e) { }
            v.currentTime = target;
            updateTime();
          } catch (e) { }
        };
        timeCur.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); jump(); } });
        timeCur.addEventListener("blur", jump);
      }
      if (v.readyState >= 1) { updateMax(); updatePlayUI(); }
    } catch { }
  }

  initBrowserPage();
  initSettingsPage();
  initModuleFileChip();
  initPreprocVideoControls();
  window.cheesepieRegisterPageRefresher?.("browser", initBrowserPage);
  window.cheesepieRegisterPageRefresher?.("settings", initSettingsPage);
  window.cheesepieRegisterPageRefresher?.("preproc", function () { initModuleFileChip(); initPreprocVideoControls(); });
  window.cheesepieRegisterPageRefresher?.("annotator", initModuleFileChip);
  window.cheesepieRegisterPageRefresher?.("preview", initModuleFileChip);
  document.addEventListener("app:page-changed", (e) => {
    const path = e && e.detail && e.detail.path;
    if (path === "/settings") initSettingsPage();
    if (path === "/browser") initBrowserPage();
  });

  // MATLAB status polling removed
})();
// Header Facility selector: populate and broadcast changes
(function headerFacility() {
  try {
    const sel = document.getElementById("app-facility");
    if (!sel) return;
    const cfg = window.CHEESEPIE || {};
    const facs = (cfg.importer && cfg.importer.facilities) || {};
    const keys = Object.keys(facs);
    sel.innerHTML = "";
    keys.forEach((k) => {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = k;
      sel.appendChild(o);
    });
    // Prefer URL param, then localStorage, then config default, then first
    let cur = "";
    try {
      const usp = new URLSearchParams(location.search);
      cur = usp.get("facility") || "";
    } catch (e) { }
    if (!cur) {
      try {
        cur = localStorage.getItem("cheesepie.facility") || "";
      } catch (e) { }
    }
    if (!cur || keys.indexOf(cur) === -1) {
      try {
        const def = (cfg.importer && cfg.importer.default_facility) || "";
        if (def && keys.indexOf(def) !== -1) cur = def;
      } catch (e) { }
    }
    if (!cur || keys.indexOf(cur) === -1) cur = keys[0] || "";
    if (cur) sel.value = cur;
    function emit() {
      try {
        const name = sel.value;
        try {
          localStorage.setItem("cheesepie.facility", name);
        } catch (e) { }
        const detail = { name, config: facs[name] || {} };
        document.dispatchEvent(
          new CustomEvent("app:facility-changed", { detail })
        );
      } catch (e) { }
    }
    sel.addEventListener("change", function () {
      emit();
    });
    // Emit on load to initialize dependents
    emit();
  } catch (e) { }
})();

// Footer task progress summary (all pages)
(function taskFooter() {
  try {
    const summaryEl = document.getElementById("tasks-footer-summary");
    const barEl = document.getElementById("tasks-footer-bar");
    const detailEl = document.getElementById("tasks-footer-detail");
    const spinnerEl = document.getElementById("tasks-footer-spinner");
    if (!summaryEl || !barEl || !detailEl) return;
    const doneStates = ["DONE", "FAILED", "CANCELLED", "ERROR"];
    let timer = null;

    function taskTitle(t) {
      return t.title || t.kind || "Task";
    }

    function fmtProgress(t) {
      const total = Number(t.total || 0);
      const prog = Number(t.progress || 0);
      if (total > 0) return ` (${prog}/${total})`;
      return "";
    }

    function updateFooter(tasks) {
      const active = (tasks || []).filter(
        (t) => !doneStates.includes(String(t.status || "").toUpperCase())
      );
      const running = active.filter(
        (t) => String(t.status || "").toUpperCase() === "RUNNING"
      );
      if (!active.length) {
        summaryEl.textContent = "No active tasks";
        detailEl.textContent = "";
        barEl.classList.remove("indeterminate");
        barEl.style.width = "0%";
        if (spinnerEl) spinnerEl.classList.remove("active");
        return;
      }
      if (running.length) {
        summaryEl.textContent =
          `${active.length} active • ${running.length} running`;
        if (spinnerEl) spinnerEl.classList.add("active");
      } else {
        summaryEl.textContent = `${active.length} queued`;
        if (spinnerEl) spinnerEl.classList.remove("active");
      }
      const focus = running[0] || active[0];
      detailEl.textContent = `Now: ${taskTitle(focus)}${fmtProgress(focus)}`;
      const totalTotal = active.reduce((acc, t) => {
        const total = Number(t.total || 0);
        return total > 0 ? acc + total : acc;
      }, 0);
      const totalProg = active.reduce((acc, t) => {
        const total = Number(t.total || 0);
        const prog = Number(t.progress || 0);
        return total > 0 ? acc + prog : acc;
      }, 0);
      if (totalTotal > 0) {
        const pct = Math.max(0, Math.min(100, Math.round((100 * totalProg) / totalTotal)));
        barEl.classList.remove("indeterminate");
        barEl.style.width = `${pct}%`;
      } else {
        barEl.classList.add("indeterminate");
        barEl.style.width = "";
      }
    }

    async function loadTasks() {
      try {
        const res = await fetch("/api/tasks?active=1&limit=0");
        const data = await res.json();
        if (!res.ok || !data || data.error) {
          throw new Error((data && data.error) || res.statusText);
        }
        updateFooter(data.tasks || []);
      } catch {
        summaryEl.textContent = "Tasks unavailable";
        detailEl.textContent = "";
        barEl.classList.remove("indeterminate");
        barEl.style.width = "0%";
        if (spinnerEl) spinnerEl.classList.remove("active");
      }
    }

    loadTasks();
    timer = setInterval(loadTasks, 4000);
    window.addEventListener("beforeunload", () => {
      if (timer) clearInterval(timer);
    });
  } catch { }
})();
