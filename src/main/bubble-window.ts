import { app, BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { BUBBLE_W, BUBBLE_H, clampToWorkArea, defaultBubblePosition, parseBubbleState, type Point } from './bubble-geometry'
import { IPC } from '../shared/types'
import type { BubbleActivity } from './session-status/reducer'
import { log } from './logger'

/**
 * Minimized mode: the overlay collapses into a small draggable logo window.
 * Clicking it restores the overlay at its previous bounds.
 */
export class BubbleController {
  private win: BrowserWindow | null = null
  private pos: Point | null = null
  private minimized = false
  private attention = 0
  private activity: BubbleActivity = null
  private readonly statePath = join(app.getPath('userData'), 'bubble.json')

  constructor(private readonly log: (msg: string) => void) {
    try {
      const s = parseBubbleState(readFileSync(this.statePath, 'utf-8'))
      if (s.x != null && s.y != null) this.pos = { x: s.x, y: s.y }
      this.minimized = s.minimized
    } catch {}
  }

  isMinimized(): boolean {
    return this.minimized
  }

  /** Hide the overlay (caller's job) and show the bubble. */
  show(): void {
    this.minimized = true
    const win = this.ensureWindow()
    const { x, y } = this.currentPosition()
    win.setBounds({ x, y, width: BUBBLE_W, height: BUBBLE_H })
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.showInactive()
    this.save()
  }

  /** Hide the bubble; the caller shows the overlay. */
  hide(): void {
    if (!this.minimized && !this.win?.isVisible()) return
    this.minimized = false
    // Expanding counts as handled: stop any repeating needs-you hops
    this.sendBounce('stop')
    this.win?.hide()
    this.save()
  }

  move(dx: number, dy: number, done: boolean): void {
    if (!this.win || this.win.isDestroyed()) return
    const [x, y] = this.win.getPosition()
    const display = screen.getDisplayNearestPoint({ x: x + dx, y: y + dy })
    const next = clampToWorkArea({ x: x + dx, y: y + dy }, display.workArea)
    this.win.setPosition(next.x, next.y)
    this.pos = next
    if (done) this.save()
  }

  setAttention(count: number, activity: BubbleActivity = this.activity): void {
    this.attention = count
    this.activity = activity
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(IPC.BUBBLE_STATE, { attention: count, activity })
  }

  /** A chat finished or needs input: make the minimized bubble hop. */
  bounce(kind: 'finished' | 'needs_approval' | 'asking'): void {
    if (!this.minimized) return
    this.sendBounce(kind)
  }

  private sendBounce(kind: string): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(IPC.BUBBLE_BOUNCE, { kind })
  }

  private currentPosition(): Point {
    const fallbackArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    if (!this.pos) return defaultBubblePosition(fallbackArea)
    // Re-clamp in case the display layout changed since last time
    return clampToWorkArea(this.pos, screen.getDisplayNearestPoint(this.pos).workArea)
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win
    const win = new BrowserWindow({
      width: BUBBLE_W,
      height: BUBBLE_H,
      ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      backgroundColor: '#00000000',
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/bubble.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    })
    win.setAlwaysOnTop(true, 'floating')
    win.webContents.on('did-finish-load', () => this.setAttention(this.attention))
    // A missing bubble.html/preload (e.g. a half-synced dist/) otherwise fails silently: no bubble at all
    win.webContents.on('did-fail-load', (_e, code, desc, url) => log('bubble', `load failed ${code} ${desc} ${url}`))
    win.webContents.on('preload-error', (_e, path, err) => log('bubble', `preload failed ${path}: ${err.message}`))
    if (process.env.ELECTRON_RENDERER_URL) {
      win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/bubble.html`)
    } else {
      win.loadFile(join(__dirname, '../renderer/bubble.html'))
    }
    win.on('closed', () => { this.win = null })
    this.win = win
    return win
  }

  private save(): void {
    try {
      writeFileSync(this.statePath, JSON.stringify({ ...this.pos, minimized: this.minimized }))
    } catch (err) {
      this.log(`bubble state save failed: ${err}`)
    }
  }
}
