/**
 * A very long chat (a base of 1.3 GB) ended the desktop app: every thread shares one 4 GB heap, and
 * the chat was held in the reading worker, again on the main thread, and a third time by the first
 * save. What holds here: the worker hands a big base over in pieces and keeps none, a restart notice
 * is confirmed without reading the chat again. (How little of a long chat is held at all:
 * session-file-light.test.ts.)
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TimelineItem } from '../shared/protocol';
import { READ, SessionFiles } from '../server/core/session-file';
import { Store } from '../server/core/store';

const dirs: string[] = [];
const was = { ...READ };
afterEach(() => {
  Object.assign(READ, was);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'sable-big-'));
  dirs.push(d);
  mkdirSync(path.join(d, 'sessions'), { recursive: true });
  return d;
};
const step = (i: number): TimelineItem =>
  ({ id: `i${i}`, ts: i, type: 'tool', name: 'Bash', kind: 'bash', title: `Run ${i}`, status: 'done', detail: { command: 'pnpm test' }, result: { text: `out ${i} → ✓ `.repeat(200), images: ['data:image/png;base64,' + 'A'.repeat(900)] } }) as TimelineItem;
/** A base in the line format, as `writeBase` writes it. */
const writeBase = (file: string, items: TimelineItem[], gen = 7) =>
  writeFileSync(file, `{"gen":${gen},"items":[\n${items.map((i) => JSON.stringify(i)).join(',\n')}\n],"todos":[{"content":"t","status":"pending"}]}`);
const filesOf = (home: string) => new SessionFiles((id) => path.join(home, 'sessions', `${id}.json`));
/** Small numbers, the same path: by line above 1 KB, a piece every 4 KB (the worker waits for the main thread many times). */
const small = () => Object.assign(READ, { inWorkerAbove: 512, byLineAbove: 1024, part: 4096 });

describe('a very long chat is held once', () => {
  it('reads a big base in pieces through the worker, complete and in order', async () => {
    const home = tmp();
    const file = path.join(home, 'sessions', 'a.json');
    const items = Array.from({ length: 400 }, (_, i) => step(i));
    writeBase(file, items);
    small();
    expect(statSync(file).size).toBeGreaterThan(400 * 1024);
    const got = await filesOf(home).loadAsync('a');
    expect(got.unreadable).toBeUndefined();
    expect(got.items).toEqual(items);
    expect(got.todos).toEqual([{ content: 't', status: 'pending' }]);
    // The same as the read on the main thread.
    expect(filesOf(home).load('a').items).toEqual(items);
  });

  it('a big base cut off in the middle is unreadable, never a shorter chat', async () => {
    const home = tmp();
    const file = path.join(home, 'sessions', 'a.json');
    writeBase(file, Array.from({ length: 200 }, (_, i) => step(i)));
    const whole = readFileSync(file);
    writeFileSync(file, whole.subarray(0, Math.floor(whole.length * 0.6)));
    small();
    const got = await filesOf(home).loadAsync('a');
    expect(got.unreadable).toBe(true);
    expect(got.items).toEqual([]);
  });

  it('an older base (one long line) above the line size still reads whole in the worker', async () => {
    const home = tmp();
    const items = Array.from({ length: 50 }, (_, i) => step(i));
    writeFileSync(path.join(home, 'sessions', 'a.json'), JSON.stringify({ items, todos: [] }));
    small();
    const got = await filesOf(home).loadAsync('a');
    expect(got.unreadable).toBeUndefined();
    expect(got.items).toEqual(items);
  });

  it('confirms a restart notice from the tail, and from a small base, without reading the chat again', async () => {
    const home = tmp();
    const store = new Store(home);
    writeBase(path.join(home, 'sessions', 'a.json'), Array.from({ length: 6000 }, (_, i) => step(i)));
    const base = path.join(home, 'sessions', 'a.json');
    expect(statSync(base).size).toBeGreaterThan(4 * 1024 * 1024);
    const data = store.loadSession('a');
    const notice = { id: 'n1', ts: 9e9, type: 'notice', variant: 'info', text: 'Ended early', early: 'restart' } as TimelineItem;
    const items = [...data.items, notice];
    const written = statSync(base).mtimeMs;
    store.saveSession('a', () => ({ items, todos: [], dirty: new Set(['n1']) }));
    expect(await store.savedRestartNotice('a', 'n1')).toBe(true);
    expect(await store.savedRestartNotice('a', 'nope')).toBe(false);
    // The base was not written again (the notice went into the tail), and the tail holds it.
    expect(statSync(base).mtimeMs).toBe(written);
    expect(JSON.parse(readFileSync(path.join(home, 'sessions', 'a.tail.json'), 'utf8')).items.at(-1).id).toBe('n1');
    // A notice that is not a restart notice does not count.
    const other = { id: 'n3', ts: 9e9, type: 'notice', variant: 'info', text: 'Something else' } as TimelineItem;
    store.saveSession('a', () => ({ items: [...items, other], todos: [], dirty: new Set(['n3']) }));
    expect(await store.savedRestartNotice('a', 'n3')).toBe(false);
    // A small chat is written whole: the notice is among the base's newest lines.
    store.saveSession('s', () => ({ items: [step(1), { ...notice, id: 'n2' } as TimelineItem], todos: [], dirty: 'all' }));
    expect(await store.savedRestartNotice('s', 'n2')).toBe(true);
    expect(await store.savedRestartNotice('s', 'n1')).toBe(false);
  });
});
