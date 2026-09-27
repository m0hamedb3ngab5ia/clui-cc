import React, { useEffect, useRef, useState } from 'react'
import iconSrc from '../../../resources/icon.png'

// Pixels of movement before a press counts as a drag instead of a click
const DRAG_THRESHOLD = 4
// How often a chat that needs you makes the bubble hop again
const NEEDS_YOU_REPEAT_MS = 20_000
// Safety net if animationend never fires (e.g. window hidden mid-hop)
const HOP_MAX_MS = 1200

// The bubble preload adds these to window.clui; the shared CluiAPI type lives in the main preload.
type BubbleApi = typeof window.clui & {
  onBubbleBounce?: (callback: (b: { kind: string }) => void) => () => void
}

const STYLES = `
@keyframes clui-pulse { 0%,100% { box-shadow: 0 4px 14px rgba(0,0,0,.35), 0 0 0 0 rgba(255,149,0,.55) } 50% { box-shadow: 0 4px 14px rgba(0,0,0,.35), 0 0 0 8px rgba(255,149,0,0) } }
@keyframes clui-hop {
  0%   { transform: translateY(0) scale(1, 1) }
  10%  { transform: translateY(0) scale(1.12, .86) }
  35%  { transform: translateY(-12px) scale(.95, 1.06) }
  55%  { transform: translateY(0) scale(1.1, .9) }
  70%  { transform: translateY(-5px) scale(.98, 1.03) }
  85%  { transform: translateY(0) scale(1.04, .96) }
  100% { transform: translateY(0) scale(1, 1) }
}
@keyframes clui-hop-shadow {
  0%, 10%, 55%, 85%, 100% { transform: scaleX(1); opacity: .45 }
  35% { transform: scaleX(.6); opacity: .18 }
  70% { transform: scaleX(.8); opacity: .3 }
}
@keyframes clui-glow { 0%,100% { filter: drop-shadow(0 0 0 rgba(255,149,0,0)) } 50% { filter: drop-shadow(0 0 8px rgba(255,149,0,.9)) } }
@keyframes clui-badge-pop { 0% { transform: scale(1) } 40% { transform: scale(1.35) } 100% { transform: scale(1) } }
.clui-logo { transform-origin: 50% 100% }
.clui-hopping .clui-logo { animation: clui-hop 700ms cubic-bezier(.3,.7,.4,1) }
.clui-hopping .clui-shadow { animation: clui-hop-shadow 700ms cubic-bezier(.3,.7,.4,1) }
.clui-badge-pop { animation: clui-badge-pop 300ms ease-out }
@media (prefers-reduced-motion: reduce) {
  .clui-hopping .clui-logo { animation: clui-glow 900ms ease-in-out }
  .clui-hopping .clui-shadow { animation: none }
  .clui-badge-pop { animation: none }
}
`

export function Bubble() {
  const api = window.clui as BubbleApi
  const drag = useRef<{ lastX: number; lastY: number; moved: number } | null>(null)
  const overLogo = useRef(false)
  const [attention, setAttention] = useState(0)
  const attentionRef = useRef(0)
  const [hopping, setHopping] = useState(false)
  const hoppingRef = useRef(false)
  const hopTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const [badgePop, setBadgePop] = useState(0)

  // Transparent headroom passes clicks through; only the logo itself catches the mouse
  const setPassthrough = (ignore: boolean) => api.setIgnoreMouseEvents(ignore, { forward: true })

  const endHop = () => {
    if (hopTimer.current) clearTimeout(hopTimer.current)
    hopTimer.current = null
    hoppingRef.current = false
    setHopping(false)
  }

  const hop = () => {
    if (hoppingRef.current) return // a bounce mid-hop is ignored
    hoppingRef.current = true
    setHopping(true)
    hopTimer.current = setTimeout(endHop, HOP_MAX_MS)
  }

  const stopRepeat = () => {
    if (repeatTimer.current) clearInterval(repeatTimer.current)
    repeatTimer.current = null
  }

  useEffect(() => {
    setPassthrough(true)
    const offState = api.onBubbleState((s) => {
      if (s.attention > attentionRef.current) setBadgePop((n) => n + 1)
      attentionRef.current = s.attention
      setAttention(s.attention)
      if (s.attention <= 0) stopRepeat()
    })
    const offBounce = api.onBubbleBounce?.(({ kind }) => {
      if (kind === 'stop') {
        stopRepeat()
        return
      }
      hop()
      if (kind !== 'finished' && !repeatTimer.current) {
        repeatTimer.current = setInterval(() => {
          if (attentionRef.current > 0) hop()
          else stopRepeat()
        }, NEEDS_YOU_REPEAT_MS)
      }
    })
    return () => {
      offState()
      offBounce?.()
      stopRepeat()
      if (hopTimer.current) clearTimeout(hopTimer.current)
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
      className={hopping ? 'clui-hopping' : undefined}
      style={{ width: '100vw', height: '100vh', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 8, boxSizing: 'border-box', position: 'relative' }}
    >
      <style>{STYLES}</style>
      <div
        className="clui-shadow"
        style={{
          position: 'absolute', bottom: 3, left: '50%', width: 44, height: 8, marginLeft: -22,
          borderRadius: '50%', background: 'rgba(0,0,0,.45)', filter: 'blur(3px)', opacity: 0,
          pointerEvents: 'none',
          visibility: hopping ? 'visible' : 'hidden',
        }}
      />
      <div
        className="clui-logo"
        onAnimationEnd={(e) => { if (e.target === e.currentTarget) endHop() }}
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
        title={attention > 0 ? `${attention} session${attention === 1 ? '' : 's'} need you — click to open` : 'Click to open Clui CC, drag to move'}
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
      </div>
    </div>
  )
}
