// Claude Code injects harness messages into the conversation: <task-notification>
// when a background command finishes, and <agent-message> when a subagent or
// teammate reports back (wrapped in safety boilerplate). Turn both into short,
// readable notices; the full text stays available behind a toggle.
// Loaded by node's type stripping in tests.

import { parseTaskNotifications, type TaskNotification } from './task-notification'

export interface AgentNotice {
  from: string | null
  /** Human label, e.g. "Subagent report" */
  label: string
  /** One-line gist of the report */
  summary: string
  /** Full report, boilerplate removed */
  report: string
}

export type HarnessNotice =
  | ({ type: 'task' } & TaskNotification)
  | ({ type: 'agent' } & AgentNotice)

const ANY_BLOCK = /<task-notification>[\s\S]*?<\/task-notification>|<agent-message(?:\s+from="([^"]*)")?\s*>([\s\S]*?)<\/agent-message>/g
// Harness text around an agent message: a lead-in before it and a safety note after it
const LEAD_IN = /Another Claude session sent a message:\s*/g
const TRAILER = /That "other Claude session" is[\s\S]*?permission laundering\.?/g
// Keep the newline after the marker so the report's shared indent can be removed
const REPORT_MARKER = /The report follows:[ \t]*/
const SUMMARY_MAX = 160

const LABELS: Record<string, string> = {
  'subagent hand-back': 'Subagent report',
}

function dedent(text: string): string {
  const lines = text.replace(/^\n+|\s+$/g, '').split('\n')
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)![0].length)
  const cut = indents.length ? Math.min(...indents) : 0
  return lines.map((l) => l.slice(cut)).join('\n').trim()
}

export function summarize(report: string, max = SUMMARY_MAX): string {
  const first = report.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  if (first.length <= max) return first
  // Prefer ending at a sentence or clause boundary inside the limit
  const window = first.slice(0, max)
  // A whole sentence reads best; the rest is one click away
  const sentence = window.lastIndexOf('. ')
  if (sentence > max * 0.4) return window.slice(0, sentence + 1)
  const clause = Math.max(window.lastIndexOf('; '), window.lastIndexOf(', '))
  return (clause > max * 0.5 ? window.slice(0, clause) : window.replace(/\s+\S*$/, '')) + '…'
}

export function parseAgentBody(from: string | null, body: string): AgentNotice {
  let text = body
  let label = 'Message from another Claude session'
  const tag = text.trim().match(/^\[([^\]]+)\]/)
  if (tag) {
    label = LABELS[tag[1].toLowerCase()] ?? tag[1]
    text = text.trim().slice(tag[0].length)
  }
  // Drop the safety preamble; keep only the agent's own words
  const marker = text.match(REPORT_MARKER)
  if (marker && marker.index !== undefined) text = text.slice(marker.index + marker[0].length)
  const report = dedent(text)
  return { from, label, summary: summarize(report) || label, report }
}

/** Splits text into harness notices (in order) and whatever else the message said */
export function parseHarnessNotices(text: string): { notices: HarnessNotice[]; rest: string } {
  const notices: HarnessNotice[] = []
  if (!text.includes('<task-notification>') && !text.includes('<agent-message')) return { notices, rest: text }
  let rest = text.replace(ANY_BLOCK, (block: string, from: string | undefined, body: string | undefined) => {
    if (block.startsWith('<task-notification>')) {
      for (const n of parseTaskNotifications(block).notifications) notices.push({ type: 'task', ...n })
    } else {
      notices.push({ type: 'agent', ...parseAgentBody(from ?? null, body ?? '') })
    }
    return '\n'
  })
  if (notices.some((n) => n.type === 'agent')) rest = rest.replace(LEAD_IN, '').replace(TRAILER, '')
  return { notices, rest: rest.trim() }
}
