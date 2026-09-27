import React, { useEffect, useState } from 'react'
import { CaretDown, CaretRight } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import type { SubagentInfo } from '../../shared/types'

const POLL_MS = 2000
const COLLAPSED_LIMIT = 5

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** Polls a session's subagents while mounted. */
export function useSubagents(sessionId: string | null | undefined, projectPath?: string | null): SubagentInfo[] {
  const [agents, setAgents] = useState<SubagentInfo[]>([])
  useEffect(() => {
    if (!sessionId) { setAgents([]); return }
    let alive = true
    const load = () => {
      window.clui.listSubagents(sessionId, projectPath ?? undefined)
        .then((list) => { if (alive) setAgents(list) })
        .catch(() => {})
    }
    load()
    const id = setInterval(load, POLL_MS)
    return () => { alive = false; clearInterval(id) }
  }, [sessionId, projectPath])
  return agents
}

/** Re-render every second while something is running, so elapsed times tick like the terminal. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

export function AgentList({ agents, limit }: { agents: SubagentInfo[]; limit?: number }) {
  const colors = useColors()
  const running = agents.some((a) => a.status === 'running')
  const now = useNow(running)
  const [showAll, setShowAll] = useState(false)
  const shown = limit && !showAll ? agents.slice(0, limit) : agents

  const glyph = (a: SubagentInfo) => {
    if (a.status === 'running') {
      return <span className="clui-agent-pulse" style={{ width: 7, height: 7, borderRadius: '50%', background: colors.statusRunning, display: 'inline-block' }} />
    }
    const [ch, color] = a.status === 'completed' ? ['✓', colors.statusComplete]
      : a.status === 'failed' ? ['✗', colors.statusError]
      : ['■', colors.statusIdle]
    return <span style={{ color, fontSize: 10, lineHeight: 1 }}>{ch}</span>
  }

  return (
    <div className="flex flex-col">
      <style>{'@keyframes clui-agent-pulse{0%,100%{opacity:1}50%{opacity:.35}} .clui-agent-pulse{animation:clui-agent-pulse 1.2s ease-in-out infinite}'}</style>
      {shown.map((a) => {
        const elapsed = a.status === 'running' ? now - a.startedAt : a.durationMs
        const line = (a.status === 'running' && a.activity) || a.description
        return (
          <div
            key={a.agentId}
            className="flex items-center gap-2 py-[3px] text-[11px] min-w-0"
            style={{ paddingLeft: (a.depth - 1) * 12 }}
            title={[a.description, a.model, `${a.toolUses} tool uses`].filter(Boolean).join(' · ')}
          >
            <span className="flex-shrink-0 w-3 flex items-center justify-center">{glyph(a)}</span>
            <span className="flex-shrink-0 font-medium" style={{ color: colors.textPrimary }}>{a.agentType}</span>
            <span className="truncate min-w-0 flex-1" style={{ color: colors.textSecondary }}>{line}</span>
            <span className="flex-shrink-0 tabular-nums text-[10px]" style={{ color: colors.textTertiary }}>
              {formatDuration(elapsed)} · ↓ {formatTokens(a.tokens)} tokens
            </span>
          </div>
        )
      })}
      {limit && agents.length > limit && (
        <button
          onClick={(e) => { e.stopPropagation(); setShowAll((v) => !v) }}
          className="self-start text-[10px] py-0.5"
          style={{ color: colors.textTertiary }}
        >
          {showAll ? 'Show fewer' : `+${agents.length - limit} more`}
        </button>
      )}
    </div>
  )
}

/** Agent tree for the active tab, shown above the status bar like the terminal's agent list. */
export function AgentsPanel() {
  const colors = useColors()
  const tab = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const agents = useSubagents(tab?.claudeSessionId, tab?.workingDirectory)
  const [open, setOpen] = useState(true)
  if (agents.length === 0) return null
  const running = agents.filter((a) => a.status === 'running').length

  return (
    <div className="px-4 pt-1.5 pb-1" style={{ borderTop: `1px solid ${colors.popoverBorder}` }} data-clui-ui>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide"
        style={{ color: colors.textTertiary }}
      >
        {open ? <CaretDown size={10} /> : <CaretRight size={10} />}
        Agents · {running > 0 ? `${running} running` : `${agents.length} done`}
      </button>
      {open && <div className="mt-1"><AgentList agents={agents} limit={COLLAPSED_LIMIT} /></div>}
    </div>
  )
}
