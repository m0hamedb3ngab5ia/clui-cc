import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listSubagentsForTranscript, resetSubagentCache, STALE_AFTER_MS } from '../src/main/subagents.ts'

const T0 = Date.parse('2026-09-27T10:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const line = (o: object) => JSON.stringify(o) + '\n'

function assistant(at: number, content: object[], usage = { input_tokens: 2, cache_read_input_tokens: 90000, cache_creation_input_tokens: 5000, output_tokens: 200 }) {
  return line({ type: 'assistant', timestamp: iso(at), message: { model: 'claude-opus-5-5', usage, content } })
}

function setup() {
  resetSubagentCache()
  const root = mkdtempSync(join(tmpdir(), 'clui-sub-'))
  const session = join(root, 'sess.jsonl')
  const dir = join(root, 'sess', 'subagents')
  mkdirSync(dir, { recursive: true })
  const agent = (id: string, meta: object, body: string) => {
    writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta))
    writeFileSync(join(dir, `agent-${id}.jsonl`), body)
  }
  return { root, session, dir, agent, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('running, foreground-completed and background-completed agents', () => {
  const { session, agent, cleanup } = setup()
  try {
    agent('run1', { agentType: 'general-purpose', description: 'Push branch', model: 'opus' },
      line({ type: 'user', timestamp: iso(T0), message: { content: 'go' } })
      + assistant(T0 + 60_000, [{ type: 'tool_use', name: 'Read', input: { file_path: '/r/src/a.ts' } }])
      + assistant(T0 + 120_000, [{ type: 'tool_use', name: 'Bash', input: { command: 'git push', description: 'Pushing chore/ui-followup-nits branch' } }]))
    agent('fg1', { agentType: 'Explore', description: 'Find files' },
      line({ type: 'user', timestamp: iso(T0), message: { content: 'x' } })
      + assistant(T0 + 10_000, [{ type: 'text', text: 'done' }]))
    agent('bg1', { agentType: 'general-purpose', description: 'Review', spawnDepth: 2 },
      line({ type: 'user', timestamp: iso(T0), message: { content: 'x' } })
      + assistant(T0 + 20_000, [{ type: 'text', text: 'done' }]))
    writeFileSync(session,
      line({ type: 'user', timestamp: iso(T0 + 11_000), toolUseResult: { agentId: 'fg1', status: 'completed', totalDurationMs: 11000, totalTokens: 56150, totalToolUseCount: 8 } })
      + line({ type: 'user', timestamp: iso(T0 + 1_000), toolUseResult: { agentId: 'bg1', status: 'async_launched' } })
      + line({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(T0 + 21_000),
        content: '<task-notification>\n<task-id>bg1</task-id>\n<status>completed</status>\n<usage><subagent_tokens>70377</subagent_tokens><tool_uses>9</tool_uses><duration_ms>114529</duration_ms></usage>\n</task-notification>' }))

    const list = listSubagentsForTranscript(session, T0 + 450_000)
    const by = Object.fromEntries(list.map((a) => [a.agentId, a]))
    assert.equal(list[0].agentId, 'run1') // running first
    assert.equal(by.run1.status, 'running')
    assert.equal(by.run1.activity, 'Pushing chore/ui-followup-nits branch')
    assert.equal(by.run1.durationMs, 450_000)
    assert.equal(by.run1.tokens, 95202)
    assert.equal(by.run1.toolUses, 2)
    assert.equal(by.run1.model, 'opus')
    assert.deepEqual([by.fg1.status, by.fg1.tokens, by.fg1.durationMs, by.fg1.toolUses, by.fg1.activity], ['completed', 56150, 11000, 8, null])
    assert.deepEqual([by.bg1.status, by.bg1.tokens, by.bg1.durationMs, by.bg1.depth], ['completed', 70377, 114529, 2])
  } finally { cleanup() }
})

test('incremental reads pick up appended lines, partial lines and resumes', () => {
  const { session, dir, agent, cleanup } = setup()
  try {
    agent('a', { agentType: 'Plan', description: 'd' }, line({ type: 'user', timestamp: iso(T0), message: { content: 'x' } }))
    writeFileSync(session, '')
    let [a] = listSubagentsForTranscript(session, T0 + 1000)
    assert.equal(a.toolUses, 0)
    const next = assistant(T0 + 2000, [{ type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } }])
    appendFileSync(join(dir, 'agent-a.jsonl'), next.slice(0, 40)) // half-written line
    ;[a] = listSubagentsForTranscript(session, T0 + 3000)
    assert.equal(a.toolUses, 0)
    appendFileSync(join(dir, 'agent-a.jsonl'), next.slice(40))
    ;[a] = listSubagentsForTranscript(session, T0 + 3000)
    assert.equal(a.toolUses, 1); assert.equal(a.activity, 'Grep TODO')
    // Finishes, then is resumed (writes after its completion) -> running again
    appendFileSync(session, line({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(T0 + 5000), content: '<task-notification><task-id>a</task-id><status>completed</status></task-notification>' }))
    ;[a] = listSubagentsForTranscript(session, T0 + 6000)
    assert.equal(a.status, 'completed')
    appendFileSync(join(dir, 'agent-a.jsonl'), assistant(T0 + 60_000, [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]))
    ;[a] = listSubagentsForTranscript(session, T0 + 61_000)
    assert.equal(a.status, 'running'); assert.equal(a.activity, 'ls')
  } finally { cleanup() }
})

test('silent agents become stopped; killed maps to stopped, failed to failed', () => {
  const { session, agent, cleanup } = setup()
  try {
    agent('s', { agentType: 'x' }, line({ type: 'user', timestamp: iso(T0), message: { content: 'x' } }))
    agent('k', { agentType: 'x' }, line({ type: 'user', timestamp: iso(T0), message: { content: 'x' } }))
    agent('f', { agentType: 'x' }, line({ type: 'user', timestamp: iso(T0), message: { content: 'x' } }))
    writeFileSync(session,
      line({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(T0 + 5), content: '<task-notification><task-id>k</task-id><status>killed</status></task-notification>' })
      + line({ type: 'user', timestamp: iso(T0 + 5), toolUseResult: { agentId: 'f', status: 'failed' } }))
    const by = Object.fromEntries(listSubagentsForTranscript(session, T0 + STALE_AFTER_MS + 1).map((a) => [a.agentId, a.status]))
    assert.deepEqual(by, { s: 'stopped', k: 'stopped', f: 'failed' })
  } finally { cleanup() }
})

test('no subagents dir means no agents', () => {
  const { root, cleanup } = setup()
  try {
    assert.deepEqual(listSubagentsForTranscript(join(root, 'other.jsonl')), [])
  } finally { cleanup() }
})
