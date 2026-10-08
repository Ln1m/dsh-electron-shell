const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshTray', {
  ready: (size) => { ipcRenderer.send('tray:size', size) },
  action: (id) => { ipcRenderer.send('tray:action', id) },
  close: () => { ipcRenderer.send('tray:close') },
  onStatus: (listener) => { ipcRenderer.on('tray:status', (_event, value) => { listener(value) }) },
})
