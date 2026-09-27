import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampToWorkArea, defaultBubblePosition, parseBubbleState, BUBBLE_W, BUBBLE_H } from '../src/main/bubble-geometry.ts'

const area = { x: 0, y: 25, width: 1440, height: 875 }

test('clampToWorkArea keeps bubble on screen', () => {
  assert.deepEqual(clampToWorkArea({ x: -50, y: 0 }, area), { x: 0, y: 25 })
  assert.deepEqual(clampToWorkArea({ x: 5000, y: 5000 }, area), { x: 1440 - BUBBLE_W, y: 900 - BUBBLE_H })
  assert.deepEqual(clampToWorkArea({ x: 100.4, y: 200.6 }, area), { x: 100, y: 201 })
})

test('bubble window is taller than wide to leave hop headroom', () => {
  assert.equal(BUBBLE_W, 72)
  assert.equal(BUBBLE_H, 112)
})

test('defaultBubblePosition is bottom-right with margin', () => {
  assert.deepEqual(defaultBubblePosition(area), { x: 1440 - BUBBLE_W - 24, y: 900 - BUBBLE_H - 24 })
})

test('parseBubbleState tolerates junk', () => {
  assert.deepEqual(parseBubbleState('{"x":10,"y":20,"minimized":true}'), { x: 10, y: 20, minimized: true })
  assert.deepEqual(parseBubbleState('not json'), { minimized: false })
  assert.deepEqual(parseBubbleState('{"x":"1","minimized":"yes"}'), { x: undefined, y: undefined, minimized: false })
})

test('bubble preload inlines IPC channels that match shared IPC (no shared import)', async () => {
  const { readFileSync } = await import('node:fs')
  const { IPC } = await import('../src/shared/types.ts')
  const src = readFileSync(new URL('../src/preload/bubble.ts', import.meta.url), 'utf-8')
  // A shared import would make the bundler emit a chunk that sandboxed preloads can't load
  assert.ok(!/from '\.\.\//.test(src), 'bubble preload must not import app modules')
  for (const key of ['EXPAND_FROM_BUBBLE', 'MOVE_BUBBLE', 'BUBBLE_STATE', 'BUBBLE_BOUNCE', 'SET_IGNORE_MOUSE_EVENTS'] as const) {
    assert.ok(src.includes(`${key}: '${IPC[key]}'`), `${key} out of sync`)
  }
})
