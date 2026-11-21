import { createHash, randomBytes } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { canonicalName } from '../../shared/file-name';
import type { PhoneFileStart } from '../../shared/protocol';
import { openGrant, type FileGrant } from './phone-guard';

/**
 * Files a securely paired phone downloads, over its sealed connection (phone.ts `phone.fileStart`,
 * `phone.fileChunk`, `phone.fileEnd`); nothing on the network can read or change them on the way.
 *
 * - A transfer opens the one file a finished share handed over (`grantFor`, its handle checked against
 *   the share's record: the same file, unchanged in size and time) and reads it whole once: its bytes
 *   must be the SHA-256 the share recorded when it completed (core/handed.ts), or nothing is sent.
 * - The phone asks for each chunk (at most `FILE_CHUNK` bytes, at an offset, from the same handle), so
 *   it sets the pace (backpressure) and can go on from any offset after a reconnect, with a new
 *   transfer; what it saves is checked against the digest once more on the phone, whole.
 * - At most `FILE_MAX_TRANSFERS` open per phone (a new one closes its oldest), each closed after
 *   `FILE_IDLE_MS` unused, at `phone.fileEnd`, and at once when its phone is removed, its connection is
 *   no longer authorized, or phone access is turned off.
 */

export const FILE_CHUNK = 256 * 1024;
export const FILE_IDLE_MS = 2 * 60_000;
export const FILE_MAX_TRANSFERS = 4;

interface Transfer {
  id: string;
  deviceId: string;
  fh: FileHandle;
  size: number;
  timer: NodeJS.Timeout;
  at: number;
}

/** SHA-256 (hex) of `size` bytes read through `fh` from its start; null when fewer were there. */
export async function digestOfHandle(fh: FileHandle, size: number): Promise<string | null> {
  const h = createHash('sha256');
  const buf = Buffer.allocUnsafe(Math.min(1 << 20, Math.max(1, size)));
  let at = 0;
  while (at < size) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - at), at);
    if (!bytesRead) return null;
    h.update(buf.subarray(0, bytesRead));
    at += bytesRead;
  }
  return h.digest('hex');
}

export class PhoneFiles {
  private open = new Map<string, Transfer>();
  /** A phone starts one transfer at a time (each reads its file whole first). */
  private starting = new Set<string>();

  /**
   * Opens `grant` for `deviceId`. `sha256`: the share's record of the bytes. `allowed`: asked again
   * after every wait (the phone may have been removed meanwhile).
   */
  async start(deviceId: string, grant: FileGrant, sha256: string, allowed: () => boolean): Promise<PhoneFileStart> {
    if (this.starting.has(deviceId)) throw new Error('Another download is starting. Try again in a moment.');
    this.starting.add(deviceId);
    let fh: FileHandle | undefined;
    try {
      const opened = await openGrant(grant);
      if ('code' in opened) throw new Error(opened.code === 409 ? 'That file changed after it was shared.' : 'That file is no longer on the computer.');
      fh = opened.fh;
      // Only the bytes the share recorded go: read once through this handle, the one the chunks come from.
      const now = await digestOfHandle(fh, grant.size);
      if (now !== sha256.toLowerCase()) throw new Error('That file changed after it was shared.');
      if (!allowed()) throw new Error('This phone was removed on the desktop.');
      const mine = [...this.open.values()].filter((t) => t.deviceId === deviceId).sort((a, b) => a.at - b.at);
      while (mine.length >= FILE_MAX_TRANSFERS) this.close(mine.shift()!.id);
      const id = randomBytes(16).toString('base64url');
      const t: Transfer = { id, deviceId, fh, size: grant.size, at: Date.now(), timer: this.idle(id) };
      this.open.set(id, t);
      fh = undefined;
      return { transfer: id, name: canonicalName(grant.name), size: grant.size, sha256: sha256.toLowerCase(), chunk: FILE_CHUNK };
    } finally {
      this.starting.delete(deviceId);
      await fh?.close().catch(() => {});
    }
  }

  private idle(id: string) {
    const t = setTimeout(() => this.close(id), FILE_IDLE_MS);
    t.unref?.();
    return t;
  }

  /** Up to `length` bytes at `offset` (base64), for the phone the transfer is for. */
  async chunk(deviceId: string, id: unknown, offset: unknown, length?: unknown): Promise<{ data: string }> {
    const t = typeof id === 'string' ? this.open.get(id) : undefined;
    if (!t || t.deviceId !== deviceId) throw new Error('That download is no longer open. Start it again.');
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > t.size) throw new Error('That part of the file is not there.');
    const want = length === undefined ? FILE_CHUNK : typeof length === 'number' && Number.isInteger(length) && length > 0 ? length : -1;
    if (want < 0) throw new Error('That part of the file is not there.');
    const n = Math.min(want, FILE_CHUNK, t.size - offset);
    clearTimeout(t.timer);
    t.timer = this.idle(t.id);
    t.at = Date.now();
    if (!n) return { data: '' };
    const buf = Buffer.allocUnsafe(n);
    let got = 0;
    while (got < n) {
      const { bytesRead } = await t.fh.read(buf, got, n - got, offset + got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    // The file got shorter since it was checked: it is no longer what was shared.
    if (got !== n) {
      this.close(t.id);
      throw new Error('That file changed after it was shared.');
    }
    // Closed meanwhile (the phone removed): nothing goes.
    if (this.open.get(t.id) !== t) throw new Error('That download is no longer open. Start it again.');
    return { data: buf.toString('base64') };
  }

  end(deviceId: string, id: unknown): { ok: boolean } {
    const t = typeof id === 'string' ? this.open.get(id) : undefined;
    if (!t || t.deviceId !== deviceId) return { ok: false };
    this.close(t.id);
    return { ok: true };
  }

  private close(id: string) {
    const t = this.open.get(id);
    if (!t) return;
    this.open.delete(id);
    clearTimeout(t.timer);
    void t.fh.close().catch(() => {});
  }

  /** Every transfer of one phone (or all) ends now, its file closed. */
  drop(deviceId?: string) {
    for (const t of [...this.open.values()]) if (!deviceId || t.deviceId === deviceId) this.close(t.id);
  }

  /** Open transfers of one phone (tests). */
  count(deviceId?: string): number {
    return [...this.open.values()].filter((t) => !deviceId || t.deviceId === deviceId).length;
  }
}
