// Claude Code Remote Control sessions running outside Orca (for example `claude remote-control` under
// a LaunchAgent). Claude Code keeps one file per running process, <claudeDir>/sessions/<pid>.json; a
// session with a `bridgeSessionId` is reachable from claude.ai. The format is internal to Claude Code
// and undocumented, so every field is checked and a file that does not fit is skipped.
//
// Only `<digits>.json` is ever opened in that folder: the `*.key` files next to them hold secrets.
// Read-only; `process.kill(pid, 0)` only asks whether the process exists, it sends no signal.
import { promises as fs } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { claudeSessionUrl } from '../../shared/links'
import type { Gate } from '../gate'
import type { TranscriptLocator } from './files'
import { ClaudeSession } from './session'
import type { ParserEvent } from './transcript'

export type RemoteStatus = 'busy' | 'idle' | 'unknown'

export interface RemoteSessionFile {
  pid: number
  sessionId: string
  bridgeSessionId: string
  /** Its claude.ai page, or null when the bridge id is not one Pitwall trusts to open. */
  url: string | null
  cwd: string
  name: string
  status: RemoteStatus
  updatedAt: number
  /** When `status` last changed, when Claude Code says. */
  statusUpdatedAt: number | null
}

/** The only file names read in sessions/: a pid and `.json`. Never `*.key`. */
export const SESSION_FILE = /^(\d{1,10})\.json$/
const SESSION_ID = /^[A-Za-z0-9_-]{8,80}$/
const MAX_FILE_BYTES = 64 * 1024
const MAX_FILES = 256

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

function str(v: unknown, max = 512): string | null {
  return typeof v === 'string' && v.trim() && v.length <= max ? v : null
}

/**
 * One session file, or null when it is not a Remote Control session Pitwall can show: bad JSON, a
 * missing or mistyped required field (pid, sessionId, cwd, updatedAt, bridgeSessionId), or no bridge.
 */
export function parseSessionFile(text: string): RemoteSessionFile | null {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return null
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null
  const o = j as Record<string, unknown>
  const pid = num(o.pid)
  const sessionId = str(o.sessionId, 80)
  const cwd = str(o.cwd, 4096)
  const updatedAt = num(o.updatedAt)
  const bridge = str(o.bridgeSessionId, 128)
  if (!pid || !Number.isInteger(pid) || !sessionId || !SESSION_ID.test(sessionId) || !cwd || !isAbsolute(cwd) || !updatedAt || !bridge) return null
  const status: RemoteStatus = o.status === 'busy' || o.status === 'idle' ? o.status : 'unknown'
  return {
    pid,
    sessionId,
    bridgeSessionId: bridge,
    url: claudeSessionUrl(bridge),
    cwd,
    name: str(o.name, 200)?.trim() ?? (basename(cwd) || sessionId.slice(0, 8)),
    status,
    updatedAt,
    statusUpdatedAt: num(o.statusUpdatedAt)
  }
}

/** Whether a process with this pid runs and is ours. A process of another user (EPERM) is not a session of ours. */
export function isAlive(pid: number, kill: (pid: number, signal: 0) => unknown = (p, s) => process.kill(p, s)): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The live Remote Control sessions in <root>/sessions. Null when the folder could not be listed for a
 * passing reason (it is kept as it was); an empty list when the folder does not exist.
 */
export async function listRemoteSessions(root: string, alive: (pid: number) => boolean = (p) => isAlive(p)): Promise<RemoteSessionFile[] | null> {
  const dir = join(root, 'sessions')
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null
  }
  const bySession = new Map<string, RemoteSessionFile>()
  for (const n of names.filter((x) => SESSION_FILE.test(x)).slice(0, MAX_FILES)) {
    const filePid = Number(SESSION_FILE.exec(n)![1])
    let f: RemoteSessionFile | null = null
    try {
      const path = join(dir, n)
      // lstat: a symlink could point anywhere; Claude Code writes plain files here.
      const st = await fs.lstat(path)
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue
      f = parseSessionFile(await fs.readFile(path, 'utf8'))
    } catch {
      continue
    }
    // A file named for another pid is not one Claude Code keeps for this process.
    if (!f || f.pid !== filePid || !alive(f.pid)) continue
    const prior = bySession.get(f.sessionId)
    if (!prior || f.updatedAt > prior.updatedAt) bySession.set(f.sessionId, f)
  }
  return [...bySession.values()]
}

export interface RemoteEntry {
  key: string
  file: RemoteSessionFile
  claude: ClaudeSession
}

export const REMOTE_PREFIX = 'rc:'

/** Follows the live Remote Control sessions and reads each one's transcript like an Orca agent's. */
export class RemoteSessions {
  readonly entries = new Map<string, RemoteEntry>()

  constructor(
    private readonly gate: Gate,
    private readonly log: (e: ParserEvent & { agentKey: string }) => void,
    private readonly alive: (pid: number) => boolean = (p) => isAlive(p)
  ) {}

  /**
   * Lists the session files, keeps the ones `keep` accepts (not shown by Orca, in scope), and reads
   * what their transcripts gained. Returns true when anything changed.
   */
  async poll(root: string, locator: TranscriptLocator, keep: (f: RemoteSessionFile) => boolean): Promise<boolean> {
    const files = await listRemoteSessions(root, this.alive)
    let changed = false
    if (files) {
      const seen = new Set<string>()
      for (const f of files) {
        if (!keep(f)) continue
        const key = REMOTE_PREFIX + f.sessionId
        seen.add(key)
        const e = this.entries.get(key)
        if (!e) {
          this.entries.set(key, { key, file: f, claude: new ClaudeSession(f.sessionId, key, this.gate, this.log) })
          changed = true
        } else {
          if (e.file.updatedAt !== f.updatedAt || e.file.status !== f.status || e.file.name !== f.name) changed = true
          e.file = f
        }
      }
      for (const key of [...this.entries.keys()]) if (!seen.has(key)) changed = this.drop(key) || changed
    }
    for (const e of this.entries.values()) {
      if (await e.claude.poll(locator)) changed = true
      // Idle at the prompt: a call still open was interrupted and will not report back, as when an Orca agent turns idle.
      if (e.file.status === 'idle') this.gate.settle(e.key, e.file.statusUpdatedAt ?? e.file.updatedAt)
    }
    return changed
  }

  drop(key: string): boolean {
    if (!this.entries.delete(key)) return false
    this.gate.forget(key)
    return true
  }
}

/** Whether `cwd` is `root` or inside it. */
export function isInside(cwd: string, root: string): boolean {
  const r = root.replace(/\/+$/, '')
  if (!r) return false
  return cwd === r || cwd.startsWith(r + '/')
}
