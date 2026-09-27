// Pure geometry for the minimized bubble window (no electron imports, unit-tested).

export interface Rect { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

export const BUBBLE_SIZE = 72

// Keep the bubble fully inside the display's work area.
export function clampToWorkArea(p: Point, area: Rect, size = BUBBLE_SIZE): Point {
  return {
    x: Math.round(Math.min(Math.max(p.x, area.x), area.x + area.width - size)),
    y: Math.round(Math.min(Math.max(p.y, area.y), area.y + area.height - size)),
  }
}

// First-time spot: bottom-right corner of the work area, with a small margin.
export function defaultBubblePosition(area: Rect, size = BUBBLE_SIZE, margin = 24): Point {
  return { x: area.x + area.width - size - margin, y: area.y + area.height - size - margin }
}

export function parseBubbleState(raw: string): { x?: number; y?: number; minimized: boolean } {
  try {
    const o = JSON.parse(raw)
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    return { x: num(o?.x), y: num(o?.y), minimized: o?.minimized === true }
  } catch {
    return { minimized: false }
  }
}
