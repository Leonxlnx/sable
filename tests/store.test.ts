/**
 * The UI store applying a realistic stream of bridge events. The store batches deltas
 * per animation frame and touches localStorage / document, so minimal shims come first.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BridgeEvent, PermissionRequest, QuestionRequest, SessionMeta, TextItem, TimelineItem, ToolItem, UserItem } from '@shared/protocol';

const frames: FrameRequestCallback[] = [];
const g = globalThis as Record<string, unknown>;
g.requestAnimationFrame = (cb: FrameRequestCallback) => frames.push(cb);
g.cancelAnimationFrame = () => {};
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.document = { hidden: false };
g.window = globalThis;

type StoreModule = typeof import('../src/state/store');
let S: StoreModule;

beforeAll(async () => {
  S = await import('../src/state/store');
});

/** Runs the pending animation frames, as the browser would before the next paint. */
function frame() {
  for (const cb of frames.splice(0)) cb(performance.now());
}

const SID = 'sess-1';
const meta = (patch: Partial<SessionMeta> = {}): SessionMeta => ({
  id: SID,
  provider: 'demo',
  cwd: '/work/relay-api',
  title: 'New session',
  titleSource: 'auto',
  model: 'demo-large',
  mode: 'default',
  status: 'starting',
  createdAt: 1,
  updatedAt: 1,
  usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
  ...patch,
});

const feed = (...events: BridgeEvent[]) => events.forEach((e) => S.applyEvent(e));
const data = () => S.useStore.getState().data[SID]!;
const item = <T extends TimelineItem>(id: string) => data().items[id] as T;

const user: UserItem = { id: 'u1', ts: 2, type: 'user', text: 'refactor the session module', state: 'sent' };
const text: TextItem = { id: 't1', ts: 3, type: 'text', text: '', streaming: true };
const agent: ToolItem = { id: 'a1', ts: 4, type: 'tool', name: 'Agent', kind: 'agent', title: 'Run a subagent', status: 'running', detail: {} };
const subRead: ToolItem = { id: 's1', ts: 5, type: 'tool', name: 'Read', kind: 'read', title: 'Read session.ts', status: 'running', detail: {}, parentId: 'a1' };
const subBash: ToolItem = { id: 's2', ts: 6, type: 'tool', name: 'Bash', kind: 'bash', title: 'Run tests', status: 'running', detail: {}, parentId: 'a1' };

const permission: PermissionRequest = {
  id: 'p1',
  sessionId: SID,
  itemId: 's2',
  toolName: 'Bash',
  kind: 'bash',
  title: 'Run tests',
  detail: { command: 'npm test' },
  options: [
    { id: 'allow', label: 'Allow once', tone: 'allow' },
    { id: 'deny', label: 'Deny', tone: 'deny' },
  ],
  createdAt: 7,
};
const question: QuestionRequest = { id: 'q1', sessionId: SID, questions: [{ question: 'Which logger?', options: [{ label: 'pino' }] }], createdAt: 8 };

beforeEach(() => {
  frames.length = 0;
  S.useStore.setState({ sessions: {}, data: {}, ui: { ...S.useStore.getState().ui, activeSessionId: SID } });
});

describe('store event application', () => {
  it('builds a session from added items and coalesces deltas into one write per frame', () => {
    feed({ type: 'session.added', session: meta() });
    expect(data()).toMatchObject({ loaded: true, roots: [], permissions: [], questions: [], todos: [] });

    feed(
      { type: 'session.updated', id: SID, patch: { status: 'running', title: 'refactor the session module' } },
      { type: 'item.added', sessionId: SID, item: user },
      { type: 'item.added', sessionId: SID, item: text },
    );
    expect(S.useStore.getState().sessions[SID]).toMatchObject({ status: 'running', title: 'refactor the session module' });

    let writes = 0;
    const unsub = S.useStore.subscribe(() => writes++);
    const words = "I'll start by finding everywhere session expiry is decided today.".split(/(?<= )/);
    for (const w of words) feed({ type: 'item.delta', sessionId: SID, id: 't1', field: 'text', delta: w });
    // Nothing lands until the frame runs.
    expect(item<TextItem>('t1').text).toBe('');
    expect(writes).toBe(0);
    frame();
    unsub();
    expect(writes).toBe(1);
    expect(item<TextItem>('t1').text).toBe(words.join(''));
    expect(data().roots).toEqual(['u1', 't1']);
  });

  it('nests sub-agent items under their parent and streams inputText and output', () => {
    feed({ type: 'session.added', session: meta({ status: 'running' }) }, { type: 'item.added', sessionId: SID, item: user }, { type: 'item.added', sessionId: SID, item: agent });
    feed({ type: 'item.added', sessionId: SID, item: subRead }, { type: 'item.added', sessionId: SID, item: subBash });
    expect(data().roots).toEqual(['u1', 'a1']);
    expect(data().children).toEqual({ a1: ['s1', 's2'] });

    feed(
      { type: 'item.delta', sessionId: SID, id: 's2', field: 'inputText', delta: '{"command":' },
      { type: 'item.delta', sessionId: SID, id: 's2', field: 'inputText', delta: '"npm test"}' },
      { type: 'item.delta', sessionId: SID, id: 's2', field: 'output', delta: '> vitest run\n' },
      { type: 'item.delta', sessionId: SID, id: 's2', field: 'output', delta: ' ✓ 12 tests\n' },
    );
    // A patch flushes pending deltas first, so it applies on top of them.
    feed({ type: 'item.patch', sessionId: SID, id: 's2', patch: { status: 'done', result: { exitCode: 0 } } as Partial<TimelineItem> });
    const bash = item<ToolItem>('s2');
    expect(bash.inputText).toBe('{"command":"npm test"}');
    expect(bash.output).toBe('> vitest run\n ✓ 12 tests\n');
    expect(bash.status).toBe('done');
    expect(bash.result).toEqual({ exitCode: 0 });

    // The scheduled frame finds nothing left to write.
    frame();
    expect(item<ToolItem>('s2').output).toBe('> vitest run\n ✓ 12 tests\n');
  });

  it('a delta for an item that is not there is ignored, and re-adding an item replaces it in place', () => {
    feed({ type: 'session.added', session: meta() }, { type: 'item.added', sessionId: SID, item: text });
    feed({ type: 'item.delta', sessionId: SID, id: 'missing', field: 'text', delta: 'x' });
    feed({ type: 'item.delta', sessionId: SID, id: 't1', field: 'text', delta: 'Hello' });
    feed({ type: 'item.added', sessionId: SID, item: { ...text, text: 'Hello world', streaming: false } });
    frame();
    expect(data().roots).toEqual(['t1']);
    expect(item<TextItem>('t1')).toMatchObject({ text: 'Hello world', streaming: false });
    expect(data().items.missing).toBeUndefined();
  });

  it('removes root and child items from their lists', () => {
    feed({ type: 'session.added', session: meta() }, ...[user, agent, subRead, subBash, text].map((i): BridgeEvent => ({ type: 'item.added', sessionId: SID, item: i })));
    feed({ type: 'item.removed', sessionId: SID, id: 's1' }, { type: 'item.removed', sessionId: SID, id: 't1' }, { type: 'item.removed', sessionId: SID, id: 'nope' });
    expect(data().roots).toEqual(['u1', 'a1']);
    expect(data().children.a1).toEqual(['s2']);
    expect(data().items.s1).toBeUndefined();
    expect(data().items.t1).toBeUndefined();
  });

  it('removing a parent removes its descendants too', () => {
    const nested: ToolItem = { ...subRead, id: 'n1', parentId: 's2' };
    feed({ type: 'session.added', session: meta() }, ...[user, agent, subRead, subBash, nested, text].map((i): BridgeEvent => ({ type: 'item.added', sessionId: SID, item: i })));
    feed({ type: 'item.removed', sessionId: SID, id: 'a1' });
    expect(data().roots).toEqual(['u1', 't1']);
    expect(Object.keys(data().items).sort()).toEqual(['t1', 'u1']);
    expect(data().children).toEqual({});
  });

  it('timeline.reset replaces the timeline and drops deltas already buffered', () => {
    feed({ type: 'session.added', session: meta() }, { type: 'item.added', sessionId: SID, item: user }, { type: 'item.added', sessionId: SID, item: text });
    feed({ type: 'item.delta', sessionId: SID, id: 't1', field: 'text', delta: 'stale' });
    const rewound: TimelineItem[] = [
      { ...user, id: 'u0', text: 'earlier' },
      { ...text, id: 't0', text: 'Answer', streaming: false },
      { ...subRead, id: 'c0', parentId: 'x0' },
    ];
    feed({ type: 'timeline.reset', sessionId: SID, items: rewound });
    frame();
    expect(data().roots).toEqual(['u0', 't0']);
    expect(data().children).toEqual({ x0: ['c0'] });
    expect(item<TextItem>('t0').text).toBe('Answer');
    expect(data().items.t1).toBeUndefined();
  });

  it('tracks prompts, todos and suggestions', () => {
    feed({ type: 'session.added', session: meta({ status: 'running' }) });
    feed({ type: 'permission.added', request: permission }, { type: 'question.added', request: question });
    // The same request id again replaces rather than duplicates.
    feed({ type: 'permission.added', request: { ...permission, title: 'Run the tests' } });
    feed({ type: 'session.updated', id: SID, patch: { status: 'awaiting' } });
    expect(data().permissions.map((p) => [p.id, p.title])).toEqual([['p1', 'Run the tests']]);
    expect(data().questions.map((q) => q.id)).toEqual(['q1']);
    expect(S.useStore.getState().sessions[SID].status).toBe('awaiting');

    feed({ type: 'permission.removed', sessionId: SID, id: 'p1' }, { type: 'question.removed', sessionId: SID, id: 'q1' });
    feed({ type: 'session.updated', id: SID, patch: { status: 'running' } });
    expect(data().permissions).toEqual([]);
    expect(data().questions).toEqual([]);

    feed({
      type: 'todos.updated',
      sessionId: SID,
      todos: [
        { content: 'Find expiry checks', status: 'completed' },
        { content: 'Run the test suite', activeForm: 'Running the test suite', status: 'in_progress' },
      ],
    });
    expect(data().todos.map((t) => t.status)).toEqual(['completed', 'in_progress']);

    feed({ type: 'suggestion', sessionId: SID, text: 'Now add a test' });
    expect(data().suggestion).toBe('Now add a test');
    feed({ type: 'suggestion', sessionId: SID, text: '' });
    expect(data().suggestion).toBeUndefined();
  });

  it('events for unknown sessions are ignored and session.removed clears everything', () => {
    feed({ type: 'item.added', sessionId: 'ghost', item: user }, { type: 'session.updated', id: 'ghost', patch: { title: 'x' } });
    expect(S.useStore.getState().data.ghost).toBeUndefined();
    expect(S.useStore.getState().sessions.ghost).toBeUndefined();

    feed({ type: 'session.added', session: meta() }, { type: 'item.added', sessionId: SID, item: user });
    // A second session.added keeps the loaded data.
    feed({ type: 'session.added', session: meta({ title: 'Renamed' }) });
    expect(data().roots).toEqual(['u1']);
    expect(S.useStore.getState().sessions[SID].title).toBe('Renamed');

    feed({ type: 'item.delta', sessionId: SID, id: 'u1', field: 'text', delta: '!' });
    feed({ type: 'session.removed', id: SID });
    frame();
    const st = S.useStore.getState();
    expect(st.sessions[SID]).toBeUndefined();
    expect(st.data[SID]).toBeUndefined();
    expect(st.ui.activeSessionId).toBeNull();
  });

  it('applySnapshot indexes items and keeps known caps', () => {
    feed({ type: 'session.added', session: meta() });
    const caps = { models: [], modes: [], commands: [], features: {} } as never;
    feed({ type: 'session.caps', id: SID, caps });
    S.applySnapshot({ session: meta({ status: 'idle' }), items: [user, agent, subRead], permissions: [permission], questions: [], todos: [], suggestion: 'Next', queue: [{ id: 'q1', text: 'later', createdAt: 1 }] });
    expect(data()).toMatchObject({ loaded: true, roots: ['u1', 'a1'], children: { a1: ['s1'] }, suggestion: 'Next', queue: [{ id: 'q1', text: 'later' }] });
    feed({ type: 'queue.updated', sessionId: SID, queue: [] });
    expect(data().queue).toEqual([]);
    expect(data().permissions).toHaveLength(1);
    expect(data().caps).toBe(caps);
  });

  it('hydrates thinking and message rows and discards an answer for a superseded row', () => {
    const message: UserItem = { ...user, more: true, attachments: [{ id: 'p', kind: 'image', name: 'p.png', dataUrl: '' }] };
    const thought = { type: 'thinking' as const, id: 'thought', ts: 2, streaming: false, text: 'start', more: true };
    S.applySnapshot({ session: meta(), items: [message, thought], permissions: [], questions: [], todos: [], queue: [] });
    const whole = { ...user, attachments: [{ id: 'p', kind: 'image' as const, name: 'p.png', dataUrl: 'data:image/png;base64,AAA' }] };
    const asked = data().items[thought.id];
    S.applyWholeItem(SID, whole, data().items[user.id]);
    expect(data().items[user.id]).toEqual(whole);
    feed({ type: 'item.patch', sessionId: SID, id: thought.id, patch: { endedAt: 12 } });
    const full = { ...thought, text: 'start and finish', endedAt: 12, more: undefined };
    S.applyWholeItem(SID, full, asked);
    expect(data().items[thought.id]).toHaveProperty('more', true);
    S.applyWholeItem(SID, full, data().items[thought.id]);
    expect(data().items[thought.id]).toEqual(full);
  });

  it('puts a step fetched whole in place of the cut one, touching nothing else; live deltas still apply', () => {
    const cut: ToolItem = { ...subBash, id: 'b1', parentId: undefined, status: 'done', output: 'start\n…\nend', more: true };
    const live: ToolItem = { ...subBash, id: 'b2', parentId: undefined, status: 'running', output: 'building\n' };
    S.applySnapshot({ session: meta({ status: 'running' }), items: [user, cut, live], permissions: [], questions: [], todos: [], queue: [] });
    const before = data();
    const whole: ToolItem = { ...cut, output: 'start\nthe middle\nend' };
    delete whole.more;
    S.applyWholeItem(SID, whole);
    expect(item<ToolItem>('b1')).toBe(whole);
    expect(data().items.u1).toBe(before.items.u1);
    expect(data().items.b2).toBe(before.items.b2);
    expect(data().roots).toBe(before.roots);
    // Only a step that is still cut is replaced (a second answer, or one for a step a live patch made whole, changes nothing).
    const writes: unknown[] = [];
    const unsub = S.useStore.subscribe((s) => writes.push(s));
    S.applyWholeItem(SID, { ...whole, output: 'stale' });
    S.applyWholeItem('other-session', whole);
    unsub();
    expect(writes).toHaveLength(0);
    expect(item<ToolItem>('b1').output).toBe('start\nthe middle\nend');
    // The live step streams on as before.
    feed({ type: 'item.delta', sessionId: SID, id: 'b2', field: 'output', delta: 'done\n' });
    frame();
    expect(item<ToolItem>('b2').output).toBe('building\ndone\n');
  });
});

describe('items revisions: one item changes in place, the revision says so', () => {
  const add = (it: TimelineItem): BridgeEvent => ({ type: 'item.added', sessionId: SID, item: it });

  it('every change to the items makes a new revision that names what changed, without copying the container', () => {
    feed({ type: 'session.added', session: meta({ status: 'running' }) }, add(user), add(text), add(agent));
    const before = data();
    const container = before.items;
    const userItem = before.items.u1;
    const textItem = before.items.t1;

    // A frame of deltas: the item it grew is a new object, the others and the container stay.
    feed({ type: 'item.delta', sessionId: SID, id: 't1', field: 'text', delta: 'Hello' });
    frame();
    const afterDelta = data();
    expect(afterDelta).not.toBe(before);
    expect(afterDelta.items).toBe(container);
    expect(afterDelta.items.u1).toBe(userItem);
    expect(afterDelta.items.t1).not.toBe(textItem);
    expect(afterDelta.rev).toBeGreaterThan(before.rev);
    expect(afterDelta.changed).toEqual({ since: before.rev, ids: ['t1'] });
    expect(afterDelta.roots).toBe(before.roots);

    // A patch, an addition (root and child), a removal: each one revision, naming its ids.
    const revs = [afterDelta.rev];
    const step = (e: BridgeEvent, ids: string[]) => {
      const prev = data().rev;
      feed(e);
      expect(data().rev).not.toBe(prev);
      expect(data().changed).toEqual({ since: prev, ids });
      expect(S.changedSince(data(), prev)).toEqual(ids);
      revs.push(data().rev);
    };
    step({ type: 'item.patch', sessionId: SID, id: 'a1', patch: { title: 'Explore the module' } as Partial<TimelineItem> }, ['a1']);
    step(add(subRead), ['s1']);
    step(add({ ...subRead, id: 'n1', parentId: 's1' }), ['n1']);
    step({ type: 'item.removed', sessionId: SID, id: 's1' }, ['s1', 'n1']);
    expect(data().items).toBe(container);
    expect('s1' in data().items).toBe(false);
    expect('n1' in data().items).toBe(false);
    expect(data().children).toEqual({ a1: [] });
    // Revisions only grow and are never reused.
    expect(new Set(revs).size).toBe(revs.length);
    expect([...revs].sort((a, b) => a - b)).toEqual(revs);
  });

  it('changedSince: nothing for the same revision, null when more than one write passed or the timeline is new', () => {
    feed({ type: 'session.added', session: meta() }, add(user), add(text));
    const r0 = data().rev;
    expect(S.changedSince(data(), r0)).toEqual([]);
    feed({ type: 'item.patch', sessionId: SID, id: 'u1', patch: { state: 'sent' } as Partial<TimelineItem> });
    const r1 = data().rev;
    expect(S.changedSince(data(), r0)).toEqual(['u1']);
    feed({ type: 'item.patch', sessionId: SID, id: 't1', patch: { streaming: false } as Partial<TimelineItem> });
    // Two writes since r0: not known, read everything.
    expect(S.changedSince(data(), r0)).toBeNull();
    expect(S.changedSince(data(), r1)).toEqual(['t1']);
    // A new timeline: a new container and nothing to follow.
    const container = data().items;
    feed({ type: 'timeline.reset', sessionId: SID, items: [user] });
    expect(data().items).not.toBe(container);
    expect(data().changed).toBeUndefined();
    expect(S.changedSince(data(), data().rev - 1)).toBeNull();
    const r2 = data().rev;
    S.applySnapshot({ session: meta(), items: [user, text], permissions: [], questions: [], todos: [], queue: [] });
    expect(data().rev).toBeGreaterThan(r2);
    expect(S.changedSince(data(), r2)).toBeNull();
  });

  it('writes nothing when nothing changed: a delta or patch for an item that is not there, a whole step no longer cut', () => {
    feed({ type: 'session.added', session: meta() }, add(user));
    const before = data();
    let writes = 0;
    const unsub = S.useStore.subscribe(() => writes++);
    feed({ type: 'item.delta', sessionId: SID, id: 'gone', field: 'text', delta: 'x' });
    frame();
    feed({ type: 'item.patch', sessionId: SID, id: 'gone', patch: { title: 'x' } as Partial<TimelineItem> });
    feed({ type: 'item.removed', sessionId: SID, id: 'gone' });
    S.applyWholeItem(SID, { ...subBash, id: 'u1' });
    unsub();
    expect(writes).toBe(0);
    expect(data()).toBe(before);
  });

  it('keeps the order of the stream: deltas before a patch apply first, deltas after it apply on top', () => {
    feed({ type: 'session.added', session: meta({ status: 'running' }) }, add(user), add(text));
    feed({ type: 'item.delta', sessionId: SID, id: 't1', field: 'text', delta: 'draft ' });
    feed({ type: 'item.delta', sessionId: SID, id: 't1', field: 'text', delta: 'words' });
    // The patch replaces the text the deltas built: it must land after them, not under them.
    feed({ type: 'item.patch', sessionId: SID, id: 't1', patch: { text: 'Final answer' } as Partial<TimelineItem> });
    expect(item<TextItem>('t1').text).toBe('Final answer');
    feed({ type: 'item.delta', sessionId: SID, id: 't1', field: 'text', delta: '.' });
    frame();
    expect(item<TextItem>('t1').text).toBe('Final answer.');
    // An item added again after deltas replaces what they built, in its place.
    feed({ type: 'item.delta', sessionId: SID, id: 't1', field: 'text', delta: ' More' });
    feed(add({ ...text, text: 'Replaced', streaming: false }));
    frame();
    expect(item<TextItem>('t1')).toMatchObject({ text: 'Replaced', streaming: false });
    expect(data().roots).toEqual(['u1', 't1']);
    // Deltas still buffered for an item that is then removed find nothing to grow.
    feed({ type: 'item.delta', sessionId: SID, id: 't1', field: 'text', delta: 'late' });
    feed({ type: 'item.removed', sessionId: SID, id: 't1' });
    frame();
    expect('t1' in data().items).toBe(false);
    expect(data().roots).toEqual(['u1']);
  });

  it('a selector that remembers the revision sees every change, and hands back the same value otherwise', async () => {
    const { toolIdsSelector } = await import('../src/features/rail/util');
    const { settledSignature } = await import('../src/features/rail/git-state');
    const edit = (id: string, ts: number, status: ToolItem['status'] = 'running'): ToolItem => ({ id, ts, type: 'tool', name: 'Edit', kind: 'edit', title: `Edit ${id}`, status, detail: {} });
    const ids = toolIdsSelector(SID, (it) => it.kind === 'edit' && it.status === 'done');
    const sig = settledSignature(SID);
    const st = () => S.useStore.getState();
    // Run as the store runs them: after every write.
    let runs = 0;
    const unsub = S.useStore.subscribe((s) => {
      ids(s);
      sig(s);
      runs++;
    });
    feed({ type: 'session.added', session: meta({ status: 'running' }) }, add(user), add(edit('e1', 10)), add(edit('e2', 5)), add(text));
    expect(ids(st())).toEqual([]);
    const empty = ids(st());
    // Streaming text elsewhere: the same array back.
    feed({ type: 'item.delta', sessionId: SID, id: 't1', field: 'text', delta: 'Working' });
    frame();
    expect(ids(st())).toBe(empty);
    feed({ type: 'item.patch', sessionId: SID, id: 'e1', patch: { status: 'done' } as Partial<TimelineItem> });
    expect(ids(st())).toEqual(['e1']);
    expect(sig(st())).toBe('running|1');
    const rows = toolIdsSelector(SID, (it) => it.kind === 'edit' && it.status === 'done', true);
    const firstRows = rows(st());
    feed({ type: 'item.patch', sessionId: SID, id: 'e1', patch: { title: 'Changed diff' } });
    expect(rows(st())).not.toBe(firstRows);
    const one = ids(st());
    feed({ type: 'item.delta', sessionId: SID, id: 't1', field: 'text', delta: ' on it' });
    frame();
    expect(ids(st())).toBe(one);
    // Timeline order (by time), whatever order they settled in.
    feed({ type: 'item.patch', sessionId: SID, id: 'e2', patch: { status: 'done' } as Partial<TimelineItem> });
    expect(ids(st())).toEqual(['e2', 'e1']);
    feed(add({ ...edit('e3', 20, 'done'), parentId: 'e1' }));
    expect(ids(st())).toEqual(['e2', 'e1', 'e3']);
    expect(sig(st())).toBe('running|3');
    feed({ type: 'item.removed', sessionId: SID, id: 'e2' });
    expect(ids(st())).toEqual(['e1', 'e3']);
    expect(sig(st())).toBe('running|2');
    unsub();
    expect(runs).toBeGreaterThan(8);
    // Writes it did not see: it reads every item again and still agrees.
    feed({ type: 'item.patch', sessionId: SID, id: 'e1', patch: { status: 'error' } as Partial<TimelineItem> });
    feed(add(edit('e4', 30, 'done')));
    expect(ids(st())).toEqual(['e3', 'e4']);
    expect(sig(st())).toBe('running|3');
    // A new timeline.
    feed({ type: 'timeline.reset', sessionId: SID, items: [user, edit('e9', 1, 'done')] });
    expect(ids(st())).toEqual(['e9']);
    expect(sig(st())).toBe('running|1');
  });

  it('the conversation shape followed write by write is always the shape read whole', async () => {
    const { shapeIndex, shapeOf } = await import('../src/features/timeline/turns');
    const read = shapeIndex();
    const whole = () => data().roots.map((id) => shapeOf(data().items[id])).join('');
    const check = () => expect(read(data(), data().roots)).toBe(whole());
    feed({ type: 'session.added', session: meta({ status: 'running' }) });
    check();
    // A seeded walk through adds, streams, patches, removals, resets and writes it does not see.
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor((seed / 2147483648) * n);
    };
    let next = 0;
    for (let i = 0; i < 600; i++) {
      const roots = data().roots;
      const pick = () => roots[rnd(roots.length)];
      const r = rnd(20);
      if (r < 6 || !roots.length) {
        const k = rnd(5);
        const id = `i${next++}`;
        const it: TimelineItem =
          k === 0 ? { id, ts: i, type: 'user', text: 'go', state: rnd(3) ? 'sent' : 'queued' } : k === 1 ? { id, ts: i, type: 'text', text: '', streaming: true } : k === 2 ? { id, ts: i, type: 'turn', durationMs: 1, inputTokens: 0, outputTokens: 0 } as TimelineItem : { ...subRead, id, ts: i, parentId: rnd(4) ? undefined : pick() };
        feed(add(it));
      } else if (r < 10) {
        feed({ type: 'item.delta', sessionId: SID, id: pick(), field: 'text', delta: rnd(2) ? 'word ' : ' ' });
        if (rnd(2)) frame();
      } else if (r < 14) {
        const id = pick();
        const cur = data().items[id];
        const patch = cur?.type === 'text' ? { streaming: false } : cur?.type === 'user' ? { state: 'sent' } : { status: 'done' };
        feed({ type: 'item.patch', sessionId: SID, id, patch: patch as Partial<TimelineItem> });
      } else if (r < 16) feed({ type: 'item.removed', sessionId: SID, id: pick() });
      else if (r < 17 && rnd(4) === 0) feed({ type: 'timeline.reset', sessionId: SID, items: roots.slice(0, rnd(roots.length + 1)).map((id) => data().items[id]) });
      else if (r < 19) {
        // Two writes before the reader looks again.
        feed(add({ ...text, id: `i${next++}`, ts: i }), { type: 'item.patch', sessionId: SID, id: pick(), patch: { streaming: false } as Partial<TimelineItem> });
      }
      check();
    }
  });
});

describe('capabilities pushed by the bridge', () => {
  it('caps.updated replaces the home composer caps, matching the folder loosely', () => {
    const caps = (id: string) => ({ models: [{ id, name: id }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], skillTrigger: '/' as const, features: { images: true, thinking: true, rewind: true, steer: true, compact: true, fast: false } });
    S.useStore.setState({ providerCaps: { [S.capsKey('codex', 'D:/work/app', null)]: caps('old') } });
    S.applyEvent({ type: 'caps.updated', provider: 'codex', cwd: 'D:\\work\\app', caps: caps('new') });
    expect(S.useStore.getState().providerCaps[S.capsKey('codex', 'D:/work/app', null)].models[0].id).toBe('new');
    // Another account's entry is left alone.
    S.applyEvent({ type: 'caps.updated', provider: 'codex', accountId: 'acc2', cwd: 'D:/work/app', caps: caps('other') });
    expect(S.useStore.getState().providerCaps[S.capsKey('codex', 'D:/work/app', null)].models[0].id).toBe('new');
    expect(S.useStore.getState().providerCaps[S.capsKey('codex', 'D:/work/app', 'acc2')].models[0].id).toBe('other');
  });
});
