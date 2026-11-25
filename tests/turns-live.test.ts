import { describe, expect, it, vi } from 'vitest';
import type { BridgeEvent, SessionMeta, TimelineItem, TurnLive, UserItem } from '../shared/protocol';
import { turnLive, TurnLiveIndex } from '../shared/turn-live';
import { groupTurns, runSpan, shapeOf, turnSpan } from '../src/features/timeline/turns';
import { changesOf } from '../src/features/timeline/changes';
import { SessionRuntime } from '../server/core/runtime';
import { Script } from '../server/providers/demo-script';
import { SCENARIOS } from '../server/providers/demo-scenarios';

vi.mock('@desk/features/timeline/lead-in', async () => await import('../src/features/timeline/lead-in'));
const MOBILE = '../mobile/src/lib/turns';
const phone = await import(/* @vite-ignore */ MOBILE) as { groupTurns: typeof groupTurns; shapeOf: typeof shapeOf; turnSpan: typeof turnSpan; runSpan: typeof runSpan };

function compareModels(roots: TimelineItem[], busy: boolean) {
  const ids = roots.map(i => i.id);
  // Both view stores publish fresh item objects. The bridge replay mutates its rows in place.
  const snapshot = roots.map(item => ({ ...item }));
  const desktop = groupTurns(ids, snapshot.map(shapeOf).join(''), busy);
  const mobile = phone.groupTurns(ids, snapshot.map(phone.shapeOf).join(''), busy);
  expect(mobile).toEqual(desktop);
  const items = Object.fromEntries(snapshot.map(i => [i.id, i]));
  desktop.groups.forEach((turn, index) => {
    const other = mobile.groups[index];
    if (turn.kind !== 'turn' || other.kind !== 'turn') return;
    expect(phone.turnSpan(items, other)).toBe(turnSpan(items, turn));
    for (const [si, seg] of turn.segments.entries()) {
      for (const [i, chunk] of seg.flow.entries()) {
        if (chunk.kind !== 'steps') continue;
        const next = seg.flow[i + 1];
        const from = i === 0 && seg.lead ? seg.lead : chunk.ids[0];
        const until = next ? (next.kind === 'steps' ? next.ids[0] : next.id)
          : turn.stops?.[si] ?? turn.segments[si + 1]?.lead ?? turn.end ?? turn.early ?? null;
        const cap = turn.end ?? (si === turn.segments.length - 1 ? turn.next : undefined);
        expect(phone.runSpan(items, chunk, from, until, cap)).toBe(runSpan(items, chunk, from, until, cap));
      }
    }
  });
  return desktop.groups;
}

function compare(items: TimelineItem[], indexed: TurnLive | undefined) {
  const roots = items.filter(i => !i.parentId);
  const groups = compareModels(roots, true);
  const turn = groups.findLast(g => g.kind === 'turn' && g.state === 'running');
  const reading = turnLive(items);
  expect(indexed).toEqual(reading);
  if (turn?.kind !== 'turn') {
    expect(reading).toBeUndefined();
    return;
  }
  const active = turn.segments[turn.liveSegment ?? turn.segments.length - 1];
  const tail = active.flow.at(-1);
  const all = turn.segments.flatMap(s => s.flow).filter(c => c.kind === 'steps');
  const byId = Object.fromEntries(items.map(i => [i.id, i]));
  const children: Record<string, string[]> = {};
  for (const i of items) if (i.parentId) (children[i.parentId] ??= []).push(i.id);
  expect(reading).toMatchObject({
    startedAt: roots.find(i => i.id === turn.key)!.ts,
    steps: turn.segments.reduce((n, s) => n + s.steps, 0),
    checkpoints: all.length - Number(tail?.kind === 'steps'),
    checkpointSteps: tail?.kind === 'steps' ? tail.count : 0,
    files: changesOf(byId, children, turn.segments.flatMap(s => s.work)).files,
  });
  if (tail) {
    const start = tail.kind === 'steps' ? tail.ids[0] : tail.id;
    // The live reading times a checkpoint as the chat does: from its first step, never from an opening
    // announcement above the run or from a text that has no words yet.
    expect(reading?.checkpointAt).toBe(byId[start].ts);
  }
}

describe('desktop, phone and live notification at every replay prefix', () => {
  it('attaches a trailing interrupt across an empty streaming text on both readers', () => {
    const rows: TimelineItem[] = [
      { id: 'u', type: 'user', ts: 1, text: 'Go' },
      { id: 'a', type: 'text', ts: 2, text: 'Done.', streaming: false },
      { id: 'r', type: 'turn', ts: 3, durationMs: 2 },
      { id: 'empty', type: 'text', ts: 4, text: '', streaming: true },
      { id: 'stop', type: 'notice', ts: 5, variant: 'interrupted', text: 'Interrupted' },
    ];
    for (const busy of [false, true]) {
      const groups = compareModels(rows, busy);
      expect(groups).toMatchObject([{ kind: 'turn', state: 'interrupted', end: 'r', ids: ['u', 'a', 'r', 'stop'] }]);
    }
  });

  it.each(['flagship', 'progress', 'agents', 'errors', 'chart', 'notifications', 'plan', 'questions', 'workflow', 'marathon'] as const)('records and replays Demo %s', async scenario => {
    const events: BridgeEvent[] = [];
    const rt = new SessionRuntime({ id: 's', provider: 'demo', cwd: '/demo', mode: 'bypassPermissions',
      usage: { inputTokens: 0, outputTokens: 0, turns: 0 } } as SessionMeta, e => {
      events.push(e);
      if (e.type === 'permission.added') queueMicrotask(() => rt.answerPermission(e.request.id, { optionId: e.request.options[0].id }));
      if (e.type === 'question.added') queueMicrotask(() => rt.answerQuestion(e.request.id, {}));
    }, () => {});
    const item = rt.add<UserItem>({ type: 'user', state: 'sent', text: scenario });
    const s = new Script({ rt, speed: 0, signal: new AbortController().signal, thinking: true,
      pricing: { input: 1, output: 1, cacheRead: 1, pace: 1 }, allowed: new Set() });
    await SCENARIOS[scenario]({ s, prompt: scenario, item, model: 'demo-large' });
    const replay = new SessionRuntime({ ...rt.meta }, () => {}, () => {});
    replay.beginTurn();
    for (const e of events) {
      if (e.type === 'item.added') replay.add(e.item);
      else if (e.type === 'item.patch') replay.patch(e.id, e.patch);
      else if (e.type === 'item.delta') replay.delta(e.id, e.field, e.delta);
      else continue;
      compare(replay.items, replay.meta.live);
    }
    replay.endTurn();
    compareModels(replay.items.filter(i => !i.parentId), false);
  }, 30_000);

  it('keeps the first reply above the work after a steer and ignores queued messages and checks', () => {
    const items: TimelineItem[] = [];
    const index = new TurnLiveIndex();
    for (const fields of [
      { type: 'user', text: 'go', state: 'sent' },
      { type: 'notice', variant: 'info', text: 'Starting' },
      { type: 'tool', kind: 'todo' },
      { type: 'tool', kind: 'share' },
      { type: 'tool', kind: 'read' },
      { type: 'user', state: 'queued', steered: true, text: 'more' },
      { type: 'user', state: 'sent', steered: true, text: 'taken' },
      { type: 'text', text: '', streaming: false },
      { type: 'tool', kind: 'agent', check: { turnId: '0' } },
      { type: 'thinking', text: 'h' },
      { type: 'user', state: 'sent', text: '<task-notification><summary>finished</summary></task-notification>' },
      { type: 'text', text: 'Let me check.' },
      { type: 'tool', kind: 'read' },
      { type: 'text', text: 'Done.' },
      { type: 'text', text: 'The issue was fixed.' },
      { type: 'notice', text: 'warning', variant: 'error', level: 'warning' },
    ]) {
      const item = { ...fields, id: String(items.length), ts: items.length } as TimelineItem;
      items.push(item);
      index.put(item);
      compare(items, turnLive(index));
    }
    // Replacing the shape of a past step can merge two already closed runs.
    for (const i of [3, 2, 8, 13, 1]) {
      const item = items[i] = { id: String(i), ts: i, type: 'text', text: 'Checking the logs.', streaming: false };
      index.put(item);
      compare(items, turnLive(index));
    }
  });
});
