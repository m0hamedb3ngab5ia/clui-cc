import { PERMISSION_MODES } from '../../shared/permission-modes'
import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { DotsThree, Bell, ArrowsOutSimple, Moon, Pulse } from '@phosphor-icons/react'
import type { TrackingSettings } from '../../shared/types'
import { useThemeStore } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'

function RowToggle({
  checked,
  onChange,
  colors,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  colors: ReturnType<typeof useColors>
  label: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className="relative w-9 h-5 rounded-full transition-colors"
      style={{
        background: checked ? colors.accent : colors.surfaceSecondary,
        border: `1px solid ${checked ? colors.accent : colors.containerBorder}`,
      }}
    >
      <span
        className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full transition-all"
        style={{
          left: checked ? 18 : 2,
          background: '#fff',
        }}
      />
    </button>
  )
}

/* ─── Settings popover ─── */

export function SettingsPopover() {
  const soundEnabled = useThemeStore((s) => s.soundEnabled)
  const setSoundEnabled = useThemeStore((s) => s.setSoundEnabled)
  const themeMode = useThemeStore((s) => s.themeMode)
  const setThemeMode = useThemeStore((s) => s.setThemeMode)
  const expandedUI = useThemeStore((s) => s.expandedUI)
  const setExpandedUI = useThemeStore((s) => s.setExpandedUI)
  const isExpanded = useSessionStore((s) => s.isExpanded)
  const defaultPermissionMode = useSessionStore((s) => s.defaultPermissionMode)
  const setDefaultPermissionMode = useSessionStore((s) => s.setDefaultPermissionMode)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

  const [open, setOpen] = useState(false)
  const [tracking, setTracking] = useState<TrackingSettings | null>(null)
  const [trackingError, setTrackingError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    window.clui.getTracking().then(setTracking).catch(() => {})
  }, [open])

  const toggleTracking = async (next: boolean) => {
    setTrackingError(null)
    const res = await window.clui.setTracking(next)
    setTracking(res.settings)
    if (!res.ok) setTrackingError(res.error || 'Could not update ~/.claude/settings.json')
  }

  const setHop = async (prefs: { hopOnFinish?: boolean; hopOnInput?: boolean }) => {
    setTracking(await window.clui.setHopPrefs(prefs))
  }
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ right: number; top?: number; bottom?: number; maxHeight?: number }>({ right: 0 })

  const updatePos = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const gap = 6 // Match HistoryPicker spacing exactly.
    const margin = 8
    const right = window.innerWidth - rect.right

    if (isExpanded) {
      // Keep anchored below trigger (so it never covers the dots button),
      // and shrink if needed instead of shifting upward onto the trigger.
      const top = rect.bottom + gap
      setPos({
        top,
        right,
        maxHeight: Math.max(120, window.innerHeight - top - margin),
      })
      return
    }

    // Same logic as HistoryPicker for collapsed mode: open upward from trigger.
    setPos({
      bottom: window.innerHeight - rect.top + gap,
      right,
      maxHeight: undefined,
    })
  }, [isExpanded])

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

  useEffect(() => {
    if (!open) return
    const onResize = () => updatePos()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open, updatePos])

  // Keep panel tracking the trigger continuously while open so it follows
  // width/position animations of the top bar without feeling "stuck in space."
  useEffect(() => {
    if (!open) return
    let raf = 0
    const tick = () => {
      updatePos()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
  }, [open, expandedUI, isExpanded, updatePos])

  const handleToggle = () => {
    if (!open) updatePos()
    setOpen((o) => !o)
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors"
        style={{ color: colors.textTertiary }}
        title="Settings"
      >
        <DotsThree size={16} weight="bold" />
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
            width: 240,
            pointerEvents: 'auto',
            background: colors.popoverBg,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: colors.popoverShadow,
            border: `1px solid ${colors.popoverBorder}`,
            ...(pos.maxHeight != null ? { maxHeight: pos.maxHeight, overflowY: 'auto' as const } : {}),
          }}
        >
          <div className="p-3 flex flex-col gap-2.5">
            {/* Full width */}
            <div>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <ArrowsOutSimple size={14} style={{ color: colors.textTertiary }} />
                  <div className="text-[12px] font-medium" style={{ color: colors.textPrimary }}>
                    Full width
                  </div>
                </div>
                <RowToggle
                  checked={expandedUI}
                  onChange={(next) => {
                    setExpandedUI(next)
                  }}
                  colors={colors}
                  label="Toggle full width panel"
                />
              </div>
            </div>

            <div style={{ height: 1, background: colors.popoverBorder }} />

            {/* Default permission mode for new chats */}
            <div>
              <div className="text-[12px] font-medium mb-1" style={{ color: colors.textPrimary }}>
                Default mode for new chats
              </div>
              <div className="grid grid-cols-4 gap-1">
                {PERMISSION_MODES.map((m) => {
                  const active = m.id === defaultPermissionMode
                  return (
                    <button
                      key={m.id}
                      onClick={() => setDefaultPermissionMode(m.id)}
                      title={m.hint}
                      className="text-[10px] rounded-md py-1 transition-colors"
                      style={{
                        background: active ? colors.accentLight : 'transparent',
                        color: active ? colors.accent : colors.textSecondary,
                        border: `1px solid ${active ? colors.accent : colors.popoverBorder}`,
                        fontWeight: active ? 600 : 400,
                      }}
                    >
                      {m.label}
                    </button>
                  )
                })}
              </div>
              <div className="text-[10px] mt-1" style={{ color: colors.textTertiary }}>
                Each chat can still switch with Shift+Tab.
              </div>
            </div>

            <div style={{ height: 1, background: colors.popoverBorder }} />

            {/* Notification sound */}
            <div>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <Bell size={14} style={{ color: colors.textTertiary }} />
                  <div className="text-[12px] font-medium" style={{ color: colors.textPrimary }}>
                    Notification sound
                  </div>
                </div>
                <RowToggle
                  checked={soundEnabled}
                  onChange={setSoundEnabled}
                  colors={colors}
                  label="Toggle notification sound"
                />
              </div>
            </div>

            <div style={{ height: 1, background: colors.popoverBorder }} />

            {/* Track every Claude session (global hooks) */}
            <div>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <Pulse size={14} style={{ color: colors.textTertiary }} />
                  <div className="text-[12px] font-medium" style={{ color: colors.textPrimary }}>
                    Track all sessions
                  </div>
                </div>
                <RowToggle
                  checked={!!tracking?.installed}
                  onChange={(next) => { void toggleTracking(next) }}
                  colors={colors}
                  label="Toggle tracking of all Claude sessions"
                />
              </div>
              <div className="text-[10px] mt-1 leading-snug" style={{ color: trackingError ? colors.statusError : colors.textTertiary }}>
                {trackingError || 'Adds status hooks to ~/.claude/settings.json so terminal sessions show live status, and the minimized bubble hops when they need you.'}
              </div>
              {tracking?.installed && (
                <div className="flex flex-col gap-1.5 mt-2 pl-[22px]">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px]" style={{ color: colors.textSecondary }}>Bubble hops when a chat finishes</span>
                    <RowToggle
                      checked={tracking.hopOnFinish}
                      onChange={(next) => { void setHop({ hopOnFinish: next }) }}
                      colors={colors}
                      label="Toggle bubble hop when finished"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px]" style={{ color: colors.textSecondary }}>Bubble hops when it needs you</span>
                    <RowToggle
                      checked={tracking.hopOnInput}
                      onChange={(next) => { void setHop({ hopOnInput: next }) }}
                      colors={colors}
                      label="Toggle bubble hop when input is needed"
                    />
                  </div>
                </div>
              )}
            </div>

            <div style={{ height: 1, background: colors.popoverBorder }} />

            {/* Theme */}
            <div>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <Moon size={14} style={{ color: colors.textTertiary }} />
                  <div className="text-[12px] font-medium" style={{ color: colors.textPrimary }}>
                    Dark theme
                  </div>
                </div>
                <RowToggle
                  checked={themeMode === 'dark'}
                  onChange={(next) => setThemeMode(next ? 'dark' : 'light')}
                  colors={colors}
                  label="Toggle dark theme"
                />
              </div>
            </div>
          </div>
        </motion.div>,
        popoverLayer,
      )}
    </>
  )
}
