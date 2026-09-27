// Minimal bridge for the minimized bubble window: it can only expand, move, and read its badge.
import { contextBridge, ipcRenderer } from 'electron'

// Channel names are inlined, not imported from ../shared/types: a shared import makes the
// bundler emit a common chunk, and sandboxed preloads can't load chunks (the main
// window's preload then fails and the UI never renders). Keep in sync with IPC.*.
const IPC = {
  EXPAND_FROM_BUBBLE: 'clui:expand-from-bubble',
  MOVE_BUBBLE: 'clui:move-bubble',
  BUBBLE_STATE: 'clui:bubble-state',
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
})
