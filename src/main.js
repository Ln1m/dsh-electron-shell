'use strict'

const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, nativeImage, nativeTheme, shell, protocol, net, session, clipboard, screen } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { DesktopBrowserGuests } = require('./browser-guests.js')

const ROOT = process.env.DSH_ROOT || 'D:\\DeepSeek_harness'
const SHELL_DIR = path.join(__dirname, '..')
const LOG_DIR = path.join(SHELL_DIR, 'logs')
const NODE_EXE = process.env.DSH_NODE || 'C:\\Program Files\\nodejs\\node.exe'
const DSH_BIN = path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const ICON = path.join(SHELL_DIR, 'assets', 'app.png')
const TRAY_ICON = path.join(SHELL_DIR, 'assets', 'tray.ico')
const BOOT_SPLASH = path.join(ROOT, 'assets', 'boot-splash')
const PRELOAD = path.join(__dirname, 'preload-app.js')
const SPLASH_PRELOAD = path.join(__dirname, 'preload-splash.js')
const TRAY_PRELOAD = path.join(__dirname, 'preload-tray.js')
const TRAY_MENU = path.join(SHELL_DIR, 'renderer', 'tray-menu.html')
const DEFAULT_PORT = Number(process.env.DSH_SHELL_PORT || 3090)
const CDP_PORT = Number(process.env.DSH_SHELL_CDP_PORT || 9333)
const USE_OVERLAY_TITLEBAR = process.env.DSH_SHELL_TITLEBAR === 'overlay'
const MAX_LOG_BYTES = 4 * 1024 * 1024

let mainWindow = null
let splashWindow = null
let tray = null
let menuWindow = null
let trayMenuSize = { width: 232, height: 192 }
let engine = null
let browserGuests = null
let quitting = false
let hostUrl = null
let appPort = DEFAULT_PORT
let enginePort = 0

function log(name, line) {
  if (line === undefined || line === null || String(line).length === 0) return
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    const file = path.join(LOG_DIR, name)
    try { if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, file + '.1') } catch { /* absent */ }
    fs.appendFileSync(file, String(line) + '\r\n')
  } catch { /* logging must never break the shell */ }
}

class EngineProcess {
  constructor() {
    this.child = null
    this.url = null
    this.stopping = false
    this.buffer = ''
    this.tail = ''
  }

  start(port) {
    return new Promise((resolve, reject) => {
      let settled = false
      const args = [DSH_BIN, 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open']
      log('engine.log', '=== start ' + new Date().toISOString() + ' port=' + String(port) + ' args=' + args.join(' '))
      const child = spawn(NODE_EXE, args, {
        cwd: ROOT,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      })
      this.child = child
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { log('engine.log', chunk.replace(/\r?\n$/, '')); this.consume(chunk, resolve) })
      child.stderr.on('data', (chunk) => {
        this.tail = (this.tail + chunk).slice(-8192)
        log('engine.err.log', chunk.replace(/\r?\n$/, ''))
      })
      child.on('error', (error) => { if (!settled) { settled = true; reject(error) } })
      child.on('close', (code) => {
        log('engine.log', '=== exit ' + new Date().toISOString() + ' code=' + String(code))
        if (!settled && !this.stopping) {
          settled = true
          const detail = this.tail.trim() || ('exit code ' + String(code))
          reject(new Error(detail))
        }
      })
    }).then((url) => { this.url = url; return url })
  }

  consume(chunk, resolve) {
    this.buffer += chunk
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() || ''
    for (const line of lines) {
      const match = /dsh web:\s*(http:\/\/127\.0\.0\.1:(\d+)\/\?token=[A-Za-z0-9_-]+)/.exec(line)
      if (match !== null && this.url === null) {
        this.url = match[1]
        enginePort = Number(match[2])
        resolve(match[1])
      }
    }
  }

  async stop() {
    const child = this.child
    if (child === null) return
    this.stopping = true
    try { child.stdout.destroy() } catch { /* closing pipes is what makes the engine exit */ }
    try { child.stderr.destroy() } catch { /* ignore */ }
    const closed = new Promise((resolve) => { child.once('close', resolve) })
    const timer = setTimeout(() => { try { child.kill() } catch { /* already gone */ } }, 3000)
    timer.unref?.()
    await closed
    clearTimeout(timer)
    this.child = null
  }

  hintFromTail() { return this.tail }
}

function startSplash() {
  splashWindow = new BrowserWindow({
    width: 1000,
    height: 563,
    frame: false,
    resizable: false,
    movable: false,
    show: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: SPLASH_PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      partition: 'splash-boot',
    },
  })
  splashWindow.once('ready-to-show', () => { try { splashWindow.center() } catch { /* ignore */ } })
  splashWindow.loadURL('splash://boot/').catch((error) => { log('shell.log', 'splash load failed: ' + error.message) })
}

function registerSplashProtocol() {
  session.fromPartition('splash-boot').protocol.handle('splash', (request) => {
    const url = new URL(request.url)
    let name = decodeURIComponent(url.pathname)
    if (name === '/' || name === '') name = '/index.html'
    if (name === '/config.json') return new Response('{}', { headers: { 'content-type': 'application/json' } })
    const base = name.startsWith('/videos/') ? name.slice('/videos/'.length) : name.slice(1)
    const target = path.join(BOOT_SPLASH, base)
    if (!target.startsWith(BOOT_SPLASH)) return new Response(null, { status: 403 })
    return net.fetch(pathToFileURL(target).toString())
  })
}

function createMainWindow() {
  const dark = nativeTheme.shouldUseDarkColors
  const workArea = screen.getPrimaryDisplay().workAreaSize
  let width = Math.round(workArea.width * 0.75)
  let height = Math.round(width * 9 / 16)
  if (height > Math.round(workArea.height * 0.90)) {
    height = Math.round(workArea.height * 0.90)
    width = Math.round(height * 16 / 9)
  }
  if (width < 800) width = 800
  if (height < 500) height = 500
  log('shell.log', 'window size ' + String(width) + 'x' + String(height) + ' from work area ' + String(workArea.width) + 'x' + String(workArea.height))
  const windowIcon = nativeImage.createFromPath(ICON)
  log('shell.log', 'window icon empty=' + String(windowIcon.isEmpty()) + ' size=' + JSON.stringify(windowIcon.getSize()))
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 720,
    minHeight: 520,
    center: true,
    show: false,
    title: 'DeepSeek Harness',
    icon: windowIcon.isEmpty() ? ICON : windowIcon,
    backgroundColor: dark ? '#151517' : '#ffffff',
    autoHideMenuBar: true,
    ...(USE_OVERLAY_TITLEBAR && process.platform === 'win32' ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: { height: 36, color: dark ? '#151517' : '#f2f2f2', symbolColor: dark ? '#f9fafb' : '#0f1115' },
    } : {}),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: true,
      devTools: true,
      spellcheck: false,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let parsed
    try { parsed = new URL(url) } catch { return { action: 'deny' } }
    if (isHostUrl(parsed)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1620,
          height: 911,
          autoHideMenuBar: true,
          icon: ICON,
          webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
        },
      }
    }
    if (['http:', 'https:'].includes(parsed.protocol)) void shell.openExternal(parsed.href)
    return { action: 'deny' }
  })

  mainWindow.on('page-title-updated', (event) => { event.preventDefault() })

  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    mainWindow.hide()
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('shell.log', 'renderer gone: ' + JSON.stringify(details))
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    let parsed
    try { parsed = new URL(url) } catch { event.preventDefault(); return }
    if (isHostUrl(parsed)) return
    event.preventDefault()
    if (['http:', 'https:'].includes(parsed.protocol)) void shell.openExternal(parsed.href)
  })

  browserGuests = new DesktopBrowserGuests({
    hostUrl: () => hostUrl,
    onAttached: (lease) => { sendToPage({ type: 'attached', lease }) },
    onOpenRequest: (lease, url) => { sendToPage({ type: 'open-request', lease, url }) },
    onFavicon: (lease, url) => { sendToPage({ type: 'favicon', lease, url }) },
    onDownload: () => { sendToPage({ type: 'downloads', items: browserGuests.listDownloads() }) },
  })
  browserGuests.bind(mainWindow)
  return mainWindow
}

function isHostUrl(url) {
  if (!['http:', 'https:'].includes(url.protocol)) return false
  return url.port === String(enginePort)
    && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
}

function sendToPage(payload) {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  try { mainWindow.webContents.send('shell:push', payload) } catch { /* window is going away */ }
}

function attachGuestHooks() {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return
    contents.on('context-menu', (_e, params) => { showBrowserMenu(contents, params) })
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.control !== true) return
      const key = String(input.key).toLowerCase()
      if (key === 'l') { event.preventDefault(); sendToPage({ type: 'focusurl' }) }
    })
  })
}

function showBrowserMenu(contents, params) {
  const items = []
  if (params.linkURL) {
    items.push({ label: '在新标签页中打开链接', click: () => { void openInNewTab(params.linkURL) } })
    items.push({ label: '在系统浏览器中打开链接', click: () => { void shell.openExternal(params.linkURL) } })
    items.push({ label: '复制链接地址', click: () => { clipboard.writeText(params.linkURL) } })
    items.push({ type: 'separator' })
  }
  if (params.mediaType === 'image' && params.srcURL) {
    items.push({ label: '复制图片地址', click: () => { clipboard.writeText(params.srcURL) } })
    items.push({ label: '在系统浏览器中打开图片', click: () => { void shell.openExternal(params.srcURL) } })
    items.push({ type: 'separator' })
  }
  if (params.isEditable) {
    items.push({ label: '撤销', role: 'undo' }, { label: '重做', role: 'redo' }, { type: 'separator' },
      { label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' }, { label: '粘贴', role: 'paste' },
      { label: '全选', role: 'selectAll' }, { type: 'separator' })
  } else if (params.selectionText) {
    items.push({ label: '复制', role: 'copy' }, { type: 'separator' })
  }
  items.push({ label: '后退', click: () => { try { if (contents.canGoBack()) contents.goBack() } catch { /* ignore */ } } })
  items.push({ label: '前进', click: () => { try { if (contents.canGoForward()) contents.goForward() } catch { /* ignore */ } } })
  items.push({ label: '重新加载', click: () => { try { contents.reload() } catch { /* ignore */ } } })
  items.push({ type: 'separator' })
  items.push({ label: '检查元素', click: () => { try { contents.inspectElement(params.x, params.y) } catch { /* ignore */ } } })
  try { Menu.buildFromTemplate(items).popup({ window: mainWindow }) } catch { /* window is gone */ }
}

async function openInNewTab(url) {
  sendToPage({ type: 'open-request', lease: '', url })
}

function createTray() {
  let image = nativeImage.createEmpty()
  try { image = nativeImage.createFromPath(TRAY_ICON) } catch { /* fall back to an empty icon */ }
  log('shell.log', 'tray icon empty=' + String(image.isEmpty()) + ' size=' + JSON.stringify(image.getSize()))
  tray = new Tray(image)
  tray.setToolTip('DeepSeek Harness')
  tray.on('click', () => { showMainWindow() })
  tray.on('right-click', () => { showTrayMenu() })
  createTrayMenuWindow()
}

function createTrayMenuWindow() {
  if (menuWindow !== null && !menuWindow.isDestroyed()) return menuWindow
  menuWindow = new BrowserWindow({
    width: trayMenuSize.width,
    height: trayMenuSize.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: TRAY_PRELOAD,
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  try { menuWindow.setMenu(null) } catch { /* ignore */ }
  menuWindow.on('blur', () => { hideTrayMenu() })
  menuWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); hideTrayMenu() } })
  menuWindow.loadFile(TRAY_MENU).catch((error) => { log('shell.log', 'tray menu load failed: ' + String(error && error.message)) })
  return menuWindow
}

function hideTrayMenu() {
  if (menuWindow === null || menuWindow.isDestroyed()) return
  try { menuWindow.hide() } catch { /* ignore */ }
}

function showTrayMenu() {
  const win = createTrayMenuWindow()
  let anchor = { x: 0, y: 0, width: 0, height: 0 }
  try { anchor = tray.getBounds() } catch { /* ignore */ }
  const area = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y }).workArea
  const size = trayMenuSize
  let x = Math.round(anchor.x + anchor.width / 2 - size.width / 2)
  let y = Math.round(anchor.y - size.height - 8)
  if (y < area.y + 4) y = Math.round(anchor.y + anchor.height + 8)
  x = Math.max(area.x + 4, Math.min(x, area.x + area.width - size.width - 4))
  y = Math.max(area.y + 4, Math.min(y, area.y + area.height - size.height - 4))
  win.setBounds({ x, y, width: size.width, height: size.height })
  try { win.webContents.send('tray:status', { dark: nativeTheme.shouldUseDarkColors, port: enginePort, up: engine !== null }) } catch { /* ignore */ }
  win.show()
  win.focus()
}

async function restartEngine() {
  if (engine === null) return
  log('shell.log', 'tray: restart engine')
  const previous = engine
  engine = null
  try { await previous.stop() } catch { /* already gone */ }
  try {
    engine = new EngineProcess()
    try {
      hostUrl = await engine.start(DEFAULT_PORT)
    } catch (error) {
      log('shell.log', 'tray restart: port busy, retrying on an ephemeral port')
      engine = new EngineProcess()
      hostUrl = await engine.start(0)
    }
    log('shell.log', 'tray restart: engine ready port=' + String(enginePort))
    if (mainWindow !== null && !mainWindow.isDestroyed()) await mainWindow.loadURL(hostUrl)
  } catch (error) {
    log('shell.log', 'tray restart failed: ' + String(error && error.message ? error.message : error))
  }
}

function showMainWindow() {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function sleep(ms) { return new Promise((resolve) => { setTimeout(resolve, ms) }) }

async function fadeIn(window) {
  try { window.setOpacity(1) } catch { /* unsupported */ }
  window.show()
}

function revealPage() {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  try { mainWindow.webContents.send('shell:fade-in') } catch { /* the page reveals itself on its own timer */ }
}

async function finishSplash() {
  if (splashWindow === null || splashWindow.isDestroyed()) return
  try { splashWindow.webContents.send('splash:ready') } catch { /* already gone */ }
}

async function quitApplication() {
  if (quitting) return
  const answer = await dialog.showMessageBox({
    type: 'question',
    buttons: ['退出', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: 'DeepSeek Harness',
    message: '确定退出 DeepSeek Harness？',
    detail: '正在运行的任务会被中断，引擎进程随外壳一起退出。',
  })
  if (answer.response !== 0) return
  quitting = true
  try { if (tray !== null) { tray.destroy(); tray = null } } catch { /* ignore */ }
  try { if (menuWindow !== null && !menuWindow.isDestroyed()) menuWindow.destroy(); menuWindow = null } catch { /* ignore */ }
  try { if (splashWindow !== null && !splashWindow.isDestroyed()) splashWindow.destroy() } catch { /* ignore */ }
  try { if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.destroy() } catch { /* ignore */ }
  if (engine !== null) await engine.stop()
  app.exit(0)
}

async function boot() {
  registerSplashProtocol()
  startSplash()
  attachGuestHooks()

  try {
    engine = new EngineProcess()
    hostUrl = await engine.start(DEFAULT_PORT)
  } catch (error) {
    const detail = String(error && error.message ? error.message : error)
    log('shell.log', 'engine start failed: ' + detail)
    if (/EADDRINUSE|address already in use/i.test(detail)) {
      try {
        engine = new EngineProcess()
        hostUrl = await engine.start(0)
      } catch (retry) {
        await failStart(retry)
        return
      }
    } else {
      await failStart(error)
      return
    }
  }

  log('shell.log', 'engine ready port=' + String(enginePort))
  createMainWindow()
  createTray()

  const started = Date.now()
  try {
    await mainWindow.loadURL(hostUrl)
  } catch (error) {
    log('shell.log', 'window load failed: ' + String(error && error.message))
  }
  const elapsed = Date.now() - started
  if (elapsed < 1200) await sleep(1200 - elapsed)
  await fadeIn(mainWindow)
  await finishSplash()
}

async function failStart(error) {
  const detail = String(error && error.message ? error.message : error)
  try {
    if (splashWindow !== null && !splashWindow.isDestroyed()) splashWindow.destroy()
  } catch { /* ignore */ }
  await dialog.showMessageBox({
    type: 'error',
    buttons: ['关闭'],
    title: 'DeepSeek Harness',
    message: 'DSH 服务未能启动',
    detail: detail.slice(0, 4000),
  })
  quitting = true
  app.exit(1)
}

app.setPath('userData', path.join(SHELL_DIR, 'userdata'))
try { app.setPath('crashDumps', path.join(SHELL_DIR, 'crashes')) } catch { /* not settable on every platform */ }

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT))
  app.setAppUserModelId('Ln1m.DeepSeekHarness.Shell')
  app.setName('DeepSeek Harness')
  protocol.registerSchemesAsPrivileged([{ scheme: 'splash', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

  app.on('second-instance', () => { showMainWindow() })
  app.on('window-all-closed', () => { /* the tray owns the process lifetime */ })
  process.on('uncaughtException', (error) => { log('shell.log', 'uncaught: ' + String(error && error.stack ? error.stack : error)) })

  let fadeClaimed = false

  ipcMain.on('shell:claim-fade', (event) => {
    const first = !fadeClaimed && mainWindow !== null && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents
    if (first) fadeClaimed = true
    event.returnValue = first
  })

  ipcMain.on('shell:window', (_event, action) => {
    if (mainWindow === null || mainWindow.isDestroyed()) return
    if (action === 'minimize') mainWindow.minimize()
    else if (action === 'maximize') { if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize() }
    else if (action === 'close') mainWindow.close()
  })

  ipcMain.on('tray:size', (event, size) => {
    if (menuWindow === null || menuWindow.isDestroyed() || event.sender !== menuWindow.webContents) return
    if (size === null || typeof size !== 'object') return
    const width = Math.max(180, Math.min(400, Math.round(Number(size.width) || 0)))
    const height = Math.max(120, Math.min(600, Math.round(Number(size.height) || 0)))
    if (width === trayMenuSize.width && height === trayMenuSize.height) return
    trayMenuSize = { width, height }
  })

  ipcMain.on('tray:close', (event) => {
    if (menuWindow === null || menuWindow.isDestroyed() || event.sender !== menuWindow.webContents) return
    hideTrayMenu()
  })

  ipcMain.on('tray:action', (event, id) => {
    if (menuWindow === null || menuWindow.isDestroyed() || event.sender !== menuWindow.webContents) return
    hideTrayMenu()
    if (id === 'open') showMainWindow()
    else if (id === 'reload') { if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.reload() }
    else if (id === 'restart') { void restartEngine() }
    else if (id === 'quit') { void quitApplication() }
  })

  ipcMain.handle('shell:browser-acquire', (event) => {
    if (mainWindow === null || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      throw new Error('browser acquire from an unexpected sender')
    }
    return browserGuests.acquire(event.sender)
  })

  ipcMain.handle('shell:browser-release', (event, lease) => {
    if (mainWindow === null || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return
    return browserGuests.release(event.sender, lease)
  })

  ipcMain.on('shell:browser-download', (_event, payload) => {
    if (payload === null || typeof payload !== 'object') return
    browserGuests.downloadAction(payload.id, payload.action)
    sendToPage({ type: 'downloads', items: browserGuests.listDownloads() })
  })

  ipcMain.on('shell:edit', (_event, action) => {
    if (mainWindow === null || mainWindow.isDestroyed()) return
    const contents = mainWindow.webContents
    if (action === 'copy') contents.copy()
    else if (action === 'paste') contents.paste()
    else if (action === 'selectAll') contents.selectAll()
    else if (action === 'devtools') contents.toggleDevTools()
    else if (action === 'reload') contents.reload()
  })

  ipcMain.on('splash:message', (_event, kind) => {
    if (kind === 'splash-ended' || kind === 'splash-skip') {
      const target = splashWindow
      splashWindow = null
      try { if (target !== null && !target.isDestroyed()) target.destroy() } catch { /* ignore */ }
      revealPage()
    }
  })

  nativeTheme.on('updated', () => {
    if (mainWindow === null || mainWindow.isDestroyed()) return
    try { mainWindow.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#151517' : '#ffffff') } catch { /* ignore */ }
  })

  app.whenReady().then(boot).catch((error) => {
    log('shell.log', 'boot failed: ' + String(error && error.stack ? error.stack : error))
    app.exit(1)
  })

  app.on('before-quit', () => { quitting = true })
}
