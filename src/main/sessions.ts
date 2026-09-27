import { join } from 'path'
import { existsSync, readdirSync, statSync, createReadStream, appendFileSync, openSync, readSync, closeSync, readFileSync } from 'fs'
import { createInterface } from 'readline'
import { parseFrontmatterDescription } from '../shared/slash-commands'
import { isHarnessText } from '../shared/harness-notices'

// Kept free of electron imports so it can be unit-tested with plain node.

export interface ScannedSession {
  sessionId: string
  slug: string | null
  firstMessage: string | null
  lastTimestamp: string
  size: number
  projectPath: string | null
  /** /rename title if set, else Claude's auto-generated title */
  title: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isSessionId(id: string): boolean {
  return UUID_RE.test(id)
}

// Claude Code names project dirs by replacing every non-alphanumeric char with '-'
// (so '/', '.', '_', spaces and unicode all become '-').
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-')
}

export function isValidProjectPath(p: string): boolean {
  return !/[\0\r\n]/.test(p) && p.startsWith('/')
}

interface Candidate { sessionId: string; filePath: string; size: number; mtime: Date }

function listCandidates(dir: string): Candidate[] {
  if (!existsSync(dir)) return []
  const out: Candidate[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue
    const sessionId = file.slice(0, -'.jsonl'.length)
    if (!isSessionId(sessionId)) continue
    const filePath = join(dir, file)
    try {
      const stat = statSync(filePath)
      if (!stat.isFile() || stat.size < 100) continue
      out.push({ sessionId, filePath, size: stat.size, mtime: stat.mtime })
    } catch {}
  }
  return out
}

async function scanFile(c: Candidate): Promise<ScannedSession | null> {
  const meta = {
    validated: false,
    slug: null as string | null,
    firstMessage: null as string | null,
    lastTimestamp: null as string | null,
    projectPath: null as string | null,
    customTitle: null as string | null,
    aiTitle: null as string | null,
  }
  await new Promise<void>((resolve) => {
    const input = createReadStream(c.filePath)
    const rl = createInterface({ input })
    rl.on('line', (line: string) => {
      try {
        const obj = JSON.parse(line)
        if (!meta.validated && obj.type && obj.uuid && obj.timestamp) meta.validated = true
        if (obj.slug && !meta.slug) meta.slug = obj.slug
        // Title records can repeat; the latest one wins
        if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') meta.customTitle = obj.customTitle
        if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') meta.aiTitle = obj.aiTitle
        if (typeof obj.cwd === 'string' && !meta.projectPath) meta.projectPath = obj.cwd
        if (obj.timestamp) meta.lastTimestamp = obj.timestamp
        // Skip meta entries and harness wrappers like <local-command-caveat>; they aren't what the user typed
        if (obj.type === 'user' && !meta.firstMessage && !obj.isMeta) {
          const content = obj.message?.content
          const text: string | null = typeof content === 'string'
            ? content
            : Array.isArray(content) ? (content.find((p: any) => p.type === 'text')?.text ?? null) : null
          // Task notifications and subagent reports aren't a title either
          meta.firstMessage = text && !isHarnessText(text) && !text.trimStart().startsWith('<') ? text.substring(0, 100) : null
        }
      } catch {}
    })
    rl.on('close', () => resolve())
    input.on('error', () => resolve())
  })
  if (!meta.validated) return null
  return {
    sessionId: c.sessionId,
    slug: meta.slug,
    firstMessage: meta.firstMessage,
    lastTimestamp: meta.lastTimestamp || c.mtime.toISOString(),
    size: c.size,
    projectPath: meta.projectPath,
    title: meta.customTitle?.trim() || meta.aiTitle?.trim() || null,
  }
}

async function scanNewest(candidates: Candidate[], limit: number): Promise<ScannedSession[]> {
  // Pre-sort by mtime so only the newest files get parsed (full-history scans are expensive).
  candidates.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
  const sessions: ScannedSession[] = []
  for (const c of candidates) {
    if (sessions.length >= limit) break
    const s = await scanFile(c)
    if (s) sessions.push(s)
  }
  sessions.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime())
  return sessions
}

export async function listProjectSessions(projectsRoot: string, projectPath: string, limit = 20): Promise<ScannedSession[]> {
  if (!isValidProjectPath(projectPath)) return []
  const dir = join(projectsRoot, encodeProjectPath(projectPath))
  return scanNewest(listCandidates(dir), limit)
}

export async function listAllSessions(projectsRoot: string, limit = 100): Promise<ScannedSession[]> {
  if (!existsSync(projectsRoot)) return []
  const candidates: Candidate[] = []
  for (const entry of readdirSync(projectsRoot)) {
    const dir = join(projectsRoot, entry)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch { continue }
    candidates.push(...listCandidates(dir))
  }
  return scanNewest(candidates, limit)
}

// Locate a session transcript. Tries the project's dir first, then every project dir,
// so sessions resolve even when the caller's path doesn't match Claude's dir name.
export function findSessionFile(projectsRoot: string, sessionId: string, projectPath?: string): string | null {
  if (!isSessionId(sessionId)) return null
  const file = `${sessionId}.jsonl`
  if (projectPath && isValidProjectPath(projectPath)) {
    const direct = join(projectsRoot, encodeProjectPath(projectPath), file)
    if (existsSync(direct)) return direct
  }
  if (!existsSync(projectsRoot)) return null
  for (const entry of readdirSync(projectsRoot)) {
    const p = join(projectsRoot, entry, file)
    if (existsSync(p)) return p
  }
  return null
}

export async function scanSessionById(projectsRoot: string, sessionId: string, projectPath?: string): Promise<ScannedSession | null> {
  const filePath = findSessionFile(projectsRoot, sessionId, projectPath)
  if (!filePath) return null
  try {
    const stat = statSync(filePath)
    return await scanFile({ sessionId, filePath, size: stat.size, mtime: stat.mtime })
  } catch {
    return null
  }
}

export async function readSessionTitle(projectsRoot: string, sessionId: string, projectPath?: string): Promise<string | null> {
  return (await scanSessionById(projectsRoot, sessionId, projectPath))?.title ?? null
}

export const MAX_TITLE_LENGTH = 200

/**
 * Rename a session the way `/rename` does: append a custom-title record to its transcript.
 * Appending (O_APPEND) is safe while a terminal session is writing the same file.
 * Returns the stored title.
 */
export function renameSession(projectsRoot: string, sessionId: string, title: string, projectPath?: string): string {
  if (!isSessionId(sessionId)) throw new Error('Invalid session id')
  const clean = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH)
  if (!clean) throw new Error('Title is empty')
  const file = findSessionFile(projectsRoot, sessionId, projectPath)
  if (!file) throw new Error('Session transcript not found')
  const record = JSON.stringify({ type: 'custom-title', customTitle: clean, sessionId })
  appendFileSync(file, (endsWithNewline(file) ? '' : '\n') + record + '\n')
  return clean
}

function endsWithNewline(file: string): boolean {
  const size = statSync(file).size
  if (size === 0) return true
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(1)
    readSync(fd, buf, 0, 1, size - 1)
    return buf[0] === 0x0a
  } finally {
    closeSync(fd)
  }
}

/** Descriptions from the frontmatter of user/project commands and skills, keyed by command name */
export function readCommandDescriptions(claudeHome: string, cwd?: string): Record<string, string> {
  const out: Record<string, string> = {}
  const readDesc = (file: string) => {
    try { return parseFrontmatterDescription(readFileSync(file, 'utf-8').slice(0, 4096)) } catch { return null }
  }
  const commandDirs = [join(claudeHome, 'commands')]
  if (cwd && isValidProjectPath(cwd)) commandDirs.unshift(join(cwd, '.claude', 'commands'))
  for (const dir of commandDirs) {
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { continue }
    for (const f of entries) {
      if (!f.endsWith('.md')) continue
      const name = f.slice(0, -3)
      if (out[name]) continue
      const d = readDesc(join(dir, f))
      if (d) out[name] = d
    }
  }
  const skillDirs = [join(claudeHome, 'skills')]
  if (cwd && isValidProjectPath(cwd)) skillDirs.unshift(join(cwd, '.claude', 'skills'))
  for (const dir of skillDirs) {
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { continue }
    for (const name of entries) {
      if (out[name]) continue
      const d = readDesc(join(dir, name, 'SKILL.md'))
      if (d) out[name] = d
    }
  }
  return out
}

/**
 * Context size at the end of a transcript: the last main-thread assistant turn's
 * input + cache tokens (same formula as the terminal). Reads only the file's tail.
 */
export function readLastContext(projectsRoot: string, sessionId: string, projectPath?: string): { tokens: number; model: string | null } | null {
  if (!isSessionId(sessionId)) return null
  const file = findSessionFile(projectsRoot, sessionId, projectPath)
  if (!file) return null
  const size = statSync(file).size
  const len = Math.min(size, 1024 * 1024)
  const buf = Buffer.alloc(len)
  const fd = openSync(file, 'r')
  try { readSync(fd, buf, 0, len, size - len) } finally { closeSync(fd) }
  const lines = buf.toString('utf-8').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"usage"')) continue
    try {
      const o = JSON.parse(line)
      if (o.type !== 'assistant' || o.isSidechain) continue
      const u = o.message?.usage
      if (!u) continue
      const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      if (tokens > 0) return { tokens, model: typeof o.message?.model === 'string' ? o.message.model : null }
    } catch {}
  }
  return null
}
