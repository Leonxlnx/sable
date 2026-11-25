import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import * as disk from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../server/app';
import { READ, SessionFiles } from '../server/core/session-file';
import { Store } from '../server/core/store';
import { isLight, snapshotEnd } from '../server/core/trim';
import { DemoProvider } from '../server/providers/demo';
import type { TimelineItem } from '../shared/protocol';

vi.mock('node:fs', async original => {
  const real = await original<typeof import('node:fs')>();
  return { ...real, openSync: vi.fn(real.openSync), renameSync: vi.fn(real.renameSync) };
});
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof disk>();
  return { ...real, statfs: vi.fn(real.statfs), rename: vi.fn(real.rename) };
});

const dirs: string[] = [];
const workerAbove = READ.inWorkerAbove;
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  READ.inWorkerAbove = workerAbove;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-migrate-'));
  dirs.push(home);
  mkdirSync(path.join(home, 'sessions'));
  const file = (id: string) => path.join(home, 'sessions', id + '.json');
  const rows: TimelineItem[] = [];
  for (let i = 0; i < 800; i++) rows.push(
    { id: 'u' + i, type: 'user', text: 'Next ' + i, ts: i },
    { id: 's' + i, type: 'tool', ts: i, kind: 'bash', name: 'Bash', title: 'Check', detail: {}, status: 'done', result: { images: ['test-' + i] } },
    { id: 'c' + i, parentId: 's' + i, type: 'text', streaming: false, text: 'child', ts: i },
    { id: 'e' + i, type: 'turn', durationMs: 2, ts: i });
  const old = '{"gen":42,"items":[\n' + rows.map(r => JSON.stringify(r)).join(',\n') + '\n],"todos":[]}';
  writeFileSync(file('a'), old);
  return { home, rows, old, file, files: new SessionFiles(file) };
}
const clock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
function restoredApp(home: string) {
  const session = { id: 'a', title: 'Synthetic', provider: 'demo', model: 'm', status: 'idle', cwd: home, titleSource: 'user',
    mode: 'default', createdAt: 1, updatedAt: 2, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
  writeFileSync(path.join(home, 'state.json'), JSON.stringify({ sessions: [session] }));
  return new App({ home, providers: [ctx => new DemoProvider(ctx)], quiet: true });
}
async function advance(store: Store, ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await store.flush();
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

function migrationTemps(file: string) {
  return readdirSync(path.dirname(file)).filter(n => n.startsWith(path.basename(file) + '.migrate.') && n.endsWith('.tmp'))
    .map(n => path.join(path.dirname(file), n));
}

function crashMigration(home: string, phase: 'copy' | 'renamed') {
  const child = spawnSync(process.execPath, ['tests/fixtures/migration-crash.mjs', home, phase],
    { stdio: 'inherit', timeout: 25_000, windowsHide: true });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(91);
}

it('cleans the abandoned migration temp after a hard exit during copy', async () => {
  const { home, file, old, rows } = fixture();
  const tail = JSON.stringify({ baseGen: 42, from: rows.length, items: [{ id: 'after', type: 'text', ts: 5, text: 'Only in tail' }] });
  writeFileSync(file('a.tail'), tail);
  crashMigration(home, 'copy');
  const staged = migrationTemps(file('a'));
  expect(staged).toHaveLength(1);
  expect(statSync(staged[0]).size).toBeGreaterThan(0);
  expect(() => JSON.parse(readFileSync(staged[0], 'utf8'))).toThrow();
  const unrelated = file('a') + '.123.tmp';
  writeFileSync(unrelated, 'other writer');
  const store = new Store(home);
  expect(migrationTemps(file('a'))).toEqual([]);
  expect(readFileSync(unrelated, 'utf8')).toBe('other writer');
  expect(readFileSync(file('a'), 'utf8')).toBe(old);
  expect(readFileSync(file('a.tail'), 'utf8')).toBe(tail);
  expect(store.loadSession('a').items.at(-1)?.id).toBe('after');
  await store.seal();
}, 30_000);

it('recovers the folded tail after a hard exit between rename and unlink', async () => {
  const { home, file, files, rows } = fixture();
  const tail = JSON.stringify({ baseGen: 42, from: rows.length, items: [{ id: 'after', type: 'text', ts: 5, text: 'From the tail' }] });
  writeFileSync(file('a.tail'), tail);
  crashMigration(home, 'renamed');
  const committed = readFileSync(file('a'), 'utf8');
  clock();
  const verify = vi.spyOn(SessionFiles.prototype, 'verifyMigrations');
  const finishPass = async () => {
    const before = verify.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(verify).toHaveBeenCalledTimes(before + 1);
    await verify.mock.results[before].value;
  };
  expect(JSON.parse(committed).itemCount).toBe(rows.length + 1);
  expect(readFileSync(file('a.tail'), 'utf8')).toBe(tail);
  expect(files.readEnd('a')).toBeUndefined();
  // Any one of these differences removes the authority to unlink.
  const extended = JSON.parse(tail);
  extended.items.push({ id: 'tail-only', type: 'text', ts: 6, text: 'Later' });
  const wrongCount = committed.slice(0, -66).replace(`"itemCount":${rows.length + 1}`, `"itemCount":${rows.length + 2}`);
  for (const [base, suffix] of [[committed.replace('From the tail', 'Lost the data'), tail],
    [wrongCount + createHash('sha256').update(wrongCount).digest('hex') + '"}', tail],
    [committed.replace('"itemCount":', '"otherCount":'), tail], [committed.slice(0, -16), tail],
    [committed, JSON.stringify(extended)], [committed, tail.replace('From the tail', 'Newer version')],
    [committed, tail.replace('42', String(JSON.parse(committed).gen))]]) {
    writeFileSync(file('a'), base);
    writeFileSync(file('a.tail'), suffix);
    const uncertain = new Store(home);
    await finishPass();
    expect(readFileSync(file('a.tail'), 'utf8')).toBe(suffix);
    await uncertain.seal();
  }
  // A second Store cannot reclaim a file while the first still owns the profile.
  const first = new Store(home);
  writeFileSync(file('a'), committed);
  writeFileSync(file('a.tail'), tail);
  const second = new Store(home);
  await finishPass(); // The first verifier must re-enter admission after its scan.
  expect(readFileSync(file('a.tail'), 'utf8')).toBe(tail);
  await second.seal();
  await first.seal();
  const store = new Store(home);
  expect(readFileSync(file('a.tail'), 'utf8')).toBe(tail);
  await finishPass();
  expect(existsSync(file('a.tail'))).toBe(false);
  expect(store.readSessionEnd('a')?.items.at(-1)?.id).toBe('after');
  expect(store.loadSession('a').items).toStrictEqual([...rows, JSON.parse(tail).items[0]]);
  await store.seal();
}, 30_000);

async function foldedFixture() {
  const f = fixture();
  const tail = JSON.stringify({ baseGen: 42, from: f.rows.length, items: [{ id: 'folded', type: 'text', ts: 5, text: 'Folded row' }] });
  writeFileSync(f.file('a.tail'), tail);
  await f.files.loadAsync('a');
  await f.files.migrate('a', () => true);
  expect(existsSync(f.file('a.tail'))).toBe(false);
  writeFileSync(f.file('a.tail'), tail);
  return { ...f, tail };
}

it('repairs phone receipts after a desktop read, take and restart through a locked index', async () => {
  const { home, file, rows } = fixture();
  const phoneSender = { deviceId: 'paired', generation: 1 };
  const q = { id: 'p', submitId: 'p', text: 'phone words', phoneSender, createdAt: 1 };
  writeFileSync(file('a'), JSON.stringify({ gen: 42, items: rows, todos: [], queue: [q] }));
  const db = new DatabaseSync(path.join(home, 'phone-submissions.sqlite'));
  db.exec('BEGIN EXCLUSIVE');
  const app = restoredApp(home);
  try {
    expect((await app.call('session.snapshot', { sessionId: 'a' })).items).toEqual(rows);
    await expect(app.call('session.submission', { sessionId: 'a', submitId: 'p' }, { phoneSender })).rejects.toThrow();
    await app.call('queue.take', { sessionId: 'a', id: 'p' });
    const disk = app.store.loadSession('a');
    expect(disk.items).toEqual(rows);
    expect(disk.queue).toEqual([]);
    expect(disk.receiptRepair).toEqual(['p']);
  } finally { await app.dispose(); db.close(); }
  const restart = restoredApp(home);
  try {
    expect(await restart.call('session.submission', { sessionId: 'a', submitId: 'p' }, { phoneSender })).toMatchObject({ ok: true });
    expect(restart.runtime('a').items).toEqual(rows);
  } finally { await restart.dispose(); }
});

it.each(['read', 'install', 'normalize'])('retries a failed %s without publishing its partial runtime', async phase => {
  const { home, file, old, rows } = fixture();
  const app = restoredApp(home), rt = app.runtime('a');
  const read = vi.spyOn(app.store, 'loadSessionAsync');
  rt.meta.unread = true;
  if (phase === 'read') read.mockRejectedValueOnce(Error('transient read failure'));
  else if (phase === 'install') vi.spyOn(rt, 'loadRestored').mockImplementationOnce(() => { throw Error('failed restore'); });
  else vi.spyOn(app.store, 'bindProviderInputs').mockImplementationOnce(() => {
    rt.notice('info', 'partial edit'); throw Error('failed binding');
  });
  try {
    const first = await app.call('session.snapshot', { sessionId: 'a' });
    expect(first.items).toMatchObject([{ text: 'This chat could not be read from disk' }]);
    expect(rt.meta.unread).toBe(true);
    rt.notice('info', 'edit before successful restore');
    await app.store.flush();
    expect(readFileSync(file('a'), 'utf8')).toBe(old);
    expect(existsSync(file('a.tail'))).toBe(false);
    const preview = vi.spyOn(app.store, 'readSessionEnd');
    await app.call('session.snapshot', { sessionId: 'a', page: 'end' });
    expect(preview).not.toHaveBeenCalled();
    expect((await app.call('session.snapshot', { sessionId: 'a' })).items).toEqual(rows);
    expect(read).toHaveBeenCalledTimes(2);
  } finally { await app.dispose(); }
});

it('keeps the disk history through a failed phone lookup and the next desktop send', async () => {
  const { home, file, rows } = fixture();
  const phoneSender = { deviceId: 'paired', generation: 1 };
  writeFileSync(file('a'), JSON.stringify({ gen: 42, items: rows, todos: [], queue: [
    { id: 'q', submitId: 'q', text: 'from phone', phoneSender, byHand: true, createdAt: 1 }] }));
  const app = restoredApp(home);
  const db = new DatabaseSync(path.join(home, 'phone-submissions.sqlite'));
  db.exec('BEGIN EXCLUSIVE');
  try {
    await expect(app.call('session.submission', { sessionId: 'a', submitId: 'q' }, { phoneSender })).rejects.toThrow();
    expect(await app.call('session.send', { sessionId: 'a', text: 'desktop after restart' })).toMatchObject({ ok: true });
    await app.store.persistInput('a');
    const saved = app.store.loadSession('a');
    expect(saved.items.slice(0, rows.length)).toEqual(rows);
    expect(saved.items.some(row => row.type === 'user' && row.text === 'desktop after restart') ||
      saved.queue?.some(row => row.text === 'desktop after restart')).toBe(true);
  } finally { await app.dispose(); db.close(); }
});

it('keeps the published base intact if a newer staged document has a damaged middle', async () => {
  const { home, file, old } = fixture();
  const tmp = file('a') + '.2147483646.tmp';
  writeFileSync(tmp, '{"gen":43,"items":[\n{"id":broken}\n],"todos":[]}');
  utimesSync(tmp, new Date(), new Date(Date.now() + 10_000));
  const store = new Store(home);
  try {
    expect(store.loadSession('a').unreadable).toBe(true);
    expect(readFileSync(file('a'), 'utf8')).toBe(old);
    expect(existsSync(tmp)).toBe(true);
  } finally { await store.seal(); }
});

it('refuses a partial runtime even if its lazy flag was cleared after the disk read', async () => {
  const { home, file, old, rows } = fixture();
  const app = restoredApp(home), rt = app.runtime('a');
  try {
    expect(app.store.loadSession('a').items).toEqual(rows);
    (app as unknown as { lazy: Set<string> }).lazy.delete('a');
    rt.notice('info', 'only row in the partial runtime');
    await expect(rt.persistInput!()).rejects.toThrow('could not be read');
    await app.store.flush();
    expect(readFileSync(file('a'), 'utf8')).toBe(old);
    expect(existsSync(file('a.tail'))).toBe(false);
    expect((await app.call('session.snapshot', { sessionId: 'a' })).items).toEqual(rows);
  } finally { await app.dispose(); }
});

it('never retries a refused partial snapshot at quit after a later successful read', async () => {
  const { file, home, old, rows } = fixture();
  const store = new Store(home);
  try {
    store.saveSession('a', () => ({ items: [], todos: [], dirty: 'all' }));
    const writing = store.persistInput('a');
    expect(store.loadSession('a').items).toEqual(rows);
    await expect(writing).rejects.toThrow('Could not save');
    await expect(store.seal()).rejects.toThrow('Could not save');
    expect(readFileSync(file('a'), 'utf8')).toBe(old);
    expect(existsSync(file('a.tail'))).toBe(false);
  } finally { await store.seal().catch(() => {}); }
});

it('refuses a cold replacement and permits a hydrated rewind and clear', async () => {
  const { file, files, old, rows } = fixture();
  const save = (items: TimelineItem[]) => files.save('a', () => ({ items, todos: [], dirty: 'all' }), true);
  for (const cut of [[], rows.slice(0, 1)]) {
    await expect(save(cut)).rejects.toThrow(/before reading/);
    expect(readFileSync(file('a'), 'utf8')).toBe(old);
  }
  expect(files.load('a').items).toEqual(rows);
  await save(rows.slice(0, 1));
  expect(files.load('a').items).toEqual(rows.slice(0, 1));
  await save([]);
  expect(files.load('a').items).toEqual([]);
});

it.each(['base', 'tail'])('adopts a complete ordinary %s temp left at the rename and discards obsolete or partial stages', async kind => {
  const { file, home, rows } = fixture();
  const crash = () => {
    const child = spawnSync(process.execPath, ['tests/fixtures/migration-crash.mjs', home, 'staged-' + kind],
      { stdio: 'inherit', windowsHide: true, timeout: 15_000 });
    expect(child.status).toBe(91);
  };
  const temps = () => readdirSync(path.dirname(file('a'))).filter(n => n.endsWith('.tmp'));
  crash();
  expect(temps()).toHaveLength(1);
  const first = new Store(home);
  try {
    expect(first.loadSession('a').items.map(r => r.id)).toEqual([...rows.map(r => r.id), 'peer-save']);
    await vi.waitFor(() => expect(temps()).toEqual([]));
  } finally { await first.seal(); }
  crash();
  const [stage] = temps();
  writeFileSync(file('a'), JSON.stringify({ gen: Date.now() + 99, items: [rows[0]], todos: [] }));
  const partial = file('a') + '.2147483646.tmp';
  writeFileSync(partial, '{"gen":3,"items":[\n{"id":"cut"}');
  // Even a misleadingly late timestamp cannot authorize an obsolete staged snapshot.
  utimesSync(path.join(path.dirname(file('a')), stage), new Date(), new Date(Date.now() + 60_000));
  const next = new Store(home);
  try {
    expect(next.loadSession('a').items).toEqual([rows[0]]);
    expect(temps()).toEqual([]);
  } finally { await next.seal(); }
}, 30_000);

it.each(['base', 'tail'])('preserves both edits when a legacy %s temp ties the public timestamp', async kind => {
  const { home, file, rows } = fixture();
  const publicTail = file('a.tail'), temp = (kind === 'base' ? file('a') : publicTail) + '.2147483646.tmp';
  const staged = { ...rows[0], id: 'staged' }, published = { ...rows[0], id: 'published' };
  writeFileSync(file('a'), '{"gen":42,"items":[' + JSON.stringify(rows[0]) + '],"todos":[]}');
  writeFileSync(publicTail, JSON.stringify({ baseGen: 42, from: 1, items: [published] }));
  writeFileSync(temp, (kind === 'base' ? '{"gen":43,"items":[\n' + JSON.stringify(rows[0]) + ',\n' :
    '{"baseGen":42,"from":1,"items":[\n') + JSON.stringify(staged) + '\n],"todos":[]}');
  const stamp = new Date(1_700_000_000_000);
  for (const f of [file('a'), publicTail, temp]) utimesSync(f, stamp, stamp);
  const store = new Store(home);
  try {
    const data = store.loadSession('a');
    expect(new Set(data.items.map(row => row.id))).toEqual(new Set([rows[0].id, 'published', 'staged']));
    expect(existsSync(temp)).toBe(false);
    store.saveSession('a', () => ({ ...data, dirty: 'all' }));
    await store.persistInput('a');
    expect(new SessionFiles(file).load('a').items).toEqual(data.items);
  } finally { await store.seal(); }
});

it('collects an ordinary full save’s superseded tail on the next solo start', async () => {
  const { home, file, rows } = fixture();
  writeFileSync(file('a.tail'), JSON.stringify({ baseGen: 42, from: rows.length, items: [{ ...rows[0], id: 'fold-me' }] }));
  const writer = new Store(home), peer = new Store(home);
  const data = writer.loadSession('a');
  writer.saveSession('a', () => ({ ...data, dirty: 'all' }));
  await writer.persistInput('a');
  expect(existsSync(file('a.tail'))).toBe(true);
  const reopened = peer.loadSession('a');
  peer.saveSession('a', () => ({ ...reopened, dirty: 'all' }));
  await peer.persistInput('a');
  expect(existsSync(file('a.tail'))).toBe(true);
  await peer.seal();
  await writer.seal();
  clock();
  const verify = vi.spyOn(SessionFiles.prototype, 'verifyMigrations');
  const next = new Store(home);
  try {
    await vi.advanceTimersByTimeAsync(1000);
    await verify.mock.results[0].value;
    expect(existsSync(file('a.tail'))).toBe(false);
    expect(next.readSessionEnd('a')?.items.at(-1)?.id).toBe('fold-me');
  } finally { await next.seal(); }
});

it('does not certify or delete a peer tail the full writer never read', async () => {
  const { files, file, rows } = fixture();
  const data = files.load('a');
  const peer = JSON.stringify({ baseGen: 42, from: rows.length, items: [{ ...rows[0], id: 'unseen-peer-edit' }] });
  writeFileSync(file('a.tail'), peer);
  await files.save('a', () => ({ ...data, dirty: 'all' }));
  expect(JSON.parse(readFileSync(file('a'), 'utf8')).supersededTail).toBeUndefined();
  expect(readFileSync(file('a.tail'), 'utf8')).toBe(peer);
});

it('reads the displaced peer edit after a hard exit inside the verifier rename', async () => {
  const { home, file } = await foldedFixture();
  const child = spawnSync(process.execPath, ['tests/fixtures/migration-crash.mjs', home, 'displaced'],
    { timeout: 25_000, windowsHide: true, stdio: 'inherit' });
  expect(child.status).toBe(91);
  expect(existsSync(file('a.tail'))).toBe(false);
  expect(readdirSync(path.dirname(file('a'))).filter(n => n.includes('.recover.'))).toHaveLength(1);
  const lock = new DatabaseSync(path.join(home, '.sable-store.lock'));
  lock.exec('BEGIN EXCLUSIVE');
  const reader = new Store(home);
  try {
    expect(reader.readSessionEnd('a')).toBeUndefined();
    const data = await reader.loadSessionAsync('a');
    expect(data.items.slice(-2).map(i => i.id)).toEqual(['folded', 'peer-save']);
    expect(JSON.parse(readFileSync(file('a.tail'), 'utf8')).items.at(-1).id).toBe('peer-save');
  } finally { await reader.seal(); lock.close(); }
}, 30_000);

it.each(['base', 'tail'])('uses a complete staged %s while a peer prevents its cleanup', async kind => {
  const { home, file, rows } = fixture();
  const bridge = new Store(home);
  const child = spawnSync(process.execPath, ['tests/fixtures/migration-crash.mjs', home, 'staged-' + kind],
    { timeout: 15_000, windowsHide: true, stdio: 'inherit' });
  expect(child.status).toBe(91);
  READ.inWorkerAbove = 1;
  const next = new Store(home);
  try {
    const data = await next.loadSessionAsync('a');
    expect(data.items.at(-1)?.id).toBe('peer-save');
    data.items.push({ ...rows[0], id: 'desktop' });
    next.saveSession('a', () => ({ ...data, dirty: new Set(['desktop']) }));
    await next.seal();
    expect(new SessionFiles(file).load('a').items.slice(-2).map(i => i.id)).toEqual(['peer-save', 'desktop']);
  } finally { await next.seal(); await bridge.seal(); }
}, 30_000);

it.each([false, true].flatMap(peer => [false, true].flatMap(noSql => [false, true].map(publicTail => ({ peer, noSql, publicTail })))))
('recovers private rows with peer=$peer unavailableSQLite=$noSql publicTail=$publicTail', async ({ peer, noSql, publicTail }) => {
  const { home, rows, file } = fixture();
  const bridge = peer ? new Store(home) : undefined;
  if (noSql) {
    const get = process.getBuiltinModule;
    vi.spyOn(process, 'getBuiltinModule').mockImplementation(name => name === 'node:sqlite' ? undefined : get(name));
  }
  const writeTail = (dest: string, id: string) => writeFileSync(dest,
    JSON.stringify({ baseGen: 42, from: rows.length, items: [{ ...rows[0], id }] }));
  const held = file('a.tail') + '.recover.00000000-0000-4000-8000-000000000001';
  writeTail(held, 'private-row');
  if (publicTail) writeTail(file('a.tail'), 'public-row');
  const reader = new Store(home);
  try {
    const data = await reader.loadSessionAsync('a');
    expect(data.items.map(r => r.id)).toContain('private-row');
    if (publicTail) expect(data.items.slice(-2).map(r => r.id)).toEqual(['private-row', 'public-row']);
    data.items.push({ ...rows[0], id: 'local-edit' });
    reader.saveSession('a', () => ({ ...data, dirty: 'all' }));
    await reader.persistInput('a');
    expect(new SessionFiles(file).load('a').items).toEqual(data.items);
  } finally { await reader.seal(); await bridge?.seal(); }
});

it('starts one verifier after construction and finishes each chat before dispatching the next', async () => {
  const { file, home, tail } = await foldedFixture();
  writeFileSync(file('b'), readFileSync(file('a')));
  writeFileSync(file('b.tail'), tail);
  clock();
  const verify = vi.spyOn(SessionFiles.prototype, 'verifyMigrations');
  const post = Worker.prototype.postMessage;
  const workers = new Set<Worker>(), dispatched: string[] = [], previousPresent: boolean[] = [];
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function(this: Worker, message, transfer) {
    workers.add(this);
    if (dispatched.length) previousPresent.push(existsSync(dispatched.at(-1)!));
    dispatched.push(message.tail);
    return post.call(this, message, transfer);
  });
  const store = new Store(home);
  try {
    expect(dispatched).toEqual([]);
    expect([file('a.tail'), file('b.tail')].every(existsSync)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await verify.mock.results[0].value).toBe(true);
    expect(workers.size).toBe(1);
    expect(dispatched.sort()).toEqual([file('a.tail'), file('b.tail')]);
    expect(previousPresent).toEqual([false]);
    expect(dispatched.some(existsSync)).toBe(false);
  } finally { await store.seal(); }
});

it.each(['before pinning', 'before rename', 'after rename'])('keeps a second process’s tail published %s', async when => {
  const { home, file, files } = await foldedFixture();
  const real = await vi.importActual<typeof import('node:fs')>('node:fs');
  clock();
  const verify = vi.spyOn(SessionFiles.prototype, 'verifyMigrations');
  const store = new Store(home);
  let writerStatus: number | null = null;
  const save = () => {
    writerStatus = spawnSync(process.execPath, ['tests/fixtures/migration-crash.mjs', home, 'save-unlocked'],
      { stdio: 'inherit', timeout: 15_000, windowsHide: true }).status;
  };
  if (when === 'before pinning') vi.mocked(openSync).mockImplementationOnce((...args) => {
    expect(args[0]).toBe(file('a.tail'));
    save();
    return real.openSync(...args);
  });
  else vi.mocked(renameSync).mockImplementationOnce((from, held) => {
    expect(from).toBe(file('a.tail'));
    if (when === 'before rename') {
      // Windows refuses replacement over an open destination. Move the old
      // name aside first to exercise the changed-inode branch on this OS too.
      if (process.platform === 'win32') real.renameSync(from, file('parked'));
      save();
    }
    real.renameSync(from, held);
    if (when === 'after rename') save();
  });
  try {
    await vi.advanceTimersByTimeAsync(1000);
    await verify.mock.results[0].value;
    expect(writerStatus).toBe(0);
    expect(JSON.parse(readFileSync(file('a.tail'), 'utf8')).items.at(-1).id).toBe('peer-save');
    expect(files.load('a').items.slice(-2).map(i => i.id)).toEqual(['folded', 'peer-save']);
    expect(readdirSync(path.dirname(file('a'))).filter(n => n.includes('.recover.'))).toEqual([]);
  } finally { await store.seal(); }
}, 30_000);

it('publishes and seals while a released bridge still holds its startup lock', async () => {
  const { home, file, files, tail } = await foldedFixture();
  const lock = new DatabaseSync(path.join(home, '.sable-store.lock'));
  lock.exec('BEGIN EXCLUSIVE');
  try {
    const peer = spawn(process.execPath, ['tests/fixtures/migration-crash.mjs', home, 'save'], { stdio: 'inherit', windowsHide: true });
    const exited = once(peer, 'exit');
    try {
      await vi.waitFor(() => expect(existsSync(path.join(home, 'published'))).toBe(true), { timeout: 9_000 });
      expect((await exited)[0]).toBe(0);
      expect(files.load('a').items.at(-1)?.id).toBe('peer-save');
      expect(readFileSync(file('a.tail'), 'utf8')).toBe(tail);
      rmSync(file('a.tail')); // Last operation in the released bridge's exclusive transaction.
      lock.exec('ROLLBACK');
      expect(files.load('a').items.slice(-2).map(i => i.id)).toEqual(['folded', 'peer-save']);
    } finally {
      if (peer.exitCode === null && peer.signalCode === null) peer.kill();
      await exited;
    }
  } finally { lock.close(); }
}, 30_000);

it('retries a contended startup lock and reaps dead owners beside a live owner and a reused PID', async () => {
  const { home, file, tail } = await foldedFixture();
  const owner = (pid: number, i: number) => path.join(home, `.sable-store.${pid}.00000000-0000-4000-8000-00000000000${i}.owner`);
  const live = owner(process.pid, 1), reused = owner(process.pid, 2), dead = owner(2147483646, 3);
  for (const name of [live, reused, dead]) writeFileSync(name, '');
  utimesSync(reused, new Date(0), new Date(0));
  const lock = new DatabaseSync(path.join(home, '.sable-store.lock'));
  lock.exec('BEGIN EXCLUSIVE');
  clock();
  const verify = vi.spyOn(SessionFiles.prototype, 'verifyMigrations');
  const store = new Store(home);
  try {
    await vi.advanceTimersByTimeAsync(5000);
    expect(verify).not.toHaveBeenCalled();
    expect(existsSync(dead)).toBe(true);
    expect(readFileSync(file('a.tail'), 'utf8')).toBe(tail);
    lock.exec('ROLLBACK');
    await vi.advanceTimersByTimeAsync(5000);
    expect([live, reused, dead].map(existsSync)).toEqual([true, false, false]);
    expect(readFileSync(file('a.tail'), 'utf8')).toBe(tail);
    rmSync(live);
    await vi.advanceTimersByTimeAsync(6000);
    await verify.mock.results[0].value;
    expect(existsSync(file('a.tail'))).toBe(false);
  } finally { lock.close(); await store.seal(); }
});

it('restores a tail claimed just before a hard exit and cancels the pending scan at seal', async () => {
  const { home, file, tail } = await foldedFixture();
  const held = file('a.tail') + '.recover.00000000-0000-4000-8000-000000000001';
  renameSync(file('a.tail'), held);
  clock();
  const verify = vi.spyOn(SessionFiles.prototype, 'verifyMigrations');
  const store = new Store(home);
  expect(existsSync(held)).toBe(false);
  expect(readFileSync(file('a.tail'), 'utf8')).toBe(tail);
  await store.seal();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(verify).not.toHaveBeenCalled();
  expect(readFileSync(file('a.tail'), 'utf8')).toBe(tail);
  const active = new Store(home);
  vi.advanceTimersByTime(1000);
  expect(verify).toHaveBeenCalledOnce();
  await active.seal();
  expect(await verify.mock.results[0].value).toBe(false);
  expect(readFileSync(file('a.tail'), 'utf8')).toBe(tail);
});

it('serves the identical end after one idle migration through the snapshot RPC', async () => {
  const { home, rows, old, file, files } = fixture();
  const app = restoredApp(home);
  clock();
  try {
    expect(files.readEnd('a')).toBeUndefined();
    const first = await app.call('session.snapshot', { sessionId: 'a', page: 'end' });
    expect(first.page?.kind).toBe('end');
    await advance(app.store, 19_999);
    expect(readFileSync(file('a'), 'utf8')).toBe(old);
    const rt = app.runtime('a');
    rt.turnActive = true;
    await advance(app.store, 1);
    rt.turnActive = false;
    rt.meta.background = 1;
    await advance(app.store, 5_000);
    expect(readFileSync(file('a'), 'utf8')).toBe(old);
    rt.meta.background = 0;
    await advance(app.store, 5_000);
    const fresh = new SessionFiles(file);
    const preview = fresh.readEnd('a')!;
    expect(preview.page).toEqual({ ...first.page, kind: 'provisional' });
    expect(preview.items).toStrictEqual(first.items);
    expect(fresh.load('a').items).toStrictEqual(rows);
    const committed = readFileSync(file('a'));
    await advance(app.store, 90_000);
    await app.dispose();
    expect(readFileSync(file('a')).equals(committed)).toBe(true);
    // A new bridge can show the migrated file even with the authoritative read held.
    const next = new App({ home, providers: [ctx => new DemoProvider(ctx)], quiet: true });
    try {
      const load = vi.spyOn(next.store, 'loadSessionAsync');
      const reopened = await next.call('session.snapshot', { sessionId: 'a', page: 'end' });
      expect(load).not.toHaveBeenCalled();
      expect(reopened.page?.kind).toBe('provisional');
      expect(reopened.items).toStrictEqual(first.items);
    } finally { await next.dispose(); }
  } finally { await app.dispose(); }
});

it('leaves a legacy base alone when authoritative restore reconciles its waiting queue', async () => {
  const { home, file, old } = fixture();
  const before = old.replace('"todos":[]', '"todos":[],"queue":[{"id":"u0","text":"Already sent","createdAt":1}]');
  writeFileSync(file('a'), before);
  const app = restoredApp(home);
  clock();
  try {
    const snap = await app.call('session.snapshot', { sessionId: 'a', page: 'end' });
    expect(snap.queue).toEqual([]);
    await advance(app.store, 60_000);
    expect(readFileSync(file('a'), 'utf8')).toBe(before);
  } finally { await app.dispose(); }
});

it.each(['tail row', 'override', 'tail todos', 'tail queue', 'base footer'].flatMap(where =>
  ['9007199254740993', '-0', '2.50e+01', '0.12345678901234567890123456789'].map(token => ({ where, token }))
))('preserves the original $token in the $where', async ({ where, token }) => {
  const { file, files, rows, old } = fixture();
  const tool = (id: string) => JSON.stringify({ ...rows[1], id, input: { value: 'TOKEN' } }).replace('"TOKEN"', token);
  const footer = '[{"content":"Test","status":"pending","value":' + token + '}]';
  const queue = '[{"id":"q","text":"Later","createdAt":' + token + '}]';
  const original = where === 'base footer' ? old.replace('"todos":[]', '"todos":' + footer) : old;
  writeFileSync(file('a'), original);
  const tail = '{"baseGen":42,"from":' + rows.length + ',"items":[' + (where === 'tail row' ? tool('new') : '') +
    '],"over":[' + (where === 'override' ? tool('s0') : '') + ']' +
    (where === 'tail todos' ? ',"todos":' + footer : where === 'tail queue' ? ',"queue":' + queue : '') + '}';
  if (where !== 'base footer') writeFileSync(file('a.tail'), tail);
  expect((await files.loadAsync('a')).unreadable).toBeUndefined();
  await files.migrate('a', () => true);
  expect(readFileSync(file('a')).equals(Buffer.from(original))).toBe(true);
  if (where === 'base footer') expect(existsSync(file('a.tail'))).toBe(false);
  else expect(readFileSync(file('a.tail'), 'utf8')).toBe(tail);
});

it('leaves a large matching tail on disk without scheduling a private read', async () => {
  const { file, files, rows, old } = fixture();
  // Above the size at which a tail is folded anyway (TAIL_MAX, 8 MiB): the one tail the private read leaves alone.
  const text = 'x'.repeat(8 * 1024 * 1024 + 16);
  const tail = JSON.stringify({ baseGen: 42, from: rows.length, items: [{ id: 'last', type: 'text', ts: 1, text }] });
  writeFileSync(file('a.tail'), tail);
  expect((await files.loadAsync('a')).items.at(-1)).toMatchObject({ id: 'last', text });
  expect(files.needsMigration('a')).toBe(false);
  await files.migrate('a', () => true);
  expect(readFileSync(file('a'), 'utf8')).toBe(old);
  expect(readFileSync(file('a.tail'), 'utf8')).toBe(tail);
});

it('opens every row when a legacy base exceeds the optional migration index budget', async () => {
  const { file, files } = fixture();
  const count = 131_073;
  const rows = Array.from({ length: count }, (_, id) => `{"id":"${id}","type":"turn","durationMs":1,"ts":1}`);
  writeFileSync(file('a'), '{"gen":42,"items":[\n' + rows.join(',\n') + '\n],"todos":[]}');
  const data = files.load('a');
  expect(data.items).toHaveLength(count);
  expect(data.items.at(-1)?.id).toBe(String(count - 1));
  expect(files.needsMigration('a')).toBe(false);
});

it('keeps a large indexed picture readable while declining a second private parse of its row', async () => {
  const { file, files, old, rows } = fixture();
  READ.inWorkerAbove = 1;
  const picture = 'P'.repeat(16 << 20);
  writeFileSync(file('a'), old.replace('test-0', picture));
  writeFileSync(file('a.tail'), JSON.stringify({ baseGen: 42, from: rows.length, items: [] }));
  const data = await files.loadAsync('a');
  expect(data.items).toHaveLength(rows.length);
  const tool = files.wholeItem('a', data.items[1]);
  expect(tool.type === 'tool' && tool.result?.images?.[0] === picture).toBe(true);
  expect(files.needsMigration('a')).toBe(false);
});

it('declines a private migration when small uncut rows together exceed its payload budget', async () => {
  const { file, files } = fixture();
  const count = 2100, text = 't'.repeat(32 << 10);
  const base = await disk.open(file('a'), 'w');
  try {
    await base.writeFile('{"gen":42,"items":[\n');
    for (let i = 0; i < count; i++) await base.writeFile((i ? ',\n' : '') + JSON.stringify({ id: String(i), type: 'text', text, ts: 1 }));
    await base.writeFile('\n],"todos":[]}');
  } finally { await base.close(); }
  writeFileSync(file('a.tail'), JSON.stringify({ baseGen: 42, from: count, items: [] }));
  const data = await files.loadAsync('a');
  expect(data.items).toHaveLength(count);
  expect(data.items.at(-1)).toMatchObject({ id: String(count - 1), text });
  expect(files.needsMigration('a')).toBe(false);
  // 2,100 writes and a 67 MB read: beside the whole suite's other workers this takes more than the default 5 s.
}, 60_000);

it.each(['lines', 'compact', 'pretty', 'no generation'])('folds the old %s base and tail with the same rows, cut, todos and queue', async shape => {
  const { file, files, rows, old } = fixture();
  READ.inWorkerAbove = 1;
  if (shape === 'compact') writeFileSync(file('a'), JSON.stringify({ gen: 42, items: rows, todos: [] }));
  if (shape === 'pretty') writeFileSync(file('a'), JSON.stringify({ gen: 42, items: rows, todos: [] }, null, 2));
  if (shape === 'no generation') writeFileSync(file('a'), old.replace('"gen":42,', ''));
  const baseGen = shape === 'no generation' ? -statSync(file('a')).mtimeMs : 42;
  const tail = { baseGen, from: rows.length - 4, items: [{ ...rows.at(-4)!, text: 'Replacement' }],
    over: [{ ...rows[0], text: 'Updated' }], todos: [{ content: 'Next', status: 'pending' }], queue: [{ id: 'q', text: 'Later', createdAt: 1 }] };
  writeFileSync(file('a.tail'), JSON.stringify(tail));
  const before = await files.loadAsync('a');
  const whole = structuredClone(before.items.map(r => files.wholeItem('a', r)));
  const cut = snapshotEnd(before.items);
  // Runtime references are independent of the version that can be migrated.
  Object.assign(before.items.at(-1)!, { text: 'local only' });
  await files.migrate('a', () => true);
  expect(existsSync(file('a.tail'))).toBe(false);
  const fresh = new SessionFiles(file);
  const end = fresh.readEnd('a')!;
  expect(end.page).toMatchObject({ before: cut.start, rootsBefore: cut.roots });
  expect(end.items).toStrictEqual(whole.slice(cut.start));
  expect(end.todos).toStrictEqual(tail.todos);
  expect(end.queue).toStrictEqual(tail.queue);
  const after = await fresh.loadAsync('a');
  expect(after.items.map(r => fresh.wholeItem('a', r))).toStrictEqual(whole);
  expect(fresh.needsMigration('a')).toBe(false);
});

it('keeps two long chats in separate idle write slots with a pause after completion', async () => {
  const { home, old, file } = fixture();
  writeFileSync(file('b'), old);
  const store = new Store(home);
  clock();
  const entered = gate(), release = gate();
  const diskIo = await vi.importActual<typeof disk>('node:fs/promises');
  vi.mocked(disk.rename).mockImplementationOnce(async (from, to) => {
    entered.open();
    await release.promise;
    await diskIo.rename(from, to);
  });
  for (const id of ['a', 'b']) {
    await store.loadSessionAsync(id);
    store.scheduleMigration(id, () => true);
  }
  await vi.advanceTimersByTimeAsync(20_000);
  await entered.promise;
  try {
    await vi.advanceTimersByTimeAsync(30_000);
    expect(readFileSync(file('b'), 'utf8')).toBe(old);
    expect(migrationTemps(file('b'))).toEqual([]);
  } finally { release.open(); await store.flush(); }
  expect(store.readSessionEnd('a')).toBeDefined();
  expect(readFileSync(file('b'), 'utf8')).toBe(old);
  await advance(store, 4_999);
  expect(readFileSync(file('b'), 'utf8')).toBe(old);
  await advance(store, 1);
  expect(store.readSessionEnd('b')).toBeDefined();
  await store.seal();
});

it('copies indexed legacy rows byte for byte and installs their new offsets at commit', async () => {
  const { file, files, old } = fixture();
  READ.inWorkerAbove = 1;
  const original = old.replace('"durationMs":2', '"durationMs": -0').replace('"images":["test-0"]', '"images": ["' + 'X'.repeat(8192) + '"],"value":1e999');
  writeFileSync(file('a'), original);
  const data = await files.loadAsync('a');
  const whole = structuredClone(files.wholeItem('a', data.items[1]));
  await files.migrate('a', () => true);
  const migrated = readFileSync(file('a'), 'utf8');
  expect(migrated.slice(migrated.indexOf('\n'), migrated.lastIndexOf('\n'))).toBe(original.slice(original.indexOf('\n'), original.lastIndexOf('\n')));
  expect(files.wholeItem('a', data.items[1])).toStrictEqual(whole);
  const fresh = new SessionFiles(file);
  const again = await fresh.loadAsync('a');
  expect(fresh.wholeItem('a', again.items[1])).toStrictEqual(whole);
  expect(again.items[3]).toMatchObject({ durationMs: -0 });
  expect(fresh.readEnd('a')).toBeDefined();
});

it('rechecks the source pair after writing the complete temp and before its rename', async () => {
  const { file, files, old } = fixture();
  READ.inWorkerAbove = 1;
  await files.loadAsync('a');
  const newer = JSON.stringify({ baseGen: 42, from: 0, items: [{ id: 'new', type: 'user', text: 'New tail', ts: 1 }] });
  let staged = false;
  await files.migrate('a', () => {
    const [tmp] = migrationTemps(file('a'));
    if (!staged && tmp && readFileSync(tmp, 'utf8').endsWith('"todos":[]}')) {
      staged = true;
      writeFileSync(file('a.tail'), newer);
    }
    return true;
  });
  expect(staged).toBe(true);
  expect(readFileSync(file('a'), 'utf8')).toBe(old);
  expect(readFileSync(file('a.tail'), 'utf8')).toBe(newer);
  expect(migrationTemps(file('a'))).toEqual([]);
});

it('retains the folded tail if another base takes the same generation at commit', async () => {
  const { file, files, rows } = fixture();
  const tail = JSON.stringify({ baseGen: 42, from: rows.length, items: [{ id: 'fold', type: 'text', text: 'Fold me', ts: 1 }] });
  writeFileSync(file('a.tail'), tail);
  await files.loadAsync('a');
  const real = await vi.importActual<typeof disk>('node:fs/promises');
  vi.mocked(disk.rename).mockImplementationOnce(async (from, to) => {
    await real.rename(from, to);
    const gen = JSON.parse(readFileSync(file('a'), 'utf8')).gen;
    writeFileSync(file('peer'), `{"gen":${gen},"items":[\n{"id":"peer","type":"text","text":"Peer","ts":2}\n],"todos":[]}`);
    await real.rename(file('peer'), to);
  });
  await files.migrate('a', () => true);
  expect(JSON.parse(readFileSync(file('a'), 'utf8')).items[0].id).toBe('peer');
  expect(readFileSync(file('a.tail'), 'utf8')).toBe(tail);
});

it('selects the descriptor’s own index on both sides of an in-flight migration rename', async () => {
  const { file, files, old } = fixture();
  writeFileSync(file('a'), old.replace('"test-0"', JSON.stringify('X'.repeat(8192))));
  READ.inWorkerAbove = 1;
  const loaded = await files.loadAsync('a');
  const step = loaded.items[1];
  expect(isLight(step)).toBe(true);
  const whole = structuredClone(files.wholeItem('a', step));
  const real = await vi.importActual<typeof disk>('node:fs/promises');
  const before = gate(), rename = gate(), after = gate(), notify = gate();
  vi.mocked(disk.rename).mockImplementationOnce(async (from, to) => {
    before.open();
    await rename.promise;
    await real.rename(from, to);
    after.open();
    await notify.promise;
  });
  const write = files.migrate('a', () => true);
  try {
    await before.promise;
    expect(files.readEnd('a')).toBeUndefined();
    expect(files.wholeItem('a', step)).toStrictEqual(whole);
    rename.open();
    await after.promise;
    expect(new SessionFiles(file).readEnd('a')).toBeDefined();
    expect(files.wholeItem('a', step)).toStrictEqual(whole);
    expect(files.wholeItem('a', files.recut('a', step, true))).toStrictEqual(whole);
  } finally { rename.open(); notify.open(); await write; }
  expect(files.wholeItem('a', step)).toStrictEqual(whole);
});

it('publishes a chat edit while a migration space check is stalled', async () => {
  const { files, file } = fixture();
  const data = await files.loadAsync('a');
  const entered = gate(), release = gate();
  const real = await vi.importActual<typeof disk>('node:fs/promises');
  vi.mocked(disk.statfs).mockImplementationOnce(async (...args) => {
    entered.open();
    await release.promise;
    return real.statfs(...args);
  });
  const migration = files.migrate('a', () => true);
  try {
    await entered.promise;
    data.items.push({ id: 'during-check', type: 'user', text: 'New edit', ts: 1 });
    const save = files.save('a', () => ({ ...data, dirty: 'all' }));
    await vi.waitFor(() => expect(JSON.parse(readFileSync(file('a'), 'utf8')).items.at(-1).id).toBe('during-check'));
    await save;
  } finally { release.open(); await migration; }
  expect(files.load('a').items.at(-1)?.id).toBe('during-check');
});

it('drops the owed rewrite at seal and accepts an ordinary base write in its place', async () => {
  const { home, old, file, files } = fixture();
  writeFileSync(file('quit'), old);
  const store = new Store(home);
  clock();
  const data = await store.loadSessionAsync('a');
  store.scheduleMigration('a', () => true);
  store.saveSession('a', () => ({ ...data, dirty: 'all' }));
  await advance(store, 1_500);
  expect(files.readEnd('a')).toBeDefined();
  const first = readFileSync(file('a'));
  await advance(store, 30_000);
  expect(readFileSync(file('a')).equals(first)).toBe(true);
  await store.loadSessionAsync('quit');
  store.scheduleMigration('quit', () => true);
  await store.seal();
  await advance(store, 60_000);
  expect(readFileSync(file('a')).equals(first)).toBe(true);
  expect(readFileSync(file('quit'), 'utf8')).toBe(old);
});

it.each(['short', 'damaged', 'stale tail', 'bad prefix', 'orphan', 'bad tail', 'partial footer'])('leaves a %s read alone', async reason => {
  const { home, file, rows, old } = fixture();
  READ.inWorkerAbove = 1;
  if (reason === 'short') writeFileSync(file('a'), JSON.stringify({ items: rows.slice(0, 2048), todos: [] }));
  if (reason === 'damaged') writeFileSync(file('a'), old.replace('"id":"u0"', '"id":broken'));
  if (reason === 'partial footer') writeFileSync(file('a'), old.replace('"todos":[]', '"rootCount":7,"todos":[]'));
  if (reason === 'bad tail') writeFileSync(file('a.tail'), '{broken');
  if (['stale tail', 'bad prefix', 'orphan'].includes(reason)) writeFileSync(file('a.tail'), JSON.stringify({
    baseGen: reason === 'stale tail' ? 13 : 42, from: reason === 'bad prefix' ? rows.length + 1 : rows.length, items: [],
    over: reason === 'orphan' ? [{ ...rows[0], id: 'lost' }] : [] }));
  const original = readFileSync(file('a'));
  const tail = existsSync(file('a.tail')) ? readFileSync(file('a.tail')) : undefined;
  const store = new Store(home);
  clock();
  await store.loadSessionAsync('a');
  store.scheduleMigration('a', () => true);
  await advance(store, 60_000);
  expect(readFileSync(file('a')).equals(original)).toBe(true);
  if (tail) expect(readFileSync(file('a.tail')).equals(tail)).toBe(true);
  await store.seal();
});

it.each(['base', 'tail', 'space'])('declines when the %s changes before the idle write', async change => {
  const { file, files, old } = fixture();
  await files.loadAsync('a');
  if (change === 'base') {
    writeFileSync(file('replacement'), old.replace('Next 0', 'Edit 0'));
    renameSync(file('replacement'), file('a')); // Same size, generation, and row IDs.
  }
  if (change === 'tail') writeFileSync(file('a.tail'), JSON.stringify({ baseGen: 42, from: 0, items: [] }));
  if (change === 'space') vi.mocked(disk.statfs).mockResolvedValueOnce({ bsize: 4096, bavail: 1 } as Awaited<ReturnType<typeof disk.statfs>>);
  const original = readFileSync(file('a'));
  await files.migrate('a', () => true);
  expect(readFileSync(file('a')).equals(original)).toBe(true);
  if (change === 'tail') expect(existsSync(file('a.tail'))).toBe(true);
});

it('abandons the temporary base when sealing starts during the copy', async () => {
  const { home, file, old } = fixture();
  const store = new Store(home);
  clock();
  await store.loadSessionAsync('a');
  let seal: Promise<void> | undefined;
  store.scheduleMigration('a', () => {
    if (migrationTemps(file('a')).length) { seal ??= store.seal(); return false; }
    return true;
  });
  await advance(store, 20_000);
  expect(seal).toBeDefined();
  await seal;
  expect(readFileSync(file('a'), 'utf8')).toBe(old);
  expect(migrationTemps(file('a'))).toEqual([]);
});
