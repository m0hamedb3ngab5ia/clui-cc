import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planOpen, osascriptArgs, OPEN_SCRIPT, MARKER_PREFIX } from '../src/main/terminal-open.ts'

const SID = '12345678-1234-1234-1234-123456789abc'

test('planOpen builds resume command and session marker', () => {
  const p = planOpen(SID, "/tmp/it's here")!
  assert.equal(p.cmd, `cd '/tmp/it'\\''s here' && claude --resume ${SID}`)
  assert.equal(p.marker, `${MARKER_PREFIX}${SID}`)
})

test('planOpen without session starts fresh claude with a generic marker', () => {
  const p = planOpen(null, '/repo')!
  assert.equal(p.cmd, `cd '/repo' && claude`)
  assert.equal(p.marker, `${MARKER_PREFIX}new`)
})

test('planOpen rejects unsafe inputs', () => {
  assert.equal(planOpen('foo; rm -rf /', '/repo'), null)
  assert.equal(planOpen(SID, 'relative/path'), null)
  assert.equal(planOpen(SID, '/x\ny'), null)
  assert.equal(planOpen(SID, '/x\0y'), null)
})

test('osascript receives the command via argv, not interpolated into the script', () => {
  const p = planOpen(SID, '/repo "quoted"')!
  const args = osascriptArgs(p)
  assert.deepEqual(args.slice(0, 2), ['-e', OPEN_SCRIPT])
  assert.deepEqual(args.slice(2), [p.marker, p.cmd, MARKER_PREFIX])
  assert.ok(!OPEN_SCRIPT.includes(SID))
})

test('script focuses existing tab, then reuses window, then falls back', () => {
  assert.ok(OPEN_SCRIPT.indexOf('return "focused"') < OPEN_SCRIPT.indexOf('return "tab"'))
  assert.ok(OPEN_SCRIPT.indexOf('return "tab"') < OPEN_SCRIPT.indexOf('return "window"'))
  assert.match(OPEN_SCRIPT, /set custom title of newTab to marker/)
})
