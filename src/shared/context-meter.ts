// Context-window usage, computed the way the terminal does (input + cache read + cache creation).
// Loaded by node's type stripping in tests.

export interface UsageLike {
  input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export function contextTokens(u: UsageLike | null | undefined): number {
  if (!u) return 0
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
}

/** The CLI reports the real window in result.modelUsage; before that, infer from the model id */
export function contextWindowFor(model: string | null | undefined, reported?: number | null): number {
  if (reported && reported > 0) return reported
  if (model && /\[1m\]/i.test(model)) return 1_000_000
  return 200_000
}

export function contextPercent(tokens: number, window: number): number {
  if (window <= 0) return 0
  return Math.min(100, Math.round((tokens / window) * 100))
}

/** Largest contextWindow among the result event's modelUsage entries (the main model's) */
export function reportedContextWindow(modelUsage: unknown): number | null {
  if (!modelUsage || typeof modelUsage !== 'object') return null
  let best: number | null = null
  for (const v of Object.values(modelUsage as Record<string, any>)) {
    const w = v?.contextWindow
    if (typeof w === 'number' && w > 0 && (best === null || w > best)) best = w
  }
  return best
}
