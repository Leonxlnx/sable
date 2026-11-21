/**
 * Files and changes a phone gets, after review wave 5 (scratch/reviews/out-wave5.md), the desktop's side:
 * - #5: a download's chunks and a phone's previews are only ever the bytes the share recorded: each
 *   chunk is checked against the hashes of its blocks taken in the one read that checked the file
 *   whole at the start, so a rewrite in place of the same length after it sends nothing; a preview is
 *   made only of bytes that are the share's digest, and kept by that digest.
 * - #22: chunk reads in flight are bounded per transfer and per phone (reads and bytes) before any
 *   buffer is allocated; what is refused for now says so (`retry: true`, `retryAfterMs`); a phone's
 *   starts wait their turn (a few), beyond that they are refused for now too.
 * - #4: the working-tree side of a tracked file's diff for the phone is read through the checked
 *   handle (core/contain.ts), never by git through the path: a tracked file replaced by a hard link to
 *   a file outside the chat never gives the phone that file's text.
 * Fakes, temp folders and the Demo agent only. `openGrant` is wrapped so a test can hold reads.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot, ToolItem } from '@shared/protocol';
import type { FileGrant } from '../server/services/phone-guard';

/** Reads held back: through the handles whose index is in `which` (in the order they were opened), while `on`. */
const gate = { on: false, which: new Set<number>(), reads: 0, waiting: [] as (() => void)[], opened: 0 };
const release = () => {
  gate.on = false;
  for (const go of gate.waiting.splice(0)) go();
};

vi.mock('../server/services/phone-guard', async (importOriginal) => {
  const m = await importOriginal<typeof import('../server/services/phone-guard')>();
  const openGrant: typeof m.openGrant = async (g) => {
    const r = await m.openGrant(g);
    if (!('fh' in r)) return r;
    const index = gate.opened++;
    const fh = r.fh;
    const wrapped = new Proxy(fh, {
      get(t, k) {
        if (k === 'read')
          return async (...a: unknown[]) => {
            if (gate.on && gate.which.has(index)) {
              gate.reads++;
              await new Promise<void>((go) => gate.waiting.push(go));
            }
            return (t.read as (...x: unknown[]) => unknown).apply(t, a);
          };
        const v = Reflect.get(t, k, t);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    return { fh: wrapped as FileHandle };
  };
  return { ...m, openGrant };
});

const { FILE_CHUNK, FILE_FLIGHT: FLIGHT, PhoneFiles } = await import('../server/services/phone-files');
const { App } = await import('../server/app');
const { DemoProvider } = await import('../server/providers/demo');
const { registerThumbs, pictureOf } = await import('../server/services/thumbs');
const { registerPhone } = await import('../server/services/phone');
const { PhoneChangesReader } = await import('../server/services/phone-changes');
const { gitDiff } = await import('../server/services/git');
const { CONTAIN } = await import('../server/core/contain');
const { pairSecure } = await import('./phone-wire');

type AppT = InstanceType<typeof App>;
const homes: string[] = [];
const apps: AppT[] = [];
afterEach(async () => {
  release();
  gate.which.clear();
  gate.reads = 0;
  vi.restoreAllMocks();
  for (const a of apps.splice(0)) await a.dispose();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const temp = (tag: string) => {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), `sable-w5-${tag}-`)));
  homes.push(d);
  return d;
};
/** Written with a time of whole seconds, so a rewrite can put it back exactly. */
const put = (file: string, body: Buffer | string) => {
  writeFileSync(file, body);
  utimesSync(file, 1_700_000_000, 1_700_000_000);
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pattern = (n: number, k: number) => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * k + (i >> 9)) % 256;
  return b;
};
const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A grant for `file` as it is now (what `grantFor` gives for a share of it), with its digest. */
function grantOf(file: string, deviceId = 'p1'): FileGrant & { sha256: string } {
  const st = statSync(file);
  return { deviceId, path: file, name: path.basename(file), size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, dev: st.dev, fileId: statSync(file, { bigint: true }).ino.toString(), expires: Date.now() + 60_000, sha256: sha(readFileSync(file)) };
}

/** Rewrites `file` in place (the same file, the same length) and puts its time back. */
function inPlace(file: string, body: Buffer | string, at = 0) {
  const b = Buffer.from(body);
  const was = statSync(file);
  const fd = openSync(file, 'r+');
  try {
    writeSync(fd, b, 0, b.length, at);
  } finally {
    closeSync(fd);
  }
  utimesSync(file, was.atime, was.mtime);
  expect(statSync(file).size).toBe(was.size);
  expect(statSync(file).mtimeMs).toBe(was.mtimeMs);
  expect(statSync(file).ino).toBe(was.ino);
}

/** A share the person allowed themselves (so it goes to a phone whether or not its file is established to be in the chat's folder). */
async function allowedShare(rt: { add: (i: ToolItem) => unknown; patch: (id: string, p: Partial<ToolItem>) => unknown; requestPermission: (...a: never[]) => Promise<unknown>; prompts: () => { permissions: { id: string; itemId?: string }[] }; answerPermission: (...a: never[]) => unknown; handing: (id: string) => Promise<void> | undefined }, itemId: string, files: string[]) {
  const list = files.map((p) => ({ path: p, name: path.basename(p) }));
  rt.add({ id: itemId, type: 'tool', name: 'SendUserFile', kind: 'share', title: 'Shared', status: 'pending', detail: { files: list } } as ToolItem);
  const asked = (rt.requestPermission as (r: unknown) => Promise<unknown>)({ itemId, toolName: 'SendUserFile', kind: 'share', title: 'Share', detail: { files: list }, options: [{ id: 'allow', label: 'Allow once', tone: 'allow' }, { id: 'deny', label: 'Deny', tone: 'deny' }] });
  const p = rt.prompts().permissions.find((x) => x.itemId === itemId)!;
  (rt.answerPermission as (id: string, a: unknown, o: unknown) => void)(p.id, { optionId: 'allow' }, { person: true });
  await asked;
  rt.patch(itemId, { status: 'done' });
  await rt.handing(itemId);
}

// ── #5: only the recorded bytes leave ──

describe('#5: a download sends only the bytes the share recorded', () => {
  it('a rewrite in place of the same length after the start sends nothing new: the chunk is refused and the transfer ends', async () => {
    const dir = temp('dl');
    const file = path.join(dir, 'data.bin');
    const body = pattern(FILE_CHUNK * 2 + 77, 7);
    put(file, body);
    const files = new PhoneFiles();
    const s = await files.start('p1', grantOf(file), sha(body), () => true);
    // Within the first block, from any offset: the recorded bytes.
    const a = await files.chunk('p1', s.transfer, 5, 100);
    expect(Buffer.from(a.data, 'base64').equals(body.subarray(5, 105))).toBe(true);
    // The second block rewritten in place: the same file, the same size.
    inPlace(file, Buffer.alloc(FILE_CHUNK, 0x41), FILE_CHUNK);
    const sent: string[] = [];
    // A part that reaches into it: nothing of it goes.
    await expect(files.chunk('p1', s.transfer, FILE_CHUNK - 10, 100).then((r) => sent.push(r.data))).rejects.toThrow('That file changed after it was shared.');
    expect(sent).toEqual([]);
    // The transfer ended with it.
    await expect(files.chunk('p1', s.transfer, 0)).rejects.toThrow('That download is no longer open. Start it again.');
    expect(files.count('p1')).toBe(0);
  });

  it('the recorded bytes go whole, from any offset and in any size', async () => {
    const dir = temp('dl2');
    const file = path.join(dir, 'data.bin');
    const body = pattern(FILE_CHUNK * 3 + 5, 3);
    put(file, body);
    const files = new PhoneFiles();
    const s = await files.start('p1', grantOf(file), sha(body), () => true);
    const parts: Buffer[] = [];
    for (let at = 0; at < body.length; ) {
      const r = Buffer.from((await files.chunk('p1', s.transfer, at, 100_003)).data, 'base64');
      expect(r.length).toBeGreaterThan(0);
      parts.push(r);
      at += r.length;
    }
    expect(Buffer.concat(parts).equals(body)).toBe(true);
    expect(Buffer.from((await files.chunk('p1', s.transfer, body.length)).data, 'base64').length).toBe(0);
  });
});

/** A real PNG of `w` x `h` in one grey (stored, so the same size whatever the grey). */
function png(w: number, h: number, grey: number): Buffer {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  const raw = Buffer.alloc((w + 1) * h, grey);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}
const url = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString('base64')}`;

async function thumbSetup(opts: Parameters<typeof registerThumbs>[1]) {
  const home = temp('thumb');
  const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
  apps.push(app);
  registerThumbs(app, opts);
  const cwd = path.join(home, 'chat');
  mkdirSync(cwd, { recursive: true });
  const id = (await app.call('session.create', { provider: 'demo', cwd })).session.id;
  const rt = app.sessions.get(id)!;
  const put = (name: string, body: Buffer | string) => {
    const f = path.join(cwd, name);
    writeFileSync(f, body);
    utimesSync(f, 1_700_000_000, 1_700_000_000);
    return f;
  };
  const phone = (itemId: string, index = 0) => pictureOf(app, { sessionId: id, itemId, index, size: 160 }, 'phone').then((r) => r.data);
  return { app, rt, put, phone, allowed: (itemId: string, files: string[]) => allowedShare(rt as never, itemId, files) };
}

describe("#5: a phone's preview is made only of the bytes the share recorded", () => {
  it('the same file rewritten in place, its size and time put back: no picture of the other bytes', async () => {
    const h = await thumbSetup({ pdf: null });
    const f = h.put('shot.png', png(4, 3, 10));
    await h.allowed('s1', [f]);
    inPlace(f, png(4, 3, 200));
    expect(await h.phone('s1')).not.toBe(url('image/png', png(4, 3, 200)));
    expect(await h.phone('s1')).toBeNull();
  });

  it('pictures are kept by the digest too: a later share of the same file, rewritten in place, is pictured from its own bytes', async () => {
    const h = await thumbSetup({ pdf: null });
    const f = h.put('shot.png', png(4, 3, 10));
    await h.allowed('s1', [f]);
    expect(await h.phone('s1')).toBe(url('image/png', png(4, 3, 10)));
    inPlace(f, png(4, 3, 200));
    await h.allowed('s2', [f]);
    expect(await h.phone('s2')).toBe(url('image/png', png(4, 3, 200)));
  });

  it('a renderer that takes a path is given a copy only of the recorded bytes', async () => {
    const seen: string[] = [];
    const host = {
      async thumbnail(file: string) {
        seen.push(readFileSync(file, 'utf8'));
        return { mime: 'image/jpeg' as const, data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) };
      },
    };
    const h = await thumbSetup({ host, pdf: null });
    const f = h.put('clip.mp4', 'video one!');
    await h.allowed('s1', [f]);
    inPlace(f, 'video two!');
    expect(await h.phone('s1')).toBeNull();
    expect(seen).toEqual([]);
    // As shared, it is pictured.
    inPlace(f, 'video one!');
    expect(await h.phone('s1')).toBe(url('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xd9])));
    expect(seen).toEqual(['video one!']);
  });
});

// ── #22: bounded work in flight, and refusals for now that say so ──

describe('#22: chunk reads in flight are bounded before anything is allocated', () => {
  async function transfers(n: number, blocks = 6) {
    const dir = temp('flight');
    const files = new PhoneFiles();
    const out: { transfer: string; body: Buffer }[] = [];
    for (let i = 0; i < n; i++) {
      const file = path.join(dir, `f${i}.bin`);
      const body = pattern(FILE_CHUNK * blocks, 5 + i);
      put(file, body);
      const s = await files.start('p1', grantOf(file), sha(body), () => true);
      out.push({ transfer: s.transfer, body });
    }
    return { files, list: out };
  }
  const retryable = (r: PromiseSettledResult<unknown>) => {
    expect(r.status).toBe('rejected');
    const e = (r as PromiseRejectedResult).reason as { retry?: unknown; retryAfterMs?: unknown; message?: string };
    expect(e.retry).toBe(true);
    expect(typeof e.retryAfterMs === 'number' && e.retryAfterMs > 0).toBe(true);
    expect(e.message).toBeTruthy();
  };

  it('per transfer: beyond its reads in flight a chunk is refused for now, with no buffer allocated for it', async () => {
    const before = gate.opened;
    const { files, list } = await transfers(1);
    const t = list[0];
    gate.which = new Set([before]);
    gate.on = true;
    const alloc = vi.spyOn(Buffer, 'allocUnsafe');
    const asks = Array.from({ length: FLIGHT.transfer + 3 }, (_, i) => files.chunk('p1', t.transfer, i * FILE_CHUNK));
    const allocated = alloc.mock.calls.length;
    alloc.mockRestore();
    asks.forEach((p) => p.catch(() => {}));
    expect(allocated).toBe(FLIGHT.transfer);
    for (const r of await Promise.allSettled(asks.slice(FLIGHT.transfer))) retryable(r);
    await until(() => gate.reads === FLIGHT.transfer);
    release();
    const done = await Promise.all(asks.slice(0, FLIGHT.transfer));
    done.forEach((r, i) => expect(Buffer.from(r.data, 'base64').equals(t.body.subarray(i * FILE_CHUNK, (i + 1) * FILE_CHUNK))).toBe(true));
    // Once they are done, the next one is served.
    const next = await files.chunk('p1', t.transfer, 3 * FILE_CHUNK);
    expect(Buffer.from(next.data, 'base64').equals(t.body.subarray(3 * FILE_CHUNK, 4 * FILE_CHUNK))).toBe(true);
  });

  it("per phone: reads still under way for a transfer that ended count, and so do the reads' bytes", async () => {
    const before = gate.opened;
    const { files, list } = await transfers(4);
    gate.which = new Set([before, before + 1, before + 2, before + 3]);
    gate.on = true;
    // Two reads in flight on each: the phone's reads all taken.
    const held = list.flatMap((t) => [files.chunk('p1', t.transfer, 0), files.chunk('p1', t.transfer, FILE_CHUNK)]);
    held.forEach((p) => p.catch(() => {}));
    expect(held.length).toBe(FLIGHT.phone);
    // The first ends while its reads are under way; a new one opens.
    files.end('p1', list[0].transfer);
    const dir = temp('flight5');
    const file = path.join(dir, 'f5.bin');
    const body = pattern(FILE_CHUNK * 2, 11);
    put(file, body);
    const s5 = await files.start('p1', grantOf(file), sha(body), () => true);
    const [r5] = await Promise.allSettled([files.chunk('p1', s5.transfer, 0)]);
    retryable(r5);
    release();
    await Promise.allSettled(held);
    expect(Buffer.from((await files.chunk('p1', s5.transfer, 0)).data, 'base64').equals(body.subarray(0, FILE_CHUNK))).toBe(true);
  });

  it('per phone, in bytes: parts that span two blocks take both', async () => {
    const before = gate.opened;
    const { files, list } = await transfers(4);
    gate.which = new Set([before, before + 1, before + 2, before + 3]);
    gate.on = true;
    // One part across a block boundary on each transfer, until the phone's bytes are taken.
    const span = 2 * FILE_CHUNK;
    const fit = Math.floor(FLIGHT.bytes / span);
    const held = list.slice(0, Math.min(4, fit)).map((t) => files.chunk('p1', t.transfer, FILE_CHUNK / 2));
    held.forEach((p) => p.catch(() => {}));
    const used = held.length * span;
    // The next part on a transfer with room for a read, once the phone's bytes would go over.
    const asks: Promise<unknown>[] = [];
    for (let i = 0; used + (i + 1) * FILE_CHUNK <= FLIGHT.bytes && i < 8; i++) asks.push(files.chunk('p1', list[(held.length + i) % 4].transfer, 4 * FILE_CHUNK));
    const over = files.chunk('p1', list[0].transfer, 4 * FILE_CHUNK);
    const [r] = await Promise.allSettled([over]);
    retryable(r);
    release();
    await Promise.allSettled([...held, ...asks]);
  });

  it("a phone's starts wait their turn; beyond those that may wait, a start is refused for now", async () => {
    const dir = temp('starts');
    const files = new PhoneFiles();
    const grants = Array.from({ length: FLIGHT.starts + 2 }, (_, i) => {
      const file = path.join(dir, `s${i}.bin`);
      put(file, pattern(FILE_CHUNK + i, 13 + i));
      return grantOf(file);
    });
    // The first start's read of its file is held.
    gate.which = new Set([gate.opened]);
    gate.on = true;
    const first = files.start('p1', grants[0], grants[0].sha256, () => true);
    await until(() => gate.reads === 1);
    const waiting = grants.slice(1, 1 + FLIGHT.starts).map((g) => files.start('p1', g, g.sha256, () => true));
    waiting.forEach((p) => p.catch(() => {}));
    const [over] = await Promise.allSettled([files.start('p1', grants[grants.length - 1], grants[grants.length - 1].sha256, () => true)]);
    retryable(over);
    // Another phone is not held behind this one's.
    const other = await files.start('p2', grantOf(grants[1].path, 'p2'), grants[1].sha256, () => true);
    expect(other.transfer).toBeTruthy();
    release();
    // Four open at most, and one in use is never closed for a new start: the fifth is refused for now
    // (review wave 6, #17: tests/boundary-wave6.test.ts), the four before it stay open.
    const all = await Promise.allSettled([first, ...waiting]);
    const opened = all.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ transfer: string }>).value);
    expect(opened.length).toBe(4);
    expect(new Set(opened.map((s) => s.transfer)).size).toBe(4);
    retryable(all[4]);
    expect(files.count('p1')).toBe(4);
  });
});

describe('#22: over the sealed connection, a refusal for now says so', () => {
  it('a chunk beyond what may be in flight is answered with retry and retryAfterMs; the ones in flight complete', async () => {
    const home = temp('wire');
    const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
    apps.push(app);
    registerPhone(app, { port: 0, host: '127.0.0.1' });
    const status = await app.call('phone.setEnabled', { on: true });
    const { c } = await pairSecure(app, status.port!);
    const cwd = path.join(home, 'chat');
    mkdirSync(cwd);
    const id = (await app.call('session.create', { provider: 'demo', cwd })).session.id;
    const rt = app.sessions.get(id)!;
    const file = path.join(cwd, 'data.bin');
    const body = pattern(FILE_CHUNK * 6, 9);
    put(file, body);
    await allowedShare(rt as never, 's1', [file]);
    const at = gate.opened;
    const s = (await c.call('phone.fileStart', { sessionId: id, itemId: 's1', index: 0 }, 10_000)) as { ok: boolean; result: { transfer: string }; error?: string };
    expect(s.error).toBeUndefined();
    gate.which = new Set([at]);
    gate.on = true;
    const asks = Array.from({ length: FLIGHT.transfer }, (_, i) => c.call('phone.fileChunk', { transfer: s.result.transfer, offset: i * FILE_CHUNK }, 10_000));
    await until(() => gate.reads === FLIGHT.transfer);
    const over = (await c.call('phone.fileChunk', { transfer: s.result.transfer, offset: 5 * FILE_CHUNK }, 3000)) as { ok: boolean; error?: string; retry?: boolean; retryAfterMs?: number };
    expect(over.ok).toBe(false);
    expect(over.retry).toBe(true);
    expect(over.retryAfterMs).toBeGreaterThan(0);
    expect(over.error).toBeTruthy();
    release();
    const done = (await Promise.all(asks)) as { ok: boolean; result?: { data: string } }[];
    done.forEach((r, i) => expect(Buffer.from(r.result!.data, 'base64').equals(body.subarray(i * FILE_CHUNK, (i + 1) * FILE_CHUNK))).toBe(true));
    c.ws.close();
  });
});

// ── #4: a tracked file's diff for the phone ──

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { cwd, windowsHide: true, stdio: 'pipe' }).toString();

function repo() {
  const home = temp('git');
  const cwd = path.join(home, 'chat');
  mkdirSync(cwd);
  git(cwd, 'init', '-q');
  writeFileSync(path.join(cwd, 'notes.txt'), 'tracked line\nsecond line\n');
  writeFileSync(path.join(cwd, 'plain.txt'), 'one\ntwo\nthree\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'first');
  mkdirSync(path.join(home, 'outside'));
  const secret = path.join(home, 'outside', 'secret.txt');
  writeFileSync(secret, 'outside secret\nmore of it\n');
  const reader = new PhoneChangesReader(async () => ({ session: { cwd }, items: [] }) as unknown as SessionSnapshot);
  return { home, cwd, secret, reader };
}

describe("#4: the phone's diff of a tracked file", () => {
  it("a tracked file replaced by a hard link to a file outside the chat: the phone never gets the outside file's text", async () => {
    const { cwd, secret, reader } = repo();
    const notes = path.join(cwd, 'notes.txt');
    unlinkSync(notes);
    linkSync(secret, notes);
    const list = await reader.changes('s1');
    expect(list.files.map((f) => f.path)).toContain('notes.txt');
    let said: string;
    try {
      said = JSON.stringify(await reader.diff('s1', 'notes.txt'));
    } catch (err) {
      said = String((err as Error).message);
    }
    expect(said).not.toContain('outside secret');
    expect(said).not.toContain('more of it');
  });

  it("an ordinary change: as git's own diff shows it where the file is established to lie in the folder, else withheld with a sentence", async () => {
    const { cwd, reader } = repo();
    writeFileSync(path.join(cwd, 'plain.txt'), 'one\n2\nthree\nfour\n');
    const ours = await reader.diff('s1', 'plain.txt').then(
      (r) => r,
      (err: Error) => err.message,
    );
    if (CONTAIN.how !== 'none') {
      const theirs = (await gitDiff(cwd, 'plain.txt')).find((d) => d.path === 'plain.txt')!;
      expect(typeof ours === 'object' && ours.diff?.hunks).toEqual(theirs.hunks);
      expect(typeof ours === 'object' && [ours.diff?.additions, ours.diff?.deletions]).toEqual([2, 1]);
    } else expect(ours).toBe("This file's changes show only on the computer: it could not be confirmed to lie in the chat's folder.");
  });
});
