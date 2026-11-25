/**
 * Spare: work that runs on quota that would otherwise expire. A chat can wait to start by itself:
 *
 * - `spare` (`/spare <message>`): its held messages start when an account of its agent has weekly
 *   quota that will go unused at the current pace, room in its 5-hour window, and is under the cap
 *   the person set. Credits and extra usage are never used, a reset grant is never spent, and at
 *   most two such turns run at once.
 * - `reset` ("Continue at reset" on a limit notice): the refused turn continues on its account once
 *   the window that refused it resets.
 *
 * `planSpare` decides (pure, tested); `SpareWaits` keeps one timer to the next moment worth looking
 * again while something waits, re-plans when limits, caps or turns change, reads an account's limits
 * once more before a turn starts on it, and does nothing at all while nothing waits.
 *
 * Nothing goes out without the planner's go or a click: each held message starts only when the
 * planner starts it (or by Start now, which starts the first and leaves the rest held), a spare turn
 * that meets a limit waits again instead of going on with another account, and what a cancelled or
 * failed wait held stays in the queue to go out only by hand (`byHand` on the queued message).
 */
import { DEFAULT_ACCOUNT, type AccountCap, type Attachment, type AuthState, type LimitPace, type ModelInfo, type NoticeItem, type ProviderId, type QueuedMessage, type RateLimit, type SpareWait } from '../../shared/protocol';
import { capPercent, capReached, isAllModelsWeekly, isSessionWindow, windowForModel, windowModel } from './limit-policy';
import type { SessionRuntime } from './runtime';

/** Spare turns that may run at once (the laptop). */
export const SPARE_MAX_PARALLEL = 2;
/** Points of the week that must be projected to go unused before Spare spends any of them. */
export const SPARE_FLOOR = 10;
/** The 5-hour window must be below this percent (or below the account's own 5-hour cap). */
export const SPARE_SESSION_CEILING = 80;
/** With nothing in particular to wait for, the planner looks again after this long. */
export const SPARE_RECHECK_MS = 30 * 60_000;
/** A spare wait never looks again sooner than this (a pinned reset may). */
const MIN_WAKE_MS = 60_000;
/** An account's limits are read again before a start at most this often. */
const REFRESH_GAP_MS = 60_000;
/** A start needs a reading of the account this recent; older rows (or a failed read) wait for another round. */
export const SPARE_FRESH_MS = 15 * 60_000;
/** After a start held back for want of a fresh reading, the planner looks again this soon. */
export const SPARE_STALE_RETRY_MS = 5 * 60_000;
const HOUR = 3_600_000;

/**
 * A queued message a wait let go of (Cancel, a start that failed): it stays in the queue and goes
 * out only by hand, never at a turn's end. Kept on the message, so it survives a restart with the queue.
 */
export type KeptMessage = QueuedMessage;

// ───────────────────────────────── the model ─────────────────────────────────

/**
 * The model a chat's turns run on, as per-model windows ("Weekly · Fable") name it: the session's
 * own; for none or the agent's `default` alias, the model the alias stands for ("Default" described
 * as "Opus 5.5 · …"), else the agent's default from settings, else its listed default. Undefined
 * when that cannot be told: then every per-model window counts for it.
 */
export function effectiveModel(model: string | undefined, models: ModelInfo[] | undefined, fallback?: string): string | undefined {
  const named = (id: string | undefined) => (id?.trim() && id.trim() !== 'default' ? id.trim() : undefined);
  const own = named(model);
  if (own) return own;
  const alias = models?.find((m) => m.id === 'default');
  const head = alias?.description?.split(/\s+·\s+/)[0]?.trim();
  if (head && head.length <= 40 && /\d/.test(head) && /^[A-Za-z][\w-]*(?:[ -][\w.-]*\w){0,2}$/.test(head)) return head;
  return named(fallback) ?? named(models?.find((m) => m.isDefault)?.id);
}

/** A window counts for a turn of `model`: windows every model shares always, a per-model one for its model (any, when the model is not known). */
const forModel = (l: RateLimit, model: string | undefined) => !windowModel(l) || model === undefined || windowForModel(l, model);

/** A per-model window over a week ("Weekly · Fable"), not a 5-hour one. */
const modelWeekly = (l: RateLimit) => !!windowModel(l) && !isSessionWindow(l) && !l.id.startsWith('five_hour') && (l.windowMins === undefined || l.windowMins >= 10_080);

// ───────────────────────────────── plan weights ─────────────────────────────────

/**
 * How big an account's plan is, in units of Pro, as the Usage page counts it
 * (`src/features/usage/plans.ts`, kept equal by tests/spare.test.ts): Claude Max 5x 5, a premium
 * Team seat 6.25, Ultra 10, Max 20x 20; 1 when not known (Codex weights are known only within one plan).
 */
export function planWeight(provider: ProviderId, auth: AuthState | undefined): number {
  if (!auth?.loggedIn || provider === 'codex') return 1;
  const method = (auth.method ?? '').toLowerCase().replace(/[\s_-]/g, '');
  if (method === 'apikey' || method === 'console' || method === 'api') return 1;
  const shown = (auth.plan ?? '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+plan$/, '').trim();
  if (!shown || /api\s?key/.test(shown)) return 1;
  const table: [RegExp, number, string][] = [
    [/\bultra\b/, 10, 'ultra'],
    [/20x/, 20, 'max20'],
    [/\b5x/, 5, 'max5'],
    [/\b(team|seat)\b.*\bstandard\b|\bstandard\b.*\b(team|seat)\b/, 1.25, 'team'],
    [/\b(team|seat|premium)\b/, 6.25, 'team'],
    [/\bmax\b/, 5, 'max'],
    [/\bpro\b/, 1, 'pro'],
  ];
  const hit = table.find(([re]) => re.test(shown));
  if (hit && hit[2] !== 'max') return hit[1];
  const text = `${shown} ${(auth.planId ?? '').toLowerCase().replace(/[_-]+/g, ' ')}`;
  return table.find(([re]) => re.test(text))?.[1] ?? 1;
}

// ───────────────────────────────── the planner ─────────────────────────────────

/** One account of an agent as the planner sees it. */
export interface SpareAccount {
  id: string;
  signedIn: boolean;
  /** False: plan limits do not apply (an API key): never spare. */
  planLimits?: boolean;
  limits: RateLimit[];
  /** Per window id, how fast it fills (the limits book). */
  pace?: Record<string, LimitPace>;
  cap?: AccountCap;
  /** Plan size in units of Pro (`planWeight`). */
  weight?: number;
  /** The agent carries the account past a limit on credits or extra usage right now. */
  onCredits?: boolean;
}

/** How much an account has to give a spare turn. */
export interface SpareRoom {
  /** It may take a spare turn now. */
  ok: boolean;
  /** Points of the week projected to go unused at its reset, within the account's weekly cap. */
  unused: number;
  /** Unused points times plan weight per hour left: quota that expires sooner wins. */
  score: number;
  /** Held only by windows that reset then (the 5-hour window, a full window): it may qualify at this time. */
  until?: number;
}

const live = (limits: RateLimit[], now: number) => limits.filter((l) => !(l.resetsAt && l.resetsAt <= now));

/** Where the window ends up at its reset at the current pace; undefined when that cannot be told. */
function projected(l: RateLimit, p: LimitPace | undefined, now: number): number | undefined {
  if (!p) return undefined;
  if (p.atReset !== undefined) return p.atReset;
  if (!l.resetsAt) return undefined;
  return Math.min(100, l.percent + p.perHour * ((l.resetsAt - now) / HOUR));
}

/**
 * What an account can give a spare turn of `model` (`effectiveModel`; undefined: every per-model
 * window counts); undefined when it cannot this week (signed out, no plan limits, no weekly figure or
 * pace, too little projected to go unused in the week or in the model's own week, at its weekly cap,
 * on credits).
 */
export function spareRoom(a: SpareAccount, now: number, model?: string, floor = SPARE_FLOOR): SpareRoom | undefined {
  if (!a.signedIn || a.planLimits === false || a.onCredits) return undefined;
  const windows = live(a.limits, now);
  const week = windows.find(isAllModelsWeekly);
  if (!week?.resetsAt) return undefined;
  const end = projected(week, a.pace?.[week.id], now);
  if (end === undefined) return undefined;
  const ceiling = capPercent(a.cap?.weekly);
  if (week.percent >= ceiling) return undefined;
  let unused = Math.round((ceiling - Math.max(end, week.percent)) * 10) / 10;
  if (unused < floor) return undefined;
  if (capReached(a.limits, a.cap, model, now)?.kind === 'weekly') return undefined;
  // The model's own week ("Weekly · Fable") must have as much to spare (a full one holds it below,
  // until its reset); without a pace, what is left of it now.
  for (const l of windows) {
    if (!modelWeekly(l) || l.percent >= 100 || !forModel(l, model)) continue;
    const left = Math.round((100 - Math.max(projected(l, a.pace?.[l.id], now) ?? l.percent, l.percent)) * 10) / 10;
    if (left < floor) return undefined;
    unused = Math.min(unused, left);
  }
  const score = (unused * (a.weight ?? 1)) / Math.max(1, (week.resetsAt - now) / HOUR);

  // Windows that hold it for now, each until its reset.
  const holds: (number | undefined)[] = [];
  for (const l of windows) if (l.percent >= 100 && forModel(l, model)) holds.push(l.resetsAt);
  const five = windows.find(isSessionWindow);
  if (five && five.percent >= Math.min(SPARE_SESSION_CEILING, capPercent(a.cap?.session))) holds.push(five.resetsAt);
  if (!holds.length) return { ok: true, unused, score };
  const known = holds.every((t) => t !== undefined);
  return { ok: false, unused, score, ...(known ? { until: Math.max(...(holds as number[])) } : {}) };
}

/**
 * The latest reset among the account's windows that are still full for `model` (unknown: any model);
 * undefined when none is. A full window whose reset is not known holds it too: `Infinity` (review
 * wave 8, #18; it was left out, so the chat went on at a window still full).
 */
export function stillFull(limits: RateLimit[], now: number, model?: string, resetModels: string[] = []): number | undefined {
  const full = live(limits, now).filter((l) => l.percent >= 100 && (forModel(l, model) || resetModels.some(m => forModel(l, m))));
  if (!full.length) return undefined;
  return full.some((l) => !l.resetsAt) ? Infinity : Math.max(...full.map((l) => l.resetsAt!));
}

export interface SpareItem {
  sessionId: string;
  provider: ProviderId;
  /** The model its turns run on (`effectiveModel`); undefined when not known (every per-model window counts). */
  model?: string;
  resetModels?: string[];
  wait: SpareWait;
  /** Its session is working or starting: nothing starts there now. */
  busy?: boolean;
}

export interface SpareStart {
  sessionId: string;
  accountId: string;
  reason: SpareWait['reason'];
}

export interface SparePlan {
  start: SpareStart[];
  /** What each waiting session waits for now: the expected time and account when known, else nothing. */
  waits: Record<string, { at?: number; accountId?: string }>;
  /** When to look again, while something still waits. */
  wakeAt?: number;
}

export interface SpareInput {
  now: number;
  /** Each agent's accounts as last known. */
  accounts: Partial<Record<ProviderId, SpareAccount[]>>;
  items: SpareItem[];
  /** Spare turns running now. */
  running: number;
  maxParallel?: number;
  floor?: number;
}

/**
 * Which waiting chats start now, and on which account. Pinned resets start at their time on their
 * account (unless the account still reads full: then at that window's reset). Spare chats go first
 * come, first served, each on the qualifying account whose unused quota expires soonest by plan
 * weight, at most one new start per account and `maxParallel` spare turns in all.
 */
export function planSpare(input: SpareInput): SparePlan {
  const { now, items, floor = SPARE_FLOOR } = input;
  const out: SparePlan = { start: [], waits: {} };
  const wake = (t: number | undefined) => {
    if (t !== undefined && (out.wakeAt === undefined || t < out.wakeAt)) out.wakeAt = t;
  };
  const taken = new Set<string>();
  let slots = (input.maxParallel ?? SPARE_MAX_PARALLEL) - input.running;
  const queue = [...items].sort((a, b) => a.wait.since - b.wait.since);

  for (const it of queue) {
    if (it.wait.reason !== 'reset') continue;
    const accountId = it.wait.accountId ?? DEFAULT_ACCOUNT;
    const at = it.wait.at ?? now;
    if (at > now) {
      out.waits[it.sessionId] = { at, accountId };
      wake(at);
      continue;
    }
    // Due, but its chat is busy (a turn the person started): the turn's end looks again.
    if (it.busy) {
      out.waits[it.sessionId] = { at, accountId };
      continue;
    }
    const acc = input.accounts[it.provider]?.find((a) => a.id === accountId);
    const later = acc ? stillFull(acc.limits, now, it.model, it.resetModels) : undefined;
    if (later === Infinity) {
      // Full with no reset known: it waits, and looks again in a while (a reading may tell).
      out.waits[it.sessionId] = { accountId };
      wake(now + SPARE_RECHECK_MS);
      continue;
    }
    if (later && later > now) {
      out.waits[it.sessionId] = { at: later, accountId };
      wake(later);
      continue;
    }
    out.start.push({ sessionId: it.sessionId, accountId, reason: 'reset' });
    taken.add(`${it.provider}:${accountId}`);
  }

  for (const it of queue) {
    if (it.wait.reason !== 'spare') continue;
    const rooms = (input.accounts[it.provider] ?? []).flatMap((a) => {
      const r = spareRoom(a, now, it.model, floor);
      return r ? [{ a, r }] : [];
    });
    const ready = rooms.filter((x) => x.r.ok && !taken.has(`${it.provider}:${x.a.id}`)).sort((x, y) => y.r.score - x.r.score);
    if (ready.length && slots > 0 && !it.busy) {
      out.start.push({ sessionId: it.sessionId, accountId: ready[0].a.id, reason: 'spare' });
      taken.add(`${it.provider}:${ready[0].a.id}`);
      slots--;
      continue;
    }
    // An account with room waits only for a turn to end (or another round); otherwise the soonest
    // window that holds one back says when to look again.
    const soon = ready.length ? undefined : rooms.filter((x) => x.r.until !== undefined).sort((x, y) => x.r.until! - y.r.until! || y.r.score - x.r.score)[0];
    out.waits[it.sessionId] = soon ? { at: soon.r.until, accountId: soon.a.id } : {};
    if (soon) wake(Math.max(soon.r.until!, now + MIN_WAKE_MS));
    wake(now + SPARE_RECHECK_MS);
  }
  return out;
}

// ───────────────────────────────── the waits ─────────────────────────────────

/** A turn Spare started: why, and since when its chat waited (its place in line when it waits again). */
export interface SpareRun {
  reason: SpareWait['reason'];
  since: number;
  /** Being stopped (its account went onto credits). */
  stopping?: boolean;
}

export interface SpareHost {
  now?: () => number;
  sessions: () => Iterable<SessionRuntime>;
  /** Loads a restored session's timeline and queue (where its held messages are). */
  hydrate: (rt: SessionRuntime) => void | Promise<void>;
  /** The session is working, starting or sending. */
  busy: (rt: SessionRuntime) => boolean;
  /** The model its turns run on (`effectiveModel`); undefined when that cannot be told. */
  model: (rt: SessionRuntime) => string | undefined;
  resetModels?: (rt: SessionRuntime) => string[];
  accounts: (provider: ProviderId) => Promise<SpareAccount[]>;
  /** Reads the account's limits again (no tokens). True when the agent gave a new reading (a failed read hands back the last known rows). */
  refresh: (provider: ProviderId, accountId: string) => Promise<boolean>;
  /** The user message the chat's open limit notice refused or cut off, when one is open. */
  refused: (rt: SessionRuntime) => string | undefined;
  /**
   * Starts what waits. Spare: moves the session to `accountId` when needed, then sends the first
   * thing it holds (a refused spare turn carries on, else its first held message). Reset: carries
   * on with the refused turn on its account; never moves the session.
   */
  start: (rt: SessionRuntime, accountId: string, wait: SpareWait) => Promise<void>;
  /** Start now (the person's click): the held entry `id` goes out on the session's account as their own send. */
  send: (rt: SessionRuntime, id: string) => Promise<void>;
  /** Stops a spare turn whose account went onto credits. */
  stop: (rt: SessionRuntime, line: string) => Promise<void>;
  accountLabel: (provider: ProviderId, accountId: string) => string;
  log: (...args: unknown[]) => void;
}

/** Marks queued messages to go out only by hand. */
function keepByHand(rt: SessionRuntime, ids: string[]) {
  let first: QueuedMessage | undefined;
  for (const q of rt.queue as KeptMessage[]) {
    if (!ids.includes(q.id)) continue;
    q.byHand = true;
    first ??= q;
  }
  // Saved and shown with the queue (an edit that changes nothing else).
  if (first) rt.updateQueued(first.id, first.text);
}

/** The chats waiting to start by themselves, and the one timer that wakes them. */
export class SpareWaits {
  /** Sessions whose current turn Spare started: they count toward the parallel limit until it ends. */
  readonly running = new Map<string, SpareRun>();
  /** Sessions Spare is about to start (reading limits, checking again, starting). */
  private starting = new Set<string>();
  /** Sessions whose start is under way right now: a turn that begins meanwhile is Spare's own. */
  private launching = new Map<string, SpareRun>();
  /** Sessions where Spare's start began a turn. */
  private began = new Set<string>();
  private timer?: NodeJS.Timeout;
  private poker?: NodeJS.Timeout;
  private pokeAt = 0;
  private planning = false;
  private again = false;
  private refreshedAt = new Map<string, number>();
  /** When each account's limits were last read from its agent (not a cached answer). */
  private readAt = new Map<string, number>();
  private disposed = false;

  constructor(private host: SpareHost) {}

  private now() {
    return this.host.now?.() ?? Date.now();
  }

  private waiting(): SessionRuntime[] {
    return [...this.host.sessions()].filter((rt) => !!rt.meta.spare);
  }

  private alive(rt: SessionRuntime) {
    for (const r of this.host.sessions()) if (r === rt) return true;
    return false;
  }

  hasWaits() {
    for (const rt of this.host.sessions()) if (rt.meta.spare) return true;
    return false;
  }

  /**
   * What the wait still holds, in the order it starts them: a refused spare turn to carry on first,
   * then its queued messages as the queue orders them.
   */
  pending(rt: SessionRuntime): string[] {
    const held = rt.meta.spare?.held;
    if (!held?.length) return [];
    const refused = this.host.refused(rt);
    const first = refused && held.includes(refused) ? [refused] : [];
    return [...first, ...rt.queue.filter((q) => held.includes(q.id)).map((q) => q.id)];
  }

  /** `/spare`: the message joins the queue, held back until the planner starts it. */
  hold(rt: SessionRuntime, text: string, attachments?: Attachment[]): SpareWait {
    const q = rt.enqueue(text, attachments);
    const cur = rt.meta.spare;
    const wait: SpareWait = cur ? { ...cur, held: [...(cur.held ?? []), q.id] } : { reason: 'spare', since: this.now(), held: [q.id] };
    rt.update({ spare: wait });
    this.poke();
    return wait;
  }

  /** "Continue at reset": the chat's last open limit notice continues on its account at its reset. */
  atReset(rt: SessionRuntime, refusalId?: string): { ok: boolean; spare?: SpareWait; error?: string } {
    const notice = rt.items.findLast((i): i is NoticeItem => i.type === 'notice' && !!i.limit && !i.limit.continuedWith && !i.parentId && (!refusalId || i.id === refusalId));
    if (!notice) return { ok: false, error: 'There is no limit to wait for' };
    const at = notice.limit!.resetsAt;
    if (!at) return { ok: false, error: 'The reset time is not known yet' };
    const held = rt.meta.spare?.held?.length ? { held: rt.meta.spare.held } : {};
    const wait: SpareWait = { reason: 'reset', since: this.now(), at, refusalId: notice.id, accountId: notice.limit!.accountId ?? rt.meta.accountId ?? DEFAULT_ACCOUNT, ...held };
    rt.update({ spare: wait });
    this.poke();
    return { ok: true, spare: wait };
  }

  /** Cancel: the chat stops waiting. What it held stays in the queue to go out only by hand, and one line says so. */
  cancel(rt: SessionRuntime): boolean {
    if (!rt.meta.spare) return false;
    this.release(rt);
    return true;
  }

  /**
   * The chat stops waiting. Its held queued messages stay in the queue but never go out by
   * themselves; a refused turn it was to carry on stays as its notice shows it. One line says so.
   */
  private release(rt: SessionRuntime) {
    if (!rt.meta.spare) return;
    const kept = this.pending(rt).filter((id) => rt.queue.some((q) => q.id === id));
    rt.update({ spare: null });
    keepByHand(rt, kept);
    const n = kept.length;
    rt.notice('info', 'Stopped waiting', n ? (n === 1 ? 'The message stays in the queue until you send it' : `The ${n} messages stay in the queue until you send them`) : undefined);
    this.poke();
  }

  /** Start now (the person's click): the first thing it holds goes out on the chat's account; the rest stay held. */
  async startNow(rt: SessionRuntime): Promise<boolean> {
    const wait = rt.meta.spare;
    if (!wait) return false;
    await this.host.hydrate(rt);
    if (rt.meta.spare !== wait) return false;
    const [first, ...rest] = this.pending(rt);
    if (!first) return false;
    if (wait.reason === 'spare' && !rest.length) rt.update({ spare: null });
    else rt.update({ spare: { ...wait, held: rest } });
    this.poke();
    await this.host.send(rt, first);
    return true;
  }

  /** Queued messages a turn's end must leave where they are: held by a wait, or kept to go out by hand. */
  held(rt: SessionRuntime): Set<string> {
    const out = new Set(rt.meta.spare?.held ?? []);
    for (const q of rt.queue as KeptMessage[]) if (q.byHand) out.add(q.id);
    return out;
  }

  /** The queue changed by hand (a held message sent, edited or removed): the wait lets go of what left. */
  queueChanged(rt: SessionRuntime) {
    const wait = rt.meta.spare;
    if (!wait?.held?.length) return;
    const held = this.pending(rt);
    if (held.length === wait.held.length) return;
    if (wait.reason === 'spare' && !held.length) {
      rt.update({ spare: null });
      this.poke();
    } else rt.update({ spare: { ...wait, held } });
  }

  turnStarted(rt: SessionRuntime) {
    const ours = this.launching.get(rt.id);
    if (ours) {
      this.running.set(rt.id, { ...ours });
      this.began.add(rt.id);
      return;
    }
    // Carried on by hand: a refused turn it was to carry on is the person's now, and waiting for a
    // reset is over. Its queued messages stay held.
    const wait = rt.meta.spare;
    if (!wait) return;
    const held = (wait.held ?? []).filter((h) => rt.queue.some((q) => q.id === h));
    if (wait.reason === 'spare' && held.length === (wait.held?.length ?? 0)) return;
    rt.update({ spare: held.length ? { reason: 'spare', since: wait.since, held } : null });
    this.poke();
  }

  /** A turn ended: a spare turn's place frees up, waiting chats are looked at again. Returns the run when Spare had started that turn. */
  turnEnded(rt: SessionRuntime): SpareRun | undefined {
    const ran = this.running.get(rt.id);
    this.running.delete(rt.id);
    if (ran || this.hasWaits()) this.poke(400);
    return ran;
  }

  /**
   * A turn Spare started met a plan limit. It never goes on with another account by itself: a turn
   * that continued at a reset waits for the next reset on the same account, a spare turn waits for
   * spare again (its refused message first), with one line. `at`: when the account can work again.
   */
  limitHit(rt: SessionRuntime, ran: SpareRun, hit: { accountId: string; at?: number }) {
    const held = this.pending(rt).filter((id) => rt.queue.some((q) => q.id === id));
    const refused = this.host.refused(rt);
    const since = Math.min(ran.since, rt.meta.spare?.since ?? ran.since);
    let wait: SpareWait | null;
    if (ran.reason === 'reset' && hit.at && hit.at > this.now()) {
      wait = { reason: 'reset', since: this.now(), at: hit.at, accountId: hit.accountId, ...(held.length ? { held } : {}) };
    } else {
      const all = refused ? [refused, ...held] : held;
      wait = all.length ? { reason: 'spare', since, held: all } : null;
    }
    rt.update({ spare: wait });
    if (wait) rt.notice('info', wait.reason === 'reset' ? 'Back to waiting for the reset' : 'Back to waiting for spare');
    this.poke(400);
  }

  /** The person moved the chat to another account: a wait for a reset on the old one is over (held messages stay held). */
  movedByHand(rt: SessionRuntime) {
    const wait = rt.meta.spare;
    if (wait?.reason !== 'reset') return;
    const held = this.pending(rt).filter((id) => rt.queue.some((q) => q.id === id));
    rt.update({ spare: held.length ? { reason: 'spare', since: wait.since, held } : null });
    this.poke();
  }

  /** An account's limits were read from its agent: a spare turn on it that went onto credits stops; waits are planned again. */
  limitsChanged(provider: ProviderId, accountId: string, onCredits: boolean) {
    this.readAt.set(`${provider}:${accountId}`, this.now());
    if (onCredits) {
      for (const rt of this.host.sessions()) {
        const run = this.running.get(rt.id);
        if (!run || run.stopping || !rt.turnActive || rt.meta.provider !== provider || (rt.meta.accountId ?? DEFAULT_ACCOUNT) !== accountId) continue;
        // Still Spare's turn until it ends (it keeps its place, and its end is not followed by a move).
        run.stopping = true;
        void this.host.stop(rt, `Stopped at the limit of ${this.host.accountLabel(provider, accountId)}`).catch((err) => this.host.log('spare stop failed', (err as Error).message));
      }
    }
    if (this.hasWaits()) this.poke(1500);
  }

  /**
   * An account's full windows cleared before their time (a reset used in the agent's own dialog,
   * confirmed by a fresh read): chats waiting for its reset are due now. The planner then starts
   * them exactly as at a reset by time, checking the account's limits once more first.
   */
  async resetCleared(provider: ProviderId, accountId: string, windows?: RateLimit[]) {
    const now = this.now();
    let due = false;
    for (const rt of this.waiting()) {
      const wait = rt.meta.spare;
      if (wait?.reason !== 'reset' || rt.meta.provider !== provider || (wait.accountId ?? DEFAULT_ACCOUNT) !== accountId) continue;
      // Only a chat that one of the cleared windows held (another model's week is not its wait); the
      // planner then checks every window that holds it, against the fresh reading (review wave 8, #18).
      const model = this.host.model(rt);
      const reading = this.host.hydrate(rt);
      if (reading) await reading;
      if (rt.meta.spare !== wait) continue;
      const models = [model, ...(this.host.resetModels?.(rt) ?? [])];
      if (windows && !windows.some(l => models.some(m => forModel(l, m)))) continue;
      if (wait.at !== undefined && wait.at > now) rt.update({ spare: { ...wait, at: now } });
      due = true;
    }
    if (due) {
      // The read that confirmed it is the fresh reading a start needs.
      this.readAt.set(`${provider}:${accountId}`, now);
      this.poke();
    }
  }

  /** Plans again after `delay` (coalesced: the earliest asked wins). */
  poke(delay = 0) {
    if (this.disposed) return;
    const at = this.now() + delay;
    if (this.poker && this.pokeAt <= at) return;
    clearTimeout(this.poker);
    this.pokeAt = at;
    this.poker = setTimeout(() => {
      this.poker = undefined;
      void this.run();
    }, delay);
    this.poker.unref?.();
  }

  /** Plans now and starts what is due; resolves when that round is done (tests). */
  async run(): Promise<void> {
    if (this.disposed) return;
    if (this.planning) {
      this.again = true;
      return;
    }
    this.planning = true;
    try {
      for (const rt of this.waiting()) {
        await this.host.hydrate(rt);
        this.queueChanged(rt);
      }
      const waits = this.waiting();
      if (!waits.length) return this.arm(undefined);
      const plan = await this.plan(waits);
      this.show(waits, plan);
      let wakeAt = plan.wakeAt;
      for (const s of plan.start) {
        const rt = waits.find((r) => r.id === s.sessionId);
        if (!rt) continue;
        // No fresh reading to start from: look again soon.
        if ((await this.begin(rt, s)) === 'stale') wakeAt = Math.min(wakeAt ?? Infinity, this.now() + SPARE_STALE_RETRY_MS);
      }
      this.arm(this.hasWaits() ? (wakeAt ?? this.now() + SPARE_RECHECK_MS) : undefined);
    } catch (err) {
      this.host.log('spare planning failed', (err as Error).message);
      this.arm(this.now() + SPARE_RECHECK_MS);
    } finally {
      this.planning = false;
      if (this.again) {
        this.again = false;
        void this.run();
      }
    }
  }

  private item(rt: SessionRuntime, busy: boolean): SpareItem {
    return { sessionId: rt.id, provider: rt.meta.provider, model: this.host.model(rt), resetModels: rt.meta.spare?.reason === 'reset' ? this.host.resetModels?.(rt) : undefined, wait: rt.meta.spare!, busy };
  }

  private async plan(waits: SessionRuntime[]): Promise<SparePlan> {
    const providers = [...new Set(waits.map((rt) => rt.meta.provider))];
    const accounts: Partial<Record<ProviderId, SpareAccount[]>> = {};
    for (const p of providers) accounts[p] = await this.host.accounts(p).catch(() => []);
    const items = waits.filter(rt => rt.meta.spare && this.alive(rt)).map(rt => this.item(rt, this.host.busy(rt) || this.starting.has(rt.id)));
    return planSpare({ now: this.now(), accounts, items, running: this.running.size + this.starting.size });
  }

  /** What each chat waits for, as its line says it (only when that changed). */
  private show(waits: SessionRuntime[], plan: SparePlan) {
    for (const rt of waits) {
      const w = plan.waits[rt.id];
      const cur = rt.meta.spare;
      if (!w || !cur) continue;
      if (cur.at === w.at && cur.accountId === w.accountId) continue;
      // A reset wait keeps its known time, unless that time passed (a window still full with no reset known).
      if (cur.reason === 'reset' && !w.at && !(cur.at !== undefined && cur.at <= this.now())) continue;
      const next: SpareWait = { ...cur };
      if (w.at === undefined) delete next.at;
      else next.at = w.at;
      if (w.accountId === undefined) delete next.accountId;
      else next.accountId = w.accountId;
      rt.update({ spare: next });
    }
  }

  /**
   * Reads the account's limits once more, checks the start still holds on that reading, and starts
   * it. 'stale': no fresh reading (the read failed, or the rows are older than `SPARE_FRESH_MS`).
   */
  private async begin(rt: SessionRuntime, s: SpareStart): Promise<'started' | 'stale' | 'held'> {
    const provider = rt.meta.provider;
    const key = `${provider}:${s.accountId}`;
    const wait = rt.meta.spare;
    this.starting.add(rt.id);
    try {
      let failed = false;
      if (this.now() - (this.refreshedAt.get(key) ?? 0) >= REFRESH_GAP_MS) {
        this.refreshedAt.set(key, this.now());
        try {
          if (await this.host.refresh(provider, s.accountId)) this.readAt.set(key, this.now());
        } catch (err) {
          failed = true;
          this.host.log('spare: limits read failed', (err as Error).message);
        }
      }
      if (!wait || rt.meta.spare !== wait || this.disposed || !this.alive(rt)) return 'held';
      if (failed || this.now() - (this.readAt.get(key) ?? 0) > SPARE_FRESH_MS) {
        this.host.log('spare: no fresh limits for', key, 'so nothing starts this round');
        return 'stale';
      }
      // Nothing left to start (sent or removed by hand meanwhile): the wait ends, nothing moves.
      if (wait.reason === 'spare' && !this.pending(rt).length) {
        rt.update({ spare: null });
        return 'held';
      }
      // The account as just read must still take it (another may lead now: this one is still fine).
      const fresh = (await this.host.accounts(provider).catch(() => [] as SpareAccount[])).filter((a) => a.id === s.accountId);
      if (this.disposed || !this.alive(rt) || rt.meta.spare !== wait) return 'held';
      if (wait.reason === 'reset' && !fresh[0]?.limits.length) return 'stale';
      const again = planSpare({ now: this.now(), accounts: { [provider]: fresh }, items: [this.item(rt, this.host.busy(rt))], running: this.running.size + this.starting.size - 1 });
      if (!again.start.some((x) => x.sessionId === rt.id && x.accountId === s.accountId)) {
        this.show([rt], again);
        return 'held';
      }
      this.launching.set(rt.id, { reason: wait.reason, since: wait.since });
      let began = false;
      try {
        await this.host.start(rt, s.accountId, wait);
      } finally {
        this.launching.delete(rt.id);
        began = this.began.delete(rt.id);
      }
      // Changed meanwhile (cancelled, sent by hand, or its turn already met a limit and waits again): that stands.
      if (rt.meta.spare !== wait) return 'started';
      // It never became a turn (the agent could not start, nothing was left to carry on): the chat
      // stops waiting, and what it held stays for a click.
      if (!began) {
        this.release(rt);
        return 'held';
      }
      // On its way. What it still holds waits for the planner (each one its own start).
      const held = this.pending(rt).filter((id) => rt.queue.some((q) => q.id === id));
      rt.update({ spare: held.length ? { reason: 'spare', since: wait.since, held } : null });
      return 'started';
    } catch (err) {
      if (this.disposed || !this.alive(rt) || rt.meta.spare !== wait) return 'held';
      this.host.log('spare start failed', (err as Error).message);
      rt.notice('error', 'Could not start the waiting message', (err as Error).message);
      this.release(rt);
      return 'held';
    } finally {
      this.starting.delete(rt.id);
    }
  }

  /** The one timer: to `at`, re-armed in steps over long waits (a laptop may sleep through one). */
  private arm(at: number | undefined) {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (at === undefined || this.disposed) return;
    const ms = Math.min(Math.max(1000, at - this.now() + 250), 6 * HOUR);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, ms);
    this.timer.unref?.();
  }

  /** Whether the timer is armed (tests). */
  get armed() {
    return !!this.timer;
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.poker);
  }
}
