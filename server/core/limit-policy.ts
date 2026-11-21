import type { AccountCap, LimitsMeta, ProviderId, RateLimit } from '../../shared/protocol';
import { capPercent, isAllModelsWeekly, isSessionWindow, windowForModel, windowModel } from '../../shared/limit-windows';

// The window helpers live in shared/ (the UI and the phone order accounts by them too).
export { capPercent, isAllModelsWeekly, isSessionWindow, windowForModel, windowModel };

/**
 * What a session does at a plan limit, in this order: carry on with credits (or extra usage) when
 * the account allows it in Sable and the agent has them, otherwise move to the next account when
 * that setting is on and one has room, otherwise stop with the notice.
 */
export type AtLimit = 'credits' | 'next' | 'stop';

export function decideAtLimit(o: { creditsAllowed: boolean; creditsAvailable: boolean; continueAtLimit: boolean; next?: string }): AtLimit {
  if (o.creditsAllowed && o.creditsAvailable) return 'credits';
  if (o.continueAtLimit && o.next) return 'next';
  return 'stop';
}

/** The agent says the account has credits or extra usage that can carry it past a limit. */
export function creditsAvailable(meta: LimitsMeta | undefined): boolean {
  if (!meta) return false;
  if (meta.extra?.enabled) return !meta.extra.limit || (meta.extra.used ?? 0) < meta.extra.limit;
  const c = meta.credits;
  if (!c) return false;
  if (c.unlimited) return true;
  const n = Number(c.balance);
  return c.balance !== undefined ? Number.isFinite(n) && n > 0 : !!c.has;
}

/** The session's account is past a limit and the agent carries it on credits or extra usage. */
export const runningOnCredits = (meta: LimitsMeta | undefined) => !!(meta?.extra?.inUse || meta?.credits?.inUse);

/** The key a per-account credits choice is stored under (`AppSettings.creditsAtLimit`). */
export const creditsKey = (provider: ProviderId, accountId: string) => `${provider}:${accountId}`;

export interface ResetAlert {
  at: number;
  provider: ProviderId;
  accountId: string;
  window: string;
}

/**
 * The next moment a full window resets, among the accounts given: windows at 100% whose reset is
 * after `now`. Undefined when no capped window has a reset ahead. Ties keep the order given.
 */
export function nextResetAlert(accounts: { provider: ProviderId; accountId: string; limits: RateLimit[] }[], now: number): ResetAlert | undefined {
  let best: ResetAlert | undefined;
  for (const a of accounts)
    for (const l of a.limits) {
      if (l.percent < 100 || !l.resetsAt || l.resetsAt <= now) continue;
      if (!best || l.resetsAt < best.at) best = { at: l.resetsAt, provider: a.provider, accountId: a.accountId, window: l.label };
    }
  return best;
}

/** Full windows whose reset fell in (since, now]: what to announce when the timer fires. */
export function dueResets(accounts: { provider: ProviderId; accountId: string; limits: RateLimit[] }[], since: number, now: number): ResetAlert[] {
  const out: ResetAlert[] = [];
  for (const a of accounts)
    for (const l of a.limits) if (l.percent >= 100 && l.resetsAt && l.resetsAt > since && l.resetsAt <= now) out.push({ at: l.resetsAt, provider: a.provider, accountId: a.accountId, window: l.label });
  return out.sort((x, y) => x.at - y.at);
}

// ── caps: "use up to" per account ──

/** The account has a cap below 100% on some window. */
export const hasCap = (cap: AccountCap | undefined) => !!cap && (capPercent(cap.weekly) < 100 || capPercent(cap.session) < 100);

export interface CapReached {
  /** Which cap: the weekly or 5-hour one the person set, or a full window of the model in use. */
  kind: 'weekly' | 'session' | 'model';
  /** The cap in percent (100 for a full model window). */
  cap: number;
  percent: number;
  /** The window as the limit rows name it. */
  label: string;
  resetsAt?: number;
}

/**
 * Whether an account is past the cap set for it, with the limits known: the all-models weekly
 * window against the weekly cap, the 5-hour window against the 5-hour cap, and a full per-model
 * window when the session uses that model. Windows whose reset has passed are not counted.
 * Undefined when it is under its cap (or has none).
 */
export function capReached(limits: RateLimit[] | undefined, cap: AccountCap | undefined, model: string | undefined, now = Date.now()): CapReached | undefined {
  if (!hasCap(cap)) return undefined;
  const live = (limits ?? []).filter((l) => !(l.resetsAt && l.resetsAt <= now));
  const weekly = capPercent(cap!.weekly);
  const w = weekly < 100 ? live.find(isAllModelsWeekly) : undefined;
  if (w && w.percent >= weekly) return { kind: 'weekly', cap: weekly, percent: w.percent, label: w.label, resetsAt: w.resetsAt };
  const session = capPercent(cap!.session);
  const s = session < 100 ? live.find(isSessionWindow) : undefined;
  if (s && s.percent >= session) return { kind: 'session', cap: session, percent: s.percent, label: s.label, resetsAt: s.resetsAt };
  const full = model ? live.find((l) => l.percent >= 100 && windowModel(l) && windowForModel(l, model)) : undefined;
  if (full) return { kind: 'model', cap: 100, percent: full.percent, label: full.label, resetsAt: full.resetsAt };
  return undefined;
}

/** The line in the chat when a session moves (or cannot): "Ultra1 reached its 95% cap". */
export function capReason(name: string, r: CapReached): string {
  if (r.kind === 'model') return `${name} used up ${r.label}`;
  return `${name} reached its ${r.cap}% ${r.kind === 'session' ? '5-hour ' : ''}cap`;
}
