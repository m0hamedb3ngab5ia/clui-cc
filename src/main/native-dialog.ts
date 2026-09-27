// File/folder pickers that can't freeze the app.
//
// Electron's dialog.showOpenDialog creates the NSOpenPanel on the main thread,
// and -[NSSavePanel _initBridgeAndStuff] blocks until macOS's picker service
// answers. When that service is wedged (seen: stuck on iCloud/File Provider),
// the whole app froze, the tray stopped responding, and the screen-saver-level
// overlay kept swallowing clicks meant for other apps.
//
// So the picker runs in a separate osascript process: if macOS hangs, only that
// child hangs. Clicking attach again cancels it, force quit still works, and
// every step is logged. The overlay is lowered while the picker is up so the
// dialog isn't hidden behind it.

export type PickKind = 'files' | 'directory'

export interface DialogHost {
  setAlwaysOnTop(flag: boolean, level?: 'screen-saver'): void
  isDestroyed(): boolean
}

export interface PickerChild {
  pid?: number
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null
  on(event: 'close', cb: (code: number | null, signal: string | null) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  kill(signal?: string): boolean
}

export interface PickerDeps {
  spawn: (cmd: string, args: string[]) => PickerChild
  host: () => DialogHost | null
  log: (msg: string) => void
  /** Mark a long-running operation for the hang watchdog; returns an "ended" callback. */
  track?: (label: string) => () => void
  now?: () => number
}

export type PickerResult =
  | { status: 'picked'; paths: string[] }
  | { status: 'canceled' }
  | { status: 'error'; message: string }

/** AppleScript lines for osascript -e. Prompts are fixed strings, never user input. */
export function pickerScript(kind: PickKind): string[] {
  if (kind === 'directory') {
    return [
      'activate',
      'POSIX path of (choose folder with prompt "Choose a folder")',
    ]
  }
  return [
    'activate',
    'set picked to choose file with prompt "Attach files" with multiple selections allowed',
    'set out to ""',
    'repeat with f in picked',
    'set out to out & POSIX path of f & linefeed',
    'end repeat',
    'return out',
  ]
}

export function parsePickerResult(code: number | null, signal: string | null, stdout: string, stderr: string): PickerResult {
  // -128 is AppleScript's "User canceled"; a signal means we killed it (cancel)
  if (signal || /\(-128\)/.test(stderr)) return { status: 'canceled' }
  if (code !== 0) return { status: 'error', message: stderr.trim() || `osascript exited ${code}` }
  const paths = stdout
    .split('\n')
    .filter((l) => l.length > 0) // don't trim: macOS names may end in spaces
    .map((p) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p))
  return paths.length ? { status: 'picked', paths } : { status: 'canceled' }
}

export class FilePicker {
  private child: PickerChild | null = null
  private label: string | null = null
  private deps: PickerDeps

  constructor(deps: PickerDeps) {
    this.deps = deps
  }

  isOpen(): string | null {
    return this.label
  }

  /** Kills the open picker, if any. Its pick() resolves null. */
  cancel(reason: string): boolean {
    if (!this.child) return false
    this.deps.log(`[dialog] ${this.label}: canceling (${reason})`)
    this.child.kill('SIGKILL')
    return true
  }

  /**
   * Opens a picker and resolves the chosen paths, or null on cancel/error.
   * Asking again while one is open cancels it (a second click on attach = cancel).
   */
  pick(kind: PickKind, label: string): Promise<string[] | null> {
    if (this.child) {
      this.cancel(`${label} requested while open`)
      return Promise.resolve(null)
    }
    const { log } = this.deps
    const now = this.deps.now ?? Date.now
    const started = now()
    const args = pickerScript(kind).flatMap((line) => ['-e', line])

    let child: PickerChild
    try {
      child = this.deps.spawn('osascript', args)
    } catch (err) {
      log(`[dialog] ${label}: failed to start picker: ${err instanceof Error ? err.message : String(err)}`)
      return Promise.resolve(null)
    }
    this.child = child
    this.label = label
    const end = this.deps.track?.(`dialog:${label}`)
    const host = this.deps.host()
    if (host && !host.isDestroyed()) host.setAlwaysOnTop(false)
    log(`[dialog] ${label}: opening (osascript pid ${child.pid ?? '?'})`)

    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let done = false
      child.stdout?.on('data', (c) => { stdout += String(c) })
      child.stderr?.on('data', (c) => { stderr += String(c) })
      const finish = (result: PickerResult) => {
        if (done) return
        done = true
        this.child = null
        this.label = null
        end?.()
        const h = this.deps.host()
        if (h && !h.isDestroyed()) h.setAlwaysOnTop(true, 'screen-saver')
        const ms = now() - started
        if (result.status === 'picked') log(`[dialog] ${label}: picked ${result.paths.length} after ${ms}ms`)
        else if (result.status === 'canceled') log(`[dialog] ${label}: canceled after ${ms}ms`)
        else log(`[dialog] ${label}: failed after ${ms}ms: ${result.message}`)
        resolve(result.status === 'picked' ? result.paths : null)
      }
      child.on('error', (err) => finish({ status: 'error', message: err.message }))
      child.on('close', (code, signal) => finish(parsePickerResult(code, signal, stdout, stderr)))
    })
  }
}
