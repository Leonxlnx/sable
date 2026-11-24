import { expect, it, vi } from 'vitest';
import type { SessionSnapshot, TimelineItem, ToolItem } from '../shared/protocol';
import { cutItem, cutItems, recentStart, RECENT_TURNS } from '../server/core/trim';
import { expectSameRows } from './trim-model';
import { watchMessage } from '../src/features/timeline/user-card';

// The crash repro's picture / wide command output / file reads, with the other costs
// measured in old turns: raw inputs, edit hunks, reasoning and occasional pasted images.
// Share immutable source strings so benchmarking stringify doesn't require a GB of fixtures.
const image = 'data:image/png;base64,' + 'A'.repeat(360_000);
const output = 'src/app.ts → ok ✓ │ 12 passed\n'.repeat(3200);
const content = 'export const ready = true;\n'.repeat(2300);
const command = 'pnpm test\n' + 'echo next\n'.repeat(90);
const hunk = { oldStart: 1, oldLines: 20, newStart: 1, newLines: 20, lines: Array.from({ length: 40 }, (_, n) => (n % 2 ? '+' : '-') + 'edited line '.repeat(6)) };

function corpus(n: number): TimelineItem[] {
  return Array.from({ length: n }, (_, i): TimelineItem => {
    const base = { id: 'i' + i, ts: 1_700_000_000_000 + i };
    const pos = i % 20;
    if (!pos) return { ...base, type: 'user', text: 'Please carry on.', ...(i % 500 === 0 ? { attachments: [{ id: 'img', kind: 'image', name: 'shot.png', dataUrl: image }] } : {}) };
    if (pos === 18) return { ...base, type: 'text', streaming: false, text: 'Done. The tests pass.' };
    if (pos === 19) return { ...base, type: 'turn', durationMs: 60_000 };
    if (pos % 3 === 1) return { ...base, type: 'thinking', streaming: false, text: 'Review the next file. '.repeat(50), endedAt: base.ts + 2 };
    const tool = { ...base, type: 'tool', status: 'done', endedAt: base.ts + 1 } as const;
    switch (i % 4) {
      case 0: return { ...tool, name: 'Bash', kind: 'bash', title: 'Run tests', detail: { command }, input: { command }, result: { text: output, exitCode: 0 } };
      case 1: return { ...tool, name: 'Edit', kind: 'edit', title: 'Edit app.ts', detail: { path: 'src/app.ts', newText: content.slice(0, 800), oldText: content.slice(0, 600) }, input: { change: content.slice(0, 1460) }, result: { diff: [{ path: 'src/app.ts', status: 'modified', additions: 20, deletions: 20, hunks: [hunk] }] } };
      case 2: return { ...tool, name: 'Read', kind: 'read', title: 'Read image', detail: { path: 'shot.png' }, input: { path: 'shot.png' }, result: { text: 'Read image', images: [image] } };
      default: return { ...tool, name: 'Read', kind: 'read', title: 'Read app.ts', detail: { path: 'src/app.ts' }, result: { file: { path: 'src/app.ts', content, totalLines: 2300 } } };
    }
  });
}

function measure(items: TimelineItem[]) {
  const snapshot: SessionSnapshot = { session: { id: 'synthetic', provider: 'demo', cwd: 'C:/w', model: 'demo', title: 'Synthetic chat', titleSource: 'user',
    mode: 'default', status: 'idle', createdAt: 1, updatedAt: 2, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } }, items, permissions: [], questions: [], todos: [], queue: [] };
  const ms = [];
  let bytes = 0;
  for (let i = 0; i < (process.env.SLIM_MEASURE ? 3 : 1); i++) {
    const start = performance.now();
    const json = JSON.stringify(snapshot);
    ms.push(performance.now() - start);
    bytes = Buffer.byteLength(json);
  }
  ms.sort((a, b) => a - b);
  return { bytes, ms: +ms[Math.floor(ms.length / 2)].toFixed(1) };
}

function compare(items: TimelineItem[]) {
  const from = recentStart(items, RECENT_TURNS);
  const before = measure(items.map((it, i) => cutItem(it, i < from ? { at: 1200, head: 600, tail: 300 } : undefined)));
  const rows = cutItems(items);
  const after = measure(rows);
  const sizes = rows.slice(0, from).filter((it): it is ToolItem => it.type === 'tool').map(it => Buffer.byteLength(JSON.stringify(it))).sort((a, b) => a - b);
  return { before, after, steps: sizes.length, median: sizes[Math.floor(sizes.length / 2)] };
}

it('sends under one fifth of the previous snapshot with old step rows under 500 bytes at the median', () => {
  expectSameRows(corpus(80));
  // Eleven steps per turn, plus three recent turns.
  const items = corpus(185 * 20);
  items.splice(2, 2);
  const result = compare(items);
  expect(result.steps).toBe(2000);
  if (process.env.SLIM_MEASURE) process.stdout.write(JSON.stringify({ items: items.length, ...result }) + '\n');
  expect(result.after.bytes).toBeLessThan(result.before.bytes / 5);
  expect(result.median).toBeLessThan(500);
});

it.runIf(process.env.SLIM_MEASURE)('measures snapshot serialization for 10,000 and 60,000 synthetic items', () => {
  for (const n of [10_000, 60_000]) process.stdout.write(JSON.stringify({ items: n, ...compare(corpus(n)) }) + '\n');
}, 60_000);

it('observes old cards together and fetches only a nearby, still-mounted message', () => {
  const observe = vi.fn(), unobserve = vi.fn(), construct = vi.fn();
  let notify!: (entries: { target: Element; isIntersecting: boolean }[]) => void;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof notify, options: IntersectionObserverInit) { notify = callback; construct(options); }
    observe = observe;
    unobserve = unobserve;
  });
  const a = {} as Element, b = {} as Element, loadA = vi.fn(), loadB = vi.fn();
  try {
    const leaveA = watchMessage(a, loadA), leaveB = watchMessage(b, loadB);
    expect(construct).toHaveBeenCalledTimes(1);
    expect(construct).toHaveBeenCalledWith(expect.objectContaining({ rootMargin: '400px' }));
    expect(observe).toHaveBeenCalledTimes(2);
    expect(loadA).not.toHaveBeenCalled();
    notify([{ target: a, isIntersecting: false }, { target: b, isIntersecting: true }]);
    expect(loadB).toHaveBeenCalledTimes(1);
    leaveA();
    notify([{ target: a, isIntersecting: true }]);
    expect(loadA).not.toHaveBeenCalled();
    leaveB();
    expect(unobserve).toHaveBeenCalledTimes(2);
  } finally { vi.unstubAllGlobals(); }
});
