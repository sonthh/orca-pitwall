# Changelog

## Unreleased

- **Remote Control** section: Claude Code sessions running outside Orca with Remote Control, read from `~/.claude/sessions/<pid>.json` (never the `*.key` files there). Each shows its name, project, working or idle, context, cost, latest prompt and last activity; click for its card, **↗ Open on claude.ai** to open it. Sessions Orca already shows are not repeated; in **This**, only those in the focused workspace's folder. The status bar counts the ones at work (`RC 2 working`). Demo mode has two.

## 0.2.0

- **Background** on each agent: background shells and Monitor watches still running, cron jobs and the `/loop` wakeup with their next run. An idle agent's row shows the next run or how many run; the status bar counts them (`2 bg`).
- A cron job or wakeup that runs starts a turn, so its tool calls count in it (`scheduled: …` / `loop: …`).
- Activity lists background shells and monitors as they finish, fail or are stopped.
- A quiet footer with the version and a **Star on GitHub** link (also in the ⋯ menu); it opens your browser only when clicked.
- Cron jobs show the time they run (`23:41 · in 4h27m`, or `Dec 31 23:57` on another day).

## 0.1.0

First release.

- Working agents on a card (state, model, effort, context, cost, prompt, running subagents, latest tool calls); idle agents one line each with their context.
- Needs-you alerts for agents waiting on a permission prompt, with the command they want to run and a Go to terminal button.
- Jump to any agent's terminal from the panel; show only one agent.
- No partial numbers while a transcript is first read; local slash commands keep the last turn; Orca-style scrollbars.
- New-since-you-looked dots, idle agents sorted by what needs a look, a heads-up before a working agent's context fills.
- Tool calls with outcome and family filters, activity list, status bar summary, demo mode.
- Follows Orca's theme (light and dark); keyboard friendly.
- Credential masking in every tool summary and prompt.
