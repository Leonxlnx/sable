import type { TimelineItem } from '@shared/protocol';

/** Past its own time limit by this much, a command that has not ended is said to be not answering. */
export const STALL_GRACE_MS = 30_000;

/**
 * When a running command step stops being believable: its own time limit (Claude Code's Bash takes
 * `timeout`, 2 minutes unless the call names one; Codex's commands carry `timeout_ms`; anything else
 * gets 10 minutes) plus a grace. 0 for a step that runs in the background or is not a command.
 */
export function stallAt(it: TimelineItem): number {
  if (it.type !== 'tool' || it.kind !== 'bash' || it.status !== 'running' || it.detail?.background) return 0;
  const inp = it.input as { timeout?: unknown; timeout_ms?: unknown; run_in_background?: unknown } | undefined;
  if (inp?.run_in_background === true) return 0;
  const named = typeof inp?.timeout === 'number' ? inp.timeout : typeof inp?.timeout_ms === 'number' ? inp.timeout_ms : 0;
  const limit = named > 0 ? Math.min(named, 3_600_000) : it.name === 'Bash' ? 120_000 : 600_000;
  return it.ts + limit + STALL_GRACE_MS;
}
