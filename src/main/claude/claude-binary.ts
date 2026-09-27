// Where the `claude` CLI lives, and the env to run it with. Same lookup order as
// RunManager, shared so every spawner (headless runs, pty runs, Remote Control) agrees.
import { execSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { getCliEnv, lastPathLine } from '../cli-env'

let cached: string | null = null

export function findClaudeBinary(): string {
  if (cached) return cached
  const candidates = ['/usr/local/bin/claude', '/opt/homebrew/bin/claude', join(homedir(), '.npm-global/bin/claude')]
  for (const c of candidates) {
    try {
      execSync(`test -x "${c}"`, { stdio: 'ignore' })
      return (cached = c)
    } catch {}
  }
  for (const cmd of ['/bin/zsh -ilc "whence -p claude"', '/bin/bash -lc "which claude"']) {
    try {
      const found = lastPathLine(execSync(cmd, { encoding: 'utf-8', env: getCliEnv() }))
      if (found) return (cached = found)
    } catch {}
  }
  return (cached = 'claude')
}

// Set by a Claude Code session in its own child processes. If Clui itself was started from
// inside one (e.g. a dev build launched from a Claude Code shell), the CLI would treat our
// sessions as nested: it then runs the conversation without writing the local transcript.
const NESTED_SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH']

/** CLI env with the binary's directory on PATH (the CLI re-execs itself by name) */
export function cliEnvWithBinary(binary: string): NodeJS.ProcessEnv {
  const env = getCliEnv()
  for (const k of NESTED_SESSION_VARS) delete env[k]
  const binDir = binary.substring(0, binary.lastIndexOf('/'))
  if (binDir && env.PATH && !env.PATH.includes(binDir)) env.PATH = `${binDir}:${env.PATH}`
  return env
}
