import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hitTest, collapseRects, decideIgnore, sanitizeRects } from '../src/shared/hit-rects.ts'

const bounds = { x: 200, y: 100, width: 1040, height: 720 }
const rects = [{ x: 290, y: 300, w: 460, h: 400 }]

test('hitTest converts screen DIP to window-local and tests inclusively at the origin edge', () => {
  assert.equal(hitTest(rects, { x: 200 + 290, y: 100 + 300 }, bounds), true)
  assert.equal(hitTest(rects, { x: 200 + 289, y: 100 + 300 }, bounds), false)
  assert.equal(hitTest(rects, { x: 200 + 750, y: 100 + 300 }, bounds), false) // exclusive far edge
  assert.equal(hitTest(rects, { x: 200 + 749, y: 100 + 699 }, bounds), true)
})

test('hitTest is false anywhere outside the window bounds', () => {
  assert.equal(hitTest(rects, { x: 10, y: 10 }, bounds), false)
  assert.equal(hitTest(rects, { x: 200 + 1040, y: 100 + 300 }, bounds), false)
  assert.equal(hitTest([{ x: -50, y: -50, w: 5000, h: 5000 }], { x: 5, y: 5 }, bounds), false)
})

test('hitTest works on a display with negative coordinates (left/upper secondary display)', () => {
  const b = { x: -1440, y: -300, width: 1040, height: 720 }
  assert.equal(hitTest(rects, { x: -1440 + 300, y: -300 + 310 }, b), true)
  assert.equal(hitTest(rects, { x: -1440 + 100, y: -300 + 310 }, b), false)
})

test('collapseRects drops nested and duplicate rects but keeps overlapping siblings', () => {
  const outer = { x: 0, y: 0, w: 100, h: 100 }
  const inner = { x: 10, y: 10, w: 20, h: 20 }
  const side = { x: 90, y: 90, w: 50, h: 50 }
  assert.deepEqual(collapseRects([inner, outer, side, { ...outer }]), [outer, side])
})

test('decideIgnore: hidden → ignore; gesture → capture; otherwise follows the hit test', () => {
  assert.equal(decideIgnore({ inside: true, gestureActive: false, visible: false }), true)
  assert.equal(decideIgnore({ inside: false, gestureActive: true, visible: true }), false)
  assert.equal(decideIgnore({ inside: true, gestureActive: false, visible: true }), false)
  assert.equal(decideIgnore({ inside: false, gestureActive: false, visible: true }), true)
})

test('sanitizeRects rejects junk from the renderer', () => {
  assert.deepEqual(sanitizeRects(null), [])
  assert.deepEqual(sanitizeRects('x'), [])
  assert.deepEqual(sanitizeRects([{ x: 1, y: 2, w: 3, h: 4 }, { x: 'a' }, { x: 1, y: 1, w: 0, h: 5 }, { x: 1, y: 1, w: 1, h: NaN }]), [{ x: 1, y: 2, w: 3, h: 4 }])
  assert.equal(sanitizeRects(Array.from({ length: 1000 }, () => ({ x: 0, y: 0, w: 1, h: 1 }))).length, 256)
})
