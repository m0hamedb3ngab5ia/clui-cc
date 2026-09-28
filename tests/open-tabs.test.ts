import { test } from 'node:test'
import assert from 'node:assert/strict'
import { snapshotOpenTabs, parseOpenTabs, type OpenTabLike } from '../src/shared/open-tabs.ts'

const tab = (over: Partial<OpenTabLike> = {}): OpenTabLike => ({
  id: 't', claudeSessionId: null, title: 'New Tab', titleLocked: false, workingDirectory: '/home',
  hasChosenDirectory: false, additionalDirs: [], permissionMode: 'default', effort: null, ...over,
})

test('snapshotOpenTabs keeps only tabs with a session, in order, and the active one', () => {
  const snap = snapshotOpenTabs([
    tab({ id: 'a', claudeSessionId: 's1', title: 'One', workingDirectory: '/p1', hasChosenDirectory: true }),
    tab({ id: 'b' }),
    tab({ id: 'c', claudeSessionId: 's2', title: 'Two', permissionMode: 'plan', effort: 'high', additionalDirs: ['/x'] }),
  ], 'c')
  assert.deepEqual(snap.tabs.map((t) => t.sessionId), ['s1', 's2'])
  assert.equal(snap.activeSessionId, 's2')
  assert.equal(snap.tabs[0].projectPath, '/p1')
  assert.equal(snap.tabs[1].projectPath, null)
  assert.equal(snap.tabs[1].permissionMode, 'plan')
  assert.deepEqual(snap.tabs[1].additionalDirs, ['/x'])
})

test('snapshotOpenTabs has no active session when a blank tab is active', () => {
  assert.equal(snapshotOpenTabs([tab({ id: 'a', claudeSessionId: 's1' }), tab({ id: 'b' })], 'b').activeSessionId, null)
})

test('parseOpenTabs round-trips a snapshot', () => {
  const snap = snapshotOpenTabs([tab({ id: 'a', claudeSessionId: 's1', title: 'One', titleLocked: true })], 'a')
  assert.deepEqual(parseOpenTabs(JSON.parse(JSON.stringify(snap))), snap)
})

test('parseOpenTabs drops junk and never throws', () => {
  assert.deepEqual(parseOpenTabs(null).tabs, [])
  assert.deepEqual(parseOpenTabs('nope').tabs, [])
  assert.deepEqual(parseOpenTabs({ tabs: 'x' }).tabs, [])
  const parsed = parseOpenTabs({ tabs: [{ sessionId: 's1' }, { title: 'no id' }, 7, { sessionId: 's1' }], activeSessionId: 5 })
  assert.deepEqual(parsed.tabs.map((t) => t.sessionId), ['s1'])
  assert.equal(parsed.tabs[0].title, '')
  assert.equal(parsed.tabs[0].permissionMode, null)
  assert.equal(parsed.activeSessionId, null)
})
