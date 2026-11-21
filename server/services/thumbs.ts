import { execFile } from 'node:child_process';
import { realpathSync, statSync, type Stats } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { App } from '../app';
import type { SessionSnapshot } from '../../shared/protocol';
import { within } from '../core/handed';
import { grantFor } from './phone-guard';

/**
 * Small pictures of the files an agent hands over (`file.thumb`, and `phone.thumb` through it): the
 * file cards' sheets on the desktop, the file rows on the phone.
 *
 * - Only a file a finished share step lists, by the step and its place in the list; nothing else on
 *   the computer can be read this way. Two rules (`pictureOf`):
 *   - the desktop's card (`file.thumb`, `currentFile`): the file as it is now at the place the step
 *     lists, in the chat's folder, or outside it only at the very place the person allowed for that
 *     share; never through a link from the folder that leads out;
 *   - the phone's row (`phone.thumb`, `thumbFile`): exactly a phone download link's rule
 *     (phone-guard.ts `grantFor`): the very file the step handed over, unchanged, else no picture.
 * - Where it comes from, cheapest for the bridge first:
 *   1. a small picture of a common type (PNG, JPEG, GIF, WebP, by its bytes) is given as it is
 *      (`THUMB.inline`: the window decodes it, off the bridge);
 *   2. a PDF's first page by Windows' own PDF renderer (Windows.Data.Pdf, in a short-lived
 *      PowerShell: its own process);
 *   3. the desktop shell's host (`ThumbHost`, electron/thumbs.ts: Windows' own thumbnail of a
 *      picture, a video, a document, anything Explorer shows one for). Electron makes it on the main
 *      process, where the bridge runs, and holds it meanwhile (about 70 to 150 ms a file, 300 to 400
 *      for the first one; Windows keeps them, so asked again they are quick): one at a time, with a
 *      breather between (`THUMB.hostGap`), so a share of many files never adds up to one long hold;
 *   4. a bigger picture file of a common type, up to `THUMB.fileMax`, as it is (a dev or standalone
 *      bridge has no shell). Otherwise none (`null`).
 * - Kept by file, size, time and width (`THUMB.entries`, `THUMB.bytes`). One picture per file is
 *   made at a time; one PDF is drawn at a time and the shell makes one at a time, each in its own
 *   lane, so a small picture never waits behind a PDF or a video.
 */

export type ThumbKind = 'image' | 'pdf' | 'video' | 'doc';

/** A picture made of a file: PNG or JPEG bytes. */
export interface ThumbImage {
  mime: 'image/png' | 'image/jpeg';
  data: Buffer;
}

/** The desktop shell's thumbnails (electron/thumbs.ts). */
export interface ThumbHost {
  /** A picture of the file at most `px` wide, or null when Windows has none for it. */
  thumbnail(file: string, px: number): Promise<ThumbImage | null>;
}

export const THUMB = {
  /** Widths a picture is made at: the width asked for rounds up to one of these. */
  sizes: [96, 160, 256, 320, 480] as const,
  /** A picture file this small is given as it is, before the shell is asked: for a sheet (`large`, 256 px and up) or a row (`small`). */
  inline: { small: 256 * 1024, large: 1536 * 1024 },
  /** The biggest picture file given as it is when nothing else made one. */
  fileMax: 3 * 1024 * 1024,
  /** Time between two of the shell's pictures (each holds the main process). */
  hostGap: 120,
  /** Pictures kept, and their bytes together (as data URLs). */
  entries: 200,
  bytes: 32 * 1024 * 1024,
  /** A PDF's page has this long to be drawn. */
  pdfMs: 15_000,
};

const KINDS: [RegExp, ThumbKind][] = [
  [/\.(png|jpe?g|jfif|gif|webp|bmp|tiff?|heic|heif|avif|ico)$/i, 'image'],
  [/\.pdf$/i, 'pdf'],
  [/\.(mp4|m4v|mov|webm|mkv|avi|wmv|mpe?g|3gp)$/i, 'video'],
  [/\.(docx|pptx|xlsx|psd)$/i, 'doc'],
];

/** The kind of picture a file may have, by its name; null for anything else (no picture is tried). */
export function thumbKind(name: string): ThumbKind | null {
  for (const [re, kind] of KINDS) if (re.test(name)) return kind;
  return null;
}

/** The width a picture is made at for a width asked for. */
export function thumbSize(px?: unknown): number {
  const n = typeof px === 'number' && Number.isFinite(px) ? px : 320;
  return THUMB.sizes.find((s) => s >= n) ?? THUMB.sizes[THUMB.sizes.length - 1];
}

/** A shared file as a thumbnail may read it. */
export interface ThumbFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * The phone's rule: file `index` of share step `itemId` exactly as a phone's download link has it
 * (phone-guard.ts `grantFor`, one place for those rules): the very file the step handed over,
 * unchanged. Throws a plain sentence otherwise.
 */
export function thumbFile(snap: Pick<SessionSnapshot, 'session' | 'items'>, itemId: string, index: number): ThumbFile {
  const grant = grantFor(snap, itemId, index, '');
  return { path: grant.path, size: grant.size, mtimeMs: grant.mtimeMs };
}

const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * The desktop's rule: file `index` of share step `itemId` as it is now at the place the step lists
 * (rewritten since, the card shows it as it is): only a share that went through, only a file it
 * lists, a regular file, in the chat's folder (links followed), or outside it only at the very place
 * the person allowed for that share (`handed[index].granted`); a link from the folder that leads out
 * is refused. Throws a plain sentence otherwise (the same sentences as `grantFor`).
 */
export function currentFile(snap: Pick<SessionSnapshot, 'session' | 'items'>, itemId: string, index: number): ThumbFile {
  const item = snap.items.find((i) => i.id === itemId);
  const share = item?.type === 'tool' && item.kind === 'share' ? item : undefined;
  if (!share || !Number.isInteger(index) || index < 0) throw new Error('That file is not in this chat.');
  if (share.status !== 'done') throw new Error('That file was not shared.');
  const file = share.detail.files?.[index];
  if (!file || typeof file.path !== 'string' || !file.path) throw new Error('That file is not in this chat.');
  const cwd = snap.session.cwd;
  const listed = path.resolve(cwd, file.path);
  let real: string;
  let st: Stats;
  try {
    real = realpathSync(listed);
    st = statSync(real);
  } catch {
    throw new Error('That file is no longer on the computer.');
  }
  if (!st.isFile()) throw new Error('That file is no longer on the computer.');
  let root: string | undefined;
  try {
    root = realpathSync(cwd);
  } catch {
    /* the chat's folder is gone: nothing counts as inside it */
  }
  if (!root || !within(root, real)) {
    const handed = Array.isArray(share.handed) ? share.handed[index] : undefined;
    if (!handed?.granted || !samePath(real, handed.path)) throw new Error(within(path.resolve(cwd), listed) ? 'That file is a link to another place.' : "That file is outside the chat's folder.");
  }
  return { path: real, size: st.size, mtimeMs: st.mtimeMs };
}

/** The type of picture these bytes are (by their first bytes, never by the name), or null. */
export function pictureType(b: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'image/gif';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// ── a PDF's first page, by Windows' own renderer ──

/**
 * Draws page 1 of the PDF in `SABLE_THUMB_SRC` at `SABLE_THUMB_PX` wide (in the process's own scale)
 * and writes it to stdout as base64 PNG. The path comes in the environment, never in the script.
 */
const PDF_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$ext = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asOp = $ext | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1' } | Select-Object -First 1
$asAct = $ext | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
function Wait-Op($op, [Type]$t) { $task = $asOp.MakeGenericMethod($t).Invoke($null, @($op)); if (-not $task.Wait(10000)) { throw 'timeout' }; $task.Result }
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$file = Wait-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:SABLE_THUMB_SRC)) ([Windows.Storage.StorageFile])
$doc = Wait-Op ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$page = $doc.GetPage(0)
$opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
$opts.DestinationWidth = [uint32]$env:SABLE_THUMB_PX
$stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
$task = $asAct.Invoke($null, @($page.RenderToStreamAsync($stream, $opts)))
if (-not $task.Wait(10000)) { throw 'timeout' }
$read = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream.GetInputStreamAt(0))
$ms = New-Object System.IO.MemoryStream
$read.CopyTo($ms)
[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))
`;

/** Page 1 of a PDF as a PNG, drawn by Windows (Windows.Data.Pdf); null where that is not there or fails. */
export function windowsPdfPage(file: string, px: number): Promise<ThumbImage | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const encoded = Buffer.from(PDF_SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env: { ...process.env, SABLE_THUMB_SRC: file, SABLE_THUMB_PX: String(px) }, timeout: THUMB.pdfMs, maxBuffer: 12 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const data = Buffer.from(String(stdout).trim(), 'base64');
        resolve(pictureType(data) === 'image/png' ? { mime: 'image/png', data } : null);
      },
    );
  });
}

// ── the pictures ──

export interface ThumbOptions {
  host?: ThumbHost;
  /** A PDF's first page (tests replace it; `null`: none). */
  pdf?: ((file: string, px: number) => Promise<ThumbImage | null>) | null;
  fileMax?: number;
  /** Pictures given as they are before the shell is asked (`THUMB.inline`). */
  inline?: { small: number; large: number };
}

const dataUrl = (mime: string, data: Buffer) => `data:${mime};base64,${data.toString('base64')}`;

export class Thumbs {
  host?: ThumbHost;
  /** Pictures made, newest last: key -> data URL, or null when the file has none. */
  private kept = new Map<string, string | null>();
  private keptBytes = 0;
  /** The picture being made of each file now (by its path). */
  private making = new Map<string, Promise<unknown>>();
  /** How many pictures were made (not taken from what is kept). */
  made = 0;
  private readonly pdf: ((file: string, px: number) => Promise<ThumbImage | null>) | null;
  private readonly fileMax: number;
  private readonly inline: { small: number; large: number };

  constructor(opts: ThumbOptions = {}) {
    this.host = opts.host;
    this.pdf = opts.pdf === undefined ? windowsPdfPage : opts.pdf;
    this.fileMax = opts.fileMax ?? THUMB.fileMax;
    this.inline = opts.inline ?? THUMB.inline;
  }

  /** A picture of the file at `px` wide (a data URL), or null when there is none. */
  async thumb(file: ThumbFile, px: number): Promise<string | null> {
    const kind = thumbKind(file.path);
    if (!kind) return null;
    const stamp = `${file.path}\n${file.size}\n${file.mtimeMs}\n`;
    const key = stamp + px;
    const hit = this.take(key);
    if (hit !== undefined) return hit;
    // One picture of a file at a time: a second ask waits for the first and usually finds it kept.
    const before = this.making.get(file.path) ?? Promise.resolve();
    const run = before.then(async () => {
      const again = this.take(key);
      if (again !== undefined) return again;
      const data = await this.make(file.path, kind, px, file.size);
      this.keep(key, stamp, file.path, data);
      return data;
    });
    const settled = run.catch(() => {});
    this.making.set(file.path, settled);
    void settled.then(() => {
      if (this.making.get(file.path) === settled) this.making.delete(file.path);
    });
    return run;
  }

  private async make(file: string, kind: ThumbKind, px: number, size: number): Promise<string | null> {
    this.made++;
    // 1. A small picture as it is: nothing is decoded here.
    if (kind === 'image' && size <= (px >= 256 ? this.inline.large : this.inline.small)) {
      const own = await this.itself(file, size);
      if (own) return own;
    }
    // 2. A PDF's page, drawn in a process of its own.
    if (kind === 'pdf' && this.pdf) {
      const t = await this.viaPdf(this.pdf, file, px);
      if (t?.data.length) return dataUrl(t.mime, t.data);
    }
    // 3. The shell's own thumbnail (it holds the main process: one at a time, with a breather).
    if (this.host) {
      const t = await this.viaHost(this.host, file, px);
      if (t?.data.length && (t.mime === 'image/png' || t.mime === 'image/jpeg')) return dataUrl(t.mime, t.data);
    }
    // 4. A bigger picture as it is, when nothing made a smaller one.
    return kind === 'image' ? this.itself(file, size) : null;
  }

  /** The picture file itself, when it is one of the common types (by its bytes) and within `fileMax`. */
  private async itself(file: string, size: number): Promise<string | null> {
    if (!(size > 0 && size <= this.fileMax)) return null;
    const data = await readFile(file).catch(() => null);
    // Read as it is now: a file that changed size since it was looked at is not given.
    const type = data && data.length === size ? pictureType(data) : null;
    return data && type ? dataUrl(type, data) : null;
  }

  private hostTurn: Promise<unknown> = Promise.resolve();
  private pdfTurn: Promise<unknown> = Promise.resolve();

  /** One of the shell's pictures at a time, `THUMB.hostGap` apart. */
  private viaHost(host: ThumbHost, file: string, px: number): Promise<ThumbImage | null> {
    const run = this.hostTurn.then(() => host.thumbnail(file, px).catch(() => null));
    this.hostTurn = run.then(() => new Promise((r) => setTimeout(r, THUMB.hostGap)));
    return run;
  }

  /** One PDF drawn at a time (each is a process). */
  private viaPdf(draw: (file: string, px: number) => Promise<ThumbImage | null>, file: string, px: number): Promise<ThumbImage | null> {
    const run = this.pdfTurn.then(() => draw(file, px).catch(() => null));
    this.pdfTurn = run;
    return run;
  }

  private take(key: string): string | null | undefined {
    if (!this.kept.has(key)) return undefined;
    const v = this.kept.get(key)!;
    // Newest last: what is used stays.
    this.kept.delete(key);
    this.kept.set(key, v);
    return v;
  }

  private keep(key: string, stamp: string, file: string, data: string | null) {
    // Pictures of the file as it was before (another size or time) go; its other widths stay.
    for (const k of [...this.kept.keys()]) if (k.startsWith(`${file}\n`) && !k.startsWith(stamp)) this.drop(k);
    this.drop(key);
    this.kept.set(key, data);
    this.keptBytes += data?.length ?? 0;
    for (const k of [...this.kept.keys()]) {
      if (this.kept.size <= THUMB.entries && this.keptBytes <= THUMB.bytes) break;
      this.drop(k);
    }
  }

  private drop(key: string) {
    if (!this.kept.has(key)) return;
    this.keptBytes -= this.kept.get(key)?.length ?? 0;
    this.kept.delete(key);
  }

  /** How many pictures are kept, and their bytes. */
  get size() {
    return { entries: this.kept.size, bytes: this.keptBytes };
  }
}

const services = new WeakMap<App, Thumbs>();

/** `file.thumb`: a picture of a file a chat's finished share step lists, for the desktop's card. */
export function registerThumbs(app: App, opts: ThumbOptions = {}): Thumbs {
  const thumbs = new Thumbs(opts);
  services.set(app, thumbs);
  app.register('file.thumb', (p) => pictureOf(app, p, 'desktop'));
  return thumbs;
}

/**
 * A picture of file `index` of share step `itemId` at `size` wide: by the desktop's rule
 * (`currentFile`) or the phone's (`thumbFile`, `phone.thumb` in phone.ts).
 */
export async function pictureOf(app: App, p: { sessionId?: unknown; itemId?: unknown; index?: unknown; size?: unknown }, rule: 'desktop' | 'phone'): Promise<{ data: string | null }> {
  const thumbs = services.get(app);
  if (!thumbs) throw new Error('Pictures of files are not available here.');
  const sessionId = String(p.sessionId ?? '');
  const itemId = String(p.itemId ?? '');
  let item;
  try {
    ({ item } = await app.call('session.item', { sessionId, itemId }));
  } catch {
    throw new Error('That file is not in this chat.');
  }
  const snap = { session: app.runtime(sessionId).meta, items: [item] };
  const index = Number(p.index);
  const file = rule === 'phone' ? thumbFile(snap, itemId, index) : currentFile(snap, itemId, index);
  return { data: await thumbs.thumb(file, thumbSize(p.size)) };
}

/** The desktop shell's thumbnails for the app's pictures (`serve.ts`); none in a dev or standalone bridge. */
export function setThumbHost(app: App, host?: ThumbHost) {
  const thumbs = services.get(app);
  if (thumbs) thumbs.host = host;
}
