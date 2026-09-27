import { execSync } from 'child_process'

let cachedPath: string | null = null

/**
 * Interactive shells can print extra lines before the command's own output
 * (e.g. Terminal.app's "Restored session: …" when TERM_SESSION_ID is inherited).
 * Keep only the last line that looks like an absolute path (or PATH list).
 */
export function lastPathLine(output: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('/'))
  return lines[lines.length - 1] || ''
}

function appendPathEntries(target: string[], seen: Set<string>, rawPath: string | undefined): void {
  if (!rawPath) return
  for (const entry of rawPath.split(':')) {
    const p = entry.trim()
    if (!p || seen.has(p)) continue
    seen.add(p)
    target.push(p)
  }
}

export function getCliPath(): string {
  if (cachedPath) return cachedPath

  const ordered: string[] = []
  const seen = new Set<string>()

  // Start from current process PATH.
  appendPathEntries(ordered, seen, process.env.PATH)

  // Add common binary locations used on macOS (Homebrew + system).
  appendPathEntries(ordered, seen, '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')

  // Try interactive login shell first so nvm/asdf/etc. PATH hooks are loaded.
  const pathCommands = [
    '/bin/zsh -ilc "echo $PATH"',
    '/bin/zsh -lc "echo $PATH"',
    '/bin/bash -lc "echo $PATH"',
  ]

  for (const cmd of pathCommands) {
    try {
      const discovered = lastPathLine(execSync(cmd, { encoding: 'utf-8', timeout: 3000 }))
      appendPathEntries(ordered, seen, discovered)
    } catch {
      // Keep trying fallbacks.
    }
  }

  cachedPath = ordered.join(':')
  return cachedPath
}

export function getCliEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnv,
    PATH: getCliPath(),
  }
  delete env.CLAUDECODE
  return env
}

