import React, { useEffect, useCallback, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Paperclip, Camera, HeadCircuit, SpinnerGap } from '@phosphor-icons/react'
import { TabStrip } from './components/TabStrip'
import { ConversationView } from './components/ConversationView'
import { InputBar } from './components/InputBar'
import { StatusBar } from './components/StatusBar'
import { AgentsPanel } from './components/AgentsPanel'
import { TodoPanel } from './components/TodoPanel'
import { PlanApprovalBar } from './components/StatusControls'
import { MarketplacePanel } from './components/MarketplacePanel'
import { PopoverLayerProvider } from './components/PopoverLayer'
import { useClaudeEvents } from './hooks/useClaudeEvents'
import { useHealthReconciliation } from './hooks/useHealthReconciliation'
import { useSessionStore } from './stores/sessionStore'
import { useColors, useThemeStore, usePanelSize } from './theme'

const TRANSITION = { duration: 0.26, ease: [0.4, 0, 0.1, 1] as const }

export default function App() {
  useClaudeEvents()
  useHealthReconciliation()

  const activeTabStatus = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.status)
  const addAttachments = useSessionStore((s) => s.addAttachments)
  const colors = useColors()
  const setSystemTheme = useThemeStore((s) => s.setSystemTheme)
  const expandedUI = useThemeStore((s) => s.expandedUI)
  const panel = usePanelSize()
  const panelSizeCustom = useThemeStore((s) => s.panelSize)
  const setPanelSize = useThemeStore((s) => s.setPanelSize)

  // Cmd+T: new tab
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== 't') return
      e.preventDefault()
      void useSessionStore.getState().createTab()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ─── Theme initialization ───
  useEffect(() => {
    // Get initial OS theme — setSystemTheme respects themeMode (system/light/dark)
    window.clui.getTheme().then(({ isDark }) => {
      setSystemTheme(isDark)
    }).catch(() => {})

    // Listen for OS theme changes
    const unsub = window.clui.onThemeChange((isDark) => {
      setSystemTheme(isDark)
    })
    return unsub
  }, [setSystemTheme])

  useEffect(() => {
    // Model list from the installed CLI (cached in main; refreshes when the CLI updates)
    void useSessionStore.getState().loadModels()
    useSessionStore.getState().initStaticInfo().then(() => {
      const homeDir = useSessionStore.getState().staticInfo?.homePath || '~'
      const tab = useSessionStore.getState().tabs[0]
      if (tab) {
        // Set working directory to home by default (user hasn't chosen yet)
        useSessionStore.setState((s) => ({
          tabs: s.tabs.map((t, i) => (i === 0 ? { ...t, workingDirectory: homeDir, hasChosenDirectory: false } : t)),
        }))
        window.clui.createTab().then(({ tabId }) => {
          useSessionStore.setState((s) => ({
            tabs: s.tabs.map((t, i) => (i === 0 ? { ...t, id: tabId } : t)),
            activeTabId: tabId,
          }))
        }).catch(() => {}).then(() => useSessionStore.getState().restoreOpenTabs())
      } else {
        void useSessionStore.getState().restoreOpenTabs()
      }
    })
  }, [])

  // Shared drag ref — must be declared before the setIgnoreMouseEvents effect so both closures can read it
  const dragRef = useRef<{ startX: number; startY: number } | null>(null)

  // Vertical position tracking — window moves first (until macOS clamps it), then CSS overflows
  const PILL_HEIGHT_CONST = 720
  const PILL_BOTTOM_MARGIN_CONST = 24
  const minWindowY = window.screen.availTop   // top of work area (below menu bar)
  const initialWindowY = window.screen.availTop + window.screen.availHeight - PILL_HEIGHT_CONST - PILL_BOTTOM_MARGIN_CONST
  const windowYRef = useRef(initialWindowY)
  const cardYRef = useRef(0) // CSS translateY offset (only used after window hits its y constraint)

  // OS-level click-through (RAF-throttled to avoid per-pixel IPC)
  useEffect(() => {
    if (!window.clui?.setIgnoreMouseEvents) return
    let lastIgnored: boolean | null = null

    const onMouseMove = (e: MouseEvent) => {
      // While dragging or resizing, keep full mouse capture — don't toggle ignore-events
      if (dragRef.current || document.body.dataset.cluiResizing) return
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const isUI = !!(el && el.closest('[data-clui-ui]'))
      const shouldIgnore = !isUI
      if (shouldIgnore !== lastIgnored) {
        lastIgnored = shouldIgnore
        if (shouldIgnore) {
          window.clui.setIgnoreMouseEvents(true, { forward: true })
        } else {
          window.clui.setIgnoreMouseEvents(false)
        }
      }
    }

    const onMouseLeave = () => {
      if (dragRef.current) return
      if (lastIgnored !== true) {
        lastIgnored = true
        window.clui.setIgnoreMouseEvents(true, { forward: true })
      }
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseleave', onMouseLeave)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseleave', onMouseLeave)
    }
  }, [])


  // Manual window drag — bypasses -webkit-app-region conflicts with setIgnoreMouseEvents
  useEffect(() => {
    if (!window.clui?.startWindowDrag) return

    const onMouseDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement
      // Only the tab bar's empty space moves the window; tabs reorder, and the
      // conversation stays free for text selection
      if (el.closest('button, input, textarea, a, select, [role="button"], [contenteditable], .cm-editor, [data-tab-id]')) return
      if (!el.closest('[data-drag-handle]')) return
      e.preventDefault()
      // Double-click: snap back to default position
      if (e.detail >= 2) {
        window.clui.resetWindowPosition()
        windowYRef.current = initialWindowY
        cardYRef.current = 0
        document.documentElement.style.setProperty('--clui-card-y', '0px')
        return
      }
      // Ensure full mouse capture for the duration of the drag
      window.clui.setIgnoreMouseEvents(false)
      dragRef.current = { startX: e.screenX, startY: e.screenY }
    }

    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      const dx = e.screenX - dragRef.current.startX
      const dy = e.screenY - dragRef.current.startY
      if (dx !== 0 || dy !== 0) {
        // Horizontal: always native window movement (full screen width range)
        if (dx !== 0) window.clui.startWindowDrag(dx, 0)
        // Vertical: move window first (until macOS y constraint), then CSS within window
        if (dy !== 0) {
          if (dy < 0) {
            // Moving up — window first, then CSS overflow
            const windowCanMove = windowYRef.current - minWindowY
            const windowDy = Math.max(-windowCanMove, dy)
            // The card slides inside the window only while its top edge stays visible;
            // past that the drag handle would be clipped and the window unrecoverable.
            const cardTop = document.querySelector('[data-clui-card]')?.getBoundingClientRect().top ?? 0
            const cssDy = Math.max(-Math.max(0, cardTop), dy - windowDy)
            if (windowDy !== 0) {
              window.clui.startWindowDrag(0, windowDy)
              windowYRef.current += windowDy
            }
            if (cssDy !== 0) {
              cardYRef.current += cssDy
              document.documentElement.style.setProperty('--clui-card-y', `${cardYRef.current}px`)
            }
          } else {
            // Moving down — undo CSS first, then move window
            const cssUndo = Math.min(-cardYRef.current, dy)
            const windowDy = dy - cssUndo
            if (cssUndo !== 0) {
              cardYRef.current += cssUndo
              document.documentElement.style.setProperty('--clui-card-y', `${cardYRef.current}px`)
            }
            if (windowDy !== 0) {
              window.clui.startWindowDrag(0, windowDy)
              windowYRef.current += windowDy
            }
          }
        }
        dragRef.current.startX = e.screenX
        dragRef.current.startY = e.screenY
      }
    }

    const onMouseUp = () => {
      dragRef.current = null
    }

    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  const isExpanded = useSessionStore((s) => s.isExpanded)
  const marketplaceOpen = useSessionStore((s) => s.marketplaceOpen)
  const isRunning = activeTabStatus === 'running' || activeTabStatus === 'connecting'

  // Layout dimensions — full width or the user's dragged size
  const contentWidth = panel.width
  const cardExpandedWidth = panel.width
  const cardCollapsedWidth = panel.width - 30
  const cardCollapsedMargin = 15
  const bodyMaxHeight = panel.bodyHeight

  // Native window must contain the panel (plus room for popovers and the side buttons)
  const syncWindowExtent = useCallback((size: { width: number; bodyHeight: number }) => {
    window.clui.setPanelExtent?.({ width: size.width + 340, height: size.bodyHeight + 320 })
      .then((b) => { if (b) windowYRef.current = b.y })
      .catch(() => {})
  }, [])
  useEffect(() => { syncWindowExtent(panel) }, [panelSizeCustom === null, expandedUI])

  // Drag the card's edges to resize: sides change width (symmetric, the card is centered),
  // top changes height (the panel grows upward from the input bar)
  const [resizing, setResizing] = useState(false)
  const resizeRef = useRef<{ edge: string; x: number; y: number; start: { width: number; bodyHeight: number } } | null>(null)
  const onResizeDown = (edge: string) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    document.body.dataset.cluiResizing = '1'
    setResizing(true)
    window.clui.setIgnoreMouseEvents(false)
    resizeRef.current = { edge, x: e.screenX, y: e.screenY, start: { ...panel } }
  }
  const onResizeMove = (e: React.PointerEvent) => {
    const r = resizeRef.current
    if (!r) return
    const dx = e.screenX - r.x
    const dy = e.screenY - r.y
    let { width, bodyHeight } = r.start
    if (r.edge.includes('right')) width += dx * 2
    if (r.edge.includes('left')) width -= dx * 2
    if (r.edge.includes('top')) bodyHeight -= dy
    setPanelSize({ width, bodyHeight })
    syncWindowExtent({ width, bodyHeight })
  }
  const onResizeUp = () => {
    resizeRef.current = null
    delete document.body.dataset.cluiResizing
    setResizing(false)
  }
  const resizeHandle = (edge: string, style: React.CSSProperties, cursor: string) => (
    <div
      key={edge}
      onPointerDown={onResizeDown(edge)}
      onPointerMove={onResizeMove}
      onPointerUp={onResizeUp}
      onPointerCancel={onResizeUp}
      onDoubleClick={() => setPanelSize(null)}
      title="Drag to resize · double-click to reset"
      style={{ position: 'absolute', zIndex: 40, cursor, ...style }}
    />
  )

  const [capturing, setCapturing] = useState(false)
  const handleScreenshot = useCallback(async () => {
    setCapturing(true)
    try {
      const result = await window.clui.takeScreenshot()
      if (!result) return
      addAttachments([result])
    } finally {
      setCapturing(false)
    }
  }, [addAttachments])

  // While the picker is open, a second click cancels it (the main process kills it)
  const [picking, setPicking] = useState(false)
  const handleAttachFile = useCallback(async () => {
    setPicking(true)
    try {
      const files = await window.clui.attachFiles()
      if (!files || files.length === 0) return
      addAttachments(files)
    } finally {
      setPicking(false)
    }
  }, [addAttachments])

  return (
    <PopoverLayerProvider>
      <div className="flex flex-col justify-end h-full" style={{ background: 'transparent' }}>

        {/* ─── 460px content column, centered. Circles overflow left. ─── */}
        <div data-clui-card style={{ width: contentWidth, position: 'relative', margin: '0 auto', transition: resizing ? 'none' : 'width 0.26s cubic-bezier(0.4, 0, 0.1, 1)', transform: 'translateY(var(--clui-card-y, 0px))' }}>

          <AnimatePresence initial={false}>
            {marketplaceOpen && (
              <div
                data-clui-ui
                style={{
                  width: 720,
                  maxWidth: 720,
                  marginLeft: '50%',
                  transform: 'translateX(-50%)',
                  marginBottom: 14,
                  position: 'relative',
                  zIndex: 30,
                }}
              >
                <motion.div
                  initial={{ opacity: 0, y: 14, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.985 }}
                  transition={TRANSITION}
                >
                  <div
                    data-clui-ui
                    className="glass-surface overflow-hidden no-drag"
                    style={{
                      borderRadius: 24,
                      maxHeight: 470,
                    }}
                  >
                    <MarketplacePanel />
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>

          {/*
            ─── Tabs / message shell ───
            This always remains the chat shell. The marketplace is a separate
            panel rendered above it, never inside it.
          */}
          <motion.div
            data-clui-ui
            className="overflow-hidden flex flex-col drag-region"
            animate={{
              width: isExpanded ? cardExpandedWidth : cardCollapsedWidth,
              marginBottom: isExpanded ? 10 : -14,
              marginLeft: isExpanded ? 0 : cardCollapsedMargin,
              marginRight: isExpanded ? 0 : cardCollapsedMargin,
              background: isExpanded ? colors.containerBg : colors.containerBgCollapsed,
              borderColor: colors.containerBorder,
              boxShadow: isExpanded ? colors.cardShadow : colors.cardShadowCollapsed,
            }}
            transition={resizing ? { duration: 0 } : TRANSITION}
            style={{
              borderWidth: 1,
              borderStyle: 'solid',
              borderRadius: 20,
              position: 'relative',
              zIndex: isExpanded ? 20 : 10,
            }}
          >
            {/* Resize handles on the card's edges (while expanded) */}
            {isExpanded && [
              resizeHandle('left', { left: 0, top: 10, bottom: 10, width: 6 }, 'ew-resize'),
              resizeHandle('right', { right: 0, top: 10, bottom: 10, width: 6 }, 'ew-resize'),
              resizeHandle('top', { top: 0, left: 10, right: 10, height: 5 }, 'ns-resize'),
              resizeHandle('top-left', { top: 0, left: 0, width: 12, height: 12 }, 'nwse-resize'),
              resizeHandle('top-right', { top: 0, right: 0, width: 12, height: 12 }, 'nesw-resize'),
            ]}

            {/* Tab strip — always mounted */}
            <div className="no-drag">
              <TabStrip />
            </div>

            {/* Body — chat history only; the marketplace is a separate overlay above */}
            <motion.div
              initial={false}
              animate={{
                height: isExpanded ? 'auto' : 0,
                opacity: isExpanded ? 1 : 0,
              }}
              transition={TRANSITION}
              className="overflow-hidden no-drag"
            >
              {/* Fixed height, not content-sized: switching to a new or short tab must not
                  shrink the panel; only the collapse toggle (or a drag-resize) changes it */}
              <div className="flex flex-col" style={{ height: bodyMaxHeight }}>
                <ConversationView />
                <PlanApprovalBar />
                <TodoPanel />
                <AgentsPanel />
                <StatusBar />
              </div>
            </motion.div>
          </motion.div>

          {/* ─── Input row — circles float outside left ─── */}
          {/* marginBottom: shadow buffer so the glass-surface drop shadow isn't clipped at the native window edge */}
          <div
            data-clui-ui
            className="relative"
            style={{
              minHeight: 46, zIndex: 15, marginBottom: 10,
            }}
          >
            {/* Stacked circle buttons — expand on hover */}
            <div
              data-clui-ui
              className="circles-out"
            >
              <div className="btn-stack">
                {/* btn-1: Attach (front, rightmost) */}
                <button
                  className="stack-btn stack-btn-1 glass-surface"
                  title={picking ? 'Choosing files… click to cancel' : 'Attach file'}
                  onClick={handleAttachFile}
                  disabled={isRunning}
                  aria-busy={picking}
                >
                  {picking ? <SpinnerGap size={17} className="animate-spin" /> : <Paperclip size={17} />}
                </button>
                {/* btn-2: Screenshot (middle) */}
                <button
                  className="stack-btn stack-btn-2 glass-surface"
                  title="Take screenshot"
                  onClick={handleScreenshot}
                  disabled={isRunning || capturing}
                  aria-busy={capturing}
                >
                  {capturing ? <SpinnerGap size={17} className="animate-spin" /> : <Camera size={17} />}
                </button>
                {/* btn-3: Skills (back, leftmost) */}
                <button
                  className="stack-btn stack-btn-3 glass-surface"
                  title="Skills & Plugins"
                  onClick={() => useSessionStore.getState().toggleMarketplace()}
                  disabled={isRunning}
                >
                  <HeadCircuit size={17} />
                </button>
              </div>
            </div>

            {/* Input pill */}
            <div
              data-clui-ui
              className="glass-surface w-full"
              style={{ minHeight: 50, borderRadius: 25, padding: '0 6px 0 16px', background: colors.inputPillBg, cursor: 'text' }}
              // Anywhere on the pill (padding, empty row beside the send button) focuses the input
              onMouseDown={(e) => {
                const target = e.target as HTMLElement
                if (target.closest('textarea, input, button, a, [role="button"]')) return
                const ta = e.currentTarget.querySelector('textarea')
                if (!ta) return
                e.preventDefault()
                ta.focus()
                ta.setSelectionRange(ta.value.length, ta.value.length)
              }}
            >
              <InputBar />
            </div>
          </div>
        </div>
      </div>
    </PopoverLayerProvider>
  )
}
