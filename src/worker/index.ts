// Pitwall's worker: follows every agent Orca runs, reads Claude Code transcripts as they grow,
// records tool calls from Orca's hooks, and sends one snapshot to the open panels. Read-only:
// hooks always pass, no network, no writes outside the plugin's own storage.
import type { OrcaWorkerApi } from 'orca/worker'
import '../shared/protocol'
import { fmtUsd, pct } from '../shared/format'
import type { AgentState, AgentView, BackgroundView, LogEntry, Scope, Snapshot, SubagentView, TurnView } from '../shared/types'
import { claudeDir, compactSettings, TranscriptLocator, type CompactSettings } from './claude/files'
import { isInside, RemoteSessions, type RemoteEntry, type RemoteSessionFile } from './claude/remote'
import { ClaudeSession, turnView } from './claude/session'
import { demoSnapshot } from './demo'
import { Gate } from './gate'
import { modelWindow } from './pricing'

interface Tracked {
  key: string
  sessionId: string | null
  terminalId: string | null
  agentKind: string
  title: string
  workspaceId: string | null
  workspaceName: string
  branch: string | null
  state: AgentState
  stateSince: number
  claude: ClaudeSession | null
  /** Finished a turn and the person has not looked at it in Pitwall yet. */
  unseen: boolean
}

interface AgentRow {
  terminalId: string | null
  title: string | null
  agent: string | null
  state: AgentState
  stateStartedAt: number
  sessionId?: string | null
  task?: { title: string } | null
}

/** Claude Code puts a spinner or mark in front of its terminal title; keep only the words. */
export function cleanTitle(t: string | null | undefined): string | null {
  if (!t) return null
  const s = t.replace(/^[^\p{L}\p{N}]+/u, '').trim()
  return s && !/^(claude( code)?|zsh|bash|fish|sh|terminal( \d+)?)$/i.test(s) ? s : null
}

const LOG_MAX = 120
const POLL_MS = 1000
const POST_MIN_MS = 250
const REFRESH_MS = 5000

export class Pitwall {
  scope: Scope = 'focused'
  showCost = true
  statusBar = true
  demo = false
  contextSetting = 'auto'
  configDir = ''
  readonly tracked = new Map<string, Tracked>()
  readonly gate: Gate
  readonly log: LogEntry[] = []
  private readonly byTerminal = new Map<string, string>()
  private readonly locator: TranscriptLocator
  private compact: CompactSettings = { enabled: true, windows: {} }
  private demoStartedAt = Date.now()
  private dirty = true
  private lastPost = 0
  private lastStatus = ''
  private lastPostError = ''
  private refreshing: Promise<void> | null = null
  private refreshQueued = false
  private focusedWorkspace: string | null = null
  private readonly unknownAt = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  private ticks = 0
  private note: string | null = null
  /** Remote Control sessions running outside Orca, read from Claude Code's session files. */
  readonly remote: RemoteSessions
  /** Every session id Orca runs in a terminal, in any workspace: those are not shown again as remote. */
  private orcaSessions = new Set<string>()
  /** The focused workspace's folder on this machine, when Orca says; null when it cannot be known. */
  private focusedPath: string | null = null
  private remotePolling: Promise<void> | null = null

  /** When this worker started: an agent first met already done, but done after this, finished unseen. */
  private readonly startedAt = Date.now()

  constructor(private readonly orca: OrcaWorkerApi) {
    this.gate = new Gate((e) => this.pushLog(e))
    this.locator = new TranscriptLocator(() => claudeDir(this.configDir))
    this.remote = new RemoteSessions(this.gate, (e) => this.pushLog({ at: e.at, agentKey: e.agentKey, kind: e.kind, text: e.text }))
  }

  // ---- lifecycle -------------------------------------------------------------------------

  async start(): Promise<void> {
    await this.loadSettings()
    const demo = await this.orca.storage.get('demo').catch(() => null)
    this.demo = demo === true
    this.compact = await compactSettings(claudeDir(this.configDir))
    await this.scheduleRefresh()
    await this.pollTranscripts()
    // The panel's first answer does not wait for Remote Control transcripts; they follow in a post.
    void this.pollRemote()
    this.timer = setInterval(() => void this.tick(), POLL_MS)
    // Never keep the worker process alive on its own (tests, shutdown).
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async loadSettings(): Promise<void> {
    const s = (await this.orca.settings.get().catch(() => ({}))) as Record<string, unknown>
    this.scope = s.scope === 'all' ? 'all' : 'focused'
    this.showCost = s.showCost !== false
    this.statusBar = s.statusBar !== false
    this.contextSetting = typeof s.contextWindow === 'string' ? s.contextWindow : 'auto'
    this.configDir = typeof s.claudeConfigDir === 'string' ? s.claudeConfigDir : ''
    this.dirty = true
  }

  private async tick(): Promise<void> {
    this.ticks++
    try {
      if (this.ticks % Math.round(REFRESH_MS / POLL_MS) === 0) void this.scheduleRefresh()
      if (this.ticks % 10 === 1) this.compact = await compactSettings(claudeDir(this.configDir))
      if (await this.pollTranscripts()) this.dirty = true
      void this.pollRemote()
      // Calls read from the transcript after a restart, while the agent already waits on the person.
      for (const t of this.tracked.values()) if (asks(t.state)) this.gate.blocked(t.key, t.stateSince)
      if (this.demo) this.dirty = true
      this.flush()
    } catch (err) {
      this.orca.log(`tick failed: ${(err as Error).message}`)
    }
  }

  // ---- agents from Orca ------------------------------------------------------------------

  /** Every refresh runs through here, one at a time; a request during a run queues one more. */
  scheduleRefresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true
      return this.refreshing.then(() => this.refreshing ?? undefined)
    }
    this.refreshing = this.refresh()
      .catch((err) => this.orca.log(`refresh failed: ${(err as Error).message}`))
      .finally(() => {
        this.refreshing = null
        if (this.refreshQueued) {
          this.refreshQueued = false
          void this.scheduleRefresh()
        }
      })
    return this.refreshing
  }

  /** Refreshes for a terminal Pitwall does not know yet, at most once per 5 s per terminal. */
  private refreshForUnknown(terminalId: string | undefined): void {
    const id = terminalId ?? '?'
    const last = this.unknownAt.get(id) ?? 0
    if (Date.now() - last < REFRESH_MS) return
    this.unknownAt.set(id, Date.now())
    if (this.unknownAt.size > 200) this.unknownAt.clear()
    void this.scheduleRefresh()
  }

  /** In focused scope, events from agents in other workspaces are not ours. */
  private outOfScope(workspaceId: string | null | undefined): boolean {
    return this.scope === 'focused' && !!workspaceId && !!this.focusedWorkspace && workspaceId !== this.focusedWorkspace
  }

  async refresh(): Promise<void> {
    const seen = new Set<string>()
    const host = this.orca.host
    const scope = this.scope
    // A failed host call must not read as "no agents": that would drop every session and re-read
    // every transcript from the start. Only a complete answer may remove agents.
    let complete = true
    const call = async <T>(name: string, params: unknown, empty: T): Promise<T> => {
      try {
        return (await host.call(name as never, params as never)) as T
      } catch {
        complete = false
        return empty
      }
    }
    if (scope === 'focused') {
      const ctx = await call<{
        workspaceId?: string
        displayName?: string
        branch?: string
        terminals?: { id: string; title?: string }[]
      } | null>('workspace.readContext', undefined, null)
      this.focusedWorkspace = ctx?.workspaceId ?? null
      if (ctx) {
        const titles = new Map((ctx.terminals ?? []).map((t) => [t.id, t.title ?? '']))
        const res = await call<{ agents: AgentRow[] }>('agents.list', ctx.workspaceId ? { workspaceId: ctx.workspaceId } : undefined, { agents: [] })
        for (const a of res.agents) this.upsert(a, ctx.workspaceId ?? null, ctx.displayName ?? '', ctx.branch || null, seen, titles)
      }
      this.note = ctx ? null : 'No workspace is focused.'
      this.focusedPath = ctx?.workspaceId ? await this.workspacePath(ctx.workspaceId) : null
    } else {
      const res = await call<{
        workspaces: { id: string; name: string; branch: string | null; hostId: string | null; status?: { terminalCount: number } }[]
      }>('workspace.list', { includeStatus: true }, { workspaces: [] })
      const live = res.workspaces.filter((w) => (w.status?.terminalCount ?? 0) > 0).slice(0, 24)
      for (const w of live) {
        const r = await call<{ agents: AgentRow[] }>('agents.list', { workspaceId: w.id }, { agents: [] })
        if (!r.agents.length) continue
        const tl = await call<{ terminals: { id: string; title?: string }[] }>('terminal.list', { workspaceId: w.id }, { terminals: [] })
        const titles = new Map(tl.terminals.map((t) => [t.id, t.title ?? '']))
        for (const a of r.agents) this.upsert(a, w.id, w.name, w.branch, seen, titles)
      }
      this.note = null
    }
    await this.readOrcaSessions()
    // The scope changed while this ran: its answer is stale, the queued refresh will redo it.
    if (scope !== this.scope) {
      this.refreshQueued = true
      return
    }
    if (!complete) return
    for (const [key, t] of this.tracked)
      if (!seen.has(key)) {
        this.tracked.delete(key)
        if (t.terminalId) this.byTerminal.delete(t.terminalId)
        this.gate.forget(key)
        this.dirty = true
      }
  }

  /** The folder of a workspace on this machine, from `workspace.list`; null for another host or when Orca does not say. */
  private async workspacePath(workspaceId: string): Promise<string | null> {
    try {
      const res = (await this.orca.host.call('workspace.list' as never, undefined as never)) as { workspaces?: { id: string; path?: string; hostId?: string | null }[] }
      const w = res?.workspaces?.find((x) => x.id === workspaceId)
      const local = w && (w.hostId === null || w.hostId === undefined || w.hostId === 'local')
      return local && typeof w.path === 'string' && w.path.startsWith('/') ? w.path : null
    } catch {
      return null
    }
  }

  /** Session ids of every agent in an Orca terminal, so a Remote Control session there is not shown twice. */
  private async readOrcaSessions(): Promise<void> {
    try {
      const res = (await this.orca.host.call('agents.list' as never, undefined as never)) as { agents?: AgentRow[] }
      this.orcaSessions = new Set((res?.agents ?? []).map((a) => a.sessionId).filter((x): x is string => !!x))
    } catch {
      // Keep the last answer; the agents Pitwall tracks are checked as well.
    }
  }

  /** A Remote Control session is shown when Orca does not show it and, in focused scope, it runs in the focused workspace. */
  wantRemote(f: RemoteSessionFile): boolean {
    if (this.orcaSessions.has(f.sessionId) || this.tracked.has(`s:${f.sessionId}`)) return false
    return this.scope === 'all' || !this.focusedPath || isInside(f.cwd, this.focusedPath)
  }

  private upsert(a: AgentRow, workspaceId: string | null, workspaceName: string, branch: string | null, seen: Set<string>, titles: Map<string, string>): void {
    const key = a.sessionId ? `s:${a.sessionId}` : a.terminalId ? `t:${a.terminalId}` : null
    if (!key) return
    seen.add(key)
    let t = this.tracked.get(key)
    if (!t) {
      // Hook calls filed under this terminal before its session was known now belong to the session.
      if (a.terminalId) this.gate.rekey(`t:${a.terminalId}`, key)
      // A terminal that ran another session (after /clear): that session is over.
      const prior = a.terminalId ? this.byTerminal.get(a.terminalId) : undefined
      if (prior && prior !== key) {
        this.tracked.delete(prior)
        this.gate.forget(prior)
      }
      t = {
        key,
        sessionId: a.sessionId ?? null,
        terminalId: a.terminalId,
        agentKind: a.agent ?? 'agent',
        title: '',
        workspaceId,
        workspaceName,
        branch,
        state: a.state,
        stateSince: a.stateStartedAt,
        claude: null,
        // First met already done, after Pitwall started (another workspace, or a turn shorter than a poll).
        unseen: a.state === 'done' && a.stateStartedAt > this.startedAt
      }
      if (a.sessionId && (a.agent ?? 'claude') === 'claude')
        t.claude = new ClaudeSession(a.sessionId, key, this.gate, (e) => this.pushLog({ at: e.at, agentKey: e.agentKey, kind: e.kind, text: e.text }))
      this.tracked.set(key, t)
      this.dirty = true
    }
    if (a.terminalId) this.byTerminal.set(a.terminalId, key)
    t.title = cleanTitle(a.task?.title) ?? cleanTitle(a.terminalId ? titles.get(a.terminalId) : null) ?? cleanTitle(a.title) ?? t.title
    t.workspaceName = workspaceName || t.workspaceName
    t.branch = branch ?? t.branch
    if (t.state !== a.state) this.setState(t, a.state, a.stateStartedAt || Date.now())
  }

  onStatus(e: { workspaceId?: string | null; terminalId?: string; sessionId?: string; state: AgentState; receivedAt: number }): void {
    const key = e.sessionId ? `s:${e.sessionId}` : e.terminalId ? this.byTerminal.get(e.terminalId) : undefined
    const t = key ? this.tracked.get(key) : undefined
    if (!t) {
      if (!this.outOfScope(e.workspaceId)) this.refreshForUnknown(e.terminalId)
      return
    }
    if (t.state !== e.state) this.setState(t, e.state, e.receivedAt || Date.now())
  }

  private setState(t: Tracked, state: AgentState, at: number): void {
    const was = t.state
    t.state = state
    t.stateSince = at
    if (state === 'working') t.unseen = false
    else if ((was === 'working' || asks(was)) && state === 'done') t.unseen = true
    // A permission prompt shows as `waiting` (verified on Orca 1.4.263), some agents report `blocked`.
    if (asks(state)) this.gate.blocked(t.key, at)
    else if (asks(was)) this.gate.unblocked(t.key)
    if (state === 'done') this.gate.settle(t.key, at)
    this.dirty = true
  }

  // ---- tool calls from Orca's hooks --------------------------------------------------------

  keyForTerminal(terminalId: string | undefined, agent: string): string {
    const known = terminalId ? this.byTerminal.get(terminalId) : undefined
    if (known) return known
    this.refreshForUnknown(terminalId)
    return terminalId ? `t:${terminalId}` : `a:${agent}`
  }

  onToolBefore(e: { agent: string; workspaceId?: string | null; terminalId?: string; tool: string; input: unknown; callId?: string }): void {
    if (this.outOfScope(e.workspaceId)) return
    const key = this.keyForTerminal(e.terminalId, e.agent)
    const t = this.tracked.get(key)
    this.gate.before(key, { callId: e.callId, tool: e.tool, input: e.input }, Date.now(), t?.claude?.parser.cwd)
    // The status event can come before the hook.
    if (t && asks(t.state)) this.gate.blocked(key, Date.now())
    this.dirty = true
  }

  onToolAfter(e: { agent: string; workspaceId?: string | null; terminalId?: string; tool: string; input: unknown; callId?: string; output?: unknown }): void {
    if (this.outOfScope(e.workspaceId)) return
    const key = this.keyForTerminal(e.terminalId, e.agent)
    this.gate.after(key, { callId: e.callId, tool: e.tool, input: e.input, output: e.output }, Date.now())
    this.dirty = true
  }

  // ---- transcripts -----------------------------------------------------------------------

  async pollTranscripts(): Promise<boolean> {
    let changed = false
    for (const t of this.tracked.values()) if (t.claude && (await t.claude.poll(this.locator))) changed = true
    return changed
  }

  /**
   * Reads the Remote Control sessions, one run at a time. The tick does not wait for it: the first read
   * of a long transcript takes seconds and must not hold up the agents in Orca's terminals.
   */
  pollRemote(): Promise<void> {
    if (this.remotePolling) return this.remotePolling
    this.remotePolling = this.remote
      .poll(claudeDir(this.configDir), this.locator, (f) => this.wantRemote(f))
      .then((changed) => {
        if (changed) this.dirty = true
      })
      // Claude Code's session files are internal: whatever goes wrong there must not stop the panel.
      .catch((err) => this.orca.log(`remote sessions: ${(err as Error).message}`))
      .finally(() => {
        this.remotePolling = null
      })
    return this.remotePolling
  }

  private ctxWindow(model: string | null): { window: number; basis: 'model' | 'compact' | 'setting' } {
    if (this.contextSetting !== 'auto') {
      const n = Number(this.contextSetting)
      if (Number.isFinite(n) && n > 0) return { window: n, basis: 'setting' }
    }
    const own = modelWindow(model)
    if (!model || !this.compact.enabled) return { window: own, basis: 'model' }
    const base = model.replace(/\[1m\]$/, '')
    const set = this.compact.windows[model] ?? this.compact.windows[base] ?? this.compact.windows['*']
    return set && set > 0 && set < own ? { window: set, basis: 'compact' } : { window: own, basis: 'model' }
  }

  // ---- output ----------------------------------------------------------------------------

  private pushLog(e: LogEntry): void {
    this.log.push(e)
    if (this.log.length > LOG_MAX * 2) this.log.splice(0, this.log.length - LOG_MAX)
    this.dirty = true
  }

  private ctxView(has: boolean, model: string | null): Pick<AgentView, 'ctxWindow' | 'ctxModelWindow' | 'ctxBasis'> {
    // No request yet means no model, so no window to measure against: show no gauge rather than a guessed one.
    if (!has || !model) return { ctxWindow: 0, ctxModelWindow: 0, ctxBasis: 'model' }
    const w = this.ctxWindow(model)
    return { ctxWindow: w.window, ctxModelWindow: modelWindow(model), ctxBasis: w.basis }
  }

  view(t: Tracked, now: number): AgentView {
    const c = t.claude
    const loading = !!(c && c.loading)
    // Numbers read from a transcript only show once it is read to the end; until then they are partial sums.
    const has = !!(c && c.found) && !loading
    const p = has ? c?.parser : undefined
    // Waiting with a call open means waiting on the person, which the panel shows as "needs you".
    const state: AgentState = t.state === 'waiting' && this.gate.hasAsking(t.key) ? 'blocked' : t.state
    const live = state === 'working' || state === 'blocked'
    return {
      key: t.key,
      canFocus: !!t.terminalId,
      unseen: t.unseen,
      agentKind: t.agentKind,
      title: t.title,
      workspaceName: t.workspaceName,
      branch: t.branch,
      state,
      stateSince: t.stateSince,
      source: has ? 'transcript' : 'orca-only',
      formatUnknown: !!p?.formatUnknown(),
      loading,
      model: p?.model ?? null,
      effort: p?.effort ?? null,
      ctxTokens: p?.ctxTokens ?? 0,
      ...this.ctxView(has, p?.model ?? null),
      compactions: p?.compactions ?? 0,
      costUsd: has && c ? c.totalCost() : null,
      outTokens: p?.outTokens ?? 0,
      requests: p?.requests ?? 0,
      cacheHitPct: p?.cacheHitPct() ?? null,
      // An agent that is no longer working has no open turn, even when its transcript never closed one.
      turn: p && live ? withSubCost(turnView(p.turnView()), c?.turnSubCost() ?? 0) : null,
      lastTurn: p ? turnView(live ? p.lastTurn : closedTurn(p.turnView(), p.lastAt ?? t.stateSince) ?? p.lastTurn) : null,
      ...capSubagents(has && c ? c.subagents(now) : []),
      // Claude Code runs schedules only while the agent is idle; `done` is idle at the prompt.
      ...capBackground(has && p?.bg ? p.bg.pending(now, t.state === 'done' ? t.stateSince : null) : [])
    }
  }

  /** A Remote Control session as an agent with no terminal: busy is working, idle is done, anything else unknown. */
  remoteView(e: RemoteEntry, now: number): AgentView {
    const f = e.file
    const state: AgentState = f.status === 'busy' ? 'working' : f.status === 'idle' ? 'done' : 'unknown'
    const project = f.cwd.replace(/\/+$/, '').split('/').pop() || f.cwd
    const t: Tracked = {
      key: e.key,
      sessionId: f.sessionId,
      terminalId: null,
      workspaceId: null,
      agentKind: 'claude',
      title: f.name,
      workspaceName: project,
      branch: null,
      state,
      stateSince: f.statusUpdatedAt ?? f.updatedAt,
      claude: e.claude,
      unseen: false
    }
    return { ...this.view(t, now), remote: { url: f.url, name: f.name, project, cwd: f.cwd, updatedAt: f.updatedAt } }
  }

  snapshot(now = Date.now()): Snapshot {
    if (this.demo) return demoSnapshot(now, this.demoStartedAt, this.showCost)
    const order: Record<AgentState, number> = { blocked: 0, working: 1, waiting: 2, done: 3, unknown: 4 }
    const agents = [...this.tracked.values()].map((t) => this.view(t, now))
    agents.sort((a, b) => order[a.state] - order[b.state] || b.stateSince - a.stateSince)
    const remote = [...this.remote.entries.values()].filter((e) => this.wantRemote(e.file)).map((e) => this.remoteView(e, now))
    remote.sort((a, b) => order[a.state] - order[b.state] || (b.remote?.updatedAt ?? 0) - (a.remote?.updatedAt ?? 0))
    const keys = new Set([...agents, ...remote].map((a) => a.key))
    return {
      v: 1,
      at: now,
      scope: this.scope,
      demo: false,
      showCost: this.showCost,
      agents,
      gate: this.gate.list(160, (e) => keys.has(e.agentKey)),
      log: this.log.filter((e) => keys.has(e.agentKey)).slice(-60),
      note: agents.length === 0 ? (this.note ?? 'No agents in this workspace yet. Start Claude Code in an Orca terminal.') : this.note,
      remote,
      remoteNote:
        this.scope === 'focused' && !this.focusedPath && remote.length
          ? "Showing Remote Control sessions from every folder: Orca did not give this workspace's folder on this machine."
          : null
    }
  }

  flush(force = false): void {
    const now = Date.now()
    if (!force && (!this.dirty || now - this.lastPost < POST_MIN_MS)) return
    this.dirty = false
    this.lastPost = now
    const snap = fitSnapshot(this.snapshot(now))
    try {
      this.orca.panels.post('pitwall.snapshot', snap)
    } catch (err) {
      const msg = (err as Error).message
      if (msg !== this.lastPostError) this.orca.log(`post failed: ${msg}`)
      this.lastPostError = msg
    }
    this.updateStatusBar(snap)
  }

  updateStatusBar(snap: Snapshot): void {
    const { text, tone, tooltip, visible } = statusBarOf(snap, this.statusBar)
    const sig = `${visible}|${text}|${tone}|${tooltip}`
    if (sig === this.lastStatus) return
    this.lastStatus = sig
    void this.orca.host.call('statusBar.update', { id: 'pitwall', text, tone, tooltip, visible }).catch(() => {})
  }

  // ---- commands --------------------------------------------------------------------------

  async setScope(scope: Scope): Promise<Snapshot> {
    this.scope = scope
    await this.orca.settings.set('scope', scope).catch(() => {})
    await this.scheduleRefresh()
    await this.pollTranscripts()
    // A run that started before the scope changed may have kept the old set: run once more.
    await this.pollRemote()
    await this.pollRemote()
    this.flush(true)
    return this.snapshot()
  }

  /** Brings the agent's terminal to the front. Only on a click in the panel; never on its own. */
  /** The person opened the agent in Pitwall or jumped to it: its finished turn counts as seen. */
  markSeen(key: string): Snapshot {
    const t = this.tracked.get(key)
    if (t?.unseen) {
      t.unseen = false
      this.dirty = true
      this.flush(true)
    }
    return this.snapshot()
  }

  async focus(key: string): Promise<{ focused: boolean; reason?: string }> {
    if (this.demo) return { focused: false, reason: 'demo' }
    const t = this.tracked.get(key)
    if (!t?.terminalId) return { focused: false, reason: 'no terminal' }
    this.markSeen(key)
    try {
      const r = (await this.orca.host.call('terminal.focus' as never, { terminalId: t.terminalId } as never)) as { focused?: boolean }
      return { focused: r?.focused !== false }
    } catch (err) {
      return { focused: false, reason: (err as Error).message }
    }
  }

  async setDemo(on: boolean): Promise<Snapshot> {
    this.demo = on
    this.demoStartedAt = Date.now()
    await this.orca.storage.set('demo', on).catch(() => {})
    this.flush(true)
    return this.snapshot()
  }

  reset(): Snapshot {
    this.gate.clear()
    this.log.length = 0
    this.flush(true)
    return this.snapshot()
  }
}

export function statusBarOf(snap: Snapshot, enabled: boolean): { text: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; tooltip: string; visible: boolean } {
  const agents = snap.agents
  const working = agents.filter((a) => a.state === 'working').length
  const asking = snap.gate.filter((g) => g.state === 'asking').length + agents.filter((a) => a.state === 'blocked' && !snap.gate.some((g) => g.agentKey === a.key && g.state === 'asking')).length
  const subs = agents.reduce((n, a) => n + a.subagents.filter((s) => s.status === 'running').length, 0)
  let fullest: AgentView | null = null
  for (const a of agents) if (a.ctxWindow > 0 && (!fullest || a.ctxTokens / a.ctxWindow > fullest.ctxTokens / fullest.ctxWindow)) fullest = a
  const ctx = fullest ? Math.round(pct(fullest.ctxTokens, fullest.ctxWindow)) : null
  const cost = snap.showCost && !agents.some((a) => a.loading) ? agents.reduce<number | null>((sum, a) => (a.costUsd === null ? sum : (sum ?? 0) + a.costUsd), null) : null
  const parts: string[] = []
  if (asking) parts.push(`${asking} asking`)
  const blocked = agents.filter((a) => a.state === 'blocked').length
  const idle = agents.length - working - blocked
  if (working) parts.push(`${working} working`)
  else if (idle > 0) parts.push(`${idle} idle`)
  else if (!agents.length) parts.push('no agents')
  const rc = (snap.remote ?? []).filter((a) => a.state === 'working').length
  if (rc) parts.push(`RC ${rc} working`)
  if (subs) parts.push(`${subs} sub`)
  const bg = agents.reduce((n, a) => n + a.backgroundCount.running + a.backgroundCount.scheduled, 0)
  if (bg) parts.push(`${bg} bg`)
  if (ctx !== null) parts.push(`ctx ${ctx}%`)
  if (cost !== null) parts.push(fmtUsd(cost))
  const tone = asking ? 'warning' : ctx !== null && ctx >= 90 ? 'danger' : ctx !== null && ctx >= 75 ? 'warning' : working || rc ? 'accent' : 'neutral'
  const rcLines = (snap.remote ?? []).slice(0, 6).map((a) => `RC ${a.state === 'working' ? '▶' : '·'} ${a.title}${a.remote ? ` · ${a.remote.project}` : ''}${a.ctxWindow ? ` · ctx ${Math.round(pct(a.ctxTokens, a.ctxWindow))}%` : ''}`)
  const lines = [
    ...agents
      .slice(0, 8)
      .map((a) => `${a.state === 'blocked' ? '⏸' : a.state === 'working' ? '▶' : '·'} ${a.workspaceName || a.title}${a.ctxWindow ? ` · ctx ${Math.round(pct(a.ctxTokens, a.ctxWindow))}%` : ''}${a.backgroundCount.running + a.backgroundCount.scheduled ? ` · ${a.backgroundCount.running + a.backgroundCount.scheduled} bg` : ''}`),
    ...rcLines
  ]
  const tooltip = lines.length ? lines.join('\n') + '\n\nClick to toggle the Pitwall sidebar' : 'Pitwall: click to toggle the sidebar'
  return { text: parts.join(' · '), tone, tooltip, visible: enabled }
}

const SUBAGENTS_SENT = 12
const BACKGROUND_SENT = 12
const POST_LIMIT = 240 * 1024

/** Running subagents plus the latest finished ones: a session with a hundred subagents stays small. */
function capSubagents(all: SubagentView[]): { subagents: SubagentView[]; subagentTotal: number } {
  if (all.length <= SUBAGENTS_SENT) return { subagents: all, subagentTotal: all.length }
  const running = all.filter((x) => x.status === 'running')
  const rest = all.filter((x) => x.status !== 'running').slice(-Math.max(0, SUBAGENTS_SENT - running.length))
  return { subagents: [...rest, ...running].sort((a, b) => a.startedAt - b.startedAt), subagentTotal: all.length }
}

/** At most BACKGROUND_SENT, half of them for schedules when both kinds overflow, with the full counts. */
function capBackground(all: BackgroundView[]): Pick<AgentView, 'background' | 'backgroundCount'> {
  const running = all.filter((x) => x.kind === 'shell' || x.kind === 'monitor')
  const scheduled = all.filter((x) => x.kind === 'cron' || x.kind === 'wakeup')
  const forScheduled = Math.max(BACKGROUND_SENT / 2, BACKGROUND_SENT - running.length)
  const s = scheduled.slice(0, forScheduled)
  return { background: [...running.slice(0, BACKGROUND_SENT - s.length), ...s], backgroundCount: { running: running.length, scheduled: scheduled.length } }
}

function withSubCost(t: TurnView | null, sub: number): TurnView | null {
  return t && t.costUsd !== null ? { ...t, costUsd: t.costUsd + sub } : t
}

/** Keeps a snapshot under Orca's post limit by trimming the gate, then the log, then subagents. */
export function fitSnapshot(snap: Snapshot, limit = POST_LIMIT): Snapshot {
  let s = snap
  const size = () => JSON.stringify(s).length
  if (size() <= limit) return s
  s = { ...s, gate: s.gate.slice(-60), log: s.log.slice(-20) }
  if (size() <= limit) return s
  const trim = (a: AgentView) => ({ ...a, subagents: a.subagents.filter((x) => x.status === 'running').slice(-4) })
  s = { ...s, agents: s.agents.map(trim), remote: s.remote.map(trim) }
  if (size() <= limit) return s
  return { ...s, agents: s.agents.slice(0, 20), remote: s.remote.slice(0, 10), gate: [], log: [] }
}

function asks(state: AgentState): boolean {
  return state === 'blocked' || state === 'waiting'
}

function closedTurn<T extends { endedAt: number | null }>(turn: T | null, at: number): T | null {
  return turn ? { ...turn, endedAt: turn.endedAt ?? at } : null
}

let instance: Pitwall | null = null

export default function activate(orca: OrcaWorkerApi): void {
  const pw = new Pitwall(orca)
  instance = pw
  const ready = pw.start().catch((err) => orca.log(`start failed: ${(err as Error).message}`))

  orca.events.on('agent.status.changed', (e) => {
    pw.onStatus({ workspaceId: e.workspaceId, terminalId: e.terminalId, sessionId: e.sessionId, state: e.state, receivedAt: e.receivedAt })
    pw.flush()
  })
  orca.events.on('workspace.changed', () => void pw.scheduleRefresh())

  // Observe only: return nothing, so every call passes unchanged and nothing waits on Pitwall.
  orca.hooks.on('agent.tool.before', (e) => {
    pw.onToolBefore(e)
  })
  orca.hooks.on('agent.tool.after', (e) => {
    pw.onToolAfter(e)
  })

  orca.settings.onDidChange(() => {
    void pw.loadSettings().then(() => {
      void pw.scheduleRefresh()
      pw.flush(true)
    })
  })

  orca.panels.handle('pitwall.snapshot', async () => {
    await ready
    return fitSnapshot(pw.snapshot())
  })
  orca.panels.handle('pitwall.setScope', async ({ scope }) => pw.setScope(scope === 'all' ? 'all' : 'focused'))
  orca.panels.handle('pitwall.setDemo', async ({ on }) => pw.setDemo(on === true))
  orca.panels.handle('pitwall.reset', async () => pw.reset())
  orca.panels.handle('pitwall.focus', async ({ key }) => pw.focus(String(key ?? '')))
  orca.panels.handle('pitwall.seen', async ({ key }) => pw.markSeen(String(key ?? '')))

  orca.commands.register('pitwall.scope', async () => {
    const s = await pw.setScope(pw.scope === 'all' ? 'focused' : 'all')
    return `Pitwall shows ${s.scope === 'all' ? 'every workspace' : 'the focused workspace'}`
  })
  orca.commands.register('pitwall.demo', async () => {
    const s = await pw.setDemo(!pw.demo)
    return s.demo ? 'Pitwall demo mode on' : 'Pitwall demo mode off'
  })
  orca.commands.register('pitwall.reset', () => {
    pw.reset()
    return 'Pitwall cleared'
  })
}

export function deactivate(): void {
  instance?.stop()
  instance = null
}
