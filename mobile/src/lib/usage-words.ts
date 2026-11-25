import type { LimitPace, RateLimit } from '@shared/protocol';
import { resetIn } from '@desk/lib/format';

/**
 * How a plan limit is said on the phone, as the desktop says it (src/features/usage/words.ts and
 * format.ts; that module reaches into the desktop's own aliases, so its rules are kept here, the same):
 * always the share USED of a window ("62% used"), a meter that fills as it is used, a reset as
 * "resets in 3h 20m" within a day and "resets Tue 14:00" further out, one reading and one rounding.
 */

const TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false };
const timeOf = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', TIME);
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** "03:40" today, "Tue 03:40" on another day this week, "17 Nov, 09:00" later. */
export function clock(ts: number, now = Date.now()): string {
  const time = timeOf(ts);
  if (sameDay(ts, now)) return time;
  if (Math.abs(ts - now) < 6 * 86_400_000) return `${new Date(ts).toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
  return `${new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${time}`;
}

/** The share of a window used, 0 to 100, rounded once: a window whose reset has passed reads 0. */
export const usedPercent = (l: RateLimit, now: number) => Math.round(l.resetsAt && l.resetsAt <= now ? 0 : Math.max(0, Math.min(100, l.percent)));

/** "62% used", "used up" at the cap. */
export const usedWords = (pct: number) => (pct >= 100 ? 'used up' : `${pct}% used`);

/** "resets in 3h 20m" within a day, "resets Tue 14:00" further out; undefined when no reset is ahead. */
export function resetsText(resetsAt: number | undefined, now: number): string | undefined {
  if (!resetsAt || resetsAt <= now) return undefined;
  return resetsAt - now < 86_400_000 ? `resets in ${resetIn(resetsAt, now)}` : `resets ${clock(resetsAt, now)}`;
}

/** Amber near a cap, red at it: the only colours a limit uses, and only on its meter. */
export function windowLevel(l: RateLimit, now: number): 'amber' | 'red' | undefined {
  if (l.resetsAt && l.resetsAt <= now) return undefined;
  if (l.percent >= 100) return 'red';
  if (l.percent >= 80) return 'amber';
  return undefined;
}

/** One sentence about where the pace leads, or nothing (the desktop's paceText, lower case: it follows the reset). */
export function paceText(l: RateLimit, p: LimitPace | undefined, now: number): { text: string; warn: boolean } | undefined {
  if (!p || l.percent >= 100 || (l.resetsAt && l.resetsAt <= now)) return undefined;
  if (p.fullAt) return { text: `runs out ${clock(p.fullAt, now)}`, warn: true };
  if (p.perHour <= 0.01) return l.resetsAt ? { text: 'steady', warn: false } : undefined;
  if (p.atReset !== undefined) return { text: `on pace for ${Math.round(p.atReset)}%`, warn: false };
  return undefined;
}

/** Where an even pace would stand now (0..1) when the window's length and reset are known: the pace mark on the meter. */
export function evenPace(l: RateLimit, now: number): number | undefined {
  if (!l.windowMins || !l.resetsAt || l.resetsAt <= now) return undefined;
  const u = 1 - (l.resetsAt - now) / (l.windowMins * 60_000);
  return u > 0.02 && u < 0.98 ? u : undefined;
}

/** The window an account is nearest its limit in (the one used most; among equals the later reset). */
export function tightestUse(limits: RateLimit[], now: number): number {
  let top = -1;
  for (const l of limits) top = Math.max(top, usedPercent(l, now));
  return top;
}
