// Slash command list: Clui's local commands + whatever the installed CLI reports in its init event.
// Loaded by node's type stripping in tests: no enums, no parameter properties.

export interface SlashCommand {
  command: string
  description: string
  /** Handled inside Clui instead of being sent to Claude */
  local?: boolean
  icon?: 'skill'
  /** Other names the menu should match, e.g. /rc for /remote-control */
  aliases?: string[]
}

export const LOCAL_COMMANDS: SlashCommand[] = [
  { command: '/clear', description: 'Clear the conversation', local: true },
  { command: '/cost', description: 'Show token usage and cost', local: true },
  { command: '/model', description: 'Show or switch model', local: true },
  { command: '/effort', description: 'Set effort: low, medium, high, xhigh, max', local: true },
  { command: '/plan', description: 'Switch this chat to Plan mode', local: true },
  { command: '/auto', description: 'Switch this chat to Auto mode', local: true },
  { command: '/manual', description: 'Switch this chat to Manual mode', local: true },
  { command: '/rename', description: 'Rename this chat', local: true },
  { command: '/remote-control', description: 'Continue this chat from your phone or claude.ai/code', local: true, aliases: ['/rc'] },
  { command: '/mcp', description: 'Show MCP server status', local: true },
  { command: '/skills', description: 'Show available skills', local: true },
  { command: '/help', description: 'Show commands and shortcuts', local: true },
]

// Descriptions for common CLI built-ins; anything else falls back to frontmatter or a generic label
export const KNOWN_DESCRIPTIONS: Record<string, string> = {
  compact: 'Summarize the conversation to free up context',
  context: 'Show what is using the context window',
  init: 'Create a CLAUDE.md for this project',
  review: 'Review a pull request',
  'security-review': 'Security review of pending changes',
  usage: 'Show plan usage limits',
  recap: 'Summarize this session',
  insights: 'Report on your Claude Code sessions',
  agents: 'Manage subagents',
  'output-style': 'Set the output style',
  config: 'Open config',
  fast: 'Toggle fast mode',
  goal: 'Set a goal for this session',
  'list-agents': 'List running agents',
  autocompact: 'Configure auto-compact',
  memory: 'Edit memory files',
}

const LOCAL_NAMES = new Set(LOCAL_COMMANDS.map((c) => c.command.slice(1)))
// CLI commands Clui can't meaningfully run headless, or that it replaces with its own UI
const HIDDEN = new Set(['heapdump', 'color', 'focus', 'doctor', 'reload-plugins', 'import', 'design-consent', 'design-revoke'])

/** Whole input is a slash-command prefix, e.g. "/", "/comp", "/anthropic-skills:pdf" */
export const SLASH_QUERY_RE = /^\/[\w:.-]*$/

export interface SlashToken {
  /** Index of the "/" */
  start: number
  /** Index just past the token (the caret) */
  end: number
  /** The token itself, e.g. "/comp" */
  query: string
}

/**
 * The slash-command token the caret is in, anywhere in the text: a "/" at the start or
 * after whitespace, followed by command characters up to the caret. "a/b" is not one.
 */
export function slashTokenAt(text: string, caret: number): SlashToken | null {
  const end = Math.max(0, Math.min(caret, text.length))
  const before = text.slice(0, end)
  const m = before.match(/(?:^|\s)(\/[\w:.-]*)$/)
  if (!m || m[1] === undefined) return null
  // Caret inside a token (e.g. "/com|pact"): no menu, so completing can't split the word
  if (/[\w:.-]/.test(text.charAt(end))) return null
  const start = end - m[1].length
  return { start, end, query: m[1] }
}

/** Replaces the token with the command (plus a space) and returns the new text and caret */
export function replaceSlashToken(text: string, token: SlashToken, command: string): { text: string; caret: number } {
  const inserted = `${command} `
  return { text: text.slice(0, token.start) + inserted + text.slice(token.end), caret: token.start + inserted.length }
}

export function buildCommandList(opts: {
  cliCommands: string[]
  terminalOnly?: string[]
  skills?: string[]
  descriptions?: Record<string, string>
}): SlashCommand[] {
  const out: SlashCommand[] = [...LOCAL_COMMANDS]
  const seen = new Set(LOCAL_NAMES)
  const terminalOnly = new Set(opts.terminalOnly ?? [])
  const skills = new Set(opts.skills ?? [])
  const names = [...opts.cliCommands, ...(opts.skills ?? [])]
  for (const raw of names) {
    const name = raw.replace(/^\//, '').trim()
    if (!name || seen.has(name) || terminalOnly.has(name) || HIDDEN.has(name) || name.startsWith('_')) continue
    seen.add(name)
    const description = opts.descriptions?.[name] || KNOWN_DESCRIPTIONS[name] || (skills.has(name) ? 'Run skill' : 'Claude Code command')
    out.push({ command: `/${name}`, description, ...(skills.has(name) ? { icon: 'skill' as const } : {}) })
  }
  return out
}

export function filterCommands(list: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase()
  const names = (c: SlashCommand) => [c.command, ...(c.aliases ?? [])].map((n) => n.toLowerCase())
  const starts = list.filter((c) => names(c).some((n) => n.startsWith(q)))
  if (q.length < 2) return starts
  // Also match inside names (e.g. "/pdf" finds "/anthropic-skills:pdf"), ranked after prefix hits
  const inner = list.filter((c) => !starts.includes(c) && names(c).some((n) => n.includes(q.slice(1))))
  return [...starts, ...inner]
}

/** `description:` from a markdown file's YAML frontmatter, or null */
export function parseFrontmatterDescription(text: string): string | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return null
  const line = m[1].split(/\r?\n/).find((l) => /^description\s*:/.test(l))
  if (!line) return null
  let v = line.replace(/^description\s*:\s*/, '').trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  if (!v || v === '|' || v === '>') return null
  return v.length > 120 ? `${v.slice(0, 117)}...` : v
}
