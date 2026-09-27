// Claude Code injects <task-notification> blocks into the conversation when a
// background command or subagent finishes. Parse them so the UI can show a
// readable status line instead of raw XML.
// Loaded by node's type stripping in tests.

export interface TaskNotification {
  status: string
  summary: string
  taskId: string | null
  outputFile: string | null
  /** A subagent's final report, when included */
  result: string | null
}

const BLOCK = /<task-notification>([\s\S]*?)<\/task-notification>/g

function field(body: string, tag: string): string | null {
  const m = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  const v = m?.[1].trim()
  return v ? v : null
}

/** Splits text into its task notifications and whatever else the message said */
export function parseTaskNotifications(text: string): { notifications: TaskNotification[]; rest: string } {
  const notifications: TaskNotification[] = []
  if (!text.includes('<task-notification>')) return { notifications, rest: text }
  const rest = text.replace(BLOCK, (_all, body: string) => {
    const status = field(body, 'status') || 'completed'
    notifications.push({
      status,
      summary: field(body, 'summary') || `Background task ${status}`,
      taskId: field(body, 'task-id'),
      outputFile: field(body, 'output-file'),
      result: field(body, 'result'),
    })
    return ''
  }).trim()
  return { notifications, rest }
}

export type TaskTone = 'ok' | 'error' | 'neutral'

export function taskTone(status: string): TaskTone {
  const s = status.toLowerCase()
  if (s === 'completed' || s === 'success' || s === 'done') return 'ok'
  if (s === 'failed' || s === 'error' || s === 'killed' || s === 'cancelled' || s === 'canceled' || s === 'timeout') return 'error'
  return 'neutral'
}
