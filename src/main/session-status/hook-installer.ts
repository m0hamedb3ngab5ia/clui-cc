// Adds/removes Clui's status hooks in ~/.claude/settings.json without touching anything else.
import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync, chmodSync, realpathSync, statSync } from 'fs'
import { dirname } from 'path'

export const HOOK_MARKER = 'clui-status-hook'

const HOOK_EVENTS: Array<{ event: string; matcher?: string }> = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'PreToolUse', matcher: 'AskUserQuestion' },
  { event: 'PostToolUse' },
  { event: 'PermissionRequest' },
  { event: 'Notification' },
  { event: 'Stop' },
  { event: 'SessionEnd' },
]

// Writes the raw hook JSON, wrapped with the Claude process id, as one file per event.
// Always exits 0 so it can never block or fail a Claude session.
export const HOOK_SCRIPT = `#!/bin/sh
# ${HOOK_MARKER}: forwards Claude Code hook events to Clui CC. Safe to delete.
dir="$HOME/.clui/events"
mkdir -p "$dir" 2>/dev/null || exit 0
# Clui not running for a long time: don't let the backlog grow without bound
[ "$(ls -f "$dir" 2>/dev/null | wc -l)" -gt 5000 ] && exit 0
name="$(date +%s)-$$-$RANDOM"
tmp="$dir/.$name.tmp"
{ printf '{"pid":%s,"payload":' "$PPID"; cat; printf '}\\n'; } > "$tmp" 2>/dev/null && mv "$tmp" "$dir/$name.json" 2>/dev/null
exit 0
`

type Settings = Record<string, any>

function isCluiHook(h: any): boolean {
  return typeof h?.command === 'string' && h.command.includes(HOOK_MARKER)
}

export function hasCluiHooks(settings: Settings): boolean {
  const hooks = settings?.hooks
  if (!hooks || typeof hooks !== 'object') return false
  return Object.values(hooks).some((groups: any) =>
    Array.isArray(groups) && groups.some((g: any) => Array.isArray(g?.hooks) && g.hooks.some(isCluiHook)))
}

export function removeCluiHooks(settings: Settings): Settings {
  const out: Settings = { ...settings }
  if (!out.hooks || typeof out.hooks !== 'object') return out
  const hooks: Settings = {}
  for (const [event, groups] of Object.entries(out.hooks)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue }
    const kept = groups
      .map((g: any) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h: any) => !isCluiHook(h)) } : g))
      .filter((g: any) => !Array.isArray(g?.hooks) || g.hooks.length > 0)
    if (kept.length > 0) hooks[event] = kept
  }
  if (Object.keys(hooks).length > 0) out.hooks = hooks
  else delete out.hooks
  return out
}

export function addCluiHooks(settings: Settings, scriptPath: string): Settings {
  const out = removeCluiHooks(settings)
  const hooks: Settings = { ...(out.hooks || {}) }
  const command = `"${scriptPath}"`
  for (const { event, matcher } of HOOK_EVENTS) {
    const group: Settings = { hooks: [{ type: 'command', command, async: true }] }
    if (matcher) group.matcher = matcher
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), group]
  }
  out.hooks = hooks
  return out
}

function readSettings(settingsPath: string): Settings {
  if (!existsSync(settingsPath)) return {}
  const raw = readFileSync(settingsPath, 'utf-8')
  if (!raw.trim()) return {}
  const parsed = JSON.parse(raw) // throws on invalid JSON: never overwrite a file we can't read
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings.json is not a JSON object')
  return parsed
}

function writeSettings(settingsPath: string, settings: Settings): void {
  mkdirSync(dirname(settingsPath), { recursive: true })
  // Write through symlinks (dotfile managers) and keep the file's mode
  const target = existsSync(settingsPath) ? realpathSync(settingsPath) : settingsPath
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o644
  // Keep the first backup: it's the pre-Clui original
  const backup = `${settingsPath}.clui-bak`
  if (existsSync(target) && !existsSync(backup)) copyFileSync(target, backup)
  const tmp = `${target}.clui-tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode })
  chmodSync(tmp, mode)
  renameSync(tmp, target)
}

export function isTrackingInstalled(settingsPath: string): boolean {
  try { return hasCluiHooks(readSettings(settingsPath)) } catch { return false }
}

export function installTracking(settingsPath: string, scriptPath: string): void {
  const settings = readSettings(settingsPath)
  mkdirSync(dirname(scriptPath), { recursive: true })
  writeFileSync(scriptPath, HOOK_SCRIPT)
  chmodSync(scriptPath, 0o755)
  writeSettings(settingsPath, addCluiHooks(settings, scriptPath))
}

export function uninstallTracking(settingsPath: string): void {
  const settings = readSettings(settingsPath)
  if (!hasCluiHooks(settings)) return
  writeSettings(settingsPath, removeCluiHooks(settings))
}
