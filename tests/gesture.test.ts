import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gestureReduce, endedAsDrag, IDLE, type GestureState } from '../src/shared/gesture.ts'

const down: GestureState = { kind: 'move', pointerId: 1, x: 100, y: 100, moved: false }

test('a press then movement past the slop becomes a drag with deltas from the last accepted move', () => {
  let s = gestureReduce(IDLE, { type: 'down', kind: 'move', pointerId: 1, x: 100, y: 100 })
  assert.deepEqual(s.state, down)
  s = gestureReduce(s.state, { type: 'move', pointerId: 1, x: 101, y: 101, buttons: 1 })
  assert.equal(s.state.kind, 'move'); assert.equal((s.state as any).moved, false); assert.deepEqual([s.dx, s.dy], [0, 0])
  s = gestureReduce(s.state, { type: 'move', pointerId: 1, x: 110, y: 90, buttons: 1 })
  assert.deepEqual([s.dx, s.dy], [10, -10]); assert.equal((s.state as any).moved, true)
  s = gestureReduce(s.state, { type: 'move', pointerId: 1, x: 112, y: 90, buttons: 1 })
  assert.deepEqual([s.dx, s.dy], [2, 0])
})

test('a move with no button held ends the gesture (the up was delivered to another app)', () => {
  const s = gestureReduce({ ...down, moved: true }, { type: 'move', pointerId: 1, x: 300, y: 300, buttons: 0 })
  assert.equal(s.state.kind, 'idle'); assert.equal(s.ended, 'buttons-released'); assert.deepEqual([s.dx, s.dy], [0, 0])
})

test('cancel (window blur / main process) ends any gesture; a later up is a no-op', () => {
  const c = gestureReduce(down, { type: 'cancel', reason: 'blur' })
  assert.equal(c.state.kind, 'idle'); assert.equal(c.ended, 'cancel:blur')
  const u = gestureReduce(c.state, { type: 'up', pointerId: 1 })
  assert.equal(u.state.kind, 'idle'); assert.equal(u.ended, undefined)
  assert.equal(gestureReduce(IDLE, { type: 'cancel', reason: 'blur' }).ended, undefined)
})

test('events from another pointer are ignored; a new press restarts a stale gesture', () => {
  assert.equal(gestureReduce(down, { type: 'move', pointerId: 2, x: 500, y: 500, buttons: 1 }).state, down)
  assert.equal(gestureReduce(down, { type: 'up', pointerId: 2 }).state, down)
  const s = gestureReduce(down, { type: 'down', kind: 'resize', pointerId: 3, x: 1, y: 1, data: 'top' })
  assert.equal(s.state.kind, 'resize'); assert.equal((s.state as any).data, 'top')
})

test('endedAsDrag tells a drag apart from a click so a cancelled reorder never counts as a tab click', () => {
  const click = gestureReduce(down, { type: 'up', pointerId: 1 })
  assert.equal(endedAsDrag(down, click), false)
  const dragged = { ...down, moved: true }
  assert.equal(endedAsDrag(dragged, gestureReduce(dragged, { type: 'up', pointerId: 1 })), true)
  assert.equal(endedAsDrag(dragged, gestureReduce(dragged, { type: 'cancel', reason: 'blur' })), true)
})
