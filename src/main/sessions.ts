import { join } from 'path'
import { existsSync, readdirSync, statSync, createReadStream } from 'fs'
import { createInterface } from 'readline'

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
          if (typeof content === 'string') {
            meta.firstMessage = content.substring(0, 100)
          } else if (Array.isArray(content)) {
            const textPart = content.find((p: any) => p.type === 'text')
            meta.firstMessage = textPart?.text?.substring(0, 100) || null
          }
          if (meta.firstMessage?.trimStart().startsWith('<')) meta.firstMessage = null
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
