/**
 * Downloads from the phone endpoint (server/services/phone.ts `serveFile`): tracked per phone, the
 * pairing asked again once the file is open, ended when the phone is removed, when phone access is
 * turned off and when the phone goes away, the file closed on every path. `open` is wrapped only to
 * see the handles the endpoint opens. The grant is put in place directly (what makes one is
 * phone-guard.ts `grantFor`, tested on its own). Plain HTTP links are only for a phone paired before the
 * secure channel (a secure one gets its files over its own connection: tests/phone-wave4.test.ts).
 */
import type { PathLike } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { get, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { helloPlain, legacyPairing } from './phone-wire';

const opened: { file: string; fh: FileHandle }[] = [];

vi.mock('node:fs/promises', async (importOriginal) => {
  const m = await importOriginal<typeof import('node:fs/promises')>();
  const open = (async (file: PathLike, ...rest: unknown[]) => {
    const fh = (await (m.open as (...a: unknown[]) => Promise<FileHandle>)(file, ...rest)) as FileHandle;
    opened.push({ file: String(file), fh });
    return fh;
  }) as typeof m.open;
  return { ...m, open, default: { ...m, open } };
});

const { App } = await import('../server/app');
const { DemoProvider } = await import('../server/providers/demo');
const { registerPhone } = await import('../server/services/phone');
const { FILE_CHUNK } = await import('../server/services/phone-files');
type AppT = InstanceType<typeof App>;
type Phone = ReturnType<typeof registerPhone>;

const homes: string[] = [];
const apps: AppT[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
  opened.splice(0);
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const SIZE = 32 * 1024 * 1024;

async function setup() {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-phone-dl-'));
  homes.push(home);
  const [old] = legacyPairing(home);
  const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
  apps.push(app);
  const phone = registerPhone(app, { port: 0, host: '127.0.0.1' });
  const status = await app.call('phone.setEnabled', { on: true });
  const file = path.join(home, 'chat', 'big.bin');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.alloc(SIZE, 7));
  return { app, phone, port: status.port, file, old };
}

/** The phone paired before the secure channel (`setup` wrote it), connected plain as it was. */
async function pairPhone(_app: AppT, port: number, old: { deviceId: string; token: string }) {
  const c = await helloPlain(port, old.token);
  return { ws: c.ws, deviceId: old.deviceId };
}

async function until(ok: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A link for `file` made for `deviceId`, as `phone.fileLink` would make it. */
function link(phone: Phone, deviceId: string, file: string, token = 'tok-' + Math.random().toString(36).slice(2)) {
  const st = statSync(file);
  // With each block's digest as `phone.fileLink` records it (a link serves only blocks that still match: wave 5, 5).
  const data = readFileSync(file);
  const blocks = Buffer.alloc(Math.ceil(data.length / FILE_CHUNK) * 32);
  for (let at = 0; at < data.length; at += FILE_CHUNK) createHash('sha256').update(data.subarray(at, at + FILE_CHUNK)).digest().copy(blocks, (at / FILE_CHUNK) * 32);
  (phone as unknown as { files: Map<string, unknown> }).files.set(token, { deviceId, path: file, name: 'big.bin', size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, expires: Date.now() + 60_000, blocks });
  return `/f/${token}/big.bin`;
}

const fetchPaused = (port: number, p: string) =>
  new Promise<IncomingMessage>((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port, path: p }, (res) => {
      res.pause();
      resolve(res);
    });
    req.on('error', reject);
  });

/** Reads the rest of a response: how many bytes came and whether it ended whole. */
const drain = (res: IncomingMessage) =>
  new Promise<{ bytes: number; complete: boolean }>((resolve) => {
    let bytes = 0;
    res.on('data', (d: Buffer) => (bytes += d.length));
    const done = () => resolve({ bytes, complete: res.complete });
    res.on('end', done);
    res.on('close', done);
    res.on('error', done);
    res.resume();
  });

const handlesOf = (file: string) => opened.filter((o) => path.resolve(o.file) === path.resolve(file)).map((o) => o.fh);

describe('a download from the phone', () => {
  it('goes through whole while its phone stays paired', async () => {
    const { app, phone, port, file, old } = await setup();
    const { ws, deviceId } = await pairPhone(app, port, old);
    const res = await fetchPaused(port, link(phone, deviceId, file));
    expect(res.statusCode).toBe(200);
    expect(await drain(res)).toEqual({ bytes: SIZE, complete: true });
    await until(() => phone.downloads(deviceId) === 0);
    await until(() => handlesOf(file).every((fh) => fh.fd === -1));
    ws.close();
  }, 30_000);

  it('ends when the phone is removed while it runs, and the file closes', async () => {
    const { app, phone, port, file, old } = await setup();
    const { deviceId } = await pairPhone(app, port, old);
    const res = await fetchPaused(port, link(phone, deviceId, file));
    expect(res.statusCode).toBe(200);
    await app.call('phone.revoke', { deviceId });
    const got = await drain(res);
    expect(got.complete).toBe(false);
    expect(got.bytes).toBeLessThan(SIZE);
    await until(() => handlesOf(file).length > 0 && handlesOf(file).every((fh) => fh.fd === -1));
    await until(() => phone.downloads(deviceId) === 0);
  }, 30_000);

  it('ends when phone access is turned off while it runs', async () => {
    const { app, phone, port, file, old } = await setup();
    const { deviceId } = await pairPhone(app, port, old);
    const res = await fetchPaused(port, link(phone, deviceId, file));
    expect(res.statusCode).toBe(200);
    await app.call('phone.setEnabled', { on: false });
    const got = await drain(res);
    expect(got.complete).toBe(false);
    await until(() => handlesOf(file).length > 0 && handlesOf(file).every((fh) => fh.fd === -1));
  }, 30_000);

  it('closes the file when the phone goes away halfway', async () => {
    const { app, phone, port, file, old } = await setup();
    const { ws, deviceId } = await pairPhone(app, port, old);
    const res = await fetchPaused(port, link(phone, deviceId, file));
    expect(res.statusCode).toBe(200);
    res.destroy();
    await until(() => handlesOf(file).length > 0 && handlesOf(file).every((fh) => fh.fd === -1));
    await until(() => phone.downloads(deviceId) === 0);
    ws.close();
  }, 30_000);

  it('is refused when the phone is removed while the file opens', async () => {
    const { app, phone, port, file, old } = await setup();
    const { deviceId } = await pairPhone(app, port, old);
    const server = (phone as unknown as { server: Server }).server;
    // Removed right after the request was read, before the file is open.
    server.prependListener('request', () => queueMicrotask(() => phone.revoke(deviceId)));
    const res = await fetchPaused(port, link(phone, deviceId, file));
    expect(res.statusCode).toBe(404);
    await drain(res);
    await until(() => handlesOf(file).every((fh) => fh.fd === -1));
  }, 30_000);
});
