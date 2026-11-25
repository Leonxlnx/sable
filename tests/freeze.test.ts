/**
 * perf1: what could freeze the window with a very long chat. The bridge runs in the desktop's main
 * process, so anything that holds its event loop stops the window answering ("not responding").
 *
 * - A move to another account copies the conversation's files (its transcript, every sub-agent's):
 *   asynchronously, so the event loop runs while hundreds of megabytes are copied.
 * - What a streamed word, a new step or a patch costs does not grow with the chat: the runtime's
 *   handlers touch the item and its index, never every item.
 * - A save after a late patch to an old step writes the tail only (session-file.test.ts holds the
 *   file rules; here the runtime's wiring as the bridge uses it).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionMeta, TimelineItem } from '../shared/protocol';
import { carryClaudeConversation, carryCodexConversation } from '../server/accounts/handover';
import { SessionRuntime } from '../server/core/runtime';
import { Store } from '../server/core/store';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'sable-freeze-'));
  dirs.push(d);
  return d;
};
const meta = (id: string, cwd: string) => ({ id, provider: 'demo', cwd, title: id, titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: 0, updatedAt: 0, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } }) as SessionMeta;

describe('nothing holds the bridge for long', () => {
  it('copies a conversation to another account without holding the event loop', async () => {
    const root = tmp();
    const a = path.join(root, 'a');
    const side = path.join(a, 'projects', 'D--w', 'abc', 'subagents');
    mkdirSync(side, { recursive: true });
    const chunk = 'x'.repeat(4 << 20);
    writeFileSync(path.join(a, 'projects', 'D--w', 'abc.jsonl'), chunk.repeat(8));
    for (let i = 0; i < 8; i++) writeFileSync(path.join(side, `agent-${i}.jsonl`), chunk);
    let ticks = 0;
    const t = setInterval(() => ticks++, 1);
    const p = carryClaudeConversation(a, path.join(root, 'b'), 'abc');
    expect(p).toBeInstanceOf(Promise);
    expect(await p).toBe(true);
    clearInterval(t);
    expect(statSync(path.join(root, 'b', 'projects', 'D--w', 'abc.jsonl')).size).toBe(32 << 20);
    // The timer ran while the files were copied (a synchronous copy lets it run zero times).
    expect(ticks).toBeGreaterThan(0);
    expect(carryCodexConversation(a, path.join(root, 'c'), 'none')).toBeInstanceOf(Promise);
  });

  it('a word, a step and a patch cost the same in a chat of 200 items and of 60,000', () => {
    const cost = (n: number) => {
      const items = Array.from({ length: n }, (_, i) => ({ id: `i${i}`, ts: i, type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'done', detail: {}, result: { text: 'ok' } }) as TimelineItem);
      const rt = new SessionRuntime(meta('s', 'C:/w'), () => {}, () => {});
      rt.load(items);
      rt.beginTurn();
      const live = rt.add({ type: 'text', text: '', streaming: true } as never).id;
      const t0 = performance.now();
      for (let k = 0; k < 3000; k++) {
        rt.delta(live, 'text', 'word ');
        if (k % 10 === 0) rt.add({ type: 'tool', name: 'Read', kind: 'read', title: 'Read', status: 'running', detail: {} } as never);
        if (k % 10 === 5) rt.patch(`i${n - 1 - (k % 50)}`, { title: `Run ${k}` } as never);
      }
      const elapsed = performance.now() - t0;
      expect(rt.meta.live?.steps).toBe(300);
      rt.endTurn();
      return elapsed;
    };
    cost(200);
    const small = Math.min(cost(200), cost(200));
    const large = Math.min(cost(60_000), cost(60_000));
    // Proportional work would make the long chat 300 times slower; allow noise, not growth.
    expect(large).toBeLessThan(small * 4 + 20);
  });

  it('a late shape change in a long running turn never reads the words of its other checkpoints', () => {
    const rt = new SessionRuntime(meta('s', 'C:/w'), () => {}, () => {});
    rt.beginTurn();
    let reads = 0;
    for (let i = 0; i < 3000; i++) {
      rt.add({ id: String(i), type: 'tool', name: 'Read', kind: 'read', title: 'Read', status: 'done', detail: {} });
      const note = rt.add({ type: 'text', text: 'The check passed.', streaming: false });
      Object.defineProperty(note, 'text', { get() { reads++; return 'The check passed.'; } });
    }
    const live = rt.add({ type: 'text', text: 'Let me check.', streaming: true });
    rt.delta(live.id, 'text', ' The suite failed.');
    rt.patch('0', { kind: 'plan' });
    expect(rt.meta.live).toMatchObject({ steps: 2999, checkpoints: 2999, checkpointSteps: 0 });
    expect(reads).toBe(0);
    rt.endTurn();
  });

  it('the side panel does not force a layout of the window for every sub-agent that finishes', () => {
    const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
    // The Agents tab's lists: a long list changes without measuring every row; no style flush per row.
    const leave = read('src/features/rail/leave.tsx');
    expect(leave).toMatch(/if \(items\.length > LONG\) return null;/);
    expect(leave).not.toMatch(/\.getAnimations\(\)/);
    // The tab row: a changed figure (the live count) reads the boxes at the next frame, not in the commit.
    const rail = read('src/features/rail/Rail.tsx');
    expect(rail).toMatch(/if \(last\.current && last\.current\.tab === tab\) \{\s*const raf = requestAnimationFrame/);
  });

  it('a burst of sub-agents measures nothing per change (the fleet)', () => {
    const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
    // A list that changes a few times a second changes without the motion (no measuring per change).
    expect(read('src/features/rail/leave.tsx')).toMatch(/const busy = now - this\.changed < BUSY_MS;[\s\S]*if \(busy\) return null;/);
    // The conversation's map reads its layout after the frame was laid out, never inside its callbacks.
    expect(read('src/features/timeline/Navigator.tsx')).toMatch(/requestAnimationFrame\(\(\) => \(t = window\.setTimeout\(check, 0\)\)\)/);
    // The tab's figure for edits outside a repository counts paths; it never builds the diffs, and in a repository it reads nothing.
    const changes = read('src/features/rail/ChangesTab.tsx');
    const count = changes.slice(changes.indexOf('export function useChangeCount'), changes.indexOf('export function ChangesTab'));
    expect(count).not.toMatch(/useSessionEdits/);
    expect(count).toMatch(/if \(!on\) return 0;/);
  });

  it('a background sub-agent finishing long after its turn saves the tail, not the whole base', async () => {
    const dir = tmp();
    const store = new Store(dir);
    const big = 'y'.repeat(5 << 20);
    const items: TimelineItem[] = [
      { id: 'u', ts: 1, type: 'user', text: 'go', state: 'sent' } as TimelineItem,
      { id: 'out', ts: 2, type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'done', detail: {}, output: big } as TimelineItem,
      { id: 'agent', ts: 3, type: 'tool', name: 'Task', kind: 'agent', title: 'Agent', status: 'done', detail: {}, result: { text: 'started', agent: { background: 'running' } } } as unknown as TimelineItem,
      { id: 't', ts: 4, type: 'turn', durationMs: 1 } as TimelineItem,
    ];
    const rt = new SessionRuntime(meta('s', dir), () => {}, (r, what) => {
      if (what !== 'meta') store.saveSession(r.id, () => ({ items: r.items, todos: r.todos, queue: r.queue, dirty: r.takeDirty() }));
    });
    rt.load(items);
    rt.touch();
    store.saveSession('s', () => ({ items: rt.items, todos: [], queue: [], dirty: rt.takeDirty() }));
    await store.flush();
    const base = path.join(dir, 'sessions', 's.json');
    const before = statSync(base).mtimeMs;
    rt.patch('agent', { result: { text: 'done', agent: { background: 'done' } } } as never);
    await store.flush();
    expect(statSync(base).mtimeMs).toBe(before);
    expect(statSync(path.join(dir, 'sessions', 's.tail.json')).size).toBeLessThan(4096);
    const back = new Store(dir).loadSession('s').items.find((i) => i.id === 'agent') as { result?: { agent?: { background?: string } } };
    expect(back.result?.agent?.background).toBe('done');
  });
});
