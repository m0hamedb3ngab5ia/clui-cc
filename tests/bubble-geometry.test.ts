import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampToWorkArea, defaultBubblePosition, parseBubbleState, BUBBLE_SIZE } from '../src/main/bubble-geometry.ts'

const area = { x: 0, y: 25, width: 1440, height: 875 }

test('clampToWorkArea keeps bubble on screen', () => {
  assert.deepEqual(clampToWorkArea({ x: -50, y: 0 }, area), { x: 0, y: 25 })
  assert.deepEqual(clampToWorkArea({ x: 5000, y: 5000 }, area), { x: 1440 - BUBBLE_SIZE, y: 900 - BUBBLE_SIZE })
  assert.deepEqual(clampToWorkArea({ x: 100.4, y: 200.6 }, area), { x: 100, y: 201 })
})

test('defaultBubblePosition is bottom-right with margin', () => {
  assert.deepEqual(defaultBubblePosition(area), { x: 1440 - BUBBLE_SIZE - 24, y: 900 - BUBBLE_SIZE - 24 })
})

test('parseBubbleState tolerates junk', () => {
  assert.deepEqual(parseBubbleState('{"x":10,"y":20,"minimized":true}'), { x: 10, y: 20, minimized: true })
  assert.deepEqual(parseBubbleState('not json'), { minimized: false })
  assert.deepEqual(parseBubbleState('{"x":"1","minimized":"yes"}'), { x: undefined, y: undefined, minimized: false })
})
