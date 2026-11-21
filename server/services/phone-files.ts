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
 *   must be the SHA-256 the share recorded when it completed (core/handed.ts), or nothing is sent. The
 *   same read records the SHA-256 of every `FILE_CHUNK` block of it (32 bytes a block: 256 KiB for a
 *   2 GiB file), so the bytes are never kept and never read whole again.
 * - The phone asks for each chunk (at most `FILE_CHUNK` bytes, at an offset, from the same handle), so
 *   it sets the pace (backpressure) and can go on from any offset after a reconnect, with a new
 *   transfer. A chunk is served from the blocks it lies in, read whole (one, or two for a part across
 *   a boundary), and only when each is the block that was checked: the file rewritten in place since
 *   (the same length, its time put back) sends nothing; that transfer ends ("That file changed after
 *   it was shared."). What the phone saves is checked against the digest once more on the phone.
 * - Work in flight is bounded before anything is allocated (`FILE_FLIGHT`): chunk reads per transfer
 *   (the phone asks at most two ahead) and per phone, and the bytes of their buffers per phone (reads
 *   of a transfer that ended still count until they are done). A phone's starts run one at a time
 *   (each reads its file whole), a few waiting their turn without holding anything. What goes over a
 *   bound is refused for now (`RetryLater`: phone.ts answers it with `retry: true` and `retryAfterMs`),
 *   never as a failure of the download.
 * - At most `FILE_MAX_TRANSFERS` open per phone (a new one closes its oldest), each closed after
 *   `FILE_IDLE_MS` unused, at `phone.fileEnd`, and at once when its phone is removed, its connection is
 *   no longer authorized, or phone access is turned off.
 */

export const FILE_CHUNK = 256 * 1024;
export const FILE_IDLE_MS = 2 * 60_000;
export const FILE_MAX_TRANSFERS = 4;
/**
 * In flight at once: chunk reads of one transfer (the phone's window is two) and of one phone (its
 * transfers' windows), the bytes their buffers take for one phone (a part across a block boundary
 * reads both blocks), and starts waiting behind the one a phone has running.
 */
export const FILE_FLIGHT = { transfer: 2, phone: 2 * FILE_MAX_TRANSFERS, bytes: 2 * FILE_MAX_TRANSFERS * FILE_CHUNK, starts: FILE_MAX_TRANSFERS };
/** How long a phone waits before it asks again for what was refused for now: a chunk, a start. */
export const FILE_RETRY_MS = { chunk: 200, start: 1000 };

/** A request refused for now, not failed: ask again after `retryAfterMs` (phone.ts sends `retry: true` and it). */
export class RetryLater extends Error {
  readonly retry = true as const;
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

const HASH = 32;

interface Transfer {
  id: string;
  deviceId: string;
  fh: FileHandle;
  size: number;
  /** SHA-256 of each `FILE_CHUNK` block as it was checked at the start. */
  blocks: Buffer;
  /** Chunk reads under way. */
  reads: number;
  timer: NodeJS.Timeout;
  at: number;
}

/** SHA-256 (hex) of `size` bytes read through `fh` from its start; null when fewer were there. */
export async function digestOfHandle(fh: FileHandle, size: number): Promise<string | null> {
  return (await blockDigests(fh, size))?.sha256 ?? null;
}

/** The SHA-256 (hex) of `size` bytes read once through `fh` from its start, and of each `FILE_CHUNK` block of them; null when fewer were there. */
export async function blockDigests(fh: FileHandle, size: number): Promise<{ sha256: string; blocks: Buffer } | null> {
  const whole = createHash('sha256');
  const blocks = Buffer.alloc(Math.ceil(size / FILE_CHUNK) * HASH);
  // A whole number of blocks at a time, so each read starts on a block.
  const buf = Buffer.allocUnsafe(Math.min(4 * FILE_CHUNK, Math.max(1, size)));
  let at = 0;
  while (at < size) {
    const want = Math.min(buf.length, size - at);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await fh.read(buf, got, want - got, at + got);
      if (!bytesRead) return null;
      got += bytesRead;
    }
    const part = buf.subarray(0, want);
    whole.update(part);
    for (let o = 0; o < want; o += FILE_CHUNK) createHash('sha256').update(part.subarray(o, Math.min(want, o + FILE_CHUNK))).digest().copy(blocks, ((at + o) / FILE_CHUNK) * HASH);
    at += want;
  }
  return { sha256: whole.digest('hex'), blocks };
}

export class PhoneFiles {
  private open = new Map<string, Transfer>();
  /** Each phone's starts, one at a time: the last in line, and how many are running or waiting. */
  private starts = new Map<string, { tail: Promise<unknown>; count: number }>();
  /** Each phone's chunk reads under way and the bytes of their buffers (a transfer that ended meanwhile included). */
  private flight = new Map<string, { reads: number; bytes: number }>();

  /**
   * Opens `grant` for `deviceId`. `sha256`: the share's record of the bytes. `allowed`: asked again
   * after every wait (the phone may have been removed meanwhile). Waits for the phone's start before
   * it (a few); refused for now (`RetryLater`) beyond those.
   */
  async start(deviceId: string, grant: FileGrant, sha256: string, allowed: () => boolean): Promise<PhoneFileStart> {
    let lane = this.starts.get(deviceId);
    if (lane && lane.count > FILE_FLIGHT.starts) throw new RetryLater('Another download is starting. Try again in a moment.', FILE_RETRY_MS.start);
    if (!lane) this.starts.set(deviceId, (lane = { tail: Promise.resolve(), count: 0 }));
    const mine = lane;
    mine.count++;
    const turn = mine.tail.then(() => this.opened(deviceId, grant, sha256, allowed));
    mine.tail = turn.catch(() => {});
    try {
      return await turn;
    } finally {
      if (--mine.count === 0 && this.starts.get(deviceId) === mine) this.starts.delete(deviceId);
    }
  }

  private async opened(deviceId: string, grant: FileGrant, sha256: string, allowed: () => boolean): Promise<PhoneFileStart> {
    if (!allowed()) throw new Error('This phone was removed on the desktop.');
    let fh: FileHandle | undefined;
    try {
      const opened = await openGrant(grant);
      if ('code' in opened) throw new Error(opened.code === 409 ? 'That file changed after it was shared.' : 'That file is no longer on the computer.');
      fh = opened.fh;
      // Only the bytes the share recorded go: read once through this handle, the one the chunks come from, each block's hash kept.
      const now = await blockDigests(fh, grant.size);
      if (!now || now.sha256 !== sha256.toLowerCase()) throw new Error('That file changed after it was shared.');
      if (!allowed()) throw new Error('This phone was removed on the desktop.');
      const mine = [...this.open.values()].filter((t) => t.deviceId === deviceId).sort((a, b) => a.at - b.at);
      while (mine.length >= FILE_MAX_TRANSFERS) this.close(mine.shift()!.id);
      const id = randomBytes(16).toString('base64url');
      const t: Transfer = { id, deviceId, fh, size: grant.size, blocks: now.blocks, reads: 0, at: Date.now(), timer: this.idle(id) };
      this.open.set(id, t);
      fh = undefined;
      return { transfer: id, name: canonicalName(grant.name), size: grant.size, sha256: sha256.toLowerCase(), chunk: FILE_CHUNK };
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  private idle(id: string) {
    const t = setTimeout(() => this.close(id), FILE_IDLE_MS);
    t.unref?.();
    return t;
  }

  /**
   * Up to `length` bytes at `offset` (base64), for the phone the transfer is for: only bytes of
   * blocks that are still the ones checked at the start. Refused for now (`RetryLater`), before any
   * buffer is allocated, beyond the reads and bytes that may be in flight.
   */
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
    // The blocks the part lies in, whole.
    const first = Math.floor(offset / FILE_CHUNK);
    const last = Math.floor((offset + n - 1) / FILE_CHUNK);
    const from = first * FILE_CHUNK;
    const span = Math.min(t.size, (last + 1) * FILE_CHUNK) - from;
    const phone = this.flight.get(deviceId) ?? { reads: 0, bytes: 0 };
    if (t.reads >= FILE_FLIGHT.transfer || phone.reads >= FILE_FLIGHT.phone || phone.bytes + span > FILE_FLIGHT.bytes) throw new RetryLater('Parts of this file are still on their way. Ask again in a moment.', FILE_RETRY_MS.chunk);
    t.reads++;
    phone.reads++;
    phone.bytes += span;
    this.flight.set(deviceId, phone);
    try {
      const buf = Buffer.allocUnsafe(span);
      let got = 0;
      try {
        while (got < span) {
          const { bytesRead } = await t.fh.read(buf, got, span - got, from + got);
          if (!bytesRead) break;
          got += bytesRead;
        }
      } catch (err) {
        // Closed meanwhile (the phone removed, the transfer ended): nothing goes.
        if (this.open.get(t.id) !== t) throw new Error('That download is no longer open. Start it again.');
        throw err;
      }
      // Shorter, or a block not as it was checked: it is no longer what was shared, and none of it goes.
      let same = got === span;
      for (let b = first; same && b <= last; b++) {
        const at = (b - first) * FILE_CHUNK;
        same = createHash('sha256').update(buf.subarray(at, Math.min(span, at + FILE_CHUNK))).digest().equals(t.blocks.subarray(b * HASH, (b + 1) * HASH));
      }
      if (!same) {
        this.close(t.id);
        throw new Error('That file changed after it was shared.');
      }
      if (this.open.get(t.id) !== t) throw new Error('That download is no longer open. Start it again.');
      return { data: buf.toString('base64', offset - from, offset - from + n) };
    } finally {
      t.reads--;
      phone.reads--;
      phone.bytes -= span;
      if (phone.reads === 0 && this.flight.get(deviceId) === phone) this.flight.delete(deviceId);
    }
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
