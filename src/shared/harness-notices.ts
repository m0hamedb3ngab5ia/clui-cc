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
  | ({ type: 'compact' } & AgentNotice)

// Claude Code's summary message after compacting a long conversation
const COMPACT_PREFIX = 'This session is being continued from a previous conversation'

// <agent-message> = a subagent/teammate in this session; <cross-session-message> = a separate Claude session
const ANY_BLOCK = /<task-notification>[\s\S]*?<\/task-notification>|<(agent-message|cross-session-message)((?:\s+[\w-]+="[^"]*")*)\s*>([\s\S]*?)<\/\1>/g
const AGENT_TAGS = ['<agent-message', '<cross-session-message']
// Harness text around those messages: a lead-in before and a safety note after (two wordings seen)
const LEAD_IN = /Another Claude session sent a message:\s*/g
const TRAILER = /(?:That "other Claude session" is|This came from another Claude session)[\s\S]*?permission laundering\.?/g

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\s${name}="([^"]*)"`))
  return m && m[1] ? m[1] : null
}
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

export function parseAgentBody(from: string | null, body: string, fromName: string | null = null): AgentNotice {
  let text = body
  let label = fromName ? `Message from ${fromName}` : 'Message from another Claude session'
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

/** True when text carries harness notices rather than something a person typed */
export function isHarnessText(text: string | null | undefined): boolean {
  return !!text && (text.includes('<task-notification>') || AGENT_TAGS.some((t) => text.includes(t)) || text.trimStart().startsWith(COMPACT_PREFIX))
}

/** Splits text into harness notices (in order) and whatever else the message said */
export function parseHarnessNotices(text: string): { notices: HarnessNotice[]; rest: string } {
  const notices: HarnessNotice[] = []
  // A compaction summary is one long harness message: collapse the whole thing
  if (text.trimStart().startsWith(COMPACT_PREFIX)) {
    notices.push({
      type: 'compact',
      from: null,
      label: 'Conversation compacted',
      summary: 'Earlier messages were summarized to free up context',
      report: text.trim(),
    })
    return { notices, rest: '' }
  }
  if (!isHarnessText(text)) return { notices, rest: text }
  let rest = text.replace(ANY_BLOCK, (block: string, _tag: string | undefined, attrs: string | undefined, body: string | undefined) => {
    if (block.startsWith('<task-notification>')) {
      for (const n of parseTaskNotifications(block).notifications) notices.push({ type: 'task', ...n })
    } else {
      notices.push({ type: 'agent', ...parseAgentBody(attr(attrs ?? '', 'from'), body ?? '', attr(attrs ?? '', 'from-name')) })
    }
    return '\n'
  })
  if (notices.some((n) => n.type === 'agent')) rest = rest.replace(LEAD_IN, '').replace(TRAILER, '')
  return { notices, rest: rest.trim() }
}
