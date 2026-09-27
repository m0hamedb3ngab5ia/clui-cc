import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { nextPermissionMode, hookPolicy, isPermissionMode, PERMISSION_MODES } from '../src/shared/permission-modes.ts'
import { modeArgs, setModeRequest } from '../src/main/claude/run-args.ts'
import { buildCommandList, filterCommands, parseFrontmatterDescription, SLASH_QUERY_RE } from '../src/shared/slash-commands.ts'
import { contextTokens, contextWindowFor, contextPercent, reportedContextWindow } from '../src/shared/context-meter.ts'
import { applyTodoToolUse, applyTaskCreated, allDone } from '../src/shared/todos.ts'
import { encodeProjectPath, renameSession, readSessionTitle, readCommandDescriptions } from '../src/main/sessions.ts'
import { normalize } from '../src/main/claude/event-normalizer.ts'

// ─── Permission modes ───

test('Shift+Tab cycles Manual → Accept edits → Plan → Auto → Manual', () => {
  assert.deepEqual(PERMISSION_MODES.map((m) => m.label), ['Manual', 'Accept edits', 'Plan', 'Auto'])
  assert.equal(nextPermissionMode('default'), 'acceptEdits')
  assert.equal(nextPermissionMode('acceptEdits'), 'plan')
  assert.equal(nextPermissionMode('plan'), 'auto')
  assert.equal(nextPermissionMode('auto'), 'default')
  assert.equal(isPermissionMode('bypassPermissions'), false)
})

test('hook prompts in manual, defers to the CLI in plan/auto, and only prompts for commands in accept-edits', () => {
  assert.equal(hookPolicy('default', 'Bash'), 'prompt')
  assert.equal(hookPolicy(undefined, 'Edit'), 'prompt')
  assert.equal(hookPolicy('plan', 'Write'), 'defer')
  assert.equal(hookPolicy('auto', 'Bash'), 'defer')
  assert.equal(hookPolicy('acceptEdits', 'Edit'), 'defer')
  assert.equal(hookPolicy('acceptEdits', 'Bash'), 'prompt')
})

test('run args carry --permission-mode and --effort; invalid values fall back safely', () => {
  assert.deepEqual(modeArgs({}), ['--permission-mode', 'default'])
  assert.deepEqual(modeArgs({ permissionMode: 'plan', effort: 'high' }), ['--permission-mode', 'plan', '--effort', 'high'])
  assert.deepEqual(modeArgs({ permissionMode: 'bypassPermissions', effort: 'turbo' }), ['--permission-mode', 'default'])
  assert.deepEqual(setModeRequest('auto', 'r1'), { type: 'control_request', request_id: 'r1', request: { subtype: 'set_permission_mode', mode: 'auto' } })
})

// ─── Slash commands ───

test('command list merges local, CLI and skill commands, hiding terminal-only ones', () => {
  const list = buildCommandList({
    cliCommands: ['compact', 'clear', 'doctor', 'rename', 'anthropic-skills:pdf', 'review'],
    terminalOnly: ['doctor'],
    skills: ['review', 'learn'],
    descriptions: { learn: 'Record a lesson' },
  })
  const names = list.map((c) => c.command)
  assert.equal(names.filter((n) => n === '/clear').length, 1, 'local /clear not duplicated')
  assert.ok(names.includes('/compact'))
  assert.ok(names.includes('/anthropic-skills:pdf'))
  assert.ok(!names.includes('/doctor'))
  assert.equal(list.find((c) => c.command === '/learn')?.description, 'Record a lesson')
  assert.equal(list.find((c) => c.command === '/compact')?.local, undefined)
  assert.equal(list.find((c) => c.command === '/rename')?.local, true)
})

test('slash query accepts plugin commands; filter ranks prefix hits first', () => {
  assert.ok(SLASH_QUERY_RE.test('/anthropic-skills:pdf'))
  assert.ok(SLASH_QUERY_RE.test('/'))
  assert.ok(!SLASH_QUERY_RE.test('/compact now'))
  const list = buildCommandList({ cliCommands: ['compact', 'anthropic-skills:pdf', 'context'] })
  assert.deepEqual(filterCommands(list, '/co').map((c) => c.command).slice(0, 3), ['/cost', '/compact', '/context'])
  assert.ok(filterCommands(list, '/pdf').some((c) => c.command === '/anthropic-skills:pdf'))
})

test('frontmatter description parsing', () => {
  assert.equal(parseFrontmatterDescription('---\nname: x\ndescription: "Does a thing"\n---\nbody'), 'Does a thing')
  assert.equal(parseFrontmatterDescription('no frontmatter'), null)
  assert.equal(parseFrontmatterDescription('---\ndescription: |\n  multi\n---'), null)
})

// ─── Context meter ───

test('context tokens follow the terminal formula and window comes from the CLI when known', () => {
  assert.equal(contextTokens({ input_tokens: 10, cache_read_input_tokens: 13689, cache_creation_input_tokens: 9876 }), 23575)
  assert.equal(contextWindowFor('claude-opus-5-5[1m]'), 1_000_000)
  assert.equal(contextWindowFor('claude-sonnet-5'), 200_000)
  assert.equal(contextWindowFor('claude-sonnet-5', 1_000_000), 1_000_000)
  assert.equal(contextPercent(50_000, 200_000), 25)
  assert.equal(contextPercent(900_000, 200_000), 100)
  assert.equal(reportedContextWindow({ 'claude-haiku-4-5': { contextWindow: 200000 }, 'claude-opus-5-5': { contextWindow: 1000000 } }), 1000000)
  assert.equal(reportedContextWindow(undefined), null)
})

// ─── Todos ───

test('TaskCreate results and TaskUpdate calls build the checklist', () => {
  let list = applyTaskCreated([], { id: '1', subject: 'alpha' })
  list = applyTaskCreated(list, { id: '2', subject: 'beta' })
  list = applyTaskCreated(list, { id: '2', subject: 'beta' })
  assert.equal(list.length, 2)
  list = applyTodoToolUse(list, 'TaskUpdate', { taskId: '1', status: 'in_progress', activeForm: 'Doing alpha' })
  assert.equal(list[0].status, 'in_progress')
  assert.equal(list[0].activeForm, 'Doing alpha')
  list = applyTodoToolUse(list, 'TaskUpdate', JSON.stringify({ taskId: '1', status: 'completed' }))
  list = applyTodoToolUse(list, 'TaskUpdate', { taskId: '2', status: 'deleted' })
  assert.deepEqual(list.map((t) => [t.id, t.status]), [['1', 'completed']])
  assert.ok(allDone(list))
  const same = applyTodoToolUse(list, 'Bash', { command: 'ls' })
  assert.equal(same, list)
})

test('TodoWrite replaces the whole list', () => {
  const list = applyTodoToolUse([], 'TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'weird' }] })
  assert.deepEqual(list.map((t) => t.status), ['completed', 'pending'])
})

// ─── Normalizer ───

test('normalizer surfaces slash commands, mode changes, compaction, context and created tasks', () => {
  const init = normalize({ type: 'system', subtype: 'init', session_id: 's', tools: [], mcp_servers: [], model: 'm', skills: [], claude_code_version: '2', slash_commands: ['compact'], terminal_slash_commands: ['doctor'], permissionMode: 'plan' } as any)
  assert.deepEqual((init[0] as any).slashCommands, ['compact'])
  assert.deepEqual((init[0] as any).terminalCommands, ['doctor'])
  assert.deepEqual(normalize({ type: 'system', subtype: 'status', permissionMode: 'auto' } as any), [{ type: 'permission_mode', mode: 'auto' }])
  assert.deepEqual(normalize({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 35611, post_tokens: 3292 } } as any), [{ type: 'compact_boundary', preTokens: 35611, postTokens: 3292 }])
  const asst = normalize({ type: 'assistant', parent_tool_use_id: null, message: { content: [], usage: { input_tokens: 5, cache_read_input_tokens: 95 } } } as any)
  assert.deepEqual(asst[1], { type: 'context_usage', tokens: 100 })
  const sub = normalize({ type: 'assistant', parent_tool_use_id: 'toolu_x', message: { content: [], usage: { input_tokens: 5 } } } as any)
  assert.equal(sub.length, 1, 'subagent turns do not move the main context meter')
  assert.deepEqual(normalize({ type: 'user', tool_use_result: { task: { id: '1', subject: 'alpha' } } } as any), [{ type: 'task_created', task: { id: '1', subject: 'alpha' } }])
  const done = normalize({ type: 'result', subtype: 'success', is_error: false, session_id: 's', modelUsage: { m: { contextWindow: 200000 } } } as any)
  assert.equal((done[0] as any).contextWindow, 200000)
})

// ─── Rename ───

const ID = '44444444-4444-4444-8444-444444444444'

function renameFixture(content: string) {
  const root = mkdtempSync(join(tmpdir(), 'clui-rename-'))
  const proj = '/Users/x/proj'
  mkdirSync(join(root, encodeProjectPath(proj)))
  const file = join(root, encodeProjectPath(proj), `${ID}.jsonl`)
  writeFileSync(file, content)
  return { root, proj, file }
}

test('rename appends a /rename-style custom-title record that becomes the title', async () => {
  const { root, proj, file } = renameFixture(JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', cwd: '/Users/x/proj', message: { content: 'hi' } }) + '\n' + JSON.stringify({ type: 'ai-title', aiTitle: 'Auto name' }) + '\n')
  try {
    assert.equal(renameSession(root, ID, '  My   chat ', proj), 'My chat')
    assert.equal(await readSessionTitle(root, ID, proj), 'My chat')
    renameSession(root, ID, 'Second name')
    assert.equal(await readSessionTitle(root, ID), 'Second name')
    const last = readFileSync(file, 'utf-8').trim().split('\n').pop()!
    assert.deepEqual(JSON.parse(last), { type: 'custom-title', customTitle: 'Second name', sessionId: ID })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rename handles a transcript without a trailing newline and rejects bad input', async () => {
  const { root, proj, file } = renameFixture(JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', cwd: '/Users/x/proj', message: { content: 'hi' } }))
  try {
    renameSession(root, ID, 'Fixed', proj)
    const lines = readFileSync(file, 'utf-8').trim().split('\n')
    assert.equal(lines.length, 2)
    lines.forEach((l) => JSON.parse(l))
    assert.throws(() => renameSession(root, ID, '   ', proj), /empty/)
    assert.throws(() => renameSession(root, '../etc', 'x'), /Invalid session id/)
    assert.throws(() => renameSession(root, '55555555-5555-4555-8555-555555555555', 'x'), /not found/)
    assert.equal(renameSession(root, ID, 'x'.repeat(500), proj).length, 200)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('command descriptions come from project and user commands and skills', () => {
  const home = mkdtempSync(join(tmpdir(), 'clui-home-'))
  const proj = mkdtempSync(join(tmpdir(), 'clui-proj-'))
  try {
    mkdirSync(join(home, 'commands'))
    mkdirSync(join(home, 'skills', 'learn'), { recursive: true })
    mkdirSync(join(proj, '.claude', 'commands'), { recursive: true })
    writeFileSync(join(home, 'commands', 'ship.md'), '---\ndescription: User ship\n---\n')
    writeFileSync(join(proj, '.claude', 'commands', 'ship.md'), '---\ndescription: Project ship\n---\n')
    writeFileSync(join(home, 'skills', 'learn', 'SKILL.md'), '---\nname: learn\ndescription: Record lessons\n---\n')
    const d = readCommandDescriptions(home, proj)
    assert.equal(d.ship, 'Project ship')
    assert.equal(d.learn, 'Record lessons')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  }
})

test('context window: "(1M context)" label and >200k usage both imply 1M', () => {
  assert.equal(contextWindowFor('Opus 5.5 (1M context)'), 1_000_000)
  assert.equal(contextWindowFor('claude-opus-5-5', null, 350_000), 1_000_000)
  assert.equal(contextWindowFor('claude-opus-5-5', null, 50_000), 200_000)
})

test('readLastContext returns the last main-thread assistant usage', async () => {
  const { readLastContext } = await import('../src/main/sessions.ts')
  const lines = [
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', cwd: '/Users/x/proj', message: { content: 'hi' } }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 90 } } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { usage: { input_tokens: 99999 } } }),
  ]
  const { root, proj } = renameFixture(lines.join('\n') + '\n')
  try {
    assert.deepEqual(readLastContext(root, ID, proj), { tokens: 1100, model: 'claude-opus-5-5' })
    assert.equal(readLastContext(root, '55555555-5555-4555-8555-555555555555'), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
