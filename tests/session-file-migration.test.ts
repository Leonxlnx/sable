import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  expect(JSON.parse(committed).itemCount).toBe(rows.length + 1);
  expect(readFileSync(file('a.tail'), 'utf8')).toBe(tail);
  expect(files.readEnd('a')).toBeUndefined();
  // Any one of these differences removes the authority to unlink.
  const extended = JSON.parse(tail);
  extended.items.push({ id: 'tail-only', type: 'text', ts: 6, text: 'Later' });
  for (const [base, suffix] of [[committed.replace('From the tail', 'Lost the data'), tail],
    [committed.replace('"itemCount":', '"otherCount":'), tail], [committed.slice(0, -16), tail],
    [committed, JSON.stringify(extended)], [committed, tail.replace('From the tail', 'Newer version')],
    [committed, tail.replace('42', String(JSON.parse(committed).gen))]]) {
    writeFileSync(file('a'), base);
    writeFileSync(file('a.tail'), suffix);
    const uncertain = new Store(home);
    expect(readFileSync(file('a.tail'), 'utf8')).toBe(suffix);
    await uncertain.seal();
  }
  // A second Store cannot reclaim a file while the first still owns the profile.
  const first = new Store(home);
  writeFileSync(file('a'), committed);
  writeFileSync(file('a.tail'), tail);
  const second = new Store(home);
  expect(readFileSync(file('a.tail'), 'utf8')).toBe(tail);
  await second.seal();
  await first.seal();
  const store = new Store(home);
  expect(existsSync(file('a.tail'))).toBe(false);
  expect(store.readSessionEnd('a')?.items.at(-1)?.id).toBe('after');
  expect(store.loadSession('a').items).toStrictEqual([...rows, JSON.parse(tail).items[0]]);
  await store.seal();
}, 30_000);

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
