import { useSyncExternalStore } from 'react';
import { registerPlugin } from '@capacitor/core';
import { canonicalName, isPackageName } from '@shared/file-name';
import { conn } from './conn';
import { createDownloads, type Download, type FilesPlugin } from './download-core';
import { isTransport } from './errors';
import { onForget } from './forget';
import { isNative, openExternal } from './native';
import { memorySink } from './sink';

/**
 * Files the agent handed over, downloaded inside the app. Paired securely, over the sealed
 * connection into the app's private storage, checked whole on the phone against the digest the
 * share recorded, and only then kept (android/…/FilesPlugin.java `stage*`; an app other than an
 * APK is also copied to Downloads/Sable). Over a pairing from before the secure channel, Android's
 * DownloadManager over plain HTTP, never for an APK. A card asks the desktop, shows the progress and
 * offers Open (Install for an APK) when it is there. What was downloaded is remembered per file
 * across restarts (`sable.downloads`) and forgotten with the desktop. In the web preview the secure
 * channel's bytes are kept in memory and checked with WebCrypto, so every state can be looked at;
 * a legacy download is acted out. The logic is in download-core.ts.
 */

export type { Download, DownloadState } from './download-core';
export { installable } from './download-core';

type Native = FilesPlugin & {
  open(o: { id?: string; file?: string; sha256?: string; size?: number }): Promise<void>;
  forgetAll(): Promise<void>;
};
const Files = registerPlugin<Native>('Files');
/** The web preview: the secure channel's files in memory (lib/sink.ts), opened as a blob. */
const web = isNative ? undefined : memorySink();

const KEY = 'sable.downloads';

const core = createDownloads({
  plugin: web ? { ...Files, ...web } : Files,
  async link(p) {
    const r = await conn.call('phone.fileLink', { sessionId: p.sid, itemId: p.itemId, index: p.index });
    const url = conn.httpUrl(r.path);
    if (!url) throw new Error('The computer is not connected.');
    return { url, size: r.size, sha256: r.sha256 };
  },
  channel: {
    // Paired securely: every download comes this way (offline, it waits for the connection, never a plain link).
    secure: () => conn.pairedSecurely,
    start: (p) => conn.call('phone.fileStart', { sessionId: p.sid, itemId: p.itemId, index: p.index }, 120_000),
    chunk: (p) => conn.call('phone.fileChunk', p, 60_000),
    end: (transfer) => conn.call('phone.fileEnd', { transfer }, 10_000),
  },
  lost: (err) => isTransport(err),
  native: isNative,
  storage: {
    get: () => localStorage.getItem(KEY),
    set: (v) => localStorage.setItem(KEY, v),
  },
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  actMs: () => Number(localStorage.getItem('sable.debug.downloadMs') ?? 2200),
});

// Progress is read only while the app is on screen; back on screen, it is read again.
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && core.resume());
// Downloads still running when the app was closed: read again.
if (isNative && core.hasActive()) setTimeout(core.resume, 600);
// Connected again: what paused with the connection goes on from its bytes.
conn.onOpen(() => core.reconnected());
// Forgetting the computer forgets its downloads too: the records, the private files, what is under way.
onForget(() => {
  core.forgetAll();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
  if (isNative) void Files.forgetAll().catch(() => {});
  web?.forgetAll();
});

export const downloadKey = (sid: string, itemId: string, index: number) => `${sid}:${itemId}:${index}`;

export function useDownload(key: string): Download {
  return useSyncExternalStore(core.subscribe, () => core.get(key));
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  json: 'application/json',
  md: 'text/plain',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};
/** A kind for DownloadManager's own row (never the installer's: what opens a file is decided natively). */
export const mimeOf = (name: string) => (isPackageName(canonicalName(name)) ? undefined : MIME[canonicalName(name).split('.').pop()?.toLowerCase() ?? '']);

/** Starts a download of one file of a share step. */
export function startDownload(key: string, p: { sid: string; itemId: string; index: number; name: string; size?: number; from?: string }) {
  const name = canonicalName(p.name);
  // Over a plain pairing an app is never fetched (it could not be checked on the way).
  if (!conn.pairedSecurely && isPackageName(name)) return Promise.reject(new Error('Pair again for a secure connection to install it'));
  return core.start(key, { ...p, name, mime: mimeOf(name) });
}

/** Stops a download (also while its link or file is still being prepared). */
export const cancelDownload = (key: string) => core.cancel(key);

/**
 * Opens a finished download with the app for its kind; an APK goes to the installer, and only from a
 * verified private copy (FilesPlugin decides that itself, by the final MIME type and the record).
 */
export async function openDownload(key: string) {
  const d = core.get(key);
  if (d.state !== 'done') return;
  if (!isNative) {
    if (d.via === 'channel' && d.file) return web?.open(d.file);
    return void (d.url && openExternal(d.url));
  }
  try {
    if (d.via === 'channel') await Files.open({ file: d.file! });
    // A legacy download: read whole again and compared before anything opens it (it sat in Downloads meanwhile).
    else await Files.open({ id: d.id!, ...(d.sha256 ? { sha256: d.sha256 } : {}), ...(d.size !== undefined ? { size: d.size } : {}) });
  } catch (err) {
    const text = (err as Error).message;
    // Gone from the phone (deleted in Files): it can be downloaded again. Changed since: removed there, said so.
    if (/no longer on this phone/i.test(text)) core.set(key, { state: 'idle' });
    else if (/so it was removed/i.test(text)) core.set(key, { state: 'failed', error: text });
    throw err;
  }
}
