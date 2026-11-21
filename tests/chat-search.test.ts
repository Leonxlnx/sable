/** Search across chats (server/services/search.ts): matching, bounds, resuming where it stopped, the desktop RPC beside the phone's. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TimelineItem } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { matches, queryWords, saidOf, searchOf, registerSearch, SEARCH, snippetOf } from '../server/services/search';
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
    expect(r).toEqual({ hits: [], partial: true });
  });

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
