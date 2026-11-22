// Demo mode: a synthetic, looping session for trying Pitwall without an agent running and for
// screenshots. Everything here is invented; it reads nothing from disk.
import type { AgentView, GateEntry, GateState, LogEntry, Snapshot, SubagentView } from '../shared/types'
import { familyOf } from './summarize'

const LOOP_S = 90

const CALLS: [string, string][] = [
  ['Read', 'src/limits/token-bucket.ts'],
  ['Grep', 'retryAfter in src/'],
  ['Read', 'src/http/middleware.ts'],
  ['Bash', 'Run the rate limiter tests'],
  ['Edit', 'src/limits/token-bucket.ts'],
  ['Glob', 'src/**/*.test.ts'],
  ['mcp__github__get_pull_request', 'github · get_pull_request'],
  ['Edit', 'src/http/middleware.ts'],
  ['WebFetch', 'datatracker.ietf.org/doc/html/rfc6585'],
  ['Bash', 'pnpm typecheck'],
  ['Write', 'src/limits/sliding-window.ts'],
  ['Agent', 'code-reviewer: Review the limiter changes'],
  ['Read', 'docs/rate-limits.md'],
  ['Edit', 'docs/rate-limits.md'],
  ['Bash', 'pnpm test --filter limits']
]

function rng(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280
  return x - Math.floor(x)
}

export function demoSnapshot(now: number, startedAt: number, showCost: boolean): Snapshot {
  const t = ((now - startedAt) / 1000) % LOOP_S
  const loopStart = now - t * 1000
  const at = (s: number) => loopStart + s * 1000

  const gate: GateEntry[] = []
  const log: LogEntry[] = [{ at: at(0), agentKey: 'demo-1', kind: 'prompt', text: 'Add a sliding-window limiter and return Retry-After on 429' }]
  const step = 2.6
  const shown = Math.min(CALLS.length * 3, Math.floor(t / step) + 1)
  for (let i = 0; i < shown; i++) {
    const [tool, summary] = CALLS[i % CALLS.length]
    const start = 1 + i * step
    const dur = 0.6 + rng(i) * 2.2
    const sub = i % 3 === 2
    const r = rng(i + 100)
    let state: GateState = t < start + dur ? 'running' : r < 0.06 ? 'error' : 'ok'
    if (i === 9 && t >= start + dur) state = 'denied'
    gate.push({ id: `demo-${i}`, at: at(start), endedAt: state === 'running' ? null : at(start + dur), agentKey: sub ? 'demo-1' : 'demo-1', sub, tool, family: familyOf(tool), summary, state })
    if (state === 'error') log.push({ at: at(start + dur), agentKey: 'demo-1', kind: 'error', text: `${tool} ${summary} failed` })
    if (state === 'denied') log.push({ at: at(start + dur), agentKey: 'demo-1', kind: 'denied', text: `${tool} denied` })
    if (tool === 'Edit' || tool === 'Write') log.push({ at: at(start), agentKey: 'demo-1', kind: 'edit', text: `${tool} ${summary}` })
  }
  // The second agent waits on the person for a migration.
  gate.push({ id: 'demo-ask', at: at(4), endedAt: null, agentKey: 'demo-2', sub: false, tool: 'Bash', family: 'shell', summary: 'pnpm db:migrate --env staging', state: 'asking' })
  log.push({ at: at(4), agentKey: 'demo-2', kind: 'asking', text: 'asks to run Bash: pnpm db:migrate --env staging' })

  const sub = (id: string, type: string, task: string, model: string, s: number, len: number, steps: number): SubagentView => {
    const running = t >= s && t < s + len
    const done = t >= s + len
    const frac = Math.max(0, Math.min(1, (t - s) / len))
    return {
      id,
      type,
      task,
      model,
      startedAt: at(s),
      endedAt: done ? at(s + len) : null,
      status: running ? 'running' : 'done',
      ctxTokens: Math.round(18_000 + frac * 64_000),
      outTokens: Math.round(frac * 9_400),
      steps: Math.round(frac * steps),
      costUsd: +(frac * 0.42).toFixed(3),
      lastTools: running ? ['Read', 'Grep', 'Read'].slice(0, 1 + (Math.floor(t) % 3)) : ['Read', 'Grep', 'Read']
    }
  }
  const subs = [
    sub('a1', 'Explore', 'Find every caller of the old limiter', 'claude-haiku-5-5', 6, 22, 14),
    sub('a2', 'Explore', 'Map retry handling in the HTTP client', 'claude-haiku-5-5', 9, 30, 19),
    sub('a3', 'code-reviewer', 'Review the limiter changes', 'claude-sonnet-5-5', 34, 38, 23)
  ].filter((s) => t >= (s.startedAt - loopStart) / 1000)
  for (const s of subs) {
    log.push({ at: s.startedAt, agentKey: 'demo-1', kind: 'spawn', text: `${s.type}: ${s.task}` })
    if (s.endedAt) log.push({ at: s.endedAt, agentKey: 'demo-1', kind: 'done', text: `${s.type} finished` })
  }
  if (t > 48) log.push({ at: at(48), agentKey: 'demo-1', kind: 'compact', text: 'context compacted 361k → 48k (auto)' })

  const ctx = t > 48 ? 48_000 + (t - 48) * 2_600 : 180_000 + t * 3_700
  const a1: AgentView = {
    key: 'demo-1',
    agentKind: 'claude',
    title: 'Sliding-window limiter',
    workspaceName: 'api-142-rate-limits',
    branch: 'feat/sliding-window',
    state: 'working',
    stateSince: at(0),
    source: 'transcript',
    formatUnknown: false,
    loading: false,
    model: 'claude-opus-5-5',
    effort: 'high',
    ctxTokens: Math.round(ctx),
    ctxWindow: 400_000,
    ctxModelWindow: 1_000_000,
    ctxBasis: 'compact',
    compactions: t > 48 ? 2 : 1,
    costUsd: 3.18 + t * 0.021,
    outTokens: Math.round(84_000 + t * 410),
    requests: 212 + Math.floor(t / 2),
    cacheHitPct: 91.4,
    turn: { startedAt: at(0), endedAt: null, prompt: 'Add a sliding-window limiter and return Retry-After on 429', tools: shown, edits: Math.floor(shown / 4), errors: gate.filter((g) => g.agentKey === 'demo-1' && g.state === 'error').length, agents: subs.length, costUsd: t * 0.021 },
    lastTurn: { startedAt: at(-400), endedAt: at(-212), prompt: 'Why do 429s spike at the top of the hour?', tools: 31, edits: 0, errors: 1, agents: 2, costUsd: 0.86 },
    subagents: subs,
    subagentTotal: subs.length,
    canFocus: false,
    unseen: false,
    background: [
      { id: 'demo-shell', kind: 'shell', label: 'Start the API dev server', startedAt: at(-310), dueAt: null, schedule: null, recurring: false, endsAt: null, detail: null, overdue: false },
      { id: 'demo-cron', kind: 'cron', label: 'Check the canary error rate and post it in the PR', startedAt: at(-1500), dueAt: at(240), schedule: 'Every 10 minutes', recurring: true, endsAt: at(-1500) + 30 * 86_400_000, detail: null, overdue: false }
    ],
    backgroundCount: { running: 1, scheduled: 1 }
  }
  const a2: AgentView = {
    key: 'demo-2',
    agentKind: 'claude',
    title: 'Usage chart',
    workspaceName: 'web-88-usage-dashboard',
    branch: 'feat/usage-chart',
    state: 'blocked',
    stateSince: at(4),
    source: 'transcript',
    formatUnknown: false,
    loading: false,
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    ctxTokens: 61_200,
    ctxWindow: 1_000_000,
    ctxModelWindow: 1_000_000,
    ctxBasis: 'model',
    compactions: 0,
    costUsd: 0.74,
    outTokens: 12_900,
    requests: 38,
    cacheHitPct: 88.2,
    turn: { startedAt: at(-30), endedAt: null, prompt: 'Wire the usage chart to the new endpoint', tools: 9, edits: 3, errors: 0, agents: 0, costUsd: 0.21 },
    lastTurn: null,
    subagents: [],
    subagentTotal: 0,
    canFocus: false,
    unseen: false,
    background: [],
    backgroundCount: { running: 0, scheduled: 0 }
  }
  const a3: AgentView = {
    key: 'demo-3',
    agentKind: 'codex',
    title: 'API reference',
    workspaceName: 'docs-12-api-reference',
    branch: 'docs/api-reference',
    state: 'done',
    stateSince: at(-95),
    source: 'orca-only',
    formatUnknown: false,
    loading: false,
    model: null,
    effort: null,
    ctxTokens: 0,
    ctxWindow: 0,
    ctxModelWindow: 0,
    ctxBasis: 'model',
    compactions: 0,
    costUsd: null,
    outTokens: 0,
    requests: 0,
    cacheHitPct: null,
    turn: null,
    lastTurn: null,
    subagents: [],
    subagentTotal: 0,
    canFocus: false,
    unseen: true,
    background: [],
    backgroundCount: { running: 0, scheduled: 0 }
  }
  // Two Remote Control sessions running outside Orca: one at work, one idle.
  const rc1Calls: [string, string][] = [
    ['Read', 'src/invoices/export.ts'],
    ['Bash', 'npm test -- invoices'],
    ['Edit', 'src/invoices/export.ts']
  ]
  const rcShown = Math.min(rc1Calls.length, 1 + Math.floor(t / 20))
  for (let i = 0; i < rcShown; i++) {
    const [tool, summary] = rc1Calls[i]
    const start = 3 + i * 20
    const running = i === rcShown - 1 && t < start + 6
    gate.push({ id: `demo-rc-${i}`, at: at(start), endedAt: running ? null : at(start + 6), agentKey: 'demo-rc-1', sub: false, tool, family: familyOf(tool), summary, state: running ? 'running' : 'ok' })
  }
  log.push({ at: at(-60), agentKey: 'demo-rc-1', kind: 'prompt', text: 'Export invoices as CSV with the tax column' })
  const remote = (key: string, over: Partial<AgentView>, info: NonNullable<AgentView['remote']>): AgentView => ({
    ...a3,
    key,
    agentKind: 'claude',
    title: info.name,
    workspaceName: info.project,
    branch: null,
    source: 'transcript',
    unseen: false,
    ...over,
    remote: info
  })
  const rc1 = remote(
    'demo-rc-1',
    {
      state: 'working',
      stateSince: at(-60),
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      ctxTokens: Math.round(84_000 + t * 900),
      ctxWindow: 1_000_000,
      ctxModelWindow: 1_000_000,
      costUsd: 1.42 + t * 0.008,
      requests: 64,
      cacheHitPct: 93.1,
      turn: { startedAt: at(-60), endedAt: null, prompt: 'Export invoices as CSV with the tax column', tools: 6 + rcShown, edits: 1, errors: 0, agents: 0, costUsd: 0.31 + t * 0.008 }
    },
    { url: 'https://claude.ai/code/session_01DemoRemoteBillingA1', name: 'billing-a3', project: 'billing-service', cwd: '/work/billing-service', updatedAt: now - 2_000 }
  )
  const rc2 = remote(
    'demo-rc-2',
    {
      state: 'done',
      stateSince: at(-1_840),
      model: 'claude-opus-5-5',
      effort: 'high',
      ctxTokens: 312_000,
      ctxWindow: 400_000,
      ctxModelWindow: 1_000_000,
      ctxBasis: 'compact',
      costUsd: 6.07,
      requests: 211,
      cacheHitPct: 89.5,
      lastTurn: { startedAt: at(-2_400), endedAt: at(-1_840), prompt: 'Rewrite the onboarding guide for the new CLI', tools: 42, edits: 9, errors: 0, agents: 2, costUsd: 1.12 }
    },
    { url: 'https://claude.ai/code/session_01DemoRemoteDocsSiteB2', name: 'docs-site-7c', project: 'docs-site', cwd: '/work/docs-site', updatedAt: at(-1_840) }
  )
  log.sort((a, b) => a.at - b.at)
  return { v: 1, at: now, scope: 'all', demo: true, showCost, agents: [a1, a2, a3], gate, log: log.slice(-60), note: null, remote: [rc1, rc2], remoteNote: null }
}
