/**
 * perf1: opening a chat fast, and only ever showing what is true.
 *
 * - One snapshot request per chat at a time (a hover's fetch and the click share it).
 * - A chat whose snapshot is not here yet: the view switches when it arrives (so the first frame
 *   shows the conversation and the complete composer), or after `OPEN_HOLD_MS` when it is slow;
 *   any other navigation meanwhile (another chat, home, a race) cancels the switch.
 * - A late answer for a chat that was removed meanwhile is dropped (it never brings the chat back).
 * - A fetch ahead (pointer resting on a row) asks with `peek`, so the chat is not marked read.
 * - Kept chats are bounded (`KEEP.chats`, `KEEP.items`), least recently used out first; the open
 *   chat and the race on screen are never dropped; a dropped chat keeps its waiting prompts.
 * - After the socket dropped (a second `app.hello`) only the open chat stays (fetched again): every
 *   other kept chat may have missed events, so it is fetched afresh when opened.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest, SessionMeta, SessionSnapshot, TimelineItem } from '@shared/protocol';

type Call = { method: string; params: Record<string, unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const calls: Call[] = [];
let statusListener: ((s: string) => void) | null = null;
vi.mock('@/lib/bridge', () => ({
  bridge: {
    status: 'closed',
    call: (method: string, params: Record<string, unknown>) => new Promise((resolve, reject) => calls.push({ method, params, resolve, reject })),
    on: () => () => {},
    onStatus: (l: (s: string) => void) => ((statusListener = l), () => {}),
    start: () => {},
  },
}));

const store = await import('../src/state/store');
const actions = await import('../src/state/actions');
const { useStore, KEEP } = store;

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, provider: 'demo', cwd: 'C:/w', title: id, titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: 0, updatedAt: 0, usage: { inputTokens: 0, outputTokens: 0, turns: 0 }, ...extra }) as SessionMeta;
const items = (id: string, n: number): TimelineItem[] => Array.from({ length: n }, (_, i) => ({ id: `${id}-${i}`, ts: i, type: 'text', text: 'x', streaming: false }) as TimelineItem);
const snap = (id: string, n = 2, extra: Partial<SessionMeta> = {}): SessionSnapshot => ({ session: meta(id, extra), items: items(id, n), permissions: [], questions: [], todos: [], queue: [] });
const snapCalls = () => calls.filter((c) => c.method === 'session.snapshot');
const answer = async (id: string, n = 2) => {
  const c = snapCalls().find((x) => x.params.sessionId === id && !(x as { done?: boolean }).done);
  if (!c) throw new Error(`no pending snapshot for ${id}`);
  (c as { done?: boolean }).done = true;
  // The bridge answers with the chat as it holds it (unread, race and all).
  c.resolve({ ...snap(id, n), session: { ...meta(id), ...useStore.getState().sessions[id] } });
  await flush();
};
const flush = () => new Promise((r) => setTimeout(r, 0));

function reset(ids: string[], extra: Record<string, Partial<SessionMeta>> = {}) {
  calls.length = 0;
  store.resetKept();
  useStore.setState((s) => ({ ready: true, sessions: Object.fromEntries(ids.map((id) => [id, meta(id, extra[id])])), data: {}, ui: { ...s.ui, activeSessionId: null, race: null } }));
}

beforeEach(() => {
  vi.useRealTimers();
  reset(['a', 'b', 'c']);
});

describe('opening a chat', () => {
  it('asks once for a chat however often it is asked for meanwhile', async () => {
    actions.prefetchSession('a');
    actions.prefetchSession('a');
    actions.openSession('a');
    expect(snapCalls()).toHaveLength(1);
    await answer('a');
    expect(useStore.getState().data.a?.loaded).toBe(true);
    expect(useStore.getState().ui.activeSessionId).toBe('a');
  });

  it('switches the view when the snapshot arrives, not before it', async () => {
    actions.openSession('a');
    expect(useStore.getState().ui.activeSessionId).toBe(null);
    await answer('a');
    const s = useStore.getState();
    expect(s.ui.activeSessionId).toBe('a');
    expect(s.data.a.loaded).toBe(true);
  });

  it('switches after the hold when the snapshot is slow, and the snapshot fills it later', async () => {
    vi.useFakeTimers();
    actions.openSession('a');
    vi.advanceTimersByTime(actions.OPEN_HOLD_MS - 1);
    expect(useStore.getState().ui.activeSessionId).toBe(null);
    vi.advanceTimersByTime(1);
    expect(useStore.getState().ui.activeSessionId).toBe('a');
    vi.useRealTimers();
    await answer('a');
    expect(useStore.getState().data.a.loaded).toBe(true);
  });

  it('a chat already here opens at once, without asking', () => {
    store.applySnapshot(snap('a'));
    calls.length = 0;
    actions.openSession('a');
    expect(useStore.getState().ui.activeSessionId).toBe('a');
    expect(snapCalls()).toHaveLength(0);
  });

  it('another chat asked for meanwhile wins; the first one never takes the view', async () => {
    actions.openSession('a');
    actions.openSession('b');
    await answer('b');
    expect(useStore.getState().ui.activeSessionId).toBe('b');
    await answer('a');
    expect(useStore.getState().ui.activeSessionId).toBe('b');
  });

  it('going home meanwhile cancels the switch', async () => {
    store.applySnapshot(snap('c'));
    actions.openSession('c');
    actions.openSession('a');
    actions.goHome();
    await answer('a');
    expect(useStore.getState().ui.activeSessionId).toBe(null);
  });

  it('a late answer for a chat removed meanwhile is dropped', async () => {
    actions.prefetchSession('a');
    store.applyEvent({ type: 'session.removed', id: 'a' });
    await answer('a');
    const s = useStore.getState();
    expect(s.sessions.a).toBeUndefined();
    expect(s.data.a).toBeUndefined();
  });

  it('a fetch ahead does not mark the chat read; opening it does', async () => {
    reset(['a'], { a: { unread: true } });
    actions.prefetchSession('a');
    expect(snapCalls()[0].params).toMatchObject({ sessionId: 'a', peek: true });
    await answer('a');
    expect(calls.some((c) => c.method === 'session.update')).toBe(false);
    actions.openSession('a');
    expect(calls.find((c) => c.method === 'session.update')?.params).toMatchObject({ sessionId: 'a', patch: { unread: false } });
  });
});

describe('chats kept in the window', () => {
  it('keeps at most KEEP.chats besides the open one, the least recently used out first, prompts kept', async () => {
    const ids = Array.from({ length: KEEP.chats + 3 }, (_, i) => `k${i}`);
    reset(ids);
    const perm = { id: 'p1', sessionId: 'k0', toolName: 'Bash', input: {}, title: 'Run' };
    for (const id of ids) {
      actions.openSession(id);
      await answer(id);
      if (id === 'k0') store.applyEvent({ type: 'permission.added', request: perm } as never);
    }
    const s = useStore.getState();
    const loaded = ids.filter((id) => s.data[id]?.loaded);
    expect(s.ui.activeSessionId).toBe(ids.at(-1));
    expect(loaded).toHaveLength(KEEP.chats + 1);
    expect(loaded).toEqual(ids.slice(-(KEEP.chats + 1)));
    // Dropped, but its waiting prompt is still there for the triage deck.
    expect(s.data.k0.loaded).toBe(false);
    expect(s.data.k0.permissions.map((p) => p.id)).toEqual(['p1']);
    expect(Object.keys(s.data.k0.items)).toHaveLength(0);
  });

  it('a chat that left the window and comes on screen some other way (a notification) is fetched, never shown empty', async () => {
    const ids = Array.from({ length: KEEP.chats + 3 }, (_, i) => `k${i}`);
    reset(ids);
    for (const id of ids) {
      actions.openSession(id);
      await answer(id);
    }
    expect(useStore.getState().data.k0.loaded).toBe(false);
    calls.length = 0;
    // What a notification's click does: the chat is put on screen directly.
    useStore.getState().setUi({ activeSessionId: 'k0', race: null });
    expect(snapCalls().map((c) => c.params.sessionId)).toEqual(['k0']);
    await answer('k0');
    expect(useStore.getState().data.k0.loaded).toBe(true);
    // A chat that is here asks nothing.
    calls.length = 0;
    useStore.getState().setUi({ activeSessionId: ids.at(-1)!, race: null });
    expect(snapCalls()).toHaveLength(0);
  });

  it('keeps fewer when the kept chats are long (KEEP.items)', async () => {
    reset(['big1', 'big2', 'small']);
    for (const id of ['big1', 'big2']) {
      actions.prefetchSession(id);
      await answer(id, Math.ceil(KEEP.items * 0.6));
    }
    actions.openSession('small');
    await answer('small', 2);
    const s = useStore.getState();
    expect(s.data.big1.loaded).toBe(false);
    expect(s.data.big2.loaded).toBe(true);
    expect(s.data.small.loaded).toBe(true);
  });

  it('never drops the open chat or the race on screen', async () => {
    const ids = Array.from({ length: KEEP.chats + 4 }, (_, i) => `r${i}`);
    reset(ids, { r0: { race: { id: 'R', rival: 'r1', side: 0, task: 't', cwd: 'C:/w' } as never }, r1: { race: { id: 'R', rival: 'r0', side: 1, task: 't', cwd: 'C:/w' } as never } });
    for (const id of ['r0', 'r1']) {
      actions.prefetchSession(id);
      await answer(id);
    }
    useStore.getState().setUi({ race: 'R', activeSessionId: null });
    for (const id of ids.slice(2)) {
      actions.prefetchSession(id);
      await answer(id);
    }
    const s = useStore.getState();
    expect(s.data.r0.loaded).toBe(true);
    expect(s.data.r1.loaded).toBe(true);
  });

  it('starting into a chat asks for it right behind hello, once; answered first it is applied at once, and what follows lands on it', async () => {
    useStore.setState((s) => ({ ready: false, sessions: {}, data: {}, ui: { ...s.ui, activeSessionId: 'a' } }));
    store.startBridge();
    statusListener?.('open');
    expect(calls.map((c) => c.method).slice(0, 2)).toEqual(['app.hello', 'session.snapshot']);
    // The snapshot answers first: applied at once (held until hello it went stale, and what came between was lost).
    snapCalls()[0].resolve(snap('a'));
    await flush();
    expect(useStore.getState().data.a?.loaded).toBe(true);
    // The chat goes on before hello answers: an item, and an approval the agent now waits on.
    store.applyEvent({ type: 'item.added', sessionId: 'a', item: { id: 'late', ts: 9, type: 'text', text: 'late', streaming: false } as TimelineItem });
    const ask = { id: 'p1', sessionId: 'a', kind: 'bash', title: 'Run', options: [] } as unknown as PermissionRequest;
    calls.find((c) => c.method === 'app.hello')!.resolve({ version: '0', platform: 'win32', home: 'C:/', providers: [], projects: [], sessions: [meta('a', { status: 'awaiting' })], settings: useStore.getState().settings, prompts: { permissions: [ask], questions: [] } });
    await flush();
    await flush();
    const s = useStore.getState();
    // Nothing of it is lost: the item, hello's newer meta and the approval all stand.
    expect(s.data.a.roots).toContain('late');
    expect(s.sessions.a.status).toBe('awaiting');
    expect(s.data.a.permissions.map((p) => p.id)).toEqual(['p1']);
    // And it was not asked for again.
    expect(snapCalls()).toHaveLength(1);
  });

  it('after the socket comes back only the open chat stays, and it is fetched again', async () => {
    for (const id of ['a', 'b']) {
      actions.openSession(id);
      await answer(id);
    }
    calls.length = 0;
    store.startBridge();
    statusListener?.('open');
    const hello = calls.find((c) => c.method === 'app.hello');
    expect(hello).toBeTruthy();
    hello!.resolve({ version: '0', platform: 'win32', home: 'C:/', providers: [], projects: [], sessions: [meta('a'), meta('b'), meta('c')], settings: useStore.getState().settings, prompts: { permissions: [], questions: [] } });
    await flush();
    const s = useStore.getState();
    expect(s.ui.activeSessionId).toBe('b');
    expect(s.data.a.loaded).toBe(false);
    expect(snapCalls().map((c) => c.params.sessionId)).toEqual(['b']);
  });
});

describe('a message the agent has taken moves in one update', () => {
  it('never a state without the row: the pair of events is one change of the list', async () => {
    actions.openSession('a');
    await answer('a', 3);
    const seen: string[][] = [];
    const stop = useStore.subscribe((s, prev) => {
      if (s.data.a !== prev.data.a) seen.push([...s.data.a.roots]);
    });
    const moved = { ...useStore.getState().data.a.items['a-0'], text: 'taken' } as TimelineItem;
    store.applyEvent({ type: 'item.removed', sessionId: 'a', id: 'a-0', moving: true });
    store.applyEvent({ type: 'item.added', sessionId: 'a', item: moved, moved: true });
    stop();
    expect(seen).toEqual([['a-1', 'a-2', 'a-0']]);
    expect(useStore.getState().data.a.items['a-0']).toMatchObject({ text: 'taken' });
    // A plain removal still removes, and a plain add of a known item replaces it where it stands.
    store.applyEvent({ type: 'item.added', sessionId: 'a', item: { ...moved, text: 'again' } as TimelineItem });
    expect(useStore.getState().data.a.roots).toEqual(['a-1', 'a-2', 'a-0']);
    store.applyEvent({ type: 'item.removed', sessionId: 'a', id: 'a-1' });
    expect(useStore.getState().data.a.roots).toEqual(['a-2', 'a-0']);
  });
});

it('an open detail retries a failed whole request and reads the replacement row', async () => {
  const { requestWhileCut } = await import('../src/features/timeline/whole-request');
  vi.useFakeTimers();
  const row = { id: 'old', type: 'thinking' as const, ts: 0, text: 'cut', streaming: false, more: true };
  const snapA = { ...snap('a'), items: [row] };
  store.applySnapshot(snapA);
  actions.openSession('a');
  const stop = requestWhileCut('a', row.id);
  try {
    calls.at(-1)!.reject(new Error('lost'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.filter(c => c.method === 'session.item')).toHaveLength(2);
    store.applySnapshot({ ...snapA, items: [{ ...row }] });
    calls.at(-1)!.resolve({ item: { ...row, text: 'stale', more: false } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.filter(c => c.method === 'session.item')).toHaveLength(3);
    calls.at(-1)!.resolve({ item: { ...row, text: 'current', more: false } });
    await vi.advanceTimersByTimeAsync(4000);
    expect(useStore.getState().data.a.items.old).toMatchObject({ text: 'current', more: false });
    expect(calls).toHaveLength(3);
  } finally { stop(); vi.useRealTimers(); }
});

it('charges live children to the first off-screen chat; a chat with an opened step stays loaded and goes back to rows on leaving', async () => {
  const budget = KEEP.items;
  try {
    KEEP.items = 3;
    actions.openSession('a');
    await answer('a', 2);
    for (const id of ['child1', 'child2']) store.applyEvent({ type: 'item.added', sessionId: 'a',
      item: { ...items(id, 1)[0], parentId: 'a-0' } });
    useStore.getState().setUi({ activeSessionId: null });
    store.trimKept();
    expect(useStore.getState().data.a.loaded).toBe(false);
    const cut = { type: 'thinking' as const, id: 't', ts: 1, text: 'cut', more: true, streaming: false };
    store.applySnapshot({ ...snap('b'), items: [cut] });
    actions.openSession('b');
    store.applyWholeItem('b', { ...cut, text: 'whole', more: false }, cut);
    expect(useStore.getState().data.b.items.t).toMatchObject({ text: 'whole' });
    const asked = snapCalls().length;
    useStore.getState().setUi({ activeSessionId: null });
    store.trimKept();
    // Off screen it is rows again (the very row it arrived as), still loaded: coming back asks for nothing.
    expect(useStore.getState().data.b.loaded).toBe(true);
    expect(useStore.getState().data.b.items.t).toBe(cut);
    expect(useStore.getState().data.b.hydrated).toBe(false);
    actions.openSession('b');
    await flush();
    expect(snapCalls().length).toBe(asked);
    expect(useStore.getState().data.b.items.t).toBe(cut);
    // A whole item that changed since it was fetched is not put back over the change.
    store.applyWholeItem('b', { ...cut, text: 'whole', more: false }, cut);
    store.applyEvent({ type: 'item.patch', sessionId: 'b', id: 't', patch: { text: 'whole, then changed' } } as never);
    await flush();
    useStore.getState().setUi({ activeSessionId: null });
    store.trimKept();
    expect(useStore.getState().data.b.items.t).toMatchObject({ text: 'whole, then changed' });
  } finally { KEEP.items = budget; }
});

it('a reloaded queue edit keeps its picture and checks whether the agent took it before sending', async () => {
  const { packDrafts, unpackDrafts } = await import('../src/features/composer/drafts');
  const { recoverTake } = await import('../src/features/composer/queue-edit');
  const attachment = { id: 'pic', kind: 'image' as const, name: 'pic.png', dataUrl: 'data:image/png;base64,abcd' };
  const { queueDraft } = await import('../src/features/composer/pending');
  const preview = queueDraft({ id: 'row', text: 'inspect this', attachments: [attachment], createdAt: 0 });
  const restored = unpackDrafts(JSON.stringify(packDrafts({ a: preview })));
  expect(restored.a).toEqual(preview);
  for (const delivered of [false, true]) {
    useStore.getState().setDraft('a', restored.a);
    const attempt = recoverTake('a');
    await flush();
    const request = calls.at(-1)!;
    expect(request.method).toBe('queue.take');
    expect(request.params.operationId).toBe(preview.recovery?.operationId);
    request.resolve(delivered ? { taken: true } : { message: { id: 'row', text: preview.text, attachments: [attachment], createdAt: 0 } });
    expect(await attempt).toBe(!delivered);
    const draft = useStore.getState().drafts.a;
    expect(draft.text).toBe(delivered ? '' : preview.text);
    expect(draft.attachments).toEqual(delivered ? [] : [attachment]);
  }
});

it('opens an oversized snapshot once and trims a growing off-screen chat', async () => {
  const budget = KEEP.items;
  try {
    KEEP.items = 2;
    actions.prefetchSession('a');
    actions.openSession('a');
    await answer('a', 3);
    expect(snapCalls()).toHaveLength(1);
    expect(useStore.getState().data.a.loaded).toBe(true);
    actions.prefetchSession('b');
    await answer('b', 2);
    store.applyEvent({ type: 'item.added', sessionId: 'b', item: items('extra', 1)[0] });
    await flush();
    expect(useStore.getState().data.b.loaded).toBe(false);
    expect(useStore.getState().data.a.loaded).toBe(true);
  } finally { KEEP.items = budget; }
});

describe('a conversation read from the end', () => {
  const row = (i: number, parentId?: string): TimelineItem => ({ id: 'i' + i, type: 'user', ts: i, text: 'Prompt ' + i, parentId });
  const page = (kind: 'end' | 'older', before: number, rows: TimelineItem[]): SessionSnapshot => ({
    ...snap('a'), items: rows, page: { kind, before, rootsBefore: before, recentAt: 0 },
  });
  it('prepends once per answer and reaches the same item indexes, groups, first build and marks as a whole read', async () => {
    const { shapeIndex, groupTurns, turnsIndex } = await import('../src/features/timeline/turns');
    const { marksOf } = await import('../src/features/timeline/nav-model');
    const { tailStart } = await import('../src/features/timeline/build-window');
    const rows = Array.from({ length: 50 }, (_, i) => row(i, i % 3 === 0 && i ? 'i' + (i - 1) : undefined));
    const read = () => useStore.getState().data.a;
    store.applySnapshot({ ...snap('a'), items: rows });
    const whole = read();
    const shapes = shapeIndex(), group = turnsIndex();
    const expected = groupTurns(whole.roots, shapes(whole, whole.roots), false);
    store.applySnapshot(page('end', 30, rows.slice(30)));
    const end = read(), grouped = group(end.roots, shapes(end, end.roots), false);
    const first = (groups: typeof grouped.groups) => groups.slice(tailStart(groups.map(() => 600), 2700));
    expect(first(grouped.groups)).toEqual(first(expected.groups));
    expect(end.loaded && end.incomplete).toBe(true);
    const work = store.completeSession('a');
    await flush();
    expect(snapCalls()).toHaveLength(1);
    actions.openSession('a');
    await store.loadSession('a');
    expect(snapCalls()).toHaveLength(1);
    snapCalls()[0].resolve(page('older', 15, rows.slice(15, 30)));
    await flush();
    const mid = read();
    expect(store.changedSince(mid, end.rev)).toEqual(rows.slice(15, 30).map(i => i.id));
    const midLayout = group(mid.roots, shapes(mid, mid.roots), false);
    expect(midLayout.groups.at(-1)).toBe(grouped.groups.at(-1));
    snapCalls()[1].resolve(page('older', 0, rows.slice(0, 15)));
    await work;
    const done = read();
    expect(done.incomplete).toBe(false);
    expect(done.roots).toEqual(whole.roots);
    expect(done.children).toEqual(whole.children);
    expect(done.items).toEqual(whole.items);
    const layout = group(done.roots, shapes(done, done.roots), false);
    expect(layout).toEqual(expected);
    expect(marksOf(layout.groups, done.items, new WeakMap())).toEqual(marksOf(expected.groups, whole.items, new WeakMap()));
  });
  it('applies a missing patch, removal and moved steer once and keeps live metadata across a page', async () => {
    store.applySnapshot(page('end', 3, [row(3)]));
    store.applyEvent({ type: 'item.patch', sessionId: 'a', id: 'i0', patch: { text: 'patched' } });
    store.applyEvent({ type: 'item.removed', sessionId: 'a', id: 'i1' });
    store.applyEvent({ type: 'item.removed', sessionId: 'a', id: 'i2', moving: true });
    store.applyEvent({ type: 'item.added', sessionId: 'a', item: row(2), moved: true });
    const queue = [{ id: 'q', text: 'next', createdAt: 1 }];
    store.applyEvent({ type: 'queue.updated', sessionId: 'a', queue });
    await flush();
    snapCalls()[0].resolve(page('older', 0, [row(0), row(1), row(2)]));
    await flush();
    const d = useStore.getState().data.a;
    expect(d.roots).toEqual(['i0', 'i3', 'i2']);
    expect(d.items.i0).toMatchObject({ text: 'patched' });
    expect(d.queue).toEqual(queue);
  });
  it('removes descendants whose missing parent arrives in a later page', async () => {
    store.applySnapshot(page('end', 3, [row(3), row(4, 'i1')]));
    store.applyEvent({ type: 'item.removed', sessionId: 'a', id: 'i0' });
    await flush();
    snapCalls()[0].resolve(page('older', 0, [row(0), row(1, 'i0'), row(2, 'i1')]));
    await flush();
    const d = useStore.getState().data.a;
    expect(d.roots).toEqual(['i3']);
    expect(d.children).toEqual({});
    expect(Object.keys(d.items)).toEqual(['i3']);
  });
  it('drops an incomplete prefetch at its whole size and ignores its late page', async () => {
    store.applySnapshot(page('end', KEEP.items + 1, [row(4)]));
    const work = store.completeSession('a').catch(() => {});
    await flush();
    store.trimKept();
    expect(useStore.getState().data.a.loaded).toBe(false);
    snapCalls()[0]?.resolve(page('older', 0, [row(1)]));
    await work;
    expect(useStore.getState().data.a.items).toEqual({});
  });
  it('asks whole on reconnect and discards the page from the previous socket', async () => {
    store.applySnapshot(page('end', 4, [row(4)]));
    actions.openSession('a');
    store.startBridge();
    await flush();
    statusListener?.('closed');
    statusListener?.('open');
    calls.find(c => c.method === 'app.hello')!.resolve({ version: '0', platform: 'win32', providers: [], projects: [], sessions: [meta('a')], settings: useStore.getState().settings, snapshotThreshold: 2 });
    await flush();
    expect(snapCalls().at(-1)!.params.page).toBeUndefined();
    snapCalls().at(-1)!.resolve(snap('a', 6));
    await flush();
    snapCalls()[0].resolve(page('older', 0, [row(1)]));
    await flush();
    expect(useStore.getState().data.a.roots).toEqual(items('a', 6).map(i => i.id));
  });
  it.each(['rewind', 'fork'] as const)('waits for a complete chat before %s', async verb => {
    store.applySnapshot(page('end', 2, [row(2)]));
    const action = verb === 'rewind' ? actions.rewindTo('a', 'i0', false) : actions.forkAt('a', 'i0');
    await flush();
    expect(calls.map(c => c.method)).toEqual(['session.snapshot']);
    snapCalls()[0].resolve(page('older', 0, [row(0), row(1)]));
    await flush();
    expect(calls[1].method).toBe('session.' + verb);
    calls[1].resolve(verb === 'rewind' ? { ok: true } : snap('b'));
    await action;
  });
});

it('replaces a display-only tail after a restart, retaining identical rows and settling the running step by ID', async () => {
  const kept: TimelineItem = { type: 'user', ts: 1, id: 'u', text: 'Continue' };
  const step: TimelineItem = { type: 'tool', ts: 2, id: 'w', name: 'Bash', title: 'Work', kind: 'bash', status: 'running', detail: {} };
  const view = snap('a', 0);
  store.applySnapshot({ ...view, page: { kind: 'provisional', before: -1, rootsBefore: -1, recentAt: 0 }, items: [kept, step] });
  // A click in the same task protects the displayed chat from the off-screen budget.
  actions.openSession('a');
  expect(useStore.getState().data.a).toMatchObject({ provisional: true, loaded: true, incomplete: true });
  await flush();
  expect(snapCalls()[0].params.page).toBe('real');
  const stopped: TimelineItem = { ...step, status: 'cancelled' };
  const notice: TimelineItem = { type: 'notice', id: 'n', ts: 3, variant: 'info', text: 'Ended early', early: 'restart' };
  snapCalls()[0].resolve({ ...view, items: [{ ...kept }, stopped, notice] });
  await flush();
  const d = useStore.getState().data.a;
  expect(d.provisional || d.incomplete).toBe(false);
  expect(d.roots).toEqual(['u', 'w', 'n']);
  expect(d.items.u).toBe(kept);
  expect(d.items.w).toBe(stopped);
});

it('orders promoted output and later deltas against the page cut', async () => {
  const tool: TimelineItem = { type: 'tool', ts: 1, id: 'tool', name: 'Bash', title: 'Work', kind: 'bash', status: 'running', detail: {}, output: 'ABC', more: true };
  store.applySnapshot({ ...snap('a'), page: { kind: 'end', before: 1, rootsBefore: 1, recentAt: 0 } });
  store.applyEvent({ type: 'item.patch', sessionId: 'a', id: 'tool', seq: 4, patch: { output: 'AB', more: false } });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  store.applyEvent({ type: 'item.delta', sessionId: 'a', id: 'tool', seq: 5, field: 'output', delta: 'C' });
  store.applyEvent({ type: 'item.delta', sessionId: 'a', id: 'tool', seq: 6, field: 'output', delta: 'D' });
  await flush();
  snapCalls()[0].resolve({ ...snap('a'), items: [tool], seq: 5, page: { kind: 'older', before: 0, rootsBefore: 0, recentAt: 0 } });
  await flush();
  vi.unstubAllGlobals();
  expect(useStore.getState().data.a.items.tool).toMatchObject({ output: 'ABCD', more: true });
});
it('prepends inherited property names as real roots and parents', async () => {
  store.applySnapshot({ ...snap('a'), page: { kind: 'end', before: 2, rootsBefore: 1, recentAt: 0 } });
  await flush();
  snapCalls()[0].resolve({ ...snap('a'), items: [{ ...items('x',1)[0], id: 'toString' }, { ...items('x',1)[0], id: '__proto__', parentId: 'toString' }], page: { kind: 'older', before: 0, rootsBefore: 0, recentAt: 0 } });
  await flush();
  const d = useStore.getState().data.a;
  expect(d.roots[0]).toBe('toString');
  expect(d.children.toString).toEqual(['__proto__']);
});
it('releases whole rows when deleting an open chat', () => {
  const row = { id: 'picture', type: 'user' as const, ts: 1, text: 'look', more: true };
  store.applySnapshot({ ...snap('a'), items: [row] });
  store.applyWholeItem('a', { ...row, more: false }, row);
  store.applyEvent({ type: 'session.removed', id: 'a' });
  expect(store.wholeRowsHeld('a')).toBe(0);
});
it('suppresses a provisional queue row whose card already stands', () => {
  store.applySnapshot({ ...snap('a'), page: { kind: 'provisional', before: -1, rootsBefore: -1, recentAt: 0 }, items: [{ type: 'user', id: 'q', ts: 1, text: 'go' }], queue: [{ id: 'q', createdAt: 0, text: 'go' }] });
  expect(useStore.getState().data.a.queue).toEqual([]);
});

it('keeps a provisional queue reconciled when its card or queue arrives live', () => {
  const q = { id: 'reserved', submitId: 'message', text: 'go', createdAt: 1 };
  store.applySnapshot({ ...snap('a'), items: [], queue: [q], page: { kind: 'provisional', before: -1, rootsBefore: -1, recentAt: 0 } });
  store.applyEvent({ type: 'item.added', sessionId: 'a', item: { id: 'message', ts: 2, type: 'user', text: 'go' } });
  expect(useStore.getState().data.a.queue).toEqual([]);
  store.applyEvent({ type: 'queue.updated', sessionId: 'a', queue: [q] });
  expect(useStore.getState().data.a.queue).toEqual([]);
});
