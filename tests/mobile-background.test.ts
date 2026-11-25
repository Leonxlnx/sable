/**
 * Phone 2.18, off screen while chats work (android/…/PageLife.java keeps the page from being frozen
 * then, so its visibility no longer says whether anyone looks; lib/screen.ts does):
 * - a chat opened while the app is off screen (a reconnect, a stale page fetched again) is only
 *   peeked at: the desktop keeps it unread and the phone keeps the page as one from the cache;
 * - a lost connection while chats work keeps the live notification as "reconnecting" (no cards, no
 *   stale "Working") instead of stopping it, which let Android stop the service and freeze the page;
 *   so does the moment between a new socket and its list.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '@shared/protocol';
import { liveOf, liveStep, type LiveTrack } from '../mobile/src/lib/notes';

const fake = vi.hoisted(() => ({
  calls: [] as { method: string; params: Record<string, unknown> }[],
  conn: {
    state: 'open',
    pairing: undefined as unknown,
    on: () => {},
    onState: () => {},
    call: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      fake.calls.push({ method, params });
      if (method === 'app.hello') return { sessions: [fake.meta('a')], providers: [], projects: [], version: 'test' };
      if (method === 'usage.limits') return [];
      if (method === 'phone.tail' || method === 'session.snapshot') return { session: fake.meta(String(params.sessionId)), items: [], permissions: [], questions: [], queue: [], todos: [] };
      throw new Error(`unexpected ${method}`);
    },
  },
  meta: (id: string, more: Record<string, unknown> = {}) => ({ id, title: id, provider: 'demo', cwd: '/x', status: 'idle', createdAt: 1, updatedAt: 1, ...more }) as unknown as SessionMeta,
}));
vi.mock('../mobile/src/lib/conn', () => ({ conn: fake.conn }));
vi.mock('../mobile/src/lib/native', () => ({
  clearAnsweredNote: () => {},
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

type Spec = { chats: number; waiting: number; lost?: number; cards?: unknown[] } | null;
type Store = {
  watchLive: (send: (spec: Spec, stop: boolean) => void) => () => void;
  refresh: (open: string[]) => Promise<{ complete: boolean }>;
  openSession: (id: string) => Promise<void>;
  getState: () => { data: Record<string, { cached?: boolean }> };
  setState: (p: Record<string, unknown>) => void;
};
// By a name in a variable: the root type-check does not follow it into the phone's own aliases.
const STORE = '../mobile/src/lib/store';
const SCREEN = '../mobile/src/lib/screen';
const load = async () => (await import(/* @vite-ignore */ STORE)) as Store;
const screen = async () => (await import(/* @vite-ignore */ SCREEN)) as { setScreen: (on: boolean) => void; onScreen: () => boolean };

const tails = () => fake.calls.filter((c) => c.method === 'phone.tail');

describe('a chat opened while nobody looks', () => {
  it('is only peeked at off screen (the desktop keeps it unread) and read once back on screen', async () => {
    const s = await load();
    const sc = await screen();
    sc.setScreen(false);
    fake.calls.length = 0;
    await s.openSession('a');
    expect(tails()).toHaveLength(1);
    expect(tails()[0].params).toMatchObject({ sessionId: 'a', peek: true });
    // Kept as a page from the cache: not the truth for the live card, read again on return (App.tsx).
    expect(s.getState().data.a.cached).toBe(true);

    sc.setScreen(true);
    fake.calls.length = 0;
    await s.openSession('a');
    expect(tails()[0].params).not.toHaveProperty('peek');
    expect(s.getState().data.a.cached).toBeUndefined();
  });

  it('a reconnect off screen brings the list and the open chats back without reading them', async () => {
    const s = await load();
    const sc = await screen();
    sc.setScreen(false);
    fake.calls.length = 0;
    await s.refresh(['a']);
    expect(fake.calls.map((c) => c.method)).toContain('app.hello');
    expect(tails().map((c) => c.params.peek)).toEqual([true]);
    sc.setScreen(true);
  });
});

describe('the live notification across a lost connection', () => {
  const settings = { notify: true, fresh: true, conn: 'open', listAt: 1 };
  const working = liveOf([fake.meta('a', { status: 'running' })], [], 1);
  const none = liveOf([], [], 1);
  const start: LiveTrack = { worked: false, lostAt: 0 };

  it('says it reconnects (no cards) while chats worked, from the time it was lost, instead of stopping', () => {
    const a = liveStep(settings, working, start, 10);
    expect(a.spec?.chats).toBe(1);
    expect(a.stop).toBe(false);
    const b = liveStep({ ...settings, conn: 'offline', listAt: undefined }, none, a.track, 20);
    expect(b).toMatchObject({ spec: { chats: 0, waiting: 0, lost: 20 }, stop: false });
    expect(b.spec).not.toHaveProperty('cards');
    // Still lost later: the same time (Android counts its ten minutes from it).
    const c = liveStep({ ...settings, conn: 'connecting', listAt: undefined }, none, b.track, 90_000);
    expect(c.spec?.lost).toBe(20);
    // A new socket whose list is not read yet is still lost, not a stop.
    const d = liveStep({ ...settings, conn: 'open', listAt: undefined }, none, c.track, 95_000);
    expect(d.spec?.lost).toBe(20);
    // Back: the work again.
    const e = liveStep(settings, working, d.track, 100_000);
    expect(e.spec).toMatchObject({ chats: 1 });
    expect(e.spec).not.toHaveProperty('lost');
    expect(e.track).toEqual({ worked: true, lostAt: 0 });
  });

  it('stops when nothing worked, when notifications are off, or when the phone was removed or forgotten', () => {
    expect(liveStep({ ...settings, conn: 'offline' }, none, start, 5)).toMatchObject({ spec: null, stop: true });
    const worked = liveStep(settings, working, start, 1).track;
    expect(liveStep({ ...settings, conn: 'offline', notify: false }, none, worked, 5)).toMatchObject({ spec: null, stop: true });
    expect(liveStep({ ...settings, conn: 'denied' }, none, worked, 5)).toMatchObject({ spec: null, stop: true });
    expect(liveStep({ ...settings, conn: 'unpaired' }, none, worked, 5)).toMatchObject({ spec: null, stop: true });
    // Connected with nothing at work: nothing, no stop (the service lingers its minute).
    expect(liveStep(settings, none, worked, 5)).toMatchObject({ spec: null, stop: false, track: { worked: false } });
  });

  it('the store tells Android "reconnecting" when the socket goes while a chat works (it used to send a stop)', async () => {
    const s = await load();
    const sent: [Spec, boolean][] = [];
    s.setState({ notify: true, fresh: true, conn: 'open', listAt: 1, sessions: { a: fake.meta('a', { status: 'running' }) } });
    const off = s.watchLive((spec, stop) => sent.push([spec, stop]));
    expect(sent.at(-1)?.[0]?.chats).toBe(1);
    s.setState({ conn: 'offline', listAt: undefined });
    const [spec, stop] = sent.at(-1)!;
    expect(stop).toBe(false);
    expect(spec).toMatchObject({ chats: 0, waiting: 0 });
    expect(typeof spec?.lost).toBe('number');
    off();
  });
});
