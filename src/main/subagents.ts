// Subagent activity for a Claude Code session, read from what the CLI writes to disk:
//   <project>/<sessionId>/subagents/agent-<id>.meta.json  (type, description, model)
//   <project>/<sessionId>/subagents/agent-<id>.jsonl      (the agent's own transcript)
//   <project>/<sessionId>.jsonl                           (completion results / task notifications)
// Transcripts only grow, so each file is parsed incrementally from the last offset.
// Kept free of electron imports so it can be unit-tested with plain node.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'fs'
import { basename, join } from 'path'
import { findSessionFile } from './sessions'

export type SubagentState = 'running' | 'completed' | 'failed' | 'stopped'

export interface SubagentInfo {
  agentId: string
  agentType: string
  description: string
  model: string | null
  status: SubagentState
  /** ms epoch */
  startedAt: number
  /** ms epoch; null while running */
  endedAt: number | null
  /** Final duration when finished; elapsed so far otherwise */
  durationMs: number
  tokens: number
  toolUses: number
  /** What it is doing now, like the terminal's progress line */
  activity: string | null
  depth: number
}

// A running agent with no transcript writes for this long is shown as stopped
export const STALE_AFTER_MS = 15 * 60 * 1000

// ─── Incremental line reader ───

interface Tail { offset: number; rest: string }

function readNewLines(path: string, tail: Tail): string[] {
  let size: number
  try { size = statSync(path).size } catch { return [] }
  if (size < tail.offset) { tail.offset = 0; tail.rest = '' } // rewritten: start over
  if (size === tail.offset) return []
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(size - tail.offset)
    const n = readSync(fd, buf, 0, buf.length, tail.offset)
    tail.offset += n
    const text = tail.rest + buf.subarray(0, n).toString('utf-8')
    const lines = text.split('\n')
    tail.rest = lines.pop() ?? '' // partial last line: finish it next time
    return lines
  } finally {
    closeSync(fd)
  }
}

// ─── Per-agent transcript stats ───

interface AgentStats {
  tail: Tail
  startedAt: number | null
  lastAt: number | null
  tokens: number
  toolUses: number
  activity: string | null
  model: string | null
}

function describeTool(name: string, input: any): string {
  const file = typeof input?.file_path === 'string' ? basename(input.file_path) : null
  switch (name) {
    case 'Bash':
      return clip(input?.description || input?.command || 'Running command')
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
      return file ? `${name} ${file}` : name
    case 'Grep': case 'Glob':
      return input?.pattern ? clip(`${name} ${input.pattern}`) : name
    case 'Agent': case 'Task':
      return clip(`Agent: ${input?.description || input?.subagent_type || ''}`)
    case 'WebFetch':
      return clip(`Fetch ${input?.url || ''}`)
    case 'WebSearch':
      return clip(`Search ${input?.query || ''}`)
    default:
      return name
  }
}

function clip(s: string, max = 80): string {
  const t = String(s).replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/** Total context tokens of one turn, matching the terminal's "↓ N tokens". */
function usageTokens(u: any): number {
  if (!u || typeof u !== 'object') return 0
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0)
}

function updateAgentStats(path: string, st: AgentStats): void {
  for (const line of readNewLines(path, st.tail)) {
    let o: any
    try { o = JSON.parse(line) } catch { continue }
    const t = o.timestamp ? Date.parse(o.timestamp) : NaN
    if (!Number.isNaN(t)) {
      if (st.startedAt == null) st.startedAt = t
      st.lastAt = t
    }
    if (o.type !== 'assistant') continue
    const msg = o.message
    if (msg?.model && !st.model) st.model = msg.model
    const tok = usageTokens(msg?.usage)
    if (tok) st.tokens = tok
    if (!Array.isArray(msg?.content)) continue
    let sawTool = false
    for (const b of msg.content) {
      if (b?.type === 'tool_use') {
        st.toolUses++
        st.activity = describeTool(b.name, b.input)
        sawTool = true
      }
    }
    // A text-only turn is the agent wrapping up; drop the stale tool line
    if (!sawTool && msg.content.some((b: any) => b?.type === 'text')) st.activity = null
  }
}

// ─── Completions recorded in the parent transcript ───

interface Completion { status: SubagentState; at: number; durationMs?: number; tokens?: number; toolUses?: number }

interface ParentStats { tail: Tail; completions: Map<string, Completion> }

function tag(text: string, name: string): string | null {
  const m = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
  return m ? m[1].trim() : null
}

function mapStatus(s: string | null | undefined): SubagentState {
  if (s === 'completed') return 'completed'
  if (s === 'failed' || s === 'error') return 'failed'
  return 'stopped' // killed / stopped / cancelled
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

function updateParentStats(path: string, ps: ParentStats): void {
  for (const line of readNewLines(path, ps.tail)) {
    let o: any
    try { o = JSON.parse(line) } catch { continue }
    const at = o.timestamp ? Date.parse(o.timestamp) : Date.now()
    // Foreground agent: the Agent tool's result
    const r = o.toolUseResult
    if (r && typeof r === 'object' && typeof r.agentId === 'string' && r.status && r.status !== 'async_launched') {
      ps.completions.set(r.agentId, {
        status: mapStatus(r.status), at,
        durationMs: num(r.totalDurationMs), tokens: num(r.totalTokens), toolUses: num(r.totalToolUseCount),
      })
      continue
    }
    // Background agent: a <task-notification> queued back to the parent
    if (o.type === 'queue-operation' && o.operation === 'enqueue' && typeof o.content === 'string' && o.content.includes('<task-notification>')) {
      const id = tag(o.content, 'task-id')
      if (!id) continue
      ps.completions.set(id, {
        status: mapStatus(tag(o.content, 'status')), at,
        durationMs: num(tag(o.content, 'duration_ms')), tokens: num(tag(o.content, 'subagent_tokens')), toolUses: num(tag(o.content, 'tool_uses')),
      })
    }
  }
}

// ─── Public API ───

const agentCache = new Map<string, AgentStats>()
const parentCache = new Map<string, ParentStats>()
const metaCache = new Map<string, any>()

export function listSubagentsForTranscript(sessionFile: string, now = Date.now()): SubagentInfo[] {
  const dir = join(sessionFile.replace(/\.jsonl$/, ''), 'subagents')
  if (!existsSync(dir)) return []

  let ps = parentCache.get(sessionFile)
  if (!ps) { ps = { tail: { offset: 0, rest: '' }, completions: new Map() }; parentCache.set(sessionFile, ps) }
  updateParentStats(sessionFile, ps)

  const out: SubagentInfo[] = []
  for (const name of readdirSync(dir)) {
    const m = name.match(/^agent-([A-Za-z0-9_-]+)\.jsonl$/)
    if (!m) continue
    const agentId = m[1]
    const path = join(dir, name)
    let st = agentCache.get(path)
    if (!st) {
      st = { tail: { offset: 0, rest: '' }, startedAt: null, lastAt: null, tokens: 0, toolUses: 0, activity: null, model: null }
      agentCache.set(path, st)
    }
    updateAgentStats(path, st)

    // Meta is written once at spawn; cache it once found
    let meta = metaCache.get(path)
    if (!meta) {
      try {
        meta = JSON.parse(readFileSync(join(dir, `agent-${agentId}.meta.json`), 'utf-8'))
        metaCache.set(path, meta)
      } catch {
        meta = {}
      }
    }

    const startedAt = st.startedAt ?? now
    const lastAt = st.lastAt ?? startedAt
    const done = ps.completions.get(agentId)
    // A resumed agent writes again after its completion: then it's running again
    const finished = done && done.at >= lastAt - 1000 ? done : undefined

    let status: SubagentState
    let endedAt: number | null
    if (finished) {
      status = finished.status
      endedAt = finished.at
    } else if (now - lastAt > STALE_AFTER_MS) {
      status = 'stopped'
      endedAt = lastAt
    } else {
      status = 'running'
      endedAt = null
    }

    out.push({
      agentId,
      agentType: typeof meta.agentType === 'string' ? meta.agentType : 'agent',
      description: typeof meta.description === 'string' ? meta.description : '',
      model: typeof meta.model === 'string' ? meta.model : st.model,
      status,
      startedAt,
      endedAt,
      durationMs: finished?.durationMs ?? ((endedAt ?? now) - startedAt),
      tokens: finished?.tokens ?? st.tokens,
      toolUses: finished?.toolUses ?? st.toolUses,
      activity: status === 'running' ? st.activity : null,
      depth: Number.isInteger(meta.spawnDepth) ? meta.spawnDepth : 1,
    })
  }
  // Running first (newest first), then finished (most recent first)
  out.sort((a, b) =>
    Number(b.status === 'running') - Number(a.status === 'running')
    || (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
  return out
}

export function listSubagents(projectsRoot: string, sessionId: string, projectPath?: string, now = Date.now()): SubagentInfo[] {
  const file = findSessionFile(projectsRoot, sessionId, projectPath)
  return file ? listSubagentsForTranscript(file, now) : []
}

/** For tests: forget incremental parse state. */
export function resetSubagentCache(): void {
  agentCache.clear()
  parentCache.clear()
  metaCache.clear()
}
