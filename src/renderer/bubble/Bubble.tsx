import React, { useEffect, useRef, useState } from 'react'
import iconSrc from '../../../resources/icon.png'

// Pixels of movement before a press counts as a drag instead of a click
const DRAG_THRESHOLD = 4

export function Bubble() {
  const drag = useRef<{ lastX: number; lastY: number; moved: number } | null>(null)
  const [attention, setAttention] = useState(0)

  useEffect(() => window.clui.onBubbleState((s) => setAttention(s.attention)), [])

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
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <style>{`@keyframes clui-pulse { 0%,100% { box-shadow: 0 4px 14px rgba(0,0,0,.35), 0 0 0 0 rgba(255,149,0,.55) } 50% { box-shadow: 0 4px 14px rgba(0,0,0,.35), 0 0 0 8px rgba(255,149,0,0) } }`}</style>
      <div
        onMouseDown={(e) => {
          e.preventDefault()
          drag.current = { lastX: e.screenX, lastY: e.screenY, moved: 0 }
        }}
        title={attention > 0 ? `${attention} session${attention === 1 ? '' : 's'} need you — click to open` : 'Click to open Clui CC, drag to move'}
        style={{
          position: 'relative',
          width: 56,
          height: 56,
          borderRadius: '50%',
          cursor: 'pointer',
          userSelect: 'none',
          background: '#1c1c1e',
          boxShadow: '0 4px 14px rgba(0,0,0,.35)',
          animation: attention > 0 ? 'clui-pulse 1.6s ease-in-out infinite' : undefined,
        }}
      >
        <img src={iconSrc} alt="Clui CC" draggable={false} style={{ width: 56, height: 56, borderRadius: '50%', pointerEvents: 'none' }} />
        {attention > 0 && (
          <span
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
