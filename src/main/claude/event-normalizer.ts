import type {
  ClaudeEvent,
  NormalizedEvent,
  StreamEvent,
  InitEvent,
  AssistantEvent,
  ResultEvent,
  RateLimitEvent,
  PermissionEvent,
  ContentDelta,
} from '../../shared/types'
import { contextTokens, reportedContextWindow } from '../../shared/context-meter'
import { isHarnessText } from '../../shared/harness-notices'

/**
 * Maps raw Claude stream-json events to canonical CLUI events.
 *
 * The normalizer is stateless — it takes one raw event and returns
 * zero or more normalized events. The caller (RunManager) is responsible
 * for sequencing and routing.
 */
export function normalize(raw: ClaudeEvent): NormalizedEvent[] {
  switch (raw.type) {
    case 'system':
      return normalizeSystem(raw as InitEvent)

    case 'stream_event':
      return normalizeStreamEvent(raw as StreamEvent)

    case 'assistant':
      return normalizeAssistant(raw as AssistantEvent)

    case 'result':
      return normalizeResult(raw as ResultEvent)

    case 'rate_limit_event':
      return normalizeRateLimit(raw as RateLimitEvent)

    case 'permission_request':
      return normalizePermission(raw as PermissionEvent)

    case 'user':
      return normalizeUser(raw as any)

    default:
      // Unknown event type — skip silently (defensive)
      return []
  }
}

function normalizeSystem(event: InitEvent): NormalizedEvent[] {
  const sys = event as any
  // Mode changes (e.g. after a set_permission_mode control request)
  if (sys.subtype === 'status' && typeof sys.permissionMode === 'string') {
    return [{ type: 'permission_mode', mode: sys.permissionMode }]
  }
  if (sys.subtype === 'compact_boundary') {
    const meta = sys.compact_metadata || {}
    return [{
      type: 'compact_boundary',
      preTokens: typeof meta.pre_tokens === 'number' ? meta.pre_tokens : null,
      postTokens: typeof meta.post_tokens === 'number' ? meta.post_tokens : null,
    }]
  }
  if (event.subtype !== 'init') return []

  return [{
    type: 'session_init',
    sessionId: event.session_id,
    tools: event.tools || [],
    model: event.model || 'unknown',
    mcpServers: event.mcp_servers || [],
    skills: event.skills || [],
    version: event.claude_code_version || 'unknown',
    slashCommands: Array.isArray(event.slash_commands) ? event.slash_commands : [],
    terminalCommands: Array.isArray(event.terminal_slash_commands) ? event.terminal_slash_commands : [],
    ...(typeof event.permissionMode === 'string' ? { permissionMode: event.permissionMode } : {}),
  }]
}

/** Tool results the UI cares about: TaskCreate returns the new task's id */
function normalizeUser(event: { tool_use_result?: any; message?: { content?: unknown } }): NormalizedEvent[] {
  const task = event.tool_use_result?.task
  if (task && task.id != null && typeof task.subject === 'string') {
    return [{
      type: 'task_created',
      task: { id: String(task.id), subject: task.subject, ...(typeof task.activeForm === 'string' ? { activeForm: task.activeForm } : {}) },
    }]
  }
  // A background task or subagent reporting back mid-run: surface it live
  const content = event.message?.content
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
      : ''
  if (isHarnessText(text)) return [{ type: 'harness_notice', text }]
  return []
}

function normalizeStreamEvent(event: StreamEvent): NormalizedEvent[] {
  const sub = event.event
  if (!sub) return []

  switch (sub.type) {
    case 'content_block_start': {
      if (sub.content_block.type === 'tool_use') {
        return [{
          type: 'tool_call',
          toolName: sub.content_block.name || 'unknown',
          toolId: sub.content_block.id || '',
          index: sub.index,
        }]
      }
      // text block start — no event needed, text comes via deltas
      return []
    }

    case 'content_block_delta': {
      const delta = sub.delta as ContentDelta
      if (delta.type === 'text_delta') {
        return [{ type: 'text_chunk', text: delta.text }]
      }
      if (delta.type === 'input_json_delta') {
        return [{
          type: 'tool_call_update',
          toolId: '', // caller can associate via index tracking
          partialInput: delta.partial_json,
        }]
      }
      return []
    }

    case 'content_block_stop': {
      return [{
        type: 'tool_call_complete',
        index: sub.index,
      }]
    }

    case 'message_start':
    case 'message_delta':
    case 'message_stop':
      // These are structural events — the assembled `assistant` event handles message completion
      return []

    default:
      return []
  }
}

function normalizeAssistant(event: AssistantEvent): NormalizedEvent[] {
  const out: NormalizedEvent[] = [{
    type: 'task_update',
    message: event.message,
  }]
  // Context meter follows the main conversation only, not subagents
  if (!event.parent_tool_use_id && event.message?.usage) {
    const tokens = contextTokens(event.message.usage)
    if (tokens > 0) out.push({ type: 'context_usage', tokens })
  }
  return out
}

function normalizeResult(event: ResultEvent): NormalizedEvent[] {
  if (event.is_error || event.subtype === 'error') {
    return [{
      type: 'error',
      message: event.result || 'Unknown error',
      isError: true,
      sessionId: event.session_id,
    }]
  }

  const denials = Array.isArray((event as any).permission_denials)
    ? (event as any).permission_denials.map((d: any) => ({
        toolName: d.tool_name || '',
        toolUseId: d.tool_use_id || '',
      }))
    : undefined

  return [{
    type: 'task_complete',
    result: event.result || '',
    costUsd: event.total_cost_usd || 0,
    durationMs: event.duration_ms || 0,
    numTurns: event.num_turns || 0,
    usage: event.usage || {},
    sessionId: event.session_id,
    contextWindow: reportedContextWindow((event as any).modelUsage),
    ...(denials && denials.length > 0 ? { permissionDenials: denials } : {}),
  }]
}

function normalizeRateLimit(event: RateLimitEvent): NormalizedEvent[] {
  const info = event.rate_limit_info
  if (!info) return []

  return [{
    type: 'rate_limit',
    status: info.status,
    resetsAt: info.resetsAt,
    rateLimitType: info.rateLimitType,
  }]
}

function normalizePermission(event: PermissionEvent): NormalizedEvent[] {
  return [{
    type: 'permission_request',
    questionId: event.question_id,
    toolName: event.tool?.name || 'unknown',
    toolDescription: event.tool?.description,
    toolInput: event.tool?.input,
    options: (event.options || []).map((o) => ({
      id: o.id,
      label: o.label,
      kind: o.kind,
    })),
  }]
}
