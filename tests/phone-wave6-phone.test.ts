/**
 * The phone app's own modules after review wave 6, pure and over fakes: words taken back from the
 * queue go into one observable draft at once and stay committed until the draft is sent (9); a
 * start takes a committed copy only when it is newer than the page's own draft, expired ones and
 * receipts dropped first (23); Forget fences the drafts' load, drains their writer, and counts a
 * module that could not let go and a notification that could not be removed (10); a busy desktop is
 * waited out within one deadline, and a Stop ends the wait and frees the start queue (18); a
 * download history that could not be read is neither pruned nor written over, and a failed write is
 * tried again (20); steps that arrive across a history gap are bounded under every parent (16).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PhoneFileStart } from '@shared/protocol';
import { busyError, isStopped, transportError, whileBusy } from '../mobile/src/lib/errors';
import { BUSY_WAIT, createDownloads, START_BUDGET, type Channel, type FilesPlugin } from '../mobile/src/lib/download-core';
import { memorySink } from '../mobile/src/lib/sink';
import { NotePoster, type NoteApi } from '../mobile/src/lib/note-post';
import { NoteBook } from '../mobile/src/lib/note-book';
import { isTransport } from '../mobile/src/lib/errors';

// ── Android's committed preferences, with a hand on each write and read ──

const prefs = vi.hoisted(() => ({
  map: new Map<string, string>(),
  log: [] as string[],
  writeGate: null as Promise<void> | null,
  readGate: null as Promise<void> | null,
  failWrite: false,
  failRead: false,
}));
vi.mock('../mobile/src/lib/native', () => ({
  durable: async (k: string, v: string | null) => {
    if (prefs.writeGate) await prefs.writeGate;
    if (prefs.failWrite) throw new Error('full');
    prefs.log.push(v === null ? `delete ${k}` : `write ${k}`);
    if (v === null) prefs.map.delete(k);
    else prefs.map.set(k, v);
  },
  readPref: async (k: string) => {
    if (prefs.readGate) await prefs.readGate;
    if (prefs.failRead) throw new Error('unreadable');
    return prefs.map.get(k) ?? null;
  },
}));

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

const tick = () => new Promise((r) => setTimeout(r, 0));
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};
const TAKEN = 'sable.taken';
const takenNow = () => JSON.parse(prefs.map.get(TAKEN) ?? 'null') as { kept: Record<string, { t: string; r: number }>; takes: { id: string }[] } | null;

/** A fresh phone: its own drafts (read from the storage as it is now), erasure, generation and forget hooks. */
async function phone() {
  vi.resetModules();
  const drafts = await import('../mobile/src/lib/drafts');
  const erase = await import('../mobile/src/lib/erase');
  const forget = await import('../mobile/src/lib/forget');
  return { drafts, erase, forget };
}
const reset = () => {
  mem.clear();
  prefs.map.clear();
  prefs.log.length = 0;
  Object.assign(prefs, { writeGate: null, readGate: null, failWrite: false, failRead: false });
};

describe('words taken back are in one observable, committed draft (9)', () => {
  it('keeps the reservation separate from newer typing until confirmation', async () => {
    reset();
    const { drafts } = await phone();
    drafts.setDraft('s', 'had', { now: true });
    const slow = gate();
    prefs.writeGate = slow.p;
    const staging = drafts.stageTaken('s', 'fix the tests', 'R1', 'q');
    await tick();
    expect(drafts.getDraft('s')).toBe('had');
    expect(await drafts.pendingTakes()).toEqual([]);
    drafts.setDraft('s', 'newer', { now: true });
    slow.open();
    await staging;
    await drafts.settleTaken('R1', true);
    expect(drafts.getDraft('s')).toBe('newer\nfix the tests');
    expect(takenNow()!.takes).toEqual([]);
    expect(takenNow()!.kept.s.t).toBe('newer\nfix the tests');
  });

  it('a chat left before the desktop answers loses nothing: the next field opens on the words', async () => {
    reset();
    const { drafts } = await phone();
    await drafts.stageTaken('s', 'the words', 'R2', 'q');
    await drafts.settleTaken('R2', true);
    await drafts.drained();
    // No field was listening: the draft itself has them, and so does its committed copy.
    expect(drafts.getDraft('s')).toBe('the words');
    expect(drafts.hasKept('s')).toBe(true);
  });

  it('a start after Android lost the page\'s newest writes takes the committed copy; a send lets it go at once', async () => {
    reset();
    const a = await phone();
    a.drafts.setDraft('s', 'older', { now: true });
    const older = mem.get('sable.drafts')!;
    await a.drafts.stageTaken('s', 'taken words', 'R3', 'q');
    await a.drafts.drained();
    // The page's storage as it was before the take (its write never reached the disk).
    mem.set('sable.drafts', older);
    const b = await phone();
    await b.drafts.pendingTakes();
    expect(b.drafts.getDraft('s')).toBe('older');
    expect(await b.drafts.pendingTakes()).toEqual(['R3']);
    await b.drafts.settleTaken('R3', true);
    expect(b.drafts.getDraft('s')).toBe('older\ntaken words');
    // Sent: the draft empties and its committed copy goes now, so the words never come back.
    b.drafts.setDraft('s', '');
    await b.drafts.drained();
    expect(takenNow()?.kept?.s).toBeUndefined();
    const c = await phone();
    await c.drafts.pendingTakes();
    expect(c.drafts.getDraft('s')).toBe('');
  });

  it('a commit that fails takes the words out of the field again (the message stays queued)', async () => {
    reset();
    const { drafts } = await phone();
    drafts.setDraft('s', 'mine', { now: true });
    prefs.failWrite = true;
    await expect(drafts.stageTaken('s', 'queued words', 'R4', 'q')).rejects.toThrow('full');
    expect(drafts.getDraft('s')).toBe('mine');
    expect(await drafts.pendingTakes()).toEqual([]);
  });
});

describe('recovery at a start (23)', () => {
  it('expired copies and receipts are dropped before anything is merged; a draft newer than the copy stays as edited', async () => {
    reset();
    const now = Date.now();
    // A build before revisions: one record per take.
    prefs.map.set(
      TAKEN,
      JSON.stringify([
        // Unanswered past its time: the message stayed queued on the desktop; its words would come twice.
        { sid: 'a', text: 'stale words', take: 'OLD', at: now - 20 * 60_000 },
        // Answered (no receipt left) a moment ago: merged once.
        { sid: 'b', text: 'kept words', at: now - 60_000 },
        { sid: 'b', text: 'kept words', at: now - 60_000 },
      ]),
    );
    const a = await phone();
    expect(await a.drafts.pendingTakes()).toEqual([]);
    expect(a.drafts.getDraft('a')).toBe('');
    expect(a.drafts.getDraft('b')).toBe('kept words');
    // With revisions: the person edited after the copy was committed (the page has a newer revision).
    reset();
    mem.set('sable.drafts', JSON.stringify({ c: { t: 'edited since', r: 9 }, d: { t: 'old', r: 2 } }));
    prefs.map.set(
      TAKEN,
      JSON.stringify({
        v: 2,
        kept: { c: { t: 'edited since plus taken', r: 5, at: now }, d: { t: 'old\ntaken', r: 3, at: now }, e: { t: 'a week old', r: 1, at: now - 8 * 24 * 3600_000 } },
        takes: [
          { id: 'R1', sid: 'd', at: now },
          { id: 'R1', sid: 'd', at: now },
          { id: 'R0', sid: 'd', at: now - 16 * 60_000 },
        ],
      }),
    );
    const b = await phone();
    expect(await b.drafts.pendingTakes()).toEqual(['R1']);
    expect(b.drafts.getDraft('c')).toBe('edited since');
    expect(b.drafts.getDraft('d')).toBe('old\ntaken');
    expect(b.drafts.getDraft('e')).toBe('');
    // Copies done with go from the storage too.
    await b.drafts.drained();
    expect(Object.keys(takenNow()!.kept)).toEqual(['d']);
  });
});

describe('Forget lets go of everything first (10)', () => {
  it('a start whose load is still on its way when the computer is forgotten takes nothing in', async () => {
    reset();
    prefs.map.set(TAKEN, JSON.stringify({ v: 2, kept: { s: { t: 'secret', r: 1, at: Date.now() } }, takes: [] }));
    const slow = gate();
    prefs.readGate = slow.p;
    const { drafts, erase } = await phone();
    const erased = erase.eraseAll({ storage: localStorage as never, native: async () => (prefs.map.delete(TAKEN), []) });
    slow.open();
    await expect(erased).resolves.toEqual([]);
    await drafts.pendingTakes();
    await drafts.drained();
    expect(drafts.getDraft('s')).toBe('');
    expect(mem.has('sable.drafts')).toBe(false);
    expect(prefs.map.has(TAKEN)).toBe(false);
  });

  it('a write under way lands before the key goes, and one still due never lands', async () => {
    reset();
    const { drafts, erase } = await phone();
    await drafts.pendingTakes();
    const slow = gate();
    prefs.writeGate = slow.p;
    const staging = drafts.stageTaken('s', 'words', 'R1', 'q').catch(() => {});
    await tick();
    // A second reservation is queued behind the first.
    const second = drafts.stageTaken('s', 'later', 'R2', 'q2').catch(() => {});
    await tick();
    const erased = erase.eraseAll({
      storage: localStorage as never,
      native: async () => {
        prefs.log.push('erase native');
        prefs.map.delete(TAKEN);
        return [];
      },
    });
    await tick();
    slow.open();
    prefs.writeGate = null;
    await erased;
    await Promise.all([staging, second]);
    await drafts.drained();
    expect(prefs.log).toEqual([`write ${TAKEN}`, 'erase native']);
    expect(prefs.map.has(TAKEN)).toBe(false);
  });

  it('a module that could not let go counts as something left', async () => {
    reset();
    const { erase, forget } = await phone();
    const stop = forget.onForget(() => {
      throw new Error('still holding');
    });
    await expect(erase.eraseAll({ storage: null, native: async () => [] })).resolves.toEqual(['forget']);
    stop();
    await expect(erase.eraseAll({ storage: null, native: async () => [] })).resolves.toEqual([]);
  });

  it('notifications Android could not remove fail the clearing; the poster goes on after', async () => {
    let fail = true;
    const posted: number[] = [];
    const api: NoteApi = {
      allowed: async () => true,
      prepare: async () => {},
      delivered: async () => [],
      cancel: async () => {},
      post: async (n) => void posted.push(n.id),
      clearAll: async () => {
        if (fail) throw new Error('not removed');
      },
    };
    const book = new NoteBook({ get: () => null, set: () => {} }, () => 7);
    const poster = new NotePoster(api, book, () => 7);
    await expect(poster.clear()).rejects.toThrow('not removed');
    fail = false;
    await expect(poster.clear()).resolves.toBeUndefined();
    await poster.notify('Chat', 'Done', 's', 'done');
    expect(posted).toEqual([7]);
  });
});

describe('a busy desktop within one deadline, stopped at once (18)', () => {
  it('a Stop while it waits on a busy answer asks nothing more, at once', async () => {
    let calls = 0;
    const ac = new AbortController();
    const going = whileBusy(
      async () => {
        calls++;
        throw busyError('Busy', 4000);
      },
      { budgetMs: 60_000, signal: ac.signal },
    );
    await tick();
    ac.abort();
    const err = await going.catch((e) => e);
    expect(isStopped(err)).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(1);
  });

  it('each call is given only the time left; past the deadline nothing is asked', async () => {
    let t = 0;
    const lefts: number[] = [];
    const err = await whileBusy(
      async (left) => {
        lefts.push(left);
        t += 30_000;
        throw busyError('Busy', 1000);
      },
      { deadline: 100_000, now: () => t, sleep: async (ms) => void (t += ms) },
    ).catch((e) => e);
    expect(lefts).toEqual([100_000, 69_000, 38_000, 7_000]);
    expect(lefts.every((l, i) => i === 0 || l < lefts[i - 1])).toBe(true);
    expect(err.message).toBe('Busy');
    let asked = 0;
    const late = await whileBusy(async () => (asked++, 'x'), { deadline: 5, now: () => 10 }).catch((e) => e);
    expect(asked).toBe(0);
    expect(isTransport(late)).toBe(true);
  });

  const BUSY = 'Another download is starting. Try again in a moment.';
  const body = Buffer.from('a file of some bytes');
  const sha = createHash('sha256').update(body).digest('hex');
  const okStart = (n: number): PhoneFileStart => ({ transfer: `t${n}`, name: 'notes.txt', size: body.length, sha256: sha, chunk: 1000 });
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

  it('a start stopped while it waits out "another download is starting" frees the queue at once, and asks no more', async () => {
    const starts: number[] = [];
    const ch: Channel = {
      secure: () => true,
      async start(p) {
        starts.push(p.index);
        if (p.index === 0) throw new Error(BUSY);
        return okStart(p.index);
      },
      chunk: async (p) => ({ data: body.subarray(p.offset, p.offset + p.length).toString('base64') }),
      end: async () => ({}),
    };
    // A wait that never ends by itself: only a Stop ends it.
    const dl = createDownloads({ plugin: { ...plugin(), ...memorySink() }, channel: ch, lost: isTransport, native: true, sleep: () => new Promise(() => {}) });
    const first = dl.start('k0', { sid: 's', itemId: 'i', index: 0, name: 'notes.txt' }).catch(() => {});
    const second = dl.start('k1', { sid: 's', itemId: 'i', index: 1, name: 'notes.txt' });
    await tick();
    expect(starts).toEqual([0]);
    await dl.cancel('k0');
    await second;
    await first;
    expect(dl.get('k1')).toMatchObject({ state: 'done', verified: true });
    expect(dl.get('k0').state).toBe('idle');
    expect(starts).toEqual([0, 1]);
  });

  it('every wait of one start counts against one deadline from its turn, the same deadline handed to each call', async () => {
    let t = 0;
    const deadlines: (number | undefined)[] = [];
    const ch: Channel = {
      secure: () => true,
      async start(_p, ctx) {
        deadlines.push(ctx?.deadline);
        // Each answer takes 40 s (the desktop hashing, then saying it is busy).
        t += 40_000;
        throw new Error(BUSY);
      },
      chunk: async () => ({ data: '' }),
      end: async () => ({}),
    };
    const dl = createDownloads({ plugin: plugin(), channel: ch, lost: isTransport, native: true, now: () => t, sleep: async (ms) => void (t += ms) });
    await expect(dl.start('k', { sid: 's', itemId: 'i', index: 0, name: 'notes.txt' })).rejects.toThrow(BUSY);
    expect(deadlines.length).toBe(4);
    expect(new Set(deadlines)).toEqual(new Set([START_BUDGET]));
    expect(deadlines.length).toBeLessThan(BUSY_WAIT.length);
    expect(dl.get('k').state).toBe('failed');
  });
});

describe('a desktop with no room for one more transfer (17, 18)', () => {
  it('a start still refused for now when its time ran out pauses (its bytes kept) and goes on when one of this phone\'s downloads ends', async () => {
    const body = Buffer.from('the bytes of a file that takes a while');
    const sha = createHash('sha256').update(body).digest('hex');
    let firstDone = false;
    const hold = gate();
    const starts: number[] = [];
    const ch: Channel = {
      secure: () => true,
      async start(p) {
        starts.push(p.index);
        if (p.index === 1 && !firstDone) throw busyError('Other downloads are under way. This one starts when one of them is done.', 1000);
        return { transfer: `t${p.index}`, name: 'notes.txt', size: body.length, sha256: sha, chunk: 1000 };
      },
      async chunk(p) {
        if (p.transfer === 't0') await hold.p;
        return { data: body.subarray(p.offset, p.offset + p.length).toString('base64') };
      },
      end: async () => ({}),
    };
    const sink = memorySink();
    const dl = createDownloads({
      plugin: {
        download: async () => ({ id: '1' }),
        status: async () => ({ state: 'done' }),
        cancel: async () => {},
        verify: async () => ({ ok: true }),
        ...sink,
        stageFinish: async (o) => {
          const r = await sink.stageFinish(o);
          if (o.id && r.ok) firstDone = true;
          return r;
        },
      },
      channel: ch,
      lost: isTransport,
      native: true,
    });
    const a = dl.start('a', { sid: 's', itemId: 'i', index: 0, name: 'notes.txt' });
    await dl.start('b', { sid: 's', itemId: 'i', index: 1, name: 'notes.txt' });
    expect(dl.get('b').state).toBe('paused');
    hold.open();
    await a;
    for (let i = 0; i < 50 && dl.get('b').state !== 'done'; i++) await tick();
    expect(dl.get('a')).toMatchObject({ state: 'done', verified: true });
    expect(dl.get('b')).toMatchObject({ state: 'done', verified: true });
    expect(starts).toEqual([0, 1, 1]);
  });
});

describe('a download history that could not be read (20)', () => {
  const p = (over: Partial<FilesPlugin> = {}): FilesPlugin => ({
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
  const done = (file: string) => ({ state: 'done', via: 'channel', verified: true, secure: true, file, stage: file, name: 'app.apk', sha256: 'a'.repeat(64), size: 3 });

  it('is not pruned nor written over; once it reads, it is merged and only then reconciled', async () => {
    const prune = vi.fn(async () => {});
    let readable = false;
    const saved = JSON.stringify({ apk: done('f-apk') });
    const set = vi.fn();
    const storage = {
      get: () => {
        if (!readable) throw new Error('unreadable');
        return saved;
      },
      set,
    };
    const dl = createDownloads({ plugin: p({ prune }), native: true, storage });
    expect(prune).not.toHaveBeenCalled();
    // A change while it cannot be read: nothing written over what is there.
    dl.set('other', { state: 'failed', error: 'x' });
    dl.set('k', done('f-new') as never);
    expect(set).not.toHaveBeenCalled();
    readable = true;
    dl.set('k2', done('f-two') as never);
    expect(dl.get('apk')).toMatchObject({ state: 'done', file: 'f-apk' });
    expect(set).toHaveBeenCalledTimes(1);
    expect(Object.keys(JSON.parse(set.mock.calls[0][0] as string)).sort()).toEqual(['apk', 'k', 'k2']);
    const keep = (prune.mock.calls[0] as unknown as [{ keep: string[] }])[0].keep;
    expect(keep).toEqual(expect.arrayContaining(['f-apk', 'f-new', 'f-two']));
    // A damaged history (not one at all) is not pruned by either.
    const prune2 = vi.fn(async () => {});
    createDownloads({ plugin: p({ prune: prune2 }), native: true, storage: { get: () => '{not json', set: () => {} } });
    expect(prune2).not.toHaveBeenCalled();
  });

  it('a write that failed is tried again with the next change, the same state included', async () => {
    let fail = true;
    const writes: string[] = [];
    const storage = {
      get: () => null,
      set: (v: string) => {
        writes.push(v);
        if (fail) throw new Error('full');
      },
    };
    const dl = createDownloads({ plugin: p(), native: true, storage });
    dl.set('a', done('f-a') as never);
    expect(writes).toHaveLength(1);
    fail = false;
    // A change that leaves what is kept the same (a failed entry is not kept) still writes what never landed.
    dl.set('b', { state: 'failed', error: 'x' });
    expect(writes).toHaveLength(2);
    expect(writes[1]).toBe(writes[0]);
    dl.set('c', { state: 'failed', error: 'y' });
    expect(writes).toHaveLength(2);
  });
});
