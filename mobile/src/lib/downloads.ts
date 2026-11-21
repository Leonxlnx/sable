import { useSyncExternalStore } from 'react';
import { registerPlugin } from '@capacitor/core';
import { conn } from './conn';
import { createDownloads, type Download, type FilesPlugin } from './download-core';
import { isNative, openExternal } from './native';

/**
 * Files the agent handed over, downloaded inside the app (android/…/FilesPlugin.java: Android's
 * DownloadManager into Downloads/Sable). A card asks the desktop for the file's one-time link
 * (`phone.fileLink`), starts the download, shows its progress and offers Open when it is there.
 * What was downloaded is remembered per file across restarts (`sable.downloads`), so Open stays. In
 * the web preview the download is acted (progress over a moment, then Open opens the link) so every
 * state can be looked at. The logic (attempts, the polling loop, what is kept) is in download-core.ts.
 */

export type { Download, DownloadState } from './download-core';
export { installable } from './download-core';

const Files = registerPlugin<FilesPlugin & { open(o: { id: string; mime?: string; sha256?: string; size?: number }): Promise<void> }>('Files');

const KEY = 'sable.downloads';

const core = createDownloads({
  plugin: Files,
  async link(p) {
    // Whether the link (and the digest with it) came sealed, read as it is asked.
    const secure = conn.secure;
    const r = await conn.call('phone.fileLink', { sessionId: p.sid, itemId: p.itemId, index: p.index });
    const url = conn.httpUrl(r.path);
    if (!url) throw new Error('The computer is not connected.');
    return { url, size: r.size, sha256: r.sha256, secure };
  },
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

export const downloadKey = (sid: string, itemId: string, index: number) => `${sid}:${itemId}:${index}`;

export function useDownload(key: string): Download {
  return useSyncExternalStore(core.subscribe, () => core.get(key));
}

const MIME: Record<string, string> = {
  apk: 'application/vnd.android.package-archive',
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
export const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''];

/** Starts a download of one file of a share step. */
export function startDownload(key: string, p: { sid: string; itemId: string; index: number; name: string; size?: number; from?: string }) {
  return core.start(key, { ...p, mime: mimeOf(p.name) });
}

/** Stops a download (also while its link is still being prepared). */
export const cancelDownload = (key: string) => core.cancel(key);

/** Opens a finished download with the app for its kind (an APK: the installer). */
export async function openDownload(key: string, name: string) {
  const d = core.get(key);
  if (d.state === 'idle') return;
  if (!isNative) return void (d.url && openExternal(d.url));
  try {
    // Read whole again and compared before anything opens it (it sat in Downloads meanwhile).
    await Files.open({ id: d.id!, mime: mimeOf(name), ...(d.sha256 ? { sha256: d.sha256 } : {}), ...(d.size !== undefined ? { size: d.size } : {}) });
  } catch (err) {
    const text = (err as Error).message;
    // Gone from the phone (deleted in Files): it can be downloaded again. Changed since: removed there, said so.
    if (/no longer on this phone/i.test(text)) core.set(key, { state: 'idle' });
    else if (/so it was removed/i.test(text)) core.set(key, { state: 'failed', error: text });
    throw err;
  }
}
