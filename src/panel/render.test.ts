import { assert, test } from 'orca/testing'
import { EMPTY_SNAPSHOT, type AgentView, type BackgroundView, type Snapshot } from '../shared/types'
import { demoSnapshot } from '../worker/demo'
import { esc, INITIAL_UI, render } from './render'
import { CSS } from './styles'
import { VERSION } from '../shared/version'

const now = Date.parse('2026-01-01T10:00:00Z')

test('escapes everything that comes from a transcript', () => {
  const s = demoSnapshot(now, now - 20_000, true)
  s.agents[0].workspaceName = '<img src=x onerror=alert(1)>'
  s.agents[0].turn!.prompt = '"><script>x</script>'
  s.gate[0].summary = '<b>bold</b>'
  const html = Object.values(render(s, INITIAL_UI, now)).join('')
  assert.ok(!html.includes('<img src=x'))
  assert.ok(!html.includes('<script>'))
  assert.ok(!html.includes('<b>bold</b>'))
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.equal(esc(`a&b<c>"d"'e'`), 'a&amp;b&lt;c&gt;&quot;d&quot;&#39;e&#39;')
})

test('the demo draws every section: alert, agents, subagents, tool calls, activity', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  const r = render(s, INITIAL_UI, now)
  assert.ok(r.alerts.includes('wants <code>Bash</code>'))
  assert.equal((r.agents.match(/<article class="agent/g) ?? []).length, 3)
  assert.equal((r.agents.match(/<article class="agent card/g) ?? []).length, 2)
  assert.ok(r.agents.includes('Subagents'))
  assert.ok(r.agents.includes('Opus 5.5'))
  assert.ok(r.gate.includes('Tool calls'))
  assert.ok(!r.gate.includes('class="calls"'), 'tool calls start folded')
  assert.ok(r.log.includes('Activity'))
  assert.ok(r.header.includes('Demo'))
})

test('an empty snapshot offers the demo', () => {
  const r = render({ ...EMPTY_SNAPSHOT, note: 'No agents here.' }, INITIAL_UI, now)
  assert.ok(r.agents.includes('No agents here.'))
  assert.ok(r.agents.includes('data-action="demo"'))
  assert.equal(r.gate, '')
  assert.equal(r.log, '')
})

test('cost hides when the setting is off, and a family filter lists its calls', () => {
  const s: Snapshot = { ...demoSnapshot(now, now - 40_000, false) }
  const r = render(s, { ...INITIAL_UI, family: 'shell', expanded: { 'sec:calls': true } }, now)
  assert.ok(!/\$\d/.test(r.agents))
  assert.ok(r.gate.includes('fam on'))
  const calls = r.gate.match(/<div class="call /g) ?? []
  assert.ok(calls.length > 0)
  assert.ok(!r.gate.includes('<code>Read</code>'))
})

test('only one agent: its card, calls and activity; asks from others still show', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  const pick = s.agents[0].key
  const other = s.agents.find((a) => a.key !== pick)!.key
  const r = render(s, { ...INITIAL_UI, only: pick, expanded: { 'sec:calls': true, 'sec:log': true } }, now)
  assert.equal((r.agents.match(/<article class="agent/g) ?? []).length, 1)
  assert.ok(r.header.includes('Show all'))
  assert.ok(r.alerts.length > 0)
  const otherName = s.agents.find((a) => a.key === other)!.title
  assert.ok(!r.log.includes(`>${otherName}<`))
  const stale = render(s, { ...INITIAL_UI, only: 'gone' }, now)
  assert.equal((stale.agents.match(/<article class="agent/g) ?? []).length, 3)
})

test('go buttons only for agents Pitwall can focus', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  assert.ok(!render(s, INITIAL_UI, now).alerts.includes('data-action="focus"'))
  for (const a of s.agents) a.canFocus = true
  const r = render(s, INITIAL_UI, now)
  assert.ok(r.alerts.includes('Go to terminal'))
  assert.ok(r.agents.includes('data-action="focus"'))
})

test('file calls lead with the file name', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  s.gate = [{ id: 'f', at: now, endedAt: now, agentKey: s.agents[0].key, sub: false, tool: 'Edit', family: 'file', summary: 'plans/deep/folder/notes.md', state: 'ok' }]
  const r = render(s, { ...INITIAL_UI, expanded: { 'sec:calls': true } }, now)
  assert.ok(r.gate.includes('notes.md <span class="muted">plans/deep/folder</span>'))
})

test('an opened idle agent has a close button', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  const idle = s.agents.find((a) => a.state !== 'working' && a.state !== 'blocked')!
  assert.ok(!render(s, INITIAL_UI, now).agents.includes('Close details'))
  const r = render(s, { ...INITIAL_UI, expanded: { ['car:' + idle.key]: true } }, now)
  assert.ok(r.agents.includes(`data-key-x="car:${idle.key}" title="Close details"`))
})

test('a card says when the transcript format is unknown', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  assert.ok(!render(s, INITIAL_UI, now).agents.includes('does not recognise'))
  s.agents[0].formatUnknown = true
  assert.ok(render(s, INITIAL_UI, now).agents.includes('does not recognise'))
})

test('new idle agents come first with a dot, and the header counts them', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  const idle = s.agents.find((a) => a.state === 'done')!
  const older = { ...idle, key: 'old', title: 'Older one', unseen: false, stateSince: now - 1000 }
  s.agents.push(older)
  const r = render(s, INITIAL_UI, now)
  assert.ok(r.header.includes('1 new'))
  assert.ok(r.agents.indexOf(idle.title) < r.agents.indexOf('Older one'))
  assert.equal(r.agents.split('new-dot').length - 1, 1)
})

test('a working agent near a full context gets a heads-up', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  const w = s.agents.find((a) => a.state === 'working')!
  assert.ok(!render(s, INITIAL_UI, now).alerts.includes('will compact soon'))
  w.ctxTokens = Math.round(w.ctxWindow * 0.93)
  assert.ok(render(s, INITIAL_UI, now).alerts.includes('will compact soon'))
})

test('no animation is left in the panel CSS', () => {
  assert.ok(!/animation|@keyframes/.test(CSS))
})

test('the demo loops without breaking at any second', () => {
  for (let t = 0; t < 95; t += 1) {
    const s = demoSnapshot(now + t * 1000, now, true)
    const r = render(s, INITIAL_UI, now + t * 1000)
    assert.ok(r.agents.length > 0)
    for (const a of s.agents) assert.ok(a.ctxTokens <= (a.ctxWindow || Infinity))
  }
})

// Contrast of the theme tokens against Orca's own light (#fff / #0a0a0a) and dark (#0a0a0a / #f0f0f0) palettes.
test('text stays readable in light and dark (WCAG AA)', () => {
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const mix = (a: number[], b: number[], p: number) => a.map((v, i) => v * p + b[i] * (1 - p))
  const lum = (c: number[]) => {
    const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
  }
  const ratio = (a: number[], b: number[]) => {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m)
    return (x + 0.05) / (y + 0.05)
  }
  const pct = (block: string, name: string) => Number(new RegExp(`--${name}: color-mix\\(in srgb, var\\(--fg\\) (\\d+)%`).exec(block)![1]) / 100
  const color = (block: string, name: string) => hex(new RegExp(`--${name}: (#[0-9a-f]{6})`).exec(block)![1])
  const root = CSS.slice(CSS.indexOf(':root'), CSS.indexOf('}', CSS.indexOf(':root')))
  const light = CSS.slice(CSS.indexOf('html.light'), CSS.indexOf('}', CSS.indexOf('html.light')))
  for (const [name, bg, fg, block] of [
    ['dark', hex('#0a0a0a'), hex('#f0f0f0'), root],
    ['light', hex('#ffffff'), hex('#0a0a0a'), light]
  ] as const) {
    // Muted text and status colours sit on cards (--surface); pills (--surface-2) carry --text-2.
    const card = mix(fg, bg, pct(root, 'surface'))
    const pill = mix(fg, bg, pct(root, 'surface-2'))
    const text = (tok: string) => mix(fg, bg, pct(/--muted:|--text-2:/.test(block) ? block : root, tok))
    assert.ok(ratio(text('muted'), card) >= 4.5, `${name} muted`)
    assert.ok(ratio(text('text-2'), pill) >= 4.5, `${name} text-2`)
    for (const tok of ['run', 'warn', 'bad', 'ok']) assert.ok(ratio(color(block, tok), card) >= 4.5, `${name} ${tok}`)
  }
})

test('a transcript still being read shows no numbers and no total', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  assert.ok(render(s, INITIAL_UI, now).header.includes('$'))
  s.agents[1] = { ...s.agents[1], loading: true, source: 'orca-only', costUsd: null, ctxWindow: 0, turn: null, lastTurn: null }
  const out = render(s, INITIAL_UI, now)
  assert.ok(out.agents.includes('Reading its transcript'))
  assert.ok(!out.header.includes('$'))
})

test('the context tooltip names the window it counts against', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  const html = render(s, INITIAL_UI, now).agents
  assert.ok(html.includes('auto-compact window (model window 1M'))
  s.agents[1] = { ...s.agents[1], ctxWindow: 1_000_000, ctxModelWindow: 1_000_000, ctxBasis: 'model' }
  assert.ok(render(s, INITIAL_UI, now).agents.includes('of the 1M model window'))
})

function setBg(a: AgentView, list: BackgroundView[]): void {
  a.background = list
  const running = list.filter((x) => x.kind === 'shell' || x.kind === 'monitor').length
  a.backgroundCount = { running, scheduled: list.length - running }
}

test('background work: running first with how long, schedules with when, details in the tooltip', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  const w = s.agents.find((a) => a.state === 'working')!
  const r = render(s, INITIAL_UI, now)
  assert.ok(r.agents.includes('Background <span class="muted">1 running · 1 scheduled</span>'))
  assert.ok(r.agents.indexOf('Start the API dev server') < r.agents.indexOf('Check the canary error rate'))
  // The demo job runs within minutes: its clock time, and how long until then.
  assert.ok(/\d\d:\d\d · in <span data-until="\d+">\dm<\/span>/.test(r.agents))
  assert.ok(r.agents.includes('Every 10 minutes · next '))
  // Nothing pending: no block.
  setBg(w, [])
  assert.ok(!render(s, INITIAL_UI, now).agents.includes('Background'))
})

test('a schedule shows now at its time, due when late, nothing when its time is unknown', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  const w = s.agents.find((a) => a.state === 'working')!
  const cron = w.background.find((x) => x.kind === 'cron')!
  setBg(w, [{ ...cron, dueAt: now - 1000 }])
  assert.ok(render(s, INITIAL_UI, now).agents.includes('<span class="muted">now</span>'))
  setBg(w, [{ ...cron, dueAt: now - 600_000, overdue: true }])
  const r = render(s, INITIAL_UI, now)
  assert.ok(r.agents.includes('<span class="warn-t">due</span>'))
  assert.ok(r.agents.includes('due now, runs once the agent is idle'))
  setBg(w, [{ ...cron, dueAt: null }])
  assert.ok(render(s, INITIAL_UI, now).agents.includes('<span class="muted"></span>'))
})

test('a long background list folds to four rows', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  const w = s.agents.find((a) => a.state === 'working')!
  const shell = w.background[0]
  setBg(w, Array.from({ length: 6 }, (_, i) => ({ ...shell, id: 'b' + i, label: 'server ' + i })))
  const r = render(s, INITIAL_UI, now)
  assert.equal((r.agents.match(/class="item bg-row"/g) ?? []).length, 4)
  assert.ok(r.agents.includes('Show all 6'))
  const all = render(s, { ...INITIAL_UI, expanded: { ['bg:' + w.key]: true } }, now)
  assert.equal((all.agents.match(/class="item bg-row"/g) ?? []).length, 6)
  assert.ok(all.agents.includes('Show fewer'))
})

test('an idle row shows the next schedule, else how many run in the background', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  const idle = s.agents.find((a) => a.state === 'done')!
  const [shell, cron] = s.agents.find((a) => a.state === 'working')!.background
  assert.ok(!render(s, INITIAL_UI, now).agents.includes('◷'))
  setBg(idle, [shell, cron])
  let r = render(s, INITIAL_UI, now)
  assert.ok(/<span class="pill" title="[^"]*">◷ <span data-until=/.test(r.agents))
  setBg(idle, [shell, { ...shell, id: 'b2' }])
  r = render(s, INITIAL_UI, now)
  assert.ok(r.agents.includes('▶ 2</span>'))
  setBg(idle, [{ ...cron, overdue: true }])
  assert.ok(render(s, INITIAL_UI, now).agents.includes('<span class="pill warn"'))
})

test('background labels are escaped', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  const w = s.agents.find((a) => a.state === 'working')!
  w.background[0].label = '<img src=x onerror=alert(1)>'
  w.background[0].detail = '"><script>x</script>'
  const r = render(s, INITIAL_UI, now)
  assert.ok(!r.agents.includes('<img src=x'))
  assert.ok(!r.agents.includes('<script>'))
})

test('counts include background work not sent, and say so', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  const w = s.agents.find((a) => a.state === 'working')!
  w.backgroundCount = { running: 9, scheduled: 7 }
  const r = render(s, { ...INITIAL_UI, expanded: { ['bg:' + w.key]: true } }, now)
  assert.ok(r.agents.includes('9 running · 7 scheduled'))
  assert.ok(r.agents.includes('14 more not listed'))
})

test('a quiet GitHub link: in the footer once agents show, in the menu, and on the empty page', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  assert.ok(render(s, INITIAL_UI, now).footer.includes('data-action="github"'))
  assert.ok(render(s, INITIAL_UI, now).footer.includes(`Pitwall ${VERSION}`))
  assert.ok(!render(s, INITIAL_UI, now).header.includes('Star Pitwall'), 'the menu stays closed')
  assert.ok(render(s, { ...INITIAL_UI, menu: true }, now).header.includes('★ Star Pitwall on GitHub'))
  const empty = render({ ...EMPTY_SNAPSHOT }, INITIAL_UI, now)
  assert.equal(empty.footer, '')
  assert.ok(empty.agents.includes('Pitwall on GitHub ↗'))
})

test('a schedule on another day shows its date and time', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  const w = s.agents.find((a) => a.state === 'working')!
  const cron = w.background.find((x) => x.kind === 'cron')!
  const at = new Date(2026, 11, 31, 23, 57).getTime()
  setBg(w, [{ ...cron, dueAt: at }])
  assert.ok(render(s, INITIAL_UI, new Date(2026, 10, 21, 18, 0).getTime()).agents.includes('>Dec 31 23:57</span>'))
})

// ---- Remote Control sessions

test('Remote Control: a section with one row per session, name, project, state, context, cost, prompt and link', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  const r = render(s, INITIAL_UI, now)
  assert.ok(r.remote.includes('Remote Control'))
  assert.ok(r.remote.includes('1 working · 2'))
  assert.equal((r.remote.match(/<article class="agent line rc/g) ?? []).length, 2)
  assert.ok(r.remote.includes('billing-a3') && r.remote.includes('billing-service'))
  assert.ok(r.remote.includes('docs-site-7c') && r.remote.includes('docs-site'))
  assert.ok(r.remote.includes('>Working</span> · Export invoices as CSV'))
  assert.ok(r.remote.includes('>Idle</span> · Rewrite the onboarding guide'))
  assert.ok(r.remote.includes('78%'), 'context of the idle session (312k of 400k)')
  assert.ok(r.remote.includes('$6.07'))
  assert.equal((r.remote.match(/data-action="open-remote"/g) ?? []).length, 2)
  // No terminal to go to, no "only this one".
  assert.ok(!r.remote.includes('data-action="focus"'))
  assert.ok(!r.remote.includes('data-action="only"'))
  // Remote sessions are not counted as Orca agents in the header.
  assert.ok(r.header.includes('1 working'))
})

test('Remote Control: cost hides with the setting; a bad link gives no button; text is escaped', () => {
  const s = demoSnapshot(now, now - 40_000, false)
  s.remote[0].remote!.url = 'https://evil.example/code/session_01DemoRemoteBillingA1'
  s.remote[1].remote!.name = '<img src=x onerror=alert(1)>'
  const r = render(s, INITIAL_UI, now)
  assert.ok(!/\$\d/.test(r.remote))
  assert.equal((r.remote.match(/data-action="open-remote"/g) ?? []).length, 1)
  assert.ok(!r.remote.includes('evil.example'))
  assert.ok(!r.remote.includes('<img src=x'))
  assert.ok(r.remote.includes('&lt;img src=x'))
})

test('Remote Control: a click opens its card in place, with the claude.ai button and no Go to terminal', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  const key = s.remote[1].key
  const r = render(s, { ...INITIAL_UI, expanded: { ['car:' + key]: true } }, now)
  assert.ok(r.remote.includes('<div class="inline-card"><article class="agent card done">'))
  assert.ok(r.remote.includes('↗ Open on claude.ai'))
  assert.ok(r.remote.includes('Context'))
  assert.ok(r.remote.includes('Last turn'))
  assert.ok(!r.remote.includes('Go to terminal'))
  assert.ok(!r.remote.includes('data-action="focus"'))
  assert.equal((r.remote.match(/<article class="agent line rc/g) ?? []).length, 1)
})

test('Remote Control: unknown status, loading transcript, note, folded section, only mode', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  s.remote[1] = { ...s.remote[1], state: 'unknown', loading: true, source: 'orca-only', ctxWindow: 0, costUsd: null }
  s.remoteNote = 'Showing Remote Control sessions from every folder: Orca did not give this workspace\'s folder on this machine.'
  let r = render(s, INITIAL_UI, now)
  assert.ok(r.remote.includes('>Unknown</span> · reading its transcript…'))
  assert.ok(r.remote.includes('Showing Remote Control sessions from every folder'))
  r = render(s, { ...INITIAL_UI, expanded: { 'sec:remote': false } }, now)
  assert.ok(r.remote.includes('Remote Control'))
  assert.ok(!r.remote.includes('<article'))
  r = render(s, { ...INITIAL_UI, only: s.agents[0].key }, now)
  assert.equal(r.remote, '')
})

test('Remote Control without Orca agents: a short line instead of the welcome, and the footer stays', () => {
  const s = { ...demoSnapshot(now, now - 40_000, true), agents: [], gate: [], log: [], note: 'No agents in this workspace yet.' }
  const r = render(s, INITIAL_UI, now)
  assert.ok(r.agents.includes('empty slim'))
  assert.ok(!r.agents.includes('Try the demo'))
  assert.ok(r.remote.includes('billing-a3'))
  assert.ok(r.footer.includes('Star on GitHub'))
  assert.equal(render({ ...EMPTY_SNAPSHOT }, INITIAL_UI, now).remote, '')
})

test('Remote Control tool calls carry the session name in a mixed list', () => {
  const s = demoSnapshot(now, now - 40_000, true)
  const r = render(s, { ...INITIAL_UI, expanded: { 'sec:calls': true } }, now)
  assert.ok(r.gate.includes('billing-a3'))
})
