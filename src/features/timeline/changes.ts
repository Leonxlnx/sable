import type { TimelineItem } from '@shared/protocol';
import { turnSpan, type TurnGroup } from './turns';

export interface Changes {
  files: number;
  add: number;
  del: number;
}

/** What a segment's edits changed, sub-agents' edits included: distinct files, lines added and removed. */
export function changesOf(items: Record<string, TimelineItem | undefined>, children: Record<string, string[] | undefined>, ids: readonly string[]): Changes {
  const files = new Set<string>();
  let add = 0;
  let del = 0;
  const walk = (list: readonly string[], depth: number) => {
    for (const id of list) {
      const it = items[id];
      if (it?.type !== 'tool') continue;
      if ((it.kind === 'edit' || it.kind === 'write') && it.status === 'done') {
        for (const d of it.result?.diff ?? []) {
          files.add(d.path);
          add += d.additions;
          del += d.deletions;
        }
      } else if (it.kind === 'agent' && depth < 4) walk(children[id] ?? [], depth + 1);
    }
  };
  walk(ids, 0);
  return { files: files.size, add, del };
}

/** The finished turn's Worked line, including edits nested under its agents. */
export function foldedTurn(items: Record<string, TimelineItem | undefined>, children: Record<string, string[] | undefined>, turn: TurnGroup) {
  const work = turn.segments.length === 1 ? turn.segments[0].work : turn.segments.flatMap(s => s.work);
  const steps = turn.segments.reduce((n, s) => n + s.steps, 0);
  return { span: turnSpan(items, turn), changes: changesOf(items, children, work), steps,
    thought: !steps && work.some(id => items[id]?.type === 'thinking') };
}
