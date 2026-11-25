import type { TimelineItem } from './protocol';
import { noticeLevel } from './notice';

type ItemMap = Record<string, TimelineItem | undefined>;

/**
 * Where one item's own time ends, for a turn's or a checkpoint's span, or null when it is no act of
 * the turn: its work and words count (steps, thinking, texts, things shown) and the notices that say
 * how it ended (Interrupted, an error, the bridge's word that it was cut); other notices came beside
 * it (an account move, a mode change) and never draw it out. A cancelled step's end is left out: a
 * settle stamped it with the moment it ran, which in a chat saved before 0.2.23 may be hours after
 * the step (the next turn's end), so its own start is all that is known of it.
 */
function actEnd(it: TimelineItem | undefined): number | null {
  if (!it) return null;
  switch (it.type) {
    case 'tool':
      if (it.check) return null;
      return it.status === 'cancelled' ? it.ts : Math.max(it.ts, it.endedAt ?? 0);
    case 'thinking':
    case 'text':
      return Math.max(it.ts, ('endedAt' in it && typeof it.endedAt === 'number' && it.endedAt) || 0);
    case 'notice':
      return it.early || it.variant === 'interrupted' || (it.variant === 'error' && noticeLevel(it) === 'error') ? it.ts : null;
    default:
      return null;
  }
}

/** A steer keeps the time it was sent. Its checkpoint starts with actual work after the take. */
export function checkpointStart(items: ItemMap, ids: readonly string[], from: string | null): number | undefined {
  const lead = from ? items[from] : undefined;
  if (lead?.type === 'user' && !lead.steered && Number.isFinite(lead.ts) && lead.ts > 0) return lead.ts;
  for (const id of ids) {
    const it = items[id];
    if (it && Number.isFinite(it.ts) && it.ts > 0 && actEnd(it) !== null) return it.ts;
  }
  return undefined;
}

/** Measure each provider record and the observed work outside its coverage, in root order.
 * A checkpoint only owns the portion of a closing record after the checkpoint began. */
export function workedSpan(items: ItemMap, ids: readonly string[], from: string | null, cap?: string | null, until?: string | null): number | null {
  const intervals: [number, number][] = [];
  const limit = cap ? items[cap] : undefined;
  const hasTime = (ts: number | undefined): ts is number => ts !== undefined && Number.isFinite(ts) && ts > 0;
  const bound = hasTime(limit?.ts) ? limit.ts : Infinity;
  const opener = from ? items[from] : undefined;
  const closer = until ? items[until] : undefined;
  const cut = (it: TimelineItem) => it.type === 'notice' && (it.early || it.variant === 'interrupted' || it.limit);
  const steer = (it: TimelineItem) => it.type === 'user' && it.steered && it.state !== 'queued';
  let begin = 0;
  let lastBoundary = -1;
  let lastCutTime = 0;
  let undated = 0;

  // A record describes the acts since the preceding record. With no clock on the record,
  // root order at the last cut or take tells which acts belong to it.
  function measure(end: number, record?: Extract<TimelineItem, { type: 'turn' }>, checkpoint = false) {
    const timed = record && hasTime(record.ts);
    // Without a timestamp there is no way to assign a whole record to its last checkpoint.
    const ownsRecord = timed || !checkpoint;
    const duration = ownsRecord && record && Number.isFinite(record.durationMs) && record.durationMs > 0 ? record.durationMs : 0;
    const coverage = duration && timed ? record.ts - duration : Infinity;
    const boundary = lastBoundary >= begin ? items[ids[lastBoundary]] : undefined;
    // Keep the old message-to-end fallback for a record with no figure or a turn with no record.
    // A steer retains its send time even when it was taken hours later.
    const messageTime = begin === 0 && opener && hasTime(opener.ts) && !steer(opener) ? opener.ts : undefined;
    const lead = checkpoint ? checkpointStart(items, ids, from) : messageTime;
    const closeAt = checkpoint ? closer : record;
    const closingTime = closeAt && !steer(closeAt) && hasTime(closeAt.ts) ? closeAt.ts : undefined;
    let first = !duration && !(closer && (steer(closer) || cut(closer))) ? lead : undefined;
    let lastAct: number | undefined;
    let last = first;
    const intervalStart = intervals.length;
    const finish = (capAt = bound) => {
      if (first !== undefined && last !== undefined) intervals.push([first, Math.min(last, capAt, bound, coverage)]);
      first = last = undefined;
    };
    for (let i = begin; i < end; i++) {
      const it = items[ids[i]];
      if (!it) continue;
      if (duration && !timed && i > lastBoundary) break;
      if (steer(it)) {
        finish();
        continue;
      }
      if (!hasTime(it.ts)) continue;
      const at = actEnd(it);
      if (at !== null && Number.isFinite(at)) {
        lastAct = Math.max(lastAct ?? it.ts, at);
        if (it.ts < coverage) {
          first ??= it.ts;
          last = Math.max(last ?? first, at);
        }
      }
      if (cut(it)) finish(it.ts);
    }
    // A record cannot close before the work ended. Without a duration, allow a
    // minute for a late result before treating the unsupported gap as a clock step.
    if (timed && lastAct !== undefined && (record.ts < lastAct || closeAt === record && !duration && record.ts - lastAct > 60_000)) {
      intervals.length = intervalStart;
      const capAt = limit === record ? Infinity : bound;
      for (let i = begin; i < end; i++) {
        const it = items[ids[i]];
        const at = actEnd(it);
        if (it && hasTime(it.ts) && at !== null && Number.isFinite(at)) intervals.push([it.ts, Math.min(at, capAt)]);
      }
      return lastAct;
    }
    // A note closes its checkpoint. If it arrived inside a later record, the idle gap
    // before that record cannot extend the preceding run.
    if (first !== undefined && closingTime !== undefined && closingTime < coverage) last = closingTime;
    finish();
    if (!duration) return;
    if (timed) {
      if (checkpoint) {
        const endAt = closingTime ?? lastAct;
        if (lead !== undefined && endAt !== undefined) intervals.push([Math.max(coverage, lead), Math.min(record.ts, endAt)]);
      } else intervals.push([coverage, record.ts]);
    } else {
      // A taken card can keep an older timestamp than the Stop immediately before it.
      const anchor = boundary?.ts || lead || items[ids[begin]]?.ts;
      const start = Math.max(lastCutTime, hasTime(anchor) ? anchor : 0);
      if (start > 0) {
        intervals.push([start, start + duration]);
        lastCutTime = start + duration;
      } else undated += duration;
    }
  }

  for (let i = 0; i < ids.length; i++) {
    const it = items[ids[i]];
    if (!it) continue;
    if (it.type === 'turn') {
      const ended = measure(i, it) ?? it.ts;
      if (hasTime(ended)) lastCutTime = ended;
      begin = i + 1;
    } else if (cut(it) || steer(it)) {
      lastBoundary = i;
      if (cut(it) && hasTime(it.ts)) lastCutTime = it.ts;
    }
  }
  // A checkpoint can close on a note before the provider writes its record.
  const checkpoint = until !== undefined;
  const checkpointRecord = checkpoint && limit?.type === 'turn' ? limit : closer?.type === 'turn' ? closer : undefined;
  if (begin < ids.length || closer) measure(ids.length, checkpointRecord, checkpoint);
  if (!intervals.length && !undated) return null;
  intervals.sort((a, b) => a[0] - b[0]);
  let total = undated;
  let through = -Infinity;
  for (const [start, end] of intervals) {
    total += Math.max(0, end - Math.max(start, through));
    through = Math.max(through, end);
  }
  return total;
}
