import { describe, expect, it } from 'vitest';
import type { SessionMeta, TimelineItem } from '../shared/protocol';
import { turnLive, TurnLiveIndex } from '../shared/turn-live';
import { chatMarkdown } from '../server/core/chat-markdown';
import { SessionRuntime } from '../server/core/runtime';
import { checkpointLine, doingLine, turnLive as phoneLive } from '../mobile/src/lib/note-live';

let serial = 0;
const row = (type: TimelineItem['type'], seconds: number, fields: object) =>
  ({ id: String(++serial), type, ts: Math.round(seconds * 1000), ...fields }) as TimelineItem;
const user = (s: number, steered = false) => row('user', s, { state: 'sent', steered, text: 'Go' });
const read = (s: number, end = s, extra: object = {}) => row('tool', s, {
  kind: 'read', name: 'Read', title: 'Read private file', detail: { path: 'private.ts' }, status: 'done', endedAt: end * 1000, ...extra,
});
const thought = (s: number, end: number) => row('thinking', s, { text: 'Private thought', endedAt: end * 1000 });
const stop = (s: number) => row('notice', s, { variant: 'interrupted', text: 'Stopped' });
const words = (s: number, text: string, streaming = false) => row('text', s, { text, streaming });
const record = (s: number, durationMs: number) => row('turn', s, { durationMs });
const owner = () => [
  user(14), thought(18, 21), read(21, 24), read(24, 26), thought(26, 28), thought(28, 30),
  read(30, 117), read(33, 46), thought(118, 124), read(124, 135), read(135, 150),
  thought(151, 170), thought(172, 220), read(223, 239),
  read(227.9, 1813, { kind: 'agent', status: 'error' }),
  row('notice', 1813, { variant: 'info', text: 'Stopped agent' }), stop(1813), user(1814, true),
  thought(1814, 1822), words(1823, 'I hear you.'), record(1823, 9976),
];
const meta = { title: 'Timing', provider: 'demo' as const, cwd: '', createdAt: 1000 };
const markdown = (rows: TimelineItem[]) => chatMarkdown(meta, rows).split('\n').filter(l => l.startsWith('**Steps**'));

it('exports the eight steps and every worked stretch of the owner’s turn', () => {
  expect(markdown([...owner(), user(2500), read(2501), record(2504, 4000)]))
    .toEqual(['**Steps** (8, 30 min 5 s)', '**Steps** (1, 4 s)']);
});

it('caps unrecorded work at the following turn and keeps a covering record whole across a normal take', () => {
  expect(markdown([user(1), read(2, 600), user(5), read(6, 7), user(8, true), read(9), record(10, 5000)]))
    .toEqual(['**Steps** (1, 4 s)', '**Steps** (2, 5 s)']);
});

it('starts an unrecorded wake at the notification that actually led to work', () => {
  const wake = (s: number) => row('user', s, { text: '<task-notification><summary>Build finished</summary></task-notification>' });
  expect(markdown([wake(1), wake(3600), read(3601, 3605)])).toEqual(['**Steps** (1, 5 s)']);
});

function card(rows: TimelineItem[]) {
  const r = phoneLive({ roots: rows.map(i => i.id), items: Object.fromEntries(rows.map(i => [i.id, i])) });
  return r && { steps: r.steps, done: r.done, count: r.cpSteps, at: r.at, started: r.startedAt };
}
function bridge(rows: TimelineItem[]) {
  const r = turnLive(rows);
  return r && { steps: r.steps, done: r.checkpoints, count: r.checkpointSteps, at: r.checkpointAt, started: r.startedAt };
}
for (const [name, live] of Object.entries({ bridge, card })) {
  describe(name, () => {
    it('starts work after the opening reply, including an opening lead-in', () => {
      for (const text of ['I found the source.', 'Let me read the handler.']) {
        const rows = [user(1), words(2, text), read(10)];
        expect(live(rows)).toEqual({ steps: 1, done: 0, count: 1, at: 10_000, started: 1000 });
      }
    });

    it('leaves an empty streaming text out of the checkpoint clock', () => {
      expect(live([user(1), words(2, '  ', true)])?.at).toBeUndefined();
      expect(live([user(1), words(2, '  ', true), words(3, 'Let me read it.'), read(4)])?.at).toBe(4000);
    });

    it('closes the stopped checkpoint on take and waits for the first resumed act', () => {
      const rows = [user(1), read(2, 50), stop(50), user(3, true)];
      expect(live(rows)).toEqual({ steps: 1, done: 1, count: 0, at: undefined, started: 1000 });
      expect(live([...rows, words(54, '', true), read(60)]))
        .toEqual({ steps: 2, done: 1, count: 1, at: 60_000, started: 1000 });
    });

    it('keeps an open checkpoint through a normal take until new work arrives', () => {
      const rows = [user(1), read(2), user(3, true)];
      expect(live(rows)).toEqual({ steps: 1, done: 0, count: 1, at: 2000, started: 1000 });
      expect(live([...rows, read(60)])).toEqual({ steps: 2, done: 1, count: 1, at: 60_000, started: 1000 });
    });

    it('folds an announcement after work or a command without promoting it to an opening reply', () => {
      const command = row('user', 1, { text: '<command-name>/compact</command-name>' });
      expect(live([command, words(2, 'Let me check.'), read(10)])?.at).toBe(2000);
      expect(live([user(1), read(2), words(3, 'Let me check.'), read(10)])?.at).toBe(2000);
    });

    it('keeps a lead-in cut off by Stop from becoming an extra checkpoint', () => {
      const rows = [user(1), words(2, 'I see the issue.'), words(3, 'Let me check.'), stop(4), user(2, true)];
      expect(live(rows)).toEqual({ steps: 0, done: 0, count: 0, at: undefined, started: 1000 });
    });

    it('publishes the owner’s eight steps through the resumed reply and clears at its record', () => {
      const rows = owner();
      expect(live(rows.slice(0, -3))).toEqual({ steps: 8, done: 1, count: 0, at: undefined, started: 14_000 });
      expect(live(rows.slice(0, -1))).toEqual({ steps: 8, done: 1, count: 0, at: 1_814_000, started: 14_000 });
      expect(live(rows)).toBeUndefined();
    });
  });
}

it('updates the published clock when a waiting steer is patched in place after Stop', () => {
  const queued = { ...user(2, true), state: 'queued' } as TimelineItem;
  const index = new TurnLiveIndex();
  for (const i of [user(1), read(3), stop(8), queued]) index.put(i);
  expect(index.read()).toBeUndefined();
  index.put({ ...queued, state: 'sent' } as TimelineItem);
  expect(index.read()).toMatchObject({ steps: 1, checkpoints: 1, checkpointSteps: 0 });
  expect(index.read()?.checkpointAt).toBeUndefined();
  index.put(read(60, 60, { status: 'running' }));
  expect(index.read()?.checkpointAt).toBe(60_000);
});

it('names the resumed checkpoint and the kind of step on the phone card', () => {
  const rows = [...owner().slice(0, -3), read(1825, 1825, { status: 'running' })];
  const r = phoneLive({ roots: rows.map(i => i.id), items: Object.fromEntries(rows.map(i => [i.id, i])) })!;
  expect(checkpointLine(r)).toBe('Checkpoint 2 · 1 step');
  expect(doingLine(r.doing)).toBe('Reading 1 file');
  expect(JSON.stringify(r)).not.toContain('private');
});

it('publishes Checkpoint 2 on SessionMeta.live when a queued card moves past Stop', () => {
  const rt = new SessionRuntime({ id: 'demo', status: 'idle' } as SessionMeta, () => {}, () => {});
  rt.add(user(1));
  rt.beginTurn();
  try {
    const steer = rt.add({ ...user(2, true), state: 'queued' } as TimelineItem);
    rt.add(read(3, 50));
    rt.add(stop(50));
    expect(rt.meta.live).toBeUndefined();
    rt.taken(steer.id);
    expect(rt.meta.live).toMatchObject({ steps: 1, checkpoints: 1, checkpointSteps: 0, startedAt: 1000 });
    expect(rt.meta.live?.checkpointAt).toBeUndefined();
    rt.add(read(60, 60, { status: 'running' }));
    expect(rt.meta.live).toMatchObject({ steps: 2, checkpoints: 1, checkpointSteps: 1, checkpointAt: 60_000, doing: 'read' });
  } finally {
    rt.endTurn();
  }
});
