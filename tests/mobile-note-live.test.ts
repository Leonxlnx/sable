/**
 * Phone 2.18 (night of 24/25 Nov): the live card of a chat at work (mobile/src/lib/note-live.ts;
 * KeepAliveService.java and LiveCards.java draw it).
 * - The running turn as the card reads it: steps, checkpoints closed (a run of work closed by
 *   something in view; a lead-in folds with its steps and closes nothing), the open checkpoint's steps
 *   and start, the files its settled edits changed, and what it does now. A page that has not seen the
 *   turn that runs (it ends with an older turn's end, or older pages are missing) gives nothing.
 * - What it does names the kind of step, never its content: no file name, command or search term.
 * - One card per chat at work with the other chats counted from its view; a chat that only serves a
 *   local address is at rest and gets none.
 * - The keys: Open always, Stop only while the chat's own turn runs; Allow once and Deny never ride on
 *   a live card. Stop from the card stops only a chat whose turn still runs, on a live connection.
 * - The result the notification turns into when the turn ends: "Finished · 3 files changed".
 */
import { describe, expect, it } from 'vitest';
import type { SessionMeta, TimelineItem } from '@shared/protocol';
import { activityLine, cardKeys, checkpointLine, doingLine, liveCard, noteStop, othersLine, resultLine, turnLive, SEGMENTS_MAX } from '../mobile/src/lib/note-live';
import { liveOf, livePayload } from '../mobile/src/lib/notes';

let clock = 0;
const at = () => (clock += 1000);
const user = (id: string, extra: object = {}) => ({ id, type: 'user', text: 'Fix the session store', ts: at(), ...extra }) as unknown as TimelineItem;
const note = (id: string, t: string, extra: object = {}) => ({ id, type: 'text', text: t, streaming: false, ts: at(), ...extra }) as unknown as TimelineItem;
const think = (id: string, streaming = false) => ({ id, type: 'thinking', text: 'hm', streaming, ts: at() }) as unknown as TimelineItem;
const tool = (id: string, kind: string, extra: object = {}) =>
  ({ id, type: 'tool', name: kind, kind, title: `${kind} secret-file.ts`, status: 'done', detail: {}, ts: at(), ...extra }) as unknown as TimelineItem;
const edit = (id: string, path: string, extra: object = {}) =>
  tool(id, 'edit', { detail: { path }, result: { diff: [{ path, additions: 3, deletions: 1 }] }, ...extra });
const end = (id: string) => ({ id, type: 'turn', ts: at() }) as unknown as TimelineItem;

const page = (list: TimelineItem[], cursor?: string) => ({
  roots: list.map((it) => it.id),
  items: Object.fromEntries(list.map((it) => [it.id, it])),
  ...(cursor ? { cursor } : {}),
});

const meta = (id: string, over: Partial<SessionMeta> = {}) => ({ id, title: `Chat ${id}`, status: 'idle', provider: 'claude', ...over }) as unknown as SessionMeta;
const settings = { conn: 'open', fresh: true, listAt: 10, notify: true };

describe('the running turn as the live card reads it', () => {
  it('counts steps, checkpoints closed by a note, the open run, the files changed and what it does now', () => {
    const head = user('u');
    const list = [head, tool('r1', 'read'), tool('r2', 'read'), edit('e1', 'a.ts'), note('n1', 'The guard answers 403 for every account, so the limiter is keyed wrongly.'), edit('e2', 'b.ts', { status: 'running', result: undefined })];
    const t = turnLive(page(list))!;
    expect(t).toMatchObject({ steps: 4, done: 1, cpSteps: 1, files: 1, startedAt: head.ts, at: list[5].ts });
    expect(t.doing).toEqual({ kind: 'edit', files: 1 });
    expect(doingLine(t.doing)).toBe('Editing 1 file');
  });

  it('folds a lead-in with the steps it announces: it closes no checkpoint', () => {
    const t = turnLive(page([user('u'), note('l', 'Let me read the handler.'), tool('r', 'read'), note('l2', 'Now the tests.'), tool('b', 'bash', { status: 'running' })]))!;
    expect(t.done).toBe(0);
    expect(t.cpSteps).toBe(2);
    expect(doingLine(t.doing)).toBe('Running a command');
  });

  it('counts the distinct files of the open checkpoint, and the newest turn only', () => {
    const list = [user('old'), edit('x', 'old.ts'), end('t1'), user('u'), edit('a', 'a.ts'), edit('b', 'b.ts'), edit('c', 'a.ts', { status: 'running', result: undefined })];
    const t = turnLive(page(list))!;
    expect(t.steps).toBe(3);
    expect(t.files).toBe(2);
    expect(t.doing).toEqual({ kind: 'edit', files: 2 });
  });

  it('says writing and thinking while they stream, and working between steps', () => {
    expect(turnLive(page([user('u'), tool('r', 'read'), note('t', 'The answer', { streaming: true })]))!.doing).toEqual({ kind: 'writing' });
    expect(turnLive(page([user('u'), think('h', true)]))!.doing).toEqual({ kind: 'thinking' });
    expect(turnLive(page([user('u'), tool('r', 'read')]))!.doing).toEqual({ kind: 'working' });
  });

  it('gives nothing for a page that has not seen the running turn', () => {
    // It ends with an older turn's end (a chat the socket no longer follows).
    expect(turnLive(page([user('u'), tool('a', 'read'), end('t')]))).toBeUndefined();
    // Older pages are missing and no message began the turn in this one.
    expect(turnLive(page([tool('a', 'read'), tool('b', 'read')], 'older'))).toBeUndefined();
    // A turn the agent began by itself after the last end is read from there.
    expect(turnLive(page([user('u'), end('t'), tool('a', 'read', { status: 'running' })]))).toMatchObject({ steps: 1, done: 0 });
  });

  it('leaves queued messages out of the work', () => {
    const t = turnLive(page([user('u'), tool('a', 'read', { status: 'running' }), user('q', { state: 'queued' })]))!;
    expect(t.doing).toEqual({ kind: 'read', files: 1 });
  });
});

describe('what the card says it does: the kind of step, never its content', () => {
  it('reads the activity line by its first verb only', () => {
    const cases: [string | undefined, string][] = [
      ['Edit server/app.ts', 'Editing'],
      ['Write secret-plan.md', 'Editing'],
      ['Read .env', 'Reading'],
      ['Run rm -rf build && npm test', 'Running a command'],
      ['Running the test suite', 'Running a command'],
      ['Search for “password”', 'Searching the code'],
      ['Find **/*.key', 'Searching the code'],
      ['Search the web for “my bank”', 'Reading the web'],
      ['Fetch internal.example.com/admin', 'Reading the web'],
      ['Thinking', 'Thinking'],
      ['Writing', 'Writing'],
      ['Waiting for your approval', 'Waiting for you'],
      ['Compacting the conversation', 'Compacting'],
      ['Frobnicate the widgets', 'Working'],
      [undefined, 'Working'],
    ];
    for (const [activity, line] of cases) expect(activityLine(activity)).toBe(line);
    expect(activityLine(undefined, 'Starting')).toBe('Starting');
  });

  it('names files by count, never by name', () => {
    expect(doingLine({ kind: 'edit', files: 3 })).toBe('Editing 3 files');
    expect(doingLine({ kind: 'read', files: 1 })).toBe('Reading 1 file');
    expect(doingLine({ kind: 'agents', count: 2 })).toBe('Running 2 sub-agents');
    const t = turnLive(page([user('u'), tool('s', 'search', { status: 'running', detail: { pattern: 'password' } })]))!;
    expect(doingLine(t.doing)).toBe('Searching the code');
  });

  it('the live set says the kind of step from the conversation, else from the activity line', () => {
    const live = liveOf([meta('a', { status: 'running', activity: 'Edit secret.ts' }), meta('b', { status: 'running', activity: 'Run npm test' })], [], 5, (id) =>
      id === 'a' ? turnLive(page([user('u'), edit('e', 'secret.ts', { status: 'running', result: undefined })])) : undefined,
    );
    expect(live.chats.map((c) => c.line)).toEqual(['Editing 1 file', 'Running a command']);
    expect(JSON.stringify(livePayload(settings, live))).not.toMatch(/secret|npm/);
  });
});

describe('one card per chat at work', () => {
  it('carries the name, agent, line, clock, checkpoint, segments, files, keys and result', () => {
    const turn = turnLive(page([user('u'), edit('a', 'a.ts'), edit('b', 'b.ts'), note('n', 'Both stores now share one clock and the tests pass.'), tool('r', 'read', { status: 'running' })]))!;
    const live = liveOf([meta('a', { status: 'running', title: 'Sable v1' })], [], 100, () => turn);
    const p = livePayload(settings, live)!;
    expect(p.cards).toHaveLength(1);
    expect(p.cards![0]).toEqual({
      id: 'a',
      title: 'Sable v1',
      agent: 'claude',
      line: 'Reading 1 file',
      since: 100,
      at: turn.at,
      meta: 'Checkpoint 2 · 1 step',
      steps: 3,
      done: 1,
      files: 2,
      others: '',
      keys: ['open', 'stop'],
      result: { done: 'Finished · 2 files changed', failed: 'Stopped · 2 files changed' },
    });
  });

  it('counts the other chats from each card, and gives a chat with only background work Open alone', () => {
    const list = [meta('a', { status: 'running' }), meta('b', { status: 'idle', background: 2 }), meta('c', { status: 'starting' }), meta('d', { status: 'awaiting' })];
    const p = livePayload(settings, liveOf(list, [], 1))!;
    expect(p.cards!.map((c) => [c.id, c.others, c.keys])).toEqual([
      ['a', '2 other chats working · 1 waiting', ['open', 'stop']],
      ['b', '2 other chats working · 1 waiting', ['open']],
      ['c', '2 other chats working · 1 waiting', ['open', 'stop']],
    ]);
    expect(p.cards![1].line).toBe('2 sub-agents working');
  });

  it('keeps the last reading through the moment the turn has ended but the chat is not idle yet', () => {
    const list = [user('u'), edit('a', 'a.ts'), edit('b', 'b.ts'), edit('c', 'c.ts', { status: 'running', result: undefined })];
    const first = liveOf([meta('a', { status: 'running' })], [], 1, () => turnLive(page(list)));
    expect(first.chats[0].turn?.files).toBe(2);
    // The last edit settles, then the turn's end lands while the chat still says it runs.
    const settled = [...list.slice(0, 3), edit('c', 'c.ts'), end('t')];
    const after = liveOf([meta('a', { status: 'running' })], first.chats, 2, () => turnLive(page(settled)));
    expect(turnLive(page(settled))).toBeUndefined();
    expect(livePayload(settings, after)!.cards![0].result.done).toBe('Finished · 2 files changed');
    // A chat that left the live set starts its next turn with no reading of the last one.
    const next = liveOf([meta('a', { status: 'running' })], [], 3, () => undefined);
    expect(next.chats[0].turn).toBeUndefined();
  });

  it('puts up no card for a chat that only serves a local address', () => {
    expect(livePayload(settings, liveOf([meta('a', { serving: 1, servingAddress: 'http://localhost:5173' })], [], 1))).toBeNull();
    const both = livePayload(settings, liveOf([meta('a', { serving: 1, commands: 1 }), meta('b', { status: 'running' })], [], 1))!;
    expect(both.cards!.map((c) => [c.id, c.line])).toEqual([['a', '1 command running'], ['b', 'Working']]);
  });

  it('never carries Allow once or Deny, and caps its segments', () => {
    for (const status of ['running', 'starting', 'idle', 'awaiting', 'error'] as const) {
      for (const key of cardKeys({ status })) expect(['open', 'stop']).toContain(key);
    }
    expect(cardKeys({ status: 'awaiting' })).toEqual(['open']);
    expect(liveCard({ id: 'a', title: 'A', line: 'Working', since: 1, turn: { steps: 90, done: 40, cpSteps: 2, files: 0, doing: { kind: 'working' } } }, undefined, 1, 0).done).toBe(SEGMENTS_MAX);
  });
});

describe('the small rules', () => {
  it('says the rest of the live set from one card', () => {
    expect(othersLine(0, 0)).toBe('');
    expect(othersLine(1, 0)).toBe('1 other chat working');
    expect(othersLine(2, 0)).toBe('2 other chats working');
    expect(othersLine(0, 1)).toBe('1 chat waiting for you');
    expect(othersLine(0, 2)).toBe('2 chats waiting for you');
    expect(othersLine(1, 2)).toBe('1 other chat working · 2 waiting');
  });

  it('says the checkpoint once one has closed, the steps before', () => {
    expect(checkpointLine(undefined)).toBe('');
    expect(checkpointLine({ done: 0, cpSteps: 0, steps: 0 })).toBe('');
    expect(checkpointLine({ done: 0, cpSteps: 4, steps: 4 })).toBe('4 steps');
    expect(checkpointLine({ done: 2, cpSteps: 1, steps: 9 })).toBe('Checkpoint 3 · 1 step');
    expect(checkpointLine({ done: 2, cpSteps: 0, steps: 9 })).toBe('Checkpoint 3');
  });

  it('turns into the result: finished or stopped, with the files changed', () => {
    expect(resultLine('done', 3)).toBe('Finished · 3 files changed');
    expect(resultLine('done', 1)).toBe('Finished · 1 file changed');
    expect(resultLine('done', 0)).toBe('Finished');
    expect(resultLine('failed', 0)).toBe('Stopped');
  });

  it('stops from the card only a chat whose own turn runs, on a live connection', () => {
    const sessions = { a: { status: 'running' as const }, b: { status: 'idle' as const }, c: { status: 'awaiting' as const } };
    expect(noteStop('a', sessions, true)).toEqual({ sessionId: 'a' });
    expect(noteStop('a', sessions, false)).toBeNull();
    expect(noteStop('b', sessions, true)).toBeNull();
    expect(noteStop('c', sessions, true)).toBeNull();
    expect(noteStop('zz', sessions, true)).toBeNull();
    expect(noteStop(42, sessions, true)).toBeNull();
  });
});
