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
import { useUiHitRects } from './hooks/useUiHitRects'
import { gestureReduce, IDLE, type GestureState, type GestureEvent } from '../shared/gesture'

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

  const isExpanded = useSessionStore((s) => s.isExpanded)
  const marketplaceOpen = useSessionStore((s) => s.marketplaceOpen)
  const isRunning = activeTabStatus === 'running' || activeTabStatus === 'connecting'

  // Main hit-tests the cursor against these rects to decide OS-level click-through
  useUiHitRects()

  // Vertical position tracking — window moves first (until macOS clamps it), then CSS overflows
  const PILL_HEIGHT_CONST = 720
  const PILL_BOTTOM_MARGIN_CONST = 24
  const availTop = () => (window.screen as Screen & { availTop?: number }).availTop ?? 0
  const initialWindowY = () => availTop() + window.screen.availHeight - PILL_HEIGHT_CONST - PILL_BOTTOM_MARGIN_CONST
  const windowYRef = useRef(initialWindowY())
  const cardYRef = useRef(0) // CSS translateY offset (only used after window hits its y constraint)

  // ─── Gestures (window move, panel resize) ───
  // One reducer-driven state for both, so every way a gesture can end is handled in one place:
  // pointer up, a move with no button held (the up went to another app — this is a
  // non-activating panel), pointercancel, window blur, or a cancel from the main process.
  const gestureRef = useRef<GestureState>(IDLE)
  const captureRef = useRef<HTMLElement | null>(null)
  const resizeStartRef = useRef<{ width: number; bodyHeight: number } | null>(null)
  const resizeOriginRef = useRef({ x: 0, y: 0 })
  const [resizing, setResizing] = useState(false)
  const debug = (line: string) => window.clui.debugLog?.(line)

  const beginGesture = (el: HTMLElement, ev: Extract<GestureEvent, { type: 'down' }>) => {
    gestureRef.current = gestureReduce(gestureRef.current, ev).state
    captureRef.current = el
    try { el.setPointerCapture(ev.pointerId) } catch {}
    window.clui.setGestureActive?.(true, ev.kind)
    debug(`gesture start ${ev.kind}`)
  }
  const endGesture = (reason: string) => {
    if (gestureRef.current.kind === 'idle') return
    const { kind, pointerId } = gestureRef.current
    gestureRef.current = IDLE
    const el = captureRef.current
    captureRef.current = null
    if (el) { try { if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId) } catch {} }
    if (kind === 'resize') { resizeStartRef.current = null; setResizing(false) }
    window.clui.setGestureActive?.(false, reason)
    debug(`gesture end ${kind} ${reason}`)
  }

  // OS-level click-through fast path: main is authoritative (it polls the cursor against the
  // published rects); this only pre-empts it while the app is active and mousemove flows.
  useEffect(() => {
    if (!window.clui?.setIgnoreMouseEvents) return
    let lastIgnored: boolean | null = null
    const unsub = window.clui.onIgnoreState?.((ignored) => { lastIgnored = ignored })

    const onMouseMove = (e: MouseEvent) => {
      if (gestureRef.current.kind !== 'idle') return
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const shouldIgnore = !(el && el.closest('[data-clui-ui]'))
      if (shouldIgnore !== lastIgnored) {
        lastIgnored = shouldIgnore
        window.clui.setIgnoreMouseEvents(shouldIgnore, shouldIgnore ? { forward: true } : undefined)
      }
    }
    document.addEventListener('mousemove', onMouseMove)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      unsub?.()
    }
  }, [])

  // Native window must contain the panel (plus room for popovers and the side buttons)
  const syncWindowExtent = useCallback((size: { width: number; bodyHeight: number }) => {
    window.clui.setPanelExtent?.({ width: size.width + 340, height: size.bodyHeight + 320 })
      .then((b) => { if (b) windowYRef.current = b.y })
      .catch(() => {})
  }, [])
  useEffect(() => { syncWindowExtent(panel) }, [panelSizeCustom === null, expandedUI])

  // Window move: the tab bar's empty space drags the window; double-click resets position and size
  useEffect(() => {
    if (!window.clui?.startWindowDrag) return

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const el = e.target as HTMLElement
      // Tabs reorder, controls click, and the conversation stays free for text selection
      if (el.closest('button, input, textarea, a, select, [role="button"], [contenteditable], .cm-editor, [data-tab-id], [data-resize-handle]')) return
      const handle = el.closest('[data-drag-handle]') as HTMLElement | null
      if (!handle) return
      e.preventDefault()
      if (e.detail >= 2) {
        // Double-click: snap back to the default position and size
        endGesture('double-click')
        window.clui.resetWindowPosition()
        setPanelSize(null)
        windowYRef.current = initialWindowY()
        cardYRef.current = 0
        document.documentElement.style.setProperty('--clui-card-y', '0px')
        return
      }
      beginGesture(handle, { type: 'down', kind: 'move', pointerId: e.pointerId, x: e.screenX, y: e.screenY })
    }

    const moveWindow = (dx: number, dy: number) => {
      // Horizontal: always native window movement (full screen width range)
      if (dx !== 0) window.clui.startWindowDrag(dx, 0)
      // Vertical: move window first (until macOS y constraint), then CSS within window
      if (dy === 0) return
      const minWindowY = availTop()
      if (dy < 0) {
        const windowCanMove = windowYRef.current - minWindowY
        const windowDy = Math.max(-windowCanMove, dy)
        // The card slides inside the window only while its top edge stays visible;
        // past that the drag handle would be clipped and the window unrecoverable.
        const cardTop = document.querySelector('[data-clui-card]')?.getBoundingClientRect().top ?? 0
        const cssDy = Math.max(-Math.max(0, cardTop), dy - windowDy)
        if (windowDy !== 0) { window.clui.startWindowDrag(0, windowDy); windowYRef.current += windowDy }
        if (cssDy !== 0) { cardYRef.current += cssDy; document.documentElement.style.setProperty('--clui-card-y', `${cardYRef.current}px`) }
      } else {
        const cssUndo = Math.min(-cardYRef.current, dy)
        const windowDy = dy - cssUndo
        if (cssUndo !== 0) { cardYRef.current += cssUndo; document.documentElement.style.setProperty('--clui-card-y', `${cardYRef.current}px`) }
        if (windowDy !== 0) { window.clui.startWindowDrag(0, windowDy); windowYRef.current += windowDy }
      }
    }

    const onPointerMove = (e: PointerEvent) => {
      const before = gestureRef.current
      if (before.kind === 'idle') return
      const step = gestureReduce(before, { type: 'move', pointerId: e.pointerId, x: e.screenX, y: e.screenY, buttons: e.buttons })
      if (step.ended) { gestureRef.current = before; endGesture(step.ended); return }
      gestureRef.current = step.state
      if (step.dx === 0 && step.dy === 0) return
      if (before.kind === 'move') moveWindow(step.dx, step.dy)
      else if (before.kind === 'resize' && resizeStartRef.current && step.state.kind === 'resize') {
        const edge = String(step.state.data)
        const { x, y } = resizeOriginRef.current
        const tdx = e.screenX - x
        const tdy = e.screenY - y
        let { width, bodyHeight } = resizeStartRef.current
        if (edge.includes('right')) width += tdx * 2
        if (edge.includes('left')) width -= tdx * 2
        if (edge.includes('top')) bodyHeight -= tdy
        setPanelSize({ width, bodyHeight })
        syncWindowExtent({ width, bodyHeight })
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      const step = gestureReduce(gestureRef.current, { type: 'up', pointerId: e.pointerId })
      if (step.ended) endGesture(step.ended)
    }
    const onCancel = (reason: string) => () => endGesture(reason)
    const onBlur = onCancel('window-blur')
    const onPointerCancel = onCancel('pointercancel')
    const onVisibility = () => { if (document.visibilityState === 'hidden') endGesture('hidden') }
    const unsubCancel = window.clui.onCancelGestures?.((reason) => endGesture(`main:${reason}`))

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('pointercancel', onPointerCancel)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('pointercancel', onPointerCancel)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', onBlur)
      unsubCancel?.()
    }
  }, [])

  // Layout dimensions — full width or the user's dragged size
  const contentWidth = panel.width
  const cardExpandedWidth = panel.width
  const cardCollapsedWidth = panel.width - 30
  const cardCollapsedMargin = 15
  const bodyMaxHeight = panel.bodyHeight

  // Drag the card's edges to resize: sides change width (symmetric, the card is centered),
  // top changes height (the panel grows upward from the input bar). Moves are handled by the
  // shared document pointermove above; the resize handles unmount when the card collapses,
  // so that ends the gesture too.
  const onResizeDown = (edge: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    resizeStartRef.current = { ...panel }
    resizeOriginRef.current = { x: e.screenX, y: e.screenY }
    setResizing(true)
    beginGesture(e.currentTarget as HTMLElement, { type: 'down', kind: 'resize', pointerId: e.pointerId, x: e.screenX, y: e.screenY, data: edge })
  }
  useEffect(() => {
    if (!isExpanded && gestureRef.current.kind === 'resize') endGesture('handles-unmounted')
  }, [isExpanded])
  const resizeHandle = (edge: string, style: React.CSSProperties, cursor: string) => (
    <div
      key={edge}
      data-resize-handle
      onPointerDown={onResizeDown(edge)}
      title="Drag to resize · double-click the tab bar to reset"
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
              style={{ minHeight: 50, borderRadius: 25, padding: '0 6px 0 16px', background: colors.inputPillBg }}
            >
              <InputBar />
            </div>
          </div>
        </div>
      </div>
    </PopoverLayerProvider>
  )
}
