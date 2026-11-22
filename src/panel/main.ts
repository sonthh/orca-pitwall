// The Pitwall panel (HTML frame). Asks the worker for a snapshot, then redraws each section only
// when its markup changes; clocks tick once a second without a redraw.
import '../shared/protocol'
import { fmtDuration, fmtUntil } from '../shared/format'
import { EMPTY_SNAPSHOT, type Scope, type Snapshot, type ToolFamily } from '../shared/types'
import { isClaudeSessionUrl } from '../shared/links'
import { INITIAL_UI, REPO_URL, render, sectionOpen, type Rendered, type UiState } from './render'
import { CSS } from './styles'

let snap: Snapshot = EMPTY_SNAPSHOT
const ONLY_KEY = 'pitwall.only'
let ui: UiState = { ...INITIAL_UI, expanded: {}, only: readOnly() }

// The "show only this agent" choice survives a panel reload; it is a per-viewer convenience.
function readOnly(): string | null {
  try {
    return localStorage.getItem(ONLY_KEY) || null
  } catch {
    return null
  }
}

function writeOnly(key: string | null): void {
  try {
    if (key) localStorage.setItem(ONLY_KEY, key)
    else localStorage.removeItem(ONLY_KEY)
  } catch {
    // Storage blocked: the choice lasts until the panel reloads.
  }
}
let loaded = false
const parts: Record<keyof Rendered, HTMLElement> = {} as Record<keyof Rendered, HTMLElement>
const last: Partial<Rendered> = {}

function mountShell(): void {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)
  for (const k of ['header', 'alerts', 'agents', 'remote', 'gate', 'log', 'footer'] as (keyof Rendered)[]) {
    const el = document.createElement('div')
    el.dataset.part = k
    document.body.appendChild(el)
    parts[k] = el
  }
  document.body.addEventListener('click', onClick)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.menu) setUi({ menu: false })
    // Rows that act like buttons (role="button") answer Enter and Space as buttons do.
    const el = document.activeElement as HTMLElement | null
    if ((e.key === 'Enter' || e.key === ' ') && el?.getAttribute('role') === 'button' && el.dataset.action) {
      e.preventDefault()
      el.click()
    }
  })
}

function draw(): void {
  if (!loaded) {
    parts.agents.innerHTML = '<div class="muted small" style="padding:20px 4px">Loading…</div>'
    return
  }
  const out = render(snap, ui, Date.now())
  // A redraw replaces the markup; keep keyboard focus on the same control.
  const active = document.activeElement as HTMLElement | null
  // Only while the panel has focus: restoring it otherwise would pull typing away from the terminal.
  const sig = document.hasFocus() && active && active !== document.body ? focusSig(active) : null
  for (const k of Object.keys(out) as (keyof Rendered)[]) {
    if (last[k] === out[k]) continue
    last[k] = out[k]
    parts[k].innerHTML = out[k]
  }
  if (sig && (document.activeElement === document.body || !document.activeElement?.isConnected)) restoreFocus(sig)
}

function focusSig(el: HTMLElement): string | null {
  const a = el.dataset.action
  if (!a) return null
  return [a, el.dataset.key ?? '', el.dataset.keyX ?? '', el.dataset.scope ?? '', el.dataset.family ?? ''].join('|')
}

function restoreFocus(sig: string): void {
  const els = document.querySelectorAll<HTMLElement>('[data-action]')
  for (let i = 0; i < els.length; i++) {
    if (focusSig(els[i]) === sig) {
      els[i].focus({ preventScroll: true })
      return
    }
  }
}

function tickClocks(): void {
  const now = Date.now()
  document.querySelectorAll<HTMLElement>('[data-since]').forEach((el) => {
    el.textContent = fmtDuration(now - Number(el.dataset.since))
  })
  document.querySelectorAll<HTMLElement>('[data-ago]').forEach((el) => {
    el.textContent = fmtDuration(now - Number(el.dataset.ago))
  })
  document.querySelectorAll<HTMLElement>('[data-until]').forEach((el) => {
    el.textContent = fmtUntil(Number(el.dataset.until) - now)
  })
}

function setUi(patch: Partial<UiState>): void {
  ui = { ...ui, ...patch }
  draw()
}

function accept(s: Snapshot): void {
  snap = s
  loaded = true
  draw()
}

async function request<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (err) {
    console.error('pitwall:', (err as Error).message)
    return null
  }
}

function onClick(e: MouseEvent): void {
  const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')
  if (!target) {
    if (ui.menu) setUi({ menu: false })
    return
  }
  const action = target.dataset.action
  if (action === 'menu') return setUi({ menu: !ui.menu })
  if (action === 'scope') {
    const scope = target.dataset.scope as Scope
    snap = { ...snap, scope }
    draw()
    void request(() => orca.plugin.request('pitwall.setScope', { scope })).then((s) => s && accept(s))
    return
  }
  if (action === 'demo') {
    setUi({ menu: false })
    void request(() => orca.plugin.request('pitwall.setDemo', { on: !snap.demo })).then((s) => s && accept(s))
    return
  }
  if (action === 'focus') {
    const key = target.dataset.key ?? ''
    target.blur()
    void request(() => orca.plugin.request('pitwall.focus', { key })).then((r) => {
      if (r && !r.focused) console.warn('pitwall: could not focus the terminal:', r.reason ?? 'unknown')
    })
    return
  }
  if (action === 'github') {
    setUi({ menu: false })
    // Only on this click, in the person's browser; Orca asks once before opening github.com.
    void request(async () => (orca.shell ? orca.shell.openExternal(REPO_URL) : null))
    return
  }
  if (action === 'open-remote') {
    const r = snap.remote.find((x) => x.key === target.dataset.key)
    const url = r?.remote?.url
    target.blur()
    // The demo's sessions are invented; a real one opens only a claude.ai/code/session_… URL, and only on this click.
    if (snap.demo || !isClaudeSessionUrl(url)) {
      if (!snap.demo) console.warn('pitwall: not a claude.ai session link')
      return
    }
    void request(async () => (orca.shell ? orca.shell.openExternal(url) : null))
    return
  }
  if (action === 'reset') {
    setUi({ menu: false })
    void request(() => orca.plugin.request('pitwall.reset')).then((s) => s && accept(s))
    return
  }
  if (action === 'only') {
    const key = target.dataset.key || null
    writeOnly(key)
    return setUi({ only: key, family: null })
  }
  if (action === 'family') {
    const f = target.dataset.family as ToolFamily
    return setUi({ family: ui.family === f ? null : f })
  }
  if (action === 'expand') {
    const key = target.dataset.keyX ?? target.dataset.key ?? ''
    // A section starts open or closed by default; toggle what the person sees, not the stored flag.
    const open = key.startsWith('sec:') ? sectionOpen(ui, key.slice(4)) : !!ui.expanded[key]
    // Opening an agent counts as looking at its finished turn.
    if (!open && key.startsWith('car:')) void request(() => orca.plugin.request('pitwall.seen', { key: key.slice(4) }))
    return setUi({ expanded: { ...ui.expanded, [key]: !open } })
  }
}

mountShell()
draw()
orca.plugin.on('pitwall.snapshot', (s) => accept(s))
void request(() => orca.plugin.request('pitwall.snapshot')).then((s) => s && accept(s))
setInterval(tickClocks, 1000)
