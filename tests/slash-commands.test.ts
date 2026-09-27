import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slashTokenAt, replaceSlashToken, filterCommands, LOCAL_COMMANDS } from '../src/shared/slash-commands.ts'

test('slash token at the start of the input', () => {
  assert.deepEqual(slashTokenAt('/comp', 5), { start: 0, end: 5, query: '/comp' })
  assert.deepEqual(slashTokenAt('/', 1), { start: 0, end: 1, query: '/' })
})

test('slash token in the middle of a sentence, after a space or newline', () => {
  assert.deepEqual(slashTokenAt('please run /comp', 16), { start: 11, end: 16, query: '/comp' })
  assert.deepEqual(slashTokenAt('first line\n/rc', 14), { start: 11, end: 14, query: '/rc' })
})

test('a slash inside a word or path is not a command', () => {
  assert.equal(slashTokenAt('a/b', 3), null)
  assert.equal(slashTokenAt('see src/main', 12), null)
})

test('the caret decides which token is active', () => {
  // Caret before the token: no menu
  assert.equal(slashTokenAt('hello /compact', 5), null)
  // Caret in the middle of the token: the token continues past the caret, so no menu yet
  assert.equal(slashTokenAt('hello /compact', 10), null)
  // Caret at the end: menu
  assert.equal(slashTokenAt('hello /compact', 14)?.query, '/compact')
  // Caret past a space after the token: no menu
  assert.equal(slashTokenAt('hello /compact ', 15), null)
})

test('replacing the token keeps the surrounding text and places the caret after it', () => {
  const token = slashTokenAt('please run /comp now', 16)!
  assert.deepEqual(replaceSlashToken('please run /comp now', token, '/compact'), { text: 'please run /compact  now', caret: 20 })
  const whole = slashTokenAt('/comp', 5)!
  assert.deepEqual(replaceSlashToken('/comp', whole, '/compact'), { text: '/compact ', caret: 9 })
})

test('aliases match in the menu (/rc finds /remote-control)', () => {
  const hits = filterCommands(LOCAL_COMMANDS, '/rc')
  assert.equal(hits[0]?.command, '/remote-control')
  assert.equal(filterCommands(LOCAL_COMMANDS, '/remote')[0]?.command, '/remote-control')
})
