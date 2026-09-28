// Tabs open when Clui last ran, reopened on the next launch (survives quit and force quit).
// Loaded by node's type stripping in tests.

export interface OpenTabLike {
  id: string
  claudeSessionId: string | null
  title: string
  titleLocked?: boolean
  workingDirectory: string
  hasChosenDirectory: boolean
  additionalDirs: string[]
  permissionMode: string
  effort: string | null
}

export interface SavedTab {
  sessionId: string
  title: string
  titleLocked: boolean
  /** null = the tab used the default (home) directory */
  projectPath: string | null
  additionalDirs: string[]
  permissionMode: string | null
  effort: string | null
}

export interface OpenTabsSnapshot {
  tabs: SavedTab[]
  activeSessionId: string | null
}

/** Tabs worth reopening: only ones with a Claude session (blank tabs have nothing to restore) */
export function snapshotOpenTabs(tabs: OpenTabLike[], activeTabId: string): OpenTabsSnapshot {
  const saved = tabs.filter((t) => t.claudeSessionId).map((t) => ({
    sessionId: t.claudeSessionId!,
    title: t.title,
    titleLocked: !!t.titleLocked,
    projectPath: t.hasChosenDirectory ? t.workingDirectory : null,
    additionalDirs: [...t.additionalDirs],
    permissionMode: t.permissionMode,
    effort: t.effort,
  }))
  const active = tabs.find((t) => t.id === activeTabId)
  return { tabs: saved, activeSessionId: active?.claudeSessionId || null }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** Reads a saved snapshot defensively: bad entries and duplicate sessions are dropped */
export function parseOpenTabs(raw: unknown): OpenTabsSnapshot {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const seen = new Set<string>()
  const tabs: SavedTab[] = []
  for (const e of Array.isArray(o.tabs) ? o.tabs : []) {
    const t = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
    const sessionId = str(t.sessionId)
    if (!sessionId || seen.has(sessionId)) continue
    seen.add(sessionId)
    tabs.push({
      sessionId,
      title: typeof t.title === 'string' ? t.title : '',
      titleLocked: t.titleLocked === true,
      projectPath: str(t.projectPath),
      additionalDirs: Array.isArray(t.additionalDirs) ? t.additionalDirs.filter((d): d is string => !!str(d)) : [],
      permissionMode: str(t.permissionMode),
      effort: str(t.effort),
    })
  }
  const active = str(o.activeSessionId)
  return { tabs, activeSessionId: active && seen.has(active) ? active : null }
}
