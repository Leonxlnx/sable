import type { AuthState, ProviderId, RateLimit } from '@shared/protocol';
import { isScopedWindow, planText } from './format';
import { livePercent } from './room';

/**
 * How big an account's plan limits are, to add accounts of one agent together. Claude in units of
 * Pro: Max 5x = 5, premium Team seat = 6.25, Ultra = 10, Max 20x = 20 (so one Pro and one Ultra
 * hold 1.1 Ultra). Where the plan is named, Sable reads it from the agent: Claude's `auth status`
 * gives the subscription ("max", "team") and the CLI's own name for it ("Claude Ultra account"),
 * Codex's `account/read` its plan type ("pro"). Plain "Max" (tier not reported) counts as 5x, a
 * Team seat as premium unless it says standard. Codex weights are only known within one plan.
 */
export interface PlanSize {
  weight: number;
  /** The plan's short name, the unit when it is the largest an agent has ("Ultra"). */
  name: string;
}

const CLAUDE: [RegExp, PlanSize][] = [
  [/\bultra\b/, { weight: 10, name: 'Ultra' }],
  [/20x/, { weight: 20, name: 'Max 20x' }],
  [/\b5x/, { weight: 5, name: 'Max 5x' }],
  [/\b(team|seat)\b.*\bstandard\b|\bstandard\b.*\b(team|seat)\b/, { weight: 1.25, name: 'Team' }],
  [/\b(team|seat|premium)\b/, { weight: 6.25, name: 'Team' }],
  [/\bmax\b/, { weight: 5, name: 'Max' }],
  [/\bpro\b/, { weight: 1, name: 'Pro' }],
];

const CODEX: [RegExp, PlanSize][] = [[/^pro$/, { weight: 1, name: 'Pro' }]];

/** The plan's size, or undefined when it is not known (a free plan, Enterprise, an API key). */
export function planSize(provider: ProviderId, auth: AuthState | undefined): PlanSize | undefined {
  if (!auth?.loggedIn) return undefined;
  const shown = planShort(auth)?.toLowerCase();
  if (!shown || shown === 'api key') return undefined;
  if (provider === 'codex') {
    const raw = (auth.planId ?? shown).toLowerCase();
    return CODEX.find(([re]) => re.test(raw) || re.test(shown))?.[1];
  }
  // The shown name decides ("Ultra" while the raw id says "max"); a plain "Max" may have its tier
  // in the raw id ("max_20x").
  const hit = CLAUDE.find(([re]) => re.test(shown))?.[1];
  if (hit && hit.name !== 'Max') return hit;
  const text = `${shown} ${(auth.planId ?? '').toLowerCase().replace(/[_-]+/g, ' ')}`;
  return CLAUDE.find(([re]) => re.test(text))?.[1];
}

/** The plan as a short word for rows ("Ultra", "Team", "Pro"). */
export function planShort(auth: AuthState | undefined): string | undefined {
  return planText(auth)?.replace(/\s+plan$/i, '');
}

/** The account's window for the whole plan: the 5-hour one (`short`) or the week. */
export function poolWindow(limits: RateLimit[] | undefined, kind: 'short' | 'week'): RateLimit | undefined {
  const week = (l: RateLimit) => (l.windowMins ?? 0) >= 1440;
  return limits?.find((l) => !isScopedWindow(l) && !!l.windowMins && (kind === 'week' ? week(l) : !week(l)));
}

export interface PoolInput {
  provider: ProviderId;
  usable: boolean;
  unmetered?: boolean;
  limits: RateLimit[] | undefined;
  auth: AuthState | undefined;
}

export interface PoolPart {
  /** In units of the largest plan counted. */
  left: number;
  size: number;
  /** Percent of the whole used, 0 to 100. */
  used: number;
}

export interface PoolTotal {
  provider: ProviderId;
  /** The largest plan counted: what one unit is ("Ultra"). */
  unit: string;
  /** Accounts counted, by plan, largest first. */
  plans: { name: string; count: number }[];
  accounts: number;
  week: PoolPart;
  /** The 5-hour windows, where the accounts have them. */
  short?: PoolPart;
}

/**
 * What is left across one agent's accounts, each weighted by its plan, in units of the largest
 * plan among them. Only accounts with a known plan size and a weekly figure count; accounts of an
 * agent that all have one plan count equally whatever it is. Agents are never added together, and
 * an agent with fewer than two such accounts gets no total (its row says it all).
 */
export function poolTotals(inputs: PoolInput[], now: number): PoolTotal[] {
  const out: PoolTotal[] = [];
  const agents = [...new Set(inputs.map((i) => i.provider))];
  for (const provider of agents) {
    const live = inputs.filter((i) => i.provider === provider && i.usable && !i.unmetered && poolWindow(i.limits, 'week'));
    const names = new Set(live.map((i) => planShort(i.auth) ?? ''));
    const one = names.size === 1 && !names.has('');
    const counted = live.flatMap((i) => {
      const size = planSize(provider, i.auth) ?? (one ? { weight: 1, name: planShort(i.auth)! } : undefined);
      return size ? [{ i, size }] : [];
    });
    if (counted.length < 2) continue;
    const top = counted.reduce((a, b) => (b.size.weight > a.size.weight ? b : a)).size;
    const part = (rows: { w: number; used: number }[]): PoolPart => {
      const size = rows.reduce((s, r) => s + r.w, 0);
      const left = rows.reduce((s, r) => s + r.w * (1 - r.used / 100), 0);
      return { size: size / top.weight, left: left / top.weight, used: size ? Math.round((1 - left / size) * 1000) / 10 : 0 };
    };
    const week = part(counted.map(({ i, size }) => ({ w: size.weight, used: livePercent(poolWindow(i.limits, 'week')!, now) })));
    // A 5-hour window is no use while the week it belongs to is used up.
    const shortRows = counted.flatMap(({ i, size }) => {
      const s = poolWindow(i.limits, 'short');
      if (!s) return [];
      const weekFull = livePercent(poolWindow(i.limits, 'week')!, now) >= 100;
      return [{ w: size.weight, used: weekFull ? 100 : livePercent(s, now) }];
    });
    const plans = new Map<string, { name: string; count: number; weight: number }>();
    for (const { size } of counted) {
      const p = plans.get(size.name) ?? { name: size.name, count: 0, weight: size.weight };
      p.count++;
      plans.set(size.name, p);
    }
    out.push({
      provider,
      unit: top.name,
      plans: [...plans.values()].sort((a, b) => b.weight - a.weight).map(({ name, count }) => ({ name, count })),
      accounts: counted.length,
      week,
      ...(shortRows.length >= 2 ? { short: part(shortRows) } : {}),
    });
  }
  return out;
}

/** Percent of an agent's weeks used across its accounts: the figure the Usage page's meter draws (usage is always said as used, `words.ts`). */
export function poolUsedPercent(t: PoolTotal): number {
  return Math.min(100, Math.round(t.week.used));
}

/** The weeks used in units of the largest plan: the whole less what is left. */
export const poolWeeksUsed = (t: PoolTotal) => Math.max(0, t.week.size - t.week.left);

/** "4.6 of 9.4 Ultra weeks used". */
export function poolWeeksText(t: PoolTotal): string {
  return `${units(poolWeeksUsed(t))} of ${units(t.week.size)} ${t.unit} weeks used`;
}

/** "2.6", "2", "0.4", "12": one decimal while it matters. */
export function units(n: number): string {
  const v = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  return String(v);
}
