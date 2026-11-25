import { describe, expect, it } from 'vitest';
import type { BridgeEvent, SessionMeta, TimelineItem, TurnLive, UserItem } from '../shared/protocol';
import { turnLive, TurnLiveIndex } from '../shared/turn-live';
import { groupTurns, shapeOf } from '../src/features/timeline/turns';
import { changesOf } from '../src/features/timeline/changes';
import { SessionRuntime } from '../server/core/runtime';
import { Script } from '../server/providers/demo-script';
import { SCENARIOS } from '../server/providers/demo-scenarios';

function compare(items: TimelineItem[], indexed: TurnLive | undefined) {
  const roots = items.filter(i => !i.parentId);
  const groups = groupTurns(roots.map(i => i.id), roots.map(shapeOf).join(''), true).groups;
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
  if (tail) expect(reading?.checkpointAt).toBe(byId[tail.kind === 'steps' ? tail.ids[0] : tail.id].ts);
}

describe('the bridge reads the running desktop turn at every prefix', () => {
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
