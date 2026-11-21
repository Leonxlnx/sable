/**
 * Pictures of the files an agent hands over (server/services/thumbs.ts, `file.thumb`): only a file a
 * finished share step lists, as it was shared and not a link; kept by file, size, time and width,
 * one made per file at a time; the shell's thumbnail first, a PDF's page, then the picture file itself
 * in a dev bridge. Demo agent only: nothing real is started.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { pictureOf, pictureType, registerThumbs, setThumbHost, THUMB, thumbKind, thumbSize, Thumbs, windowsPdfPage, type ThumbHost, type ThumbOptions } from '../server/services/thumbs';
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

/** A real PNG of `w` x `h` (one grey). */
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
  ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, grey);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A one-page PDF written by hand. */
function pdf(): Buffer {
  const content = 'BT /F1 24 Tf 72 720 Td (Thumbnail) Tj ET\n0.2 0.4 0.8 rg 72 500 300 120 re f';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
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

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

async function setup(opts: ThumbOptions = { pdf: null }) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-thumbs-'));
  homes.push(home);
  const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
  apps.push(app);
  const thumbs = registerThumbs(app, opts);
  const cwd = path.join(home, 'chat');
  mkdirSync(cwd, { recursive: true });
  const id = (await app.call('session.create', { provider: 'demo', cwd })).session.id;
  const rt = app.sessions.get(id)!;
  const put = (name: string, body: Buffer | string) => {
    const f = path.join(cwd, name);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
    return f;
  };
  const share = (itemId: string, files: { path: string; name?: string; size?: number }[], status = 'done') =>
    rt.add({ id: itemId, type: 'tool', name: 'SendUserFile', kind: 'share', title: 'Shared', status, detail: { files: files.map((f) => ({ name: path.basename(f.path), ...f })) } } as never);
  const thumb = (itemId: string, index = 0, extra: Record<string, unknown> = {}) => app.call('file.thumb', { sessionId: id, itemId, index, ...extra } as never);
  return { app, thumbs, home, cwd, id, rt, put, share, thumb };
}

/** A host that answers a JPEG for every file and counts what it was asked. */
function fakeHost(delay = 0) {
  const asked: { file: string; px: number }[] = [];
  const host: ThumbHost = {
    async thumbnail(file, px) {
      asked.push({ file, px });
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return { mime: 'image/jpeg', data: JPEG };
    },
  };
  return { host, asked };
}

describe('file.thumb: what may be pictured', () => {
  it('only a file a finished share step lists, as it was shared, never a link or another place', async () => {
    const { cwd, home, put, share, thumb, rt } = await setup();
    const shot = put('shots/home.png', png());
    const size = png().length;
    share('s-done', [{ path: 'shots/home.png', size }]);
    for (const status of ['running', 'awaiting', 'denied', 'cancelled', 'error']) share(`s-${status}`, [{ path: shot, size }], status);
    rt.add({ id: 'read1', type: 'tool', name: 'Read', kind: 'read', title: 'Read', status: 'done', detail: { path: shot } } as never);

    // The file the step lists, resolved against the chat's folder: the picture itself (no shell here).
    expect((await thumb('s-done')).data).toBe(`data:image/png;base64,${png().toString('base64')}`);
    // Not a share step, or an item that is not there.
    await expect(thumb('read1')).rejects.toThrow('That file is not in this chat.');
    await expect(thumb('nope')).rejects.toThrow('That file is not in this chat.');
    // A share that is pending, was denied, stopped or failed.
    for (const status of ['running', 'awaiting', 'denied', 'cancelled', 'error']) await expect(thumb(`s-${status}`), status).rejects.toThrow('That file was not shared.');
    // Past the files it lists, or not a place in the list; a path passed along is not read.
    for (const index of [1, -1, 0.5, Number.NaN]) await expect(thumb('s-done', index)).rejects.toThrow('That file is not in this chat.');
    const elsewhere = path.join(home, 'secret.png');
    writeFileSync(elsewhere, png(9, 9, 7));
    expect((await thumb('s-done', 0, { path: elsewhere })).data).toBe(`data:image/png;base64,${png().toString('base64')}`);

    // A link to a picture outside: refused (when this user may make links).
    let linked = false;
    try {
      symlinkSync(elsewhere, path.join(cwd, 'leak.png'), 'file');
      linked = true;
    } catch {
      /* no symlinks for this user: that part is skipped */
    }
    if (linked) {
      share('s-link', [{ path: path.join(cwd, 'leak.png'), size: png(9, 9, 7).length }]);
      await expect(thumb('s-link')).rejects.toThrow('That file is a link to another place.');
    }

    // Outside the chat's folder from a share the person did not allow themselves: refused. Allowed by
    // the person for that share: that very place only (and as it is now).
    share('s-out', [{ path: elsewhere, size: png(9, 9, 7).length }]);
    await expect(thumb('s-out')).rejects.toThrow("That file is outside the chat's folder.");
    rt.add({ id: 's-allowed', type: 'tool', name: 'SendUserFile', kind: 'share', title: 'Shared', status: 'done', detail: { files: [{ path: elsewhere, name: 'secret.png' }] }, handed: [{ path: elsewhere, size: 1, mtimeMs: 1, ino: '1', inside: false, granted: true }] } as never);
    expect((await thumb('s-allowed')).data).toBe(`data:image/png;base64,${png(9, 9, 7).toString('base64')}`);
    // A step restored from before the bridge kept what a share handed over: in the chat's folder, pictured.
    share('s-old', [{ path: shot, size }]);
    delete (rt.get('s-old') as { handed?: unknown }).handed;
    expect((await thumb('s-old')).data).toBe(`data:image/png;base64,${png().toString('base64')}`);

    // Rewritten since it was shared: the card shows it as it is now. Gone: refused.
    const now = Buffer.concat([png(), Buffer.alloc(16)]);
    writeFileSync(shot, now);
    expect((await thumb('s-done')).data).toBe(`data:image/png;base64,${now.toString('base64')}`);
    rmSync(shot);
    await expect(thumb('s-done')).rejects.toThrow('That file is no longer on the computer.');
  });

  it("keeps the phone's rule for the phone: the very file the step handed over, unchanged", async () => {
    const { app, id, put, share, rt } = await setup();
    const f = put('shot.png', png());
    share('s', [{ path: f, size: png().length }]);
    const phone = () => pictureOf(app, { sessionId: id, itemId: 's', index: 0, size: 160 }, 'phone');
    expect((await phone()).data).toBe(`data:image/png;base64,${png().toString('base64')}`);
    // Rewritten: the desktop shows it as it is, the phone gets none of it.
    writeFileSync(f, Buffer.concat([png(), Buffer.alloc(8)]));
    expect((await app.call('file.thumb', { sessionId: id, itemId: 's', index: 0 })).data).toMatch(/^data:image\/png;base64,/);
    await expect(phone()).rejects.toThrow('That file changed after it was shared.');
    // No record of what the step handed over: the desktop pictures it, the phone does not.
    share('s-old', [{ path: f }]);
    delete (rt.get('s-old') as { handed?: unknown }).handed;
    expect((await app.call('file.thumb', { sessionId: id, itemId: 's-old', index: 0 })).data).toMatch(/^data:image\/png;base64,/);
    await expect(pictureOf(app, { sessionId: id, itemId: 's-old', index: 0 }, 'phone')).rejects.toThrow('Ask the agent to share that file again.');
  });

  it("refuses another chat's step and a chat that is not there", async () => {
    const { app, put, share, thumb } = await setup();
    const f = put('a.png', png());
    share('s1', [{ path: f, size: png().length }]);
    const other = (await app.call('session.create', { provider: 'demo', cwd: path.dirname(f) })).session.id;
    await expect(app.call('file.thumb', { sessionId: other, itemId: 's1', index: 0 })).rejects.toThrow('That file is not in this chat.');
    await expect(app.call('file.thumb', { sessionId: 'nope', itemId: 's1', index: 0 })).rejects.toThrow('That file is not in this chat.');
    expect((await thumb('s1')).data).toMatch(/^data:image\/png;base64,/);
  });
});

describe('file.thumb: where the picture comes from', () => {
  it('in a dev bridge: the picture file itself for common types, by its bytes, under the cap', async () => {
    const { put, share, thumb } = await setup({ pdf: null, fileMax: 1000 });
    const files = {
      png: put('a.png', png()),
      jpeg: put('b.jpg', JPEG),
      fake: put('c.png', 'not a picture at all'),
      big: put('d.png', Buffer.concat([png(), Buffer.alloc(2000)])),
      zip: put('e.zip', Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(40)])),
      doc: put('f.pdf', pdf()),
      video: put('g.mp4', Buffer.alloc(64)),
    };
    share('s', Object.values(files).map((p) => ({ path: p })));
    const got = await Promise.all(Object.keys(files).map((_, i) => thumb('s', i).then((r) => r.data)));
    expect(got[0]).toBe(`data:image/png;base64,${png().toString('base64')}`);
    expect(got[1]).toBe(`data:image/jpeg;base64,${JPEG.toString('base64')}`);
    // A ".png" that is text, a picture over the cap, a kind with no picture, a PDF and a video without a shell.
    expect(got.slice(2)).toEqual([null, null, null, null, null]);
  });

  it("gives a small picture as it is, draws a PDF's page, and asks the desktop shell for the rest", async () => {
    const { host, asked } = fakeHost();
    const pages: number[] = [];
    const { app, put, share, thumb, thumbs } = await setup({
      pdf: async (_file, px) => {
        pages.push(px);
        return { mime: 'image/png', data: png(2, 3) };
      },
    });
    // A "photo" of 300 KB: over what a row gets as it is, within what a sheet gets.
    const photo = Buffer.concat([png(), Buffer.alloc(300_000)]);
    const files = [put('a.png', png()), put('b.pdf', pdf()), put('c.mp4', Buffer.alloc(64)), put('d.zip', Buffer.alloc(64)), put('photo.png', photo)];
    share('s', files.map((p) => ({ path: p })));
    // No shell: the PDF is drawn, the video has none, the archive is never tried.
    expect((await thumb('s', 1, { size: 300 })).data).toBe(`data:image/png;base64,${png(2, 3).toString('base64')}`);
    expect(pages).toEqual([320]);
    expect((await thumb('s', 2)).data).toBeNull();
    setThumbHost(app, host);
    // A small picture as it is, at any width: the shell is not asked.
    expect((await thumb('s', 0, { size: 140 })).data).toBe(`data:image/png;base64,${png().toString('base64')}`);
    // The photo: as it is for a sheet; for a row, the shell's thumbnail (widths round up to a step).
    expect((await thumb('s', 4, { size: 320 })).data).toBe(`data:image/png;base64,${photo.toString('base64')}`);
    expect((await thumb('s', 4, { size: 150 })).data).toBe(`data:image/jpeg;base64,${JPEG.toString('base64')}`);
    // A video by the shell; a PDF still by its renderer (its own process), never the shell; an archive never.
    expect((await thumb('s', 2, { size: 9999 })).data).toMatch(/^data:image\/jpeg;base64,/);
    expect((await thumb('s', 1, { size: 96 })).data).toMatch(/^data:image\/png;base64,/);
    expect(pages).toEqual([320, 96]);
    expect((await thumb('s', 3)).data).toBeNull();
    expect(asked.map((a) => [path.basename(a.file), a.px])).toEqual([
      ['photo.png', 160],
      ['c.mp4', 480],
    ]);
    // A shell with nothing for it: the photo as it is after all (within the cap), the video none.
    thumbs.host = { thumbnail: async () => null };
    expect((await thumb('s', 4, { size: 96 })).data).toBe(`data:image/png;base64,${photo.toString('base64')}`);
    expect((await thumb('s', 2, { size: 160 })).data).toBeNull();
  });

  it('never keeps a small picture waiting behind a PDF being drawn or the shell', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { put, share, thumb } = await setup({
      pdf: async () => (await held, { mime: 'image/png', data: png(2, 3) }),
      host: { thumbnail: async () => (await held, { mime: 'image/jpeg', data: JPEG }) },
    });
    const files = [put('a.pdf', pdf()), put('b.mp4', Buffer.alloc(8)), put('c.pdf', pdf()), put('d.png', png())];
    share('s', files.map((p) => ({ path: p })));
    const slow = [thumb('s', 0), thumb('s', 1), thumb('s', 2)];
    expect((await thumb('s', 3)).data).toBe(`data:image/png;base64,${png().toString('base64')}`);
    release();
    expect((await Promise.all(slow)).map((r) => r.data?.split(';')[0])).toEqual(['data:image/png', 'data:image/jpeg', 'data:image/png']);
  });

  it("asks the shell for one picture at a time, a breather apart (it holds the desktop's main process)", async () => {
    let now = 0;
    let most = 0;
    const spans: [number, number][] = [];
    const host: ThumbHost = {
      async thumbnail() {
        most = Math.max(most, ++now);
        const t = Date.now();
        await new Promise((r) => setTimeout(r, 25));
        spans.push([t, Date.now()]);
        now--;
        return { mime: 'image/jpeg', data: JPEG };
      },
    };
    const { put, share, thumb } = await setup({ host, pdf: null });
    const files = ['a.mp4', 'b.mp4', 'c.mov', 'd.mkv'].map((n) => put(n, Buffer.alloc(32)));
    share('s', files.map((p) => ({ path: p })));
    const got = await Promise.all(files.map((_, i) => thumb('s', i)));
    expect(got.every((r) => r.data?.startsWith('data:image/jpeg'))).toBe(true);
    expect(most).toBe(1);
    spans.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) expect(spans[i][0] - spans[i - 1][1]).toBeGreaterThanOrEqual(THUMB.hostGap - 15);
  });

  it.runIf(process.platform === 'win32')("draws a PDF's first page with Windows' own renderer", async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-thumbs-pdf-'));
    homes.push(home);
    const f = path.join(home, 'page.pdf');
    writeFileSync(f, pdf());
    const t = await windowsPdfPage(f, 160);
    expect(t?.mime).toBe('image/png');
    expect(pictureType(t!.data)).toBe('image/png');
    // Its width from the PNG's header: the width asked for, in the process's own scale.
    expect(t!.data.readUInt32BE(16)).toBeGreaterThanOrEqual(160);
    // Not a PDF: none.
    writeFileSync(f, 'not a pdf');
    expect(await windowsPdfPage(f, 160)).toBeNull();
  }, 40_000);
});

describe('file.thumb: what is kept', () => {
  it('makes a picture once per file, size, time and width, one per file at a time', async () => {
    const { host, asked } = fakeHost(30);
    // Every picture by the shell here (none given as it is).
    const { put, share, thumb, thumbs } = await setup({ host, pdf: null, inline: { small: 0, large: 0 } });
    const f = put('a.png', png());
    share('s', [{ path: f }]);
    // Asked three times at once: made once.
    const all = await Promise.all([thumb('s'), thumb('s'), thumb('s')]);
    expect(new Set(all.map((r) => r.data)).size).toBe(1);
    expect(asked).toHaveLength(1);
    // Asked again: kept. Another width: made, and both kept.
    await thumb('s');
    await thumb('s', 0, { size: 160 });
    expect(asked.map((a) => a.px)).toEqual([320, 160]);
    expect(thumbs.size.entries).toBe(2);
    // One file at a time even across widths: the second waited for the first.
    asked.length = 0;
    const t0 = Date.now();
    await Promise.all([thumb('s', 0, { size: 480 }), thumb('s', 0, { size: 96 })]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
    expect(asked.map((a) => a.px).sort((a, b) => a - b)).toEqual([96, 480]);
    expect(thumbs.size.entries).toBe(4);
    expect(thumbs.made).toBe(4);
    // Rewritten in place (only its time moved): made again as it is now, its pictures of before gone.
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    await thumb('s');
    expect(asked.map((a) => a.px).sort((a, b) => a - b)).toEqual([96, 320, 480]);
    expect(thumbs.size.entries).toBe(1);
    expect(thumbs.made).toBe(5);
  });

  it("drops a file's pictures of before when it is pictured as it is now (another size or time)", async () => {
    const { host, asked } = fakeHost();
    const thumbs = new Thumbs({ host, pdf: null, inline: { small: 0, large: 0 } });
    // Real files: a picture is made only of the file as it was checked (its size and time).
    const dir = mkdtempSync(path.join(tmpdir(), 'sable-thumbs-drop-'));
    homes.push(dir);
    const at = { path: path.join(dir, 'clip.mp4'), size: 10, mtimeMs: 1000 };
    const other = { ...at, path: path.join(dir, 'other.mp4') };
    for (const f of [at, other]) {
      writeFileSync(f.path, Buffer.alloc(f.size));
      utimesSync(f.path, 1, 1);
    }
    await thumbs.thumb(at, 320);
    await thumbs.thumb(at, 160);
    await thumbs.thumb(other, 320);
    expect(thumbs.size.entries).toBe(3);
    utimesSync(at.path, 2, 2);
    await thumbs.thumb({ ...at, mtimeMs: 2000 }, 320);
    // Its two pictures of before went; the other file's stays.
    expect(thumbs.size.entries).toBe(2);
    await thumbs.thumb({ ...at, mtimeMs: 2000 }, 320);
    expect(asked).toHaveLength(4);
    // Asked by what it no longer is (its time of before): nothing is read, nothing is kept.
    expect(await thumbs.thumb(at, 96)).toBeNull();
    expect(asked).toHaveLength(4);
    expect(thumbs.size.entries).toBe(2);
  });

  it('keeps a file without a picture as none, and stays within its count', async () => {
    const asked: string[] = [];
    const host: ThumbHost = { thumbnail: async (file) => (asked.push(path.basename(file)), null) };
    const { put, share, thumb, thumbs } = await setup({ host, pdf: null });
    const files = Array.from({ length: 6 }, (_, i) => put(`clip-${i}.mp4`, Buffer.alloc(10 + i)));
    share('s', files.map((p) => ({ path: p })));
    expect((await thumb('s', 0)).data).toBeNull();
    expect((await thumb('s', 0)).data).toBeNull();
    expect(asked).toEqual(['clip-0.mp4']);
    const before = THUMB.entries;
    THUMB.entries = 3;
    try {
      for (let i = 0; i < 6; i++) await thumb('s', i);
      expect(thumbs.size.entries).toBe(3);
      // The oldest went: asked again, it is made again.
      await thumb('s', 0);
      expect(asked.filter((a) => a === 'clip-0.mp4')).toHaveLength(2);
    } finally {
      THUMB.entries = before;
    }
  });

  it('names the kinds it tries and the widths it makes', () => {
    expect(['a.PNG', 'b.jpeg', 'c.webp', 'd.pdf', 'e.mp4', 'f.MOV', 'g.docx'].map(thumbKind)).toEqual(['image', 'image', 'image', 'pdf', 'video', 'video', 'doc']);
    expect(['a.zip', 'b.apk', 'c.svg', 'd.txt', 'e.lnk', 'f.url', 'noext'].map(thumbKind)).toEqual([null, null, null, null, null, null, null]);
    expect([undefined, 1, 96, 97, 300, 320, 321, 5000, Number.NaN, '320'].map((s) => thumbSize(s))).toEqual([320, 96, 96, 160, 320, 320, 480, 480, 320, 320]);
    expect(new Thumbs().host).toBeUndefined();
  });
});
