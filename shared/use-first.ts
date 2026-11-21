import type { AccountCap, RateLimit } from './protocol';
import { capPercent, isAllModelsWeekly, isSessionWindow, windowForModel, windowModel } from './limit-windows';

/**
 * Which account to use first so that the least quota expires unused: the one whose unused week
 * ends soonest. (Earliest deadline first: work put on a later-ending account while an earlier one
 * still has room can always be moved to the earlier one without losing anything, never the other
 * way round.) Pure: the bridge picks the next account by it at a limit, the desktop and the phone
 * list accounts in this order.
 */

/** Points of the week below which an account is not worth moving to (it would be at its limit at once). */
export const USE_FIRST_FLOOR = 5;
/** The 5-hour window at or past this holds the account until that window resets. */
export const USE_FIRST_SESSION_CEILING = 97;

export interface UseFirstAccount {
  id: string;
  signedIn: boolean;
  /** False: billed per token (an API key): no week to use up. */
  planLimits?: boolean;
  limits?: RateLimit[];
  cap?: AccountCap;
  /** Plan size in units of Pro; decides between weeks that end together. */
  weight?: number;
}

export interface UseFirstRank {
  id: string;
  /**
   * `now`: has room and takes work now. `held`: has room this week, but a window holds it until
   * `until` (the 5-hour window, or the model's own week). `spent`: nothing left this week (back at
   * `expiresAt`). `unknown`: its week was never read. `off`: signed out, or billed per token.
   */
  state: 'now' | 'held' | 'spent' | 'unknown' | 'off';
  /** Points of the week still unused within the account's cap (for the model, when one is named). */
  left?: number;
  /** When the week ends: what is unused then is gone. */
  expiresAt?: number;
  /** When a hold ends. */
  until?: number;
}

const ORDER: Record<UseFirstRank['state'], number> = { now: 0, held: 1, spent: 2, unknown: 3, off: 4 };

/** A per-model window over a week ("Weekly · Fable"), not a 5-hour one. */
const modelWeek = (l: RateLimit) => !!windowModel(l) && !l.id.startsWith('five_hour') && (l.windowMins === undefined || l.windowMins >= 10_080);

/** One account's place: what it has left this week for `model` (undefined: the week of all models only), and whether it takes work now. */
export function rankAccount(a: UseFirstAccount, now: number, model?: string): UseFirstRank {
  if (!a.signedIn || a.planLimits === false) return { id: a.id, state: 'off' };
  const live = (a.limits ?? []).filter((l) => !(l.resetsAt && l.resetsAt <= now));
  const week = live.find(isAllModelsWeekly);
  if (!week) return { id: a.id, state: 'unknown' };
  let left = capPercent(a.cap?.weekly) - week.percent;
  const holds: (number | undefined)[] = [];
  // The model's own week bounds what the chat can use; a full one holds it until that week ends.
  if (model !== undefined)
    for (const l of live) {
      if (!modelWeek(l) || !windowForModel(l, model)) continue;
      left = Math.min(left, 100 - l.percent);
      if (l.percent >= 100) holds.push(l.resetsAt);
    }
  left = Math.max(0, Math.round(left * 10) / 10);
  const base = { id: a.id, left, ...(week.resetsAt ? { expiresAt: week.resetsAt } : {}) };
  if (week.percent >= capPercent(a.cap?.weekly) || (left < USE_FIRST_FLOOR && !holds.length)) return { ...base, state: 'spent' };
  const five = live.find(isSessionWindow);
  if (five && five !== week && five.percent >= Math.min(USE_FIRST_SESSION_CEILING, capPercent(a.cap?.session))) holds.push(five.resetsAt);
  if (!holds.length) return { ...base, state: 'now' };
  const known = holds.filter((t): t is number => t !== undefined);
  return { ...base, state: 'held', ...(known.length === holds.length ? { until: Math.max(...known) } : {}) };
}

/**
 * The accounts in the order to use them: those that take work now by the end of their week (the
 * soonest first; between weeks that end together, the one with more left for its plan size), then
 * those held (the soonest free first), those spent (the soonest back first), then the ones not read
 * and the ones that are off, each group in the order given.
 */
export function useFirst(accounts: UseFirstAccount[], now: number, model?: string): UseFirstRank[] {
  const weight = new Map(accounts.map((a) => [a.id, a.weight ?? 1]));
  const at = new Map(accounts.map((a, i) => [a.id, i]));
  const far = Number.MAX_SAFE_INTEGER;
  const key = (r: UseFirstRank) => (r.state === 'now' ? (r.expiresAt ?? far) : r.state === 'held' ? (r.until ?? far) : r.state === 'spent' ? (r.expiresAt ?? far) : 0);
  // Weeks ending within the same quarter of an hour count as ending together.
  const slot = (t: number) => (t === far || t === 0 ? t : Math.round(t / 900_000));
  return accounts
    .map((a) => rankAccount(a, now, model))
    .sort(
      (x, y) =>
        ORDER[x.state] - ORDER[y.state] ||
        slot(key(x)) - slot(key(y)) ||
        (x.state === 'now' ? (y.left ?? 0) * weight.get(y.id)! - (x.left ?? 0) * weight.get(x.id)! : 0) ||
        at.get(x.id)! - at.get(y.id)!,
    );
}

/** The account to use now among `accounts` (never `except`); undefined when none takes work now. */
export function firstToUse(accounts: UseFirstAccount[], now: number, model?: string, except?: string): string | undefined {
  return useFirst(accounts, now, model).find((r) => r.state === 'now' && r.id !== except)?.id;
}
