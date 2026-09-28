import type { CluiAPI } from '../preload/index'

declare module '*.mp3' {
  const src: string
  export default src
}

declare global {
  interface Window {
    clui: CluiAPI
  }
  // Chromium's non-standard work-area top (below the macOS menu bar)
  interface Screen {
    availTop: number
  }
}
