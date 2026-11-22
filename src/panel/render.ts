// Pure rendering: snapshot + UI state + clock -> HTML strings, one per section. No DOM access,
// so it runs in Node tests. Every value from the snapshot goes through esc().
import { fmtClock, fmtDuration, fmtTokens, fmtUntil, fmtUsd, modelLabel, pct } from '../shared/format'
import { isClaudeSessionUrl } from '../shared/links'
import { VERSION } from '../shared/version'
import type { AgentView, BackgroundView, GateEntry, LogEntry, Snapshot, SubagentView, ToolFamily, TurnView } from '../shared/types'

export interface UiState {
  family: ToolFamily | null
  /** Open/closed overrides: `car:<key>` for idle agents, `sub:<key>` for all subagents, `bg:<key>` for all background work, `sec:<name>` for sections. */
  expanded: Record<string, boolean>
  menu: boolean
  /** Show only this agent (its card, tool calls and activity). Asks from other agents still show. */
  only: string | null
}

/** Where Pitwall lives; opened in the browser only on a click. */
export const REPO_URL = 'https://github.com/sonthh/orca-pitwall'

export const INITIAL_UI: UiState = { family: null, expanded: {}, menu: false, only: null }

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

const STATE_LABEL: Record<string, string> = { working: 'Working', blocked: 'Needs you', waiting: 'Waiting', done: 'Idle', unknown: '' }
const SECTION_DEFAULT: Record<string, boolean> = { idle: true, remote: true, calls: false, log: false }

function since(at: number, now: number): string {
  return `<span data-since="${at}">${esc(fmtDuration(now - at))}</span>`
}

function ago(at: number, now: number): string {
  return `<span data-ago="${at}">${esc(fmtDuration(now - at))}</span>`
}

function until(at: number, now: number): string {
  return `<span data-until="${at}">${esc(fmtUntil(at - now))}</span>`
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function isLive(a: AgentView): boolean {
  return a.state === 'working' || a.state === 'blocked'
}

function goButton(s: Snapshot, key: string, label: string, cls = 'go'): string {
  const a = s.agents.find((x) => x.key === key)
  return a?.canFocus ? `<button class="${cls}" data-action="focus" data-key="${esc(key)}" title="Bring its terminal to the front">${label}</button>` : ''
}

function nameOf(s: Snapshot, key: string): string {
  const a = s.agents.find((x) => x.key === key) ?? s.remote.find((x) => x.key === key)
  return a ? a.title || a.workspaceName : 'An agent'
}

export function sectionOpen(ui: UiState, name: string): boolean {
  return ui.expanded['sec:' + name] ?? SECTION_DEFAULT[name] ?? true
}

/** The agents the panel shows: one when the person picked it and it still exists, else all. */
export function visibleAgents(s: Snapshot, ui: UiState): AgentView[] {
  if (ui.only && s.agents.some((a) => a.key === ui.only)) return s.agents.filter((a) => a.key === ui.only)
  return s.agents
}

/** Keys whose tool calls and activity show: the shown agents, and the Remote Control sessions unless one agent is picked. */
function shownKeys(s: Snapshot, ui: UiState): Set<string> {
  const keys = new Set(visibleAgents(s, ui).map((a) => a.key))
  if (!onlyOne(s, ui)) for (const r of s.remote) keys.add(r.key)
  return keys
}

function onlyOne(s: Snapshot, ui: UiState): boolean {
  return !!ui.only && s.agents.some((a) => a.key === ui.only)
}

function ctxPct(a: AgentView): number | null {
  return a.ctxWindow ? pct(a.ctxTokens, a.ctxWindow) : null
}

function ctxTone(p: number): string {
  return p >= 90 ? 'bad' : p >= 75 ? 'warn' : ''
}

export function renderHeader(s: Snapshot, ui: UiState): string {
  const scope = s.scope
  const count = (st: string) => s.agents.filter((a) => a.state === st).length
  const parts = [
    count('blocked') ? `<span class="sum warn">${count('blocked')} need you</span>` : '',
    count('working') ? `<span class="sum run">${count('working')} working</span>` : '',
    s.agents.length - count('blocked') - count('working') ? `<span class="sum">${s.agents.length - count('blocked') - count('working')} idle</span>` : '',
    s.agents.some((a) => a.unseen) ? `<span class="sum new" title="Finished while you were elsewhere">${s.agents.filter((a) => a.unseen).length} new</span>` : ''
  ].filter(Boolean)
  // A transcript still being read would make the total a partial sum.
  const total = s.agents.some((a) => a.loading) ? 0 : s.agents.reduce((n, a) => n + (a.costUsd ?? 0), 0)
  const only = ui.only ? s.agents.find((a) => a.key === ui.only) : null
  return `<header class="top">
  <span class="title">Pitwall</span>${s.demo ? '<span class="badge">Demo</span>' : ''}
  <div class="seg" role="group" aria-label="Show agents from">
    <button data-action="scope" data-scope="focused" class="${scope === 'focused' ? 'on' : ''}" title="Agents in the focused workspace">This</button>
    <button data-action="scope" data-scope="all" class="${scope === 'all' ? 'on' : ''}" title="Agents in every workspace">All</button>
  </div>
  <button class="icon" data-action="menu" aria-label="More" title="More">⋯</button>
  ${
    ui.menu
      ? `<div class="menu" role="menu">
    <button role="menuitem" data-action="demo">${s.demo ? 'Leave demo mode' : 'Demo mode'}</button>
    <button role="menuitem" data-action="reset">Clear tool calls and activity</button>
    <div class="menu-sep" role="separator"></div>
    <button role="menuitem" data-action="github" title="${REPO_URL}">★ Star Pitwall on GitHub</button>
  </div>`
      : ''
  }
</header>
${
  only
    ? `<div class="only-bar"><span class="ell">Only <b>${esc(only.title || only.workspaceName)}</b></span><button class="chip-btn" data-action="only" data-key="" title="Show every agent">Show all ×</button></div>`
    : parts.length
      ? `<div class="summary">${parts.join('')}${s.showCost && total > 0 ? `<span class="sum right" title="API list price of all sessions shown">${esc(fmtUsd(total))}</span>` : ''}</div>`
      : ''
}`
}

/** Context share at which a working agent gets a heads-up to compact. */
const CTX_ALERT = 90

export function renderAlerts(s: Snapshot, now: number): string {
  const asking = s.gate.filter((g) => g.state === 'asking')
  const blockedAgents = s.agents.filter((a) => a.state === 'blocked' && !asking.some((g) => g.agentKey === a.key))
  // A working agent close to its window is about to compact and lose detail: say so while there is time.
  const full = s.agents.filter((a) => a.state === 'working' && (ctxPct(a) ?? 0) >= CTX_ALERT)
  if (!asking.length && !blockedAgents.length && !full.length) return ''
  const rows = [
    ...asking.map(
      (g) =>
        `<div class="alert"><div class="row"><span class="badge-warn">Needs you</span><span class="ell"><b>${esc(nameOf(s, g.agentKey))}</b> wants <code>${esc(g.tool)}</code></span><span class="right sub-t">${since(g.at, now)}</span></div>${g.summary ? `<div class="what" title="${esc(g.summary)}">${esc(g.summary)}</div>` : ''}<div class="alert-foot"><span class="hint">Answer in its terminal.</span>${goButton(s, g.agentKey, 'Go to terminal ↗')}</div></div>`
    ),
    ...blockedAgents.map(
      (a) =>
        `<div class="alert"><div class="row"><span class="badge-warn">Needs you</span><span class="ell"><b>${esc(a.title || a.workspaceName)}</b> is waiting for you</span><span class="right sub-t">${since(a.stateSince, now)}</span></div><div class="alert-foot"><span class="hint">Answer in its terminal.</span>${goButton(s, a.key, 'Go to terminal ↗')}</div></div>`
    ),
    ...full.map(
      (a) =>
        `<div class="alert soft"><div class="row"><span class="pill ${ctxTone(ctxPct(a)!)}">Context ${Math.round(ctxPct(a)!)}%</span><span class="ell"><b>${esc(a.title || a.workspaceName)}</b> will compact soon</span></div><div class="alert-foot"><span class="hint">Run <code>/compact</code> at a good stopping point to keep what matters.</span>${goButton(s, a.key, 'Go ↗', 'go soft')}</div></div>`
    )
  ]
  return `<section class="alerts" aria-live="polite">${rows.join('')}</section>`
}

function ctxBlock(a: AgentView): string {
  const p = ctxPct(a)
  if (p === null) return ''
  const tone = ctxTone(p)
  const of =
    a.ctxBasis === 'compact'
      ? `the ${fmtTokens(a.ctxWindow)} auto-compact window (model window ${fmtTokens(a.ctxModelWindow)}; Claude Code's status line counts against the model window)`
      : a.ctxBasis === 'setting'
        ? `${fmtTokens(a.ctxWindow)}, the Context window setting${a.ctxModelWindow && a.ctxModelWindow !== a.ctxWindow ? ` (model window ${fmtTokens(a.ctxModelWindow)})` : ''}`
        : `the ${fmtTokens(a.ctxWindow)} model window`
  const tip = `${fmtTokens(a.ctxTokens)} of ${of}${a.compactions ? `, compacted ${a.compactions}×` : ''}${a.cacheHitPct !== null ? `, ${Math.round(a.cacheHitPct)}% of the latest prompt from cache` : ''}`
  return `<div class="ctx" title="${esc(tip)}">
  <div class="ctx-line"><span class="sub-t">Context</span><span class="ctx-num ${tone}">${Math.round(p)}%</span><span class="muted ell">${esc(fmtTokens(a.ctxTokens))} / ${esc(fmtTokens(a.ctxWindow!))}${a.compactions ? ` · compacted ${a.compactions}×` : ''}</span></div>
  <div class="meter${tone ? ' ' + tone : ''}"><i style="width:${Math.min(100, p).toFixed(1)}%"></i></div>
</div>`
}

function turnBlock(t: TurnView | null, last: boolean, showCost: boolean, now: number, a?: AgentView, ui?: UiState): string {
  if (!t) return ''
  const bits = [
    plural(t.tools, 'tool'),
    t.edits ? plural(t.edits, 'edit') : '',
    t.agents
      ? a && ui && !ui.expanded['sub:' + a.key] && !a.subagents.some((x) => x.status === 'running')
        ? `<button class="link inline" data-action="expand" data-key-x="sub:${esc(a.key)}" title="List them">${plural(t.agents, 'subagent')}</button>`
        : plural(t.agents, 'subagent')
      : '',
    t.errors ? `<span class="bad-t">${plural(t.errors, 'error')}</span>` : '',
    showCost && t.costUsd !== null && t.costUsd >= 0.005 ? esc(fmtUsd(t.costUsd)) : ''
  ].filter(Boolean)
  const when = t.endedAt ? esc(fmtDuration(t.endedAt - t.startedAt)) : since(t.startedAt, now)
  return `<div class="block">
  ${t.prompt ? `<div class="prompt" title="${esc(t.prompt)}">${esc(t.prompt)}</div>` : ''}
  <div class="sub-t small">${last ? 'Last turn' : 'This turn'} ${when} · ${bits.join(' · ')}</div>
</div>`
}

function subagentBlock(a: AgentView, ui: UiState, now: number): string {
  const subs = a.subagents
  if (!subs.length) return ''
  const all = !!ui.expanded['sub:' + a.key]
  const running = subs.filter((x) => x.status === 'running')
  // Finished subagents are a count in the turn line; the list shows while some run, or on request.
  if (!running.length && !all) return ''
  const recent = subs.filter((x) => x.status !== 'running' && now - (x.endedAt ?? now) < 30 * 60 * 1000)
  const shown = all ? subs : [...running, ...recent.slice(-Math.max(0, 3 - running.length))]
  const less = all && !running.length ? `<button class="link" data-action="expand" data-key-x="sub:${esc(a.key)}">Hide</button>` : ''
  const total = Math.max(a.subagentTotal, subs.length)
  const rows = shown
    .map((x: SubagentView) => {
      const info = [`${x.type}: ${x.task}`, `${modelLabel(x.model)} · ${x.steps} steps · ${fmtTokens(x.ctxTokens)} context`, x.lastTools.length ? 'last: ' + x.lastTools.join(', ') : ''].filter(Boolean).join('\n')
      const time = x.status === 'running' ? since(x.startedAt, now) : esc(fmtDuration((x.endedAt ?? now) - x.startedAt))
      const mark = x.status === 'running' ? '<span class="dot run"></span>' : x.status === 'error' ? '<span class="mark bad-t">✗</span>' : '<span class="mark ok-t">✓</span>'
      return `<div class="item" title="${esc(info)}">${mark}<span class="ell"><b class="w5">${esc(x.type)}</b> <span class="sub-t">${esc(x.task)}</span></span><span class="muted">${time}</span></div>`
    })
    .join('')
  const more =
    subs.length > shown.length
      ? `<button class="link" data-action="expand" data-key-x="sub:${esc(a.key)}">Show all ${subs.length}</button>`
      : all && subs.length > 3
        ? `<button class="link" data-action="expand" data-key-x="sub:${esc(a.key)}">Show fewer</button>`
        : ''
  return `<div class="block"><div class="block-title">Subagents <span class="muted">${running.length ? `${running.length} running · ` : ''}${total} this session</span></div>${rows}${less || more}</div>`
}

const BG_MARK: Record<BackgroundView['kind'], string> = {
  shell: '<span class="dot run"></span>',
  monitor: '<span class="mark">◉</span>',
  cron: '<span class="mark">↻</span>',
  wakeup: '<span class="mark">◷</span>'
}
const BG_WORD: Record<BackgroundView['kind'], string> = { shell: 'shell', monitor: 'monitor', cron: 'cron', wakeup: 'wakeup' }

function isRunning(x: BackgroundView): boolean {
  return x.kind === 'shell' || x.kind === 'monitor'
}

/** Right-hand side of a background row: how long it has run, or when it runs next. */
function bgWhen(x: BackgroundView, now: number): string {
  if (isRunning(x)) return x.startedAt !== null ? since(x.startedAt, now) : ''
  if (x.overdue) return '<span class="warn-t">due</span>'
  if (x.dueAt === null) return ''
  if (x.dueAt <= now) return 'now'
  // The clock time it runs at; today's also say how long until then.
  const clock = esc(fmtClock(x.dueAt, now))
  return isToday(x.dueAt, now) ? `${clock} · in ${until(x.dueAt, now)}` : clock
  return ''
}

function isToday(at: number, now: number): boolean {
  return new Date(at).toDateString() === new Date(now).toDateString()
}

/** Plain-text detail for a background row's tooltip. */
export function bgTip(x: BackgroundView, now: number): string {
  const lines = [`${BG_WORD[x.kind]}: ${x.label}`]
  if (x.kind === 'shell') lines.push(x.startedAt !== null ? `Running since ${fmtClock(x.startedAt, now)}` : 'Running')
  if (x.kind === 'monitor') lines.push(`Watching${x.startedAt !== null ? ' since ' + fmtClock(x.startedAt, now) : ''}${x.endsAt !== null ? ', stops by ' + fmtClock(x.endsAt, now) : ''}`)
  if (x.kind === 'cron' || x.kind === 'wakeup') {
    const sched = x.kind === 'wakeup' ? '/loop wakeup' : x.recurring ? x.schedule ?? 'Recurring' : `Once${x.schedule ? ' (' + x.schedule + ')' : ''}`
    const next = x.overdue ? 'due now, runs once the agent is idle' : x.dueAt !== null ? `${x.recurring ? 'next' : 'at'} ${fmtClock(x.dueAt, now)}` : ''
    lines.push([sched, next].filter(Boolean).join(' · '))
    if (x.kind === 'cron' && x.recurring && x.endsAt !== null) lines.push(`Expires ${fmtClock(x.endsAt, now)}`)
  }
  if (x.detail) lines.push(x.detail)
  return lines.join('\n')
}

const BG_SHOWN = 4

function backgroundBlock(a: AgentView, ui: UiState, now: number): string {
  const list = a.background
  if (!list.length) return ''
  const all = !!ui.expanded['bg:' + a.key]
  const { running, scheduled } = a.backgroundCount
  const unsent = running + scheduled - list.length
  const head = [running ? `${running} running` : '', scheduled ? `${scheduled} scheduled` : ''].filter(Boolean).join(' · ')
  const shown = all ? list : list.slice(0, BG_SHOWN)
  const more =
    list.length > BG_SHOWN
      ? `<button class="link" data-action="expand" data-key-x="bg:${esc(a.key)}">${all ? 'Show fewer' : `Show all ${a.backgroundCount.running + a.backgroundCount.scheduled}`}</button>`
      : ''
  const rows = shown
    .map((x) => `<div class="item bg-row" title="${esc(bgTip(x, now))}">${BG_MARK[x.kind]}<span class="ell"><b class="w5">${BG_WORD[x.kind]}</b> <span class="sub-t">${esc(x.label)}</span></span><span class="muted">${bgWhen(x, now)}</span></div>`)
    .join('')
  const rest = all && unsent > 0 ? `<div class="muted small">${unsent} more not listed</div>` : ''
  return `<div class="block"><div class="block-title">Background <span class="muted">${head}</span></div>${rows}${rest}${more}</div>`
}

/** One pill on an idle row: when the next schedule runs, else how many run in the background. */
function bgPill(a: AgentView, now: number): string {
  const list = a.background
  if (!list.length) return ''
  const tip = list.map((x) => bgTip(x, now).split('\n').slice(0, 2).join(' · ')).join('\n')
  const next = list.find((x) => !isRunning(x) && (x.overdue || x.dueAt !== null))
  const running = a.backgroundCount.running
  const text = next ? `◷ ${next.overdue ? 'due' : next.dueAt! <= now ? 'now' : until(next.dueAt!, now)}` : running ? `▶ ${running}` : `◷ ${list.length}`
  return `<span class="pill${next?.overdue ? ' warn' : ''}" title="${esc(tip)}">${text}</span>`
}

const STATE_WORD: Record<GateEntry['state'], string> = { running: 'running', asking: 'asking you', ok: 'done', error: 'failed', denied: 'denied' }
const STATE_ICON: Record<GateEntry['state'], string> = { running: '•', asking: '?', ok: '✓', error: '✗', denied: '⊘' }

/** File calls lead with the file name, so a narrow panel cuts the folder, not the name. */
function callText(e: GateEntry): string {
  const m = e.family === 'file' ? /^(.*\/)([^/\s]+)$/.exec(e.summary) : null
  return m ? `${esc(m[2])} <span class="muted">${esc(m[1].replace(/\/$/, ''))}</span>` : esc(e.summary)
}

function callRow(e: GateEntry, now: number, who: string | null): string {
  const tip = `${e.tool}${e.summary ? ': ' + e.summary : ''} (${STATE_WORD[e.state]}${e.sub ? ', subagent' : ''}${who ? ', ' + who : ''})`
  return `<div class="call s-${e.state}" title="${esc(tip)}"><span class="ico">${STATE_ICON[e.state]}</span><code>${esc(e.tool)}</code><span class="sub-t ell">${callText(e)}</span><span class="muted">${ago(e.at, now)}</span></div>`
}

function recentCalls(a: AgentView, s: Snapshot, now: number): string {
  const mine = s.gate.filter((g) => g.agentKey === a.key).slice(-4).reverse()
  if (!mine.length) return ''
  return `<div class="block"><div class="block-title">Recent tool calls</div>${mine.map((e) => callRow(e, now, null)).join('')}</div>`
}

function stateBadge(a: AgentView, now: number): string {
  const label = a.remote && a.state === 'unknown' ? 'Unknown' : STATE_LABEL[a.state] ?? a.state
  return `<span class="state ${esc(a.state)}">${esc(label)} ${since(a.stateSince, now)}</span>`
}

function onlyButton(a: AgentView, ui: UiState): string {
  if (ui.only === a.key || a.remote) return ''
  return `<button class="icon small-icon" data-action="only" data-key="${esc(a.key)}" title="Show only this agent" aria-label="Show only this agent">◎</button>`
}

function agentCard(a: AgentView, s: Snapshot, ui: UiState, now: number, collapsible: boolean): string {
  const name = a.title || a.workspaceName
  const second = a.remote ? a.remote.project : s.scope === 'all' ? a.workspaceName : a.branch
  const meta = [a.model ? modelLabel(a.model) : a.agentKind, a.effort ?? '', s.showCost && a.costUsd !== null ? fmtUsd(a.costUsd) : ''].filter(Boolean)
  const head = `<div class="card-head${collapsible ? ' clickable' : ''}"${collapsible ? ` data-action="expand" data-key-x="car:${esc(a.key)}" title="Collapse" tabindex="0" role="button"` : ''}>
    <div class="name clamp" title="${esc(name)}">${collapsible ? '<span class="chev">▾</span>' : ''}${esc(name)}</div>
    <div class="row sub-t small">${stateBadge(a, now)}<span class="ell">${[second && second !== name ? second : '', ...meta].filter(Boolean).map(esc).join(' · ')}</span></div>
  </div>`
  const unknown = a.formatUnknown
    ? `<div class="block small bad-t">Pitwall does not recognise this transcript's format, so context, cost and turns may be missing. Update Pitwall.</div>`
    : ''
  const body =
    unknown +
    (a.source === 'transcript'
      ? [ctxBlock(a), turnBlock(a.turn, false, s.showCost, now, a, ui) || turnBlock(a.lastTurn, true, s.showCost, now, a, ui), subagentBlock(a, ui, now), backgroundBlock(a, ui, now), recentCalls(a, s, now)].join('')
      : `<div class="block sub-t small">${a.loading ? 'Reading its transcript…' : a.agentKind === 'claude' ? 'Waiting for its transcript…' : 'State and tool calls only: Pitwall reads Claude Code transcripts today.'}</div>${recentCalls(a, s, now)}`) +
    (a.remote ? remoteFoot(a, now) : '')
  return `<article class="agent card ${esc(a.state)}"><div class="card-tools">${a.canFocus ? `<button class="icon small-icon" data-action="focus" data-key="${esc(a.key)}" title="Go to its terminal" aria-label="Go to its terminal">↗</button>` : ''}${onlyButton(a, ui)}${collapsible ? `<button class="icon small-icon" data-action="expand" data-key-x="car:${esc(a.key)}" title="Close details" aria-label="Close details">×</button>` : ''}</div>${head}${body}</article>`
}

/** The way out of a Remote Control card: where it runs, when it was last active, and its page on claude.ai. */
function remoteFoot(a: AgentView, now: number): string {
  const r = a.remote!
  return `<div class="block rc-foot"><span class="sub-t small ell" title="${esc(r.cwd)}">Last active ${ago(r.updatedAt, now)} ago</span>${openButton(a, '↗ Open on claude.ai', 'go soft')}</div>`
}

/** Opens the session's claude.ai page; only for a URL that passes the check. */
function openButton(a: AgentView, label: string, cls: string): string {
  if (!a.remote || !isClaudeSessionUrl(a.remote.url)) return ''
  return `<button class="${cls}" data-action="open-remote" data-key="${esc(a.key)}" title="Open this session on claude.ai">${label}</button>`
}

const RC_WORD: Record<string, string> = { working: 'Working', done: 'Idle' }

/** One Remote Control session, two lines: name and project, then its state and latest prompt. */
function remoteRow(a: AgentView, s: Snapshot, now: number): string {
  const r = a.remote!
  const p = ctxPct(a)
  const prompt = a.turn?.prompt || a.lastTurn?.prompt || ''
  const word = RC_WORD[a.state] ?? 'Unknown'
  const detail = a.loading ? 'reading its transcript…' : prompt
  const meta = [
    p !== null ? `<span class="pill ${ctxTone(p)}" title="Context ${esc(fmtTokens(a.ctxTokens))} / ${esc(fmtTokens(a.ctxWindow))}">${Math.round(p)}%</span>` : '',
    s.showCost && a.costUsd !== null ? `<span class="muted small" title="API list price of this session">${esc(fmtUsd(a.costUsd))}</span>` : ''
  ].join('')
  return `<article class="agent line rc ${esc(a.state)}" data-action="expand" data-key-x="car:${esc(a.key)}" title="Show details" tabindex="0" role="button" aria-expanded="false">
  <span class="chev">▸</span>
  <span class="rc-top">${a.state === 'working' ? '<span class="dot run"></span>' : ''}<span class="name">${esc(r.name)}</span> <span class="muted">${esc(r.project)}</span></span>
  <span class="muted time" title="Last activity">${ago(r.updatedAt, now)}</span>
  <span class="rc-go">${openButton(a, '↗', 'icon go-icon')}</span>
  <span class="rc-sub sub-t small"${prompt ? ` title="${esc(prompt)}"` : ''}><span class="rc-state ${esc(a.state)}">${word}</span>${detail ? ` · ${esc(detail)}` : ''}</span>
  <span class="rc-meta">${meta}</span>
</article>`
}

/** Claude Code Remote Control sessions running outside Orca on this machine. Hidden while one agent is picked. */
export function renderRemote(s: Snapshot, ui: UiState, now: number): string {
  if (!s.remote.length || onlyOne(s, ui)) return ''
  const working = s.remote.filter((a) => a.state === 'working').length
  const head = sectionHead('remote', 'Remote Control', `${working ? `${working} working · ` : ''}${s.remote.length}`, ui)
  if (!sectionOpen(ui, 'remote')) return `<section class="sec rc-sec">${head}</section>`
  const rows = s.remote.map((a) => (ui.expanded['car:' + a.key] ? `<div class="inline-card">${agentCard(a, s, ui, now, true)}</div>` : remoteRow(a, s, now))).join('')
  const note = s.remoteNote ? `<div class="muted small rc-note">${esc(s.remoteNote)}</div>` : ''
  return `<section class="sec rc-sec">${head}<div class="lines">${note}${rows}</div></section>`
}

function idleRow(a: AgentView, s: Snapshot, ui: UiState, now: number): string {
  const name = a.title || a.workspaceName
  const p = ctxPct(a)
  const tone = p === null ? '' : ctxTone(p)
  const second = s.scope === 'all' ? a.workspaceName : null
  // The whole row opens its details in place (like the section heads); going to the terminal is its own
  // always-visible button, so a click never switches tabs by surprise.
  return `<article class="agent line ${esc(a.state)}" data-action="expand" data-key-x="car:${esc(a.key)}" title="Show details" tabindex="0" role="button" aria-expanded="false">
  <span class="chev">▸</span>${a.unseen ? '<span class="new-dot" title="Finished while you were elsewhere" aria-label="new"></span>' : ''}
  <span class="ell"><span class="name">${esc(name)}</span>${second && second !== name ? ` <span class="muted">${esc(second)}</span>` : ''}</span>
  <span class="hover-tools">${onlyButton(a, ui)}</span>
  ${bgPill(a, now)}
  ${p !== null ? `<span class="pill ${tone}" title="Context ${esc(fmtTokens(a.ctxTokens))} / ${esc(fmtTokens(a.ctxWindow!))}">${Math.round(p)}%</span>` : ''}
  <span class="muted time">${since(a.stateSince, now)}</span>
  ${a.canFocus ? `<button class="icon go-icon" data-action="focus" data-key="${esc(a.key)}" title="Go to its terminal" aria-label="Go to its terminal">↗</button>` : ''}
</article>`
}

export function renderAgent(a: AgentView, s: Snapshot, ui: UiState, now: number): string {
  if (isLive(a)) return agentCard(a, s, ui, now, false)
  if (ui.expanded['car:' + a.key] || ui.only === a.key) return agentCard(a, s, ui, now, ui.only !== a.key)
  return idleRow(a, s, ui, now)
}

function sectionHead(name: string, title: string, extra: string, ui: UiState): string {
  const open = sectionOpen(ui, name)
  return `<button class="sec-head" data-action="expand" data-key-x="sec:${name}" aria-expanded="${open}"><span class="chev">${open ? '▾' : '▸'}</span><span class="sec-title">${title}</span><span class="right sub-t small">${extra}</span></button>`
}

export function renderAgents(s: Snapshot, ui: UiState, now: number): string {
  // With Remote Control sessions below, a line is enough; the full welcome is for an empty panel.
  if (!s.agents.length) return s.remote.length ? `<section class="empty slim"><div class="sub-t small">${esc(s.note ?? 'No agents in Orca terminals.')}</div></section>` : renderEmpty(s)
  const shown = visibleAgents(s, ui)
  const active = shown.filter((a) => isLive(a) || ui.only === a.key)
  // Just finished and not looked at first, then the most recent: the list answers "what needs a look?".
  const idle = shown.filter((a) => !active.includes(a)).sort((x, y) => Number(y.unseen) - Number(x.unseen) || y.stateSince - x.stateSince)
  const cards = active.map((a) => renderAgent(a, s, ui, now)).join('')
  // An opened idle agent stays where it was in the list, so the reader does not lose their place.
  const idleList = idle.length
    ? `<section class="sec">${sectionHead('idle', 'Idle', String(idle.length), ui)}${sectionOpen(ui, 'idle') ? `<div class="lines">${idle.map((a) => (ui.expanded['car:' + a.key] ? `<div class="inline-card">${agentCard(a, s, ui, now, true)}</div>` : idleRow(a, s, ui, now))).join('')}</div>` : ''}</section>`
    : ''
  return `${cards ? `<div class="cards">${cards}</div>` : ''}${idleList}`
}

const FAMILIES: ToolFamily[] = ['file', 'shell', 'web', 'mcp', 'agent', 'other']

export function renderGate(s: Snapshot, ui: UiState, now: number): string {
  const keys = shownKeys(s, ui)
  const g = s.gate.filter((e) => keys.has(e.agentKey) || !s.agents.some((a) => a.key === e.agentKey) && !ui.only)
  if (!g.length) return ''
  const counts = { running: 0, asking: 0, ok: 0, error: 0, denied: 0 }
  for (const e of g) counts[e.state]++
  const tally = [
    counts.running ? `${counts.running} running` : '',
    counts.asking ? `${counts.asking} asking` : '',
    counts.ok ? `${counts.ok} done` : '',
    counts.error ? `<span class="bad-t">${counts.error} failed</span>` : '',
    counts.denied ? `<span class="bad-t">${counts.denied} denied</span>` : ''
  ]
    .filter(Boolean)
    .join(' · ')
  const head = sectionHead('calls', 'Tool calls', tally, ui)
  if (!sectionOpen(ui, 'calls')) return `<section class="sec gate">${head}</section>`
  const fams = FAMILIES.map((f) => ({ f, n: g.filter((e) => e.family === f).length }))
    .filter((x) => x.n)
    .map((x) => `<button class="fam${ui.family === x.f ? ' on' : ''}" data-action="family" data-family="${x.f}" title="Only ${x.f} calls">${x.f} <span class="muted">${x.n}</span></button>`)
    .join('')
  const multi = keys.size > 1
  const rows = g
    .filter((e) => !ui.family || e.family === ui.family)
    .slice(-10)
    .reverse()
    .map((e) => callRow(e, now, multi ? nameOf(s, e.agentKey) : null))
    .join('')
  return `<section class="sec gate">${head}<div class="sec-body"><div class="fams">${fams}</div><div class="calls">${rows}</div></div></section>`
}

const LOG_ICON: Record<LogEntry['kind'], string> = { prompt: '›', spawn: '+', done: '✓', edit: '✎', error: '✗', denied: '⊘', asking: '?', compact: '↺', turn: '·' }

export function renderLog(s: Snapshot, ui: UiState, now: number): string {
  const keys = shownKeys(s, ui)
  // "Turn done" rows repeat what the cards already say; the activity list keeps the events.
  const log = s.log.filter((l) => l.kind !== 'turn' && (keys.has(l.agentKey) || (!ui.only && !s.agents.some((a) => a.key === l.agentKey))))
  if (!log.length) return ''
  const latest = log[log.length - 1]
  const head = sectionHead('log', 'Activity', `latest ${ago(latest.at, now)} ago`, ui)
  if (!sectionOpen(ui, 'log')) return `<section class="sec log">${head}</section>`
  const multi = new Set(log.map((l) => l.agentKey)).size > 1
  let prev = ''
  const rows = log
    .slice(-12)
    .reverse()
    .map((l) => {
      // In a mixed list the agent's name heads each run of its rows instead of repeating on every row.
      const who = multi && l.agentKey !== prev ? `<div class="log-who sub-t ell">${esc(nameOf(s, l.agentKey))}</div>` : ''
      prev = l.agentKey
      return `${who}<div class="log-row k-${l.kind}"><span class="ico">${LOG_ICON[l.kind]}</span><span class="ell" title="${esc(l.text)}">${esc(l.text)}</span><span class="muted">${ago(l.at, now)}</span></div>`
    })
    .join('')
  return `<section class="sec log">${head}<div class="sec-body">${rows}</div></section>`
}

export function renderEmpty(s: Snapshot): string {
  return `<section class="empty">
  <div class="empty-title">${esc(s.note ?? 'No agents yet')}</div>
  <p class="sub-t">Start Claude Code in an Orca terminal and it shows up here: context, cost, subagents, tool calls, and a heads-up when it needs you.</p>
  <p class="muted small">Read-only. Nothing leaves your machine. <button class="quiet-link" data-action="github" title="${REPO_URL}">Pitwall on GitHub ↗</button></p>
  <button class="primary" data-action="demo">Try the demo</button>
</section>`
}

export interface Rendered {
  header: string
  alerts: string
  agents: string
  remote: string
  gate: string
  log: string
  footer: string
}

/** A quiet line at the end of the panel, once there is something above it. */
export function renderFooter(s: Snapshot): string {
  if (!s.agents.length && !s.remote.length) return ''
  return `<footer class="foot"><span class="ver">Pitwall ${esc(VERSION)}</span><span class="dot-sep">·</span><button class="quiet-link" data-action="github" title="Pitwall is free and open source: a star helps others find it">★ Star on GitHub</button></footer>`
}

export function render(s: Snapshot, ui: UiState, now: number): Rendered {
  return {
    header: renderHeader(s, ui),
    alerts: renderAlerts(s, now),
    agents: renderAgents(s, ui, now),
    remote: renderRemote(s, ui, now),
    gate: renderGate(s, ui, now),
    log: renderLog(s, ui, now),
    footer: renderFooter(s)
  }
}
