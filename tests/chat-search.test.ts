/** Search across chats (server/services/search.ts): matching, bounds, resuming where it stopped, the desktop RPC beside the phone's. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TimelineItem } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { FieldScan, matches, queryWords, saidOf, searchOf, registerSearch, SEARCH, snippetOf } from '../server/services/search';
import { registerPhone } from '../server/services/phone';

const homes: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function makeApp(home = mkdtempSync(path.join(tmpdir(), 'sable-search-'))) {
  if (!homes.includes(home)) homes.push(home);
  const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
  apps.push(app);
  registerSearch(app);
  return { app, home };
}

/** A chat whose messages talk about `words` (one exchange each), with a step whose output must never be searched. */
async function chat(app: App, words: string[], at?: number) {
  const id = (await app.call('session.create', { provider: 'demo', cwd: path.resolve('.') })).session.id;
  const rt = app.sessions.get(id)!;
  words.forEach((w, i) => {
    rt.add({ type: 'user', text: `question ${i}: ${w}` } as never);
    rt.add({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'done', detail: { command: 'grep zebra' }, output: 'zebra zebra', result: { text: 'zebra' } } as never);
    rt.add({ type: 'text', text: `Answer ${i} about **${w}**.`, streaming: false } as never);
    rt.add({ type: 'turn', durationMs: 10 } as never);
  });
  if (at) rt.update({ updatedAt: at });
  return id;
}

describe('what search reads and matches', () => {
  it('reads the person’s own messages and the agent’s texts, never steps, sub-agents, checks or what the harness wrote', () => {
    const items = [
      { id: 'u1', type: 'user', text: 'find the otter', ts: 1 },
      { id: 'n1', type: 'user', text: '<task-notification>otter done</task-notification>', ts: 2 },
      { id: 'c1', type: 'user', text: 'npm test failed', until: { check: true }, ts: 3 },
      { id: 't1', type: 'tool', kind: 'bash', name: 'Bash', title: 'otter', status: 'done', detail: {}, output: 'otter', ts: 4 },
      { id: 'k1', type: 'text', text: 'otter inside an agent', parentId: 't1', streaming: false, ts: 5 },
      { id: 'th', type: 'thinking', text: 'otter thoughts', streaming: false, ts: 6 },
      { id: 'a1', type: 'text', text: 'Found the otter.', streaming: false, ts: 7 },
      { id: 'e1', type: 'text', text: '   ', streaming: false, ts: 8 },
    ] as unknown as TimelineItem[];
    expect(saidOf(items).map((s) => [s.id, s.role])).toEqual([
      ['u1', 'user'],
      ['a1', 'agent'],
    ]);
  });

  it('needs every word, in any case and order; the query is cut and its words counted once', () => {
    const { q, words } = queryWords('  Otter  the OTTER ');
    expect(q).toBe('otter  the otter');
    expect(words).toEqual(['otter', 'the']);
    expect(matches('The quick otter', words)).toBe(true);
    expect(matches('An otter swims', words)).toBe(false);
    expect(queryWords('x'.repeat(500)).q).toHaveLength(SEARCH.max);
  });

  it('gives the words around the first match as plain text, cut at word boundaries', () => {
    const long = `${'lorem ipsum '.repeat(40)}the **quokka** sleeps in [the shade](https://example.com) ${'dolor sit '.repeat(40)}`;
    const s = snippetOf(long, ['quokka']);
    expect(s.length).toBeLessThanOrEqual(SEARCH.snippet + 2);
    expect(s).toMatch(/^….*the quokka sleeps in the shade.*…$/);
    expect(s).not.toContain('**');
    expect(snippetOf('A short `quokka` note', ['quokka'])).toBe('A short quokka note');
  });
});

describe('searching chats', () => {
  it('finds messages across chats, newest chats first and newest message first, within its limits', async () => {
    const { app } = makeApp();
    const older = await chat(app, ['the otter plan', 'apples', 'otter again'], 1_000);
    const newer = await chat(app, ['a sleepy otter'], 2_000);
    const archived = await chat(app, ['otter archived'], 3_000);
    await app.call('session.update', { sessionId: archived, patch: { archived: true } });

    const all = await app.call('search.messages', { query: 'OTTER' });
    expect(all.partial).toBeUndefined();
    expect(all.hits.map((h) => h.sessionId)).toEqual([newer, newer, older, older, older, older]);
    expect(all.hits.map((h) => h.text)).toEqual([
      'Answer 0 about a sleepy otter.',
      'question 0: a sleepy otter',
      'Answer 2 about otter again.',
      'question 2: otter again',
      'Answer 0 about the otter plan.',
      'question 0: the otter plan',
    ]);
    expect(all.hits[0].role).toBe('agent');
    expect(all.hits[1].role).toBe('user');

    // A few per chat, and a few in all.
    const few = await app.call('search.messages', { query: 'otter', perChat: 1, limit: 10 });
    expect(few.hits.map((h) => h.sessionId)).toEqual([newer, older]);
    expect((await app.call('search.messages', { query: 'otter', limit: 3 })).hits).toHaveLength(3);
    // Out-of-range limits are held to the bounds.
    expect((await app.call('search.messages', { query: 'otter', limit: 0, perChat: 99 })).hits).toHaveLength(1);
    // Every word; steps and their output are never searched; a one-letter query finds nothing.
    expect((await app.call('search.messages', { query: 'otter plan' })).hits).toHaveLength(2);
    expect((await app.call('search.messages', { query: 'zebra' })).hits).toEqual([]);
    expect((await app.call('search.messages', { query: 'o' })).hits).toEqual([]);
  });

  it('reads chats that are not open from their files within its budget, and goes on where it stopped', async () => {
    const first = makeApp();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await chat(first.app, [`walrus ${i}`, `topic ${i}`], 1_000 + i));
    await first.app.dispose();
    apps.splice(apps.indexOf(first.app), 1);

    const { app } = makeApp(first.home);
    for (const id of ids) expect(app.sessions.get(id)!.items).toHaveLength(0);
    const search = searchOf(app);
    // A budget of one byte: each call reads one chat more (the newest first), and keeps what it read.
    const rounds: string[][] = [];
    for (let i = 0; i < 6; i++) {
      const r = await search.search('walrus', { bytes: 1 });
      rounds.push([...new Set(r.hits.map((h) => h.sessionId))]);
      if (!r.partial) break;
    }
    expect(rounds).toEqual([[ids[3]], [ids[3], ids[2]], [ids[3], ids[2], ids[1]], [ids[3], ids[2], ids[1], ids[0]]]);
    // Nothing was opened, and a search with nothing new to read is whole at once.
    for (const id of ids) expect(app.sessions.get(id)!.items).toHaveLength(0);
    const again = await search.search('topic', { bytes: 1 });
    expect(again.partial).toBeUndefined();
    expect(again.hits).toHaveLength(8);
  });

  it('stops when the caller no longer wants the answer, and answers partial', async () => {
    const { app } = makeApp();
    await chat(app, ['narwhal'], 1_000);
    const signal = { aborted: true };
    const r = await searchOf(app).search('narwhal', { signal });
    expect(r).toMatchObject({ hits: [], partial: true });
  });

  it('reads one huge chat within the budget of each call, going on from the file offset where it stopped', async () => {
    const first = makeApp();
    const id = (await first.app.call('session.create', { provider: 'demo', cwd: path.resolve('.') })).session.id;
    const rt = first.app.sessions.get(id)!;
    rt.add({ type: 'user', text: 'first heron' } as never);
    for (let i = 0; i < 6; i++) rt.add({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'done', detail: {}, output: `${i}`.repeat(1_500_000) } as never);
    rt.add({ type: 'text', text: 'last heron', streaming: false } as never);
    rt.add({ type: 'turn', durationMs: 10 } as never);
    await first.app.dispose();
    apps.splice(apps.indexOf(first.app), 1);

    const { app } = makeApp(first.home);
    const search = searchOf(app);
    const budget = 2 * 1024 * 1024;
    let r = await search.search('heron', { bytes: budget });
    expect(r.partial).toBe(true);
    expect(r.cursor).toBeTruthy();
    expect(search.lastRead).toBeLessThanOrEqual(budget + 1024 * 1024);
    let rounds = 1;
    while (r.partial && rounds < 20) {
      r = await search.search('heron', { bytes: budget, cursor: r.cursor });
      expect(search.lastRead).toBeLessThanOrEqual(budget + 1024 * 1024);
      rounds++;
    }
    expect(rounds).toBeGreaterThan(2);
    expect(r.partial).toBeUndefined();
    expect(r.hits.map((h) => h.text)).toEqual(['last heron', 'first heron']);
  });

  it('a chat too big for what search keeps does not hold back the chats after it', async () => {
    const first = makeApp();
    const older = await chat(first.app, ['the pelican'], 1_000);
    await chat(first.app, Array.from({ length: 40 }, (_, i) => `long talk ${i} ${'words '.repeat(20)}`), 2_000);
    await first.app.dispose();
    apps.splice(apps.indexOf(first.app), 1);

    const { app } = makeApp(first.home);
    const keep = SEARCH.keep;
    SEARCH.keep = 200;
    try {
      let found: string[] = [];
      for (let i = 0; i < 4 && !found.length; i++) found = (await searchOf(app).search('pelican', { bytes: 1 })).hits.map((h) => h.sessionId);
      expect(found).toEqual([older, older]);
    } finally {
      SEARCH.keep = keep;
    }
  });

  it('an open chat obeys the time budget too, and goes on from the item where it stopped', async () => {
    const { app } = makeApp();
    await chat(app, ['the ibis', ...Array.from({ length: 1500 }, (_, i) => `filler ${i}`)], 1_000);
    const search = searchOf(app);
    let r = await search.search('ibis', { ms: -1 });
    expect(r.partial).toBe(true);
    let rounds = 1;
    while (r.partial && rounds < 40) {
      r = await search.search('ibis', { ms: -1, cursor: r.cursor });
      rounds++;
    }
    expect(rounds).toBeGreaterThan(2);
    expect(r.hits.map((h) => h.text)).toEqual(['Answer 0 about the ibis.', 'question 0: the ibis']);
  });

  it('a search in one window does not stop another window’s', async () => {
    const first = makeApp();
    for (let i = 0; i < 30; i++) await chat(first.app, [`kraken ${i}`], 1_000 + i);
    await first.app.dispose();
    apps.splice(apps.indexOf(first.app), 1);
    const { app } = makeApp(first.home);
    const ms = SEARCH.ms;
    SEARCH.ms = 60_000;
    try {
      const one = app.call('search.messages', { query: 'kraken', scope: 'window-a' });
      const two = app.call('search.messages', { query: 'kraken 2', scope: 'window-b' });
      const [a, b] = await Promise.all([one, two]);
      expect(a.partial).toBeUndefined();
      expect(a.hits.length).toBeGreaterThan(0);
      expect(b.hits.length).toBeGreaterThan(0);
    } finally {
      SEARCH.ms = ms;
    }
  });
});

describe('what a closed chat’s files give search', () => {
  /** A chat written to disk and the app opened again, so search reads its files. */
  async function closed(fill: (app: App, id: string) => void | Promise<void>) {
    const first = makeApp();
    const id = (await first.app.call('session.create', { provider: 'demo', cwd: path.resolve('.') })).session.id;
    await fill(first.app, id);
    await first.app.dispose();
    apps.splice(apps.indexOf(first.app), 1);
    const again = makeApp(first.home);
    return { ...again, id, base: path.join(again.app.store.dir, 'sessions', `${id}.json`) };
  }

  it('finds the words of a message that carries a big picture, wherever the picture sits in it', async () => {
    const { app, id } = await closed((a, sid) => {
      const rt = a.sessions.get(sid)!;
      rt.add({ type: 'user', attachments: [{ id: 'p1', kind: 'image', name: 'shot.png', dataUrl: `data:image/png;base64,${'A'.repeat(3_000_000)}` }], text: 'the capybara in this caption' } as never);
      rt.add({ type: 'text', text: 'A capybara indeed.', streaming: false } as never);
      rt.add({ type: 'turn', durationMs: 10 } as never);
    });
    const r = await searchOf(app).search('capybara');
    expect(r.hits.map((h) => [h.sessionId, h.role, h.text])).toEqual([
      [id, 'agent', 'A capybara indeed.'],
      [id, 'user', 'the capybara in this caption'],
    ]);
  });

  it('reads a tail of any size the session reader reads, as the reader does', async () => {
    const { app, id, base } = await closed((a, sid) => {
      const rt = a.sessions.get(sid)!;
      rt.add({ type: 'user', text: 'an early aardvark' } as never);
      rt.add({ type: 'turn', durationMs: 10 } as never);
    });
    const head = readFileSync(base, 'utf8').split('\n')[0];
    const gen = Number(/"gen":(\d+)/.exec(head)![1]);
    const big = { id: 'big', type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'done', detail: {}, output: 'z'.repeat(17 * 1024 * 1024), ts: 3 };
    const late = { id: 'late', type: 'text', text: 'a recent aardvark reply', streaming: false, ts: 4 };
    writeFileSync(base.replace(/\.json$/, '.tail.json'), JSON.stringify({ baseGen: gen, from: 2, items: [big, late], todos: [] }));
    const r = await searchOf(app).search('aardvark');
    expect(r.hits.map((h) => h.itemId)).toEqual(['late', expect.any(String)]);
    expect(r.hits[1].text).toBe('an early aardvark');
    // The reader gives the chat the same items.
    const snap = await app.call('session.snapshot', { sessionId: id });
    expect(snap.items.some((i) => i.id === 'late')).toBe(true);
  });

  it('says when part of a chat could not be read, instead of answering as if it had none', async () => {
    const { app, base } = await closed((a, sid) => {
      const rt = a.sessions.get(sid)!;
      rt.add({ type: 'user', text: 'a lost walrus' } as never);
    });
    writeFileSync(base, '{"gen":1,"items":[\n{"id":"x","type":"user","text":"a walrus but bro');
    const r = await searchOf(app).search('walrus');
    expect(r.hits).toEqual([]);
    expect(r.partial).toBeUndefined();
    expect(r.skipped).toBe(1);
  });
});

describe('reading JSON as it streams', () => {
  /** Feeds `text` to a scanner in pieces of `size` bytes and gives the items' fields back as values. */
  function scan(text: string, doc: boolean, size: number) {
    const got: Record<string, unknown>[] = [];
    const s = new FieldScan(doc, (f) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(f)) out[k] = v!.kind === 'str' ? JSON.parse(`"${v!.raw}"`) : JSON.parse(v!.raw);
      got.push(out);
    });
    const b = Buffer.from(text, 'utf8');
    for (let i = 0; i < b.length; i += size) s.push(b, i, Math.min(b.length, i + size));
    s.end();
    return { got, s };
  }

  it('keeps the fields search reads, whatever splits the pieces, and skips the rest', () => {
    const item = { id: 'u1', type: 'user', attachments: [{ id: 'a', dataUrl: `data:x;base64,${'Q'.repeat(5000)}`, text: 'not "this" one' }], text: 'say "hi" \\ back\\slash é 😀\n', ts: 12, until: { check: false }, extra: [1, { text: 'nested' }] };
    const line = `${JSON.stringify(item)},`;
    for (const size of [1, 2, 3, 7, 64, 100_000]) {
      const { got, s } = scan(line, false, size);
      expect(got, `pieces of ${size}`).toEqual([{ id: 'u1', type: 'user', text: item.text, ts: 12, until: { check: false } }]);
      expect(s.closed && !s.broken).toBe(true);
    }
  });

  it('reads a whole file’s items and its root fields', () => {
    const doc = JSON.stringify({ baseGen: 77, from: 3, items: [{ id: 'a', type: 'text', text: 'one' }, { id: 'b', type: 'tool', output: 'x'.repeat(3000), detail: { items: [{ id: 'no' }] } }, { id: 'c', type: 'user', text: 'two', parentId: 'b' }], todos: [{ id: 't', text: 'todo' }] });
    for (const size of [1, 5, 4096]) {
      const { got, s } = scan(doc, true, size);
      expect(got.map((g) => g.id)).toEqual(['a', 'b', 'c']);
      expect(got[2]).toEqual({ id: 'c', type: 'user', text: 'two', parentId: 'b' });
      expect(s.root).toEqual({ baseGen: '77', from: '3' });
      expect(s.closed && s.hasItems && !s.broken).toBe(true);
    }
  });
});

describe('searching chats, the desktop RPC', () => {

  it('a newer desktop search stops the one still running', async () => {
    const first = makeApp();
    for (let i = 0; i < 30; i++) await chat(first.app, [`kraken ${i}`], 1_000 + i);
    await first.app.dispose();
    apps.splice(apps.indexOf(first.app), 1);
    const { app } = makeApp(first.home);
    const one = app.call('search.messages', { query: 'kraken' });
    const two = app.call('search.messages', { query: 'kraken 2' });
    const [a, b] = await Promise.all([one, two]);
    expect(a.partial).toBe(true);
    expect(b.hits.length).toBeGreaterThan(0);
  });

  it('the phone and the desktop share one searcher', async () => {
    const { app } = makeApp();
    const phone = registerPhone(app, { port: 0, host: '127.0.0.1' });
    expect((phone as unknown as { finder: unknown }).finder).toBe(searchOf(app));
  });
});
