/**
 * The phone boundary (server/services/phone.ts, phone-guard.ts, phone-changes.ts): download links
 * only for a share that went through, bound to the phone and to the file as it was; a malformed first
 * frame closes only its socket; pictures from the phone as data, never a path on the computer; what
 * goes back to a phone cut and within a frame budget; a chat's changes only from its own folder.
 * Demo agent and a local socket only: nothing real is started.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PermissionRequest, PhoneChanges, PhoneDiff, PhoneTail, QueuedMessage, UserItem } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { registerFs } from '../server/services/fs';
import { phoneEvent, phonePermission, phoneResult, registerPhone } from '../server/services/phone';
import { FRAME_MAX, phoneAttachments, readHello } from '../server/services/phone-guard';
import { fetchSecure, helloPlain, helloSecure, legacyPairing, pairSecure, wireClient } from './phone-wire';

const homes: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
  // A git child of a check may still hold a folder for a moment under load.
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** `legacy`: phones paired before the secure channel, in phone.json before the App starts. */
async function setup(legacy = 0) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-phone-guard-'));
  homes.push(home);
  const old = legacy ? legacyPairing(home, Array.from({ length: legacy }, () => ({}))) : [];
  const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
  apps.push(app);
  registerFs(app);
  registerPhone(app, { port: 0, host: '127.0.0.1' });
  const status = await app.call('phone.setEnabled', { on: true });
  expect(status.listening).toBe(true);
  return { app, home, port: status.port, old };
}

type Frame = Record<string, unknown>;

/** A socket to the endpoint (tests/phone-wire.ts): plain until a handshake makes it secure. */
const client = (port: number) => wireClient(port);

/** Pairs a phone over the secure channel (the only way now), "Allow" clicked. */
const pairPhone = (app: App, port: number, name = 'Test phone') => pairSecure(app, port, name);

/** A chat in its own folder, opened from the phone. */
async function chatIn(app: App, c: ReturnType<typeof client>, cwd: string) {
  mkdirSync(cwd, { recursive: true });
  const created = (await c.call('session.create', { provider: 'demo', cwd })) as { result: PhoneTail };
  return app.sessions.get(created.result.session.id)!;
}

const share = (id: string, status: string, files: { path: string; name: string; size?: number }[]) => ({ id, type: 'tool', name: 'SendUserFile', kind: 'share', title: files[0].name, status, detail: { files } }) as never;

describe('download links from the phone', () => {
  it('only for a share that went through, its path resolved against the chat folder', async () => {
    const { app, port, home } = await setup();
    const { c } = await pairPhone(app, port);
    const cwd = path.join(home, 'chat');
    const rt = await chatIn(app, c, cwd);
    mkdirSync(path.join(cwd, 'reports'));
    writeFileSync(path.join(cwd, 'reports', 'audit.txt'), 'the audit');
    const file = { path: 'reports/audit.txt', name: 'audit.txt', size: 9 };
    for (const status of ['running', 'awaiting', 'denied', 'cancelled', 'error']) rt.add(share(`s-${status}`, status, [file]));
    rt.add(share('s-done', 'done', [file]));
    // Over the secure channel (phone.fileStart and its chunks), by the same rules as a link.
    const get = (itemId: string) => fetchSecure(c, { sessionId: rt.id, itemId, index: 0 });
    for (const status of ['running', 'awaiting', 'denied', 'cancelled', 'error']) {
      const r = await get(`s-${status}`);
      expect(r.ok, status).toBe(false);
      expect(!r.ok && r.error, status).toBe('That file was not shared.');
    }
    const ok = await get('s-done');
    expect(ok.ok && ok.bytes.toString()).toBe('the audit');
    // A file that changed since the share named its size is not handed out.
    writeFileSync(path.join(cwd, 'reports', 'audit.txt'), 'the audit, rewritten');
    const changed = await get('s-done');
    expect(!changed.ok && changed.error).toBe('That file changed after it was shared.');
    c.ws.close();
  });

  it('stop working when the phone is removed or phone access is turned off', async () => {
    // Plain HTTP links: phones paired before the secure channel.
    const { app, port, home, old } = await setup(2);
    const c = await helloPlain(port, old[0].token);
    const deviceId = old[0].deviceId;
    const cwd = path.join(home, 'chat');
    const rt = await chatIn(app, c, cwd);
    writeFileSync(path.join(cwd, 'build.zip'), 'zip bytes');
    rt.add(share('s1', 'done', [{ path: path.join(cwd, 'build.zip'), name: 'build.zip', size: 9 }]));
    const link = (await c.call('phone.fileLink', { sessionId: rt.id, itemId: 's1', index: 0 })) as { result: { path: string } };
    const other = { c: await helloPlain(port, old[1].token) };
    const kept = (await other.c.call('phone.fileLink', { sessionId: rt.id, itemId: 's1', index: 0 })) as { result: { path: string } };
    await app.call('phone.revoke', { deviceId });
    await c.closed;
    // The removed phone's link is gone; the other phone's still works.
    expect((await fetch(`http://127.0.0.1:${port}${link.result.path}`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}${kept.result.path}`)).status).toBe(200);
    // Phone access off and on again: no link of before works (asked again on a fresh connection when the old one was cut).
    await app.call('phone.setEnabled', { on: false });
    const again = await app.call('phone.setEnabled', { on: true });
    const url = `http://127.0.0.1:${again.port}${kept.result.path}`;
    const status = await fetch(url).then(
      (r) => r.status,
      () => fetch(url).then((r) => r.status),
    );
    expect(status).toBe(404);
  });

  it('serve the file as it was when the link was made, and refuse it once it changed or was replaced', async () => {
    // Plain HTTP links: a phone paired before the secure channel.
    const { app, port, home, old } = await setup(1);
    const c = await helloPlain(port, old[0].token);
    const cwd = path.join(home, 'chat');
    const rt = await chatIn(app, c, cwd);
    const file = path.join(cwd, 'notes.txt');
    writeFileSync(file, 'version one');
    rt.add(share('s1', 'done', [{ path: file, name: 'notes.txt', size: 11 }]));
    const get = async () => {
      const l = (await c.call('phone.fileLink', { sessionId: rt.id, itemId: 's1', index: 0 })) as { result: { path: string } };
      return `http://127.0.0.1:${port}${l.result.path}`;
    };
    // Rewritten in place with the same size: refused.
    const a = await get();
    writeFileSync(file, 'version two');
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect((await fetch(a)).status).toBe(409);
    // Replaced by another file of the same size: refused.
    rt.add(share('s2', 'done', [{ path: file, name: 'notes.txt', size: 11 }]));
    const l2 = (await c.call('phone.fileLink', { sessionId: rt.id, itemId: 's2', index: 0 })) as { result: { path: string } };
    writeFileSync(path.join(cwd, 'other.txt'), 'version six');
    renameSync(path.join(cwd, 'other.txt'), file);
    expect((await fetch(`http://127.0.0.1:${port}${l2.result.path}`)).status).toBe(409);
    c.ws.close();
  });
});

describe('the first frame of a socket', () => {
  it('reads only an object with a token or a key', () => {
    for (const bad of ['42', 'null', '[]', '"hello"', 'true', '{"hello":null}', '{"hello":"x"}', '{"hello":{"token":5}}', '{"pair":7}', '{"pair":{"key":""}}', '{}', 'not json']) expect(readHello(bad), bad).toBeNull();
    expect(readHello('{"hello":{"token":"abc"}}')).toEqual({ hello: { token: 'abc' } });
    expect(readHello('{"pair":{"key":"k","name":"Pixel"}}')).toEqual({ pair: { key: 'k', name: 'Pixel' } });
  });

  it('malformed, closes only that socket; the endpoint and other phones go on', async () => {
    const { app, port } = await setup();
    const { c, token, deviceId, fingerprint } = await pairPhone(app, port);
    for (const bad of ['42', 'null', '[1]', '"x"', '{"hello":null}', '{"hello":"x"}', '{"pair":3}']) {
      const s = client(port);
      await s.open;
      s.ws.send(bad);
      expect(await s.closed, bad).toBe(4000);
    }
    // Still there: the paired phone works, and a new socket with the token is welcomed.
    expect((await c.call('app.hello')).ok).toBe(true);
    const again = (await helloSecure(port, { deviceId, token, fingerprint })).c;
    expect(await again.next((f) => 'welcome' in f)).toBeTruthy();
    expect((await app.call('phone.status', {})).listening).toBe(true);
    again.ws.close();
    c.ws.close();
  });
});

describe('pictures from the phone', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';

  it('are image data within the caps, never a path, a file or text', () => {
    expect(phoneAttachments([{ id: 'p1', kind: 'image', name: 'Photo', dataUrl: png, path: 'C:\\Users\\me\\secret.png', text: 'x' }])).toEqual([{ id: 'p1', kind: 'image', name: 'Photo', dataUrl: png, mime: 'image/png', size: 8 }]);
    expect(() => phoneAttachments([{ kind: 'image', name: 'x.png', path: 'C:\\Users\\me\\secret.png' }])).toThrow(/pictures/);
    expect(() => phoneAttachments([{ kind: 'file', name: 'a.txt', path: '/etc/passwd' }])).toThrow(/pictures/);
    expect(() => phoneAttachments([{ kind: 'text', name: 'a.txt', text: 'hello' }])).toThrow(/pictures/);
    expect(() => phoneAttachments([{ kind: 'image', dataUrl: 'data:text/html;base64,PGI+' }])).toThrow(/pictures/);
    expect(() => phoneAttachments('C:\\secret.png')).toThrow(/pictures/);
    expect(() => phoneAttachments([{ kind: 'image', dataUrl: `data:image/png;base64,${'A'.repeat(9 * 1024 * 1024)}` }])).toThrow(/too big/);
    expect(phoneAttachments(undefined)).toBeUndefined();
    // One the desktop holds for the message, named by its id: the desktop's own copy.
    const mine = { id: 'a1', kind: 'image' as const, name: 'shot.png', dataUrl: png };
    expect(phoneAttachments([{ id: 'a1', kind: 'image', path: 'C:\\other.png' }], [mine])).toEqual([mine]);
  });

  it('a message from the phone carries no desktop path to the agent', async () => {
    const { app, port } = await setup();
    const { c } = await pairPhone(app, port);
    const rt = await chatIn(app, c, path.resolve('.'));
    const sent = await c.call('session.send', { sessionId: rt.id, text: 'look', attachments: [{ id: 'x', kind: 'image', name: 'x.png', path: path.resolve('package.json') }] });
    expect(sent.ok).toBe(false);
    expect(rt.items.some((i) => i.type === 'user')).toBe(false);
    const ok = await c.call('session.send', { sessionId: rt.id, text: 'look at this', attachments: [{ id: 'p1', kind: 'image', name: 'Photo', dataUrl: png, path: path.resolve('package.json') }] });
    expect(ok.ok).toBe(true);
    const msg = rt.items.find((i): i is UserItem => i.type === 'user')!;
    expect(msg.attachments).toEqual([{ id: 'p1', kind: 'image', name: 'Photo', dataUrl: png, mime: 'image/png', size: 8 }]);
    c.ws.close();
  });

  it('a queued message edited on the phone keeps the desktop copy of its own pictures', async () => {
    const { app, port } = await setup();
    const { c } = await pairPhone(app, port);
    const rt = await chatIn(app, c, path.resolve('.'));
    const q = rt.enqueue('first', [{ id: 'a1', kind: 'image', name: 'shot.png', dataUrl: png }]);
    const r = await c.call('queue.update', { sessionId: rt.id, id: q.id, text: 'edited', attachments: [{ id: 'a1', kind: 'image', name: 'shot.png', path: path.resolve('package.json') }] });
    expect(r.ok).toBe(true);
    expect(rt.queue[0]).toMatchObject({ text: 'edited', attachments: [{ id: 'a1', kind: 'image', name: 'shot.png', dataUrl: png }] });
    expect(rt.queue[0].attachments?.[0].path).toBeUndefined();
    c.ws.close();
  });
});

describe('what goes back to a phone', () => {
  const big = (n: number) => 'x'.repeat(n);
  const request = (): PermissionRequest => ({
    id: 'p1',
    sessionId: 's1',
    toolName: 'Write',
    kind: 'write',
    title: 'Write src/huge.ts',
    detail: { path: 'src/huge.ts', content: big(4_000_000), oldText: big(1_000_000), newText: big(1_000_000), plan: big(100_000) },
    diff: [{ path: 'src/huge.ts', status: 'added', additions: 100_000, deletions: 0, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 100_000, lines: Array.from({ length: 100_000 }, (_, i) => `+line ${i} ${big(50)}`) }] }],
    options: [
      { id: 'allow', label: 'Allow once', tone: 'allow' },
      { id: 'deny', label: 'Deny', tone: 'deny' },
    ],
    createdAt: 1,
  });

  it('a permission with a whole file in it, cut like a step opened in full', () => {
    const p = phonePermission(request());
    expect(JSON.stringify(p).length).toBeLessThan(120_000);
    expect(p.detail.path).toBe('src/huge.ts');
    expect(p.diff?.[0]).toMatchObject({ path: 'src/huge.ts', additions: 100_000 });
    expect(p.options.map((o) => o.id)).toEqual(['allow', 'deny']);
    const e = phoneEvent({ type: 'permission.added', request: request() });
    expect(JSON.stringify(e).length).toBeLessThan(120_000);
    const hello = phoneResult('app.hello', { version: '1', prompts: { permissions: [request()], questions: [] } }) as { prompts: { permissions: PermissionRequest[] } };
    expect(JSON.stringify(hello).length).toBeLessThan(120_000);
  });

  it('a queued message taken back without its pictures', () => {
    const message: QueuedMessage = { id: 'q1', text: 'look', createdAt: 1, attachments: [{ id: 'a1', kind: 'image', name: 'shot.png', dataUrl: `data:image/png;base64,${big(3_000_000)}`, size: 2_000_000 }] };
    const r = phoneResult('queue.take', { message }) as { message: QueuedMessage };
    expect(r.message.attachments).toEqual([{ id: 'a1', kind: 'image', name: 'shot.png', size: 2_000_000 }]);
  });

  it('over the socket: permission requests cut, queue.take without data, and no frame over its budget', async () => {
    const { app, port } = await setup();
    const { c } = await pairPhone(app, port);
    const rt = await chatIn(app, c, path.resolve('.'));
    app.emit({ type: 'permission.added', request: { ...request(), sessionId: rt.id } });
    const got = (await c.next((f) => (f.event as { type?: string } | undefined)?.type === 'permission.added')) as { event: { request: PermissionRequest } };
    expect(JSON.stringify(got).length).toBeLessThan(120_000);
    const q = rt.enqueue('look', [{ id: 'a1', kind: 'image', name: 'shot.png', dataUrl: `data:image/png;base64,${big(3_000_000)}` }]);
    const taken = (await c.call('queue.take', { sessionId: rt.id, id: q.id })) as { result: { message: QueuedMessage } };
    expect(taken.result.message.attachments?.[0].dataUrl).toBeUndefined();
    // An event too big for a phone is left out; the next one comes.
    app.emit({ type: 'toast', level: 'info', text: big(FRAME_MAX.event + 10) });
    app.emit({ type: 'toast', level: 'info', text: 'small' });
    await c.next((f) => (f.event as { text?: string } | undefined)?.text === 'small');
    expect(c.frames.some((f) => typeof (f.event as { text?: string } | undefined)?.text === 'string' && (f.event as { text: string }).text.length > 1000)).toBe(false);
    c.ws.close();
  });
});

describe("a chat's changes from the phone, in a repository's subfolder", () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };

  it('lists and diffs only the chat folder, never a sibling folder or a link out of it', async () => {
    const { app, port, home } = await setup();
    const repo = path.join(home, 'repo');
    mkdirSync(path.join(repo, 'app'), { recursive: true });
    mkdirSync(path.join(repo, 'private'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'core.autocrlf', 'false');
    writeFileSync(path.join(repo, 'app', 'a.ts'), 'one\n');
    writeFileSync(path.join(repo, 'private', 'keys.txt'), 'secret one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    writeFileSync(path.join(repo, 'app', 'a.ts'), 'one\ntwo\n');
    writeFileSync(path.join(repo, 'private', 'keys.txt'), 'secret two\n');
    writeFileSync(path.join(repo, 'private', 'new.txt'), 'secret new\n');
    writeFileSync(path.join(home, 'outside.txt'), 'outside the repository\n');
    // An untracked link in the chat's folder that leads out of it (where links can be made).
    let linked = false;
    try {
      symlinkSync(path.join(home, 'outside.txt'), path.join(repo, 'app', 'leak.txt'), 'file');
      linked = true;
    } catch {
      /* no symlinks for this user on Windows: that part is skipped */
    }
    const { c } = await pairPhone(app, port);
    const created = (await c.call('session.create', { provider: 'demo', cwd: path.join(repo, 'app') })) as { result: PhoneTail };
    const id = created.result.session.id;

    const list = (await c.call('phone.changes', { sessionId: id })) as { ok: boolean; result: PhoneChanges };
    expect(list.ok).toBe(true);
    const paths = list.result.files.map((f) => f.path).sort();
    expect(paths).toEqual(linked ? ['a.ts', 'leak.txt'] : ['a.ts']);
    expect(list.result.additions).toBe(1);
    const diff = async (p: string) => (await c.call('phone.diff', { sessionId: id, path: p })) as { ok: boolean; result: PhoneDiff; error?: string };
    expect((await diff('a.ts')).result.diff?.hunks.flatMap((h) => h.lines)).toContain('+two');
    for (const p of ['../private/keys.txt', '../private/new.txt', '..\\private\\keys.txt', path.join(repo, 'private', 'keys.txt')]) {
      const r = await diff(p);
      expect(r.ok, p).toBe(false);
    }
    if (linked) {
      // The link is listed (git lists it), but what it leads to is never read.
      const leak = await diff('leak.txt');
      expect(JSON.stringify(leak)).not.toContain('outside the repository');
      expect(list.result.files.find((f) => f.path === 'leak.txt')?.additions ?? 0).toBe(0);
    }
    c.ws.close();
    // Git-heavy: room for a loaded machine.
  }, 20_000);
});
