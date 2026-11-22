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
import type { SessionMeta, SessionSnapshot, TimelineItem } from '@shared/protocol';

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

  it('starting into a chat asks for it right behind hello, once, and applies it once hello is in', async () => {
    useStore.setState((s) => ({ ready: false, sessions: {}, data: {}, ui: { ...s.ui, activeSessionId: 'a' } }));
    store.startBridge();
    statusListener?.('open');
    expect(calls.map((c) => c.method).slice(0, 2)).toEqual(['app.hello', 'session.snapshot']);
    // The snapshot answers first: it waits for hello.
    snapCalls()[0].resolve(snap('a'));
    await flush();
    expect(useStore.getState().data.a).toBeUndefined();
    calls.find((c) => c.method === 'app.hello')!.resolve({ version: '0', platform: 'win32', home: 'C:/', providers: [], projects: [], sessions: [meta('a')], settings: useStore.getState().settings, prompts: { permissions: [], questions: [] } });
    await flush();
    await flush();
    expect(useStore.getState().data.a?.loaded).toBe(true);
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
