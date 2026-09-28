import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canReplaceTab, findSessionTab, isBlankTab, type TabLike } from '../src/shared/tab-reuse.ts'

const tab = (over: Partial<TabLike> = {}): TabLike => ({
  id: 't', claudeSessionId: null, resumedFrom: null, status: 'idle', activeRequestId: null,
  messages: [], attachments: [], queuedPrompts: [], titleLocked: false, ...over,
})

test('findSessionTab matches the current or the original session id', () => {
  const tabs = [tab({ id: 'a', claudeSessionId: 's1' }), tab({ id: 'b', claudeSessionId: 's9', resumedFrom: 's2' })]
  assert.equal(findSessionTab(tabs, 's1')?.id, 'a')
  assert.equal(findSessionTab(tabs, 's2')?.id, 'b')
  assert.equal(findSessionTab(tabs, 's3'), undefined)
})

test('isBlankTab is true only for an untouched New Tab', () => {
  assert.equal(isBlankTab(tab()), true)
  assert.equal(isBlankTab(tab({ messages: [{}] })), false)
  assert.equal(isBlankTab(tab({ claudeSessionId: 's1' })), false)
  assert.equal(isBlankTab(tab({ status: 'running' })), false)
  assert.equal(isBlankTab(tab({ attachments: [{}] })), false)
  assert.equal(isBlankTab(tab({ queuedPrompts: ['hi'] })), false)
  assert.equal(isBlankTab(tab({ titleLocked: true })), false)
})

test('isBlankTab is false when the tab has an unsent draft', () => {
  assert.equal(isBlankTab(tab(), 'half-written prompt'), false)
  assert.equal(isBlankTab(tab(), '   '), true)
})

test('canReplaceTab only replaces the blank tab the app launched with', () => {
  assert.equal(canReplaceTab(tab({ id: 'launch' }), 'launch'), true)
  assert.equal(canReplaceTab(tab({ id: 'later' }), 'launch'), false)
  assert.equal(canReplaceTab(tab({ id: 'launch' }), 'launch', 'draft text'), false)
  assert.equal(canReplaceTab(tab({ id: 'launch', messages: [{}] }), 'launch'), false)
  assert.equal(canReplaceTab(tab({ id: 'launch' }), null), false)
})
