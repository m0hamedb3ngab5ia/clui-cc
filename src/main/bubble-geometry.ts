// Pure geometry for the minimized bubble window (no electron imports, unit-tested).

export interface Rect { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

// Taller than wide: the logo sits at the bottom, transparent headroom above lets it hop
export const BUBBLE_W = 72
export const BUBBLE_H = 88

// Keep the bubble fully inside the display's work area.
export function clampToWorkArea(p: Point, area: Rect, width = BUBBLE_W, height = BUBBLE_H): Point {
  return {
    x: Math.round(Math.min(Math.max(p.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(p.y, area.y), area.y + area.height - height)),
  }
}

// First-time spot: bottom-right corner of the work area, with a small margin.
export function defaultBubblePosition(area: Rect, width = BUBBLE_W, height = BUBBLE_H, margin = 24): Point {
  return { x: area.x + area.width - width - margin, y: area.y + area.height - height - margin }
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
