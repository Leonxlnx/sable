/**
 * The phone app's side of review wave 4: search that goes on until the desktop says it is whole (22),
 * a bounded live buffer while a chat is read far back, and spacer sums kept between scroll frames
 * (23), and notifications posted one at a time, none left after Forget (25). Pure modules and the
 * phone's store over a fake connection; no device.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PhoneSearch, PhoneSearchHit, SessionMeta, TimelineItem } from '@shared/protocol';
import { AUTO_ROUNDS, nothingFound, searchMessages, skippedLine, type Found, type SearchCall } from '../mobile/src/lib/search';
import { NoteBook } from '../mobile/src/lib/note-book';
import { NotePoster, SUMMARY_ID, type NoteApi } from '../mobile/src/lib/note-post';
import { GUESS, spacers, SpacerSums } from '../mobile/src/lib/window';

const tick = () => new Promise((r) => setTimeout(r, 0));

// ── the phone's store, over a fake desktop ──

type Page = { session: SessionMeta; items: TimelineItem[]; cursor?: string; next?: string; total: number; at?: string; permissions: []; questions: []; queue: []; todos: [] };
const fake = vi.hoisted(() => ({
  conn: {
    state: 'open',
    pairing: undefined as unknown,
    on: () => {},
    onState: () => {},
    call: (async () => {
      throw new Error('no desktop');
    }) as (method: string, params: Record<string, string | undefined>) => Promise<unknown>,
  },
}));
vi.mock('../mobile/src/lib/conn', () => ({ conn: fake.conn }));
vi.mock('../mobile/src/lib/native', () => ({ clearChatNotifications: () => {}, clearShortcuts: () => {} }));
vi.mock('@desk/features/timeline/lead-in', async () => await import('../src/features/timeline/lead-in'));

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) });
vi.stubGlobal('window', globalThis);
vi.stubGlobal('requestAnimationFrame', (f: () => void) => setTimeout(f, 0));
vi.stubGlobal('cancelAnimationFrame', (h: ReturnType<typeof setTimeout>) => clearTimeout(h));

interface StoreData {
  items: Record<string, TimelineItem>;
  roots: string[];
  children: Record<string, string[]>;
  next?: string;
}
// Loaded by a path the root type check does not follow (the store's grouping resolves `@desk` through the phone's config).
const STORE = '../mobile/src/lib/store';
const store = (await import(/* @vite-ignore */ STORE)) as {
  openAt: (id: string, itemId: string) => Promise<'here' | 'gone'>;
  fetchNewer: (id: string) => Promise<boolean>;
  closeGap: (id: string) => Promise<void>;
  applyEvent: (e: unknown) => void;
  getState: () => { data: Record<string, StoreData> };
};

/** The desktop's chats (root items only; a page is a slice of them) and a gate that holds its answers. */
const desk = new Map<string, TimelineItem[]>();
let hold: Promise<void> | null = null;
const metaOf = (id: string) => ({ id, title: 'A long chat', provider: 'demo', cwd: '/x', status: 'running', createdAt: 1, updatedAt: 1 }) as unknown as SessionMeta;
fake.conn.call = async (method, p) => {
  if (method !== 'phone.tail') throw new Error(`unexpected ${method}`);
  const roots = desk.get(p.sessionId!)!;
  const idx = (id: string) => roots.findIndex((r) => r.id === id);
  let s: number;
  let e: number;
  if (p.around) {
    const at = idx(p.around);
    s = Math.max(0, at - 10);
    e = Math.min(roots.length, at + 30);
  } else if (p.after) {
    s = idx(p.after);
    if (s < 0) throw new Error('That message is no longer in this chat.');
    e = Math.min(roots.length, s + 40);
  } else {
    e = roots.length;
    s = Math.max(0, e - 40);
  }
  // Made when asked; answered when the gate opens (events may arrive meanwhile).
  const page: Page = { session: metaOf(p.sessionId!), items: roots.slice(s, e), total: roots.length, ...(s > 0 ? { cursor: roots[s].id } : {}), ...(e < roots.length ? { next: roots[e].id } : {}), ...(p.around ? { at: p.around } : {}), permissions: [], questions: [], queue: [], todos: [] };
  if (hold) await hold;
  return page;
};

let made = 0;
const root = (): TimelineItem => {
  const n = made++;
  return (n % 2 ? { id: `r${n}`, ts: n, type: 'text', text: `answer ${n}` } : { id: `r${n}`, ts: n, type: 'user', text: `message ${n}` }) as TimelineItem;
};
/** The desktop adds a root to a chat, and the phone hears it live. */
const arrive = (sid: string) => {
  const it = root();
  desk.get(sid)!.push(it);
  store.applyEvent({ type: 'item.added', sessionId: sid, item: it });
  return it;
};
const chat = (sid: string, n: number) => {
  desk.set(sid, Array.from({ length: n }, root));
  return desk.get(sid)!;
};
/** Reads on toward the newest until the pages here reach it. */
async function readOn(sid: string) {
  for (let i = 0; i < 1000 && store.getState().data[sid]?.next; i++) await store.fetchNewer(sid);
  expect(store.getState().data[sid].next).toBeUndefined();
}
/** The phone's roots are the desktop's, from where they start to the newest, each once. */
const whole = (sid: string) => {
  const roots = store.getState().data[sid].roots;
  const all = desk.get(sid)!.map((r) => r.id);
  expect(roots).toEqual(all.slice(all.indexOf(roots[0])));
};

describe('a message the agent takes while the phone reads far back', () => {
  /** The desktop moves a root to the end (`SessionRuntime.taken`), and the phone hears the pair of events. */
  const take = (sid: string, id: string) => {
    const roots = desk.get(sid)!;
    const at = roots.findIndex((r) => r.id === id);
    const [it] = roots.splice(at, 1);
    roots.push(it);
    store.applyEvent({ type: 'item.removed', sessionId: sid, id, moving: true });
    store.applyEvent({ type: 'item.added', sessionId: sid, item: it, moved: true });
  };

  it('the root the next page started at moves to the end: reading on skips nothing', async () => {
    const roots = chat('steer', 200);
    await store.openAt('steer', roots[100].id);
    const next = store.getState().data.steer.next!;
    expect(next).toBeTruthy();
    for (let k = 0; k < 5; k++) arrive('steer');
    take('steer', next);
    // The page after here no longer starts at the moved root.
    expect(store.getState().data.steer.next).toBe(store.getState().data.steer.roots.at(-1));
    await readOn('steer');
    whole('steer');
    expect(store.getState().data.steer.roots.at(-1)).toBe(next);
  });

  it('a root held for later that moves stands once, at the end', async () => {
    const roots = chat('held', 200);
    await store.openAt('held', roots[100].id);
    const sent = arrive('held');
    for (let k = 0; k < 4; k++) arrive('held');
    take('held', sent.id);
    await readOn('held');
    whole('held');
    const mine = store.getState().data.held.roots.filter((r) => r === sent.id);
    expect(mine).toHaveLength(1);
    expect(store.getState().data.held.roots.at(-1)).toBe(sent.id);
  });

  it('at the newest the message simply moves to the end', async () => {
    const roots = chat('live', 30);
    await store.openAt('live', roots[20].id);
    await readOn('live');
    const sent = arrive('live');
    arrive('live');
    take('live', sent.id);
    whole('live');
  });
});

describe('reading a chat far back while it runs (23)', () => {
  it('keeps a bounded live buffer, and reading on brings every root that came meanwhile', async () => {
    const roots = chat('long', 2000);
    expect(await store.openAt('long', roots[100].id)).toBe('here');
    expect(store.getState().data.long.next).toBeTruthy();
    // A long-running chat adds 3000 roots (with a step under some) while the phone reads the old hit.
    for (let k = 0; k < 3000; k++) {
      const it = arrive('long');
      if (k % 10 === 0) store.applyEvent({ type: 'item.added', sessionId: 'long', item: { id: `${it.id}-step`, ts: 0, type: 'tool', parentId: it.id, name: 'Bash', kind: 'bash', title: 'ls', status: 'done', detail: {} } });
    }
    const d = store.getState().data.long;
    expect(Object.keys(d.items).length).toBeLessThan(400);
    expect(d.roots.length).toBeLessThan(100);
    await readOn('long');
    whole('long');
  });

  it('a page that reaches the newest while roots are let go goes on from what it has (nothing lost, nothing twice)', async () => {
    const roots = chat('race', 200);
    await store.openAt('race', roots[150].id);
    for (let k = 0; k < 10; k++) arrive('race');
    // The page to the newest is made, then hundreds more roots arrive before it lands.
    let open!: () => void;
    hold = new Promise<void>((r) => (open = r));
    const landing = store.fetchNewer('race');
    await tick();
    for (let k = 0; k < 500; k++) arrive('race');
    hold = null;
    open();
    await landing;
    // It reached the newest as it was made, but roots were let go meanwhile: the gap stays, on from its last root.
    expect(store.getState().data.race.next).toBe(desk.get('race')![209].id);
    await readOn('race');
    whole('race');
    // Live again: the next root follows at once.
    arrive('race');
    whole('race');
  });

  it('the jump to the newest asks for the newest page', async () => {
    const roots = chat('jump', 300);
    await store.openAt('jump', roots[20].id);
    for (let k = 0; k < 400; k++) arrive('jump');
    await store.closeGap('jump');
    const d = store.getState().data.jump;
    expect(d.next).toBeUndefined();
    expect(d.roots.at(-1)).toBe(desk.get('jump')!.at(-1)!.id);
  });
});

describe('spacers while scrolling (23)', () => {
  const keys = Array.from({ length: 5000 }, (_, i) => `t${i}`);
  const near = (a: { top: number; bottom: number }, b: { top: number; bottom: number }) => {
    expect(Math.abs(a.top - b.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(a.bottom - b.bottom)).toBeLessThanOrEqual(1);
  };

  it('are the sums of the heights outside the window, as measured, else their average, else a guess', () => {
    const sums = new SpacerSums();
    expect(sums.of(keys.slice(0, 4), { lo: 1, hi: 3 })).toEqual({ top: GUESS, bottom: GUESS });
    const plain = new Map<string, number>();
    for (let i = 0; i < keys.length; i += 3) {
      sums.set(keys[i], 100 + (i % 7));
      plain.set(keys[i], 100 + (i % 7));
    }
    for (const r of [{ lo: 0, hi: 72 }, { lo: 2000, hi: 2072 }, { lo: 4928, hi: 5000 }, { lo: 0, hi: 5000 }]) near(sums.of(keys, r), spacers(keys, r, plain));
  });

  it('are summed again only when the groups or a height change, not on every frame', () => {
    const sums = new SpacerSums();
    for (let i = 0; i < keys.length; i += 2) sums.set(keys[i], 200);
    sums.of(keys, { lo: 0, hi: 72 });
    const built = sums.builds;
    for (let f = 0; f < 600; f++) sums.of(keys, { lo: 2000 + (f % 50), hi: 2072 + (f % 50) });
    expect(sums.builds).toBe(built);
    // The same height again changes nothing; a new one, new groups or a clear sum again once.
    sums.set(keys[0], 200);
    sums.of(keys, { lo: 10, hi: 20 });
    expect(sums.builds).toBe(built);
    sums.set(keys[1], 120);
    const a = sums.of(keys, { lo: 10, hi: 20 });
    sums.of(keys, { lo: 11, hi: 21 });
    expect(sums.builds).toBe(built + 1);
    expect(a.top).toBe(Math.round(200 * 5 + 120 + (4 * (200 * 2500 + 120)) / 2501));
    const more = [...keys, 't5000'];
    sums.of(more, { lo: 0, hi: 1 });
    expect(sums.builds).toBe(built + 2);
    sums.clear();
    expect(sums.of(more, { lo: 0, hi: 1 }).bottom).toBe(5000 * GUESS);
  });
});

// ── search (22) ──

const hit = (n: number): PhoneSearchHit => ({ sessionId: `s${n}`, itemId: `i${n}`, role: 'agent', text: `match ${n}`, ts: n });

/** A desktop whose search takes `slices` calls, partial (with its cursor) until the last; the hits add up, a match in each slice of `at`. */
function desktop(slices: number, at: number[], skipped?: number) {
  const calls: { query: string; cursor?: string }[] = [];
  const call: SearchCall = async (p) => {
    calls.push(p);
    const n = calls.length;
    const r: PhoneSearch = { hits: at.filter((s) => s <= n).map(hit) };
    if (n < slices) Object.assign(r, { partial: true, cursor: 'run1' });
    if (skipped && n >= 2) r.skipped = skipped;
    return r;
  };
  return { call, calls };
}

describe('message search on the phone (22)', () => {
  it('goes on past four partial answers until the desktop says it is whole, never saying nothing meanwhile', async () => {
    const d = desktop(7, [5]);
    const shown: Found[] = [];
    await searchMessages(d.call, 'lynx', () => true, (f) => shown.push(f));
    expect(d.calls).toHaveLength(7);
    const last = shown.at(-1)!;
    expect(last.hits.map((h) => h.itemId)).toEqual(['i5']);
    expect(last.busy).toBe(false);
    for (const f of shown.slice(0, -1)) {
      expect(f.busy).toBe(true);
      expect(nothingFound(f)).toBe(false);
    }
    expect(nothingFound(last)).toBe(false);
  });

  it('passes the cursor back (the desktop also goes on for the same phone without it)', async () => {
    const d = desktop(3, []);
    const shown: Found[] = [];
    await searchMessages(d.call, 'lynx', () => true, (f) => shown.push(f));
    expect(d.calls).toEqual([{ query: 'lynx' }, { query: 'lynx', cursor: 'run1' }, { query: 'lynx', cursor: 'run1' }]);
    expect(nothingFound(shown.at(-1)!)).toBe(true);
  });

  it('says how many chats could not be read', async () => {
    const d = desktop(3, [1], 2);
    const shown: Found[] = [];
    await searchMessages(d.call, 'lynx', () => true, (f) => shown.push(f));
    expect(shown.at(-1)!.skipped).toBe(2);
    expect(skippedLine(2)).toBe('2 chats could not be read.');
    expect(skippedLine(1)).toBe('1 chat could not be read.');
  });

  it('a search that does not end on its own pauses with a way on, and goes on from there when asked', async () => {
    const d = desktop(Infinity, [AUTO_ROUNDS + 5]);
    const shown: Found[] = [];
    await searchMessages(d.call, 'lynx', () => true, (f) => shown.push(f));
    expect(d.calls).toHaveLength(AUTO_ROUNDS);
    const paused = shown.at(-1)!;
    expect(paused).toMatchObject({ busy: false, more: true, hits: [] });
    expect(nothingFound(paused)).toBe(false);
    // "Search further"
    await searchMessages(d.call, 'lynx', () => shown.length < AUTO_ROUNDS + 10, (f) => shown.push(f), paused);
    expect(d.calls[AUTO_ROUNDS]).toEqual({ query: 'lynx', cursor: 'run1' });
    expect(shown.at(-1)!.hits.map((h) => h.itemId)).toEqual([`i${AUTO_ROUNDS + 5}`]);
  });

  it('stops once the answer is no longer wanted', async () => {
    const d = desktop(10, []);
    let live = true;
    await searchMessages(d.call, 'lynx', () => live, () => (live = false));
    expect(d.calls).toHaveLength(1);
  });

  it('a desktop without message search hides the section; a failure part way keeps what came, with a way on', async () => {
    const shown: Found[] = [];
    await searchMessages(async () => Promise.reject(new Error('Not available from the phone')), 'lynx', () => true, (f) => shown.push(f));
    expect(shown.at(-1)).toMatchObject({ off: true });
    let n = 0;
    const flaky: SearchCall = async () => {
      if (++n === 3) throw new Error('The desktop did not answer in time');
      return { hits: [hit(1)], partial: true, cursor: 'run1' };
    };
    await searchMessages(flaky, 'lynx', () => true, (f) => shown.push(f));
    expect(shown.at(-1)).toMatchObject({ busy: false, more: true, hits: [hit(1)] });
    expect(shown.at(-1)!.off).toBeUndefined();
  });
});

// ── notifications (25) ──

/** Android's notifications as the poster sees them: what is shown, every post, and a gate on posting. */
function android() {
  const shown = new Map<number, { chats?: number }>();
  const posts: { id: number; chats: number }[] = [];
  const st = { posting: 0, hold: null as Promise<void> | null };
  const api: NoteApi = {
    allowed: async () => (await tick(), true),
    prepare: async () => void (await tick()),
    delivered: async () => (await tick(), [...shown.keys()]),
    cancel: async (ids) => {
      await tick();
      // Cancelling the summary takes its group with it.
      for (const id of ids) id === SUMMARY_ID ? shown.clear() : shown.delete(id);
    },
    post: async (n, chats) => {
      st.posting++;
      if (st.hold) await st.hold;
      await tick();
      posts.push({ id: n.id, chats });
      shown.set(n.id, {});
      if (chats > 1) shown.set(SUMMARY_ID, { chats });
    },
    clearAll: async () => {
      await tick();
      shown.clear();
    },
  };
  return { api, shown, posts, st };
}
const idFor = (sid: string) => 100 + sid.charCodeAt(sid.length - 1);
const memStore = () => {
  let v: string | null = null;
  return { get: () => v, set: (x: string) => void (v = x) };
};
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await tick();
  expect(ok()).toBe(true);
};
const setup = () => {
  const a = android();
  const book = new NoteBook(memStore(), idFor);
  return { ...a, book, poster: new NotePoster(a.api, book, idFor) };
};

describe('notifications grouped under Sable (25)', () => {
  it('two chats that finish together are posted one after the other, the second with the summary of two', async () => {
    const { poster, shown, book } = setup();
    await Promise.all([poster.notify('A', 'Done', 'chat-a', 'done'), poster.notify('B', 'Done', 'chat-b', 'done')]);
    expect(shown.get(SUMMARY_ID)).toEqual({ chats: 2 });
    expect(book.list()).toEqual(['chat-a', 'chat-b']);
  });

  it('a post still on its way when the desktop is forgotten is taken back, and never written down', async () => {
    const { poster, shown, book, st } = setup();
    let open!: () => void;
    st.hold = new Promise<void>((r) => (open = r));
    const going = poster.notify('A', 'Done', 'chat-a', 'done');
    await until(() => st.posting === 1);
    await poster.clear();
    open();
    await going;
    expect(shown.size).toBe(0);
    expect(book.size).toBe(0);
  });

  it('one waiting behind it then is never posted; after Forget the next posts as usual', async () => {
    const { poster, shown, posts, book, st } = setup();
    let open!: () => void;
    st.hold = new Promise<void>((r) => (open = r));
    const first = poster.notify('A', 'Done', 'chat-a', 'done');
    const second = poster.notify('B', 'Waiting for you', 'chat-b', 'waiting');
    await until(() => st.posting === 1);
    void poster.clear();
    st.hold = null;
    open();
    await Promise.all([first, second]);
    expect(posts.map((p) => p.id)).toEqual([idFor('chat-a')]);
    expect(shown.size).toBe(0);
    await poster.notify('C', 'Done', 'chat-c', 'done');
    expect([...shown.keys()]).toEqual([idFor('chat-c')]);
    expect(book.list()).toEqual(['chat-c']);
  });

  it('a chat opened while its notification goes up loses it once it is up', async () => {
    const { poster, shown, book, st } = setup();
    let open!: () => void;
    st.hold = new Promise<void>((r) => (open = r));
    const going = poster.notify('A', 'Done', 'chat-a', 'done');
    await until(() => st.posting === 1);
    const cleared = poster.clearOne('chat-a');
    open();
    await Promise.all([going, cleared]);
    expect(shown.size).toBe(0);
    expect(book.size).toBe(0);
  });
});
