// Watches ~/.clui/events, keeps the live status map, and persists it across restarts.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, watch, type FSWatcher } from 'fs'
import { join } from 'path'
import { drainEvents } from './events'
import { applyEvent, markDead, prune, type NotifyKind, type SessionStatus, type StatusMap } from './reducer'

const POLL_MS = 5000
const LIVENESS_MS = 30000

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM' // exists but not ours
  }
}

export class StatusTracker {
  private map: StatusMap = {}
  private watcher: FSWatcher | null = null
  private timers: NodeJS.Timeout[] = []
  private drainScheduled = false
  private readonly eventsDir: string
  private readonly statePath: string
  private readonly onChange: (map: StatusMap) => void
  private readonly onNotify: (status: SessionStatus, kind: NotifyKind) => void
  private readonly log: (msg: string) => void

  // No parameter properties: this file is loaded directly by node's type stripping in tests
  constructor(
    cluiHome: string,
    onChange: (map: StatusMap) => void,
    onNotify: (status: SessionStatus, kind: NotifyKind) => void,
    log: (msg: string) => void,
  ) {
    this.onChange = onChange
    this.onNotify = onNotify
    this.log = log
    this.eventsDir = join(cluiHome, 'events')
    this.statePath = join(cluiHome, 'status.json')
  }

  start(): void {
    try {
      if (existsSync(this.statePath)) this.map = JSON.parse(readFileSync(this.statePath, 'utf-8')) || {}
    } catch {
      this.map = {}
    }
    mkdirSync(this.eventsDir, { recursive: true })
    // Backlog from while Clui was closed: update state, but don't fire stale banners
    this.drain(false)
    this.checkLiveness()
    try {
      this.watcher = watch(this.eventsDir, () => this.scheduleDrain())
    } catch (err) {
      this.log(`status watcher failed, polling only: ${err}`)
    }
    this.timers.push(setInterval(() => this.scheduleDrain(), POLL_MS))
    this.timers.push(setInterval(() => this.checkLiveness(), LIVENESS_MS))
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    this.timers.forEach(clearInterval)
    this.timers = []
  }

  snapshot(): StatusMap {
    return this.map
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return
    this.drainScheduled = true
    // Coalesce bursts (e.g. PostToolUse storms) into one pass
    setTimeout(() => {
      this.drainScheduled = false
      this.drain(true)
    }, 100)
  }

  private drain(notify: boolean): void {
    const events = drainEvents(this.eventsDir)
    if (events.length === 0) return
    const pending = new Map<string, NotifyKind>()
    for (const ev of events) {
      const { changed, notify: kind } = applyEvent(this.map, ev)
      if (!changed) continue
      // Only the latest notification per session within a batch matters
      if (kind) pending.set(changed.sessionId, kind)
      else if (pending.has(changed.sessionId)) pending.delete(changed.sessionId)
    }
    this.commit()
    if (!notify) return
    for (const [id, kind] of pending) {
      const s = this.map[id]
      if (s && s.status === kind) this.onNotify(s, kind)
    }
  }

  private checkLiveness(): void {
    const dead = markDead(this.map, pidAlive, Date.now())
    const before = Object.keys(this.map).length
    prune(this.map, Date.now())
    if (dead.length > 0 || Object.keys(this.map).length !== before) this.commit()
  }

  private commit(): void {
    try {
      const tmp = `${this.statePath}.tmp`
      writeFileSync(tmp, JSON.stringify(this.map))
      renameSync(tmp, this.statePath)
    } catch (err) {
      this.log(`status save failed: ${err}`)
    }
    this.onChange(this.map)
  }
}
