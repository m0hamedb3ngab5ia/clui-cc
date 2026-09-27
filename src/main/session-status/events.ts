// Reads and consumes event files written by the clui-status hook script.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { HookEvent } from './reducer'

// PostToolUse payloads carry full tool output; beyond this, only the header fields are read
const MAX_FULL_READ = 128 * 1024
const HEAD_BYTES = 16 * 1024
// Backlog after a long time closed: only the newest events matter for current status
const MAX_BATCH = 2000
const STALE_TMP_MS = 60 * 60 * 1000

export function parseEventFile(raw: string, time: number): HookEvent | null {
  try {
    const o = JSON.parse(raw)
    if (!o || typeof o.payload !== 'object' || o.payload === null) return null
    const pid = Number.isInteger(o.pid) && o.pid > 1 ? o.pid : null
    return { time, pid, payload: o.payload }
  } catch {
    return null
  }
}

/** Pull the small top-level fields out of a truncated (unparseable) event file. */
export function parseEventHead(head: string, time: number): HookEvent | null {
  const str = (key: string) => {
    const m = head.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))
    if (!m) return undefined
    try { return JSON.parse(`"${m[1]}"`) as string } catch { return undefined }
  }
  const session_id = str('session_id')
  const hook_event_name = str('hook_event_name')
  if (!session_id || !hook_event_name) return null
  const pidMatch = head.match(/^\{"pid":(\d+)/)
  const pid = pidMatch ? Number(pidMatch[1]) : null
  return {
    time,
    pid: pid && pid > 1 ? pid : null,
    payload: { session_id, hook_event_name, tool_name: str('tool_name'), cwd: str('cwd'), transcript_path: str('transcript_path') },
  }
}

function readEvent(path: string, size: number, time: number): HookEvent | null {
  if (size <= MAX_FULL_READ) return parseEventFile(readFileSync(path, 'utf-8'), time)
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
    return parseEventHead(buf.subarray(0, n).toString('utf-8'), time)
  } finally {
    closeSync(fd)
  }
}

/** Read every finished event file (oldest first), delete it, and return the parsed events. */
export function drainEvents(dir: string, now = Date.now()): HookEvent[] {
  if (!existsSync(dir)) return []
  const files: Array<{ path: string; name: string; time: number; size: number }> = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (name.endsWith('.tmp')) {
      // Left behind by a hook whose mv failed
      try { if (now - statSync(path).mtimeMs > STALE_TMP_MS) unlinkSync(path) } catch {}
      continue
    }
    if (!name.endsWith('.json')) continue
    try {
      const st = statSync(path)
      files.push({ path, name, time: st.mtimeMs, size: st.size })
    } catch {}
  }
  files.sort((a, b) => a.time - b.time || a.name.localeCompare(b.name))
  const dropped = files.length > MAX_BATCH ? files.splice(0, files.length - MAX_BATCH) : []
  for (const f of dropped) { try { unlinkSync(f.path) } catch {} }
  const events: HookEvent[] = []
  for (const f of files) {
    try {
      const ev = readEvent(f.path, f.size, Math.round(f.time))
      if (ev) events.push(ev)
    } catch {}
    try { unlinkSync(f.path) } catch {}
  }
  return events
}
