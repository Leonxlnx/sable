/**
 * The phone's side of files and approvals after review wave 4 (pure modules, no device): a download
 * over the secure channel comes in bounded, ordered chunks into a private file, is checked whole
 * before it counts, pauses with the connection and goes on from its bytes, and only such a verified
 * copy is ever installable (4, 10); an approval shows where it reaches, by whole paths, both ends of a
 * rename, and the folder a command runs in (9); a refresh after `phone.stale` that fails is said and
 * tried again (21).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FileDiff, PhoneFileStart } from '@shared/protocol';
import { createDownloads, installable, SWAPPED, WINDOW, type Channel, type FilesPlugin } from '../mobile/src/lib/download-core';
import { transportError } from '../mobile/src/lib/errors';
import { isTransport } from '../mobile/src/lib/errors';
import { memorySink } from '../mobile/src/lib/sink';
import { patchLines, scopeOf } from '../mobile/src/lib/asks';
import { reconciler } from '../mobile/src/lib/stale';

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** A desktop's file channel over `bytes`, recording what was asked; `cut` makes a chunk fail as a lost connection. */
function channelOver(bytes: Buffer, opts: { sha256?: string; chunk?: number; cut?: (offset: number) => boolean } = {}) {
  const asked: number[] = [];
  let inFlight = 0;
  let most = 0;
  let starts = 0;
  const ch: Channel & { asked: number[]; most: () => number; starts: () => number } = {
    secure: () => true,
    async start(): Promise<PhoneFileStart> {
      starts++;
      return { transfer: `t${starts}`, name: 'app.apk', size: bytes.length, sha256: opts.sha256 ?? createHash('sha256').update(bytes).digest('hex'), chunk: opts.chunk ?? 1000 };
    },
    async chunk(p) {
      asked.push(p.offset);
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      if (opts.cut?.(p.offset)) throw transportError('The connection to the desktop was lost', 'lost');
      return { data: bytes.subarray(p.offset, p.offset + p.length).toString('base64') };
    },
    async end() {
      return {};
    },
    asked,
    most: () => most,
    starts: () => starts,
  };
  return ch;
}

const legacyPlugin = (): FilesPlugin => ({
  download: async () => ({ id: '1' }),
  status: async () => ({ state: 'done' }),
  cancel: async () => {},
  verify: async () => ({ ok: true }),
  stageBegin: async () => ({ id: 'x', have: 0 }),
  stageWrite: async () => ({ have: 0 }),
  stageFinish: async () => ({ ok: false }),
  stageDrop: async () => {},
});

const FILE = { sid: 's', itemId: 'i', index: 0, name: 'app.apk' };
const body = Buffer.from(Array.from({ length: 4500 }, (_, i) => (i * 13) % 256));

describe('a download over the secure channel (4, 10)', () => {
  it('comes in ordered chunks into a private file, a few asked ahead, and counts only once checked whole', async () => {
    const sink = memorySink();
    const ch = channelOver(body);
    const states: string[] = [];
    const dl = createDownloads({ plugin: { ...legacyPlugin(), ...sink }, channel: ch, lost: isTransport, link: async () => Promise.reject(new Error('no plain link')), native: true });
    dl.subscribe(() => states.push(dl.get('k').state));
    await dl.start('k', FILE);
    const d = dl.get('k');
    expect(d).toMatchObject({ state: 'done', via: 'channel', verified: true, name: 'app.apk', size: body.length });
    expect(installable(d)).toBe(true);
    expect(Buffer.from(sink.bytesOf(d.file!)!).equals(body)).toBe(true);
    // Every chunk once, in order; never more than WINDOW asked ahead; "verifying" before "done".
    expect(ch.asked).toEqual([0, 1000, 2000, 3000, 4000]);
    expect(ch.most()).toBeLessThanOrEqual(WINDOW);
    expect(states.indexOf('verifying')).toBeGreaterThan(-1);
    expect(states.indexOf('verifying')).toBeLessThan(states.indexOf('done'));
  });

  it('bytes that are not what the share recorded are removed, said so, and never installable', async () => {
    const sink = memorySink();
    const tampered = Buffer.from(body);
    tampered[1234] ^= 1;
    const ch = channelOver(tampered, { sha256: createHash('sha256').update(body).digest('hex') });
    const dl = createDownloads({ plugin: { ...legacyPlugin(), ...sink }, channel: ch, lost: isTransport, link: async () => ({ url: '' }), native: true });
    await dl.start('k', FILE);
    expect(dl.get('k')).toMatchObject({ state: 'failed', error: SWAPPED });
    expect(installable(dl.get('k'))).toBe(false);
    expect(dl.get('k').file).toBeUndefined();
  });

  it('a lost connection pauses it; once connected again it goes on from the bytes it has', async () => {
    const sink = memorySink();
    let cut = true;
    const ch = channelOver(body, { cut: (o) => cut && o >= 2000 });
    const dl = createDownloads({ plugin: { ...legacyPlugin(), ...sink }, channel: ch, lost: isTransport, link: async () => ({ url: '' }), native: true });
    await dl.start('k', FILE);
    expect(dl.get('k').state).toBe('paused');
    expect(dl.get('k').bytes).toBe(2000);
    cut = false;
    const before = ch.asked.length;
    dl.reconnected();
    await until(() => dl.get('k').state === 'done');
    // A new transfer, from where it stopped: the first 2000 bytes were not asked for again.
    expect(ch.starts()).toBe(2);
    expect(ch.asked.slice(before)[0]).toBe(2000);
    expect(Buffer.from(sink.bytesOf(dl.get('k').file!)!).equals(body)).toBe(true);
  });

  it('a refusal by the desktop fails it with its words; a download over a plain pairing is never installable', async () => {
    const sink = memorySink();
    const ch: Channel = { ...channelOver(body), start: async () => Promise.reject(new Error('That file changed after it was shared.')) };
    const dl = createDownloads({ plugin: { ...legacyPlugin(), ...sink }, channel: ch, lost: isTransport, link: async () => ({ url: '' }), native: true });
    await expect(dl.start('k', FILE)).rejects.toThrow('That file changed after it was shared.');
    expect(dl.get('k')).toMatchObject({ state: 'failed', error: 'That file changed after it was shared.' });
    // DownloadManager's file, even checked, never reaches the installer.
    const plain = createDownloads({ plugin: legacyPlugin(), link: async () => ({ url: 'http://x/f', sha256: 'a'.repeat(64), size: 4 }), native: true, sleep: () => new Promise(() => {}) });
    await plain.start('k', FILE);
    await until(() => plain.get('k').state === 'done');
    expect(plain.get('k').verified).toBe(true);
    expect(installable(plain.get('k'))).toBe(false);
  });
});

describe('an approval shows where it reaches (9)', () => {
  const diff = (p: string, oldPath?: string): FileDiff => ({ path: p, ...(oldPath ? { oldPath } : {}), status: oldPath ? 'renamed' : 'modified', additions: 1, deletions: 0, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+x'] }] }) as FileDiff;

  it('a command with its working folder; two files of one name by their whole paths; a rename by both ends', () => {
    expect(scopeOf({ detail: { command: 'npm test', cwd: 'C:\\work\\api' } })).toMatchObject({ cwd: 'C:\\work\\api' });
    const two = [diff('src/server/index.ts'), diff('src/client/index.ts')];
    expect(patchLines(two).filter((l) => !l.startsWith('@@ -'))).toEqual(['@@ src/server/index.ts', '+x', '@@ src/client/index.ts', '+x']);
    expect(scopeOf({ detail: {}, diff: two }).files).toEqual(['src/server/index.ts', 'src/client/index.ts']);
    const moved = [diff('lib/new-name.ts', 'lib/old-name.ts')];
    expect(patchLines(moved)[0]).toBe('@@ lib/old-name.ts → lib/new-name.ts');
    expect(scopeOf({ detail: {}, diff: moved }).files).toEqual(['lib/old-name.ts → lib/new-name.ts']);
    // A file read or written by its whole path, never just its name.
    expect(scopeOf({ detail: { path: 'C:\\secrets\\deploy\\.env' } }).path).toBe('C:\\secrets\\deploy\\.env');
  });
});

describe('a refresh after phone.stale (21)', () => {
  it('that fails is said once and tried again until it goes through', async () => {
    let fails = 2;
    const said: string[] = [];
    const later: (() => void)[] = [];
    const go = reconciler(
      async () => {
        if (fails-- > 0) throw new Error('That is too big to send to the phone.');
      },
      { report: (key) => said.push(key), later: (fn) => void later.push(fn) },
    );
    go('chat-1');
    await until(() => later.length === 1);
    expect(said).toEqual(['chat-1']);
    expect(go.failing('chat-1')).toBe(true);
    later.shift()!();
    await until(() => later.length === 1);
    expect(said).toEqual(['chat-1']);
    later.shift()!();
    await until(() => !go.failing('chat-1'));
    expect(later).toHaveLength(0);
  });
});
