import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Clock, ChatCircle, Folder } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import type { SessionMeta } from '../../shared/types'

function formatTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(isoDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

type HistoryScope = 'project' | 'all'
const SCOPE_KEY = 'clui.historyScope'

function readScope(): HistoryScope {
  try {
    return localStorage.getItem(SCOPE_KEY) === 'project' ? 'project' : 'all'
  } catch {
    return 'all'
  }
}

function projectName(path: string | null | undefined): string {
  if (!path) return ''
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] || '/'
}

export function HistoryPicker() {
  const resumeSession = useSessionStore((s) => s.resumeSession)
  const isExpanded = useSessionStore((s) => s.isExpanded)
  const activeTab = useSessionStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId),
    (a, b) => a === b || (!!a && !!b && a.hasChosenDirectory === b.hasChosenDirectory && a.workingDirectory === b.workingDirectory),
  )
  const staticInfo = useSessionStore((s) => s.staticInfo)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()
  const effectiveProjectPath = activeTab?.hasChosenDirectory
    ? activeTab.workingDirectory
    : (staticInfo?.homePath || activeTab?.workingDirectory || '~')

  const [open, setOpen] = useState(false)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [scope, setScope] = useState<HistoryScope>(readScope)
  const [query, setQuery] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ right: number; top?: number; bottom?: number; maxHeight?: number }>({ right: 0 })

  const updatePos = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    if (isExpanded) {
      const top = rect.bottom + 6
      setPos({
        top,
        right: window.innerWidth - rect.right,
        maxHeight: window.innerHeight - top - 12,
      })
    } else {
      setPos({
        bottom: window.innerHeight - rect.top + 6,
        right: window.innerWidth - rect.right,
      })
    }
  }, [isExpanded])

  const loadSessions = useCallback(async () => {
    setLoading(true)
    try {
      const result = scope === 'all'
        ? await window.clui.listAllSessions()
        : await window.clui.listSessions(effectiveProjectPath)
      setSessions(result)
    } catch {
      setSessions([])
    }
    setLoading(false)
  }, [effectiveProjectPath, scope])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Reload when the scope changes while open (opening itself triggers a load in handleToggle)
  useEffect(() => {
    if (open) void loadSessions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  const handleToggle = () => {
    if (!open) {
      updatePos()
      setQuery('')
      void loadSessions()
    }
    setOpen((o) => !o)
  }

  const changeScope = (next: HistoryScope) => {
    if (next === scope) return
    setScope(next)
    try { localStorage.setItem(SCOPE_KEY, next) } catch {}
  }

  const q = query.trim().toLowerCase()
  const visible = q
    ? sessions.filter((s) =>
        [s.title, s.firstMessage, s.slug, s.projectPath].some((v) => v?.toLowerCase().includes(q)))
    : sessions

  const handleSelect = (session: SessionMeta) => {
    setOpen(false)
    const name = session.title || session.firstMessage
    const title = name
      ? (name.length > 30 ? name.substring(0, 27) + '...' : name)
      : session.slug || 'Resumed'
    // Resume in the directory the session ran in, so `claude --resume` finds it
    void resumeSession(session.sessionId, title, session.projectPath || effectiveProjectPath)
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors"
        style={{ color: colors.textTertiary }}
        title="Resume a previous session"
      >
        <Clock size={13} />
      </button>

      {popoverLayer && open && createPortal(
        <motion.div
          ref={popoverRef}
          data-clui-ui
          initial={{ opacity: 0, y: isExpanded ? -4 : 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: isExpanded ? -4 : 4 }}
          transition={{ duration: 0.12 }}
          className="rounded-xl"
          style={{
            position: 'fixed',
            ...(pos.top != null ? { top: pos.top } : {}),
            ...(pos.bottom != null ? { bottom: pos.bottom } : {}),
            right: pos.right,
            width: scope === 'all' ? 320 : 280,
            pointerEvents: 'auto',
            background: colors.popoverBg,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: colors.popoverShadow,
            border: `1px solid ${colors.popoverBorder}`,
            ...(pos.maxHeight != null ? { maxHeight: pos.maxHeight } : {}),
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column' as const,
          }}
        >
          <div className="px-3 py-2 flex-shrink-0 flex flex-col gap-1.5" style={{ borderBottom: `1px solid ${colors.popoverBorder}` }}>
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium" style={{ color: colors.textTertiary }}>Recent Sessions</span>
              <div className="flex items-center gap-0.5 text-[10px]">
                {(['project', 'all'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => changeScope(s)}
                    className="px-1.5 py-0.5 rounded-md transition-colors"
                    style={{
                      color: scope === s ? colors.textPrimary : colors.textTertiary,
                      background: scope === s ? colors.popoverBorder : 'transparent',
                    }}
                    title={s === 'all' ? 'Sessions from every project' : 'Sessions from this tab\'s folder'}
                  >
                    {s === 'all' ? 'All' : 'This folder'}
                  </button>
                ))}
              </div>
            </div>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter sessions..."
              className="w-full bg-transparent outline-none text-[11px] px-1.5 py-1 rounded-md"
              style={{ color: colors.textPrimary, border: `1px solid ${colors.popoverBorder}` }}
            />
          </div>

          <div className="overflow-y-auto py-1" style={{ maxHeight: pos.maxHeight != null ? undefined : 260 }}>
            {loading && (
              <div className="px-3 py-4 text-center text-[11px]" style={{ color: colors.textTertiary }}>
                Loading...
              </div>
            )}

            {!loading && visible.length === 0 && (
              <div className="px-3 py-4 text-center text-[11px]" style={{ color: colors.textTertiary }}>
                {q ? 'No matching sessions' : 'No previous sessions found'}
              </div>
            )}

            {!loading && visible.map((session) => (
              <button
                key={session.sessionId}
                onClick={() => handleSelect(session)}
                className="w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors"
              >
                <ChatCircle size={13} className="flex-shrink-0 mt-0.5" style={{ color: colors.textTertiary }} />
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] truncate" style={{ color: colors.textPrimary }}>
                    {session.title || session.firstMessage || session.slug || session.sessionId.substring(0, 8)}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] mt-0.5" style={{ color: colors.textTertiary }}>
                    <span>{formatTimeAgo(session.lastTimestamp)}</span>
                    <span>{formatSize(session.size)}</span>
                    {scope === 'all' && session.projectPath && (
                      <span className="flex items-center gap-0.5 min-w-0" title={session.projectPath}>
                        <Folder size={10} className="flex-shrink-0" />
                        <span className="truncate">{projectName(session.projectPath)}</span>
                      </span>
                    )}
                    {session.slug && scope !== 'all' && <span className="truncate">{session.slug}</span>}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </motion.div>,
        popoverLayer,
      )}
    </>
  )
}
