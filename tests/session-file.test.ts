import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TextItem, TimelineItem } from '../shared/protocol';
import { OVER_MAX, READ, readBaseByLine, SessionFiles, SMALL_BASE, TAIL_KEEP, TAIL_MAX, settledEnd, type SessionSave } from '../server/core/session-file';
import { SessionRuntime } from '../server/core/runtime';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sable-session-file-'));
  dirs.push(dir);
  const pathOf = (id: string) => path.join(dir, `${id}.json`);
  return { dir, pathOf, files: new SessionFiles(pathOf), tail: (id: string) => path.join(dir, `${id}.tail.json`) };
}

let n = 0;
const text = (t: string, id = `i${n++}`): TextItem => ({ id, type: 'text', ts: 1, text: t }) as TextItem;
const turn = (id: string) => ({ id, type: 'turn', ts: 1, durationMs: 1 }) as TimelineItem;
/** A finished turn bigger than SMALL_BASE, so the base/tail rule applies; everything up to its turn line is settled. */
const big = () => [text('x'.repeat(SMALL_BASE + 1024), 'big'), text('a', 'a'), text('b', 'b'), turn('t0')];
const ids = (items: TimelineItem[]) => items.map((i) => i.id);
const save = (items: TimelineItem[], dirty: SessionSave['dirty']): (() => SessionSave) => () => ({ items, todos: [], queue: [], dirty });
const raw = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

describe('session files: a base and a small tail', () => {
  it('writes a small timeline whole, as JSON a reader of the old shape understands', async () => {
    const { files, pathOf, tail } = setup();
    const items = [text('hello', 'h'), text('line one\nline two', 'h2')];
    await files.save('s', save(items, 'all'));
    expect(raw(pathOf('s')).items).toEqual(items);
    expect(raw(pathOf('s')).todos).toEqual([]);
    expect(existsSync(tail('s'))).toBe(false);
    expect(new SessionFiles(pathOf).load('s').items).toEqual(items);
  });

  it('reads a file written before the base had a generation', () => {
    const { pathOf } = setup();
    writeFileSync(pathOf('old'), JSON.stringify({ items: [text('old', 'o')], todos: [{ content: 't', status: 'pending' }] }));
    const f = new SessionFiles(pathOf).load('old');
    expect(ids(f.items)).toEqual(['o']);
    expect(f.todos).toHaveLength(1);
  });

  it('writes only the tail while a long chat grows, and reads base and tail together', async () => {
    const { files, pathOf, tail } = setup();
    const items = big();
    await files.save('s', save(items, 'all'));
    const baseBefore = readFileSync(pathOf('s'), 'utf8');
    const mtime = statSync(pathOf('s')).mtimeMs;

    // A new answer streams in after the finished turn.
    const answer = text('Hel', 'ans');
    items.push(answer);
    await files.save('s', save(items, new Set(['ans'])));
    answer.text += 'lo there';
    await files.save('s', save(items, new Set(['ans'])));

    expect(readFileSync(pathOf('s'), 'utf8')).toBe(baseBefore);
    expect(statSync(pathOf('s')).mtimeMs).toBe(mtime);
    expect(raw(tail('s'))).toMatchObject({ from: 4, items: [answer] });

    const back = new SessionFiles(pathOf).load('s');
    expect(ids(back.items)).toEqual(['big', 'a', 'b', 't0', 'ans']);
    expect((back.items[4] as TextItem).text).toBe('Hello there');
  });

  it('a late change to an item the base settles goes in the tail, never rewrites the base, and reads back in its place', async () => {
    const { files, pathOf, tail } = setup();
    const items = big();
    await files.save('s', save(items, 'all'));
    const baseBefore = readFileSync(pathOf('s'), 'utf8');
    items.push(text('new', 'n'));
    await files.save('s', save(items, new Set(['n'])));

    // A late patch to an old step (a background sub-agent that finished hours after its turn).
    (items[1] as TextItem).text = 'a, patched';
    await files.save('s', save(items, new Set(['a'])));
    expect(readFileSync(pathOf('s'), 'utf8')).toBe(baseBefore);
    expect(raw(tail('s'))).toMatchObject({ from: 4, items: [{ id: 'n' }], over: [{ id: 'a', text: 'a, patched' }] });
    // Later saves keep carrying it until the base is written again.
    items.push(text('more', 'm'));
    await files.save('s', save(items, new Set(['m'])));
    expect(raw(tail('s')).over).toEqual([items[1]]);
    expect(readFileSync(pathOf('s'), 'utf8')).toBe(baseBefore);
    const back = new SessionFiles(pathOf).load('s');
    expect(ids(back.items)).toEqual(['big', 'a', 'b', 't0', 'n', 'm']);
    expect((back.items[1] as TextItem).text).toBe('a, patched');
    // A reader that picks up from the files carries the change on too.
    const again = new SessionFiles(pathOf);
    again.load('s');
    items.push(text('last', 'l'));
    await again.save('s', save(items, new Set(['l'])));
    expect(raw(tail('s')).over).toEqual([items[1]]);
    expect(readFileSync(pathOf('s'), 'utf8')).toBe(baseBefore);
  });

  it('writes the base again once the changed settled items pass their bound, and drops the tail', async () => {
    const { files, pathOf, tail } = setup();
    const items = big();
    for (let i = 0; i < OVER_MAX.items + 2; i++) items.splice(items.length - 1, 0, text(`o${i}`, `o${i}`));
    await files.save('s', save(items, 'all'));
    const gen1 = raw(pathOf('s')).gen;
    for (let i = 0; i <= OVER_MAX.items; i++) (items[1 + i] as TextItem).text += '!';
    await files.save('s', save(items, new Set(items.slice(1, OVER_MAX.items + 2).map((i) => i.id))));
    expect(existsSync(tail('s'))).toBe(false);
    expect(raw(pathOf('s')).gen).toBeGreaterThan(gen1);
    expect(raw(pathOf('s')).items[1].text).toBe('a!');
  });

  it('writes the base again when an item it settles moves or goes, and drops the tail', async () => {
    const { files, pathOf, tail } = setup();
    const items = big();
    await files.save('s', save(items, 'all'));
    items.push(text('new', 'n'));
    await files.save('s', save(items, new Set(['n'])));
    expect(existsSync(tail('s'))).toBe(true);

    // A rewind removes items.
    items.splice(2);
    await files.save('s', save(items, new Set()));
    expect(ids(raw(pathOf('s')).items)).toEqual(['big', 'a']);

    // A queued message moves from the middle to the end.
    items.push(text('c', 'c'));
    await files.save('s', save(items, new Set(['c'])));
    const [moved] = items.splice(1, 1);
    items.push(moved);
    await files.save('s', save(items, new Set(['a'])));
    expect(ids(new SessionFiles(pathOf).load('s').items)).toEqual(['big', 'c', 'a']);
  });

  it('leaves the turn that streams now out of the base, so its words never rewrite the base', async () => {
    const { files, pathOf } = setup();
    const items = big();
    for (let i = 0; i < 40; i++) items.push(text(`step ${i}`, `s${i}`));
    items.push(turn('t1'));
    const live = text('', 'live');
    items.push(text('next question', 'q'), live);
    await files.save('s', save(items, 'all'));
    const mtime = statSync(pathOf('s')).mtimeMs;
    for (let i = 0; i < 3; i++) {
      live.text += 'word ';
      await files.save('s', save(items, new Set(['live'])));
    }
    expect(statSync(pathOf('s')).mtimeMs).toBe(mtime);
    expect((new SessionFiles(pathOf).load('s').items.at(-1) as TextItem).text).toBe('word word word ');
  });

  it('ignores a tail left from another base (a crash between a new base and removing the tail)', async () => {
    const { files, pathOf, tail } = setup();
    const items = big();
    await files.save('s', save(items, 'all'));
    items.push(text('t1', 't1'));
    await files.save('s', save(items, new Set(['t1'])));
    const staleTail = readFileSync(tail('s'), 'utf8');
    // The base is written again (it now holds t1 and t2), then the old tail comes back.
    items.push(text('t2', 't2'));
    (items[0] as TextItem).text += '!';
    await files.save('s', save(items, new Set(['big', 't2'])));
    writeFileSync(tail('s'), staleTail);
    expect(ids(new SessionFiles(pathOf).load('s').items)).toEqual(['big', 'a', 'b', 't0', 't1', 't2']);
  });

  it('keeps a big tail rather than rewriting the base for every new item, and folds it once the boundary moves well on', async () => {
    const { files, pathOf, tail } = setup();
    const items = big();
    await files.save('s', save(items, 'all'));
    const mtime = statSync(pathOf('s')).mtimeMs;
    items.push(text('y'.repeat(TAIL_MAX + 1), 'huge'));
    await files.save('s', save(items, new Set(['huge'])));
    expect(statSync(pathOf('s')).mtimeMs).toBe(mtime);
    expect(existsSync(tail('s'))).toBe(true);
    // A long turn later: the boundary moved far enough, the tail goes into the base.
    for (let i = 0; i < TAIL_KEEP + 2; i++) items.push(text(`m${i}`, `m${i}`));
    items.push(turn('t1'));
    await files.save('s', save(items, new Set(['t1'])));
    expect(existsSync(tail('s'))).toBe(false);
    expect(ids(raw(pathOf('s')).items)).toEqual(ids(items));
  });

  it('runs saves for one session one after another and keeps the last state', async () => {
    const { files, pathOf } = setup();
    const items = big();
    const writes = [files.save('s', save(items.slice(), 'all'))];
    for (let i = 0; i < 5; i++) {
      items.push(text(`m${i}`, `m${i}`));
      writes.push(files.save('s', save(items.slice(), new Set([`m${i}`]))));
    }
    await Promise.all(writes);
    expect(ids(new SessionFiles(pathOf).load('s').items)).toEqual(['big', 'a', 'b', 't0', 'm0', 'm1', 'm2', 'm3', 'm4']);
  });

  it('never writes over a file it could not read', async () => {
    const { files, pathOf } = setup();
    writeFileSync(pathOf('bad'), '{"items":[{"id":"x"'); // damaged
    const f = files.load('bad');
    expect(f).toMatchObject({ items: [], unreadable: true });
    await files.save('bad', save([text('new', 'n')], 'all'));
    expect(readFileSync(pathOf('bad'), 'utf8')).toBe('{"items":[{"id":"x"');
  });

  it('writes the base anew on the first save after reading a file of an older version', async () => {
    const { files, pathOf, tail } = setup();
    const items = big();
    writeFileSync(pathOf('old'), JSON.stringify({ items, todos: [] }));
    const loaded = files.load('old');
    loaded.items.push(text('n', 'n'));
    await files.save('old', save(loaded.items, new Set(['n'])));
    expect(existsSync(tail('old'))).toBe(false);
    expect(typeof raw(pathOf('old')).gen).toBe('number');
    expect(ids(raw(pathOf('old')).items)).toEqual(['big', 'a', 'b', 't0', 'n']);
  });

  it('a chat deleted while it is being written does not come back', async () => {
    const { files, pathOf, tail } = setup();
    const items = big();
    const w = files.save('s', save(items, 'all'));
    files.remove('s');
    await w;
    await files.save('s', save(items, 'all'));
    await files.idle();
    expect(existsSync(pathOf('s'))).toBe(false);
    expect(existsSync(tail('s'))).toBe(false);
  });

  it('reads a base line by line (for files too big for one string)', async () => {
    const { files, pathOf } = setup();
    const items = [...big(), text('line one\nline two "quoted"', 'q'), text('ümlaut ✓', 'u')];
    await files.save('s', () => ({ items, todos: [{ content: 'do it', status: 'pending' } as never], queue: [{ id: 'qq', text: 'later' } as never], dirty: 'all' }));
    const read = readBaseByLine(pathOf('s'));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value?.items).toEqual(items);
    expect(read.value?.todos).toHaveLength(1);
    expect(read.value?.queue).toHaveLength(1);
    expect(typeof read.value?.gen).toBe('number');
  });

  it('reads big files of both kinds: an old one-line file and a new one-item-per-line base', async () => {
    const { files, pathOf } = setup();
    const was = READ.byLineAbove;
    READ.byLineAbove = 1024; // everything here counts as big
    try {
      const items = [text('x'.repeat(4096), 'big'), text('a', 'a'), turn('t0')];
      writeFileSync(pathOf('old'), JSON.stringify({ items, todos: [] }));
      const old = new SessionFiles(pathOf).load('old');
      expect(old.unreadable).toBeUndefined();
      expect(ids(old.items)).toEqual(['big', 'a', 't0']);
      await files.save('new', save(items, 'all'));
      const fresh = new SessionFiles(pathOf).load('new');
      expect(fresh.unreadable).toBeUndefined();
      expect(fresh.items).toEqual(items);
    } finally {
      READ.byLineAbove = was;
    }
  });

  it('reads a big chat in a worker thread with the same result as on the main thread', async () => {
    const { files, pathOf, tail } = setup();
    const was = { ...READ };
    READ.inWorkerAbove = 0;
    try {
      const items = [...big(), text('line one\nline two', 'q')];
      writeFileSync(pathOf('old'), JSON.stringify({ items, todos: [] }));
      expect(await new SessionFiles(pathOf).loadAsync('old')).toEqual(new SessionFiles(pathOf).load('old'));
      // A new base read line by line, with a tail.
      READ.byLineAbove = 1024;
      await files.save('s', save(items, 'all'));
      items.push(text('more', 'm'));
      await files.save('s', save(items, new Set(['m'])));
      expect(existsSync(tail('s'))).toBe(true);
      const inWorker = await new SessionFiles(pathOf).loadAsync('s');
      expect(inWorker.items).toEqual(items);
      expect(inWorker).toEqual(new SessionFiles(pathOf).load('s'));
      writeFileSync(pathOf('bad'), '{"items":[');
      expect(await new SessionFiles(pathOf).loadAsync('bad')).toMatchObject({ unreadable: true, items: [] });
    } finally {
      Object.assign(READ, was);
    }
  });

  it('settles a base up to the last finished turn, and before a step still running', () => {
    const items = [text('a', 'a'), turn('t'), text('b', 'b')];
    expect(settledEnd(items)).toBe(2);
    const running = [text('a', 'a'), { id: 'r', type: 'tool', status: 'running' } as TimelineItem, turn('t'), text('b', 'b')];
    expect(settledEnd(running)).toBe(1);
  });

  it('gets what changed from the runtime: added, streamed, patched and moved items', () => {
    const rt = new SessionRuntime({ id: 's' } as never, () => {}, () => {});
    rt.load([text('one', 'one')]);
    expect(rt.takeDirty()).toBe('all');
    rt.markSaved();
    const t = rt.add<TextItem>({ type: 'text', text: '' } as never);
    rt.delta(t.id, 'text', 'hi');
    rt.patch('one', { text: 'one!' } as never);
    expect([...(rt.takeDirty() as Set<string>)].sort()).toEqual([t.id, 'one'].sort());
    expect(rt.takeDirty()).toEqual(new Set());
    rt.reset([text('r', 'r')]);
    expect(rt.takeDirty()).toBe('all');
  });
});
