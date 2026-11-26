/** Local usage: the transcript scanner (Claude Code and Codex formats, incremental cache), the limits book and the pace. */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEvent, RateLimit } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { LimitsBook, pace, windowSamples } from '../server/services/limits';
import { UsageScanner, dayKey, registerUsage, transcriptSources, type UsageSource } from '../server/services/usage';

const dirs: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix = 'sable-usage-') {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const NOW = Date.now();
const HOUR = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();

function assistant(o: { id: string; session: string; t: number; model?: string; input?: number; output?: number; read?: number; write?: number; cwd?: string }) {
  return JSON.stringify({
    type: 'assistant',
    sessionId: o.session,
    cwd: o.cwd ?? '/work/alpha',
    timestamp: iso(o.t),
    requestId: `req-${o.id}`,
    message: { id: o.id, model: o.model ?? 'claude-x', usage: { input_tokens: o.input ?? 10, output_tokens: o.output ?? 100, cache_read_input_tokens: o.read ?? 1000, cache_creation_input_tokens: o.write ?? 50 } },
  });
}

function write(file: string, lines: string[]) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.join('\n') + '\n');
}

const sum = (rows: { input: number; output: number; cacheRead: number; cacheWrite: number }[], k: 'input' | 'output' | 'cacheRead' | 'cacheWrite') => rows.reduce((n, r) => n + r[k], 0);

describe('transcript scanner', () => {
  it('counts each path, then persists a deletion-only scan with the surviving account and totals', async () => {
    const root = tmp();
    const sources = ['first', 'second'].map(accountId => ({ provider: 'claude', format: 'claude', accountId, dir: path.join(root, accountId) }) as const);
    for (const src of sources) write(path.join(src.dir, 'k', 's.jsonl'), [assistant({ id: 'reply', session: 's', t: NOW })]);
    const opts = { cacheFile: path.join(root, 'cache.json') };
    const scanner = new UsageScanner(opts);
    await scanner.scan(sources);
    expect(scanner.report().rows[0].input).toBe(20);
    await scanner.flush();
    rmSync(path.join(sources[0].dir, 'k', 's.jsonl'));
    expect((await scanner.scan(sources)).read).toBe(0);
    await vi.waitFor(async () => {
      const reopened = new UsageScanner(opts);
      await reopened.ready();
      expect(reopened.report().rows[0].input).toBe(10);
      expect(reopened.report().sessions['claude:s'].accountId).toBe('second');
    }, { timeout: 5000, interval: 100 });
  });

  it('reads Claude Code transcripts: one count per reply, malformed lines skipped, titles, cost, two accounts', async () => {
    const root = tmp();
    const a = path.join(root, 'a', 'projects');
    const b = path.join(root, 'b', 'projects');
    write(path.join(a, 'alpha', 's1.jsonl'), [
      JSON.stringify({ type: 'user', sessionId: 's1', cwd: '/work/alpha', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
      JSON.stringify({ type: 'user', sessionId: 's1', cwd: '/work/alpha', message: { role: 'user', content: 'Refactor the session module\nplease' } }),
      // The same reply, one line per content block: the last one has the final output count.
      assistant({ id: 'm1', session: 's1', t: NOW - 2 * HOUR, output: 40 }),
      assistant({ id: 'm1', session: 's1', t: NOW - 2 * HOUR, output: 100 }),
      '{"type":"assistant", this is not json',
      '',
      assistant({ id: 'm2', session: 's1', t: NOW - HOUR, model: 'claude-y', input: 5, output: 7, read: 0, write: 0 }),
      JSON.stringify({ type: 'assistant', sessionId: 's1', timestamp: iso(NOW), message: { id: 'syn', model: '<synthetic>', usage: { input_tokens: 999, output_tokens: 999 } } }),
      JSON.stringify({ type: 'cost-state', sessionId: 's1', totalCostUSD: 0.5 }),
      JSON.stringify({ type: 'cost-state', sessionId: 's1', totalCostUSD: 0.75 }),
    ]);
    // A sub-agent transcript counts toward its parent session.
    write(path.join(a, 'alpha', 's1', 'subagents', 'agent-1.jsonl'), [assistant({ id: 'm3', session: 's1', t: NOW - HOUR, output: 1 })]);
    write(path.join(b, 'beta', 's2.jsonl'), [assistant({ id: 'm9', session: 's2', t: NOW - 3 * HOUR, cwd: '/work/beta' }), JSON.stringify({ type: 'custom-title', sessionId: 's2', customTitle: 'Named by hand' })]);
    const sources: UsageSource[] = [
      { provider: 'claude', accountId: 'default', format: 'claude', dir: a },
      { provider: 'claude', accountId: 'work', format: 'claude', dir: b },
    ];
    const scanner = new UsageScanner();
    const r = await scanner.scan(sources);
    expect(r).toMatchObject({ files: 3, read: 3 });
    const report = scanner.report();
    const s1 = report.rows.filter((x) => x.session === 'claude:s1');
    expect(sum(s1, 'output')).toBe(100 + 7 + 1);
    expect(sum(s1, 'input')).toBe(10 + 5 + 10);
    expect(s1.reduce((n, x) => n + x.replies, 0)).toBe(3);
    // Rows are per day, and two hours ago may be yesterday.
    expect([...new Set(s1.map((x) => x.model))].sort()).toEqual(['claude-x', 'claude-y']);
    expect(s1.reduce((n, x) => n + (x.costUsd ?? 0), 0)).toBeCloseTo(0.75);
    expect(report.sessions['claude:s1']).toMatchObject({ accountId: 'default', project: '/work/alpha', title: 'Refactor the session module' });
    expect(report.sessions['claude:s2']).toMatchObject({ accountId: 'work', project: '/work/beta', title: 'Named by hand' });
    expect(report.rows.every((x) => x.day === dayKey(NOW) || x.day === dayKey(NOW - 3 * HOUR) || x.day === dayKey(NOW - 2 * HOUR))).toBe(true);
  });

  it('reads only what changed: unchanged files are skipped, appended lines are read from where it stopped', async () => {
    const root = tmp();
    const dir = path.join(root, 'projects');
    const file = path.join(dir, 'alpha', 's1.jsonl');
    write(file, [assistant({ id: 'm1', session: 's1', t: NOW - HOUR, output: 100 })]);
    write(path.join(dir, 'alpha', 's2.jsonl'), [assistant({ id: 'm5', session: 's2', t: NOW - HOUR, output: 5 })]);
    const cacheFile = path.join(root, 'cache.json');
    const sources: UsageSource[] = [{ provider: 'claude', accountId: 'default', format: 'claude', dir }];
    const scanner = new UsageScanner({ cacheFile });
    expect((await scanner.scan(sources)).read).toBe(2);
    expect((await scanner.scan(sources)).read).toBe(0);

    // A repeated last reply split across two reads still counts once.
    appendFileSync(file, assistant({ id: 'm1', session: 's1', t: NOW - HOUR, output: 120 }) + '\n' + assistant({ id: 'm2', session: 's1', t: NOW, output: 30 }) + '\n');
    expect((await scanner.scan(sources)).read).toBe(1);
    const rows = scanner.report().rows.filter((x) => x.session === 'claude:s1');
    expect(sum(rows, 'output')).toBe(120 + 30);

    // The cache survives a restart: a new scanner with the same file reads nothing.
    await scanner.flush();
    const again = new UsageScanner({ cacheFile });
    expect((await again.scan(sources)).read).toBe(0);
    expect(sum(again.report().rows, 'output')).toBe(120 + 30 + 5);

    // A file that shrank (rewritten) is read from the start.
    write(file, [assistant({ id: 'm7', session: 's1', t: NOW, output: 3 })]);
    const later = new Date(NOW + 5000);
    utimesSync(file, later, later);
    expect((await again.scan(sources)).read).toBe(1);
    expect(sum(again.report().rows.filter((x) => x.session === 'claude:s1'), 'output')).toBe(3);
  });

  it('reads the usage of a reply megabytes long and skips huge lines without copying them whole', async () => {
    const root = tmp();
    const dir = path.join(root, 'projects');
    const big = 'x'.repeat(3 * 1024 * 1024);
    const huge = JSON.stringify({
      parentUuid: 'p',
      message: { model: 'claude-x', id: 'big', type: 'message', content: [{ type: 'text', text: big }], usage: { input_tokens: 7, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      requestId: 'r-big',
      type: 'assistant',
      timestamp: iso(NOW),
      cwd: '/work/alpha',
      sessionId: 's1',
    });
    const image = JSON.stringify({ type: 'user', sessionId: 's1', message: { role: 'user', content: [{ type: 'image', data: big }] } });
    write(path.join(dir, 'alpha', 's1.jsonl'), [image, huge, assistant({ id: 'm2', session: 's1', t: NOW, output: 1 })]);
    const scanner = new UsageScanner();
    await scanner.scan([{ provider: 'claude', accountId: 'default', format: 'claude', dir }]);
    const rows = scanner.report().rows;
    expect(sum(rows, 'output')).toBe(10);
    expect(sum(rows, 'input')).toBe(17);
  });

  it('copes with an empty or missing folder, and leaves out days before the range', async () => {
    const root = tmp();
    mkdirSync(path.join(root, 'empty'));
    const old = path.join(root, 'old', 'p', 'o.jsonl');
    write(old, [assistant({ id: 'x', session: 'o', t: NOW - 60 * 24 * HOUR })]);
    const scanner = new UsageScanner();
    const r = await scanner.scan([
      { provider: 'claude', accountId: 'default', format: 'claude', dir: path.join(root, 'empty') },
      { provider: 'claude', accountId: 'default', format: 'claude', dir: path.join(root, 'missing') },
      { provider: 'claude', accountId: 'default', format: 'claude', dir: path.join(root, 'old') },
    ]);
    expect(r.read).toBeLessThanOrEqual(1);
    expect(scanner.report().rows).toEqual([]);
    expect(scanner.report().sessions).toEqual({});
  });

  it('reads Codex rollouts: usage records with cached input split out, the model and folder, rate-limit samples', async () => {
    const root = tmp();
    const d = new Date(NOW);
    const day = path.join(root, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    const usage = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
    write(path.join(day, 'rollout-1.jsonl'), [
      JSON.stringify({ timestamp: iso(NOW - HOUR), type: 'session_meta', payload: { id: 'thread-1', cwd: '/work/gamma' } }),
      JSON.stringify({ timestamp: iso(NOW - HOUR), type: 'turn_context', payload: { model: 'gpt-x', cwd: '/work/gamma' } }),
      JSON.stringify({ timestamp: iso(NOW - HOUR), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…' }] } }),
      JSON.stringify({ timestamp: iso(NOW - HOUR), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the flaky test' }] } }),
      JSON.stringify({ timestamp: iso(NOW - HOUR), type: 'token_usage_record', payload: { response_id: 'r1', usage: usage(1000, 800, 50) } }),
      JSON.stringify({ timestamp: iso(NOW - HOUR + 1000), type: 'token_usage_record', payload: { response_id: 'r2', usage: usage(500, 400, 20) } }),
      // Counts are ignored once usage records exist; the rate limits are kept.
      JSON.stringify({
        timestamp: iso(NOW - HOUR + 2000),
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: usage(1500, 1200, 70), last_token_usage: usage(500, 400, 20) }, rate_limits: { limit_id: 'codex', primary: { used_percent: 42.4, window_minutes: 300, resets_at: Math.round((NOW + HOUR) / 1000) }, secondary: null } },
      }),
    ]);
    const scanner = new UsageScanner();
    await scanner.scan(transcriptSources('codex', 'default', path.join(root), root, {}));
    const report = scanner.report();
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ session: 'codex:thread-1', model: 'gpt-x', input: 300, cacheRead: 1200, output: 70, replies: 2 });
    expect(report.sessions['codex:thread-1']).toMatchObject({ project: '/work/gamma', title: 'Fix the flaky test' });
    const samples = scanner.samples().get('codex:default')!;
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ id: 'codex:primary', percent: 42, windowMins: 300 });
    expect(samples[0].resetsAt).toBeGreaterThan(NOW);
  });
});

describe('pace', () => {
  const five = (percent: number, resetsIn: number): RateLimit => ({ id: 'five_hour', label: '5-hour limit', percent, resetsAt: NOW + resetsIn, windowMins: 300 });

  it('uses the recent samples when they span long enough', () => {
    // 20% in the last hour, 60% used, reset in 3 hours: full in 2 hours, before the reset.
    const p = pace(five(60, 3 * HOUR), [[NOW - HOUR, 40], [NOW - 30 * 60_000, 50], [NOW, 60]], NOW)!;
    expect(p.basis).toBe('recent');
    expect(p.perHour).toBeCloseTo(20);
    expect(p.fullAt).toBeCloseTo(NOW + 2 * HOUR, -3);
    expect(p.atReset).toBe(100);
  });

  it('says it lasts (no fullAt) when the reset comes first', () => {
    const p = pace(five(30, HOUR), [[NOW - HOUR, 25], [NOW, 30]], NOW)!;
    expect(p.fullAt).toBeUndefined();
    expect(p.atReset).toBe(35);
  });

  it('falls back to the average since the window began, and says nothing too early or at the cap', () => {
    // Started 4 hours ago (reset in 1), 40% used: 10% an hour.
    const p = pace(five(40, HOUR), [[NOW, 40]], NOW)!;
    expect(p.basis).toBe('window');
    expect(p.perHour).toBeCloseTo(10);
    expect(p.fullAt).toBeUndefined();
    // Five minutes into the window there is nothing to tell.
    expect(pace(five(2, 5 * HOUR - 5 * 60_000), [[NOW, 2]], NOW)).toBeUndefined();
    expect(pace(five(100, HOUR), [[NOW - HOUR, 80], [NOW, 100]], NOW)).toBeUndefined();
  });

  it('keeps only the current window of the history', () => {
    const l = five(10, 4 * HOUR); // started an hour ago
    const kept = windowSamples([[NOW - 3 * HOUR, 90], [NOW - 2 * HOUR, 95], [NOW - 30 * 60_000, 4], [NOW, 10]], l);
    expect(kept).toEqual([[NOW - 30 * 60_000, 4], [NOW, 10]]);
    // Without a known start, a drop marks the reset.
    expect(windowSamples([[1, 90], [2, 95], [3, 4], [4, 10]], { id: 'x', label: 'x', percent: 10 })).toEqual([[3, 4], [4, 10]]);
  });
});

describe('limits book', () => {
  it('remembers reads with their time across restarts, keeps a history, and keeps the last read over an empty one', async () => {
    const file = path.join(tmp(), 'limits.json');
    const book = new LimitsBook(file);
    const l = (percent: number): RateLimit[] => [{ id: 'five_hour', label: '5-hour limit', percent, resetsAt: NOW + 3 * HOUR, windowMins: 300 }];
    book.record('claude', 'default', l(10), { planLimits: true }, NOW - 40 * 60_000);
    book.record('claude', 'default', l(20), {}, NOW - 20 * 60_000);
    // The same percent again shortly after adds no sample.
    book.record('claude', 'default', l(20), {}, NOW - 19 * 60_000);
    book.record('claude', 'default', [], {}, NOW);
    const r = book.report('claude', 'default', NOW);
    expect(r.limits[0].percent).toBe(20);
    expect(r.readAt).toBe(NOW - 19 * 60_000);
    expect(r.planLimits).toBe(true);
    expect(r.history.five_hour).toEqual([[NOW - 40 * 60_000, 10], [NOW - 20 * 60_000, 20]]);
    expect(r.pace.five_hour?.basis).toBe('recent');
    await book.flush();
    const again = new LimitsBook(file).report('claude', 'default', NOW);
    expect(again.limits).toEqual(r.limits);
    expect(again.history).toEqual(r.history);

    // An account without plan limits says so.
    book.record('claude', 'api', [], { planLimits: false }, NOW);
    expect(book.report('claude', 'api', NOW)).toMatchObject({ limits: [], planLimits: false, readAt: NOW });
  });
});

describe('usage service', () => {
  it('reports limits with history after a read, remembers them, and merges transcripts with the Demo', async () => {
    const home = tmp('sable-usage-app-');
    const projects = path.join(tmp(), 'projects');
    write(path.join(projects, 'p', 's1.jsonl'), [assistant({ id: 'm1', session: 's1', t: NOW - HOUR, output: 100 })]);
    const app = new App({ home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true });
    apps.push(app);
    registerUsage(app, { sources: () => [{ provider: 'claude', accountId: 'default', format: 'claude', dir: projects }] });
    const events: BridgeEvent[] = [];
    app.subscribe((e) => events.push(e));

    await app.call('provider.limits', { provider: 'demo' });
    const report = events.find((e): e is Extract<BridgeEvent, { type: 'limits.report' }> => e.type === 'limits.report')!.report;
    expect(report.limits.map((l) => l.id)).toEqual(['five_hour', 'seven_day']);
    expect(report.history.five_hour.length).toBeGreaterThan(3);
    expect(report.pace.five_hour).toBeDefined();
    expect(await app.call('usage.limits', {})).toHaveLength(1);

    await app.call('usage.report', { refresh: true });
    const t0 = Date.now();
    while (!events.some((e) => e.type === 'usage.updated') && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
    const usage = (events.find((e) => e.type === 'usage.updated') as Extract<BridgeEvent, { type: 'usage.updated' }>).report;
    expect(usage.scanning).toBe(false);
    expect(usage.rows.some((r) => r.session === 'claude:s1' && r.output === 100)).toBe(true);
    expect(usage.rows.some((r) => r.session.startsWith('demo:'))).toBe(true);
  });
});
