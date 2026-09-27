import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RemoteControlManager, chunkForTyping, classifyOutput, stripAnsi, type PtyLike } from '../src/main/claude/remote-control.ts'

function fakePty() {
  const data: Array<(d: string) => void> = []
  const exit: Array<(e: { exitCode: number }) => void> = []
  const written: string[] = []
  const killed: string[] = []
  const pty: PtyLike = {
    pid: 42,
    onData: (cb) => { data.push(cb) },
    onExit: (cb) => { exit.push(cb) },
    write: (d) => { written.push(d) },
    kill: (sig) => { killed.push(sig ?? 'SIGTERM') },
  }
  return { pty, written, killed, emit: (d: string) => data.forEach((cb) => cb(d)), exitWith: (code: number) => exit.forEach((cb) => cb({ exitCode: code })) }
}

function manager(fake: ReturnType<typeof fakePty>) {
  const events: Array<[string, any]> = []
  const spawned: string[][] = []
  const m = new RemoteControlManager({
    spawn: (args) => { spawned.push(args); return fake.pty },
    sessionFile: () => null,
    lineToMessages: () => [],
    log: () => {},
  })
  m.on('event', (tabId: string, e: unknown) => events.push([tabId, e]))
  return { m, events, spawned }
}

test('reads the session URL out of Ink output', () => {
  const raw = '\x1b[2K\x1b[G/remote-control is active \xb7 Continue here, on your phone, or at \x1b[4mhttps://claude.ai/code/session_015GJtgo\x1b[24m\r\n'
  assert.deepEqual(classifyOutput(stripAnsi(raw)), { url: 'https://claude.ai/code/session_015GJtgo' })
  assert.equal(classifyOutput('Loading…'), null)
})

test('recognises the ways the CLI can refuse, with or without the spaces Ink drops', () => {
  assert.match((classifyOutput('Quick safety check: Is this a project you created or one you trust?') as any).error, /trusted this folder/)
  assert.match((classifyOutput('Accessingworkspace:/Users/me Quicksafetycheck:Isthisaprojectyoucreated') as any).error, /trusted this folder/)
  assert.match((classifyOutput('Remote Control not started here') as any).error, /another terminal/)
  assert.match((classifyOutput('Enable Remote Control? (y/n)') as any).error, /one-time confirmation/)
})

test('start → active with the URL, typed messages get a carriage return, stop sends /exit', async () => {
  const fake = fakePty()
  const { m, events, spawned } = manager(fake)
  assert.deepEqual(m.start('tab1', { sessionId: 'abc', cwd: '/p', name: 'My chat', permissionMode: 'plan' }), { ok: true })
  assert.deepEqual(spawned[0], ['--resume', 'abc', '--remote-control=My chat', '--permission-mode', 'plan'])
  assert.deepEqual(events[0], ['tab1', { state: 'starting' }])
  assert.ok(!m.send('tab1', 'hi'), 'no typing before it is active')
  fake.emit('booting…')
  fake.emit('/remote-control is active · at https://claude.ai/code/session_x')
  assert.deepEqual(events[1], ['tab1', { state: 'active', url: 'https://claude.ai/code/session_x', name: 'My chat' }])
  assert.ok(m.isActive('tab1'))
  assert.ok(m.send('tab1', 'line one\nline two'))
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(fake.written.join(''), 'line one line two\r')
  assert.ok(fake.written.length > 2, 'typed in small chunks, Enter last')
  assert.deepEqual(m.start('tab1', { sessionId: 'abc', cwd: '/p', name: 'x' }), { ok: false, error: 'Remote Control is already on for this chat.' })
  assert.ok(m.stop('tab1', 'user'))
  assert.equal(fake.written.at(-1), '/exit\r')
  fake.exitWith(0)
  assert.deepEqual(events[2], ['tab1', { state: 'off', reason: 'stopped' }])
  assert.ok(!m.isActive('tab1'))
})

test('a refusal kills the process and reports the reason', () => {
  const fake = fakePty()
  const { m, events } = manager(fake)
  m.start('tab1', { sessionId: 'abc', cwd: '/p', name: 'x' })
  fake.emit('Remote Control not started here')
  assert.equal(events[1][1].state, 'error')
  assert.deepEqual(fake.killed, ['SIGKILL'])
  assert.ok(!m.isActive('tab1'))
})

test('an unexpected exit while active turns Remote Control off', () => {
  const fake = fakePty()
  const { m, events } = manager(fake)
  m.start('tab1', { sessionId: 'abc', cwd: '/p', name: 'x' })
  fake.emit('at https://claude.ai/code/session_y')
  fake.exitWith(1)
  assert.deepEqual(events[2], ['tab1', { state: 'off', reason: 'exited' }])
})

test('chunkForTyping keeps surrogate pairs whole and flattens newlines', () => {
  const chunks = chunkForTyping('1234567😀x\ny')
  assert.deepEqual(chunks, ['1234567😀', 'x y'])
  assert.ok(chunks.every((c) => !/[\uD800-\uDBFF]$/.test(c)))
})

test('a restart while the old pty is stopping kills it; its late exit does not emit off', () => {
  const fake = fakePty()
  const { m, events } = manager(fake)
  m.start('tab1', { sessionId: 'abc', cwd: '/p', name: 'x' })
  fake.emit('at https://claude.ai/code/session_y')
  m.stop('tab1', 'user')
  assert.ok(m.holdsSession('tab1'))
  assert.deepEqual(m.start('tab1', { sessionId: 'abc', cwd: '/p', name: 'x' }), { ok: true })
  assert.ok(fake.killed.includes('SIGKILL'))
  const n = events.length
  fake.exitWith(0) // both onExit callbacks fire on the shared fake; neither may report off
  assert.ok(!events.slice(n).some(([, e]) => e.state === 'off'))
  m.killAll()
})
