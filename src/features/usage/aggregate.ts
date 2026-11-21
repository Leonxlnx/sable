import type { ProviderId, UsageReport, UsageRow, UsageSession, UsageTokens } from '@shared/protocol';

/** What the Usage view sums from the bridge's rows: per day, per group, ranked lists. Pure, so it is easy to test. */

export type Grouping = 'model' | 'project' | 'account';

/**
 * The work in a row: input, output and cache writes. Cache reads are left out of every headline,
 * bar and rank: they dominate and would make each figure look ten times larger than the work.
 */
export const rowTotal = (r: UsageTokens) => r.input + r.output + r.cacheWrite;

const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** The `days` local days ending today, oldest first. */
export function dayKeys(days: number, now = Date.now()): string[] {
  const out: string[] = [];
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) out.push(dayKey(d.getTime() - i * 86_400_000));
  return out;
}

export interface Ranked {
  key: string;
  label: string;
  /** The agent a model ranks under (model rows show its mark). */
  provider?: ProviderId;
  total: number;
  tokens: UsageTokens;
  costUsd?: number;
}

export interface RankedSession extends Ranked {
  session: UsageSession;
}

export interface DayBar {
  day: string;
  total: number;
  /** Totals per shown group (same order as `Summary.groups`), the last one "Other" when there is one. */
  parts: number[];
  tokens: UsageTokens;
  costUsd?: number;
}

export interface Summary {
  days: string[];
  bars: DayBar[];
  /** The groups the chart stacks: the largest three, then everything else as one. */
  groups: { key: string; label: string; total: number }[];
  total: number;
  today: number;
  costUsd?: number;
  tokens: UsageTokens;
  models: Ranked[];
  projects: Ranked[];
  accounts: Ranked[];
  sessions: RankedSession[];
}

export interface Namers {
  model: (id: string, provider: string) => string;
  account: (provider: string, accountId: string) => string;
  /** Whether an account's reported cost is real money (an API key), not a plan's price estimate. */
  paysPerToken?: (provider: string, accountId: string) => boolean;
}

const zero = (): UsageTokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const addTokens = (a: UsageTokens, r: UsageTokens) => {
  a.input += r.input;
  a.output += r.output;
  a.cacheRead += r.cacheRead;
  a.cacheWrite += r.cacheWrite;
};

/** Up to this many groups get their own tone; the rest stack as "Other". */
export const SHOWN_GROUPS = 3;

export function summarize(report: UsageReport, days: number, grouping: Grouping, names: Namers, now = Date.now()): Summary {
  const keys = dayKeys(days, now);
  const from = keys[0];
  const today = keys[keys.length - 1];
  // Cost counts only where it is money actually paid (API-key accounts).
  const paid = (r: UsageRow) => {
    const s = report.sessions[r.session];
    return !!s && !!names.paysPerToken?.(s.provider, s.accountId);
  };
  const rows = report.rows.filter((r) => r.day >= from && r.day <= today).map((r) => (r.costUsd && !paid(r) ? { ...r, costUsd: undefined } : r));

  const groupOf = (r: UsageRow): { key: string; label: string } => {
    const s = report.sessions[r.session];
    if (grouping === 'model') return { key: `${s?.provider ?? ''}\t${r.model}`, label: r.model ? names.model(r.model, s?.provider ?? '') : 'Unknown model' };
    if (grouping === 'project') return { key: s?.project || '?', label: s?.project || 'Unknown folder' };
    return { key: `${s?.provider}:${s?.accountId}`, label: s ? names.account(s.provider, s.accountId) : 'Unknown account' };
  };

  const rank = (keyOf: (r: UsageRow) => { key: string; label: string; provider?: ProviderId } | undefined) => {
    const map = new Map<string, Ranked>();
    for (const r of rows) {
      const g = keyOf(r);
      if (!g) continue;
      const e: Ranked = map.get(g.key) ?? { key: g.key, label: g.label, provider: g.provider, total: 0, tokens: zero() };
      e.total += rowTotal(r);
      addTokens(e.tokens, r);
      if (r.costUsd) e.costUsd = (e.costUsd ?? 0) + r.costUsd;
      map.set(g.key, e);
    }
    return [...map.values()].filter((e) => e.total > 0).sort((a, b) => b.total - a.total);
  };

  const groupRank = rank(groupOf);
  const shown = groupRank.length > SHOWN_GROUPS + 1 ? groupRank.slice(0, SHOWN_GROUPS) : groupRank;
  const index = new Map(shown.map((g, i) => [g.key, i]));
  const other = groupRank.length > shown.length;
  const groups = shown.map((g) => ({ key: g.key, label: g.label, total: g.total }));
  if (other) groups.push({ key: '\u0000other', label: 'Other', total: groupRank.slice(shown.length).reduce((n, g) => n + g.total, 0) });

  const byDay = new Map<string, DayBar>(keys.map((d) => [d, { day: d, total: 0, parts: groups.map(() => 0), tokens: zero() }]));
  const tokens = zero();
  let cost = 0;
  for (const r of rows) {
    const bar = byDay.get(r.day);
    if (!bar) continue;
    const t = rowTotal(r);
    bar.total += t;
    addTokens(bar.tokens, r);
    addTokens(tokens, r);
    if (r.costUsd) {
      bar.costUsd = (bar.costUsd ?? 0) + r.costUsd;
      cost += r.costUsd;
    }
    const gi = index.get(groupOf(r).key) ?? groups.length - 1;
    if (gi >= 0) bar.parts[gi] += t;
  }
  const bars = keys.map((d) => byDay.get(d)!);

  const sessions = rank((r) => ({ key: r.session, label: report.sessions[r.session]?.title || 'Untitled session' }))
    .slice(0, 8)
    .map((e) => ({ ...e, session: report.sessions[e.key] }))
    .filter((e): e is RankedSession => !!e.session);

  return {
    days: keys,
    bars,
    groups,
    total: bars.reduce((n, b) => n + b.total, 0),
    today: bars[bars.length - 1]?.total ?? 0,
    costUsd: cost > 0 ? cost : undefined,
    tokens,
    models: rank((r) => {
      const provider = report.sessions[r.session]?.provider;
      return { key: `${provider ?? ''}\t${r.model}`, label: r.model ? names.model(r.model, provider ?? '') : 'Unknown model', provider };
    }),
    projects: rank((r) => {
      const p = report.sessions[r.session]?.project;
      return { key: p || '?', label: p || 'Unknown folder' };
    }),
    accounts: rank((r) => {
      const s = report.sessions[r.session];
      return s ? { key: `${s.provider}:${s.accountId}`, label: names.account(s.provider, s.accountId) } : undefined;
    }),
    sessions,
  };
}

/** "12.4M", "860k", "4.2k", "312": compact token figures. */
export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

/** A tidy axis maximum and step for `max`: 1, 2 or 5 times a power of ten. */
export function niceScale(max: number, ticks = 3): { top: number; step: number } {
  if (max <= 0) return { top: 1, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  return { top: Math.ceil(max / step) * step, step };
}

/** Axis labels: compact, without trailing zeros ("3B", "1.5B", "250M"). */
export function axisLabel(n: number): string {
  return compact(n).replace(/\.0+(?=[kMB]$)/, '').replace(/(\.\d*?)0+(?=[kMB]$)/, '$1');
}
