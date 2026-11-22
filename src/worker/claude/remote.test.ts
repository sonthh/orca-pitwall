import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { assistant, prompt } from '../../../test/helpers'
import { claudeSessionUrl, isClaudeSessionUrl } from '../../shared/links'
import { Gate } from '../gate'
import { TranscriptLocator } from './files'
import { isAlive, isInside, listRemoteSessions, parseSessionFile, RemoteSessions } from './remote'

// Every id, path and name here is invented.
const SID_A = '11111111-aaaa-4bbb-8ccc-000000000001'
const SID_B = '11111111-aaaa-4bbb-8ccc-000000000002'
const SID_C = '11111111-aaaa-4bbb-8ccc-000000000003'
const BRIDGE = 'session_01TestBridgeAAAAAAAA'

function sessionJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: 41001,
    sessionId: SID_A,
    cwd: '/work/billing-service',
    startedAt: 1_700_000_000_000,
    version: '9.9.9',
    kind: 'interactive',
    entrypoint: 'sdk-cli',
    name: 'billing-a3',
    nameSource: 'derived',
    bridgeSessionId: BRIDGE,
    updatedAt: 1_700_000_100_000,
    status: 'busy',
    statusUpdatedAt: 1_700_000_090_000,
    ...over
  }
}

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pitwall-remote-'))
  mkdirSync(join(root, 'sessions'), { recursive: true })
  return root
}

function put(root: string, name: string, body: unknown): void {
  writeFileSync(join(root, 'sessions', name), typeof body === 'string' ? body : JSON.stringify(body))
}

test('a valid Remote Control session file parses, with its claude.ai link', () => {
  const f = parseSessionFile(JSON.stringify(sessionJson()))!
  assert.ok(f)
  assert.equal(f.pid, 41001)
  assert.equal(f.sessionId, SID_A)
  assert.equal(f.name, 'billing-a3')
  assert.equal(f.status, 'busy')
  assert.equal(f.updatedAt, 1_700_000_100_000)
  assert.equal(f.statusUpdatedAt, 1_700_000_090_000)
  assert.equal(f.url, `https://claude.ai/code/${BRIDGE}`)
})

test('broken JSON and non-objects are skipped, never thrown', () => {
  for (const text of ['', '{', '{"pid":', 'null', '[]', '42', '"x"', '\u0000\u0001'])
    assert.equal(parseSessionFile(text), null, JSON.stringify(text))
})

test('a missing or mistyped required field skips the file', () => {
  for (const field of ['pid', 'sessionId', 'cwd', 'updatedAt', 'bridgeSessionId']) {
    const j = sessionJson()
    delete j[field]
    assert.equal(parseSessionFile(JSON.stringify(j)), null, `without ${field}`)
  }
  const bad: Record<string, unknown>[] = [
    { pid: '41001' },
    { pid: -1 },
    { pid: 1.5 },
    { sessionId: '../../etc/passwd' },
    { sessionId: 'short' },
    { cwd: 'relative/path' },
    { cwd: 7 },
    { updatedAt: 'yesterday' },
    { updatedAt: 0 },
    { bridgeSessionId: '' },
    { bridgeSessionId: 12 }
  ]
  for (const over of bad) assert.equal(parseSessionFile(JSON.stringify(sessionJson(over))), null, JSON.stringify(over))
})

test('a plain CLI session (no bridge) is not a Remote Control session', () => {
  const j = sessionJson({ entrypoint: 'cli' })
  delete j.bridgeSessionId
  assert.equal(parseSessionFile(JSON.stringify(j)), null)
})

test('status: busy and idle are known, anything else is unknown; name falls back to the folder', () => {
  assert.equal(parseSessionFile(JSON.stringify(sessionJson({ status: 'idle' })))!.status, 'idle')
  assert.equal(parseSessionFile(JSON.stringify(sessionJson({ status: 'thinking' })))!.status, 'unknown')
  assert.equal(parseSessionFile(JSON.stringify(sessionJson({ status: undefined })))!.status, 'unknown')
  const j = sessionJson()
  delete j.name
  assert.equal(parseSessionFile(JSON.stringify(j))!.name, 'billing-service')
  assert.equal(parseSessionFile(JSON.stringify(sessionJson({ statusUpdatedAt: 'x' })))!.statusUpdatedAt, null)
})

test('a bridge id that does not fit the claude.ai pattern keeps the session but gives no link', () => {
  const f = parseSessionFile(JSON.stringify(sessionJson({ bridgeSessionId: 'session_x/../../evil' })))!
  assert.ok(f)
  assert.equal(f.url, null)
})

test('claude.ai links: only https://claude.ai/code/session_<letters and digits>', () => {
  assert.ok(isClaudeSessionUrl('https://claude.ai/code/session_01AbCdEf23456789'))
  for (const url of [
    'http://claude.ai/code/session_01AbCdEf23456789',
    'https://claude.ai.evil.com/code/session_01AbCdEf23456789',
    'https://evil.com/https://claude.ai/code/session_01AbCdEf23456789',
    'https://claude.ai/code/session_01AbCdEf23456789?x=1',
    'https://claude.ai/code/session_01AbCdEf23456789/../../settings',
    'https://claude.ai/code/session_01AbCdEf23456789#frag',
    'https://claude.ai/code/session_short',
    'https://claude.ai/code/01AbCdEf23456789',
    'https://claude.ai/code/session_01AbCdEf23456789\n',
    'javascript:alert(1)',
    'https://user@claude.ai/code/session_01AbCdEf23456789',
    'https://claude.ai/code/session_' + 'a'.repeat(65)
  ])
    assert.ok(!isClaudeSessionUrl(url), url)
  assert.ok(!isClaudeSessionUrl(null))
  assert.ok(!isClaudeSessionUrl(42))
  assert.equal(claudeSessionUrl('session_01AbCdEf23456789'), 'https://claude.ai/code/session_01AbCdEf23456789')
  assert.equal(claudeSessionUrl('session_01AbCdEf2345678/x'), null)
  assert.equal(claudeSessionUrl(undefined), null)
})

test('isAlive: a running pid is alive; ESRCH and EPERM are not; bad pids never reach kill', () => {
  assert.ok(isAlive(process.pid))
  const err = (code: string) => () => {
    throw Object.assign(new Error(code), { code })
  }
  assert.ok(!isAlive(123, err('ESRCH')))
  assert.ok(!isAlive(123, err('EPERM')))
  let called = false
  const spy = () => {
    called = true
  }
  assert.ok(!isAlive(0, spy))
  assert.ok(!isAlive(-5, spy))
  assert.ok(!isAlive(1.5, spy))
  assert.ok(!called)
})

test('listing: live bridged sessions only; broken, dead, mismatched and plain ones are skipped', async () => {
  const root = tmpRoot()
  put(root, '41001.json', sessionJson())
  put(root, '41002.json', sessionJson({ pid: 41002, sessionId: SID_B, name: 'dead-one' }))
  put(root, '41003.json', '{"pid":41003,"sessionId":')
  put(root, '41004.json', sessionJson({ pid: 9999, sessionId: SID_C }))
  const plain = sessionJson({ pid: 41005, sessionId: SID_C })
  delete plain.bridgeSessionId
  put(root, '41005.json', plain)
  put(root, '41006.json', { pid: 41006, cwd: '/work/x' })
  put(root, 'notes.json', sessionJson({ pid: 41001 }))
  put(root, '41007.json.tmp', sessionJson({ pid: 41007 }))
  mkdirSync(join(root, 'sessions', '41008.json'))
  const alive = (pid: number) => pid !== 41002
  const got = await listRemoteSessions(root, alive)
  assert.ok(got)
  assert.deepEqual(
    got!.map((f) => f.sessionId),
    [SID_A]
  )
  rmSync(root, { recursive: true })
})

test('listing never opens *.key files, even ones that look like session JSON', async () => {
  const root = tmpRoot()
  // If Pitwall read this file it would list a second session.
  put(root, '41010.3f2a9c.key', sessionJson({ pid: 41010, sessionId: SID_B }))
  put(root, '41010.key', sessionJson({ pid: 41010, sessionId: SID_B }))
  put(root, '41001.json', sessionJson())
  const got = await listRemoteSessions(root, () => true)
  assert.deepEqual(
    got!.map((f) => f.sessionId),
    [SID_A]
  )
  rmSync(root, { recursive: true })
})

test('listing: no sessions folder means none; oversized files are skipped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pitwall-remote-'))
  assert.deepEqual(await listRemoteSessions(root, () => true), [])
  mkdirSync(join(root, 'sessions'))
  put(root, '41001.json', JSON.stringify(sessionJson({ pad: 'x'.repeat(70 * 1024) })))
  assert.deepEqual(await listRemoteSessions(root, () => true), [])
  rmSync(root, { recursive: true })
})

test('isInside: the folder itself and anything below it, not a sibling with the same prefix', () => {
  assert.ok(isInside('/work/app', '/work/app'))
  assert.ok(isInside('/work/app/packages/api', '/work/app/'))
  assert.ok(!isInside('/work/app-2', '/work/app'))
  assert.ok(!isInside('/work', '/work/app'))
  assert.ok(!isInside('/work/app', ''))
  assert.ok(!isInside('/work/app', '/'))
})

test('RemoteSessions reads each kept session transcript, skips the ones Orca shows, drops dead ones', async () => {
  const root = tmpRoot()
  mkdirSync(join(root, 'projects', '-work-billing-service'), { recursive: true })
  writeFileSync(
    join(root, 'projects', '-work-billing-service', SID_A + '.jsonl'),
    [prompt(0, 'export invoices as CSV'), assistant(1, { model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40_000 } })].join('\n') + '\n'
  )
  put(root, '41001.json', sessionJson())
  put(root, '41002.json', sessionJson({ pid: 41002, sessionId: SID_B, name: 'in-orca' }))
  const living = new Set([41001, 41002])
  const rs = new RemoteSessions(new Gate(() => {}), () => {}, (pid) => living.has(pid))
  const locator = new TranscriptLocator(() => root)
  const orca = new Set([SID_B])
  assert.ok(await rs.poll(root, locator, (f) => !orca.has(f.sessionId)))
  assert.deepEqual([...rs.entries.keys()], ['rc:' + SID_A])
  const e = rs.entries.get('rc:' + SID_A)!
  assert.ok(e.claude.found)
  assert.ok(!e.claude.loading)
  assert.equal(e.claude.parser.model, 'claude-opus-5-5')
  assert.equal(e.claude.parser.ctxTokens, 40_120)
  // Nothing new: no change.
  assert.ok(!(await rs.poll(root, locator, (f) => !orca.has(f.sessionId))))
  // The process ends: the session leaves.
  living.delete(41001)
  assert.ok(await rs.poll(root, locator, (f) => !orca.has(f.sessionId)))
  assert.equal(rs.entries.size, 0)
  rmSync(root, { recursive: true })
})

test('an idle session settles tool calls left open (interrupted), like an Orca agent that turns idle', async () => {
  const root = tmpRoot()
  mkdirSync(join(root, 'projects', '-work-billing-service'), { recursive: true })
  // Recent rows, so the call enters the live list; it never gets a result (the person pressed Esc).
  const recent = (line: string, agoMs: number) => {
    const j = JSON.parse(line)
    j.timestamp = new Date(Date.now() - agoMs).toISOString()
    return JSON.stringify(j)
  }
  writeFileSync(
    join(root, 'projects', '-work-billing-service', SID_A + '.jsonl'),
    [
      recent(prompt(0, 'run the slow suite'), 60_000),
      recent(assistant(1, { usage: { input_tokens: 10, output_tokens: 5 }, tools: [{ id: 'toolu_open', name: 'Bash', input: { command: 'npm test' } }] }), 50_000)
    ].join('\n') + '\n'
  )
  const gate = new Gate(() => {})
  const rs = new RemoteSessions(gate, () => {}, () => true)
  const locator = new TranscriptLocator(() => root)
  put(root, '41001.json', sessionJson({ status: 'busy', updatedAt: Date.now() - 40_000 }))
  await rs.poll(root, locator, () => true)
  assert.equal(gate.get('toolu_open')!.state, 'running')
  put(root, '41001.json', sessionJson({ status: 'idle', updatedAt: Date.now() - 1_000, statusUpdatedAt: Date.now() - 1_000 }))
  await rs.poll(root, locator, () => true)
  assert.equal(gate.get('toolu_open')!.state, 'ok')
  rmSync(root, { recursive: true })
})

test('listing skips a session file that is a symlink', async () => {
  const root = tmpRoot()
  writeFileSync(join(root, 'elsewhere.json'), JSON.stringify(sessionJson()))
  symlinkSync(join(root, 'elsewhere.json'), join(root, 'sessions', '41001.json'))
  assert.deepEqual(await listRemoteSessions(root, () => true), [])
  rmSync(root, { recursive: true })
})
