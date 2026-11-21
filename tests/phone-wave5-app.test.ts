/**
 * The phone app's side of review wave 5, pure modules and the store over a fake desktop: a queued
 * message taken back is kept on the phone before the desktop lets it go (20); Forget erases the
 * pairing's storage whatever loaded, and work begun before writes nothing back (10, 11); the web
 * sink reserves a file's size when it admits it, and downloads start one at a time, waiting out
 * "another download is starting" (22); a file already verified is never fetched or published twice,
 * a copy that could not be published says so, and a private copy goes with its record (25); over a
 * pairing from before the secure channel nothing is transferred (19); steps under a root held while
 * a chat is read far back are bounded (24).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PhoneFileStart, SessionMeta, TimelineItem } from '@shared/protocol';
import { confirmTake, KEEP_FAILED_TAKE, takeBack, TAKE_RETRY, type TakeDeps } from '../mobile/src/lib/take';
import { eraseAll, pairingKeys, sweep, type KeyList } from '../mobile/src/lib/erase';
import { epoch } from '../mobile/src/lib/epoch';
import { onForget } from '../mobile/src/lib/forget';
import { transportError, isTransport } from '../mobile/src/lib/errors';
import { memorySink } from '../mobile/src/lib/sink';
import { createDownloads, KEEP, PLAIN_OFF, type Channel, type FilesPlugin } from '../mobile/src/lib/download-core';

const tick = () => new Promise((r) => setTimeout(r, 0));
const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

// ── the store over a fake desktop (as in phone-wave4-app) ──

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
  prefs: new Map<string, string>(),
}));
vi.mock('../mobile/src/lib/conn', () => ({ conn: fake.conn }));
vi.mock('../mobile/src/lib/native', () => ({
  clearChatNotifications: () => {},
  clearShortcuts: () => {},
  loadPref: async (k: string, f: unknown) => (fake.prefs.has(k) ? JSON.parse(fake.prefs.get(k)!) : f),
  durable: async (k: string, v: string | null) => void (v === null ? fake.prefs.delete(k) : fake.prefs.set(k, v)),
}));
vi.mock('@desk/features/timeline/lead-in', async () => await import('../src/features/timeline/lead-in'));

const mem = new Map<string, string>();
const ls: KeyList & { getItem(k: string): string | null; setItem(k: string, v: string): void } = {
  get length() {
    return mem.size;
  },
  key: (i: number) => [...mem.keys()][i] ?? null,
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
};
vi.stubGlobal('localStorage', ls);
vi.stubGlobal('window', globalThis);
vi.stubGlobal('requestAnimationFrame', (f: () => void) => setTimeout(f, 0));
vi.stubGlobal('cancelAnimationFrame', (h: ReturnType<typeof setTimeout>) => clearTimeout(h));

describe('a queued message taken back (20)', () => {
  const deps = (over: Partial<TakeDeps> = {}) => {
    const log: string[] = [];
    const d: TakeDeps = {
      take: async () => (log.push('take'), { message: { text: 'fix the tests' }, take: 'R1' }),
      done: async (take, kept) => (log.push(`done ${take} ${kept}`), { taken: true }),
      stage: async (sid, text, take) => void log.push(`stage ${sid} ${text} ${take}`),
      settle: (take) => void log.push(`settle ${take}`),
      sleep: async () => {},
      ...over,
    };
    return { d, log };
  };

  it('keeps the words on the phone first, then tells the desktop it may let the message go', async () => {
    const { d, log } = deps();
    await expect(takeBack(d, 's', 'q')).resolves.toEqual({ text: 'fix the tests', stillQueued: false });
    expect(log).toEqual(['take', 'stage s fix the tests R1', 'done R1 true', 'settle R1']);
  });

  it('words it could not keep are said back, and the message stays queued', async () => {
    const { d, log } = deps({ stage: async () => Promise.reject(new Error('full')) });
    await expect(takeBack(d, 's', 'q')).rejects.toThrow(KEEP_FAILED_TAKE);
    await tick();
    expect(log).toContain('done R1 false');
    expect(log).not.toContain('done R1 true');
  });

  it('a confirmation the connection cut is sent again (the receipt answers the same), and left for later past a few tries', async () => {
    let n = 0;
    const { d, log } = deps({ done: async (take, kept) => (log.push(`done ${take} ${kept}`), ++n < 2 ? Promise.reject(transportError('The connection to the desktop was lost', 'lost')) : { taken: true }) });
    await expect(takeBack(d, 's', 'q')).resolves.toMatchObject({ stillQueued: false });
    expect(log.filter((l) => l === 'done R1 true')).toHaveLength(2);
    const never = deps({ done: async () => Promise.reject(transportError('Not connected to the desktop', 'unsent')) });
    await expect(confirmTake(never.d, 'R2')).resolves.toBeUndefined();
    expect(never.log).not.toContain('settle R2');
    expect(TAKE_RETRY.length).toBeGreaterThan(0);
  });

  it('a desktop that kept it queued (changed meanwhile) says so; one from before receipts takes it as it did', async () => {
    const kept = deps({ done: async () => ({ taken: false }) });
    await expect(takeBack(kept.d, 's', 'q')).resolves.toEqual({ text: 'fix the tests', stillQueued: true });
    const old = deps({ take: async () => ({ message: { text: 'old' } }) });
    await expect(takeBack(old.d, 's', 'q')).resolves.toEqual({ text: 'old' });
    expect(old.log.some((l) => l.startsWith('done'))).toBe(false);
  });

  it('the staged words go into the draft and a committed copy; after Forget nothing is staged', async () => {
    const drafts = await import('../mobile/src/lib/drafts');
    drafts.drafts.set('s', 'had');
    await drafts.stageTaken('s', 'taken', 'R9');
    expect(JSON.parse(mem.get('sable.drafts')!)).toEqual({ s: 'had\ntaken' });
    expect(JSON.parse(fake.prefs.get(drafts.TAKEN)!)).toMatchObject([{ sid: 's', text: 'taken', take: 'R9' }]);
    expect(await drafts.pendingTakes()).toEqual(['R9']);
    drafts.settleTaken('R9');
    await until(() => !fake.prefs.has(drafts.TAKEN));
    await eraseAll({ storage: ls, native: async () => [] });
    expect(drafts.drafts.size).toBe(0);
  });
});

describe('Forget erases what the pairing kept (10, 11)', () => {
  it('sweeps every key of the pairing from the storage itself (a chat tail with no index too), keeps the phone\'s own settings', async () => {
    mem.clear();
    for (const k of ['sable.home', 'sable.tail.abc', 'sable.drafts', 'sable.reviews', 'sable.nav', 'sable.notified', 'sable.downloads', 'sable.newchat', 'sable.homeFilter', 'sable.something-new']) mem.set(k, '1');
    for (const k of ['sable.diffwrap', 'sable.reviewhint', 'sable.debug.downloadMs', 'other']) mem.set(k, '1');
    expect(pairingKeys(ls).sort()).toHaveLength(10);
    expect(sweep(ls)).toEqual([]);
    expect([...mem.keys()].sort()).toEqual(['other', 'sable.debug.downloadMs', 'sable.diffwrap', 'sable.reviewhint']);
  });

  it('moves the generation on first, runs what loaded, sweeps again after Android (a late write is caught), and says what is left', async () => {
    mem.clear();
    const was = epoch();
    let seen = -1;
    const stop = onForget(() => {
      seen = epoch();
      // A module that writes as it forgets (a save still due).
      mem.set('sable.downloads', '{}');
    });
    // A write still due that lands while Android removes its files (a debounced save): swept again after.
    await expect(eraseAll({ storage: ls, native: async () => (mem.set('sable.drafts', '{"s":"late"}'), []) })).resolves.toEqual([]);
    expect(seen).toBe(was + 1);
    expect(mem.has('sable.downloads')).toBe(false);
    expect(mem.has('sable.drafts')).toBe(false);
    await expect(eraseAll({ storage: ls, native: async () => ['files'] })).resolves.toEqual(['files']);
    stop();
  });

  it('a check still running in the web sink when everything is forgotten keeps nothing', async () => {
    const sink = memorySink({ max: 1000 });
    const bytes = Buffer.from('hello world');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const st = await sink.stageBegin({ key: 'k', name: 'a.txt', size: bytes.length, sha256: sha });
    await sink.stageWrite({ id: st.id, offset: 0, data: bytes.toString('base64') });
    const finishing = sink.stageFinish({ id: st.id });
    sink.forgetAll();
    await expect(finishing).resolves.toEqual({ ok: false });
    expect(sink.used()).toBe(0);
  });
});

/** A desktop's file channel over `bytes`; `busy` makes a start that overlaps another refused as the desktop does. */
function channelOver(bytes: Buffer, opts: { chunk?: number } = {}) {
  let starting = 0;
  let most = 0;
  const seen = { starts: 0, busy: 0, chunks: 0 };
  const ch: Channel & { seen: typeof seen; most: () => number } = {
    secure: () => true,
    async start(): Promise<PhoneFileStart> {
      if (starting > 0) {
        seen.busy++;
        throw new Error('Another download is starting. Try again in a moment.');
      }
      starting++;
      most = Math.max(most, starting);
      seen.starts++;
      await new Promise((r) => setTimeout(r, 15));
      starting--;
      return { transfer: `t${seen.starts}`, name: 'notes.txt', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), chunk: opts.chunk ?? 1000 };
    },
    async chunk(p) {
      seen.chunks++;
      return { data: bytes.subarray(p.offset, p.offset + p.length).toString('base64') };
    },
    async end() {
      return {};
    },
    seen,
    most: () => most,
  };
  return ch;
}

const plugin = (over: Partial<FilesPlugin> = {}): FilesPlugin => ({
  download: async () => ({ id: '1' }),
  status: async () => ({ state: 'done' }),
  cancel: async () => {},
  verify: async () => ({ ok: true }),
  stageBegin: async () => ({ id: 'x', have: 0 }),
  stageWrite: async () => ({ have: 0 }),
  stageFinish: async () => ({ ok: false }),
  stageDrop: async () => {},
  ...over,
});

const body = Buffer.from(Array.from({ length: 2500 }, (_, i) => (i * 7) % 256));

describe('bounds on concurrent work (22)', () => {
  it('the sink reserves a file\'s whole size when it admits it: two that each fit cannot both be under way past the bound', async () => {
    const sink = memorySink({ max: 100 });
    await sink.stageBegin({ key: 'a', name: 'a.bin', size: 60, sha256: 'a'.repeat(64) });
    await expect(sink.stageBegin({ key: 'b', name: 'b.bin', size: 60, sha256: 'b'.repeat(64) })).rejects.toThrow('Not enough space');
    expect(sink.used()).toBe(60);
  });

  it('downloads resumed together start one at a time, and "another download is starting" is waited out, never a failure', async () => {
    const sink = memorySink();
    const ch = channelOver(body);
    const dl = createDownloads({ plugin: { ...plugin(), ...sink }, channel: ch, lost: isTransport, native: true });
    await Promise.all(['k1', 'k2', 'k3'].map((k, i) => dl.start(k, { sid: 's', itemId: 'i', index: i, name: 'notes.txt' })));
    for (const k of ['k1', 'k2', 'k3']) expect(dl.get(k)).toMatchObject({ state: 'done', verified: true });
    expect(ch.most()).toBe(1);
    expect(ch.seen.busy).toBe(0);
    // Another phone's start (or one the desktop still prepares) holds the desktop: the answer is waited out.
    let refused = 0;
    const busy: Channel = {
      ...ch,
      start: async (p) => (refused++ < 2 ? Promise.reject(new Error('Another download is starting. Try again in a moment.')) : ch.start(p)),
    };
    const dl2 = createDownloads({ plugin: { ...plugin(), ...memorySink() }, channel: busy, lost: isTransport, native: true, sleep: async () => {} });
    await dl2.start('k', { sid: 's', itemId: 'i', index: 0, name: 'notes.txt' });
    expect(dl2.get('k').state).toBe('done');
    expect(refused).toBe(3);
  });
});

describe('finishing a download, restart-safe (25)', () => {
  it('a file already verified on the phone is done at once: no chunk asked, nothing published again', async () => {
    const ch = channelOver(body);
    const finish = vi.fn(async () => ({ ok: true, file: 'f1' }));
    const dl = createDownloads({ plugin: plugin({ stageBegin: async () => ({ id: 'f1', have: body.length, file: 'f1', published: true }), stageFinish: finish }), channel: ch, lost: isTransport, native: true });
    await dl.start('k', { sid: 's', itemId: 'i', index: 0, name: 'notes.txt' });
    expect(dl.get('k')).toMatchObject({ state: 'done', verified: true, file: 'f1' });
    expect(ch.seen.chunks).toBe(0);
    expect(finish).not.toHaveBeenCalled();
  });

  it('a copy that could not go to Downloads is said; a record let go takes its private copy with it; at start the files no record names go', async () => {
    const discard = vi.fn(async () => {});
    const prune = vi.fn(async () => {});
    let n = 0;
    const p = plugin({
      stageBegin: async () => ({ id: `s${++n}`, have: 0 }),
      stageWrite: async (o) => ({ have: o.offset + Buffer.from(o.data, 'base64').length }),
      stageFinish: async (o) => ({ ok: true, file: o.id, published: false }),
      discard,
      prune,
    });
    const store = new Map<string, string>();
    const storage = { get: () => store.get('d') ?? null, set: (v: string) => void store.set('d', v) };
    const dl = createDownloads({ plugin: p, channel: channelOver(body), lost: isTransport, native: true, storage });
    await dl.start('first', { sid: 's', itemId: 'i', index: 0, name: 'notes.txt' });
    expect(dl.get('first')).toMatchObject({ state: 'done', published: false });
    for (let i = 0; i < KEEP; i++) await dl.start(`k${i}`, { sid: 's', itemId: 'i', index: i + 1, name: 'notes.txt' });
    expect(dl.get('first').state).toBe('idle');
    expect(discard).toHaveBeenCalledWith({ file: 's1' });
    expect(prune).toHaveBeenCalledTimes(1);
    // The next start names every file a kept record has.
    createDownloads({ plugin: p, channel: channelOver(body), lost: isTransport, native: true, storage });
    const keep = (prune.mock.calls[1] as unknown as [{ keep: string[] }])[0].keep;
    expect(keep).toHaveLength(KEEP);
    expect(keep).not.toContain('s1');
  });
});

describe('a pairing from before the secure channel (19)', () => {
  it('transfers nothing, and a system download an older build left running is stopped at start', async () => {
    const cancel = vi.fn(async () => {});
    const store = new Map<string, string>([['d', JSON.stringify({ old: { state: 'running', via: 'system', id: '42', total: 9 } })]]);
    const dl = createDownloads({ plugin: plugin({ cancel }), native: true, storage: { get: () => store.get('d') ?? null, set: (v) => void store.set('d', v) } });
    expect(cancel).toHaveBeenCalledWith({ id: '42' });
    expect(dl.get('old')).toMatchObject({ state: 'failed', error: PLAIN_OFF });
    await expect(dl.start('k', { sid: 's', itemId: 'i', index: 0, name: 'notes.txt' })).rejects.toThrow(PLAIN_OFF);
    expect(dl.get('k')).toMatchObject({ state: 'failed', error: PLAIN_OFF });
  });
});

// ── the store: steps under a root held while a chat is read far back (24) ──

interface StoreData {
  items: Record<string, TimelineItem & { kids?: number }>;
  roots: string[];
  children: Record<string, string[]>;
  next?: string;
  late?: string[];
}
const STORE = '../mobile/src/lib/store';
const desk = new Map<string, TimelineItem[]>();
const metaOf = (id: string) => ({ id, title: 'A long chat', provider: 'demo', cwd: '/x', status: 'running', createdAt: 1, updatedAt: 1 }) as unknown as SessionMeta;
fake.conn.call = async (method, p) => {
  if (method !== 'phone.tail') throw new Error(`unexpected ${method}`);
  const roots = desk.get(p.sessionId!)!;
  const at = roots.findIndex((r) => r.id === (p.around ?? p.after));
  const s = p.around ? Math.max(0, at - 10) : at >= 0 ? at : Math.max(0, roots.length - 40);
  const e = Math.min(roots.length, s + 40);
  return { session: metaOf(p.sessionId!), items: roots.slice(s, e), total: roots.length, ...(s > 0 ? { cursor: roots[s].id } : {}), ...(e < roots.length ? { next: roots[e].id } : {}), ...(p.around ? { at: p.around } : {}), permissions: [], questions: [], queue: [], todos: [] };
};

describe('one live sub-agent while a chat is read far back (24)', () => {
  it('its steps are bounded (counted on it past the bound, fetched when it is opened), and no list is copied per step', async () => {
    const store = (await import(/* @vite-ignore */ STORE)) as {
      openAt: (id: string, itemId: string) => Promise<'here' | 'gone'>;
      applyEvent: (e: unknown) => void;
      getState: () => { data: Record<string, StoreData> };
      LATE_KIDS_MAX: number;
    };
    const roots = Array.from({ length: 300 }, (_, n) => ({ id: `r${n}`, ts: n, type: 'user', text: `m${n}` }) as TimelineItem);
    desk.set('agent', roots);
    expect(await store.openAt('agent', roots[20].id)).toBe('here');
    const agent = { id: 'agent-root', ts: 1, type: 'tool', name: 'Task', kind: 'agent', title: 'Agent', status: 'running', detail: {} } as unknown as TimelineItem;
    desk.get('agent')!.push(agent);
    store.applyEvent({ type: 'item.added', sessionId: 'agent', item: agent });
    expect(store.getState().data.agent.late).toEqual(['agent-root']);
    const list = () => store.getState().data.agent.children['agent-root'];
    const steps = store.LATE_KIDS_MAX + 900;
    let firstList: string[] | undefined;
    for (let k = 0; k < steps; k++) {
      store.applyEvent({ type: 'item.added', sessionId: 'agent', item: { id: `step${k}`, ts: k, type: 'tool', parentId: 'agent-root', name: 'Bash', kind: 'bash', title: 'ls', status: 'done', detail: {} } });
      if (k === 0) firstList = list();
    }
    await tick();
    const d = store.getState().data.agent;
    expect(list()).toBe(firstList);
    expect(list().length).toBe(store.LATE_KIDS_MAX);
    expect(Object.keys(d.items).length).toBeLessThan(store.LATE_KIDS_MAX + 100);
    expect(d.items['agent-root'].kids).toBe(steps);
  });
});
