'use strict'

const { contextBridge, ipcRenderer, webFrame } = require('electron')

const pushListeners = new Set()

ipcRenderer.on('shell:push', (_event, payload) => {
  for (const listener of [...pushListeners]) {
    try { listener(payload) } catch { /* one bad listener must not stop the rest */ }
  }
})

contextBridge.exposeInMainWorld('__DSH_SHELL__', {
  protocolVersion: 1,
  browserAcquire: () => ipcRenderer.invoke('shell:browser-acquire'),
  browserRelease: (lease) => ipcRenderer.invoke('shell:browser-release', lease),
  browserDownload: (id, action) => ipcRenderer.send('shell:browser-download', { id, action }),
  subscribe: (listener) => {
    pushListeners.add(listener)
    return () => { pushListeners.delete(listener) }
  },
  windowAction: (action) => ipcRenderer.send('shell:window', action),
  edit: (action) => ipcRenderer.send('shell:edit', action),
})

const claimFirstPaint = async () => {
  let claimed = false
  try { claimed = ipcRenderer.sendSync('shell:claim-fade') === true } catch { claimed = false }
  if (!claimed) return
  let base = null
  try { base = await webFrame.insertCSS('html{opacity:0;transition:opacity 240ms ease}', { cssOrigin: 'user' }) } catch { base = null }
  if (base === null || base === undefined) return
  performance.mark('dsh-fade-hidden')
  let revealed = false
  const reveal = () => {
    if (revealed) return
    revealed = true
    performance.mark('dsh-fade-start')
    let top = null
    try {
      Promise.resolve(webFrame.insertCSS('html{opacity:1}', { cssOrigin: 'user' })).then((key) => { top = key })
    } catch { top = null }
    let frames = 0
    const began = performance.now()
    const count = () => {
      frames += 1
      if (performance.now() - began < 260) requestAnimationFrame(count)
      else {
        performance.mark('dsh-fade-end', { detail: { frames } })
        performance.measure('dsh-fade', 'dsh-fade-start', 'dsh-fade-end')
      }
    }
    requestAnimationFrame(count)
    setTimeout(() => {
      if (top !== null && top !== undefined) { try { webFrame.removeInsertedCSS(top) } catch { /* ignore */ } }
      try { webFrame.removeInsertedCSS(base) } catch { /* ignore */ }
    }, 420)
  }
  ipcRenderer.on('shell:fade-in', reveal)
  setTimeout(reveal, 2600)
}
claimFirstPaint()

const SHIM = String.raw`
(function () {
  if (window.chrome !== undefined && window.chrome !== null && window.chrome.webview !== undefined
    && window.chrome.webview !== null && window.chrome.webview.__dshShell === true) {
    try { paneChrome(); } catch (e) { }
    return;
  }
  var BRIDGE = window.__DSH_SHELL__;
  if (BRIDGE === undefined || BRIDGE === null) return;

  var START_URL = 'https://limestart.cn/';

  function Bus() { this.handlers = []; }
  Bus.prototype.addEventListener = function (type, fn) {
    if (type !== 'message' || typeof fn !== 'function') return;
    if (this.handlers.indexOf(fn) < 0) this.handlers.push(fn);
  };
  Bus.prototype.removeEventListener = function (type, fn) {
    if (type !== 'message') return;
    var at = this.handlers.indexOf(fn);
    if (at >= 0) this.handlers.splice(at, 1);
  };
  Bus.prototype.dispatch = function (data) {
    var list = this.handlers.slice();
    for (var i = 0; i < list.length; i++) {
      try { list[i]({ type: 'message', data: data, source: null }); } catch (e) { }
    }
  };

  var bus = new Bus();
  var tabs = [];
  var activeId = '';
  var serial = 0;
  var rect = null;
  var visible = false;
  var zoom = 1;
  var favicons = {};
  var layer = null;
  var creating = null;

  function stageNode() {
    var nodes = [];
    try { nodes = Array.prototype.slice.call(document.querySelectorAll('.eb_stage')); } catch (e) { return null; }
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.isConnected !== true) continue;
      if (node.offsetWidth < 8 || node.offsetHeight < 8) continue;
      return node;
    }
    return nodes.length > 0 ? nodes[0] : null;
  }

  function stageRadius(stage) {
    var node = stage;
    for (var depth = 0; depth < 8 && node !== null && node !== undefined; depth += 1) {
      var current = '';
      try { current = window.getComputedStyle(node).borderTopLeftRadius || ''; } catch (e) { current = ''; }
      if (current !== '' && current !== '0px' && current !== '0%') return current;
      node = node.parentElement;
    }
    return '';
  }

  function ensureLayer() {
    var stage = stageNode();
    if (stage === null) return null;
    if (layer !== null && layer.parentNode === stage) return layer;
    if (layer === null) { layer = document.createElement('div'); layer.id = '__dsh_embed_layer__'; }
    layer.style.cssText = 'position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:2;';
    stage.appendChild(layer);
    return layer;
  }

  function active() {
    for (var i = 0; i < tabs.length; i++) if (tabs[i].id === activeId) return tabs[i];
    return null;
  }

  function byLease(lease) {
    for (var i = 0; i < tabs.length; i++) if (tabs[i].lease === lease) return tabs[i];
    return null;
  }

  function mountTabs() {
    var host = ensureLayer();
    if (host === null) return false;
    var radius = stageRadius(host);
    var overflow = radius === '' ? 'visible' : 'hidden';
    for (var i = 0; i < tabs.length; i++) {
      var el = tabs[i].el;
      if (el.parentNode !== host) host.appendChild(el);
      if (el.style.borderRadius !== radius) el.style.borderRadius = radius;
      if (el.style.overflow !== overflow) el.style.overflow = overflow;
    }
    return true;
  }

  function place(el, host) {
    var want = (visible === true && host !== null) ? 'flex' : 'none';
    var events = dockDragging() === true ? 'none' : 'auto';
    if (el.style.pointerEvents !== events) el.style.pointerEvents = events;
    if (el.style.display !== want) el.style.display = want;
    if (want === 'none') return;
    var inStage = host !== document.body && host !== document.documentElement;
    var left = '0px';
    var top = '0px';
    var width = '100%';
    var height = '100%';
    if (!inStage) {
      if (rect === null) { if (el.style.display !== 'none') el.style.display = 'none'; return; }
      left = rect.x + 'px';
      top = rect.y + 'px';
      width = rect.w + 'px';
      height = rect.h + 'px';
    }
    if (el.style.left !== left) el.style.left = left;
    if (el.style.top !== top) el.style.top = top;
    if (el.style.width !== width) el.style.width = width;
    if (el.style.height !== height) el.style.height = height;
  }

  function applyGeometry() {
    var mounted = mountTabs();
    var host = mounted ? layer.parentNode : null;
    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      if (tab.id !== activeId) {
        if (tab.el.style.display !== 'none') tab.el.style.display = 'none';
        continue;
      }
      place(tab.el, host);
    }
  }

  function pushState() {
    var tab = active();
    var list = [];
    for (var i = 0; i < tabs.length; i++) {
      list.push({
        id: tabs[i].id,
        title: tabs[i].title,
        url: tabs[i].url,
        loading: tabs[i].loading === true,
        active: tabs[i].id === activeId,
      });
    }
    bus.dispatch({
      kind: 'dsh-embed-state',
      url: tab === null ? '' : tab.url,
      title: tab === null ? '' : tab.title,
      canGoBack: tab !== null && tab.canGoBack === true,
      canGoForward: tab !== null && tab.canGoForward === true,
      loading: tab !== null && tab.loading === true,
      zoom: zoom,
      tabs: list,
    });
  }

  function syncNav(tab) {
    try { tab.canGoBack = tab.el.canGoBack() === true; } catch (e) { tab.canGoBack = false; }
    try { tab.canGoForward = tab.el.canGoForward() === true; } catch (e) { tab.canGoForward = false; }
  }

  function attachEvents(tab) {
    var el = tab.el;
    el.addEventListener('did-start-loading', function () { tab.loading = true; pushState(); });
    el.addEventListener('did-stop-loading', function () {
      tab.loading = false;
      syncNav(tab);
      pushState();
    });
    el.addEventListener('did-navigate', function (event) {
      tab.url = event.url;
      syncNav(tab);
      pushState();
    });
    el.addEventListener('did-navigate-in-page', function (event) {
      if (event.isMainFrame !== true) return;
      tab.url = event.url;
      syncNav(tab);
      pushState();
    });
    el.addEventListener('page-title-updated', function (event) {
      tab.title = event.title || tab.url;
      pushState();
    });
    el.addEventListener('did-fail-load', function (event) {
      if (event.errorCode === -3) return;
      tab.loading = false;
      pushState();
    });
    el.addEventListener('destroyed', function () { dropTab(tab.id, false); });
  }

  function createTab(url, makeActive) {
    if (creating !== null) return creating;
    creating = BRIDGE.browserAcquire().then(function (res) {
      var el = document.createElement('webview');
      el.setAttribute('partition', res.partition);
      el.setAttribute('src', 'about:blank#' + res.lease);
      el.setAttribute('allowpopups', '');
      el.style.cssText = 'position:absolute;display:none;border:0;background:transparent;pointer-events:auto;';
      var tab = {
        id: 'et' + String(++serial), lease: res.lease, el: el, url: url, title: url,
        loading: false, ready: false, canGoBack: false, canGoForward: false, pending: url,
      };
      tabs.push(tab);
      attachEvents(tab);
      if (makeActive !== false) activeId = tab.id;
      applyGeometry();
      pushState();
      return tab;
    }).catch(function () { return null; }).then(function (tab) { creating = null; return tab; });
    return creating;
  }

  function dropTab(id, replace) {
    var at = -1;
    for (var i = 0; i < tabs.length; i++) if (tabs[i].id === id) { at = i; break; }
    if (at < 0) return;
    var tab = tabs[at];
    tabs.splice(at, 1);
    if (tab.lease !== undefined) { try { BRIDGE.browserRelease(tab.lease).catch(function () { }); } catch (e) { } }
    try { tab.el.remove(); } catch (e) { }
    if (activeId === id) activeId = tabs.length > 0 ? tabs[tabs.length - 1].id : '';
    applyGeometry();
    pushState();
    if (replace !== false && tabs.length === 0) void createTab(START_URL, true);
  }

  function navigate(tab, url) {
    tab.url = url;
    tab.title = tab.title || url;
    if (tab.ready === true) {
      try { tab.el.loadURL(url); } catch (e) { }
    } else {
      tab.pending = url;
    }
  }

  function navAction(action) {
    var tab = active();
    if (tab === null) return;
    var el = tab.el;
    try {
      if (action === 'back') { if (el.canGoBack() === true) el.goBack(); }
      else if (action === 'forward') { if (el.canGoForward() === true) el.goForward(); }
      else if (action === 'reload') el.reload();
      else if (action === 'stop') el.stop();
      else if (action === 'home') navigate(tab, START_URL);
      else if (action === 'zoomIn') { zoom = Math.min(3, Math.round((zoom + 0.1) * 100) / 100); el.setZoomFactor(zoom); }
      else if (action === 'zoomOut') { zoom = Math.max(0.25, Math.round((zoom - 0.1) * 100) / 100); el.setZoomFactor(zoom); }
      else if (action === 'zoomReset') { zoom = 1; el.setZoomFactor(1); }
    } catch (e) { }
    pushState();
  }

  function dockDragging() {
    try { return globalThis.__DSH_DOCK_DRAGGING__ === true; } catch (e) { return false; }
  }

  function handle(payload) {
    if (payload === null || typeof payload !== 'object') return;
    if (payload.kind !== 'dsh-embed') return;
    var cmd = payload.cmd;
    if (cmd === 'hide') {
      applyGeometry();
      return;
    }
    if (cmd === 'icon') {
      var tab = active();
      var url = tab === null ? '' : (favicons[tab.lease] || '');
      bus.dispatch({ kind: 'dsh-embed-icon', icon: url });
      return;
    }
    if (cmd === 'download') { BRIDGE.browserDownload(payload.id, payload.action); return; }
    if (cmd === 'shelf') { return; }
    if (typeof payload.x === 'number' && typeof payload.w === 'number') {
      rect = { x: payload.x, y: payload.y, w: payload.w, h: payload.h };
    }
    if (cmd === 'nav') { navAction(payload.action); return; }
    if (cmd === 'newTab') { void createTab(payload.url || START_URL, true); return; }
    if (cmd === 'closeTab') { dropTab(payload.id, true); return; }
    if (cmd === 'selectTab') {
      activeId = payload.id;
      applyGeometry();
      pushState();
      return;
    }
    if (cmd === 'open' || cmd === 'rect') {
      visible = true;
      if (tabs.length === 0) { void createTab(payload.url || START_URL, true); return; }
      var current = active();
      if (current === null) { activeId = tabs[0].id; current = tabs[0]; }
      if (cmd === 'open' && typeof payload.url === 'string' && payload.url.length > 0 && payload.url !== current.url) {
        navigate(current, payload.url);
      }
      applyGeometry();
      pushState();
    }
  }

  try {
    BRIDGE.subscribe(function (message) {
      if (message === null || typeof message !== 'object') return;
      if (message.type === 'attached') {
        var tab = byLease(message.lease);
        if (tab === null || tab.ready === true) return;
        tab.ready = true;
        try { tab.el.setZoomFactor(zoom); } catch (e) { }
        try { tab.el.src = tab.pending || START_URL; } catch (e) { }
        return;
      }
      if (message.type === 'favicon') { favicons[message.lease] = message.url; return; }
      if (message.type === 'open-request') {
        if (typeof message.url === 'string' && message.url.length > 0) void createTab(message.url, true);
        return;
      }
      if (message.type === 'focusurl') {
        var box = document.querySelector('.eb_url');
        if (box !== null) { try { box.focus(); box.select(); } catch (e) { } }
      }
    });
  } catch (e) { }

  var target = window.chrome;
  if (target === undefined || target === null) target = {};
  try {
    target.webview = { postMessage: handle, addEventListener: function (t, f) { bus.addEventListener(t, f); },
      removeEventListener: function (t, f) { bus.removeEventListener(t, f); }, __dshShell: true };
  } catch (e) { }
  if (window.chrome === undefined || window.chrome === null || window.chrome.webview === undefined) {
    try {
      Object.defineProperty(window, 'chrome', { value: target, configurable: true, writable: true });
    } catch (e) { }
  }
  function paneChrome() {
    if (document.head === null) {
      document.addEventListener('DOMContentLoaded', function () { try { paneChrome(); } catch (e) { } }, { once: true });
      return;
    }
    if (document.getElementById('__dsh_pane_chrome__') !== null) return;
    var style = document.createElement('style');
    style.id = '__dsh_pane_chrome__';
    style.textContent = [
      '[class*="_tabHostHeader_"]{height:30px!important}',
      '[class*="_tabStrip_"]{height:28px;padding-top:2px!important}',
      '[class*="dhJKeW_header"]{display:none!important}',
      '[class*="vk_viewerBar"]{display:none!important}',
      '[data-dsh-toolbar="1"]{display:none!important}',
      '#__dsh_ctx__{position:fixed;z-index:2147483000;min-width:186px;max-width:420px;padding:4px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#222);border:.5px solid var(--dsw-alias-border-l2,#444);box-shadow:0 12px 32px rgba(0,0,0,.45);font-size:12px;line-height:1.3;color:var(--dsw-alias-label-primary,#eee);font-family:var(--dsw-font,inherit)}',
      '#__dsh_ctx__ .ctx_row{display:flex;align-items:center;gap:8px;height:26px;padding:0 8px;border-radius:6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#__dsh_ctx__ .ctx_row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',
      '#__dsh_ctx__ .ctx_title{padding:3px 8px 6px;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#__dsh_ctx__ .ctx_group{padding:5px 8px 2px;color:var(--dsw-alias-label-tertiary,#999);font-size:11px}',
      '#__dsh_ctx__ .ctx_row[data-disabled="1"]{opacity:.45;cursor:default}',
      '#__dsh_ctx__ .ctx_row[data-disabled="1"]:hover{background:transparent}',
      '#__dsh_ctx__ .ctx_sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l2,#333)}',
    ].join('');
    document.head.appendChild(style);

    var menu = null;
    function closeMenu() {
      if (menu !== null) { menu.remove(); menu = null; }
    }
    function paneScope(anchor) {
      return anchor.closest('[data-dockkit-content]') || anchor.closest('[class*="_tabHost_"]') || anchor;
    }
    function visible(el) {
      if (el === null || el === undefined) return false;
      if (el.getClientRects().length === 0) return false;
      var rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    var MARKERS = '[data-document-preview],[data-code-preview],[data-html-preview],[data-image-preview],[data-pdf-preview],.vk_viewerTab';
    function activeViewer(scope) {
      var marks = scope.querySelectorAll(MARKERS);
      var best = null;
      for (var i = 0; i < marks.length; i++) if (visible(marks[i])) best = marks[i];
      return best;
    }
    function collect(scope) {
      var viewer = activeViewer(scope);
      var root = viewer || scope;
      var path = '';
      var pathNode = scope.querySelector('[data-textpreview-path]');
      if (pathNode !== null && visible(pathNode)) path = (pathNode.textContent || '').trim();
      var titleNode = scope.querySelector('[data-dockkit-tab-title]');
      if (path.length === 0 && titleNode !== null) path = (titleNode.textContent || '').trim();
      if (path.length !== 0 && titleNode !== null) {
        var full = vkFullPath(root);
        if (full.length > 0) path = full;
      }
      var buttons = [];
      var all = root.querySelectorAll('button');
      for (var i = 0; i < all.length; i++) {
        if (all[i].closest('[class*="_tabStrip_"]') !== null) continue;
        if (all[i].closest('[class*="_tabHostHeader_"]') !== null) continue;
        if (all[i].disabled === true) continue;
        if (viewer === null && visible(all[i]) !== true) continue;
        buttons.push(all[i]);
      }
      return { path: path, buttons: buttons };
    }
    function vkFullPath(root) {
      var nodes = root.querySelectorAll('[title]');
      for (var i = 0; i < nodes.length; i++) {
        var t = nodes[i].getAttribute('title') || '';
        if (/^[A-Za-z]:[\\/]/.test(t) || /^\\\\/.test(t)) return t;
      }
      var texts = root.querySelectorAll('span,div');
      for (var j = 0; j < texts.length; j++) {
        if (texts[j].children.length !== 0) continue;
        var v = (texts[j].textContent || '').trim();
        if ((/^[A-Za-z]:[\\/]/.test(v) || /^\\\\/.test(v)) && v.length < 400) return v;
      }
      return '';
    }
    function inBrowseUi(el) {
      return el.closest('[class*="vk_browse"]') !== null || el.closest('[class*="vk_pick"]') !== null;
    }
    function markToolbars() {
      var marked = document.querySelectorAll('[data-dsh-toolbar="1"]');
      for (var k = 0; k < marked.length; k++) {
        if (marked[k].closest('[class*="eb_"]') !== null || marked[k].closest('#__dsh_embed_layer__') !== null || inBrowseUi(marked[k])) {
          marked[k].removeAttribute('data-dsh-toolbar');
        }
      }
      var panes = document.querySelectorAll('[data-dockkit-content]');
      for (var i = 0; i < panes.length; i++) {
        var nodes = panes[i].querySelectorAll('div,section,header,nav');
        for (var j = 0; j < nodes.length; j++) {
          var el = nodes[j];
          if (el.getAttribute('data-dsh-toolbar') === '1') continue;
          if (el.closest('[class*="eb_"]') !== null) continue;
          if (inBrowseUi(el)) continue;
          if (el.closest('[class*="_tabStrip_"]') !== null || el.closest('[class*="_tabHostHeader_"]') !== null) continue;
          if (el.children.length > 8) continue;
          var rect = el.getBoundingClientRect();
          if (rect.height < 18 || rect.height > 46) continue;
          if (rect.width < 140) continue;
          var hasButton = el.querySelector('button') !== null;
          var text = (el.textContent || '').trim();
          var looksPath = /^[A-Za-z]:[\\/]|^\//.test(text) || /\.(pdf|png|jpe?g|gif|webp|svg|mp4|mov|mkv|webm|docx?|xlsx?|pptx?|md|txt|csv|json|html?)$/i.test(text);
          if (!hasButton && !looksPath) continue;
          if (el.querySelector('[data-dockkit-tab-title]') !== null) continue;
          el.setAttribute('data-dsh-toolbar', '1');
        }
      }
    }
    function openDropdownItems() {
      var out = [];
      var nodes = document.querySelectorAll('body *');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (el.closest !== undefined && el.closest('#__dsh_ctx__') !== null) continue;
        if (el.children.length > 2) continue;
        var text = (el.textContent || '').trim();
        if (text.length === 0 || text.length > 16) continue;
        var cs = window.getComputedStyle(el);
        if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        var rect = el.getBoundingClientRect();
        if (rect.width < 28 || rect.height < 14 || rect.height > 52) continue;
        out.push({ el: el, text: text });
      }
      return out;
    }
    function row(label, action) {
      var el = document.createElement('div');
      el.className = 'ctx_row';
      el.textContent = label;
      if (typeof action !== 'function') {
        el.setAttribute('data-disabled', '1');
        return el;
      }
      el.addEventListener('click', function () { closeMenu(); try { action(); } catch (e) { } });
      return el;
    }
    function sep() { var el = document.createElement('div'); el.className = 'ctx_sep'; return el; }
    function withBarLayout(node, run) {
      var bar = node.closest('[class*="vk_viewerBar"],[class*="dhJKeW_header"],[data-dsh-toolbar="1"]');
      var savedStyle = null;
      var savedMask = null;
      var restore = function () { };
      if (bar !== null) {
        savedStyle = bar.getAttribute('style') || '';
        savedMask = bar.getAttribute('data-dsh-toolbar');
        restore = function () {
          bar.setAttribute('style', savedStyle);
          if (savedMask !== null) bar.setAttribute('data-dsh-toolbar', savedMask);
        };
        try {
          bar.removeAttribute('data-dsh-toolbar');
          bar.style.setProperty('display', 'flex', 'important');
          bar.style.setProperty('position', 'fixed', 'important');
          bar.style.setProperty('left', '2px', 'important');
          bar.style.setProperty('top', '2px', 'important');
          bar.style.setProperty('width', '360px', 'important');
          bar.style.setProperty('z-index', '-1', 'important');
        } catch (e) { }
      }
      run();
      window.setTimeout(restore, 420);
    }
    function probeMode(mode, pickLabel, done) {
      withBarLayout(mode, function () {
        try { mode.click(); } catch (e) { }
        window.setTimeout(function () {
          var items = openDropdownItems();
          if (pickLabel === null) {
            try { mode.click(); } catch (e) { }
          } else {
            var hit = null;
            for (var i = 0; i < items.length; i++) if (items[i].text === pickLabel) { hit = items[i]; break; }
            try { if (hit !== null) hit.el.click(); else mode.click(); } catch (e) { }
          }
          window.setTimeout(function () { try { done(items); } catch (e) { } }, 40);
        }, 200);
      });
    }
    function fillModes(mode, menu, group) {
      var insert = function (rows) {
        if (rows.length === 0) {
          if (group.parentNode !== null) group.parentNode.removeChild(group);
          return;
        }
        var anchor = group.nextSibling;
        for (var i = 0; i < rows.length; i++) {
          (function (spec) {
            var entry = row(spec.label, typeof spec.run === 'function' ? function () { try { spec.run(); } catch (e) { } } : null);
            menu.insertBefore(entry, anchor);
          })(rows[i]);
        }
      };
      var registered = null;
      try { registered = globalThis.__dshViewerMenu; } catch (e) { registered = null; }
      if (registered !== null && registered !== undefined && Array.isArray(registered.items) && registered.items.length > 0) {
        if (typeof registered.label === 'string' && registered.label.length > 0) group.textContent = registered.label;
        var rows = [];
        for (var i = 0; i < registered.items.length; i++) {
          var item = registered.items[i];
          if (item === null || item === undefined || typeof item.label !== 'string' || item.label.length === 0) continue;
          rows.push({ label: item.label, run: item.run });
        }
        insert(rows);
        return;
      }
      probeMode(mode, null, function (items) {
        var rows = [];
        for (var j = 0; j < items.length; j++) rows.push({ label: items[j].text, run: null });
        insert(rows);
      });
    }
    function openMenu(x, y, anchor) {
      closeMenu();
      markToolbars();
      var gathered = collect(paneScope(anchor));
      var path = gathered.path;
      var buttons = gathered.buttons;
      menu = document.createElement('div');
      menu.id = '__dsh_ctx__';
      if (path.length > 0) {
        var title = document.createElement('div');
        title.className = 'ctx_title';
        title.textContent = path;
        title.title = path;
        menu.appendChild(title);
      }
      var mode = null;
      for (var i = 0; i < buttons.length; i++) {
        var aria = buttons[i].getAttribute('aria-label') || '';
        if (aria === '打开方式') { mode = buttons[i]; continue; }
        var label = aria.length > 0 ? aria : (buttons[i].getAttribute('title') || '').trim();
        if (label.length === 0) continue;
        if (buttons[i].getAttribute('aria-pressed') === 'true') label = label + '  ✓';
        (function (button, name) { menu.appendChild(row(name, function () { button.click(); })); })(buttons[i], label);
      }
      var modeGroup = null;
      if (mode !== null) {
        modeGroup = document.createElement('div');
        modeGroup.className = 'ctx_group';
        modeGroup.textContent = '打开方式';
        menu.appendChild(modeGroup);
      }
      if (menu.childElementCount > 1) menu.appendChild(sep());
      if (path.length > 0) {
        menu.appendChild(row('复制路径', function () {
          try {
            if (navigator.clipboard !== undefined) { void navigator.clipboard.writeText(path); return; }
          } catch (e) { }
          var area = document.createElement('textarea');
          area.value = path;
          document.body.appendChild(area);
          area.select();
          try { document.execCommand('copy'); } catch (e) { }
          area.remove();
        }));
      }
      document.body.appendChild(menu);
      var box = menu.getBoundingClientRect();
      menu.style.left = Math.max(4, Math.min(x, window.innerWidth - box.width - 6)) + 'px';
      menu.style.top = Math.max(4, Math.min(y, window.innerHeight - box.height - 6)) + 'px';
      if (modeGroup !== null && mode !== null) fillModes(mode, menu, modeGroup);
    }
    function isEditable(node) {
      var el = node;
      while (el !== null && el !== undefined && el.nodeType === 1) {
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.disabled !== true;
        if (el.isContentEditable === true) return true;
        el = el.parentElement;
      }
      return false;
    }
    function openAppMenu(x, y, node) {
      closeMenu();
      var selected = String(window.getSelection()).length > 0;
      var editable = isEditable(node);
      menu = document.createElement('div');
      menu.id = '__dsh_ctx__';
      menu.appendChild(row('新建会话', function () {
        var all = document.querySelectorAll('button');
        for (var i = 0; i < all.length; i++) {
          if ((all[i].textContent || '').trim().indexOf('新会话') === 0) { all[i].click(); return; }
        }
      }));
      menu.appendChild(row('重新加载界面', function () { BRIDGE.edit('reload'); }));
      menu.appendChild(sep());
      menu.appendChild(row('复制', selected ? function () { BRIDGE.edit('copy'); } : null));
      menu.appendChild(row('粘贴', editable ? function () { BRIDGE.edit('paste'); } : null));
      menu.appendChild(row('全选', function () { BRIDGE.edit('selectAll'); }));
      menu.appendChild(sep());
      menu.appendChild(row('开发者工具', function () { BRIDGE.edit('devtools'); }));
      document.body.appendChild(menu);
      var box = menu.getBoundingClientRect();
      menu.style.left = Math.max(4, Math.min(x, window.innerWidth - box.width - 6)) + 'px';
      menu.style.top = Math.max(4, Math.min(y, window.innerHeight - box.height - 6)) + 'px';
    }

    document.addEventListener('contextmenu', function (event) {
      var node = event.target;
      if (node === null || node === undefined || typeof node.closest !== 'function') return;
      var pane = node.closest('[data-dockkit-content]');
      if (pane !== null) {
        if (node.closest('[class*="vk_cmd"]') !== null) return;
        event.preventDefault();
        event.stopPropagation();
        openMenu(event.clientX, event.clientY, pane);
        return;
      }
      if (node.closest('[class*="eb_stage"]') !== null) return;
      event.preventDefault();
      event.stopPropagation();
      openAppMenu(event.clientX, event.clientY, node);
    }, true);
    document.addEventListener('mousedown', function (event) {
      if (menu === null) return;
      if (menu.contains(event.target)) return;
      closeMenu();
    }, true);
    document.addEventListener('keydown', function (event) { if (event.key === 'Escape') closeMenu(); }, true);
    window.addEventListener('blur', closeMenu);
    try { markToolbars(); } catch (e) { }
    window.setInterval(function () { try { markToolbars(); } catch (e) { } }, 1200);
    var pendingScan = false;
    try {
      new MutationObserver(function () {
        if (pendingScan) return;
        pendingScan = true;
        window.requestAnimationFrame(function () {
          pendingScan = false;
          try { markToolbars(); } catch (e) { }
        });
      }).observe(document.body, { childList: true, subtree: true });
    } catch (e) { }
  }

  try { paneChrome(); } catch (e) { }

  if (window.chrome !== undefined && window.chrome !== null && window.chrome.webview !== undefined) {
    window.chrome.webview.__dshShell = true;
  }
})();
`

function injectShim() {
  try { void webFrame.executeJavaScript(SHIM) } catch { /* retry below */ }
  const install = () => {
    try { void webFrame.executeJavaScript(SHIM) } catch { /* document is gone */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install)
  else install()
}

injectShim()
