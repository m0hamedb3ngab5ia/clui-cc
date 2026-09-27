import { useEffect } from 'react'

/**
 * Publish the window-local bounding rects of every top-level `[data-clui-ui]` region to the
 * main process, which hit-tests the cursor against them to decide OS-level click-through.
 * (Main must own that decision: macOS stops forwarding mousemove to this window as soon as
 * another app is active, so a renderer-driven toggle freezes in whatever state it was in.)
 *
 * Rects are re-measured on DOM mutations, element resizes, and on an animation-frame loop
 * that runs while anything is animating (framer-motion transitions, the `--clui-card-y`
 * translate while dragging) and stops after a short quiet period.
 */
const PAD = 2          // px: keep the resize handles on the card edge inside the hit area
const QUIET_MS = 350   // stop the rAF loop this long after the last change
const SELECTOR = '[data-clui-ui]'

export function useUiHitRects(): void {
  useEffect(() => {
    if (!window.clui?.setUiHitRects) return
    let lastJson = ''
    let raf = 0
    let quietUntil = 0
    const ro = new ResizeObserver(() => wake())

    const measure = (): boolean => {
      const rects: { x: number; y: number; w: number; h: number }[] = []
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(SELECTOR))) {
        // top-level regions only: nested markers are covered by their ancestor
        if (el.parentElement?.closest(SELECTOR)) continue
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) continue
        rects.push({ x: Math.floor(r.left - PAD), y: Math.floor(r.top - PAD), w: Math.ceil(r.width + 2 * PAD), h: Math.ceil(r.height + 2 * PAD) })
      }
      const json = JSON.stringify(rects)
      if (json === lastJson) return false
      lastJson = json
      window.clui.setUiHitRects(rects)
      return true
    }

    const loop = () => {
      raf = 0
      const changed = measure()
      const now = performance.now()
      if (changed) quietUntil = now + QUIET_MS
      if (now < quietUntil) raf = requestAnimationFrame(loop)
    }
    const wake = () => {
      quietUntil = performance.now() + QUIET_MS
      if (!raf) raf = requestAnimationFrame(loop)
    }

    const observeAll = () => {
      ro.disconnect()
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(SELECTOR))) ro.observe(el)
    }
    const mo = new MutationObserver(() => { observeAll(); wake() })
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-clui-ui', 'style', 'class'] })

    // Anything that can move the UI without a DOM mutation
    document.addEventListener('transitionrun', wake, true)
    document.addEventListener('animationstart', wake, true)
    document.addEventListener('scroll', wake, true)
    window.addEventListener('resize', wake)
    const unsubShown = window.clui.onWindowShown?.(wake)

    observeAll()
    wake()
    return () => {
      mo.disconnect()
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
      document.removeEventListener('transitionrun', wake, true)
      document.removeEventListener('animationstart', wake, true)
      document.removeEventListener('scroll', wake, true)
      window.removeEventListener('resize', wake)
      unsubShown?.()
    }
  }, [])
}
