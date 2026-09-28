import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { encodeProjectPath, listAllSessions, listProjectSessions, findSessionFile, readSessionTitle, renameSession, writeAiTitle } from '../src/main/sessions.ts'

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const ID_C = '33333333-3333-4333-8333-333333333333'

function transcript(cwd: string, text: string, ts: string): string {
  return [
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: ts, cwd, message: { content: text } }),
    JSON.stringify({ type: 'assistant', uuid: 'u2', timestamp: ts, cwd, message: { content: [{ type: 'text', text: 'ok' }] } }),
  ].join('\n') + '\n'
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'clui-sessions-'))
  const p1 = '/Users/first.last/My Project'
  const p2 = '/Users/first.last/other_repo'
  mkdirSync(join(root, encodeProjectPath(p1)))
  mkdirSync(join(root, encodeProjectPath(p2)))
  const write = (proj: string, id: string, text: string, ts: string, mtimeSec: number) => {
    const f = join(root, encodeProjectPath(proj), `${id}.jsonl`)
    writeFileSync(f, transcript(proj, text, ts))
    utimesSync(f, mtimeSec, mtimeSec)
  }
  write(p1, ID_A, 'oldest in p1', '2026-01-01T00:00:00Z', 1000)
  write(p2, ID_B, 'newest in p2', '2026-03-01T00:00:00Z', 3000)
  write(p1, ID_C, 'middle in p1', '2026-02-01T00:00:00Z', 2000)
  writeFileSync(join(root, encodeProjectPath(p1), 'not-a-uuid.jsonl'), transcript(p1, 'x', '2026-04-01T00:00:00Z'))
  return { root, p1, p2, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('encodeProjectPath matches Claude Code dir naming', () => {
  assert.equal(encodeProjectPath('/Users/a.b/My Repo_x'), '-Users-a-b-My-Repo-x')
  assert.equal(encodeProjectPath('/Users/me/Mohamed’s Air'), '-Users-me-Mohamed-s-Air')
})

test('listAllSessions spans every project, newest first, with real cwd', async () => {
  const { root, p1, p2, cleanup } = setup()
  try {
    const all = await listAllSessions(root)
    assert.deepEqual(all.map((s) => s.sessionId), [ID_B, ID_C, ID_A])
    assert.equal(all[0].projectPath, p2)
    assert.equal(all[1].projectPath, p1)
    assert.equal(all[0].firstMessage, 'newest in p2')
  } finally { cleanup() }
})

test('listAllSessions respects limit by newest mtime', async () => {
  const { root, cleanup } = setup()
  try {
    const top = await listAllSessions(root, 2)
    assert.deepEqual(top.map((s) => s.sessionId), [ID_B, ID_C])
  } finally { cleanup() }
})

test('listProjectSessions finds sessions for paths with dots and spaces', async () => {
  const { root, p1, cleanup } = setup()
  try {
    const s = await listProjectSessions(root, p1)
    assert.deepEqual(s.map((x) => x.sessionId), [ID_C, ID_A])
    assert.deepEqual(await listProjectSessions(root, 'relative/path'), [])
  } finally { cleanup() }
})

test('findSessionFile falls back to searching all projects', () => {
  const { root, p2, cleanup } = setup()
  try {
    const expected = join(root, encodeProjectPath(p2), `${ID_B}.jsonl`)
    assert.equal(findSessionFile(root, ID_B, p2), expected)
    assert.equal(findSessionFile(root, ID_B, '/wrong/path'), expected)
    assert.equal(findSessionFile(root, ID_B), expected)
    assert.equal(findSessionFile(root, '../etc/passwd'), null)
  } finally { cleanup() }
})

test('title prefers latest customTitle, then latest aiTitle, else null', async () => {
  const { root, p1, p2, cleanup } = setup()
  try {
    const dir1 = join(root, encodeProjectPath(p1))
    const add = (file: string, recs: object[]) =>
      writeFileSync(join(dir1, file), recs.map((r) => JSON.stringify(r)).join('\n') + '\n', { flag: 'a' })
    add(`${ID_A}.jsonl`, [
      { type: 'ai-title', aiTitle: 'First guess', sessionId: ID_A },
      { type: 'ai-title', aiTitle: 'Better guess', sessionId: ID_A },
    ])
    add(`${ID_C}.jsonl`, [
      { type: 'custom-title', customTitle: 'Old name', sessionId: ID_C },
      { type: 'ai-title', aiTitle: 'Auto name', sessionId: ID_C },
      { type: 'custom-title', customTitle: 'My rename', sessionId: ID_C },
    ])
    const byId = new Map((await listAllSessions(root)).map((s) => [s.sessionId, s]))
    assert.equal(byId.get(ID_A)?.title, 'Better guess')
    assert.equal(byId.get(ID_C)?.title, 'My rename')
    assert.equal(byId.get(ID_B)?.title, null)
    assert.equal(await readSessionTitle(root, ID_C, p2), 'My rename')
    assert.equal(await readSessionTitle(root, ID_B), null)
  } finally { cleanup() }
})

test('firstMessage skips harness wrappers and meta entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clui-sessions-'))
  try {
    const proj = '/Users/x/repo'
    mkdirSync(join(root, encodeProjectPath(proj)))
    const ts = '2026-01-01T00:00:00Z'
    const recs = [
      { type: 'user', uuid: 'a', timestamp: ts, cwd: proj, isMeta: true, message: { content: 'meta text' } },
      { type: 'user', uuid: 'b', timestamp: ts, cwd: proj, message: { content: '<local-command-caveat>x</local-command-caveat>' } },
      { type: 'user', uuid: 'c', timestamp: ts, cwd: proj, message: { content: 'real question' } },
    ]
    writeFileSync(join(root, encodeProjectPath(proj), `${ID_A}.jsonl`), recs.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const [s] = await listAllSessions(root)
    assert.equal(s.firstMessage, 'real question')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('lastPathLine ignores shell chatter before the real output', async () => {
  const { lastPathLine } = await import('../src/main/cli-env.ts')
  assert.equal(lastPathLine('Restored session: Sun Sep 27 07:51:56 EDT 2026\n/Users/x/.local/bin/claude\n'), '/Users/x/.local/bin/claude')
  assert.equal(lastPathLine('/usr/bin:/bin'), '/usr/bin:/bin')
  assert.equal(lastPathLine('claude not found'), '')
})

test('writeAiTitle stores a generated title that a later /rename overrides', async () => {
  const { root, p1, cleanup } = setup()
  try {
    assert.equal(writeAiTitle(root, ID_A, '  Auto   Named  ', p1), 'Auto Named')
    assert.equal(await readSessionTitle(root, ID_A, p1), 'Auto Named')
    renameSession(root, ID_A, 'Mine', p1)
    assert.equal(await readSessionTitle(root, ID_A, p1), 'Mine')
    assert.throws(() => writeAiTitle(root, 'nope', 'x'), /Invalid session id/)
    assert.throws(() => writeAiTitle(root, ID_A, '   ', p1), /Title is empty/)
  } finally { cleanup() }
})
