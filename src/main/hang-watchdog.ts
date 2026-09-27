// Main-thread hang watchdog.
//
// A worker thread has its own event loop, so it keeps running when the main
// thread is stuck (a blocked native call, a wedged modal loop). The main thread
// stamps a shared heartbeat every second and tells the worker which long
// operations are in flight; when the heartbeat goes stale the worker writes the
// stall, and what was running, straight to the log file.

import { Worker } from 'worker_threads'

export const HEARTBEAT_MS = 1000
export const STALL_MS = 5000

/** Pure stall check, shared by the worker source below and the tests. */
export function stallReport(lastBeat: number, now: number, ops: string[], stallMs: number): string | null {
  const age = now - lastBeat
  if (age < stallMs) return null
  return `main thread unresponsive for ${Math.round(age / 1000)}s; active: ${ops.length ? ops.join(', ') : 'none'}`
}

const WORKER_SRC = `
const { workerData, parentPort } = require('worker_threads')
const { appendFileSync } = require('fs')
const beat = new Float64Array(workerData.sab)
const stallReport = ${stallReport.toString()}
let ops = []
let stalled = false
let lastReport = 0
parentPort.on('message', (m) => { if (m && Array.isArray(m.ops)) ops = m.ops })
const write = (msg) => { try { appendFileSync(workerData.logFile, '[' + new Date().toISOString() + '] [watchdog] ' + msg + '\\n') } catch {} }
setInterval(() => {
  const now = Date.now()
  const report = stallReport(beat[0], now, ops, workerData.stallMs)
  if (report) {
    // Log the first detection, then every 30s while it lasts
    if (!stalled || now - lastReport >= 30000) { write(report); lastReport = now }
    stalled = true
  } else if (stalled) {
    write('main thread responsive again; active: ' + (ops.length ? ops.join(', ') : 'none'))
    stalled = false
  }
}, workerData.heartbeatMs)
`

export class HangWatchdog {
  private worker: Worker | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private beat: Float64Array
  private ops = new Map<number, string>()
  private nextOp = 1
  private logFile: string
  private log: (msg: string) => void

  constructor(logFile: string, log: (msg: string) => void) {
    this.logFile = logFile
    this.log = log
    this.beat = new Float64Array(new SharedArrayBuffer(8))
  }

  start(): void {
    if (this.worker) return
    this.beat[0] = Date.now()
    try {
      this.worker = new Worker(WORKER_SRC, {
        eval: true,
        workerData: { sab: this.beat.buffer, logFile: this.logFile, heartbeatMs: HEARTBEAT_MS, stallMs: STALL_MS },
      })
      this.worker.unref()
      this.worker.on('error', (err) => this.log(`[watchdog] worker error: ${err.message}`))
    } catch (err) {
      this.log(`[watchdog] failed to start: ${err instanceof Error ? err.message : String(err)}`)
      this.worker = null
      return
    }
    this.timer = setInterval(() => { this.beat[0] = Date.now() }, HEARTBEAT_MS)
    this.timer.unref?.()
  }

  /** Marks an operation as in flight; call the returned function when it ends. */
  track(label: string): () => void {
    const id = this.nextOp++
    this.ops.set(id, label)
    this.publish()
    return () => { this.ops.delete(id); this.publish() }
  }

  activeOps(): string[] {
    return Array.from(this.ops.values())
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    void this.worker?.terminate()
    this.worker = null
  }

  private publish(): void {
    this.worker?.postMessage({ ops: this.activeOps() })
  }
}
