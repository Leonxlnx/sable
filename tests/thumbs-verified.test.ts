/**
 * Pictures of shared files are made of the very file that was checked (review wave 3):
 * - #3: a PDF or video waiting for its renderer is drawn from an immutable copy made from the checked
 *   handle, never from whatever is at its path when the renderer gets to it; pictures are kept by the
 *   checked file's identity, so another file with the same path, size and time is pictured anew.
 * - #20: a cold chat is read by the asynchronous, coalesced reader, never synchronously.
 * - #21: Windows' PDF renderer draws a very tall page within a bounded height and pixel count.
 * Demo agent and fakes only: nothing real is started.
 */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { pictureOf, registerThumbs, windowsPdfPage, type ThumbHost, type ThumbImage } from '../server/services/thumbs';
import { CONTAIN } from '../server/core/contain';

// These tests are about pictures of shared files, not containment. Where no handle names its file (Windows), the
// default ('none') counts every file as external, so a share reaches a phone only when the person
// allowed it (review wave 5, #7: tests/contain.test.ts, tests/files-wave5.test.ts). Here the walks
// ('walk') stand in for Linux's proof, so a plain file in the chat folder counts as inside as it does there.
if (CONTAIN.how === 'none') CONTAIN.how = 'walk';

const homes: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A real PNG of `w` x `h` in one grey. */
function png(w = 4, h = 3, grey = 128): Buffer {
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

/** A one-page PDF of `w` x `h` points. */
function pdf(w = 595, h = 842, label = 'Thumbnail'): Buffer {
  const content = `BT /F1 6 Tf 1 ${h - 10} Td (${label}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** One whole second for every file's time, so a replacement can carry exactly the same. */
const T = 1_700_000_000;

function gate() {
  let open!: () => void;
  const shut = new Promise<void>((r) => (open = r));
  return { wait: () => shut, open };
}

async function setup(opts: Parameters<typeof registerThumbs>[1]) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-thumbs-v-'));
  homes.push(home);
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
    utimesSync(f, T, T);
    return f;
  };
  /** A share that goes through now: the bridge records what it handed over. */
  const share = (itemId: string, files: string[]) => {
    rt.add({ id: itemId, type: 'tool', name: 'SendUserFile', kind: 'share', title: 'Shared', status: 'running', detail: { files: files.map((p) => ({ path: p, name: path.basename(p) })) } } as never);
    rt.patch(itemId, { status: 'done' } as never);
  };
  const phone = (itemId: string, index = 0) => pictureOf(app, { sessionId: id, itemId, index, size: 160 }, 'phone').then((r) => r.data);
  const desk = (itemId: string, index = 0) => app.call('file.thumb', { sessionId: id, itemId, index, size: 320 } as never).then((r) => (r as { data: string | null }).data);
  /** Another file of the same size and time takes the place of `f` (a build writes it aside and moves it over). */
  const replace = (f: string, body: Buffer | string) => {
    const was = statSync(f);
    const next = `${f}.next`;
    writeFileSync(next, body);
    utimesSync(next, T, T);
    // Windows refuses the move while a reader still holds the file for a moment (under a full parallel
    // run the copy for the renderer can take a while): try again briefly, as a build tool would.
    for (let i = 0; ; i++) {
      try {
        renameSync(next, f);
        break;
      } catch (err) {
        if (i >= 240 || (err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    expect(statSync(f).size).toBe(was.size);
    expect(statSync(f).mtimeMs).toBe(was.mtimeMs);
  };
  return { app, home, cwd, id, rt, put, share, phone, desk, replace };
}

const url = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString('base64')}`;

describe('#3: a picture is made of the file that was checked', () => {
  it('a PDF waiting behind another is drawn from what was checked, not from what replaced it meanwhile', async () => {
    const g = gate();
    const drawn: string[] = [];
    const h = await setup({
      pdf: async (file) => {
        const body = readFileSync(file, 'latin1');
        drawn.push(/\((\w+)\) Tj/.exec(body)?.[1] ?? '?');
        if (drawn.length === 1) await g.wait();
        return { mime: 'image/png', data: png(2, 3) };
      },
    });
    const a = h.put('a.pdf', pdf(595, 842, 'first'));
    const b = h.put('b.pdf', pdf(595, 842, 'shared'));
    h.share('s', [a, b]);
    const first = h.phone('s', 0);
    await vi.waitFor(() => expect(drawn).toHaveLength(1));
    const second = h.phone('s', 1);
    await new Promise((r) => setTimeout(r, 50));
    // While b waits for the renderer, another PDF of the same size and time takes its place.
    h.replace(b, pdf(595, 842, 'secret'));
    g.open();
    await Promise.all([first, second]);
    expect(drawn).toEqual(['first', 'shared']);
  });

  it("the desktop shell is given a copy of the file that was checked, never the path's later file", async () => {
    const g = gate();
    const seen: string[] = [];
    const host: ThumbHost = {
      async thumbnail(file) {
        seen.push(readFileSync(file, 'utf8'));
        if (seen.length === 1) await g.wait();
        return { mime: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) } as ThumbImage;
      },
    };
    const h = await setup({ host, pdf: null });
    const a = h.put('a.mp4', 'video one!');
    const b = h.put('b.mp4', 'video two!');
    h.share('s', [a, b]);
    const first = h.phone('s', 0);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const second = h.phone('s', 1);
    await new Promise((r) => setTimeout(r, 50));
    h.replace(b, 'other one!');
    g.open();
    await Promise.all([first, second]);
    expect(seen).toEqual(['video one!', 'video two!']);
  });

  it('another file with the same path, size and time is pictured as itself, not from what was kept', async () => {
    const h = await setup({ pdf: null });
    const f = h.put('shot.png', png(4, 3, 10));
    h.share('s1', [f]);
    expect(await h.phone('s1')).toBe(url('image/png', png(4, 3, 10)));
    expect(await h.desk('s1')).toBe(url('image/png', png(4, 3, 10)));
    h.replace(f, png(4, 3, 200));
    // Shared again: the phone gets the new file's picture.
    h.share('s2', [f]);
    expect(await h.phone('s2')).toBe(url('image/png', png(4, 3, 200)));
    // The desktop shows the file as it is now.
    expect(await h.desk('s1')).toBe(url('image/png', png(4, 3, 200)));
    // The phone's old share no longer names the file it handed over.
    await expect(h.phone('s1')).rejects.toThrow('That file changed after it was shared.');
  });
});

describe('#20: a cold chat is read without holding the bridge', () => {
  it('file.thumb and phone.thumb read a chat not opened yet with the asynchronous reader, once', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-thumbs-cold-'));
    homes.push(home);
    const cwd = path.join(home, 'chat');
    mkdirSync(cwd);
    writeFileSync(path.join(cwd, 'a.png'), png());
    const first = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
    const id = (await first.call('session.create', { provider: 'demo', cwd })).session.id;
    const rt0 = first.sessions.get(id)!;
    rt0.add({ id: 's', type: 'tool', name: 'SendUserFile', kind: 'share', title: 'Shared', status: 'running', detail: { files: [{ path: 'a.png', name: 'a.png' }] } } as never);
    rt0.patch('s', { status: 'done' } as never);
    await first.dispose();

    const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
    apps.push(app);
    registerThumbs(app, { pdf: null });
    const sync = vi.spyOn(app.store, 'loadSession');
    const async = vi.spyOn(app.store, 'loadSessionAsync');
    const [d, p] = await Promise.all([app.call('file.thumb', { sessionId: id, itemId: 's', index: 0 } as never), pictureOf(app, { sessionId: id, itemId: 's', index: 0 }, 'phone')]);
    expect((d as { data: string }).data).toBe(url('image/png', png()));
    expect(p.data).toBe(url('image/png', png()));
    expect(sync).not.toHaveBeenCalled();
    expect(async).toHaveBeenCalledTimes(1);
  });
});

describe("#21: Windows' PDF renderer keeps within its bounds", () => {
  it.runIf(process.platform === 'win32')('draws only the top of a very tall, narrow page, within a bounded height', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-thumbs-tall-'));
    homes.push(home);
    const f = path.join(home, 'tall.pdf');
    writeFileSync(f, pdf(10, 4000));
    const t = await windowsPdfPage(f, 160);
    expect(t?.mime).toBe('image/png');
    const w = t!.data.readUInt32BE(16);
    const hgt = t!.data.readUInt32BE(20);
    expect(w).toBeGreaterThanOrEqual(160);
    expect(hgt).toBeLessThanOrEqual(2 * w);
    // An ordinary page keeps its proportions.
    writeFileSync(f, pdf());
    const a4 = await windowsPdfPage(f, 160);
    const ratio = a4!.data.readUInt32BE(20) / a4!.data.readUInt32BE(16);
    expect(ratio).toBeGreaterThan(1.35);
    expect(ratio).toBeLessThan(1.48);
  }, 60_000);
});
