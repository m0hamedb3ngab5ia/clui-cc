// Short AI titles for Clui sessions. The CLI only writes `ai-title` records for interactive
// sessions, never for SDK/stream-json runs like ours, so we ask a small model ourselves.
// Kept free of electron imports so it can be unit-tested with plain node.

const MAX_WORDS = 10
const MAX_CHARS = 60
const MAX_INPUT_CHARS = 1000

const SYSTEM_PROMPT = 'You name chat sessions. Reply with the title only.'

export function titleArgs(firstMessage: string): string[] {
  const prompt =
    'Write a 3-6 word title (Title Case, no quotes, no trailing punctuation) summarizing this request.\n\n' +
    `Request:\n${firstMessage.slice(0, MAX_INPUT_CHARS)}`
  return [
    '-p', prompt,
    '--model', 'haiku',
    '--output-format', 'json',
    '--system-prompt', SYSTEM_PROMPT,
    '--no-session-persistence',
    // No user hooks, MCP servers, skills or tools: a bare one-shot
    '--setting-sources', '',
    '--strict-mcp-config',
    '--tools', '',
    '--disable-slash-commands',
  ]
}

/** Normalize model output to a single short title, or null if it isn't one */
export function cleanTitle(raw: string): string | null {
  const line = String(raw ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const title = line
    .replace(/^title\s*:\s*/i, '')
    .replace(/[*_`#]/g, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[.!?:;,]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!title || title.length > MAX_CHARS || title.split(' ').length > MAX_WORDS) return null
  return title
}

/** Run the CLI (via `exec`, which gets the args and returns stdout) and return a clean title, or null */
export async function generateTitle(firstMessage: string, exec: (args: string[]) => Promise<string>): Promise<string | null> {
  if (!firstMessage.trim()) return null
  try {
    const out = JSON.parse(await exec(titleArgs(firstMessage)))
    if (out?.is_error || typeof out?.result !== 'string') return null
    return cleanTitle(out.result)
  } catch {
    return null
  }
}
