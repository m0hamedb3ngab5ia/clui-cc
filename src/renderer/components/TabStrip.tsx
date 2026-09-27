import React, { useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, X, Minus } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { HistoryPicker } from './HistoryPicker'
import { SettingsPopover } from './SettingsPopover'
import { useColors } from '../theme'
import type { TabStatus } from '../../shared/types'

function StatusDot({ status, hasUnread, hasPermission }: { status: TabStatus; hasUnread: boolean; hasPermission: boolean }) {
  const colors = useColors()
  let bg: string = colors.statusIdle
  let pulse = false
  let glow = false

  if (status === 'dead' || status === 'failed') {
    bg = colors.statusError
  } else if (hasPermission) {
    bg = colors.statusPermission
    glow = true
  } else if (status === 'connecting' || status === 'running') {
    bg = colors.statusRunning
    pulse = true
  } else if (hasUnread) {
    bg = colors.statusComplete
  }

  return (
    <span
      className={`w-[6px] h-[6px] rounded-full flex-shrink-0 ${pulse ? 'animate-pulse-dot' : ''}`}
      style={{
        background: bg,
        ...(glow ? { boxShadow: `0 0 6px 2px ${colors.statusPermissionGlow}` } : {}),
      }}
    />
  )
}

export function TabStrip() {
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const selectTab = useSessionStore((s) => s.selectTab)
  const createTab = useSessionStore((s) => s.createTab)
  const closeTab = useSessionStore((s) => s.closeTab)
  const moveTab = useSessionStore((s) => s.moveTab)
  const renameTab = useSessionStore((s) => s.renameTab)
  const colors = useColors()
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const drag = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)

  // Drag a tab to reorder it; a press without movement is a normal click
  const onTabPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input')) return
    drag.current = { id, x: e.clientX, y: e.clientY, moved: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onTabPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return
    if (!d.moved) { d.moved = true; setDraggingId(d.id) }
    const over = document.elementsFromPoint(e.clientX, e.clientY)
      .map((el) => (el as HTMLElement).closest?.('[data-tab-id]') as HTMLElement | null)
      .find((el) => el && el.dataset.tabId !== d.id)
    if (over?.dataset.tabId) moveTab(d.id, over.dataset.tabId)
  }
  const onTabPointerUp = () => {
    if (drag.current?.moved) suppressClick.current = true
    drag.current = null
    setDraggingId(null)
  }

  const startRename = (id: string, title: string) => {
    setEditingId(id)
    setDraft(title)
  }
  const commitRename = () => {
    const id = editingId
    setEditingId(null)
    if (id && draft.trim()) void renameTab(id, draft)
  }

  return (
    <div
      data-clui-ui
      data-drag-handle
      className="flex items-center no-drag"
      style={{ padding: '8px 0' }}
    >
      {/* Scrollable tabs area — clipped by master card edge */}
      <div className="relative min-w-0 flex-1">
        <div
          className="flex items-center gap-1 overflow-x-auto min-w-0"
          style={{
            scrollbarWidth: 'none',
            paddingLeft: 8,
            // Extra right breathing room so clipped tabs fade out before the edge.
            paddingRight: 14,
            // Right-only content fade so the parent card's own animated background
            // shows through cleanly in both collapsed and expanded states.
            maskImage: 'linear-gradient(to right, black 0%, black calc(100% - 40px), transparent 100%)',
            WebkitMaskImage: 'linear-gradient(to right, black 0%, black calc(100% - 40px), transparent 100%)',
          }}
        >
          <AnimatePresence mode="popLayout">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId
              return (
                <motion.div
                  key={tab.id}
                  data-tab-id={tab.id}
                  layout
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: draggingId === tab.id ? 0.6 : 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.15 }}
                  onPointerDown={(e) => onTabPointerDown(e, tab.id)}
                  onPointerMove={onTabPointerMove}
                  onPointerUp={onTabPointerUp}
                  onPointerCancel={onTabPointerUp}
                  onClick={() => {
                    if (suppressClick.current) { suppressClick.current = false; return }
                    if (editingId !== tab.id) selectTab(tab.id)
                  }}
                  onDoubleClick={() => startRename(tab.id, tab.title)}
                  title="Double-click to rename · drag to reorder"
                  className="group flex items-center gap-1.5 cursor-pointer select-none flex-shrink-0 max-w-[160px] transition-all duration-150"
                  style={{
                    cursor: draggingId === tab.id ? 'grabbing' : 'pointer',
                    background: isActive ? colors.tabActive : 'transparent',
                    border: isActive ? `1px solid ${colors.tabActiveBorder}` : '1px solid transparent',
                    borderRadius: 9999,
                    padding: '4px 10px',
                    fontSize: 12,
                    color: isActive ? colors.textPrimary : colors.textTertiary,
                    fontWeight: isActive ? 500 : 400,
                  }}
                >
                  <StatusDot status={tab.status} hasUnread={tab.hasUnread} hasPermission={tab.permissionQueue.length > 0} />
                  {editingId === tab.id ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onFocus={(e) => e.currentTarget.select()}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                        if (e.key === 'Escape') { e.preventDefault(); setEditingId(null) }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      maxLength={200}
                      className="bg-transparent outline-none min-w-0 flex-1"
                      style={{ color: colors.textPrimary, fontSize: 12, width: 110 }}
                    />
                  ) : (
                    <span className="truncate flex-1">{tab.title}</span>
                  )}
                  {tabs.length > 1 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
                      className="flex-shrink-0 rounded-full w-4 h-4 flex items-center justify-center transition-opacity"
                      style={{
                        opacity: isActive ? 0.5 : 0,
                        color: colors.textSecondary,
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = isActive ? '0.5' : '0' }}
                    >
                      <X size={10} />
                    </button>
                  )}
                </motion.div>
              )
            })}
          </AnimatePresence>
        </div>
      </div>

      {/* Pinned action buttons — always visible on the right */}
      <div className="flex items-center gap-0.5 flex-shrink-0 ml-1 pr-2">
        <button
          onClick={() => createTab()}
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors"
          style={{ color: colors.textTertiary }}
          title="New tab"
        >
          <Plus size={14} />
        </button>

        <HistoryPicker />

        <SettingsPopover />

        <button
          onClick={() => window.clui.minimizeToBubble()}
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors"
          style={{ color: colors.textTertiary }}
          title="Minimize to floating button"
        >
          <Minus size={14} />
        </button>
      </div>
    </div>
  )
}
