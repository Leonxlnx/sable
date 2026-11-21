/**
 * Private copies for a renderer that takes a path (review wave 4, #24): a copy is made only within
 * a bounded number of copy slots (`THUMB.copies`) and a total of temporary bytes (`THUMB.copyBytes`),
 * taken before the file is opened, and each copy is removed after use on every path (drawn, no
 * picture, a renderer that fails, a file that changed). Opening a chat with many shared videos no
 * longer copies every one of them ahead of the renderer. Demo agent and fakes only.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { registerThumbs, THUMB, type ThumbHost, type ThumbImage, type ThumbOptions } from '../server/services/thumbs';

const homes: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const JPEG: ThumbImage = { mime: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) };

function gate() {
  let open!: () => void;
  const shut = new Promise<void>((r) => (open = r));
  return { wait: () => shut, open };
}

async function setup(opts: ThumbOptions) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-thumbs-b-'));
  homes.push(home);
  const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
  apps.push(app);
  registerThumbs(app, opts);
  const cwd = path.join(home, 'chat');
  mkdirSync(cwd, { recursive: true });
  const id = (await app.call('session.create', { provider: 'demo', cwd })).session.id;
  const rt = app.sessions.get(id)!;
  // Names no other test uses: the copies on disk are found by them.
  const tag = `budget${Math.random().toString(36).slice(2, 8)}`;
  const put = (name: string, size: number) => {
    const f = path.join(cwd, `${tag}-${name}`);
    writeFileSync(f, Buffer.alloc(size, 3));
    return f;
  };
  const share = (itemId: string, files: string[]) => {
    rt.add({ id: itemId, type: 'tool', name: 'SendUserFile', kind: 'share', title: 'Shared', status: 'running', detail: { files: files.map((p) => ({ path: p, name: path.basename(p) })) } } as never);
    rt.patch(itemId, { status: 'done' } as never);
  };
  const desk = (itemId: string, index: number) => app.call('file.thumb', { sessionId: id, itemId, index, size: 320 } as never).then((r) => (r as { data: string | null }).data);
  /** The private copies of this test's files on disk now: how many, and their bytes. */
  const copies = () => {
    let n = 0;
    let bytes = 0;
    for (const d of readdirSync(tmpdir())) {
      if (!d.startsWith('sable-thumb-')) continue;
      let inside: string[] = [];
      try {
        inside = readdirSync(path.join(tmpdir(), d));
      } catch {
        continue;
      }
      for (const f of inside) {
        if (!f.startsWith(tag)) continue;
        n++;
        try {
          bytes += statSync(path.join(tmpdir(), d, f)).size;
        } catch {
          /* removed meanwhile */
        }
      }
    }
    return { n, bytes };
  };
  return { put, share, desk, copies };
}

describe('private copies for a renderer', () => {
  it('are made only within the copy slots: a chat of many videos never copies them all ahead of the shell', async () => {
    expect(THUMB.copies).toBeGreaterThanOrEqual(1);
    expect(THUMB.copyBytes).toBeGreaterThanOrEqual(THUMB.copyMax);
    const g = gate();
    let most = { n: 0, bytes: 0 };
    let h!: Awaited<ReturnType<typeof setup>>;
    const host: ThumbHost = {
      async thumbnail() {
        const now = h.copies();
        if (now.n > most.n) most = now;
        await g.wait();
        return JPEG;
      },
    };
    h = await setup({ host, pdf: null, copies: 2 });
    const size = 256 * 1024;
    const files = Array.from({ length: 8 }, (_, i) => h.put(`v${i}.mp4`, size));
    h.share('s', files);
    const all = files.map((_, i) => h.desk('s', i));
    // The shell holds the first; give every other one time to copy if it would.
    await vi.waitFor(() => expect(most.n).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 300));
    const held = h.copies();
    expect(held.n).toBeLessThanOrEqual(2);
    expect(held.bytes).toBeLessThanOrEqual(2 * size);
    g.open();
    expect((await Promise.all(all)).every((d) => d?.startsWith('data:image/jpeg'))).toBe(true);
    expect(most.n).toBeLessThanOrEqual(2);
    // Every copy is gone once its picture is made.
    await vi.waitFor(() => expect(h.copies().n).toBe(0));
  });

  it('keep within the total of temporary bytes, whatever the slots', async () => {
    const g = gate();
    let peak = 0;
    let h!: Awaited<ReturnType<typeof setup>>;
    let calls = 0;
    const host: ThumbHost = {
      async thumbnail() {
        calls++;
        peak = Math.max(peak, h.copies().bytes);
        await g.wait();
        return JPEG;
      },
    };
    const size = 300 * 1024;
    // Room for two of these at once (and a part of a third), with slots for six.
    h = await setup({ host, pdf: null, copies: 6, copyBytes: Math.floor(2.5 * size) });
    const files = Array.from({ length: 6 }, (_, i) => h.put(`m${i}.mov`, size));
    h.share('s', files);
    const all = files.map((_, i) => h.desk('s', i));
    await vi.waitFor(() => expect(calls).toBe(1));
    await new Promise((r) => setTimeout(r, 300));
    expect(h.copies().bytes).toBeLessThanOrEqual(2.5 * size);
    expect(h.copies().n).toBeLessThanOrEqual(2);
    g.open();
    await Promise.all(all);
    expect(peak).toBeLessThanOrEqual(2.5 * size);
    await vi.waitFor(() => expect(h.copies().n).toBe(0));
  });

  it('are removed and their room given back on every path (a picture, none, a failing renderer, a file gone)', async () => {
    let n = 0;
    const host: ThumbHost = {
      async thumbnail() {
        n++;
        if (n % 3 === 1) throw new Error('the shell failed');
        if (n % 3 === 2) return null;
        return JPEG;
      },
    };
    const h = await setup({ host, pdf: null, copies: 1, copyBytes: 1024 * 1024 });
    const files = Array.from({ length: 7 }, (_, i) => h.put(`c${i}.mkv`, 64 * 1024));
    h.share('s', files);
    const got = await Promise.all(files.slice(0, 6).map((_, i) => h.desk('s', i)));
    expect(got.filter((d) => d?.startsWith('data:image/jpeg'))).toHaveLength(2);
    // With one slot, every one came through: none kept its room.
    expect(n).toBe(6);
    expect(h.copies().n).toBe(0);
    // A file gone before its turn: refused, nothing copied.
    rmSync(files[6]);
    await expect(h.desk('s', 6)).rejects.toThrow('That file is no longer on the computer.');
    expect(h.copies().n).toBe(0);
  });
});
