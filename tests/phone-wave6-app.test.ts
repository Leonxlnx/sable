/**
 * The phone's store reading long lists on (review wave 6, #7, #13, #14): the chats' list and what
 * waits come in pages; events that arrive meanwhile stay applied (an answered prompt is not put
 * back by a later page); a list not read to its end keeps the chats known before and says so (no
 * pruning by it); Forget while a load is on its way applies nothing of it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PermissionRequest, SessionMeta } from '@shared/protocol';
import { bumpEpoch } from '../mobile/src/lib/epoch';

const fake = vi.hoisted(() => ({
  cleared: vi.fn(),
  conn: {
    state: 'open',
    pairing: undefined as unknown,
    on: () => {},
    onState: () => {},
    call: (async () => {
      throw new Error('no desktop');
    }) as (method: string, params: Record<string, unknown>) => Promise<unknown>,
  },
}));
vi.mock('../mobile/src/lib/conn', () => ({ conn: fake.conn }));
vi.mock('../mobile/src/lib/native', () => ({
  clearAnsweredNote: fake.cleared,
  clearChatNotifications: () => {},
  clearShortcuts: () => {},
  loadPref: async (_k: string, f: unknown) => f,
  durable: async () => {},
}));
vi.mock('@desk/features/timeline/lead-in', async () => await import('../src/features/timeline/lead-in'));

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  get length() {
    return mem.size;
  },
  key: (i: number) => [...mem.keys()][i] ?? null,
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
});
vi.stubGlobal('window', globalThis);
vi.stubGlobal('requestAnimationFrame', (f: () => void) => setTimeout(f, 0));
vi.stubGlobal('cancelAnimationFrame', (h: ReturnType<typeof setTimeout>) => clearTimeout(h));

type Store = {
  watchLive: (send: (spec: { chats: number; waiting: number; chat?: string; since?: number } | null, stop: boolean) => void) => () => void;
  applyEventSoon: (e: unknown) => void;
  intend: (id: string, field: 'speed', value: string | undefined) => number;
  undoIntent: (id: string, field: 'speed', gen: number) => boolean;
  loadCachedHome: () => void;
  refresh: (open: string[]) => Promise<{ complete: boolean }>;
  openSession: (id: string) => Promise<void>;
  applyEvent: (e: unknown) => void;
  getState: () => { sessions: Record<string, SessionMeta>; pending: { permissions: PermissionRequest[] }; data: Record<string, { permissions: PermissionRequest[] }> };
  setState: (p: Record<string, unknown>) => void;
};
// By a name in a variable: the root type-check does not follow it into the phone's own aliases.
const STORE = '../mobile/src/lib/store';
const load = async () => (await import(/* @vite-ignore */ STORE)) as Store;

const meta = (id: string) => ({ id, title: id, provider: 'demo', cwd: '/x', status: 'idle', createdAt: 1, updatedAt: 1 }) as unknown as SessionMeta;

describe('phone session updates', () => {
  it('removes JSON null fields, including a held pick rolled back after the clear', async () => {
    const s = await load();
    s.setState({ sessions: { a: { ...meta('a'), speed: 'fast', background: 2, commands: 3, spare: { reason: 'reset' } } } });
    const pick = s.intend('a', 'speed', 'other');
    const patch = (fields: object) => s.applyEvent(JSON.parse(JSON.stringify({ type: 'session.updated', id: 'a', patch: fields })));
    patch({ speed: null, background: null, spare: null, moving: false, omitted: undefined });
    expect(s.getState().sessions.a).not.toHaveProperty('background');
    expect(s.getState().sessions.a).not.toHaveProperty('spare');
    expect(s.getState().sessions.a).toMatchObject({ speed: 'other', commands: 3, moving: false });
    expect(s.undoIntent('a', 'speed', pick)).toBe(true);
    expect(s.getState().sessions.a).not.toHaveProperty('speed');
    s.intend('a', 'speed', undefined);
    patch({ speed: null });
    patch({ speed: 'new', commands: 0 });
    expect(s.getState().sessions.a).toMatchObject({ speed: 'new', commands: 0 });
  });

  it('normalizes a last-run cache that already contains a literal null', async () => {
    const s = await load();
    s.setState({ fresh: false });
    mem.set('sable.home', JSON.stringify({ sessions: [{ ...meta('cached'), activity: null, commands: null }] }));
    s.loadCachedHome();
    expect(s.getState().sessions.cached).not.toHaveProperty('activity');
    expect(s.getState().sessions.cached).not.toHaveProperty('commands');
  });

  it('publishes existing work on subscription and socket patches before the hidden page gets a frame', async () => {
    const s = await load();
    const send = vi.fn();
    s.setState({ conn: 'open', fresh: true, listAt: 1, notify: true, sessions: { a: { ...meta('a'), status: 'running' } } });
    const stop = s.watchLive(send);
    try {
      expect(send.mock.lastCall?.[0]).toMatchObject({ chats: 1, chat: 'a', text: 'Working' });
      const since = send.mock.lastCall![0].since;
      s.applyEventSoon({ type: 'session.updated', id: 'a', patch: { status: 'idle', commands: 1 } });
      expect(send.mock.lastCall?.[0]).toMatchObject({ chats: 1, text: '1 command running', since });
      s.applyEventSoon({ type: 'session.updated', id: 'a', patch: { commands: null } });
      expect(send.mock.lastCall).toEqual([null, false]);
      s.applyEventSoon({ type: 'session.updated', id: 'a', patch: { status: 'starting' } });
      expect(send.mock.lastCall?.[0]).toMatchObject({ chats: 1, text: 'Starting' });
      for (const update of [{ notify: false }, { notify: true, fresh: false }, { fresh: true, conn: 'offline' }, { conn: 'unpaired' }]) {
        s.setState(update);
        expect(send.mock.lastCall).toEqual([null, true]);
      }
      s.setState({ conn: 'open', notify: undefined });
      expect(send.mock.lastCall).toEqual([null, true]);
      s.setState({ notify: true });
      expect(send.mock.lastCall?.[0]).toMatchObject({ chat: 'a', chats: 1 });
    } finally {
      stop();
    }
  });
});

it('keeps Open on a closed socket or refused answer and clears only the old post when the desktop answered first', async () => {
  const s = await load();
  const modulePath = '../mobile/src/lib/note-answer';
  const { answerFromNote } = await import(/* @vite-ignore */ modulePath);
  const action = { sessionId: 'a', requestId: 'r', optionId: 'yes', verb: 'allow', noteId: 23, detail: 'go', token: 'post-r', deviceId: 'phone' };
  const req = { id: 'r', sessionId: 'a', title: 'go', detail: {}, options: [{ id: 'yes', label: 'Allow once', tone: 'allow' }, { id: 'no', label: 'Deny', tone: 'deny' }] };
  const call = vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValue({ ok: false });
  fake.cleared.mockClear();
  fake.conn.call = call;
  fake.conn.pairing = { deviceId: 'phone' };
  s.setState({ conn: 'offline', fresh: true, notify: true, listAt: 1, pending: { permissions: [req], questions: [] } });
  await answerFromNote(action);
  expect(call).not.toHaveBeenCalled();
  s.setState({ conn: 'open' });
  await answerFromNote(action);
  expect(call).toHaveBeenCalledExactlyOnceWith('permission.respond', { sessionId: 'a', requestId: 'r', optionId: 'yes' });
  expect(fake.cleared).not.toHaveBeenCalled();
  await answerFromNote(action);
  expect(fake.cleared).toHaveBeenCalledExactlyOnceWith(action);
  s.setState({ pending: { permissions: [], questions: [] } });
  await answerFromNote(action);
  expect(call).toHaveBeenCalledTimes(2);
  expect(fake.cleared).toHaveBeenCalledTimes(2);
  fake.conn.pairing = undefined;
});
const perm = (id: string, sessionId = 'a') => ({ id, sessionId, tool: 'Bash', title: 'Run', input: {} }) as unknown as PermissionRequest;
const hello = (over: Record<string, unknown> = {}) => ({ sessions: [meta('a')], providers: [], projects: [], settings: {}, version: 'x', ...over });
const tick = () => new Promise((r) => setTimeout(r, 0));
/** A call that answers when `open()` is called. */
function gate<T>(value: T) {
  let open!: () => void;
  const p = new Promise<T>((r) => (open = () => r(value)));
  return { p, open };
}

describe("the chats' list in pages", () => {
  it('is read to its end and merged by id', async () => {
    const store = await load();
    fake.conn.call = async (method, p) => {
      if (method === 'app.hello') return hello({ sessions: [meta('a'), meta('b')], sessionsCursor: '2:c' });
      if (method === 'phone.sessions') return p.cursor === '2:c' ? { sessions: [meta('b'), meta('c')], cursor: '4:e', total: 5 } : { sessions: [meta('e')], total: 5 };
      throw new Error(`unexpected ${method}`);
    };
    expect(await store.refresh([])).toEqual({ complete: true });
    expect(Object.keys(store.getState().sessions).sort()).toEqual(['a', 'b', 'c', 'e']);
  });

  it('not read to its end: the chats known before stay, and it says so', async () => {
    const store = await load();
    store.setState({ sessions: { old: meta('old'), a: meta('a') } });
    fake.conn.call = async (method) => {
      if (method === 'app.hello') return hello({ sessionsCursor: '1:b' });
      if (method === 'phone.sessions') throw new Error('The connection to the desktop was lost');
      throw new Error(`unexpected ${method}`);
    };
    expect(await store.refresh([])).toEqual({ complete: false });
    expect(Object.keys(store.getState().sessions).sort()).toEqual(['a', 'old']);
  });

  it('a chat added while the next page is on its way stays', async () => {
    const store = await load();
    const page = gate({ sessions: [meta('b')], total: 2 });
    fake.conn.call = async (method) => {
      if (method === 'app.hello') return hello({ sessionsCursor: '1:b' });
      if (method === 'phone.sessions') return page.p;
      throw new Error(`unexpected ${method}`);
    };
    const done = store.refresh([]);
    await tick();
    store.applyEvent({ type: 'session.added', session: meta('new') });
    page.open();
    expect(await done).toEqual({ complete: true });
    expect(Object.keys(store.getState().sessions).sort()).toEqual(['a', 'b', 'new']);
  });
});

describe('what waits, in pages', () => {
  it('one answered while the next page is on its way is not put back', async () => {
    const store = await load();
    const page = gate({ permissions: [perm('p2'), perm('p3')], questions: [], permissionsTotal: 3, questionsTotal: 0 });
    fake.conn.call = async (method) => {
      if (method === 'app.hello') return hello({ prompts: { permissions: [perm('p1')], questions: [] }, promptsCursor: '1:p2' });
      if (method === 'phone.prompts') return page.p;
      throw new Error(`unexpected ${method}`);
    };
    const done = store.refresh([]);
    await tick();
    await tick();
    store.applyEvent({ type: 'permission.removed', sessionId: 'a', id: 'p2' });
    page.open();
    await done;
    expect(store.getState().pending.permissions.map((p) => p.id)).toEqual(['p1', 'p3']);
  });

  it("a chat's own: its page shows at once, the rest is added, an answered one stays answered", async () => {
    const store = await load();
    store.setState({ sessions: { a: meta('a') } });
    const page = gate({ permissions: [perm('p2'), perm('p3')], questions: [], permissionsTotal: 3, questionsTotal: 0 });
    fake.conn.call = async (method) => {
      if (method === 'phone.tail') return { session: meta('a'), items: [], total: 0, permissions: [perm('p1')], questions: [], queue: [], todos: [], promptsCursor: '1:p2' };
      if (method === 'phone.prompts') return page.p;
      throw new Error(`unexpected ${method}`);
    };
    await store.openSession('a');
    // Shown before the rest came.
    expect(store.getState().data.a.permissions.map((p) => p.id)).toEqual(['p1']);
    store.applyEvent({ type: 'permission.removed', sessionId: 'a', id: 'p3' });
    page.open();
    await tick();
    await tick();
    expect(store.getState().data.a.permissions.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(store.getState().pending.permissions.map((p) => p.id)).toContain('p2');
    expect(store.getState().pending.permissions.map((p) => p.id)).not.toContain('p3');
  });
});

describe('Forget while a load is on its way', () => {
  it('applies nothing of it', async () => {
    const store = await load();
    store.setState({ sessions: {}, data: {}, pending: { permissions: [], questions: [] } });
    const first = gate(hello({ sessions: [meta('secret')] }));
    fake.conn.call = async (method) => {
      if (method === 'app.hello') return first.p;
      if (method === 'phone.tail') return { session: meta('secret'), items: [], total: 0, permissions: [], questions: [], queue: [], todos: [] };
      throw new Error(`unexpected ${method}`);
    };
    const done = store.refresh([]);
    const opened = store.openSession('secret');
    // Forget moves the pairing's generation on before what was kept is erased.
    bumpEpoch();
    first.open();
    expect(await done).toEqual({ complete: false });
    await opened;
    expect(store.getState().sessions.secret).toBeUndefined();
    expect(store.getState().data.secret).toBeUndefined();
  });
});

describe('steps under a root in view while the pages stop before the newest (#16)', () => {
  it('are bounded per parent too, and counted on it past the bound', async () => {
    type Deep = { items: Record<string, { kids?: number }>; children: Record<string, string[]>; next?: string };
    const store = (await load()) as unknown as Omit<Store, 'getState'> & { openAt: (id: string, itemId: string) => Promise<'here' | 'gone'>; LATE_KIDS_MAX: number; getState: () => { data: Record<string, Deep> } };
    const roots: Record<string, unknown>[] = Array.from({ length: 200 }, (_, n) => ({ id: `r${n}`, ts: n, type: 'user', text: `m${n}` }));
    // A sub-agent still working, within the window opened around r20.
    roots[22] = { id: 'agent', ts: 22, type: 'tool', name: 'Task', kind: 'agent', title: 'Agent', status: 'running', detail: {} };
    store.setState({ sessions: { deep: meta('deep') } });
    fake.conn.call = async (method, p) => {
      if (method !== 'phone.tail') throw new Error(`unexpected ${method}`);
      const at = roots.findIndex((r) => r.id === p.around);
      const s = Math.max(0, at - 10);
      const e = Math.min(roots.length, s + 40);
      return { session: meta('deep'), items: roots.slice(s, e), total: roots.length, cursor: roots[s].id, ...(e < roots.length ? { next: roots[e].id } : {}), at: p.around, permissions: [], questions: [], queue: [], todos: [] };
    };
    expect(await store.openAt('deep', 'r20')).toBe('here');
    expect(store.getState().data.deep.next).toBeDefined();
    const steps = store.LATE_KIDS_MAX + 250;
    for (let k = 0; k < steps; k++) store.applyEvent({ type: 'item.added', sessionId: 'deep', item: { id: `s${k}`, ts: k, type: 'tool', parentId: 'agent', name: 'Bash', kind: 'bash', title: 'ls', status: 'done', detail: {} } });
    await tick();
    const d = store.getState().data.deep;
    expect(d.children.agent.length).toBe(store.LATE_KIDS_MAX);
    expect(d.items.agent.kids).toBe(steps);
    expect(Object.keys(d.items).length).toBeLessThan(40 + store.LATE_KIDS_MAX + 10);
  });
});
