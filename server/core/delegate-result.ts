import type { TimelineItem, ToolItem, TurnItem } from '../../shared/protocol';

export const MAX_DELEGATE_RESULT = 40_000;

export function delegateAnswer(words?: string, error?: string) {
  const answer = words?.trim() || (error ? `The sub-agent stopped: ${error}` : 'The sub-agent finished without a written answer.');
  return { ok: !error, text: answer.length > MAX_DELEGATE_RESULT ? answer.slice(0, MAX_DELEGATE_RESULT) + '\n\n(cut off)' : answer };
}

/** Some SDK calls have no tool-use id until their result is echoed. */
export function anonymousDelegateStep(content: unknown): string | undefined {
  const last = Array.isArray(content) ? content.at(-1)?.text : content;
  const id = typeof last === 'string' && /\n\n\[Sable delegate receipt ([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\]$/.exec(last)?.[1];
  return id ? 'delegate-' + id : undefined;
}

type SavedEnd = { words?: string; turn?: TurnItem; interrupted?: boolean; lost?: boolean };

/** Older saves can contain the child's terminal turn one write ahead of its delegate row. */
export function savedDelegateEnds(items: TimelineItem[]) {
  const ends = new Map<string, SavedEnd>();
  for (const row of items) if (row.type === 'tool' && (row.delegateReport === 'working' || row.delegateCaller !== undefined)) ends.set(row.id, {});
  if (!ends.size) return ends;
  for (const row of items) {
    const end = row.parentId && ends.get(row.parentId);
    if (!end || !row.id.startsWith('sub-')) continue;
    if (row.type === 'text' && !row.streaming && row.text.trim()) end.words = row.text;
    if (row.type === 'turn') end.turn = row;
    if (row.type === 'notice' && row.variant === 'interrupted') end.interrupted = true;
    if (row.type === 'notice' && row.early) end.lost = true;
  }
  return ends;
}

export function restoreWorkingDelegate(row: ToolItem, end?: SavedEnd): ToolItem {
  const reported = row.result?.text;
  const stopped = end?.interrupted || end?.turn?.stopReason === 'interrupted';
  const result = reported ? { ok: !row.result?.isError, text: reported }
    : stopped ? { ok: false, text: 'The sub-agent stopped before it finished.' }
    : end?.lost ? { ok: false, text: 'The sub-agent lost its process before it finished.' }
    : end?.turn ? delegateAnswer(end.words, end.turn.error)
    : undefined;
  const outcome = stopped || !result ? 'stopped' : result.ok ? 'done' : 'failed';
  return { ...row, delegateReport: 'pending', status: outcome === 'stopped' ? 'cancelled' : result?.ok ? 'done' : 'error',
    result: { ...row.result, text: result?.text ?? 'Sable restarted before the sub-agent reported.', isError: !result?.ok,
      agent: { ...row.result?.agent, background: outcome } } };
}
