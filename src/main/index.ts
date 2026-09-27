import { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, Tray, Menu, nativeImage, nativeTheme, shell, systemPreferences, session } from 'electron'
import { join } from 'path'
import { createReadStream, readFileSync as readFileSyncFs, writeFileSync as writeFileSyncFs } from 'fs'
import { createInterface } from 'readline'
import { homedir } from 'os'
import { ControlPlane } from './claude/control-plane'
import { ensureSkills, type SkillStatus } from './skills/installer'
import { fetchCatalog, listInstalled, installPlugin, uninstallPlugin } from './marketplace/catalog'
import { log as _log, LOG_FILE, flushLogs } from './logger'
import { BubbleController } from './bubble-window'
import { FilePicker, type PickKind } from './native-dialog'
import { HangWatchdog } from './hang-watchdog'
import { RemoteControlManager } from './claude/remote-control'
import { findClaudeBinary, cliEnvWithBinary } from './claude/claude-binary'
import { listSubagents } from './subagents'
import { discoverModels, isCacheFresh, readSettingsModel, type ModelCache } from './models'
import { StatusTracker } from './session-status/tracker'
import { attentionCount, bubbleActivity, type NotifyKind, type SessionStatus } from './session-status/reducer'
import { installTracking, uninstallTracking, isTrackingInstalled } from './session-status/hook-installer'
import { listProjectSessions, listAllSessions, findSessionFile, isSessionId, isValidProjectPath, readSessionTitle, scanSessionById, renameSession, readCommandDescriptions, readLastContext, sessionLineToMessages } from './sessions'
import { getCliEnv } from './cli-env'
import { IPC } from '../shared/types'
import { isPermissionMode } from '../shared/permission-modes'
import type { RunOptions, NormalizedEvent, EnrichedError } from '../shared/types'

const DEBUG_MODE = process.env.CLUI_DEBUG === '1'
const SPACES_DEBUG = DEBUG_MODE || process.env.CLUI_SPACES_DEBUG === '1'

function getContentSecurityPolicy(): string {
  const isDev = !!process.env.ELECTRON_RENDERER_URL
  const connectSrc = isDev
    ? "connect-src 'self' ws://localhost:* http://localhost:*;"
    : "connect-src 'self';"
  const scriptSrc = isDev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval';"
    : "script-src 'self';"

  return [
    "default-src 'none'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self'",
    connectSrc,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ].join('; ')
}

function installContentSecurityPolicy(): void {
  const csp = getContentSecurityPolicy()
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })
}

function log(msg: string): void {
  _log('main', msg)
}
const mainLog = log

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let screenshotCounter = 0
let toggleSequence = 0
let lastWindowBounds: Electron.Rectangle | null = null
let bubble: BubbleController | null = null
let statusTracker: StatusTracker | null = null

// Feature flag: enable PTY interactive permissions transport
const INTERACTIVE_PTY = process.env.CLUI_INTERACTIVE_PERMISSIONS_PTY === '1'

const controlPlane = new ControlPlane(INTERACTIVE_PTY)
const watchdog = new HangWatchdog(LOG_FILE, log)

// Escape hatch when the UI wedges: skip graceful teardown that could itself hang.
function forceQuitApp(source: string): void {
  log(`FORCE QUIT via ${source}; active: ${watchdog.activeOps().join(', ') || 'none'}`)
  filePicker.cancel('force quit')
  try { remoteControl.killAll() } catch {}
  try { controlPlane.shutdown() } catch (err) { log(`force quit: shutdown error ${err}`) }
  flushLogs()
  app.exit(0)
}

// macOS: pickers run out of process (see native-dialog.ts) so a wedged system
// picker service can't freeze the app. Elsewhere Electron's dialog is fine.
const filePicker = new FilePicker({
  spawn: (cmd, args) => require('child_process').spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }),
  host: () => mainWindow,
  log,
  track: (l) => watchdog.track(l),
})

// Remote Control: a hidden interactive `claude --resume --remote-control` per tab (see remote-control.ts)
const remoteControl = new RemoteControlManager({
  spawn: (args, cwd) => {
    // node-pty is native; require at runtime like pty-run-manager does
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pty = require('node-pty') as typeof import('node-pty')
    const bin = findClaudeBinary()
    const p = pty.spawn(bin, args, { name: 'xterm-256color', cols: 300, rows: 40, cwd, env: cliEnvWithBinary(bin) })
    return {
      pid: p.pid,
      onData: (cb) => { p.onData(cb) },
      onExit: (cb) => { p.onExit(cb) },
      write: (d) => p.write(d),
      kill: (sig) => p.kill(sig),
    }
  },
  sessionFile: (sessionId, cwd) => findSessionFile(join(homedir(), '.claude', 'projects'), sessionId, cwd),
  lineToMessages: sessionLineToMessages,
  log,
})
remoteControl.on('event', (tabId: string, event: unknown) => broadcast(IPC.REMOTE_CONTROL_EVENT, tabId, event))
remoteControl.on('messages', (tabId: string, messages: unknown) => broadcast(IPC.REMOTE_CONTROL_MESSAGES, tabId, messages))

async function pickPaths(kind: PickKind, label: string): Promise<string[] | null> {
  if (process.platform === 'darwin') return filePicker.pick(kind, label)
  if (!mainWindow) return null
  const properties: Electron.OpenDialogOptions['properties'] = kind === 'directory' ? ['openDirectory'] : ['openFile', 'multiSelections']
  const result = await dialog.showOpenDialog(mainWindow, { properties })
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths
}

// Keep native width fixed to avoid renderer animation vs setBounds race.
// The UI itself still launches in compact mode; extra width is transparent/click-through.
const BAR_WIDTH = 1040
const PILL_HEIGHT = 720  // Fixed native window height — extra room for expanded UI + shadow buffers
const PILL_BOTTOM_MARGIN = 24

// ─── Broadcast to renderer ───

function broadcast(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

function snapshotWindowState(reason: string): void {
  if (!SPACES_DEBUG) return
  if (!mainWindow || mainWindow.isDestroyed()) {
    log(`[spaces] ${reason} window=none`)
    return
  }

  const b = mainWindow.getBounds()
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const visibleOnAll = mainWindow.isVisibleOnAllWorkspaces()
  const wcFocused = mainWindow.webContents.isFocused()

  log(
    `[spaces] ${reason} ` +
    `vis=${mainWindow.isVisible()} focused=${mainWindow.isFocused()} wcFocused=${wcFocused} ` +
    `alwaysOnTop=${mainWindow.isAlwaysOnTop()} allWs=${visibleOnAll} ` +
    `bounds=(${b.x},${b.y},${b.width}x${b.height}) ` +
    `cursor=(${cursor.x},${cursor.y}) display=${display.id} ` +
    `workArea=(${display.workArea.x},${display.workArea.y},${display.workArea.width}x${display.workArea.height})`
  )
}

function scheduleToggleSnapshots(toggleId: number, phase: 'show' | 'hide'): void {
  if (!SPACES_DEBUG) return
  const probes = [0, 100, 400, 1200]
  for (const delay of probes) {
    setTimeout(() => {
      snapshotWindowState(`toggle#${toggleId} ${phase} +${delay}ms`)
    }, delay)
  }
}


// ─── Wire ControlPlane events → renderer ───

controlPlane.on('event', (tabId: string, event: NormalizedEvent) => {
  broadcast('clui:normalized-event', tabId, event)
})

controlPlane.on('tab-status-change', (tabId: string, newStatus: string, oldStatus: string) => {
  broadcast('clui:tab-status-change', tabId, newStatus, oldStatus)
})

controlPlane.on('error', (tabId: string, error: EnrichedError) => {
  broadcast('clui:enriched-error', tabId, error)
})

// ─── Window Creation ───

function createWindow(): void {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { width: screenWidth, height: screenHeight } = display.workAreaSize
  const { x: dx, y: dy } = display.workArea

  const x = dx + Math.round((screenWidth - BAR_WIDTH) / 2)
  const y = dy + screenHeight - PILL_HEIGHT - PILL_BOTTOM_MARGIN

  mainWindow = new BrowserWindow({
    width: BAR_WIDTH,
    height: PILL_HEIGHT,
    x,
    y,
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),  // NSPanel — non-activating, joins all spaces
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: true,
    backgroundColor: '#00000000',
    show: false,
    icon: join(__dirname, '../../resources/icon.icns'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })
  lastWindowBounds = mainWindow.getBounds()

  // Belt-and-suspenders: panel already joins all spaces and floats,
  // but explicit flags ensure correct behavior on older Electron builds.
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Right-click: Copy for selected text, Cut/Copy/Paste in inputs
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const items: Electron.MenuItemConstructorOptions[] = params.isEditable
      ? [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' }]
      : params.selectionText
        ? [{ role: 'copy' }]
        : []
    if (items.length > 0) Menu.buildFromTemplate(items).popup({ window: mainWindow! })
  })

  // Hang diagnostics: renderer freezes and crashes land in the log
  mainWindow.on('unresponsive', () => log(`renderer unresponsive; active: ${watchdog.activeOps().join(', ') || 'none'}`))
  mainWindow.on('responsive', () => log('renderer responsive again'))
  mainWindow.webContents.on('render-process-gone', (_e, d) => log(`renderer gone: ${d.reason} (exit ${d.exitCode})`))

  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  mainWindow.once('ready-to-show', () => {
    // Relaunch while minimized: come back as the bubble, not the full overlay
    if (bubble?.isMinimized()) bubble.show()
    else mainWindow?.show()
    // Enable OS-level click-through for transparent regions.
    // { forward: true } ensures mousemove events still reach the renderer
    // so it can toggle click-through off when cursor enters interactive UI.
    mainWindow?.setIgnoreMouseEvents(true, { forward: true })
    if (process.env.ELECTRON_RENDERER_URL) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' })
    }
  })

  let forceQuit = false
  app.on('before-quit', () => { forceQuit = true })
  mainWindow.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showWindow(source = 'unknown'): void {
  if (!mainWindow) return
  const toggleId = ++toggleSequence
  bubble?.hide()

  if (lastWindowBounds) {
    // Displays may have changed since it was hidden; never bring it back off screen
    mainWindow.setBounds({ ...lastWindowBounds, ...clampToWorkArea(lastWindowBounds) })
  }

  // Always re-assert space membership — the flag can be lost after hide/show cycles
  // and must be set before show() so the window joins the active Space, not its
  // last-known Space.
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (SPACES_DEBUG) {
    const b = mainWindow.getBounds()
    log(`[spaces] showWindow#${toggleId} source=${source} preserve-bounds=(${b.x},${b.y},${b.width}x${b.height})`)
    snapshotWindowState(`showWindow#${toggleId} pre-show`)
  }
  // As an accessory app (app.dock.hide), show() + focus gives keyboard
  // without deactivating the active app — hover preserved everywhere.
  mainWindow.show()
  if (lastWindowBounds) {
    mainWindow.setBounds(lastWindowBounds)
  }
  mainWindow.webContents.focus()
  broadcast(IPC.WINDOW_SHOWN)
  if (SPACES_DEBUG) scheduleToggleSnapshots(toggleId, 'show')
}

function resetWindowPosition(): void {
  if (!mainWindow) return

  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { width: sw, height: sh } = display.workAreaSize
  const { x: dx, y: dy } = display.workArea

  // Keep any size the user dragged the panel to
  const { width, height } = mainWindow.getBounds()
  mainWindow.setBounds({
    x: dx + Math.round((sw - width) / 2),
    y: dy + Math.max(0, sh - height - PILL_BOTTOM_MARGIN),
    width,
    height,
  })
  lastWindowBounds = mainWindow.getBounds()
}

function toggleWindow(source = 'unknown'): void {
  if (!mainWindow) return
  const toggleId = ++toggleSequence
  if (SPACES_DEBUG) {
    log(`[spaces] toggle#${toggleId} source=${source} start`)
    snapshotWindowState(`toggle#${toggleId} pre`)
  }

  if (bubble?.isMinimized()) {
    showWindow(source)
  } else if (mainWindow.isVisible()) {
    mainWindow.hide()
    if (SPACES_DEBUG) scheduleToggleSnapshots(toggleId, 'hide')
  } else {
    showWindow(source)
  }
}

// ─── Resize ───
// Fixed-height mode: ignore renderer resize events to prevent jank.
// The native window stays at PILL_HEIGHT; all expand/collapse happens inside the renderer.

ipcMain.on(IPC.RESIZE_HEIGHT, () => {
  // No-op — fixed height window, no dynamic resize
})

ipcMain.on(IPC.SET_WINDOW_WIDTH, () => {
  // No-op — native width is fixed to keep expand/collapse animation smooth.
})

// The user can drag the panel bigger than the default native window; grow the window
// around it (bottom edge and horizontal center stay put), never below the defaults.
ipcMain.handle(IPC.SET_PANEL_EXTENT, (_e, size: { width: number; height: number }) => {
  if (!mainWindow || mainWindow.isDestroyed() || !size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return null
  const b = mainWindow.getBounds()
  const area = screen.getDisplayMatching(b).workArea
  const width = Math.min(area.width, Math.max(BAR_WIDTH, Math.round(size.width)))
  const height = Math.min(area.height, Math.max(PILL_HEIGHT, Math.round(size.height)))
  if (width === b.width && height === b.height) return b
  const centerX = b.x + b.width / 2
  const bottom = b.y + b.height
  const x = Math.min(area.x + area.width - width, Math.max(area.x, Math.round(centerX - width / 2)))
  const y = Math.min(area.y + area.height - height, Math.max(area.y, bottom - height))
  mainWindow.setBounds({ x, y, width, height })
  lastWindowBounds = mainWindow.getBounds()
  return lastWindowBounds
})

ipcMain.handle(IPC.ANIMATE_HEIGHT, () => {
  // No-op — kept for API compat, animation handled purely in renderer
})

// ─── Quit from the UI (the renderer confirms first) ───

ipcMain.on(IPC.QUIT_APP, (_e, force: boolean) => {
  if (force) forceQuitApp('ui button')
  else {
    log('QUIT via ui button')
    app.quit()
  }
})

// ─── Minimize to floating bubble ───

ipcMain.on(IPC.MINIMIZE_TO_BUBBLE, () => {
  if (!mainWindow || !bubble) return
  if (mainWindow.isVisible()) lastWindowBounds = mainWindow.getBounds()
  mainWindow.hide()
  bubble.show()
})

ipcMain.on(IPC.EXPAND_FROM_BUBBLE, () => {
  showWindow('bubble click')
})

ipcMain.on(IPC.MOVE_BUBBLE, (_e, deltaX: number, deltaY: number, done: boolean) => {
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return
  bubble?.move(Math.round(deltaX), Math.round(deltaY), !!done)
})

ipcMain.on(IPC.HIDE_WINDOW, () => {
  mainWindow?.hide()
})

ipcMain.handle(IPC.IS_VISIBLE, () => {
  return mainWindow?.isVisible() ?? false
})

// OS-level click-through toggle — renderer calls this on mousemove
// to enable clicks on interactive UI while passing through transparent areas
ipcMain.on(IPC.SET_IGNORE_MOUSE_EVENTS, (event, ignore: boolean, options?: { forward?: boolean }) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(ignore, options || {})
  }
})


// Manual window drag — works reliably with frameless + setIgnoreMouseEvents
// Keep enough of the window on its display that the drag handle stays reachable
const MIN_VISIBLE_PX = 120
function clampToWorkArea(b: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  const area = screen.getDisplayMatching(b).workArea
  const x = Math.min(area.x + area.width - MIN_VISIBLE_PX, Math.max(area.x + MIN_VISIBLE_PX - b.width, b.x))
  const y = Math.min(area.y + area.height - MIN_VISIBLE_PX, Math.max(area.y, b.y))
  return { x: Math.round(x), y: Math.round(y) }
}

ipcMain.on(IPC.START_WINDOW_DRAG, (event, deltaX: number, deltaY: number) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    const b = win.getBounds()
    // Vertical is handled in two phases in the renderer: window first (until the screen top),
    // then CSS within the window. Clamp anyway so the handle can never leave the screen.
    const pos = clampToWorkArea({ ...b, x: b.x + deltaX, y: b.y + deltaY })
    win.setPosition(pos.x, pos.y)
    lastWindowBounds = win.getBounds()
  }
})

ipcMain.on(IPC.RESET_WINDOW_POSITION, () => {
  resetWindowPosition()
})

// ─── IPC Handlers (typed, strict) ───

ipcMain.handle(IPC.START, async () => {
  log('IPC START — fetching static CLI info')
  const { execSync } = require('child_process')

  let version = 'unknown'
  try {
    version = execSync('claude -v', { encoding: 'utf-8', timeout: 5000, env: getCliEnv() }).trim()
  } catch {}

  let auth: { email?: string; subscriptionType?: string; authMethod?: string } = {}
  try {
    const raw = execSync('claude auth status', { encoding: 'utf-8', timeout: 5000, env: getCliEnv() }).trim()
    auth = JSON.parse(raw)
  } catch {}

  let mcpServers: string[] = []
  try {
    const raw = execSync('claude mcp list', { encoding: 'utf-8', timeout: 5000, env: getCliEnv() }).trim()
    if (raw) mcpServers = raw.split('\n').filter(Boolean)
  } catch {}

  return { version, auth, mcpServers, projectPath: process.cwd(), homePath: require('os').homedir() }
})

ipcMain.handle(IPC.CREATE_TAB, () => {
  const tabId = controlPlane.createTab()
  log(`IPC CREATE_TAB → ${tabId}`)
  return { tabId }
})

ipcMain.on(IPC.INIT_SESSION, (_event, tabId: string) => {
  log(`IPC INIT_SESSION: ${tabId}`)
  controlPlane.initSession(tabId)
})

ipcMain.on(IPC.RESET_TAB_SESSION, (_event, tabId: string) => {
  log(`IPC RESET_TAB_SESSION: ${tabId}`)
  remoteControl.stop(tabId, 'session reset')
  controlPlane.resetTabSession(tabId)
})

ipcMain.handle(IPC.PROMPT, async (_event, { tabId, requestId, options }: { tabId: string; requestId: string; options: RunOptions }) => {
  if (remoteControl.holdsSession(tabId)) {
    log(`IPC PROMPT: tab=${tabId} refused — Remote Control holds this session`)
    throw new Error('Remote Control is on for this chat. Turn it off with /remote-control to run turns here.')
  }
  if (DEBUG_MODE) {
    log(`IPC PROMPT: tab=${tabId} req=${requestId} prompt="${options.prompt.substring(0, 100)}"`)
  } else {
    log(`IPC PROMPT: tab=${tabId} req=${requestId}`)
  }

  if (!tabId) {
    throw new Error('No tabId provided — prompt rejected')
  }
  if (!requestId) {
    throw new Error('No requestId provided — prompt rejected')
  }

  try {
    await controlPlane.submitPrompt(tabId, requestId, options)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`PROMPT error: ${msg}`)
    throw err
  }
})

ipcMain.handle(IPC.CANCEL, (_event, requestId: string) => {
  log(`IPC CANCEL: ${requestId}`)
  return controlPlane.cancel(requestId)
})

ipcMain.handle(IPC.STOP_TAB, (_event, tabId: string) => {
  log(`IPC STOP_TAB: ${tabId}`)
  remoteControl.stop(tabId, 'stop tab')
  return controlPlane.cancelTab(tabId)
})

ipcMain.handle(IPC.RETRY, async (_event, { tabId, requestId, options }: { tabId: string; requestId: string; options: RunOptions }) => {
  log(`IPC RETRY: tab=${tabId} req=${requestId}`)
  return controlPlane.retry(tabId, requestId, options)
})

ipcMain.handle(IPC.STATUS, () => {
  return controlPlane.getHealth()
})

ipcMain.handle(IPC.TAB_HEALTH, () => {
  return controlPlane.getHealth()
})

ipcMain.handle(IPC.CLOSE_TAB, (_event, tabId: string) => {
  log(`IPC CLOSE_TAB: ${tabId}`)
  remoteControl.stop(tabId, 'tab closed')
  controlPlane.closeTab(tabId)
})

ipcMain.handle(IPC.SET_TAB_PERMISSION_MODE, (_event, arg: { tabId: string; mode: string }) => {
  if (!arg || typeof arg.tabId !== 'string' || !isPermissionMode(arg.mode)) {
    log(`IPC SET_TAB_PERMISSION_MODE: invalid ${JSON.stringify(arg)} — ignoring`)
    return false
  }
  return controlPlane.setTabPermissionMode(arg.tabId, arg.mode)
})

ipcMain.handle(IPC.REMOTE_CONTROL_START, (_e, arg: { tabId: string; sessionId: string; cwd: string; name: string; permissionMode?: string; model?: string }) => {
  const cwd = arg?.cwd === '~' ? homedir() : arg?.cwd
  if (!arg || typeof arg.tabId !== 'string' || !isSessionId(arg.sessionId) || typeof cwd !== 'string' || !isValidProjectPath(cwd)) {
    log(`IPC REMOTE_CONTROL_START: invalid ${JSON.stringify(arg)}`)
    return { ok: false, error: 'This chat has no session to share yet.' }
  }
  const tab = controlPlane.getTabStatus(arg.tabId)
  if (tab?.activeRequestId) return { ok: false, error: 'Wait for the current turn to finish, then try again.' }
  const name = String(arg.name || 'Clui').replace(/[\r\n]/g, ' ').replace(/^-+/, '').slice(0, 80) || 'Clui'
  const mode = isPermissionMode(arg.permissionMode) ? arg.permissionMode : undefined
  const model = typeof arg.model === 'string' && /^[a-z0-9.\[\]-]+$/i.test(arg.model) ? arg.model : undefined
  return remoteControl.start(arg.tabId, { sessionId: arg.sessionId, cwd, name, permissionMode: mode, model })
})

ipcMain.handle(IPC.REMOTE_CONTROL_STOP, (_e, tabId: string) => remoteControl.stop(String(tabId), 'user'))

ipcMain.handle(IPC.REMOTE_CONTROL_SEND, (_e, arg: { tabId: string; text: string }) => {
  if (!arg || typeof arg.tabId !== 'string' || typeof arg.text !== 'string' || !arg.text.trim()) return false
  return remoteControl.send(arg.tabId, arg.text)
})

ipcMain.handle(IPC.RESPOND_PERMISSION, (_event, { tabId, questionId, optionId }: { tabId: string; questionId: string; optionId: string }) => {
  log(`IPC RESPOND_PERMISSION: tab=${tabId} question=${questionId} option=${optionId}`)
  return controlPlane.respondToPermission(tabId, questionId, optionId)
})

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')

ipcMain.handle(IPC.LIST_SESSIONS, async (_e, projectPath?: string) => {
  log(`IPC LIST_SESSIONS ${projectPath ? `(path=${projectPath})` : ''}`)
  try {
    const cwd = projectPath || process.cwd()
    if (!isValidProjectPath(cwd)) {
      log(`LIST_SESSIONS: rejected invalid projectPath: ${cwd}`)
      return []
    }
    return await listProjectSessions(CLAUDE_PROJECTS_DIR, cwd, 20)
  } catch (err) {
    log(`LIST_SESSIONS error: ${err}`)
    return []
  }
})

// Sessions from every project under ~/.claude/projects, newest first
ipcMain.handle(IPC.LIST_ALL_SESSIONS, async () => {
  log('IPC LIST_ALL_SESSIONS')
  try {
    const sessions = await listAllSessions(CLAUDE_PROJECTS_DIR, 100)
    // Live sessions always show, even when older transcripts fall outside the top 100
    const seen = new Set(sessions.map((s) => s.sessionId))
    for (const st of Object.values(statusTracker?.snapshot() ?? {})) {
      if (st.status === 'ended' || seen.has(st.sessionId)) continue
      const scanned = await scanSessionById(CLAUDE_PROJECTS_DIR, st.sessionId, st.cwd ?? undefined)
      if (scanned) sessions.push(scanned)
    }
    return sessions
  } catch (err) {
    log(`LIST_ALL_SESSIONS error: ${err}`)
    return []
  }
})

// Current title of a session (/rename, else Claude's auto title)
ipcMain.handle(IPC.RENAME_SESSION, (_e, arg: { sessionId: string; title: string; projectPath?: string }) => {
  try {
    const title = renameSession(CLAUDE_PROJECTS_DIR, arg?.sessionId, arg?.title, arg?.projectPath)
    log(`RENAME_SESSION ${arg.sessionId}`)
    return { ok: true, title }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})

const commandDescCache = new Map<string, { at: number; value: Record<string, string> }>()
ipcMain.handle(IPC.GET_COMMAND_DESCRIPTIONS, (_e, cwd?: string) => {
  const key = typeof cwd === 'string' ? cwd : ''
  const hit = commandDescCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  const value = readCommandDescriptions(join(homedir(), '.claude'), key || undefined)
  commandDescCache.set(key, { at: Date.now(), value })
  return value
})

ipcMain.handle(IPC.GET_SESSION_CONTEXT, (_e, arg: { sessionId: string; projectPath?: string }) => {
  try {
    return readLastContext(CLAUDE_PROJECTS_DIR, arg?.sessionId, arg?.projectPath)
  } catch {
    return null
  }
})

ipcMain.handle(IPC.GET_SESSION_TITLE, async (_e, arg: { sessionId: string; projectPath?: string }) => {
  if (!arg || !isSessionId(arg.sessionId)) return null
  try {
    return await readSessionTitle(CLAUDE_PROJECTS_DIR, arg.sessionId, arg.projectPath)
  } catch (err) {
    log(`GET_SESSION_TITLE error: ${err}`)
    return null
  }
})

// ─── Live status of every Claude session (global hooks → ~/.clui/events) ───

const CLUI_HOME = join(homedir(), '.clui')
const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json')
const STATUS_HOOK_SCRIPT = join(CLUI_HOME, 'hooks', 'clui-status-hook.sh')
// Which alerts make the minimized bubble hop (Settings). Clui shows no macOS banners.
interface HopPrefs { hopOnFinish: boolean; hopOnInput: boolean }
function hopPrefsPath(): string { return join(app.getPath('userData'), 'notify-prefs.json') }
function readHopPrefs(): HopPrefs {
  try {
    const o = JSON.parse(readFileSyncFs(hopPrefsPath(), 'utf-8'))
    // notifyOn* are the keys from when these switches drove banners
    return { hopOnFinish: (o.hopOnFinish ?? o.notifyOnFinish) !== false, hopOnInput: (o.hopOnInput ?? o.notifyOnInput) !== false }
  } catch {
    return { hopOnFinish: true, hopOnInput: true }
  }
}
function trackingSettings() {
  return { installed: isTrackingInstalled(CLAUDE_SETTINGS_PATH), ...readHopPrefs() }
}

function alertSession(st: SessionStatus, kind: NotifyKind): void {
  const prefs = readHopPrefs()
  if (kind === 'finished' ? !prefs.hopOnFinish : !prefs.hopOnInput) return
  log(`hop ${kind} session=${st.sessionId}`)
  bubble?.bounce(kind)
}

function onStatusChange(map: Record<string, SessionStatus>): void {
  const count = attentionCount(map)
  bubble?.setAttention(count, bubbleActivity(map))
  tray?.setTitle(count > 0 ? ` ${count}` : '')
  broadcast(IPC.SESSION_STATUS_CHANGED, map)
}

ipcMain.handle(IPC.GET_SESSION_STATUSES, () => statusTracker?.snapshot() ?? {})

// ─── Model list (from the installed claude CLI, cached per CLI version + settings model for an hour) ───

function modelCachePath(): string { return join(app.getPath('userData'), 'models.json') }
let modelDiscovery: Promise<ModelCache | null> | null = null

function readModelCache(): ModelCache | null {
  try { return JSON.parse(readFileSyncFs(modelCachePath(), 'utf-8')) } catch { return null }
}

ipcMain.handle(IPC.GET_MODELS, async (_e, force: boolean) => {
  const cached = readModelCache()
  const toList = (c: ModelCache | null) => c && { defaultLabel: c.defaultLabel, models: c.models, fetchedAt: c.fetchedAt }
  try {
    if (!force && cached) {
      const version = await new Promise<string>((resolve) =>
        require('child_process').execFile('claude', ['--version'], { env: getCliEnv(), timeout: 10000, encoding: 'utf-8' },
          (_err: unknown, out: string) => resolve((out || '').trim())))
      if (isCacheFresh(cached, version, Date.now(), readSettingsModel(join(homedir(), '.claude')))) return toList(cached)
    }
    modelDiscovery ??= discoverModels(getCliEnv(), undefined, readSettingsModel(join(homedir(), '.claude'))).finally(() => { modelDiscovery = null })
    const fresh = await modelDiscovery
    if (fresh && fresh.models.length > 0) {
      writeFileSyncFs(modelCachePath(), JSON.stringify(fresh))
      log(`GET_MODELS discovered ${fresh.models.length} models (${fresh.cliVersion})`)
      return toList(fresh)
    }
  } catch (err) {
    log(`GET_MODELS error: ${err}`)
  }
  return toList(cached)
})

ipcMain.handle(IPC.GET_TRACKING, () => trackingSettings())

ipcMain.handle(IPC.SET_TRACKING, (_e, enabled: boolean) => {
  try {
    if (enabled) installTracking(CLAUDE_SETTINGS_PATH, STATUS_HOOK_SCRIPT)
    else uninstallTracking(CLAUDE_SETTINGS_PATH)
    log(`SET_TRACKING ${enabled ? 'installed' : 'removed'} status hooks`)
    return { ok: true, settings: trackingSettings() }
  } catch (err) {
    log(`SET_TRACKING error: ${err}`)
    return { ok: false, error: String(err instanceof Error ? err.message : err), settings: trackingSettings() }
  }
})

ipcMain.handle(IPC.SET_HOP_PREFS, (_e, prefs: Partial<HopPrefs>) => {
  const next = { ...readHopPrefs() }
  if (typeof prefs?.hopOnFinish === 'boolean') next.hopOnFinish = prefs.hopOnFinish
  if (typeof prefs?.hopOnInput === 'boolean') next.hopOnInput = prefs.hopOnInput
  try { writeFileSyncFs(hopPrefsPath(), JSON.stringify(next)) } catch (err) { log(`hop prefs save failed: ${err}`) }
  return trackingSettings()
})

// ─── Subagents of a session (like the terminal's agent tree) ───

ipcMain.handle(IPC.LIST_SUBAGENTS, (_e, arg: { sessionId: string; projectPath?: string }) => {
  if (!arg || !isSessionId(arg.sessionId)) return []
  const projectPath = typeof arg.projectPath === 'string' && isValidProjectPath(arg.projectPath) ? arg.projectPath : undefined
  try {
    return listSubagents(CLAUDE_PROJECTS_DIR, arg.sessionId, projectPath)
  } catch (err) {
    log(`LIST_SUBAGENTS error: ${err}`)
    return []
  }
})

ipcMain.handle(IPC.COUNT_SUBAGENTS, (_e, sessions: unknown) => {
  const out: Record<string, { running: number; total: number }> = {}
  if (!Array.isArray(sessions)) return out
  for (const s of sessions.slice(0, 50)) {
    if (!s || typeof s.sessionId !== 'string' || !isSessionId(s.sessionId)) continue
    const projectPath = typeof s.projectPath === 'string' && isValidProjectPath(s.projectPath) ? s.projectPath : undefined
    try {
      const agents = listSubagents(CLAUDE_PROJECTS_DIR, s.sessionId, projectPath)
      if (agents.length > 0) out[s.sessionId] = { running: agents.filter((a) => a.status === 'running').length, total: agents.length }
    } catch {}
  }
  return out
})

// Load conversation history from a session's JSONL file
ipcMain.handle(IPC.LOAD_SESSION, async (_e, arg: { sessionId: string; projectPath?: string } | string) => {
  const sessionId = typeof arg === 'string' ? arg : arg.sessionId
  const projectPath = typeof arg === 'string' ? undefined : arg.projectPath
  log(`IPC LOAD_SESSION ${sessionId}${projectPath ? ` (path=${projectPath})` : ''}`)

  // Validate sessionId — must be strict UUID to prevent path traversal via crafted filenames
  if (!isSessionId(sessionId)) {
    log(`LOAD_SESSION: rejected invalid sessionId: ${sessionId}`)
    return []
  }

  try {
    const filePath = findSessionFile(CLAUDE_PROJECTS_DIR, sessionId, projectPath || process.cwd())
    if (!filePath) return []

    const messages: Array<{ role: string; content: string; toolName?: string; timestamp: number }> = []
    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: createReadStream(filePath) })
      rl.on('line', (line: string) => {
        try {
          messages.push(...sessionLineToMessages(JSON.parse(line)))
        } catch {}
      })
      rl.on('close', () => resolve())
    })
    return messages
  } catch (err) {
    log(`LOAD_SESSION error: ${err}`)
    return []
  }
})

ipcMain.handle(IPC.SELECT_DIRECTORY, async () => {
  if (!mainWindow) return null
  const paths = await pickPaths('directory', 'select-directory')
  return paths ? paths[0] : null
})

ipcMain.handle(IPC.OPEN_EXTERNAL, async (_event, url: string) => {
  try {
    // Parse with URL constructor to reject malformed/ambiguous payloads
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    if (!parsed.hostname) return false
    await shell.openExternal(parsed.href)
    return true
  } catch {
    return false
  }
})

ipcMain.handle(IPC.ATTACH_FILES, async () => {
  if (!mainWindow) return null
  const paths = await pickPaths('files', 'attach-files')
  if (!paths) return null
  log(`[dialog] attach-files: reading ${paths.length} file(s)`)
  return attachmentsForPaths(paths)
})

function attachmentsForPaths(filePaths: string[]) {
  const { basename, extname } = require('path')
  const { readFileSync, statSync } = require('fs')

  const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
  const mimeMap: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
    '.json': 'application/json', '.yaml': 'text/yaml', '.toml': 'text/toml',
  }

  return filePaths.map((fp: string) => {
    const ext = extname(fp).toLowerCase()
    const mime = mimeMap[ext] || 'application/octet-stream'
    const stat = statSync(fp)
    let dataUrl: string | undefined

    // Generate preview data URL for images (max 2MB to keep IPC fast)
    if (IMAGE_EXTS.has(ext) && stat.size < 2 * 1024 * 1024) {
      try {
        const buf = readFileSync(fp)
        dataUrl = `data:${mime};base64,${buf.toString('base64')}`
      } catch {}
    }

    return {
      id: crypto.randomUUID(),
      type: IMAGE_EXTS.has(ext) ? 'image' : 'file',
      name: basename(fp),
      path: fp,
      mimeType: mime,
      dataUrl,
      size: stat.size,
    }
  })
}

ipcMain.handle(IPC.TAKE_SCREENSHOT, async () => {
  if (!mainWindow) return null

  if (SPACES_DEBUG) snapshotWindowState('screenshot pre-hide')
  mainWindow.hide()
  await new Promise((r) => setTimeout(r, 300))

  try {
    const { execSync } = require('child_process')
    const { join } = require('path')
    const { tmpdir } = require('os')
    const { readFileSync, existsSync } = require('fs')

    const timestamp = Date.now()
    const screenshotPath = join(tmpdir(), `clui-screenshot-${timestamp}.png`)

    execSync(`/usr/sbin/screencapture -i "${screenshotPath}"`, {
      timeout: 30000,
      stdio: 'ignore',
    })

    if (!existsSync(screenshotPath)) {
      return null
    }

    // Return structured attachment with data URL preview
    const buf = readFileSync(screenshotPath)
    return {
      id: crypto.randomUUID(),
      type: 'image',
      name: `screenshot ${++screenshotCounter}.png`,
      path: screenshotPath,
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
      size: buf.length,
    }
  } catch {
    return null
  } finally {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.webContents.focus()
    }
    broadcast(IPC.WINDOW_SHOWN)
    if (SPACES_DEBUG) {
      log('[spaces] screenshot restore show+focus')
      snapshotWindowState('screenshot restore immediate')
      setTimeout(() => snapshotWindowState('screenshot restore +200ms'), 200)
    }
  }
})

let pasteCounter = 0
ipcMain.handle(IPC.PASTE_IMAGE, async (_event, dataUrl: string) => {
  try {
    const { writeFileSync } = require('fs')
    const { join } = require('path')
    const { tmpdir } = require('os')

    // Parse data URL: "data:image/png;base64,..."
    const match = dataUrl.match(/^data:(image\/(\w+));base64,(.+)$/)
    if (!match) return null

    const [, mimeType, ext, base64Data] = match
    const buf = Buffer.from(base64Data, 'base64')
    const timestamp = Date.now()
    const filePath = join(tmpdir(), `clui-paste-${timestamp}.${ext}`)
    writeFileSync(filePath, buf)

    return {
      id: crypto.randomUUID(),
      type: 'image',
      name: `pasted image ${++pasteCounter}.${ext}`,
      path: filePath,
      mimeType,
      dataUrl,
      size: buf.length,
    }
  } catch {
    return null
  }
})

ipcMain.handle(IPC.TRANSCRIBE_AUDIO, async (_event, audioBase64: string, opts?: { interim?: boolean }) => {
  // Live-preview passes run every few seconds; keep them out of the log
  const log = opts?.interim ? (_msg: string) => {} : mainLog
  const { writeFileSync, existsSync, unlinkSync, readFileSync } = require('fs')
  const { execFile } = require('child_process')
  const { join, basename } = require('path')
  const { tmpdir } = require('os')

  const startedAt = Date.now()
  const phaseMs: Record<string, number> = {}
  const mark = (name: string, t0: number) => { phaseMs[name] = Date.now() - t0 }

  // Unique per call: live-preview and final passes can overlap
  const tmpWav = join(tmpdir(), `clui-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`)
  try {
    const runExecFile = (bin: string, args: string[], timeout: number): Promise<string> =>
      new Promise((resolve, reject) => {
        execFile(bin, args, { encoding: 'utf-8', timeout }, (err: any, stdout: string, stderr: string) => {
          if (err) {
            const detail = stderr?.trim() || stdout?.trim() || err.message
            reject(new Error(detail))
            return
          }
          resolve(stdout || '')
        })
      })

    let t0 = Date.now()
    const buf = Buffer.from(audioBase64, 'base64')
    writeFileSync(tmpWav, buf)
    mark('decode+write_wav', t0)

    // Find whisper backend in priority order: whisperkit-cli (Apple Silicon CoreML) → whisper-cli (whisper-cpp) → whisper (python)
    t0 = Date.now()
    const candidates = [
      '/opt/homebrew/bin/whisperkit-cli',
      '/usr/local/bin/whisperkit-cli',
      '/opt/homebrew/bin/whisper-cli',
      '/usr/local/bin/whisper-cli',
      '/opt/homebrew/bin/whisper',
      '/usr/local/bin/whisper',
      join(homedir(), '.local/bin/whisper'),
    ]

    let whisperBin = ''
    for (const c of candidates) {
      if (existsSync(c)) { whisperBin = c; break }
    }
    mark('probe_binary_paths', t0)

    if (!whisperBin) {
      t0 = Date.now()
      for (const name of ['whisperkit-cli', 'whisper-cli', 'whisper']) {
        try {
          whisperBin = await runExecFile('/bin/zsh', ['-lc', `whence -p ${name}`], 5000).then((s) => s.trim())
          if (whisperBin) break
        } catch {}
      }
      mark('probe_binary_whence', t0)
    }

    if (!whisperBin) {
      const hint = process.arch === 'arm64'
        ? 'brew install whisperkit-cli   (or: brew install whisper-cpp)'
        : 'brew install whisper-cpp'
      return {
        error: `Whisper not found. Install with:\n  ${hint}`,
        transcript: null,
      }
    }

    const isWhisperKit = whisperBin.includes('whisperkit-cli')
    const isWhisperCpp = !isWhisperKit && whisperBin.includes('whisper-cli')

    log(`Transcribing with: ${whisperBin} (backend: ${isWhisperKit ? 'WhisperKit' : isWhisperCpp ? 'whisper-cpp' : 'Python whisper'})`)

    let output: string
    if (isWhisperKit) {
      // WhisperKit (Apple Silicon CoreML) — auto-downloads models on first run
      // Use --report to produce a JSON file with a top-level "text" field for deterministic parsing
      const reportDir = tmpdir()
      t0 = Date.now()
      output = await runExecFile(
        whisperBin,
        ['transcribe', '--audio-path', tmpWav, '--model', 'tiny', '--without-timestamps', '--skip-special-tokens', '--report', '--report-path', reportDir],
        60000
      )
      mark('whisperkit_transcribe_report', t0)

      // WhisperKit writes <audioFileName>.json (filename without extension)
      const wavBasename = basename(tmpWav, '.wav')
      const reportPath = join(reportDir, `${wavBasename}.json`)
      if (existsSync(reportPath)) {
        try {
          t0 = Date.now()
          const report = JSON.parse(readFileSync(reportPath, 'utf-8'))
          const transcript = (report.text || '').trim()
          mark('whisperkit_parse_report_json', t0)
          try { unlinkSync(reportPath) } catch {}
          // Also clean up .srt that --report creates
          const srtPath = join(reportDir, `${wavBasename}.srt`)
          try { unlinkSync(srtPath) } catch {}
          log(`Transcription timing(ms): ${JSON.stringify({ ...phaseMs, total: Date.now() - startedAt })}`)
          return { error: null, transcript }
        } catch (parseErr: any) {
          log(`WhisperKit JSON parse failed: ${parseErr.message}, falling back to stdout`)
          try { unlinkSync(reportPath) } catch {}
        }
      }

      // Performance fallback: avoid a second full transcription if report file is missing/invalid.
      // Use stdout from the first run to keep latency close to pre-report behavior.
      if (!output || !output.trim()) {
        t0 = Date.now()
        output = await runExecFile(
          whisperBin,
          ['transcribe', '--audio-path', tmpWav, '--model', 'tiny', '--without-timestamps', '--skip-special-tokens'],
          60000
        )
        mark('whisperkit_transcribe_stdout_rerun', t0)
      }
    } else if (isWhisperCpp) {
      // whisper-cpp: whisper-cli -m model -f file --no-timestamps
      // Find model file — prefer multilingual (auto-detect language) over .en (English-only)
      const modelCandidates = [
        join(homedir(), '.local/share/whisper/ggml-base.bin'),
        join(homedir(), '.local/share/whisper/ggml-tiny.bin'),
        '/opt/homebrew/share/whisper-cpp/models/ggml-base.bin',
        '/opt/homebrew/share/whisper-cpp/models/ggml-tiny.bin',
        join(homedir(), '.local/share/whisper/ggml-base.en.bin'),
        join(homedir(), '.local/share/whisper/ggml-tiny.en.bin'),
        '/opt/homebrew/share/whisper-cpp/models/ggml-base.en.bin',
        '/opt/homebrew/share/whisper-cpp/models/ggml-tiny.en.bin',
      ]

      let modelPath = ''
      for (const m of modelCandidates) {
        if (existsSync(m)) { modelPath = m; break }
      }

      if (!modelPath) {
        return {
          error: 'Whisper model not found. Download with:\n  mkdir -p ~/.local/share/whisper && curl -L -o ~/.local/share/whisper/ggml-tiny.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
          transcript: null,
        }
      }

      const isEnglishOnly = modelPath.includes('.en.')
      const langFlag = isEnglishOnly ? '-l en' : '-l auto'
      t0 = Date.now()
      output = await runExecFile(
        whisperBin,
        ['-m', modelPath, '-f', tmpWav, '--no-timestamps', '-l', isEnglishOnly ? 'en' : 'auto'],
        30000
      )
      mark('whisper_cpp_transcribe', t0)
    } else {
      // Python whisper
      t0 = Date.now()
      output = await runExecFile(
        whisperBin,
        [tmpWav, '--model', 'tiny', '--output_format', 'txt', '--output_dir', tmpdir()],
        30000
      )
      mark('python_whisper_transcribe', t0)
      // Python whisper writes .txt file
      const txtPath = tmpWav.replace('.wav', '.txt')
      if (existsSync(txtPath)) {
        t0 = Date.now()
        const transcript = readFileSync(txtPath, 'utf-8').trim()
        mark('python_whisper_read_txt', t0)
        try { unlinkSync(txtPath) } catch {}
        log(`Transcription timing(ms): ${JSON.stringify({ ...phaseMs, total: Date.now() - startedAt })}`)
        return { error: null, transcript }
      }
      // File not created — Python whisper failed silently
      return {
        error: `Whisper output file not found at ${txtPath}. Check disk space and permissions.`,
        transcript: null,
      }
    }

    // WhisperKit (stdout fallback) and whisper-cpp print to stdout directly
    // Strip timestamp patterns and known hallucination outputs
    const HALLUCINATIONS = /^\s*(\[BLANK_AUDIO\]|you\.?|thank you\.?|thanks\.?)\s*$/i
    const transcript = output
      .replace(/\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/g, '')
      .trim()

    if (HALLUCINATIONS.test(transcript)) {
      log(`Transcription timing(ms): ${JSON.stringify({ ...phaseMs, total: Date.now() - startedAt })}`)
      return { error: null, transcript: '' }
    }

    log(`Transcription timing(ms): ${JSON.stringify({ ...phaseMs, total: Date.now() - startedAt })}`)
    return { error: null, transcript: transcript || '' }
  } catch (err: any) {
    log(`Transcription error: ${err.message}`)
    log(`Transcription timing(ms): ${JSON.stringify({ ...phaseMs, total: Date.now() - startedAt, failed: true })}`)
    return {
      error: `Transcription failed: ${err.message}`,
      transcript: null,
    }
  } finally {
    try { unlinkSync(tmpWav) } catch {}
  }
})

ipcMain.handle(IPC.GET_DIAGNOSTICS, () => {
  const { readFileSync, existsSync } = require('fs')
  const health = controlPlane.getHealth()

  let recentLogs = ''
  if (existsSync(LOG_FILE)) {
    try {
      const content = readFileSync(LOG_FILE, 'utf-8')
      const lines = content.split('\n')
      recentLogs = lines.slice(-100).join('\n')
    } catch {}
  }

  return {
    health,
    logPath: LOG_FILE,
    recentLogs,
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    appVersion: app.getVersion(),
    transport: INTERACTIVE_PTY ? 'pty' : 'stream-json',
  }
})

ipcMain.handle(IPC.OPEN_IN_TERMINAL, (_event, arg: string | null | { sessionId?: string | null; projectPath?: string }) => {
  const { execFile } = require('child_process')
  const claudeBin = 'claude'

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  // Support both old (string) and new ({ sessionId, projectPath }) calling convention
  let sessionId: string | null = null
  let projectPath: string = process.cwd()
  if (typeof arg === 'string') {
    sessionId = arg
  } else if (arg && typeof arg === 'object') {
    sessionId = arg.sessionId ?? null
    projectPath = arg.projectPath && arg.projectPath !== '~' ? arg.projectPath : process.cwd()
  }

  // Validate sessionId — must be a strict UUID to prevent injection into the shell command
  if (sessionId && !UUID_RE.test(sessionId)) {
    log(`OPEN_IN_TERMINAL: rejected invalid sessionId: ${sessionId}`)
    return false
  }

  // Sanitize projectPath — reject null bytes, newlines, and non-absolute paths
  if (/[\0\r\n]/.test(projectPath) || !projectPath.startsWith('/')) {
    log(`OPEN_IN_TERMINAL: rejected invalid projectPath: ${projectPath}`)
    return false
  }

  // Shell-safe single-quote escaping: replace ' with '\'' (end quote, escaped literal quote, reopen quote)
  // Single quotes block all shell expansion ($, `, \, etc.) — unlike double quotes which allow $() and backticks
  const shellSingleQuote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'"
  // AppleScript string escaping: backslashes doubled, double quotes escaped
  const escapeAppleScript = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

  const safeDir = escapeAppleScript(shellSingleQuote(projectPath))

  let cmd: string
  if (sessionId) {
    // sessionId is UUID-validated above, safe to embed directly
    cmd = `cd ${safeDir} && ${claudeBin} --resume ${sessionId}`
  } else {
    cmd = `cd ${safeDir} && ${claudeBin}`
  }

  const script = `tell application "Terminal"
  activate
  do script "${cmd}"
end tell`

  try {
    execFile('/usr/bin/osascript', ['-e', script], (err: Error | null) => {
      if (err) log(`Failed to open terminal: ${err.message}`)
      else log(`Opened terminal with: ${cmd}`)
    })
    return true
  } catch (err: unknown) {
    log(`Failed to open terminal: ${err}`)
    return false
  }
})

// ─── Marketplace IPC ───

ipcMain.handle(IPC.MARKETPLACE_FETCH, async (_event, { forceRefresh } = {}) => {
  log('IPC MARKETPLACE_FETCH')
  return fetchCatalog(forceRefresh)
})

ipcMain.handle(IPC.MARKETPLACE_INSTALLED, async () => {
  log('IPC MARKETPLACE_INSTALLED')
  return listInstalled()
})

ipcMain.handle(IPC.MARKETPLACE_INSTALL, async (_event, { repo, pluginName, marketplace, sourcePath, isSkillMd }: { repo: string; pluginName: string; marketplace: string; sourcePath?: string; isSkillMd?: boolean }) => {
  log(`IPC MARKETPLACE_INSTALL: ${pluginName} from ${repo} (isSkillMd=${isSkillMd})`)
  return installPlugin(repo, pluginName, marketplace, sourcePath, isSkillMd)
})

ipcMain.handle(IPC.MARKETPLACE_UNINSTALL, async (_event, { pluginName }: { pluginName: string }) => {
  log(`IPC MARKETPLACE_UNINSTALL: ${pluginName}`)
  return uninstallPlugin(pluginName)
})

// ─── Theme Detection ───

ipcMain.handle(IPC.GET_THEME, () => {
  return { isDark: nativeTheme.shouldUseDarkColors }
})

nativeTheme.on('updated', () => {
  broadcast(IPC.THEME_CHANGED, nativeTheme.shouldUseDarkColors)
})

// ─── Permission Preflight ───
// Request all required macOS permissions upfront on first launch so the user
// is never interrupted mid-session by a permission prompt.

ipcMain.handle(IPC.REQUEST_MIC, async () => {
  if (process.platform !== 'darwin') return true
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') return true
    if (status === 'not-determined') return await systemPreferences.askForMediaAccess('microphone')
    return false
  } catch (err: any) {
    log(`microphone access check failed — ${err.message}`)
    return false
  }
})

async function requestPermissions(): Promise<void> {
  if (process.platform !== 'darwin') return

  // Microphone: asked on first use of the mic button (REQUEST_MIC), not at launch

  // ── Accessibility (for global ⌥+Space shortcut) ──
  // globalShortcut works without it on modern macOS; Cmd+Shift+K is always the fallback.
  // Screen Recording: not requested upfront — macOS 15 Sequoia shows an alarming
  // "bypass private window picker" dialog. Let the OS prompt naturally if/when
  // the screenshot feature is actually used.
}

// ─── App Lifecycle ───

app.whenReady().then(async () => {
  watchdog.start()
  app.on('child-process-gone', (_e, d) => log(`child process gone: ${d.type} ${d.reason} (exit ${d.exitCode})`))
  // macOS: become an accessory app. Accessory apps can have key windows (keyboard works)
  // without deactivating the currently active app (hover preserved in browsers).
  // This is how Spotlight, Alfred, Raycast work.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide()
  }

  // Request permissions upfront so the user is never interrupted mid-session.
  await requestPermissions()

  installContentSecurityPolicy()

  // Skill provisioning — non-blocking, streams status to renderer
  ensureSkills((status: SkillStatus) => {
    log(`Skill ${status.name}: ${status.state}${status.error ? ` — ${status.error}` : ''}`)
    broadcast(IPC.SKILL_STATUS, status)
  }).catch((err: Error) => log(`Skill provisioning error: ${err.message}`))

  bubble = new BubbleController(log)
  createWindow()
  statusTracker = new StatusTracker(CLUI_HOME, onStatusChange, (st, kind) => alertSession(st, kind), log)
  statusTracker.start()
  snapshotWindowState('after createWindow')

  if (SPACES_DEBUG) {
    mainWindow?.on('show', () => snapshotWindowState('event window show'))
    mainWindow?.on('hide', () => snapshotWindowState('event window hide'))
    mainWindow?.on('focus', () => snapshotWindowState('event window focus'))
    mainWindow?.on('blur', () => snapshotWindowState('event window blur'))
    mainWindow?.webContents.on('focus', () => snapshotWindowState('event webContents focus'))
    mainWindow?.webContents.on('blur', () => snapshotWindowState('event webContents blur'))

    app.on('browser-window-focus', () => snapshotWindowState('event app browser-window-focus'))
    app.on('browser-window-blur', () => snapshotWindowState('event app browser-window-blur'))

    screen.on('display-added', (_e, display) => {
      log(`[spaces] event display-added id=${display.id}`)
      snapshotWindowState('event display-added')
    })
    screen.on('display-removed', (_e, display) => {
      log(`[spaces] event display-removed id=${display.id}`)
      snapshotWindowState('event display-removed')
    })
    screen.on('display-metrics-changed', (_e, display, changedMetrics) => {
      log(`[spaces] event display-metrics-changed id=${display.id} changed=${changedMetrics.join(',')}`)
      snapshotWindowState('event display-metrics-changed')
    })
  }


  // Primary: Option+Space (2 keys, doesn't conflict with shell)
  // Fallback: Cmd+Shift+K kept as secondary shortcut
  const registered = globalShortcut.register('Alt+Space', () => toggleWindow('shortcut Alt+Space'))
  if (!registered) {
    log('Alt+Space shortcut registration failed — macOS input sources may claim it')
  }
  globalShortcut.register('CommandOrControl+Shift+K', () => toggleWindow('shortcut Cmd/Ctrl+Shift+K'))
  if (!globalShortcut.register('CommandOrControl+Alt+Shift+Q', () => forceQuitApp('shortcut Cmd+Opt+Shift+Q'))) {
    log('Force-quit shortcut Cmd+Opt+Shift+Q registration failed')
  }

  const trayIconPath = join(__dirname, '../../resources/trayTemplate.png')
  const trayIcon = nativeImage.createFromPath(trayIconPath)
  trayIcon.setTemplateImage(true)
  tray = new Tray(trayIcon)
  tray.setToolTip('Clui CC — Claude Code UI')
  tray.on('click', () => toggleWindow('tray click'))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Clui CC', click: () => showWindow('tray menu') },
      { label: 'Reset Position', click: () => { resetWindowPosition(); showWindow('tray reset') } },
      { label: 'Quit', click: () => { app.quit() } },
      { type: 'separator' },
      { label: 'Force Quit', accelerator: 'CommandOrControl+Alt+Shift+Q', click: () => forceQuitApp('tray menu') },
      { label: 'Show Debug Log', click: () => { flushLogs(); shell.showItemInFolder(LOG_FILE) } },
    ])
  )
  // Tray and bubble exist now; reflect statuses loaded at startup
  if (statusTracker) onStatusChange(statusTracker.snapshot())

  // app 'activate' fires when macOS brings the app to the foreground (e.g. after
  // webContents.focus() triggers applicationDidBecomeActive on some macOS versions).
  // Using showWindow here instead of toggleWindow prevents the re-entry race where
  // a summon immediately hides itself because activate fires mid-show.
  app.on('activate', () => showWindow('app activate'))
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  statusTracker?.stop()
  filePicker.cancel('app quit')
  try { remoteControl.killAll() } catch {}
  controlPlane.shutdown()
  watchdog.stop()
  flushLogs()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
