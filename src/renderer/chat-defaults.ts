// Global defaults for new chats, and the mode each resumed session last used (localStorage).
import { DEFAULT_PERMISSION_MODE, isEffortLevel, isPermissionMode, type EffortLevel, type PermissionMode } from '../shared/permission-modes'

const DEFAULTS_KEY = 'clui.chatDefaults'
const SESSION_MODES_KEY = 'clui.sessionModes'
const MAX_SESSION_MODES = 300

export interface ChatDefaults {
  permissionMode: PermissionMode
  effort: EffortLevel | null
}

export function loadChatDefaults(): ChatDefaults {
  try {
    const raw = JSON.parse(localStorage.getItem(DEFAULTS_KEY) || '{}')
    return {
      permissionMode: isPermissionMode(raw.permissionMode) ? raw.permissionMode : DEFAULT_PERMISSION_MODE,
      effort: isEffortLevel(raw.effort) ? raw.effort : null,
    }
  } catch {
    return { permissionMode: DEFAULT_PERMISSION_MODE, effort: null }
  }
}

export function saveChatDefaults(d: ChatDefaults): void {
  try { localStorage.setItem(DEFAULTS_KEY, JSON.stringify(d)) } catch {}
}

function loadSessionModes(): Record<string, PermissionMode> {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_MODES_KEY) || '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export function sessionModeFor(sessionId: string | null | undefined): PermissionMode | null {
  if (!sessionId) return null
  const m = loadSessionModes()[sessionId]
  return isPermissionMode(m) ? m : null
}

export function rememberSessionMode(sessionId: string | null | undefined, mode: PermissionMode): void {
  if (!sessionId) return
  try {
    const all = loadSessionModes()
    delete all[sessionId]
    all[sessionId] = mode
    const keys = Object.keys(all)
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SESSION_MODES))) delete all[k]
    localStorage.setItem(SESSION_MODES_KEY, JSON.stringify(all))
  } catch {}
}
