import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import { assistant, prompt, result } from '../../test/helpers'
import type { Snapshot } from '../shared/types'
import { demoSnapshot } from './demo'
import * as main from './index'
import { fitSnapshot, statusBarOf } from './index'

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const caps = ['agent:read', 'workspace:read', 'storage:own', 'settings:own']
const hooks = ['agent.tool.before', 'agent.tool.after']
const events = ['agent.status.changed', 'workspace.changed']

function fakeClaudeDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'pitwall-worker-'))
  mkdirSync(join(root, 'projects', '-work-app'), { recursive: true })
  writeFileSync(
    join(root, 'projects', '-work-app', SID + '.jsonl'),
    [
      prompt(0, 'make it faster'),
      assistant(1, { usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50_000 }, tools: [{ id: 'toolu_1', name: 'Read', input: { file_path: '/work/app/a.ts' } }] }),
      result(2, 'toolu_1')
    ].join('\n') + '\n'
  )
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 400000 } } }))
  return root
}

async function mounted(root: string, state = 'working') {
  const host = mockHost({
    capabilities: caps,
    settings: { claudeConfigDir: root },
    results: {
      'workspace.readContext': { workspaceId: 'w1', branch: 'main', displayName: 'app', terminals: [{ id: 't1' }] },
      'agents.list': { agents: [{ terminalId: 't1', title: 'Claude', agent: 'claude', state, stateStartedAt: 1, sessionId: SID }] },
      'statusBar.update': {}
    }
  })
  const worker = await mountWorker(main, { host, hooks, events })
  return { host, worker }
}

test('reads the session transcript and answers a snapshot', async () => {
  const root = fakeClaudeDir()
  const { worker } = await mounted(root)
  const s = (await worker.request('pitwall.snapshot')) as Snapshot
  assert.equal(s.agents.length, 1)
  const a = s.agents[0]
  assert.equal(a.workspaceName, 'app')
  assert.equal(a.source, 'transcript')
  assert.equal(a.model, 'claude-opus-5-5')
  assert.equal(a.ctxWindow, 400000)
  assert.equal(a.ctxTokens, 50_120)
  assert.equal(a.turn!.prompt, 'make it faster')
  // The fixture's tool call is hours old: history counts in the turn, it does not fill the live grid.
  assert.equal(a.turn!.tools, 1)
  assert.equal(s.gate.length, 0)
  await worker.deactivate()
  rmSync(root, { recursive: true })
})

test('hooks always pass and record live calls; a blocked agent asks', async () => {
  const root = fakeClaudeDir()
  const { worker } = await mounted(root)
  await worker.request('pitwall.snapshot')
  const before = await worker.hooks.fire('agent.tool.before', { agent: 'claude', workspaceId: 'w1', terminalId: 't1', tool: 'Bash', input: { command: 'make deploy' }, callId: 'toolu_9' })
  assert.equal(before.kind, 'continue')
  await worker.emit('agent.status.changed', { workspaceId: 'w1', paneKey: 'p', terminalId: 't1', state: 'blocked', receivedAt: Date.now(), sessionId: SID })
  let s = (await worker.request('pitwall.snapshot')) as Snapshot
  assert.equal(s.gate.find((g) => g.id === 'toolu_9')!.state, 'asking')
  assert.equal(s.agents[0].state, 'blocked')
  const after = await worker.hooks.fire('agent.tool.after', { agent: 'claude', workspaceId: 'w1', terminalId: 't1', tool: 'Bash', input: {}, callId: 'toolu_9', output: { stdout: '' } })
  assert.equal(after.kind, 'continue')
  s = (await worker.request('pitwall.snapshot')) as Snapshot
  assert.equal(s.gate.find((g) => g.id === 'toolu_9')!.state, 'ok')
  await worker.deactivate()
  rmSync(root, { recursive: true })
})

test('a permission prompt reported as waiting shows the open call as asking', async () => {
  const root = fakeClaudeDir()
  const { worker } = await mounted(root)
  await worker.request('pitwall.snapshot')
  await worker.hooks.fire('agent.tool.before', { agent: 'claude', workspaceId: 'w1', terminalId: 't1', tool: 'Bash', input: { command: 'touch x' }, callId: 'toolu_w' })
  await worker.emit('agent.status.changed', { workspaceId: 'w1', paneKey: 'p', terminalId: 't1', state: 'waiting', receivedAt: Date.now(), sessionId: SID })
  let s = (await worker.request('pitwall.snapshot')) as Snapshot
  assert.equal(s.gate.find((g) => g.id === 'toolu_w')!.state, 'asking')
  assert.equal(s.agents[0].state, 'blocked')
  // Denied: Claude Code reports the turn done; the transcript decides denied later.
  await worker.emit('agent.status.changed', { workspaceId: 'w1', paneKey: 'p', terminalId: 't1', state: 'done', receivedAt: Date.now() + 5000, sessionId: SID })
  s = (await worker.request('pitwall.snapshot')) as Snapshot
  assert.notEqual(s.gate.find((g) => g.id === 'toolu_w')!.state, 'asking')
  assert.equal(s.agents[0].state, 'done')
  await worker.deactivate()
  rmSync(root, { recursive: true })
})

test('demo mode, reset and scope requests', async () => {
  const root = fakeClaudeDir()
  const { worker, host } = await mounted(root)
  const demo = (await worker.request('pitwall.setDemo', { on: true })) as Snapshot
  assert.equal(demo.demo, true)
  assert.ok(demo.agents.length >= 2)
  assert.equal(host.data().storage.demo, true)
  const off = (await worker.request('pitwall.setDemo', { on: false })) as Snapshot
  assert.equal(off.demo, false)
  const cleared = (await worker.request('pitwall.reset')) as Snapshot
  assert.equal(cleared.gate.length, 0)
  await worker.request('pitwall.setScope', { scope: 'focused' })
  assert.equal(host.data().settings.scope, 'focused')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
  rmSync(root, { recursive: true })
})

test('status bar text: asking first, context and cost', () => {
  const base: Snapshot = {
    v: 1,
    at: 0,
    scope: 'focused',
    demo: false,
    showCost: true,
    agents: [],
    gate: [],
    log: [],
    note: null,
    remote: [],
    remoteNote: null
  }
  assert.equal(statusBarOf(base, true).text, 'no agents')
  const agent = {
    key: 'k',
    agentKind: 'claude',
    title: 't',
    workspaceName: 'app',
    branch: null,
    state: 'working' as const,
    stateSince: 0,
    source: 'transcript' as const,
    model: 'claude-opus-5-5',
    effort: null,
    ctxTokens: 340_000,
    ctxWindow: 400_000,
    compactions: 0,
    costUsd: 1.5,
    outTokens: 0,
    requests: 1,
    cacheHitPct: null,
    turn: null,
    lastTurn: null,
    subagents: [],
    subagentTotal: 0,
    canFocus: false,
    unseen: false,
    formatUnknown: false,
    loading: false,
    ctxModelWindow: 1_000_000,
    ctxBasis: 'compact' as const,
    background: [],
    backgroundCount: { running: 0, scheduled: 0 }
  }
  const s = { ...base, agents: [agent], gate: [{ id: 'g', at: 0, endedAt: null, agentKey: 'k', sub: false, tool: 'Bash', family: 'shell' as const, summary: '', state: 'asking' as const }] }
  const out = statusBarOf(s, true)
  assert.equal(out.text, '1 asking · 1 working · ctx 85% · $1.50')
  assert.equal(out.tone, 'warning')
  assert.equal(statusBarOf({ ...s, gate: [], showCost: false }, true).text, '1 working · ctx 85%')
  assert.equal(statusBarOf({ ...s, gate: [] }, true).tone, 'warning')
  // A transcript still being read gives a partial sum: no total until every one is read.
  assert.equal(statusBarOf({ ...s, gate: [], agents: [{ ...agent, loading: true }] }, true).text, '1 working · ctx 85%')
})

test('the status bar counts background work', () => {
  const s = demoSnapshot(Date.now(), Date.now() - 40_000, true)
  const out = statusBarOf(s, true)
  assert.ok(out.text.includes('2 bg'), out.text)
  assert.ok(out.tooltip.includes('· 2 bg'))
  for (const a of s.agents) a.backgroundCount = { running: 0, scheduled: 0 }
  assert.ok(!statusBarOf(s, true).text.includes('bg'))
})

test('background work from the transcript: shown once read, dropped when its schedule is long past', async () => {
  const root = fakeClaudeDir()
  const file = join(root, 'projects', '-work-app', SID + '.jsonl')
  const t = Date.now()
  const iso = (ms: number) => new Date(ms).toISOString()
  const row = (o: Record<string, unknown>) => JSON.stringify(o) + '\n'
  appendFileSync(
    file,
    row({ type: 'assistant', timestamp: iso(t - 60_000), message: { id: 'm9', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: 'npm run dev', description: 'Start the dev server', run_in_background: true } }] } }) +
      row({ type: 'user', timestamp: iso(t - 59_000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'Command running in background with ID: bdev12345.' }] }, toolUseResult: { backgroundTaskId: 'bdev12345' } }) +
      row({ type: 'assistant', timestamp: iso(t - 58_000), message: { id: 'm10', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_cron', name: 'CronCreate', input: { cron: '0 0 1 1 *', prompt: 'long ago', recurring: false } }] } }) +
      row({ type: 'user', timestamp: iso(t - 57_000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_cron', content: 'Scheduled one-shot task jold1234 (0 0 1 1 *).' }] }, toolUseResult: { id: 'jold1234', recurring: false, nextFireAt: t - 3_600_000 } })
  )
  // Idle for an hour: the one-shot job an hour overdue will not run, the shell still does.
  const host = mockHost({
    capabilities: caps,
    settings: { claudeConfigDir: root },
    results: {
      'workspace.readContext': { workspaceId: 'w1', branch: 'main', displayName: 'app', terminals: [{ id: 't1' }] },
      'agents.list': { agents: [{ terminalId: 't1', title: 'Claude', agent: 'claude', state: 'done', stateStartedAt: t - 3_600_000, sessionId: SID }] },
      'statusBar.update': {}
    }
  })
  const worker = await mountWorker(main, { host, hooks, events })
  let s = (await worker.request('pitwall.snapshot')) as Snapshot
  assert.deepEqual(s.agents[0].background.map((x) => x.id), ['bdev12345'])
  assert.equal(s.agents[0].background[0].label, 'Start the dev server')
  // While it works, the late job waits instead.
  await worker.emit('agent.status.changed', { workspaceId: 'w1', paneKey: 'p', terminalId: 't1', state: 'working', receivedAt: Date.now(), sessionId: SID })
  s = (await worker.request('pitwall.snapshot')) as Snapshot
  const late = s.agents[0].background.find((x) => x.id === 'jold1234')!
  assert.equal(late.overdue, true)
  await worker.deactivate()
  rmSync(root, { recursive: true })
})

test('a failed agents.list keeps the agents; hooks from other workspaces are ignored', async () => {
  const root = fakeClaudeDir()
  let fail = false
  const host = mockHost({
    capabilities: caps,
    settings: { claudeConfigDir: root },
    results: {
      'workspace.readContext': { workspaceId: 'w1', branch: 'main', displayName: 'app', terminals: [{ id: 't1', title: '✳ Fix the parser' }] },
      'agents.list': () => {
        if (fail) throw hostError('timeout', 'slow')
        return { agents: [{ terminalId: 't1', title: 'Claude', agent: 'claude', state: 'working', stateStartedAt: 1, sessionId: SID }] }
      },
      'statusBar.update': {}
    }
  })
  const worker = await mountWorker(main, { host, hooks, events })
  let s = (await worker.request('pitwall.snapshot')) as Snapshot
  assert.equal(s.agents[0].title, 'Fix the parser')
  fail = true
  await worker.request('pitwall.setScope', { scope: 'focused' })
  s = (await worker.request('pitwall.snapshot')) as Snapshot
  assert.equal(s.agents.length, 1)
  await worker.hooks.fire('agent.tool.before', { agent: 'claude', workspaceId: 'w2', terminalId: 't9', tool: 'Bash', input: {}, callId: 'other' })
  s = (await worker.request('pitwall.snapshot')) as Snapshot
  assert.ok(!s.gate.some((g) => g.id === 'other'))
  await worker.deactivate()
  rmSync(root, { recursive: true })
})

test('a huge snapshot is trimmed under the post limit', () => {
  const gate = Array.from({ length: 160 }, (_, i) => ({ id: `g${i}`, at: i, endedAt: i, agentKey: 'k', sub: false, tool: 'Bash', family: 'shell' as const, summary: 'x'.repeat(90), state: 'ok' as const }))
  const log = Array.from({ length: 60 }, (_, i) => ({ at: i, agentKey: 'k', kind: 'edit' as const, text: 'y'.repeat(200) }))
  const s: Snapshot = { v: 1, at: 0, scope: 'all', demo: false, showCost: true, agents: [], gate, log, note: null, remote: [], remoteNote: null }
  const out = fitSnapshot(s, 10_000)
  assert.ok(JSON.stringify(out).length <= 10_000 || out.gate.length === 0)
  assert.equal(fitSnapshot(s).gate.length, 160)
})

test('generic shell and terminal titles fall back to the workspace name', () => {
  assert.equal(main.cleanTitle('Terminal 8'), null)
  assert.equal(main.cleanTitle('✳ Claude Code'), null)
  assert.equal(main.cleanTitle('✳ Fix the parser'), 'Fix the parser')
})

test('focus brings the agent terminal to the front, and only on request', async () => {
  const root = fakeClaudeDir()
  const calls: unknown[] = []
  const host = mockHost({
    capabilities: [...caps, 'workspace:write'],
    settings: { claudeConfigDir: root },
    results: {
      'workspace.readContext': { workspaceId: 'w1', branch: 'main', displayName: 'app', terminals: [{ id: 't1' }] },
      'agents.list': { agents: [{ terminalId: 't1', title: 'Claude', agent: 'claude', state: 'done', stateStartedAt: 1, sessionId: SID }] },
      'statusBar.update': {},
      'terminal.focus': (p: unknown) => {
        calls.push(p)
        return { focused: true }
      }
    }
  })
  const worker = await mountWorker(main, { host, hooks, events })
  const s = (await worker.request('pitwall.snapshot')) as Snapshot
  assert.equal(s.agents[0].canFocus, true)
  assert.equal(calls.length, 0)
  const r = (await worker.request('pitwall.focus', { key: s.agents[0].key })) as { focused: boolean }
  assert.equal(r.focused, true)
  assert.deepEqual(calls, [{ terminalId: 't1' }])
  const miss = (await worker.request('pitwall.focus', { key: 'nope' })) as { focused: boolean }
  assert.equal(miss.focused, false)
  await worker.deactivate()
  rmSync(root, { recursive: true })
})

test('status bar does not call an agent that needs you idle', () => {
  const s = demoSnapshot(Date.now(), Date.now() - 40_000, true)
  const working = s.agents.find((a) => a.state === 'working')!
  working.state = 'done'
  const text = statusBarOf(s, true).text
  assert.ok(text.includes('2 idle'), text)
  assert.ok(!text.includes('3 idle'), text)
})

test('an agent that finishes while you are elsewhere is new until you look at it', async () => {
  const root = fakeClaudeDir()
  const { worker } = await mounted(root, 'working')
  let s = (await worker.request('pitwall.snapshot')) as Snapshot
  const key = s.agents[0].key
  assert.equal(s.agents[0].unseen, false)
  await worker.emit('agent.status.changed', { workspaceId: 'w1', paneKey: 'p', terminalId: 't1', state: 'done', receivedAt: Date.now(), sessionId: SID })
  s = (await worker.request('pitwall.snapshot')) as Snapshot
  assert.equal(s.agents[0].unseen, true)
  s = (await worker.request('pitwall.seen', { key })) as Snapshot
  assert.equal(s.agents[0].unseen, false)
  await worker.emit('agent.status.changed', { workspaceId: 'w1', paneKey: 'p', terminalId: 't1', state: 'working', receivedAt: Date.now(), sessionId: SID })
  await worker.emit('agent.status.changed', { workspaceId: 'w1', paneKey: 'p', terminalId: 't1', state: 'done', receivedAt: Date.now(), sessionId: SID })
  s = (await worker.request('pitwall.snapshot')) as Snapshot
  assert.equal(s.agents[0].unseen, true)
  await worker.deactivate()
  rmSync(root, { recursive: true })
})

test('an agent first seen already done, after Pitwall started, is new', async () => {
  const root = fakeClaudeDir()
  const host = mockHost({
    capabilities: caps,
    settings: { claudeConfigDir: root },
    results: {
      'workspace.readContext': { workspaceId: 'w1', branch: 'main', displayName: 'app', terminals: [{ id: 't1' }, { id: 't2' }] },
      'agents.list': {
        agents: [
          { terminalId: 't1', title: 'Claude', agent: 'claude', state: 'done', stateStartedAt: Date.now() + 1000, sessionId: SID },
          { terminalId: 't2', title: 'Old', agent: 'claude', state: 'done', stateStartedAt: 1, sessionId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee' }
        ]
      },
      'statusBar.update': {}
    }
  })
  const worker = await mountWorker(main, { host, hooks, events })
  const s = (await worker.request('pitwall.snapshot')) as Snapshot
  const byTerm = (k: string) => s.agents.find((a) => a.key.includes(k === 't1' ? SID : 'bbbbbbbb'))!
  assert.equal(byTerm('t1').unseen, true)
  assert.equal(byTerm('t2').unseen, false)
  await worker.deactivate()
  rmSync(root, { recursive: true })
})

// ---- Remote Control sessions outside Orca (synthetic files; the pids are this test's own process and its parent, so they are alive)

const RC_SID = '22222222-aaaa-4bbb-8ccc-000000000001'

function withRemote(root: string): void {
  mkdirSync(join(root, 'sessions'), { recursive: true })
  mkdirSync(join(root, 'projects', '-work-app-billing'), { recursive: true })
  writeFileSync(
    join(root, 'projects', '-work-app-billing', RC_SID + '.jsonl'),
    [prompt(0, 'export invoices as CSV'), assistant(1, { usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30_000 } })].join('\n') + '\n'
  )
  const base = { cwd: '/work/app/billing', kind: 'interactive', entrypoint: 'sdk-cli', status: 'busy', updatedAt: Date.now() - 5_000, statusUpdatedAt: Date.now() - 60_000 }
  writeFileSync(join(root, 'sessions', `${process.pid}.json`), JSON.stringify({ ...base, pid: process.pid, sessionId: RC_SID, name: 'billing-a3', bridgeSessionId: 'session_01TestBridgeRemoteA' }))
  // The Orca agent's own session also runs Remote Control: Orca shows it, so it must not show twice.
  writeFileSync(join(root, 'sessions', `${process.ppid}.json`), JSON.stringify({ ...base, pid: process.ppid, sessionId: SID, name: 'in-orca', bridgeSessionId: 'session_01TestBridgeRemoteB' }))
  // A secret next to them that must never be read.
  writeFileSync(join(root, 'sessions', `${process.pid}.deadbeef.key`), 'not-json-secret')
}

async function mountedRemote(root: string, workspaces: unknown) {
  const host = mockHost({
    capabilities: caps,
    settings: { claudeConfigDir: root },
    results: {
      'workspace.readContext': { workspaceId: 'w1', branch: 'main', displayName: 'app', terminals: [{ id: 't1' }] },
      'workspace.list': workspaces,
      'agents.list': { agents: [{ terminalId: 't1', title: 'Claude', agent: 'claude', state: 'working', stateStartedAt: 1, sessionId: SID }] },
      'terminal.list': { terminals: [{ id: 't1' }] },
      'statusBar.update': {}
    }
  })
  const worker = await mountWorker(main, { host, hooks, events })
  return { host, worker }
}

test('Remote Control sessions outside Orca: shown once, read like an agent, limited to the focused workspace folder', async () => {
  const root = fakeClaudeDir()
  withRemote(root)
  const inApp = { workspaces: [{ id: 'w1', kind: 'worktree', name: 'app', path: '/work/app', branch: 'main', hostId: 'local' }], truncated: false }
  const { host, worker } = await mountedRemote(root, inApp)
  // The first read runs beside the tick; a scope request waits for it.
  let s = await worker.request('pitwall.setScope', { scope: 'focused' })
  assert.equal(s.agents.length, 1)
  assert.deepEqual(
    s.remote.map((a) => a.key),
    ['rc:' + RC_SID],
    'the Orca session is not repeated'
  )
  const r = s.remote[0]
  assert.equal(r.title, 'billing-a3')
  assert.equal(r.state, 'working')
  assert.equal(r.canFocus, false)
  assert.equal(r.source, 'transcript')
  assert.equal(r.ctxTokens, 30_120)
  assert.equal(r.turn!.prompt, 'export invoices as CSV')
  assert.deepEqual(r.remote, { url: 'https://claude.ai/code/session_01TestBridgeRemoteA', name: 'billing-a3', project: 'billing', cwd: '/work/app/billing', updatedAt: r.remote!.updatedAt })
  assert.equal(s.remoteNote, null)
  assert.ok(statusBarOf(s, true).text.includes('RC 1 working'))

  // Another folder is focused: the session is not in it.
  host.respond('workspace.list', { workspaces: [{ id: 'w1', kind: 'worktree', name: 'app', path: '/work/other', branch: 'main', hostId: 'local' }], truncated: false })
  s = await worker.request('pitwall.setScope', { scope: 'focused' })
  assert.equal(s.remote.length, 0)
  assert.ok(!statusBarOf(s, true).text.includes('RC'))

  // All workspaces: every session again.
  s = await worker.request('pitwall.setScope', { scope: 'all' })
  assert.equal(s.remote.length, 1)
  assert.equal(s.remoteNote, null)

  // The folder cannot be known (an SSH workspace): every session, with the reason.
  host.respond('workspace.list', { workspaces: [{ id: 'w1', kind: 'worktree', name: 'app', path: '/home/dev/app', branch: 'main', hostId: 'ssh:box' }], truncated: false })
  s = await worker.request('pitwall.setScope', { scope: 'focused' })
  assert.equal(s.remote.length, 1)
  assert.ok(s.remoteNote && s.remoteNote.includes("folder"))
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
  rmSync(root, { recursive: true })
})

test('broken session files never break the snapshot', async () => {
  const root = fakeClaudeDir()
  mkdirSync(join(root, 'sessions'), { recursive: true })
  writeFileSync(join(root, 'sessions', `${process.pid}.json`), '{"pid":' + process.pid + ',"sessionId":')
  writeFileSync(join(root, 'sessions', `${process.ppid}.json`), JSON.stringify({ pid: process.ppid, bridgeSessionId: 'session_01TestBridgeRemoteC' }))
  const { worker } = await mountedRemote(root, () => {
    throw hostError('timeout', 'slow')
  })
  const s = await worker.request('pitwall.setScope', { scope: 'all' })
  assert.equal(s.agents.length, 1)
  assert.equal(s.remote.length, 0)
  await worker.deactivate()
  rmSync(root, { recursive: true })
})
