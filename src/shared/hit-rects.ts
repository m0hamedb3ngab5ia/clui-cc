// Pure click-through geometry (no electron/DOM imports, unit-tested).
//
// The overlay is a fixed-size transparent native window; only the UI regions inside it
// should take mouse input. The renderer publishes the bounding rects of those regions
// (window-local DIP coordinates) and the main process decides, from the global cursor
// position, whether the window must ignore mouse events. Main owns that decision because
// macOS delivers forwarded mousemove events only while the app is active, so a renderer-
// driven toggle freezes as soon as the user clicks another app.

export interface HitRect { x: number; y: number; w: number; h: number }
export interface Bounds { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

const MAX_RECTS = 256

/** Validate a renderer-supplied rect list (IPC payloads are untrusted). */
export function sanitizeRects(input: unknown): HitRect[] {
  if (!Array.isArray(input)) return []
  const out: HitRect[] = []
  for (const r of input) {
    if (out.length >= MAX_RECTS) break
    if (!r || typeof r !== 'object') continue
    const { x, y, w, h } = r as Record<string, unknown>
    if (![x, y, w, h].every((v) => typeof v === 'number' && Number.isFinite(v))) continue
    if ((w as number) <= 0 || (h as number) <= 0) continue
    out.push({ x: x as number, y: y as number, w: w as number, h: h as number })
  }
  return out
}

/** Drop rects fully contained in another rect (nested UI regions). */
export function collapseRects(rects: HitRect[]): HitRect[] {
  return rects.filter((a, i) =>
    !rects.some((b, j) =>
      j !== i &&
      b.x <= a.x && b.y <= a.y && b.x + b.w >= a.x + a.w && b.y + b.h >= a.y + a.h &&
      // identical rects: keep the first one only
      !(b.x === a.x && b.y === a.y && b.w === a.w && b.h === a.h && j > i)
    )
  )
}

/** Is the screen-space point (DIP) over a UI rect of a window at `bounds`? */
export function hitTest(rects: HitRect[], screenPoint: Point, bounds: Bounds): boolean {
  const px = screenPoint.x - bounds.x
  const py = screenPoint.y - bounds.y
  if (px < 0 || py < 0 || px >= bounds.width || py >= bounds.height) return false
  return rects.some((r) => px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h)
}

export interface IgnoreInputs {
  /** cursor is over a UI rect */
  inside: boolean
  /** a move/resize/reorder gesture is in progress: keep full mouse capture */
  gestureActive: boolean
  /** window is visible; hidden windows keep ignoring so a stale show can't eat clicks */
  visible: boolean
}

export interface GestureWatchInputs {
  cursor: Point
  bounds: Bounds
  /** when the cursor was first seen outside the (padded) window, or null while inside */
  outsideSince: number | null
  startedAt: number
  now: number
}
/** Cursor may leave the window this far (DIP) mid-gesture (resize past the min size, overshoot). */
export const GESTURE_OUTSIDE_MARGIN = 64
/** Outside longer than this → the up was delivered elsewhere; the gesture is stuck. */
export const GESTURE_OUTSIDE_MS = 500
/** No real gesture lasts this long; a stuck one would capture the whole transparent window. */
export const GESTURE_MAX_MS = 45_000

export function cursorOutsideWindow({ x, y }: Point, b: Bounds, margin = GESTURE_OUTSIDE_MARGIN): boolean {
  return x < b.x - margin || y < b.y - margin || x >= b.x + b.width + margin || y >= b.y + b.height + margin
}

/**
 * Main-side watchdog for a gesture whose ending mouseup may never arrive (non-activating
 * panel, release over another app). Returns a cancel reason, or null to keep it.
 */
export function gestureWatchdog(i: GestureWatchInputs): string | null {
  if (i.now - i.startedAt > GESTURE_MAX_MS) return 'watchdog:max-age'
  if (i.outsideSince !== null && cursorOutsideWindow(i.cursor, i.bounds) && i.now - i.outsideSince > GESTURE_OUTSIDE_MS) return 'watchdog:outside'
  return null
}

/** The single policy for `setIgnoreMouseEvents`. */
export function decideIgnore({ inside, gestureActive, visible }: IgnoreInputs): boolean {
  if (!visible) return true
  if (gestureActive) return false
  return !inside
}
