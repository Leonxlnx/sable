import type { RateLimit } from '@shared/protocol';
import { clock, duration } from './format';
import { livePercent, tightest } from './room';

/**
 * How a plan limit is said, everywhere an account's usage is shown or spoken (the sidebar footer's
 * ring and its tooltip, the switcher's rows and the pane beside them, the session header's account,
 * the Usage page, the limit notice, the warnings): always the share USED of a window, never what is
 * left. A ring and a meter fill as the window is used. A reset is "resets in 3h 20m" within a day,
 * "resets Tue 14:00" further out. One reading and one rounding (`usedPercent`), so two figures of
 * the same account in view at once are the same figure.
 */

/** The share of a window used, 0 to 100, rounded once: a window whose reset has passed reads 0. */
export function usedPercent(l: RateLimit, now: number): number {
  return Math.round(livePercent(l, now));
}

/** "62% used". */
export const usedText = (pct: number) => `${pct}% used`;

/**
 * The window that decides how full an account is (the one used most; among equals the one that
 * resets later) with its figure: the footer's ring, the account's row in every menu. Undefined while
 * nothing is known.
 */
export function accountUsed(limits: RateLimit[] | undefined, now: number): { limit: RateLimit; pct: number } | undefined {
  const limit = tightest(limits, now);
  return limit ? { limit, pct: usedPercent(limit, now) } : undefined;
}

/** "resets in 3h 20m" within a day, "resets Tue 14:00" or "resets 2 Dec, 09:00" further out; undefined when no reset is ahead. */
export function resetsText(resetsAt: number | undefined, now: number): string | undefined {
  if (!resetsAt || resetsAt <= now) return undefined;
  return resetsAt - now < 86_400_000 ? `resets in ${duration(resetsAt - now)}` : `resets ${clock(resetsAt, now)}`;
}

/** The same with a capital, to start a line: "Resets in 3h 20m". */
export function resetsLine(resetsAt: number | undefined, now: number): string | undefined {
  const t = resetsText(resetsAt, now);
  return t && t.charAt(0).toUpperCase() + t.slice(1);
}

/** A window's state in words: "used up" at its cap, "82% used" otherwise. */
export function windowState(l: RateLimit, now: number): string {
  const pct = usedPercent(l, now);
  return pct >= 100 ? 'used up' : usedText(pct);
}
