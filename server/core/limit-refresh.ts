import type { AccountCap, AuthState, RateLimit } from '../../shared/protocol';
import { capPercent, isSessionWindow, windowModel } from '../../shared/limit-windows';
import { rankAccount, USE_FIRST_SESSION_CEILING } from '../../shared/use-first';
import type { Provider } from '../providers/types';

/** One request per provider instance (one account), taken by its next idle turn-end read. */
export const limitsAfterTurn = new WeakSet<Provider>();

/** A sign-in billed per token has no plan windows to check, even if an old reading survived. */
export function isApiKeyAuth(auth: AuthState): boolean {
  return /api|console/i.test(auth.method ?? '') || /^(api[ _-]?key|console)$/i.test(auth.plan ?? '');
}

/** The account is held for at least one model. A partial reading may contain only the full window. */
export function heldForLimits(limits: RateLimit[], cap: AccountCap | undefined, now: number): boolean {
  const live = limits.filter(l => !l.resetsAt || l.resetsAt > now);
  if (live.some(l => l.percent >= 100 || (isSessionWindow(l) && l.percent >= Math.min(USE_FIRST_SESSION_CEILING, capPercent(cap?.session))))) return true;
  const account = { id: '', signedIn: true, limits: live, cap };
  return [undefined, ...new Set(live.map(windowModel).filter(Boolean))].some(model => {
    const { state } = rankAccount(account, now, model);
    return state === 'held' || state === 'spent';
  });
}
