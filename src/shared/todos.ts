// Claude's task checklist, rebuilt from tool calls. Current CLIs use TaskCreate/TaskUpdate
// (ids come back in the TaskCreate result); older ones send the whole list via TodoWrite.
// Loaded by node's type stripping in tests.

export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

function asStatus(v: unknown): TodoItem['status'] {
  return v === 'in_progress' || v === 'completed' ? v : 'pending'
}

function asObject(input: unknown): Record<string, any> | null {
  let obj = input
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj) } catch { return null }
  }
  return obj && typeof obj === 'object' ? (obj as Record<string, any>) : null
}

/** Apply a tool_use (name + input) to the list. Returns the same array when nothing changed. */
export function applyTodoToolUse(list: TodoItem[], toolName: string, input: unknown): TodoItem[] {
  const obj = asObject(input)
  if (!obj) return list
  if (toolName === 'TodoWrite' && Array.isArray(obj.todos)) {
    return obj.todos
      .filter((t: any) => t && typeof t.content === 'string')
      .map((t: any, i: number) => ({
        id: String(t.id ?? i + 1),
        content: t.content,
        status: asStatus(t.status),
        ...(typeof t.activeForm === 'string' ? { activeForm: t.activeForm } : {}),
      }))
  }
  if (toolName === 'TaskUpdate' && obj.taskId != null) {
    const id = String(obj.taskId)
    if (obj.status === 'deleted') return list.filter((t) => t.id !== id)
    if (!list.some((t) => t.id === id)) return list
    return list.map((t) => t.id !== id ? t : {
      ...t,
      ...(obj.status ? { status: asStatus(obj.status) } : {}),
      ...(typeof obj.subject === 'string' ? { content: obj.subject } : {}),
      ...(typeof obj.activeForm === 'string' ? { activeForm: obj.activeForm } : {}),
    })
  }
  return list
}

/** Apply a TaskCreate result ({ task: { id, subject } }) from the CLI's tool_use_result */
export function applyTaskCreated(list: TodoItem[], task: { id: unknown; subject?: unknown; activeForm?: unknown }): TodoItem[] {
  if (task?.id == null || typeof task.subject !== 'string') return list
  const id = String(task.id)
  if (list.some((t) => t.id === id)) return list
  return [...list, { id, content: task.subject, status: 'pending', ...(typeof task.activeForm === 'string' ? { activeForm: task.activeForm } : {}) }]
}

export function allDone(list: TodoItem[]): boolean {
  return list.length > 0 && list.every((t) => t.status === 'completed')
}
