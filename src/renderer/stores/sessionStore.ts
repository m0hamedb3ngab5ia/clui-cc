import { create } from 'zustand'
import type { TabStatus, NormalizedEvent, EnrichedError, Message, TabState, Attachment, CatalogPlugin, PluginStatus, LiveSessionStatus, ModelOption, RemoteControlEvent, SessionLoadMessage } from '../../shared/types'
import { useThemeStore } from '../theme'
import notificationSrc from '../../../resources/notification.mp3'
import { loadChatDefaults, saveChatDefaults, sessionModeFor, rememberSessionMode } from '../chat-defaults'
import { nextPermissionMode, permissionModeLabel, isPermissionMode, isEffortLevel, type EffortLevel, type PermissionMode } from '../../shared/permission-modes'
import { applyTaskCreated, applyTodoToolUse } from '../../shared/todos'
import { canReplaceTab, findSessionTab } from '../../shared/tab-reuse'
import { snapshotOpenTabs } from '../../shared/open-tabs'

// ─── Models ───
// The real list is discovered from the installed claude CLI (see main/models.ts).
// These aliases are only a fallback until discovery finishes or if it fails;
// the CLI resolves each one to its latest model.

export const FALLBACK_MODELS: ModelOption[] = [
  { id: 'opus', label: 'Opus (latest)' },
  { id: 'sonnet', label: 'Sonnet (latest)' },
  { id: 'haiku', label: 'Haiku (latest)' },
]

function normalizeModelId(modelId: string): string {
  // Claude sometimes appends context window hints like "[1m]" to model IDs.
  return modelId.replace(/\[[^\]]+\]/g, '').trim()
}

export function getModelDisplayLabel(modelId: string): string {
  const normalizedId = normalizeModelId(modelId)
  const has1MContext = /\[\s*1m\s*\]/i.test(modelId)

  const known = useSessionStore.getState().models.find((m) => m.id === modelId || m.id === normalizedId)
  if (known) return known.label

  // Full model IDs like claude-opus-5-5, claude-sonnet-5, claude-haiku-4-5-20251001
  const compact = normalizedId
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
  const familyMatch = compact.match(/^([a-z]+)-(\d+)(?:-(\d+))?$/i)
  if (familyMatch) {
    const family = familyMatch[1][0].toUpperCase() + familyMatch[1].slice(1).toLowerCase()
    const label = familyMatch[3] ? `${family} ${familyMatch[2]}.${familyMatch[3]}` : `${family} ${familyMatch[2]}`
    return has1MContext ? `${label} (1M)` : label
  }

  return has1MContext ? `${normalizedId} (1M)` : normalizedId
}

// ─── Store ───

interface StaticInfo {
  version: string
  email: string | null
  subscriptionType: string | null
  projectPath: string
  homePath: string
}

interface State {
  tabs: TabState[]
  activeTabId: string
  /** Global expand/collapse — user-controlled, not per-tab */
  isExpanded: boolean
  /** Unsent input text per tab, so switching tabs keeps each tab's draft */
  drafts: Record<string, string>
  setDraft: (tabId: string, value: string | ((prev: string) => string)) => void
  /** Global info fetched on startup (not per-session) */
  staticInfo: StaticInfo | null
  /** User's preferred model override (null = use default) */
  preferredModel: string | null
  /** Mode and effort new chats start with (Settings / "Set as default") */
  defaultPermissionMode: PermissionMode
  defaultEffort: EffortLevel | null
  /** Brief status-bar flash after Shift+Tab, e.g. "Plan mode" */
  modeFlash: { text: string; nonce: number } | null

  // Marketplace state
  marketplaceOpen: boolean
  marketplaceCatalog: CatalogPlugin[]
  marketplaceLoading: boolean
  marketplaceError: string | null
  marketplaceInstalledNames: string[]
  marketplacePluginStates: Record<string, PluginStatus>
  marketplaceSearch: string
  marketplaceFilter: string

  /** Live status of every Claude session (from Clui's global hooks), keyed by session id */
  sessionStatuses: Record<string, LiveSessionStatus>

  /** Models from the installed claude CLI (FALLBACK_MODELS until loaded) */
  models: ModelOption[]
  /** What claude uses with no --model, e.g. "Opus 5.5 (1M context)" */
  defaultModelLabel: string | null
  modelsLoading: boolean
  loadModels: (force?: boolean) => Promise<void>

  // Actions
  setSessionStatuses: (map: Record<string, LiveSessionStatus>) => void
  initStaticInfo: () => Promise<void>
  setPreferredModel: (model: string | null) => void
  setTabPermissionMode: (mode: PermissionMode, tabId?: string) => void
  cyclePermissionMode: () => void
  setDefaultPermissionMode: (mode: PermissionMode) => void
  setTabEffort: (effort: EffortLevel | null) => void
  setDefaultEffort: (effort: EffortLevel | null) => void
  renameTab: (tabId: string, title: string) => Promise<boolean>
  moveTab: (fromId: string, toId: string) => void
  approvePlan: (mode: PermissionMode) => void
  dismissPlan: () => void
  interruptActive: () => boolean
  createTab: () => Promise<string>
  selectTab: (tabId: string) => void
  closeTab: (tabId: string) => void
  clearTab: () => void
  toggleExpanded: () => void
  toggleMarketplace: () => void
  closeMarketplace: () => void
  loadMarketplace: (forceRefresh?: boolean) => Promise<void>
  setMarketplaceSearch: (query: string) => void
  setMarketplaceFilter: (filter: string) => void
  installMarketplacePlugin: (plugin: CatalogPlugin) => Promise<void>
  uninstallMarketplacePlugin: (plugin: CatalogPlugin) => Promise<void>
  buildYourOwn: () => void
  resumeSession: (sessionId: string, title?: string, projectPath?: string) => Promise<string>
  /** Reopen the tabs from the last run, then keep saving them on every change */
  restoreOpenTabs: () => Promise<void>
  addSystemMessage: (content: string) => void
  sendMessage: (prompt: string, projectPath?: string) => void
  /** Remote Control for the active tab: serve its session to the phone / claude.ai/code */
  startRemoteControl: (name?: string) => Promise<void>
  stopRemoteControl: () => void
  handleRemoteControlEvent: (tabId: string, event: RemoteControlEvent) => void
  handleRemoteControlMessages: (tabId: string, messages: SessionLoadMessage[]) => void
  respondPermission: (tabId: string, questionId: string, optionId: string) => void
  addDirectory: (dir: string) => void
  removeDirectory: (dir: string) => void
  setBaseDirectory: (dir: string) => void
  addAttachments: (attachments: Attachment[]) => void
  removeAttachment: (attachmentId: string) => void
  clearAttachments: () => void
  handleNormalizedEvent: (tabId: string, event: NormalizedEvent) => void
  handleStatusChange: (tabId: string, newStatus: string, oldStatus: string) => void
  handleError: (tabId: string, error: EnrichedError) => void
}

let msgCounter = 0
const nextMsgId = () => `msg-${++msgCounter}`

// ─── Notification sound (plays when task completes while window is hidden) ───
const notificationAudio = new Audio(notificationSrc)
notificationAudio.volume = 1.0

async function playNotificationIfHidden(): Promise<void> {
  if (!useThemeStore.getState().soundEnabled) return
  try {
    const visible = await window.clui.isVisible()
    if (!visible) {
      notificationAudio.currentTime = 0
      notificationAudio.play().catch(() => {})
    }
  } catch {}
}

// Replace a tab's first-prompt title with the session's real title once Claude has written one
async function refreshTabTitle(tabId: string): Promise<void> {
  const tab = useSessionStore.getState().tabs.find((t) => t.id === tabId)
  if (!tab?.claudeSessionId || tab.titleLocked) return
  try {
    const title = await window.clui.getSessionTitle(tab.claudeSessionId, tab.workingDirectory)
      // Clui's own runs never get a CLI ai-title, so generate one
      || await window.clui.autoTitleSession(tab.claudeSessionId, tab.workingDirectory)
    if (!title) return
    useSessionStore.setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId && !t.titleLocked && t.title !== title ? { ...t, title } : t)),
    }))
  } catch {}
}

function makeLocalTab(): TabState {
  return {
    id: crypto.randomUUID(),
    claudeSessionId: null,
    status: 'idle',
    activeRequestId: null,
    hasUnread: false,
    currentActivity: '',
    permissionQueue: [],
    permissionDenied: null,
    attachments: [],
    messages: [],
    title: 'New Tab',
    lastResult: null,
    sessionModel: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: null,
    sessionSlashCommands: [],
    sessionTerminalCommands: [],
    permissionMode: loadChatDefaults().permissionMode,
    effort: loadChatDefaults().effort,
    contextTokens: 0,
    contextWindow: null,
    totalCostUsd: 0,
    todos: [],
    planReady: false,
    titleLocked: false,
    pendingTitle: null,
    queuedPrompts: [],
    remoteControl: { state: 'off', url: null, name: null },
    workingDirectory: '~',
    hasChosenDirectory: false,
    additionalDirs: [],
  }
}

const initialTab = makeLocalTab()
/** Only this launch tab may be replaced by an opened session */
const launchTabId = initialTab.id

export const useSessionStore = create<State>((set, get) => ({
  tabs: [initialTab],
  activeTabId: initialTab.id,
  isExpanded: true, // launch with panel open; expandedUI (full width) still forced off
  drafts: {},
  setDraft: (tabId, value) => set((s) => {
    const next = typeof value === 'function' ? value(s.drafts[tabId] ?? '') : value
    if ((s.drafts[tabId] ?? '') === next) return s
    const drafts = { ...s.drafts }
    if (next) drafts[tabId] = next
    else delete drafts[tabId]
    return { drafts }
  }),
  staticInfo: null,
  preferredModel: null,
  defaultPermissionMode: loadChatDefaults().permissionMode,
  defaultEffort: loadChatDefaults().effort,
  modeFlash: null,

  // Marketplace
  marketplaceOpen: false,
  marketplaceCatalog: [],
  marketplaceLoading: false,
  marketplaceError: null,
  marketplaceInstalledNames: [],
  marketplacePluginStates: {},
  marketplaceSearch: '',
  marketplaceFilter: 'All',

  sessionStatuses: {},

  models: FALLBACK_MODELS,
  defaultModelLabel: null,
  modelsLoading: false,

  loadModels: async (force) => {
    set({ modelsLoading: true })
    try {
      const list = await window.clui.getModels(force)
      if (list && list.models.length > 0) set({ models: list.models, defaultModelLabel: list.defaultLabel })
    } catch {}
    set({ modelsLoading: false })
  },

  setSessionStatuses: (map) => set({ sessionStatuses: map }),


  initStaticInfo: async () => {
    try {
      const result = await window.clui.start()
      set({
        staticInfo: {
          version: result.version || 'unknown',
          email: result.auth?.email || null,
          subscriptionType: result.auth?.subscriptionType || null,
          projectPath: result.projectPath || '~',
          homePath: result.homePath || '~',
        },
      })
    } catch {}
  },

  setPreferredModel: (model) => {
    set({ preferredModel: model })
  },

  setTabPermissionMode: (mode, tabId) => {
    const id = tabId || get().activeTabId
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, permissionMode: mode, planReady: mode === 'plan' ? t.planReady : false } : t)),
      modeFlash: { text: `${permissionModeLabel(mode)} mode`, nonce: Date.now() },
    }))
    rememberSessionMode(tab.claudeSessionId, mode)
    // Applies to a running turn right away; otherwise the next run gets --permission-mode
    if (tab.status === 'running' || tab.status === 'connecting') {
      window.clui.setTabPermissionMode(id, mode).catch(() => {})
    }
  },

  cyclePermissionMode: () => {
    const tab = get().tabs.find((t) => t.id === get().activeTabId)
    if (tab) get().setTabPermissionMode(nextPermissionMode(tab.permissionMode))
  },

  setDefaultPermissionMode: (mode) => {
    set({ defaultPermissionMode: mode })
    saveChatDefaults({ permissionMode: mode, effort: get().defaultEffort })
  },

  setTabEffort: (effort) => {
    const id = get().activeTabId
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, effort } : t)) }))
  },

  setDefaultEffort: (effort) => {
    set({ defaultEffort: effort })
    saveChatDefaults({ permissionMode: get().defaultPermissionMode, effort })
  },

  renameTab: async (tabId, title) => {
    const clean = title.replace(/\s+/g, ' ').trim()
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab || !clean) return false
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, title: clean, titleLocked: true, pendingTitle: t.claudeSessionId ? null : clean } : t)) }))
    if (!tab.claudeSessionId) return true
    const res = await window.clui.renameSession(tab.claudeSessionId, clean, tab.workingDirectory).catch(() => ({ ok: false }))
    return !!res.ok
  },

  moveTab: (fromId, toId) => {
    if (fromId === toId) return
    set((s) => {
      const tabs = [...s.tabs]
      const from = tabs.findIndex((t) => t.id === fromId)
      const to = tabs.findIndex((t) => t.id === toId)
      if (from < 0 || to < 0) return {}
      const [moved] = tabs.splice(from, 1)
      tabs.splice(to, 0, moved)
      return { tabs }
    })
  },

  approvePlan: (mode) => {
    get().setTabPermissionMode(mode)
    get().sendMessage('The plan is approved. Go ahead and implement it.')
  },

  dismissPlan: () => {
    const id = get().activeTabId
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, planReady: false } : t)) }))
  },

  interruptActive: () => {
    const tab = get().tabs.find((t) => t.id === get().activeTabId)
    if (!tab || (tab.status !== 'running' && tab.status !== 'connecting')) return false
    window.clui.stopTab(tab.id).catch(() => {})
    return true
  },

  createTab: async () => {
    const homeDir = get().staticInfo?.homePath || '~'
    try {
      const { tabId } = await window.clui.createTab()
      const tab: TabState = {
        ...makeLocalTab(),
        id: tabId,
        workingDirectory: homeDir,
        permissionMode: get().defaultPermissionMode,
        effort: get().defaultEffort,
      }
      set((s) => ({
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
      }))
      return tabId
    } catch {
      const tab = makeLocalTab()
      tab.workingDirectory = homeDir
      set((s) => ({
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
      }))
      return tab.id
    }
  },

  selectTab: (tabId) => {
    const s = get()
    if (tabId === s.activeTabId) {
      // Clicking the already-active tab: toggle global expand/collapse
      const willExpand = !s.isExpanded
      set((prev) => ({
        isExpanded: willExpand,
        marketplaceOpen: false,
        // Expanding = reading: clear unread flag
        tabs: willExpand
          ? prev.tabs.map((t) => t.id === tabId ? { ...t, hasUnread: false } : t)
          : prev.tabs,
      }))
    } else {
      // Switching to a different tab: mark as read
      set((prev) => ({
        activeTabId: tabId,
        marketplaceOpen: false,
        tabs: prev.tabs.map((t) =>
          t.id === tabId ? { ...t, hasUnread: false } : t
        ),
      }))
    }
  },

  toggleExpanded: () => {
    const { activeTabId, isExpanded } = get()
    const willExpand = !isExpanded
    set((s) => ({
      isExpanded: willExpand,
      marketplaceOpen: false,
      // Expanding = reading: clear unread flag for the active tab
      tabs: willExpand
        ? s.tabs.map((t) => t.id === activeTabId ? { ...t, hasUnread: false } : t)
        : s.tabs,
    }))
  },

  toggleMarketplace: () => {
    const s = get()
    if (s.marketplaceOpen) {
      set({ marketplaceOpen: false })
    } else {
      set({ isExpanded: false, marketplaceOpen: true })
      get().loadMarketplace()
    }
  },

  closeMarketplace: () => {
    set({ marketplaceOpen: false })
  },

  loadMarketplace: async (forceRefresh) => {
    set({ marketplaceLoading: true, marketplaceError: null })
    try {
      const [catalog, installed] = await Promise.all([
        window.clui.fetchMarketplace(forceRefresh),
        window.clui.listInstalledPlugins(),
      ])
      if (catalog.error && catalog.plugins.length === 0) {
        set({ marketplaceError: catalog.error, marketplaceLoading: false })
        return
      }
      const installedSet = new Set(installed.map((n) => n.toLowerCase()))
      const pluginStates: Record<string, PluginStatus> = {}
      for (const p of catalog.plugins) {
        // For SKILL.md skills: match individual name against ~/.claude/skills/ dirs
        // For CLI plugins: match installName or "installName@marketplace" against installed_plugins.json
        const candidates = p.isSkillMd
          ? [p.installName]
          : [p.installName, `${p.installName}@${p.marketplace}`]
        const isInstalled = candidates.some((c) => installedSet.has(c.toLowerCase()))
        pluginStates[p.id] = isInstalled ? 'installed' : 'not_installed'
      }
      set({
        marketplaceCatalog: catalog.plugins,
        marketplaceInstalledNames: installed,
        marketplacePluginStates: pluginStates,
        marketplaceLoading: false,
      })
    } catch (err: unknown) {
      set({
        marketplaceError: err instanceof Error ? err.message : String(err),
        marketplaceLoading: false,
      })
    }
  },

  setMarketplaceSearch: (query) => {
    set({ marketplaceSearch: query })
  },

  setMarketplaceFilter: (filter) => {
    set({ marketplaceFilter: filter })
  },

  installMarketplacePlugin: async (plugin) => {
    set((s) => ({
      marketplacePluginStates: { ...s.marketplacePluginStates, [plugin.id]: 'installing' },
    }))
    const result = await window.clui.installPlugin(plugin.repo, plugin.installName, plugin.marketplace, plugin.sourcePath, plugin.isSkillMd)
    if (result.ok) {
      set((s) => ({
        marketplacePluginStates: { ...s.marketplacePluginStates, [plugin.id]: 'installed' as PluginStatus },
        marketplaceInstalledNames: [...s.marketplaceInstalledNames, plugin.installName],
      }))
    } else {
      set((s) => ({
        marketplacePluginStates: { ...s.marketplacePluginStates, [plugin.id]: 'failed' },
      }))
    }
  },

  uninstallMarketplacePlugin: async (plugin) => {
    const result = await window.clui.uninstallPlugin(plugin.installName)
    if (result.ok) {
      set((s) => ({
        marketplacePluginStates: { ...s.marketplacePluginStates, [plugin.id]: 'not_installed' as PluginStatus },
        marketplaceInstalledNames: s.marketplaceInstalledNames.filter((n) => n !== plugin.installName),
      }))
    }
  },

  buildYourOwn: () => {
    set({ marketplaceOpen: false, isExpanded: true })
    // Small delay to let the UI transition
    setTimeout(() => {
      get().sendMessage('Help me create a new Claude Code skill')
    }, 100)
  },

  closeTab: (tabId) => {
    window.clui.closeTab(tabId).catch(() => {})
    get().setDraft(tabId, '')

    const s = get()
    const remaining = s.tabs.filter((t) => t.id !== tabId)

    if (s.activeTabId === tabId) {
      if (remaining.length === 0) {
        const newTab = makeLocalTab()
        set({ tabs: [newTab], activeTabId: newTab.id })
        return
      }
      const closedIndex = s.tabs.findIndex((t) => t.id === tabId)
      const newActive = remaining[Math.min(closedIndex, remaining.length - 1)]
      set({ tabs: remaining, activeTabId: newActive.id })
    } else {
      set({ tabs: remaining })
    }
  },

  clearTab: () => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? { ...t, messages: [], lastResult: null, currentActivity: '', permissionQueue: [], permissionDenied: null, queuedPrompts: [] }
          : t
      ),
    }))
  },

  resumeSession: async (sessionId, title, projectPath) => {
    // Already open: switch to it instead of opening a second copy
    const existing = findSessionTab(get().tabs, sessionId)
    if (existing) {
      set({ activeTabId: existing.id, isExpanded: true })
      return existing.id
    }
    // Opening from the untouched launch tab: the session takes its place
    const active = get().tabs.find((t) => t.id === get().activeTabId)
    const blank = active && canReplaceTab(active, launchTabId, get().drafts[active.id]) ? active : null
    // Re-checked when placing: the tab may have been used while the session loaded
    let replaced = false
    const place = (s: { tabs: TabState[] }, tab: TabState): TabState[] => {
      const current = blank && s.tabs.find((t) => t.id === blank.id)
      replaced = !!current && canReplaceTab(current, launchTabId, get().drafts[current.id])
      return replaced ? s.tabs.map((t) => (t.id === blank!.id ? tab : t)) : [...s.tabs, tab]
    }
    const dropBlank = () => { if (blank && replaced) window.clui.closeTab(blank.id).catch(() => {}) }
    const defaultDir = projectPath || get().staticInfo?.homePath || '~'
    try {
      const { tabId } = await window.clui.createTab()

      // Load previous conversation messages from the JSONL file
      const history = await window.clui.loadSession(sessionId, defaultDir).catch(() => [])
      const messages: Message[] = history.map((m) => ({
        id: nextMsgId(),
        role: m.role as Message['role'],
        content: m.content,
        toolName: m.toolName,
        toolStatus: m.toolName ? 'completed' as const : undefined,
        timestamp: m.timestamp,
      }))

      const tab: TabState = {
        ...makeLocalTab(),
        id: tabId,
        claudeSessionId: sessionId,
        resumedFrom: sessionId,
        title: title || 'Resumed Session',
        workingDirectory: defaultDir,
        hasChosenDirectory: !!projectPath,
        messages,
        permissionMode: sessionModeFor(sessionId) || get().defaultPermissionMode,
        effort: get().defaultEffort,
      }
      set((s) => ({
        tabs: place(s, tab),
        activeTabId: tab.id,
        isExpanded: true,
      }))
      dropBlank()
      // Seed the context meter from where the session left off
      window.clui.getSessionContext(sessionId, defaultDir).then((ctx) => {
        if (!ctx) return
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === tabId && t.contextTokens === 0
            ? { ...t, contextTokens: ctx.tokens, sessionModel: t.sessionModel || ctx.model }
            : t)),
        }))
      }).catch(() => {})
      // Don't call initSession — the first real prompt will use --resume with the sessionId
      return tabId
    } catch {
      const tab = makeLocalTab()
      tab.claudeSessionId = sessionId
      tab.resumedFrom = sessionId
      tab.title = title || 'Resumed Session'
      tab.workingDirectory = defaultDir
      tab.hasChosenDirectory = !!projectPath
      set((s) => ({
        tabs: place(s, tab),
        activeTabId: tab.id,
        isExpanded: true,
      }))
      dropBlank()
      return tab.id
    }
  },

  restoreOpenTabs: async () => {
    const saved = await window.clui.getOpenTabs().catch(() => null)
    const wasExpanded = get().isExpanded
    for (const t of saved?.tabs ?? []) {
      try {
        const tabId = await get().resumeSession(t.sessionId, t.title || undefined, t.projectPath ?? undefined)
        set((s) => ({
          tabs: s.tabs.map((x) => (x.id === tabId ? {
            ...x,
            titleLocked: t.titleLocked,
            additionalDirs: t.additionalDirs,
            ...(isPermissionMode(t.permissionMode) ? { permissionMode: t.permissionMode } : {}),
            effort: isEffortLevel(t.effort) ? t.effort : x.effort,
          } : x)),
        }))
      } catch {}
    }
    const active = saved?.activeSessionId ? findSessionTab(get().tabs, saved.activeSessionId) : undefined
    set((s) => ({ isExpanded: wasExpanded, activeTabId: active?.id ?? s.activeTabId }))
    startSavingOpenTabs()
  },

  addSystemMessage: (content) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              messages: [
                ...t.messages,
                { id: nextMsgId(), role: 'system' as const, content, timestamp: Date.now() },
              ],
            }
          : t
      ),
    }))
  },

  // ─── Permission response ───

  respondPermission: (tabId, questionId, optionId) => {
    // Send to backend
    window.clui.respondPermission(tabId, questionId, optionId).catch(() => {})

    // Remove answered item from queue; show next tool's activity or clear
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        const remaining = t.permissionQueue.filter((p) => p.questionId !== questionId)
        return {
          ...t,
          permissionQueue: remaining,
          currentActivity: remaining.length > 0
            ? `Waiting for permission: ${remaining[0].toolTitle}`
            : 'Working...',
        }
      }),
    }))
  },

  // ─── Directory management ───

  addDirectory: (dir) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              additionalDirs: t.additionalDirs.includes(dir)
                ? t.additionalDirs
                : [...t.additionalDirs, dir],
            }
          : t
      ),
    }))
  },

  removeDirectory: (dir) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? { ...t, additionalDirs: t.additionalDirs.filter((d) => d !== dir) }
          : t
      ),
    }))
  },

  setBaseDirectory: (dir) => {
    const { activeTabId } = get()
    // A new directory means a new session: Remote Control on the old one must end
    get().stopRemoteControl()
    window.clui.resetTabSession(activeTabId)
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              workingDirectory: dir,
              hasChosenDirectory: true,
              claudeSessionId: null,
              additionalDirs: [],
            }
          : t
      ),
    }))
  },

  // ─── Attachment management ───

  addAttachments: (attachments) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? { ...t, attachments: [...t.attachments, ...attachments] }
          : t
      ),
    }))
  },

  removeAttachment: (attachmentId) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? { ...t, attachments: t.attachments.filter((a) => a.id !== attachmentId) }
          : t
      ),
    }))
  },

  clearAttachments: () => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId ? { ...t, attachments: [] } : t
      ),
    }))
  },

  // ─── Send ───

  sendMessage: (prompt, projectPath) => {
    const { activeTabId, tabs, staticInfo } = get()
    const tab = tabs.find((t) => t.id === activeTabId)
    // Use explicitly chosen directory, otherwise fall back to user home
    const resolvedPath = projectPath || (tab?.hasChosenDirectory ? tab.workingDirectory : (staticInfo?.homePath || tab?.workingDirectory || '~'))
    if (!tab) return

    // Guard: don't send while connecting (warmup in progress)
    if (tab.status === 'connecting') return

    // Remote Control holds the session in its own CLI: type the message there instead
    if (tab.remoteControl.state === 'active') {
      const text = prompt.trim()
      if (!text) return
      const dropped = tab.attachments.length
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === activeTabId
          ? { ...t, attachments: [], messages: [...t.messages, { id: nextMsgId(), role: 'user' as const, content: text, timestamp: Date.now() }] }
          : t)),
      }))
      // The CLI's Remote Control input takes text only; tell the user instead of silently dropping files
      if (dropped > 0) get().addSystemMessage(`${dropped} attachment${dropped === 1 ? '' : 's'} not sent: Remote Control accepts text only. Run /rc to turn it off, then send files.`)
      window.clui.remoteControlSend(activeTabId, text).then((ok) => {
        if (!ok) get().addSystemMessage('Error: Remote Control is not running for this chat.')
      }).catch(() => {})
      return
    }

    const isBusy = tab.status === 'running'
    const requestId = crypto.randomUUID()

    // Build full prompt with attachment context
    let fullPrompt = prompt
    if (tab.attachments.length > 0) {
      const attachmentCtx = tab.attachments
        .map((a) => `[Attached ${a.type}: ${a.path}]`)
        .join('\n')
      fullPrompt = `${attachmentCtx}\n\n${prompt}`
    }

    const title = tab.messages.length === 0 && !tab.titleLocked
      ? (prompt.length > 30 ? prompt.substring(0, 27) + '...' : prompt)
      : tab.title

    // Optimistic update: clear attachments
    // If busy, add to queuedPrompts (shown at bottom); otherwise add to messages and set connecting
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== activeTabId) return t
        const withEffectiveBase = t.hasChosenDirectory
          ? t
          : {
              ...t,
              // Once the user sends the first message, lock in the effective
              // base directory (home by default) so the footer no longer shows "—".
              hasChosenDirectory: true,
              workingDirectory: resolvedPath,
            }
        if (isBusy) {
          return {
            ...withEffectiveBase,
            title,
            attachments: [],
            queuedPrompts: [...withEffectiveBase.queuedPrompts, prompt],
          }
        }
        return {
          ...withEffectiveBase,
          planReady: false,
          status: 'connecting' as TabStatus,
          activeRequestId: requestId,
          currentActivity: 'Starting...',
          title,
          attachments: [],
          messages: [
            ...withEffectiveBase.messages,
            { id: nextMsgId(), role: 'user' as const, content: prompt, timestamp: Date.now() },
          ],
        }
      }),
    }))

    // Send to backend — ControlPlane will queue if a run is active
    const { preferredModel } = get()
    window.clui.prompt(activeTabId, requestId, {
      prompt: fullPrompt,
      projectPath: resolvedPath,
      sessionId: tab.claudeSessionId || undefined,
      model: preferredModel || undefined,
      permissionMode: tab.permissionMode,
      effort: tab.effort || undefined,
      addDirs: tab.additionalDirs.length > 0 ? tab.additionalDirs : undefined,
    }).catch((err: Error) => {
      get().handleError(activeTabId, {
        message: err.message,
        stderrTail: [],
        exitCode: null,
        elapsedMs: 0,
        toolCallCount: 0,
      })
    })
  },

  // ─── Remote Control ───

  startRemoteControl: async (name) => {
    const tab = get().tabs.find((t) => t.id === get().activeTabId)
    if (!tab) return
    const add = get().addSystemMessage
    if (!tab.claudeSessionId) { add('Send a message first, then run /remote-control to continue this chat from your phone.'); return }
    if (tab.status === 'running' || tab.status === 'connecting') { add('Wait for the current turn to finish, then run /remote-control.'); return }
    if (tab.remoteControl.state === 'starting' || tab.remoteControl.state === 'active') { add('Remote Control is already on for this chat.'); return }
    const cwd = tab.hasChosenDirectory ? tab.workingDirectory : (get().staticInfo?.homePath || tab.workingDirectory || '~')
    const sessionName = (name || tab.title || 'Clui').trim().slice(0, 80)
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, remoteControl: { state: 'starting', url: null, name: sessionName } } : t)) }))
    add('Connecting Remote Control…')
    const res = await window.clui.remoteControlStart(tab.id, {
      sessionId: tab.claudeSessionId,
      cwd,
      name: sessionName,
      permissionMode: tab.permissionMode,
      model: get().preferredModel || undefined,
    }).catch((err: Error) => ({ ok: false, error: err.message }))
    if (!res.ok) {
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, remoteControl: { state: 'off', url: null, name: null } } : t)) }))
      get().addSystemMessage(`Error: ${res.error || 'Remote Control could not start.'}`)
    }
  },

  stopRemoteControl: () => {
    const tab = get().tabs.find((t) => t.id === get().activeTabId)
    if (!tab || tab.remoteControl.state === 'off') return
    window.clui.remoteControlStop(tab.id).catch(() => {})
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, remoteControl: { state: 'off', url: null, name: null }, currentActivity: '' } : t)) }))
    get().addSystemMessage('Remote Control off. This chat continues here.')
  },

  handleRemoteControlEvent: (tabId, event) => {
    const note = (content: string) => ({ id: nextMsgId(), role: 'system' as const, content, timestamp: Date.now() })
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        switch (event.state) {
          case 'starting':
            return { ...t, remoteControl: { ...t.remoteControl, state: 'starting' } }
          case 'active':
            return {
              ...t,
              remoteControl: { state: 'active', url: event.url, name: event.name },
              currentActivity: 'Remote Control',
              messages: [...t.messages, note(`Remote Control is on · Continue on your phone or at ${event.url}`)],
            }
          case 'error':
            return { ...t, remoteControl: { state: 'off', url: null, name: null }, currentActivity: '', messages: [...t.messages, note(`Error: ${event.message}`)] }
          case 'off':
            // 'stopped' was announced by stopRemoteControl; an unexpected exit gets a note
            return {
              ...t,
              remoteControl: { state: 'off', url: null, name: null },
              currentActivity: '',
              messages: event.reason === 'exited' && t.remoteControl.state !== 'off'
                ? [...t.messages, note('Remote Control ended (the Claude Code session exited). This chat continues here.')]
                : t.messages,
            }
        }
      }),
    }))
  },

  handleRemoteControlMessages: (tabId, incoming) => {
    // send() types newlines as spaces, so the echo differs in whitespace only
    const norm = (x: string) => x.replace(/\s+/g, ' ').trim()
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId || t.remoteControl.state !== 'active') return t
        const messages = [...t.messages]
        for (const m of incoming) {
          // A message typed in Clui is already shown; the transcript echoes it back
          if (m.role === 'user') {
            const last = [...messages].reverse().find((x) => x.role === 'user')
            if (last && norm(last.content) === norm(m.content) && Date.now() - last.timestamp < 60_000) continue
          }
          messages.push({
            id: nextMsgId(),
            role: m.role as Message['role'],
            content: m.content,
            toolName: m.toolName,
            toolStatus: m.toolName ? 'completed' : undefined,
            timestamp: m.timestamp || Date.now(),
          })
        }
        return { ...t, messages, hasUnread: t.id !== s.activeTabId ? true : t.hasUnread }
      }),
    }))
  },

  // ─── Event handlers ───

  handleNormalizedEvent: (tabId, event) => {
    set((s) => {
      const { activeTabId } = s
      const tabs = s.tabs.map((tab) => {
        if (tab.id !== tabId) return tab
        const updated = { ...tab }

        switch (event.type) {
          case 'session_init':
            updated.claudeSessionId = event.sessionId
            updated.sessionModel = event.model
            updated.sessionTools = event.tools
            updated.sessionMcpServers = event.mcpServers
            updated.sessionSkills = event.skills
            updated.sessionVersion = event.version
            if (event.slashCommands.length > 0) {
              updated.sessionSlashCommands = event.slashCommands
              updated.sessionTerminalCommands = event.terminalCommands
            }
            if (updated.pendingTitle && event.sessionId) {
              const pending = updated.pendingTitle
              updated.pendingTitle = null
              void window.clui.renameSession(event.sessionId, pending, updated.workingDirectory)
            }
            if (!event.isWarmup) rememberSessionMode(event.sessionId, updated.permissionMode)
            // Don't change status/activity for warmup inits — they're invisible
            if (!event.isWarmup) {
              updated.status = 'running'
              updated.currentActivity = 'Thinking...'
              // Move the first queued prompt into the timeline (it's now being processed)
              if (updated.queuedPrompts.length > 0) {
                const [nextPrompt, ...rest] = updated.queuedPrompts
                updated.queuedPrompts = rest
                updated.messages = [
                  ...updated.messages,
                  { id: nextMsgId(), role: 'user' as const, content: nextPrompt, timestamp: Date.now() },
                ]
              }
            }
            break

          case 'permission_mode':
            if (event.mode === 'default' || event.mode === 'acceptEdits' || event.mode === 'plan' || event.mode === 'auto') {
              updated.permissionMode = event.mode
            }
            break

          case 'compact_boundary':
            updated.contextTokens = event.postTokens ?? 0
            updated.messages = [
              ...updated.messages,
              {
                id: nextMsgId(),
                role: 'system',
                content: event.preTokens != null && event.postTokens != null
                  ? `Conversation compacted (${Math.round(event.preTokens / 1000)}k → ${Math.round(event.postTokens / 1000)}k tokens)`
                  : 'Conversation compacted',
                timestamp: Date.now(),
              },
            ]
            break

          case 'context_usage':
            updated.contextTokens = event.tokens
            break

          case 'task_created':
            updated.todos = applyTaskCreated(updated.todos, event.task)
            break

          case 'harness_notice': {
            // Shown as notice rows by UserMessage; skip exact repeats
            const last = updated.messages[updated.messages.length - 1]
            if (!(last?.role === 'user' && last.content === event.text)) {
              updated.messages = [...updated.messages, { id: nextMsgId(), role: 'user', content: event.text, timestamp: Date.now() }]
            }
            break
          }

          case 'text_chunk': {
            updated.currentActivity = 'Writing...'
            const lastMsg = updated.messages[updated.messages.length - 1]
            if (lastMsg?.role === 'assistant' && !lastMsg.toolName) {
              updated.messages = [
                ...updated.messages.slice(0, -1),
                { ...lastMsg, content: lastMsg.content + event.text },
              ]
            } else {
              updated.messages = [
                ...updated.messages,
                { id: nextMsgId(), role: 'assistant', content: event.text, timestamp: Date.now() },
              ]
            }
            break
          }

          case 'tool_call':
            updated.currentActivity = `Running ${event.toolName}...`
            updated.messages = [
              ...updated.messages,
              {
                id: nextMsgId(),
                role: 'tool',
                content: '',
                toolName: event.toolName,
                toolInput: '',
                toolStatus: 'running',
                timestamp: Date.now(),
              },
            ]
            break

          case 'tool_call_update': {
            const msgs = [...updated.messages]
            const lastTool = [...msgs].reverse().find((m) => m.role === 'tool' && m.toolStatus === 'running')
            if (lastTool) {
              lastTool.toolInput = (lastTool.toolInput || '') + event.partialInput
            }
            updated.messages = msgs
            break
          }

          case 'tool_call_complete': {
            const msgs2 = [...updated.messages]
            const runningTool = [...msgs2].reverse().find((m) => m.role === 'tool' && m.toolStatus === 'running')
            if (runningTool) {
              runningTool.toolStatus = 'completed'
            }
            updated.messages = msgs2
            break
          }

          case 'task_update': {
            // ── Text fallback ──
            // text_chunk events (from stream_event deltas) are the primary render path.
            // If they didn't arrive for this run (timing, partial stream, etc.), the
            // assembled assistant event still has the full text — extract it here.
            // "This run" = everything after the last user message.
            if (event.message?.content) {
              const lastUserIdx = (() => {
                for (let i = updated.messages.length - 1; i >= 0; i--) {
                  if (updated.messages[i].role === 'user') return i
                }
                return -1
              })()
              const hasStreamedText = updated.messages
                .slice(lastUserIdx + 1)
                .some((m) => m.role === 'assistant' && !m.toolName)

              if (!hasStreamedText) {
                const textContent = event.message.content
                  .filter((b) => b.type === 'text' && b.text)
                  .map((b) => b.text!)
                  .join('')
                if (textContent) {
                  updated.messages = [
                    ...updated.messages,
                    { id: nextMsgId(), role: 'assistant' as const, content: textContent, timestamp: Date.now() },
                  ]
                }
              }

              for (const block of event.message.content) {
                if (block.type === 'tool_use' && block.name) {
                  updated.todos = applyTodoToolUse(updated.todos, block.name, block.input)
                }
              }

              // ── Tool card deduplication (unchanged) ──
              for (const block of event.message.content) {
                if (block.type === 'tool_use' && block.name) {
                  const exists = updated.messages.find(
                    (m) => m.role === 'tool' && m.toolName === block.name && !m.content
                  )
                  if (!exists) {
                    updated.messages = [
                      ...updated.messages,
                      {
                        id: nextMsgId(),
                        role: 'tool',
                        content: '',
                        toolName: block.name,
                        toolInput: JSON.stringify(block.input, null, 2),
                        toolStatus: 'completed',
                        timestamp: Date.now(),
                      },
                    ]
                  }
                }
              }
            }
            break
          }

          case 'task_complete':
            updated.status = 'completed'
            updated.activeRequestId = null
            updated.currentActivity = ''
            updated.permissionQueue = []
            updated.totalCostUsd = (updated.totalCostUsd || 0) + (event.costUsd || 0)
            if (event.contextWindow) updated.contextWindow = event.contextWindow
            if (updated.permissionMode === 'plan' && event.numTurns > 0) updated.planReady = true
            updated.lastResult = {
              totalCostUsd: event.costUsd,
              durationMs: event.durationMs,
              numTurns: event.numTurns,
              usage: event.usage,
              sessionId: event.sessionId,
            }
            // ── Final text fallback ──
            // If neither text_chunks nor task_update text produced an assistant message,
            // use event.result (the CLI's assembled final output) as last resort.
            if (event.result) {
              const lastUserIdx2 = (() => {
                for (let i = updated.messages.length - 1; i >= 0; i--) {
                  if (updated.messages[i].role === 'user') return i
                }
                return -1
              })()
              const hasAnyText = updated.messages
                .slice(lastUserIdx2 + 1)
                .some((m) => m.role === 'assistant' && !m.toolName)
              if (!hasAnyText) {
                updated.messages = [
                  ...updated.messages,
                  { id: nextMsgId(), role: 'assistant' as const, content: event.result, timestamp: Date.now() },
                ]
              }
            }
            // Mark as unread unless the user is actively viewing this tab
            // (active tab with card expanded). A collapsed active tab still
            // counts as "unread" — the user hasn't seen the response yet.
            if (tabId !== activeTabId || !s.isExpanded) {
              updated.hasUnread = true
            }
            // Show fallback card when tools were denied by permission settings
            if (event.permissionDenials && event.permissionDenials.length > 0) {
              updated.permissionDenied = { tools: event.permissionDenials }
            } else {
              updated.permissionDenied = null
            }
            // Play notification sound if window is hidden
            playNotificationIfHidden()
            void refreshTabTitle(tabId)
            break

          case 'error':
            updated.status = 'failed'
            updated.activeRequestId = null
            updated.currentActivity = ''
            updated.permissionQueue = []
            updated.permissionDenied = null
            updated.messages = [
              ...updated.messages,
              { id: nextMsgId(), role: 'system', content: `Error: ${event.message}`, timestamp: Date.now() },
            ]
            break

          case 'session_dead':
            updated.status = 'dead'
            updated.activeRequestId = null
            updated.currentActivity = ''
            updated.permissionQueue = []
            updated.permissionDenied = null
            updated.messages = [
              ...updated.messages,
              {
                id: nextMsgId(),
                role: 'system',
                content: `Session ended unexpectedly (exit ${event.exitCode})`,
                timestamp: Date.now(),
              },
            ]
            break

          case 'permission_request': {
            const newReq: import('../../shared/types').PermissionRequest = {
              questionId: event.questionId,
              toolTitle: event.toolName,
              toolDescription: event.toolDescription,
              toolInput: event.toolInput,
              options: event.options.map((o) => ({
                optionId: o.id,
                kind: o.kind,
                label: o.label,
              })),
            }
            updated.permissionQueue = [...updated.permissionQueue, newReq]
            updated.currentActivity = `Waiting for permission: ${event.toolName}`
            break
          }

          case 'rate_limit':
            if (event.status !== 'allowed') {
              updated.messages = [
                ...updated.messages,
                {
                  id: nextMsgId(),
                  role: 'system',
                  content: `Rate limited (${event.rateLimitType}). Resets at ${new Date(event.resetsAt).toLocaleTimeString()}.`,
                  timestamp: Date.now(),
                },
              ]
            }
            break
        }

        return updated
      })

      return { tabs }
    })
  },

  handleStatusChange: (tabId, newStatus) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              status: newStatus as TabStatus,
              // Clear activity when transitioning to idle (e.g., after warmup init)
              ...(newStatus === 'idle' ? { currentActivity: '', permissionQueue: [] as import('../../shared/types').PermissionRequest[], permissionDenied: null } : {}),
            }
          : t
      ),
    }))
  },

  handleError: (tabId, error) => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t

        // Deduplicate: skip if the last message is already an error for this failure
        const lastMsg = t.messages[t.messages.length - 1]
        const alreadyHasError = lastMsg?.role === 'system' && lastMsg.content.startsWith('Error:')

        return {
          ...t,
          status: 'failed' as TabStatus,
          activeRequestId: null,
          currentActivity: '',
          permissionQueue: [],
          messages: alreadyHasError
            ? t.messages
            : [
                ...t.messages,
                {
                  id: nextMsgId(),
                  role: 'system' as const,
                  content: `Error: ${error.message}${error.stderrTail.length > 0 ? '\n\n' + error.stderrTail.slice(-5).join('\n') : ''}`,
                  timestamp: Date.now(),
                },
              ],
        }
      }),
    }))
  },
}))

// Saved on every tab change (not on quit), so a force quit or crash still reopens the latest tabs
let savingOpenTabs = false
function startSavingOpenTabs(): void {
  if (savingOpenTabs) return
  savingOpenTabs = true
  let last = ''
  const save = (s: State) => {
    const snapshot = snapshotOpenTabs(s.tabs, s.activeTabId)
    const json = JSON.stringify(snapshot)
    if (json === last) return
    last = json
    window.clui.saveOpenTabs(snapshot)
  }
  save(useSessionStore.getState())
  useSessionStore.subscribe(save)
}
