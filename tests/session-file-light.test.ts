import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { BRIDGE_PATH, type SessionMeta, type SessionSnapshot, type TimelineItem, type ToolItem } from '../shared/protocol';
import { App } from '../server/app';
import { attachBridge } from '../server/bridge';
import { READ, OVER_MAX, SessionFiles, type SessionData } from '../server/core/session-file';
import { chatMarkdown } from '../server/core/chat-markdown';
import { Store } from '../server/core/store';
import { cutItems, isLight, LIGHT, resultForWindow } from '../server/core/trim';
import { DemoProvider } from '../server/providers/demo';
import { isUtf8 } from 'node:buffer';
import { largeRowReader } from '../server/core/session-json';
import { cutItem, PAGE_LIMIT, workerCut } from '../server/core/trim';
import { namedInTurn } from '../server/services/capture';
import { registerExport } from '../server/services/export';
import { phoneDetail, phoneItem, registerPhone } from '../server/services/phone';
import { beside, pairSecure } from './phone-wire';

const workerFault = vi.hoisted(() => ({ enabled: false, pieces: 0 }));
vi.mock('node:worker_threads', async importOriginal => {
  const threads = await importOriginal<typeof import('node:worker_threads')>();
  return { ...threads, Worker: class extends threads.Worker {
    constructor(script: string, options: import('node:worker_threads').WorkerOptions) {
      super(workerFault.enabled ? "throw new Error('reading worker stopped')" : script, options);
      this.on('message', msg => { if (Array.isArray(msg?.rows)) workerFault.pieces++; });
    }
  } };
});

const homes: string[] = [];
const original = { ...READ };
const marker = JSON.stringify(LIGHT).slice(1, -1);
afterEach(() => {
  workerFault.enabled = false;
  workerFault.pieces = 0;
  Object.assign(READ, original);
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

function fixture(padding = 0) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-indexed-'));
  homes.push(home);
  const dir = path.join(home, 'sessions');
  mkdirSync(dir);
  const file = (id: string) => path.join(dir, id + '.json');
  const meta: SessionMeta = { id: 'src', title: 'Long chat', provider: 'demo', model: 'm', status: 'idle',
    cwd: beside(home), titleSource: 'user', mode: 'default', createdAt: 1, updatedAt: 2, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
  const picture = 'data:image/png;base64,' + 'A'.repeat(8000);
  const items: TimelineItem[] = [];
  for (let n = 0; n < 6; n++) {
    const output = 'before\n'.repeat(700) + (n === 0 ? 'http://localhost:8234/preview\n' : '') + 'after ✓\n'.repeat(700);
    items.push({ type: 'user', id: 'u' + n, ts: n, text: 'Part ' + n, ...(n === 0 ? { attachments: [{ id: 'picture', name: 'fixture.png', kind: 'image' as const, dataUrl: picture }] } : {}) });
    items.push({ type: 'tool', id: 's' + n, ts: n, kind: 'bash', name: 'Bash', title: 'Run ✓', status: 'done',
      ...(n === 0 ? { input: { run_in_background: true } } : {}),
      detail: { command: 'test ' + 'arg '.repeat(150) + '\nsecond command' }, result: { images: [picture], text: output, stderr: output, exitCode: 0,
        file: { path: 'f', content: output }, files: Array.from({ length: 214 }, (_, i) => '/dir/file' + i) }, output });
    if (n === 0 && padding) items.push({ type: 'tool', id: 'padding', ts: 0, kind: 'read', name: 'Read', title: 'Output', status: 'done', detail: {}, result: { text: 'a'.repeat(padding) } });
    items.push(n === 1 ? { type: 'thinking', id: 'a1', ts: n, text: 'Consider this. '.repeat(400), streaming: false } : { type: 'text', id: 'a' + n, ts: n, text: 'Done ' + n, streaming: false });
    items.push({ type: 'turn', id: 't' + n, ts: n, durationMs: 1234 });
  }
  writeFileSync(file('src'), '{"gen":42,"items":[\n' + items.map(i => JSON.stringify(i)).join(',\n') + '\n],"todos":[]}');
  writeFileSync(path.join(home, 'state.json'), JSON.stringify({ sessions: [meta], projects: [], accounts: [] }));
  READ.inWorkerAbove = 1;
  return { home, file, meta, items, picture };
}

it('keeps negative zero and overflowing exponents in an indexed preview and its baseline', async () => {
  const { file } = fixture();
  const original = readFileSync(file('src'), 'utf8').replace('"id":"s0","ts":0', '"id":"s0","ts":-0,"metrics":{"x":1e400,"y":-1e400}');
  writeFileSync(file('src'), original);
  const files = new SessionFiles(file);
  const data = await files.loadAsync('src');
  const item = data.items.find(i => i.id === 's0')!;
  expect(isLight(item)).toBe(true);
  expect(Object.is(item.ts, -0)).toBe(true);
  expect(item).toHaveProperty('metrics', { x: Infinity, y: -Infinity });
  const whole = JSON.parse(original).items[1];
  expect(files.wholeItem('src', item)).toStrictEqual(whole);
  (item as ToolItem & { metrics: { x: number } }).metrics.x = 7;
  whole.metrics.x = 7;
  expect(files.wholeItem('src', item)).toStrictEqual(whole);
});

it('only projects an image line that fits the whole-row string reader', () => {
  const line = Buffer.from(JSON.stringify({ type: 'tool', id: 'im', ts: 1, name: 'Read', kind: 'read', title: 'Image', detail: {},
    status: 'done', result: { images: ['a'.repeat(360_000)] } }));
  const project = (it: ToolItem) => cutItem(it, workerCut.old);
  expect(largeRowReader(isUtf8, workerCut, line.length)(line, false, project)?.value).toEqual(project(JSON.parse(line.toString())));
  expect(largeRowReader(isUtf8, workerCut, line.length - 1)(line, false, project)).toBeUndefined();
});

it('validates every byte lane before projecting an ASCII image', () => {
  const row = Buffer.from(JSON.stringify({ type: 'tool', id: 'i', kind: 'read', name: 'Read', title: 'Image', status: 'done',
    detail: {}, result: { images: ['A'.repeat(32000)] } }));
  const start = row.indexOf('A'.repeat(16));
  const read = largeRowReader(isUtf8, workerCut, row.length);
  for (const byte of [0, 31, 32, 34, 92, 127, 128, 255]) {
    for (let lane = 0; lane < 16; lane++) {
      row[start + lane] = byte;
      expect(!!read(row, false, it => cutItem(it, workerCut.old)), `byte ${byte} lane ${lane}`)
        .toBe(byte === 32 || byte === 127);
      row[start + lane] = 65;
    }
  }
});

it('sends an unencodable answer as a row, serves its parts, and retries only the failed page', async () => {
  const { home, file, items } = fixture();
  const text = 'a\n界'.repeat(350000);
  items.push({ id: 'long', ts: 9, type: 'text', streaming: false, text });
  writeFileSync(file('src'), JSON.stringify({ gen: 42, items, todos: [] }));
  const server = createServer();
  const bridge = attachBridge(server, { home, providers: [ctx => new DemoProvider(ctx)], quiet: true });
  const originalLimit = PAGE_LIMIT.chars;
  PAGE_LIMIT.chars = 1 << 20;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const ws = new WebSocket('ws://127.0.0.1:' + (server.address() as AddressInfo).port + BRIDGE_PATH);
  let key = 0;
  async function call(method: string, params: object) {
    const id = ++key;
    const answer = new Promise<{ ok: boolean; result: any }>(resolve => {
      const receive = (raw: WebSocket.RawData) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id !== id) return;
        ws.off('message', receive);
        resolve(msg);
      };
      ws.on('message', receive);
    });
    ws.send(JSON.stringify({ id, method, params: { sessionId: 'src', ...params } }));
    return answer;
  }
  try {
    await once(ws, 'open');
    const end = (await call('session.snapshot', { page: 'end' })).result;
    const compact = end.items.at(-1);
    expect(compact).toMatchObject({ id: 'long', more: true, byParts: true, type: 'text' });
    expect(compact.text.length).toBeLessThan(text.length);
    let content = '', offset = 0, seq: number | undefined;
    do {
      const part = (await call('session.itemPart', { itemId: 'long', path: ['text'], offset, seq })).result;
      expect(part.kind).toBe('value');
      content += part.value;
      offset = part.next;
      if (seq === undefined) bridge.app.runtime('src').add({ type: 'text', text: 'another answer', streaming: true });
      seq = part.seq;
    } while (offset);
    expect(content === text).toBe(true);
    bridge.app.runtime('src').patch('long', { streaming: true });
    expect((await call('session.itemPart', { itemId: 'long', path: ['text'], offset: 65536, seq })).ok).toBe(false);
    const cursor = { at: 4, roots: 4, id: items[4].id };
    vi.spyOn(bridge.app, 'call').mockRejectedValueOnce(new Error('page failed'));
    expect((await call('session.snapshot', { peek: true, page: cursor })).ok).toBe(false);
    const retry = (await call('session.snapshot', { peek: true })).result;
    expect(retry.page.kind).toBe('older');
    expect(retry.items.map((i: TimelineItem) => i.id)).toEqual(items.slice(0, 4).map(i => i.id));
    // A timeout in the window need not have raised an error on this socket.
    for (let n = 0; n < 3; n++) await call('session.snapshot', { peek: true, page: cursor });
    const afterTimeout = (await call('session.snapshot', { peek: true })).result;
    expect(afterTimeout.page.kind).toBe('older');
    expect(afterTimeout.items).toEqual(retry.items);
  } finally {
    PAGE_LIMIT.chars = originalLimit;
    ws.terminate(); await bridge.dispose(); await new Promise<void>(r => server.close(() => r()));
  }
});

it('sends identical window snapshots and serves the whole step over session.item', async () => {
  const { home, items } = fixture();
  const baselineHome = mkdtempSync(path.join(tmpdir(), 'sable-whole-'));
  homes.push(baselineHome);
  mkdirSync(path.join(baselineHome, 'sessions'));
  for (const name of ['state.json', 'sessions/src.json']) copyFileSync(path.join(home, name), path.join(baselineHome, name));
  const baseline = new App({ home: baselineHome, providers: [ctx => new DemoProvider(ctx)], quiet: true });
  let expected: SessionSnapshot;
  try {
    READ.inWorkerAbove = Infinity;
    const snap = await baseline.call('session.snapshot', { sessionId: 'src' });
    expect(snap.items.some(isLight)).toBe(false);
    expected = JSON.parse(JSON.stringify(resultForWindow(snap)));
  } finally { READ.inWorkerAbove = 1; await baseline.dispose(); }
  const server = createServer();
  const bridge = attachBridge(server, { home, providers: [ctx => new DemoProvider(ctx)], quiet: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const ws = new WebSocket('ws://127.0.0.1:' + (server.address() as AddressInfo).port + BRIDGE_PATH);
  try {
    await once(ws, 'open');
    let id = 0;
    const call = <T>(method: string, params: unknown) => new Promise<T>((resolve, reject) => {
      const key = ++id;
      const handle = (raw: WebSocket.RawData) => {
        const frame = JSON.parse(raw.toString());
        if (frame.id !== key) return;
        ws.off('message', handle);
        if (raw.toString().includes(marker) || !frame.ok) reject(new Error(frame.error ?? 'Private marker on socket'));
        else resolve(frame.result);
      };
      ws.on('message', handle);
      ws.send(JSON.stringify({ id: key, method, params }));
    });
    const snap = await call<SessionSnapshot>('session.snapshot', { sessionId: 'src' });
    const rt = bridge.app.sessions.get('src')!;
    expect(isLight(rt.get('s0')!)).toBe(true);
    expect(rt.get('s5')).toEqual(items.find(i => i.id === 's5'));
    expect(snap).toEqual(expected);
    expect(snap.items).toEqual(cutItems(items));
    for (const itemId of ['s0', 'u0', 'a1']) {
      expect(isLight(rt.get(itemId)!)).toBe(true);
      expect(snap.items.find(i => i.id === itemId)).toHaveProperty('more', true);
      expect((await call<{ item: TimelineItem }>('session.item', { sessionId: 'src', itemId })).item).toEqual(items.find(i => i.id === itemId));
    }
    expect(isLight(rt.get('s0')!)).toBe(true);
    const old = rt.get<ToolItem>('s1')!;
    rt.patch<ToolItem>('s1', { result: { ...old.result, exitCode: 3 } });
    expect(rt.get('s1')).toEqual({ ...items[5], result: { ...(items[5] as ToolItem).result, exitCode: 3 } });
    rt.delta('s2', 'output', 'late');
    expect(rt.get<ToolItem>('s2')!.output).toBe((items[9] as ToolItem).output + 'late');
    rt.delta('a1', 'text', 'late');
    expect(rt.get('a1')).toEqual({ ...items[6], text: 'Consider this. '.repeat(400) + 'late' });
    // After a rewind the same step needs its recent preview and is live in the runtime again.
    rt.reset(rt.items.slice(0, 4));
    expect(rt.get('s0')).toEqual(items[1]);
    expect((await call<SessionSnapshot>('session.snapshot', { sessionId: 'src' })).items).toEqual(cutItems(items.slice(0, 4)));
  } finally {
    ws.terminate();
    await bridge.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('shares old-turn eligibility and uses the matching tail to find recent steps', async () => {
  const { file, items } = fixture();
  const tool = items[1] as ToolItem;
  const alwaysWhole: TimelineItem[] = [
    { ...tool, id: 'running', status: 'running' },
    { ...tool, id: 'background', result: { ...tool.result, agent: { background: 'running' } } },
    { ...tool, id: 'widget', kind: 'widget' },
    { ...tool, id: 'share', kind: 'share' },
    { id: 'note', type: 'notice', ts: 0, variant: 'info', text: tool.output! },
  ];
  const baseItems = [...alwaysWhole, ...items];
  writeFileSync(file('src'), '{"gen":42,"items":[\n' + baseItems.map(i => JSON.stringify(i)).join(',\n') + '\n],"todos":[]}');
  const files = new SessionFiles(file);
  READ.part = 4096;
  const loaded = await files.loadAsync('src');
  expect(workerFault.pieces).toBeGreaterThan(2);
  expect(loaded.items.slice(0, alwaysWhole.length)).toEqual(alwaysWhole);
  expect(loaded.items.filter(isLight).map(i => i.id)).toEqual(['u0', 's0', 's1', 'a1', 's2']);
  // A final tail truncates the base after the first turn. s0 is now recent.
  writeFileSync(file('src.tail'), JSON.stringify({ baseGen: 42, from: alwaysWhole.length + 4, items: [] }));
  expect((await files.loadAsync('src')).items).toEqual(baseItems.slice(0, alwaysWhole.length + 4));
});

it('rewrites identical bytes on a clean save, a late patch, a folded tail and a rewind', async () => {
  const { file, items } = fixture(4 << 20);
  copyFileSync(file('src'), file('whole'));
  const files = new SessionFiles(file);
  const light = await files.loadAsync('src');
  // Two independent writer clocks, as in separate bridge processes. Pin the time so even the
  // generation header must match byte for byte. Production generations still increase on every write.
  vi.resetModules();
  const reference = await import('../server/core/session-file');
  const untrimmed = new reference.SessionFiles(file);
  const whole = untrimmed.load('whole');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
  const step = (d: SessionData) => d.items[1] as ToolItem;
  const save = async (dirty: Set<string> | 'all') => {
    for (const [id, data] of [['src', light], ['whole', whole]] as const) {
      const writer = id === 'src' ? files : untrimmed;
      await writer.save(id, () => ({ ...data, dirty }));
      expect(writer.needsRetry(id)).toBe(false);
    }
  };
  const bytes = (id: string) => readFileSync(file(id));
  const equalBase = () => {
    expect(bytes('src').equals(bytes('whole'))).toBe(true);
    expect(bytes('src').includes(marker)).toBe(false);
  };
  expect(isLight(step(light))).toBe(true);
  await save('all');
  equalBase();
  for (const d of [light, whole]) {
    const s = step(d);
    s.status = 'error';
    s.result = { ...s.result, exitCode: 2, file: { ...s.result!.file!, path: 'moved' } };
  }
  expect(files.wholeItem('src', step(light))).toEqual(step(whole));
  await save(new Set(['s0']));
  const tail = (id: string) => JSON.parse(readFileSync(file(id + '.tail'), 'utf8'));
  expect(tail('src').over).toEqual([step(whole)]);
  expect(readFileSync(file('src.tail'), 'utf8')).not.toContain(marker);
  const cap = OVER_MAX.chars;
  try {
    reference.OVER_MAX.chars = OVER_MAX.chars = 1;
    await save(new Set(['s0']));
  } finally { reference.OVER_MAX.chars = OVER_MAX.chars = cap; }
  equalBase();
  expect(existsSync(file('src.tail'))).toBe(false);
  expect(files.wholeItem('src', step(light))).toEqual(step(whole));
  for (const d of [light, whole]) d.items.splice(4);
  await save('all');
  equalBase();
  const disk = JSON.parse(bytes('src').toString());
  expect(disk.items[1]).toEqual(step(whole));
  expect(disk.items[2]).toEqual(items[2]);
});

it('sends the original attachment when the bridge retries an indexed message', async () => {
  const { home, items } = fixture();
  const app = new App({ home, providers: [ctx => new DemoProvider(ctx)], quiet: true });
  try {
    await app.call('session.snapshot', { sessionId: 'src' });
    const rt = app.runtime('src');
    const item = rt.get('u0')!;
    if (item.type !== 'user' || !isLight(item)) throw new Error('Expected indexed message');
    const handle = rt.handle = await app.provider('demo').open(rt, { loadTranscript: false });
    const send = vi.spyOn(handle, 'send').mockResolvedValue();
    await app['sendWithHandover'](rt, handle, item);
    expect(send.mock.calls[0][0]).toEqual(items[0]);
    expect(rt.get('u0')).toEqual(items[0]);
    expect(rt.returnUntaken({ ids: new Set(['u0']) })).toBe(1);
    expect(rt.queue[0].attachments).toEqual((items[0] as typeof item).attachments);
    await app.store.flush();
    expect(new Store(home).loadSession('src').queue?.[0].attachments).toEqual(rt.queue[0].attachments);
  } finally { await app.dispose(); }
});

it('preserves hidden image data and edit hunks when a late patch reorders and updates their rows', async () => {
  const { home, file, items, picture } = fixture();
  const user = items[0];
  if (user.type !== 'user') throw new Error('Missing message');
  user.attachments = ['one', 'two'].map(id => ({ id, name: id, kind: 'image', dataUrl: picture + id }));
  const edit = items[1] as ToolItem;
  const diff = ['a', 'a', 'b'].map((path, i) => ({ path, status: 'modified' as const, additions: 1, deletions: 0,
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+' + path + i] }] }));
  edit.kind = 'edit';
  edit.result = { diff };
  writeFileSync(file('src'), '{"gen":42,"items":[\n' + items.map(i => JSON.stringify(i)).join(',\n') + '\n],"todos":[]}');
  const app = new App({ home, providers: [ctx => new DemoProvider(ctx)], quiet: true });
  try {
    await app.call('session.snapshot', { sessionId: 'src' });
    const rt = app.sessions.get('src')!;
    const message = rt.get<typeof user>('u0')!;
    const step = rt.get<ToolItem>('s0')!;
    expect(isLight(message) && isLight(step)).toBe(true);
    rt.patch<typeof user>('u0', { attachments: message.attachments!.slice().reverse().map(a => ({ ...a, name: a.name + '.png' })) });
    const order = [2, 0, 1];
    rt.patch<ToolItem>('s0', { result: { diff: order.map(i => ({ ...step.result!.diff![i], additions: 2 })) } });
    expect(rt.get<typeof user>('u0')!.attachments).toEqual(user.attachments.slice().reverse().map(a => ({ ...a, name: a.name + '.png' })));
    expect(rt.get<ToolItem>('s0')!.result?.diff).toEqual(order.map(i => ({ ...diff[i], additions: 2 })));
  } finally { await app.dispose(); }
});

it('keeps markdown, exported bytes, phone pictures, phone detail and capture URLs identical', async () => {
  const { home, items, picture } = fixture();
  const app = new App({ home, providers: [ctx => new DemoProvider(ctx)], quiet: true });
  const target = path.join(home, 'chat.md');
  registerExport(app, { showSave: async () => target });
  registerPhone(app, { host: '127.0.0.1', port: 0 });
  try {
    const snap = await app.call('session.snapshot', { sessionId: 'src' });
    expect(snap.items.map(i => phoneItem(i))).toEqual(items.map(i => phoneItem(i)));
    const markdown = chatMarkdown(snap.session, items);
    const fetch = vi.spyOn(app.store, 'wholeItem');
    expect((await app.call('session.markdown', { sessionId: 'src' })).markdown).toBe(markdown);
    await app.call('session.export', { sessionId: 'src' });
    expect(readFileSync(target, 'utf8')).toBe(markdown);
    expect(fetch.mock.calls.map(([, item]) => item.id)).toEqual(['u0', 's0', 's1', 'a1', 's2', 'u0', 's0', 's1', 'a1', 's2']);
    const turn = snap.items.slice(0, 4);
    expect(namedInTurn(turn, 'u0', i => app.store.wholeItem('src', i))).toEqual(['http://localhost:8234/preview']);
    const status = await app.call('phone.setEnabled', { on: true });
    const { c } = await pairSecure(app, status.port);
    try {
      const page = await c.call('phone.tail', { sessionId: 'src' });
      expect(page.result).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: 's0', pics: 1 })]) });
      const full = await c.call('phone.item', { sessionId: 'src', itemId: 's0' });
      expect(full.result).toEqual(phoneDetail(items, 's0'));
      for (const itemId of ['u0', 'a1']) expect((await c.call('phone.item', { sessionId: 'src', itemId })).result).toEqual(phoneDetail(items, itemId));
      expect(await c.call('phone.image', { sessionId: 'src', itemId: 's0', index: 0 })).toMatchObject({ result: { data: picture } });
      expect(JSON.stringify(c.frames)).not.toContain(marker);
    } finally { c.ws.close(); }
  } finally { await app.dispose(); }
});

it('forks a whole independent base before the source is deleted', async () => {
  const { home, file, items } = fixture();
  const app = new App({ home, providers: [ctx => new DemoProvider(ctx)], quiet: true });
  try {
    const fork = await app.call('session.fork', { sessionId: 'src', itemId: 'a4' });
    await app.call('session.close', { sessionId: 'src', remove: true });
    expect(existsSync(file('src'))).toBe(false);
    const id = fork.session.id;
    expect(JSON.parse(readFileSync(file(id), 'utf8')).items).toEqual(items.slice(0, 20));
    expect((await app.call('session.item', { sessionId: id, itemId: 's0' })).item).toEqual(items[1]);
    await app.store.flush();
    expect(readFileSync(file(id), 'utf8')).not.toContain(marker);
  } finally { await app.dispose(); }
});

it('reads old edit hunks for a phone diff and the turn check brief', async () => {
  const { home, file, items } = fixture();
  const edit: ToolItem = { type: 'tool', kind: 'edit', id: 'edit', ts: 1, name: 'Edit', title: 'Edit a.ts', status: 'done',
    detail: { path: 'a.ts' }, result: { diff: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 1,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-previous', '+new line for review'] }] }] } };
  items.splice(2, 0, edit);
  writeFileSync(file('src'), '{"gen":42,"items":[\n' + items.map(i => JSON.stringify(i)).join(',\n') + '\n],"todos":[]}');
  const app = new App({ home, providers: [ctx => new DemoProvider(ctx, { speed: 0 })], quiet: true });
  registerPhone(app, { host: '127.0.0.1', port: 0 });
  try {
    const status = await app.call('phone.setEnabled', { on: true });
    const { c } = await pairSecure(app, status.port);
    try {
      const data = { sessionId: 'src', path: 'a.ts', items: [edit.id] };
      expect((await c.call('phone.diff', data)).result).toMatchObject({ diff: { hunks: edit.result!.diff![0].hunks } });
    } finally { c.ws.close(); }
    const rt = app.runtime('src');
    expect(isLight(rt.get(edit.id)!)).toBe(true);
    const read = vi.spyOn(app.store, 'wholeItem');
    expect((await app.call('turn.check', { sessionId: 'src', turnId: 'missing' })).ok).toBe(false);
    expect(read).not.toHaveBeenCalled();
    const check = await app.call('turn.check', { sessionId: 'src', turnId: 'u0' });
    expect(rt.get<ToolItem>(check.itemId!)?.detail.prompt).toContain('+new line for review');
    expect(isLight(rt.get(edit.id)!)).toBe(true);
  } finally { await app.dispose(); }
});

it('pins the source bytes through a concurrent fork and source deletion', async () => {
  const { home, file, items } = fixture(4 << 20);
  const store = new Store(home);
  const data = await store.loadSessionAsync('src');
  const copying = store.copySession('src', 'fork', data.items);
  store.deleteSession('src');
  const fork = await copying;
  expect(store.wholeItem('fork', fork.items[1])).toEqual(items[1]);
  expect(JSON.parse(readFileSync(file('fork'), 'utf8')).items).toEqual(items);
  await vi.waitFor(() => expect(existsSync(file('src'))).toBe(false));
});

it('opens the committed generation after an interrupted rename and rejects mismatched offsets', async () => {
  const { file, items } = fixture();
  const files = new SessionFiles(file);
  const loaded = await files.loadAsync('src');
  const old = readFileSync(file('src'));
  // A complete replacement waiting for its rename is invisible, including its different offsets.
  writeFileSync(file('src') + '.' + process.pid + '.tmp', old.toString().replace('42,', '12345,'));
  const reader = new SessionFiles(file);
  const afterCrash = await reader.loadAsync('src');
  expect(reader.wholeItem('src', afterCrash.items[1])).toEqual(items[1]);
  writeFileSync(file('src'), old.toString().replace('42,', '12345,'));
  expect(() => files.wholeItem('src', loaded.items[1])).toThrow(/generation/);
  await files.save('src', () => ({ ...loaded, dirty: 'all' }));
  expect(readFileSync(file('src'), 'utf8')).toBe(old.toString().replace('42,', '12345,'));
});

it('confirms only the committed restart notice in the tail or the rewritten base', async () => {
  const { home, file } = fixture(4 << 20);
  const store = new Store(home);
  const data = await store.loadSessionAsync('src');
  const sync = vi.spyOn(SessionFiles.prototype, 'load');
  const asyncRead = vi.spyOn(SessionFiles.prototype, 'loadAsync');
  for (const dirty of [new Set(['notice']), 'all'] as const) {
    if (dirty !== 'all') data.items.push({ id: 'notice', type: 'notice', ts: 0, text: 'Stopped', variant: 'info', early: 'restart' });
    store.saveSession('src', () => ({ ...data, dirty }));
    expect(await store.savedRestartNotice('src', 'notice')).toBe(true);
    expect(await store.savedRestartNotice('src', 'absent')).toBe(false);
    const target = file(dirty === 'all' ? 'src' : 'src.tail');
    const saved = readFileSync(target, 'utf8');
    writeFileSync(target, saved.replace('"early":"restart"', '"early":"changed"'));
    expect(await store.savedRestartNotice('src', 'notice')).toBe(false);
    writeFileSync(target, saved);
  }
  expect(sync).not.toHaveBeenCalled();
  expect(asyncRead).not.toHaveBeenCalled();
  await store.flush();
});

it('copies unchanged JSON line bytes without serializing the step again', async () => {
  const { file } = fixture();
  const text = readFileSync(file('src'), 'utf8');
  const line = text.split('\n')[2].replace('"id":"s0"', '"id":  "s0"');
  writeFileSync(file('src'), text.replace(text.split('\n')[2], line));
  const files = new SessionFiles(file);
  const data = await files.loadAsync('src');
  expect(isLight(data.items[1])).toBe(true);
  await files.save('src', () => ({ ...data, dirty: 'all' }));
  expect(files.needsRetry('src')).toBe(false);
  expect(JSON.parse(readFileSync(file('src'), 'utf8')).gen).toBeGreaterThan(42);
  expect(readFileSync(file('src'), 'utf8').split('\n')[2] === line).toBe(true);
});

it('preserves a valid base when the reading worker itself dies', async () => {
  const { file } = fixture();
  const before = readFileSync(file('src'));
  const files = new SessionFiles(file);
  const sync = vi.spyOn(files, 'load');
  workerFault.enabled = true;
  expect(await files.loadAsync('src')).toMatchObject({ unreadable: true });
  expect(sync).not.toHaveBeenCalled();
  await files.save('src', () => ({ items: [], todos: [], dirty: 'all' }));
  expect(readFileSync(file('src')).equals(before)).toBe(true);
  workerFault.enabled = false;
  expect((await files.loadAsync('src')).items).not.toHaveLength(0);
});

it('leaves malformed worker input unreadable without a synchronous retry', async () => {
  const { file } = fixture();
  writeFileSync(file('src'), '{"gen":42,"items":[\n{"id":"bad"},\n');
  const files = new SessionFiles(file);
  const sync = vi.spyOn(files, 'load');
  expect(await files.loadAsync('src')).toMatchObject({ unreadable: true });
  await files.save('src', () => ({ items: [], todos: [], dirty: 'all' }));
  expect(readFileSync(file('src'), 'utf8')).toBe('{"gen":42,"items":[\n{"id":"bad"},\n');
  expect(sync).not.toHaveBeenCalled();
});

it.each([false, true])('keeps settled pictures in the last turn indexed, including after the turn ages (compact %s)', async compact => {
  const { home, file, items } = fixture();
  const last = items.find(i => i.id === 's5') as ToolItem;
  last.result!.images = ['X'.repeat(64000)];
  if (compact) writeFileSync(file('src'), JSON.stringify({ items, todos: [] }));
  else writeFileSync(file('src'), '{"gen":42,"items":[\n' + items.map(i => JSON.stringify(i)).join(',\n') + '\n],"todos":[]}');
  const app = new App({ home, providers: [ctx => new DemoProvider(ctx)], quiet: true });
  try {
    await app.call('session.snapshot', { sessionId: 'src' });
    const rt = app.runtime('src');
    expect(isLight(rt.get(last.id)!)).toBe(true);
    expect(rt.get<ToolItem>(last.id)!.result?.images).toBeUndefined();
    for (let n = 0; n < 3; n++) rt.add({ type: 'turn', durationMs: 1 });
    expect(rt.get<ToolItem>(last.id)!.detail.command?.length).toBeLessThanOrEqual(400);
    expect(app.store.wholeItem(rt.id, rt.get(last.id)!)).toEqual(last);
  } finally { await app.dispose(); }
});

it('loads a cold queue.take through the asynchronous reader', async () => {
  const { home, file } = fixture();
  writeFileSync(file('src.tail'), JSON.stringify({ baseGen: 42, items: [], queue: [{ id: 'q', text: 'keep', createdAt: 1 }] }));
  const app = new App({ home, providers: [ctx => new DemoProvider(ctx)], quiet: true });
  const sync = vi.spyOn(app.store, 'loadSession');
  try {
    expect(await app.call('queue.take', { sessionId: 'src', id: 'q' })).toMatchObject({ message: { text: 'keep' } });
    expect(sync).not.toHaveBeenCalled();
  } finally { await app.dispose(); }
});

it('streams an existing oversized tail beside a small base in a worker', async () => {
  const { file } = fixture();
  READ.inWorkerAbove = 512 * 1024;
  READ.tailStream = 1024;
  const files = new SessionFiles(file);
  const sync = vi.spyOn(files, 'load');
  const suffix = { type: 'text', id: 'suffix', ts: 100, text: 'end'.repeat(200000) };
  writeFileSync(file('src'), '{"gen":42,"items":[\n],"todos":[]}');
  writeFileSync(file('src.tail'), JSON.stringify({ baseGen: 42, from: 0, items: [suffix] }));
  expect((await files.loadAsync('src')).items).toEqual([suffix]);
  expect(sync).not.toHaveBeenCalled();
});

it('releases a settled live picture once its own base commits', async () => {
  const { home, items } = fixture();
  READ.inWorkerAbove = Infinity;
  const app = new App({ home, providers: [ctx => new DemoProvider(ctx)], quiet: true });
  try {
    await app.call('session.snapshot', { sessionId: 'src' });
    const rt = app.runtime('src');
    const step = rt.add<ToolItem>({ ...items[1] as ToolItem, id: 'new-picture', result: { images: ['B'.repeat(64000)] } });
    rt.add({ type: 'turn', durationMs: 1 });
    READ.inWorkerAbove = 1;
    await app.store.flush();
    expect(isLight(step)).toBe(true);
    expect(step.result?.images).toBeUndefined();
    expect((app.store.wholeItem(rt.id, step) as ToolItem).result?.images).toEqual(['B'.repeat(64000)]);
  } finally { await app.dispose(); }
});
