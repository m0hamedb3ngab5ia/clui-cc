// Minimal bridge for the minimized bubble window: it can only expand, move, read its badge,
// hear bounce requests, and toggle click-through for its transparent headroom.
import { contextBridge, ipcRenderer } from 'electron'

// Channel names are inlined, not imported from ../shared/types: a shared import makes the
// bundler emit a common chunk, and sandboxed preloads can't load chunks (the main
// window's preload then fails and the UI never renders). Keep in sync with IPC.*.
const IPC = {
  EXPAND_FROM_BUBBLE: 'clui:expand-from-bubble',
  MOVE_BUBBLE: 'clui:move-bubble',
  BUBBLE_STATE: 'clui:bubble-state',
  BUBBLE_BOUNCE: 'clui:bubble-bounce',
  SET_IGNORE_MOUSE_EVENTS: 'clui:set-ignore-mouse-events',
} as const

contextBridge.exposeInMainWorld('clui', {
  expandFromBubble: () => ipcRenderer.send(IPC.EXPAND_FROM_BUBBLE),
  moveBubble: (deltaX: number, deltaY: number, done?: boolean) =>
    ipcRenderer.send(IPC.MOVE_BUBBLE, deltaX, deltaY, !!done),
  onBubbleState: (callback: (state: { attention: number }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, state: { attention: number }) => callback(state)
    ipcRenderer.on(IPC.BUBBLE_STATE, handler)
    return () => ipcRenderer.removeListener(IPC.BUBBLE_STATE, handler)
  },
  onBubbleBounce: (callback: (b: { kind: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, b: { kind: string }) => callback(b)
    ipcRenderer.on(IPC.BUBBLE_BOUNCE, handler)
    return () => ipcRenderer.removeListener(IPC.BUBBLE_BOUNCE, handler)
  },
  setIgnoreMouseEvents: (ignore: boolean, options?: { forward?: boolean }) =>
    ipcRenderer.send(IPC.SET_IGNORE_MOUSE_EVENTS, ignore, options || {}),
})
