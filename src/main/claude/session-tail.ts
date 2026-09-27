// Follows a session's JSONL transcript as another process appends to it (used while
// Remote Control holds the session, so messages sent from a phone show up in the tab).
// fs.watch plus a slow poll, since macOS occasionally drops watch events.
import { watch, statSync, openSync, readSync, closeSync, type FSWatcher } from 'fs'
import { StringDecoder } from 'string_decoder'
import type { SessionLoadMessage } from '../../shared/types'

const POLL_MS = 2000

export type LineToMessages = (obj: any) => SessionLoadMessage[]

export class SessionTail {
  private filePath: string
  private offset: number
  private partial = ''
  private decoder = new StringDecoder('utf8')
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private reading = false
  private convert: LineToMessages
  private onMessages: (messages: SessionLoadMessage[]) => void
  private log: (msg: string) => void

  constructor(filePath: string, convert: LineToMessages, onMessages: (messages: SessionLoadMessage[]) => void, log: (msg: string) => void) {
    this.filePath = filePath
    this.convert = convert
    this.onMessages = onMessages
    this.log = log
    this.offset = this.size()
  }

  private size(): number {
    try { return statSync(this.filePath).size } catch { return 0 }
  }

  start(): void {
    try {
      this.watcher = watch(this.filePath, () => this.read())
    } catch (err) {
      this.log(`[rc] tail watch failed, polling only: ${err}`)
    }
    this.timer = setInterval(() => this.read(), POLL_MS)
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Reads bytes appended since the last read and emits the messages they contain */
  read(): void {
    if (this.reading) return
    this.reading = true
    try {
      const size = this.size()
      if (size < this.offset) { this.offset = 0; this.partial = ''; this.decoder = new StringDecoder('utf8') } // rewritten
      if (size === this.offset) return
      const fd = openSync(this.filePath, 'r')
      let text: string
      try {
        const buf = Buffer.alloc(size - this.offset)
        const n = readSync(fd, buf, 0, buf.length, this.offset)
        text = this.decoder.write(buf.subarray(0, n))
        this.offset += n
      } finally {
        closeSync(fd)
      }
      const lines = (this.partial + text).split('\n')
      this.partial = lines.pop() ?? ''
      const out: SessionLoadMessage[] = []
      for (const line of lines) {
        if (!line.trim()) continue
        try { out.push(...this.convert(JSON.parse(line))) } catch {}
      }
      if (out.length) this.onMessages(out)
    } catch (err) {
      this.log(`[rc] tail read failed: ${err}`)
    } finally {
      this.reading = false
    }
  }
}
