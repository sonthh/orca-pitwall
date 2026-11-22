// Panel CSS. Every surface and text colour derives from Orca's theme variables, so the panel follows
// light and dark. Active agents sit on a raised card; idle ones are one line each. Colour marks state
// only: blue working, amber needs you, red failed. No motion.
export const CSS = `
:root {
  --bg: var(--orca-background, #111);
  --fg: var(--orca-foreground, #eee);
  --text-2: color-mix(in srgb, var(--fg) 72%, var(--bg));
  --muted: color-mix(in srgb, var(--fg) 52%, var(--bg));
  --line: var(--orca-border, #2a2a2a);
  --surface: color-mix(in srgb, var(--fg) 5%, var(--bg));
  --surface-2: color-mix(in srgb, var(--fg) 9%, var(--bg));
  --hover: color-mix(in srgb, var(--fg) 7%, var(--bg));
  --radius: var(--orca-radius, 8px);
  --run: #60a5fa; --warn: #fbbf24; --bad: #f87171; --ok: #4ade80;
  --warn-bg: color-mix(in srgb, var(--warn) 12%, var(--bg));
  --warn-edge: color-mix(in srgb, var(--warn) 45%, transparent);
}
/* Light text needs more weight to stay readable (WCAG AA 4.5:1 on cards). */
html.light {
  --run: #1d4ed8; --warn: #92400e; --bad: #b91c1c; --ok: #15803d;
  --text-2: color-mix(in srgb, var(--fg) 80%, var(--bg));
  --muted: color-mix(in srgb, var(--fg) 64%, var(--bg));
  --warn-bg: #fef3c7; --warn-edge: #f59e0b;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font: 12.5px/1.45 var(--orca-font-sans, system-ui, sans-serif); }
body { padding: 8px 8px 20px; overflow-x: hidden; }
/* Orca's own "sleek" scrollbars: thin thumb, no track. */
::-webkit-scrollbar { width: 12px; height: 12px; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--muted) 28%, transparent); background-clip: padding-box; border: 3px solid transparent; border-radius: 0; min-height: 28px; }
::-webkit-scrollbar-thumb:hover { background-color: color-mix(in srgb, var(--muted) 48%, transparent); }
::-webkit-scrollbar-thumb:active { background-color: color-mix(in srgb, var(--fg) 36%, transparent); }
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; padding: 0; text-align: left; }
[role="button"]:focus-visible, button:focus-visible { outline: 2px solid var(--orca-ring, var(--run)); outline-offset: 1px; border-radius: 4px; }
code { font-family: var(--orca-font-mono, ui-monospace, monospace); font-size: 11.5px; }
b { font-weight: 600; }
.w5 { font-weight: 500; }
.muted { color: var(--muted); }
.sub-t { color: var(--text-2); }
.small { font-size: 11.5px; }
.right { margin-left: auto; white-space: nowrap; flex: none; }
.ell { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.bad-t { color: var(--bad); } .ok-t { color: var(--ok); } .warn-t { color: var(--warn); }
.row { display: flex; align-items: center; gap: 6px; min-width: 0; }

.top { display: flex; align-items: center; gap: 6px; position: relative; padding: 0 2px 8px; }
.title { font-weight: 600; font-size: 13px; }
.badge { font-size: 11px; color: var(--text-2); background: var(--surface-2); border-radius: 4px; padding: 0 6px; }
.seg { margin-left: auto; display: flex; background: var(--surface); border-radius: 6px; padding: 2px; }
.seg button { padding: 1px 10px; border-radius: 4px; color: var(--text-2); }
.seg button.on { background: var(--surface-2); color: var(--fg); font-weight: 500; }
.icon { width: 24px; height: 24px; border-radius: 5px; color: var(--text-2); text-align: center; flex: none; }
.icon:hover { background: var(--hover); color: var(--fg); }
.small-icon { width: 20px; height: 20px; font-size: 12px; opacity: .8; }
.small-icon:hover { opacity: 1; }
.menu { position: absolute; right: 0; top: 28px; z-index: 5; background: var(--orca-popover, var(--bg)); color: var(--orca-popover-foreground, var(--fg)); border: 1px solid var(--line); border-radius: var(--radius); padding: 4px; min-width: 190px; box-shadow: 0 8px 22px rgba(0,0,0,.28); }
.menu button { display: block; width: 100%; padding: 6px 8px; border-radius: 5px; }
.menu button:hover { background: var(--hover); }
.menu-sep { height: 1px; margin: 4px 2px; background: var(--line); }
.quiet-link { color: var(--muted); font-size: 11px; padding: 0; }
.quiet-link:hover, .quiet-link:focus-visible { color: var(--fg); text-decoration: underline; text-underline-offset: 2px; }
.foot { padding: 14px 4px 6px; text-align: center; font-size: 11px; color: var(--muted); }
.foot .dot-sep { margin: 0 6px; }

.summary { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; padding: 0 2px 8px; font-size: 12px; color: var(--text-2); }
.sum { white-space: nowrap; }
.sum::before { content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; background: var(--muted); vertical-align: 1px; }
.sum.run::before { background: var(--run); } .sum.warn::before { background: var(--warn); }
.sum.right::before { display: none; }
.only-bar { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; padding: 5px 8px; border-radius: var(--radius); background: var(--surface); }
.chip-btn { margin-left: auto; flex: none; font-size: 11.5px; padding: 1px 8px; border-radius: 10px; background: var(--surface-2); }
.chip-btn:hover { color: var(--fg); background: var(--hover); }

.alerts { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; margin-bottom: 8px; }
.alert { padding: 8px 10px; border-radius: var(--radius); background: var(--warn-bg); border: 1px solid var(--warn-edge); }
.badge-warn { flex: none; font-size: 11px; font-weight: 600; padding: 0 6px; border-radius: 4px; color: var(--bg); background: var(--warn); }
.alert .what { margin-top: 5px; padding: 4px 6px; border-radius: 4px; background: var(--surface); font-family: var(--orca-font-mono, ui-monospace, monospace); font-size: 11.5px; overflow-wrap: anywhere; max-height: 4.5em; overflow: hidden; }
.alert-foot { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.alert .hint { font-size: 11px; color: var(--text-2); }
.go { margin-left: auto; flex: none; font-size: 11.5px; font-weight: 500; padding: 2px 9px; border-radius: 5px; background: var(--warn); color: var(--bg); }
.go:hover { filter: brightness(1.08); }
.alert.soft { background: var(--surface); border-color: color-mix(in srgb, var(--warn) 30%, var(--line)); }
.badge-soft { flex: none; font-size: 11px; font-weight: 600; padding: 0 6px; border-radius: 4px; color: var(--warn); background: color-mix(in srgb, var(--warn) 15%, transparent); }
.go.soft, .go-soft { margin-left: auto; flex: none; font-size: 11.5px; font-weight: 500; padding: 2px 9px; border-radius: 5px; background: var(--surface-2); color: var(--fg); }
.new-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--run); }
.sum.new::before { background: var(--run); }

.cards { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; margin-bottom: 8px; }
.card { position: relative; min-width: 0; overflow: hidden; padding: 10px 10px 8px; border-radius: var(--radius); background: var(--surface); border: 1px solid var(--line); }
.card.working { border-color: color-mix(in srgb, var(--run) 35%, var(--line)); }
.card.blocked { border-color: color-mix(in srgb, var(--warn) 55%, var(--line)); }
.card-tools { position: absolute; top: 6px; right: 6px; display: flex; gap: 2px; }
.card-head { padding-right: 66px; }
.card-head.clickable { cursor: pointer; }
.name { font-weight: 600; font-size: 13px; }
.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.link.inline { font-size: inherit; text-decoration: underline dotted; text-underline-offset: 2px; }
.state { flex: none; font-size: 11px; font-weight: 500; padding: 0 7px; border-radius: 10px; background: var(--surface-2); color: var(--text-2); white-space: nowrap; }
.state.working { color: var(--run); background: color-mix(in srgb, var(--run) 15%, transparent); }
.state.blocked { color: var(--warn); background: color-mix(in srgb, var(--warn) 16%, transparent); }
.card-head .row { margin-top: 3px; }
.block { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line); display: grid; grid-template-columns: minmax(0, 1fr); gap: 3px; }
.block-title { font-size: 11.5px; font-weight: 600; color: var(--text-2); }
.ctx { margin-top: 8px; }
.ctx-line { display: flex; align-items: baseline; gap: 6px; font-size: 11.5px; }
.ctx-num { font-weight: 600; font-size: 13px; color: var(--fg); }
.ctx-num.warn { color: var(--warn); } .ctx-num.bad { color: var(--bad); }
.meter { height: 4px; margin-top: 4px; border-radius: 2px; background: var(--surface-2); overflow: hidden; }
.meter i { display: block; height: 100%; border-radius: 2px; background: var(--run); }
.meter.warn i { background: var(--warn); } .meter.bad i { background: var(--bad); }
.prompt { padding-left: 8px; border-left: 2px solid var(--surface-2); color: var(--fg); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.item { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; gap: 6px; align-items: center; font-size: 12px; }
.mark { text-align: center; font-size: 11px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); justify-self: center; }
.dot.run { background: var(--run); }
.link { color: var(--text-2); font-size: 11.5px; justify-self: start; }
.link:hover { color: var(--fg); text-decoration: underline; }

.sec { margin-top: 4px; }
.sec-head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 4px; border-radius: 5px; }
.sec-head:hover { background: var(--hover); }
.chev { width: 10px; color: var(--muted); font-size: 11px; flex: none; }
.sec-title { font-weight: 600; white-space: nowrap; flex: none; }
.sec-head .right { min-width: 0; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; }
.sec-body { padding: 2px 4px 4px 20px; }
.lines { display: grid; grid-template-columns: minmax(0, 1fr); padding-left: 14px; }
.line { display: flex; align-items: center; gap: 6px; padding: 4px 2px 4px 4px; border-radius: 5px; cursor: pointer; min-width: 0; }
.line:hover { background: var(--hover); }
.line .name { font-weight: 500; font-size: 12.5px; }
.line .time { flex: none; font-size: 11.5px; min-width: 38px; text-align: right; }
.line .ell { flex: 1 1 auto; }
.hover-tools { display: none; flex: none; }
.line .chev, .card-head .chev { flex: none; }
.card-head .chev { display: inline-block; width: 14px; color: var(--muted); font-weight: 400; font-size: 11px; }
.go-icon { width: 24px; height: 24px; font-size: 13px; }
.inline-card { margin: 4px 0 6px; }
.line:hover .hover-tools, .line:focus-within .hover-tools { display: flex; }
.pill { flex: none; font-size: 11px; padding: 0 6px; border-radius: 9px; background: var(--surface-2); color: var(--text-2); }
.pill.warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 15%, transparent); }
.pill.bad { color: var(--bad); background: color-mix(in srgb, var(--bad) 15%, transparent); }

.fams { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.fam { font-size: 11.5px; padding: 0 7px; border-radius: 10px; background: var(--surface); color: var(--text-2); }
.fam:hover { color: var(--fg); }
.fam.on { background: var(--fg); color: var(--bg); } .fam.on .muted { color: var(--bg); }
.calls { display: grid; gap: 1px; }
.call, .log-row { display: grid; grid-template-columns: 12px auto minmax(0, 1fr) auto; gap: 6px; align-items: baseline; font-size: 12px; padding: 1px 0; }
.log-row { grid-template-columns: 12px minmax(0, 1fr) auto; }
.log-who { font-size: 11.5px; font-weight: 600; margin-top: 6px; }
.log-who:first-child { margin-top: 0; }
.ico { text-align: center; color: var(--muted); }
.s-ok .ico, .k-done .ico { color: var(--ok); }
.s-error .ico, .s-denied .ico, .k-error .ico, .k-denied .ico { color: var(--bad); }
.s-asking .ico, .k-asking .ico { color: var(--warn); }
.s-running .ico, .k-spawn .ico { color: var(--run); }

.empty { padding: 28px 12px; text-align: center; }
.empty.slim { padding: 10px 4px 2px; text-align: left; }
/* A Remote Control row: name, project, time and link above; state, prompt, context and cost below. */
.line.rc { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto 24px; grid-template-areas: "chev top time go" ". sub meta go"; column-gap: 6px; row-gap: 1px; align-items: center; }
.rc .chev { grid-area: chev; }
.rc .rc-top { grid-area: top; }
.rc .time { grid-area: time; }
.rc .rc-go { grid-area: go; display: flex; justify-content: center; }
.rc .rc-sub { grid-area: sub; }
.rc .rc-meta { grid-area: meta; display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.rc .rc-top, .rc .rc-sub { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc .rc-top .dot { display: inline-block; margin-right: 5px; vertical-align: 1px; }
.rc-state.working { color: var(--run); }
.rc-note { padding: 2px 4px 4px; }
.rc-foot { display: flex; align-items: center; gap: 8px; }
.rc-foot .ell { flex: 1 1 auto; min-width: 0; }
.empty-title { font-weight: 600; font-size: 13px; margin-bottom: 6px; }
.empty p { margin: 0 0 8px; }
.primary { margin-top: 6px; padding: 5px 14px; border-radius: var(--radius); background: var(--orca-primary, var(--fg)); color: var(--orca-primary-foreground, var(--bg)); font-weight: 500; }
`
