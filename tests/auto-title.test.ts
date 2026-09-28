import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanTitle, generateTitle, titleArgs } from '../src/main/auto-title.ts'

test('cleanTitle strips quotes, labels, markdown and trailing punctuation', () => {
  assert.equal(cleanTitle('"Auto Session Naming"'), 'Auto Session Naming')
  assert.equal(cleanTitle('Title: Fix Login Bug.'), 'Fix Login Bug')
  assert.equal(cleanTitle('**Refactor   Store**\n'), 'Refactor Store')
  assert.equal(cleanTitle('  Deploy Pipeline Fix  \nextra line'), 'Deploy Pipeline Fix')
})

test('cleanTitle rejects empty or runaway output', () => {
  assert.equal(cleanTitle(''), null)
  assert.equal(cleanTitle('   "" '), null)
  assert.equal(cleanTitle('word '.repeat(40)), null)
})

test('titleArgs runs a cheap isolated one-shot', () => {
  const args = titleArgs('fix the bug')
  assert.equal(args[0], '-p')
  assert.ok(args[1].includes('fix the bug'))
  for (const flag of ['--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(args.includes(flag), flag)
  assert.equal(args[args.indexOf('--setting-sources') + 1], '')
  assert.equal(args[args.indexOf('--tools') + 1], '')
})

test('generateTitle parses the CLI json result', async () => {
  const title = await generateTitle('make tabs nicer', async () => JSON.stringify({ result: '"Nicer Tab Titles."' }))
  assert.equal(title, 'Nicer Tab Titles')
})

test('generateTitle returns null on errors and bad output', async () => {
  assert.equal(await generateTitle('x', async () => { throw new Error('boom') }), null)
  assert.equal(await generateTitle('x', async () => 'not json'), null)
  assert.equal(await generateTitle('x', async () => JSON.stringify({ is_error: true, result: 'Credit low' })), null)
  assert.equal(await generateTitle('   ', async () => JSON.stringify({ result: 'Nope' })), null)
})
