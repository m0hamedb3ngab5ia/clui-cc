import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/types'
import type { RunOptions, NormalizedEvent, HealthReport, EnrichedError, Attachment, SessionMeta, CatalogPlugin, SessionLoadMessage, LiveSessionStatus, TrackingSettings, ModelList, SubagentInfo, RemoteControlEvent } from '../shared/types'
import type { OpenTabsSnapshot } from '../shared/open-tabs'

export interface CluiAPI {
  // ─── Request-response (renderer → main) ───
  start(): Promise<{ version: string; auth: { email?: string; subscriptionType?: string; authMethod?: string }; mcpServers: string[]; projectPath: string; homePath: string }>
  createTab(): Promise<{ tabId: string }>
  prompt(tabId: string, requestId: string, options: RunOptions): Promise<void>
  cancel(requestId: string): Promise<boolean>
  stopTab(tabId: string): Promise<boolean>
  retry(tabId: string, requestId: string, options: RunOptions): Promise<void>
  status(): Promise<HealthReport>
  tabHealth(): Promise<HealthReport>
  closeTab(tabId: string): Promise<void>
  selectDirectory(): Promise<string | null>
  openExternal(url: string): Promise<boolean>
  openInTerminal(sessionId: string | null, projectPath?: string): Promise<boolean>
  attachFiles(): Promise<Attachment[] | null>
  takeScreenshot(): Promise<Attachment | null>
  pasteImage(dataUrl: string): Promise<Attachment | null>
  /** Grow/shrink the native window to fit a resized panel; returns the new bounds */
  setPanelExtent(size: { width: number; height: number }): Promise<{ x: number; y: number; width: number; height: number } | null>
  /** interim: a live-preview pass while still recording (quieter logging) */
  transcribeAudio(audioBase64: string, opts?: { interim?: boolean }): Promise<{ error: string | null; transcript: string | null }>
  getDiagnostics(): Promise<any>
  respondPermission(tabId: string, questionId: string, optionId: string): Promise<boolean>
  initSession(tabId: string): void
  resetTabSession(tabId: string): void
  listSessions(projectPath?: string): Promise<SessionMeta[]>
  listAllSessions(): Promise<SessionMeta[]>
  getSessionTitle(sessionId: string, projectPath?: string): Promise<string | null>
  /** Generate and store a short AI title if the session has none yet; returns the session's title */
  autoTitleSession(sessionId: string, projectPath?: string): Promise<string | null>
  getSessionStatuses(): Promise<Record<string, LiveSessionStatus>>
  /** Models discovered from the installed claude CLI (cached; `force` re-queries) */
  getModels(force?: boolean): Promise<ModelList | null>
  onSessionStatusChanged(callback: (map: Record<string, LiveSessionStatus>) => void): () => void
  getTracking(): Promise<TrackingSettings>
  /** Install or remove Clui's global status hooks; resolves with the new settings or an error message */
  setTracking(enabled: boolean): Promise<{ ok: boolean; error?: string; settings: TrackingSettings }>
  setHopPrefs(prefs: { hopOnFinish?: boolean; hopOnInput?: boolean }): Promise<TrackingSettings>
  /** Tabs open when Clui last ran */
  getOpenTabs(): Promise<OpenTabsSnapshot>
  /** Save the open tabs (written to disk at once, so a force quit keeps them) */
  saveOpenTabs(snapshot: OpenTabsSnapshot): void
  /** Tell main which Claude sessions belong to Clui tabs (to avoid double alerts) */
  listSubagents(sessionId: string, projectPath?: string): Promise<SubagentInfo[]>
  /** Running / total subagents per session */
  countSubagents(sessions: Array<{ sessionId: string; projectPath?: string | null }>): Promise<Record<string, { running: number; total: number }>>
  loadSession(sessionId: string, projectPath?: string): Promise<SessionLoadMessage[]>
  fetchMarketplace(forceRefresh?: boolean): Promise<{ plugins: CatalogPlugin[]; error: string | null }>
  listInstalledPlugins(): Promise<string[]>
  installPlugin(repo: string, pluginName: string, marketplace: string, sourcePath?: string, isSkillMd?: boolean): Promise<{ ok: boolean; error?: string }>
  uninstallPlugin(pluginName: string): Promise<{ ok: boolean; error?: string }>
  /** Switch a tab's live run to another permission mode; false if no run is active */
  setTabPermissionMode(tabId: string, mode: string): Promise<boolean>
  /** Rename like /rename: appends a custom-title record to the transcript */
  renameSession(sessionId: string, title: string, projectPath?: string): Promise<{ ok: boolean; title?: string; error?: string }>
  /** Frontmatter descriptions of user/project commands and skills */
  getCommandDescriptions(cwd?: string): Promise<Record<string, string>>
  /** Context tokens at the end of a saved session (for the % meter on resume) */
  /** Ask macOS for the microphone the first time voice input is used */
  requestMic(): Promise<boolean>
  getSessionContext(sessionId: string, projectPath?: string): Promise<{ tokens: number; model: string | null } | null>
  getTheme(): Promise<{ isDark: boolean }>
  onThemeChange(callback: (isDark: boolean) => void): () => void
  /** Remote Control: serve this tab's session to claude.ai / the phone from a hidden CLI */
  remoteControlStart(tabId: string, opts: { sessionId: string; cwd: string; name: string; permissionMode?: string; model?: string }): Promise<{ ok: boolean; error?: string }>
  remoteControlStop(tabId: string): Promise<boolean>
  /** Type a message into the Remote Control session; false when it isn't on */
  remoteControlSend(tabId: string, text: string): Promise<boolean>
  onRemoteControl(callback: (tabId: string, event: RemoteControlEvent) => void): () => void
  /** Messages appended to the transcript while Remote Control is on (from the phone or Clui) */
  onRemoteControlMessages(callback: (tabId: string, messages: SessionLoadMessage[]) => void): () => void

  // ─── Window management ───
  resizeHeight(height: number): void
  setWindowWidth(width: number): void
  animateHeight(from: number, to: number, durationMs: number): Promise<void>
  hideWindow(): void
  isVisible(): Promise<boolean>
  /** OS-level click-through for transparent window regions */
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void
  /** Manual window drag for frameless windows */
  startWindowDrag(deltaX: number, deltaY: number): void
  /** Reset overlay to its default bottom-center position */
  resetWindowPosition(): void
  /** Collapse the overlay into the floating logo bubble */
  minimizeToBubble(): void
  /** Quit Clui CC; force skips graceful teardown (for when it's stuck) */
  quitApp(force?: boolean): void
  expandFromBubble(): void
  /** Move the bubble window; `done` persists the final position */
  moveBubble(deltaX: number, deltaY: number, done?: boolean): void
  onBubbleState(callback: (state: { attention: number; activity?: 'input' | 'working' | null }) => void): () => void

  // ─── Event listeners (main → renderer) ───
  onEvent(callback: (tabId: string, event: NormalizedEvent) => void): () => void
  onTabStatusChange(callback: (tabId: string, newStatus: string, oldStatus: string) => void): () => void
  onError(callback: (tabId: string, error: EnrichedError) => void): () => void
  onSkillStatus(callback: (status: { name: string; state: string; error?: string; reason?: string }) => void): () => void
  onWindowShown(callback: () => void): () => void
}

const api: CluiAPI = {
  // ─── Request-response ───
  start: () => ipcRenderer.invoke(IPC.START),
  createTab: () => ipcRenderer.invoke(IPC.CREATE_TAB),
  prompt: (tabId, requestId, options) => ipcRenderer.invoke(IPC.PROMPT, { tabId, requestId, options }),
  cancel: (requestId) => ipcRenderer.invoke(IPC.CANCEL, requestId),
  stopTab: (tabId) => ipcRenderer.invoke(IPC.STOP_TAB, tabId),
  retry: (tabId, requestId, options) => ipcRenderer.invoke(IPC.RETRY, { tabId, requestId, options }),
  status: () => ipcRenderer.invoke(IPC.STATUS),
  tabHealth: () => ipcRenderer.invoke(IPC.TAB_HEALTH),
  closeTab: (tabId) => ipcRenderer.invoke(IPC.CLOSE_TAB, tabId),
  selectDirectory: () => ipcRenderer.invoke(IPC.SELECT_DIRECTORY),
  openExternal: (url) => ipcRenderer.invoke(IPC.OPEN_EXTERNAL, url),
  openInTerminal: (sessionId, projectPath) => ipcRenderer.invoke(IPC.OPEN_IN_TERMINAL, { sessionId, projectPath }),
  attachFiles: () => ipcRenderer.invoke(IPC.ATTACH_FILES),
  takeScreenshot: () => ipcRenderer.invoke(IPC.TAKE_SCREENSHOT),
  pasteImage: (dataUrl) => ipcRenderer.invoke(IPC.PASTE_IMAGE, dataUrl),
  setPanelExtent: (size) => ipcRenderer.invoke(IPC.SET_PANEL_EXTENT, size),
  transcribeAudio: (audioBase64, opts) => ipcRenderer.invoke(IPC.TRANSCRIBE_AUDIO, audioBase64, opts),
  getDiagnostics: () => ipcRenderer.invoke(IPC.GET_DIAGNOSTICS),
  respondPermission: (tabId, questionId, optionId) =>
    ipcRenderer.invoke(IPC.RESPOND_PERMISSION, { tabId, questionId, optionId }),
  initSession: (tabId) => ipcRenderer.send(IPC.INIT_SESSION, tabId),
  resetTabSession: (tabId) => ipcRenderer.send(IPC.RESET_TAB_SESSION, tabId),
  listSessions: (projectPath?: string) => ipcRenderer.invoke(IPC.LIST_SESSIONS, projectPath),
  listAllSessions: () => ipcRenderer.invoke(IPC.LIST_ALL_SESSIONS),
  getSessionTitle: (sessionId: string, projectPath?: string) => ipcRenderer.invoke(IPC.GET_SESSION_TITLE, { sessionId, projectPath }),
  autoTitleSession: (sessionId: string, projectPath?: string) => ipcRenderer.invoke(IPC.AUTO_TITLE_SESSION, { sessionId, projectPath }),
  getSessionStatuses: () => ipcRenderer.invoke(IPC.GET_SESSION_STATUSES),
  getModels: (force?: boolean) => ipcRenderer.invoke(IPC.GET_MODELS, !!force),
  onSessionStatusChanged: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, map: Record<string, LiveSessionStatus>) => callback(map)
    ipcRenderer.on(IPC.SESSION_STATUS_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.SESSION_STATUS_CHANGED, handler)
  },
  getTracking: () => ipcRenderer.invoke(IPC.GET_TRACKING),
  setTracking: (enabled: boolean) => ipcRenderer.invoke(IPC.SET_TRACKING, enabled),
  setHopPrefs: (prefs) => ipcRenderer.invoke(IPC.SET_HOP_PREFS, prefs),
  getOpenTabs: () => ipcRenderer.invoke(IPC.GET_OPEN_TABS),
  saveOpenTabs: (snapshot) => ipcRenderer.send(IPC.SAVE_OPEN_TABS, snapshot),
  listSubagents: (sessionId, projectPath) => ipcRenderer.invoke(IPC.LIST_SUBAGENTS, { sessionId, projectPath }),
  countSubagents: (sessions) => ipcRenderer.invoke(IPC.COUNT_SUBAGENTS, sessions),
  loadSession: (sessionId: string, projectPath?: string) => ipcRenderer.invoke(IPC.LOAD_SESSION, { sessionId, projectPath }),
  fetchMarketplace: (forceRefresh) => ipcRenderer.invoke(IPC.MARKETPLACE_FETCH, { forceRefresh }),
  listInstalledPlugins: () => ipcRenderer.invoke(IPC.MARKETPLACE_INSTALLED),
  installPlugin: (repo, pluginName, marketplace, sourcePath, isSkillMd) =>
    ipcRenderer.invoke(IPC.MARKETPLACE_INSTALL, { repo, pluginName, marketplace, sourcePath, isSkillMd }),
  uninstallPlugin: (pluginName) =>
    ipcRenderer.invoke(IPC.MARKETPLACE_UNINSTALL, { pluginName }),
  setTabPermissionMode: (tabId, mode) => ipcRenderer.invoke(IPC.SET_TAB_PERMISSION_MODE, { tabId, mode }),
  renameSession: (sessionId, title, projectPath) => ipcRenderer.invoke(IPC.RENAME_SESSION, { sessionId, title, projectPath }),
  requestMic: () => ipcRenderer.invoke(IPC.REQUEST_MIC),
  getSessionContext: (sessionId, projectPath) => ipcRenderer.invoke(IPC.GET_SESSION_CONTEXT, { sessionId, projectPath }),
  getCommandDescriptions: (cwd) => ipcRenderer.invoke(IPC.GET_COMMAND_DESCRIPTIONS, cwd),
  getTheme: () => ipcRenderer.invoke(IPC.GET_THEME),
  onThemeChange: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, isDark: boolean) => callback(isDark)
    ipcRenderer.on(IPC.THEME_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.THEME_CHANGED, handler)
  },
  remoteControlStart: (tabId, opts) => ipcRenderer.invoke(IPC.REMOTE_CONTROL_START, { tabId, ...opts }),
  remoteControlStop: (tabId) => ipcRenderer.invoke(IPC.REMOTE_CONTROL_STOP, tabId),
  remoteControlSend: (tabId, text) => ipcRenderer.invoke(IPC.REMOTE_CONTROL_SEND, { tabId, text }),
  onRemoteControl: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, event: RemoteControlEvent) => callback(tabId, event)
    ipcRenderer.on(IPC.REMOTE_CONTROL_EVENT, handler)
    return () => ipcRenderer.removeListener(IPC.REMOTE_CONTROL_EVENT, handler)
  },
  onRemoteControlMessages: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, messages: SessionLoadMessage[]) => callback(tabId, messages)
    ipcRenderer.on(IPC.REMOTE_CONTROL_MESSAGES, handler)
    return () => ipcRenderer.removeListener(IPC.REMOTE_CONTROL_MESSAGES, handler)
  },

  // ─── Window management ───
  resizeHeight: (height) => ipcRenderer.send(IPC.RESIZE_HEIGHT, height),
  animateHeight: (from, to, durationMs) =>
    ipcRenderer.invoke(IPC.ANIMATE_HEIGHT, { from, to, durationMs }),
  hideWindow: () => ipcRenderer.send(IPC.HIDE_WINDOW),
  isVisible: () => ipcRenderer.invoke(IPC.IS_VISIBLE),
  setIgnoreMouseEvents: (ignore, options) =>
    ipcRenderer.send(IPC.SET_IGNORE_MOUSE_EVENTS, ignore, options || {}),
  startWindowDrag: (deltaX, deltaY) =>
    ipcRenderer.send(IPC.START_WINDOW_DRAG, deltaX, deltaY),
  resetWindowPosition: () => ipcRenderer.send(IPC.RESET_WINDOW_POSITION),
  minimizeToBubble: () => ipcRenderer.send(IPC.MINIMIZE_TO_BUBBLE),
  quitApp: (force) => ipcRenderer.send(IPC.QUIT_APP, !!force),
  expandFromBubble: () => ipcRenderer.send(IPC.EXPAND_FROM_BUBBLE),
  moveBubble: (deltaX, deltaY, done) => ipcRenderer.send(IPC.MOVE_BUBBLE, deltaX, deltaY, !!done),
  onBubbleState: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, state: { attention: number }) => callback(state)
    ipcRenderer.on(IPC.BUBBLE_STATE, handler)
    return () => ipcRenderer.removeListener(IPC.BUBBLE_STATE, handler)
  },
  setWindowWidth: (width) => ipcRenderer.send(IPC.SET_WINDOW_WIDTH, width),

  // ─── Event listeners ───
  onEvent: (callback) => {
    const channels = [
      IPC.TEXT_CHUNK, IPC.TOOL_CALL, IPC.TOOL_CALL_UPDATE,
      IPC.TOOL_CALL_COMPLETE, IPC.TASK_UPDATE, IPC.TASK_COMPLETE,
      IPC.SESSION_DEAD, IPC.SESSION_INIT, IPC.ERROR, IPC.RATE_LIMIT,
    ]
    // Single unified handler — all normalized events come through one channel
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, event: NormalizedEvent) => callback(tabId, event)
    ipcRenderer.on('clui:normalized-event', handler)
    return () => ipcRenderer.removeListener('clui:normalized-event', handler)
  },

  onTabStatusChange: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, newStatus: string, oldStatus: string) =>
      callback(tabId, newStatus, oldStatus)
    ipcRenderer.on('clui:tab-status-change', handler)
    return () => ipcRenderer.removeListener('clui:tab-status-change', handler)
  },

  onError: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, error: EnrichedError) =>
      callback(tabId, error)
    ipcRenderer.on('clui:enriched-error', handler)
    return () => ipcRenderer.removeListener('clui:enriched-error', handler)
  },

  onSkillStatus: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, status: any) => callback(status)
    ipcRenderer.on(IPC.SKILL_STATUS, handler)
    return () => ipcRenderer.removeListener(IPC.SKILL_STATUS, handler)
  },

  onWindowShown: (callback) => {
    const handler = () => callback()
    ipcRenderer.on(IPC.WINDOW_SHOWN, handler)
    return () => ipcRenderer.removeListener(IPC.WINDOW_SHOWN, handler)
  },
}

contextBridge.exposeInMainWorld('clui', api)
