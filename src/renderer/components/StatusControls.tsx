import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { CaretDown, Check, Gauge } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { PERMISSION_MODES, EFFORT_LEVELS, permissionModeLabel, type PermissionMode, type EffortLevel } from '../../shared/permission-modes'
import { contextPercent, contextWindowFor } from '../../shared/context-meter'

// Same cues as the terminal's mode line
export const MODE_STYLE: Record<PermissionMode, { glyph: string; color: string | null }> = {
  default: { glyph: '◇', color: null },
  acceptEdits: { glyph: '⏵⏵', color: '#a78bfa' },
  plan: { glyph: '⏸', color: '#4fb3a9' },
  auto: { glyph: '⏵⏵', color: '#e0a040' },
}

/** Small anchored popover shared by the status bar pickers */
function usePopover() {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })
  const toggle = useCallback(() => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      setPos({ bottom: window.innerHeight - rect.top + 6, left: rect.left })
    }
    setOpen((o) => !o)
  }, [open])
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || popoverRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])
  return { open, setOpen, toggle, triggerRef, popoverRef, pos }
}

function PopoverShell({ pop, width, children }: { pop: ReturnType<typeof usePopover>; width: number; children: React.ReactNode }) {
  const popoverLayer = usePopoverLayer()
  const colors = useColors()
  if (!popoverLayer || !pop.open) return null
  return createPortal(
    <motion.div
      ref={pop.popoverRef}
      data-clui-ui
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.12 }}
      className="rounded-xl py-1"
      style={{
        position: 'fixed', bottom: pop.pos.bottom, left: pop.pos.left, width, pointerEvents: 'auto',
        background: colors.popoverBg, backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        boxShadow: colors.popoverShadow, border: `1px solid ${colors.popoverBorder}`,
      }}
    >
      {children}
    </motion.div>,
    popoverLayer,
  )
}

function MenuRow({ active, onClick, children, hint }: { active: boolean; onClick: () => void; children: React.ReactNode; hint?: string }) {
  const colors = useColors()
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] text-left transition-colors"
      style={{ color: active ? colors.textPrimary : colors.textSecondary, fontWeight: active ? 600 : 400 }}
      onMouseEnter={(e) => { e.currentTarget.style.background = colors.surfaceHover }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      <span className="flex flex-col min-w-0">
        <span className="flex items-center gap-1.5">{children}</span>
        {hint && <span className="text-[10px] font-normal truncate" style={{ color: colors.textTertiary }}>{hint}</span>}
      </span>
      {active && <Check size={12} style={{ color: colors.accent, flexShrink: 0 }} />}
    </button>
  )
}

function Divider() {
  const colors = useColors()
  return <div className="mx-2 my-0.5" style={{ height: 1, background: colors.popoverBorder }} />
}

/* ─── Permission mode (per chat; Shift+Tab cycles) ─── */

export function PermissionModePicker() {
  const mode = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.permissionMode ?? 'default')
  const defaultMode = useSessionStore((s) => s.defaultPermissionMode)
  const setTabPermissionMode = useSessionStore((s) => s.setTabPermissionMode)
  const setDefaultPermissionMode = useSessionStore((s) => s.setDefaultPermissionMode)
  const flash = useSessionStore((s) => s.modeFlash)
  const colors = useColors()
  const pop = usePopover()
  const [flashing, setFlashing] = useState(false)

  useEffect(() => {
    if (!flash) return
    setFlashing(true)
    const id = setTimeout(() => setFlashing(false), 900)
    return () => clearTimeout(id)
  }, [flash?.nonce])

  const style = MODE_STYLE[mode]
  const color = style.color ?? colors.textTertiary

  return (
    <>
      <button
        ref={pop.triggerRef}
        onClick={pop.toggle}
        className="flex items-center gap-1 text-[10px] rounded-full px-1.5 py-0.5 transition-all whitespace-nowrap flex-shrink-0"
        style={{
          color,
          cursor: 'pointer',
          background: flashing ? `${style.color ?? colors.accent}22` : 'transparent',
        }}
        title="Permission mode for this chat · Shift+Tab to cycle"
      >
        <span style={{ fontSize: 9, letterSpacing: -1 }}>{style.glyph}</span>
        {permissionModeLabel(mode)}
        <CaretDown size={10} style={{ opacity: 0.6 }} />
      </button>
      <PopoverShell pop={pop} width={230}>
        {PERMISSION_MODES.map((m) => (
          <MenuRow key={m.id} active={m.id === mode} hint={m.hint} onClick={() => { setTabPermissionMode(m.id); pop.setOpen(false) }}>
            <span style={{ color: MODE_STYLE[m.id].color ?? colors.textTertiary, fontSize: 9, width: 14 }}>{MODE_STYLE[m.id].glyph}</span>
            {m.label}
            {m.id === defaultMode && <span className="text-[9px] font-normal" style={{ color: colors.textTertiary }}>default</span>}
          </MenuRow>
        ))}
        <Divider />
        <button
          onClick={() => { setDefaultPermissionMode(mode); pop.setOpen(false) }}
          disabled={mode === defaultMode}
          className="w-full px-3 py-1.5 text-[11px] text-left"
          style={{ color: mode === defaultMode ? colors.textMuted : colors.accent, cursor: mode === defaultMode ? 'default' : 'pointer' }}
        >
          {mode === defaultMode ? `${permissionModeLabel(mode)} is the default for new chats` : `Use ${permissionModeLabel(mode)} for all new chats`}
        </button>
        <div className="px-3 pb-1 text-[9px]" style={{ color: colors.textMuted }}>Shift+Tab cycles modes</div>
      </PopoverShell>
    </>
  )
}

/* ─── Effort ─── */

export function EffortPicker({ compact = false }: { compact?: boolean }) {
  const effort = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.effort ?? null)
  const defaultEffort = useSessionStore((s) => s.defaultEffort)
  const setTabEffort = useSessionStore((s) => s.setTabEffort)
  const setDefaultEffort = useSessionStore((s) => s.setDefaultEffort)
  const colors = useColors()
  const pop = usePopover()
  const options: Array<EffortLevel | null> = [null, ...EFFORT_LEVELS]

  return (
    <>
      <button
        ref={pop.triggerRef}
        onClick={pop.toggle}
        className="flex items-center gap-0.5 text-[10px] rounded-full px-1.5 py-0.5 whitespace-nowrap flex-shrink-0"
        style={{ color: colors.textTertiary, cursor: 'pointer' }}
        title={`Effort for this chat: ${effort ?? 'default'} (--effort)`}
      >
        <Gauge size={11} />
        {effort ?? (compact ? null : 'effort')}
        {!compact && <CaretDown size={10} style={{ opacity: 0.6 }} />}
      </button>
      <PopoverShell pop={pop} width={170}>
        {options.map((o) => (
          <MenuRow key={o ?? 'default'} active={o === effort} onClick={() => { setTabEffort(o); pop.setOpen(false) }}>
            {o ?? 'Default'}
            {o === defaultEffort && <span className="text-[9px] font-normal" style={{ color: colors.textTertiary }}>default</span>}
          </MenuRow>
        ))}
        <Divider />
        <button
          onClick={() => { setDefaultEffort(effort); pop.setOpen(false) }}
          disabled={effort === defaultEffort}
          className="w-full px-3 py-1.5 text-[11px] text-left"
          style={{ color: effort === defaultEffort ? colors.textMuted : colors.accent }}
        >
          {effort === defaultEffort ? 'This is the default' : 'Use for all new chats'}
        </button>
      </PopoverShell>
    </>
  )
}

/* ─── Context + cost ─── */

function formatK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : `${n}`
}

export function ContextMeter({ compact = false }: { compact?: boolean }) {
  const tab = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const preferredModel = useSessionStore((s) => s.preferredModel)
  const defaultModelLabel = useSessionStore((s) => s.defaultModelLabel)
  const colors = useColors()
  if (!tab || (tab.contextTokens <= 0 && tab.totalCostUsd <= 0)) return null
  // Before the CLI reports the window, the chosen model (or the CLI default, e.g. "Opus 5.5 (1M context)") says it
  const modelHint = tab.sessionModel?.includes('[1m]') ? tab.sessionModel : (preferredModel || defaultModelLabel || tab.sessionModel)
  const window = contextWindowFor(modelHint, tab.contextWindow, tab.contextTokens)
  const pct = contextPercent(tab.contextTokens, window)
  const warn = pct >= 80
  const color = warn ? colors.statusRunning : colors.textTertiary
  const r = 5
  const c = 2 * Math.PI * r
  return (
    <span
      className="flex items-center gap-1 text-[10px] tabular-nums whitespace-nowrap flex-shrink-0"
      style={{ color }}
      title={`Context: ${formatK(tab.contextTokens)} / ${formatK(window)} tokens${warn ? '\nRunning low — try /compact' : ''}\nCost this tab: $${tab.totalCostUsd.toFixed(2)}`}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx="6" cy="6" r={r} fill="none" stroke={colors.popoverBorder} strokeWidth="2" />
        <circle cx="6" cy="6" r={r} fill="none" stroke={color} strokeWidth="2" strokeDasharray={`${(pct / 100) * c} ${c}`} />
      </svg>
      {pct}%
      {!compact && tab.totalCostUsd > 0 && <span style={{ color: colors.textMuted }}>· ${tab.totalCostUsd.toFixed(2)}</span>}
    </span>
  )
}

/* ─── Plan approval (plan-mode turn finished) ─── */

export function PlanApprovalBar() {
  const tab = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const approvePlan = useSessionStore((s) => s.approvePlan)
  const dismissPlan = useSessionStore((s) => s.dismissPlan)
  const colors = useColors()
  const show = !!tab?.planReady && tab.permissionMode === 'plan' && tab.status !== 'running' && tab.status !== 'connecting'
  const btn = (label: string, onClick: () => void, primary = false) => (
    <button
      onClick={onClick}
      className="px-2 py-0.5 rounded-md text-[11px] font-medium"
      style={{
        background: primary ? MODE_STYLE.plan.color! : 'transparent',
        color: primary ? '#fff' : colors.textSecondary,
        border: primary ? 'none' : `1px solid ${colors.popoverBorder}`,
      }}
    >
      {label}
    </button>
  )
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          data-clui-ui
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="flex items-center gap-2 px-4 py-1.5 flex-wrap"
          style={{ borderTop: `1px solid ${colors.popoverBorder}` }}
        >
          <span className="text-[11px] flex-1 min-w-0" style={{ color: MODE_STYLE.plan.color! }}>⏸ Plan ready — approve to start?</span>
          {btn('Approve · Auto', () => approvePlan('auto'), true)}
          {btn('Approve · Accept edits', () => approvePlan('acceptEdits'))}
          {btn('Approve · Manual', () => approvePlan('default'))}
          {btn('Keep planning', dismissPlan)}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
