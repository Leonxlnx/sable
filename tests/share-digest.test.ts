/**
 * A share records the bytes it handed over as it completes (review wave 4, #6): the SHA-256 of the
 * file read through the very handle the share opened, never the path again, recorded only when the
 * file stayed exactly as it was while it was read (else `unhashed: 'changed'`), `big` above the cap
 * without reading, `unreadable` when a read fails; every handle closed on every path. Small files
 * (within `HASH_AT_ONCE` together) are read before the step's patch returns, so their handles are
 * closed by then and a build may replace them at once; bigger ones after, the step's patch never
 * waiting for them: their digest comes as a patch of its own that is saved with the session, and a
 * share rewound or removed meanwhile is left alone. `handing` resolves once the digest is recorded.
 * `node:fs` is wrapped only to see the handles and to break or change a read.
 * Fakes only: no agent process starts.
 */
import { createHash } from 'node:crypto';
import type { PathLike } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEvent, SessionMeta, ToolItem } from '@shared/protocol';
import { CONTAIN } from '../server/core/contain';

// These tests are about a share's digests, not containment. Where no handle names its file (Windows), the
// default ('none') counts every file as external, so a share reaches a phone only when the person
// allowed it (review wave 5, #7: tests/contain.test.ts, tests/files-wave5.test.ts). Here the walks
// ('walk') stand in for Linux's proof, so a plain file in the chat folder counts as inside as it does there.
if (CONTAIN.how === 'none') CONTAIN.how = 'walk';

const seen = { opened: new Map<number, string>(), closed: new Set<number>(), reads: [] as string[] };
const hook: { read?: (file: string) => Error | void } = {};

vi.mock('node:fs', async (importOriginal) => {
  const m = await importOriginal<typeof import('node:fs')>();
  const openSync = ((file: PathLike, ...rest: unknown[]) => {
    const fd = (m.openSync as (...a: unknown[]) => number)(file, ...rest);
    seen.opened.set(fd, String(file));
    seen.closed.delete(fd);
    return fd;
  }) as typeof m.openSync;
  const closeSync = ((fd: number) => {
    seen.closed.add(fd);
    return m.closeSync(fd);
  }) as typeof m.closeSync;
  const close = ((fd: number, cb?: (e: NodeJS.ErrnoException | null) => void) => {
    seen.closed.add(fd);
    return m.close(fd, cb ?? (() => {}));
  }) as typeof m.close;
  const read = ((fd: number, ...rest: unknown[]) => {
    const file = seen.opened.get(fd) ?? '';
    seen.reads.push(file);
    const broken = hook.read?.(file);
    const cb = rest[rest.length - 1] as (e: Error | null, n?: number) => void;
    if (broken) return void process.nextTick(cb, broken);
    return (m.read as (...a: unknown[]) => void)(fd, ...rest);
  }) as typeof m.read;
  const readSync = ((fd: number, ...rest: unknown[]) => {
    const file = seen.opened.get(fd) ?? '';
    seen.reads.push(file);
    const broken = hook.read?.(file);
    if (broken) throw broken;
    return (m.readSync as (...a: unknown[]) => number)(fd, ...rest);
  }) as typeof m.readSync;
  const mine = { openSync, closeSync, close, read, readSync };
  return { ...m, ...mine, default: { ...m, ...mine } };
});

const fs = await import('node:fs');
const { SessionRuntime } = await import('../server/core/runtime');
const { HASH_AT_ONCE, HASH_MAX, handOver } = await import('../server/core/handed');
const { SessionFiles } = await import('../server/core/session-file');

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  hook.read = undefined;
  seen.opened.clear();
  seen.closed.clear();
  seen.reads.length = 0;
  while (cleanups.length) await cleanups.pop()!();
});

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
/** Bigger than what is read at once: its digest comes after the step's patch. */
const big = (fill: number) => Buffer.alloc(HASH_AT_ONCE + 512 * 1024, fill);

function place() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'sable-digest-')));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const cwd = path.join(home, 'chat');
  fs.mkdirSync(cwd);
  const now = Date.now();
  const meta: SessionMeta = { id: 's1', provider: 'claude', cwd, title: 't', titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: now, updatedAt: now, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
  const events: BridgeEvent[] = [];
  const dirty: string[] = [];
  const rt = new SessionRuntime(meta, (e) => events.push(e), (_rt, what) => dirty.push(what));
  const put = (rel: string, body: Buffer | string) => {
    const f = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
    return f;
  };
  const share = (id: string, files: string[]) => {
    rt.add<ToolItem>({ id, type: 'tool', name: 'SendUserFile', kind: 'share', title: 'Shared', status: 'running', detail: { files: files.map((p) => ({ path: p, name: path.basename(p) })) } });
    rt.patch<ToolItem>(id, { status: 'done', endedAt: Date.now() });
  };
  const handed = (id: string) => rt.get<ToolItem>(id)!.handed!;
  return { home, cwd, rt, events, dirty, put, share, handed };
}

/** The handles opened for `file` since the test began, and whether each is closed. */
const handlesOf = (file: string) => [...seen.opened].filter(([, f]) => f.toLowerCase() === file.toLowerCase()).map(([fd]) => ({ fd, closed: seen.closed.has(fd) }));

describe('the bytes a share handed over', () => {
  it('of small files are recorded before the step is patched, their handles closed by then', () => {
    expect(HASH_AT_ONCE).toBeGreaterThan(0);
    const { cwd, rt, put, share, handed } = place();
    const f = put('build/app.apk', 'build one');
    share('s1', ['build/app.apk']);
    expect(handed('s1')[0]).toMatchObject({ inside: true, size: 9, sha256: sha('build one') });
    expect(rt.handing('s1')).toBeUndefined();
    expect(handlesOf(f).every((h) => h.closed)).toBe(true);
    // A build may move a new file over it, and rename its folder, right away.
    fs.writeFileSync(`${f}.next`, 'build two');
    fs.renameSync(`${f}.next`, f);
    fs.renameSync(path.join(cwd, 'build'), path.join(cwd, 'build-old'));
    expect(handed('s1')[0]!.sha256).toBe(sha('build one'));
  });

  it('of bigger files are recorded after the step is patched, which never waits for them', async () => {
    const { rt, events, put, share, handed } = place();
    const body = big(7);
    const f = put('reports/audit.bin', body);
    share('s1', ['reports/audit.bin']);
    // The step is done at once; its digest is still being read.
    expect(rt.get<ToolItem>('s1')!.status).toBe('done');
    expect(handed('s1')[0]).toMatchObject({ inside: true, size: body.length });
    expect(handed('s1')[0]?.sha256).toBeUndefined();
    expect(handed('s1')[0]?.unhashed).toBeUndefined();
    const pending = rt.handing('s1');
    expect(pending).toBeInstanceOf(Promise);
    rt.takeDirty();
    const before = events.length;
    await pending;
    expect(handed('s1')[0]?.sha256).toBe(sha(body));
    expect(handed('s1')[0]?.unhashed).toBeUndefined();
    // As a patch of its own (a new list), marked for the next save.
    const patch = events.slice(before).find((e) => e.type === 'item.patch' && e.id === 's1') as Extract<BridgeEvent, { type: 'item.patch' }> | undefined;
    expect((patch?.patch as Partial<ToolItem>)?.handed?.[0]?.sha256).toBe(sha(body));
    expect(rt.takeDirty()).toEqual(new Set(['s1']));
    // Nothing pending any more; the handle the share opened is closed.
    expect(rt.handing('s1')).toBeUndefined();
    expect(handlesOf(f).every((h) => h.closed)).toBe(true);
  });

  it('keep describing the shared bytes after the file is rewritten in place, size and time restored', async () => {
    const { rt, put, share, handed } = place();
    const small = put('app.apk', 'build one');
    const large = put('app.aab', big(1));
    share('s1', ['app.apk', 'app.aab']);
    await rt.handing('s1');
    // A reproducible build writes other bytes of the same length into the same files and puts their times back.
    for (const [f, body] of [
      [small, 'build two'],
      [large, big(2)],
    ] as const) {
      const was = fs.statSync(f);
      fs.writeFileSync(f, body);
      fs.utimesSync(f, was.atimeMs / 1000, was.mtimeMs / 1000);
      expect(fs.statSync(f).size).toBe(was.size);
    }
    expect(handed('s1').map((h) => h?.sha256)).toEqual([sha('build one'), sha(big(1))]);
  });

  it('are read through the handle the share opened, never by its path again', async () => {
    const { rt, put, share, handed } = place();
    const f = put('notes.bin', big(3));
    share('s1', ['notes.bin']);
    expect(handlesOf(f)).toHaveLength(1);
    // Whatever takes the path now is not what was shared.
    fs.unlinkSync(f);
    fs.writeFileSync(f, big(4));
    await rt.handing('s1');
    expect(handlesOf(f)).toHaveLength(1);
    const h = handed('s1')[0]!;
    expect(h.sha256).not.toBe(sha(big(4)));
    expect(h.sha256 === sha(big(3)) || h.unhashed === 'changed').toBe(true);
  });

  it('that change while they are read are recorded as changed, not hashed', async () => {
    const { rt, put, share, handed } = place();
    const body = Buffer.alloc(3 * 1024 * 1024, 1);
    const f = put('build/app.apk', body);
    const g = put('build/grows.log', 'a line\n');
    let rewrote = false;
    let grew = false;
    hook.read = (file) => {
      if (file.toLowerCase() === f.toLowerCase() && !rewrote) {
        rewrote = true;
        const was = fs.statSync(f);
        // Rewritten in place while it is read, its length and time put back.
        fs.writeFileSync(f, Buffer.alloc(body.length, 2));
        fs.utimesSync(f, was.atimeMs / 1000, was.mtimeMs / 1000);
      }
      if (file.toLowerCase() === g.toLowerCase() && !grew) {
        grew = true;
        fs.appendFileSync(g, 'another line\n');
      }
    };
    share('s1', ['build/app.apk', 'build/grows.log']);
    await rt.handing('s1');
    expect(rewrote && grew).toBe(true);
    expect(handed('s1').map((h) => [h?.sha256, h?.unhashed])).toEqual([
      [undefined, 'changed'],
      [undefined, 'changed'],
    ]);
    expect([...handlesOf(f), ...handlesOf(g)].every((h) => h.closed)).toBe(true);
  });

  it('that cannot be read are recorded as unreadable, the handle closed', async () => {
    const { rt, put, share, handed } = place();
    const f = put('disk.img', 'bad sector');
    const g = put('disk2.img', big(5));
    const eio = () => Object.assign(new Error('i/o error'), { code: 'EIO' });
    hook.read = (file) => ([f, g].some((x) => x.toLowerCase() === file.toLowerCase()) ? eio() : undefined);
    share('s1', ['disk.img', 'disk2.img']);
    await rt.handing('s1');
    expect(handed('s1').map((h) => [h?.sha256, h?.unhashed])).toEqual([
      [undefined, 'unreadable'],
      [undefined, 'unreadable'],
    ]);
    expect([...handlesOf(f), ...handlesOf(g)].every((h) => h.closed)).toBe(true);
  });

  it('over the cap are not read at all: big, decided as the share completes', async () => {
    expect(HASH_MAX).toBe(2 * 1024 ** 3);
    const { cwd, put } = place();
    const f = put('movie.mp4', 'twelve bytes');
    const small = put('small.txt', 'ok');
    const got = handOver(cwd, [{ path: 'movie.mp4', name: 'movie.mp4' }, { path: 'small.txt', name: 'small.txt' }, { path: 'gone.txt', name: 'gone.txt' }], undefined, { hashMax: 4, atOnce: 0 });
    expect(got.handed[0]).toMatchObject({ unhashed: 'big', size: 12 });
    expect(got.handed[1]?.unhashed).toBeUndefined();
    expect(got.handed[2]).toBeNull();
    // The big one's handle is closed at once and never read.
    expect(handlesOf(f).every((h) => h.closed)).toBe(true);
    expect(seen.reads.some((r) => r.toLowerCase() === f.toLowerCase())).toBe(false);
    const next = await got.digests!;
    expect(next[0]).toMatchObject({ unhashed: 'big' });
    expect(next[1]?.sha256).toBe(sha('ok'));
    expect(next[2]).toBeNull();
    expect(handlesOf(small).every((h) => h.closed)).toBe(true);
    // Nothing left to read: no digests to wait for.
    expect(handOver(cwd, [{ path: 'movie.mp4', name: 'movie.mp4' }], undefined, { hashMax: 4 }).digests).toBeUndefined();
  });

  it('are kept with the session: saved and read back', async () => {
    const { home, rt, dirty, put, share } = place();
    put('audit.txt', 'the audit');
    put('audit.bin', big(6));
    share('s1', ['audit.txt', 'audit.bin']);
    const n = dirty.length;
    await rt.handing('s1');
    expect(dirty.slice(n)).toContain('items');
    const files = new SessionFiles((id) => path.join(home, `${id}.json`));
    await files.save('s1', () => ({ items: rt.items, todos: rt.todos, dirty: rt.takeDirty() }));
    await files.idle();
    const back = new SessionFiles((id) => path.join(home, `${id}.json`)).load('s1');
    const item = back.items.find((i) => i.id === 's1') as ToolItem;
    expect(item.handed?.[0]).toMatchObject({ sha256: sha('the audit'), inside: true, size: 9 });
    expect(item.handed?.[1]).toMatchObject({ sha256: sha(big(6)), inside: true });
  });

  it('of a share rewound or removed meanwhile are left alone', async () => {
    const { rt, events, put, share } = place();
    put('a.bin', big(1));
    put('b.bin', big(2));
    share('gone', ['a.bin']);
    share('rewound', ['b.bin']);
    const waits = [rt.handing('gone'), rt.handing('rewound')];
    expect(waits.every((w) => w instanceof Promise)).toBe(true);
    rt.remove('gone');
    rt.reset(rt.items.filter((i) => i.id !== 'rewound'));
    const before = events.length;
    await Promise.all(waits);
    expect(rt.get('gone')).toBeUndefined();
    expect(rt.get('rewound')).toBeUndefined();
    expect(rt.items.some((i) => i.id === 'gone' || i.id === 'rewound')).toBe(false);
    expect(events.slice(before).filter((e) => e.type === 'item.patch' || e.type === 'item.added')).toEqual([]);
  });

  it('of a share restored from before (no capture) are never made up', () => {
    const { rt, put } = place();
    put('audit.txt', 'the audit');
    rt.load([{ id: 's1', ts: 1, type: 'tool', name: 'SendUserFile', kind: 'share', title: 'audit.txt', status: 'done', detail: { files: [{ path: 'audit.txt', name: 'audit.txt' }] }, handed: [{ path: 'x', size: 9, mtimeMs: 1, ino: '1', dev: 1, inside: true }] } as ToolItem]);
    expect(rt.handing('s1')).toBeUndefined();
    expect(rt.get<ToolItem>('s1')!.handed![0]!.sha256).toBeUndefined();
    expect(rt.handing('nope')).toBeUndefined();
  });
});
