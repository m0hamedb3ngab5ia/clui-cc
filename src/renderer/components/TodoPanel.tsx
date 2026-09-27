import React, { useEffect, useState } from 'react'
import { CaretDown, CaretRight } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { allDone } from '../../shared/todos'

const HIDE_AFTER_DONE_MS = 10_000

/** Claude's task checklist for the active tab, like the terminal's todo list */
export function TodoPanel() {
  const colors = useColors()
  const tab = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const [open, setOpen] = useState(true)
  const [hidden, setHidden] = useState(false)
  const todos = tab?.todos ?? []
  const done = allDone(todos)
  const idle = tab?.status !== 'running' && tab?.status !== 'connecting'

  // Once everything is checked off and the turn is over, fade the list away
  useEffect(() => {
    setHidden(false)
    if (!done || !idle) return
    const id = setTimeout(() => setHidden(true), HIDE_AFTER_DONE_MS)
    return () => clearTimeout(id)
  }, [done, idle, todos])

  if (todos.length === 0 || hidden) return null
  const completed = todos.filter((t) => t.status === 'completed').length

  return (
    <div className="px-4 pt-1.5 pb-1 flex-shrink-0" style={{ borderTop: `1px solid ${colors.popoverBorder}` }} data-clui-ui>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide"
        style={{ color: colors.textTertiary }}
      >
        {open ? <CaretDown size={10} /> : <CaretRight size={10} />}
        Tasks · {completed}/{todos.length}
      </button>
      {open && (
        <div className="mt-1 overflow-y-auto conversation-selectable" style={{ maxHeight: 120 }}>
          {todos.map((t) => {
            const active = t.status === 'in_progress'
            const glyph = t.status === 'completed' ? '☑' : active ? '◐' : '☐'
            return (
              <div key={t.id} className="flex items-start gap-2 py-[2px] text-[11px]">
                <span className="flex-shrink-0 w-3 text-center" style={{ color: active ? colors.statusRunning : t.status === 'completed' ? colors.statusComplete : colors.textTertiary }}>{glyph}</span>
                <span
                  className="min-w-0"
                  style={{
                    color: t.status === 'completed' ? colors.textTertiary : colors.textPrimary,
                    fontWeight: active ? 600 : 400,
                    textDecoration: t.status === 'completed' ? 'line-through' : 'none',
                  }}
                >
                  {active && t.activeForm ? t.activeForm : t.content}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
