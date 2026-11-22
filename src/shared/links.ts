// Links Pitwall may open in the browser, on a click only. Checked on both sides: the worker builds
// them, the panel checks again before it asks Orca to open one.

/** A Claude Code session on claude.ai: https://claude.ai/code/session_<id>, nothing more. */
export const CLAUDE_SESSION_URL = /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{8,64}$/

export function isClaudeSessionUrl(url: unknown): url is string {
  return typeof url === 'string' && CLAUDE_SESSION_URL.test(url)
}

/** The claude.ai page of a Remote Control session, or null when the id is not one Pitwall trusts. */
export function claudeSessionUrl(bridgeSessionId: unknown): string | null {
  if (typeof bridgeSessionId !== 'string') return null
  const url = `https://claude.ai/code/${bridgeSessionId}`
  return isClaudeSessionUrl(url) ? url : null
}
