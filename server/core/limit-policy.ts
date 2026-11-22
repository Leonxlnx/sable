import type { AccountCap, LimitsMeta, ProviderId, RateLimit, TimelineItem } from '../../shared/protocol';
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

// ── a limit met by background work (sub-agents, workflows) after the chat's own turn ended ──
//
// The rule: the first refusal writes the chat's one limit notice. The decision (the same as for a
// turn: credits are not offered, so the next account by use first, else the notice and "Continue at
// reset") is made once the refusals stop coming: 3 s after the latest, at most 15 s after the first,
// or at once when no background work runs any more. What still runs then works on the account that
// is at its limit and will be refused with its next request: it is stopped at the limit and the
// chat moves. A turn that begins meanwhile (a notification waking the agent) takes over: its refusal
// says it in the same notice and the turn's path moves the chat.

/** How long after a refusal of background work the next one is waited for. */
export const BACKGROUND_LIMIT_SETTLE_MS = 3_000;
/** How long after the first refusal the decision waits at most. */
export const BACKGROUND_LIMIT_MAX_MS = 15_000;

/** Milliseconds until the decision on a limit met by background work (0: now). */
export function backgroundLimitDue(o: { first: number; last: number; now: number; running: number; settleMs?: number; maxMs?: number }): number {
  if (o.running <= 0) return 0;
  const at = Math.min(o.last + (o.settleMs ?? BACKGROUND_LIMIT_SETTLE_MS), o.first + (o.maxMs ?? BACKGROUND_LIMIT_MAX_MS));
  return Math.max(0, at - o.now);
}

/** At most this many background agents are named to the agent after a move, each cut to `NAME_MAX` characters. */
const NAMES_MAX = 12;
const NAME_MAX = 90;

/**
 * Background agents a plan limit stopped (`AgentStats.limit` on a stopped or failed background
 * step; `only`: these steps), as the agent knows them: the task it gave, the kind, and its own call
 * id. Bounded.
 */
export function limitStoppedAgents(items: readonly TimelineItem[], only?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  let more = 0;
  for (const i of items) {
    if (i.type !== 'tool' || (only && !only.has(i.id))) continue;
    const a = i.result?.agent;
    const ended = a?.background === 'stopped' || a?.background === 'failed' || i.workflow?.status === 'stopped';
    if (!a?.limit || !ended) continue;
    if (out.length >= NAMES_MAX) {
      more++;
      continue;
    }
    const task = (i.detail.description || i.title || i.name).replace(/\s+/g, ' ').trim();
    const cut = task.length > NAME_MAX ? `${task.slice(0, NAME_MAX - 1).trimEnd()}…` : task;
    const kind = i.detail.subagent?.replace(/\s+/g, ' ').trim().slice(0, 40);
    out.push(`"${cut.replace(/"/g, "'")}" (${kind ? `${kind}, ` : ''}${i.workflow ? 'workflow' : 'call'} ${i.id})`);
  }
  if (more) out.push(`${more} more`);
  return out;
}

// ── back to the account a limit moved the chat from ──
//
// A chat a limit moved off an account (`SessionMeta.movedFrom`) goes back once that account takes
// work again: only at rest (no turn, no background work, nothing queued) or right before the
// person's next message, never mid-turn, never while another transition runs, and only after a
// fresh reading of its limits shows room for the chat's model ("when max3 is back you switch to
// it"). It goes back to the account it left, whatever "use first" ranks now: the ranking decides
// only the outward move. `movedFrom` stays until the return happened, the person moved the chat by
// hand, or that account is gone. A reading that is not fresh or shows no room for the model arms
// one more try, backing off (`returnRetryMs`); nothing returns on a guess. One return per reset.

/** Where a chat moved by a limit goes now: the account it left once that one takes work for its model, else undefined (stay). */
export function returnTarget(o: { from: string; current: string; fromTakesWork: boolean }): string | undefined {
  return o.fromTakesWork && o.from !== o.current ? o.from : undefined;
}

/**
 * The reading affirmatively shows room for the chat's model: fresh, with at least one live window
 * that counts for the model, and none of those full (`full`: the caller's own cap check).
 */
export function readingShowsRoom(o: { fresh: boolean; limits: RateLimit[]; model?: string; now: number; full: boolean }): boolean {
  if (!o.fresh || o.full) return false;
  return o.limits.some((l) => !(l.resetsAt && l.resetsAt <= o.now) && (!o.model || windowForModel(l, o.model)) && l.percent < 100);
}

/** How soon a chat that may return reads the account's limits again when the last reading showed it still held. */
export const RETURN_RECHECK_MS = 5 * 60_000;

/**
 * After a start, the returns chats still owe are looked at again (their timers lived in the last
 * run): never in the first `first` ms, when every account is being read anyway, and `gap` apart, so
 * a start is not a burst of readings and moves.
 */
export const RETURN_AT_START_MS = { first: 30_000, gap: 5_000 };

/** When the `nth` chat (from 0) that owes a return is looked at after a start; never before its own `returnAt`. */
export const returnAtStartMs = (nth: number, returnAt: number | undefined, now: number, ms = RETURN_AT_START_MS) =>
  Math.max((returnAt ?? 0) - now, ms.first + Math.max(0, nth) * ms.gap);

/**
 * When the returns still owed at a start are looked at, as waits from `now`, for chats given
 * soonest due first: none in the first half minute, none before it is due, and never two within
 * `gap` of each other, also when several are due at the same reset an hour away.
 */
export function returnsAtStart(dues: readonly (number | undefined)[], now: number, ms = RETURN_AT_START_MS): number[] {
  let prev = -Infinity;
  return dues.map((due, nth) => (prev = Math.max(returnAtStartMs(nth, due, now, ms), prev + ms.gap)));
}

/** The next try after an inconclusive reading (not fresh, failed, no room shown): 1, 2, 4… minutes, at most 30. */
export const returnRetryMs = (tries: number) => Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, tries));

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
