import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAvailableAliases, parseCurrentModel, dedupeByLabel, discoverModels, isCacheFresh, withContextHint } from '../src/main/models.ts'

const BASE = "Current model: `Opus 5.5 (1M context)`\nUsage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID."

test('parses the CLI alias list and current model', () => {
  assert.deepEqual(parseAvailableAliases(BASE), ['sonnet', 'opus', 'haiku', 'fable', 'best', 'sonnet[1m]', 'opus[1m]', 'fable[1m]', 'opusplan'])
  assert.equal(parseCurrentModel(BASE), 'Opus 5.5 (1M context)')
  assert.equal(parseCurrentModel('Current model: `Sonnet 5` (effort: medium)'), 'Sonnet 5')
  assert.deepEqual(parseAvailableAliases('nothing here'), [])
})

test('dedupes aliases that resolve to the same model', () => {
  assert.deepEqual(
    dedupeByLabel([{ id: 'fable', label: 'Fable 5.1' }, { id: 'best', label: 'Fable 5.1' }, { id: 'opus', label: 'Opus 5.5' }]),
    [{ id: 'fable', label: 'Fable 5.1' }, { id: 'opus', label: 'Opus 5.5' }],
  )
})

test('discoverModels resolves each alias via the CLI and skips failures', async () => {
  const labels: Record<string, string> = { sonnet: 'Sonnet 5', opus: 'Opus 5.5', fable: 'Fable 5.1', best: 'Fable 5.1' }
  const calls: string[][] = []
  const exec = async (args: string[]) => {
    calls.push(args)
    if (args[0] === '--version') return '9.9.9 (Claude Code)\n'
    const i = args.indexOf('--model')
    if (i < 0) return JSON.stringify({ result: 'Current model: `Opus 5.5 (1M context)`\nUsage: /model <name>. Available: sonnet, opus, fable, best, haiku, default, or a full model ID.' })
    const alias = args[i + 1]
    if (alias === 'haiku') throw new Error('boom')
    return JSON.stringify({ result: `Current model: \`${labels[alias]}\`` })
  }
  const cache = await discoverModels({}, exec)
  assert.equal(cache.cliVersion, '9.9.9 (Claude Code)')
  assert.equal(cache.defaultLabel, 'Opus 5.5 (1M context)')
  assert.deepEqual(cache.models, [
    { id: 'sonnet', label: 'Sonnet 5' }, { id: 'opus', label: 'Opus 5.5' }, { id: 'fable', label: 'Fable 5.1' },
  ])
  assert.ok(calls.every((a) => a[0] === '--version' || a.includes('--no-session-persistence')))
})

test('cache freshness depends on CLI version and age', () => {
  const cache = { cliVersion: '1', fetchedAt: 0, defaultLabel: null, models: [{ id: 'opus', label: 'Opus' }] }
  assert.ok(isCacheFresh(cache, '1', 1000))
  assert.ok(!isCacheFresh(cache, '2', 1000))
  assert.ok(!isCacheFresh(cache, '1', 25 * 60 * 60 * 1000))
  assert.ok(!isCacheFresh(null, '1', 0))
})

test('[1m] aliases stay distinct even when the CLI omits the 1M label', () => {
  assert.equal(withContextHint('sonnet[1m]', 'Sonnet 5'), 'Sonnet 5 (1M context)')
  assert.equal(withContextHint('opus[1m]', 'Opus 5.5 (1M context)'), 'Opus 5.5 (1M context)')
  assert.equal(withContextHint('sonnet', 'Sonnet 5'), 'Sonnet 5')
})
