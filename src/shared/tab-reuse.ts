// Which tab should a session from history open in?
// Loaded by node's type stripping in tests.

export interface TabLike {
  id: string
  claudeSessionId: string | null
  /** The history session this tab was opened from (claudeSessionId can move on after a resume) */
  resumedFrom?: string | null
  status: string
  activeRequestId: string | null
  messages: unknown[]
  attachments: unknown[]
  queuedPrompts: string[]
  titleLocked?: boolean
}

/** The tab already showing this session, if any */
export function findSessionTab<T extends TabLike>(tabs: T[], sessionId: string): T | undefined {
  return tabs.find((t) => t.claudeSessionId === sessionId || t.resumedFrom === sessionId)
}

/** An untouched "New Tab": nothing sent, typed, attached or running */
export function isBlankTab(t: TabLike, draft = ''): boolean {
  return !draft.trim()
    && !t.claudeSessionId
    && !t.resumedFrom
    && t.status === 'idle'
    && !t.activeRequestId
    && t.messages.length === 0
    && t.attachments.length === 0
    && t.queuedPrompts.length === 0
    && !t.titleLocked
}

/** Opening a session may take over only the untouched tab the app launched with, never a New Tab the user made */
export function canReplaceTab(t: TabLike, launchTabId: string | null, draft = ''): boolean {
  return t.id === launchTabId && isBlankTab(t, draft)
}
