import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findSessionTab, isBlankTab, type TabLike } from '../src/shared/tab-reuse.ts'

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
