// Claude Code permission modes, in the order Shift+Tab cycles them in the terminal.
// Loaded by node's type stripping in tests: no enums, no parameter properties.

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto'

export const PERMISSION_MODES: ReadonlyArray<{ id: PermissionMode; label: string; hint: string }> = [
  { id: 'default', label: 'Manual', hint: 'Ask before edits and commands' },
  { id: 'acceptEdits', label: 'Accept edits', hint: 'Edit files without asking, ask for commands' },
  { id: 'plan', label: 'Plan', hint: 'Read and plan only, no changes' },
  { id: 'auto', label: 'Auto', hint: "Claude Code's classifier approves safe actions" },
]

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'default'

export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === 'string' && PERMISSION_MODES.some((m) => m.id === v)
}

export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  const i = PERMISSION_MODES.findIndex((m) => m.id === mode)
  return PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length].id
}

export function permissionModeLabel(mode: PermissionMode): string {
  return PERMISSION_MODES.find((m) => m.id === mode)?.label ?? 'Manual'
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * What Clui's PreToolUse hook does for a tool call, given the mode the CLI reports
 * in the hook payload (so a mid-run Shift+Tab is honoured immediately).
 * 'prompt' = show Clui's permission card; 'defer' = return no decision and let
 * Claude Code apply its own mode (plan blocks changes, auto runs its classifier).
 */
export function hookPolicy(mode: string | undefined, toolName: string): 'prompt' | 'defer' {
  switch (mode) {
    case 'plan':
    case 'auto':
    case 'bypassPermissions':
      return 'defer'
    case 'acceptEdits':
      return EDIT_TOOLS.has(toolName) ? 'defer' : 'prompt'
    default:
      return 'prompt'
  }
}

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v)
}
