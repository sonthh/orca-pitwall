// The snapshot the worker sends to every open Pitwall panel. Agent-neutral: an adapter (only
// Claude Code today) fills the transcript-based fields; Orca itself fills state and tool calls.

export type AgentState = 'working' | 'blocked' | 'waiting' | 'done' | 'unknown'
export type GateState = 'running' | 'asking' | 'ok' | 'error' | 'denied'
export type ToolFamily = 'file' | 'shell' | 'web' | 'mcp' | 'agent' | 'other'
export type Scope = 'focused' | 'all'

export interface TurnView {
  startedAt: number
  endedAt: number | null
  prompt: string
  tools: number
  edits: number
  errors: number
  agents: number
  costUsd: number | null
}

export interface SubagentView {
  id: string
  type: string
  task: string
  model: string | null
  startedAt: number
  endedAt: number | null
  status: 'running' | 'done' | 'error'
  ctxTokens: number
  outTokens: number
  steps: number
  costUsd: number | null
  lastTools: string[]
}

/** Work an agent left running or scheduled: a background shell, a monitor, a cron job, the /loop wakeup. */
export interface BackgroundView {
  id: string
  kind: 'shell' | 'monitor' | 'cron' | 'wakeup'
  label: string
  /** When it started; null when Pitwall learned of it later and cannot say. */
  startedAt: number | null
  /** Next run of a cron job or the wakeup; null when there is none or the schedule is one Pitwall cannot read. */
  dueAt: number | null
  /** The schedule as Claude Code describes it. */
  schedule: string | null
  recurring: boolean
  /** When it stops on its own (a monitor's timeout, a recurring cron's expiry). */
  endsAt: number | null
  detail: string | null
  /** Past its time and waiting: Claude Code runs schedules only once the agent is idle. */
  overdue: boolean
}

export interface AgentView {
  key: string
  agentKind: string
  title: string
  workspaceName: string
  branch: string | null
  state: AgentState
  stateSince: number
  source: 'transcript' | 'orca-only'
  /** The transcript exists but its format is not one Pitwall reads. */
  formatUnknown: boolean
  /** Its transcript is still being read for the first time: no number is final yet. */
  loading: boolean
  model: string | null
  effort: string | null
  ctxTokens: number
  ctxWindow: number
  /** The model's own window, and where ctxWindow comes from: the model, the auto-compact window, or the Context window setting. */
  ctxModelWindow: number
  ctxBasis: 'model' | 'compact' | 'setting'
  compactions: number
  costUsd: number | null
  outTokens: number
  requests: number
  cacheHitPct: number | null
  turn: TurnView | null
  lastTurn: TurnView | null
  subagents: SubagentView[]
  /** Subagents this session started, including ones not sent. */
  subagentTotal: number
  /** Pitwall can bring this agent's terminal to the front (it has one, and this is not the demo). */
  canFocus: boolean
  /** Finished a turn the person has not looked at yet (opened or jumped to it in Pitwall). */
  unseen: boolean
  /** Background shells, monitors, cron jobs and the wakeup still pending; running ones first, then by next run. */
  background: BackgroundView[]
  /** All of it, including any not sent: running (shells, monitors) and scheduled (cron jobs, wakeup). */
  backgroundCount: { running: number; scheduled: number }
  /** Set on a Claude Code Remote Control session running outside Orca (no terminal to go to). */
  remote?: RemoteInfo
}

/** A Remote Control session Pitwall found in Claude Code's session files, not in an Orca terminal. */
export interface RemoteInfo {
  /** Its page on claude.ai, checked against CLAUDE_SESSION_URL; null when the id does not fit. */
  url: string | null
  /** The session's name as Claude Code reports it. */
  name: string
  /** Last folder of its working directory. */
  project: string
  cwd: string
  /** Last time Claude Code updated the session file. */
  updatedAt: number
}

export interface GateEntry {
  id: string
  at: number
  endedAt: number | null
  agentKey: string
  sub: boolean
  tool: string
  family: ToolFamily
  summary: string
  state: GateState
}

export interface LogEntry {
  at: number
  agentKey: string
  kind: 'prompt' | 'spawn' | 'done' | 'edit' | 'error' | 'denied' | 'asking' | 'compact' | 'turn'
  text: string
}

export interface Snapshot {
  v: 1
  at: number
  scope: Scope
  demo: boolean
  showCost: boolean
  agents: AgentView[]
  gate: GateEntry[]
  log: LogEntry[]
  note: string | null
  /** Claude Code Remote Control sessions running outside Orca on this machine. */
  remote: AgentView[]
  /** Why the Remote Control list is not limited to the focused workspace, when it is not. */
  remoteNote: string | null
}

export const EMPTY_SNAPSHOT: Snapshot = {
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
