/** The phone endpoint (server/services/phone.ts): pairing with approval, token hello, the allowlist, rate limits, revocation; the QR encoder; Claude's Remote Control default. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  PHONE_OWN_METHODS,
  PHONE_PATH,
  type Capabilities,
  type ModelInfo,
  type NoticeItem,
  type PhoneChanges,
  type PhoneDiff,
  type PhoneFrame,
  type PhoneSearch,
  type PhoneStatus,
  type PhoneTail,
  type TextItem,
  type TimelineItem,
  type ToolItem,
  type UserItem,
} from '@shared/protocol';
import { App, withDefaultOptions } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { capabilities } from '../server/providers/demo-catalog';
import type { Provider, ProviderContext } from '../server/providers/types';
import { registerFs } from '../server/services/fs';
import { LIMITS, phoneDetail, phoneEvent, phonePage, REACH, registerPhone, SEARCH, type PhoneService } from '../server/services/phone';
import { qrMatrix } from '../server/services/qr';
import { registerThumbs } from '../server/services/thumbs';
import { mergeHosts } from '../mobile/src/lib/hosts';

const homes: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/** The Demo under the id "codex" with models of its own: a second agent to switch to, nothing real started. */
const FAKE_MODELS: ModelInfo[] = [
  { id: 'gpt-6', name: 'GPT-6', isDefault: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
  { id: 'gpt-6-mini', name: 'GPT-6 Mini', efforts: ['low', 'medium'], defaultEffort: 'low' },
];
const fakeCaps = (): Capabilities => ({ ...capabilities(), models: FAKE_MODELS.map((m) => ({ ...m })) });
function fakeCodex(ctx: ProviderContext): Provider {
  const p = new DemoProvider(ctx, { speed: 0 });
  Object.assign(p, { id: 'codex', name: 'Codex' });
  p.caps = async () => fakeCaps();
  const open = p.open.bind(p);
  p.open = async (rt, opts) => {
    if (!rt.meta.model) rt.update({ model: 'gpt-6' });
    const s = await open(rt, opts);
    rt.setCaps(fakeCaps());
    return s;
  };
  return p as unknown as Provider;
}

async function setup(opts: { codex?: boolean } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-phone-'));
  homes.push(home);
  const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 }), ...(opts.codex ? [fakeCodex] : [])] });
  apps.push(app);
  registerFs(app);
  const phone = registerPhone(app, { port: 0, host: '127.0.0.1' });
  const status = await app.call('phone.setEnabled', { on: true });
  expect(status.listening).toBe(true);
  return { app, phone, home, port: status.port };
}

type Frame = PhoneFrame | { id: number; ok: boolean; result?: unknown; error?: string } | { event: unknown };

function client(port: number, origin?: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${PHONE_PATH}`, origin ? { headers: { origin } } : undefined);
  const frames: Frame[] = [];
  const waiters: ((f: Frame) => void)[] = [];
  ws.on('message', (m) => {
    const f = JSON.parse(String(m)) as Frame;
    frames.push(f);
    for (const w of waiters.splice(0)) w(f);
  });
  const next = (pred: (f: Frame) => boolean) =>
    new Promise<Frame>((resolve, reject) => {
      const hit = frames.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error('no such frame')), 3000);
      const check = (f: Frame) => {
        if (pred(f)) {
          clearTimeout(t);
          resolve(f);
        } else waiters.push(check);
      };
      waiters.push(check);
    });
  const open = new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('refused'), { status: res.statusCode })));
    ws.on('error', reject);
  });
  let id = 0;
  const call = async (method: string, params: unknown = {}) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params }));
    return (await next((f) => 'id' in f && f.id === i)) as { ok: boolean; result?: unknown; error?: string };
  };
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  return { ws, open, next, call, closed, frames };
}

const keyOf = (s: PhoneStatus) => /k=([^&]+)/.exec(s.pairing!.link)![1];

async function pairPhone(app: App, port: number) {
  const offer = await app.call('phone.pair', {});
  const c = client(port, 'http://localhost');
  await c.open;
  c.ws.send(JSON.stringify({ pair: { key: keyOf(offer), name: 'Test phone' } }));
  await c.next((f) => 'waiting' in f);
  const asking = await app.call('phone.status', {});
  expect(asking.request?.name).toBe('Test phone');
  await app.call('phone.approve', { requestId: asking.request!.id, allow: true });
  const paired = (await c.next((f) => 'paired' in f)) as { paired: { token: string; deviceId: string } };
  await c.next((f) => 'welcome' in f);
  return { c, token: paired.paired.token, deviceId: paired.paired.deviceId };
}

describe('phone endpoint', () => {
  it('pairs only after "Allow", keeps the token hashed, and the key works once', async () => {
    const { app, port, home } = await setup();
    const offer = await app.call('phone.pair', {});
    expect(offer.pairing?.link).toMatch(/^sable:\/\/pair\?h=.*&p=\d+&k=[\w-]{20,}/);
    const { c, token } = await pairPhone(app, port);
    expect(token.length).toBeGreaterThanOrEqual(40);
    const saved = readFileSync(path.join(home, 'phone.json'), 'utf8');
    expect(saved).not.toContain(token);
    expect((await app.call('phone.status', {})).devices).toHaveLength(1);
    // The same key again: refused.
    const again = client(port);
    await again.open;
    again.ws.send(JSON.stringify({ pair: { key: keyOf(offer), name: 'Other' } }));
    expect(await again.next((f) => 'denied' in f)).toBeTruthy();
    c.ws.close();
  });

  it('denied pairing gives no token', async () => {
    const { app, port } = await setup();
    const offer = await app.call('phone.pair', {});
    const c = client(port);
    await c.open;
    c.ws.send(JSON.stringify({ pair: { key: keyOf(offer), name: 'Stranger' } }));
    await c.next((f) => 'waiting' in f);
    const st = await app.call('phone.status', {});
    await app.call('phone.approve', { requestId: st.request!.id, allow: false });
    await c.next((f) => 'denied' in f);
    expect(c.frames.some((f) => 'paired' in f)).toBe(false);
    expect((await app.call('phone.status', {})).devices).toHaveLength(0);
  });

  it('a paired phone calls only the allowlist, with narrowed parameters', async () => {
    const { app, port } = await setup();
    const { c } = await pairPhone(app, port);
    const hello = await c.call('app.hello');
    expect(hello.ok).toBe(true);
    for (const m of ['term.run', 'fs.read', 'memory.write', 'app.setSettings', 'phone.status', 'phone.pair', 'git.commit', 'auth.login', 'device.tap']) {
      const r = await c.call(m, {});
      expect(r.ok, m).toBe(false);
      expect(r.error).toMatch(/Not available from the phone/);
    }
    // Folder listing never returns files.
    const list = (await c.call('fs.list', { path: path.resolve('.') })) as { ok: boolean; result: { entries: { dir: boolean }[] } };
    expect(list.ok).toBe(true);
    expect(list.result.entries.every((e) => e.dir)).toBe(true);
    // session.update takes only pinned / archived / unread.
    const snap = (await c.call('session.create', { provider: 'demo', cwd: path.resolve('.') })) as { result: { session: { id: string } } };
    const id = snap.result.session.id;
    await c.call('session.update', { sessionId: id, patch: { pinned: true, cwd: 'C:/elsewhere', provider: 'claude' } });
    const meta = app.sessions.get(id)!.meta;
    expect(meta.pinned).toBe(true);
    expect(meta.cwd).not.toBe('C:/elsewhere');
    expect(meta.provider).toBe('demo');
    // session.setOptions passes only Remote Control.
    await c.call('session.setOptions', { sessionId: id, options: { computerUse: true, browser: true, remoteControl: true } });
    expect(app.sessions.get(id)!.meta.options?.computerUse).toBeUndefined();
    expect(app.sessions.get(id)!.meta.options?.remoteControl).toBe(true);
  });

  it('streams conversation events but never the phone service state', async () => {
    const { app, port } = await setup();
    const { c } = await pairPhone(app, port);
    app.emit({ type: 'toast', level: 'info', text: 'hello phone' });
    app.emit({ type: 'term.data', termId: 't', data: 'secret', stream: 'out' });
    await app.call('phone.pair', {});
    await c.next((f) => 'event' in f && (f.event as { type: string }).type === 'toast');
    await new Promise((r) => setTimeout(r, 100));
    const types = c.frames.filter((f) => 'event' in f).map((f) => (f as { event: { type: string } }).event.type);
    expect(types).not.toContain('term.data');
    expect(types).not.toContain('phone.updated');
  });

  it('refuses wrong tokens, blocks an address after repeated failures, and refuses web pages', async () => {
    const { port } = await setup();
    for (let i = 0; i < 5; i++) {
      const c = client(port);
      await c.open;
      c.ws.send(JSON.stringify({ hello: { token: `wrong-${i}` } }));
      expect(await c.closed).toBe(4001);
    }
    const blocked = client(port);
    await expect(blocked.open).rejects.toMatchObject({ status: 429 });
    const page = client(port, 'http://evil.example');
    await expect(page.open).rejects.toMatchObject({ status: 403 });
  });

  it('revoking a phone ends its connection and its token', async () => {
    const { app, port } = await setup();
    const { c, token, deviceId } = await pairPhone(app, port);
    await app.call('phone.revoke', { deviceId });
    expect(await c.closed).toBe(4001);
    const again = client(port);
    await again.open;
    again.ws.send(JSON.stringify({ hello: { token } }));
    expect(await again.closed).toBe(4001);
  });

  it('a paired phone reconnects with its token after a restart of the endpoint', async () => {
    const { app, port, phone } = await setup();
    const { c, token } = await pairPhone(app, port);
    c.ws.close();
    await (phone as PhoneService).stop();
    await app.call('phone.setEnabled', { on: true });
    const port2 = (await app.call('phone.status', {})).port;
    const again = client(port2);
    await again.open;
    again.ws.send(JSON.stringify({ hello: { token } }));
    expect(await again.next((f) => 'welcome' in f)).toBeTruthy();
    again.ws.close();
  });
});

describe('conversations in pages', () => {
  const big = 'x'.repeat(2_000_000);
  /** A long conversation: `turns` turns, each a message, `steps` tool calls with big output, an answer and its end. */
  function long(turns: number, steps: number): TimelineItem[] {
    const out: TimelineItem[] = [];
    let n = 0;
    for (let t = 0; t < turns; t++) {
      out.push({ id: `u${t}`, ts: n++, type: 'user', text: `message ${t}`, attachments: [{ id: 'a', kind: 'image', name: 'shot.png', dataUrl: `data:image/png;base64,${'A'.repeat(300_000)}` }] });
      for (let s = 0; s < steps; s++) {
        out.push({
          id: `t${t}-${s}`,
          ts: n++,
          type: 'tool',
          name: 'Bash',
          kind: 'bash',
          title: 'Run tests',
          status: 'done',
          detail: { command: 'pnpm test', newText: big },
          input: { command: 'pnpm test', blob: big },
          output: big,
          result: { text: big, images: ['data:image/png;base64,AAAA'], diff: [{ path: 'a.ts', status: 'modified', additions: 3, deletions: 1, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 3, lines: ['-a', '+b', '+c', '+d'] }] }] },
        });
        out.push({ id: `k${t}-${s}`, ts: n++, type: 'text', text: big, streaming: false, parentId: `t${t}-${s}` });
      }
      out.push({ id: `a${t}`, ts: n++, type: 'text', text: `answer ${t} ${'y'.repeat(20_000)}`, streaming: false });
      out.push({ id: `e${t}`, ts: n++, type: 'turn', durationMs: 1000 });
    }
    return out;
  }

  it('sends the newest page, trimmed, with a cursor to the one before', () => {
    const items = long(60, 5);
    const page = phonePage(items);
    expect(page.total).toBe(60 * 8);
    const bytes = JSON.stringify(page).length;
    expect(bytes).toBeLessThan(100_000);
    // Newest last, starting at a message (a turn is not split).
    expect(page.items[page.items.length - 1].id).toBe('e59');
    expect(page.items[0].type).toBe('user');
    expect(page.cursor).toBe(page.items[0].id);
    const tool = page.items.find((i) => i.type === 'tool') as ToolItem & { more?: boolean };
    expect(tool.output).toBeUndefined();
    expect(tool.input).toBeUndefined();
    expect(tool.detail.newText).toBeUndefined();
    expect(tool.detail.command).toBe('pnpm test');
    expect(tool.result?.text).toBeUndefined();
    expect(tool.result?.images).toBeUndefined();
    expect(tool.result?.diff?.[0]).toMatchObject({ additions: 3, deletions: 1, hunks: [] });
    expect(tool.more).toBe(true);
    expect((tool as { kids?: number }).kids).toBe(1);
    // No sub-agent steps in a page; no picture data.
    expect(page.items.some((i) => i.parentId)).toBe(false);
    const user = page.items.find((i) => i.type === 'user') as UserItem;
    expect(user.attachments?.[0]).toEqual({ id: 'a', kind: 'image', name: 'shot.png' });
    // An answer keeps a generous length and says it was cut.
    const answer = page.items.find((i) => i.type === 'text') as TextItem & { cut?: boolean };
    expect(answer.text.length).toBe(LIMITS.answer);
    expect(answer.cut).toBe(true);
  });

  it('pages back to the start without gaps or repeats', () => {
    const items = long(25, 4);
    const roots = items.filter((i) => !i.parentId).map((i) => i.id);
    const seen: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 100; i++) {
      const page = phonePage(items, { before });
      seen.unshift(...page.items.map((x) => x.id));
      before = page.cursor;
      if (!before) break;
    }
    expect(seen).toEqual(roots);
    // A cursor that is gone gives an empty page.
    expect(phonePage(items, { before: 'nope' }).items).toEqual([]);
  });

  it('reaches back to an item asked for (a search hit), within its cap, and pages on from there', () => {
    const items = long(60, 5);
    const plain = phonePage(items);
    expect(plain.items.some((i) => i.id === 'u20')).toBe(false);
    const page = phonePage(items, { to: 'a20' });
    const ids = page.items.map((i) => i.id);
    // The turn that holds it is whole (from its message), and the page runs to the newest.
    expect(ids[0]).toBe('u20');
    expect(ids[ids.length - 1]).toBe('e59');
    expect(page.cursor).toBe('u20');
    expect(JSON.stringify(page).length).toBeLessThan(REACH.bytes * 1.7);
    // From a cursor, as `before`; an item after the cursor or unknown changes nothing.
    const older = phonePage(items, { before: 'u20', to: 'u3' });
    expect(older.items[0].id).toBe('u3');
    expect(older.items[older.items.length - 1].id).toBe('e19');
    expect(phonePage(items, { to: 'nope' }).items.map((i) => i.id)).toEqual(plain.items.map((i) => i.id));
  });

  it('cuts text between steps to a line, and returns one item in full on request', () => {
    const items: TimelineItem[] = [
      { id: 'u', ts: 0, type: 'user', text: 'go' },
      { id: 'x', ts: 1, type: 'text', text: 'z'.repeat(5000), streaming: false },
      { id: 't', ts: 2, type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'done', detail: { command: 'ls' }, output: 'line\n'.repeat(1000) },
      { id: 'c', ts: 3, type: 'thinking', text: 'w'.repeat(5000), streaming: false, parentId: 't' },
    ];
    const page = phonePage(items);
    expect((page.items[1] as TextItem).text.length).toBe(LIMITS.step);
    const d = phoneDetail(items, 't');
    expect((d.item as ToolItem).output?.split('\n').length).toBeLessThanOrEqual(202);
    expect(d.children.map((c) => c.id)).toEqual(['c']);
    expect(() => phoneDetail(items, 'gone')).toThrow();
  });

  it('trims live events: no tool output, no big results, text deltas pass', () => {
    expect(phoneEvent({ type: 'item.delta', sessionId: 's', id: 't', field: 'output', delta: big })).toBeNull();
    expect(phoneEvent({ type: 'item.delta', sessionId: 's', id: 't', field: 'text', delta: 'hi' })).toMatchObject({ delta: 'hi' });
    const patch = phoneEvent({ type: 'item.patch', sessionId: 's', id: 't', patch: { status: 'done', output: big, result: { text: big, exitCode: 0 } } as Partial<TimelineItem> });
    expect(JSON.stringify(patch).length).toBeLessThan(400);
    const reset = phoneEvent({ type: 'timeline.reset', sessionId: 's', items: long(30, 3) }) as { items: unknown[]; cursor?: string };
    expect(JSON.stringify(reset).length).toBeLessThan(100_000);
    expect(reset.cursor).toBeTruthy();
  });

  it('over the socket: a page, its compressed size, and events only for open conversations', async () => {
    const { app, port } = await setup();
    const { c } = await pairPhone(app, port);
    const created = (await c.call('session.create', { provider: 'demo', cwd: path.resolve('.') })) as { result: PhoneTail };
    const id = created.result.session.id;
    const other = await app.call('session.create', { provider: 'demo', cwd: path.resolve('.') });
    // A huge timeline loaded into the session.
    const rt = app.sessions.get(id)!;
    rt.load(long(40, 6), [], []);
    const before = (c.ws as unknown as { _socket: { bytesRead: number } })._socket.bytesRead;
    const tail = (await c.call('phone.tail', { sessionId: id })) as { ok: boolean; result: PhoneTail };
    const wire = (c.ws as unknown as { _socket: { bytesRead: number } })._socket.bytesRead - before;
    expect(tail.ok).toBe(true);
    expect(tail.result.items.length).toBeGreaterThan(5);
    expect(wire).toBeLessThan(40_000);
    // session.snapshot from a phone is cut to its page too.
    const snap = (await c.call('session.snapshot', { sessionId: id })) as { result: PhoneTail };
    expect(snap.result.cursor).toBeTruthy();
    expect(JSON.stringify(snap.result).length).toBeLessThan(100_000);
    const more = (await c.call('phone.tail', { sessionId: id, before: tail.result.cursor })) as { result: PhoneTail };
    expect(more.result.items[more.result.items.length - 1].id).not.toBe(tail.result.items[0].id);
    const one = (await c.call('phone.item', { sessionId: id, itemId: 't39-0' })) as { result: { item: ToolItem; children: unknown[] } };
    expect(one.result.item.result?.text?.length).toBeGreaterThan(1000);
    expect(one.result.children).toHaveLength(1);
    // Item events: the open conversation's, not another's.
    const n = c.frames.length;
    app.emit({ type: 'item.delta', sessionId: other.session.id, id: 'x', field: 'text', delta: 'elsewhere' });
    app.emit({ type: 'item.delta', sessionId: id, id: 'a39', field: 'text', delta: 'here' });
    app.emit({ type: 'item.delta', sessionId: id, id: 't39-0', field: 'output', delta: big });
    await c.next((f) => 'event' in f && (f.event as { delta?: string }).delta === 'here');
    await new Promise((r) => setTimeout(r, 50));
    const got = c.frames.slice(n).filter((f) => 'event' in f).map((f) => (f as { event: { delta?: string } }).event.delta);
    expect(got).toEqual(['here']);
    // Still only for phones: the localhost bridge has no such methods.
    await expect(app.call('phone.tail' as never, { sessionId: id } as never)).rejects.toThrow();
    c.ws.close();
  });
});

describe('files the agent hands over', () => {
  it('gives a short-lived link for a shared file of the chat, serves only that file, and refuses others', async () => {
    const { app, port, home } = await setup();
    const { c } = await pairPhone(app, port);
    // The chat's own folder: a file outside it goes to a phone only when the person allowed the share (tests/share-handed.test.ts).
    const created = (await c.call('session.create', { provider: 'demo', cwd: home })) as { result: PhoneTail };
    const id = created.result.session.id;
    const file = path.join(home, 'build.apk');
    writeFileSync(file, 'apk bytes');
    const rt = app.sessions.get(id)!;
    rt.add({ id: 'share1', type: 'tool', name: 'SendUserFile', kind: 'share', title: 'build.apk', status: 'done', detail: { files: [{ path: file, name: 'build.apk', size: 9 }] } } as never);
    rt.add({ id: 'read1', type: 'tool', name: 'Read', kind: 'read', title: 'Read', status: 'done', detail: { path: file } } as never);
    const link = (await c.call('phone.fileLink', { sessionId: id, itemId: 'share1', index: 0 })) as { ok: boolean; result: { path: string; name: string; size: number } };
    expect(link.ok).toBe(true);
    expect(link.result).toMatchObject({ name: 'build.apk', size: 9 });
    const res = await fetch(`http://127.0.0.1:${port}${link.result.path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.android.package-archive');
    expect(await res.text()).toBe('apk bytes');
    // Not a share step, an index out of range, or a made-up token: nothing.
    expect(((await c.call('phone.fileLink', { sessionId: id, itemId: 'read1', index: 0 })) as { ok: boolean }).ok).toBe(false);
    expect(((await c.call('phone.fileLink', { sessionId: id, itemId: 'share1', index: 3 })) as { ok: boolean }).ok).toBe(false);
    expect((await fetch(`http://127.0.0.1:${port}/f/not-a-token/build.apk`)).status).toBe(404);
    c.ws.close();
  });

  it("gives a small picture of a shared file for its row, by the bridge's rules, at the row's width", async () => {
    const { app, port, home } = await setup();
    const asked: { file: string; px: number }[] = [];
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);
    registerThumbs(app, { pdf: null, host: { thumbnail: async (file, px) => (asked.push({ file, px }), { mime: 'image/jpeg', data: jpeg }) } });
    expect(PHONE_OWN_METHODS).toContain('phone.thumb');
    const { c } = await pairPhone(app, port);
    const id = (await app.call('session.create', { provider: 'demo', cwd: home })).session.id;
    const other = (await app.call('session.create', { provider: 'demo', cwd: home })).session.id;
    const shot = path.join(home, 'shot.png');
    writeFileSync(shot, 'png bytes');
    const files = [
      { path: shot, name: 'shot.png', size: 9 },
      { path: path.join(home, 'notes.zip'), name: 'notes.zip', size: 3 },
    ];
    writeFileSync(files[1].path, 'zip');
    const rt = app.sessions.get(id)!;
    rt.add({ id: 'share1', type: 'tool', name: 'SendUserFile', kind: 'share', title: 'shot.png', status: 'done', detail: { files } } as never);
    rt.add({ id: 'ask1', type: 'tool', name: 'SendUserFile', kind: 'share', title: 'shot.png', status: 'awaiting', detail: { files } } as never);
    rt.add({ id: 'read1', type: 'tool', name: 'Read', kind: 'read', title: 'Read', status: 'done', detail: { path: shot } } as never);
    const thumb = (params: Record<string, unknown>) => c.call('phone.thumb', params) as Promise<{ ok: boolean; result?: { data: string | null }; error?: string }>;
    const ok = await thumb({ sessionId: id, itemId: 'share1', index: 0, size: 4096 });
    expect(ok.result?.data).toBe(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
    // The row's width, whatever the phone asked for; a kind with no picture is none, nothing tried.
    expect(asked).toEqual([{ file: shot, px: 160 }]);
    expect((await thumb({ sessionId: id, itemId: 'share1', index: 1 })).result?.data).toBeNull();
    // Waiting for "Allow", not a share, past the list, another chat, a path of its own: nothing.
    for (const params of [
      { sessionId: id, itemId: 'ask1', index: 0 },
      { sessionId: id, itemId: 'read1', index: 0 },
      { sessionId: id, itemId: 'share1', index: 2 },
      { sessionId: other, itemId: 'share1', index: 0 },
      { sessionId: id, path: shot },
    ])
      expect((await thumb(params)).ok, JSON.stringify(params)).toBe(false);
    // Changed since it was shared: nothing.
    writeFileSync(shot, 'png bytes, rewritten');
    expect((await thumb({ sessionId: id, itemId: 'share1', index: 0 })).error).toBe('That file changed after it was shared.');
    expect(asked).toHaveLength(1);
    c.ws.close();
  });
});

describe('searching chats from the phone', () => {
  /** A chat with messages and steps whose output must never be searched. */
  function fill(app: App, id: string, words: string[]) {
    const rt = app.sessions.get(id)!;
    words.forEach((w, i) => {
      rt.add({ type: 'user', text: `question ${i}: ${w}` } as never);
      rt.add({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'done', detail: { command: 'grep pineapple' }, output: 'pineapple pineapple', result: { text: 'pineapple', images: [`data:image/png;base64,${'A'.repeat(1_500_000)}`] } } as never);
      rt.add({ type: 'text', text: `Answer ${i} about ${w}.`, streaming: false } as never);
      rt.add({ type: 'turn', durationMs: 10 } as never);
    });
  }

  it('finds messages across chats, newest first, never in steps, archived chats or what the harness wrote', async () => {
    const { app, port } = await setup();
    const { c } = await pairPhone(app, port);
    const a = (await app.call('session.create', { provider: 'demo', cwd: path.resolve('.') })).session.id;
    const b = (await app.call('session.create', { provider: 'demo', cwd: path.resolve('.') })).session.id;
    const gone = (await app.call('session.create', { provider: 'demo', cwd: path.resolve('.') })).session.id;
    fill(app, a, ['the Banana split', 'apple pie', 'banana bread']);
    fill(app, b, ['a cherry banana tart']);
    fill(app, gone, ['banana archived']);
    app.sessions.get(a)!.add({ type: 'user', text: '<task-notification>banana done</task-notification>' } as never);
    await app.call('session.update', { sessionId: gone, patch: { archived: true } });
    const r = (await c.call('phone.search', { query: 'BANANA' })) as { ok: boolean; result: PhoneSearch };
    expect(r.ok).toBe(true);
    const hits = r.result.hits;
    expect(new Set(hits.map((h) => h.sessionId))).toEqual(new Set([a, b]));
    // Within a chat, the newest message first; the person's words and the agent's.
    const inA = hits.filter((h) => h.sessionId === a);
    expect(inA.map((h) => h.text)).toEqual(['Answer 2 about banana bread.', 'question 2: banana bread', 'Answer 0 about the Banana split.', 'question 0: the Banana split']);
    expect(inA[0].role).toBe('agent');
    expect(inA[1].role).toBe('user');
    // Every word must be there; steps and their output are not searched; short queries find nothing.
    expect(((await c.call('phone.search', { query: 'banana bread' })) as { result: PhoneSearch }).result.hits).toHaveLength(2);
    expect(((await c.call('phone.search', { query: 'pineapple' })) as { result: PhoneSearch }).result.hits).toEqual([]);
    expect(((await c.call('phone.search', { query: 'b' })) as { result: PhoneSearch }).result.hits).toEqual([]);
    // A long message gives the words around the match.
    app.sessions.get(b)!.add({ type: 'text', text: `${'lorem ipsum '.repeat(60)}the quokka sleeps ${'dolor sit '.repeat(60)}`, streaming: false } as never);
    const q = ((await c.call('phone.search', { query: 'quokka' })) as { result: PhoneSearch }).result.hits[0];
    expect(q.text.length).toBeLessThanOrEqual(SEARCH.snippet + 2);
    expect(q.text).toMatch(/^….*the quokka sleeps.*…$/);
    // Not on the localhost bridge.
    await expect(app.call('phone.search' as never, { query: 'banana' } as never)).rejects.toThrow();
    c.ws.close();
  });

  it('reads chats the desktop has not opened from their files, without opening them, and keeps what it read', async () => {
    const first = await setup();
    const a = (await first.app.call('session.create', { provider: 'demo', cwd: path.resolve('.') })).session.id;
    const words = Array.from({ length: 40 }, (_, i) => (i === 3 ? 'the walrus plan' : i === 38 ? 'walrus again, late' : `topic ${i}`));
    fill(first.app, a, words);
    await first.app.call('session.update', { sessionId: a, patch: { unread: true } });
    await first.app.dispose();
    apps.splice(apps.indexOf(first.app), 1);
    expect(existsSync(path.join(first.home, 'sessions', `${a}.json`))).toBe(true);

    const app = new App({ home: first.home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
    apps.push(app);
    const phone = registerPhone(app, { port: 0, host: '127.0.0.1' });
    const port = (await app.call('phone.setEnabled', { on: true })).port;
    const { c } = await pairPhone(app, port);
    expect(app.sessions.get(a)!.items).toHaveLength(0);
    let r = (await c.call('phone.search', { query: 'walrus' })) as { result: PhoneSearch };
    // A chat bigger than one call's budget is read over a few calls: the phone asks again while partial.
    for (let i = 0; i < 4 && r.result.partial; i++) r = (await c.call('phone.search', { query: 'walrus' })) as { result: PhoneSearch };
    expect(r.result.hits.map((h) => h.text)).toEqual(['Answer 38 about walrus again, late.', 'question 38: walrus again, late', 'Answer 3 about the walrus plan.', 'question 3: the walrus plan']);
    // The chat was not opened (nor marked read); the second search reads nothing from disk.
    expect(app.sessions.get(a)!.items).toHaveLength(0);
    expect(app.sessions.get(a)!.meta.unread).toBe(true);
    const kept = (phone as unknown as { finder: { kept: Map<string, unknown> } }).finder.kept;
    expect(kept.has(a)).toBe(true);
    expect(((await c.call('phone.search', { query: 'topic 12' })) as { result: PhoneSearch }).result.hits).toHaveLength(2);
    // The hit opens there: the page reaches back to it.
    const page = (await c.call('phone.tail', { sessionId: a, to: r.result.hits[3].itemId })) as { result: PhoneTail };
    expect(page.result.items.some((i) => i.id === r.result.hits[3].itemId)).toBe(true);
    c.ws.close();
  });
});

describe('pictures of a step', () => {
  it('counts them on the step and gives each one, only a picture of that chat', async () => {
    const { app, port } = await setup();
    const { c } = await pairPhone(app, port);
    const id = (await app.call('session.create', { provider: 'demo', cwd: path.resolve('.') })).session.id;
    const other = (await app.call('session.create', { provider: 'demo', cwd: path.resolve('.') })).session.id;
    const png = `data:image/png;base64,${'iVBORw0KGgo'.repeat(10)}`;
    const rt = app.sessions.get(id)!;
    rt.add({ id: 'u1', type: 'user', text: 'take a screenshot' } as never);
    rt.add({ id: 'shot', type: 'tool', name: 'browser_screenshot', kind: 'browser', title: 'Screenshot', status: 'done', detail: {}, result: { images: [png, 'file:///C:/secret.png', `data:image/svg+xml;base64,PHN2Zz4=`] } } as never);
    app.sessions.get(other)!.add({ id: 'theirs', type: 'tool', name: 'browser_screenshot', kind: 'browser', title: 'Screenshot', status: 'done', detail: {}, result: { images: [png] } } as never);
    const tail = (await c.call('phone.tail', { sessionId: id })) as { result: PhoneTail };
    const step = tail.result.items.find((i) => i.id === 'shot')!;
    expect(step.pics).toBe(3);
    expect((step as ToolItem).result?.images).toBeUndefined();
    const ok = (await c.call('phone.image', { sessionId: id, itemId: 'shot', index: 0 })) as { ok: boolean; result: { data: string } };
    expect(ok.result.data).toBe(png);
    for (const params of [
      { sessionId: id, itemId: 'shot', index: 1 },
      { sessionId: id, itemId: 'shot', index: 2 },
      { sessionId: id, itemId: 'shot', index: 7 },
      { sessionId: id, itemId: 'u1', index: 0 },
      { sessionId: id, itemId: 'theirs', index: 0 },
    ])
      expect(((await c.call('phone.image', params)) as { ok: boolean }).ok).toBe(false);
    // A live patch says so too.
    expect(phoneEvent({ type: 'item.patch', sessionId: id, id: 'shot', patch: { result: { images: [png, png] } } as Partial<TimelineItem> })).toMatchObject({ patch: { pics: 2 } });
    c.ws.close();
  });
});

describe('a turn checked by the other agent', () => {
  it('keeps the check and its findings on the phone, so it shows under the turn it checks', () => {
    const items: TimelineItem[] = [
      { id: 'u', ts: 0, type: 'user', text: 'go' },
      { id: 'x', ts: 1, type: 'tool', name: 'Check', kind: 'agent', title: 'Check', status: 'done', detail: {}, check: { turn: 'u', agent: 'codex' }, result: { text: 'One finding: the guard skips admins.' } },
    ];
    const page = phonePage(items);
    const check = page.items[1] as ToolItem;
    expect(check.check).toEqual({ turn: 'u', agent: 'codex' });
    expect(check.result?.text).toBe('One finding: the guard skips admins.');
  });
});

describe('a new folder from the phone', () => {
  it('makes one plain folder inside an existing one, and nothing else', async () => {
    const { app, port, home } = await setup();
    const { c } = await pairPhone(app, port);
    const made = (await c.call('phone.mkdir', { parent: home, name: 'Weekend app' })) as { ok: boolean; result: { path: string } };
    expect(made.ok).toBe(true);
    expect(made.result.path).toBe(path.join(home, 'Weekend app'));
    expect(statSync(made.result.path).isDirectory()).toBe(true);
    // Already there, a path instead of a name, hidden, a relative or missing parent: refused.
    for (const p of [
      { parent: home, name: 'Weekend app' },
      { parent: home, name: '../escape' },
      { parent: home, name: 'a/b' },
      { parent: home, name: '.hidden' },
      { parent: 'relative', name: 'x' },
      { parent: path.join(home, 'missing'), name: 'x' },
    ])
      expect(((await c.call('phone.mkdir', p)) as { ok: boolean }).ok).toBe(false);
    expect(existsSync(path.join(home, '..', 'escape'))).toBe(false);
    // Only for phones.
    await expect(app.call('phone.mkdir' as never, { parent: home, name: 'y' } as never)).rejects.toThrow();
    c.ws.close();
  });
});

describe("a chat's changes from the phone", () => {
  // The test's own git never refreshes the index either (that would move its time under the read-only check).
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  const numbered = (n: number, word = 'line') => Array.from({ length: n }, (_, i) => `${word} ${i + 1}`).join('\n') + '\n';

  /** A repository with every kind of change: modified, deleted, untracked, a long one, a binary one; and a file beside it. */
  function repoIn(home: string) {
    const repo = path.join(home, 'repo');
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'core.autocrlf', 'false');
    writeFileSync(path.join(repo, 'src', 'a.ts'), numbered(30));
    writeFileSync(path.join(repo, 'old.txt'), 'one\ntwo\nthree\n');
    writeFileSync(path.join(repo, 'keep.txt'), 'untouched\n');
    writeFileSync(path.join(repo, 'big.txt'), 'start\n');
    writeFileSync(path.join(repo, 'pic.bin'), Buffer.from([1, 2, 0, 3]));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    writeFileSync(path.join(repo, 'src', 'a.ts'), numbered(30).replace('line 12\n', 'line twelve\n').replace('line 20\n', ''));
    rmSync(path.join(repo, 'old.txt'));
    writeFileSync(path.join(repo, 'notes.md'), '# Notes\nfirst\n');
    writeFileSync(path.join(repo, 'big.txt'), 'start\n' + numbered(5000, 'more'));
    writeFileSync(path.join(repo, 'pic.bin'), Buffer.from([1, 2, 0, 3, 9, 9]));
    writeFileSync(path.join(home, 'outside.txt'), 'not in the repository\n');
    return repo;
  }

  it('lists the working tree of the chat’s folder and gives a listed file’s diff, capped, and nothing else', async () => {
    const { app, port, home } = await setup();
    const repo = repoIn(home);
    const { c } = await pairPhone(app, port);
    const created = (await c.call('session.create', { provider: 'demo', cwd: repo })) as { result: PhoneTail };
    const id = created.result.session.id;
    const before = git(repo, 'status', '--porcelain');
    const indexAt = statSync(path.join(repo, '.git', 'index')).mtimeMs;

    const list = (await c.call('phone.changes', { sessionId: id })) as { ok: boolean; result: PhoneChanges };
    expect(list.ok).toBe(true);
    expect(list.result.scope).toBe('tree');
    expect(list.result.branch).toBe('main');
    const by = new Map(list.result.files.map((f) => [f.path, f]));
    expect([...by.keys()].sort()).toEqual(['big.txt', 'notes.md', 'old.txt', 'pic.bin', 'src/a.ts']);
    expect(by.get('src/a.ts')).toMatchObject({ status: 'M', additions: 1, deletions: 2 });
    expect(by.get('old.txt')).toMatchObject({ status: 'D', deletions: 3 });
    expect(by.get('notes.md')).toMatchObject({ status: '?', additions: 2 });

    const diff = async (p: string) => (await c.call('phone.diff', { sessionId: id, path: p })) as { ok: boolean; result: PhoneDiff; error?: string };
    const a = await diff('src/a.ts');
    expect(a.ok).toBe(true);
    expect(a.result.numbered).toBe(true);
    expect(a.result.cut).toBeUndefined();
    expect(a.result.diff?.hunks.flatMap((h) => h.lines)).toContain('+line twelve');
    const gone = await diff('old.txt');
    expect(gone.result.diff?.status).toBe('deleted');
    expect(gone.result.diff?.hunks[0].lines).toEqual(['-one', '-two', '-three']);
    const fresh = await diff('notes.md');
    expect(fresh.result.diff?.status).toBe('added');
    const big = await diff('big.txt');
    expect(big.result.cut).toBe(true);
    expect(big.result.diff?.additions).toBe(5000);
    expect(big.result.diff!.hunks.reduce((n, h) => n + h.lines.length, 0)).toBeLessThanOrEqual(3000);
    expect(JSON.stringify(big.result).length).toBeLessThan(450_000);
    expect((await diff('pic.bin')).result.diff?.binary).toBe(true);

    // Only a file the folder's status lists: not a clean file, not a path out of the folder, not an absolute path, not another chat's.
    for (const p of ['keep.txt', '../outside.txt', path.join(home, 'outside.txt'), path.join(repo, 'src', 'a.ts'), '', 'src/../../outside.txt']) {
      const r = await diff(p);
      expect(r.ok, p).toBe(false);
    }
    expect(((await c.call('phone.changes', { sessionId: 'nope' })) as { ok: boolean }).ok).toBe(false);
    expect(((await c.call('phone.diff', { sessionId: 'nope', path: 'src/a.ts' })) as { ok: boolean }).ok).toBe(false);
    // Read-only: the index and the tree are as they were.
    expect(statSync(path.join(repo, '.git', 'index')).mtimeMs).toBe(indexAt);
    expect(git(repo, 'status', '--porcelain')).toBe(before);
    // Only for phones.
    await expect(app.call('phone.changes' as never, { sessionId: id } as never)).rejects.toThrow();
    await expect(app.call('phone.diff' as never, { sessionId: id, path: 'src/a.ts' } as never)).rejects.toThrow();
    c.ws.close();
  });

  it('outside a repository: the chat’s own edits; with steps named, only theirs (sub-agents included)', async () => {
    const { app, port, home } = await setup();
    const plain = path.join(home, 'plain');
    mkdirSync(plain);
    const { c } = await pairPhone(app, port);
    const created = (await c.call('session.create', { provider: 'demo', cwd: plain })) as { result: PhoneTail };
    const id = created.result.session.id;
    const rt = app.sessions.get(id)!;
    const edit = (eid: string, file: string, hunk: { oldStart: number; lines: string[] }, extra: Partial<ToolItem> = {}) =>
      rt.add({
        id: eid,
        type: 'tool',
        name: 'Edit',
        kind: 'edit',
        title: 'Edit',
        status: 'done',
        detail: { path: file },
        result: { diff: [{ path: file, status: 'modified', additions: hunk.lines.filter((l) => l[0] === '+').length, deletions: hunk.lines.filter((l) => l[0] === '-').length, hunks: [{ oldStart: hunk.oldStart, oldLines: 1, newStart: hunk.oldStart, newLines: 1, lines: hunk.lines }] }] },
        ...extra,
      } as never);
    edit('e1', path.join(plain, 'x.ts'), { oldStart: 3, lines: ['-a', '+b'] });
    edit('e2', path.join(plain, 'x.ts'), { oldStart: 9, lines: ['-c', '+d'] });
    edit('e3', path.join(plain, 'y.ts'), { oldStart: 1, lines: ['-e', '+f'] });
    rt.add({ id: 'ag', type: 'tool', name: 'Task', kind: 'agent', title: 'Helper', status: 'done', detail: {} } as never);
    edit('e4', path.join(plain, 'sub', 'z.ts'), { oldStart: 2, lines: ['+g'] }, { parentId: 'ag' });

    const all = (await c.call('phone.changes', { sessionId: id })) as { result: PhoneChanges };
    expect(all.result.scope).toBe('edits');
    expect(all.result.files.map((f) => [f.path, f.edits])).toEqual([
      ['x.ts', 2],
      ['y.ts', 1],
      ['sub/z.ts', 1],
    ]);
    const x = (await c.call('phone.diff', { sessionId: id, path: 'x.ts' })) as { result: PhoneDiff };
    expect(x.result.numbered).toBe(false);
    expect(x.result.diff?.hunks).toHaveLength(2);
    expect(((await c.call('phone.diff', { sessionId: id, path: 'y.ts' })) as { result: PhoneDiff }).result.numbered).toBe(true);

    const turn = (await c.call('phone.changes', { sessionId: id, items: ['e2', 'ag', 'missing', 42] })) as { result: PhoneChanges };
    expect(turn.result.scope).toBe('turn');
    expect(turn.result.files.map((f) => [f.path, f.edits])).toEqual([
      ['x.ts', 1],
      ['sub/z.ts', 1],
    ]);
    expect(turn.result).toMatchObject({ additions: 2, deletions: 1 });
    const tx = (await c.call('phone.diff', { sessionId: id, path: 'x.ts', items: ['e2', 'ag'] })) as { result: PhoneDiff };
    expect(tx.result.numbered).toBe(true);
    expect(tx.result.diff?.hunks[0].lines).toEqual(['-c', '+d']);
    expect(((await c.call('phone.diff', { sessionId: id, path: 'y.ts', items: ['e2'] })) as { ok: boolean }).ok).toBe(false);
    c.ws.close();
  });
});

describe('switching agents from the phone', () => {
  it("learns the other agent's models, switches the chat in place and back, and answers /model without sending it", async () => {
    const { app, port, home } = await setup({ codex: true });
    const { c } = await pairPhone(app, port);
    const snap = (await c.call('session.create', { provider: 'demo', cwd: home })) as { result: { session: { id: string } } };
    const id = snap.result.session.id;
    await c.call('phone.tail', { sessionId: id });
    // The other agent's models, for the setup sheet (an existing phone method).
    const caps = (await c.call('provider.caps', { provider: 'codex', cwd: home })) as { ok: boolean; result: Capabilities };
    expect(caps.ok).toBe(true);
    expect(caps.result.models.map((m) => m.id)).toEqual(['gpt-6', 'gpt-6-mini']);

    const r = (await c.call('session.switchAgent', { sessionId: id, provider: 'codex', model: 'gpt-6-mini' })) as { ok: boolean; result: { ok: boolean } };
    expect(r.ok).toBe(true);
    const rt = app.sessions.get(id)!;
    expect(rt.meta.provider).toBe('codex');
    expect(rt.meta.model).toBe('gpt-6-mini');
    // The switch line reaches the phone with its mark.
    const added = (await c.next((f) => 'event' in f && (f.event as { type: string; item?: NoticeItem }).type === 'item.added' && !!(f.event as { item?: NoticeItem }).item?.agentSwitch)) as { event: { item: NoticeItem } };
    expect(added.event.item.agentSwitch).toEqual({ from: 'demo', to: 'codex' });
    expect(added.event.item.text).toBe('Switched to Codex');

    // `/model` from the phone: the model changes, nothing is sent or shown.
    const before = rt.items.length;
    const m = (await c.call('session.send', { sessionId: id, text: '/model gpt-6' })) as { ok: boolean; result: { ok: boolean; model?: string } };
    expect(m.result).toEqual({ ok: true, model: 'gpt-6' });
    expect(rt.meta.model).toBe('gpt-6');
    const none = (await c.call('session.send', { sessionId: id, text: '/model nothing-like-it' })) as { result: { ok: boolean; error?: string } };
    expect(none.result.ok).toBe(false);
    expect(none.result.error).toMatch(/No model called/);
    expect(rt.items.length).toBe(before);

    // Switch back with nothing sent since: an undo, the line goes.
    const back = (await c.call('session.switchAgent', { sessionId: id, provider: 'demo' })) as { result: { ok: boolean; undone?: boolean } };
    expect(back.result).toMatchObject({ ok: true, undone: true });
    expect(rt.meta.provider).toBe('demo');
    expect(rt.items.some((i) => i.type === 'notice' && i.agentSwitch)).toBe(false);
    c.ws.close();
  });
});

describe('desktop addresses', () => {
  it('the welcome lists them; a phone adds new ones to its pairing, the last good one first', async () => {
    const { app, port } = await setup();
    const { c } = await pairPhone(app, port);
    const w = c.frames.find((f) => 'welcome' in f) as { welcome: { hosts?: string[] } };
    expect(Array.isArray(w.welcome.hosts)).toBe(true);
    c.ws.close();
    // Paired at home, Tailscale installed later: its 100.x address joins, nothing repeats.
    expect(mergeHosts(['192.168.1.20', '10.0.0.5'], ['192.168.1.20', '100.101.7.9'], '192.168.1.20')).toEqual(['192.168.1.20', '100.101.7.9', '10.0.0.5']);
    expect(mergeHosts(['a1', 'a2', 'a3', 'a4'], ['b1', 'b2', 'b3', 'b4'], 'a2')).toHaveLength(6);
    expect(mergeHosts(['a1'], ['bad host!', 42, 'b1'], undefined)).toEqual(['b1', 'a1']);
    expect(mergeHosts(['a1'], undefined, 'a1')).toEqual(['a1']);
  });
});

describe('qr encoder', () => {
  it('draws finder patterns and grows with the text', () => {
    const small = qrMatrix('sable://pair?h=1.2.3.4&p=47820&k=abcdefghijklmnopqrstuv');
    expect(small.length).toBeGreaterThanOrEqual(25);
    // Top-left finder: a dark 7x7 ring with a dark 3x3 centre.
    expect(small[0].slice(0, 7).every(Boolean)).toBe(true);
    expect(small[1][1]).toBe(false);
    expect(small[3][3]).toBe(true);
    const big = qrMatrix('x'.repeat(180));
    expect(big.length).toBeGreaterThan(small.length);
    expect(() => qrMatrix('x'.repeat(400))).toThrow();
  });
});

describe('remote control default', () => {
  it('is on for new Claude sessions unless chosen, and only for Claude', () => {
    expect(withDefaultOptions('claude', undefined)).toEqual({ remoteControl: true });
    expect(withDefaultOptions('claude', { browser: true })).toEqual({ browser: true, remoteControl: true });
    expect(withDefaultOptions('claude', { remoteControl: false })).toEqual({ remoteControl: false });
    expect(withDefaultOptions('codex', undefined)).toBeUndefined();
    expect(withDefaultOptions('demo', { browserTab: false })).toEqual({ browserTab: false });
  });
});
