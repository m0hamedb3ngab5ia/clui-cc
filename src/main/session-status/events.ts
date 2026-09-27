// Reads and consumes event files written by the clui-status hook script.
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { HookEvent } from './reducer'

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

/** Read every finished event file (oldest first), delete it, and return the parsed events. */
export function drainEvents(dir: string): HookEvent[] {
  if (!existsSync(dir)) return []
  const files: Array<{ path: string; name: string; time: number }> = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue // skips in-progress .tmp files
    const path = join(dir, name)
    try { files.push({ path, name, time: statSync(path).mtimeMs }) } catch {}
  }
  files.sort((a, b) => a.time - b.time || a.name.localeCompare(b.name))
  const events: HookEvent[] = []
  for (const f of files) {
    try {
      const ev = parseEventFile(readFileSync(f.path, 'utf-8'), Math.round(f.time))
      if (ev) events.push(ev)
    } catch {}
    try { unlinkSync(f.path) } catch {}
  }
  return events
}
