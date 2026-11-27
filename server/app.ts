import { requireWebMessage } from './services/web-policy';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ACCOUNT,
  matchModel,
  type AccountCap,
  type AgentHandover,
  type UpdateState,
  type AccountInfo,
  type AuthState,
  type AppState,
  type BridgeEvent,
  type Capabilities,
  type FolderGroup,
  type NoticeItem,
  type Project,
  type ProviderId,
  type ProviderInfo,
  type LimitsMeta,
  type RateLimit,
  STANDARD_SPEED,
  type RpcMethods,
  type RpcName,
  type SessionMeta,
  type SessionOptions,
  type SessionSnapshot,
  type SpareWait,
  type TimelineItem,
  type ToolItem,
  type QueuedMessage,
  type UserItem,
} from '../shared/protocol';
import { AuthJournal } from './core/auth-journal';
import { authGate, gateKey, SignInChecks, takeAuthFailure } from './core/auth-gate';
/** A refusal for the sign-in as it was noted (`refusalMark`). */
interface RefusalMark {
  refusedId?: string;
  endId?: string;
  provider: ProviderId;
  accountId: string;
  stops: number;
  closes: number;
}
import { DELEGATE_REPORT, delegateReport, syntheticOf, lostTasksNote, RESUME_AFTER_SIGN_IN, RESUME_LOST, signInBackgroundNote } from '../shared/synthetic';
import { normalizeBackdrop } from '../shared/backdrop';
import { HANDOVER_JOIN, personalOrigin, readableTitle, RESUME_AFTER_RESET, RESUME_LIMIT_RESET, RESUME_SUMMARY_TRAILER, RESUME_UNDER_ANOTHER, resumeBackgroundNote } from '../shared/synthetic';
import { Races, type Contender } from './core/race';
import { laneSlug } from './services/git-lanes';
import { gitDraftInput, gitWorktrees } from './services/git';
import { cleanCommit, commitPrompt } from './core/commit-draft';
import { SessionRuntime, autoTitle, lostLine, pendingPrompts, type BackgroundLimit, type LossTrigger } from './core/runtime';
import { Store, type StoredAccount } from './core/store';
import { DiskCache } from './core/cache';
import { isLight, recentStart, RECENT_TURNS, sessionPatchForJson, SNAPSHOT_THRESHOLD, snapshotEnd, snapshotPage } from './core/trim';
import { BACKGROUND_LIMIT_SETTLE_MS, backgroundLimitDue, capReached, capReason, creditsKey, decideAtLimit, dueResets, hasCap, limitStoppedAgents, nextResetAlert, readingShowsRoom, RETURN_AT_START_MS, RETURN_RECHECK_MS, returnRetryMs, returnsAtStart, returnTarget, runningOnCredits } from './core/limit-policy';
import { rankAccount } from '../shared/use-first';
import { defaultChatsRoot, makeChatFolder, removeEmptyChatFolder } from './core/chats';
import { speedFor, startSpeedFor } from '../shared/speed';
import { resultDigest, type WantedReceipts } from './core/delegate-result';
import { DelegateJournal, type DelegateRecord } from './core/delegate-journal';
import type { DelegateReceipts, Provider, ProviderContext, ProviderSession } from './providers/types';
import { atCap, findAccountFolders, folderLabel, labelFromAuth, pickNextAccount } from './accounts/folders';
import { bigContext, changedFiles, COMPACT_OPENER, COMPACT_TIMEOUT_MS, contextClause, isSlashCommand, lostClause, moveNote, type MoveOutcome } from './core/move-context';
import { handoverText } from './accounts/handover';
import { ConversationCopies } from './accounts/dedupe';
import { itemsSince, lastSwitch, legOf, rootBefore, undoableSwitch, withLeg, workedIn } from './core/agent-switch';
import { runsTask, worksInBackground } from '../shared/background';
import { WorkTracker, type ProcessProbe } from './core/track';
import { runSubAgent } from './core/sub-agent';
import { readOnlyMode, TurnChecks, withoutChecks } from './core/check';
import { cutAt, forkHistory } from './core/fork';
import { pinFolder } from './core/contain';
import { orderAccounts } from './accounts/order';
import { allowsEverything, withBrowserLine } from './providers/browser-tool';
import { agentLimitOf, ownReplays } from './providers/claude-tools';
import { profileOf } from './services/profile';
import { anyPageHeld, registerSignIns } from './services/sign-ins';
import { CUSTOM_AGENT_ONLY, customAgent, customOf } from './services/custom';
import { parseUntil, runCheck, UntilLoops } from './core/until';
import { ChatTitles, type TitleModel, type TitleOwner, type TitlePrompt } from './core/titles';
import { Lanes, LaneUnavailable, worktreesRoot } from './core/lanes';
import { backgroundAgentName, isAllModelsWeekly } from './core/limit-policy';
import { matchesWindowModel, windowForModel, windowModel } from '../shared/limit-windows';
import { mergeWindows } from './services/limits';
import { workOf, WAKE_DELIVERY_GRACE_MS, type ChatWork } from './core/work';
import { effectiveModel, planWeight, SPARE_STALE_RETRY_MS, SpareWaits, type SpareAccount, type SpareRun } from './core/spare';
import { clearedWindows, ResetConsoles } from './core/reset-console';
import { heldForLimits, isApiKeyAuth, limitsAfterTurn } from './core/limit-refresh';
export { isApiKeyAuth } from './core/limit-refresh';
import { PhoneReceipts, Submissions, messagePrint } from './core/submissions';
import { openConsole as realConsole, type OpenConsole } from './util/console';
import { VERSION } from './version';
import { bootMark } from './util/boot';
import { DeadlineExceeded, withDeadline } from './util/deadline';
import { cliPresentSoon } from './util/cli-present';

/**
 * Who asks, beside the params: `allowed` (the phone endpoint's guard, services/phone.ts) says whether
 * the caller may still act; a handler that waits asks it again right before what it does after the wait.
 */
export interface CallContext {
  phoneSender?: UserItem['phoneSender'];
  allowed?: () => boolean;
  refusal?: () => string | undefined;
  /**
   * The caller knows a sign-in only as in or out and keeps what it read (a phone): `app.hello`
   * waits for an agent's own answer where it would say `checking`.
   */
  settled?: boolean;
}

/** The caller of a call may no longer act (a phone removed while its request waited). */
export class CallerGone extends Error {
  constructor(reason = 'This phone was removed on the desktop') {
    super(reason);
  }
}

/** Throws `CallerGone` when the caller may no longer act. */
const still = (ctx?: CallContext) => {
  if (ctx?.allowed && !ctx.allowed()) throw new CallerGone(ctx?.refusal?.());
};

/**
 * A move or a switch refused for now because the chat is busy: a turn runs (one the agent began by
 * itself too), work goes on in the background, a message is on its way to the agent, another
 * transition runs. Nothing went wrong and nothing changed: the next moment of rest decides again. A
 * move Sable makes by itself passes over it quietly; one the person asked for says it as any refusal.
 */
export class NotNow extends Error {}
type DeliveryFields = Partial<Pick<UserItem, 'until' | 'id' | 'submitPrint' | 'ts' | 'steerAttempts' | 'steerOrder'>> & { submitId?: string; steerNow?: () => void };

class DeliveryMissed extends Error {}
class DeliveryUncertain extends Error {
  constructor() { super('The agent did not confirm this message. Check its reply before continuing by hand.'); }
}

/** When the last thing in a timeline happened: the latest start or end of any of its items (undefined when empty). */
function lastAct(items: readonly TimelineItem[]): number | undefined {
  let at: number | undefined;
  for (const i of items) {
    const end = (i.type === 'tool' || i.type === 'thinking') && i.endedAt ? i.endedAt : 0;
    at = Math.max(at ?? 0, i.ts, end);
  }
  return at;
}

/** `p`, or `fallback` once `ms` passed (the timer cleared either way). */
function boundedBy<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<F>((r) => (timer = setTimeout(() => r(fallback), ms)))]).finally(() => clearTimeout(timer));
}

interface MoveAttempt {
  stops: number;
  live(): void;
  compacted: boolean;
  remote: boolean;
  sourceClosed: boolean;
  lostSteps: string[];
}

interface MoveOptions {
  retry?: boolean;
  refusalId?: string;
  line?: string;
  compact?: boolean;
  onCompacting?: () => void;
  waits?: boolean;
  automatic?: boolean;
  /** The window that caused the move. A manual switch uses its selected refusal, if any. */
  limitReturn?: { at?: number; models?: (string | undefined)[] } | 'selectedNotice';
}

/** A message's words and pictures as a send or a queue edit takes them: words a string, pictures a list or nothing. */
function validMessage(text: unknown, attachments: unknown) {
  if (typeof text !== 'string') throw new Error('A message needs its words.');
  if (attachments !== undefined && attachments !== null && !Array.isArray(attachments)) throw new Error('Those attachments cannot go with a message.');
}

type Handler<M extends RpcName> = (params: RpcMethods[M]['params'], ctx: CallContext) => Promise<RpcMethods[M]['result']> | RpcMethods[M]['result'];

export interface AppOptions {
  home?: string;
  /** Provider factories; injected so tests can run with the demo provider only. */
  providers: ((ctx: ProviderContext) => Provider)[];
  quiet?: boolean;
  /** How long after serving a cached answer the fresh one is fetched (tests shorten these). */
  refreshDelays?: { info?: number; caps?: number; signIn?: number; firstInfo?: number; settledInfo?: number };
  /** The user's home folder, where "Use an existing folder" looks for agent config folders (tests point it elsewhere). */
  userHome?: string;
  /** How long a sign-in may wait for the browser before it is given up (tests shorten it). */
  loginTimeoutMs?: number;
  /** Opens a console window (`limit.resetInAgent`); tests pass one that opens nothing. Default: a real window, Windows only. */
  openConsole?: OpenConsole;
  /** How long after a first read that showed no change a reset's limits are read once more (tests shorten it). */
  resetSettleMs?: number;
  /** How long a compaction before a move to another account may take (tests shorten it). */
  compactTimeoutMs?: number;
  /** How long a limit met by background work waits for the next refusal, and at most (`core/limit-policy.ts`; tests shorten them). */
  backgroundLimitMs?: { settle: number; max: number };
  /** Tests: when the returns chats still owe are looked at after a start (`RETURN_AT_START_MS`). */
  returnAtStartMs?: { first: number; gap: number };
  /** Tests: how tracked work's processes are looked at (`core/track.ts`; default: the system's own answers). */
  trackProbe?: ProcessProbe;
}

export { VERSION };

/** How long an agent asked to stop a compaction that took too long has to say it stopped. */
const COMPACT_STOP_GRACE_MS = 5000;
/** How long a send waits for a return to another account already under way before it goes in the queue behind it. */
const RETURN_SEND_WAIT_MS = 15_000;
/** How long the agent of the account a chat leaves has to close before the move goes on without its transcript. */
const MOVE_CLOSE_MS = 10_000;
/** How soon a move held by a turn the agent says it runs, where Sable runs none, is looked at again. */
const LIVE_TURN_RECHECK_MS = 5_000;
/** How long a move gives the agent's word of a turn's end to follow its result (`settleLiveTurn`). */
const LIVE_TURN_SETTLE_MS = 2_000;
/** How long a move waits for a message already on its way to the agent before it looks again (`untilDispatched`). */
const DISPATCH_WAIT_MS = 15_000;
/** Between two chats whose Remote Control process opens again after a move: a reset returns many chats at once. */
const REMOTE_REOPEN_GAP_MS = 3_000;
/**
 * How long the silent second send after a refused sign-in waits while the agent still works: a process
 * that still holds the refused message runs it by itself once its sign-in is renewed (C5).
 */
const SIGN_IN_HOLD_MS = 10_000;

/** How a reset in the agent's own dialog is offered: a console window Sable opens, or a command for a terminal. */
const limitResetVia = (consoles: boolean, p: Provider): NonNullable<ProviderInfo['limitReset']> | undefined => {
  const line = p.limitResetCommand?.().line;
  return line ? { via: consoles ? 'console' : 'terminal', command: line } : undefined;
};

/** An account's own terminal command for its reset dialog: its config folder in it, never another account's (review wave 8, #19). */
const resetCommandOf = (p: Provider): { resetCommand?: string } => {
  const line = p.limitResetCommand?.().line;
  return line ? { resetCommand: line } : {};
};

/** The label of each provider's built-in account until the user renames it. */
export const DEFAULT_ACCOUNT_LABEL = 'Main';

const WAKE_LOST = 'The scheduled wake-up ended with the old process. Schedule it again if still needed.';
const DELEGATE_CONTINUATIONS = 2;
const LOSS_WAKE_WINDOW_MS = 10 * 60_000;
const LOSS_WAKE_CRASH_MS = 2 * 60_000;
const recentLossWakes = (rt: SessionRuntime, now = Date.now()) => (rt.meta.lossWake?.attempts ?? []).filter(at => now - at < LOSS_WAKE_WINDOW_MS);
const accountKey = (provider: ProviderId, accountId: string) => `${provider}:${accountId}`;
type KnownLimits = Map<string, { limits?: RateLimit[]; planLimits?: boolean }>;

/** The bridge application: owns providers, sessions and persistence. Transport-agnostic. */
export class App {
  beforeFirstInput?: (sessionId: string) => Promise<void>;
  readonly store: Store;
  /** Last known provider info and capabilities, so start-up never waits for the CLIs. */
  readonly cache: DiskCache;
  readonly journal: AuthJournal;
  /** The built-in default account's instance of each provider. */
  readonly providers = new Map<ProviderId, Provider>();
  /** Instances for extra accounts, created on first use: `provider:accountId` → instance. */
  private instances = new Map<string, Provider>();
  private factories = new Map<ProviderId, (ctx: ProviderContext) => Provider>();
  /** Last known sign-in per extra account (the default account asks its provider every time, as before). */
  private infoCache = new Map<string, Promise<ProviderInfo>>();
  private authRetryAt = new Map<string, number>();
  private limitsCache = new Map<string, RateLimit[]>();
  /** Accounts whose last limits event named only some windows (`LimitsMeta.partial`): their cache lays over what the usage service knows. */
  private limitsPartial = new Set<string>();
  /** Called when an account's old limits are no longer its own (its sign-in changed): the usage service forgets them. */
  private limitsForgetters: ((provider: ProviderId, accountId: string) => void)[] = [];
  /** What each account's agent last said beside its windows (credits, extra usage), merged. */
  private limitsMeta = new Map<string, LimitsMeta>();
  /** Per agent: the limit handover moved sessions off the preferred account; new sessions use `to` until `until`. */
  private fallbacks = new Map<ProviderId, { from: string; to: string; until?: number }>();
  private resetTimer?: NodeJS.Timeout;
  private heldLimitsTimer?: NodeJS.Timeout;
  private limitsToastAt = new Map<string, number>();
  /** The confirmed reset reading can serve several chats returning to this dormant account. */
  private earlyResetRead = new Map<string, { at: number; seq: number; limits: RateLimit[] }>();
  private resetCheckedAt = Date.now();
  /** Sessions told once that they run on credits Sable was not allowed to use (per account and window). */
  private creditsWarned = new Set<string>();
  /** Counts `limits.updated` events from each account's provider (so `provider.limits` does not repeat one). */
  private limitsSeq = new Map<string, number>();
  readonly sessions = new Map<string, SessionRuntime>();
  private readonly conversationCopies: ConversationCopies;
  /** Updates of the desktop app (`services/update.ts`), when the shell can install them. */
  updates?: { readonly installing?: boolean; state: UpdateState; dispose(): void };
  private listeners = new Set<(e: BridgeEvent) => void>();
  private handlers = new Map<string, Handler<RpcName>>();
  private quiet: boolean;
  private delays: NonNullable<AppOptions['refreshDelays']>;
  private logins = new Map<string, { cancel: (timeout: boolean) => Promise<void> }>();
  private disposers: (() => void | Promise<void>)[] = [];
  /** Sessions of an agent that is not available in this build (the Demo outside development): kept on disk, not shown. */
  private hidden: SessionMeta[] = [];
  private userHome: string;
  private loginTimeoutMs: number;
  private compactTimeoutMs: number;
  private backgroundLimitMs?: { settle: number; max: number };
  /** Chats compacting on the account they leave, before a move: their compaction turn ends here, not in `afterTurn`. */
  private compacting = new Map<string, (error?: string) => void>();
  /** Chats moving to another account right now: a message sent meanwhile waits in the queue (`queuedWhileMoving`). */
  private moving = new Set<string>();
  /** How many chats are on their way to each account (`accountKey`): it is not removed meanwhile. */
  private movingTo = new Map<string, number>();
  /** Accounts being removed right now (`accountKey`): no chat starts a move to one. */
  private removingAccounts = new Set<string>();
  /** Chats whose file is there but could not be read: their timeline is empty, so no move may start them over from it. */
  private unreadable = new Set<string>();

  /** Returns due at the same moment go this far apart (`RETURN_AT_START_MS.gap`; tests shorten it). */
  private returnGapMs = RETURN_AT_START_MS.gap;
  private queuedWhileMoving = new Set<string>();
  /**
   * A summary of the conversation so far, sent ahead of the next message after a session moved to
   * an account that could not take the conversation itself (by session id).
   */
  private handovers = new Map<string, string>();
  /** Sessions whose agent is still starting after session.create answered (Codex's thread start can take most of a minute). */
  private opening = new Map<string, Promise<void>>();
  /** Sessions with a first message waiting for that start: they stay "starting" rather than flash idle. */
  private delivering = new Set<string>();
  /** Per session, the messages shown while the agent starts that still wait to go out. */
  private earlyWaiting = new Map<string, string[]>();
  /** Such messages the user stopped before the agent was there: never sent. */
  private stoppedEarly = new Set<string>();
  /**
   * Per session, the messages handed to its agent since its last turn ended: what the turn that ends
   * next took (a settled first turn is named from them, server/core/titles.ts). A message stopped
   * before the agent had it is never here; those of a failed or stopped turn are dropped with it.
   */
  private handed = new Map<string, string[]>();
  /** A retry has no second user card. Its result still belongs to the original request. */
  private retryOwners = new WeakMap<SessionRuntime, string>();

  /** `itemId` goes to the agent now (recorded first: a fast turn can end before the send returns). */
  private accountUse = new Map<string, number>();
  private handOver(rt: SessionRuntime, itemId: string) {
    this.accountUse.set(accountKey(rt.meta.provider, rt.meta.accountId ?? DEFAULT_ACCOUNT), Date.now());
    const list = this.handed.get(rt.id) ?? [];
    if (!list.includes(itemId)) list.push(itemId);
    this.handed.set(rt.id, list);
    return () => this.handed.set(rt.id, (this.handed.get(rt.id) ?? []).filter((id) => id !== itemId));
  }

  /**
   * The messages the turn that just ended took. A steer the agent has not taken yet stays for the
   * turn that takes it; after a failure or a stop nothing stays (untaken steers go back to the queue).
   */
  private consumed(rt: SessionRuntime, ok: boolean): string[] {
    const list = this.handed.get(rt.id) ?? [];
    // A message its agent answers on its own (Claude Code: a result per message) counts only on that
    // agent's word that it went ok: one that failed while a steer kept the turn going, or one with no
    // word at all, never names the chat.
    const taken = list.filter((id) => rt.get<UserItem>(id)?.state === 'sent' && rt.answeredOk(id));
    const waiting = ok ? list.filter((id) => rt.get<UserItem>(id)?.state === 'queued') : [];
    if (waiting.length) this.handed.set(rt.id, waiting);
    else this.handed.delete(rt.id);
    // Looked at now: only a steer still to be taken keeps its record, and what this turn took keeps its
    // own while the chat is named from it (right after); the next turn's end lets those go.
    rt.forgetOutcomes(ok ? [...waiting, ...taken] : []);
    return ok ? taken : [];
  }
  /** Accounts tried by this chain of refusals. A successful turn retires the chain. */
  private autoContinued = new WeakMap<SessionRuntime, { user?: string; accounts: Set<string> }>();
  /** Per session, the cap check in flight: a send and a turn's end never move a session twice. */
  private capChecks = new Map<string, Promise<void>>();
  /** Sessions told once that no account is under its cap, as `${sessionId}:${accountId}:${kind}:${resetsAt}`. */
  private capWarned = new Set<string>();
  /** `/until` loops (until green): the check Sable runs after each turn, and the failures it sends back. */
  private until = new UntilLoops({
    busy: (rt) => rt.turnActive || this.opening.has(rt.id) || this.delivering.has(rt.id),
    settle: (rt) => this.checkCap(rt),
    weekly: async (rt) => (await this.knownLimits(rt.meta.provider)).get(rt.meta.accountId ?? DEFAULT_ACCOUNT)?.limits?.find(isAllModelsWeekly),
    capped: async (rt) => {
      const accountId = rt.meta.accountId ?? DEFAULT_ACCOUNT;
      const cap = this.capOf(rt.meta.provider, accountId);
      if (!cap) return undefined;
      const reached = capReached((await this.knownLimits(rt.meta.provider)).get(accountId)?.limits, cap, this.chatModel(rt));
      return reached ? capReason(this.accountLabel(rt.meta.provider, accountId), reached) : undefined;
    },
    accountLabel: (rt) => this.accountLabel(rt.meta.provider, rt.meta.accountId ?? DEFAULT_ACCOUNT),
    send: async (rt, text, mark) => { await this.deliver(rt, text, undefined, { until: mark }); },
    run: runCheck,
    log: (...args) => this.log(...args),
  });
  /** Loops that were armed when Sable closed: their sessions say so when next opened. */
  private untilLost = new Map<string, NonNullable<SessionMeta['until']>>();
  /** Spare: chats that start by themselves on quota that would expire, or at a limit's reset (server/core/spare.ts). */
  private spare = new SpareWaits({
    sessions: () => this.sessions.values(),
    hydrate: rt => this.lazy.has(rt.id) ? this.hydrateAsync(rt) : undefined,
    busy: (rt) => rt.turnActive || this.opening.has(rt.id) || this.delivering.has(rt.id) || this.dispatching.has(rt.id) || this.moving.has(rt.id) || this.switching.has(rt.id),
    model: (rt) => this.chatModel(rt),
    resetModels: rt => {
      const card = this.openLimit(rt, rt.meta.spare?.refusalId);
      const rows = this.limitsCache.get(accountKey(rt.meta.provider, rt.meta.spare?.accountId ?? DEFAULT_ACCOUNT));
      return Object.values(this.refusalModels(card, rows)).filter((model): model is string => !!model);
    },
    accounts: (provider) => this.spareAccounts(provider),
    refresh: async (provider, accountId) => {
      if (this.dormant(provider, accountId)) return false;
      // Only the agent's own reading counts: a failed read hands back the last known rows.
      return (await this.readLimits(provider, accountId, true)).fresh;
    },
    refused: (rt) => this.refusedMessage(rt)?.id,
    start: (rt, accountId, wait) => this.startSpare(rt, accountId, wait),
    send: (rt, id) => this.sendHeld(rt, id),
    stop: async (rt, line) => {
      rt.stopRequested = true;
      await rt.handle?.interrupt();
      rt.notice('info', line, 'Spare never uses credits or extra usage');
    },
    accountLabel: (provider, accountId) => this.accountLabel(provider, accountId),
    log: (...args) => this.log(...args),
  });
  /** Lanes: a worktree of its own for a session whose folder another session is working in (server/core/lanes.ts). */
  private lanes = new Lanes({
    home: () => this.store.dir,
    root: () => this.worktreesRoot(),
    kept: path => this.emit({ type: 'toast', level: 'info', text: `Worktree kept at ${path}` }),
    load: (rt) => this.hydrateAsync(rt),
    sending: (rt) => this.sending.has(rt.id) || this.dispatching.has(rt.id) || this.moving.has(rt.id),
    sessions: () => this.sessions.values(),
    // Off unless turned on: a lane starts from the last commit, without the folder's uncommitted work.
    auto: () => this.store.state.settings.autoLanes === true,
    release: async (rt) => {
      await this.opening.get(rt.id)?.catch(() => {});
      rt.cancelPrompts();
      await this.detachWriter(rt);
    },
    configHome: (rt) => {
      try {
        return this.provider(rt.meta.provider, rt.meta.accountId ?? DEFAULT_ACCOUNT).configHome?.();
      } catch {
        return undefined;
      }
    },
    persist: () => this.persistSessions(),
    log: (...args) => this.log(...args),
  });

  /** Chat titles by a small model, once after a chat's first turn (server/core/titles.ts). */
  private titles = new ChatTitles({
    settings: () => this.store.state.settings,
    model: (owner) => this.titleModel(owner),
    open: (rt) => this.sessions.get(rt.id) === rt,
    log: (...args) => this.log(...args),
  });

  /** Race: one task to two agents at once, each in a lane of its own (server/core/race.ts). */
  private races = new Races({
    get: id => this.sessions.get(id),
    contenders: (cwd, hint) => this.raceContenders(cwd, hint),
    create: async (c, cwd, opts) => {
      const snap = await this.createSession({ provider: c.provider, cwd, ...(c.model ? { model: c.model } : {}), accountId: c.accountId, ...(opts.mode ? { mode: opts.mode } : {}) }, { lane: { slug: opts.slug, detail: opts.detail } });
      return this.runtime(snap.session.id);
    },
    remove: async (rt) => {
      await this.call('session.close', { sessionId: rt.id, remove: true });
    },
    send: async (rt, text) => {
      const entry = rt.enqueue(text);
      await rt.persistInput?.();
      void this.deliverQueued(rt, entry.id).catch(err => rt.queueReason(entry.id, String(err)));
    },
    stop: (rt) => this.stopForGood(rt),
    forecast: (rt) => this.lanes.forecast(rt),
    land: (rt, message) => this.lanes.land(rt, message),
    discard: async rt => {
      if (this.lazy.has(rt.id)) await this.hydrateAsync(rt);
      return this.lanes.discard(rt);
    },
    persist: () => this.persistSessions(),
    log: (...args) => this.log(...args),
  });

  /** "Check with Codex": the other agent reviewing a finished turn, read-only (server/core/check.ts). */
  private checks = new TurnChecks({
    available: (agent) => this.canCheckWith(agent),
    run: (parent, call, itemId, signal) =>
      runSubAgent(
        {
          provider: (id, account) => this.delegateProvider(id, account),
          accountFor: (id) => this.defaultAccountId(id),
          defaultModel: (id) => this.store.state.settings.defaultModels[id],
          modeFor: (id) => readOnlyMode(id),
          log: this.log,
        },
        parent,
        call,
        itemId,
        signal,
        { readOnly: true },
      ),
    busy: (rt) => rt.turnActive || this.opening.has(rt.id) || this.delivering.has(rt.id),
    log: (...args) => this.log(...args),
  });

  /** Limit resets used in the agent's own dialog, in a console window (server/core/reset-console.ts). */
  private resets: ResetConsoles;
  /** False where Sable cannot open a console window: the person runs the reset command in a terminal. */
  private consoles: boolean;
  /** Work agents started outside their tools and asked Sable to watch (`track_work`). */
  private tracker: WorkTracker;

  constructor(opts: AppOptions) {
    this.consoles = !!opts.openConsole || process.platform === 'win32';
    this.resets = new ResetConsoles({
      open: opts.openConsole ?? realConsole,
      journal: () => this.journal,
      command: (provider, accountId) => this.provider(provider, accountId).limitResetCommand?.(),
      cwd: () => {
        // A neutral folder of Sable's own, never a project.
        const dir = path.join(this.store.dir, 'limit-reset');
        mkdirSync(dir, { recursive: true });
        return dir;
      },
      title: (provider, accountId) => {
        const name = this.accountList(provider).length > 1 ? this.accountLabel(provider, accountId).replace(/["%^&|<>\r\n]/g, '').trim() : '';
        return `${this.provider(provider, accountId).name} reset${name ? ` (${name})` : ''}`;
      },
      known: (provider, accountId) => ({ limits: this.limitsCache.get(accountKey(provider, accountId)), signIn: this.signInGen.get(accountKey(provider, accountId)) ?? 0 }),
      read: (provider, accountId) => this.readLimits(provider, accountId, 'fresh'),
      cleared: (provider, accountId, windows) => this.limitsCleared(provider, accountId, windows),
      emit: (provider, accountId, run) => this.emit({ type: 'limit.resetRun', provider, accountId: accountId === DEFAULT_ACCOUNT ? undefined : accountId, run }),
      log: (...args) => this.log(...args),
      ...(opts.resetSettleMs !== undefined ? { settleMs: opts.resetSettleMs } : {}),
    });
    this.quiet = !!opts.quiet;
    this.delays = opts.refreshDelays ?? {};
    this.userHome = opts.userHome ?? homedir();
    this.loginTimeoutMs = opts.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
    this.compactTimeoutMs = opts.compactTimeoutMs ?? COMPACT_TIMEOUT_MS;
    this.backgroundLimitMs = opts.backgroundLimitMs;
    this.store = new Store(opts.home, (session, id) => this.sessions.get(session)?.get(id));
    this.tracker = new WorkTracker({ session: id => this.sessions.get(id), log: (...args) => this.log(...args) }, opts.trackProbe);
    this.delegateJournal = new DelegateJournal(this.store.dir);
    this.phoneReceipts = new PhoneReceipts(this.store.dir);
    this.onDispose(() => this.phoneReceipts.close());
    this.cache = new DiskCache(this.store.dir);
    this.journal = new AuthJournal(this.store.dir);
    this.onDispose(authGate.watchWake(() => this.journal.record(undefined, { event: 'wake' })));
    bootMark('app:store');
    for (const make of opts.providers) {
      const p = make(this.contextFor(DEFAULT_ACCOUNT));
      this.providers.set(p.id, p);
      this.factories.set(p.id, make);
    }
    this.registerCore();
    this.scheduleHeldLimits();
    this.restoreRegistry(opts.returnAtStartMs);
    this.conversationCopies = new ConversationCopies(this, () => this.disposed || !!this.updates?.installing, id => {
      const rt = this.sessions.get(id);
      if (!rt) return false; // An unavailable agent's chat can still own a saved leg.
      const w = this.workOf(rt);
      return !!(w.turn || w.agents || w.commands || rt.meta.moving || this.moveAttempts.has(rt) || this.switching.has(id) ||
        this.opening.has(id) || this.delivering.has(id) || this.dispatching.has(id) || this.sending.has(id) || this.writers.get(rt)?.size ||
        rt.meta.status === 'starting' || rt.meta.status === 'running' || rt.meta.status === 'awaiting');
    });
  }

  private restoreRegistry(pacing?: AppOptions['returnAtStartMs']) {
    const recovery: SessionRuntime[] = [];
    for (const meta of this.store.state.sessions) {
      if (!this.providers.has(meta.provider)) {
        this.hidden.push(meta);
        continue;
      }
      // Nothing survives a restart mid-turn: a chat that worked when Sable closed says so where its turn
      // was cut, once it is read (`loadInto`).
      if (meta.status === 'running' || meta.status === 'awaiting') meta.pendingRestart = true;
      meta.status = 'idle';
      meta.activity = undefined;
      // Remote links and live capability state belong to the agent process that is gone.
      meta.remote = meta.options?.remoteControl ? { status: 'Reconnects when the agent starts again', tone: 'waiting' } : undefined;
      meta.capState = undefined;
      // Background work lived in the agent process that is gone (its steps are stopped, its commands
      // lost, as the chat is read: `loadRestored`); so did a move that was under way.
      meta.background = undefined;
      meta.commands = undefined;
      meta.serving = undefined;
      meta.servingSince = undefined;
      meta.servingAddress = undefined;
      meta.moving = undefined;
      // An until loop does not outlive Sable: the session says so when it is opened.
      if (meta.until) this.untilLost.set(meta.id, meta.until), (meta.until = undefined);
      // A chat titled from a message the agent's harness wrote (`<task-notification>`): its plain words.
      const plain = meta.titleSource === 'user' || meta.titleAuthored ? meta.title : readableTitle(meta.title);
      // Existing timelines can prove this was a quotation once opened. Until then keep the title.
      if (plain !== meta.title && !existsSync(path.join(this.store.dir, 'sessions', meta.id + '.json'))) meta.title = plain || 'New session';
      const rt = this.makeRuntime(meta, true);
      this.sessions.set(meta.id, rt);
      // A chat with tracked work is read by itself too: its rows attach to their processes again, or say they ended.
      if (meta.delegateRecovery || meta.tracked) recovery.push(rt);
    }
    const pending = recovery.values();
    const hydrate = async () => {
      for (const rt of pending) {
        if (this.disposed) return;
        if (this.sessions.get(rt.id) !== rt) continue;
        const read = this.hydrateAsync(rt);
        try { await withDeadline(read, 90_000, 'Reading the saved delegate chat'); }
        catch (err) {
          if (!(err instanceof DeadlineExceeded)) { this.log('delegate recovery failed', err); continue; }
          if (!this.disposed) this.emit({ type: 'toast', level: 'error', text: 'Delegate recovery is delayed for ' + rt.meta.title + '. Its saved chat is still on disk.' });
          // Keep the two-reader limit even for stalled storage. Opening another chat is independent.
          const resume = () => { void hydrate(); };
          void read.then(resume, resume);
          return;
        }
      }
    };
    void Promise.all([hydrate(), hydrate()]);
    bootMark('app:sessions');
    this.seedFolderOrder();
    // Chats that waited when Sable closed go on waiting (a reset that passed meanwhile is due now).
    if (this.spare.hasWaits()) this.spare.poke(4000);
    // A chat a limit moved away still owes its return (its timer lived in the last run).
    // Soonest due first, never two within the gap: chats that left one account are due at the same reset.
    if (pacing) this.returnGapMs = pacing.gap;
    const owing = [...this.sessions.values()].filter((rt) => rt.meta.movedFrom).sort((a, b) => (a.meta.returnAt ?? 0) - (b.meta.returnAt ?? 0));
    const waits = returnsAtStart(owing.map((rt) => rt.meta.returnAt), Date.now(), pacing);
    owing.forEach((rt, i) => this.armReturn(rt, waits[i]));
  }

  log = (...args: unknown[]) => {
    if (!this.quiet) console.log('[sable]', ...args);
  };

  private rewindReceipts = new WeakMap<SessionRuntime, Map<string, Promise<{ ok: boolean; message?: string }>>>();
  private queueReceipts = new WeakMap<SessionRuntime, Map<string, QueuedMessage>>();
  private receiptsFor(rt: SessionRuntime) {
    let receipts = this.queueReceipts.get(rt);
    if (!receipts) this.queueReceipts.set(rt, receipts = new Map());
    return receipts;
  }
  /** Only displace the words and files that the requesting window has saved in full. */
  private revisedQueueRow(rt: SessionRuntime, id: string, expected?: QueuedMessage) {
    if (!expected) return;
    const row = rt.queue.find(q => q.id === id);
    if (row && (row.text !== expected.text || JSON.stringify(row.attachments ?? []) !== JSON.stringify(expected.attachments ?? []))) return row;
  }
  private pendingPrints = new WeakMap<SessionRuntime, Map<string, string>>();
  private submissionSlot(rt: SessionRuntime, id: string, print: string) {
    const queued = rt.queue.find(q => q.id === id || q.submitId === id);
    const user = rt.get(id);
    const original = queued ?? (user?.type === 'user' ? user : undefined);
    const first = original ? original.submitPrint ?? messagePrint(original.text, original.attachments) : this.pendingPrints.get(rt)?.get(id);
    return !first || first === print ? id : id + '/' + print;
  }

  private itemSequence = 0;
  private partVersions = new WeakMap<TimelineItem[], Map<string, number>>();
  private enqueueSubmission?: { rt: SessionRuntime; id: string };
  emit = (event: BridgeEvent) => {
    if (event.type === 'web.updated' || event.type === 'phone.updated' || event.type === 'update.state' || event.type === 'limits.updated' || event.type === 'limits.report' || event.type === 'settings.updated') {
      for (const rt of this.sessions.values()) {
        this.scheduleLossWake(rt);
        if (event.type === 'update.state' && !this.updates?.installing && this.updateDrains.delete(rt)) rt.onQueueRunnable?.();
      }
    }
    if (event.type === 'timeline.reset' || event.type === 'item.added' || event.type === 'item.removed' ||
        event.type === 'item.patch' || event.type === 'item.delta') {
      const rt = this.sessions.get(event.sessionId);
      if (rt) {
        this.snapshotEnds.delete(rt.items);
        if (event.type === 'timeline.reset') this.partVersions.delete(rt.items);
        else if (event.type !== 'item.added') this.partVersions.get(rt.items)?.delete(event.id);
      }
    }
    // enqueue publishes a row copy synchronously. Tag both copies before any subscriber sees it.
    const submission = this.enqueueSubmission;
    if (submission && event.type === 'queue.updated' && event.sessionId === submission.rt.id) {
      this.enqueueSubmission = undefined;
      const row = submission.rt.queue.at(-1);
      const published = event.queue.at(-1);
      if (row && published?.id === row.id) {
        row.id = published.id = row.submitId = published.submitId = submission.id;
        row.submitPrint = published.submitPrint = messagePrint(row.text, row.attachments);
      }
    }
    // A rewind can move a disk-backed step into the recent turns. A late patch/delta can
    // restart one. Restore that item in place before subscribers or the provider use it again.
    if (event.type === 'timeline.reset') {
      const rt = this.sessions.get(event.sessionId);
      if (rt) this.store.bindProviderInputs(rt.id, rt.items);
      const recent = recentStart(event.items, RECENT_TURNS);
      for (let i = 0; rt && i < event.items.length; i++) event.items[i] = { ...this.store.recut(rt.id, rt.items[i], i >= recent) };
    } else if (event.type === 'item.added' && event.item.type === 'turn') {
      const rt = this.sessions.get(event.sessionId);
      if (rt) {
        const end = recentStart(rt.items, RECENT_TURNS);
        for (let i = recentStart(rt.items, RECENT_TURNS + 1); i < end; i++) this.store.recut(rt.id, rt.items[i], false);
      }
    } else if (event.type === 'item.added' && isLight(event.item)) {
      event = { ...event, item: this.store.wholeItem(event.sessionId, event.item) };
    } else if (event.type === 'item.patch' || event.type === 'item.delta') {
      const item = this.sessions.get(event.sessionId)?.get(event.id);
      if (item && isLight(item)) {
        if (event.type === 'item.delta') {
          // Undo the runtime's append to the preview, then append to the original.
          const field = event.field;
          const values = item as Partial<Record<typeof field, string>>;
          const prefix = (values[field] ?? '').slice(0, -event.delta.length);
          if (prefix || field === 'text') values[field] = prefix;
          else delete values[field];
          this.store.promote(event.sessionId, item);
          values[field] = (values[field] ?? '') + event.delta;
          event = { type: 'item.patch', sessionId: event.sessionId, id: item.id, patch: { ...item, more: false } };
        } else if (!(item.type === 'user' && Object.keys(event.patch).every(k => k === 'providerId'))) {
          this.store.promote(event.sessionId, item);
          event = { ...event, patch: { ...item, more: false } };
        }
      }
    }
    if (event.type === 'item.patch' || event.type === 'item.delta' || event.type === 'item.removed') event = { ...event, seq: ++this.itemSequence };
    // Subscribers in this process still see native values. Socket frames carry explicit clears.
    if (event.type === 'session.updated') {
      const { patch } = event;
      if (Object.values(patch).some(value => value === undefined)) {
        const json = sessionPatchForJson(patch);
        event = { ...event, patch: Object.defineProperty({ ...patch }, 'toJSON', { value: () => json }) };
      }
    }
    for (const l of this.listeners) l(event);
  };

  subscribe(listener: (e: BridgeEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Runs `fn` first when the app is disposed (services stop their own work here). */
  onDispose(fn: () => void | Promise<void>) {
    this.disposers.push(fn);
  }

  register<M extends RpcName>(method: M, handler: Handler<M>) {
    this.handlers.set(method, handler as unknown as Handler<RpcName>);
  }

  private registryReady() {
    if (!this.store.registryUnavailable) return true;
    if (!this.store.reloadRegistry()) return false;
    this.restoreRegistry();
    this.emitProjects();
    this.emit({ type: 'settings.updated', settings: this.store.state.settings });
    for (const rt of this.sessions.values()) this.emit({ type: 'session.added', session: rt.meta });
    for (const id of this.providers.keys()) void this.emitProvider(id).catch(() => {});
    this.emit({ type: 'toast', level: 'success', text: 'Your saved chats and settings are available again.' });
    return true;
  }

  private registryRetry?: NodeJS.Timeout;
  private retryRegistry() {
    if (this.registryRetry || this.disposed) return;
    this.registryRetry = setTimeout(() => {
      this.registryRetry = undefined;
      if (!this.registryReady()) this.retryRegistry();
    }, 1500);
    this.registryRetry.unref();
  }

  async call<M extends RpcName>(method: M, params: RpcMethods[M]['params'], ctx: CallContext = {}): Promise<RpcMethods[M]['result']> {
    if (this.disposed) throw new NotNow('Sable is closing.');
    if (this.updates?.installing) throw new NotNow('Sable is restarting for an update.');
    if (!this.registryReady()) {
      const text = 'Sable could not read your saved chats and settings. Changes are paused while it tries again.';
      this.retryRegistry();
      if (method !== 'app.hello') throw new Error(text);
      this.emit({ type: 'toast', level: 'error', text });
      // The first retry can recover a short Windows lock before the first sidebar snapshot.
      // A longer lock keeps its retry timer and publishes the recovered state to connected windows.
      await new Promise(resolve => setTimeout(resolve, 1500));
      still(ctx);
      if (this.disposed) throw new Error(text);
    }
    const h = this.handlers.get(method);
    if (!h) throw new Error(`Unknown method: ${method}`);
    const id = (params as { sessionId?: string } | undefined)?.sessionId;
    // Send and Stop record their order before joining the same cold read.
    if (id && this.lazy.has(id) && method !== 'session.snapshot' && method !== 'session.send' && method !== 'session.interrupt') {
      await this.hydrateAsync(this.runtime(id));
      still(ctx);
    }
    if (id && method.startsWith('queue.') && this.unreadable.has(id)) throw new Error('This chat could not be read from disk');
    if (this.disposed) throw new NotNow('Sable is closing.');
    return (await h(params as never, ctx)) as RpcMethods[M]['result'];
  }

  /** The provider instance for an account (the default account when `accountId` is absent). */
  provider(id: ProviderId, accountId: string = DEFAULT_ACCOUNT): Provider {
    const p = this.providers.get(id);
    const make = this.factories.get(id);
    if (!p || !make) throw new Error(`Provider not available: ${id}`);
    if (accountId === DEFAULT_ACCOUNT) return p;
    const key = accountKey(id, accountId);
    let inst = this.instances.get(key);
    if (inst) return inst;
    if (!this.findAccount(id, accountId)) throw new Error('This account was removed. Pick another account for this agent.');
    inst = make(this.contextFor(accountId, this.accountDir(id, accountId)));
    this.instances.set(key, inst);
    return inst;
  }

  // ── accounts ──

  private delegateProvider(id: ProviderId, account?: string) {
    const provider = this.provider(id, account);
    return provider.forDelegate?.() ?? provider;
  }

  private contextFor(accountId: string, dir?: string): ProviderContext {
    return {
      log: this.log,
      emit: (e) => this.fromProvider(accountId, e),
      journal: this.journal,
      closing: () => this.disposed || !!this.updates?.installing,
      dormant: provider => this.dormant(provider, accountId),
      account: accountId === DEFAULT_ACCOUNT ? undefined : { id: accountId, dir },
      settings: () => this.store.state.settings,
      otherAgents: () => this.otherAgents(),
      profile: () => profileOf(this),
      customBrief: () => customOf(this).brief(),
      trackWork: (session, args, itemId) => {
        const rt = this.sessions.get(session.id);
        if (this.disposed || !rt || rt.meta !== session.meta) return { ok: false, text: 'No session is attached yet.' };
        return this.tracker.track(rt, args, itemId);
      },
      runAgent: (session, call, itemId, signal) => {
        const rt = this.sessions.get(session.id);
        if (this.disposed || !rt || rt.meta !== session.meta) return Promise.resolve({ ok: false, text: 'No session is attached yet.' });
        return runSubAgent(
          {
            provider: (id, account) => this.delegateProvider(id, account),
            accountFor: (id) => this.defaultAccountId(id),
            defaultModel: (id) => this.store.state.settings.defaultModels[id],
            modeFor: subAgentMode,
            log: this.log,
          },
          rt,
          call,
          itemId,
          signal,
        );
      },
    };
  }

  /** The agents a session can hand work to: Claude Code and Codex where installed and signed in (last known). */
  private otherAgents(): ProviderId[] {
    return (['claude', 'codex'] as ProviderId[]).filter((id) => {
      if (!this.providers.has(id)) return false;
      const info = this.cache.get<ProviderInfo>(`info:${id}`);
      return !!info?.installed && !!info.auth?.loggedIn;
    });
  }

  /**
   * The model that names a chat: its own agent's smallest, on the chat's own account (Claude Code's
   * Haiku, Codex's smallest model). Never another agent's or another account's: an agent without
   * one leaves the chat its title.
   */
  private titleModel(owner: TitleOwner): TitleModel | undefined {
    try {
      const p = this.provider(owner.provider, owner.accountId);
      return p.quickTitle ? (prompt: TitlePrompt, signal: AbortSignal, holds?: () => boolean) => p.quickTitle!(prompt, signal, holds) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * A commit message for a chat's changes, written by its own agent's smallest model on the chat's
   * own account, as chat titles are (`titleModel`: Claude Code's Haiku, Codex's smallest model; never
   * another agent's or account's). Only on the person's click. Nothing is staged or committed: the
   * person reads it and commits.
   */
  private async draftCommit(sessionId: string, cwd: string): Promise<{ ok: boolean; message?: string; error?: string }> {
    const rt = this.runtime(sessionId);
    const owner = { provider: rt.meta.provider, accountId: rt.meta.accountId ?? DEFAULT_ACCOUNT };
    const model = this.titleModel(owner);
    if (!model) return { ok: false, error: `${this.agentName(owner.provider)} cannot write a commit message. Write one yourself.` };
    const input = await gitDraftInput(cwd);
    if ('error' in input) return { ok: false, error: input.error };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const message = cleanCommit(await model(commitPrompt(input, path.resolve(cwd)), ctrl.signal));
      return message ? { ok: true, message } : { ok: false, error: 'The model gave no message. Write one yourself.' };
    } catch (err) {
      return { ok: false, error: (err as Error).message || 'The message could not be written.' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Whether `agent` can check a turn now: the Demo always, Claude Code and Codex where installed and signed in (last known). */
  private canCheckWith(agent: ProviderId): boolean {
    if (!this.providers.has(agent)) return false;
    return agent === 'demo' || this.otherAgents().includes(agent);
  }

  /** Tags a provider instance's events with its account and keeps the per-account caches current. */
  private fromProvider(accountId: string, e: BridgeEvent) {
    switch (e.type) {
      case 'auth.progress':
        return this.emit({ ...e, accountId });
      case 'limits.updated': {
        const key = accountKey(e.provider, accountId);
        const before = this.limitsCache.get(key) ?? [];
        const rows = e.meta?.partial ? mergeWindows(before, e.limits) : e.limits;
        this.limitsCache.set(key, rows);
        if (e.meta?.partial) this.limitsPartial.add(key);
        else this.limitsPartial.delete(key);
        if (e.meta) this.limitsMeta.set(key, { ...this.limitsMeta.get(key), ...e.meta });
        this.limitsSeq.set(key, (this.limitsSeq.get(key) ?? 0) + 1);
        this.scheduleResetAlert();
        this.emit({ ...e, accountId });
        // After the usage service has recorded the read (it listens to the event above). Past a
        // limit on credits now (a full window, not a flag left from before a reset): a spare turn there stops.
        const now = Date.now();
        const past = e.limits.some((l) => l.percent >= 100 && !(l.resetsAt && l.resetsAt <= now));
        this.spare.limitsChanged(e.provider, accountId, past && runningOnCredits(this.limitsMeta.get(key)));
        // The dialog compares its own before and after, including its second read.
        if ((e.provider === 'claude' || e.provider === 'codex') && !this.disposed && !this.updates?.installing && !this.resets.current(e.provider, accountId)) {
          const cleared = clearedWindows(before, e.limits, now);
          if (cleared.length) this.limitsCleared(e.provider, accountId, cleared, e.limits);
        }
        return;
      }
      case 'provider.updated':
        if (accountId !== DEFAULT_ACCOUNT) {
          const key = accountKey(e.provider.id, accountId);
          if (e.provider.auth.checking || e.provider.problem) this.infoCache.delete(key);
          else this.infoCache.set(key, Promise.resolve(e.provider));
        }
        void this.emitProvider(e.provider.id).catch(() => {});
        return;
      case 'caps.updated': {
        const tagged = { ...e, accountId: accountId === DEFAULT_ACCOUNT ? undefined : accountId };
        // Only news when it differs from what the UI was given.
        if (this.storeCaps(e.provider, accountId, e.cwd, e.caps)) this.emit(tagged);
        return;
      }
      default:
        return this.emit(e);
    }
  }

  /** Where an extra account's config lives: Sable's own folder for it, or the folder the user registered. */
  accountDir(provider: ProviderId, accountId: string) {
    const own = this.store.state.accounts.find((a) => a.provider === provider && a.id === accountId)?.dir;
    return own ?? path.join(this.store.dir, 'accounts', provider, accountId);
  }

  private findAccount(provider: ProviderId, accountId: string): StoredAccount | undefined {
    return this.accountList(provider).find((a) => a.id === accountId);
  }

  /** The provider's accounts in the order the person set (`settings.accountOrder`), else the built-in default first. */
  accountList(provider: ProviderId): StoredAccount[] {
    const mine = this.store.state.accounts.filter((a) => a.provider === provider);
    const def = mine.find((a) => a.id === DEFAULT_ACCOUNT) ?? { id: DEFAULT_ACCOUNT, provider, label: DEFAULT_ACCOUNT_LABEL, createdAt: 0 };
    return orderAccounts([def, ...mine.filter((a) => a.id !== DEFAULT_ACCOUNT)], this.store.state.settings.accountOrder?.[provider]);
  }

  /** The account new sessions with this provider use. */
  defaultAccountId(provider: ProviderId): string {
    const chosen = this.store.state.settings.defaultAccounts?.[provider];
    const preferred = chosen && this.findAccount(provider, chosen) ? chosen : DEFAULT_ACCOUNT;
    // After a limit handover new sessions start where the sessions went, until the preferred
    // account's limit resets (with "Return to the preferred account" on) or for good (off).
    const fb = this.fallbacks.get(provider);
    if (!fb || fb.from !== preferred || !this.findAccount(provider, fb.to)) return preferred;
    if (this.store.state.settings.returnToPreferred && (!fb.until || Date.now() >= fb.until)) {
      this.fallbacks.delete(provider);
      return preferred;
    }
    return fb.to;
  }

  // ── limit resets ──

  /** Only cached sign-ins and readings are inspected. Leave a gap after each actual attempt. */
  private scheduleHeldLimits(pending?: { provider: ProviderId; accountId: string }[]) {
    if (this.disposed || (!this.providers.has('claude') && !this.providers.has('codex'))) return;
    const delay = pending?.length ? 4000 : (29 + 2 * Math.random()) * 60_000;
    this.heldLimitsTimer = setTimeout(() => {
      const accounts = pending?.length ? pending : [...this.providers.keys()]
        .filter(p => p === 'claude' || p === 'codex')
        .flatMap(provider => this.accountList(provider).map(a => ({ provider, accountId: a.id })));
      void this.readNextHeld(accounts).catch(err => this.log('Held limits read failed', err))
        .finally(() => this.scheduleHeldLimits(accounts));
    }, delay);
    this.heldLimitsTimer.unref?.();
  }

  private async readNextHeld(accounts: { provider: ProviderId; accountId: string }[]) {
    const readings = new Map<ProviderId, KnownLimits>();
    while (accounts.length && !this.disposed) {
      const { provider, accountId } = accounts.shift()!;
      if (this.updates?.installing || authGate.readsPaused()) continue;
      if (!readings.has(provider)) readings.set(provider, await this.knownLimits(provider));
      const info = this.cache.get<ProviderInfo>(`info:${provider}`);
      const account = info?.accounts?.find(a => a.id === accountId);
      const auth = account?.auth ?? (accountId === DEFAULT_ACCOUNT ? info?.auth : undefined);
      if (!info?.installed || !auth?.loggedIn || isApiKeyAuth(auth) || !this.findAccount(provider, accountId)) continue;
      const key = accountKey(provider, accountId);
      const known = readings.get(provider)?.get(accountId);
      if ((this.limitsMeta.get(key)?.planLimits ?? known?.planLimits) === false) continue;
      const limits = known?.limits ?? account?.limits ?? [];
      if (!heldForLimits(limits, this.capOf(provider, accountId), Date.now())) continue;
      if (!this.limitsCache.get(key)?.length) this.limitsCache.set(key, limits);
      await this.readLimits(provider, accountId, true);
      break;
    }
  }

  private capped() {
    return [...this.limitsCache.entries()].map(([key, limits]) => {
      const [provider, ...rest] = key.split(':');
      return { provider: provider as ProviderId, accountId: rest.join(':') || DEFAULT_ACCOUNT, limits };
    });
  }

  /** One timer for the next reset of a full window: announced (when wanted), and the fallback account ends. */
  private scheduleResetAlert() {
    clearTimeout(this.resetTimer);
    this.resetTimer = undefined;
    if (this.disposed) return;
    const settings = this.store.state.settings;
    const fallbackEnds = [...this.fallbacks.values()].map((f) => f.until ?? 0).filter((t) => t > Date.now());
    if (!settings.notifyLimitReset && !fallbackEnds.length) return;
    const next = settings.notifyLimitReset ? nextResetAlert(this.capped(), Date.now())?.at : undefined;
    const at = Math.min(next ?? Infinity, ...fallbackEnds);
    if (!Number.isFinite(at)) return;
    // Long waits are re-armed in steps (a laptop may sleep through one).
    this.resetTimer = setTimeout(() => this.onResetDue(), Math.min(Math.max(0, at - Date.now()) + 500, 6 * 3600_000));
    this.resetTimer.unref?.();
  }

  /**
   * A fresh reading confirmed an early reset. Release the same waits whether the reset was
   * discovered by a limits read or confirmed after the agent's reset dialog.
   */
  private limitsCleared(provider: ProviderId, accountId: string, windows: RateLimit[], read = this.limitsCache.get(accountKey(provider, accountId))) {
    // Chats that waited go on only where every window holding their model has room now (the planner
    // checks the fresh reading); the windows that cleared say whose wait this was.
    void this.spare.resetCleared(provider, accountId, windows).catch(err => this.log('Could not resume reset wait', err));
    const fb = this.fallbacks.get(provider);
    const now = Date.now();
    const key = accountKey(provider, accountId);
    if (read) this.earlyResetRead.set(key, { at: now, seq: this.limitsSeq.get(key) ?? 0, limits: read });
    for (const w of windows) this.notifyReset(provider, accountId, w.label, now);
    for (const rt of this.sessions.values()) {
      if (rt.meta.provider !== provider || rt.meta.movedFrom !== accountId) continue;
      const models = [this.chatModel(rt), ...(rt.meta.returnModels ?? [])];
      if (!windows.some(w => models.some(m => windowForModel(w, m)))) continue;
      rt.update({ returnAt: now });
      this.returnChecked.delete(rt.id);
      this.armReturn(rt);
    }
    if (fb && fb.from === accountId && fb.until && fb.until > now) {
      // New chats return only once no window that holds the agent's default model stays full: a
      // weekly window still full keeps them away until its own reset (review wave 8, #18).
      const model = effectiveModel(undefined, this.cachedCaps(provider, accountId)?.models, this.store.state.settings.defaultModels[provider]);
      const still = (this.limitsCache.get(accountKey(provider, accountId)) ?? []).filter(
        (l) => l.percent >= 100 && !(l.resetsAt && l.resetsAt <= now) && (!windowModel(l) || !model || windowForModel(l, model)),
      );
      if (!still.length) fb.until = now;
      else if (still.every((l) => l.resetsAt)) fb.until = Math.max(...still.map((l) => l.resetsAt!));
      void this.emitProvider(provider).catch(() => {});
    }
    this.scheduleResetAlert();
  }

  private notifyReset(provider: ProviderId, accountId: string, window: string, at: number) {
    if (this.store.state.settings.notifyLimitReset)
      this.emit({ type: 'limit.reset', provider, accountId: accountId === DEFAULT_ACCOUNT ? undefined : accountId, window, at });
  }

  private onResetDue() {
    const now = Date.now();
    const due = dueResets(this.capped(), this.resetCheckedAt, now);
    this.resetCheckedAt = now;
    for (const r of due) this.notifyReset(r.provider, r.accountId, r.window, r.at);
    for (const [provider, fb] of this.fallbacks) if (fb.until && fb.until <= now) void this.emitProvider(provider).catch(() => {});
    this.scheduleResetAlert();
  }

  /** A passive refresh can use the last answer for accounts untouched for two hours. */
  private dormant(provider: ProviderId, accountId: string) {
    if (provider !== 'claude' && provider !== 'codex') return false;
    const since = Date.now() - 2 * 3600_000;
    if ((this.accountUse.get(accountKey(provider, accountId)) ?? 0) >= since || (this.findAccount(provider, accountId)?.createdAt ?? 0) >= since) return false;
    for (const rt of this.sessions.values()) {
      if (rt.meta.provider === provider && (rt.meta.accountId ?? DEFAULT_ACCOUNT) === accountId && (rt.turnActive || rt.meta.updatedAt >= since)) return false;
    }
    return true;
  }

  private accountAuth(provider: ProviderId, accountId: string, force: boolean): Promise<ProviderInfo> {
    const key = accountKey(provider, accountId);
    const hit = this.infoCache.get(key);
    if (hit && !force) return hit;
    const p = this.provider(provider, accountId);
    // A first read of several accounts at once (start-up) is staggered a little per account (auth-gate.ts).
    const retry = this.authRetryAt.get(key);
    const lag = force ? 0 : Math.max((retry ?? 0) - Date.now(), accountId === DEFAULT_ACCOUNT ? 0 : authGate.stagger(key, 600, 200));
    const info: Promise<ProviderInfo> = (lag ? new Promise<void>((r) => setTimeout(r, lag)) : Promise.resolve()).then(() => {
      const newer = this.infoCache.get(key);
      if (newer && newer !== info) return newer;
      return p.info(force);
    }).catch(() => fallbackInfo(p)).then(answer => {
      if (this.infoCache.get(key) === info) {
        const inconclusive = answer.auth.checking || answer.problem;
        if (inconclusive) this.authRetryAt.set(key, retry === undefined ? 0 : Date.now() + 10_000);
        else this.authRetryAt.delete(key);
        if (inconclusive || accountId === DEFAULT_ACCOUNT) this.infoCache.delete(key);
      }
      return answer;
    });
    this.infoCache.set(key, info);
    return info;
  }

  /** The provider as the UI sees it: the default account's CLI state plus every account. `force` re-reads one account. */
  async providerInfo(provider: ProviderId, force?: string, nameFromLogin = false): Promise<ProviderInfo> {
    const previous = this.cache.get<ProviderInfo>(`info:${provider}`);
    const coldBase = force !== DEFAULT_ACCOUNT && previous?.installed && this.dormant(provider, DEFAULT_ACCOUNT);
    const status = coldBase ? previous : await this.accountAuth(provider, DEFAULT_ACCOUNT, force === DEFAULT_ACCOUNT);
    const base = status.auth.checking && previous?.installed ? { ...status, installed: true, version: status.version ?? previous.version } : status;
    const defaultId = this.defaultAccountId(provider);
    const signIns = await Promise.all(
      this.accountList(provider).map(async (a) => {
        const own = a.id === DEFAULT_ACCOUNT;
        // A missing CLI has no accounts to ask about.
        const cached = previous?.accounts?.find(row => row.id === a.id);
        const cold = own ? coldBase : force !== a.id && this.dormant(provider, a.id);
        const info = own ? base : cold ? cached : base.installed ? await this.accountAuth(provider, a.id, force === a.id) : undefined;
        const read = info?.auth ?? { loggedIn: false, ...(cold && { checking: true }) };
        const known = cached?.auth ?? (own ? previous?.auth : undefined);
        const auth = read.checking && known?.loggedIn ? known : read;
        return { a, own, info, cold, auth };
      }),
    );
    // The sign-ins first: one that changed forgets the old person's limits before any snapshot copies
    // them (review wave 8, #26).
    this.noteSignIns(
      provider,
      signIns.filter(s => !s.cold && !s.info?.auth.checking && !s.info?.problem).map((s) => ({ id: s.a.id, auth: s.auth })),
    );
    if (nameFromLogin) {
      const row = signIns.find(s => s.a.id === force);
      if (row?.a.autoLabel && row.info?.auth.loggedIn && !row.info.auth.checking && !row.info.problem) {
        const name = labelFromAuth(row.info.auth, signIns.filter(s => s !== row).map(s => s.a.label));
        if (name) {
          row.a.label = name;
          row.a.autoLabel = false;
          this.store.saveState();
        }
      }
    }
    const accounts = signIns.map(
      ({ a, own, info, auth }): AccountInfo => ({
        id: a.id,
        provider,
        label: a.label,
        isDefault: a.id === defaultId,
        auth,
        limits: this.limitsCache.get(accountKey(provider, a.id)),
        dir: own ? undefined : this.accountDir(provider, a.id),
        problem: own ? undefined : info?.problem,
        ...(a.dir ? { external: true } : {}),
        ...resetCommandOf(this.provider(provider, a.id)),
      }),
    );
    const limitReset = limitResetVia(this.consoles, this.provider(provider));
    return { ...base, auth: accounts.find(a => a.id === DEFAULT_ACCOUNT)?.auth ?? base.auth, accounts, ...(limitReset ? { limitReset } : {}) };
  }

  /**
   * The sign-in each account's limits were read under. One that changed (another person, a
   * subscription replaced by an API key) makes the old reading another account's: it is forgotten
   * (review wave 7, #3).
   */
  private noteSignIns(provider: ProviderId, accounts: Pick<AccountInfo, 'id' | 'auth'>[]) {
    for (const a of accounts) {
      if (!a.auth.loggedIn) continue;
      // Chats that waited for this account's sign-in carry on (server/core/auth-gate.ts).
      this.resumeSignedIn(provider, a.id);
      const now = signInOf(a.auth);
      const key = `signin:${accountKey(provider, a.id)}`;
      const was = this.cache.get<SignIn>(key);
      if (was && was.apiKey === now.apiKey && (was.email ?? '') === (now.email ?? was.email ?? '')) continue;
      // The same sign-in told with its address now: kept, nothing forgotten.
      this.cache.set(key, { ...now, email: now.email ?? was?.email });
      if (was && (was.apiKey !== now.apiKey || (!!was.email && !!now.email && was.email !== now.email))) this.forgetLimits(provider, a.id);
    }
  }

  private forgetLimits(provider: ProviderId, accountId: string) {
    const key = accountKey(provider, accountId);
    const hadLimits = !!this.limitsCache.get(key)?.length;
    this.earlyResetRead.delete(key);
    limitsAfterTurn.delete(this.provider(provider, accountId));
    this.limitsCache.delete(key);
    this.limitsPartial.delete(key);
    this.limitsMeta.delete(key);
    // When: a reading older than this (a transcript's snapshot, a reset's "before") is the old person's.
    this.cache.set(`limits-forgotten:${key}`, Math.max(Date.now(), this.limitsForgottenAt(provider, accountId) + 1));
    this.signInGen.set(key, (this.signInGen.get(key) ?? 0) + 1);
    for (const fn of this.limitsForgetters) fn(provider, accountId);
    if (hadLimits) this.emit({ type: 'limits.updated', provider, accountId, limits: [] });
  }

  /**
   * Reads an account's limits from its agent. `fresh`: the agent itself announced a reading while
   * this one ran (a throttled or refused read hands back the last known rows and says nothing).
   * `force: 'fresh'` goes past the agent's own throttles (a reset's reading after its dialog).
   */
  private async readLimits(provider: ProviderId, accountId: string, force: boolean | 'fresh', { requested = !!force, feedback = false } = {}): Promise<{ limits: RateLimit[]; fresh: boolean; signIn: number }> {
    const key = accountKey(provider, accountId);
    const signIn = this.signInGen.get(key) ?? 0;
    const cached = () => ({ limits: this.limitsCache.get(key) ?? [], fresh: false, signIn });
    const p = this.provider(provider, accountId);
    const plan = provider === 'claude' || provider === 'codex';
    if (feedback && plan && !this.limitsCache.get(key)?.length && this.handlers.has('usage.limits')) {
      // First click after a restart: the old full window may exist only in the limits book.
      const known = (await this.knownLimits(provider)).get(accountId)?.limits;
      if (signIn !== (this.signInGen.get(key) ?? 0) || !this.findAccount(provider, accountId)) return cached();
      if (known?.length && !this.limitsCache.get(key)?.length) this.limitsCache.set(key, known);
    }
    if (this.disposed || this.updates?.installing) return cached();
    const busy = () => [...this.sessions.values()].some(s => s.meta.provider === provider && (s.meta.accountId ?? DEFAULT_ACCOUNT) === accountId && s.turnActive);
    const skipped = () => {
      if (force !== true || this.disposed || this.updates?.installing) return;
      const working = plan && (busy() || limitsAfterTurn.has(p));
      if (working) limitsAfterTurn.add(p);
      if (!feedback) return;
      const now = Date.now();
      if (now - (this.limitsToastAt.get(key) ?? -Infinity) < 60_000) return;
      this.limitsToastAt.set(key, now);
      const label = this.accountLabel(provider, accountId);
      this.emit({ type: 'toast', level: 'info', text: working ? `${label} is working. Its limits are read when the turn ends.` : `Limits for ${label} could not be read just now.` });
    };
    if (plan && (authGate.readsPaused() || busy() || (!requested && this.dormant(provider, accountId)))) {
      skipped();
      return cached();
    }
    let limits: RateLimit[];
    const seq = this.limitsSeq.get(key) ?? 0;
    try { limits = await p.limits(force); }
    catch (err) {
      skipped();
      if (!feedback) throw err;
      return cached();
    }
    const fresh = (this.limitsSeq.get(key) ?? 0) > seq;
    // A sign-in that changed meanwhile: this reading may be the previous person's; it is not kept.
    if ((this.signInGen.get(key) ?? 0) !== signIn) return { limits: this.limitsCache.get(key) ?? [], fresh: false, signIn: this.signInGen.get(key) ?? 0 };
    // A provider that read them announced it already (with what it knows about the read).
    if (!fresh) {
      skipped();
      limits = this.limitsCache.get(key) ?? limits;
      this.emit({ type: 'limits.updated', provider, accountId, limits });
    }
    return { limits, fresh, signIn };
  }

  /** When an account's limits were last forgotten for a changed sign-in (0: never). */
  limitsForgottenAt(provider: ProviderId, accountId: string): number {
    return this.cache.get<number>(`limits-forgotten:${accountKey(provider, accountId)}`) ?? 0;
  }

  /** Counts the sign-in changes of each account in this run (a reset's reading before and after must share one). */
  private signInGen = new Map<string, number>();

  /** The usage service forgets an account's limits when they are no longer its own (`noteSignIns`). */
  onLimitsForgotten(fn: (provider: ProviderId, accountId: string) => void) {
    this.limitsForgetters.push(fn);
  }

  private async emitProvider(provider: ProviderId, force?: string, nameFromLogin = false) {
    const info = await this.providerInfo(provider, force, nameFromLogin);
    this.cache.set(`info:${provider}`, info);
    this.emit({ type: 'provider.updated', provider: info });
    return info;
  }

  private refreshing = new Map<ProviderId, Promise<unknown>>();

  /**
   * The provider for app.hello: the last known answer from disk when there is one (refreshed in
   * the background and pushed as `provider.updated`), otherwise asked for now.
   */
  private providerInfoFast(provider: ProviderId): Promise<ProviderInfo> {
    const cached = this.cache.get<ProviderInfo>(`info:${provider}`);
    if (!cached?.installed) return this.providerInfoNoWait(provider, cached);
    if (!this.refreshing.has(provider)) {
      // Not right away: start-up stays quiet (starting a CLI can make it sync plugins over the
      // network), and anything that needs the agent sooner asks it then.
      const run = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.delays.info ?? INFO_REFRESH_DELAY_MS);
        t.unref?.();
        this.onDispose(() => (clearTimeout(t), resolve()));
      })
        .then(() => (this.disposed ? undefined : this.emitProvider(provider)))
        .catch(() => {})
        .finally(() => this.refreshing.delete(provider));
      this.refreshing.set(provider, run);
    }
    // Account names and the default come from the store, sign-in from the cache.
    const defaultId = this.defaultAccountId(provider);
    const accounts = this.accountList(provider).map((a): AccountInfo => {
      const prev = cached.accounts?.find((x) => x.id === a.id);
      return {
        id: a.id,
        provider,
        label: a.label,
        isDefault: a.id === defaultId,
        auth: prev?.auth ?? (a.id === DEFAULT_ACCOUNT ? cached.auth : { loggedIn: false, checking: true }),
        limits: this.limitsCache.get(accountKey(provider, a.id)) ?? prev?.limits,
        dir: a.id === DEFAULT_ACCOUNT ? undefined : this.accountDir(provider, a.id),
        problem: prev?.problem,
        ...(a.dir ? { external: true } : {}),
        ...resetCommandOf(this.provider(provider, a.id)),
      };
    });
    // Setup warnings belong to the run that saw them: the fresh read brings this run's.
    return Promise.resolve({ ...cached, accounts, warnings: undefined });
  }

  /** The agent's own answer when nothing usable was cached, asked once at a time. */
  private asking = new Map<ProviderId, Promise<ProviderInfo>>();

  /**
   * The provider for app.hello when nothing usable is cached (the first start, or an agent that was
   * not installed last time): the agent is asked now, and hello takes its answer only if it comes
   * within a moment (`FIRST_INFO_WAIT_MS`: the Demo's, a missing CLI's). Otherwise hello answers with
   * what is known without the CLI (installed by a look at PATH, the sign-in `checking`: neither in
   * nor out) and the answer goes out as `provider.updated` when it is in.
   */
  private providerInfoNoWait(provider: ProviderId, cached: ProviderInfo | undefined): Promise<ProviderInfo> {
    let asked = this.asking.get(provider);
    if (!asked) {
      const p = this.provider(provider);
      asked = this.providerInfo(provider)
        .catch(() => fallbackInfo(p) as ProviderInfo)
        .then((info) => {
          if (!this.disposed) this.cache.set(`info:${provider}`, info);
          return info;
        });
      this.asking.set(provider, asked);
      asked.finally(() => this.asking.delete(provider)).catch(() => {});
    }
    let late = false;
    const answered = asked;
    void answered.then((info) => {
      if (late && !this.disposed) this.emit({ type: 'provider.updated', provider: info });
    });
    const wait = this.delays.firstInfo ?? FIRST_INFO_WAIT_MS;
    // Looked for beside the wait, off this thread (a PATH entry on a dead drive must not hold the bridge).
    const present = cliPresentSoon(provider, wait + 150);
    return Promise.race([
      answered,
      new Promise<ProviderInfo>((resolve) => {
        const t = setTimeout(() => {
          late = true;
          void present.then((installed) => resolve(this.provisionalInfo(provider, cached, installed)));
        }, wait);
        t.unref?.();
        void answered.then(() => clearTimeout(t));
      }),
    ]);
  }

  /**
   * The first word of an agent hello did not wait for, while it is still on its way (the first
   * seconds of a first start). Hello alone goes ahead on a guess: whatever decides by an agent's
   * sign-in or by its accounts' limits (where a chat starts or moves, who races, which agents a
   * session may hand work to) waits here first. Nothing to wait for at any other time. `ms`: at
   * most this long.
   */
  private firstWord(provider?: ProviderId, ms?: number): Promise<void> {
    const waits = provider ? [this.asking.get(provider)] : [...this.asking.values()];
    const all = Promise.all(waits.filter((w): w is Promise<ProviderInfo> => !!w)).then(
      () => {},
      () => {},
    );
    if (ms === undefined || !waits.some(Boolean)) return all;
    return Promise.race([
      all,
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        t.unref?.();
        void all.then(() => clearTimeout(t));
      }),
    ]);
  }

  /**
   * The provider for a caller that cannot show "not known yet" (`CallContext.settled`): where hello
   * would say `checking`, the agent's own answer, which is on its way, is waited for. Bounded past
   * the CLIs' own time limits; an agent that has not answered by then is told as it is.
   */
  private async providerInfoSettled(provider: ProviderId): Promise<ProviderInfo> {
    const info = await this.providerInfoFast(provider);
    if (!info.auth.checking) return info;
    const asked = this.asking.get(provider);
    // Answered in the meantime: the answer is the cached one.
    if (!asked) return this.cache.get<ProviderInfo>(`info:${provider}`) ?? info;
    return Promise.race([
      asked,
      new Promise<ProviderInfo>((resolve) => {
        const t = setTimeout(() => resolve(info), this.delays.settledInfo ?? SETTLED_INFO_WAIT_MS);
        t.unref?.();
        void asked.then(() => clearTimeout(t));
      }),
    ]);
  }

  /** What hello says of an agent before its CLI answered: nothing that needs the CLI. */
  private provisionalInfo(provider: ProviderId, cached: ProviderInfo | undefined, present: boolean | undefined): ProviderInfo {
    const p = this.provider(provider);
    // Not known in time (a slow drive in PATH): taken as there, its sign-in `checking`; the agent's own answer says.
    const installed = present ?? true;
    const auth: AuthState = installed ? { loggedIn: false, checking: true } : { loggedIn: false };
    const defaultId = this.defaultAccountId(provider);
    const accounts = this.accountList(provider).map(
      (a): AccountInfo => ({
        id: a.id,
        provider,
        label: a.label,
        isDefault: a.id === defaultId,
        auth,
        limits: this.limitsCache.get(accountKey(provider, a.id)),
        dir: a.id === DEFAULT_ACCOUNT ? undefined : this.accountDir(provider, a.id),
        ...(a.dir ? { external: true } : {}),
        ...resetCommandOf(this.provider(provider, a.id)),
      }),
    );
    return { id: provider, name: p.name, installed, ...(installed && cached?.version ? { version: cached.version } : {}), auth, accounts, ...(installed ? {} : { problem: cached?.problem }) };
  }

  /**
   * Capabilities for the home composer: the cached answer at once when there is one, the fresh
   * one pushed as `caps.updated` when it differs. A stale cache never blocks anything.
   */
  /** A model the session's agent lists, from the live caps or the last known ones. */
  private modelInfo(rt: SessionRuntime, model: string) {
    const caps = rt.caps ?? this.cachedCaps(rt.meta.provider, rt.meta.accountId ?? DEFAULT_ACCOUNT, rt.meta.cwd);
    return caps?.models.find((m) => m.id === model);
  }

  private async applySpeed(rt: SessionRuntime, speed: string) {
    await rt.handle?.setSpeed?.(speed);
    rt.update({ speed, fast: speed !== STANDARD_SPEED });
  }

  /** The speed a new session starts with: the one asked for when its model offers it (as far as is known). */
  private startSpeed(provider: ProviderId, accountId: string, cwd: string, model: string | undefined, speed: string | undefined): Partial<SessionMeta> {
    if (!speed || speed === STANDARD_SPEED) return {};
    const caps = this.cachedCaps(provider, accountId, path.resolve(cwd)) ?? this.cachedCaps(provider, accountId, cwd);
    const info = caps?.models.find((m) => m.id === model) ?? caps?.models.find((m) => m.isDefault);
    // Unknown caps: keep the choice; the agent's adapter checks it against the model again. A paid
    // speed (Claude's fast mode) is never started from a default: the session turns it on itself.
    const chosen = caps ? startSpeedFor(info, speed) : provider === 'claude' ? STANDARD_SPEED : speed;
    return chosen === STANDARD_SPEED ? {} : { speed: chosen, fast: true };
  }

  private async capsFast(provider: ProviderId, cwd: string | undefined, accountId = DEFAULT_ACCOUNT, refresh = false): Promise<Capabilities> {
    const p = this.provider(provider, accountId);
    const generation = this.signInGen.get(accountKey(provider, accountId));
    const fresh = () =>
      p.caps(cwd).then((answer) => {
        // Codex reads its MCP inventory (and the plugin behind browser / computer use) in the
        // background, which takes long: until it arrives, keep the last known inventory.
        if (generation !== this.signInGen.get(accountKey(provider, accountId))) return this.capsFast(provider, cwd, accountId, true);
        const before = this.cachedCaps(provider, accountId, cwd);
        const caps =
          provider === 'codex' && !answer.mcpServers.length && before?.mcpServers.length
            ? { ...answer, mcpServers: before.mcpServers, features: { ...answer.features, browser: before.features.browser, computerUse: before.features.computerUse, linkedBrowserComputer: before.features.linkedBrowserComputer } }
            : answer;
        if (this.storeCaps(provider, accountId, cwd, caps)) this.emit({ type: 'caps.updated', provider, accountId: accountId === DEFAULT_ACCOUNT ? undefined : accountId, cwd, caps });
        return caps;
      });
    const cached = provider === 'demo' || refresh ? undefined : this.cachedCaps(provider, accountId, cwd);
    if (!cached) return fresh();
    // Check it a moment later, off the start-up path (the probe starts a CLI process).
    const t = setTimeout(() => !this.disposed && void fresh().catch(() => {}), this.delays.caps ?? CAPS_REFRESH_DELAY_MS);
    t.unref?.();
    return cached;
  }

  // A change of sign-in expires every folder, including folders only the disk cache remembers.
  private cachedCaps(provider: ProviderId, accountId: string, cwd?: string): Capabilities | undefined {
    const entry = this.cache.get<Capabilities | { since: number; caps: Capabilities }>(capsCacheKey(provider, accountId, cwd));
    if (!entry) return;
    const since = this.limitsForgottenAt(provider, accountId);
    if ('since' in entry) return entry.since === since ? entry.caps : undefined;
    return since ? undefined : entry;
  }

  private storeCaps(provider: ProviderId, accountId: string, cwd: string | undefined, caps: Capabilities) {
    const since = this.limitsForgottenAt(provider, accountId);
    return this.cache.set(capsCacheKey(provider, accountId, cwd), since ? { since, caps } : caps);
  }

  // ── prewarm ──

  /** The provider instance holding the one warm agent process, if any. */
  private warmHolder?: Provider;

  private async prewarm(p: RpcMethods['provider.prewarm']['params']) {
    const settings = this.store.state.settings;
    if (settings.prewarm === false || p.provider === 'demo') return { ok: false };
    const accountId = p.accountId ?? this.defaultAccountId(p.provider);
    const inst = this.provider(p.provider, accountId);
    if (!inst.prewarm || !isDir(path.resolve(p.cwd))) return { ok: false };
    if (this.warmHolder && this.warmHolder !== inst) await this.warmHolder.discardWarm?.().catch(() => {});
    this.warmHolder = inst;
    await inst.prewarm({
      cwd: path.resolve(p.cwd),
      model: p.model ?? settings.defaultModels[p.provider],
      mode: p.mode ?? settings.defaultModes[p.provider] ?? 'default',
      effort: p.effort ?? settings.defaultEfforts[p.provider],
      options: settings.sessionOptions?.[p.provider],
      ultracode: p.ultracode || undefined,
    });
    return { ok: true };
  }

  private nextLabel(provider: ProviderId) {
    const taken = new Set(this.accountList(provider).map((a) => a.label.toLowerCase()));
    for (let n = 2; ; n++) if (!taken.has(`account ${n}`)) return `Account ${n}`;
  }

  /** Deletes an extra account's folder, and only ever a folder under `<home>/accounts/`. */
  private removeAccountDir(provider: ProviderId, accountId: string) {
    const root = path.join(this.store.dir, 'accounts');
    const dir = this.accountDir(provider, accountId);
    const rel = path.relative(root, dir);
    if (!/^[\w-]+$/.test(accountId) || !rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
    } catch (err) {
      this.log('could not delete account folder', dir, (err as Error).message);
    }
  }

  runtime(id: string): SessionRuntime {
    const rt = this.sessions.get(id);
    if (!rt) throw new Error('Session not found');
    return rt;
  }

  private lazy = new Set<string>();
  /** Geometry only. Every timeline event invalidates it before publication. */
  private snapshotEnds = new WeakMap<TimelineItem[], ReturnType<typeof snapshotEnd>>();

  /** Folders being pinned (core/contain.ts `pinFolder`), one at a time so a start with many chats does not crowd the disk. */
  private pinning: Promise<unknown> = Promise.resolve();
  /** Each session's folder as last pinned, by session id. */
  private pinned = new Map<string, string>();

  /**
   * Pins a session's folder as it is when it becomes the session's (made, restored, or moved to a
   * lane's worktree, which Sable has just made: pinned anew), so a folder later swapped for another
   * one (a junction to another repository) is not taken for the chat's (review wave 6, #2).
   */
  private pinCwd(rt: SessionRuntime) {
    const cwd = rt.meta.cwd;
    if (!cwd || this.pinned.get(rt.id) === cwd) return;
    this.pinned.set(rt.id, cwd);
    const lane = rt.meta.lane;
    const fresh = !!lane && path.resolve(lane.path).toLowerCase() === path.resolve(cwd).toLowerCase();
    this.pinning = this.pinning.then(() => pinFolder(cwd, fresh)).catch(() => {});
  }

  private makeRuntime(meta: SessionMeta, lazy = false): SessionRuntime {
    if (lazy) this.lazy.add(meta.id);
    const rt = new SessionRuntime(meta, this.emit, (rt, what) => {
      const restoring = this.installingTimeline.get(rt);
      if (restoring) restoring[what] = true;
      else if (what === 'meta') {
        this.pinCwd(rt);
        this.store.saveState();
      } else if (lazy && !this.installed.has(rt)) {
        this.log('Refused a timeline save before successful hydration', rt.id);
        this.lazy.add(rt.id);
        if (!this.unreadable.has(rt.id)) {
          this.unreadable.add(rt.id);
          this.emit({ type: 'toast', level: 'error', text: 'This chat could not be read from disk. Its saved history is protected. Open it again to retry.' });
        }
      } else this.saveTimeline(rt);
    });
    this.pinCwd(rt);
    const persist = (requireOpen = false) => lazy && !this.installed.has(rt)
      ? Promise.reject(Error('This chat could not be read from disk'))
      : this.store.persistInput(rt.id, requireOpen);
    rt.persistInput = () => persist();
    rt.persistDelegate = () => withDeadline(persist(true), 5000, 'Saving the delegate');
    rt.reapDelegate = confirmed => {
      this.retiredDelegates.add(confirmed);
      void confirmed.then(() => this.retiredDelegates.delete(confirmed));
    };
    rt.offerToolResult = row => {
      const keys = this.offerDelegateReports(rt, [row]).map(record => record.key);
      void rt.persistDelegate?.().then(() => this.delegateJournal.forget(rt.id, keys))
        .catch(err => this.log('foreground receipt journal retained', err));
    };
    rt.saveQuitResult = row => {
      const delivery = row.delegateDeliveryId!;
      this.delegateJournal.save(rt.id, [{ key: delivery, delivery, row: row.id,
        terminal: { status: row.status, delegateReport: row.delegateReport, endedAt: row.endedAt, result: row.result } }]);
      return () => this.delegateJournal.forget(rt.id, [delivery]);
    };
    rt.promote = item => this.store.promote(rt.id, item);
    rt.canBeginTurn = () => !this.disposed && !this.updates?.installing;
    rt.onTurnEnd = (r, error, opts) => this.afterTurn(r, error, opts?.hold, opts?.backgroundLimit);
    // Background work met a plan limit with no turn running: the chat's limit, decided once (limit-policy.ts).
    rt.onBackgroundLimit = (r, hit) => this.limitInBackground(r, hit);
    rt.onStoppedLimit = (r, notice) => { void this.onLimitHit(r, notice, false, 0, true).catch(err => this.log('stopped limit failed', (err as Error).message)); };
    // At rest (the last background work ended): the moves that waited for it are looked at again.
    rt.onRest = (r) => { setTimeout(() => this.restMoves(r), 0); this.scheduleLossWake(r); };
    rt.onWorkLost = (r, cause, count) => this.workLost(r, cause, count);
    rt.onWakeEligibilityChanged = () => this.scheduleLossWake(rt);
    rt.stageDelegateReports = () => this.stagePersonalReports(rt);
    rt.onDelegateReport = () => this.scheduleLossWake(rt);
    rt.onUnreadSteer = (id, fresh) => {
      const card = rt.get<UserItem>(id);
      if (!card) return;
      const caller = this.senderGuard(card.phoneSender, rt.id) ?? this.steerSenders.get(card);
      const delay = this.store.state.settings.steerAfterMs ?? 30_000;
      const exhausted = (card.steerAttempts ?? 0) >= 2;
      const arm = (retry: boolean, reason?: string) => rt.waitForSteer(id, exhausted ? 0 : retry ? Math.max(delay * 2, 5000) : delay, () => {
        const send = async () => {
          if (!card.steerWait || rt.get(id) !== card) return;
          try {
            if ((await this.steerNow(rt, id, caller ?? {}, true)).ok) return;
            if (!retry && rt.get(id) === card && card.state === 'queued') arm(true, card.steerWait?.reason ?? 'Claude did not confirm withdrawal.');
          } catch (err) {
            if (rt.get(id) !== card || card.state !== 'queued') return;
            const reason = (err as Error).message;
            if (!retry && !rt.stopRequested && !/timed out|stopped|closed|process changed/i.test(reason)) arm(true, reason);
            else rt.patch<UserItem>(id, { steerWait: { ...card.steerWait, autoAt: undefined, reason } });
          }
        };
        // A concurrent recall can claim several cards. Recheck the original if that recall missed it.
        void Promise.resolve(this.steersSettled.get(rt)).then(send).catch(err => this.log('automatic steer', (err as Error).message));
      }, fresh || retry ? Date.now() : undefined, reason);
      arm(false, exhausted ? 'Automatic interruption limit reached.' : undefined);
    };
    rt.onReturnUntaken = item => {
      const sender = this.steerSenders.get(item);
      if (!item.phoneSender && sender?.allowed) rt.transientQueueGuards.set(item.id, sender.allowed);
    };
    // A queued message a phone was taking back is released: the queue goes on if it waited for it.
    rt.onQueueRunnable = () => {
      const stops = this.stopsOf(rt);
      setTimeout(() => { if (stops === this.stopsOf(rt) && (rt.queue.length || rt.meta.until)) this.sendNextQueued(rt); }, 0);
    };
    rt.onQueueReleased = (r) => {
      this.scheduleLossWake(r);
      if (!this.drainWaiting.delete(r.id)) return;
      setTimeout(() => {
        if (r.turnActive || r.stopRequested || this.sessions.get(r.id) !== r) return;
        this.sendNextQueued(r);
      }, 0);
    };
    rt.onTurnStart = (r) => {
      // A compaction before a move is no round of an until loop, nor a turn Spare started.
      if (this.compacting.has(r.id)) return;
      this.until.turnStarted(r);
      this.spare.turnStarted(r);
    };
    return rt;
  }

  private reading = new Map<string, Promise<void>>();
  private installed = new WeakSet<SessionRuntime>();
  private installingTimeline = new WeakMap<SessionRuntime, { meta: boolean; items: boolean }>();

  private saveTimeline(rt: SessionRuntime) {
    this.store.saveSession(rt.id, () => ({ items: rt.items, todos: rt.todos, queue: rt.queue,
      receiptRepair: this.phoneReceipts.pending(rt.id), dirty: rt.takeDirty() }));
  }

  /** Concurrent actions wait for the same indexed read before observing or editing the chat. */
  private hydrateAsync(rt: SessionRuntime): Promise<void> {
    if (!this.lazy.has(rt.id)) return this.reading.get(rt.id) ?? Promise.resolve();
    let run = this.reading.get(rt.id);
    if (!run) {
      run = (async () => {
        let file: Awaited<ReturnType<Store['loadSessionAsync']>>;
        let restartNotice: string | undefined;
        const changes = { meta: false, items: false };
        let meta: SessionMeta | undefined;
        try {
          file = await this.store.loadSessionAsync(rt.id);
          if (this.sessions.get(rt.id) !== rt || this.disposed) return;
          if (file.unreadable) throw Error('Unreadable session file');
          meta = { ...rt.meta };
          this.installingTimeline.set(rt, changes);
          restartNotice = this.loadInto(rt, file);
        } catch (err) {
          if (this.sessions.get(rt.id) !== rt || this.disposed) return;
          this.log('This chat could not be read from disk', rt.id, String(err));
          this.unreadable.add(rt.id);
          this.installingTimeline.set(rt, changes);
          rt.load([], [], []);
          rt.notice('error', 'This chat could not be read from disk', 'Nothing is written to it. Open the chat again to retry.');
          if (meta) Object.assign(rt.meta, meta);
          return;
        } finally { this.installingTimeline.delete(rt); }
        this.installed.add(rt);
        this.lazy.delete(rt.id);
        this.unreadable.delete(rt.id);
        try { this.phoneReceipts.remember(rt.id, file.receiptRepair, file.queue); }
        catch (err) { this.log('Could not stage phone receipt repairs', rt.id, String(err)); }
        if (changes.meta) this.store.saveState();
        if (changes.items) this.saveTimeline(rt);
        try { this.afterRestore(rt, file, restartNotice); }
        catch (err) { this.log('Session maintenance failed', rt.id, String(err)); }
        void this.restoreSteerReceipts(rt).catch(err => this.log('Could not check steer receipts', String(err)));
      })()
        .finally(() => this.reading.delete(rt.id));
      this.reading.set(rt.id, run);
    }
    return run;
  }

  private steerReads = new WeakMap<SessionRuntime, Map<string, { latest: string; pending: Set<string> }>>();

  /** A deadline bounds the caller's wait. A later positive still owns its exact UUID. */
  private async restoreSteerReceipts(rt: SessionRuntime, only?: string) {
    const reads = this.steerReads.get(rt) ?? new Map<string, { latest: string; pending: Set<string> }>();
    this.steerReads.set(rt, reads);
    const groups = new Map<string, { to: NonNullable<UserItem['issuedTo']>; ids: Set<string> }>();
    const pending = new Set<Promise<void>>();
    for (const row of rt.queue) {
      const uuid = row.issuedUuid;
      if (!uuid || only && uuid !== only) continue;
      if (row.issuedTo?.stillQueued && !rt.handle?.stillQueued?.(uuid)) rt.forgetLiveQueue(uuid);
      const to = row.issuedTo;
      const leg = rt.meta.provider === to?.provider ? rt.meta : rt.meta.agents?.find(l => l.provider === to?.provider);
      const carried = !!to?.session && leg?.providerSessionId === to.session;
      const accountId = carried ? leg.accountId : to?.accountId;
      const elsewhere = !carried || rt.meta.provider !== to.provider;
      rt.queueReason(row.id, elsewhere ? (to?.stillQueued ? 'Claude reported this input still queued. This chat cannot receive its original receipt.' : 'This chat cannot receive the original Claude receipt. Check the original conversation before sending again.')
        : to.stillQueued ? 'Claude still has this input queued.' : 'Issued to Claude. Receipt unknown.');
      if (!to?.session) continue;
      const existing = reads.get(uuid);
      if (existing) {
        existing.latest = accountId ?? DEFAULT_ACCOUNT;
        if (existing.pending.has(existing.latest)) continue;
      }
      const key = JSON.stringify([accountId, to.session, to.cwd]);
      let group = groups.get(key);
      if (!group) groups.set(key, group = { to: { ...to, accountId }, ids: new Set() });
      group.ids.add(uuid);
    }
    for (const { to, ids } of groups.values()) {
      // A read started before a carry can still confirm the UUID. Its failure must not
      // hide a receipt from the new account. Explicit resend waits for both observers.
      const account = to.accountId ?? DEFAULT_ACCOUNT;
      const read = Promise.resolve().then(() => {
        const provider = this.provider(to.provider, to.accountId);
        if (!provider.steerReceipts) throw Error('Original Claude history is unavailable.');
        return provider.steerReceipts(to.session!, to.cwd, ids);
      }).catch(err => {
        if (!this.disposed && this.sessions.get(rt.id) === rt) {
          for (const row of rt.queue) if (row.issuedUuid && ids.has(row.issuedUuid) && reads.get(row.issuedUuid)?.latest === account)
            rt.queueReason(row.id, row.issuedTo?.stillQueued ? 'Claude reported this input still queued. Its original receipt is unavailable.' : 'The original Claude receipt is unavailable. Check that conversation before sending again.');
        }
        this.log('Could not check the original Claude receipt', String(err));
        return [];
      }).then(async receipts => {
          if (this.disposed || this.sessions.get(rt.id) !== rt) return;
          let changed = false;
          for (const uuid of receipts ?? []) if (ids.has(uuid) && rt.confirmSteerReceipt(uuid)) changed = true;
          if (changed) await rt.persistInput?.();
        }).catch(err => this.log('Could not save the original Claude receipt', String(err)))
        .finally(() => {
          for (const uuid of ids) {
            const observer = reads.get(uuid)!;
            observer.pending.delete(account);
            if (!observer.pending.size) reads.delete(uuid);
          }
        });
      for (const uuid of ids) {
        const observer = reads.get(uuid) ?? { latest: account, pending: new Set<string>() };
        observer.pending.add(account);
        reads.set(uuid, observer);
      }
      pending.add(read);
    }
    if (pending.size) await boundedBy(Promise.all(pending), 3000, undefined);
  }

  private loadInto(rt: SessionRuntime, file: ReturnType<Store['loadSession']>) {
    // No agent process carries anything from before: background sub-agents and workflows ended with it
    // (stopped as read, so the count never shows them, also not on the way).
    // A queue entry and the card handed to the provider share one ID. At a crash the
    // RPC can still be outstanding. The card owns that delivery once it exists.
    const users = new Set(file.items.filter(i => i.type === 'user').map(i => i.id));
    const queue = file.queue?.filter(q => !users.has(q.id)).map(q => q.issuedUuid ? { ...q, byHand: true, steerWait: { reason: 'Issued to Claude. Receipt unknown.' } } : q);
    const journal = file.items.some(i => i.type === 'tool' && (i.delegateDeliveryId || i.delegateAttempt))
      ? this.delegateJournal.read(rt.id) : [];
    const lostNames = rt.loadRestored(file.items, file.todos, queue ?? []);
    this.restoreDelegateJournal(rt, file.items, journal);
    this.restorePersonalLimitBoundary(rt);
    if (rt.stopRequested) rt.holdDelegateReports('stop');
    this.store.bindProviderInputs(rt.id, rt.items);
    // A message Sable sent that came back as one "From the Claude app" (D-own): merged into its own card,
    // only where the agent's own id for it proves they are one message.
    for (const id of ownReplays(rt.items)) rt.remove(id);
    for (const item of rt.items) {
      if (item.type === 'notice' && item.limit?.moving) rt.patch<NoticeItem>(item.id, { limit: { ...item.limit, moving: undefined } });
    }
    // Its turn ran when Sable closed: the bridge knows it was cut, and says so once ("Ended early"),
    // at the time of the turn's last item, never now (the chat may be read hours later).
    let restartNotice: string | undefined;
    if (rt.meta.pendingRestart) {
      const cutAt = lastAct(rt.items);
      const before = rt.items.length;
      if (cutAt !== undefined) rt.cutTurn('restart', { at: cutAt });
      if (rt.items.length > before) restartNotice = rt.items.at(-1)?.id;
      else rt.update({ pendingRestart: undefined }); // The saved timeline already closes the turn.
    }
    // Background commands still running when Sable closed were lost with it (D-lost): said once, where the
    // chat stopped, their names on demand (the agent hears it with its next message, `takeLost`).
    if (lostNames.length) rt.add<NoticeItem>({ type: 'notice', variant: 'info', text: lostLine(lostNames.length, 'restart'), detail: lostNames.join('\n'), ts: lastAct(rt.items) });
    // What was in flight when Sable closed ended then, not now (the chat may be opened much later).
    rt.settle('cancelled', { endUnknown: true });
    // Messages still waiting for the agent when Sable closed (a steer not taken yet) would wait forever: back to the queue.
    const inFlight = new Set(file.queue?.filter(q => users.has(q.id)).map(q => q.id));
    const legacy = rt.meta.provider === 'claude' ? rt.items.filter((i): i is UserItem =>
      i.type === 'user' && i.state === 'queued' && !!i.steered && !i.steerOrder && !i.issuedUuid) : [];
    for (const item of legacy) inFlight.add(item.id);
    rt.returnUntaken({ all: true, reason: 'closed', byHand: inFlight });
    for (const item of legacy) rt.queueReason(item.id, 'Delivery before the update was not confirmed.');
    // Old files only named the UUID. Pin the available Claude leg before a later move changes it.
    for (const q of rt.queue) if (q.issuedUuid && !q.issuedTo && rt.meta.provider === 'claude') {
      q.issuedTo = { provider: 'claude', accountId: rt.meta.accountId, session: rt.meta.providerSessionId, cwd: rt.meta.cwd };
      rt.queueReason(q.id, 'Checking the original Claude receipt.');
    }
    const lost = this.untilLost.get(rt.id);
    if (lost) this.until.restored(rt, lost), this.untilLost.delete(rt.id);
    return restartNotice;
  }

  private afterRestore(rt: SessionRuntime, file: ReturnType<Store['loadSession']>, restartNotice?: string) {
    if (rt.meta.titleSource === 'auto' && !rt.meta.titleAuthored) {
      const plain = readableTitle(rt.meta.title);
      if (plain !== rt.meta.title) {
        const first = rt.items.find((i): i is UserItem => i.type === 'user' && !i.parentId);
        const source = first && personalOrigin(first) ? first : !first ? rt.queue.find(q => !q.until) : undefined;
        if (source && autoTitle(source.text, true) === rt.meta.title) rt.update({ titleAuthored: true });
        else rt.update({ title: plain || 'New session' });
      }
    }
    const recovered = this.recoveredDelegateKeys.get(rt);
    if (recovered?.length) void rt.persistDelegate?.().then(() => this.delegateJournal.forget(rt.id, recovered))
      .catch(err => this.log('delegate journal retained', err));
    if (rt.pendingDelegateReports.size) this.scheduleLossWake(rt);
    this.tracker.restored(rt);
    if (rt.items.length > SNAPSHOT_THRESHOLD) this.snapshotEnds.set(rt.items, snapshotEnd(rt.items));
    this.store.scheduleMigration(rt.id, () => {
      const work = this.workOf(rt);
      return !this.disposed && this.sessions.get(rt.id) === rt && !work.turn && !work.agents && !work.commands &&
        !this.moveAttempts.has(rt) && !this.moving.has(rt.id) && !this.switching.has(rt.id) && !this.compacting.has(rt.id) &&
        !this.opening.has(rt.id) && !this.delivering.has(rt.id) && !this.dispatching.has(rt.id) && !this.sending.has(rt.id) && !this.sendHolds.has(rt.id);
    }, () => file.items.length === rt.items.length && file.items.every((row, i) => row === rt.items[i]) &&
      (file.queue?.length ?? 0) === rt.queue.length && !file.queue?.some((row, i) => row !== rt.queue[i]));
    if (restartNotice) {
      void this.store.savedRestartNotice(rt.id, restartNotice).then((saved) => {
        if (saved && !this.disposed && this.sessions.get(rt.id) === rt) rt.update({ pendingRestart: undefined });
      }).catch((err) => this.log('could not confirm the restart notice', (err as Error).message));
    }
  }

  /**
   * Puts a message in the timeline and hands it to the agent. Mid-turn it is steered: the agent
   * takes it at its next step; it waits where it was sent and then stands where the agent took it.
   */
  private async deliver(rt: SessionRuntime, text: string, attachments?: UserItem['attachments'], extra?: DeliveryFields, ctx?: CallContext, explicit = false) {
    // From here to its dispatch no return to another account begins (review wave 16, #11): a message
    // goes to exactly one account, never while a move is half done.
    this.sending.set(rt.id, (this.sending.get(rt.id) ?? 0) + 1);
    try {
      return await this.deliverNow(rt, text, attachments, extra, ctx, explicit);
    } finally {
      const n = (this.sending.get(rt.id) ?? 1) - 1;
      if (n > 0) this.sending.set(rt.id, n);
      else {
        this.sending.delete(rt.id);
        this.resumeDrain(rt);
        this.scheduleLossWake(rt);
        this.lanes.sent(rt);
      }
    }
  }

  private async deliverNow(rt: SessionRuntime, text: string, attachments?: UserItem['attachments'], extra?: DeliveryFields, ctx?: CallContext, explicit = false) {
    if (ctx?.phoneSender?.kind === 'web') requireWebMessage(text);
    // Past its account's cap, the session moves to the next account before the message goes out.
    // The first message names the session's lane, or moves it into one when its folder got busy.
    // A caller that may no longer act (a phone removed meanwhile) is asked again after every wait.
    // Moving to another account (compacting first): the message waits in the queue and goes there.
    if (this.moving.has(rt.id)) {
      this.queuedWhileMoving.add(rt.id);
      return this.deferSend(rt, text, attachments, ctx, extra);
    }
    // A limit's transition runs (background work being stopped, the move after it): the message waits
    // in the queue, with its sender's guard, and goes once that is over (review wave 17, #5).
    if (this.sendHolds.has(rt.id) || (this.refusalQueues.has(rt) && this.limitPending(rt))) return this.queueBehindHold(rt, text, attachments, ctx, extra);
    const stops = this.stopsOf(rt);
    await this.lanes.ready(rt);
    if (this.stopsOf(rt) === stops && !rt.items.some((i) => i.type === 'user')) {
      if (rt.meta.provider === 'claude' || rt.meta.provider === 'codex') await this.firstWord(undefined, FIRST_WORD_WAIT_MS);
      await this.lanes.beforeFirstSend(rt, text);
    }
    still(ctx);
    if (this.stopsOf(rt) === stops && !rt.turnActive && !this.opening.has(rt.id)) {
      // Back to the account a limit moved it from, when that one takes work again (as a model change,
      // right before the message). A return already under way is waited for (bounded): the message
      // never goes out on the account it is leaving.
      this.sendWaits.add(rt.id);
      const back = this.returnAfterLimit(rt).catch((err) => this.log('return after a limit failed', (err as Error).message));
      let waited: unknown;
      try {
        waited = await Promise.race([back.then(() => 'done'), new Promise((r) => void setTimeout(() => r('timeout'), RETURN_SEND_WAIT_MS).unref?.())]);
      } finally {
        this.sendWaits.delete(rt.id);
      }
      // The return still reads the limits: the message queues against it and goes once it settles,
      // whichever account the chat is on then (review wave 17, #8).
      if (waited === 'timeout' && this.returnRuns.has(rt.id)) {
        this.holdSends(rt, back);
        return this.queueBehindHold(rt, text, attachments, ctx, extra);
      }
      // The return is still moving the chat (compacting first): the message goes there once it is done.
      if (this.moving.has(rt.id)) {
        this.queuedWhileMoving.add(rt.id);
        return this.deferSend(rt, text, attachments, ctx, extra);
      }
      await this.checkCap(rt);
    }
    still(ctx);
    // Stop or Close during lane validation or the cap check leaves the message with its sender's guard.
    if (this.stopsOf(rt) !== stops) {
      if (this.sessions.get(rt.id) === rt) {
        return this.deferSend(rt, text, attachments, ctx, extra);
      }
      throw new NotNow('The chat was closed before delivery.');
    }
    // From here to the agent's own dispatch the message is on its way: no move or agent switch begins
    // under it (D6). One asked for meanwhile waits for it, and then finds the chat working.
    const sent = this.beginDispatch(rt);
    try {
      return await this.dispatchNow(rt, text, attachments, extra, ctx, explicit);
    } finally {
      sent();
    }
  }

  /** The message goes to the agent: shown in the timeline (steered into a running turn) and sent. */
  private async dispatchNow(rt: SessionRuntime, text: string, attachments?: UserItem['attachments'], extra?: DeliveryFields, ctx?: CallContext, explicit = false) {
    const addUser = () => {
      if (rt.meta.titleSource === 'auto' && !rt.items.some((i) => i.type === 'user')) {
        rt.update({ title: extra?.until?.check ? autoTitle(`Until ${extra.until.check.command} passes`) : autoTitle(text, !!(explicit || extra?.id)), titleAuthored: !extra?.until && (explicit || extra?.id) ? true : undefined });
      }
      // The chat just used goes to the top of its folder at once.
      rt.touch();
      return rt.add<UserItem>({
        type: 'user',
        id: extra?.id ?? extra?.submitId,
        ts: extra?.ts,
        ...(extra?.submitPrint && { submitPrint: extra.submitPrint }),
        text,
        attachments: attachments?.length ? attachments : undefined,
        state: 'queued',
        ...((explicit || extra?.id) && !extra?.until && { authored: true }),
        ...(ctx?.phoneSender && { phoneSender: ctx.phoneSender }),
        ...(extra?.steerAttempts && { steerAttempts: extra.steerAttempts }),
        ...((extra?.steerOrder || rt.turnActive && rt.meta.provider === 'claude') && { steerOrder: extra?.steerOrder ?? rt.nextSteerOrder() }),
        ...(rt.turnActive && !extra?.until ? { steered: true } : {}),
        ...(extra?.until ? { until: extra.until } : {}),
      });
    };
    // The agent is not there yet (a new session still starting, or a restored one whose agent
    // starts with this message; Codex can take most of a minute): show the message now, send it
    // once the agent is there.
    let early: UserItem | undefined;
    // An agent that cannot start at all (its account was removed) refuses the message outright.
    if (!rt.handle && !this.opening.has(rt.id)) this.provider(rt.meta.provider, rt.meta.accountId);
    if (!extra?.id && (this.opening.has(rt.id) || !rt.handle)) {
      early = addUser();
      this.delivering.add(rt.id);
      this.earlyWaiting.set(rt.id, [...(this.earlyWaiting.get(rt.id) ?? []), early.id]);
      if (rt.meta.status !== 'starting') rt.update({ status: 'starting' });
    }
    let handle: ProviderSession;
    try {
      handle = await this.ensureHandle(rt);
    } catch (err) {
      if (err instanceof LaneUnavailable && early) rt.remove(early.id);
      if (!early || err instanceof LaneUnavailable) throw err;
      const stopped = this.stoppedEarly.delete(early.id);
      rt.returnUntaken({ ids: new Set([early.id]), byHand: new Set([early.id]) });
      rt.queueReason(early.id, stopped ? 'Stopped before the provider opened.' : (err as Error).message);
      if (stopped) return 'queued' as const;
      rt.update({ status: 'error', lastError: (err as Error).message });
      rt.notice('error', 'Could not send the message', (err as Error).message);
      return 'queued' as const;
    } finally {
      this.delivering.delete(rt.id);
      this.scheduleLossWake(rt);
      if (early) this.earlyWaiting.set(rt.id, (this.earlyWaiting.get(rt.id) ?? []).filter((id) => id !== early.id));
    }
    // Stopped while the agent was starting: the message stays where it was sent, and is not sent later.
    if (early && this.stoppedEarly.delete(early.id)) {
      rt.returnUntaken({ ids: new Set([early.id]), byHand: new Set([early.id]) });
      rt.queueReason(early.id, 'Stopped before the provider opened.');
      return 'queued' as const;
    }
    // Its phone was removed while it waited: it never goes out (one shown early leaves the chat, said in a line).
    const gone = () => {
      if (!ctx?.allowed || ctx.allowed()) return;
      if (early) {
        rt.remove(early.id);
        if (!rt.turnActive && rt.meta.status === 'starting') rt.update({ status: 'idle' });
        rt.notice('info', ctx.refusal?.() ?? 'A message from a removed phone was not sent');
      }
      throw new CallerGone(ctx?.refusal?.());
    };
    gone();
    // A model chosen since the agent started takes effect now, with this message (never inside a running turn).
    await this.applyDue(rt, handle);
    gone();
    // Right before the dispatch, whatever came first (a first message while the agent opened, a queued
    // one, a steer): never on credits the account's own setting forbids (review wave 17, #2).
    if (await this.heldForCredits(rt)) {
      extra?.steerNow?.();
      // Its sender is asked again before anything of it is recorded (#3).
      gone();
      if (rt.turnActive) {
        // A steer: held in the queue with its guard; the running turn goes on, and at its end the
        // message is looked at again like any other.
        if (early) rt.remove(early.id);
        return this.deferSend(rt, text, attachments, ctx, extra);
      }
      // As if the agent refused it at the limit, without asking it: the message stands, the limit's
      // notice follows, and the turn's end decides as for any refusal (`onLimitHit`: the next account
      // carries the same message on, with its sender's guard, or "Continue with" / "Continue at reset").
      const refused = early ?? addUser();
      rt.patch<UserItem>(refused.id, { heldAtLimit: true });
      if (!refused.phoneSender && ctx?.allowed) this.refusedGuards.set(refused, ctx);
      rt.beginTurn('Thinking');
      rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'You have reached your usage limit.', limit: { ...this.creditsWindow(rt), origin: 'user', userItemId: refused.id } });
      rt.endTurn('You have reached your usage limit.');
      await rt.persistInput?.();
      return;
    }
    gone();
    // The chat began moving to another account after all (a move whose wait for this message ran
    // out), a limit's transition began while the message got ready, or its agent was replaced
    // or let go meanwhile (a close, a lane's release: a Claude session let go refuses every message):
    // the message never goes to an account it is leaving or a process that was let go (D6). It waits
    // in the queue and goes where the chat is then.
    const holding = (this.sendHolds.has(rt.id) || (this.refusalQueues.has(rt) && this.limitPending(rt))) && !rt.turnActive;
    if (this.moving.has(rt.id) || holding || rt.handle !== handle) {
      if (early) rt.remove(early.id);
      if (early && !rt.turnActive && rt.meta.status === 'starting') rt.update({ status: 'idle' });
      if (holding && !this.moving.has(rt.id)) return this.queueBehindHold(rt, text, attachments, ctx, extra);
      if (this.moving.has(rt.id)) this.queuedWhileMoving.add(rt.id);
      else setTimeout(() => this.sendNextQueued(rt), 0);
      return this.deferSend(rt, text, attachments, ctx, extra);
    }
    extra?.steerNow?.();
    const item = early ?? addUser();
    if ((item.steered || extra?.steerNow) && !item.phoneSender && ctx?.allowed) this.steerSenders.set(item, ctx);
    if (!rt.turnActive) this.retryOwners.delete(rt);
    const runningSince = item.steered ? rt.turnStartedAt : undefined;
    const unhand = this.handOver(rt, item.id);
    try {
      // The guard goes along to the agent's own dispatch (review wave 6, #3): an adapter that waits
      // first (Codex loading its thread) asks it again right before the message goes.
      const stops = this.stopsOf(rt);
      const accepted = explicit && !extra?.steerNow && rt.unreadQueueHeld ? (taken: boolean) => {
        if (!taken || this.stopsOf(rt) !== stops || !rt.unreadQueueHeld) return;
        rt.unreadQueueHeld = false;
        if (!rt.turnActive && rt.items.slice(rt.items.indexOf(item) + 1).some(i => i.type === 'turn' && !i.parentId)) {
          setTimeout(() => {
            if (!rt.turnActive && this.sessions.get(rt.id) === rt) this.sendNextQueued(rt);
          }, 0);
        }
      } : undefined;
      let sender = ctx;
      await this.sendWithHandover(rt, handle, item, () => {
        still(sender);
        extra?.steerNow?.();
      }, true, accepted, undefined, !!extra?.steerNow || !!extra?.steerAttempts);
      // A held input outlives the RPC. Its eventual provider write checks the pairing again.
      if (ctx?.phoneSender) sender = this.senderGuard(ctx.phoneSender, rt.id);
    } catch (err) {
      unhand();
      if (extra?.steerNow || extra?.steerAttempts) {
        rt.remove(item.id);
        rt.unreadQueueHeld = true;
        throw err; // deliverQueued releases its reservation, leaving the original in the queue.
      }
      if (err instanceof LaneUnavailable) {
        rt.remove(item.id);
        throw err;
      }
      if (err instanceof CallerGone) {
        // Its phone was removed while the agent got ready: nothing of it went to the agent. A turn it
        // began ends (nothing runs in it); a turn it was steered into goes on.
        rt.remove(item.id);
        if (rt.turnActive && !(item.steered && rt.turnStartedAt === runningSince)) {
          rt.settle('cancelled');
          rt.endTurn();
        }
        if (!extra?.id) rt.notice('info', 'A message from a removed phone was not sent');
        throw err;
      }
      // A steer the agent could not take: the turn it was meant for goes on, and the message waits in the queue.
      if (item.steered && rt.get<UserItem>(item.id)?.state === 'queued') {
        this.log('steer failed; back to the queue', (err as Error).message);
        if (!extra?.id || item.issuedUuid) rt.returnUntaken({ ids: new Set([item.id]) });
        else rt.remove(item.id);
        return 'queued' as const;
      }
      if (item.steered && rt.queue.some(q => q.id === item.id)) return 'queued' as const;
      // The turn this message began has ended since (its end stands after it): a failure of its send
      // that comes now is that turn's, and never ends the one running now (begun by a newer message).
      const at = item.steered ? -1 : rt.items.findIndex((i) => i.id === item.id);
      if (at >= 0 && rt.items.slice(at + 1).some((i) => i.type === 'turn' && !i.parentId)) {
        rt.returnUnwritten([item.id], (err as Error).message);
        await rt.persistInput?.();
        this.log('a send failed after its turn ended; nothing else ends', (err as Error).message);
        return;
      }
      rt.notice('error', 'Could not send the message', (err as Error).message);
      rt.returnUnwritten([item.id], (err as Error).message);
      rt.endTurn((err as Error).message);
      return 'queued' as const;
    }
  }

  /**
   * The message as the agent gets it: after a move to another account without the conversation, the
   * summary goes first (once); after a switch of agent, the handover of what that agent has not seen.
   * Background commands lost with a process since the agent was last told are named right after the
   * person's words (shared/synthetic.ts `lostTasksNote`), before any note.
   */
  private withHandover(rt: SessionRuntime, item: UserItem): { item: UserItem; personalOffset?: number; count?: number; taken?: () => void; release?: () => void } {
    // A slash command takes nothing before or after it (the agent would read it as its words): what
    // is pending waits for the next message.
    if (isSlashCommand(item.text)) return { item };
    const pending = rt.meta.agentHandover;
    const kept = this.handovers.get(rt.id);
    const moved = rt.meta.moveNote;
    const { names: lost, count, taken: toldLost, release } = rt.meta.provider === 'demo' ? rt.pendingLost() : rt.reserveLost();
    const wake = this.pendingLossWake.get(rt);
    const lossNotice = rt.lossNotice;
    if (!pending && !moved && kept === undefined && !lost.length) return { item };
    // A summary of the whole conversation covers what a switch would hand over.
    const summary = kept ?? ((moved?.summary ? this.moveSummaryText(rt, moved.summary, moved.skip) : '') || (pending ? this.agentHandoverText(rt, pending, item.id) : ''));
    // After a move to another account: a short note after the person's words, once.
    const note = moved ? this.moveNoteText(rt, moved.line, item.id, lost.length > 0) : '';
    // All of it is let go only once the agent took the message (review wave 8, #22): a send that
    // never went out (a phone removed meanwhile, the agent not starting) leaves it for the next one.
    let acknowledged = false;
    const taken = () => {
      if (acknowledged) return;
      acknowledged = true;
      if (pending && rt.meta.agentHandover === pending) rt.update({ agentHandover: null });
      if (kept !== undefined && this.handovers.get(rt.id) === kept) this.handovers.delete(rt.id);
      if (moved && rt.meta.moveNote === moved) rt.update({ moveNote: null });
      toldLost();
      if (count && wake) {
        if (this.pendingLossWake.get(rt) === wake && !rt.pendingLost().count) this.pendingLossWake.delete(rt);
        if (!rt.get(item.id) && this.stopsOf(rt) === wake.stops) {
          rt.update({ lossWake: { attempts: [], ...rt.meta.lossWake, delivered: wake.id } });
          const changedAccount = (wake.cause === 'move' || wake.cause === 'limit') && rt.meta.accountId !== wake.account;
          const when = changedAccount ? 'when the chat moved' : wake.cause === 'limit' ? 'at the plan limit' :
            wake.cause === 'capability' ? 'when the agent restarted' : "with the agent's process";
          const line = `${count === 1 ? '1 background task was' : `${count} background tasks were`} lost ${when}. The agent was told and carries on.`;
          const noticeId = wake.notice ?? lossNotice;
          const old = noticeId && rt.get<NoticeItem>(noticeId);
          if (old) rt.patch<NoticeItem>(old.id, { text: line, detail: lost.join('\n') });
          else rt.notice('info', line, lost.join('\n'));
        }
      }
    };
    if (!summary && !note && !lost.length) return { item, taken };
    const prefix = summary ? summary + HANDOVER_JOIN : '';
    return { item: { ...item, text: `${prefix}${item.text}${lostTasksNote(lost)}${note ? `\n\n${note}` : ''}` }, personalOffset: prefix.length, count, taken, release };
  }

  private pendingLossWake = new WeakMap<SessionRuntime, { id: string; cause: LossTrigger; stops: number; account?: string; notice?: string }>();
  /** Includes the checks before a move can publish its moving flag. */
  private moveAttempts = new WeakMap<SessionRuntime, number>();
  private wakeDue = new WeakMap<SessionRuntime, number>();
  private lossWakeTimers = new Map<SessionRuntime, NodeJS.Timeout>();
  private wakeProcesses = new WeakMap<SessionRuntime, { handle: ProviderSession; generation: number; at: number }>();

  private workLost(rt: SessionRuntime, cause: LossTrigger, count: number) {
    const last = this.wakeProcesses.get(rt);
    if (this.disposed) return;
    if (cause === 'death' && last && last.handle === rt.handle && last.generation === rt.processGeneration && Date.now() - last.at < LOSS_WAKE_CRASH_MS) {
      rt.update({ lossWake: { attempts: [], ...rt.meta.lossWake, blocked: true } });
    }
    if (!count || rt.stopRequested || rt.meta.lossWake?.blocked) return;
    this.pendingLossWake.set(rt, { id: randomUUID(), cause, stops: this.stopsOf(rt), account: rt.meta.accountId });
    this.scheduleLossWake(rt);
  }

  /** Give a pending personal send or limit carry-on first claim on the batch. */
  private scheduleLossWake(rt: SessionRuntime, delay = 0) {
    if (this.disposed || this.sessions.get(rt.id) !== rt || (!rt.pendingDelegateReports.size && !this.pendingLossWake.has(rt))) return;
    const due = Date.now() + delay;
    if (this.lossWakeTimers.has(rt) && (this.wakeDue.get(rt) ?? 0) <= due) return;
    clearTimeout(this.lossWakeTimers.get(rt));
    this.wakeDue.set(rt, due);
    const timer = setTimeout(() => {
      this.lossWakeTimers.delete(rt);
      void this.wakeAfterLoss(rt).catch(err => this.log('lost-work wake failed', (err as Error).message));
    }, delay);
    timer.unref?.();
    this.lossWakeTimers.set(rt, timer);
  }

  private delegateJournal: DelegateJournal;
  private recoveredDelegateKeys = new WeakMap<SessionRuntime, string[]>();

  private offerDelegateReports(rt: SessionRuntime, rows: ToolItem[]) {
    const records = rows.map(row => {
      const { prepared, ...attempt } = row.delegateAttempt!;
      return { key: prepared!, row: row.id, delivery: row.delegateDeliveryId!, attempt: { ...attempt, issued: prepared } };
    });
    this.delegateJournal.save(rt.id, records);
    for (const record of records) rt.patch<ToolItem>(record.row, { delegateAttempt: record.attempt });
    return records;
  }

  private restoreDelegateJournal(rt: SessionRuntime, original: TimelineItem[], records: DelegateRecord[]) {
    const keys: string[] = [];
    for (const record of records) {
      const row = rt.get<ToolItem>(record.row);
      if (row?.type !== 'tool' || row.delegateDeliveryId !== record.delivery) continue;
      if ('terminal' in record) {
        const prior = original.find(i => i.id === row.id) as ToolItem | undefined;
        if (prior?.delegateReport === 'working' || prior?.delegateCaller !== undefined || prior?.delegateReport === 'stopping' ||
            prior?.result?.isError && prior.result.text === 'Sable restarted before the sub-agent reported.') {
          rt.patch<ToolItem>(row.id, { ...record.terminal, delegateCaller: undefined, delegateReceiversPending: undefined });
          if (record.terminal.delegateReport === 'pending') rt.pendingDelegateReports.add(row.id);
          else rt.pendingDelegateReports.delete(row.id);
          keys.push(record.key);
        }
      } else if (record.unissued) {
        const attempt = row.delegateAttempt;
        if (row.delegateReport === 'pending' && (attempt?.prepared === record.key || attempt?.issued === record.key)) {
          if (attempt.issued) this.refundDelegate(rt, attempt);
          rt.patch<ToolItem>(row.id, { delegateAttempt: undefined, delegateReceiptState: null, delegateRetryId: null });
        }
        keys.push(record.key);
      } else if (row.delegateReport === 'pending' && row.delegateAttempt?.prepared === record.key) {
        rt.patch<ToolItem>(row.id, { delegateAttempt: record.attempt, delegateWait: null });
        const anchor = record.attempt.budget && rt.get<UserItem | ToolItem>(record.attempt.budget);
        if (anchor) rt.patch(anchor.id, { delegateContinuations: (anchor.delegateContinuations ?? 0) + 1 });
        keys.push(record.key);
      }
    }
    this.recoveredDelegateKeys.set(rt, keys);
    for (const id of rt.pendingDelegateReports) {
      const row = rt.get<ToolItem>(id);
      if (!row?.delegateAttempt?.prepared) continue;
      if (row.delegateAttempt.tool) {
        rt.patch<ToolItem>(row.id, { delegateAttempt: undefined });
        continue;
      }
      // The native write never began. Reuse the already-durable checkpoint for a personal send.
      rt.promote?.(row);
      this.personalReports.set(row.delegateAttempt, { saved: true, block: delegateReport(row.title,
        row.result?.agent?.background ?? row.status, row.result?.text ?? '', row.delegateDeliveryId) });
      if (row.delegateAttempt.provider !== rt.meta.provider || row.delegateAttempt.account !== rt.meta.accountId ||
          row.delegateAttempt.session !== rt.meta.providerSessionId) rt.patch<ToolItem>(id, { delegateAttempt: undefined });
    }
  }

  /** Earlier versions did not mark consumed personal input. Only infer a boundary from a
   * sent personal card and its own successful top-level turn after the outstanding refusal. */
  private restorePersonalLimitBoundary(rt: SessionRuntime) {
    const at = rt.items.findLastIndex(i => i.type === 'notice' && !i.parentId && i.limit && !i.limit.continuedWith);
    if (at < 0) return;
    let personal: UserItem | undefined;
    for (let i = at + 1; i < rt.items.length; i++) {
      const row = rt.items[i];
      if (row.parentId) continue;
      if (row.type === 'user') {
        if (row.completedPersonalTurn) return;
        personal = row.state === 'sent' && !row.heldAtLimit && !row.awaitingNativeReceipt && !row.until && !row.steered && !syntheticOf(row) ? row : undefined;
      } else if (row.type === 'notice' && (row.limit || row.early || row.variant === 'interrupted' || row.variant === 'error')) {
        personal = undefined;
      } else if (row.type === 'turn') {
        if (personal && !row.error && (!row.stopReason || ['completed', 'end_turn', 'stop'].includes(row.stopReason))) {
          rt.patch<UserItem>(personal.id, { completedPersonalTurn: true });
          return;
        }
        personal = undefined;
      }
    }
  }

  private limitHoldsWake(rt: SessionRuntime) {
    for (let i = rt.items.length - 1; i >= 0; i--) {
      const item = rt.items[i];
      if (item.type === 'user' && !item.parentId && item.completedPersonalTurn) break;
      if (item.type === 'notice' && !item.parentId && item.limit && !item.limit.continuedWith) return true;
    }
    return false;
  }

  private async wakeAfterLoss(rt: SessionRuntime) {
    const batch = this.pendingLossWake.get(rt);
    const before = new Set(rt.pendingDelegateReports);
    this.reconcileDelegateReports(rt);
    if (before.size && (this.delegateBudget(rt)?.delegateContinuations ?? 0) >= DELEGATE_CONTINUATIONS) rt.holdDelegateReports('budget', attempt => this.personalReports.has(attempt));
    const reports = [...rt.pendingDelegateReports].some(id => {
      const step = rt.get<ToolItem>(id);
      return step?.delegateReport === 'pending' && (!step.delegateAttempt || this.personalReports.has(step.delegateAttempt)) && (!step.delegateWait || step.delegateWait === 'retry');
    });
    const retry = reports && [...before].some(id => rt.get<ToolItem>(id)?.delegateWait === 'retry');
    const running = reports && rt.turnActive;
    const stops = this.stopsOf(rt);
    if ((!reports && (!batch || !rt.pendingLost().count)) || (!running && !retry && rt.meta.lossWake?.blocked)) return this.preparePersonalReports(rt);
    const account = rt.meta.accountId;
    const ready = (dispatches: number, ownTurn = false, draining = false) => {
      const w = workOf(rt, false, Date.now(), 'wake');
      return !this.disposed && !this.updates?.installing && this.sessions.get(rt.id) === rt && rt.meta.accountId === account &&
        this.pendingLossWake.get(rt) === batch && this.stopsOf(rt) === stops && !rt.stopRequested && (running || retry || !rt.meta.lossWake?.blocked) &&
        (!rt.dangerHeld || running) && (rt.unreadQueueHeld || !this.nextAutomaticMessage(rt)) && !rt.meta.spare && (running ? rt.turnActive || draining : !w.turn || ownTurn) && (running || !w.agents && !w.commands) &&
        !this.limitPending(rt) && !this.refusalQueues.has(rt) && !this.limitHoldsWake(rt) && !this.sendHolds.has(rt.id) &&
        !this.moveAttempts.has(rt) && !this.moving.has(rt.id) && !this.switching.has(rt.id) && !this.sending.has(rt.id) && !this.delivering.has(rt.id) &&
        !this.opening.has(rt.id) && !this.capChecks.has(rt.id) && !this.returnRuns.has(rt.id) && (this.dispatching.get(rt.id)?.size ?? 0) === dispatches;
    };
    if (!ready(0)) {
      this.preparePersonalReports(rt);
      // Some provider-only work ends without a runtime row or a turn notification.
      if (!running && rt.handle?.liveWork && !rt.turnActive && !rt.meta.commands && !rt.meta.background) {
        const work = workOf(rt, false, Date.now(), 'wake');
        if (work.turn || work.commands || work.agents) this.scheduleLossWake(rt, 1500);
      }
      return;
    }
    const now = Date.now();
    const attempts = recentLossWakes(rt, now);
    if (!reports && !running && attempts.length >= 2) return this.scheduleLossWake(rt, attempts[0] + LOSS_WAKE_WINDOW_MS - now);
    const release = this.beginDispatch(rt, false);
    const deadline = now + 90_000;
    const within = <T>(work: Promise<T>) => reports ? withDeadline(work, Math.max(1, deadline - Date.now()), 'Report dispatch') : work;
    const recheck = () => { throw new NotNow('The chat changed before the agent could carry on.'); };
    let changed = false;
    const lossNotice = rt.lossNotice;
    const names = rt.pendingLost().names;
    let reported = false;
    const missed = () => {
      if (reported || reports || !batch || this.disposed || this.stopsOf(rt) !== stops || this.sessions.get(rt.id) !== rt) return;
      reported = true;
      const note = "Background work was lost. The agent hasn't confirmed the message.";
      if (lossNotice && rt.get(lossNotice)) rt.patch<NoticeItem>(lossNotice, { text: note });
      else batch.notice = rt.notice('info', note, names.join('\n')).id;
    };
    try {
      const handle = await within(this.ensureHandle(rt, false, reports ? deadline : undefined));
      if (!ready(1)) recheck();
      if (await within(this.heldForCredits(rt))) {
        const reset = this.creditsWindow(rt).resetsAt;
        if (reset) this.scheduleLossWake(rt, Math.max(1, reset - Date.now()));
        return;
      }
      if (!ready(1)) recheck();
      if (!running) await within(this.applyDue(rt, handle));
      if (!ready(1)) recheck();
      // Both RPC providers open their turn before the final sender check and guard its identity at dispatch.
      let admitted = false;
      let offered = true;
      const check = () => {
        if (reports && Date.now() >= deadline) recheck();
        const draining = !offered && running && rt.meta.provider === 'opencode';
        if (!ready(draining ? 0 : 1, admitted && (rt.meta.provider === 'codex' || rt.meta.provider === 'opencode'), draining)) recheck();
        admitted = true;
      };
      await within(this.sendWithHandover(rt, handle, { type: 'user', id: randomUUID(), ts: now, state: 'sent', text: reports ? DELEGATE_REPORT : RESUME_LOST }, check, false, read => {
        if (read) reported = true;
        else missed();
      }, missed));
      offered = false;
    } catch (err) {
      if (reports && err instanceof DeadlineExceeded) {
        for (const id of before) if (rt.pendingDelegateReports.has(id) && !rt.get<ToolItem>(id)?.delegateReceiptState) {
          rt.patch<ToolItem>(id, { delegateWait: 'provider' });
        }
        rt.notice('info', 'Report pending', 'The provider did not become ready. The saved report can go with your next message.');
        this.preparePersonalReports(rt);
      }
      if (!(err instanceof NotNow)) {
        if (this.pendingLossWake.get(rt) === batch) this.pendingLossWake.delete(rt);
        missed();
        throw err;
      }
      changed = true;
    } finally {
      release();
      if (changed || [...rt.pendingDelegateReports].some(id => !before.has(id))) this.scheduleLossWake(rt);
    }
  }

  /** A destination that has not acknowledged its first input still owes the source a rollback. */
  private firstInputs = new Map<string, { missed(): void; rollback(): void }>();

  private async sendFirstInput(rt: SessionRuntime, handle: ProviderSession, item: UserItem, check: () => void, rollback: () => void) {
    let settle!: (taken: boolean | 'uncertain') => void;
    const received = new Promise<boolean | 'uncertain'>(resolve => { settle = resolve; });
    const finish = (taken: boolean | 'uncertain') => {
      if (this.firstInputs.get(rt.id) !== pending) return;
      this.firstInputs.delete(rt.id);
      settle(taken);
    };
    const pending = { missed: () => finish(false), rollback };
    this.firstInputs.set(rt.id, pending);
    try {
      await this.sendWithHandover(rt, handle, item, check, false, finish, () => finish('uncertain'));
      const outcome = await boundedBy(received, 90_000, 'uncertain' as const);
      if (outcome === 'uncertain') throw new DeliveryUncertain();
      if (!outcome) {
        check();
        throw new DeliveryMissed('The agent ended before confirming the message.');
      }
    } finally { finish(false); }
  }

  private delegateBudget(rt: SessionRuntime) {
    return rt.items.findLast((i): i is UserItem => i.type === 'user' && !i.parentId && i.state !== 'queued' && !i.until && !syntheticOf(i))
      ?? rt.items.find((i): i is ToolItem => i.type === 'tool' && !!(i.delegateDeliveryId || i.delegateReport));
  }

  // Prepare the next personal send without waiting for a transcript or disk commit at the composer.
  private personalReports = new WeakMap<NonNullable<ToolItem['delegateAttempt']>, { saved: boolean; block: string }>();

  private preparePersonalReports(rt: SessionRuntime) {
    const saved = this.stagePersonalReports(rt);
    if (saved) void rt.persistDelegate?.().then(saved).catch(err => this.log('delegate destination checkpoint failed', err));
  }

  private stagePersonalReports(rt: SessionRuntime) {
    if (this.disposed || rt.stopRequested || this.sessions.get(rt.id) !== rt) return;
    const session = rt.meta.providerSessionId;
    if (!session) return;
    const staged: { saved: boolean }[] = [];
    for (const id of rt.pendingDelegateReports) {
      const row = rt.get<ToolItem>(id);
      if (row?.delegateReport !== 'pending' || row.delegateAttempt) continue;
      const attempt = { prepared: randomUUID(), provider: rt.meta.provider, account: rt.meta.accountId, session, after: rt.handle?.delegateCheckpoint?.() };
      rt.promote?.(row);
      const deliveryId = row.delegateDeliveryId ?? randomUUID();
      const block = delegateReport(row.title, row.result?.agent?.background ?? row.status, row.result?.text ?? '', deliveryId);
      const state = { saved: false, block };
      this.personalReports.set(attempt, state);
      staged.push(state);
      rt.patch<ToolItem>(id, { delegateAttempt: attempt, delegateDeliveryId: deliveryId });
    }
    if (staged.length) return () => { for (const state of staged) state.saved = true; };
  }

  private clearPreparedReports(rt: SessionRuntime) {
    for (const id of rt.pendingDelegateReports) {
      const attempt = rt.get<ToolItem>(id)?.delegateAttempt;
      if (attempt && this.personalReports.delete(attempt)) rt.patch<ToolItem>(id, { delegateAttempt: undefined });
    }
  }

  private receiptReads = new WeakSet<NonNullable<ToolItem['delegateAttempt']>>();

  /** Read each origin once per batch. The reader never owns a send or a dispatch reservation. */
  private reconcileDelegateReports(rt: SessionRuntime) {
    type Attempt = NonNullable<ToolItem['delegateAttempt']>;
    const groups = new Map<string, { wanted: WantedReceipts; rows: { row: ToolItem; attempt: Attempt }[] }>();
    for (const id of rt.pendingDelegateReports) {
      const row = rt.get<ToolItem>(id);
      const attempt = row?.delegateAttempt;
      if (!row || !attempt || row.delegateReceiptState === 'unknown' || this.personalReports.has(attempt) || this.receiptReads.has(attempt)) continue;
      const key = JSON.stringify([attempt.provider, attempt.account, attempt.session]);
      let group = groups.get(key);
      if (!group) groups.set(key, group = { wanted: { ids: new Set(), tools: new Map() }, rows: [] });
      if (attempt.tool) {
        rt.promote?.(row);
        group.wanted.tools.set(attempt.tool, { delivery: row.delegateDeliveryId, digest: resultDigest(row.result?.text) });
      } else if (row.delegateDeliveryId) group.wanted.ids.add(row.delegateDeliveryId);
      this.receiptReads.add(attempt);
      group.rows.push({ row, attempt });
      rt.patch<ToolItem>(id, { delegateReceiptState: 'checking' });
    }
    for (const { wanted, rows } of groups.values()) {
      const origin = rows[0].attempt;
      const lookup = async () => origin.session ? this.provider(origin.provider, origin.account)
        .delegateReceipts?.(origin.session, rt.meta.cwd, origin.after, wanted, AbortSignal.timeout(3000)) : undefined;
      void boundedBy(lookup().catch(err => { this.log('delegate receipt lookup failed', err); return undefined; }), 3000, undefined)
        .then(async (receipts: DelegateReceipts | undefined) => {
          if (this.disposed || this.sessions.get(rt.id) !== rt) return;
          for (const { row, attempt } of rows) {
            if (row !== rt.get(row.id) || row.delegateAttempt !== attempt || !rt.pendingDelegateReports.has(row.id)) continue;
            const delivered = receipts?.ids.has(attempt.tool ? 'tool:' + attempt.tool : row.delegateDeliveryId!);
            if (!delivered && !receipts?.settled) {
              // The lookup did not complete (a long history is not read in 3 s). The first time for a row
              // the report goes again by the pending path, as after a lookup that did not find it: its text
              // tells the agent to ignore a copy it already has. The count is saved with the row and never
              // cleared, so a row is sent again by itself at most once. After that the row says "Delivery
              // unknown" and offers "Send report again"; nothing is written into the conversation.
              if (!row.delegateRedelivered) {
                this.refundDelegate(rt, attempt);
                rt.patch<ToolItem>(row.id, { delegateAttempt: undefined, delegateReceiptState: null, delegateReport: 'pending', delegateRedelivered: 1 });
                continue;
              }
              rt.patch<ToolItem>(row.id, { delegateWait: null, delegateReceiptState: 'unknown', delegateRetryId: randomUUID() });
              continue;
            }
            if (delivered) {
              rt.pendingDelegateReports.delete(row.id);
              if (!rt.meta.providerSessionId && !attempt.tool && rt.meta.provider === attempt.provider && rt.meta.accountId === attempt.account) {
                rt.update({ providerSessionId: attempt.session });
              }
            } else this.refundDelegate(rt, attempt);
            rt.patch<ToolItem>(row.id, { delegateAttempt: undefined, delegateReceiptState: null, delegateReport: delivered ? 'delivered' : 'pending' });
          }
          this.scheduleLossWake(rt);
          await rt.persistDelegate?.();
        }).catch(err => this.log('delegate reconciliation failed', err));
    }
  }

  private refundDelegate(rt: SessionRuntime, attempt: NonNullable<ToolItem['delegateAttempt']>) {
    const anchor = attempt.budget && rt.get<UserItem | ToolItem>(attempt.budget);
    if (anchor && anchor.delegateContinuations) rt.patch(anchor.id, { delegateContinuations: anchor.delegateContinuations - 1 });
  }

  /** Claude confirms input by UUID. Codex confirms turn/start or turn/steer by RPC. */
  private async sendWithHandover(rt: SessionRuntime, handle: ProviderSession, item: UserItem, check?: () => void, browser = false, receipt?: (taken: boolean) => void, uncertain?: () => void, steerNow = false) {
    const stops = this.stopsOf(rt);
    const reports: string[] = [];
    const reservation = Symbol();
    const ownsReports = () => reports.every(id => rt.reservedDelegateReports.get(id) === reservation);
    const maySend = () => {
      if (!ownsReports()) throw new NotNow('The delegate report was removed before dispatch.');
      if (this.updates?.installing) throw new NotNow('Sable is restarting for an update.');
      check?.();
      if (this.disposed || this.sessions.get(rt.id) !== rt || rt.handle !== handle || this.stopsOf(rt) !== stops) throw new NotNow('The agent was stopped or closed before the message went out.');
    };
    if (rt.meta.lane) await this.lanes.ready(rt);
    if (this.beforeFirstInput) await this.beforeFirstInput(rt.id);
    maySend();
    // A refused message retried after a restore can have disk-backed attachments.
    const card = rt.get<UserItem>(item.id);
    if (card && card !== item && isLight(card)) this.store.promote(rt.id, card);
    if (card?.heldAtLimit && card.text === item.text) rt.patch<UserItem>(card.id, { heldAtLimit: undefined });
    if (card?.type === 'user' && card.text === item.text && !card.until && (rt.meta.provider === 'opencode' || rt.meta.provider === 'codex')) {
      rt.patch<UserItem>(card.id, { state: 'queued', awaitingNativeReceipt: true });
      await rt.persistInput?.();
      maySend();
    }
    const out = this.withHandover(rt, this.store.promote(rt.id, item) as UserItem);
    const wake = !rt.get(item.id) && out.count ? this.pendingLossWake.get(rt) : undefined;
    if (item.text === RESUME_LOST && !rt.get(item.id) && !wake) { out.release?.(); return; }
    const reportWake = item.text === DELEGATE_REPORT && !rt.get(item.id);
    // Reserve before dispatch. A simultaneous personal send cannot claim the same reports.
    const blocks: string[] = [];
    let budget: UserItem | ToolItem | undefined;
    const personal = card?.type === 'user' && !card.until && !syntheticOf(card);
    if (rt.pendingDelegateReports.size && !isSlashCommand(item.text)) {
      if (!personal) budget = this.delegateBudget(rt);
      const capped = (budget?.delegateContinuations ?? 0) >= DELEGATE_CONTINUATIONS;
      if (!capped || [...rt.pendingDelegateReports].some(id => rt.get<ToolItem>(id)?.delegateWait === 'retry')) {
        if (capped) budget = undefined;
        const prepared = new Map<ToolItem, string>();
        try {
          for (const id of rt.pendingDelegateReports) {
            const step = rt.get<ToolItem>(id);
            if (step?.delegateReport !== 'pending') { rt.pendingDelegateReports.delete(id); continue; }
            const attempt = step.delegateAttempt;
            const staged = attempt && this.personalReports.get(attempt);
            if (attempt && !staged || !personal && (step.delegateWait || capped) && step.delegateWait !== 'retry') continue;
            if (personal && (!staged?.saved || attempt?.provider !== rt.meta.provider || attempt.account !== rt.meta.accountId ||
                attempt.session !== (rt.meta.providerSessionId ?? handle.delegateDestination?.()))) {
              // The person's input goes immediately. Its fresh turn can receive the report independently.
              if (step.delegateWait) rt.patch<ToolItem>(id, { delegateWait: null });
              continue;
            }
            if (!staged) rt.promote?.(step);
            const deliveryId = step.delegateDeliveryId ?? randomUUID();
            prepared.set(step, deliveryId);
            blocks.push(staged?.block ?? delegateReport(step.title, step.result?.agent?.background ?? step.status, step.result?.text ?? '', deliveryId));
          }
          const session = prepared.size ? rt.meta.providerSessionId ?? handle.delegateDestination?.() : undefined;
          const after = prepared.size ? handle.delegateCheckpoint?.() : undefined;
          for (const [step, deliveryId] of prepared) {
            if (step.delegateAttempt) this.personalReports.delete(step.delegateAttempt);
            rt.patch<ToolItem>(step.id, { delegateDeliveryId: deliveryId, ...(step.delegateWait ? { delegateWait: null } : {}), delegateAttempt: {
              prepared: step.delegateAttempt?.prepared ?? randomUUID(), provider: rt.meta.provider, account: rt.meta.accountId, session, after,
              budget: reports.length ? undefined : budget?.id,
            } });
            rt.pendingDelegateReports.delete(step.id);
            rt.reservedDelegateReports.set(step.id, reservation);
            reports.push(step.id);
          }
        } catch (err) { out.release?.(); throw err; }
      }
    }
    if (reportWake && !blocks.length) { out.release?.(); return; }
    let settled = false;
    let offered = false;
    let charged = false;
    let receiptTimer: NodeJS.Timeout | undefined;
    const offers: Extract<DelegateRecord, { attempt: unknown }>[] = [];
    const releasedOffers = new Map<string, NonNullable<ToolItem['delegateAttempt']>>();
    const issueReport = reports.length ? () => {
      if (settled || !ownsReports() || this.disposed || this.stopsOf(rt) !== stops || rt.handle !== handle) throw new NotNow('The report was withdrawn before dispatch.');
      if (offered) return;
      if (budget && (budget.delegateContinuations ?? 0) >= DELEGATE_CONTINUATIONS) throw new NotNow('The report waits for the next personal message.');
      offers.push(...this.offerDelegateReports(rt, reports.map(id => rt.get<ToolItem>(id)!)));
      offered = true;
      if (budget) {
        charged = true;
        rt.patch(budget.id, { delegateContinuations: (budget.delegateContinuations ?? 0) + 1 });
      }
    } : undefined;
    const settleReports = (read: boolean) => {
      if (settled) {
        if (read && this.sessions.get(rt.id) === rt) {
          let changed = false;
          for (const [id, attempt] of releasedOffers) if (rt.confirmLateDelegate(id, attempt)) changed = true;
          releasedOffers.clear();
          if (changed) void rt.persistDelegate?.().catch(err => this.log('late delegate receipt save failed', err));
        }
        return;
      }
      settled = true;
      clearTimeout(receiptTimer);
      for (const id of reports) {
        if (rt.reservedDelegateReports.get(id) !== reservation) continue;
        rt.reservedDelegateReports.delete(id);
        if (this.sessions.get(rt.id) !== rt) continue;
        if (rt.get<ToolItem>(id)?.delegateReport !== 'pending') continue;
        if (read) rt.patch<ToolItem>(id, { delegateReport: 'delivered', delegateAttempt: undefined });
        else {
          if (!offered) rt.patch<ToolItem>(id, { delegateAttempt: undefined });
          rt.pendingDelegateReports.add(id);
          if (offered) {
            const attempt = rt.get<ToolItem>(id)?.delegateAttempt;
            if (attempt) releasedOffers.set(id, attempt);
            this.scheduleLossWake(rt);
          }
        }
      }
      if (!offered && charged && budget?.delegateContinuations && rt.get(budget.id) === budget) {
        rt.patch(budget.id, { delegateContinuations: budget.delegateContinuations - 1 });
      }
      if (reports.length && this.sessions.get(rt.id) === rt) void rt.persistDelegate?.().then(() => this.delegateJournal.forget(rt.id, offers.map(record => record.key)))
        .catch(err => this.log('delegate receipt save failed', err));
    };
    if (blocks.length) out.item = { ...out.item, text: [out.item.text, ...blocks].join('\n\n') };
    const confirms = rt.meta.provider === 'claude' || rt.meta.provider === 'codex' || (rt.meta.provider === 'opencode' && (!!out.count || reports.length > 0));
    const taken = receipt || reports.length ? () => { settleReports(true); out.taken?.(); receipt?.(true); } : out.taken;
    const release = receipt || reports.length ? (unissued?: true) => {
      if (unissued && offered && !settled) {
        try { this.delegateJournal.save(rt.id, offers.map(record => ({ ...record, unissued: true }))); }
        catch (err) { this.log('could not journal the local report refusal', err); }
      }
      if (unissued) offered = false;
      settleReports(false);
      out.release?.();
      receipt?.(false);
      if (unissued && reports.length) this.scheduleLossWake(rt, 1500);
    } : out.release;
    if (reports.length) {
      receiptTimer = setTimeout(() => {
        if (!offered && this.sessions.get(rt.id) === rt && ownsReports()) {
          for (const id of reports) rt.patch<ToolItem>(id, { delegateWait: 'provider' });
          rt.notice('info', 'Report pending', 'The provider did not take the report. It can go with your next message.');
        }
        release?.(offered ? undefined : true);
      }, 90_000);
      receiptTimer.unref?.();
    }
    try {
      if (blocks.length && !personal) {
        await rt.persistDelegate?.();
        maySend();
      }
      if ((wake || reportWake) && !rt.turnActive) {
        const at = Date.now();
        this.wakeProcesses.set(rt, { handle, generation: rt.processGeneration, at });
        rt.update({ lossWake: { ...rt.meta.lossWake, attempts: [...recentLossWakes(rt, at), at] } });
      }
      if (!confirms) issueReport?.();
      const sending = handle.send(browser ? this.withBrowserPage(rt, out.item) : out.item, { issueReport, steerNow, personalOffset: personal && card.text === item.text ? out.personalOffset ?? 0 : undefined, delegateReport: reportWake, check: maySend, taken: confirms ? taken : undefined, release, uncertain });
      await (reports.length ? withDeadline(sending, 90_000, 'Report offer') : sending);
      if (!confirms) taken?.();
    } catch (err) {
      release?.();
      throw err;
    } finally {
      if (item.text === RESUME_LOST && wake && this.pendingLossWake.get(rt) === wake) this.pendingLossWake.delete(rt);
    }
  }

  /** The summary a move without the conversation carries: the chat before its switch line, as it stood then. */
  private moveSummaryText(rt: SessionRuntime, line: string, skip?: string): string {
    const at = rt.items.findIndex((i) => i.id === line);
    return handoverText(withoutChecks(at >= 0 ? rt.items.slice(0, at) : rt.items), { skip });
  }

  /**
   * The note after a move: what the person waits on and the open todos, as the chat stood at its
   * switch line. `lost`: the same message names background tasks lost on the way (nothing else
   * changed would be untrue).
   */
  private moveNoteText(rt: SessionRuntime, line: string, skip: string, lost = false): string {
    const at = rt.items.findIndex((i) => i.id === line);
    const anchor = rt.get<NoticeItem>(line);
    const wakeLost = anchor?.type === 'notice' && anchor.detail?.includes(WAKE_LOST);
    return moveNote(at >= 0 ? rt.items.slice(0, at) : rt.items, rt.todos, { skip, lost, wake: wakeLost ? WAKE_LOST : undefined });
  }

  /** What an agent the chat switched to has not seen: the whole chat, or what happened since it was left (`since`). */
  private agentHandoverText(rt: SessionRuntime, pending: AgentHandover, skip?: string): string {
    const range = withoutChecks(itemsSince(rt.items, pending.since)).filter((i) => i.id !== skip);
    const worked = workedIn(range, pending.from).filter((p) => p !== rt.meta.provider);
    const from = (worked.length ? worked : [pending.from]).map((p) => this.agentName(p)).join(' and ');
    // Bounded whatever the chat holds: the newest exchanges within the budget, the person's last
    // message always, the open todos and the files changed in the range.
    return handoverText(range, { from, since: !!pending.since, maxChars: SWITCH_HANDOVER_CHARS, todos: rt.todos, files: changedFiles(range, rt.meta.cwd) });
  }

  /** An agent's name, also for one this build does not have. */
  private agentName(provider: ProviderId): string {
    return this.providers.get(provider)?.name ?? AGENT_NAMES[provider] ?? provider;
  }

  // ── the session's model ──

  /** Sessions whose model changed while their agent was there: it takes the model right before the next message (`speed`: the speed fell back too). */
  private modelDue = new Map<string, { speed: boolean }>();
  /** Sessions whose agent has not taken the mode a phone chose while work ran (`session.setMode`): it goes with the next message. */
  private modeDue = new Set<string>();

  /**
   * Sets the session's model. Nothing goes to the agent now: a running agent takes it right
   * before the next message goes out (live where the agent can, so its process and any background
   * work stay); an agent that starts later starts with it.
   */
  private setSessionModel(rt: SessionRuntime, model: string) {
    if (!model || model === rt.meta.model) return;
    rt.update({ model });
    // A speed the new model does not offer falls back to standard.
    let speed = false;
    if (rt.meta.speed && rt.meta.speed !== STANDARD_SPEED && speedFor(this.modelInfo(rt, model), rt.meta.speed) === STANDARD_SPEED) {
      rt.update({ speed: STANDARD_SPEED, fast: false });
      speed = true;
    }
    if (rt.handle || this.opening.has(rt.id)) this.modelDue.set(rt.id, { speed: speed || !!this.modelDue.get(rt.id)?.speed });
  }

  /** A mode a phone chose during earlier work goes to the agent and answers at once from this message on (never inside a running turn). */
  private async applyModeDue(rt: SessionRuntime, handle: ProviderSession) {
    if (rt.turnActive || !(rt.dangerHeld || this.modeDue.has(rt.id))) return;
    rt.dangerHeld = false;
    this.scheduleLossWake(rt);
    rt.heldMode = undefined;
    if (this.modeDue.delete(rt.id)) await handle.setMode(rt.meta.mode).catch((err: Error) => this.log('mode change failed', err.message));
  }

  /** A model chosen since the agent started goes to it now (never into a running turn: a steer leaves it for the next message). */
  private async applyDue(rt: SessionRuntime, handle: ProviderSession) {
    await this.applyModeDue(rt, handle);
    const due = this.modelDue.get(rt.id);
    if (!due || rt.turnActive) {
      // An effort the running agent did not take when it was chosen goes with this message (a change
      // still unanswered holds the message a few seconds at most; the effort stays due then).
      if (this.effortDue.has(rt.id)) await this.effortFirst(rt, handle);
      return;
    }
    this.modelDue.delete(rt.id);
    try {
      await handle.setModel(rt.meta.model);
      if (due.speed) await handle.setSpeed?.(rt.meta.speed ?? STANDARD_SPEED);
    } catch (err) {
      this.log('model change failed', (err as Error).message);
    }
    // A model change can reset the agent's effort to the model's own: the session's goes again.
    if (rt.meta.effort) await this.effortFirst(rt, handle);
  }

  /** Sessions whose running agent has not taken the effort they hold (it refused, or failed to answer). */
  private effortDue = new Set<string>();
  /** Per session, the effort change going to its agent now: the next waits for it (one at a time, in order). */
  private effortRuns = new Map<string, Promise<void>>();
  /**
   * Per session, effort calls by the order they went out: those the agent has not answered yet, and the
   * newest it has answered. A call it answers after a newer one (it stalled past the wait) left the
   * agent on an old pick: the session's goes again.
   */
  private effortCalls = new Map<string, { sent: number; out: Set<number>; landed: number }>();
  /** How long the next change, or a message, waits for a change the agent has not answered. */
  private effortWaitMs = EFFORT_WAIT_MS;

  /** The effort to the agent before a message, waiting for it a few seconds at most (an agent that never answers does not hold the message). */
  private effortFirst(rt: SessionRuntime, handle: ProviderSession) {
    return Promise.race([
      this.applyEffort(rt, handle),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.effortWaitMs);
        t.unref?.();
      }),
    ]);
  }

  /**
   * The session's effort to its running agent (none running: the next start reads it from the session).
   * One change at a time per session, each sending what the session holds when its turn comes (quick
   * picks coalesce to the latest), so the agent ends with the last pick whatever order it answers in:
   * a change it never answers is waited for a few seconds, and should it answer after a newer one did,
   * the newest pick goes again. Never throws: a refusal leaves it due, and it goes again right before
   * the next message.
   */
  private async applyEffort(rt: SessionRuntime, handle: ProviderSession | undefined) {
    if (!handle || !rt.meta.effort) return void this.effortDue.delete(rt.id);
    this.effortDue.add(rt.id);
    // After the change before it (one the agent never answers is waited for a few seconds, not for ever).
    const prev = this.effortRuns.get(rt.id);
    const ready = prev ? Promise.race([prev, new Promise<void>((r) => setTimeout(r, this.effortWaitMs).unref?.())]) : Promise.resolve();
    const run = ready.then(async () => {
      const effort = rt.meta.effort;
      // Settled meanwhile (a later run sent the same pick), or the agent is another one now (it starts with the session's).
      if (!effort || !this.effortDue.has(rt.id) || (rt.handle && rt.handle !== handle)) return;
      let calls = this.effortCalls.get(rt.id);
      if (!calls) this.effortCalls.set(rt.id, (calls = { sent: 0, out: new Set(), landed: 0 }));
      const n = ++calls.sent;
      calls.out.add(n);
      try {
        await handle.setEffort(effort);
        calls.out.delete(n);
        const late = calls.landed > n;
        calls.landed = Math.max(calls.landed, n);
        if (rt.handle && rt.handle !== handle) return;
        // A newer call is still out: it is answered after this one and decides.
        if ([...calls.out].some((m) => m > n)) return;
        if (rt.meta.effort === effort) this.effortDue.delete(rt.id);
        // Answered after a newer call was: the agent is on this old pick now. The session's goes again.
        else if (late) void this.applyEffort(rt, handle);
        // Otherwise a later pick came meanwhile: it stays due, and the run queued for it sends it.
      } catch (err) {
        calls.out.delete(n);
        this.log('effort change failed; it goes with the next message', (err as Error).message);
      }
    });
    this.effortRuns.set(rt.id, run);
    try {
      await run;
    } finally {
      if (this.effortRuns.get(rt.id) === run) this.effortRuns.delete(rt.id);
    }
  }

  /**
   * `/model <name>` typed as a message (the phone, or anything that did not catch it first): never
   * sent. Sets the session's model, or switches the chat to the agent that has a model of that name.
   */
  private async modelCommand(rt: SessionRuntime, query: string): Promise<RpcMethods['session.send']['result']> {
    if (!query) return { ok: false, error: 'Name a model after /model' };
    const caps = rt.caps ?? this.cachedCaps(rt.meta.provider, rt.meta.accountId ?? DEFAULT_ACCOUNT, rt.meta.cwd) ?? (await this.capsFast(rt.meta.provider, rt.meta.cwd, rt.meta.accountId ?? DEFAULT_ACCOUNT).catch(() => undefined));
    const own = matchModel(query, caps?.models ?? []);
    if (own) {
      this.setSessionModel(rt, own.id);
      return { ok: true, model: own.id };
    }
    for (const p of this.otherAgents()) {
      if (p === rt.meta.provider) continue;
      const accountId = rt.meta.agents?.find((l) => l.provider === p)?.accountId ?? this.defaultAccountId(p);
      const theirs = this.cachedCaps(p, accountId, rt.meta.cwd) ?? this.cachedCaps(p, accountId);
      const m = theirs && matchModel(query, theirs.models);
      if (!m) continue;
      await this.switchAgent(rt, p, { model: m.id });
      return { ok: true, model: m.id, switched: p };
    }
    return { ok: false, error: `No model called “${query}”` };
  }

  /** The message as the agent gets it: one line on the page in the Browser tab when it changed since the last message (never its content). */
  private withBrowserPage(rt: SessionRuntime, item: UserItem): UserItem {
    const text = withBrowserLine(rt, item.text);
    return text === item.text ? item : { ...item, text };
  }

  // ── accounts at a limit ──

  /** Limits known per account of `provider`: what the usage service remembers, then what came in this run. */
  private async knownLimits(provider: ProviderId): Promise<KnownLimits> {
    // An agent's first word names who is signed in: limits kept from another person's sign-in are
    // forgotten with it (noteSignIns), so no decision is made on them a moment before.
    await this.firstWord(provider);
    const out: KnownLimits = new Map();
    if (this.handlers.has('usage.limits')) {
      const reports = await this.call('usage.limits', {}).catch(() => []);
      for (const r of reports) if (r.provider === provider) out.set(r.accountId, { limits: r.limits, planLimits: r.planLimits });
    }
    // This run's last read: whole, it is the account's; partial (some windows only), it lays over the
    // merged report by window, never a shorter list in its place (review wave 7, #9).
    for (const a of this.accountList(provider)) {
      const key = accountKey(provider, a.id);
      const l = this.limitsCache.get(key);
      if (!l?.length) continue;
      const known = out.get(a.id)?.limits;
      out.set(a.id, { ...out.get(a.id), limits: this.limitsPartial.has(key) && known?.length ? mergeWindows(known, l) : l });
    }
    return out;
  }

  /**
   * The signed-in account of `provider` to go on with, other than `current`: under its own cap, one
   * on the same plan first, then the most room (with `model`, other models' full windows do not
   * count); with `byCap`, the next one in the person's order and never an API key; with the person's
   * own order chosen (`accountsBy: 'manual'`), the first in it. Undefined when none has room.
   * `rt`: the chat that moves: its effective model decides which windows count (the alias "default"
   * is the model it names, as the Spare planner reads it), and an account whose known models leave out
   * the chat's own is not taken. `except`: accounts that already refused this message.
   */
  async nextAccount(provider: ProviderId, current: string, opts: { model?: string; refusedModel?: string; wakeModel?: string; cwd?: string; rt?: SessionRuntime; byCap?: boolean; except?: Iterable<string> } = {}): Promise<string | undefined> {
    // The sign-ins first: one that changed forgets its old limits before they are read.
    const info = await this.providerInfo(provider);
    const known = await this.knownLimits(provider);
    const accounts = info.accounts ?? [];
    const cwd = opts.rt?.meta.cwd ?? opts.cwd;
    const capsOf = (accountId: string) => this.cachedCaps(provider, accountId, cwd) ?? this.cachedCaps(provider, accountId);
    const chosen = opts.model ?? opts.rt?.meta.model;
    const ownCaps = (opts.rt?.caps ?? capsOf(current))?.models;
    const model = effectiveModel(chosen || undefined, ownCaps, this.store.state.settings.defaultModels[provider]);
    // The chat's own model as its account lists it: another account whose known list leaves it out cannot take the chat (review wave 7, #12).
    const named = opts.refusedModel ? model : ownCaps?.find(m => m.id === chosen && chosen !== 'default')?.id;
    const offers = (accountId: string) => {
      if (!named) return true;
      const models = capsOf(accountId)?.models;
      if (!models?.length) return true;
      if ((!chosen || chosen === 'default') && effectiveModel(chosen, models)?.toLowerCase() === named.toLowerCase()) return true;
      return models.some((m) => m.id.toLowerCase() === named.toLowerCase() || m.name.toLowerCase() === named.toLowerCase());
    };
    const except = new Set(opts.except ?? []);
    const now = Date.now();
    const required = [model, opts.wakeModel].filter((id): id is string => !!id);
    for (const a of accounts) {
      const limits = known.get(a.id)?.limits ?? a.limits;
      if (!offers(a.id) || required.some(id => atCap(limits, now, id))) except.add(a.id);
    }
    const manual = this.store.state.settings.accountsBy === 'manual';
    return pickNextAccount(
      current,
      accounts.map((a) => ({
        id: a.id,
        signedIn: a.auth.loggedIn,
        isDefault: a.isDefault,
        limits: known.get(a.id)?.limits ?? a.limits,
        // An API key bills per token: known as such from its sign-in now, whatever an older limits report said (review wave 7, #3).
        planLimits: isApiKeyAuth(a.auth) ? false : known.get(a.id)?.planLimits,
        cap: this.capOf(provider, a.id),
        plan: a.auth.plan,
        weight: planWeight(provider, a.auth),
      })),
      Date.now(),
      { model: opts.refusedModel ?? model, plan: accounts.find((a) => a.id === current)?.auth.plan, byCap: opts.byCap, useFirst: !manual, manual, except },
    );
  }

  /**
   * The model a chat's turns run on, as per-model windows name it (the alias "default" resolved):
   * one reading for ranking, moves, caps and reset notices (review wave 8, #27).
   */
  private chatModel(rt: SessionRuntime): string | undefined {
    const caps = rt.caps ?? this.cachedCaps(rt.meta.provider, rt.meta.accountId ?? DEFAULT_ACCOUNT, rt.meta.cwd);
    return effectiveModel(rt.meta.model, caps?.models, this.store.state.settings.defaultModels[rt.meta.provider]);
  }

  // ── caps: "use up to" per account ──

  /** The cap set for an account, when it has one below 100%. */
  private capOf(provider: ProviderId, accountId: string): AccountCap | undefined {
    const cap = this.store.state.settings.accountCaps?.[creditsKey(provider, accountId)];
    return hasCap(cap) ? cap : undefined;
  }

  private accountLabel(provider: ProviderId, accountId: string) {
    return this.findAccount(provider, accountId)?.label ?? 'another account';
  }

  /**
   * Where a new session starts when `accountId` is past its cap: the next account under its own
   * cap, with the line that says why. Undefined when it is under its cap, or no account is.
   */
  private async underCapStart(provider: ProviderId, accountId: string, chosen: string | undefined, cwd?: string): Promise<{ to: string; line: string } | undefined> {
    const cap = this.capOf(provider, accountId);
    if (!cap) return undefined;
    const known = await this.knownLimits(provider);
    // The alias "default" resolved, as everywhere else that reads per-model windows (review wave 8, #27).
    const caps = this.cachedCaps(provider, accountId, cwd) ?? this.cachedCaps(provider, accountId);
    const model = effectiveModel(chosen || undefined, caps?.models, this.store.state.settings.defaultModels[provider]);
    const reached = capReached(known.get(accountId)?.limits, cap, model);
    if (!reached) return undefined;
    const next = await this.nextAccount(provider, accountId, { model, byCap: true }).catch(() => undefined);
    if (!next) return undefined;
    return { to: next, line: `Started with ${this.accountLabel(provider, next)}: ${capReason(this.accountLabel(provider, accountId), reached)}` };
  }

  /**
   * Before a message goes out and when a turn ends: a session whose account is past the cap set for
   * it moves, between turns, to the next signed-in account under its own cap, carrying the
   * conversation, with one line in the chat. With none under its cap it stays and says so once.
   * Accounts without a cap cost nothing here.
   */
  private checkCap(rt: SessionRuntime): Promise<void> {
    const running = this.capChecks.get(rt.id);
    if (running) return running;
    if (rt.turnActive || !this.capOf(rt.meta.provider, rt.meta.accountId ?? DEFAULT_ACCOUNT)) return Promise.resolve();
    const run = this.moveOffCap(rt)
      .catch((err) => this.log('cap check failed', (err as Error).message))
      .finally(() => { this.capChecks.delete(rt.id); this.scheduleLossWake(rt); });
    this.capChecks.set(rt.id, run);
    return run;
  }

  private async moveOffCap(rt: SessionRuntime) {
    const provider = rt.meta.provider;
    const from = rt.meta.accountId ?? DEFAULT_ACCOUNT;
    const model = this.chatModel(rt);
    const known = await this.knownLimits(provider);
    const reached = capReached(known.get(from)?.limits, this.capOf(provider, from), model);
    if (!reached) return;
    // The next account in the person's order, never an API key (a cap does not start paying per token).
    const next = await this.nextAccount(provider, from, { rt, byCap: true }).catch(() => undefined);
    // Never mid-turn: a turn that started meanwhile runs on, and its end checks again.
    if (this.limitPending(rt) || rt.turnActive || (rt.meta.accountId ?? DEFAULT_ACCOUNT) !== from || this.sessions.get(rt.id) !== rt) return;
    const name = this.accountLabel(provider, from);
    if (!next) {
      const key = `${rt.id}:${from}:${reached.kind}:${reached.resetsAt ?? ''}`;
      if (this.capWarned.has(key)) return;
      this.capWarned.add(key);
      rt.notice('info', capReason(name, reached), 'No other account is under its cap, so this chat stays here');
      return;
    }
    // Sable's own move, which can wait: never under work that still runs in the process it would
    // close (a sub-agent, a young command); the end of that work looks again (`restMoves`).
    if (this.holdsMove(this.workOf(rt, true))) return this.recheckWhenFree(rt);
    const label = this.accountLabel(provider, next);
    try {
      // What the move leaves behind (where it goes back, where new chats start) only once it happened.
      await this.switchAccount(rt, next, { line: `Moved to ${label}: ${capReason(name, reached)}`, waits: true, limitReturn: { at: reached.resetsAt } });
    } catch (err) {
      this.autoMoveFailed(rt, err, `Could not move to ${label}`);
    }
  }

  /**
   * A move Sable made by itself did not happen. Refused for now (the chat works: `NotNow`), it is
   * looked at again at the next rest; a removed phone or a closed chat needs nothing. Anything else is
   * said in the chat, once, with why (`text`: what did not happen).
   */
  private autoMoveFailed(rt: SessionRuntime, err: unknown, text: string) {
    if (err instanceof CallerGone || this.sessions.get(rt.id) !== rt) return;
    if (err instanceof NotNow) {
      this.log('a move waits:', (err as Error).message);
      this.recheckWhenFree(rt);
      return;
    }
    this.log(`${text}:`, (err as Error).message);
    const detail = `${(err as Error).message}\nThis chat stays on ${this.accountLabel(rt.meta.provider, rt.meta.accountId ?? DEFAULT_ACCOUNT)}.`;
    if (rt.meta.status === 'error' && !rt.turnActive) rt.update({ status: 'idle', lastError: undefined });
    const card = rt.items.findLast((i): i is NoticeItem => i.type === 'notice' && !!i.limit?.moving && !i.limit.continuedWith);
    if (card) rt.patch<NoticeItem>(card.id, { detail: [card.detail, text, detail].filter(Boolean).join('\n') });
    else rt.notice('info', text, detail);
  }

  /**
   * A turn was refused at a plan limit: the notice learns which account, when the window resets and
   * which account could carry on. With "Continue with the next account at a limit" on, the session
   * moves there and the refused message goes out again (once per message and account). A turn
   * Spare started (`spare`) never moves: it waits again instead (`SpareWaits.limitHit`).
   */
  /** A new refusal may arrive during the preceding handoff's send. Finish that move first. */
  private accountMoves = new Map<string, Promise<unknown>>();
  private limitDecisions = new Map<string, Set<string>>();

  private limitPending(rt: SessionRuntime) {
    return this.limitDecisions.has(rt.id) || this.bgLimits.has(rt.id);
  }

  private async onLimitHit(rt: SessionRuntime, notice: NoticeItem, spare = false, settleMs = this.backgroundLimitMs?.settle ?? BACKGROUND_LIMIT_SETTLE_MS, manualOnly = false) {
    if (!notice.limit?.origin) {
      const user = this.refusedMessage(rt, notice);
      rt.patch<NoticeItem>(notice.id, { limit: { ...notice.limit, origin: user ? 'user' : 'background', userItemId: user?.id } });
    }
    const active = this.limitDecisions.get(rt.id) ?? new Set<string>();
    if (active.has(notice.id)) return;
    active.add(notice.id);
    this.limitDecisions.set(rt.id, active);
    if (!manualOnly && this.refusalQueues.has(rt)) this.refusalQueues.set(rt, notice.id);
    try {
      await this.decideLimit(rt, notice, spare, settleMs, manualOnly);
    } finally {
      active.delete(notice.id);
      if (!active.size) this.limitDecisions.delete(rt.id);
      this.scheduleLossWake(rt);
      // Decided: a later refusal (a turn the agent wakes for) is not folded into this card unseen, where
      // nothing would decide it again; it gets a card of its own (D4). While background work still runs
      // on the account, its refusals still belong to this one.
      const card = rt.get<NoticeItem>(notice.id);
      if (!spare && rt.limitCard === notice.id && card?.limit?.provider && !card.limit.moving && !(rt.meta.background ?? 0)) rt.limitCard = undefined;
      if (!active.size && !manualOnly && !rt.turnActive && card?.limit?.provider && rt.meta.spare?.refusalId !== notice.id && this.sessions.get(rt.id) === rt && !this.disposed) {
        const next = this.pendingPersonal(rt);
        if (next) await this.onLimitHit(rt, next, spare, settleMs);
      }
    }
  }

  private pendingPersonal(rt: SessionRuntime) {
    return rt.items.find((i): i is NoticeItem => i.type === 'notice' && !i.parentId && !!i.limit?.userItemId && !!i.limit.accountId && !i.limit.provider && !i.limit.continuedWith);
  }

  private async decideLimit(rt: SessionRuntime, notice: NoticeItem, spare: boolean, settleMs: number, manualOnly: boolean) {
    const provider = rt.meta.provider;
    const current = rt.meta.accountId ?? DEFAULT_ACCOUNT;
    const accountId = notice.limit?.accountId ?? current;
    // Still the same chat, open and on this account after every wait below (review wave 16, #10).
    const closes = this.closesOf(rt);
    const stops = this.stopsOf(rt);
    const stopped = () => manualOnly || rt.stopRequested || this.stopsOf(rt) !== stops;
    const open = () => !this.disposed && this.sessions.get(rt.id) === rt && this.closesOf(rt) === closes && (rt.meta.accountId ?? DEFAULT_ACCOUNT) === current;
    const known = await this.knownLimits(provider);
    // Every window that is used up and holds this chat's model has to reset before the account can
    // work again; another model's full week is not this chat's wait (review wave 8, #27).
    const rows = known.get(accountId)?.limits;
    const named = agentLimitOf(notice.detail);
    const window = this.limitModel(named?.window, rows) ? named?.window : notice.limit?.window;
    const wakeModel = this.limitModel(notice.limit?.wakeWindow, rows);
    const refusedModel = this.limitModel(provider === 'codex' ? named?.window : window, rows);
    const model = refusedModel ?? this.chatModel(rt);
    const now = Date.now();
    const own = (known.get(accountId)?.limits ?? []).filter((l) => l.percent >= 100 && !(l.resetsAt && l.resetsAt <= now) && (!windowModel(l) || !model || windowForModel(l, model)));
    const full = own.sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0];
    // The accounts that already refused this message are not tried again (review wave 7, #10).
    const user = this.refusedMessage(rt, notice)?.id;
    const previous = this.autoContinued.get(rt);
    const chain = previous && previous.user === user ? previous : { user, accounts: new Set<string>() };
    const tried = chain.accounts;
    const selection = await this.nextAccount(provider, accountId, { rt, refusedModel: refusedModel ?? wakeModel, wakeModel, except: tried }).catch((err: Error) => {
      this.log('could not check alternative accounts', err.message);
      return null;
    });
    if (!open()) return;
    // An unavailable reading still permits a reset wait. Only a completed selection can report no room.
    const next = selection ?? undefined;
    const limit = { ...notice.limit, provider: selection === null ? undefined : provider, accountId, resetsAt: notice.limit?.resetsAt ?? full?.resetsAt, window: window ?? full?.label, next };
    // A refused turn was not carried by credits, so only the next account or the notice remain.
    const settings = this.store.state.settings;
    const moves = decideAtLimit({ creditsAllowed: false, creditsAvailable: false, continueAtLimit: !!settings.continueAtLimit, next }) === 'next' && !!next;
    // Moving by itself: the notice never offers the button for it, not even for a frame.
    const willMove = !stopped() && !spare && moves && !rt.turnActive;
    rt.patch<NoticeItem>(notice.id, { limit: willMove ? { ...limit, moving: true } : limit });
    if (spare || stopped()) return;
    if (!moves && !rt.turnActive) {
      // Nothing goes on on the account at its limit, whatever comes next (review wave 16, #6); sends
      // queue behind the stop (review wave 17, #5).
      await this.holdSends(rt, this.settleBackground(rt, limit, settleMs));
      if (!open() || stopped()) return;
      // No other account takes over: the chat waits for this account's reset and then carries on by itself.
      if (this.store.state.settings.continueAtReset) this.spare.atReset(rt, notice.id);
    }
    if (!moves || rt.turnActive || stopped()) return;
    if (tried.has(next)) return;
    tried.add(next);
    let moved = false;
    // This account refused it: a later limit of the same message does not come back here.
    tried.add(accountId);
    this.autoContinued.set(rt, chain);
    // The move happens by itself: the notice offers no button for it meanwhile (`LimitHit.moving`).
    rt.patch<NoticeItem>(notice.id, { limit: { ...limit, moving: true } });
    try {
      // One transition, reserved before anything is awaited: sends queue behind it and go once it is
      // over, on the account the chat is on then (review wave 17, #5).
      await this.holdSends(
        rt,
        (async () => {
          // Background work still running on this account meets the same limit with its next request: it
          // gets a short while to end by itself, then what is left stops at the limit (limit-policy.ts).
          await this.settleBackground(rt, limit, settleMs);
          const prior = this.accountMoves.get(rt.id);
          if (prior) await prior.catch(() => {});
          if (stopped() || rt.turnActive || this.moving.has(rt.id) || !this.openLimit(rt, notice.id) || !open()) return;
          if (!this.store.state.settings.continueAtLimit) {
            if (this.store.state.settings.continueAtReset) this.spare.atReset(rt, notice.id);
            return;
          }
          try {
            // Where it goes back and where new chats start meanwhile: written only for a move that
            // happens, before the refused message goes out again there (D5).
            await this.switchAccount(rt, next, { retry: true, refusalId: notice.id, automatic: true, limitReturn: { at: full?.resetsAt ?? limit.resetsAt, models: [refusedModel, wakeModel] } });
            moved = true;
          } catch (err) {
            this.autoMoveFailed(rt, err, `Could not continue with ${this.accountLabel(provider, next)}`);
          }
        })(),
      );
    } finally {
      if (!moved) tried.delete(next);
      // Not moved after all (it failed, or something took over): the notice offers the move again.
      const card = rt.get<NoticeItem>(notice.id);
      if (card?.limit?.moving) rt.patch<NoticeItem>(notice.id, { limit: { ...card.limit, moving: undefined } });
    }
  }

  /** The model the CLI actually refused, including when its usage rows have not arrived yet. */
  private limitModel(label: string | undefined, limits?: RateLimit[]): string | undefined {
    if (!label) return;
    const row = limits?.find((l) => l.label === label || l.id === label);
    const own = row && windowModel(row);
    if (own) return own;
    const model = /^Weekly\s*·\s*(.+)$/i.exec(label)?.[1].trim().toLowerCase();
    return model === 'all models' ? undefined : model;
  }

  private refusalModels(card: NoticeItem | undefined, rows?: RateLimit[]) {
    const limit = card?.limit;
    const named = this.limitModel(agentLimitOf(card?.detail)?.window, rows);
    return { refusedModel: named ?? this.limitModel(limit?.window, rows), wakeModel: this.limitModel(limit?.wakeWindow, rows) };
  }

  /** Per chat, a limit met by its background work and not decided yet (`limitInBackground`). */
  private bgLimits = new Map<string, { first: number; last: number; timer?: NodeJS.Timeout; card: string }>();

  /**
   * Background work met a plan limit while the chat's own turn is over (limit-policy.ts has the
   * rule): the chat's one limit notice is written by the first refusal, and once the refusals stop
   * coming the chat's limit is decided as a turn's is (`onLimitHit`): it moves to the next account
   * and carries on by itself, or the notice offers "Continue at reset". While a turn runs its own
   * refusal says it and its end decides; a window of another model (a sub-agent's own) is only that
   * step's.
   */
  private limitInBackground(rt: SessionRuntime, hit: BackgroundLimit) {
    if (rt.turnActive || this.sessions.get(rt.id) !== rt) return;
    // Closed (its agent let go): nothing starts it again.
    if (rt.stopRequested && !rt.handle) return;
    const accountId = rt.meta.accountId ?? DEFAULT_ACCOUNT;
    if (hit.stepId) {
      const rows = this.limitsCache.get(accountKey(rt.meta.provider, accountId));
      const own = this.limitModel(hit.window, rows);
      const model = this.chatModel(rt);
      if (own && model && !matchesWindowModel(own, model)) return;
    }
    // Claude can publish the wake's refusal immediately after the person's named 429.
    // The same handoff must carry the person's payload and respect both windows.
    const personal = this.openLimit(rt);
    if (!hit.stepId && personal?.limit?.origin === 'user' && !personal.limit.provider && this.limitDecisions.get(rt.id)?.has(personal.id)) {
      this.refusalQueues.set(rt, personal.id);
      rt.patch<NoticeItem>(personal.id, { limit: { ...personal.limit, wakeWindow: hit.window, resetsAt: Math.max(hit.resetsAt ?? 0, personal.limit.resetsAt ?? 0) || undefined } });
      return;
    }
    const now = Date.now();
    let open = rt.limitCard ? rt.get<NoticeItem>(rt.limitCard) : undefined;
    if (open?.limit?.continuedWith) open = undefined;
    if (!open) {
      open = rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'You have reached your usage limit.', ...(hit.detail ? { detail: hit.detail } : {}), limit: { origin: 'background', resetsAt: hit.resetsAt, window: hit.window } });
      rt.limitCard = open.id;
    } else if (open.limit && !hit.stepId && hit.window) {
      rt.patch<NoticeItem>(open.id, { detail: hit.detail ?? open.detail, limit: { ...open.limit, origin: open.limit.origin ?? 'background', window: hit.window, resetsAt: hit.resetsAt ?? open.limit.resetsAt } });
    } else if (open.limit && (!open.limit.resetsAt || !open.limit.window) && (hit.resetsAt || hit.window)) {
      rt.patch<NoticeItem>(open.id, { limit: { ...open.limit, resetsAt: open.limit.resetsAt ?? hit.resetsAt, window: open.limit.window ?? hit.window } });
    }
    const was = this.bgLimits.get(rt.id);
    const state = was && was.card === open.id ? { ...was, last: now } : { first: now, last: now, card: open.id };
    clearTimeout(was?.timer);
    const wait = backgroundLimitDue({ first: state.first, last: state.last, now, running: rt.meta.background ?? 0, settleMs: this.backgroundLimitMs?.settle, maxMs: this.backgroundLimitMs?.max });
    state.timer = setTimeout(() => void this.decideBackgroundLimit(rt, state.card).catch((err) => this.log('background limit failed', (err as Error).message)), wait);
    state.timer.unref?.();
    this.bgLimits.set(rt.id, state);
    this.refusalQueues.set(rt, open.id);
  }

  /** The limit background work met is decided now: as a refused turn's (`onLimitHit`), unless a turn took it over meanwhile. */
  private async decideBackgroundLimit(rt: SessionRuntime, card: string) {
    const state = this.bgLimits.get(rt.id);
    if (state?.card === card) this.bgLimits.delete(rt.id);
    this.scheduleLossWake(rt);
    const notice = rt.get<NoticeItem>(card);
    if (!notice?.limit || notice.limit.continuedWith || this.sessions.get(rt.id) !== rt) return;
    // A turn began meanwhile (a notification woke the agent): its end decides, in this notice.
    if (rt.turnActive) return;
    // The refusals have stopped coming (or the wait is over): what still runs stops at the limit now.
    await this.onLimitHit(rt, notice, false, 0);
  }

  /**
   * Before a move at a limit: background work still running on the account gets a short while to
   * end by itself (it is refused with its next request), then what is left stops at the limit.
   */
  private async settleBackground(rt: SessionRuntime, limit: { window?: string; resetsAt?: number }, ms: number) {
    const end = Date.now() + ms;
    while ((rt.meta.background ?? 0) > 0 && Date.now() < end && !rt.turnActive) await new Promise((r) => setTimeout(r, 100));
    if (!rt.turnActive && (rt.meta.background ?? 0) > 0) await this.stopLiveBackground(rt, limit);
  }

  /**
   * What still runs in the background on an account at its limit is stopped for real (review wave
   * 16, #6): the agent's own stop where it has one (`stopBackgroundWork`: Claude Code's tasks and
   * process, Codex's sub-agent turns interrupted), else its process is let go and its tasks end with
   * it. A step is marked stopped at the limit, and named to the agent after a move, only once its
   * stop was confirmed (review wave 17, #6); one that could not be stopped keeps running in the
   * Agents tab, the chat says so plainly, and a move still goes ahead (`unstoppable`).
   */
  private async stopLiveBackground(rt: SessionRuntime, limit: { window?: string; resetsAt?: number }, automatic = true) {
    // Work already found unstoppable is not asked again.
    const running = rt.items.filter((i) => worksInBackground(i) && !this.unstoppable.get(rt.id)?.has(i.id)).map((i) => i.id);
    if (!running.length) return;
    type Stop = boolean | { failed: string[] };
    const delegates = [...rt.delegates.entries()].filter(([id]) => running.includes(id));
    for (const [, call] of delegates) call.stop(false);
    const confirmations = delegates.map(async ([id, call]) =>
      await boundedBy(call.ended.then(() => true), MOVE_CLOSE_MS, false) ? undefined : id);
    const h = rt.handle as (ProviderSession & { stopBackgroundWork?: (automatic: boolean) => Promise<Stop> }) | undefined;
    const bounded = (p: Promise<Stop>) => Promise.race([p.catch((): Stop => false), new Promise<Stop>((r) => setTimeout(() => r(false), MOVE_CLOSE_MS))]);
    let result: Stop = true;
    if (h?.stopBackgroundWork) result = await bounded(h.stopBackgroundWork(automatic));
    else if (h) {
      rt.handle = undefined;
      result = await this.closeWriter(rt, rt.meta.accountId ?? DEFAULT_ACCOUNT, h, rt.meta.provider, 'limit').then(() => true, () => false);
    }
    // A turn began while they were being stopped (a notification woke the agent; Claude Code then
    // stops nothing): none of them is taken for unstoppable, and a move waits for that turn (D2).
    if (result === false && rt.turnActive) return;
    const failed = new Set(result === true ? [] : result === false ? running : result.failed.filter((id) => running.includes(id)));
    for (const id of await Promise.all(confirmations)) if (id) failed.add(id);
    const done = new Set(running.filter((id) => !failed.has(id)));
    if (done.size) {
      rt.stopAtLimit((i) => done.has(i.id), limit);
      this.markLimitStops(rt, [...done], limit);
      if (automatic) this.recordStoppedAgents(rt, done, 'limit');
    }
    if (!failed.size) return;
    this.log('background work at a limit: its stop was not confirmed for', failed.size);
    this.unstoppable.set(rt.id, new Set([...(this.unstoppable.get(rt.id) ?? []), ...failed]));
    const n = failed.size;
    const note = rt.notice('info', `${n === 1 ? 'A sub-agent' : `${n} sub-agents`} could not be stopped`, `${n === 1 ? 'It' : 'They'} may still be working on ${this.accountLabel(rt.meta.provider, rt.meta.accountId ?? DEFAULT_ACCOUNT)}.`);
    this.unstoppableNotes.set(rt.id, [...(this.unstoppableNotes.get(rt.id) ?? []), { notice: note.id, steps: [...failed] }]);
  }

  /** Per chat, background steps whose stop at a limit was not confirmed: a move goes ahead beside them. */
  private unstoppable = new Map<string, Set<string>>();
  /** Per chat, the lines that said such steps may still be working, with the steps each names. */
  private unstoppableNotes = new Map<string, { notice: string; steps: string[] }[]>();

  private recordStoppedAgents(rt: SessionRuntime, ids: Iterable<string>, cause: 'limit' | 'move') {
    const names: string[] = [];
    for (const id of ids) {
      const item = rt.get<ToolItem>(id);
      if (item && !item.delegateReport && (item.result?.agent?.background === 'stopped' || item.workflow?.status === 'stopped')) names.push(backgroundAgentName(item));
    }
    if (names.length) rt.reportLoss(cause, names);
  }

  /**
   * Sub-agents a limit could not stop that the move's close ended after all (their process went with
   * it, moves-M2): at the limit they read as stopped by it and are named to the agent with the
   * carry-on, and a line that said they may still be working says what became of them.
   */
  private markLimitStops(rt: SessionRuntime, ended: string[], limit: { window?: string; resetsAt?: number } | undefined) {
    if (!ended.length) return;
    if (limit) {
      for (const id of ended) {
        const i = rt.get<ToolItem>(id);
        if (!i || i.result?.agent?.limit) continue;
        const agent = { ...i.result?.agent, limit: { window: limit.window ?? 'Plan limit', ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}) } };
        rt.patch<ToolItem>(id, { result: { ...i.result, agent } });
      }
    }
  }

  private endedByMove(rt: SessionRuntime, ended: string[], label: string) {
    if (!ended.length) return;
    const gone = new Set(ended);
    const left = this.unstoppable.get(rt.id);
    if (left) for (const id of ended) left.delete(id);
    const notes = this.unstoppableNotes.get(rt.id) ?? [];
    const keep = notes.filter((n) => {
      if (!n.steps.every((id) => gone.has(id) || !worksInBackground(rt.get(id)))) return true;
      const note = rt.get<NoticeItem>(n.notice);
      if (note) rt.patch<NoticeItem>(n.notice, { detail: `${n.steps.length === 1 ? 'It' : 'They'} stopped when the chat moved to ${label}.` });
      return false;
    });
    if (keep.length) this.unstoppableNotes.set(rt.id, keep);
    else this.unstoppableNotes.delete(rt.id);
  }

  // ── back to the account a limit moved the chat from (limit-policy.ts has the rule) ──

  /** Per chat, the timer that looks again when the account it left resets (or tries a reading again). */
  private returnTimers = new Map<string, NodeJS.Timeout>();
  /** Per chat, inconclusive readings in a row: each next try waits longer (`returnRetryMs`). */
  private returnTries = new Map<string, number>();
  /** Per chat, when a reading last found the account it left still held or could not tell (read again after `RETURN_RECHECK_MS`). */
  private returnChecked = new Map<string, number>();
  /** Returns made, as `${chat}:${account}:${returnAt}`: at most one per reset. */
  private returned = new Set<string>();
  /** Per chat, the return being looked at or made now: a send waits for it (bounded, `deliver`). */
  private returnRuns = new Map<string, Promise<void>>();
  /** Per chat, sends between their start and their dispatch: no return begins meanwhile. */
  private sending = new Map<string, number>();
  /** Chats whose send waits for the return in flight: that return may go on. */
  private sendWaits = new Set<string>();
  /** Per chat, limit transitions running now (a stop of background work, the move after it): sends queue behind them. */
  private sendHolds = new Map<string, Set<Promise<unknown>>>();
  /** Chats with messages queued behind a hold: the queue goes on once every hold is over. */
  private heldSends = new Set<string>();
  /** The sender's guard of a message refused at a limit, kept until it is really dispatched (review wave 17, #3). */
  private refusedGuards = new WeakMap<UserItem, CallContext>();

  private refusedGuard(rt: SessionRuntime, item: UserItem) {
    return this.senderGuard(item.phoneSender, rt.id) ?? this.refusedGuards.get(item);
  }

  /** Sends to the chat queue behind `p` until it settles (with any other hold). */
  private holdSends<T>(rt: SessionRuntime, p: Promise<T>): Promise<T> {
    let set = this.sendHolds.get(rt.id);
    if (!set) this.sendHolds.set(rt.id, (set = new Set()));
    set.add(p);
    const release = () => {
      set!.delete(p);
      if (set!.size || this.sendHolds.get(rt.id) !== set) return;
      this.sendHolds.delete(rt.id);
      this.scheduleLossWake(rt);
      // Drained once, with each message's own guard, on the account the chat is on now.
      if (this.heldSends.delete(rt.id))
        setTimeout(() => {
          this.sendNextQueued(rt);
        }, 0);
    };
    p.then(release, release);
    return p;
  }

  private deferSend(rt: SessionRuntime, text: string, attachments?: UserItem['attachments'], ctx?: CallContext, extra?: DeliveryFields) {
    const { id: reservedId, submitId, until } = extra ?? {};
    if (submitId) this.enqueueSubmission = { rt, id: submitId };
    let id: string;
    try { id = reservedId ?? rt.enqueue(text, attachments, ctx?.phoneSender, until).id; }
    finally { this.enqueueSubmission = undefined; }
    if (!reservedId && !ctx?.phoneSender && ctx?.allowed) rt.transientQueueGuards.set(id, ctx.allowed);
    return 'queued' as const;
  }

  private queueBehindHold(rt: SessionRuntime, text: string, attachments?: UserItem['attachments'], ctx?: CallContext, extra?: DeliveryFields) {
    this.heldSends.add(rt.id);
    return this.deferSend(rt, text, attachments, ctx, extra);
  }

  /** The refused message's sender may still act (a phone not removed meanwhile); said once when not. */
  private refusedAllowed(rt: SessionRuntime, item: UserItem): boolean {
    const guard = this.refusedGuard(rt, item);
    if (!guard?.allowed || guard.allowed()) return true;
    rt.notice('info', guard.refusal?.() ?? 'A message from a removed phone was not sent');
    return false;
  }

  /** `inMs`: one more try after an inconclusive reading; otherwise at `returnAt`. */
  private armReturn(rt: SessionRuntime, inMs?: number) {
    clearTimeout(this.returnTimers.get(rt.id));
    this.returnTimers.delete(rt.id);
    const at = inMs !== undefined ? Date.now() + inMs : rt.meta.returnAt;
    if (!rt.meta.movedFrom || !at || this.disposed || this.sessions.get(rt.id) !== rt) return;
    // Chats that left one account are due at the same reset: one after another, never a burst of readings and moves.
    const turn = inMs !== undefined ? 0 : this.returnTurn(rt) * this.returnGapMs;
    // Long waits are armed again in steps (a laptop may sleep through one).
    const timer = setTimeout(
      () => {
        this.returnTimers.delete(rt.id);
        void this.returnAfterLimit(rt, { retry: inMs !== undefined }).catch((err) => this.log('return after a limit failed', (err as Error).message));
      },
      Math.min(Math.max(0, at - Date.now()) + (inMs !== undefined ? 0 : 1000) + turn, 6 * 3600_000),
    );
    timer.unref?.();
    this.returnTimers.set(rt.id, timer);
  }

  /** This chat's place among the chats that owe the same return (the same account, due at the same moment), from 0. */
  private returnTurn(rt: SessionRuntime): number {
    const same = [...this.sessions.values()]
      .filter((o) => o.meta.provider === rt.meta.provider && !!o.meta.movedFrom && o.meta.movedFrom === rt.meta.movedFrom && o.meta.returnAt === rt.meta.returnAt)
      .map((o) => o.id)
      .sort();
    return Math.max(0, same.indexOf(rt.id));
  }

  /** A chat closed or let go: its limit decision and its return wait for nothing any more (review wave 16, #10). */
  private dropLimitTimers(rt: SessionRuntime) {
    this.refusalQueues.delete(rt);
    const bg = this.bgLimits.get(rt.id);
    if (bg) clearTimeout(bg.timer);
    this.bgLimits.delete(rt.id);
    clearTimeout(this.returnTimers.get(rt.id));
    this.returnTimers.delete(rt.id);
    clearTimeout(this.workTimers.get(rt.id));
    this.workTimers.delete(rt.id);
    this.scheduleLossWake(rt);
  }

  private workOf(rt: SessionRuntime, waitable = false) { return workOf(rt, waitable); }

  /**
   * The agent says it runs a turn where Sable runs none: most often its word of the end is a moment
   * behind the turn's result (a compaction just ended). Given that moment (bounded) before a move
   * reads it as work; a turn that really runs is still there after it.
   */
  private async settleLiveTurn(rt: SessionRuntime) {
    const end = Date.now() + LIVE_TURN_SETTLE_MS;
    while (!rt.turnActive && this.workOf(rt).turn && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  }

  /** Whether the agent of `handle` says it runs a turn now (one Sable knows or not); an agent that cannot say is taken at its word for none. */
  private agentWorks(handle: ProviderSession): boolean {
    try {
      return !!handle.liveWork?.().turn;
    } catch {
      return false;
    }
  }

  /** Whether the chat's work holds a move Sable decides by itself and can postpone (a return, a cap or credits move). */
  private holdsMove(w: ChatWork): boolean {
    return w.turn || w.agents > 0 || w.holds !== undefined;
  }

  /** Per chat, the timer that looks at the moves that wait again once what held them ages out of it (`recheckWhenFree`). */
  private workTimers = new Map<string, NodeJS.Timeout>();

  /**
   * A move that can wait was held. A turn's end or the last background work's end looks again by
   * itself (`afterTurn`, `restMoves`); what holds it only by its age (a young command still running,
   * a wake-up due) is looked at again once it no longer does, and a turn only the agent knows of
   * shortly.
   */
  private recheckWhenFree(rt: SessionRuntime) {
    if (this.disposed || this.sessions.get(rt.id) !== rt) return;
    const w = this.workOf(rt, true);
    // The agent says it works where Sable runs no turn (its word of the end is on its way, or a turn of
    // its own is about to begin, which then ends by itself): looked at again shortly.
    const at = w.turn ? (rt.turnActive ? undefined : Date.now() + LIVE_TURN_RECHECK_MS) : w.agents > 0 ? undefined : w.holds;
    if (at === undefined) return;
    clearTimeout(this.workTimers.get(rt.id));
    const timer = setTimeout(
      () => {
        this.workTimers.delete(rt.id);
        this.restMoves(rt);
      },
      Math.min(Math.max(0, at - Date.now()) + (w.turn ? 0 : 1000), 6 * 3600_000),
    );
    timer.unref?.();
    this.workTimers.set(rt.id, timer);
  }

  /** At rest (the last background work ended, or what held a move aged out of it): the moves that waited are looked at again. */
  private restMoves(rt: SessionRuntime) {
    if (this.disposed || this.sessions.get(rt.id) !== rt || this.limitPending(rt)) return;
    const account = rt.meta.accountId;
    void this.checkCap(rt)
      .then(() => { if (rt.meta.accountId === account) return this.returnAfterLimit(rt); })
      .then(() => { if (rt.meta.accountId === account && this.atRest(rt)) return this.onCredits(rt); })
      .catch((err) => this.log('move at rest failed', (err as Error).message));
  }

  /** The chat is at rest and no transition or send of it runs: nothing visible is in the way of a move. */
  private atRest(rt: SessionRuntime): boolean {
    return (
      this.sessions.get(rt.id) === rt &&
      // No turn, no sub-agent, no young command or wake-up due (an older command does not hold it).
      !this.holdsMove(this.workOf(rt, true)) &&
      !this.moving.has(rt.id) &&
      !this.switching.has(rt.id) &&
      !this.opening.has(rt.id) &&
      !this.delivering.has(rt.id) &&
      !this.dispatching.has(rt.id) &&
      !this.compacting.has(rt.id) &&
      (!(this.sending.get(rt.id) ?? 0) || this.sendWaits.has(rt.id)) &&
      // Closed or stopped by the person: nothing moves it until they send again.
      (!rt.stopRequested || this.sendWaits.has(rt.id)) &&
      !rt.meta.spare
    );
  }

  /**
   * A chat a limit moved away (`movedFrom`) goes back to that account once it takes work again for
   * the chat's model: looked at at rest (a turn's end with nothing queued, the last background work's
   * end, the reset's timer) and right before the person's next message goes out, which waits for it.
   * One run per chat at a time; at most one return per reset; one switch line and the context rule of
   * every move (`switchAccount`). Only a fresh reading that shows room counts (limit-policy.ts).
   */
  returnAfterLimit(rt: SessionRuntime, opts: { retry?: boolean } = {}): Promise<void> {
    const running = this.returnRuns.get(rt.id);
    if (running) return running;
    const run: Promise<void> = this.tryReturn(rt, opts).finally(() => {
      if (this.returnRuns.get(rt.id) === run) this.returnRuns.delete(rt.id);
      this.scheduleLossWake(rt);
    });
    this.returnRuns.set(rt.id, run);
    return run;
  }

  private async tryReturn(rt: SessionRuntime, opts: { retry?: boolean }): Promise<void> {
    const from = rt.meta.movedFrom;
    if (!from || this.disposed || this.updates?.installing) return;
    const provider = rt.meta.provider;
    const current = rt.meta.accountId ?? DEFAULT_ACCOUNT;
    const forget = () => {
      rt.update({ movedFrom: undefined, returnAt: undefined, returnModels: undefined });
      this.returnTries.delete(rt.id);
      this.armReturn(rt);
    };
    // Back on it already, or the account is gone: nothing is owed any more.
    if (from === current || !this.findAccount(provider, from)) return forget();
    // Held by work in the process the move would close: the end of that work looks again.
    if (!this.atRest(rt)) return this.recheckWhenFree(rt);
    const at = rt.meta.returnAt;
    if (at && Date.now() < at) return this.armReturn(rt);
    const key = `${rt.id}:${from}:${at ?? ''}`;
    const checked = this.returnChecked.get(rt.id);
    if (this.returned.has(key) || (!opts.retry && checked && Date.now() - checked < RETURN_RECHECK_MS)) return;
    const closes = this.closesOf(rt);
    // Still the same chat, open, owing this return, on the account it went to.
    const still = () => !this.disposed && !this.updates?.installing && this.sessions.get(rt.id) === rt && this.closesOf(rt) === closes && rt.meta.movedFrom === from && (rt.meta.accountId ?? DEFAULT_ACCOUNT) === current;
    // A reading that could not tell (failed, not fresh, no room shown): one more try, later each time.
    const inconclusive = () => {
      this.returnChecked.set(rt.id, Date.now());
      const tries = this.returnTries.get(rt.id) ?? 0;
      this.returnTries.set(rt.id, tries + 1);
      this.armReturn(rt, returnRetryMs(tries));
    };
    let reading: { limits: RateLimit[]; fresh: boolean };
    const account = accountKey(provider, from);
    const early = this.earlyResetRead.get(account);
    try {
      if (early && at === early.at) {
        // Work could have held the chat past this reading. Confirm again even if the account is dormant.
        reading = Date.now() - early.at < 60_000 && early.seq === this.limitsSeq.get(account)
          ? { limits: early.limits, fresh: true } : await this.readLimits(provider, from, true);
      } else reading = await this.readLimits(provider, from, 'fresh', { requested: false });
    } catch {
      if (still()) inconclusive();
      return;
    }
    if (!still()) return;
    const model = this.chatModel(rt);
    const now = Date.now();
    const cap = this.capOf(provider, from);
    // A partial answer can prove room only for the windows it named. Other known holds still count.
    const limits = this.limitsPartial.has(account) ? mergeWindows(this.limitsCache.get(account) ?? [], reading.limits) : reading.limits;
    const rank = rankAccount({ id: from, signedIn: true, limits, cap }, now, model);
    const refused = rt.meta.returnModels ?? [];
    const full = [model, ...refused].some(m => atCap(limits, now, m) || capReached(limits, cap, m, now)) || rank.state === 'held' || rank.state === 'spent';
    if (reading.fresh && full) {
      // Still held, as a fresh reading says: looked at again when the window that holds it resets.
      this.returnChecked.set(rt.id, now);
      this.returnTries.delete(rt.id);
      const held = limits.filter(l => l.percent >= 100 && l.resetsAt && l.resetsAt > now && [model, ...refused].some(m => windowForModel(l, m)));
      const until = Math.max(rank.until ?? 0, rank.state === 'spent' ? rank.expiresAt ?? 0 : 0, ...held.map(l => l.resetsAt!));
      if (until && until > now) {
        rt.update({ returnAt: until });
        this.armReturn(rt);
      } else this.armReturn(rt, returnRetryMs(0));
      return;
    }
    // Never on a guess: only a fresh reading that shows room for the chat's model.
    if (!readingShowsRoom({ fresh: reading.fresh, limits: reading.limits, model, now, full })) return inconclusive();
    if (refused.some(m => !reading.limits.some(l => windowModel(l) && windowForModel(l, m) && l.percent < 100 && (!l.resetsAt || l.resetsAt > now)))) return inconclusive();
    this.returnTries.delete(rt.id);
    const to = returnTarget({ from, current, fromTakesWork: true });
    // A chat not read since the start (the timer after a restart): read beside the app, never in its way.
    if (to) await this.hydrateAsync(rt).catch(() => {});
    // A chat that could not be read (its file locked or broken, or the read failed) is not moved: a
    // move may have to start the conversation over from the timeline, and there is none. The return
    // stays owed and is looked at again at the next start or the person's next message.
    if (to && (this.lazy.has(rt.id) || this.unreadable.has(rt.id))) return;
    // Only at rest, looked at again after the wait (never mid-turn, never beside another transition).
    if (!to || !still()) return;
    if (!this.atRest(rt)) return this.recheckWhenFree(rt);
    this.returned.add(key);
    try {
      // Sable's own move, which can wait for work in the background (`waits`), and never compacts by
      // itself (moves-M1): the person did not ask for it, and every bounce would cost working detail.
      await this.switchAccount(rt, to, { line: `Back on ${this.accountLabel(provider, to)}`, compact: false, waits: true });
    } catch (err) {
      // Not moved: the chat still owes its return, tried again later (by the work's end when it was busy).
      this.returned.delete(key);
      if (err instanceof NotNow) return this.recheckWhenFree(rt);
      if (still()) {
        inconclusive();
        this.autoMoveFailed(rt, err, `Could not return to ${this.accountLabel(provider, to)}`);
      }
      return;
    }
    if ((rt.meta.accountId ?? DEFAULT_ACCOUNT) === to) forget();
  }

  /**
   * A turn ended while the agent carried the account past its limit on credits or extra usage.
   * Allowed for this account: it carries on (the limit area says so). Otherwise the next account
   * takes over when that setting is on, or the session says once what is happening.
   */
  private async onCredits(rt: SessionRuntime) {
    const provider = rt.meta.provider;
    const accountId = rt.meta.accountId ?? DEFAULT_ACCOUNT;
    const key = accountKey(provider, accountId);
    const meta = this.limitsMeta.get(key);
    if (!runningOnCredits(meta)) return;
    // Providers can retain their last credits flag across a reset. A complete reading with room takes precedence.
    const stillBilled = () => {
      const rows = this.limitsCache.get(key);
      return runningOnCredits(this.limitsMeta.get(key)) && (!rows?.length || this.limitsPartial.has(key) || atCap(rows, Date.now(), this.chatModel(rt)));
    };
    if (!stillBilled()) return;
    const next = this.store.state.settings.continueAtLimit ? await this.nextAccount(provider, accountId, { rt }).catch(() => undefined) : undefined;
    if (this.sessions.get(rt.id) !== rt || rt.meta.provider !== provider || (rt.meta.accountId ?? DEFAULT_ACCOUNT) !== accountId || !stillBilled()) return;
    const settings = this.store.state.settings;
    const decision = decideAtLimit({ creditsAllowed: !!settings.creditsAtLimit?.[creditsKey(provider, accountId)], creditsAvailable: true, continueAtLimit: !!settings.continueAtLimit, next });
    if (decision === 'credits' || rt.turnActive) return;
    const until = meta?.extra?.resetsAt ?? meta?.credits?.resetsAt;
    if (decision === 'next' && next) {
      // Sable's own move, which can wait for work in the background: the next turn's end looks again
      // (the turn that work's end wakes, or the person's next).
      if (this.holdsMove(this.workOf(rt, true))) return this.recheckWhenFree(rt);
      try {
        // Past its limit: a compaction there would be paid for with credits. What the move leaves
        // behind only once it happened (D5).
        await this.switchAccount(rt, next, { automatic: true, compact: false, waits: true, limitReturn: { at: until } });
      } catch (err) {
        this.autoMoveFailed(rt, err, `Could not move to ${this.accountLabel(provider, next)}`);
      }
      return;
    }
    const warningKey = `${rt.id}:${accountId}:${until ?? ''}`;
    if (this.creditsWarned.has(warningKey)) return;
    this.creditsWarned.add(warningKey);
    rt.notice('info', meta?.extra?.inUse ? 'Running on extra usage' : 'Running on credits', 'This account is past its limit. Its setting with the provider decides whether credits are spent.');
  }

  /**
   * Before a message goes out (review wave 16, #7): the account is past a full window and the agent
   * runs it on credits or extra usage, which `AppSettings.creditsAtLimit` does not allow for it. The
   * message is then never sent there (the caller treats it as refused at the limit). Only while a
   * window that holds the chat's model is still full: a credits flag left from before a reset holds nothing.
   */
  private async heldForCredits(rt: SessionRuntime): Promise<boolean> {
    const provider = rt.meta.provider;
    const accountId = rt.meta.accountId ?? DEFAULT_ACCOUNT;
    const meta = this.limitsMeta.get(accountKey(provider, accountId));
    if (!runningOnCredits(meta) || this.store.state.settings.creditsAtLimit?.[creditsKey(provider, accountId)]) return false;
    return !!this.creditsWindow(rt).window;
  }

  /** The full window that holds the chat's model on its account, with the latest reset among them. */
  private creditsWindow(rt: SessionRuntime): { window?: string; resetsAt?: number } {
    const model = this.chatModel(rt);
    const now = Date.now();
    const full = (this.limitsCache.get(accountKey(rt.meta.provider, rt.meta.accountId ?? DEFAULT_ACCOUNT)) ?? []).filter(
      (l) => l.percent >= 100 && l.resetsAt && l.resetsAt > now && windowForModel(l, model),
    );
    if (!full.length) return {};
    const last = full.reduce((a, b) => (b.resetsAt! > a.resetsAt! ? b : a));
    return { window: last.label, resetsAt: last.resetsAt };
  }

  /**
   * What goes out after a move to another account at a limit. Refused before any work: the
   * message again. Cut off mid-turn: the new account carries on where the old one stopped instead
   * of starting the task over (the conversation came along, or the summary shows what was done),
   * and nothing new appears in the conversation.
   */
  private resumeMessage(rt: SessionRuntime, refused: UserItem, carried: 'conversation' | 'summary' | 'none' | 'reset', card: NoticeItem, ended: readonly string[] = []): UserItem {
    const from = rt.items.findIndex((i) => i.id === refused.id);
    const progressed = from >= 0 && rt.items.slice(from + 1, rt.items.indexOf(card)).some((i) => (i.type === 'text' && i.text.trim()) || i.type === 'tool');
    // The limit met the chat's background work (its own turn had ended): nothing of the person's to send again.
    const background = card.limit?.origin === 'background';
    if (!progressed && !background) return refused;
    const text =
      carried === 'reset'
        ? RESUME_AFTER_RESET
        : carried === 'conversation' || background
          ? RESUME_UNDER_ANOTHER
          : `${refused.text}${RESUME_SUMMARY_TRAILER}`;
    // Background agents the same limit stopped (`ended`: those the move's close ended after all):
    // named, so the agent can start again what is still needed.
    const lost = new Set(rt.pendingLost().names);
    const stopped = resumeBackgroundNote(limitStoppedAgents(rt.items, new Set([...rt.takeLimitStopped(), ...ended])).filter(name => !lost.has(name)));
    return { id: randomUUID(), ts: Date.now(), type: 'user', text: `${text}${stopped}`, state: 'sent' };
  }

  // ── Spare: chats that start by themselves (server/core/spare.ts) ──

  /** Each account of `provider` as the Spare planner sees it: the limits book's windows and pace, caps, plan weight, credits. */
  private async spareAccounts(provider: ProviderId): Promise<SpareAccount[]> {
    // The last known sign-ins (asking the CLI each time would start processes on every limits event).
    const cached = this.cache.get<ProviderInfo>(`info:${provider}`);
    const [info, reports] = await Promise.all([
      cached?.accounts?.length ? cached : this.providerInfo(provider),
      this.handlers.has('usage.limits') ? this.call('usage.limits', {}).catch(() => []) : Promise.resolve([]),
    ]);
    return (info.accounts ?? []).map((a) => {
      const key = accountKey(provider, a.id);
      const r = reports.find((x) => x.provider === provider && x.accountId === a.id);
      return {
        id: a.id,
        signedIn: a.auth.loggedIn,
        // An API key now bills per token, whatever a report from before said (review wave 8, #26).
        planLimits: isApiKeyAuth(a.auth) ? false : r?.planLimits,
        limits: this.limitsPartial.has(key) && r?.limits.length ? mergeWindows(r.limits, this.limitsCache.get(key) ?? []) : this.limitsCache.get(key) ?? r?.limits ?? a.limits ?? [],
        pace: r?.pace,
        cap: this.capOf(provider, a.id),
        weight: planWeight(provider, a.auth),
        onCredits: runningOnCredits(this.limitsMeta.get(key)),
      };
    });
  }

  /**
   * Starts a chat that waited. Spare: on the account the planner chose (the session moves there
   * first, with one line), the first thing it holds goes out (a refused spare turn carries on, else
   * its first held message). Reset: the refused turn carries on, on the account that reset. Nothing
   * to start: nothing moves.
   */
  private async startSpare(rt: SessionRuntime, accountId: string, wait: SpareWait) {
    const from = rt.meta.accountId ?? DEFAULT_ACCOUNT;
    if (wait.reason === 'reset') {
      // Moved to another account meanwhile (by hand): the reset is not this chat's any more.
      const card = this.openLimit(rt, wait.refusalId);
      if (from !== accountId || !card || (!wait.refusalId && card.ts > wait.since)) return;
      try {
        await this.resumeRefused(rt, 'reset', card.id, true);
      } catch (err) {
        if (!(err instanceof DeliveryMissed) || rt.meta.spare !== wait || this.disposed) throw err;
        rt.notice('error', 'Could not start the waiting message', err.message);
        rt.update({ spare: { ...wait, at: Date.now() + SPARE_STALE_RETRY_MS } });
      }
      return;
    }
    const id = this.spare.pending(rt)[0];
    if (!id) return;
    const moved = from !== accountId ? await this.switchAccount(rt, accountId, { line: `Started with ${this.accountLabel(rt.meta.provider, accountId)}` }) : undefined;
    await this.sendHeld(rt, id, moved?.carried, true);
  }

  /** A held entry goes out: the refused turn carries on (its id), or a queued message as an ordinary send. */
  private async sendHeld(rt: SessionRuntime, id: string, carried?: 'conversation' | 'summary' | 'none', automatic = false) {
    if (id === this.refusedMessage(rt)?.id) return void (await this.resumeRefused(rt, carried ?? 'reset', undefined, automatic));
    await this.deliverQueued(rt, id);
  }

  /**
   * The turn the open limit notice refused carries on with the session's account (the refused message
   * again, or "carry on" when it got partway). `reset`: on the same account, its window having reset.
   * Nothing is sent when no limit notice is open any more (carried on by hand meanwhile).
   */
  private async resumeRefused(rt: SessionRuntime, carried: 'conversation' | 'summary' | 'none' | 'reset', refusalId?: string, automatic = false) {
    if (this.lazy.has(rt.id)) await this.hydrateAsync(rt);
    const accountId = rt.meta.accountId ?? DEFAULT_ACCOUNT;
    const open = this.openLimit(rt, refusalId);
    if (!open || (automatic && rt.dangerHeld) || rt.turnActive || this.moving.has(rt.id) || this.switching.has(rt.id) || this.dispatching.has(rt.id)) return;
    const release = this.beginDispatch(rt);
    const stops = this.stopsOf(rt), closes = this.closesOf(rt);
    const valid = () => !(automatic && rt.dangerHeld) && !this.disposed && this.sessions.get(rt.id) === rt && this.stopsOf(rt) === stops && this.closesOf(rt) === closes &&
      (rt.meta.accountId ?? DEFAULT_ACCOUNT) === accountId && this.openLimit(rt, refusalId)?.id === open.id;
    try {
      await this.dispatchRefused(rt, carried, open, accountId, valid);
    } finally { release(); }
  }

  private openLimit(rt: SessionRuntime, id?: string) {
    return rt.items.findLast((i): i is NoticeItem => i.type === 'notice' && !!i.limit && !i.limit.continuedWith && !i.parentId && (!id || i.id === id));
  }

  private async dispatchRefused(rt: SessionRuntime, carried: 'conversation' | 'summary' | 'none' | 'reset', open: NoticeItem, accountId: string, valid: () => boolean) {
    const refused = this.refusedMessage(rt, open);
    const item: UserItem = refused
      ? this.resumeMessage(rt, refused, carried, open)
      : { id: randomUUID(), ts: Date.now(), type: 'user', text: RESUME_LIMIT_RESET, state: 'sent' };
    const handle = await this.ensureHandle(rt);
    if (!valid()) return;
    await this.applyDue(rt, handle);
    // Its sender (a phone) removed meanwhile, or credits the setting forbids: nothing goes (review wave 17, #2, #3).
    if (refused && !this.refusedAllowed(rt, refused)) return;
    if (await this.heldForCredits(rt) || !valid() || rt.turnActive || rt.handle !== handle) return;
    // The turn carries on with the refused message: it is the one this turn answers.
    if (refused && item.id === refused.id) this.retryOwners.set(rt, refused.id);
    const unhand = refused ? this.handOver(rt, refused.id) : undefined;
    try {
      const check = () => {
        if (!valid()) throw new NotNow('The chat no longer waits for this reset.');
        if (refused) still(this.refusedGuard(rt, refused));
      };
      if (rt.meta.provider === 'claude') await this.sendFirstInput(rt, handle, item, check, () => {});
      else await this.sendWithHandover(rt, handle, item, check);
      rt.patch<NoticeItem>(open.id, { limit: { ...open.limit, continuedWith: accountId, ...(carried === 'reset' ? { atReset: true } : {}) } });
      this.releaseRefusalQueue(rt, open.id);
    } catch (err) {
      unhand?.();
      if (err instanceof DeliveryMissed || err instanceof DeliveryUncertain || err instanceof NotNow) throw err;
      rt.notice('error', 'Could not send the message', (err as Error).message);
      rt.endTurn((err as Error).message);
    }
  }

  // ── refused for the sign-in (server/core/auth-gate.ts) ──

  /** One ask of the CLI per account after a refusal, and the chats that wait for a sign-in. */
  private signIns = new SignInChecks({
    ask: async (provider, accountId) => {
      const info = await this.accountAuth(provider as ProviderId, accountId, true);
      return info.problem || !info.installed || info.auth.checking ? undefined : info.auth.loggedIn;
    },
    delayMs: () => this.delays.signIn ?? 1500,
  });

  /** Chats waiting for a sign-in: how often they had been stopped and closed when the wait began. */
  private signInWaits = new Map<string, { stops: number; closes: number }>();

  /** What a refusal for the sign-in was, taken when it is noted: the message, its turn's closing line, the chat's agent, account and generations. */
  private refusalMark(rt: SessionRuntime): RefusalMark {
    return {
      refusedId: rt.items.findLast((i) => i.type === 'user' && !i.parentId)?.id,
      endId: rt.items.findLast((i) => i.type === 'turn' && !i.parentId)?.id,
      provider: rt.meta.provider,
      accountId: rt.meta.accountId ?? DEFAULT_ACCOUNT,
      stops: this.stopsOf(rt),
      closes: this.closesOf(rt),
    };
  }

  /** Whether the chat is still as it was when the refusal was noted (and at rest, open, not moving). */
  private sameRefusal(rt: SessionRuntime, m: RefusalMark): boolean {
    if (this.disposed || this.sessions.get(rt.id) !== rt || rt.turnActive || this.moving.has(rt.id) || this.switching.has(rt.id)) return false;
    const now = this.refusalMark(rt);
    return now.refusedId === m.refusedId && now.endId === m.endId && now.provider === m.provider && now.accountId === m.accountId && now.stops === m.stops && now.closes === m.closes;
  }

  /**
   * A turn refused for the sign-in. A moment later the CLI is asked whether the account is signed in
   * (once per account, however many chats were refused): then the message goes once more, silently.
   * When the CLI says signed out, the chat says it once and waits for the account (`resumeSignedIn`).
   */
  private async onSignInRefused(rt: SessionRuntime, refusal: { background: string[]; observed?: boolean }, mark: RefusalMark) {
    const { provider, accountId } = mark;
    if (!refusal.observed) this.journal.record({ agent: provider, accountId }, { event: 'refused' });
    const signedIn = await this.signIns.check(provider, accountId);
    // Anything changed meanwhile (stopped, closed, moved, another agent or account, a message sent or a
    // turn ended since): the person decides what happens next; nothing is retried, nothing is said.
    if (!this.sameRefusal(rt, mark)) return;
    const refused = mark.refusedId ? rt.get<UserItem>(mark.refusedId) : undefined;
    if (signedIn === undefined) return void rt.notice('error', 'Could not confirm the sign-in', 'Try the message again when the account is available.');
    if (signedIn && refused && this.signIns.mayRetry(rt.id, refused.id)) {
      return void (await this.sendAfterSignIn(rt, refused, refusal.background, mark));
    }
    if (signedIn) return void rt.notice('error', 'The sign-in was refused again');
    const known = this.cache.get<ProviderInfo>(`info:${provider}`);
    if (known) {
      const out = { loggedIn: false };
      const info = { ...known, ...(accountId === DEFAULT_ACCOUNT && { auth: out }),
        accounts: known.accounts?.map(a => a.id === accountId ? { ...a, auth: out } : a) };
      this.cache.set(`info:${provider}`, info);
      this.emit({ type: 'provider.updated', provider: info });
    }
    this.signIns.wait(provider, accountId, rt.id, refusal.background);
    // What the chat was when it began to wait: closed or stopped meanwhile, it is not started again.
    this.signInWaits.set(rt.id, { stops: mark.stops, closes: mark.closes });
    // One notice for the chat, however many requests and sub-agents were refused.
    if (rt.items.some((i) => i.type === 'notice' && !!i.auth)) return;
    const label = this.accountList(provider).length > 1 ? this.accountLabel(provider, accountId) : undefined;
    this.journal.record({ agent: provider, accountId }, { event: 'signed-out' });
    const notice = { type: 'notice' as const, variant: 'error' as const, text: `Signed out of ${label ?? this.provider(provider, accountId).name}`, auth: { state: 'signedOut' as const, provider, accountId, ...(label ? { label } : {}) } };
    // Inside the refused turn, before its closing line.
    const end = rt.items.at(-1);
    if (end?.type === 'turn') {
      rt.remove(end.id);
      rt.add<NoticeItem>(notice);
      rt.add({ ...end });
    } else rt.add<NoticeItem>(notice);
  }

  /** The account reads signed in again: the chats that waited on it carry on by themselves, once. */
  private resumeSignedIn(provider: ProviderId, accountId: string) {
    for (const [id, background] of this.signIns.take(provider, accountId)) {
      const rt = this.sessions.get(id);
      const since = this.signInWaits.get(id);
      this.signInWaits.delete(id);
      if (!rt || rt.turnActive || (rt.meta.accountId ?? DEFAULT_ACCOUNT) !== accountId) continue;
      const notice = rt.items.findLast((i): i is NoticeItem => i.type === 'notice' && !!i.auth);
      if (!notice) continue;
      rt.remove(notice.id);
      // The last message refused (the person may have tried again meanwhile); one answered since needs nothing.
      const at = rt.items.findLastIndex((i) => i.type === 'user' && !i.parentId);
      const refused = at >= 0 ? (rt.items[at] as UserItem) : undefined;
      const answered = rt.items.slice(at + 1).some((i) => i.type === 'text' && !i.parentId && !!i.text.trim());
      // The message may be a newer one (the person tried again meanwhile); the stops and closes are those
      // of the moment the chat began to wait, so a chat closed or stopped since stays as the person left it.
      const mark = { ...this.refusalMark(rt), ...since };
      if (refused && !answered) void this.sendAfterSignIn(rt, refused, background, mark).catch((err) => this.log('carrying on after a sign-in failed', (err as Error).message));
    }
  }

  /**
   * The refused turn carries on: the message again when nothing was done yet, otherwise a short
   * carry-on that names the background agents the refusal stopped. The failed turn's closing line
   * goes (the retry is the same turn), and nothing new shows in the conversation.
   */
  private async sendAfterSignIn(rt: SessionRuntime, refused: UserItem, background: string[], mark: RefusalMark) {
    if (this.lazy.has(rt.id)) await this.hydrateAsync(rt);
    if (!this.sameRefusal(rt, mark) || this.limitPending(rt) || this.sendHolds.has(rt.id)) return;
    const handle = await this.ensureHandle(rt);
    await this.applyDue(rt, handle);
    // The agent's process may still hold the refused message (a request of other work was refused,
    // and the message waits behind it): it runs it by itself once its sign-in is renewed, and a second
    // send would make it run twice (C5). So the message goes again only once the agent says it is not
    // working (bounded); a turn that begins meanwhile is the agent taking it, and nothing is sent.
    const end = Date.now() + SIGN_IN_HOLD_MS;
    while (this.agentWorks(handle) && Date.now() < end && this.sameRefusal(rt, mark) && rt.handle === handle) await new Promise((r) => setTimeout(r, 100));
    if (rt.handle !== handle) return;
    // Checked again right before it goes: what was refused is still the chat's last word (#8).
    if (!this.sameRefusal(rt, mark) || mark.refusedId !== refused.id) return;
    if (!this.refusedAllowed(rt, refused)) return;
    if (this.agentWorks(handle)) {
      rt.notice('info', 'Sign-in renewed', 'The agent is still working. If it finishes without answering, send your message again.');
      return;
    }
    const at = rt.items.findIndex((i) => i.id === refused.id);
    const after = at >= 0 ? rt.items.slice(at + 1) : [];
    const progressed = background.length > 0 || after.some((i) => (i.type === 'text' && i.text.trim()) || i.type === 'tool');
    const item: UserItem = progressed ? { id: randomUUID(), ts: Date.now(), type: 'user', text: `${RESUME_AFTER_SIGN_IN}${signInBackgroundNote(background)}`, state: 'sent' } : refused;
    const release = this.beginDispatch(rt);
    const unhand = this.handOver(rt, refused.id);
    try {
      await this.sendWithHandover(rt, handle, item, () => {
        still(this.refusedGuard(rt, refused));
        if (this.stopsOf(rt) !== mark.stops || this.closesOf(rt) !== mark.closes || this.moving.has(rt.id) || this.limitPending(rt)) throw new NotNow('The sign-in retry was interrupted.');
      });
      this.journal.record({ agent: mark.provider, accountId: mark.accountId }, { event: 'retry' });
      if (mark.endId && after.some(i => i.id === mark.endId && i.type === 'turn' && !i.parentId)) rt.remove(mark.endId);
    } catch (err) {
      unhand();
      if (err instanceof NotNow) return;
      rt.notice('error', 'Could not send the message', (err as Error).message);
      rt.endTurn((err as Error).message);
    } finally { release(); }
  }

  /**
   * A turn Spare started met a plan limit: it waits again on the same account's reset (a reset turn)
   * or for spare (a spare turn), never going on with another account by itself.
   */
  private spareLimitHit(rt: SessionRuntime, ran: SpareRun, notice: NoticeItem) {
    const accountId = rt.meta.accountId ?? DEFAULT_ACCOUNT;
    const now = Date.now();
    const full = (this.limitsCache.get(accountKey(rt.meta.provider, accountId)) ?? []).filter((l) => l.percent >= 100 && l.resetsAt && l.resetsAt > now);
    const at = notice.limit?.resetsAt ?? (full.length ? Math.max(...full.map((l) => l.resetsAt!)) : undefined);
    this.spare.limitHit(rt, ran, { accountId, at });
    if (rt.meta.spare?.reason === 'reset') rt.update({ spare: { ...rt.meta.spare, refusalId: notice.id } });
  }

  /** The original request on a new card, or the last user inside a legacy card's own turn. */
  private refusedMessage(rt: SessionRuntime, card = this.openLimit(rt)): UserItem | undefined {
    if (!card || card.limit?.origin === 'background') return;
    if (card.limit?.userItemId) {
      const user = rt.get<UserItem>(card.limit.userItemId);
      return user?.type === 'user' ? user : undefined;
    }
    const at = rt.items.findIndex(i => i.id === card.id);
    for (let i = at - 1; i >= 0; i--) {
      const it = rt.items[i];
      if (!it.parentId && (it.type === 'turn' || (it.type === 'notice' && (it.early || it.variant === 'interrupted')))) return;
      if (it.type === 'user' && !it.parentId && it.state !== 'queued') return it;
    }
    return undefined;
  }

  /**
   * Moves an idle session to another account of its agent. The conversation is carried into that
   * account's folder so the same conversation resumes there; when that is not possible, a new one
   * starts and the next message carries a summary of this one.
   *
   * A big chat (`bigContext`) whose account can still run a turn compacts there first, where its
   * cache is warm, and the compacted conversation is carried (`compact: false`: never, as at a limit,
   * where that account cannot). `onCompacting`: called as the compaction starts. The switch line
   * says what the move did to the context; the first message after it carries a short note.
   */
  async switchAccount(
    rt: SessionRuntime,
    accountId: string,
    opts: MoveOptions = {},
    ctx?: CallContext,
  ): Promise<RpcMethods['session.switchAccount']['result']> {
    const stops = this.stopsOf(rt);
    const closes = this.closesOf(rt);
    this.moveAttempts.set(rt, (this.moveAttempts.get(rt) ?? 0) + 1);
    try {
      return await this.switchIdleAccount(rt, accountId, opts, ctx, stops, closes);
    } catch (err) {
      // Even a refusal before the destination was reserved confirms the source for every window.
      if (this.sessions.get(rt.id) === rt) this.emit({ type: 'session.updated', id: rt.id, patch: { accountId: rt.meta.accountId ?? DEFAULT_ACCOUNT, movedFrom: rt.meta.movedFrom, returnAt: rt.meta.returnAt } });
      throw err;
    } finally {
      const remaining = this.moveAttempts.get(rt)! - 1;
      if (remaining) this.moveAttempts.set(rt, remaining);
      else this.moveAttempts.delete(rt);
      this.scheduleLossWake(rt);
    }
  }

  private async switchIdleAccount(rt: SessionRuntime, accountId: string, opts: MoveOptions, ctx: CallContext | undefined, stops: number, closes: number): Promise<RpcMethods['session.switchAccount']['result']> {
    if (this.lazy.has(rt.id)) await this.hydrateAsync(rt);
    const live = () => {
      if (this.disposed || this.sessions.get(rt.id) !== rt || this.closesOf(rt) !== closes) throw new NotNow('The chat was closed during the move.');
      still(ctx);
    };
    const requested = opts.retry ? this.openLimit(rt, opts.refusalId)?.id : undefined;
    if (opts.refusalId && requested !== opts.refusalId) throw new NotNow('The refusal was already handled.');
    const selected = requested && this.openLimit(rt, requested);
    const current = rt.meta.accountId ?? DEFAULT_ACCOUNT;
    if (!opts.automatic && selected && opts.refusalId && selected.limit && current !== accountId) {
      const rows = this.limitsCache.get(accountKey(rt.meta.provider, selected.limit.accountId ?? current));
      const models = { rt, ...this.refusalModels(selected, rows) };
      const others = this.accountList(rt.meta.provider).filter(a => a.id !== accountId).map(a => a.id);
      if (!await this.nextAccount(rt.meta.provider, current, { ...models, except: others })) {
        const next = await this.nextAccount(rt.meta.provider, current, models);
        live();
        const card = this.openLimit(rt, requested);
        if (card?.limit?.next === accountId) rt.patch<NoticeItem>(card.id, { limit: { ...card.limit, next } });
        throw new NotNow('That account no longer has room for this continuation.');
      }
      live();
      if (current !== (rt.meta.accountId ?? DEFAULT_ACCOUNT) || this.stopsOf(rt) !== stops) throw new NotNow('The chat changed while checking the account.');
    }
    if (rt.meta.lane) await this.lanes.ready(rt);
    // One transition at a time, never under work (review wave 8, #10; D-moves).
    await this.settleLiveTurn(rt);
    live();
    this.refuseBusy(rt, opts.waits);
    // A message already on its way to the agent goes first (D6): the move never closes the process it
    // is being handed to. Then everything is looked at again (it has usually begun a turn).
    if (this.dispatching.has(rt.id)) {
      await this.untilDispatched(rt);
      live();
      this.refuseBusy(rt, opts.waits, true);
    }
    // At a limit (the notice's move, by itself or by the click): what still runs works on the account
    // at its limit and is refused with its next request, so it stops at the limit and the chat moves.
    const atLimit = opts.retry ? this.openLimit(rt, opts.refusalId) : undefined;
    if (opts.retry && requested !== atLimit?.id) throw new NotNow('The refusal was already handled.');
    const target = this.provider(rt.meta.provider, accountId);
    const to = accountKey(rt.meta.provider, accountId);
    if (this.removingAccounts.has(to)) throw new Error('This account is being removed. Pick another account for this agent.');
    const from = accountKey(rt.meta.provider, rt.meta.accountId ?? DEFAULT_ACCOUNT);
    if (this.removingAccounts.has(from)) throw new Error('The current account is being removed. Wait for its removal before moving the chat.');
    // Keep the destination available for startup and the source available for rollback.
    const heldAccounts = new Set([from, to]);
    for (const key of heldAccounts) this.movingTo.set(key, (this.movingTo.get(key) ?? 0) + 1);
    let moving = false;
    const attempt: MoveAttempt = { stops, live, compacted: false, remote: false, sourceClosed: false, lostSteps: [] };
    try {
      if (atLimit?.limit && rt.items.some((i) => worksInBackground(i) && !this.unstoppable.get(rt.id)?.has(i.id)) && (rt.meta.accountId ?? DEFAULT_ACCOUNT) !== accountId && !this.moving.has(rt.id)) {
        await this.stopLiveBackground(rt, atLimit.limit, !!opts.automatic);
        live();
        // A turn began while they were stopped (a notification woke the agent): the move waits for
        // that turn's end, which is refused at the limit too and decides again (D2).
        if (this.workOf(rt).turn) throw new NotNow('The agent is still working. Stop it first.');
      }
      // Work a limit's stop could not end does not hold the move (it stays on the account it ran on).
      const left = this.unstoppable.get(rt.id);
      if (rt.items.some((i) => worksInBackground(i) && !left?.has(i.id))) throw new NotNow('Background work is still running in this chat. Move when it is done.');
      if ((rt.meta.accountId ?? DEFAULT_ACCOUNT) === accountId) {
        if (atLimit) await this.resumeRefused(rt, 'conversation', atLimit.id);
        return { ok: true, carried: 'none' };
      }
      // Anything that began while the background work was stopped (another move, a message): one at a time.
      this.refuseBusy(rt, opts.waits, true);
      if (opts.retry && requested !== this.openLimit(rt, opts.refusalId)?.id) throw new NotNow('The refusal was already handled.');
      this.moving.add(rt.id);
      // The header's account menu shows the move for as long as it runs (D8).
      rt.update({ moving: true });
      moving = true;
      const run = this.moveAccount(rt, accountId, target, opts, attempt);
      this.accountMoves.set(rt.id, run);
      return await run;
    } catch (err) {
      if (moving && this.sessions.get(rt.id) === rt) {
        for (const id of attempt.lostSteps) {
          const task = rt.get<ToolItem>(id)?.task;
          if (task?.state === 'lost' && task.why === 'move') rt.patch<ToolItem>(id, { task: { ...task, why: 'process' } });
        }
        if (attempt.lostSteps.length) rt.notice('info', lostLine(attempt.lostSteps.length, 'process'));
        if (attempt.sourceClosed && !rt.handle && !this.disposed && this.stopsOf(rt) === stops && !(opts.waits && this.limitPending(rt))) {
          // The source transcript is intact. Restore a live chat without replaying any request there.
          try {
            const handle = await this.ensureHandle(rt, true);
            if (attempt.remote && rt.meta.options?.remoteControl) await handle.setOptions?.(rt.meta.options);
          } catch (reopen) {
            throw new Error(`${(err as Error).message} The original account could not reopen: ${(reopen as Error).message}`);
          }
        }
      }
      throw err;
    } finally {
      for (const key of heldAccounts) {
        const holds = (this.movingTo.get(key) ?? 1) - 1;
        if (holds > 0) this.movingTo.set(key, holds);
        else this.movingTo.delete(key);
      }
      if (moving) {
        this.accountMoves.delete(rt.id);
        this.moved(rt, stops, attempt.compacted);
        if (attempt.remote && (rt.meta.accountId ?? DEFAULT_ACCOUNT) === accountId) this.reopenRemote(rt, { stops, closes, accountId });
      }
    }
  }

  /**
   * Refuses a move for now (`NotNow`) while the chat is busy (D-moves): a turn runs (one the agent
   * began by itself too), another move or a switch of agent runs, its agent is still starting (its
   * handle would come up on the account it leaves), and (`sent`, once a wait for it is over) a message
   * is on its way to the agent. A move Sable decides by itself and that can wait (`waits`) is also
   * held while sub-agents work or a young background command runs; one the person asks for, or one at
   * a limit, goes ahead beside commands, which are lost with the process (the switch line names them).
   */
  private refuseBusy(rt: SessionRuntime, waits = false, sent = false) {
    const w = this.workOf(rt, waits);
    if (w.turn) throw new NotNow('The agent is still working. Stop it first.');
    if (this.moving.has(rt.id)) throw new NotNow('This chat is moving to another account already.');
    if (this.opening.has(rt.id) || this.delivering.has(rt.id)) throw new NotNow('The agent is still starting. Move when it is ready.');
    if (this.switching.has(rt.id)) throw new NotNow('This chat is switching agent. Move when it is done.');
    if (sent && this.dispatching.has(rt.id)) throw new NotNow('A message is on its way to the agent. Move once it is sent.');
    if (waits) this.checkWaitable(rt, w);
  }

  private checkWaitable(rt: SessionRuntime, w: ChatWork) {
    if (this.limitPending(rt)) throw new NotNow('The move waits for the plan limit decision.');
    if (this.holdsMove(w)) throw new NotNow(w.agents ? 'Background work is still running in this chat. It moves once that is done.' : 'A background command is still running in this chat. It moves once that is done.');
  }

  /** Per chat, sends past their own checks and on their way to the agent (`deliverNow`): no move or agent switch begins under one. */
  private dispatching = new Map<string, Set<Promise<void>>>();

  /** A send of the chat is on its way to its agent until the returned function is called. */
  private beginDispatch(rt: SessionRuntime, checkLossAfter = true): () => void {
    let done!: () => void;
    const p = new Promise<void>((r) => (done = r));
    let set = this.dispatching.get(rt.id);
    if (!set) this.dispatching.set(rt.id, (set = new Set()));
    const own = set;
    own.add(p);
    return () => {
      own.delete(p);
      if (!own.size && this.dispatching.get(rt.id) === own) this.dispatching.delete(rt.id);
      if (checkLossAfter) this.scheduleLossWake(rt);
      done();
    };
  }

  /** Waits until no message of the chat is on its way to its agent (bounded: `DISPATCH_WAIT_MS`). */
  private async untilDispatched(rt: SessionRuntime) {
    const end = Date.now() + DISPATCH_WAIT_MS;
    for (let set = this.dispatching.get(rt.id); set?.size && Date.now() < end; set = this.dispatching.get(rt.id)) {
      await boundedBy(Promise.all([...set]), Math.max(0, end - Date.now()), undefined);
    }
  }

  /** Remote Control processes opened again after moves, one after another. */
  private remoteReopens: Promise<void> = Promise.resolve();

  /**
   * After a move, a chat whose Remote Control was live gets its agent process back on the new account
   * (D3), so the Claude app reaches it again without a message from the desktop first. Paced: one at
   * a time and a few seconds apart (a reset returns many chats at once, and each start goes through its
   * account's sign-in gate). Never for a chat closed, stopped, moved or switched meanwhile, one whose
   * Remote Control was turned off, or one whose agent is already there (a carry-on opened it).
   */
  private reopenRemote(rt: SessionRuntime, mark: { stops: number; closes: number; accountId: string }) {
    const due = () =>
      !this.disposed &&
      this.sessions.get(rt.id) === rt &&
      !!rt.meta.options?.remoteControl &&
      !rt.handle &&
      !this.opening.has(rt.id) &&
      !this.moving.has(rt.id) &&
      !this.switching.has(rt.id) &&
      this.stopsOf(rt) === mark.stops &&
      this.closesOf(rt) === mark.closes &&
      (rt.meta.accountId ?? DEFAULT_ACCOUNT) === mark.accountId;
    if (!due()) return;
    void this.paceRemote(async () => {
      if (!due()) return;
      try {
        const handle = await this.ensureHandle(rt);
        // Claude Code starts Remote Control when asked, as a new chat's start asks it.
        if (rt.meta.provider === 'claude' && rt.handle === handle && rt.meta.options) await handle.setOptions?.(rt.meta.options);
      } catch (err) {
        this.log('Remote Control did not start again after a move', (err as Error).message);
      }
    });
  }

  private paceRemote(start: () => Promise<void>): Promise<void> {
    const opened = this.remoteReopens.then(start);
    this.remoteReopens = opened.catch(() => {}).then(() => new Promise<void>((r) => void setTimeout(r, REMOTE_REOPEN_GAP_MS).unref?.()));
    return opened;
  }

  /** A move ended, however: what was sent meanwhile goes out. */
  private moved(rt: SessionRuntime, stops: number, compacted: boolean) {
    this.moving.delete(rt.id);
    void this.restoreSteerReceipts(rt);
    this.scheduleLossWake(rt);
    if (rt.meta.moving) rt.update({ moving: false });
    // What was sent meanwhile (or waited behind the compaction) goes out on the new account; after a
    // Stop or a close meanwhile it waits for the person (review wave 8, #21).
    const waited = this.queuedWhileMoving.delete(rt.id);
    if ((waited || compacted) && rt.queue.length) {
      setTimeout(() => {
        if (rt.turnActive || rt.stopRequested || this.stopsOf(rt) !== stops || this.sessions.get(rt.id) !== rt) return;
        this.sendNextQueued(rt);
      }, 0);
    }
  }

  /** Messages a phone sent while its chat moved, queued: the guard of the pairing that sent each (by queue id). */
  phoneStillPaired?: (sender: NonNullable<UserItem['phoneSender']>) => boolean;
  closeWebIngress?: () => void;
  webSenderRefusal?: (sender: NonNullable<UserItem['phoneSender']>, sessionId: string) => string | undefined;
  private modeChanges = new Map<string, number>();
  changingMode(sessionId: string) { return this.modeChanges.has(sessionId); }
  private senderGuard(phoneSender: UserItem['phoneSender'], sessionId: string): CallContext | undefined {
    if (phoneSender?.kind === 'web') {
      const refusal = () => this.webSenderRefusal ? this.webSenderRefusal(phoneSender, sessionId) : 'Web access is off.';
      return { phoneSender, allowed: () => !refusal(), refusal };
    }
    return phoneSender && { phoneSender, allowed: () => !!this.phoneStillPaired?.(phoneSender) };
  }
  /** `session.send` by submission id: a retry of a send that went out is answered, not sent again. */
  private phoneReceipts: PhoneReceipts;

  private removePhoneReceipts(id: string, delay = 1000) {
    try { this.phoneReceipts.remove(id); }
    catch (err) {
      this.log('Receipt cleanup deferred', id, String(err));
      setTimeout(() => { if (!this.disposed) this.removePhoneReceipts(id, Math.min(delay * 2, 60_000)); }, delay).unref();
    }
  }
  private submissions = new Submissions<RpcMethods['session.send']['result']>();
  /** Chats switching agent right now (`switchAgent`): no account move meanwhile. */
  private switching = new Set<string>();
  /** Per chat, how often the person stopped it (Stop, close): work begun before a stop does not start a turn after it. */
  private stops = new Map<string, number>();
  /** Per chat, how often it was closed or let go: a move begun before does not go on. */
  private closes = new Map<string, number>();
  private stopsOf(rt: SessionRuntime) {
    return this.stops.get(rt.id) ?? 0;
  }
  private closesOf(rt: SessionRuntime) {
    return this.closes.get(rt.id) ?? 0;
  }
  private cancelLossWake(rt: SessionRuntime) {
    this.pendingLossWake.delete(rt);
    clearTimeout(this.lossWakeTimers.get(rt));
    this.lossWakeTimers.delete(rt);
  }
  private stopped(rt: SessionRuntime) {
    this.steerControls.get(rt)?.abort(new NotNow('The chat was stopped or closed.'));
    this.clearPreparedReports(rt);
    rt.stopDelegates(true);
    this.cancelLossWake(rt);
    this.stops.set(rt.id, this.stopsOf(rt) + 1);
    this.firstInputs.get(rt.id)?.missed();
  }
  private closed(rt: SessionRuntime) {
    rt.stopRequested = true;
    this.stopped(rt);
    this.closes.set(rt.id, this.closesOf(rt) + 1);
    // A limit decision or a return armed before never starts it again (review wave 16, #10).
    this.dropLimitTimers(rt);
    if (rt.meta.spare?.reason === 'reset') this.spare.cancel(rt);
  }

  /**
   * Whether the chat's account can run a turn now: still there, not at a plan limit that counts for
   * the chat's model (another model's full weekly does not), not running on credits.
   */
  private async canRunTurn(rt: SessionRuntime, accountId: string): Promise<boolean> {
    const provider = rt.meta.provider;
    try {
      this.provider(provider, accountId);
    } catch {
      return false;
    }
    const known = await this.knownLimits(provider).catch(() => new Map<string, { limits?: RateLimit[] }>());
    const model = effectiveModel(rt.meta.model || undefined, rt.caps?.models, this.store.state.settings.defaultModels[provider]);
    if (atCap(known.get(accountId)?.limits, Date.now(), model)) return false;
    return !runningOnCredits(this.limitsMeta.get(accountKey(provider, accountId)));
  }

  /**
   * Compacts the chat on the account it is on (the agent's own compaction: Claude Code's `/compact`,
   * Codex's thread compaction, the Demo's), as a turn of its own that opens with a hidden line, so
   * the chat shows it working. Never longer than `compactTimeoutMs`: then it is stopped. Says how it
   * went; the context ring is right after it (the agent's own count, or unknown until the next turn).
   */
  private async compactBeforeMove(rt: SessionRuntime, label: string, check: () => void, automatic: boolean): Promise<MoveOutcome & { stable: boolean }> {
    const before = rt.meta.usage.contextTokens ?? 0;
    const stops = this.stopsOf(rt);
    const opener = rt.add<UserItem>({ type: 'user', text: COMPACT_OPENER, state: 'sent' });
    const status = rt.notice('info', `Compacting before the move to ${label}`);
    let ended!: (error: string | undefined) => void;
    const done = new Promise<{ error?: string }>((resolve) => (ended = (error) => resolve({ error })));
    // One deadline for all of it, from before the agent is opened (review wave 8, #11): a start, a
    // send or a Stop that stalls never holds the move past it.
    const deadline = Date.now() + this.compactTimeoutMs;
    const TIMEOUT = Symbol('timeout');
    const within = <T,>(p: Promise<T>, ms = Math.max(0, deadline - Date.now())): Promise<T | typeof TIMEOUT> => {
      let timer: NodeJS.Timeout | undefined;
      return Promise.race([p, new Promise<typeof TIMEOUT>((r) => (timer = setTimeout(() => r(TIMEOUT), ms)))]).finally(() => clearTimeout(timer));
    };
    let ok = false;
    let stopped = false;
    let failure: string | undefined;
    let cancelled: NotNow | CallerGone | undefined;
    // The agent said the compaction turn ended (finished, failed or stopped): its transcript is whole.
    let confirmed = false;
    let handle: ProviderSession | undefined;
    try {
      const opened = await within(this.ensureHandle(rt, true));
      if (opened === TIMEOUT) throw new Error('the agent did not start in time');
      check();
      handle = opened;
      this.compacting.set(rt.id, (error) => ended(error));
      const sent = await within(this.sendWithHandover(rt, handle, { ...opener, text: '/compact' }).then(() => 'sent' as const));
      const r = sent === TIMEOUT ? TIMEOUT : await within(done);
      if (r === TIMEOUT) {
        this.log('compaction before a move timed out');
        // Asked to stop, and given a short while to say it did; past that, its transcript may still be written.
        const h = handle;
        const stoppedAt = await within(
          h
            .interrupt()
            .catch(() => {})
            .then(() => done),
          Math.min(COMPACT_STOP_GRACE_MS, this.compactTimeoutMs),
        );
        confirmed = stoppedAt !== TIMEOUT;
      } else {
        confirmed = true;
        failure = r.error;
        stopped = !failure && this.stopsOf(rt) !== stops;
        ok = !r.error && !rt.stopRequested;
      }
    } catch (err) {
      failure = (err as Error).message;
      if (err instanceof NotNow || err instanceof CallerGone) cancelled = err;
      this.log('compaction before a move failed', failure);
      // Nothing was sent or the send failed at once: there is no turn whose writing could go on.
      confirmed = !rt.turnActive;
    } finally {
      if (rt.turnActive && this.compacting.has(rt.id)) {
        rt.settle('cancelled');
        rt.endTurn();
      }
      this.compacting.delete(rt.id);
      rt.remove(status.id);
    }
    const from = rt.items.findIndex((i) => i.id === opener.id);
    const after = from >= 0 ? rt.items.slice(from + 1) : [];
    if (cancelled) {
      rt.remove(opener.id);
      throw cancelled;
    }
    if (automatic && !ok && !stopped) {
      // A failed internal /compact is explained by the move that requested it.
      for (const i of after) {
        if (i.type === 'notice' && !i.parentId && i.variant === 'error' && !i.limit) {
          failure = i.detail ?? failure ?? i.text;
          rt.remove(i.id);
        }
      }
      if (!after.some((i) => rt.get(i.id) && !i.parentId && i.type !== 'turn')) rt.remove(opener.id);
      throw new Error(failure ? `Could not compact the conversation: ${failure}` : 'Could not compact the conversation on the original account.');
    }
    // Nothing came of it (the send failed at once): the opener goes too.
    if (!after.some((i) => !i.parentId && i.type !== 'turn')) rt.remove(opener.id);
    // The person stopped the compaction and its end was confirmed. Carry the stable transcript;
    // the Stop generation keeps the pending message in the queue.
    if (stopped) return { kind: 'asIs', tokens: before, stable: true };
    if (!ok || !after.some((i) => i.type === 'notice' && i.variant === 'compact')) return { kind: 'notCompacted', tokens: before, stable: confirmed };
    // The ring: the agent's own count after the compaction, asked for when its events did not say.
    let now = rt.meta.usage.contextTokens;
    if (!(now !== undefined && now < before) && handle?.context) {
      const c = await within(handle.context().catch(() => null), Math.min(5000, Math.max(0, deadline - Date.now())));
      if (c !== TIMEOUT && c?.totalTokens !== undefined && c.totalTokens < before) now = c.totalTokens;
    }
    if (now !== undefined && now < before) {
      if (now !== rt.meta.usage.contextTokens) rt.update({ usage: { ...rt.meta.usage, contextTokens: now } });
      return { kind: 'compacted', before, after: now, stable: true };
    }
    // Compacted, but no count came: unknown until the next turn rather than the old one.
    rt.update({ usage: { ...rt.meta.usage, contextTokens: undefined } });
    return { kind: 'compacted', before, stable: true };
  }

  /** Resolve the cards for this refusal together. A user message or an earlier handover bounds the group. */
  private closeLimitCards(rt: SessionRuntime, accountId: string, cardId?: string) {
    const last = cardId ? rt.items.findIndex((i) => i.id === cardId) : rt.items.findLastIndex((i) => i.type === 'notice' && !i.parentId && !!i.limit && !i.limit.continuedWith);
    const owner = (rt.items[last] as NoticeItem | undefined)?.limit?.userItemId;
    for (let at = last; at >= 0; at--) {
      const it = rt.items[at];
      if (it.parentId) continue;
      if (it.type === 'user' || (at !== last && it.id === rt.meta.moveNote?.line)) break;
      if (it.type !== 'notice') continue;
      if (it.limit?.continuedWith || /^(?:Moved to |Continued with |Back on |New conversation with )/.test(it.text)) break;
      if (it.limit) {
        if (it.limit.userItemId && it.limit.userItemId !== owner) break;
        rt.patch<NoticeItem>(it.id, { limit: { ...it.limit, moving: undefined, continuedWith: accountId } });
        this.releaseRefusalQueue(rt, it.id);
      }
    }
  }

  private async moveAccount(
    rt: SessionRuntime,
    accountId: string,
    target: Provider,
    opts: MoveOptions,
    attempt: MoveAttempt,
  ): Promise<RpcMethods['session.switchAccount']['result']> {
    const provider = rt.meta.provider;
    const fromId = rt.meta.accountId ?? DEFAULT_ACCOUNT;
    const label = this.findAccount(provider, accountId)?.label ?? 'another account';
    const { stops } = attempt;
    const live = () => {
      attempt.live();
      if (opts.automatic && !this.store.state.settings.continueAtLimit) throw new NotNow('Automatic continuation was turned off.');
      if (opts.automatic && !opts.retry && this.store.state.settings.creditsAtLimit?.[creditsKey(provider, fromId)]) throw new NotNow('Credits are now allowed on this account.');
      if (opts.waits && (rt.meta.accountId ?? DEFAULT_ACCOUNT) === fromId && this.limitPending(rt)) throw new NotNow('The move waits for the plan limit decision.');
    };
    const auto = opts.automatic || opts.waits;
    const limitCard = opts.retry ? this.openLimit(rt, opts.refusalId) : undefined;
    const atLimit = limitCard?.limit;
    // The turn boundary survives a restart with the limit card still open. An already answered
    // message belongs to that earlier turn and must not be retried for work the agent began itself.
    const person = limitCard && this.refusedMessage(rt, limitCard);
    const refused: UserItem | undefined = person ?? (limitCard ? { id: randomUUID(), ts: Date.now(), type: 'user', text: RESUME_UNDER_ANOTHER, state: 'sent' } : undefined);
    // Closed or deleted meanwhile: the move goes no further (nothing copied, the runtime untouched);
    // stopped meanwhile: it completes, but starts no turn (review wave 8, #21).

    // Up to the close, after every wait: a turn that began meanwhile (a notification woke the agent, a
    // message came by Remote Control) is never closed under; the move backs out with nothing changed (D2).
    const check = () => {
      live();
      const work = this.workOf(rt, opts.waits);
      if (opts.waits) this.checkWaitable(rt, work);
      if (work.turn) throw new NotNow('The agent is still working. Stop it first.');
      return work;
    };
    const ready = async () => {
      await this.settleLiveTurn(rt);
      check();
    };
    // Whether the old account's transcript is whole: false when its agent may still be writing it
    // (a compaction that did not say it stopped, a close that failed or hung). Then it is not copied
    // and the chat goes on from a summary instead (review wave 8, #11).
    let stable = true;
    for (const account of [fromId, accountId]) {
      if (this.writers.get(rt)?.has(accountKey(provider, account))) {
        await this.confirmWriter(rt, account);
        check();
      }
    }

    // A big chat compacts first where it is, when that account can still run a turn (never to carry on a refused one).
    const tokens = rt.meta.usage.contextTokens;
    let outcome: MoveOutcome = { kind: 'plain' };
    if (rt.meta.providerSessionId && target.adoptConversation && bigContext(tokens, rt.meta.usage.contextWindow)) {
      const caps = rt.caps ?? this.cachedCaps(provider, fromId, rt.meta.cwd) ?? this.cachedCaps(provider, fromId);
      const can = opts.compact !== false && !opts.retry && caps?.features.compact !== false && (await this.canRunTurn(rt, fromId));
      await ready();
      if (can) {
        opts.onCompacting?.();
        attempt.compacted = true;
        const compacted = await this.compactBeforeMove(rt, label, () => {
          check();
          if (this.stopsOf(rt) !== stops) throw new NotNow('The chat was stopped before compaction.');
        }, !!auto);
        stable = compacted.stable;
        const { stable: _s, ...rest } = compacted;
        outcome = rest as MoveOutcome;
        await ready();
        if (auto && outcome.kind === 'notCompacted') throw new Error('Could not compact the conversation on the original account.');
      } else outcome = { kind: 'asIs', tokens: tokens! };
    }

    // A start still under way is waited for (bounded) so its handle is closed here, not installed later.
    const opening = this.opening.get(rt.id);
    if (opening) {
      await boundedBy(opening.catch(() => {}), MOVE_CLOSE_MS, undefined);
      if (this.opening.has(rt.id)) throw new NotNow('The agent is still starting.');
    }
    await this.settleLiveTurn(rt);
    // The last look, with nothing awaited between it and the close: from here the move happens.
    const { wakeAt } = check();
    // Background commands and monitors live in the process the move closes: they are lost with it
    // (D-lost: the switch line names them, the agent is told with its next message). Sub-agents still
    // working are only those a limit could not stop; the close may end them after all (moves-M2).
    const wakeLost = wakeAt !== undefined && wakeAt + WAKE_DELIVERY_GRACE_MS > Date.now();
    rt.cancelPrompts();
    const working = rt.items.filter((i) => worksInBackground(i)).map((i) => i.id);
    if (rt.meta.commands || rt.meta.serving) attempt.lostSteps = rt.items.filter(runsTask).map((i) => i.id);
    const lost = rt.tasksLost('move', auto ? 'move' : undefined);
    const old = rt.handle;
    rt.handle = undefined;
    // Its Remote Control was live: the new account's process takes it over once the move is done (D3).
    attempt.remote = !!old && !!rt.meta.options?.remoteControl && (!!rt.meta.remote?.url || rt.meta.remote?.tone === 'ok');
    if (old) {
      try {
        await this.closeWriter(rt, fromId, old, rt.meta.provider, 'move');
        attempt.sourceClosed = true;
        rt.setReportedTasks([]);
        if (old.exited) stable = true;
      } catch {
        stable = false;
      }
    }
    // A caller removed while the agent closed (a phone, review wave 6, #3): no conversation is copied, nothing moves.
    live();
    if (auto && !stable) throw new Error('The old process did not confirm its exit, so the conversation could not be copied.');
    const ended = working.filter((wid) => !worksInBackground(rt.get(wid)));
    this.markLimitStops(rt, ended, atLimit);
    if (auto) this.recordStoppedAgents(rt, ended, 'move');

    let carried: 'conversation' | 'summary' | 'none' = 'none';
    let summaryAt = false;
    const id = rt.meta.providerSessionId;
    if (id) {
      let fromHome: string | undefined;
      try {
        fromHome = this.provider(provider, fromId).configHome?.();
      } catch {
        /* the old account was removed: nothing to copy from */
      }
      let adopted = false;
      if (stable && fromHome && target.adoptConversation) {
        try {
          adopted = await target.adoptConversation(fromHome, id);
        } catch (err) {
          if (auto) throw err;
          this.log('could not carry the conversation over', (err as Error).message);
        }
        if (auto && !adopted) throw new Error('Could not copy the conversation to the new account.');
      }
      live();
      if (adopted) carried = 'conversation';
      else {
        // The conversation stays behind, and the timeline it would be told from could not be read: the
        // chat keeps its account and its conversation rather than starting with nothing.
        if (this.unreadable.has(rt.id)) throw new Error('This chat could not be read from disk, so it cannot start over on another account. Restart Sable and try again.');
        // Kept with the chat (its switch line, below) and taken by the first message the agent accepts.
        if (handoverText(withoutChecks(rt.items), { skip: refused?.id })) {
          summaryAt = true;
          carried = 'summary';
        }
      }
    }
    // A new conversation starts from the summary: the old count says nothing about it (the ring is
    // empty until its first turn says). A carried one keeps its count, compacted or not.
    const usage = carried === 'summary' ? { usage: { ...rt.meta.usage, contextTokens: undefined } } : {};
    if (carried === 'summary' || carried === 'none') outcome = { kind: 'plain' };
    const source = { accountId: rt.meta.accountId, providerSessionId: id, usage: { ...rt.meta.usage }, moveNote: rt.meta.moveNote, remote: rt.meta.remote, capState: rt.meta.capState,
      movedFrom: rt.meta.movedFrom, returnAt: rt.meta.returnAt, returnModels: rt.meta.returnModels };
    const previousCaps = rt.caps;
    const destinationStart = rt.items.length;
    const restore = () => {
      if (rt.turnActive) {
        rt.settle('cancelled');
        rt.endTurn(undefined, { hold: true });
      }
      if (auto) {
        // The switch line or limit card explains a rejected startup, including failures the
        // adapter also reported on the timeline before its open or send rejected.
        for (const item of rt.items.slice(destinationStart)) {
          if (item.type === 'notice' && !item.parentId && item.variant === 'error' && !item.limit) rt.remove(item.id);
        }
      }
      rt.update({ ...source, status: 'idle', lastError: undefined });
      if (previousCaps && rt.caps !== previousCaps) rt.setCaps(previousCaps);
    };
    // A move by a cap says why in its own line; a move at a limit closes the limit's notice. The
    // line says what the move did to the context: compacted (before and after), or read again in full.
    const clause = contextClause(outcome, !!refused);
    // Background commands the close lost: said on the same line, named in its detail.
    const gone = lostClause(lost);
    const detailOf = (d: string | undefined) => [d, gone.detail, wakeLost ? WAKE_LOST : undefined].filter(Boolean).join('\n\n') || undefined;
    const summaryLine = 'With a summary of the conversation so far';
    const open = opts.line ? undefined : this.openLimit(rt, opts.refusalId);

    let line: NoticeItem | undefined;
    const destination: Partial<SessionMeta> = { providerSessionId: carried === 'conversation' ? id : undefined };
    // A refusal in the destination's very first send must already see its way back. Stage the
    // return with the account so a failed handoff restores both in the same patch.
    let limitReturn = opts.limitReturn;
    if (limitReturn === 'selectedNotice') {
      const rows = this.limitsCache.get(accountKey(provider, fromId));
      limitReturn = atLimit && { at: atLimit.resetsAt, models: [atLimit.window, atLimit.wakeWindow].map(w => this.limitModel(w, rows)) };
    }
    if (opts.limitReturn) {
      const origin = source.movedFrom ?? fromId;
      if (!limitReturn || origin === accountId) Object.assign(destination, { movedFrom: undefined, returnAt: undefined, returnModels: undefined });
      else if (origin === fromId) Object.assign(destination, { movedFrom: origin, returnAt: limitReturn.at, returnModels: limitReturn.models?.filter((m): m is string => !!m) ?? [] });
    }
    let committed = false;
    let openingCaps: Capabilities | undefined;
    // Providers read their resume ID from the runtime passed to open(). Keep that view and
    // the new thread's startup metadata private until its account and handover are ready.
    const starting = new Proxy(rt, {
      get(target, key) {
        if (!committed && key === 'meta') return { ...target.meta, ...destination, accountId: accountId === DEFAULT_ACCOUNT ? undefined : accountId };
        if (!committed && key === 'caps') return openingCaps;
        if (!committed && key === 'setCaps') return (caps: Capabilities) => { openingCaps = caps; };
        if (!committed && key === 'update') return (patch: Partial<SessionMeta>) => Object.assign(destination, patch);
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const rollback = () => {
      committed = false;
      if (line) rt.remove(line.id);
      restore();
    };
    const closeFailedDestination = async () => {
      const failed = rt.handle;
      rt.handle = undefined;
      rollback();
      if (failed) await this.closeWriter(rt, accountId, failed).catch(() => {});
    };
    const publish = () => {
      if (opts.line) line = rt.notice('info', `${opts.line}${clause.suffix ?? ''}${gone.suffix ?? ''}`, detailOf(carried === 'summary' ? summaryLine : clause.detail));
      else if (!open || carried === 'summary') {
        line = rt.notice('info', carried === 'summary' ? `New conversation with ${label}${gone.suffix ?? ''}` : `Continued with ${label}${clause.suffix ?? ''}${gone.suffix ?? ''}`, detailOf(carried === 'summary' ? summaryLine : clause.detail));
      } else if (clause.suffix || clause.detail) {
        // The limit's notice says where it went; one quiet line says what that did to the context.
        line = rt.notice('info', `${clause.suffix ? `Context${clause.suffix.replace(/^ · context/, '')}` : 'Carried as it is'}${gone.suffix ?? ''}`, detailOf(clause.detail));
      } else if (lost.length || wakeLost) {
        // The limit's notice says where it went; one quiet line says what the move lost.
        line = rt.notice('info', lost.length ? lostLine(lost.length, 'move') : 'Scheduled wake-up cancelled', [gone.names, wakeLost ? WAKE_LOST : undefined].filter(Boolean).join('\n\n') || undefined);
      }

      // The first message after the move tells the agent (moveNote): anchored at the line, so what the
      // person waits on is read from before it, also after a restart.
      const anchor = line?.id ?? open?.id ?? rt.items.findLast((i) => !i.parentId)?.id;
      // The summary, when the conversation stayed behind, is the chat before the line; one from an
      // earlier move that no message took yet stays (review wave 8, #22).
      const prev = rt.meta.moveNote;
      const summary = summaryAt && line ? { summary: line.id, ...(refused ? { skip: refused.id } : {}) } : prev?.summary ? { summary: prev.summary, ...(prev.skip ? { skip: prev.skip } : {}) } : {};
      if (!auto && !opts.line) this.cancelLossWake(rt);
      rt.update({ ...destination, ...usage, accountId: accountId === DEFAULT_ACCOUNT ? undefined : accountId, status: 'idle', lastError: undefined, ...(anchor ? { moveNote: { line: anchor, ...summary } } : {}) });
      committed = true;
      if (openingCaps) rt.setCaps(openingCaps);
    };
    // A reconnect during the copy or start still sees the source. Publish the destination and
    // install its process together, once the start has succeeded.
    if ((refused || (auto && old)) && this.stopsOf(rt) === stops) {
      if (rt.meta.lane) await this.lanes.ready(rt);
      const launch = async () => {
        live();
        if (this.stopsOf(rt) !== stops) return publish();
        const handle = await target.open(starting, { loadTranscript: false });
        try {
          live();
        } catch (err) {
          await this.closeWriter(rt, accountId, handle).catch(() => {});
          throw err;
        }
        rt.handle = handle;
        publish();
        this.seedCaps(rt);
        if (attempt.remote && provider === 'claude' && rt.meta.options?.remoteControl) await handle.setOptions?.(rt.meta.options);
      };
      const started = !refused && attempt.remote ? this.paceRemote(launch) : launch();
      this.opening.set(rt.id, started);
      try {
        await started;
        live();
      } catch (err) {
        await closeFailedDestination();
        throw err;
      } finally {
        if (this.opening.get(rt.id) === started) this.opening.delete(rt.id);
        this.scheduleLossWake(rt);
      }
    } else publish();
    this.persistSessions();

    // Stopped during the move: the refused turn does not start again by itself.
    const carryOn = async () => {
      if (!refused || this.stopsOf(rt) !== stops) return;
      const handle = rt.handle;
      live();
      if (!handle) throw new NotNow('The destination process was released during the move.');
      // Its sender (a phone) removed meanwhile: the refused message never goes (review wave 17, #3).
      if (!this.refusedAllowed(rt, refused)) {
        this.pendingLossWake.delete(rt);
        return false;
      }
      const retry = this.resumeMessage(rt, refused, carried, limitCard!, ended);
      if (auto && !rt.get(retry.id) && rt.pendingLost().count && (rt.dangerHeld || rt.meta.lossWake?.blocked || recentLossWakes(rt).length >= 2)) return;
      await this.applyModeDue(rt, handle);
      live();
      if (this.stopsOf(rt) !== stops) return;
      const stopped = new NotNow('The chat was stopped during the move.');
      const unhand = this.handOver(rt, refused.id);
      try {
        if (person && retry.id === person.id) this.retryOwners.set(rt, person.id);
        const checkDelivery = () => {
          live();
          if (this.stopsOf(rt) !== stops) throw stopped;
          still(this.refusedGuard(rt, refused));
        };
        if (provider === 'claude') await this.sendFirstInput(rt, handle, retry, checkDelivery, rollback);
        else await this.sendWithHandover(rt, handle, retry, checkDelivery);
      } catch (err) {
        unhand();
        if (err === stopped) return;
        if (err instanceof CallerGone && rt.turnActive) {
          rt.settle('cancelled');
          rt.endTurn();
        }
        throw err;
      }
    };
    try {
      const continued = await carryOn();
      if (open && continued !== false) this.closeLimitCards(rt, accountId, open.id);
    } catch (err) {
      this.retryOwners.delete(rt);
      // An unnamed completion may already have answered on the destination. Keep its transcript
      // and the open refusal for a deliberate retry. Only a known miss rolls back.
      if (err instanceof DeliveryUncertain) rt.notice('info', 'Delivery unconfirmed', err.message);
      else await closeFailedDestination();
      throw err;
    }
    this.endedByMove(rt, ended, label);
    if (opts.limitReturn) this.armReturn(rt);
    if (limitReturn && fromId === this.defaultAccountId(provider)) {
      this.fallbacks.set(provider, { from: fromId, to: accountId, until: limitReturn.at });
      void this.emitProvider(provider).catch(() => {});
      this.scheduleResetAlert();
    }
    if (carried === 'conversation' && id) await this.conversationCopies.moved(rt.meta, id, accountId, fromId);
    return { ok: true, carried };
  }

  /**
   * Switches the chat to another agent in place: the same chat and conversation, the next message
   * goes to `provider`. The agent it leaves keeps its own conversation (`SessionMeta.agents`); an
   * agent the chat ran with before resumes its own and is told what happened since it was left, a
   * new one starts from a handover of the whole chat (both computed when the next message goes out,
   * so they survive a restart). Switching back right after a switch, with nothing sent, undoes it
   * (the switch line goes). Refused while the agent works or background work runs in its process.
   */
  async switchAgent(rt: SessionRuntime, provider: ProviderId, opts: { model?: string; accountId?: string } = {}): Promise<RpcMethods['session.switchAgent']['result']> {
    if (this.lazy.has(rt.id)) await this.hydrateAsync(rt);
    const from = rt.meta.provider;
    if (provider === from) {
      if (opts.model) this.setSessionModel(rt, opts.model);
      return { ok: true };
    }
    if (!this.providers.has(provider)) throw new Error(`Provider not available: ${provider}`);
    // The Customize chat only with an agent that gets its brief (`services/custom.ts`).
    if (rt.meta.custom && !customAgent(provider)) throw new Error(CUSTOM_AGENT_ONLY);
    // The same reading of the chat's work as every move: a turn (one the agent began by itself too), a
    // message on its way to the agent, sub-agents working in the background. Background commands do not
    // hold a switch the person asks for: they are lost with the process it closes, and said so.
    const work = this.workOf(rt);
    if (work.turn || this.opening.has(rt.id) || this.delivering.has(rt.id) || this.dispatching.has(rt.id) || this.capChecks.has(rt.id)) throw new NotNow('The agent is still working. Switch when it is done.');
    // Never over a move of account, nor two switches at once (review wave 8, #10).
    if (this.moving.has(rt.id) || this.switching.has(rt.id)) throw new NotNow('This chat is changing account or agent. Switch when it is done.');
    if (work.agents > 0 || rt.items.some(worksInBackground)) throw new NotNow('Background work is still running in this chat. Switch when it is done.');
    const cwd = rt.meta.cwd;
    if (provider !== 'demo' && !isDir(cwd)) throw new Error(`Folder not found: ${cwd}`);
    const settings = this.store.state.settings;
    const undo = undoableSwitch(rt.items, from, provider);
    let legs = rt.meta.agents ?? [];
    // Undone: the line goes, and an agent whose conversation reached it covers up to the item before it.
    if (undo) {
      const before = rootBefore(rt.items, undo.id);
      legs = legs.map((l) => (l.knows === undo.id ? { ...l, knows: before } : l));
    }
    const target = legs.find((l) => l.provider === provider);
    // The agent it goes back to keeps its account (and so its conversation) while that account exists,
    // and, for Claude Code, whose conversations belong to a folder, while the chat is in the same folder.
    const keeps = !!target && (!target.accountId || !!this.findAccount(provider, target.accountId)) && !(provider === 'claude' && target.cwd && !sameDir(target.cwd, cwd));
    const accountId = keeps ? (target!.accountId ?? DEFAULT_ACCOUNT) : (opts.accountId ?? this.defaultAccountId(provider));
    // Refuses an account that was removed before anything changes.
    this.provider(provider, accountId);
    const cached = this.cachedCaps(provider, accountId, cwd);
    const defaultModel = (caps: Capabilities | undefined) => caps?.models.find((m) => m.isDefault)?.id ?? caps?.models[0]?.id;
    const model = opts.model || (keeps ? target!.model : '') || settings.defaultModels[provider] || defaultModel(cached) || '';
    const prev = legs.find((l) => l.provider === from);

    rt.cancelPrompts();
    // Commands still running live in the process the switch closes (D-lost): marked before it goes.
    const lost = rt.tasksLost('process');
    this.switching.add(rt.id);
    try {
      await this.detachWriter(rt, 'switch');
    } finally {
      this.switching.delete(rt.id);
      this.scheduleLossWake(rt);
      this.resumeDrain(rt);
    }
    // Closed or moved while the agent closed: nothing switches.
    if (this.sessions.get(rt.id) !== rt) throw new Error('The chat was closed.');
    rt.handle = undefined;
    this.modelDue.delete(rt.id);
    this.handovers.delete(rt.id);

    // Only the latest switch line offers to switch back.
    const prior = lastSwitch(rt.items);
    let line: NoticeItem | undefined;
    if (undo) {
      rt.remove(undo.id);
      const latest = lastSwitch(rt.items);
      if (latest?.agentSwitch?.past) rt.patch<NoticeItem>(latest.id, { agentSwitch: { ...latest.agentSwitch, past: false } });
    } else {
      if (prior?.agentSwitch && !prior.agentSwitch.past) rt.patch<NoticeItem>(prior.id, { agentSwitch: { ...prior.agentSwitch, past: true } });
      line = rt.add<NoticeItem>({ type: 'notice', variant: 'info', text: `${target ? 'Switched back to' : 'Switched to'} ${this.agentName(provider)}`, agentSwitch: { from, to: provider, ...(target ? { back: true } : {}) } });
    }
    // The commands the closed process ran are lost with it: said once, their names on demand (the
    // agent the chat goes on with hears it with its next message).
    if (lost.length) rt.notice('info', lostLine(lost.length, 'process'), lost.join('\n'));
    // The agent left behind covers the chat up to this line, unless its handover never went out.
    const leaving = legOf(rt.meta, rt.meta.agentHandover ? prev?.knows : (line?.id ?? rt.items.findLast((i) => !i.parentId)?.id));
    const knows = keeps ? target!.knows : undefined;
    const startSpeed = keeps ? (target!.speed && target!.speed !== STANDARD_SPEED ? { speed: target!.speed, fast: true } : {}) : this.startSpeed(provider, accountId, cwd, model, settings.defaultSpeeds?.[provider]);
    const next: SessionMeta = {
      ...rt.meta,
      provider,
      providerSessionId: keeps ? target!.providerSessionId : undefined,
      model,
      effort: keeps ? target!.effort : settings.defaultEfforts[provider],
      mode: keeps ? target!.mode : subAgentMode(provider, rt.meta.mode),
      accountId: accountId === DEFAULT_ACCOUNT ? undefined : accountId,
      speed: undefined,
      fast: undefined,
      ...startSpeed,
      ultracode: keeps ? target!.ultracode : undefined,
      options: keeps ? target!.options : withDefaultOptions(provider, settings.sessionOptions?.[provider]),
      movedFrom: undefined,
      returnModels: undefined,
      returnAt: undefined,
      remote: undefined,
      capState: undefined,
      status: 'idle',
      lastError: undefined,
      activity: undefined,
      usage: { ...rt.meta.usage, contextTokens: keeps ? target!.context?.tokens : undefined, contextWindow: keeps ? target!.context?.window : undefined },
      agents: withLeg(legs, leaving),
      agentHandover: { from, ...(knows ? { since: knows } : {}) },
      // The handover covers a move of account before it: no second note.
      moveNote: undefined,
    };
    // Fields that end are dropped, not left undefined (patches travel as JSON; the meta goes whole below).
    for (const k of Object.keys(next) as (keyof SessionMeta)[]) if (next[k] === undefined) delete next[k];
    for (const k of Object.keys(rt.meta) as (keyof SessionMeta)[]) if (!(k in next)) delete rt.meta[k];
    rt.update(next);
    void this.restoreSteerReceipts(rt);
    // Whole, so what ended (a conversation id, an account, a speed) ends in every window too.
    this.emit({ type: 'session.added', session: { ...rt.meta } });
    // The new agent's models and modes at once where known; asked for otherwise.
    if (cached) rt.setCaps(cached);
    else {
      rt.caps = undefined;
      this.emit({ type: 'session.caps', id: rt.id, caps: undefined as unknown as Capabilities });
      void this.capsFast(provider, cwd, accountId)
        .then((caps) => {
          if (this.sessions.get(rt.id) !== rt || rt.meta.provider !== provider || rt.handle || rt.caps) return;
          rt.setCaps(caps);
          if (!rt.meta.model && defaultModel(caps)) rt.update({ model: defaultModel(caps) });
        })
        .catch(() => {});
    }
    // A wait for the old agent's limit to reset is over.
    this.spare.movedByHand(rt);
    this.persistSessions();
    return { ok: true, ...(undo ? { undone: true } : {}) };
  }

  /**
   * A turn ended. When it ended normally, the next queued message goes out (one per turn
   * end). After an interrupt, a close or a failure the queue waits for the user, as it does when
   * the agent could not say how the turn ended (`hold`).
   */
  private afterTurn(rt: SessionRuntime, error?: string, hold = false, backgroundLimit = false) {
    this.steerEnds.get(rt)?.(!error && !hold && !backgroundLimit && !this.compacting.has(rt.id) && !rt.stopRequested);
    this.scheduleLossWake(rt);
    // The compaction before a move ended: the move goes on (nothing is sent, nothing else follows).
    const compacted = this.compacting.get(rt.id);
    if (compacted) return compacted(error);
    const last = rt.items.at(-1);
    if (last?.type === 'notice' && last.early) this.firstInputs.get(rt.id)?.missed();
    // Sable is going down (a close at quit cuts the turn it ran): nothing follows, no move, no check,
    // no queued message, nothing that would start an agent again.
    if (this.disposed) return;
    // Refused for the sign-in: asked again before it is believed (server/core/auth-gate.ts).
    const signIn = takeAuthFailure(rt.id);
    // What was refused is taken now, before anything is awaited (review wave 16, #8). Only a turn that
    // failed, and only a refusal of this very turn: a sub-agent refused in a turn that went on to
    // finish needs nothing, and one refused in an earlier turn says nothing about this one (wave 17, #7).
    const mark = signIn ? this.refusalMark(rt) : undefined;
    if (signIn && mark && error && (signIn.turn === undefined || signIn.turn === mark.refusedId)) {
      void this.onSignInRefused(rt, signIn, mark).catch((err) => this.log('sign-in follow-up failed', (err as Error).message));
    }
    // A spare turn's end frees its place; waiting chats are looked at again.
    const retryOwner = this.retryOwners.get(rt);
    this.retryOwners.delete(rt);
    const ran = this.spare.turnEnded(rt);
    if (backgroundLimit) {
      // The provider publishes the refused wake immediately after this callback.
      rt.returnUntaken();
      this.consumed(rt, false);
      this.until.turnOver(rt);
      return;
    }
    const undecided = rt.items.filter((i): i is NoticeItem => i.type === 'notice' && !!i.limit && !i.limit.provider && !i.limit.continuedWith && !i.parentId);
    // Capture each personal refusal on its original account. A second one can wait across the first move.
    const newCards = undecided.filter(i => !i.limit?.accountId);
    for (const card of newCards) {
      if (card.limit?.userItemId) rt.patch<NoticeItem>(card.id, { limit: { ...card.limit, accountId: rt.meta.accountId ?? DEFAULT_ACCOUNT } });
    }
    const hit = newCards.find(i => i.limit?.userItemId) ?? newCards.at(-1) ?? (!this.limitDecisions.has(rt.id) ? this.pendingPersonal(rt) : undefined);
    if (hit) {
      if (retryOwner && !hit.limit?.origin) {
        const owner = this.refusedMessage(rt, hit)?.id ?? retryOwner;
        rt.patch<NoticeItem>(hit.id, { limit: { ...hit.limit, origin: 'user', userItemId: owner } });
      }
      // A turn Spare started waits again at a limit instead of going on with another account.
      const refusedSpare = newCards.includes(hit) ? ran : undefined;
      if (refusedSpare) this.spareLimitHit(rt, refusedSpare, hit);
      void this.onLimitHit(rt, hit, !!refusedSpare).catch((err) => this.log('limit follow-up failed', (err as Error).message));
    } else {
      if (!error && !hold && !rt.stopRequested) {
        const chain = this.autoContinued.get(rt);
        // A wake's refusal is published just after endTurn. Give the provider that
        // boundary before retiring the chain a completed turn was carrying.
        if (chain) queueMicrotask(() => {
          if (!this.bgLimits.has(rt.id) && this.autoContinued.get(rt) === chain) this.autoContinued.delete(rt);
        });
      }
      // Past its cap now: the session moves before anything else goes out (a queued message waits for it).
      void this.checkCap(rt);
      // Spare's own turns never go on with credits or another account (a spare turn on credits is stopped).
      if (!error && !ran) void this.onCredits(rt).catch((err) => this.log('credits follow-up failed', (err as Error).message));
    }
    // An until loop stopped during the turn says so after it.
    this.until.turnOver(rt);
    // What the turn took (nothing of a failed or stopped one, nor of one whose end is not known).
    const consumed = this.consumed(rt, !error && !rt.stopRequested && !hold);
    if (consumed.length) rt.patch<UserItem>(consumed[consumed.length - 1], { completedPersonalTurn: true });
    const heldCard = this.refusalQueues.get(rt);
    if (!hit && heldCard && consumed.length) {
      const at = rt.items.findIndex(i => i.id === heldCard);
      if (at >= 0 && consumed.some(id => rt.items.findIndex(i => i.id === id) > at)) {
        this.refusalQueues.delete(rt);
        this.scheduleLossWake(rt);
        this.closeLimitCards(rt, rt.meta.accountId ?? DEFAULT_ACCOUNT, heldCard);
        if (rt.meta.spare?.refusalId === heldCard) this.spare.cancel(rt);
      }
    }
    if (error || rt.stopRequested || hold) {
      this.pendingDrains.delete(rt);
      // Steered messages the agent never took go back to the queue, to send or edit again.
      const back = rt.returnUntaken({ reason: error ? 'failed' : 'stopped' });
      if (hold && !this.steerEnds.has(rt) && !back && rt.queue.length) rt.notice('info', 'Queued messages wait', 'The agent did not say how the last turn ended. Send them when you are ready.');
      // An until loop waits for the next turn, as the queue waits for the user.
      this.until.turnHeld(rt);
      return;
    }
    // The chat's first turn settled: a small model names it from the message it took, in the background.
    this.titles.turnEnded(rt, consumed);
    const waiting = rt.items.filter((i): i is UserItem => i.type === 'user' && i.state === 'queued');
    // Let the adapter finish its own bookkeeping (it may start a turn of its own first, with a
    // steered message the turn ended before taking).
    setTimeout(() => {
      if (rt.turnActive || rt.stopRequested || this.sessions.get(rt.id) !== rt) return;
      // A steered message no turn took and no adapter carried on is never left waiting: it goes out first.
      rt.returnUntaken({ from: waiting });
      const rest = !rt.queue.length && !rt.meta.until;
      this.sendNextQueued(rt);
      // Nothing more to do: a chat a limit moved away goes back once that account takes work again.
      if (rest) void this.returnAfterLimit(rt).catch((err) => this.log('return after a limit failed', (err as Error).message));
    }, 0);
  }

  /** Sessions whose next queued message is being taken back by a phone: the queue goes on when that take settles. */
  private drainWaiting = new Set<string>();
  private pendingDrains = new WeakSet<SessionRuntime>();
  private updateDrains = new WeakSet<SessionRuntime>();

  private resumeDrain(rt: SessionRuntime) {
    if (!this.pendingDrains.delete(rt)) return;
    const stops = this.stopsOf(rt);
    setTimeout(() => {
      if (this.stopsOf(rt) === stops) this.sendNextQueued(rt);
    }, 0);
  }

  /** Queued work stays with an unresolved background refusal through its move or reset. */
  private refusalQueues = new WeakMap<SessionRuntime, string>();

  private releaseRefusalQueue(rt: SessionRuntime, card: string) {
    if (this.refusalQueues.get(rt) !== card) return;
    this.refusalQueues.delete(rt);
    this.scheduleLossWake(rt);
    if (rt.queue.length) setTimeout(() => {
      this.sendNextQueued(rt);
    }, 0);
  }

  private nextAutomaticMessage(rt: SessionRuntime, includeRevokedTransient = false) {
    const held = this.spare.held(rt);
    return rt.queue.find(q => {
      if (held.has(q.id)) return false;
      const sender = this.senderGuard(q.phoneSender, rt.id);
      if (sender?.allowed?.() === false) {
        const reason = includeRevokedTransient && sender.refusal?.();
        if (reason) rt.queueReason(q.id, reason);
        return false;
      }
      return includeRevokedTransient || !!q.phoneSender || rt.transientQueueGuards.get(q.id)?.() !== false;
    });
  }

  /** After a turn: the next queued message goes out, or (nothing waits) an until loop runs its check. */
  private sendNextQueued(rt: SessionRuntime): void {
    if (this.updates?.installing) return void this.updateDrains.add(rt);
    if (this.disposed || this.sessions.get(rt.id) !== rt || rt.turnActive || rt.unreadQueueHeld || rt.stopRequested || this.refusalQueues.has(rt)) return;
    if (this.steerEnds.has(rt) || this.sending.has(rt.id) || this.switching.has(rt.id)) return void this.pendingDrains.add(rt);
    if (this.sendHolds.has(rt.id)) return void this.heldSends.add(rt.id);
    // Moving to another account: the queue goes on there once the move is done.
    if (this.moving.has(rt.id)) return void this.queuedWhileMoving.add(rt.id);
    // Messages held for Spare stay where they are: the chat starts them by itself.
    const next = this.nextAutomaticMessage(rt, true);
    const nextId = next?.id;
    // A phone is taking it back right now: it neither goes nor is skipped; the queue goes on once that settles.
    if (rt.isReserved(nextId)) return void this.drainWaiting.add(rt.id);
    // Older in-process callers supply a transient guard only. Paired submissions carry phoneSender.
    if (next && !next.phoneSender && rt.transientQueueGuards.get(next.id)?.() === false) {
      rt.takeQueued(next.id);
      rt.notice('info', 'A message from a removed phone was not sent');
      return this.sendNextQueued(rt);
    }
    if (nextId) void this.deliverQueued(rt, nextId).catch((err) => {
      if (err instanceof CallerGone) rt.onQueueRunnable?.();
      else rt.notice('error', 'Could not send the queued message', (err as Error).message);
    });
    // Nothing waits: an until loop runs its check (the user's messages always go first).
    else this.until.turnEnded(rt);
  }

  private steerControls = new WeakMap<SessionRuntime, AbortController>();
  private steerEnds = new WeakMap<SessionRuntime, (drain: boolean) => void>();
  private steersSettled = new WeakMap<SessionRuntime, Promise<void>>();
  private steerSenders = new WeakMap<UserItem, CallContext>();

  private async steerNow(rt: SessionRuntime, itemId: string, caller: CallContext, automatic = false) {
    const handle = rt.handle;
    const stops = this.stopsOf(rt);
    const check = () => {
      still(caller);
      if (this.moving.has(rt.id) || this.moveAttempts.has(rt)) throw new NotNow('This chat is moving to another account.');
      if (this.limitPending(rt) || this.sendHolds.has(rt.id)) throw new NotNow('A plan limit decision is in progress.');
      if (this.switching.has(rt.id)) throw new NotNow('This chat is switching agent.');
      if (rt.stopRequested || this.stopsOf(rt) !== stops || this.disposed || this.sessions.get(rt.id) !== rt || rt.handle !== handle) throw new NotNow('The chat was stopped or closed.');
    };
    check();
    if (rt.meta.provider !== 'claude') throw new NotNow('Interrupt and send now is available for Claude Code chats.');
    if (!handle?.recallSteers || !handle.interruptSteer) return { ok: false };
    const card = rt.get<UserItem>(itemId);
    if (!rt.turnActive || card?.type !== 'user' || card.parentId || !card.steered || card.state !== 'queued' || this.steerEnds.has(rt)) return { ok: false };
    still(this.senderGuard(card.phoneSender, rt.id) ?? this.steerSenders.get(card));
    // A returned phone message keeps the guard of the pairing that originally sent it.
    const originals = new Map(rt.items.filter((it): it is UserItem => it.type === 'user' && !it.parentId && !!it.steered && it.state === 'queued').map(it => [it.id, it]));
    let ended = false, drainOnRelease = true;
    const boundary = new Promise<void>(resolve => this.steerEnds.set(rt, drain => {
      ended = true;
      drainOnRelease = drain;
      resolve();
    }));
    let settle!: () => void;
    this.steersSettled.set(rt, new Promise<void>(resolve => { settle = resolve; }));
    const release = this.beginDispatch(rt);
    const control = new AbortController();
    this.steerControls.set(rt, control);
    try {
      const ids = await handle.recallSteers(itemId, check, control.signal, automatic);
      if (!ids.length) {
        if (rt.get(itemId) === card && card.state === 'queued') rt.patch<UserItem>(itemId, { steerWait: { ...card.steerWait, reason: 'Claude did not confirm withdrawal.' } });
        return { ok: false };
      }
      check();
      if (!ended && rt.turnActive) {
        await handle.interruptSteer(control.signal);
        if (!ended) await new Promise<void>((resolve, reject) => {
          const abort = () => reject(control.signal.reason);
          if (control.signal.aborted) return abort();
          control.signal.addEventListener('abort', abort, { once: true });
          const timer = setTimeout(() => reject(new NotNow('Claude did not confirm the turn ended.')), 3500);
          void boundary.then(resolve).finally(() => { clearTimeout(timer); control.signal.removeEventListener('abort', abort); });
        });
      }
      const order = [...originals.keys()];
      rt.reorderQueued(order.filter(id => rt.queue.some(q => q.id === id)));
      let sent = false;
      let selectedSent = false;
      for (const id of order) {
        const original = originals.get(id);
        const entry = rt.queue.find(q => q.id === id);
        if (!entry || entry.issuedUuid || !ids.includes(id) && !handle.wasWithdrawn?.(id)) continue;
        if (!original || entry.text !== original.text || entry.attachments !== original.attachments) continue;
        const beforeSend = () => {
          check();
          if (caller.phoneSender?.kind === 'web') {
            if (original.phoneSender?.deviceId !== caller.phoneSender.deviceId || original.phoneSender.kind !== 'web')
              throw new NotNow('Only steer a message sent by this browser.');
            requireWebMessage(entry.text);
          }
          still(this.senderGuard(original.phoneSender, rt.id) ?? this.steerSenders.get(original));
          if (!sent && rt.turnActive) throw new NotNow('Another turn has already started.');
        };
        beforeSend();
        if (!await this.deliverQueued(rt, id, caller, beforeSend)) break;
        if (rt.queue.some(q => q.id === id)) break;
        sent = true;
        if (id === itemId) selectedSent = true;
      }
      if (sent && !rt.queue.some(q => originals.has(q.id) && !q.byHand && this.senderGuard(q.phoneSender, rt.id)?.allowed?.() !== false)) rt.unreadQueueHeld = false;
      return { ok: selectedSent };
    } catch (error) {
      const reason = (error as Error).message;
      if (rt.get(itemId) === card && card.state === 'queued') rt.patch<UserItem>(itemId, { steerWait: { ...card.steerWait, reason } });
      else rt.queueReason(itemId, reason);
      throw error;
    } finally {
      this.steerControls.delete(rt);
      this.steerEnds.delete(rt);
      this.steersSettled.delete(rt);
      settle();
      release();
      if (drainOnRelease && !rt.turnActive && rt.queue.length && this.stopsOf(rt) === stops) this.pendingDrains.add(rt);
      this.resumeDrain(rt);
    }
  }

  private async deliverQueued(rt: SessionRuntime, id: string, caller?: CallContext, steerNow?: () => void) {
    const recovery = this.reading.get(rt.id);
    if (recovery) {
      const stops = this.stopsOf(rt);
      await recovery;
      still(caller);
      if (this.disposed || this.sessions.get(rt.id) !== rt || this.stopsOf(rt) !== stops) throw new NotNow('The chat was stopped or closed.');
    }
    const waiting = rt.queue.find(q => q.id === id);
    if (waiting?.issuedUuid && caller) {
      if (rt.handle?.stillQueued?.(waiting.issuedUuid)) {
        rt.queueReason(id, 'Claude still has this input queued.');
        return false;
      }
      const { provider, accountId, providerSessionId } = rt.meta;
      const uuid = waiting.issuedUuid;
      const stops = this.stopsOf(rt);
      await this.restoreSteerReceipts(rt, uuid);
      still(caller);
      if (this.disposed || this.sessions.get(rt.id) !== rt || this.stopsOf(rt) !== stops) throw new NotNow('The chat was stopped or closed.');
      if (rt.meta.provider !== provider || rt.meta.accountId !== accountId || rt.meta.providerSessionId !== providerSessionId) {
        rt.queueReason(id, 'The destination changed. Review the message and send again.');
        return false;
      }
      if (this.steerReads.get(rt)?.has(uuid)) {
        rt.queueReason(id, 'Still checking the original Claude receipt. Try again when the check finishes.');
        return false;
      }
      if (rt.queue.find(q => q.id === id) !== waiting || waiting.issuedUuid !== uuid) {
        const current = rt.queue.find(q => q.id === id);
        if (current && current !== waiting) rt.queueReason(id, 'The message changed during the receipt check. Review it and send again.');
        return !current && rt.get<UserItem>(id)?.state === 'sent';
      }
    }
    const reserved = rt.reserveQueued(id);
    if (!reserved) {
      if (caller) rt.queueReason(id, 'Another action holds this message. Try again when it finishes.');
      return false;
    }
    const entry = reserved.message;
    if (entry.issuedUuid && !caller) {
      rt.rollbackReserved(id);
      return false;
    }
    if (entry.issuedUuid && (entry.issuedTo?.stillQueued || rt.handle?.stillQueued?.(entry.issuedUuid))) {
      rt.rollbackReserved(id);
      rt.queueReason(id, 'Claude still has this input queued.');
      return false;
    }
    const sender = entry.phoneSender && entry.phoneSender.kind !== 'web' && caller && !caller.allowed && !steerNow ? undefined : this.senderGuard(entry.phoneSender, rt.id) ?? (rt.transientQueueGuards.has(id) ? { allowed: rt.transientQueueGuards.get(id) } : undefined);
    const guard = sender?.allowed && caller?.allowed ? { ...sender, allowed: () => sender.allowed!() && caller.allowed!() } : sender ?? caller;
    try {
      still(guard);
      if (await this.deliver(rt, entry.text, entry.attachments, { id, until: entry.until, submitPrint: entry.submitPrint, steerOrder: entry.steerOrder, ...(entry.issuedUuid || entry.steerAttempts ? { ts: entry.createdAt, steerAttempts: entry.steerAttempts ?? 1 } : {}), ...(steerNow && { steerNow, ts: entry.createdAt, steerAttempts: (entry.steerAttempts ?? 0) + 1 }) }, guard, !!caller) === 'queued') {
        rt.rollbackReserved(id);
        return true;
      }
    } catch (err) {
      rt.rollbackReserved(id);
      throw err;
    }
    const delivered = this.takeReserved(rt, id, reserved.rev);
    if (delivered && caller) await rt.persistInput?.();
    return !!delivered;
  }

  /** Commit ownership before a paired phone's first SDK write, even for an idle chat. */
  private async acceptPhoneInput(rt: SessionRuntime, id: string, text: string, attachments: UserItem['attachments'], ctx: CallContext, wait: boolean) {
    const stops = this.stopsOf(rt);
    this.enqueueSubmission = { rt, id };
    let entry: QueuedMessage;
    try { entry = rt.enqueue(text, attachments, ctx.phoneSender); }
    finally { this.enqueueSubmission = undefined; }
    if (!wait) {
      entry.byHand = true;
      rt.queueReason(id, 'Delivery was not confirmed. Review before sending again.');
    }
    const staged = rt.reserveQueued(id);
    if (!staged) throw new NotNow('The waiting message has changed.');
    try {
      await rt.persistInput!();
      if (this.disposed || this.sessions.get(rt.id) !== rt) throw new NotNow('The chat was closed.');
      this.phoneReceipts.record(rt.id, id);
    } catch (err) {
      // A refused admission must not leave an unindexed copy free to drain behind the phone's retry.
      if (!this.disposed && this.sessions.get(rt.id) === rt && this.takeReserved(rt, id, staged.rev)) await rt.persistInput!();
      throw err;
    } finally { rt.rollbackReserved(id); }
    if (wait) {
      if (this.stopsOf(rt) === stops && !this.steerEnds.has(rt)) rt.unreadQueueHeld = false;
    } else if (stops === this.stopsOf(rt)) {
      const sender = this.senderGuard(ctx.phoneSender, rt.id);
      try {
        if (await this.deliverQueued(rt, id, sender) && rt.queue.includes(entry)) {
          // The live dispatch deferred to a move or hold before reaching the agent.
          delete entry.byHand;
          delete entry.steerWait;
          rt.updateQueued(id, entry.text);
          rt.onQueueRunnable?.();
        }
      } catch (err) {
        rt.queueReason(id, (err as Error).message);
      }
    }
    await rt.persistInput!();
    return { ok: true, ...(rt.queue.some(q => q.id === id) && { queued: true }) };
  }

  /** A phone's take of a queued message went through (phone.ts): it leaves the queue if it is still the one reserved. */
  takeReserved(rt: SessionRuntime, id: string, rev: number) {
    const message = rt.commitReserved(id, rev);
    if (message) this.spare.queueChanged(rt);
    return message;
  }

  /** A child that missed the move deadline may still own its account's transcript. */
  private writers = new WeakMap<SessionRuntime, Map<string, () => Promise<void>>>();

  private detachWriter(rt: SessionRuntime, reason: 'switch' | 'close' = 'close') {
    const handle = rt.handle;
    rt.handle = undefined;
    const account = rt.meta.accountId ?? DEFAULT_ACCOUNT;
    return handle ? this.closeWriter(rt, account, handle, rt.meta.provider, reason) : this.confirmWriter(rt, account);
  }

  private closeWriter(rt: SessionRuntime, account: string, handle: ProviderSession, provider = rt.meta.provider, reason: 'close' | 'switch' | 'limit' | 'move' = 'close') {
    const writers = this.writers.get(rt) ?? new Map<string, () => Promise<void>>();
    this.writers.set(rt, writers);
    let closing: Promise<void> | undefined;
    writers.set(accountKey(provider, account), async () => {
      // Share an in-flight close. A rejected close or exit check can be retried on the same handle.
      closing ??= handle.close(reason).catch(err => { closing = undefined; throw err; });
      await closing;
      await handle.exited?.();
    });
    return this.confirmWriter(rt, account, provider);
  }

  private async confirmWriter(rt: SessionRuntime, account: string, provider = rt.meta.provider) {
    const writers = this.writers.get(rt);
    const key = accountKey(provider, account);
    const confirm = writers?.get(key);
    if (!writers || !confirm) return;
    if (!await boundedBy(confirm().then(() => true, () => false), MOVE_CLOSE_MS, false)) throw new NotNow('The old process has not confirmed its exit.');
    if (writers.get(key) === confirm) writers.delete(key);
  }

  /** Includes work admitted before a provider has published its first turn or task. */
  get preparingWork() {
    return !!(this.journal.busy || this.sending.size || this.dispatching.size || this.opening.size || this.switching.size ||
      this.moving.size || this.firstInputs.size || this.limitDecisions.size || this.bgLimits.size);
  }

  private async ensureHandle(rt: SessionRuntime, forMove = false, reportDeadline?: number) {
    const closes = this.closesOf(rt);
    const closed = () => this.disposed || this.sessions.get(rt.id) !== rt || this.closesOf(rt) !== closes ||
      reportDeadline !== undefined && Date.now() >= reportDeadline;
    if (this.lazy.has(rt.id)) await this.hydrateAsync(rt);
    for (let tries = 0; ; tries++) {
      if (closed()) throw new NotNow('The chat was closed.');
      if (rt.handle) return rt.handle;
      if (!forMove && this.moving.has(rt.id)) throw new NotNow('The chat is moving to another account.');
      const agent = rt.meta.provider;
      const account = rt.meta.accountId ?? DEFAULT_ACCOUNT;
      // Either wait can change the checkout. A lane operation must be able to release the old
      // writer without waiting for the provider start that depends on it.
      if (this.writers.get(rt)?.has(accountKey(agent, account))) await this.confirmWriter(rt, account, agent);
      if (rt.meta.lane) await this.lanes.ready(rt);
      if (closed()) throw new NotNow('The chat was closed.');
      const opening = this.opening.get(rt.id);
      if (opening) {
        await opening;
        continue;
      }
      if (rt.handle) return rt.handle;
      if (!forMove && this.moving.has(rt.id)) throw new NotNow('The chat is moving to another account.');
      if (agent !== rt.meta.provider || account !== (rt.meta.accountId ?? DEFAULT_ACCOUNT)) continue;
      const cwd = rt.meta.cwd;
      const ready = this.provider(agent, account).open(rt, { loadTranscript: false });
      const opened = ready
        .then((handle) => {
          if (closed()) {
            void this.closeWriter(rt, account, handle, agent).catch(() => {});
            throw new Error('The session was closed while the agent was starting.');
          }
          if (rt.meta.cwd !== cwd || rt.meta.provider !== agent || (rt.meta.accountId ?? DEFAULT_ACCOUNT) !== account) {
            void this.closeWriter(rt, account, handle, agent).catch(() => {});
            return;
          }
          rt.handle = handle;
          this.seedCaps(rt);
        });
      const openingWait = reportDeadline === undefined ? opened : withDeadline(opened, Math.max(1, reportDeadline - Date.now()), 'Opening the report destination');
      this.opening.set(rt.id, openingWait);
      try {
        await openingWait;
      } finally {
        if (this.opening.get(rt.id) === openingWait) this.opening.delete(rt.id);
        this.scheduleLossWake(rt);
      }
      if (rt.handle) return rt.handle;
      if (tries >= 2) throw new Error('The chat changed account or agent while its agent was starting.');
    }
  }

  /** Shows what the agent offers right away from the cache; the adapter's own answer replaces it. */
  private seedCaps(rt: SessionRuntime) {
    const cached = this.cachedCaps(rt.meta.provider, rt.meta.accountId ?? DEFAULT_ACCOUNT, rt.meta.cwd);
    if (!cached) return;
    if (!rt.caps) return rt.setCaps(cached);
    // Codex's MCP inventory (and so its browser / computer-use plugin) arrives much later.
    if (rt.meta.provider === 'codex' && !rt.caps.mcpServers.length && cached.mcpServers.length) {
      const f = cached.features;
      rt.setCaps({ ...rt.caps, mcpServers: cached.mcpServers, features: { ...rt.caps.features, browser: f.browser, computerUse: f.computerUse, linkedBrowserComputer: f.linkedBrowserComputer } });
    }
  }

  private persistSessions() {
    this.store.state.sessions = [...[...this.sessions.values()].map((r) => r.meta), ...this.hidden];
    this.store.saveState();
  }

  /** The sidebar's arrangement changed: folders, projects and the chats group's place, in one event. */
  private emitProjects() {
    const st = this.store.state;
    this.emit({ type: 'projects.updated', projects: st.projects, groups: st.groups ?? [], chatsOrder: st.chatsOrder });
  }

  /** A place above every top entry of the manual order (loose folders, projects, the chats group): where a new one goes. */
  private topPlace(): number {
    const st = this.store.state;
    let min = Infinity;
    for (const p of st.projects) if (!this.groupOf(p) && typeof p.order === 'number' && p.order < min) min = p.order;
    for (const g of st.groups ?? []) if (g.order < min) min = g.order;
    if (typeof st.chatsOrder === 'number' && st.chatsOrder < min) min = st.chatsOrder;
    return Number.isFinite(min) ? min - 1 : 0;
  }

  /** The project a folder belongs to, when that project still exists. */
  private groupOf(p: Project): FolderGroup | undefined {
    return p.group ? this.store.state.groups?.find((g) => g.id === p.group) : undefined;
  }

  /** Where lanes' worktrees go: the chosen folder, else `<Sable home>/lanes` (`worktreesRoot`). */
  worktreesRoot(): string {
    return worktreesRoot(this.store.state.settings.worktreesFolder, this.userHome, this.store.dir);
  }

  /** Where chats without a folder get their folders: the chosen place, else D:\Sable chats or ~/Sable chats. */
  chatsRoot(): string {
    const chosen = this.store.state.settings.chatsFolder?.trim();
    return chosen ? path.resolve(chosen.replace(/^~(?=$|[\\/])/, this.userHome)) : defaultChatsRoot(this.userHome);
  }

  private findProject(dir: string): Project | undefined {
    const key = path.resolve(dir).toLowerCase();
    return this.store.state.projects.find((x) => path.resolve(x.path).toLowerCase() === key);
  }

  /** A folder opened or used: known from now on, back in the sidebar if it was removed, a new one on top of the manual order. */
  private touchProject(dir: string): Project {
    const projects = this.store.state.projects;
    const key = path.resolve(dir);
    let p = this.findProject(key);
    if (!p) {
      p = { path: key, name: path.basename(key) || key, lastOpened: Date.now(), order: this.topPlace() };
      projects.push(p);
    } else {
      p.lastOpened = Date.now();
      // Opened again after it was removed: it comes back with its sessions, on top (or in its project).
      if (p.hidden) {
        delete p.hidden;
        if (!this.groupOf(p)) p.order = this.topPlace();
      }
    }
    this.store.saveState();
    this.emitProjects();
    return p;
  }

  /** A folder known only through its sessions, made a project (no event: the caller sends one). */
  private touchProjectQuiet(dir: string): Project {
    const key = path.resolve(dir);
    const p: Project = { path: key, name: path.basename(key) || key, lastOpened: 0 };
    this.store.state.projects.push(p);
    return p;
  }

  /**
   * Gives every folder a place in the manual order the first time (profiles from before it):
   * the order the sidebar showed until now, pinned first, then by last activity.
   */
  private seedFolderOrder() {
    const projects = this.store.state.projects;
    const seen = new Set(projects.map((p) => path.resolve(p.path).toLowerCase()));
    // Folders known only through their sessions become projects, so they can be ordered and removed
    // (a chat's own folder is not one: chats sit together in the chats group).
    for (const s of this.store.state.sessions) {
      if (s.chat) continue;
      // A chat in a lane belongs to the folder it came from, never to the lane.
      const key = path.resolve(s.lane?.folder ?? s.cwd);
      if (seen.has(key.toLowerCase())) continue;
      seen.add(key.toLowerCase());
      projects.push({ path: key, name: path.basename(key) || key, lastOpened: 0 });
    }
    if (projects.every((p) => typeof p.order === 'number')) return;
    const last = new Map<string, number>();
    for (const s of this.store.state.sessions) {
      if (s.archived) continue;
      const k = path.resolve(s.lane?.folder ?? s.cwd).toLowerCase();
      last.set(k, Math.max(last.get(k) ?? 0, s.updatedAt));
    }
    const activity = (p: Project) => Math.max(p.lastOpened, last.get(path.resolve(p.path).toLowerCase()) ?? 0);
    const ordered = projects.filter((p) => typeof p.order === 'number').sort((a, b) => a.order! - b.order!);
    const fresh = projects.filter((p) => typeof p.order !== 'number').sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : activity(b) - activity(a)));
    [...ordered, ...fresh].forEach((p, i) => (p.order = i));
    this.store.saveState();
  }

  async state(settled = false): Promise<AppState> {
    const providers = await Promise.all([...this.providers.values()].map((p) => (settled ? this.providerInfoSettled(p.id) : this.providerInfoFast(p.id)).catch(() => fallbackInfo(p))));
    return {
      snapshotThreshold: SNAPSHOT_THRESHOLD,
      version: VERSION,
      platform: process.platform,
      home: homedir(),
      dataDir: this.store.dir,
      providers,
      projects: this.store.state.projects,
      sessions: [...this.sessions.values()].map((r) => r.meta),
      settings: this.store.state.settings,
      groups: this.store.state.groups ?? [],
      chatsOrder: this.store.state.chatsOrder,
      chatsDefault: defaultChatsRoot(this.userHome),
      worktreesDefault: worktreesRoot(undefined, this.userHome, this.store.dir),
      // Read last, after the awaits: every later change reaches the window as an event.
      prompts: pendingPrompts(this.sessions.values()),
      ...(this.updates ? { update: this.updates.state } : {}),
    };
  }

  /**
   * Ends whatever the session is doing and lets its agent go, so its folder can be removed: its turn,
   * a message still waiting for the agent to start, an until loop, a turn check. The chat stays.
   */
  private async stopForGood(rt: SessionRuntime) {
    if (this.lazy.has(rt.id)) await this.hydrateAsync(rt);
    this.closed(rt);
    this.until.closed(rt);
    await this.checks.closed(rt);
    rt.stopRequested = true;
    rt.cancelPrompts();
    const waiting = this.earlyWaiting.get(rt.id);
    if (waiting?.length) {
      for (const id of waiting) this.stoppedEarly.add(id);
      this.earlyWaiting.delete(rt.id);
    }
    await this.opening.get(rt.id)?.catch(() => {});
    await this.detachWriter(rt);
    if (rt.turnActive) {
      rt.settle('cancelled');
      rt.endTurn();
    } else if (rt.meta.status !== 'idle' && rt.meta.status !== 'error') rt.update({ status: 'idle', activity: undefined });
  }

  /**
   * Who races in `cwd`: Claude Code against Codex where both are installed and signed in (last
   * known), each with its default model and the account new chats of that agent use; else two
   * models of the one agent that is (the Demo when asked for, or when no real agent is there).
   */
  private async raceContenders(cwd: string, hint?: ProviderId): Promise<Contender[] | { error: string }> {
    const settings = this.store.state.settings;
    // Who is signed in is read from the agents' last answers: a first answer still on its way counts.
    await this.firstWord();
    const signedIn = this.otherAgents();
    const pick: ProviderId[] = hint === 'demo' && this.providers.has('demo') ? ['demo'] : signedIn.length ? signedIn.slice(0, 2) : this.providers.has('demo') ? ['demo'] : [];
    if (!pick.length) return { error: 'Sign in to Claude Code or Codex to race.' };
    const name = (id: ProviderId) => this.providers.get(id)?.name ?? id;
    if (pick.length === 2) return pick.map((id) => ({ provider: id, model: settings.defaultModels[id] ?? '', accountId: this.defaultAccountId(id), label: name(id), slug: id }));
    // One agent: its default model against the next one its own picker offers.
    const id = pick[0];
    const accountId = this.defaultAccountId(id);
    const caps = await this.call('provider.caps', { provider: id, cwd, ...(accountId === DEFAULT_ACCOUNT ? {} : { accountId }) }).catch(() => undefined);
    const models = (caps?.models ?? []).filter((m) => m.picker !== false);
    const firstId = settings.defaultModels[id] || models.find((m) => m.isDefault)?.id || models[0]?.id;
    const first = models.find((m) => m.id === firstId) ?? models[0];
    const head = (m: { name: string; description?: string }) => (m.description?.split(/\s+·\s+/)[0] ?? m.name).toLowerCase();
    const second = first && models.find((m) => m.id !== first.id && m.name !== first.name && head(m) !== head(first));
    if (!first || !second) return { error: `${name(id)} offers one model here, so there is nothing to race.` };
    const side = (m: { id: string; name: string }): Contender => ({ provider: id, model: m.id, accountId, label: m.name, slug: laneSlug(m.name, 14) || m.id });
    return [side(first), side(second)];
  }

  /**
   * A new session (`session.create`). `lane`: it starts in a lane of its own, made before its agent
   * starts, whatever the folder's state (a race); when the lane cannot be made the session is removed
   * and this rejects.
   */
  /** A new session with what `session.create` cannot ask for (the Customize chat, `services/custom.ts`). */
  startSession(p: RpcMethods['session.create']['params'], extra: { custom?: boolean } = {}): Promise<SessionSnapshot> {
    return this.createSession(p, extra);
  }

  private async createSession(p: RpcMethods['session.create']['params'], extra: { lane?: { slug: string; detail?: string }; custom?: boolean; fork?: { source: string; items: TimelineItem[]; chainFrom?: string } } = {}, ctx?: CallContext): Promise<SessionSnapshot> {
    if (!this.registryReady()) throw new Error('Sable could not read your saved chats and settings.');
    const settings = this.store.state.settings;
    let accountId = p.accountId ?? this.defaultAccountId(p.provider);
    this.provider(p.provider, accountId);
    // An account past its cap: the session starts on the next one under its own (a resumed
    // conversation stays where it lives).
    const capStart = p.resume ? undefined : await this.underCapStart(p.provider, accountId, p.model ?? settings.defaultModels[p.provider], p.cwd).catch(() => undefined);
    // Its caller (a phone) removed while that was read: no chat, no folder.
    still(ctx);
    if (capStart) accountId = capStart.to;
    const provider = this.provider(p.provider, accountId);
    // A chat without a folder gets a fresh folder of its own under the chats folder.
    const cwd = p.chat ? makeChatFolder(this.chatsRoot(), p.chat.text) : p.cwd;
    // The demo provider plays scripted sessions in made-up folders; real agents need a real one.
    if (p.provider !== 'demo' && !isDir(path.resolve(cwd))) throw new Error(`Folder not found: ${path.resolve(cwd)}`);
    const now = Date.now();
    const meta: SessionMeta = {
      id: randomUUID(),
      provider: p.provider,
      providerSessionId: p.resume,
      cwd: path.resolve(cwd),
      title: p.title ?? 'New session',
      titleSource: p.title ? 'user' : 'auto',
      model: p.model ?? settings.defaultModels[p.provider] ?? '',
      effort: p.effort ?? settings.defaultEfforts[p.provider],
      mode: p.mode ?? settings.defaultModes[p.provider] ?? 'default',
      ...(p.ultracode ? { ultracode: true } : {}),
      ...this.startSpeed(p.provider, accountId, cwd, p.model ?? settings.defaultModels[p.provider], p.speed ?? settings.defaultSpeeds?.[p.provider]),
      ...(p.chat ? { chat: true } : {}),
      // The Customize chat lives in Sable's own folder, never one of the sidebar's folders.
      ...(extra.custom ? { custom: true, chat: true } : {}),
      status: 'starting',
      createdAt: now,
      updatedAt: now,
      usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
    };
    if (accountId !== DEFAULT_ACCOUNT) meta.accountId = accountId;
    const options = withDefaultOptions(p.provider, p.options ?? settings.sessionOptions?.[p.provider]);
    if (options && Object.keys(options).length) meta.options = { ...options };
    const rt = this.makeRuntime(meta);
    if (extra.fork) {
      try {
        const file = await this.store.copySession(extra.fork.source, rt.id, extra.fork.items);
        rt.loadRestored(file.items, file.todos);
        this.store.bindProviderInputs(rt.id, rt.items);
      } catch (err) {
        this.store.deleteSession(rt.id);
        throw err;
      }
    }
    this.sessions.set(meta.id, rt);
    if (capStart) rt.notice('info', capStart.line);
    // Continue in the other agent: the first message carries a compact account of the source
    // conversation (read from Sable's timeline; the source and its transcript stay untouched).
    const source = p.handoverFrom ? this.sessions.get(p.handoverFrom) : undefined;
    if (source) {
      await this.hydrateAsync(source);
      const summary = handoverText(withoutChecks(source.items), { from: this.provider(source.meta.provider, source.meta.accountId ?? DEFAULT_ACCOUNT).name });
      if (summary) {
        this.handovers.set(meta.id, summary);
        rt.notice('info', `Continued from ${source.meta.title}`, 'It starts with a summary of that conversation');
      }
    }
    // A chat's own folder is not one of the sidebar's folders; the chats group, new, goes on top.
    if (!meta.chat) this.touchProject(meta.cwd);
    else if (typeof this.store.state.chatsOrder !== 'number') {
      this.store.state.chatsOrder = this.topPlace();
      this.store.saveState();
      this.emitProjects();
    }
    this.emit({ type: 'session.added', session: meta });
    // A race: the lane is there before the agent starts in it, or there is no session.
    if (extra.lane) {
      const made = await this.lanes.enterNow(rt, extra.lane.slug, extra.lane.detail).catch((err: Error) => ({ ok: false, error: err.message }));
      if (!made.ok) {
        this.sessions.delete(meta.id);
        this.store.deleteSession(meta.id);
        this.emit({ type: 'session.removed', id: meta.id });
        this.persistSessions();
        throw new Error(made.error ?? 'Could not make the lane.');
      }
    }
    // A folder another session is working in: the session starts in a lane of its own.
    const closes = this.closesOf(rt);
    const findingAgents = this.asking.size > 0;
    const laneReady = this.lanes.atStart(rt, p.title ?? p.chat?.text);
    // A fresh Codex thread fixes its tools at thread/start. While the agents are
    // still checking in, let the first send open it through ensureHandle.
    if (findingAgents && p.provider === 'codex' && !p.resume && !extra.fork) {
      const ready = laneReady.then(() => { if (!rt.turnActive) rt.update({ status: 'idle' }); });
      this.opening.set(rt.id, ready);
      void ready.catch(err => rt.update({ status: 'error', lastError: String(err) })).finally(() => {
        if (this.opening.get(rt.id) === ready) this.opening.delete(rt.id);
        this.scheduleLossWake(rt);
      });
      this.persistSessions();
      return rt.snapshot();
    }
    const opened = laneReady.then(() => {
      if (this.disposed || this.closesOf(rt) !== closes) throw new NotNow('The chat was closed.');
      return provider.open(rt, { loadTranscript: !!p.resume && !extra.fork, chainFrom: extra.fork?.chainFrom });
    }).then(
      (handle) => {
        // Closed while it was starting: let the agent go.
        if (this.disposed || this.sessions.get(rt.id) !== rt || this.closesOf(rt) !== closes) return this.closeWriter(rt, accountId, handle, p.provider).catch(() => {});
        rt.handle = handle;
        if (!this.delivering.has(rt.id)) rt.update({ status: 'idle' });
        this.seedCaps(rt);
        if (p.provider === 'claude' && meta.options?.remoteControl) void handle.setOptions?.(meta.options).catch((err) => rt.notice('error', 'Remote Control could not start', (err as Error).message));
      },
      (err) => rt.update({ status: 'error', lastError: (err as Error).message }),
    );
    this.opening.set(rt.id, opened);
    void opened.finally(() => {
      if (this.opening.get(rt.id) === opened) this.opening.delete(rt.id);
      this.scheduleLossWake(rt);
      this.persistSessions();
      // A chat started with `/spare` from home waited for its agent to be there.
      if (rt.meta.spare) this.spare.poke();
    });
    // A slow start answers early (status "starting"): the UI opens the session and the first
    // message shows at once, waiting in deliver() for the agent.
    let timer: NodeJS.Timeout | undefined;
    if (!findingAgents) await Promise.race([opened, new Promise<void>((r) => (timer = setTimeout(r, 1500)))]);
    clearTimeout(timer);
    this.persistSessions();
    return rt.snapshot();
  }

  private registerCore() {
    this.register('app.hello', async (_params, ctx) => {
      bootMark('hello:asked');
      const state = await this.state(ctx.settled);
      bootMark('hello:answered');
      return state;
    });

    this.register('app.setSettings', ({ patch: raw }) => {
      // Backdrop images change only through backdrop.*; the config is always checked.
      const { backdropImages: _images, ...patch } = raw;
      if (patch.steerAfterMs !== undefined && (!Number.isSafeInteger(patch.steerAfterMs) || patch.steerAfterMs < 0)) throw new Error('The steer delay must be a nonnegative whole number of milliseconds.');
      if (patch.backdropConfig) patch.backdropConfig = normalizeBackdrop(patch.backdropConfig, this.store.state.settings.backdropImages.map((i) => i.id));
      this.store.state.settings = { ...this.store.state.settings, ...patch };
      this.store.saveState();
      this.emit({ type: 'settings.updated', settings: this.store.state.settings });
      if ('notifyLimitReset' in patch || 'returnToPreferred' in patch) this.scheduleResetAlert();
      // A cap changed: what Spare may use changed with it.
      if ('accountCaps' in patch && this.spare.hasWaits()) this.spare.poke(300);
      // Which account is the default shows on every account.
      if (patch.defaultAccounts || 'returnToPreferred' in patch) for (const id of this.providers.keys()) void this.emitProvider(id).catch(() => {});
      return this.store.state.settings;
    });

    // ── auth ──
    this.register('auth.journal', ({ limit }) => this.journal.lines(limit));
    this.register('auth.refresh', ({ provider, accountId = DEFAULT_ACCOUNT }) => {
      this.provider(provider, accountId);
      this.accountUse.set(accountKey(provider, accountId), Date.now());
      return this.emitProvider(provider, accountId);
    });
    // The code a browser showed instead of returning to Sable: it finishes the sign-in in progress.
    this.register('auth.code', async ({ provider, accountId = DEFAULT_ACCOUNT, code }) => {
      const p = this.provider(provider, accountId);
      if (!p.submitLoginCode) return { ok: false, error: 'This agent finishes its sign-in in the browser.' };
      try {
        await p.submitLoginCode(String(code ?? ''));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message || 'The code did not work. Start the sign-in again.' };
      }
    });
    this.register('auth.login', async ({ provider, accountId = DEFAULT_ACCOUNT }) => {
      const p = this.provider(provider, accountId);
      const key = accountKey(provider, accountId);
      if (this.logins.has(key)) return { started: true };
      this.accountUse.set(key, Date.now());
      let waiting = true;
      const flow = { cancel: async (timeout: boolean) => {
        if (!waiting) return;
        waiting = false;
        clearTimeout(timer);
        this.emit({ type: 'auth.progress', provider, accountId, state: timeout ? 'timeout' : 'cancelled' });
        try { await p.cancelLogin(); }
        finally { if (this.logins.get(key) === flow) this.logins.delete(key); }
      } };
      this.logins.set(key, flow);
      // A sign-in nobody finishes in the browser is given up, so the flow never hangs on "waiting".
      const timer = setTimeout(() => void flow.cancel(true).catch(() => {}), this.loginTimeoutMs);
      timer.unref?.();
      this.emit({ type: 'auth.progress', provider, accountId, state: 'started' });
      void p
        .login()
        .then(async () => {
          if (!waiting) return;
          waiting = false;
          clearTimeout(timer);
          this.cache.set(`signin:${key}`, undefined);
          this.infoCache.delete(key);
          this.authRetryAt.delete(key);
          this.forgetLimits(provider, accountId);
          this.journal.record({ agent: provider, accountId }, { event: 'signed-in' });
          this.logins.delete(key);
          this.emit({ type: 'auth.progress', provider, accountId, state: 'done' });
          await this.emitProvider(provider, accountId, true);
        })
        .catch((err: Error) => {
          if (waiting) this.emit({ type: 'auth.progress', provider, accountId, state: 'error', message: err.message ?? String(err) });
        })
        .finally(() => {
          clearTimeout(timer);
          if (this.logins.get(key) === flow) this.logins.delete(key);
        });
      return { started: true };
    });
    this.register('auth.cancel', async ({ provider, accountId = DEFAULT_ACCOUNT }) => {
      await this.logins.get(accountKey(provider, accountId))?.cancel(false);
      return { ok: true };
    });
    this.register('auth.logout', async ({ provider, accountId = DEFAULT_ACCOUNT }) => {
      await this.provider(provider, accountId).logout();
      this.earlyResetRead.delete(accountKey(provider, accountId));
      limitsAfterTurn.delete(this.provider(provider, accountId));
      this.limitsCache.delete(accountKey(provider, accountId));
      return this.emitProvider(provider, accountId);
    });

    // ── accounts ──
    this.register('account.add', async ({ provider, label }) => {
      this.provider(provider); // throws when the provider is not available
      const id = randomUUID().replace(/-/g, '').slice(0, 10);
      mkdirSync(this.accountDir(provider, id), { recursive: true });
      const named = label?.trim().slice(0, 60);
      this.store.state.accounts.push({ id, provider, label: named || this.nextLabel(provider), createdAt: Date.now(), ...(named ? {} : { autoLabel: true }) });
      this.store.saveState();
      const info = await this.emitProvider(provider);
      return { ...info, account: info.accounts!.find((a) => a.id === id)! };
    });
    this.register('account.addExisting', async ({ provider, dir, label }) => {
      this.provider(provider);
      const abs = path.resolve(dir.trim().replace(/^~(?=$|[\\/])/, this.userHome));
      if (!isDir(abs)) throw new Error(`Folder not found: ${abs}`);
      const folder = gateKey(provider, abs);
      const taken = this.accountList(provider).find((a) => a.id !== DEFAULT_ACCOUNT && gateKey(provider, this.accountDir(provider, a.id)) === folder);
      if (taken) throw new Error(`That folder is already the account ${taken.label}.`);
      const standard = path.join(this.userHome, provider === 'codex' ? '.codex' : '.claude');
      if (folder === gateKey(provider, this.provider(provider).configHome?.() ?? standard) || folder === gateKey(provider, standard)) throw new Error('That folder is the built-in account.');
      const id = randomUUID().replace(/-/g, '').slice(0, 10);
      this.store.state.accounts.push({ id, provider, label: label?.trim().slice(0, 60) || folderLabel(provider, abs), createdAt: Date.now(), dir: abs });
      this.store.saveState();
      // Its sign-in comes from the CLI, asked now.
      const info = await this.emitProvider(provider, id);
      return { ...info, account: info.accounts!.find((a) => a.id === id)! };
    });
    this.register('account.folders', ({ provider }) => {
      const known = this.accountList(provider)
        .filter((a) => a.id !== DEFAULT_ACCOUNT)
        .map((a) => this.accountDir(provider, a.id));
      return findAccountFolders(provider, this.userHome, known);
    });
    this.register('account.rename', ({ provider, accountId, label }) => {
      const acc = this.findAccount(provider, accountId);
      if (!acc) throw new Error('Account not found');
      const name = label.trim().slice(0, 60);
      if (name) {
        acc.label = name;
        // The built-in account is stored once it has a name of its own.
        if (!this.store.state.accounts.includes(acc)) this.store.state.accounts.push(acc);
        this.store.saveState();
      }
      return this.emitProvider(provider);
    });
    this.register('account.reorder', ({ provider, ids }) => {
      const known = new Set(this.accountList(provider).map((a) => a.id));
      const order = [...new Set(ids)].filter((id) => known.has(id));
      const s = this.store.state.settings;
      s.accountOrder = { ...s.accountOrder, [provider]: order };
      this.store.saveState();
      return this.emitProvider(provider);
    });
    this.register('account.remove', async ({ provider, accountId }) => {
      if (accountId === DEFAULT_ACCOUNT) throw new Error('The default account cannot be removed');
      const stored = this.findAccount(provider, accountId);
      if (!stored) throw new Error('Account not found');
      const external = !!stored.dir;
      const mine = [...this.sessions.values()].filter((rt) => rt.meta.provider === provider && rt.meta.accountId === accountId);
      const busy = mine.filter((rt) => rt.meta.status === 'running' || rt.meta.status === 'awaiting' || rt.meta.status === 'starting');
      if (busy.length) throw new Error(busy.length === 1 ? 'A session with this account is still working. Stop it first.' : `${busy.length} sessions with this account are still working. Stop them first.`);
      // A chat on its way here (a big one compacts first, which takes a while) would arrive on an account that is gone.
      const key = accountKey(provider, accountId);
      if (this.movingTo.get(key)) throw new Error('A chat is moving to this account or still using it during a move. Remove it when the move is done.');
      // Held the other way round too: no move to it begins while its agents are closed below.
      this.removingAccounts.add(key);
      try {
        for (const rt of mine) {
          rt.cancelPrompts();
          await this.detachWriter(rt);
        }
        const inst = this.instances.get(key);
        this.instances.delete(key);
        if (inst) {
          await inst.cancelLogin().catch(() => {});
          await inst.dispose().catch(() => {});
        }
      } finally {
        this.removingAccounts.delete(key);
      }
      this.infoCache.delete(key);
      this.authRetryAt.delete(key);
      this.limitsCache.delete(key);
      this.earlyResetRead.delete(key);
      this.limitsToastAt.delete(key);
      this.store.state.accounts = this.store.state.accounts.filter((a) => !(a.provider === provider && a.id === accountId));
      const defaults = this.store.state.settings.defaultAccounts;
      if (defaults?.[provider] === accountId) {
        const next = { ...defaults };
        delete next[provider];
        this.store.state.settings = { ...this.store.state.settings, defaultAccounts: next };
        this.emit({ type: 'settings.updated', settings: this.store.state.settings });
      }
      this.store.saveState();
      // A folder the user brought is only forgotten; Sable's own folder for the account is deleted.
      if (!external) this.removeAccountDir(provider, accountId);
      return this.emitProvider(provider);
    });

    this.register('provider.caps', ({ provider, cwd, accountId, refresh }) => this.capsFast(provider, cwd, accountId, refresh));
    this.register('provider.prewarm', (p) => this.prewarm(p));
    this.register('provider.limits', async ({ provider, accountId = DEFAULT_ACCOUNT, force }) => {
      if (force) {
        this.provider(provider, accountId);
        this.accountUse.set(accountKey(provider, accountId), Date.now());
      }
      return (await this.readLimits(provider, accountId, !!force, { feedback: !!force })).limits;
    });
    // Spends a reset credit: only the confirmed click in the UI calls this, never anything automatic.
    this.register('provider.useReset', async ({ provider, accountId = DEFAULT_ACCOUNT, key }) => {
      const p = this.provider(provider, accountId);
      if (!p.useReset) throw new Error('This agent has no resets');
      if (!key || typeof key !== 'string') throw new Error('Missing reset key');
      return { outcome: await p.useReset(key) };
    });

    // A reset in the agent's own dialog: only the person's click opens it; the person confirms there.
    this.register('limit.resetInAgent', async ({ provider, accountId = DEFAULT_ACCOUNT }) => {
      const p = this.provider(provider, accountId);
      if (!p.limitResetCommand) return { ok: false, error: 'This agent has no reset dialog' };
      if (!this.consoles) return { ok: false, error: `Run ${p.limitResetCommand().line} in a terminal` };
      return this.resets.start(provider, accountId);
    });
    this.register('limit.resetCancel', ({ provider, accountId = DEFAULT_ACCOUNT }) => ({ ok: this.resets.cancel(provider, accountId) }));

    // ── projects ──
    this.register('project.add', ({ path: dir }) => {
      if (!isDir(path.resolve(dir))) throw new Error(`Not a folder: ${path.resolve(dir)}`);
      return this.touchProject(dir);
    });
    // A folder with sessions is hidden with them (nothing is deleted); one without any is forgotten.
    this.register('project.remove', ({ path: dir }) => {
      const key = path.resolve(dir).toLowerCase();
      const used = [...this.sessions.values()].some((r) => path.resolve(r.meta.cwd).toLowerCase() === key);
      const p = this.findProject(dir);
      if (used) {
        if (p) p.hidden = true;
        else this.store.state.projects.push({ path: path.resolve(dir), name: path.basename(dir) || dir, lastOpened: 0, hidden: true });
      } else if (p) this.store.state.projects = this.store.state.projects.filter((x) => x !== p);
      this.store.saveState();
      this.emitProjects();
      return { ok: true };
    });
    this.register('project.reorder', ({ paths }) => {
      const list = Array.isArray(paths) ? paths.filter((x): x is string => typeof x === 'string') : [];
      const named = list.map((dir) => this.findProject(dir) ?? this.touchProjectQuiet(dir));
      const rest = this.store.state.projects.filter((p) => !named.includes(p)).sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
      [...named, ...rest].forEach((p, i) => (p.order = i));
      this.store.saveState();
      this.emitProjects();
      return { ok: true };
    });
    // Only the name the sidebar shows changes; the folder on disk keeps its own, which an empty name brings back.
    this.register('project.rename', ({ path: dir, name }) => {
      if (typeof dir !== 'string' || !dir) throw new Error('Missing folder');
      const own = path.basename(path.resolve(dir)) || path.resolve(dir);
      const wanted = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
      const p = this.findProject(dir) ?? this.touchProjectQuiet(dir);
      p.name = wanted || own;
      this.store.saveState();
      this.emitProjects();
      return { ok: true, name: p.name };
    });
    this.register('project.arrange', ({ top, inside }) => {
      const st = this.store.state;
      const groups = (st.groups ??= []);
      // Membership first: the folders named for a project join it, in that order.
      for (const [id, paths] of Object.entries(inside && typeof inside === 'object' ? inside : {})) {
        if (!groups.some((g) => g.id === id) || !Array.isArray(paths)) continue;
        paths
          .filter((x): x is string => typeof x === 'string' && !!x)
          .forEach((dir, i) => {
            const p = this.findProject(dir) ?? this.touchProjectQuiet(dir);
            p.group = id;
            p.order = i;
          });
      }
      // Then the top: named entries first, in that order (a folder named here is loose from now on),
      // the rest after them in their own order.
      type Entry = { order: number | undefined; set: (n: number) => void; key: unknown };
      const named: Entry[] = [];
      const seen = new Set<unknown>();
      const chats: Entry = { order: st.chatsOrder, set: (n) => (st.chatsOrder = n), key: 'chats' };
      for (const key of Array.isArray(top) ? top : []) {
        if (typeof key !== 'string' || !key) continue;
        let e: Entry | undefined;
        if (key === 'chats') e = chats;
        else if (key.startsWith('group:')) {
          const g = groups.find((x) => x.id === key.slice(6));
          if (g) e = { order: g.order, set: (n) => (g.order = n), key: g };
        } else {
          const p = this.findProject(key) ?? this.touchProjectQuiet(key);
          delete p.group;
          e = { order: p.order, set: (n) => (p.order = n), key: p };
        }
        if (e && !seen.has(e.key)) {
          seen.add(e.key);
          named.push(e);
        }
      }
      if (named.length) {
        const rest: Entry[] = [
          ...st.projects.filter((p) => !this.groupOf(p) && !seen.has(p)).map((p) => ({ order: p.order, set: (n: number) => (p.order = n), key: p })),
          ...groups.filter((g) => !seen.has(g)).map((g) => ({ order: g.order, set: (n: number) => (g.order = n), key: g })),
          ...(seen.has('chats') || typeof st.chatsOrder !== 'number' ? [] : [chats]),
        ].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
        [...named, ...rest].forEach((e, i) => e.set(i));
      }
      this.store.saveState();
      this.emitProjects();
      return { ok: true };
    });
    this.register('group.create', ({ name, paths }) => {
      const st = this.store.state;
      const groups = (st.groups ??= []);
      const list = (Array.isArray(paths) ? paths : []).filter((x): x is string => typeof x === 'string' && !!x);
      const first = list.length ? this.findProject(list[0]) : undefined;
      // Where its first folder stood, so the folder does not jump; otherwise on top.
      const at = first && !this.groupOf(first) && typeof first.order === 'number' ? first.order : this.topPlace();
      const g: FolderGroup = { id: randomUUID().replace(/-/g, '').slice(0, 10), name: cleanName(name) || 'New project', order: at, createdAt: Date.now() };
      groups.push(g);
      list.forEach((dir, i) => {
        const p = this.findProject(dir) ?? this.touchProjectQuiet(dir);
        p.group = g.id;
        p.order = i;
      });
      this.store.saveState();
      this.emitProjects();
      return g;
    });
    this.register('group.rename', ({ id, name }) => {
      const g = this.store.state.groups?.find((x) => x.id === id);
      if (!g) throw new Error('Project not found');
      const wanted = cleanName(name);
      if (wanted) g.name = wanted;
      this.store.saveState();
      this.emitProjects();
      return { ok: true };
    });
    this.register('group.remove', ({ id }) => {
      const st = this.store.state;
      const g = st.groups?.find((x) => x.id === id);
      if (!g) return { ok: false };
      // Its folders stay where it stood, loose, in their order.
      const inside = st.projects.filter((p) => p.group === id).sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
      inside.forEach((p, i) => {
        delete p.group;
        p.order = g.order + (i + 1) / (inside.length + 1);
      });
      st.groups = st.groups!.filter((x) => x !== g);
      this.store.saveState();
      this.emitProjects();
      return { ok: true };
    });
    this.register('chats.prepare', () => {
      const root = this.chatsRoot();
      mkdirSync(root, { recursive: true });
      return { path: root };
    });
    this.register('project.pin', ({ path: dir, pinned }) => {
      // A folder known only through its sessions becomes a project when pinned.
      const p = this.store.state.projects.find((x) => x.path === dir) ?? (pinned ? this.touchProject(dir) : undefined);
      if (p) p.pinned = pinned;
      this.store.saveState();
      this.emitProjects();
      return { ok: true };
    });

    // ── sessions ──
    this.register('session.create', (p, ctx) => this.createSession(p, {}, ctx));

    this.register('session.snapshot', async ({ sessionId, peek, page, keepFrom }) => {
      const rt = this.runtime(sessionId);
      if (page === 'end' && this.lazy.has(sessionId) && !this.unreadable.has(sessionId) && !rt.meta.pendingRestart && !this.untilLost.has(sessionId)) {
        const preview = this.store.readSessionEnd(sessionId);
        if (preview) {
          setImmediate(() => {
            if (!this.disposed && this.sessions.get(sessionId) === rt) void this.hydrateAsync(rt).catch(err => this.log('session read failed', String(err)));
          });
          if (rt.meta.unread && !peek) rt.update({ unread: false });
          return { ...rt.snapshot(), ...preview };
        }
      }
      await this.hydrateAsync(rt);
      if (this.unreadable.has(sessionId)) return rt.snapshot();
      // Fetched ahead of an open (`peek`): not read yet.
      if (rt.meta.unread && !peek) rt.update({ unread: false });
      const snap = rt.snapshot();
      if (!page || snap.items.length <= SNAPSHOT_THRESHOLD && typeof page === 'string') return snap;
      if (typeof page !== 'string') {
        const older = snapshotPage(snap, page);
        if (!older.page) return older;
        // Runtime patches and deltas mutate the row in place. Freeze its fields at the sequence
        // boundary, before the socket's async caller resumes and projects the bounded page.
        return { ...older, items: older.items.map(item => ({ ...item })), seq: this.itemSequence };
      }
      let end = this.snapshotEnds.get(rt.items);
      if (!end) this.snapshotEnds.set(rt.items, end = snapshotEnd(rt.items));
      // Restore can settle an old running turn. Keep its displayed rows in the
      // replacement even if the ordinary idle tail starts further down now.
      if (page === 'real' && keepFrom && end.start && rt.items[end.start]?.id !== keepFrom) {
        let roots = end.roots;
        for (let i = end.start - 1; i >= 0; i--) {
          if (!rt.items[i].parentId) roots--;
          if (rt.items[i].id === keepFrom) { end = { start: i, roots }; break; }
        }
      }
      return snapshotPage(snap, 'end', end);
    });
    // A window gets finished steps cut (core/trim.ts): one whole, when it opens. A chat not read yet
    // (a picture of a file asked after a restart) is read off the main thread, one read for all, as a snapshot is.
    this.register('session.item', async ({ sessionId, itemId }) => {
      const rt = this.runtime(sessionId);
      await this.hydrateAsync(rt);
      const item = rt.get(itemId);
      if (!item) throw new Error('That part of the conversation is no longer there');
      return { item: { ...this.store.wholeItem(sessionId, item) } };
    });
    this.register('track.stop', async ({ sessionId, itemId }) => {
      const rt = this.runtime(sessionId);
      await this.hydrateAsync(rt);
      return { ok: this.tracker.stop(rt, itemId) };
    });
    this.register('session.itemPart', ({ sessionId, itemId, path, offset = 0, seq }) => {
      const rt = this.runtime(sessionId);
      const item = rt.get(itemId);
      if (!item) throw new Error('That part of the conversation is no longer there');
      let versions = this.partVersions.get(rt.items);
      if (seq !== undefined && seq !== versions?.get(itemId)) throw new Error('The conversation changed while reading this item.');
      if (!versions) this.partVersions.set(rt.items, versions = new Map());
      const version = versions.get(itemId) ?? ++this.itemSequence;
      versions.set(itemId, version);
      let value: unknown = this.store.wholeItem(sessionId, item);
      if (!Array.isArray(path) || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid item range');
      for (const key of path) {
        if (!value || typeof value !== 'object' || !Object.prototype.propertyIsEnumerable.call(value, key)) throw new Error('Unknown item field');
        value = (value as Record<string, unknown>)[key];
      }
      if (typeof value === 'string') {
        const end = offset + 65536;
        return { seq: version, kind: 'value', value: value.slice(offset, end), next: end < value.length ? end : undefined };
      }
      if (Array.isArray(value)) return { seq: version, kind: 'array', length: value.length };
      if (value && typeof value === 'object') {
        const keys = Object.keys(value).filter(k => (value as Record<string, unknown>)[k] !== undefined);
        const end = offset + 256;
        return { seq: version, kind: 'object', keys: keys.slice(offset, end), next: end < keys.length ? end : undefined };
      }
      return { seq: version, kind: 'value', value: typeof value === 'number' || typeof value === 'boolean' ? value : null };
    });

    // A recovered field may be about to edit a queue row. Join the original send if it is
    // still running, or ask the saved row before allowing its words into a second action.
    this.register('session.submission', async ({ sessionId, submitId, text, attachments }, ctx) => {
      if (ctx.phoneSender) {
        const rt = this.runtime(sessionId);
        await this.hydrateAsync(rt);
        if (!this.phoneReceipts.has(sessionId, submitId)) {
          if (this.unreadable.has(sessionId)) throw Error('This chat could not be read from disk');
          await this.submissions.pending(sessionId, submitId, 'phone');
        }
        return { ok: this.phoneReceipts.has(sessionId, submitId), ...(rt.queue.some(q => q.id === submitId) && { queued: true }) };
      }
      return this.submissions.run(sessionId, submitId, async () => {
        const rt = this.runtime(sessionId);
        if (this.unreadable.has(sessionId)) throw Error('This chat could not be read from disk');
        const slot = this.submissionSlot(rt, submitId, messagePrint(text, attachments));
        if (rt.queue.some(q => q.submitId === slot || q.id === slot)) return { ok: true, queued: true };
        const existing = rt.get<UserItem>(slot);
        return { ok: existing?.type === 'user', ...(existing?.state === 'queued' && { queued: true }) };
      }, messagePrint(text, attachments));
    });

    // A retry of a submission the bridge already took (its window lost the answer) is answered, not sent again.
    this.register('session.send', ({ sessionId, text, attachments, steer, submitId }, ctx) => this.submissions.run(sessionId, submitId, async () => {
      // A message is words (maybe empty, with pictures) before anything holds it: the queue, the timeline, the agent.
      validMessage(text, attachments);
      const rt = this.runtime(sessionId);
      // A chat not read yet (a phone's message after a restart): read off the main thread, as a snapshot is;
      // a big one read here synchronously held the window for most of a second.
      const stops = this.lazy.has(sessionId) ? this.stopsOf(rt) : undefined;
      await this.hydrateAsync(rt);
      still(ctx);
      if (this.unreadable.has(sessionId)) throw new Error('This chat could not be read from disk');
      if (this.disposed || stops !== undefined && this.stopsOf(rt) !== stops) throw new NotNow('The agent was stopped or closed before the message went out.');
      const print = messagePrint(text, attachments);
      const identity = typeof submitId === 'string' && submitId.length > 0 && submitId.length <= 128
        ? ctx.phoneSender ? submitId : this.submissionSlot(rt, submitId, print) : undefined;
      if (ctx.phoneSender && identity && this.phoneReceipts.has(rt.id, identity)) return { ok: true, ...(rt.queue.some(q => q.id === identity) && { queued: true }) };
      if (identity && rt.queue.some(q => q.submitId === identity || q.id === identity)) {
        if (ctx.phoneSender) { await rt.persistInput!(); this.phoneReceipts.record(rt.id, identity); }
        return { ok: true, queued: true };
      }
      const existing = identity ? rt.get<UserItem>(identity) : undefined;
      if (existing?.type === 'user') {
        if (ctx.phoneSender) { await rt.persistInput!(); this.phoneReceipts.record(rt.id, identity!); }
        return { ok: true, ...(existing.state === 'queued' && { queued: true }) };
      }
      if (identity && rt.get(identity)) throw Error('That submission ID is already in use');
      const retryReport = !attachments?.length && /^\/report-retry\s+([\da-f-]{36})$/i.exec(text.trim());
      if (retryReport) {
        const row = rt.items.find((it): it is ToolItem => it.type === 'tool' && it.delegateRetryId === retryReport[1]);
        if (row?.delegateReceiptState !== 'unknown' || !row.delegateAttempt) throw new Error('This report no longer needs a delivery decision.');
        this.refundDelegate(rt, row.delegateAttempt);
        rt.patch<ToolItem>(row.id, { delegateAttempt: undefined, delegateReceiptState: null, delegateRetryId: null, delegateWait: 'retry' });
        rt.stopRequested = false;
        await rt.persistDelegate?.();
        if (ctx.phoneSender && identity) this.phoneReceipts.record(rt.id, identity);
        this.scheduleLossWake(rt);
        return { ok: true };
      }
      // `/model <name>` changes the model; it never goes to the agent (whose own /model restarts it).
      const model = typeof text === 'string' && !attachments?.length ? /^\/model(?:\s+([\s\S]*))?$/i.exec(text.trim()) : null;
      if (model) {
        const result = await this.modelCommand(rt, (model[1] ?? '').trim());
        if (result.ok && ctx.phoneSender && identity) {
          await rt.persistInput?.();
          this.phoneReceipts.record(rt.id, identity);
        }
        return result;
      }
      // While the agent works the bridge holds the message until the turn ends, unless it is
      // steered into the running turn (and the agent can take one).
      const wait = this.steerEnds.has(rt) || (rt.turnActive && !(steer && rt.caps?.features.steer !== false));
      if (identity && ctx.phoneSender) return this.acceptPhoneInput(rt, identity, text, attachments, ctx, wait);
      if (wait) {
        if (identity) this.enqueueSubmission = { rt, id: identity };
        try {
          const q = rt.enqueue(text, attachments, ctx.phoneSender);
          // A phone's message keeps its pairing's guard in the queue.
          if (!ctx.phoneSender && ctx.allowed) rt.transientQueueGuards.set(q.id, ctx.allowed);
        } finally {
          this.enqueueSubmission = undefined;
        }
        await rt.persistInput?.();
        if (!this.steerEnds.has(rt)) rt.unreadQueueHeld = false;
        return { ok: true, queued: true };
      }
      let prints = this.pendingPrints.get(rt);
      if (!prints) this.pendingPrints.set(rt, prints = new Map());
      if (identity) prints.set(identity, print);
      try {
        const disposition = await this.deliver(rt, text, attachments, identity ? { submitId: identity, submitPrint: print } : undefined, ctx, true);
        if (disposition === 'queued') await rt.persistInput?.();
        return disposition === 'queued' ? { ok: true, queued: true } : { ok: true };
      } finally {
        if (identity) prints.delete(identity);
      }
    }, ctx.phoneSender ? 'phone' : messagePrint(text, attachments)));

    this.register('queue.update', async ({ sessionId, id, text, attachments, operationId, expected }, ctx) => {
      // Omitted attachments keep the message's; an empty list removes them.
      validMessage(text, attachments);
      const rt = this.runtime(sessionId);
      // The message as this edit finds it, in the same step: the desktop's swap takes it into its
      // field, so an edit another window made just before is never lost (review wave 10, #8).
      const key = !ctx.allowed && operationId ? JSON.stringify([id, operationId]) : undefined;
      const receipt = key && this.receiptsFor(rt).get(key);
      if (receipt) {
        await rt.persistInput?.();
        return { ok: true, previous: receipt };
      }
      const current = key && this.revisedQueueRow(rt, id, expected);
      if (current) return { ok: false, current };
      const found = rt.queue.find((q) => q.id === id);
      const previous = found ? { ...found, ...(found.attachments ? { attachments: [...found.attachments] } : {}) } : undefined;
      const ok = rt.updateQueued(id, text, attachments ?? undefined);
      if (ok && key && previous) this.receiptsFor(rt).set(key, previous);
      this.spare.queueChanged(rt);
      // Capture this edit's reply before another window acts during its save.
      const result = ok && previous && !ctx.allowed && rt.queue.some(q => q.id === id) ? { ok, previous } : { ok };
      if (ok) await rt.persistInput?.();
      return result;
    });
    this.register('queue.take', async ({ sessionId, id, operationId, expected, releaseReceipt, receiptOnly }, ctx) => {
      const rt = this.runtime(sessionId);
      const key = !ctx.allowed && operationId ? JSON.stringify([id, operationId]) : undefined;
      if (releaseReceipt) {
        if (key) this.receiptsFor(rt).delete(key);
        return {};
      }
      const receipt = key && this.receiptsFor(rt).get(key);
      if (receipt) {
        await rt.persistInput?.();
        return { message: receipt };
      }
      const taken = async () => {
        if (rt.get(id)?.type !== 'user' || rt.isReserved(id)) return {};
        await rt.persistInput?.();
        return { taken: true };
      };
      if (receiptOnly) return taken();
      const current = key && this.revisedQueueRow(rt, id, expected);
      if (current) return { current };
      const message = rt.takeQueued(id);
      this.spare.queueChanged(rt);
      if (message && key) this.receiptsFor(rt).set(key, message);
      if (message) {
        await rt.persistInput?.();
        return { message };
      }
      return taken();
    });
    this.register('queue.reorder', async ({ sessionId, ids }) => {
      const rt = this.runtime(sessionId);
      rt.reorderQueued(Array.isArray(ids) ? ids : []);
      await rt.persistInput?.();
      return { ok: true };
    });
    this.register('queue.remove', async ({ sessionId, id }) => {
      const rt = this.runtime(sessionId);
      const entry = rt.takeQueued(id);
      this.spare.queueChanged(rt);
      if (entry) await rt.persistInput?.();
      return { ok: !!entry };
    });
    this.register('queue.sendNow', async ({ sessionId, id }, ctx) => {
      const rt = this.runtime(sessionId);
      try {
        if (this.steerEnds.has(rt)) throw new NotNow('Waiting for the interrupted turn to end.');
        const ok = await this.deliverQueued(rt, id, ctx);
        if (ok && rt.queue.some(q => q.id === id && q.byHand)) {
          rt.queueReason(id, 'Delivery is on hold. Try again after the current send or account change finishes.');
          return { ok: false };
        }
        return { ok };
      } catch (err) {
        rt.queueReason(id, (err as Error).message);
        throw err;
      }
    });

    this.register('session.steerNow', ({ sessionId, itemId }, ctx) => this.steerNow(this.runtime(sessionId), itemId, ctx));

    this.register('session.interrupt', async ({ sessionId }, ctx) => {
      const rt = this.runtime(sessionId);
      rt.stopRequested = true;
      this.stopped(rt);
      if (this.lazy.has(sessionId)) {
        await this.hydrateAsync(rt);
        still(ctx);
      }
      rt.cancelPrompts();
      // Stopped while the agent is still starting: what waits for it is not sent once it is there,
      // and the session is idle again (the message stays in the conversation, stopped, as after any stop).
      const waiting = this.earlyWaiting.get(rt.id);
      if (waiting?.length && !rt.turnActive) {
        for (const id of waiting) this.stoppedEarly.add(id);
        this.earlyWaiting.delete(rt.id);
        rt.notice('interrupted', 'Interrupted');
        rt.update({ status: 'idle', activity: undefined });
        return { ok: true };
      }
      await rt.handle?.interrupt();
      return { ok: true };
    });

    // Stored on the session; the agent takes it with the next message (see setSessionModel).
    this.register('session.setModel', ({ sessionId, model }) => {
      this.setSessionModel(this.runtime(sessionId), typeof model === 'string' ? model : '');
      return { ok: true };
    });
    this.register('session.switchAgent', async ({ sessionId, provider, model, accountId }) => {
      const rt = this.runtime(sessionId);
      return this.switchAgent(rt, provider, { model: typeof model === 'string' && model ? model : undefined, accountId: typeof accountId === 'string' && accountId ? accountId : undefined });
    });
    this.register('session.setSpeed', async ({ sessionId, speed }) => {
      const rt = this.runtime(sessionId);
      const next = speedFor(this.modelInfo(rt, rt.meta.model), speed);
      await this.applySpeed(rt, next);
      return { ok: true, speed: next };
    });
    this.register('session.setEffort', async ({ sessionId, effort }) => {
      const rt = this.runtime(sessionId);
      // The choice is the session's at once, in the order it was made: the chip, the popover, the phone and
      // the next message all read it, whatever the agent takes to answer (Claude Code's answer can take
      // seconds while its process starts, and two quick picks must not land in the order they finish).
      rt.update({ effort });
      await this.applyEffort(rt, rt.handle);
      return { ok: true };
    });
    this.register('session.setMode', async ({ sessionId, mode, answerWaiting }) => {
      const rt = this.runtime(sessionId);
      const danger = rt.caps?.modes.find((m) => m.id === mode)?.tone === 'danger' || allowsEverything(mode);
      // A mode that never asks, chosen from a phone while work runs, answers that work's asks only from the
      // next message on (review wave 7, #1): the phone could not be shown them. Claude Code's own mode
      // waits for it too (in Bypass the CLI would stop asking at once); the switch goes with the next message.
      if (answerWaiting === false && danger && (rt.turnActive || (rt.meta.background ?? 0) > 0)) {
        // The work in progress keeps the mode it had (`workMode`), also over a second held switch.
        if (!rt.dangerHeld) rt.heldMode = rt.meta.mode;
        rt.dangerHeld = true;
        this.modeDue.add(rt.id);
      } else {
        rt.dangerHeld = false;
        this.scheduleLossWake(rt);
        rt.heldMode = undefined;
        this.modeDue.delete(rt.id);
        this.modeChanges.set(rt.id, (this.modeChanges.get(rt.id) ?? 0) + 1);
        try { await rt.handle?.setMode(mode); }
        finally {
          const remaining = this.modeChanges.get(rt.id)! - 1;
          if (remaining) this.modeChanges.set(rt.id, remaining);
          else this.modeChanges.delete(rt.id);
        }
      }
      rt.update({ mode });
      // The mode that never asks (Bypass, Full access) answers what already waits too; questions stay.
      // A phone answers only what it may itself (`answerWaiting: false`, phone.ts).
      if (answerWaiting !== false && rt.caps?.modes.find((m) => m.id === mode)?.tone === 'danger') {
        for (const p of rt.prompts().permissions) {
          if (p.toolName === 'ExitPlanMode') continue;
          const allow = p.options.find((o) => o.tone === 'allow');
          if (allow) rt.answerPermission(p.id, { optionId: allow.id });
        }
      }
      return { ok: true };
    });
    this.register('session.setFast', async ({ sessionId, fast }) => {
      const rt = this.runtime(sessionId);
      await rt.handle?.setFast?.(fast);
      rt.update({ fast });
      return { ok: true };
    });
    this.register('session.setUltracode', async ({ sessionId, on }) => {
      const rt = this.runtime(sessionId);
      const before = !!rt.meta.ultracode;
      // The adapter reads the meta at the next start, so it changes first (false, not undefined: patches travel as JSON).
      rt.update({ ultracode: on });
      try {
        await rt.handle?.setUltracode?.(on);
      } catch (err) {
        rt.update({ ultracode: before });
        rt.notice('error', on ? 'Ultracode could not be turned on' : 'Ultracode could not be turned off', (err as Error).message);
        return { ok: false };
      }
      return { ok: true };
    });

    // Until green: `/until <check>` arms a loop on the session (server/core/until.ts).
    this.register('until.set', ({ sessionId, text }) => {
      const rt = this.runtime(sessionId);
      const parsed = parseUntil(text ?? '');
      if ('error' in parsed) return { ok: false, error: parsed.error };
      if ('off' in parsed) return { ok: this.until.stop(rt) };
      return { ok: true, until: { ...this.until.arm(rt, parsed.args) } };
    });
    this.register('until.stop', ({ sessionId }) => ({ ok: this.until.stop(this.runtime(sessionId)) }));
    this.register('until.check', ({ sessionId }) => ({ ok: this.until.checkNow(this.runtime(sessionId)) }));

    // "Check with Codex" (server/core/check.ts): the other agent reviews a finished turn, read-only.
    this.register('turn.check', ({ sessionId, turnId }) => {
      const rt = this.runtime(sessionId);
      return this.checks.start(rt, String(turnId ?? ''), edit => this.store.wholeItem(sessionId, edit) as ToolItem);
    });
    this.register('turn.checkStop', ({ sessionId, itemId }) => ({ ok: this.checks.stop(this.runtime(sessionId), String(itemId ?? '')) }));

    // Spare (server/core/spare.ts): `/spare <message>` and "Continue at reset".
    this.register('spare.send', async ({ sessionId, text, attachments }) => {
      const rt = this.runtime(sessionId);
      const body = typeof text === 'string' ? text.trim() : '';
      if (!body && !attachments?.length) return { ok: false, error: 'Add a message after /spare' };
      // A new chat is named by the message it waits with, not "New session" for hours.
      if (rt.meta.titleSource === 'auto' && !rt.items.some((i) => i.type === 'user') && !rt.meta.spare) rt.update({ title: autoTitle(body, true), titleAuthored: true });
      const spare = this.spare.hold(rt, body, attachments);
      await rt.persistInput?.();
      return { ok: true, spare };
    });
    this.register('spare.atReset', ({ sessionId, refusalId }) => this.spare.atReset(this.runtime(sessionId), refusalId));
    this.register('spare.cancel', ({ sessionId }) => ({ ok: this.spare.cancel(this.runtime(sessionId)) }));
    this.register('spare.startNow', async ({ sessionId }) => ({ ok: await this.spare.startNow(this.runtime(sessionId)) }));
    // Development only: the Demo's limits never reset by themselves; this makes one do so soon.
    this.register('demo.limitResetIn', ({ accountId, ms }) => {
      if (!this.providers.has('demo')) throw new Error('The Demo agent is not available');
      const p = this.provider('demo', accountId) as Provider & { limitResetIn?: (ms: number) => void };
      if (!p.limitResetIn) return { ok: false };
      p.limitResetIn(Math.max(0, Number(ms) || 0));
      return { ok: true };
    });

    // Lanes (server/core/lanes.ts).
    this.register('git.worktrees', ({ cwd }) => gitWorktrees(cwd));
    this.register('git.draft', ({ sessionId, cwd }) => this.draftCommit(String(sessionId ?? ''), String(cwd ?? '')));
    this.register('lane.forecast', ({ sessionId }) => this.lanes.forecast(this.runtime(sessionId)));
    this.register('lane.land', ({ sessionId, message }) => this.lanes.land(this.runtime(sessionId), typeof message === 'string' ? message : undefined));
    this.register('lane.discard', ({ sessionId }) => this.lanes.discard(this.runtime(sessionId)));
    this.register('lane.create', ({ sessionId }) => this.lanes.create(this.runtime(sessionId)));
    this.register('lane.open', ({ sessionId }) => this.lanes.open(this.runtime(sessionId)));
    this.register('lane.diff', ({ sessionId }) => this.lanes.diff(this.runtime(sessionId)));

    // Race (server/core/race.ts).
    this.register('race.start', ({ cwd, task, provider, modes }) =>
      this.races.start({ cwd: String(cwd ?? ''), task: typeof task === 'string' ? task : '', provider, modes: modes && typeof modes === 'object' ? modes : undefined }),
    );
    this.register('race.keep', ({ sessionId, message }) => this.races.keep(this.runtime(sessionId), typeof message === 'string' ? message : undefined));
    this.register('race.discard', ({ sessionId }) => this.races.discardBoth(this.runtime(sessionId)));

    this.register('session.rename', ({ sessionId, title }) => {
      this.runtime(sessionId).update({ title: title.trim() || 'Untitled', titleSource: 'user' });
      return { ok: true };
    });
    this.register('session.update', ({ sessionId, patch }) => {
      const flags: Partial<SessionMeta> = {};
      for (const key of ['pinned', 'archived', 'unread'] as const) {
        if (typeof patch[key] === 'boolean') flags[key] = patch[key];
      }
      // Muted is kept only while true: unmuting clears the field.
      if (typeof patch.muted === 'boolean') flags.muted = patch.muted || undefined;
      this.runtime(sessionId).update(flags);
      return { ok: true };
    });

    this.register('session.close', async ({ sessionId, remove }) => {
      const rt = this.runtime(sessionId);
      this.closed(rt);
      const cleanup = remove ? rt.revokeAllDelegates() : undefined;
      if (cleanup) {
        this.retiredDelegates.add(cleanup);
        void cleanup.finally(() => this.retiredDelegates.delete(cleanup)).catch(err => this.log('deleted delegate cleanup failed', err));
      }
      this.until.closed(rt);
      await this.checks.closed(rt);
      rt.stopRequested = true;
      rt.cancelPrompts();
      await this.detachWriter(rt).catch(() => {});
      if (rt.turnActive) {
        rt.settle('cancelled');
        rt.endTurn();
      }
      if (remove) {
        this.autoContinued.delete(rt);
        this.heldSends.delete(sessionId);
        this.drainWaiting.delete(sessionId);
        this.sessions.delete(sessionId);
        this.handed.delete(sessionId);
        this.pinned.delete(sessionId);
        this.unstoppableNotes.delete(sessionId);
        this.persistSessions();
        this.store.deleteSession(sessionId);
        try { this.delegateJournal.remove(sessionId); } catch (err) { this.log('deleted delegate journal cleanup failed', err); }
        this.removePhoneReceipts(sessionId);
        this.emit({ type: 'session.removed', id: sessionId });
        // A deleted chat takes its folder along when nothing was ever put in it.
        if (rt.meta.chat) removeEmptyChatFolder(this.chatsRoot(), rt.meta.cwd);
        // A deleted chat's lane goes too when it holds nothing to land (otherwise its branch keeps the work).
        await this.lanes.closed(rt);
        // Its rival races no more.
        this.races.closed(rt);
      } else this.persistSessions();
      return { ok: true };
    });

    this.register('session.rewind', async ({ sessionId, itemId, restoreFiles, expectedLast, expectedEnd, operationId }) => {
      const rt = this.runtime(sessionId);
      let receipts = this.rewindReceipts.get(rt);
      if (!receipts) this.rewindReceipts.set(rt, receipts = new Map());
      const previous = operationId && receipts.get(operationId);
      if (previous) return previous;
      const handle = await this.ensureHandle(rt);
      // A restored Claude handle can yield inside rewind while finding the native point.
      // Finish that read first. Once restoredChain is clear, a message-only rewind cuts
      // synchronously. Never enter the asynchronous file-restore branch with a comparison.
      const guarded = !!(expectedLast || expectedEnd);
      if (guarded && restoreFiles) return { ok: false, message: 'A conditional rewind cannot restore files.' };
      if (guarded && 'restoredChain' in handle && handle.restoredChain) {
        if ('loadChain' in handle && typeof handle.loadChain === 'function') {
          try { await handle.loadChain(); } catch { /* The chain remains unverified. */ }
        }
        if (handle.restoredChain) return { ok: false, message: 'Could not verify the saved conversation before rewind.' };
      }
      const joined = operationId && receipts.get(operationId);
      if (joined) return joined;
      if (guarded && (rt.handle !== handle || rt.turnActive)) return { ok: false, message: 'The conversation moved on' };
      if (!handle.rewind) return { ok: false, message: 'This provider cannot rewind.' };
      if (expectedEnd && rt.items.findLast(i => !i.parentId)?.id !== expectedEnd)
        return { ok: false, message: 'The conversation moved on' };
      if (expectedLast) {
        const last = rt.items.findLast(i => i.type === 'user' && !i.parentId && i.state !== 'queued' && !syntheticOf(i));
        if (last?.id !== itemId || expectedLast.id !== itemId || !last)
          return { ok: false, message: 'The conversation moved on' };
        const current = this.store.wholeItem(sessionId, last) as UserItem;
        const same = current.ts === expectedLast.ts && current.text === expectedLast.text &&
          current.providerId === expectedLast.providerId && current.state === expectedLast.state &&
          JSON.stringify(current.attachments ?? []) === JSON.stringify(expectedLast.attachments ?? []);
        if (!same) return { ok: false, message: 'The conversation moved on' };
      }
      const pending = handle.rewind(itemId, restoreFiles);
      if (operationId) receipts.set(operationId, pending);
      const done = await pending;
      // A check of a turn the rewind took away stops with it.
      this.checks.pruned(rt);
      return done;
    });
    // Fork at an answer: a new session with the same agent and settings that continues from the
    // end of that turn. An unresolved native point is reported before creating a session.
    // Providers that continue from a summary announce it before the fork appears.
    this.register('session.fork', async ({ sessionId, itemId }) => {
      const src = this.runtime(sessionId);
      await this.hydrateAsync(src);
      const cut = cutAt(src.items, itemId);
      if (!cut) throw new Error('That point is no longer in the conversation.');
      const m = src.meta;
      let resume: string | null = null;
      if (m.providerSessionId) {
        try {
          const handle = await this.ensureHandle(src);
          resume = (await handle.fork?.(itemId)) ?? null;
        } catch {
          resume = null;
        }
      }
      if (!resume) {
        const detail = 'It starts with a summary of the conversation up to there';
        if ((m.provider === 'claude' || m.provider === 'codex') && m.providerSessionId) {
          throw new Error('This fork cannot keep the agent conversation. Continue from a summary of the conversation up to there.');
        }
        this.emit({ type: 'toast', level: 'info', text: detail });
      }
      const snap = await this.createSession({
        provider: m.provider,
        cwd: m.cwd,
        model: m.model || undefined,
        effort: m.effort,
        mode: m.mode,
        accountId: m.accountId,
        options: m.options,
        ultracode: m.ultracode,
        speed: m.speed,
        title: `${m.title} (fork)`,
        ...(resume ? { resume } : {}),
      }, src.items.some(isLight) || cut.kept.some(row => row.type === 'tool' && (row.delegateReport || row.delegateDeliveryId)) ? { fork: { source: src.id, items: forkHistory(cut.kept, row => this.store.wholeItem(src.id, row)), chainFrom: resume && m.provider === 'claude' ? m.providerSessionId : undefined } } : {});
      const rt = this.runtime(snap.session.id);
      if (resume) rt.notice('info', `Forked from ${m.title}`);
      else {
        const summary = handoverText(withoutChecks(cut.kept), { from: this.provider(m.provider, m.accountId ?? DEFAULT_ACCOUNT).name });
        if (summary) {
          this.handovers.set(rt.id, summary);
          rt.notice('info', `Forked from ${m.title}`, 'It starts with a summary of the conversation up to there');
        }
      }
      return this.call('session.snapshot', { sessionId: rt.id });
    });
    this.register('session.switchAccount', async ({ sessionId, accountId, retry, refusalId, adoptPhoneMessage }, ctx) => {
      const rt = this.runtime(sessionId);
      if (adoptPhoneMessage) {
        const refused = refusalId && this.refusedMessage(rt, this.openLimit(rt, refusalId));
        if (ctx.allowed || ctx.phoneSender || !retry || !refused || refused.id !== adoptPhoneMessage || !refused.phoneSender || this.openLimit(rt, refusalId)?.id !== refusalId)
          throw new NotNow('Select the refused phone message on the desktop.');
        rt.patch<UserItem>(refused.id, { phoneSender: undefined, authored: true });
        await rt.persistInput?.();
      }
      const from = rt.meta.accountId ?? DEFAULT_ACCOUNT;
      // A big chat compacts first, which can take minutes: the answer comes as it starts, and the
      // chat shows the compaction and then the switch line (a failure later is said there too).
      let started!: () => void;
      const compacting = new Promise<'compacting'>((resolve) => (started = () => resolve('compacting')));
      const run = this.switchAccount(rt, accountId, { retry, refusalId, onCompacting: () => started(), limitReturn: 'selectedNotice' }, ctx).then((result) => {
        // Moved by hand: a wait for the old account's reset is over.
        if ((rt.meta.accountId ?? DEFAULT_ACCOUNT) !== from) this.spare.movedByHand(rt);
        return result;
      });
      const first = await Promise.race([run, compacting]);
      if (first !== 'compacting') return first;
      run.catch((err) => {
        if (err instanceof CallerGone || this.sessions.get(rt.id) !== rt) return;
        rt.notice('error', 'Could not move the chat to another account', (err as Error).message);
      });
      return { ok: true, carried: 'conversation', compacting: true };
    });
    this.register('session.context', async ({ sessionId }) => (await this.runtime(sessionId).handle?.context?.()) ?? null);
    this.register('session.setOptions', async ({ sessionId, options }, ctx) => {
      const rt = this.runtime(sessionId);
      const set = () => {
        const next = { ...rt.meta.options, ...options };
        rt.update({ options: next });
        this.persistSessions();
        return next;
      };
      // From the desktop: at once, and the agent takes it once it is there.
      if (!ctx.allowed) {
        const next = set();
        try {
          const handle = await this.ensureHandle(rt);
          await handle.setOptions?.(next);
        } catch (err) {
          rt.notice('error', 'Could not apply the change', (err as Error).message);
        }
        return { ok: true };
      }
      // From a phone: set once the agent is there, and only while the phone may still act (review
      // wave 6, #3); a phone removed meanwhile changes nothing.
      let handle: ProviderSession | undefined;
      let failed: Error | undefined;
      try {
        handle = await this.ensureHandle(rt);
      } catch (err) {
        failed = err as Error;
      }
      still(ctx);
      const next = set();
      try {
        if (failed) throw failed;
        await handle?.setOptions?.(next);
      } catch (err) {
        rt.notice('error', 'Could not apply the change', (err as Error).message);
      }
      return { ok: true };
    });

    this.register('session.mcp', async ({ sessionId }) => {
      const rt = this.runtime(sessionId);
      const fresh = await rt.handle?.mcp?.();
      if (!fresh) return rt.caps?.mcpServers ?? [];
      // Keep the session's capabilities in step with what was just read.
      if (rt.caps) rt.setCaps({ ...rt.caps, mcpServers: fresh });
      return fresh;
    });

    this.register('permission.respond', ({ sessionId, requestId, optionId, message }) => ({
      // The person's own answer (a window or a phone): a share they allow may hand over a file outside the chat's folder.
      ok: this.runtime(sessionId).answerPermission(requestId, { optionId, message }, { person: true }),
    }));
    this.register('question.respond', ({ sessionId, requestId, answers }) => ({
      ok: this.runtime(sessionId).answerQuestion(requestId, answers),
    }));
    this.register('browser.respond', ({ sessionId, requestId, answer }) => ({
      ok: this.sessions.get(sessionId)?.answerBrowser(requestId, answer && typeof answer === 'object' ? answer : { ok: false, error: 'No answer' }) ?? false,
    }));
    this.register('browser.page', ({ sessionId, page }) => {
      const rt = this.sessions.get(sessionId);
      if (!rt) return { ok: false };
      // A page held for a sign-in: its address and title are not even kept (they would reach the next message after the hold).
      rt.browserPage = page && typeof page.url === 'string' && !anyPageHeld() ? { url: page.url.slice(0, 2000), title: String(page.title ?? '').slice(0, 300) } : null;
      return { ok: true };
    });
    // The Browser tab's saved sign-ins (desktop windows only: not on the phone's allowlist).
    registerSignIns(this);

    // Titles and previews made from a first message the agent's harness wrote read as plain words.
    this.register('history.list', async ({ provider, cwd, limit, accountId }) =>
      (await this.provider(provider, accountId).history(cwd, limit)).map((h) => ({
        ...h,
        title: readableTitle(h.title) || 'Untitled session',
        ...(h.preview ? { preview: readableTitle(h.preview) || undefined } : {}),
      })),
    );
  }

  private retiredDelegates = new Set<Promise<unknown>>();
  private disposed = false;

  async dispose(saved?: () => void) {
    this.disposed = true;
    this.closeWebIngress?.();
    // Tracked rows stay as they are on disk: the next start looks at their processes again.
    this.tracker.dispose();
    clearTimeout(this.heldLimitsTimer);
    const deadline = Date.now() + 9800;
    for (const rt of this.sessions.values()) this.steerControls.get(rt)?.abort(new NotNow('The chat was closed.'));
    for (const timer of this.lossWakeTimers.values()) clearTimeout(timer);
    this.lossWakeTimers.clear();
    clearTimeout(this.registryRetry);
    for (const pending of this.firstInputs.values()) {
      pending.missed();
      pending.rollback();
    }
    // Reserve the rest of Electron's save window for sealing. Unconfirmed children stay working on disk.
    for (const rt of this.sessions.values()) this.clearPreparedReports(rt);
    let childSaveError: unknown;
    const children = [...this.sessions.values()].flatMap(rt => [...rt.delegates.values()].map(owner =>
      (owner.quit?.() ?? owner.ended).catch(err => { childSaveError = err; })));
    if (children.length) {
      void this.store.flush().catch(err => this.log('delegate quit checkpoint failed', err));
      await boundedBy(Promise.allSettled(children), Math.max(1, deadline - Date.now() - 2000), undefined);
    }
    const registryReads = this.conversationCopies.finishRegistryReads();
    if (registryReads) await boundedBy(registryReads, Math.max(1, deadline - Date.now() - 2000), undefined);
    const durable = await boundedBy(this.store.seal().then(() => true, (err: Error) => err), Math.max(1, deadline - Date.now()), false);
    const drainAgents = this.journal.active;
    if (durable === true && !childSaveError && !drainAgents) saved?.();
    clearTimeout(this.resetTimer);
    this.updates?.dispose();
    this.until.dispose();
    this.spare.dispose();
    this.resets.dispose();
    this.titles.dispose();
    const services = [this.checks.dispose(), ...this.disposers.splice(0).map(fn => Promise.resolve().then(fn))];
    const handles = [...this.sessions.values()].map(rt => {
      rt.clearSteerWaits();
      rt.cancelPrompts();
      return rt.handle?.close('quit');
    });
    const providers = [...this.providers.values(), ...this.instances.values()];
    const agents = boundedBy(Promise.allSettled(handles), 1500, undefined)
      .then(() => Promise.allSettled(providers.map(p => p.dispose())));
    if (drainAgents) {
      // Electron allows three seconds after the save acknowledgement. Use the remaining
      // pre-acknowledgement budget for agent exits, concurrently across all accounts.
      await boundedBy(this.journal.whenDrained(), Math.max(1, deadline - Date.now()), undefined);
      if (this.journal.active) this.journal.noteQuitDeadline();
      if (durable === true && !childSaveError) saved?.();
    }
    await boundedBy(Promise.allSettled([...services, agents, ...this.retiredDelegates, this.cache.flush(), this.journal.flush()]), drainAgents ? Math.max(1, deadline - Date.now()) : 3000, undefined);
    this.instances.clear();
    if (childSaveError) throw childSaveError;
    if (durable !== true) throw durable || new Error('Timed out saving the conversations.');
  }
}

function isDir(dir: string) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Capabilities a new session starts with: the person's choice for the agent, else the defaults.
 * Claude's Remote Control is on unless chosen otherwise (every chat can be continued on a phone).
 */
export function withDefaultOptions(provider: ProviderId, chosen: SessionOptions | undefined): SessionOptions | undefined {
  if (provider === 'claude' && chosen?.remoteControl === undefined) return { ...chosen, remoteControl: true };
  return chosen;
}

/** A sub-agent's permission mode: the same posture as its parent's, in its own agent's terms. */
function subAgentMode(agent: ProviderId, parentMode: string): string {
  const posture: Record<string, 'full' | 'edits' | 'read' | 'ask'> = {
    bypassPermissions: 'full',
    'full-access': 'full',
    acceptEdits: 'edits',
    auto: 'edits',
    plan: 'read',
    'read-only': 'read',
  };
  const p = posture[parentMode] ?? 'ask';
  if (agent === 'codex') return { full: 'full-access', edits: 'auto', read: 'read-only', ask: 'default' }[p];
  return { full: 'bypassPermissions', edits: 'acceptEdits', read: 'plan', ask: 'default' }[p];
}

/** A name as given in a field: one line, no runs of spaces, at most 120 characters. */
const cleanName = (name: unknown) => (typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, 120) : '');

const sameDir = (a: string, b: string) => path.resolve(a).replace(/[\\/]+$/, '').toLowerCase() === path.resolve(b).replace(/[\\/]+$/, '').toLowerCase();

/** The longest handover a switch of agent sends ahead of the next message (about a thousand tokens). */
const SWITCH_HANDOVER_CHARS = 4500;

/** Agents' names when this build has no such provider (a chat that once ran with it). */
const AGENT_NAMES: Partial<Record<ProviderId, string>> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', demo: 'Demo' };

/** How long a sign-in may wait for the browser. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** How long after start-up cached provider info is checked against the CLI. */
const INFO_REFRESH_DELAY_MS = 15_000;
/** How long app.hello waits for an agent that has nothing cached before it answers without it. */
const FIRST_INFO_WAIT_MS = 50;
/**
 * How long a hello that must not say `checking` (a phone's) waits for an agent's own answer: past
 * the CLIs' own limits (Codex allows its account read 20 s) and inside the phone's 30 s for a request.
 */
const SETTLED_INFO_WAIT_MS = 24_000;
/** How long a new session waits for the other agents' first word before it starts without them. */
const FIRST_WORD_WAIT_MS = 3_000;
/** How long after a cached capabilities answer the fresh one is fetched. */
const CAPS_REFRESH_DELAY_MS = 2_500;

/** How long a message waits for an effort change the agent has not answered yet (it goes again with the next one). */
const EFFORT_WAIT_MS = 6_000;

/** Cached capabilities are per agent, account and folder (plan models, project skills and MCP servers differ). */
function capsCacheKey(provider: ProviderId, accountId: string, cwd?: string) {
  return `caps:${provider}:${accountId}:${cwd ? path.resolve(cwd).toLowerCase() : ''}`;
}

function fallbackInfo(p: Provider): ProviderInfo {
  return { id: p.id, name: p.name, installed: false, auth: { loggedIn: false, checking: true }, problem: 'Could not query the CLI' };
}

/** Who an account is signed in as, for telling a changed sign-in (another person, a key in place of a plan). */
interface SignIn {
  apiKey: boolean;
  email?: string;
}

function signInOf(auth: AuthState): SignIn {
  const email = auth.email?.trim().toLowerCase();
  return { apiKey: isApiKeyAuth(auth), ...(email ? { email } : {}) };
}
