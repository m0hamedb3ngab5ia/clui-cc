// Pure state machine for pointer gestures on the overlay (window move, panel resize,
// tab reorder). The overlay is a non-activating panel: when the user releases the mouse
// over another app the renderer never receives the up event, so every gesture must also
// end on "no buttons pressed", window blur, pointercancel, or a cancel from the main process.

export type GestureKind = 'move' | 'resize' | 'reorder'

export type GestureState =
  | { kind: 'idle' }
  | { kind: GestureKind; pointerId: number; x: number; y: number; moved: boolean; data?: unknown }

export type GestureEvent =
  | { type: 'down'; kind: GestureKind; pointerId: number; x: number; y: number; data?: unknown }
  | { type: 'move'; pointerId: number; x: number; y: number; buttons: number }
  | { type: 'up'; pointerId: number }
  | { type: 'cancel'; reason: string }

export const IDLE: GestureState = { kind: 'idle' }

export interface GestureStep {
  state: GestureState
  /** delta since the last accepted move (0,0 when the event was not a live move) */
  dx: number
  dy: number
  /** why the gesture ended this step, if it did */
  ended?: string
}

/** Movement below this (px) is still a click, not a drag. */
export const DRAG_SLOP = 4

export function gestureReduce(state: GestureState, ev: GestureEvent): GestureStep {
  switch (ev.type) {
    case 'down':
      // A new press while a gesture is "active" means the previous up was lost: restart.
      return { state: { kind: ev.kind, pointerId: ev.pointerId, x: ev.x, y: ev.y, moved: false, ...(ev.data !== undefined ? { data: ev.data } : {}) }, dx: 0, dy: 0 }
    case 'move': {
      if (state.kind === 'idle') return { state, dx: 0, dy: 0 }
      if (ev.pointerId !== state.pointerId) return { state, dx: 0, dy: 0 }
      if ((ev.buttons & 1) === 0) return { state: IDLE, dx: 0, dy: 0, ended: 'buttons-released' }
      const dx = ev.x - state.x
      const dy = ev.y - state.y
      const moved = state.moved || Math.hypot(dx, dy) >= DRAG_SLOP
      if (!moved) return { state, dx: 0, dy: 0 }
      return { state: { ...state, x: ev.x, y: ev.y, moved: true }, dx, dy }
    }
    case 'up':
      if (state.kind === 'idle' || ev.pointerId !== state.pointerId) return { state, dx: 0, dy: 0 }
      return { state: IDLE, dx: 0, dy: 0, ended: 'up' }
    case 'cancel':
      if (state.kind === 'idle') return { state, dx: 0, dy: 0 }
      return { state: IDLE, dx: 0, dy: 0, ended: `cancel:${ev.reason}` }
  }
}

/** True when a gesture that ended was a real drag (suppress the following click). */
export function endedAsDrag(before: GestureState, step: GestureStep): boolean {
  return !!step.ended && before.kind !== 'idle' && before.moved
}
