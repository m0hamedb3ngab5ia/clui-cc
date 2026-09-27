import { useEffect } from 'react'

/**
 * Publish the window-local bounding rects of every `[data-clui-ui]` region to the
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
const MIN_INTERVAL_MS = 33 // measure at most this often (matches main's poll); layout is forced per measure
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
      // Every marker, nested ones too: a child can sit outside its ancestor's box (the side
      // buttons are absolutely positioned left of the input row). Main collapses contained rects.
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(SELECTOR))) {
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

    let lastMeasure = 0
    const loop = () => {
      raf = 0
      const now = performance.now()
      if (now - lastMeasure >= MIN_INTERVAL_MS) {
        lastMeasure = now
        if (measure()) quietUntil = now + QUIET_MS
      }
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
    // Re-bind the ResizeObserver only when markers may have been added/removed; style/class
    // churn (framer-motion writes style every frame, streaming output appends nodes) just wakes.
    const touchesMarker = (n: Node): boolean =>
      n instanceof HTMLElement && (n.matches(SELECTOR) || n.querySelector(SELECTOR) !== null)
    const mo = new MutationObserver((records) => {
      const rebind = records.some((m) =>
        (m.type === 'attributes' && m.attributeName === 'data-clui-ui') ||
        (m.type === 'childList' && (Array.from(m.addedNodes).some(touchesMarker) || Array.from(m.removedNodes).some(touchesMarker))))
      if (rebind) observeAll()
      wake()
    })
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
