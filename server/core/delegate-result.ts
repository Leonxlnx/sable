import { createHash } from 'node:crypto';
import type { TimelineItem, ToolItem, TurnItem } from '../../shared/protocol';

export const MAX_DELEGATE_RESULT = 40_000;

export function delegateAnswer(words?: string, error?: string) {
  const answer = words?.trim() || (error ? `The sub-agent stopped: ${error}` : 'The sub-agent finished without a written answer.');
  return { ok: !error, text: answer.length > MAX_DELEGATE_RESULT ? answer.slice(0, MAX_DELEGATE_RESULT) + '\n\n(cut off)' : answer };
}

function resultBody(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  const block = Array.isArray(content) && content.length === 1 ? content[0] : undefined;
  if ((block?.type === 'text' || block?.type === 'inputText') && typeof block.text === 'string') return block.text;
}

/** Some SDK calls have no tool-use id until their result is echoed. */
export function anonymousDelegateStep(content: unknown): string | undefined {
  const last = resultBody(content);
  const id = typeof last === 'string' && /\n\n\[Sable delegate receipt ([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\]$/.exec(last)?.[1];
  return id ? 'delegate-' + id : undefined;
}

export type WantedReceipts = { ids: Set<string>; tools: Map<string, { delivery?: string; digest?: string }> };

export function resultDigest(content: unknown): string | undefined {
  const text = resultBody(content);
  return text !== undefined ? createHash('sha256').update(text).digest('hex') : undefined;
}

export function toolReceipt(id: string, content: unknown, wanted: WantedReceipts['tools']) {
  const marker = anonymousDelegateStep(content);
  const key = wanted.has(id) ? id : marker;
  const expected = key && wanted.get(key);
  if (expected && (marker === 'delegate-' + expected.delivery || expected.digest && resultDigest(content) === expected.digest)) return key;
}

type SavedEnd = { words?: string; turn?: TurnItem; interrupted?: boolean; lost?: boolean; liveReceiver?: boolean };

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
    if (row.type === 'tool' && row.result?.agent?.background === 'running') end.liveReceiver = true;
    if (row.type === 'notice' && row.variant === 'interrupted') end.interrupted = true;
    if (row.type === 'notice' && row.early) end.lost = true;
  }
  return ends;
}

export function restoreWorkingDelegate(row: ToolItem, end?: SavedEnd): ToolItem {
  const waiting = row.delegateReceiversPending || end?.liveReceiver;
  const reported = !waiting && row.result?.text;
  const stopped = end?.interrupted || end?.turn?.stopReason === 'interrupted';
  const result = reported ? { ok: !row.result?.isError, text: reported }
    : stopped ? { ok: false, text: 'The sub-agent stopped before it finished.' }
    : end?.lost ? { ok: false, text: 'The sub-agent lost its process before it finished.' }
    : end?.turn && !waiting ? delegateAnswer(end.words, end.turn.error)
    : undefined;
  const outcome = stopped || !result ? 'stopped' : result.ok ? 'done' : 'failed';
  return { ...row, delegateReceiversPending: undefined, delegateReport: 'pending', status: outcome === 'stopped' ? 'cancelled' : result?.ok ? 'done' : 'error',
    result: { ...row.result, text: result?.text ?? 'Sable restarted before the sub-agent reported.', isError: !result?.ok,
      agent: { ...row.result?.agent, background: outcome } } };
}
