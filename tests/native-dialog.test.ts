import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { FilePicker, parsePickerResult, pickerScript } from '../src/main/native-dialog.ts'
import { stallReport } from '../src/main/hang-watchdog.ts'

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed: string[] = []
  kill(signal = 'SIGTERM') { this.killed.push(signal); queueMicrotask(() => this.emit('close', null, signal)); return true }
  exit(code: number, out = '', err = '') {
    if (out) this.stdout.emit('data', out)
    if (err) this.stderr.emit('data', err)
    this.emit('close', code, null)
  }
}

function setup() {
  const calls: string[] = []
  const logs: string[] = []
  const children: FakeChild[] = []
  const spawned: string[][] = []
  const picker = new FilePicker({
    spawn: (cmd, args) => { spawned.push([cmd, ...args]); const c = new FakeChild(); children.push(c); return c },
    host: () => ({ setAlwaysOnTop: (f: boolean, l?: string) => { calls.push(`top:${f}${l ? `:${l}` : ''}`) }, isDestroyed: () => false }),
    log: (m) => logs.push(m),
  })
  return { picker, calls, logs, children, spawned }
}

test('runs the picker in osascript, lowers the overlay, then restores it', async () => {
  const { picker, calls, logs, children, spawned } = setup()
  const p = picker.pick('files', 'attach-files')
  assert.equal(spawned[0][0], 'osascript')
  assert.deepEqual(calls, ['top:false'])
  children[0].exit(0, '/Users/me/a.png\n/Users/me/b c.txt\n')
  assert.deepEqual(await p, ['/Users/me/a.png', '/Users/me/b c.txt'])
  assert.deepEqual(calls, ['top:false', 'top:true:screen-saver'])
  assert.ok(logs.some((l) => l.includes('attach-files: opening (osascript pid 4242)')))
  assert.ok(logs.some((l) => l.includes('attach-files: picked 2 after')))
  assert.equal(picker.isOpen(), null)
})

test('a second request while open cancels the picker instead of stacking another', async () => {
  const { picker, children, spawned } = setup()
  const first = picker.pick('files', 'attach-files')
  assert.equal(await picker.pick('files', 'attach-files'), null)
  assert.deepEqual(children[0].killed, ['SIGKILL'])
  assert.equal(await first, null)
  assert.equal(spawned.length, 1)
  assert.equal(picker.isOpen(), null)
})

test('user cancel, spawn errors and failures resolve null and restore the overlay', async () => {
  const { picker, calls, logs, children } = setup()
  const p1 = picker.pick('files', 'attach-files')
  children[0].exit(1, '', 'execution error: User canceled. (-128)')
  assert.equal(await p1, null)
  const p2 = picker.pick('directory', 'select-directory')
  children[1].emit('error', new Error('spawn osascript ENOENT'))
  assert.equal(await p2, null)
  assert.equal(calls.at(-1), 'top:true:screen-saver')
  assert.ok(logs.some((l) => l.includes('canceled after')))
  assert.ok(logs.some((l) => l.includes('failed after') && l.includes('ENOENT')))
})

test('parsePickerResult handles folders, cancel and errors', () => {
  assert.deepEqual(parsePickerResult(0, null, '/Users/me/proj/\n', ''), { status: 'picked', paths: ['/Users/me/proj'] })
  assert.deepEqual(parsePickerResult(0, null, '/\n', ''), { status: 'picked', paths: ['/'] })
  assert.deepEqual(parsePickerResult(0, null, '/Users/me/notes \n\n', ''), { status: 'picked', paths: ['/Users/me/notes '] })
  assert.deepEqual(parsePickerResult(1, null, '', 'User canceled. (-128)'), { status: 'canceled' })
  assert.deepEqual(parsePickerResult(null, 'SIGKILL', '', ''), { status: 'canceled' })
  assert.deepEqual(parsePickerResult(1, null, '', 'boom'), { status: 'error', message: 'boom' })
})

test('picker scripts use fixed prompts only', () => {
  assert.ok(pickerScript('files').some((l) => l.includes('multiple selections allowed')))
  assert.ok(pickerScript('directory').some((l) => l.includes('choose folder')))
})

test('stallReport flags a stale heartbeat and names active operations', () => {
  assert.equal(stallReport(10_000, 12_000, [], 5000), null)
  assert.equal(stallReport(10_000, 17_000, ['dialog:attach-files'], 5000),
    'main thread unresponsive for 7s; active: dialog:attach-files')
  assert.match(stallReport(0, 6000, [], 5000)!, /active: none$/)
})
