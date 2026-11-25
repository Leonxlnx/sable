import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SessionMeta, SessionSnapshot, TimelineItem } from '../shared/protocol';
import { App } from '../server/app';
import { SessionFiles } from '../server/core/session-file';
import { resultForWindow, snapshotPage } from '../server/core/trim';
import { DemoProvider } from '../server/providers/demo';

const meta: SessionMeta = { id: 'a', title: 'Synthetic', provider: 'demo', model: 'm', status: 'idle', cwd: 'C:/w',
  titleSource: 'user', mode: 'default', createdAt: 1, updatedAt: 2, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };

function history() {
  const items: TimelineItem[] = [];
  for (let i = 0; i < 620; i++) {
    const ts = i;
    items.push({ type: 'user', ts, id: 'u' + i, text: 'Part ' + i },
      { type: 'tool', id: 's' + i, kind: 'bash', name: 'Bash', title: 'Run', status: 'done', ts, detail: {}, output: 'abc'.repeat(1400) },
      { type: 'text', id: 'c' + i, parentId: 's' + i, text: 'child', streaming: false, ts },
      { type: 'text', id: 'a' + i, text: 'Finished this part.', streaming: false, ts },
      { type: 'turn', id: 'e' + i, durationMs: 10, ts });
  }
  return items;
}
const snapshot = (items: TimelineItem[]): SessionSnapshot => ({ session: meta, items, todos: [], permissions: [], questions: [], queue: [] });

describe('the newest turns over the desktop snapshot RPC', () => {
  it('cuts each page at the density of the whole snapshot and completes it once in order', () => {
    const snap = snapshot(history()), whole = resultForWindow(snap);
    let page = resultForWindow(snapshotPage(snap, 'end'));
    expect(page.items.length).toBe(40);
    expect(page.page?.rootsBefore).toBe(2448);
    let built = page.items;
    while (page.page!.before) {
      const { before: at, rootsBefore: roots } = page.page!;
      page = resultForWindow(snapshotPage(snap, { at, roots, id: page.items[0].id }));
      built = page.items.concat(built);
    }
    expect(built).toEqual(whole.items);
    expect(snapshotPage(snapshot(snap.items.slice(-5)), 'end').page).toBeUndefined();
  });
  it.each(['running', 'awaiting', 'pending'])('includes a %s step with its turn and recovers a cursor invalidated by a rewind', status => {
    const snap = snapshot(history());
    Object.assign(snap.items[101], { status });
    const head = snapshotPage(snap, 'end');
    expect(head.items[0].id).toBe('u20');
    snap.items.splice(10, 1);
    expect(snapshotPage(snap, { at: 100, roots: 80, id: 'u20' })).toBe(snap);
  });
});

function savedChat(rows: TimelineItem[], interrupted = false) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-read-end-'));
  const dir = path.join(home, 'sessions');
  mkdirSync(dir);
  const first = snapshotPage(snapshot(rows), 'end').items[0].id;
  const file = path.join(dir, 'a.json');
  writeFileSync(file, '{"gen":42,"items":[\n' + rows.map(i => JSON.stringify(i)).join(',\n') +
    '\n],"endId":' + JSON.stringify(first) + ',"itemCount":' + rows.length + ',"rootCount":' + rows.filter(i => !i.parentId).length + ',"todos":[]}');
  writeFileSync(path.join(home, 'state.json'), JSON.stringify({ sessions: [{ ...meta, cwd: home, status: interrupted ? 'running' : 'idle' }] }));
  const app = new App({ home, providers: [ctx => new DemoProvider(ctx)], quiet: true });
  return { home, app };
}

describe('reading a provisional conversation', () => {
  it.each([false, true])('matches the authoritative RPC tail across restore (interrupted %s)', async interrupted => {
    const rows = history();
    if (interrupted) {
      rows.pop();
      Object.assign(rows.at(-3)!, { status: 'running' });
      Object.assign(rows[606 * 5 + 1], { status: 'running' });
    }
    const { home, app } = savedChat(rows, interrupted);
    try {
      const preview = resultForWindow(await app.call('session.snapshot', { sessionId: 'a', page: 'end' }));
      expect(preview.page?.kind).toBe('provisional');
      const real = resultForWindow(await app.call('session.snapshot', { sessionId: 'a', page: 'real', keepFrom: preview.items[0].id }));
      if (!interrupted) {
        expect(preview.items).toEqual(real.items);
        let part = real;
        let combined = real.items;
        while (part.page?.before) {
          part = resultForWindow(await app.call('session.snapshot', { sessionId: 'a',
            page: { at: part.page.before, roots: part.page.rootsBefore, id: part.items[0].id } }));
          combined = part.items.concat(combined);
        }
        expect(combined).toEqual(resultForWindow(await app.call('session.snapshot', { sessionId: 'a' })).items);
      } else {
        expect(preview.items[0].id).toBe('u606');
        expect(real.items.map(i => i.id).slice(0, preview.items.length)).toEqual(preview.items.map(i => i.id));
        expect(real.items.filter(i => i.id !== 's619' && i.id !== 's606' && preview.items.some(p => p.id === i.id))).toEqual(preview.items.filter(i => i.id !== 's619' && i.id !== 's606'));
        expect(real.items.at(-1)).toMatchObject({ type: 'notice', early: 'restart' });
      }
    } finally { await app.dispose(); rmSync(home, { recursive: true, force: true }); }
  });
  it('shares the real read with a send from the provisional view', async () => {
    const { app, home } = savedChat(history());
    const load = app.store.loadSessionAsync.bind(app.store);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const read = vi.spyOn(app.store, 'loadSessionAsync').mockImplementation(async id => { await gate; return load(id); });
    try {
      const preview = await app.call('session.snapshot', { sessionId: 'a', page: 'end' });
      expect(preview.page?.kind).toBe('provisional');
      const send = app.call('session.send', { sessionId: 'a', text: 'A message during restore' });
      const real = app.call('session.snapshot', { sessionId: 'a', page: 'real' });
      expect(app.runtime('a').items).toHaveLength(0);
      expect(read).toHaveBeenCalledTimes(1);
      release();
      await Promise.all([send, real]);
      const items = app.runtime('a').items;
      expect(items[0].id).toBe('u0');
      expect(items.filter(i => i.type === 'user' && i.text === 'A message during restore')).toHaveLength(1);
      expect(read).toHaveBeenCalledTimes(1);
    } finally { release(); await app.dispose(); rmSync(home, { recursive: true, force: true }); }
  });
  it('applies a matching tail prefix, suffix, overrides, todos and queue, and declines doubtful files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sable-end-files-'));
    const file = path.join(dir, 'a.json'), tailFile = path.join(dir, 'a.tail.json');
    const files = new SessionFiles(() => file), rows = history();
    const body = rows.map(i => JSON.stringify(i)).join(',\n');
    const document = '{"gen":42,"items":[\n' + body + '\n],"itemCount":3100,"rootCount":2480,"todos":[]}';
    try {
      writeFileSync(file, document);
      const tail = { baseGen: 42, from: rows.length - 5, items: rows.slice(-5), over: [{ ...rows.at(-10)!, text: 'updated' }],
        todos: [{ content: 'work', status: 'pending' }], queue: [{ id: 'q', createdAt: 2, text: 'Next' }] };
      writeFileSync(tailFile, JSON.stringify(tail));
      const shown = files.readEnd('a')!;
      const whole = files.load('a');
      const expected = snapshotPage(snapshot(whole.items), 'end');
      expect(shown.items).toEqual(expected.items);
      expect(shown.page.rootsBefore).toBe(expected.page?.rootsBefore);
      expect(shown.todos).toEqual(tail.todos);
      expect(shown.queue).toEqual(tail.queue);
      for (const bad of [{ ...tail, baseGen: 41 }, { ...tail, from: 9000 }, { ...tail, over: [{ id: 'missing', type: 'turn' }] }]) {
        writeFileSync(tailFile, JSON.stringify(bad));
        expect(files.readEnd('a')).toBeUndefined();
      }
      writeFileSync(tailFile, '{');
      expect(files.readEnd('a')).toBeUndefined();
      rmSync(tailFile);
      const overrides = rows.filter(i => i.type === 'user').slice(-20).map(i => JSON.stringify(i)).join(',\n');
      writeFileSync(file, document.replace('\n],"itemCount":', '\n],"over":[\n' + overrides + '\n],"itemCount":'));
      expect(files.readEnd('a')).toBeUndefined();
      writeFileSync(file, document.replace('"gen":42,', ''));
      expect(files.readEnd('a')).toBeUndefined();
      expect(readFileSync(file, 'utf8')).toBe(document.replace('"gen":42,', ''));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

