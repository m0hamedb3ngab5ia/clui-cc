// Live status of Claude Code sessions, driven by global hook events.
// Pure (no electron / fs) so it can be unit-tested with node:test.

export type LiveStatus = 'idle' | 'working' | 'needs_approval' | 'asking' | 'waiting' | 'finished' | 'ended'

export interface SessionStatus {
  sessionId: string
  status: LiveStatus
  cwd: string | null
  transcriptPath: string | null
  /** Short human text: the question, the tool awaiting approval, or Claude's last message */
  message: string | null
  /** Event time in ms */
  updatedAt: number
  /** Claude process id that emitted the event (for liveness checks) */
  pid: number | null
  /** Tool the session is blocked on while needs_approval / asking */
  pendingTool?: string | null
}

export type StatusMap = Record<string, SessionStatus>

export interface HookEvent {
  time: number
  pid: number | null
  payload: Record<string, any>
}

export type NotifyKind = 'finished' | 'needs_approval' | 'asking'

export interface ApplyResult {
  changed: SessionStatus | null
  notify: NotifyKind | null
}

const NEEDS_USER: LiveStatus[] = ['needs_approval', 'asking']

export function needsUser(s: SessionStatus): boolean {
  return NEEDS_USER.includes(s.status)
}

function clip(text: unknown, max = 140): string | null {
  if (typeof text !== 'string') return null
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return null
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

function questionText(toolInput: any): string | null {
  const q = Array.isArray(toolInput?.questions) ? toolInput.questions[0]?.question : toolInput?.question
  return clip(q)
}

function nextState(p: Record<string, any>): { status: LiveStatus; message?: string | null; pendingTool?: string | null } | null {
  switch (p.hook_event_name) {
    case 'SessionStart':
      return { status: 'idle', message: null }
    case 'UserPromptSubmit':
      return { status: 'working', message: null }
    case 'PreToolUse':
      return p.tool_name === 'AskUserQuestion' ? { status: 'asking', message: questionText(p.tool_input), pendingTool: 'AskUserQuestion' } : null
    case 'PostToolUse':
      return { status: 'working' }
    case 'PermissionRequest':
      return { status: 'needs_approval', message: clip(p.tool_name ? `Wants to use ${p.tool_name}` : p.message), pendingTool: typeof p.tool_name === 'string' ? p.tool_name : null }
    case 'Notification':
      if (p.notification_type === 'permission_prompt') return { status: 'needs_approval', message: clip(p.message) }
      if (p.notification_type === 'idle_prompt') return { status: 'waiting' }
      return null
    case 'Stop':
      return { status: 'finished', message: clip(p.last_assistant_message) }
    case 'SessionEnd':
      return { status: 'ended' }
    default:
      return null
  }
}

/** Apply one hook event in place. Older-than-current events are ignored. */
export function applyEvent(map: StatusMap, ev: HookEvent): ApplyResult {
  const p = ev.payload
  const sessionId = typeof p?.session_id === 'string' ? p.session_id : null
  if (!sessionId) return { changed: null, notify: null }
  const next = nextState(p)
  if (!next) return { changed: null, notify: null }

  const prev = map[sessionId]
  if (prev && ev.time < prev.updatedAt) return { changed: null, notify: null }
  // idle_prompt only re-confirms a finished session; keep the more useful 'finished'
  if (next.status === 'waiting' && prev?.status === 'finished') return { changed: null, notify: null }
  // Hooks run async/in parallel: a PostToolUse from another tool must not clear an open prompt
  if (p.hook_event_name === 'PostToolUse' && prev && (prev.status === 'needs_approval' || prev.status === 'asking')
    && prev.pendingTool && p.tool_name !== prev.pendingTool) {
    return { changed: null, notify: null }
  }

  const entry: SessionStatus = {
    sessionId,
    status: next.status,
    cwd: typeof p.cwd === 'string' ? p.cwd : prev?.cwd ?? null,
    transcriptPath: typeof p.transcript_path === 'string' ? p.transcript_path : prev?.transcriptPath ?? null,
    message: next.message !== undefined ? next.message : prev?.message ?? null,
    updatedAt: ev.time,
    pid: ev.pid ?? prev?.pid ?? null,
    pendingTool: next.status === 'needs_approval' || next.status === 'asking'
      ? (next.pendingTool !== undefined ? next.pendingTool : prev?.pendingTool ?? null)
      : null,
  }
  map[sessionId] = entry

  const statusChanged = prev?.status !== entry.status
  let notify: NotifyKind | null = null
  if (statusChanged && (entry.status === 'finished' || entry.status === 'needs_approval' || entry.status === 'asking')) {
    notify = entry.status
  }
  return { changed: entry, notify }
}

const DAY = 24 * 60 * 60 * 1000

/** Drop ended sessions after a day and anything silent for a week. */
export function prune(map: StatusMap, now: number): void {
  for (const [id, s] of Object.entries(map)) {
    const age = now - s.updatedAt
    if ((s.status === 'ended' && age > DAY) || age > 7 * DAY) delete map[id]
  }
}

/** Mark sessions whose Claude process has exited as ended. Returns ids that changed. */
export function markDead(map: StatusMap, isAlive: (pid: number) => boolean, now: number): string[] {
  const changed: string[] = []
  for (const s of Object.values(map)) {
    if (s.status === 'ended' || s.pid == null) continue
    if (!isAlive(s.pid)) {
      s.status = 'ended'
      s.updatedAt = Math.max(s.updatedAt, now)
      changed.push(s.sessionId)
    }
  }
  return changed
}

export function attentionCount(map: StatusMap): number {
  return Object.values(map).filter(needsUser).length
}
