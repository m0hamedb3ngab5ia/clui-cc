// Remote Control for a tab: continue its conversation from the phone or claude.ai/code.
//
// Clui runs turns headless (`claude -p`), and the CLI only enables Remote Control in
// an interactive session. So we resume the tab's session in a hidden pty
// (`claude --resume <id> --remote-control <name>`), read the session URL from its
// output, and keep it running until the user turns Remote Control off or closes the
// tab. While it runs, Clui never starts a `-p --resume` on that session (the CLI
// would refuse to move Remote Control anyway); typed input goes to the pty instead,
// and the transcript file is tailed so remote messages appear in the tab.

import { EventEmitter } from 'events'
import type { RemoteControlEvent, SessionLoadMessage } from '../../shared/types'
import { SessionTail, type LineToMessages } from './session-tail'

export const URL_RE = /https:\/\/claude\.ai\/code\/[A-Za-z0-9_-]+/
// Lines the CLI prints when Remote Control can't start; each ends the attempt. Ink positions
// every word with cursor moves, so after stripping escapes the spaces are gone: match without them.
const FAILURE_PATTERNS: Array<[RegExp, string]> = [
  [/RemoteControlnotstartedhere/i, 'This session already has Remote Control on in another terminal.'],
  [/Quicksafetycheck|trustthisfolder|Isthisaprojectyoucreated/i, 'Claude Code has not trusted this folder yet. Run `claude` in it once, accept the trust prompt, then try again.'],
  [/EnableRemoteControl\?/i, 'Remote Control needs a one-time confirmation. Run `claude remote-control` in a terminal once, answer y, then try again.'],
  [/RemoteControl(?:is)?not(?:available|eligible)|RemoteControlisn'tavailable|RemoteControl(?:is)?unavailable/i, 'Remote Control is not available for this account or environment.'],
  [/Error:/, 'Claude Code reported an error.'],
]
const START_TIMEOUT_MS = 30_000
const EXIT_GRACE_MS = 1500
const KILL_MS = 5000

/** Ink output has cursor moves and colours; keep only text */
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|[\x00-\x08\x0b-\x1f]/g, '')
}

/** Reads the CLI's output so far and decides whether Remote Control is up or failed */
export function classifyOutput(clean: string): { url: string } | { error: string } | null {
  const url = clean.match(URL_RE)
  if (url) return { url: url[0] }
  const packed = clean.replace(/\s+/g, '')
  for (const [re, error] of FAILURE_PATTERNS) {
    if (!re.test(packed)) continue
    return { error: re.source.startsWith('Error') ? (clean.match(/Error:\s*[^\n]{0,200}/)?.[0] ?? error) : error }
  }
  return null
}

export interface PtyLike {
  pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  kill(signal?: string): void
}

export interface RemoteControlDeps {
  spawn: (args: string[], cwd: string) => PtyLike
  /** Transcript file for a session, or null when it isn't on disk yet */
  sessionFile: (sessionId: string, cwd: string) => string | null
  lineToMessages: LineToMessages
  log: (msg: string) => void
}

export interface StartOptions {
  sessionId: string
  cwd: string
  name: string
  permissionMode?: string
  model?: string
}

interface Entry {
  pty: PtyLike
  tail: SessionTail | null
  output: string
  state: 'starting' | 'active' | 'stopping'
  url: string | null
  timer: ReturnType<typeof setTimeout> | null
  killTimer: ReturnType<typeof setTimeout> | null
  sessionId: string
  /** Serialises send() so concurrent messages don't interleave their keystrokes */
  queue: Promise<void>
}

/** Splits text into keyboard-sized chunks of up to 8 code points (never splits a surrogate pair) */
export function chunkForTyping(text: string): string[] {
  const chars = Array.from(text.replace(/\r?\n/g, ' '))
  const chunks: string[] = []
  for (let i = 0; i < chars.length; i += 8) chunks.push(chars.slice(i, i + 8).join(''))
  return chunks
}

/** Emits 'event' (tabId, RemoteControlEvent) and 'messages' (tabId, SessionLoadMessage[]) */
export class RemoteControlManager extends EventEmitter {
  private entries = new Map<string, Entry>()
  private deps: RemoteControlDeps

  constructor(deps: RemoteControlDeps) {
    super()
    this.deps = deps
  }

  isActive(tabId: string): boolean {
    const e = this.entries.get(tabId)
    return !!e && e.state !== 'stopping'
  }

  /** True while any pty holds the session, including one still shutting down */
  holdsSession(tabId: string): boolean {
    return this.entries.has(tabId)
  }

  activeTabs(): string[] {
    return Array.from(this.entries.keys())
  }

  start(tabId: string, opts: StartOptions): { ok: boolean; error?: string } {
    const existing = this.entries.get(tabId)
    if (existing && existing.state !== 'stopping') return { ok: false, error: 'Remote Control is already on for this chat.' }
    if (existing) {
      // Still shutting down from a stop: finish it now so the restart can proceed
      try { existing.pty.kill('SIGKILL') } catch {}
      this.cleanup(tabId, existing)
    }
    const { log } = this.deps
    // `=` form so a name starting with '-' can't be read as a flag
    const args = ['--resume', opts.sessionId, `--remote-control=${opts.name || 'Clui'}`]
    if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode)
    if (opts.model) args.push('--model', opts.model)
    let pty: PtyLike
    try {
      pty = this.deps.spawn(args, opts.cwd)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`[rc] ${tabId}: failed to start: ${message}`)
      return { ok: false, error: `Could not start Claude Code: ${message}` }
    }
    const entry: Entry = { pty, tail: null, output: '', state: 'starting', url: null, timer: null, killTimer: null, sessionId: opts.sessionId, queue: Promise.resolve() }
    this.entries.set(tabId, entry)
    log(`[rc] ${tabId}: starting for session ${opts.sessionId} (pid ${pty.pid})`)
    this.emit('event', tabId, { state: 'starting' } satisfies RemoteControlEvent)

    entry.timer = setTimeout(() => {
      if (entry.state !== 'starting') return
      log(`[rc] ${tabId}: no URL after ${START_TIMEOUT_MS}ms; output tail: ${JSON.stringify(entry.output.replace(/\s+/g, ' ').slice(-600))}`)
      this.fail(tabId, entry, 'Remote Control did not connect within 30s.')
    }, START_TIMEOUT_MS)

    pty.onData((data) => {
      if (entry.state !== 'starting') return
      if (!entry.output) log(`[rc] ${tabId}: first output: ${JSON.stringify(stripAnsi(data).replace(/\s+/g, ' ').slice(0, 200))}`)
      entry.output = (entry.output + stripAnsi(data)).slice(-20_000)
      const verdict = classifyOutput(entry.output)
      if (!verdict) return
      if ('url' in verdict) this.activate(tabId, entry, verdict.url, opts)
      else this.fail(tabId, entry, verdict.error)
    })
    pty.onExit(({ exitCode }) => {
      const was = entry.state
      // Already removed by fail() or replaced by a restart: don't clobber the new state
      const current = this.entries.get(tabId) === entry
      this.cleanup(tabId, entry)
      if (!current) return
      log(`[rc] ${tabId}: exited (${exitCode}) while ${was}`)
      if (was === 'starting') this.emit('event', tabId, { state: 'error', message: `Claude Code exited before Remote Control connected (code ${exitCode}).` } satisfies RemoteControlEvent)
      else this.emit('event', tabId, { state: 'off', reason: was === 'stopping' ? 'stopped' : 'exited' } satisfies RemoteControlEvent)
    })
    return { ok: true }
  }

  private activate(tabId: string, entry: Entry, url: string, opts: StartOptions): void {
    entry.state = 'active'
    entry.url = url
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    this.deps.log(`[rc] ${tabId}: active at ${url}`)
    const file = this.deps.sessionFile(opts.sessionId, opts.cwd)
    if (file) {
      entry.tail = new SessionTail(file, this.deps.lineToMessages, (messages) => this.emit('messages', tabId, messages), this.deps.log)
      entry.tail.start()
    } else {
      this.deps.log(`[rc] ${tabId}: transcript not found; remote messages won't mirror`)
    }
    this.emit('event', tabId, { state: 'active', url, name: opts.name } satisfies RemoteControlEvent)
  }

  private fail(tabId: string, entry: Entry, message: string): void {
    this.deps.log(`[rc] ${tabId}: failed: ${message}`)
    entry.state = 'stopping'
    this.emit('event', tabId, { state: 'error', message } satisfies RemoteControlEvent)
    try { entry.pty.kill('SIGKILL') } catch {}
    this.cleanup(tabId, entry)
  }

  /** Types a message into the interactive session; false when Remote Control isn't on */
  send(tabId: string, text: string): boolean {
    const e = this.entries.get(tabId)
    if (!e || e.state !== 'active') return false
    // The CLI's input treats a multi-character chunk as a paste and drops a trailing Enter,
    // so type it like a keyboard: small chunks, then Enter after a pause.
    const chunks = chunkForTyping(text)
    e.queue = e.queue.then(() => new Promise<void>((resolve) => {
      let i = 0
      const step = () => {
        if (e.state !== 'active') return resolve()
        if (i < chunks.length) { e.pty.write(chunks[i++]); setTimeout(step, 8); return }
        setTimeout(() => { if (e.state === 'active') e.pty.write('\r'); resolve() }, 150)
      }
      step()
    }))
    return true
  }

  stop(tabId: string, reason: string): boolean {
    const e = this.entries.get(tabId)
    if (!e || e.state === 'stopping') return false
    this.deps.log(`[rc] ${tabId}: stopping (${reason})`)
    e.state = 'stopping'
    e.tail?.stop()
    e.tail = null
    try { e.pty.write('/exit\r') } catch {}
    e.timer = setTimeout(() => { try { e.pty.kill('SIGTERM') } catch {} }, EXIT_GRACE_MS)
    e.killTimer = setTimeout(() => { try { e.pty.kill('SIGKILL') } catch {} }, KILL_MS)
    return true
  }

  stopAll(reason: string): void {
    for (const tabId of Array.from(this.entries.keys())) this.stop(tabId, reason)
  }

  /** Synchronous teardown for app quit: there's no time for a graceful /exit */
  killAll(): void {
    for (const [tabId, e] of Array.from(this.entries)) {
      try { e.pty.kill('SIGTERM') } catch {}
      this.cleanup(tabId, e)
    }
  }

  private cleanup(tabId: string, entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.killTimer) clearTimeout(entry.killTimer)
    entry.tail?.stop()
    entry.timer = null
    entry.killTimer = null
    entry.tail = null
    if (this.entries.get(tabId) === entry) this.entries.delete(tabId)
  }
}

export type { SessionLoadMessage }
