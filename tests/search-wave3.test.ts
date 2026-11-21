/**
 * Search over closed chats tells what it could not read and stays within each call's bytes (review
 * wave 3):
 * - #17: a tail that is there but cannot be read or parsed is counted in `skipped`, never taken as
 *   absent, and nothing of that chat is kept: once it reads again, its messages are found.
 * - #18: every read is held to what is left of the call's byte budget (a whole tail too), and the
 *   palette asks again until the bridge says the search is whole, showing that more is coming.
 * The Demo agent only.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MessageSearch } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { registerSearch, SEARCH, searchOf } from '../server/services/search';
import { searchAll, type MessageResults } from '../src/features/palette/messages';

const homes: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function makeApp(home = mkdtempSync(path.join(tmpdir(), 'sable-search-w3-'))) {
  if (!homes.includes(home)) homes.push(home);
  const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
  apps.push(app);
  registerSearch(app);
  return { app, home };
}

/** Chats written to disk and the app opened again, so search reads their files. */
async function closed(fills: ((app: App, id: string) => void)[]) {
  const first = makeApp();
  const ids: string[] = [];
  for (const [i, fill] of fills.entries()) {
    const id = (await first.app.call('session.create', { provider: 'demo', cwd: path.resolve('.') })).session.id;
    fill(first.app, id);
    first.app.sessions.get(id)!.update({ updatedAt: 1_000 + i });
    ids.push(id);
  }
  await first.app.dispose();
  apps.splice(apps.indexOf(first.app), 1);
  const again = makeApp(first.home);
  const base = (id: string) => path.join(again.app.store.dir, 'sessions', `${id}.json`);
  const gen = (id: string) => Number(/"gen":(\d+)/.exec(readFileSync(base(id), 'utf8').split('\n')[0])![1]);
  return { ...again, ids, base, gen };
}

const said = (text: string) => (a: App, id: string) => {
  const rt = a.sessions.get(id)!;
  rt.add({ type: 'user', text } as never);
  rt.add({ type: 'turn', durationMs: 10 } as never);
};

describe('#17: a tail that cannot be read is said, never taken as absent nor kept', () => {
  it('a damaged tail is skipped; once whole again (same size and time) its message is found', async () => {
    const { app, ids, base, gen } = await closed([said('an early lynx')]);
    const id = ids[0];
    const tail = base(id).replace(/\.json$/, '.tail.json');
    const whole = JSON.stringify({ baseGen: gen(id), from: 2, items: [{ id: 'late', type: 'text', text: 'a recent lynx reply', streaming: false, ts: 9 }], todos: [] });
    const damaged = whole.slice(0, -1) + 'x';
    expect(damaged.length).toBe(whole.length);
    writeFileSync(tail, damaged);
    utimesSync(tail, 1_700_000_000, 1_700_000_000);
    const r = await searchOf(app).search('lynx');
    expect(r.skipped).toBe(1);
    expect(r.hits.map((h) => h.text)).toEqual(['an early lynx']);
    // The same size and time, readable now: read again, not answered from what was kept.
    writeFileSync(tail, whole);
    utimesSync(tail, 1_700_000_000, 1_700_000_000);
    const again = await searchOf(app).search('lynx');
    expect(again.skipped).toBeUndefined();
    expect(again.hits.map((h) => h.itemId)).toEqual(['late', expect.any(String)]);
  });

  it('a tail that cannot be read at all (a folder in its place) is skipped too', async () => {
    const { app, ids, base } = await closed([said('a quiet lynx')]);
    const tail = base(ids[0]).replace(/\.json$/, '.tail.json');
    mkdirSync(tail);
    const r = await searchOf(app).search('lynx');
    expect(r.skipped).toBe(1);
  });

  it('a big tail cut off part way is skipped', async () => {
    const { app, ids, base, gen } = await closed([said('a lynx at the start')]);
    const id = ids[0];
    const big = { id: 'big', type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'done', detail: {}, output: 'z'.repeat(5 * 1024 * 1024), ts: 3 };
    const text = JSON.stringify({ baseGen: gen(id), from: 2, items: [big, { id: 'late', type: 'text', text: 'lynx late', streaming: false, ts: 4 }], todos: [] });
    writeFileSync(base(id).replace(/\.json$/, '.tail.json'), text.slice(0, text.length - 40));
    const r = await searchOf(app).search('lynx');
    expect(r.skipped).toBe(1);
  });
});

describe('#18: each read is held to what is left of the call', () => {
  it('a tail read whole only when it fits; else in pieces within the budget', async () => {
    const { app, ids, base, gen } = await closed([
      (a, id) => {
        const rt = a.sessions.get(id)!;
        rt.add({ type: 'user', text: 'the old marmot' } as never);
        rt.add({ type: 'turn', durationMs: 10 } as never);
      },
      said('nothing here'),
    ]);
    // The older chat's tail is 3 MB: more than what is left after the newer chat within a 2 MB call.
    const older = ids[0];
    const big = { id: 'big', type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'done', detail: {}, output: 'y'.repeat(3 * 1024 * 1024), ts: 3 };
    writeFileSync(base(older).replace(/\.json$/, '.tail.json'), JSON.stringify({ baseGen: gen(older), from: 2, items: [big, { id: 'late', type: 'text', text: 'a marmot late', streaming: false, ts: 4 }], todos: [] }));
    const search = searchOf(app);
    const budget = 2 * 1024 * 1024;
    let r: MessageSearch = await search.search('marmot', { bytes: budget });
    const reads = [search.lastRead];
    for (let i = 0; i < 10 && r.partial; i++) {
      r = await search.search('marmot', { bytes: budget, cursor: r.cursor });
      reads.push(search.lastRead);
    }
    expect(r.partial).toBeUndefined();
    expect(r.hits.map((h) => h.text)).toEqual(['a marmot late', 'the old marmot']);
    for (const n of reads) expect(n).toBeLessThanOrEqual(budget);
  });

  it("a base is read no further than the call's budget", async () => {
    const { app } = await closed([
      (a, id) => {
        const rt = a.sessions.get(id)!;
        rt.add({ type: 'user', text: 'a stoat first' } as never);
        for (let i = 0; i < 5; i++) rt.add({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'done', detail: {}, output: `${i}`.repeat(1_000_000) } as never);
        rt.add({ type: 'text', text: 'a stoat last', streaming: false } as never);
        rt.add({ type: 'turn', durationMs: 10 } as never);
      },
    ]);
    const search = searchOf(app);
    const budget = 1.5 * 1024 * 1024;
    const r = await search.search('stoat', { bytes: budget });
    expect(r.partial).toBe(true);
    expect(search.lastRead).toBeLessThanOrEqual(budget);
    expect(SEARCH.chunk).toBe(1024 * 1024);
  });
});

describe('#18: the palette asks until the search is whole', () => {
  it('goes on with each cursor however many answers it takes, showing more is coming until the last', async () => {
    const asked: (string | undefined)[] = [];
    const call = async (p: { cursor?: string }) => {
      asked.push(p.cursor);
      const n = asked.length;
      return (n < 30 ? { hits: [], partial: true, cursor: `c${n}` } : { hits: [{ sessionId: 's', itemId: 'i', role: 'user', text: 'found late', ts: 1 }] }) as MessageSearch;
    };
    const shown: MessageResults[] = [];
    await searchAll(call, 'late', () => true, (r) => shown.push(r));
    expect(asked).toHaveLength(30);
    expect(asked.slice(0, 3)).toEqual([undefined, 'c1', 'c2']);
    expect(shown.slice(0, -1).every((s) => s.busy)).toBe(true);
    expect(shown.at(-1)).toMatchObject({ busy: false, hits: [{ text: 'found late' }] });
  });

  it('stops once the answer is no longer wanted', async () => {
    let live = true;
    let n = 0;
    const call = async () => {
      if (++n === 3) live = false;
      return { hits: [], partial: true, cursor: 'c' } as MessageSearch;
    };
    const shown: MessageResults[] = [];
    await searchAll(call, 'gone', () => live, (r) => shown.push(r));
    expect(n).toBe(3);
    expect(shown).toHaveLength(2);
  });
});
