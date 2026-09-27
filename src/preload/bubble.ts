// Minimal bridge for the minimized bubble window: it can only expand, move, and read its badge.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/types'

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
