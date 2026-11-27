/**
 * A save of a long chat costs what changed, not the length of the chat (27 Nov: at 126,000 rows every
 * save held the bridge, which is the window's main process, for 150 to 600 ms, and the first one after a
 * start for three seconds; a save comes every second and a half while a chat streams).
 *
 * - The end of a chat is found from each row's bits exactly as from the rows.
 * - A save that takes rows over by their place writes what a save that asks about every row writes, for
 *   every kind of change: rows added, changed, put in, taken out, moved, copied again, all of them.
 * - The copies of a chat just read are made ahead in slices, and the first save after that is right too.
 * - A steady save's longest block does not grow with the chat.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TimelineItem } from '../shared/protocol';
import { SMALL_BASE } from '../server/core/session-file';
import { Store } from '../server/core/store';
import { rowFacts, snapshotEnd } from '../server/core/trim';

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.seal().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

/** A small generator with a seed, so a failure names the case. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('the end of a chat from each row\'s bits', () => {
  it('is the end the rows themselves give, for every mix of rows', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const rows: TimelineItem[] = [];
      const n = 20 + Math.floor(r() * 380);
      const tools: string[] = [];
      for (let i = 0; i < n; i++) {
        const k = r();
        const id = 'r' + i;
        if (k < 0.12) {
          rows.push({ type: 'user', id, ts: i, text: 'Do ' + i, state: r() < 0.06 ? 'queued' : 'sent', ...(r() < 0.1 ? { steered: true } : {}) } as TimelineItem);
        } else if (k < 0.62) {
          const parent = tools.length && r() < 0.15 ? tools[Math.floor(r() * tools.length)] : undefined;
          const live = r();
          rows.push({
            type: 'tool', id, ts: i, kind: 'bash', name: 'Bash', title: 'Run', detail: {},
            status: live < 0.03 ? 'running' : live < 0.04 ? 'pending' : live < 0.05 ? 'awaiting' : r() < 0.1 ? 'error' : 'done',
            ...(parent ? { parentId: parent } : {}),
            ...(r() < 0.02 ? { task: { id: 't' + i, kind: 'command', state: r() < 0.5 ? 'running' : 'done' } } : {}),
            ...(r() < 0.02 ? { tracked: { pid: 1, title: 'Job', since: 1, state: r() < 0.5 ? 'running' : 'ended' } } : {}),
            ...(r() < 0.02 ? { result: { text: '', agent: { background: r() < 0.5 ? 'running' : 'done' } } } : {}),
            ...(r() < 0.01 ? { workflow: { status: r() < 0.5 ? 'running' : 'done' } } : {}),
          } as unknown as TimelineItem);
          tools.push(id);
        } else if (k < 0.8) {
          rows.push({ type: r() < 0.3 ? 'thinking' : 'text', id, ts: i, text: 'Said ' + i, streaming: r() < 0.03 } as TimelineItem);
        } else if (k < 0.86) {
          rows.push({ type: 'notice', id, ts: i, variant: 'info', text: 'Note',
            ...(r() < 0.3 ? { limit: { provider: 'claude', ...(r() < 0.4 ? { continuedWith: 'x' } : {}), ...(r() < 0.2 ? { atReset: true } : {}) } } : {}) } as unknown as TimelineItem);
        } else rows.push({ type: 'turn', id, ts: i, durationMs: 1 } as TimelineItem);
      }
      const bits = Uint8Array.from(rows, (row) => rowFacts(row));
      expect(snapshotEnd(rows, bits), 'seed ' + seed).toEqual(snapshotEnd(rows));
    }
  });
});

const text = 'A line of what was said in this part of the conversation. '.repeat(40);
/** A chat whose file is past the size where it is written whole every time: turns of a message, steps, an answer. */
function chat(turns: number, big = true): TimelineItem[] {
  const rows: TimelineItem[] = [];
  let s = 0;
  for (let t = 0; t < turns; t++) {
    rows.push({ type: 'user', id: 'u' + t, ts: t, text: 'Do part ' + t, state: 'sent' } as TimelineItem);
    for (let k = 0; k < 4; k++) rows.push({ type: 'tool', id: 's' + s++, ts: t, kind: 'bash', name: 'Bash', title: 'Run', status: 'done', detail: { command: 'pnpm test' }, result: { text: big ? text : 'ok', exitCode: 0 } } as TimelineItem);
    rows.push({ type: 'text', id: 'a' + t, ts: t, text: 'Done ' + t, streaming: false } as TimelineItem);
    rows.push({ type: 'turn', id: 't' + t, ts: t, durationMs: 1 } as TimelineItem);
  }
  return rows;
}

function open(rows: TimelineItem[]) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-savecost-'));
  dirs.push(home);
  mkdirSync(path.join(home, 'sessions'));
  writeFileSync(path.join(home, 'state.json'), JSON.stringify({ sessions: [], projects: [], accounts: [] }));
  const byId = new Map<string, TimelineItem>();
  const store = new Store(home, (_s, id) => byId.get(id));
  stores.push(store);
  const live = rows;
  /** The runtime's index of its rows by id, as the bridge keeps it: brought up to the rows as they stand. */
  const sync = () => {
    byId.clear();
    for (const row of live) byId.set(row.id, row);
  };
  sync();
  const save = async (dirty: Set<string> | 'all') => {
    sync();
    store.saveSession('c', () => ({ items: live, todos: [], queue: [], dirty }));
    await store.persistInput('c');
  };
  /** How the saves found their rows so far: by place, or by asking about every place. */
  const found = () => ({ ...(store as unknown as { rowSaves: { byPlace: number; asked: number } }).rowSaves });
  /** The base is past the size written whole each time (so the saves under test go through the tail). */
  const long = () => statSync(path.join(home, 'sessions', 'c.json')).size > SMALL_BASE;
  /** What a store that never saw this chat reads from its files. */
  const onDisk = () => {
    const fresh = new Store(home);
    const read = fresh.loadSession('c');
    // Sealed with the others at the test's end, one after another: two stores of one process share the
    // state file's temp name, and a seal left running here raced the next store's rename (ENOENT, once, under load).
    stores.push(fresh);
    expect(read.unreadable).toBeFalsy();
    return read.items;
  };
  return { home, store, live, byId, save, onDisk, long, sync, found };
}

/** Turns enough for a file past the size that is written whole at every save: only then a save writes the tail. */
const LONG = 470;

const step = (id: string): TimelineItem => ({ type: 'tool', id, ts: 9e6, kind: 'read', name: 'Read', title: 'Read a file', status: 'done', detail: { path: 'a.ts' }, result: { text: 'x' } }) as TimelineItem;

describe('a save that takes rows over by their place', () => {
  it('writes the chat as it stands after every kind of change', async () => {
    const h = open(chat(LONG));
    await h.save('all');
    expect(h.long()).toBe(true);
    expect(h.onDisk()).toEqual(h.live);

    // Rows added at the end, as a turn streams.
    const added = new Set<string>();
    h.live.push({ type: 'user', id: 'live-u', ts: 9e6, text: 'More', state: 'sent' } as TimelineItem);
    added.add('live-u');
    for (let i = 0; i < 12; i++) {
      h.live.push(step('live' + i));
      added.add('live' + i);
    }
    const before = h.found();
    await h.save(added);
    expect(h.onDisk()).toEqual(h.live);

    // Nothing changed: the same again.
    await h.save(new Set());
    expect(h.onDisk()).toEqual(h.live);
    // Both took the rows over by their place: nobody asked about every row.
    expect(h.found()).toEqual({ byPlace: before.byPlace + 2, asked: before.asked });

    // A row of the running turn changed in place, and one far up.
    (h.live[h.live.length - 3] as { title: string }).title = 'Read another file';
    (h.live[700] as { title: string }).title = 'Run it again';
    await h.save(new Set([h.live[h.live.length - 3].id, h.live[700].id]));
    expect(h.onDisk()).toEqual(h.live);

    // A row named changed that is no longer there, beside one that is.
    (h.live[h.live.length - 1] as { title: string }).title = 'Read the last file';
    await h.save(new Set(['gone', h.live[h.live.length - 1].id]));
    expect(h.onDisk()).toEqual(h.live);

    // A row put in far up (every place after it holds another row than before).
    h.live.splice(900, 0, step('put-in'));
    await h.save(new Set(['put-in']));
    expect(h.onDisk()).toEqual(h.live);

    // A row taken out.
    h.live.splice(400, 1);
    await h.save(new Set());
    expect(h.onDisk()).toEqual(h.live);

    // A row moved: taken out near the end and put in further up, as a message the agent took is.
    const [moved] = h.live.splice(h.live.length - 2, 1);
    h.live.splice(h.live.length - 6, 0, moved);
    await h.save(new Set([moved.id]));
    expect(h.onDisk()).toEqual(h.live);

    // The chat cut short (a rewind), then going on.
    h.live.length -= 5;
    await h.save(new Set());
    expect(h.onDisk()).toEqual(h.live);
    h.live.push(step('after-rewind'));
    await h.save(new Set(['after-rewind']));
    expect(h.onDisk()).toEqual(h.live);

    // Everything named changed.
    (h.live[10] as { title: string }).title = 'All of it';
    const all = h.found();
    await h.save('all');
    expect(h.onDisk()).toEqual(h.live);
    // Only that one asked about every row (as the very first save did); each of the nine changes before it went by place.
    expect(all).toEqual({ byPlace: 9, asked: 1 });
    expect(h.found()).toEqual({ byPlace: 9, asked: 2 });
  });

  it('writes a base in the middle of a turn, then the turn\'s last rows as they change, and all of it at a quit', async () => {
    const rows = chat(LONG);
    // A turn under way: rows after the last finished turn.
    rows.push({ type: 'user', id: 'live-u', ts: 9e6, text: 'More', state: 'sent' } as TimelineItem);
    for (let i = 0; i < 30; i++) rows.push(step('live' + i));
    const h = open(rows);
    await h.save('all');
    expect(h.long()).toBe(true);
    // The base holds the turn's rows too, behind its settled part: one of them changes, then another.
    (h.live[h.live.length - 10] as { title: string }).title = 'Changed after the base';
    await h.save(new Set([h.live[h.live.length - 10].id]));
    expect(h.onDisk()).toEqual(h.live);
    (h.live[h.live.length - 20] as { title: string }).title = 'Changed later';
    h.live.push(step('more'));
    await h.save(new Set([h.live[h.live.length - 21].id, 'more']));
    expect(h.onDisk()).toEqual(h.live);
    // A settled row far up too, and a save with nothing named after it.
    (h.live[900] as { title: string }).title = 'An old step';
    await h.save(new Set([h.live[900].id]));
    await h.save(new Set());
    expect(h.onDisk()).toEqual(h.live);
    // The quit's save may keep a longer prefix of the base: every changed row is still written.
    (h.live[h.live.length - 5] as { title: string }).title = 'Changed at the end';
    h.sync();
    h.store.saveSession('c', () => ({ items: h.live, todos: [], queue: [], dirty: new Set([h.live[h.live.length - 5].id]) }));
    await h.store.seal();
    expect(h.onDisk()).toEqual(h.live);
  });

  it('meets many rows copied again in one walk, and writes them', async () => {
    const h = open(chat(LONG));
    await h.save('all');
    const added = new Set<string>(['live-u']);
    h.live.push({ type: 'user', id: 'live-u', ts: 9e6, text: 'More', state: 'sent' } as TimelineItem);
    for (let i = 0; i < 150; i++) {
      h.live.push(step('live' + i));
      added.add('live' + i);
    }
    await h.save(added);
    const replace = (h.store as unknown as { replaceView(id: string, item: TimelineItem, view: TimelineItem): void }).replaceView.bind(h.store);
    for (let i = 0; i < 100; i++) {
      const row = h.live[h.live.length - 1 - i];
      replace('c', row, { ...row, title: 'In another form ' + i } as TimelineItem);
    }
    const before = h.found();
    await h.save(new Set());
    expect(h.onDisk()).toEqual(h.live);
    // More names than are looked for one by one: one walk over the places.
    expect(h.found()).toEqual({ byPlace: before.byPlace, asked: before.asked + 1 });
    h.live.push(step('later'));
    await h.save(new Set(['later']));
    expect(h.onDisk()).toEqual(h.live);
    expect(h.found().byPlace).toBe(before.byPlace + 1);
  });

  it('keeps a row\'s copy while nobody names it, as a save always did', async () => {
    const h = open(chat(LONG));
    await h.save('all');
    const before = structuredClone(h.live[300]);
    // Changed and not named: the file keeps what it had (everything that changes a row names it).
    (h.live[300] as { title: string }).title = 'Unnamed change';
    h.live.push(step('more'));
    await h.save(new Set(['more']));
    const disk = h.onDisk();
    expect(disk[300]).toEqual(before);
    expect(disk.at(-1)).toEqual(h.live.at(-1));
    // Named, it is written.
    await h.save(new Set([h.live[300].id]));
    expect(h.onDisk()[300]).toEqual(h.live[300]);
  });

  it('writes a row whose copy was made again outside a save', async () => {
    const h = open(chat(LONG));
    await h.save('all');
    expect(h.long()).toBe(true);
    // A running turn: its rows live in the tail, written again at every save.
    const added = new Set<string>(['live-u']);
    h.live.push({ type: 'user', id: 'live-u', ts: 9e6, text: 'More', state: 'sent' } as TimelineItem);
    for (let i = 0; i < 8; i++) {
      h.live.push(step('live' + i));
      added.add('live' + i);
    }
    await h.save(added);
    expect(h.onDisk()).toEqual(h.live);
    // One of them is put in another form in place, as the store does with a row it slims, and nobody names it.
    const at = h.live.length - 4;
    const row = h.live[at];
    const view = { ...row, title: 'In another form', result: { text: 'short' } } as TimelineItem;
    (h.store as unknown as { replaceView(id: string, item: TimelineItem, view: TimelineItem): void }).replaceView('c', row, view);
    expect(row).toEqual(view);
    await h.save(new Set());
    expect(h.onDisk()[at]).toEqual(view);
    // And the save after it takes it over by its place again.
    h.live.push(step('later'));
    await h.save(new Set(['later']));
    expect(h.onDisk()).toEqual(h.live);
  });

  it('is right when a second save is asked for while the first is being written', async () => {
    const h = open(chat(LONG));
    await h.save('all');
    h.live.push(step('one'));
    h.sync();
    h.store.saveSession('c', () => ({ items: h.live, todos: [], queue: [], dirty: new Set(['one']) }));
    const first = h.store.persistInput('c');
    // The first write is under way with its own rows: these changes belong to the next.
    h.live.splice(200, 1);
    h.live.push(step('two'));
    (h.live[100] as { title: string }).title = 'Changed meanwhile';
    h.sync();
    h.store.saveSession('c', () => ({ items: h.live, todos: [], queue: [], dirty: new Set(['two', h.live[100].id]) }));
    await Promise.all([first, h.store.persistInput('c')]);
    expect(h.onDisk()).toEqual(h.live);
    h.live.push(step('three'));
    await h.save(new Set(['three']));
    expect(h.onDisk()).toEqual(h.live);
  });
});

describe('the copies of a chat just read', () => {
  const warmed = async (store: Store) => {
    const s = store as unknown as { warming: Map<string, unknown> };
    for (let i = 0; i < 2000 && s.warming.size; i++) await new Promise((r) => setTimeout(r, 2));
    expect(s.warming.size).toBe(0);
  };

  it('are made ahead in slices, and the first save after them is right', async () => {
    const h = open(chat(600, false));
    let ticks = 0;
    const t = setInterval(() => ticks++, 1);
    h.store.warmSave('c', h.live);
    await warmed(h.store);
    clearInterval(t);
    // Other work ran while they were made.
    expect(ticks).toBeGreaterThan(0);
    // A row changed after its copy was made is named, and written as it is now.
    (h.live[50] as { title: string }).title = 'Changed after the copy';
    h.live.push(step('new'));
    await h.save(new Set([h.live[50].id, 'new']));
    expect(h.onDisk()).toEqual(h.live);
  });

  it('are waited for by a save that must happen now, which then asks about no row', async () => {
    const h = open(chat(600, false));
    h.store.warmSave('c', h.live);
    h.live.push(step('now'));
    h.sync();
    h.store.saveSession('c', () => ({ items: h.live, todos: [], queue: [], dirty: new Set(['now']) }));
    // As the bridge commits an input right after a chat was read: at once, yet not as one task over every row.
    await h.store.persistInput('c');
    expect(h.found()).toEqual({ byPlace: 1, asked: 0 });
    expect(h.onDisk()).toEqual(h.live);
  });

  it('give way to a save that comes first', async () => {
    const h = open(chat(600, false));
    h.store.warmSave('c', h.live);
    h.live.push(step('early'));
    // A quit waits for nothing: its save makes the copies that are left itself.
    h.sync();
    h.store.saveSession('c', () => ({ items: h.live, todos: [], queue: [], dirty: new Set(['early']) }));
    await h.store.flush();
    expect((h.store as unknown as { warming: Map<string, unknown> }).warming.size).toBe(0);
    expect(h.found().asked).toBe(1);
    expect(h.onDisk()).toEqual(h.live);
    h.live.splice(3, 1);
    await h.save(new Set());
    expect(h.onDisk()).toEqual(h.live);
  });
});

describe('what a steady save costs', () => {
  it('does not grow with the chat', async () => {
    // Small rows, many of them: a file past the size that is written whole each time.
    const rows = chat(16_000, false);
    expect(rows.length).toBeGreaterThan(100_000);
    const h = open(rows);
    await h.save('all');
    await h.save(new Set());
    // One walk over every row of the chat, on this machine, now.
    const walk = () => {
      const t0 = performance.now();
      let n = 0;
      for (let i = 0; i < h.live.length; i++) if (h.live[i].id) n++;
      return n ? performance.now() - t0 : 0;
    };
    const one = Math.min(walk(), walk(), walk());
    let best = Infinity;
    const before = h.found();
    for (let r = 0; r < 6; r++) {
      const id = 'tick' + r;
      const row = step(id);
      h.live.push(row);
      h.byId.set(id, row);
      h.store.saveSession('c', () => ({ items: h.live, todos: [], queue: [], dirty: new Set([id]) }));
      // The longest stretch in which no timer could run while the save went on.
      let last = performance.now();
      let block = 0;
      const tick = setInterval(() => {
        const now = performance.now();
        block = Math.max(block, now - last);
        last = now;
      }, 1);
      await h.store.persistInput('c');
      block = Math.max(block, performance.now() - last);
      clearInterval(tick);
      best = Math.min(best, block);
    }
    // Each of them took the rows over by their place.
    expect(h.found()).toEqual({ byPlace: before.byPlace + 6, asked: before.asked });
    // Asking about every row cost some ten walks; taking rows over by their place costs about one.
    expect(best).toBeLessThan(one * 4 + 25);
    expect(h.onDisk().length).toBe(h.live.length);
  }, 120_000);
});
