'use strict'

const { randomUUID } = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs')
const { app, session, shell } = require('electron')

const EMBED_PARTITION = 'persist:dsh-embedded-browser'
const EMBED_PRELOAD = path.join(__dirname, 'preload-embed.js')

class DesktopBrowserGuests {
  constructor(options) {
    this.hostUrl = options.hostUrl
    this.onDownload = options.onDownload || (() => {})
    this.onAttached = options.onAttached || (() => {})
    this.onOpenRequest = options.onOpenRequest || (() => {})
    this.onFavicon = options.onFavicon || (() => {})
    this.leases = new Map()
    this.sessionReady = false
    this.downloads = new Map()
  }

  acquire(owner) {
    if (!this.sessionReady) {
      this.configureSession(session.fromPartition(EMBED_PARTITION))
      this.sessionReady = true
    }
    const lease = randomUUID()
    this.leases.set(lease, { owner, partition: EMBED_PARTITION, attached: false, guest: undefined })
    return { lease, partition: EMBED_PARTITION }
  }

  async release(owner, id) {
    if (typeof id !== 'string') return
    const lease = this.leases.get(id)
    if (lease === undefined) return
    if (lease.owner !== owner) return
    this.leases.delete(id)
    const guest = lease.guest
    if (guest !== undefined && !guest.isDestroyed()) {
      const destroyed = new Promise((resolve) => { guest.once('destroyed', resolve) })
      guest.close({ waitForBeforeUnload: false })
      await destroyed
    }
  }

  bind(window) {
    const owner = window.webContents
    owner.on('will-attach-webview', (event, preferences, params) => {
      const id = typeof params.src === 'string' && params.src.startsWith('about:blank#')
        ? params.src.slice('about:blank#'.length) : ''
      const lease = this.leases.get(id)
      if (lease === undefined || lease.owner !== owner || lease.attached || params.partition !== lease.partition) {
        event.preventDefault()
        return
      }
      lease.attached = true
      for (const key of Object.keys(preferences)) {
        if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
      }
      Object.assign(preferences, {
        partition: lease.partition,
        preload: EMBED_PRELOAD,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true,
        devTools: true,
      })
      params.httpreferrer = ''
    })
    owner.on('did-attach-webview', (_event, guest) => {
      let attachedLease
      guest.once('dom-ready', () => {
        const url = guest.getURL()
        const id = url.startsWith('about:blank#') ? url.slice('about:blank#'.length) : ''
        const lease = this.leases.get(id)
        if (lease === undefined || lease.owner !== owner || lease.guest !== undefined) {
          guest.close({ waitForBeforeUnload: false })
          return
        }
        lease.guest = guest
        attachedLease = id
        guest.once('destroyed', () => { this.leases.delete(id) })
        this.onAttached(id)
      })
      guest.setWindowOpenHandler(({ url, postBody }) => {
        const lease = attachedLease === undefined ? undefined : this.leases.get(attachedLease)
        if (attachedLease !== undefined && lease?.guest === guest && lease.owner === owner && !owner.isDestroyed()
          && postBody === undefined && this.allowedNavigation(url)) {
          this.onOpenRequest(attachedLease, new URL(url).href)
        }
        return { action: 'deny' }
      })
      guest.on('will-frame-navigate', (event) => {
        if (event.isMainFrame && !this.allowedNavigation(event.url)) event.preventDefault()
      })
      guest.on('will-redirect', (event, url, _inPlace, mainFrame) => {
        if (mainFrame && !this.allowedNavigation(url)) event.preventDefault()
      })
      guest.on('will-attach-webview', (event) => { event.preventDefault() })
      guest.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
      guest.on('page-favicon-updated', (_event, favicons) => {
        if (attachedLease !== undefined && Array.isArray(favicons) && favicons.length > 0) {
          this.onFavicon(attachedLease, favicons[0])
        }
      })
    })
    const releaseAll = () => {
      for (const [id, lease] of this.leases) {
        if (lease.owner === owner) void this.release(owner, id).catch(() => {})
      }
    }
    owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) releaseAll()
    })
    owner.on('render-process-gone', releaseAll)
    owner.once('destroyed', releaseAll)
  }

  configureSession(browserSession) {
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setDevicePermissionHandler(() => false)
    browserSession.setDisplayMediaRequestHandler((_request, callback) => { callback({}) })
    browserSession.on('will-download', (event, item) => {
      const id = randomUUID()
      const name = item.getFilename()
      let target = path.join(app.getPath('downloads'), name)
      try {
        const ext = path.extname(name)
        const stem = name.slice(0, name.length - ext.length)
        let n = 1
        while (fs.existsSync(target)) { target = path.join(app.getPath('downloads'), `${stem} (${n})${ext}`); n += 1 }
      } catch { /* keep the plain target */ }
      item.setSavePath(target)
      const entry = { id, name, received: 0, total: item.getTotalBytes(), state: 'active', path: target }
      this.downloads.set(id, { entry, item })
      item.on('updated', (_e, state) => {
        entry.received = item.getReceivedBytes()
        entry.total = item.getTotalBytes()
        entry.state = state === 'interrupted' ? 'fail' : 'active'
        if (state === 'interrupted') entry.reason = '下载中断'
        this.onDownload(id)
      })
      item.once('done', (_e, state) => {
        entry.received = item.getReceivedBytes()
        entry.total = item.getTotalBytes()
        entry.state = state === 'completed' ? 'done' : 'fail'
        if (state !== 'completed') entry.reason = state === 'cancelled' ? '已取消' : '下载失败'
        this.onDownload(id)
      })
    })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      let url
      try { url = new URL(details.url) } catch { callback({}); return }
      const network = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      callback({ cancel: network
        ? url.username !== '' || url.password !== '' || this.isApplicationHost(url)
        : !['about:', 'data:', 'blob:'].includes(url.protocol) })
    })
  }

  downloadAction(id, action) {
    const record = this.downloads.get(id)
    if (action === 'clear') { this.downloads.delete(id); return }
    if (record === undefined) return
    const { entry, item } = record
    if (action === 'cancel') { try { item.cancel() } catch { /* already settled */ } return }
    if (action === 'open') { void shell.openPath(entry.path); return }
    if (action === 'reveal') { shell.showItemInFolder(entry.path) }
  }

  listDownloads() {
    return [...this.downloads.values()].map(({ entry }) => ({
      id: entry.id, name: entry.name, received: entry.received, total: entry.total,
      state: entry.state, reason: entry.reason, path: entry.path,
    }))
  }

  allowedNavigation(value) {
    let url
    try { url = new URL(value) } catch { return false }
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === ''
      && !this.isApplicationHost(url)
  }

  isApplicationHost(url) {
    const value = this.hostUrl()
    if (value === undefined || value === null) return false
    let host
    try { host = new URL(value) } catch { return false }
    return url.port === host.port
      && (url.hostname === host.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  }
}

module.exports = { DesktopBrowserGuests, EMBED_PARTITION }
