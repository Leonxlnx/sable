import { mkdtempSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { closeForQuit } from '../electron/quit';
import { Store } from '../server/core/store';
import type { TextItem } from '../shared/protocol';

const folders: string[] = [];
function folder() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sable-store-quit-'));
  folders.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('preserves a registry unreadable at startup through save and quit', async () => {
  const dir = folder();
  const file = path.join(dir, 'state.json');
  mkdirSync(file); // A read fails even when the test process has elevated permissions.
  const store = new Store(dir);
  rmdirSync(file);
  const original = '{"projects":[],"sessions":[],"accounts":[{"id":"preserve"}]}';
  writeFileSync(file, original);
  store.saveState();
  await store.flush();
  await store.seal();
  expect(readFileSync(file, 'utf8')).toBe(original);
});

it('D3 retries the original registry without replacing a missing or unreadable file', async () => {
  const dir = folder(), file = path.join(dir, 'state.json');
  mkdirSync(file);
  const store = new Store(dir);
  rmdirSync(file);
  expect(store.reloadRegistry()).toBe(false);
  writeFileSync(file, '{broken');
  expect(store.reloadRegistry()).toBe(false);
  store.saveState(); await store.flush();
  expect(readFileSync(file, 'utf8')).toBe('{broken');
  writeFileSync(file, JSON.stringify({ accounts: [{ id: 'restored' }] }));
  expect(store.reloadRegistry()).toBe(true);
  expect(store.state.accounts.map(a => a.id)).toEqual(['restored']);
  await store.seal();
});

it('drains the final dirty answer to the tail during an active large-chat save', async () => {
  const dir = folder();
  const store = new Store(dir);
  const items: TextItem[] = Array.from({ length: 40 }, (_, i) => ({ type: 'text', id: String(i), ts: i, text: 'x'.repeat(128 * 1024), streaming: false }));
  store.saveSession('chat', () => ({ items, todos: [], dirty: 'all' }));
  await store.flush();
  const base = path.join(dir, 'sessions', 'chat.json');
  const gen = JSON.parse(readFileSync(base, 'utf8')).gen;
  const answer = items[39];
  const save = () => store.saveSession('chat', () => ({ items, todos: [], dirty: new Set([answer.id]) }));
  answer.text = 'draft';
  save();
  const writing = store.flush();
  answer.text = 'final';
  save();
  const quit = store.seal();
  answer.text = 'after quit';
  await Promise.all([writing, quit]);
  expect(JSON.parse(readFileSync(base, 'utf8')).gen).toBe(gen);
  expect(readFileSync(path.join(dir, 'sessions', 'chat.tail.json')).length).toBeLessThan(4096);
  expect(new Store(dir).loadSession('chat').items.at(-1)).toMatchObject({ text: 'final' });
});

it('seals a small chat with a dirty tail behind its first write and reports failed final writes', async () => {
  const dir = folder();
  const store = new Store(dir);
  const item: TextItem = { type: 'text', id: 'last', ts: 1, text: 'draft', streaming: false };
  const save = () => store.saveSession('chat', () => ({ items: [item], todos: [], dirty: new Set([item.id]) }));
  save();
  const writing = store.flush();
  item.text = 'finished';
  save();
  await Promise.all([writing, store.seal()]);
  const base = path.join(dir, 'sessions', 'chat.json');
  expect(JSON.parse(readFileSync(base, 'utf8')).items[0].text).toBe('draft');
  expect(new Store(dir).loadSession('chat').items[0]).toMatchObject({ text: 'finished' });
  const broken = new Store(folder());
  mkdirSync(path.join(broken.dir, 'sessions', 'bad.json'));
  broken.saveSession('bad', () => ({ items: [item], todos: [], dirty: 'all' }));
  await expect(broken.seal()).rejects.toThrow();
});

it('seals a legacy timeline by writing only its dirty tail', async () => {
  const dir = folder(), store = new Store(dir);
  const file = path.join(dir, 'sessions', 'legacy.json');
  const item: TextItem = { type: 'text', id: 'a', ts: 1, text: 'old', streaming: false };
  const before = JSON.stringify({ items: [item], todos: [] });
  writeFileSync(file, before);
  const saved = store.loadSession('legacy');
  saved.items.push({ ...item, id: 'b', text: 'new answer' });
  store.saveSession('legacy', () => ({ ...saved, dirty: new Set(['b']) }));
  await store.seal();
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(new Store(dir).loadSession('legacy').items).toEqual(saved.items);
});

it('acknowledges a slow seal before cleanup and bounds a stuck disposer', async () => {
  const { App } = await import('../server/app');
  const app = new App({ home: folder(), providers: [], quiet: true });
  vi.useFakeTimers();
  const events: string[] = [];
  vi.spyOn(app.store, 'seal').mockImplementation(() => new Promise(resolve => setTimeout(resolve, 4000)));
  app.onDispose(() => { events.push('cleanup'); return new Promise(() => {}); });
  let done = false;
  try {
    void app.dispose(() => events.push('saved')).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(3000);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual(['saved', 'cleanup']);
    await vi.advanceTimersByTimeAsync(4000);
    expect(done).toBe(true);
  } finally { vi.useRealTimers(); }
});

it('gives a slow save its own deadline before the shell cleanup grace', async () => {
  vi.useFakeTimers();
  try {
    let saved!: () => void;
    let finished = false;
    const closing = closeForQuit(ack => { saved = ack; return new Promise(() => {}); }).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(9000);
    expect(finished).toBe(false);
    saved();
    await vi.advanceTimersByTimeAsync(2999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(finished).toBe(true);
    await expect(closeForQuit(async () => {})).rejects.toThrow(/sav/i);
    const timeout = expect(closeForQuit(() => new Promise(() => {}))).rejects.toThrow(/saving/);
    await vi.advanceTimersByTimeAsync(10000);
    await timeout;
  } finally { vi.useRealTimers(); }
});
