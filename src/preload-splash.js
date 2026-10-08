'use strict'

const { contextBridge, ipcRenderer, webFrame } = require('electron')

contextBridge.exposeInMainWorld('__DSH_SPLASH__', {
  post: (kind) => { ipcRenderer.send('splash:message', String(kind)) },
})

webFrame.executeJavaScript(`(function () {
  var bridge = window.__DSH_SPLASH__;
  if (bridge === undefined || bridge === null) return;
  var webview = { postMessage: function (message) {
    try { bridge.post(message !== null && typeof message === 'object' ? message.kind : ''); } catch (e) { }
  } };
  try { Object.defineProperty(window, 'chrome', { value: { webview: webview }, configurable: true, writable: true }); } catch (e) { }
})();`)

ipcRenderer.on('splash:ready', () => {
  void webFrame.executeJavaScript('window.__splashReady !== undefined && window.__splashReady !== null ? window.__splashReady() : undefined')
})
