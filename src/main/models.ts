// Model list discovered from the installed Claude Code CLI, so new models appear
// without editing Clui. `claude -p "/model"` is a local command: no API call, no tokens.
import { execFile } from 'child_process'
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export interface ModelOption {
  /** Value passed to `claude --model` (an alias like "opus" or "opus[1m]") */
  id: string
  /** Resolved name, e.g. "Opus 5.5 (1M context)" */
  label: string
}

export interface ModelCache {
  cliVersion: string
  fetchedAt: number
  /** What `claude` uses with no --model flag */
  defaultLabel: string | null
  models: ModelOption[]
  /** `model` from the user's Claude settings when this was discovered; a change invalidates the cache */
  settingsModel?: string | null
}

// Aliases that aren't a distinct model to pick from a menu
const SKIP_ALIASES = new Set(['default'])

/** "Usage: /model <name>. Available: sonnet, opus, fable[1m], or a full model ID." → aliases */
export function parseAvailableAliases(result: string): string[] {
  const m = result.match(/Available:\s*([^\n]*)/i)
  if (!m) return []
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/\.$/, ''))
    .filter((s) => /^[a-z][a-z0-9-]*(\[[a-z0-9]+\])?$/i.test(s) && !SKIP_ALIASES.has(s))
}

/** "Current model: `Opus 5.5 (1M context)` (effort: medium)" → "Opus 5.5 (1M context)" */
export function parseCurrentModel(result: string): string | null {
  const m = result.match(/Current model:\s*`([^`]+)`/i)
  return m ? m[1].trim() : null
}

/** Drop aliases that resolve to the same model as an earlier one (e.g. "best" = "fable"). */
export function dedupeByLabel(models: ModelOption[]): ModelOption[] {
  const seen = new Set<string>()
  return models.filter((m) => {
    if (seen.has(m.label)) return false
    seen.add(m.label)
    return true
  })
}

/** The CLI may label "sonnet[1m]" just "Sonnet 5"; keep it distinguishable from "sonnet". */
export function withContextHint(id: string, label: string): string {
  return /\[1m\]$/i.test(id) && !/1M/i.test(label) ? `${label} (1M context)` : label
}

// Each probe spawns a claude process; don't start them all at once
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

type Exec = (args: string[]) => Promise<string>

function makeExec(env: NodeJS.ProcessEnv, binary = 'claude'): Exec {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(binary, args, { env, cwd: tmpdir(), timeout: 30000, encoding: 'utf-8' }, (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout)
      })
    })
}

async function slashModel(exec: Exec, model?: string): Promise<string> {
  const args = ['-p', '/model', '--output-format', 'json', '--no-session-persistence']
  if (model) args.push('--model', model)
  const out = JSON.parse(await exec(args))
  return typeof out?.result === 'string' ? out.result : ''
}

/** The `model` the user set in ~/.claude/settings.json (local overrides user), or null */
export function readSettingsModel(claudeHome: string): string | null {
  let out: string | null = null
  for (const name of ['settings.json', 'settings.local.json']) {
    try {
      const v = JSON.parse(readFileSync(join(claudeHome, name), 'utf-8'))?.model
      if (typeof v === 'string' && v.trim()) out = v.trim()
    } catch {}
  }
  return out
}

export async function discoverModels(env: NodeJS.ProcessEnv, exec: Exec | undefined, settingsModel: string | null = null, binary = 'claude'): Promise<ModelCache> {
  exec ??= makeExec(env, binary)
  const cliVersion = (await exec(['--version'])).trim()
  const base = await slashModel(exec)
  const aliases = parseAvailableAliases(base)
  const resolved = await mapLimit(aliases, 3, async (id) => {
    try {
      const label = parseCurrentModel(await slashModel(exec, id))
      return label ? { id, label: withContextHint(id, label) } : null
    } catch {
      return null
    }
  })
  return {
    cliVersion,
    fetchedAt: Date.now(),
    defaultLabel: parseCurrentModel(base),
    models: dedupeByLabel(resolved.filter((m): m is ModelOption => !!m)),
    settingsModel,
  }
}

// Short: the probes are local and cheap, and the default label must follow settings changes
const TTL = 60 * 60 * 1000

export function isCacheFresh(cache: ModelCache | null, cliVersion: string, now: number, settingsModel: string | null = null): boolean {
  return !!cache && cache.models.length > 0 && cache.cliVersion === cliVersion && now - cache.fetchedAt < TTL
    && (cache.settingsModel ?? null) === settingsModel
}
