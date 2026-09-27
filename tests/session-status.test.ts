import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyEvent, markDead, prune, attentionCount, type StatusMap } from '../src/main/session-status/reducer.ts'
import { addCluiHooks, removeCluiHooks, hasCluiHooks, installTracking, uninstallTracking, isTrackingInstalled } from '../src/main/session-status/hook-installer.ts'
import { drainEvents, parseEventFile } from '../src/main/session-status/events.ts'

const SID = 'aaaaaaaa-1111-4111-8111-111111111111'
let t = 1000
const ev = (payload: Record<string, any>, pid: number | null = 42) =>
  ({ time: ++t, pid, payload: { session_id: SID, cwd: '/repo', ...payload } })

test('status transitions and notifications', () => {
  const m: StatusMap = {}
  const step = (p: Record<string, any>) => applyEvent(m, ev(p))
  assert.equal(step({ hook_event_name: 'SessionStart' }).changed?.status, 'idle')
  assert.equal(step({ hook_event_name: 'UserPromptSubmit' }).changed?.status, 'working')
  assert.equal(step({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }).changed, null)
  let r = step({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which DB?' }] } })
  assert.equal(r.changed?.status, 'asking'); assert.equal(r.notify, 'asking'); assert.equal(r.changed?.message, 'Which DB?')
  assert.equal(attentionCount(m), 1)
  assert.equal(step({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' }).changed?.status, 'working')
  r = step({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' })
  assert.equal(r.notify, 'needs_approval'); assert.equal(r.changed?.message, 'Wants to use Bash')
  // Same status again (the Notification that follows) must not notify twice
  r = step({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs permission' })
  assert.equal(r.changed?.status, 'needs_approval'); assert.equal(r.notify, null)
  step({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })
  r = step({ hook_event_name: 'Stop', last_assistant_message: 'All done.' })
  assert.equal(r.notify, 'finished'); assert.equal(r.changed?.message, 'All done.')
  // idle_prompt after finish keeps 'finished'
  assert.equal(step({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }).changed, null)
  assert.equal(m[SID].status, 'finished')
  assert.equal(step({ hook_event_name: 'SessionEnd' }).changed?.status, 'ended')
})

test('ignores stale, unknown and id-less events', () => {
  const m: StatusMap = {}
  applyEvent(m, { time: 500, pid: 1, payload: { session_id: SID, hook_event_name: 'Stop' } })
  assert.equal(applyEvent(m, { time: 400, pid: 1, payload: { session_id: SID, hook_event_name: 'UserPromptSubmit' } }).changed, null)
  assert.equal(applyEvent(m, { time: 600, pid: 1, payload: { hook_event_name: 'Stop' } }).changed, null)
  assert.equal(applyEvent(m, { time: 600, pid: 1, payload: { session_id: SID, hook_event_name: 'Weird' } }).changed, null)
  assert.equal(m[SID].status, 'finished')
})

test('markDead and prune', () => {
  const m: StatusMap = {}
  applyEvent(m, { time: 1, pid: 111, payload: { session_id: 'a', hook_event_name: 'UserPromptSubmit' } })
  applyEvent(m, { time: 1, pid: 222, payload: { session_id: 'b', hook_event_name: 'UserPromptSubmit' } })
  assert.deepEqual(markDead(m, (pid) => pid === 222, 50), ['a'])
  assert.equal(m.a.status, 'ended'); assert.equal(m.b.status, 'working')
  const day = 24 * 60 * 60 * 1000
  prune(m, 50 + day + 1)
  assert.equal(m.a, undefined); assert.ok(m.b)
  prune(m, 8 * day)
  assert.equal(m.b, undefined)
})

const userSettings = () => ({
  model: 'opus',
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo caveman' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'notify.sh' }] }],
  },
})

test('hook install is idempotent and preserves user hooks', () => {
  const once = addCluiHooks(userSettings(), '/h/.clui/hooks/clui-status-hook.sh')
  const twice = addCluiHooks(once, '/h/.clui/hooks/clui-status-hook.sh')
  assert.deepEqual(twice, once)
  assert.ok(hasCluiHooks(once))
  assert.equal(once.hooks.SessionStart[0].hooks[0].command, 'echo caveman')
  assert.equal(once.hooks.SessionStart.length, 2)
  assert.equal(once.hooks.PreToolUse[0].matcher, 'AskUserQuestion')
  assert.ok(once.hooks.Stop.every((g: any) => g.hooks.every((h: any) => !h.command.includes('clui') || h.async === true)))
  const removed = removeCluiHooks(once)
  assert.deepEqual(removed, userSettings())
  assert.ok(!hasCluiHooks(removed))
  assert.deepEqual(removeCluiHooks({ model: 'x' }), { model: 'x' })
  assert.deepEqual(removeCluiHooks(addCluiHooks({}, '/x/clui-status-hook.sh')), {})
})

test('installTracking writes script, backup, and refuses invalid JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clui-hooks-'))
  try {
    const settingsPath = join(dir, 'settings.json')
    const script = join(dir, 'hooks', 'clui-status-hook.sh')
    writeFileSync(settingsPath, JSON.stringify(userSettings(), null, 2))
    installTracking(settingsPath, script)
    assert.ok(isTrackingInstalled(settingsPath))
    assert.ok(existsSync(script))
    assert.deepEqual(JSON.parse(readFileSync(`${settingsPath}.clui-bak`, 'utf-8')), userSettings())
    uninstallTracking(settingsPath)
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf-8')), userSettings())
    writeFileSync(settingsPath, '{ broken')
    assert.throws(() => installTracking(settingsPath, script))
    assert.equal(readFileSync(settingsPath, 'utf-8'), '{ broken')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('drainEvents parses in order, deletes files, skips junk and tmp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clui-events-'))
  try {
    const put = (name: string, body: string, sec: number) => {
      writeFileSync(join(dir, name), body); utimesSync(join(dir, name), sec, sec)
    }
    put('b.json', JSON.stringify({ pid: 7, payload: { hook_event_name: 'Stop', session_id: 's' } }), 200)
    put('a.json', JSON.stringify({ pid: 7, payload: { hook_event_name: 'UserPromptSubmit', session_id: 's' } }), 100)
    put('c.json', '{"pid":7,"payload":', 300)
    put('.d.tmp', '{}', 50)
    const evs = drainEvents(dir)
    assert.deepEqual(evs.map((e) => e.payload.hook_event_name), ['UserPromptSubmit', 'Stop'])
    assert.equal(evs[0].pid, 7)
    assert.deepEqual(readdirSync(dir), ['.d.tmp'])
    assert.equal(parseEventFile('{"pid":1,"payload":{}}', 5)?.pid, null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('StatusTracker: backlog is silent, live events notify once', async () => {
  const { StatusTracker } = await import('../src/main/session-status/tracker.ts')
  const home = mkdtempSync(join(tmpdir(), 'clui-home-'))
  const events = join(home, 'events')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(events, { recursive: true })
  const put = (name: string, payload: object) =>
    writeFileSync(join(events, `${name}.json`), JSON.stringify({ pid: process.pid, payload }))
  const notes: string[] = []
  let last: Record<string, any> = {}
  const tracker = new StatusTracker(home, (m) => { last = m }, (s, k) => notes.push(`${s.sessionId}:${k}`), () => {})
  try {
    put('1', { session_id: 'old', hook_event_name: 'Stop' })
    tracker.start()
    assert.equal(last.old?.status, 'finished')
    assert.deepEqual(notes, [])
    put('2', { session_id: 'new', hook_event_name: 'UserPromptSubmit' })
    put('3', { session_id: 'new', hook_event_name: 'PermissionRequest', tool_name: 'Bash' })
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(last.new?.status, 'needs_approval')
    assert.deepEqual(notes, ['new:needs_approval'])
    assert.ok(existsSync(join(home, 'status.json')))
    assert.deepEqual(readdirSync(events), [])
  } finally {
    tracker.stop()
    rmSync(home, { recursive: true, force: true })
  }
})
