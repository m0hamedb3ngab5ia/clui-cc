import React, { useEffect, useRef, useState } from 'react'
import iconSrc from '../../../resources/icon.png'

// Pixels of movement before a press counts as a drag instead of a click
const DRAG_THRESHOLD = 4
// Dock-style bounce, like macOS's critical attention request: one hop (BOUNCE_MS) then a rest,
// repeating every BOUNCE_EVERY_MS until you open the bubble. A chat that needs you also stops once
// it's handled elsewhere. The notification sound plays once per event, not per hop.
const BOUNCE_MS = 620
const BOUNCE_EVERY_MS = 3000

// Squeeze a one-hop keyframe list into the start of a BOUNCE_EVERY_MS cycle; the rest stays still
const hopFrames = (frames: [number, string][]) =>
  frames.map(([pct, css]) => `${+(pct * BOUNCE_MS / BOUNCE_EVERY_MS).toFixed(2)}% { ${css} }`).join('\n  ') + '\n  100% { transform: translateY(0) scale(1, 1) }'

// The bubble preload adds these to window.clui; the shared CluiAPI type lives in the main preload.
type BubbleApi = typeof window.clui & {
  onBubbleBounce?: (callback: (b: { kind: string }) => void) => () => void
}

const STYLES = `
@keyframes clui-pulse { 0%,100% { box-shadow: 0 4px 14px rgba(0,0,0,.35), 0 0 0 0 rgba(255,149,0,.55) } 50% { box-shadow: 0 4px 14px rgba(0,0,0,.35), 0 0 0 8px rgba(255,149,0,0) } }
@keyframes clui-bounce {
  ${hopFrames([
    [0, 'transform: translateY(0) scale(1.1, .88); animation-timing-function: cubic-bezier(.2,.7,.4,1)'],
    [8, 'transform: translateY(-4px) scale(.96, 1.05); animation-timing-function: cubic-bezier(.2,.7,.4,1)'],
    [46, 'transform: translateY(-40px) scale(.98, 1.02); animation-timing-function: cubic-bezier(.6,0,.8,.3)'],
    [88, 'transform: translateY(0) scale(1.12, .86); animation-timing-function: ease-out'],
    [100, 'transform: translateY(0) scale(1, 1)'],
  ])}
}
@keyframes clui-bounce-shadow {
  0%, ${+(88 * BOUNCE_MS / BOUNCE_EVERY_MS).toFixed(2)}%, 100% { transform: scaleX(1); opacity: .5 }
  ${+(46 * BOUNCE_MS / BOUNCE_EVERY_MS).toFixed(2)}% { transform: scaleX(.45); opacity: .12 }
}
@keyframes clui-glow { 0%,100% { filter: drop-shadow(0 0 0 rgba(255,149,0,0)) } 50% { filter: drop-shadow(0 0 10px rgba(255,149,0,.95)) } }
@keyframes clui-badge-pop { 0% { transform: scale(1) } 30% { transform: scale(1.5) } 60% { transform: scale(.9) } 100% { transform: scale(1) } }
.clui-logo { transform-origin: 50% 100% }
.clui-bounce-n .clui-logo, .clui-bounce-loop .clui-logo { animation: clui-bounce ${BOUNCE_EVERY_MS}ms infinite }
.clui-bounce-n .clui-shadow, .clui-bounce-loop .clui-shadow { animation: clui-bounce-shadow ${BOUNCE_EVERY_MS}ms infinite }
.clui-badge-pop { animation: clui-badge-pop 500ms ease-out }
@media (prefers-reduced-motion: reduce) {
  .clui-bounce-n .clui-logo, .clui-bounce-loop .clui-logo { animation: clui-glow ${BOUNCE_EVERY_MS}ms ease-in-out infinite }
  .clui-bounce-n .clui-shadow, .clui-bounce-loop .clui-shadow { animation: none }
  .clui-badge-pop { animation: none }
}
`

export function Bubble() {
  const api = window.clui as BubbleApi
  const drag = useRef<{ lastX: number; lastY: number; moved: number } | null>(null)
  const overLogo = useRef(false)
  const [attention, setAttention] = useState(0)
  const attentionRef = useRef(0)
  // null = still; 'n' = finished chat, hop until the bubble is opened; 'loop' = needs you, also stops once handled
  const [bounce, setBounce] = useState<null | 'n' | 'loop'>(null)
  const bounceRef = useRef<null | 'n' | 'loop'>(null)
  const [badgePop, setBadgePop] = useState(0)
  // Needing you wins over working; either way only one corner indicator shows
  const [activity, setActivity] = useState<null | 'input' | 'working'>(null)

  // Transparent headroom passes clicks through; only the logo itself catches the mouse
  const setPassthrough = (ignore: boolean) => api.setIgnoreMouseEvents(ignore, { forward: true })

  const setMode = (m: null | 'n' | 'loop') => {
    bounceRef.current = m
    setBounce(m)
  }

  const startBounce = (kind: string) => {
    if (kind === 'stop') return setMode(null)
    if (kind === 'finished') {
      if (!bounceRef.current) setMode('n') // never interrupt a running bounce
      return
    }
    setMode('loop')
  }

  useEffect(() => {
    setPassthrough(true)
    const offState = api.onBubbleState((s) => {
      if (s.attention > attentionRef.current) setBadgePop((n) => n + 1)
      attentionRef.current = s.attention
      setAttention(s.attention)
      setActivity(s.activity ?? (s.attention > 0 ? 'input' : null))
      // Handled everywhere: stop asking for attention
      if (s.attention <= 0 && bounceRef.current === 'loop') setMode(null)
    })
    const offBounce = api.onBubbleBounce?.(({ kind }) => startBounce(kind))
    return () => {
      offState()
      offBounce?.()
    }
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = drag.current
      if (!d) return
      const dx = e.screenX - d.lastX
      const dy = e.screenY - d.lastY
      if (dx === 0 && dy === 0) return
      d.moved += Math.abs(dx) + Math.abs(dy)
      d.lastX = e.screenX
      d.lastY = e.screenY
      if (d.moved >= DRAG_THRESHOLD) window.clui.moveBubble(dx, dy)
    }
    const onUp = () => {
      const d = drag.current
      drag.current = null
      if (d && d.moved < DRAG_THRESHOLD) window.clui.expandFromBubble()
      else if (d) window.clui.moveBubble(0, 0, true)
      // Pointer may have left the logo mid-drag; restore click-through now
      if (d && !overLogo.current) setPassthrough(true)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  return (
    <div
      className={bounce === 'n' ? 'clui-bounce-n' : bounce === 'loop' ? 'clui-bounce-loop' : undefined}
      style={{ width: '100vw', height: '100vh', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 8, boxSizing: 'border-box', position: 'relative' }}
    >
      <style>{STYLES}</style>
      <div
        className="clui-shadow"
        style={{
          position: 'absolute', bottom: 3, left: '50%', width: 44, height: 8, marginLeft: -22,
          borderRadius: '50%', background: 'rgba(0,0,0,.45)', filter: 'blur(3px)', opacity: 0,
          pointerEvents: 'none',
          visibility: bounce ? 'visible' : 'hidden',
        }}
      />
      <div
        className="clui-logo"
        onMouseEnter={() => {
          overLogo.current = true
          setPassthrough(false)
        }}
        onMouseLeave={() => {
          overLogo.current = false
          if (!drag.current) setPassthrough(true)
        }}
        onMouseDown={(e) => {
          e.preventDefault()
          drag.current = { lastX: e.screenX, lastY: e.screenY, moved: 0 }
        }}
        title={attention > 0
          ? `${attention} session${attention === 1 ? '' : 's'} need you — click to open`
          : activity === 'working' ? 'Claude is working — click to open' : 'Click to open Clui CC, drag to move'}
        style={{ position: 'relative', width: 56, height: 56, cursor: 'pointer', userSelect: 'none' }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            background: '#1c1c1e',
            boxShadow: '0 4px 14px rgba(0,0,0,.35)',
            animation: attention > 0 ? 'clui-pulse 1.6s ease-in-out infinite' : undefined,
          }}
        >
          <img src={iconSrc} alt="Clui CC" draggable={false} style={{ width: 56, height: 56, borderRadius: '50%', pointerEvents: 'none' }} />
        </div>
        {attention > 0 && (
          <span
            key={badgePop}
            className={badgePop > 0 ? 'clui-badge-pop' : undefined}
            style={{
              position: 'absolute', top: -2, right: -2, minWidth: 18, height: 18, padding: '0 5px',
              borderRadius: 9, background: '#ff9500', color: '#fff', fontSize: 11, fontWeight: 600,
              fontFamily: '-apple-system, system-ui, sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxSizing: 'border-box', pointerEvents: 'none',
            }}
          >
            {attention}
          </span>
        )}
        {attention <= 0 && activity === 'working' && (
          // Static "live" light: noticeable at a glance, never animated
          <span
            aria-label="Claude is working"
            style={{
              position: 'absolute', top: 1, right: 1, width: 12, height: 12, borderRadius: '50%',
              background: '#34c759', border: '2px solid #1c1c1e', boxSizing: 'border-box',
              boxShadow: '0 1px 3px rgba(0,0,0,.4)', pointerEvents: 'none',
            }}
          />
        )}
      </div>
    </div>
  )
}
