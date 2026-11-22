import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, statSync } from 'node:fs';
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
  type UserItem,
} from '../shared/protocol';
import { authGate, SignInChecks, takeAuthFailure } from './core/auth-gate';
/** A refusal for the sign-in as it was noted (`refusalMark`). */
interface RefusalMark {
  refusedId?: string;
  endId?: string;
  provider: ProviderId;
  accountId: string;
  stops: number;
  closes: number;
}
import { RESUME_AFTER_SIGN_IN, signInBackgroundNote } from '../shared/synthetic';
import { normalizeBackdrop } from '../shared/backdrop';
import { HANDOVER_JOIN, readableTitle, RESUME_AFTER_RESET, RESUME_LIMIT_RESET, RESUME_SUMMARY_TRAILER, RESUME_UNDER_ANOTHER, resumeBackgroundNote } from '../shared/synthetic';
import { Races, type Contender } from './core/race';
import { laneSlug } from './services/git-lanes';
import { gitDraftInput, gitWorktrees } from './services/git';
import { cleanCommit, commitPrompt } from './core/commit-draft';
import { SessionRuntime, autoTitle, pendingPrompts, type BackgroundLimit } from './core/runtime';
import { Store, type StoredAccount } from './core/store';
import { DiskCache } from './core/cache';
import { BACKGROUND_LIMIT_SETTLE_MS, backgroundLimitDue, capReached, capReason, creditsKey, decideAtLimit, dueResets, hasCap, limitStoppedAgents, nextResetAlert, readingShowsRoom, RETURN_AT_START_MS, RETURN_RECHECK_MS, returnRetryMs, returnsAtStart, returnTarget, runningOnCredits } from './core/limit-policy';
import { rankAccount } from '../shared/use-first';
import { defaultChatsRoot, makeChatFolder, removeEmptyChatFolder } from './core/chats';
import { speedFor, startSpeedFor } from '../shared/speed';
import type { Provider, ProviderContext, ProviderSession } from './providers/types';
import { atCap, findAccountFolders, folderLabel, labelFromAuth, pickNextAccount } from './accounts/folders';
import { bigContext, changedFiles, COMPACT_OPENER, COMPACT_TIMEOUT_MS, contextClause, isSlashCommand, moveNote, type MoveOutcome } from './core/move-context';
import { handoverText } from './accounts/handover';
import { backgroundRunning, itemsSince, lastSwitch, legOf, rootBefore, undoableSwitch, withLeg, workedIn } from './core/agent-switch';
import { worksInBackground } from '../shared/background';
import { runSubAgent } from './core/sub-agent';
import { readOnlyMode, TurnChecks, withoutChecks } from './core/check';
import { cutAt } from './core/fork';
import { pinFolder } from './core/contain';
import { orderAccounts } from './accounts/order';
import { allowsEverything, withBrowserLine } from './providers/browser-tool';
import { profileOf } from './services/profile';
import { registerSignIns } from './services/sign-ins';
import { CUSTOM_AGENT_ONLY, customAgent, customOf } from './services/custom';
import { parseUntil, runCheck, UntilLoops } from './core/until';
import { ChatTitles, type TitleModel, type TitleOwner, type TitlePrompt } from './core/titles';
import { Lanes, worktreesRoot } from './core/lanes';
import { isAllModelsWeekly } from './core/limit-policy';
import { windowForModel, windowModel } from '../shared/limit-windows';
import { mergeWindows } from './services/limits';
import { effectiveModel, planWeight, SpareWaits, type SpareAccount, type SpareRun } from './core/spare';
import { ResetConsoles } from './core/reset-console';
import { Submissions, messagePrint } from './core/submissions';
import { openConsole as realConsole, type OpenConsole } from './util/console';
import { VERSION } from './version';
import { bootMark } from './util/boot';
import { cliPresentSoon } from './util/cli-present';

/**
 * Who asks, beside the params: `allowed` (the phone endpoint's guard, services/phone.ts) says whether
 * the caller may still act; a handler that waits asks it again right before what it does after the wait.
 */
export interface CallContext {
  allowed?: () => boolean;
  /**
   * The caller knows a sign-in only as in or out and keeps what it read (a phone): `app.hello`
   * waits for an agent's own answer where it would say `checking`.
   */
  settled?: boolean;
}

/** The caller of a call may no longer act (a phone removed while its request waited). */
export class CallerGone extends Error {
  constructor() {
    super('This phone was removed on the desktop');
  }
}

/** Throws `CallerGone` when the caller may no longer act. */
const still = (ctx?: CallContext) => {
  if (ctx?.allowed && !ctx.allowed()) throw new CallerGone();
};

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
}

export { VERSION };

/** How long an agent asked to stop a compaction that took too long has to say it stopped. */
const COMPACT_STOP_GRACE_MS = 5000;
/** How long a send waits for a return to another account already under way before it goes in the queue behind it. */
const RETURN_SEND_WAIT_MS = 15_000;
/** How long the agent of the account a chat leaves has to close before the move goes on without its transcript. */
const MOVE_CLOSE_MS = 10_000;

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

const accountKey = (provider: ProviderId, accountId: string) => `${provider}:${accountId}`;

/** The bridge application: owns providers, sessions and persistence. Transport-agnostic. */
export class App {
  readonly store: Store;
  /** Last known provider info and capabilities, so start-up never waits for the CLIs. */
  readonly cache: DiskCache;
  /** The built-in default account's instance of each provider. */
  readonly providers = new Map<ProviderId, Provider>();
  /** Instances for extra accounts, created on first use: `provider:accountId` → instance. */
  private instances = new Map<string, Provider>();
  private factories = new Map<ProviderId, (ctx: ProviderContext) => Provider>();
  /** Last known sign-in per extra account (the default account asks its provider every time, as before). */
  private infoCache = new Map<string, Promise<ProviderInfo>>();
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
  private resetCheckedAt = Date.now();
  /** Sessions told once that they run on credits Sable was not allowed to use (per account and window). */
  private creditsWarned = new Set<string>();
  /** Counts `limits.updated` events from each account's provider (so `provider.limits` does not repeat one). */
  private limitsSeq = new Map<string, number>();
  readonly sessions = new Map<string, SessionRuntime>();
  /** Updates of the desktop app (`services/update.ts`), when the shell can install them. */
  updates?: { state: UpdateState; dispose(): void };
  private listeners = new Set<(e: BridgeEvent) => void>();
  private handlers = new Map<string, Handler<RpcName>>();
  private quiet: boolean;
  private delays: NonNullable<AppOptions['refreshDelays']>;
  /** Accounts whose sign-in the user cancelled; the rejection that follows is not an error. */
  private loginCancelled = new Set<string>();
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
  /** Sign-ins given up after `loginTimeoutMs`; the rejection that follows is not an error. */
  private loginTimedOut = new Set<string>();
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

  /** `itemId` goes to the agent now (recorded first: a fast turn can end before the send returns). */
  private handOver(rt: SessionRuntime, itemId: string) {
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
  /** Automatic continues already made per session, as `${messageId}:${accountId}` (never the same twice). */
  private autoContinued = new Map<string, Set<string>>();
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
    send: (rt, text, mark) => this.deliver(rt, text, undefined, { until: mark }),
    run: runCheck,
    log: (...args) => this.log(...args),
  });
  /** Loops that were armed when Sable closed: their sessions say so when next opened. */
  private untilLost = new Map<string, NonNullable<SessionMeta['until']>>();
  /** Spare: chats that start by themselves on quota that would expire, or at a limit's reset (server/core/spare.ts). */
  private spare = new SpareWaits({
    sessions: () => this.sessions.values(),
    hydrate: (rt) => this.hydrate(rt),
    busy: (rt) => rt.turnActive || this.opening.has(rt.id) || this.delivering.has(rt.id),
    model: (rt) => this.chatModel(rt),
    accounts: (provider) => this.spareAccounts(provider),
    refresh: async (provider, accountId) => {
      const key = accountKey(provider, accountId);
      const seq = this.limitsSeq.get(key) ?? 0;
      await this.call('provider.limits', { provider, accountId, force: true });
      // Only the agent's own reading counts: a failed read hands back the last known rows.
      return (this.limitsSeq.get(key) ?? 0) > seq;
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
    sessions: () => this.sessions.values(),
    // Off unless turned on: a lane starts from the last commit, without the folder's uncommitted work.
    auto: () => this.store.state.settings.autoLanes === true,
    release: async (rt) => {
      await this.opening.get(rt.id)?.catch(() => {});
      rt.cancelPrompts();
      await rt.handle?.close().catch(() => {});
      rt.handle = undefined;
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
    get: (id) => {
      const rt = this.sessions.get(id);
      if (rt) this.hydrate(rt);
      return rt;
    },
    contenders: (cwd, hint) => this.raceContenders(cwd, hint),
    create: async (c, cwd, opts) => {
      const snap = await this.createSession({ provider: c.provider, cwd, ...(c.model ? { model: c.model } : {}), accountId: c.accountId, ...(opts.mode ? { mode: opts.mode } : {}) }, { lane: { slug: opts.slug, detail: opts.detail } });
      return this.runtime(snap.session.id);
    },
    remove: async (rt) => {
      await this.call('session.close', { sessionId: rt.id, remove: true });
    },
    send: (rt, text) => this.deliver(rt, text),
    stop: (rt) => this.stopForGood(rt),
    forecast: (rt) => this.lanes.forecast(rt),
    land: (rt, message) => this.lanes.land(rt, message),
    discard: (rt) => this.lanes.discard(rt),
    persist: () => this.persistSessions(),
    log: (...args) => this.log(...args),
  });

  /** "Check with Codex": the other agent reviewing a finished turn, read-only (server/core/check.ts). */
  private checks = new TurnChecks({
    available: (agent) => this.canCheckWith(agent),
    run: (parent, call, itemId, signal) =>
      runSubAgent(
        {
          provider: (id, account) => this.provider(id, account),
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

  constructor(opts: AppOptions) {
    this.consoles = !!opts.openConsole || process.platform === 'win32';
    this.resets = new ResetConsoles({
      open: opts.openConsole ?? realConsole,
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
    this.store = new Store(opts.home);
    this.cache = new DiskCache(this.store.dir);
    bootMark('app:store');
    for (const make of opts.providers) {
      const p = make(this.contextFor(DEFAULT_ACCOUNT));
      this.providers.set(p.id, p);
      this.factories.set(p.id, make);
    }
    for (const meta of this.store.state.sessions) {
      if (!this.providers.has(meta.provider)) {
        this.hidden.push(meta);
        continue;
      }
      // Nothing survives a restart mid-turn.
      meta.status = 'idle';
      meta.activity = undefined;
      // Remote links and live capability state belong to the agent process that is gone.
      meta.remote = meta.options?.remoteControl ? { status: 'Reconnects when the agent starts again', tone: 'waiting' } : undefined;
      meta.capState = undefined;
      // Background work lived in the agent process that is gone (its steps are stopped as the chat is read: `loadRestored`).
      meta.background = undefined;
      // An until loop does not outlive Sable: the session says so when it is opened.
      if (meta.until) this.untilLost.set(meta.id, meta.until), (meta.until = undefined);
      // A chat titled from a message the agent's harness wrote (`<task-notification>`): its plain words.
      const plain = meta.titleSource === 'user' ? meta.title : readableTitle(meta.title);
      if (plain !== meta.title) meta.title = plain || 'New session';
      this.sessions.set(meta.id, this.makeRuntime(meta, true));
    }
    bootMark('app:sessions');
    this.seedFolderOrder();
    this.registerCore();
    // Chats that waited when Sable closed go on waiting (a reset that passed meanwhile is due now).
    if (this.spare.hasWaits()) this.spare.poke(4000);
    // A chat a limit moved away still owes its return (its timer lived in the last run).
    // Soonest due first, never two within the gap: chats that left one account are due at the same reset.
    if (opts.returnAtStartMs) this.returnGapMs = opts.returnAtStartMs.gap;
    const owing = [...this.sessions.values()].filter((rt) => rt.meta.movedFrom).sort((a, b) => (a.meta.returnAt ?? 0) - (b.meta.returnAt ?? 0));
    const waits = returnsAtStart(owing.map((rt) => rt.meta.returnAt), Date.now(), opts.returnAtStartMs);
    owing.forEach((rt, i) => this.armReturn(rt, waits[i]));
  }

  log = (...args: unknown[]) => {
    if (!this.quiet) console.log('[sable]', ...args);
  };

  emit = (event: BridgeEvent) => {
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

  async call<M extends RpcName>(method: M, params: RpcMethods[M]['params'], ctx: CallContext = {}): Promise<RpcMethods[M]['result']> {
    const h = this.handlers.get(method);
    if (!h) throw new Error(`Unknown method: ${method}`);
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

  private contextFor(accountId: string, dir?: string): ProviderContext {
    return {
      log: this.log,
      emit: (e) => this.fromProvider(accountId, e),
      account: accountId === DEFAULT_ACCOUNT ? undefined : { id: accountId, dir },
      settings: () => this.store.state.settings,
      otherAgents: () => this.otherAgents(),
      profile: () => profileOf(this),
      customBrief: () => customOf(this).brief(),
      runAgent: (rt, call, itemId, signal) => {
        if (this.sessions.get(rt.id) !== rt) return Promise.resolve({ ok: false, text: 'No session is attached yet.' });
        return runSubAgent(
          {
            provider: (id, account) => this.provider(id, account),
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
        this.limitsCache.set(key, e.limits);
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
        return;
      }
      case 'provider.updated':
        if (accountId !== DEFAULT_ACCOUNT) this.infoCache.set(accountKey(e.provider.id, accountId), Promise.resolve(e.provider));
        void this.emitProvider(e.provider.id).catch(() => {});
        return;
      case 'caps.updated': {
        const tagged = { ...e, accountId: accountId === DEFAULT_ACCOUNT ? undefined : accountId };
        // Only news when it differs from what the UI was given.
        if (this.cache.set(capsCacheKey(e.provider, accountId, e.cwd), e.caps)) this.emit(tagged);
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
   * An account's full windows cleared before their time (a reset used in the agent's own dialog, as
   * a fresh read showed): what waits for its reset goes on as at a reset by time: chats waiting to
   * continue there, and new chats return to it when it is the preferred one.
   */
  private limitsCleared(provider: ProviderId, accountId: string, windows: RateLimit[]) {
    // Chats that waited go on only where every window holding their model has room now (the planner
    // checks the fresh reading); the windows that cleared say whose wait this was.
    this.spare.resetCleared(provider, accountId, windows);
    const fb = this.fallbacks.get(provider);
    const now = Date.now();
    if (fb && fb.from === accountId && fb.until && fb.until > now) {
      // New chats return only once no window that holds the agent's default model stays full: a
      // weekly window still full keeps them away until its own reset (review wave 8, #18).
      const model = effectiveModel(undefined, this.cache.get<Capabilities>(capsCacheKey(provider, accountId))?.models, this.store.state.settings.defaultModels[provider]);
      const still = (this.limitsCache.get(accountKey(provider, accountId)) ?? []).filter(
        (l) => l.percent >= 100 && !(l.resetsAt && l.resetsAt <= now) && (!windowModel(l) || !model || windowForModel(l, model)),
      );
      if (!still.length) fb.until = now;
      else if (still.every((l) => l.resetsAt)) fb.until = Math.max(...still.map((l) => l.resetsAt!));
      void this.emitProvider(provider).catch(() => {});
    }
    this.scheduleResetAlert();
  }

  private onResetDue() {
    const now = Date.now();
    const due = dueResets(this.capped(), this.resetCheckedAt, now);
    this.resetCheckedAt = now;
    if (this.store.state.settings.notifyLimitReset)
      for (const r of due) this.emit({ type: 'limit.reset', provider: r.provider, accountId: r.accountId === DEFAULT_ACCOUNT ? undefined : r.accountId, window: r.window, at: r.at });
    for (const [provider, fb] of this.fallbacks) if (fb.until && fb.until <= now) void this.emitProvider(provider).catch(() => {});
    this.scheduleResetAlert();
  }

  private accountAuth(provider: ProviderId, accountId: string, force: boolean): Promise<ProviderInfo> {
    const key = accountKey(provider, accountId);
    const hit = this.infoCache.get(key);
    if (hit && !force) return hit;
    const p = this.provider(provider, accountId);
    // A first read of several accounts at once (start-up) is staggered a little per account (auth-gate.ts).
    const lag = force || accountId === DEFAULT_ACCOUNT ? 0 : authGate.stagger(key, 600, 200);
    const info = (lag ? new Promise<void>((r) => setTimeout(r, lag)) : Promise.resolve()).then(() => p.info(force)).catch(() => fallbackInfo(p));
    this.infoCache.set(key, info);
    return info;
  }

  /** The provider as the UI sees it: the default account's CLI state plus every account. `force` re-reads one account. */
  async providerInfo(provider: ProviderId, force?: string): Promise<ProviderInfo> {
    const p = this.provider(provider);
    const base = await p.info(force === DEFAULT_ACCOUNT).catch(() => fallbackInfo(p));
    const defaultId = this.defaultAccountId(provider);
    const signIns = await Promise.all(
      this.accountList(provider).map(async (a) => {
        const own = a.id === DEFAULT_ACCOUNT;
        // A missing CLI has no accounts to ask about.
        const info = own ? base : base.installed ? await this.accountAuth(provider, a.id, force === a.id) : undefined;
        return { a, own, info, auth: info?.auth ?? { loggedIn: false } };
      }),
    );
    // The sign-ins first: one that changed forgets the old person's limits before any snapshot copies
    // them (review wave 8, #26).
    this.noteSignIns(
      provider,
      signIns.map((s) => ({ id: s.a.id, auth: s.auth })),
    );
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
    return { ...base, accounts, ...(limitReset ? { limitReset } : {}) };
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
    this.limitsCache.delete(key);
    this.limitsPartial.delete(key);
    this.limitsMeta.delete(key);
    // When: a reading older than this (a transcript's snapshot, a reset's "before") is the old person's.
    this.cache.set(`limits-forgotten:${key}`, Date.now());
    this.signInGen.set(key, (this.signInGen.get(key) ?? 0) + 1);
    for (const fn of this.limitsForgetters) fn(provider, accountId);
  }

  /**
   * Reads an account's limits from its agent. `fresh`: the agent itself announced a reading while
   * this one ran (a throttled or refused read hands back the last known rows and says nothing).
   * `force: 'fresh'` goes past the agent's own throttles (a reset's reading after its dialog).
   */
  private async readLimits(provider: ProviderId, accountId: string, force: boolean | 'fresh'): Promise<{ limits: RateLimit[]; fresh: boolean; signIn: number }> {
    const key = accountKey(provider, accountId);
    const seq = this.limitsSeq.get(key) ?? 0;
    const signIn = this.signInGen.get(key) ?? 0;
    const limits = await this.provider(provider, accountId).limits(force);
    const fresh = (this.limitsSeq.get(key) ?? 0) > seq;
    // A sign-in that changed meanwhile: this reading may be the previous person's; it is not kept.
    if ((this.signInGen.get(key) ?? 0) !== signIn) return { limits: this.limitsCache.get(key) ?? [], fresh: false, signIn: this.signInGen.get(key) ?? 0 };
    this.limitsCache.set(key, limits);
    // A provider that read them announced it already (with what it knows about the read).
    if (!fresh) this.emit({ type: 'limits.updated', provider, accountId, limits });
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

  private async emitProvider(provider: ProviderId, force?: string) {
    const info = await this.providerInfo(provider, force);
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
        auth: prev?.auth ?? { loggedIn: false },
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
    const caps = rt.caps ?? this.cache.get<Capabilities>(capsCacheKey(rt.meta.provider, rt.meta.accountId ?? DEFAULT_ACCOUNT, rt.meta.cwd));
    return caps?.models.find((m) => m.id === model);
  }

  private async applySpeed(rt: SessionRuntime, speed: string) {
    await rt.handle?.setSpeed?.(speed);
    rt.update({ speed, fast: speed !== STANDARD_SPEED });
  }

  /** The speed a new session starts with: the one asked for when its model offers it (as far as is known). */
  private startSpeed(provider: ProviderId, accountId: string, cwd: string, model: string | undefined, speed: string | undefined): Partial<SessionMeta> {
    if (!speed || speed === STANDARD_SPEED) return {};
    const caps = this.cache.get<Capabilities>(capsCacheKey(provider, accountId, path.resolve(cwd))) ?? this.cache.get<Capabilities>(capsCacheKey(provider, accountId, cwd));
    const info = caps?.models.find((m) => m.id === model) ?? caps?.models.find((m) => m.isDefault);
    // Unknown caps: keep the choice; the agent's adapter checks it against the model again. A paid
    // speed (Claude's fast mode) is never started from a default: the session turns it on itself.
    const chosen = caps ? startSpeedFor(info, speed) : provider === 'claude' ? STANDARD_SPEED : speed;
    return chosen === STANDARD_SPEED ? {} : { speed: chosen, fast: true };
  }

  private async capsFast(provider: ProviderId, cwd: string | undefined, accountId = DEFAULT_ACCOUNT, refresh = false): Promise<Capabilities> {
    const p = this.provider(provider, accountId);
    const key = capsCacheKey(provider, accountId, cwd);
    const fresh = () =>
      p.caps(cwd).then((answer) => {
        // Codex reads its MCP inventory (and the plugin behind browser / computer use) in the
        // background, which takes long: until it arrives, keep the last known inventory.
        const before = this.cache.get<Capabilities>(key);
        const caps =
          provider === 'codex' && !answer.mcpServers.length && before?.mcpServers.length
            ? { ...answer, mcpServers: before.mcpServers, features: { ...answer.features, browser: before.features.browser, computerUse: before.features.computerUse, linkedBrowserComputer: before.features.linkedBrowserComputer } }
            : answer;
        if (this.cache.set(key, caps)) this.emit({ type: 'caps.updated', provider, accountId: accountId === DEFAULT_ACCOUNT ? undefined : accountId, cwd, caps });
        return caps;
      });
    const cached = provider === 'demo' || refresh ? undefined : this.cache.get<Capabilities>(key);
    if (!cached) return fresh();
    // Check it a moment later, off the start-up path (the probe starts a CLI process).
    const t = setTimeout(() => !this.disposed && void fresh().catch(() => {}), this.delays.caps ?? CAPS_REFRESH_DELAY_MS);
    t.unref?.();
    return cached;
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

  /** The session with its timeline read from disk (for actions that add to it). */
  private loaded(id: string): SessionRuntime {
    const rt = this.runtime(id);
    this.hydrate(rt);
    return rt;
  }

  runtime(id: string): SessionRuntime {
    const rt = this.sessions.get(id);
    if (!rt) throw new Error('Session not found');
    return rt;
  }

  private lazy = new Set<string>();

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
      if (what === 'meta') {
        this.pinCwd(rt);
        this.store.saveState();
      } else this.store.saveSession(rt.id, () => ({ items: rt.items, todos: rt.todos, queue: rt.queue, dirty: rt.takeDirty() }));
    });
    this.pinCwd(rt);
    rt.onTurnEnd = (r, error, opts) => this.afterTurn(r, error, opts?.hold);
    // Background work met a plan limit with no turn running: the chat's limit, decided once (limit-policy.ts).
    rt.onBackgroundLimit = (r, hit) => this.limitInBackground(r, hit);
    // At rest: a chat a limit moved away goes back once that account takes work again.
    rt.onRest = (r) => void setTimeout(() => void this.returnAfterLimit(r).catch((err) => this.log('return after a limit failed', (err as Error).message)), 0);
    // A queued message a phone was taking back is released: the queue goes on if it waited for it.
    rt.onQueueReleased = (r) => {
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

  /** Loads a restored session's timeline from disk the first time it is needed. */
  private hydrate(rt: SessionRuntime) {
    if (!this.lazy.delete(rt.id)) return;
    this.loadInto(rt, this.store.loadSession(rt.id));
  }

  private reading = new Map<string, Promise<void>>();

  /**
   * As `hydrate`, with a big file read in a worker thread, so opening a chat of hundreds of megabytes
   * does not hold the app up. A sync `hydrate` meanwhile (a message sent to it) simply wins.
   */
  private hydrateAsync(rt: SessionRuntime): Promise<void> {
    if (!this.lazy.has(rt.id)) return Promise.resolve();
    let run = this.reading.get(rt.id);
    if (!run) {
      run = this.store
        .loadSessionAsync(rt.id)
        .then((file) => {
          if (this.lazy.delete(rt.id)) this.loadInto(rt, file);
        })
        .finally(() => this.reading.delete(rt.id));
      this.reading.set(rt.id, run);
    }
    return run;
  }

  private loadInto(rt: SessionRuntime, file: ReturnType<Store['loadSession']>) {
    // No agent process carries anything from before: background sub-agents and workflows ended with it
    // (stopped as read, so the count never shows them, also not on the way).
    rt.loadRestored(file.items, file.todos, file.queue ?? []);
    // A file that is there but cannot be read is left exactly as it is (nothing is written to it).
    if (file.unreadable) {
      this.unreadable.add(rt.id);
      rt.notice('error', 'This chat could not be read from disk', 'Nothing is written to it. Restart Sable to try again.');
    }
    // What was in flight when Sable closed ended then, not now (the chat may be opened much later).
    rt.settle('cancelled', { endUnknown: true });
    // Messages still waiting for the agent when Sable closed (a steer not taken yet) would wait forever: back to the queue.
    rt.returnUntaken({ all: true, reason: 'closed' });
    const lost = this.untilLost.get(rt.id);
    if (lost) this.untilLost.delete(rt.id), this.until.restored(rt, lost);
  }

  /**
   * Puts a message in the timeline and hands it to the agent. Mid-turn it is steered: the agent
   * takes it at its next step; it waits where it was sent and then stands where the agent took it.
   */
  private async deliver(rt: SessionRuntime, text: string, attachments?: UserItem['attachments'], extra?: Pick<UserItem, 'until'>, ctx?: CallContext) {
    // From here to its dispatch no return to another account begins (review wave 16, #11): a message
    // goes to exactly one account, never while a move is half done.
    this.sending.set(rt.id, (this.sending.get(rt.id) ?? 0) + 1);
    try {
      await this.deliverNow(rt, text, attachments, extra, ctx);
    } finally {
      const n = (this.sending.get(rt.id) ?? 1) - 1;
      if (n > 0) this.sending.set(rt.id, n);
      else this.sending.delete(rt.id);
    }
  }

  private async deliverNow(rt: SessionRuntime, text: string, attachments?: UserItem['attachments'], extra?: Pick<UserItem, 'until'>, ctx?: CallContext) {
    // Past its account's cap, the session moves to the next account before the message goes out.
    // The first message names the session's lane, or moves it into one when its folder got busy.
    // A caller that may no longer act (a phone removed meanwhile) is asked again after every wait.
    // Moving to another account (compacting first): the message waits in the queue and goes there.
    if (this.moving.has(rt.id)) {
      const q = rt.enqueue(text, attachments);
      // Its sender's guard goes along: a phone removed meanwhile never has it sent (review wave 8, #21).
      if (ctx?.allowed) this.queueGuards.set(q.id, ctx);
      this.queuedWhileMoving.add(rt.id);
      return;
    }
    // A limit's transition runs (background work being stopped, the move after it): the message waits
    // in the queue, with its sender's guard, and goes once that is over (review wave 17, #5).
    if (this.sendHolds.has(rt.id)) return void this.queueBehindHold(rt, text, attachments, ctx);
    if (!extra?.until && !rt.items.some((i) => i.type === 'user')) await this.lanes.beforeFirstSend(rt, text);
    still(ctx);
    if (!rt.turnActive && !this.opening.has(rt.id)) {
      const stops = this.stopsOf(rt);
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
        return void this.queueBehindHold(rt, text, attachments, ctx);
      }
      // The return is still moving the chat (compacting first): the message goes there once it is done.
      if (this.moving.has(rt.id)) {
        const q = rt.enqueue(text, attachments);
        if (ctx?.allowed) this.queueGuards.set(q.id, ctx);
        this.queuedWhileMoving.add(rt.id);
        return;
      }
      await this.checkCap(rt);
      // Stopped (or closed) while the cap check moved the chat (compacting first): the message starts
      // no turn after the Stop; it waits in the queue for the person (review wave 8, #21).
      if (this.stopsOf(rt) !== stops) {
        if (this.sessions.get(rt.id) === rt) rt.enqueue(text, attachments);
        return;
      }
    }
    still(ctx);
    const addUser = () => {
      if (rt.meta.titleSource === 'auto' && !rt.items.some((i) => i.type === 'user')) {
        rt.update({ title: extra?.until?.check ? autoTitle(`Until ${extra.until.check.command} passes`) : autoTitle(text) });
      }
      // The chat just used goes to the top of its folder at once.
      rt.touch();
      return rt.add<UserItem>({
        type: 'user',
        text,
        attachments: attachments?.length ? attachments : undefined,
        state: rt.turnActive ? 'queued' : 'sent',
        ...(rt.turnActive ? { steered: true } : {}),
        ...(extra?.until ? { until: extra.until } : {}),
      });
    };
    // The agent is not there yet (a new session still starting, or a restored one whose agent
    // starts with this message; Codex can take most of a minute): show the message now, send it
    // once the agent is there.
    let early: UserItem | undefined;
    // An agent that cannot start at all (its account was removed) refuses the message outright.
    if (!rt.handle && !this.opening.has(rt.id)) this.provider(rt.meta.provider, rt.meta.accountId);
    if (this.opening.has(rt.id) || !rt.handle) {
      early = addUser();
      this.delivering.add(rt.id);
      this.earlyWaiting.set(rt.id, [...(this.earlyWaiting.get(rt.id) ?? []), early.id]);
      if (rt.meta.status !== 'starting') rt.update({ status: 'starting' });
    }
    let handle: ProviderSession;
    try {
      handle = await this.ensureHandle(rt);
    } catch (err) {
      if (!early) throw err;
      if (this.stoppedEarly.delete(early.id)) return;
      rt.update({ status: 'error', lastError: (err as Error).message });
      rt.notice('error', 'Could not send the message', (err as Error).message);
      return;
    } finally {
      this.delivering.delete(rt.id);
      if (early) this.earlyWaiting.set(rt.id, (this.earlyWaiting.get(rt.id) ?? []).filter((id) => id !== early.id));
    }
    // Stopped while the agent was starting: the message stays where it was sent, and is not sent later.
    if (early && this.stoppedEarly.delete(early.id)) return;
    // Its phone was removed while it waited: it never goes out (one shown early leaves the chat, said in a line).
    const gone = () => {
      if (!ctx?.allowed || ctx.allowed()) return;
      if (early) {
        rt.remove(early.id);
        if (!rt.turnActive && rt.meta.status === 'starting') rt.update({ status: 'idle' });
        rt.notice('info', 'A message from a removed phone was not sent');
      }
      throw new CallerGone();
    };
    gone();
    // A model chosen since the agent started takes effect now, with this message (never inside a running turn).
    await this.applyDue(rt, handle);
    gone();
    // Right before the dispatch, whatever came first (a first message while the agent opened, a queued
    // one, a steer): never on credits the account's own setting forbids (review wave 17, #2).
    if (await this.heldForCredits(rt)) {
      // Its sender is asked again before anything of it is recorded (#3).
      gone();
      if (rt.turnActive) {
        // A steer: held in the queue with its guard; the running turn goes on, and at its end the
        // message is looked at again like any other.
        if (early) rt.remove(early.id);
        const q = rt.enqueue(text, attachments);
        if (ctx?.allowed) this.queueGuards.set(q.id, ctx);
        return;
      }
      // As if the agent refused it at the limit, without asking it: the message stands, the limit's
      // notice follows, and the turn's end decides as for any refusal (`onLimitHit`: the next account
      // carries the same message on, with its sender's guard, or "Continue with" / "Continue at reset").
      const refused = early ?? addUser();
      if (ctx?.allowed) this.refusedGuards.set(refused.id, ctx);
      rt.beginTurn('Thinking');
      rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'You have reached your usage limit.', limit: { ...this.creditsWindow(rt) } });
      rt.endTurn('You have reached your usage limit.');
      return;
    }
    gone();
    const item = early ?? addUser();
    const runningSince = item.steered ? rt.turnStartedAt : undefined;
    const unhand = this.handOver(rt, item.id);
    try {
      // The guard goes along to the agent's own dispatch (review wave 6, #3): an adapter that waits
      // first (Codex loading its thread) asks it again right before the message goes.
      const out = this.withHandover(rt, item);
      await handle.send(this.withBrowserPage(rt, out.item), { check: () => still(ctx) });
      out.taken();
    } catch (err) {
      unhand();
      if (err instanceof CallerGone) {
        // Its phone was removed while the agent got ready: nothing of it went to the agent. A turn it
        // began ends (nothing runs in it); a turn it was steered into goes on.
        rt.remove(item.id);
        if (rt.turnActive && !(item.steered && rt.turnStartedAt === runningSince)) {
          rt.settle('cancelled');
          rt.endTurn();
        }
        rt.notice('info', 'A message from a removed phone was not sent');
        throw err;
      }
      // A steer the agent could not take: the turn it was meant for goes on, and the message waits in the queue.
      if (item.steered && rt.turnActive && rt.turnStartedAt === runningSince && rt.get<UserItem>(item.id)?.state === 'queued') {
        this.log('steer failed; back to the queue', (err as Error).message);
        rt.remove(item.id);
        rt.requeue([{ id: item.id, text: item.text, attachments: item.attachments, createdAt: item.ts }]);
        return;
      }
      // The turn this message began has ended since (its end stands after it): a failure of its send
      // that comes now is that turn's, and never ends the one running now (begun by a newer message).
      const at = item.steered ? -1 : rt.items.findIndex((i) => i.id === item.id);
      if (at >= 0 && rt.items.slice(at + 1).some((i) => i.type === 'turn' && !i.parentId)) {
        this.log('a send failed after its turn ended; nothing else ends', (err as Error).message);
        return;
      }
      rt.notice('error', 'Could not send the message', (err as Error).message);
      rt.endTurn((err as Error).message);
    }
  }

  /**
   * The message as the agent gets it: after a move to another account without the conversation, the
   * summary goes first (once); after a switch of agent, the handover of what that agent has not seen.
   */
  private withHandover(rt: SessionRuntime, item: UserItem): { item: UserItem; taken: () => void } {
    // A slash command takes nothing before or after it (the agent would read it as its words): what
    // is pending waits for the next message.
    if (isSlashCommand(item.text)) return { item, taken: () => {} };
    const pending = rt.meta.agentHandover;
    const kept = this.handovers.get(rt.id);
    const moved = rt.meta.moveNote;
    // A summary of the whole conversation covers what a switch would hand over.
    const summary = kept ?? ((moved?.summary ? this.moveSummaryText(rt, moved.summary, moved.skip) : '') || (pending ? this.agentHandoverText(rt, pending, item.id) : ''));
    // After a move to another account: a short note after the person's words, once.
    const note = moved ? this.moveNoteText(rt, moved.line, item.id) : '';
    // All of it is let go only once the agent took the message (review wave 8, #22): a send that
    // never went out (a phone removed meanwhile, the agent not starting) leaves it for the next one.
    const taken = () => {
      if (pending && rt.meta.agentHandover === pending) rt.update({ agentHandover: null });
      if (kept !== undefined && this.handovers.get(rt.id) === kept) this.handovers.delete(rt.id);
      if (moved && rt.meta.moveNote === moved) rt.update({ moveNote: null });
    };
    if (!summary && !note) return { item, taken };
    return { item: { ...item, text: `${summary ? `${summary}${HANDOVER_JOIN}` : ''}${item.text}${note ? `\n\n${note}` : ''}` }, taken };
  }

  /** The summary a move without the conversation carries: the chat before its switch line, as it stood then. */
  private moveSummaryText(rt: SessionRuntime, line: string, skip?: string): string {
    const at = rt.items.findIndex((i) => i.id === line);
    return handoverText(withoutChecks(at >= 0 ? rt.items.slice(0, at) : rt.items), { skip });
  }

  /** The note after a move: what the person waits on and the open todos, as the chat stood at its switch line. */
  private moveNoteText(rt: SessionRuntime, line: string, skip: string): string {
    const at = rt.items.findIndex((i) => i.id === line);
    return moveNote(at >= 0 ? rt.items.slice(0, at) : rt.items, rt.todos, { skip });
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
    const caps = rt.caps ?? this.cache.get<Capabilities>(capsCacheKey(rt.meta.provider, rt.meta.accountId ?? DEFAULT_ACCOUNT, rt.meta.cwd)) ?? (await this.capsFast(rt.meta.provider, rt.meta.cwd, rt.meta.accountId ?? DEFAULT_ACCOUNT).catch(() => undefined));
    const own = matchModel(query, caps?.models ?? []);
    if (own) {
      this.setSessionModel(rt, own.id);
      return { ok: true, model: own.id };
    }
    for (const p of this.otherAgents()) {
      if (p === rt.meta.provider) continue;
      const accountId = rt.meta.agents?.find((l) => l.provider === p)?.accountId ?? this.defaultAccountId(p);
      const theirs = this.cache.get<Capabilities>(capsCacheKey(p, accountId, rt.meta.cwd)) ?? this.cache.get<Capabilities>(capsCacheKey(p, accountId));
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
  private async knownLimits(provider: ProviderId): Promise<Map<string, { limits?: RateLimit[]; planLimits?: boolean }>> {
    // An agent's first word names who is signed in: limits kept from another person's sign-in are
    // forgotten with it (noteSignIns), so no decision is made on them a moment before.
    await this.firstWord(provider);
    const out = new Map<string, { limits?: RateLimit[]; planLimits?: boolean }>();
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
  async nextAccount(provider: ProviderId, current: string, opts: { model?: string; cwd?: string; rt?: SessionRuntime; byCap?: boolean; except?: Iterable<string> } = {}): Promise<string | undefined> {
    // The sign-ins first: one that changed forgets its old limits before they are read.
    const info = await this.providerInfo(provider);
    const known = await this.knownLimits(provider);
    const accounts = info.accounts ?? [];
    const cwd = opts.rt?.meta.cwd ?? opts.cwd;
    const capsOf = (accountId: string) => this.cache.get<Capabilities>(capsCacheKey(provider, accountId, cwd)) ?? this.cache.get<Capabilities>(capsCacheKey(provider, accountId));
    const chosen = opts.rt ? opts.rt.meta.model : opts.model;
    const ownCaps = (opts.rt?.caps ?? capsOf(current))?.models;
    const model = effectiveModel(chosen || undefined, ownCaps, this.store.state.settings.defaultModels[provider]);
    // The chat's own model as its account lists it: another account whose known list leaves it out cannot take the chat (review wave 7, #12).
    const named = chosen && chosen !== 'default' && ownCaps?.some((m) => m.id === chosen) ? chosen : undefined;
    const offers = (accountId: string) => {
      if (!named) return true;
      const models = capsOf(accountId)?.models;
      return !models?.length || models.some((m) => m.id === named);
    };
    const except = new Set(opts.except ?? []);
    for (const a of accounts) if (a.id !== current && !offers(a.id)) except.add(a.id);
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
      { model, plan: accounts.find((a) => a.id === current)?.auth.plan, byCap: opts.byCap, useFirst: !manual, manual, except },
    );
  }

  /**
   * The model a chat's turns run on, as per-model windows name it (the alias "default" resolved):
   * one reading for ranking, moves, caps and reset notices (review wave 8, #27).
   */
  private chatModel(rt: SessionRuntime): string | undefined {
    const caps = rt.caps ?? this.cache.get<Capabilities>(capsCacheKey(rt.meta.provider, rt.meta.accountId ?? DEFAULT_ACCOUNT, rt.meta.cwd));
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
    const caps = this.cache.get<Capabilities>(capsCacheKey(provider, accountId, cwd)) ?? this.cache.get<Capabilities>(capsCacheKey(provider, accountId));
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
      .finally(() => this.capChecks.delete(rt.id));
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
    if (rt.turnActive || (rt.meta.accountId ?? DEFAULT_ACCOUNT) !== from || this.sessions.get(rt.id) !== rt) return;
    const name = this.accountLabel(provider, from);
    if (!next) {
      const key = `${rt.id}:${from}:${reached.kind}:${reached.resetsAt ?? ''}`;
      if (this.capWarned.has(key)) return;
      this.capWarned.add(key);
      rt.notice('info', capReason(name, reached), 'No other account is under its cap, so this chat stays here');
      return;
    }
    this.movedByLimit(rt, from, next, reached.resetsAt);
    await this.switchAccount(rt, next, { line: `Moved to ${this.accountLabel(provider, next)}: ${capReason(name, reached)}` });
  }

  /**
   * A turn was refused at a plan limit: the notice learns which account, when the window resets and
   * which account could carry on. With "Continue with the next account at a limit" on, the session
   * moves there and the refused message goes out again (once per message and account). A turn
   * Spare started (`spare`) never moves: it waits again instead (`SpareWaits.limitHit`).
   */
  private async onLimitHit(rt: SessionRuntime, notice: NoticeItem, spare = false, settleMs = this.backgroundLimitMs?.settle ?? BACKGROUND_LIMIT_SETTLE_MS) {
    const provider = rt.meta.provider;
    const accountId = rt.meta.accountId ?? DEFAULT_ACCOUNT;
    // Still the same chat, open and on this account after every wait below (review wave 16, #10).
    const closes = this.closesOf(rt);
    const open = () => this.sessions.get(rt.id) === rt && this.closesOf(rt) === closes && (rt.meta.accountId ?? DEFAULT_ACCOUNT) === accountId;
    const known = await this.knownLimits(provider);
    // Every window that is used up and holds this chat's model has to reset before the account can
    // work again; another model's full week is not this chat's wait (review wave 8, #27).
    const model = this.chatModel(rt);
    const now = Date.now();
    const own = (known.get(accountId)?.limits ?? []).filter((l) => l.percent >= 100 && !(l.resetsAt && l.resetsAt <= now) && (!windowModel(l) || !model || windowForModel(l, model)));
    const full = own.sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0];
    // The accounts that already refused this message are not tried again (review wave 7, #10).
    const refused = this.refusedMessage(rt);
    const done = this.autoContinued.get(rt.id) ?? new Set<string>();
    const mark = `${refused?.id ?? ''}:`;
    const tried = [...done].flatMap((k) => (k.startsWith(mark) ? [k.slice(mark.length)] : []));
    const next = await this.nextAccount(provider, accountId, { rt, except: tried }).catch(() => undefined);
    if (!open()) return;
    const limit = { ...notice.limit, provider, accountId, resetsAt: notice.limit?.resetsAt ?? full?.resetsAt, window: notice.limit?.window ?? full?.label, ...(next ? { next } : {}) };
    // A refused turn was not carried by credits, so only the next account or the notice remain.
    const settings = this.store.state.settings;
    const moves = decideAtLimit({ creditsAllowed: false, creditsAvailable: false, continueAtLimit: !!settings.continueAtLimit, next }) === 'next' && !!next;
    // Moving by itself: the notice never offers the button for it, not even for a frame.
    const willMove = !spare && moves && !rt.turnActive && !done.has(`${mark}${next}`);
    rt.patch<NoticeItem>(notice.id, { limit: willMove ? { ...limit, moving: true } : limit });
    if (spare) return;
    if (!moves && !rt.turnActive) {
      // Nothing goes on on the account at its limit, whatever comes next (review wave 16, #6); sends
      // queue behind the stop (review wave 17, #5).
      await this.holdSends(rt, this.settleBackground(rt, limit, settleMs));
      if (!open()) return;
      // No other account takes over: the chat waits for this account's reset and then carries on by itself.
      if (settings.continueAtReset) this.spare.atReset(rt);
    }
    if (!moves || rt.turnActive) return;
    const key = `${mark}${next}`;
    if (done.has(key)) return;
    done.add(key);
    // This account refused it: a later limit of the same message does not come back here.
    done.add(`${mark}${accountId}`);
    this.autoContinued.set(rt.id, done);
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
          if (rt.turnActive || this.moving.has(rt.id) || rt.get<NoticeItem>(notice.id)?.limit?.continuedWith || !open()) return;
          this.movedByLimit(rt, accountId, next, full?.resetsAt ?? limit.resetsAt);
          await this.switchAccount(rt, next, { retry: true });
        })(),
      );
    } finally {
      // Not moved after all (it failed, or something took over): the notice offers the move again.
      const card = rt.get<NoticeItem>(notice.id);
      if (card?.limit?.moving) rt.patch<NoticeItem>(notice.id, { limit: { ...card.limit, moving: undefined } });
    }
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
    const row = hit.window ? this.limitsCache.get(accountKey(rt.meta.provider, accountId))?.find((l) => l.label === hit.window) : undefined;
    const model = this.chatModel(rt);
    if (row && model && !windowForModel(row, model)) return;
    const now = Date.now();
    let open = rt.limitCard ? rt.get<NoticeItem>(rt.limitCard) : undefined;
    if (open?.limit?.continuedWith) open = undefined;
    if (!open) {
      open = rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'You have reached your usage limit.', ...(hit.detail ? { detail: hit.detail } : {}), limit: { resetsAt: hit.resetsAt, window: hit.window } });
      rt.limitCard = open.id;
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
  }

  /** The limit background work met is decided now: as a refused turn's (`onLimitHit`), unless a turn took it over meanwhile. */
  private async decideBackgroundLimit(rt: SessionRuntime, card: string) {
    const state = this.bgLimits.get(rt.id);
    if (state?.card === card) this.bgLimits.delete(rt.id);
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
  private async stopLiveBackground(rt: SessionRuntime, limit: { window?: string; resetsAt?: number }) {
    // Work already found unstoppable is not asked again.
    const running = rt.items.filter((i) => worksInBackground(i) && !this.unstoppable.get(rt.id)?.has(i.id)).map((i) => i.id);
    if (!running.length) return;
    type Stop = boolean | { failed: string[] };
    const h = rt.handle as (ProviderSession & { stopBackgroundWork?: () => Promise<Stop> }) | undefined;
    const bounded = (p: Promise<Stop>) => Promise.race([p.catch((): Stop => false), new Promise<Stop>((r) => setTimeout(() => r(false), MOVE_CLOSE_MS))]);
    let result: Stop = true;
    if (h?.stopBackgroundWork) result = await bounded(h.stopBackgroundWork());
    else if (h) {
      rt.handle = undefined;
      result = await bounded(
        Promise.resolve()
          .then(() => h.close())
          .then(() => true),
      );
    }
    const failed = new Set(result === true ? [] : result === false ? running : result.failed.filter((id) => running.includes(id)));
    const done = new Set(running.filter((id) => !failed.has(id)));
    if (done.size) rt.stopAtLimit((i) => done.has(i.id), limit);
    if (!failed.size) return;
    this.log('background work at a limit: its stop was not confirmed for', failed.size);
    this.unstoppable.set(rt.id, new Set([...(this.unstoppable.get(rt.id) ?? []), ...failed]));
    const n = failed.size;
    rt.notice('info', `${n === 1 ? 'A sub-agent' : `${n} sub-agents`} could not be stopped`, `${n === 1 ? 'It' : 'They'} may still be working on ${this.accountLabel(rt.meta.provider, rt.meta.accountId ?? DEFAULT_ACCOUNT)}.`);
  }

  /** Per chat, background steps whose stop at a limit was not confirmed: a move goes ahead beside them. */
  private unstoppable = new Map<string, Set<string>>();

  /** Remembers a limit handover: the session's preferred account, and where new sessions go meanwhile. */
  private movedByLimit(rt: SessionRuntime, from: string, to: string, until?: number) {
    // The account the chat goes back to (`returnAfterLimit`): the first one a limit moved it from, unless it goes back there now.
    const origin = rt.meta.movedFrom && rt.meta.movedFrom !== to ? rt.meta.movedFrom : from;
    rt.update({ movedFrom: origin, returnAt: origin === from ? until : rt.meta.returnAt });
    this.armReturn(rt);
    if (from === this.defaultAccountId(rt.meta.provider)) {
      this.fallbacks.set(rt.meta.provider, { from, to, until });
      void this.emitProvider(rt.meta.provider).catch(() => {});
      this.scheduleResetAlert();
    }
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
  private refusedGuards = new Map<string, CallContext>();

  /** Sends to the chat queue behind `p` until it settles (with any other hold). */
  private holdSends<T>(rt: SessionRuntime, p: Promise<T>): Promise<T> {
    let set = this.sendHolds.get(rt.id);
    if (!set) this.sendHolds.set(rt.id, (set = new Set()));
    set.add(p);
    const release = () => {
      set!.delete(p);
      if (set!.size || this.sendHolds.get(rt.id) !== set) return;
      this.sendHolds.delete(rt.id);
      // Drained once, with each message's own guard, on the account the chat is on now.
      if (this.heldSends.delete(rt.id))
        setTimeout(() => {
          if (this.sessions.get(rt.id) !== rt || this.sendHolds.has(rt.id)) return;
          if (this.moving.has(rt.id)) return void this.queuedWhileMoving.add(rt.id);
          if (!rt.turnActive && !rt.stopRequested) this.sendNextQueued(rt);
        }, 0);
    };
    p.then(release, release);
    return p;
  }

  private queueBehindHold(rt: SessionRuntime, text: string, attachments?: UserItem['attachments'], ctx?: CallContext) {
    const q = rt.enqueue(text, attachments);
    if (ctx?.allowed) this.queueGuards.set(q.id, ctx);
    this.heldSends.add(rt.id);
  }

  /** The refused message's sender may still act (a phone not removed meanwhile); said once when not. */
  private refusedAllowed(rt: SessionRuntime, id: string): boolean {
    const guard = this.refusedGuards.get(id);
    if (!guard?.allowed || guard.allowed()) return true;
    this.refusedGuards.delete(id);
    rt.notice('info', 'A message from a removed phone was not sent');
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
    const bg = this.bgLimits.get(rt.id);
    if (bg) clearTimeout(bg.timer);
    this.bgLimits.delete(rt.id);
    clearTimeout(this.returnTimers.get(rt.id));
    this.returnTimers.delete(rt.id);
  }

  /** The chat is at rest and no transition or send of it runs: nothing visible is in the way of a move. */
  private atRest(rt: SessionRuntime): boolean {
    return (
      this.sessions.get(rt.id) === rt &&
      !rt.turnActive &&
      !(rt.meta.background ?? 0) &&
      !this.moving.has(rt.id) &&
      !this.switching.has(rt.id) &&
      !this.opening.has(rt.id) &&
      !this.delivering.has(rt.id) &&
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
    });
    this.returnRuns.set(rt.id, run);
    return run;
  }

  private async tryReturn(rt: SessionRuntime, opts: { retry?: boolean }): Promise<void> {
    const from = rt.meta.movedFrom;
    if (!from) return;
    const provider = rt.meta.provider;
    const current = rt.meta.accountId ?? DEFAULT_ACCOUNT;
    const forget = () => {
      rt.update({ movedFrom: undefined, returnAt: undefined });
      this.returnTries.delete(rt.id);
      this.armReturn(rt);
    };
    // Back on it already, or the account is gone: nothing is owed any more.
    if (from === current || !this.findAccount(provider, from)) return forget();
    if (!this.atRest(rt)) return;
    const at = rt.meta.returnAt;
    if (at && Date.now() < at) return this.armReturn(rt);
    const key = `${rt.id}:${from}:${at ?? ''}`;
    const checked = this.returnChecked.get(rt.id);
    if (this.returned.has(key) || (!opts.retry && checked && Date.now() - checked < RETURN_RECHECK_MS)) return;
    const closes = this.closesOf(rt);
    // Still the same chat, open, owing this return, on the account it went to.
    const still = () => this.sessions.get(rt.id) === rt && this.closesOf(rt) === closes && rt.meta.movedFrom === from && (rt.meta.accountId ?? DEFAULT_ACCOUNT) === current;
    // A reading that could not tell (failed, not fresh, no room shown): one more try, later each time.
    const inconclusive = () => {
      this.returnChecked.set(rt.id, Date.now());
      const tries = this.returnTries.get(rt.id) ?? 0;
      this.returnTries.set(rt.id, tries + 1);
      this.armReturn(rt, returnRetryMs(tries));
    };
    let reading: { limits: RateLimit[]; fresh: boolean };
    try {
      reading = await this.readLimits(provider, from, 'fresh');
    } catch {
      if (still()) inconclusive();
      return;
    }
    if (!still()) return;
    const model = this.chatModel(rt);
    const now = Date.now();
    const cap = this.capOf(provider, from);
    const rank = rankAccount({ id: from, signedIn: true, limits: reading.limits, cap }, now, model);
    const full = atCap(reading.limits, now, model) || !!capReached(reading.limits, cap, model, now) || rank.state === 'held' || rank.state === 'spent';
    if (reading.fresh && full) {
      // Still held, as a fresh reading says: looked at again when the window that holds it resets.
      this.returnChecked.set(rt.id, now);
      this.returnTries.delete(rt.id);
      const held = reading.limits.filter((l) => l.percent >= 100 && l.resetsAt && l.resetsAt > now && windowForModel(l, model));
      const until = rank.until ?? (rank.state === 'spent' ? rank.expiresAt : undefined) ?? (held.length ? Math.max(...held.map((l) => l.resetsAt!)) : undefined);
      if (until && until > now) {
        rt.update({ returnAt: until });
        this.armReturn(rt);
      } else this.armReturn(rt, returnRetryMs(0));
      return;
    }
    // Never on a guess: only a fresh reading that shows room for the chat's model.
    if (!readingShowsRoom({ fresh: reading.fresh, limits: reading.limits, model, now, full })) return inconclusive();
    this.returnTries.delete(rt.id);
    const to = returnTarget({ from, current, fromTakesWork: true });
    // A chat not read since the start (the timer after a restart): read beside the app, never in its way.
    if (to) await this.hydrateAsync(rt).catch(() => {});
    // A chat that could not be read (its file locked or broken, or the read failed) is not moved: a
    // move may have to start the conversation over from the timeline, and there is none. The return
    // stays owed and is looked at again at the next start or the person's next message.
    if (to && (this.lazy.has(rt.id) || this.unreadable.has(rt.id))) return;
    // Only at rest, looked at again after the wait (never mid-turn, never beside another transition).
    if (!to || !still() || !this.atRest(rt)) return;
    this.returned.add(key);
    try {
      await this.switchAccount(rt, to, { line: `Back on ${this.accountLabel(provider, to)}` });
    } catch (err) {
      // Not moved: the chat still owes its return, tried again later.
      this.returned.delete(key);
      if (still()) inconclusive();
      throw err;
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
    const meta = this.limitsMeta.get(accountKey(provider, accountId));
    if (!runningOnCredits(meta)) return;
    const settings = this.store.state.settings;
    // The chat's model goes along: only its own windows and the shared ones count (review wave 7, #13).
    const next = settings.continueAtLimit ? await this.nextAccount(provider, accountId, { rt }).catch(() => undefined) : undefined;
    const decision = decideAtLimit({ creditsAllowed: !!settings.creditsAtLimit?.[creditsKey(provider, accountId)], creditsAvailable: true, continueAtLimit: !!settings.continueAtLimit, next });
    if (decision === 'credits' || rt.turnActive) return;
    const until = meta?.extra?.resetsAt ?? meta?.credits?.resetsAt;
    if (decision === 'next' && next) {
      this.movedByLimit(rt, accountId, next, until);
      // Past its limit: a compaction there would be paid for with credits.
      await this.switchAccount(rt, next, { compact: false });
      return;
    }
    const key = `${rt.id}:${accountId}:${until ?? ''}`;
    if (this.creditsWarned.has(key)) return;
    this.creditsWarned.add(key);
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
  private resumeMessage(rt: SessionRuntime, refused: UserItem, carried: 'conversation' | 'summary' | 'none' | 'reset'): UserItem {
    const from = rt.items.findIndex((i) => i.id === refused.id);
    const progressed = from >= 0 && rt.items.slice(from + 1).some((i) => (i.type === 'text' && i.text.trim()) || i.type === 'tool');
    // The limit met the chat's background work (its own turn had ended): nothing of the person's to send again.
    const card = rt.items.findLast((i): i is NoticeItem => i.type === 'notice' && !!i.limit && !i.parentId);
    const background = !!card && card.id === rt.limitCard;
    if (!progressed && !background) return refused;
    const text =
      carried === 'reset'
        ? RESUME_AFTER_RESET
        : carried === 'conversation' || background
          ? RESUME_UNDER_ANOTHER
          : `${refused.text}${RESUME_SUMMARY_TRAILER}`;
    // Background agents the same limit stopped: named, so the agent can start again what is still needed.
    const stopped = resumeBackgroundNote(limitStoppedAgents(rt.items, rt.takeLimitStopped()));
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
        limits: r?.limits.length ? r.limits : (this.limitsCache.get(key) ?? a.limits ?? []),
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
      if (from !== accountId) return;
      await this.resumeRefused(rt, 'reset');
      return;
    }
    const id = this.spare.pending(rt)[0];
    if (!id) return;
    const moved = from !== accountId ? await this.switchAccount(rt, accountId, { line: `Started with ${this.accountLabel(rt.meta.provider, accountId)}` }) : undefined;
    await this.sendHeld(rt, id, moved?.carried);
  }

  /** A held entry goes out: the refused turn carries on (its id), or a queued message as an ordinary send. */
  private async sendHeld(rt: SessionRuntime, id: string, carried?: 'conversation' | 'summary' | 'none') {
    if (id === this.refusedMessage(rt)?.id) return void (await this.resumeRefused(rt, carried ?? 'reset'));
    const q = rt.takeQueued(id);
    if (q) await this.deliver(rt, q.text, q.attachments);
  }

  /**
   * The turn the open limit notice refused carries on with the session's account (the refused message
   * again, or "carry on" when it got partway). `reset`: on the same account, its window having reset.
   * Nothing is sent when no limit notice is open any more (carried on by hand meanwhile).
   */
  private async resumeRefused(rt: SessionRuntime, carried: 'conversation' | 'summary' | 'none' | 'reset') {
    this.hydrate(rt);
    const accountId = rt.meta.accountId ?? DEFAULT_ACCOUNT;
    const open = rt.items.findLast((i): i is NoticeItem => i.type === 'notice' && !!i.limit && !i.limit.continuedWith && !i.parentId);
    if (!open) return;
    const refused = this.refusedMessage(rt);
    rt.patch<NoticeItem>(open.id, { limit: { ...open.limit, continuedWith: accountId, ...(carried === 'reset' ? { atReset: true } : {}) } });
    const item: UserItem = refused
      ? this.resumeMessage(rt, refused, carried)
      : { id: randomUUID(), ts: Date.now(), type: 'user', text: RESUME_LIMIT_RESET, state: 'sent' };
    const handle = await this.ensureHandle(rt);
    await this.applyDue(rt, handle);
    // Its sender (a phone) removed meanwhile, or credits the setting forbids: nothing goes (review wave 17, #2, #3).
    if (refused && !this.refusedAllowed(rt, refused.id)) return;
    if (await this.heldForCredits(rt)) return;
    // The turn carries on with the refused message: it is the one this turn answers.
    const unhand = refused ? this.handOver(rt, refused.id) : undefined;
    try {
      const out = this.withHandover(rt, item);
      await handle.send(out.item, { check: () => (refused ? still(this.refusedGuards.get(refused.id)) : undefined) });
      if (refused) this.refusedGuards.delete(refused.id);
      out.taken();
    } catch (err) {
      unhand?.();
      rt.notice('error', 'Could not send the message', (err as Error).message);
      rt.endTurn((err as Error).message);
    }
  }

  // ── refused for the sign-in (server/core/auth-gate.ts) ──

  /** One ask of the CLI per account after a refusal, and the chats that wait for a sign-in. */
  private signIns = new SignInChecks({
    ask: async (provider, accountId) => !!(await this.accountAuth(provider as ProviderId, accountId, true)).auth?.loggedIn,
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
    if (this.sessions.get(rt.id) !== rt || rt.turnActive || this.moving.has(rt.id) || this.switching.has(rt.id)) return false;
    const now = this.refusalMark(rt);
    return now.refusedId === m.refusedId && now.endId === m.endId && now.provider === m.provider && now.accountId === m.accountId && now.stops === m.stops && now.closes === m.closes;
  }

  /**
   * A turn refused for the sign-in. A moment later the CLI is asked whether the account is signed in
   * (once per account, however many chats were refused): then the message goes once more, silently.
   * When the CLI says signed out, the chat says it once and waits for the account (`resumeSignedIn`).
   */
  private async onSignInRefused(rt: SessionRuntime, refusal: { background: string[] }, mark: RefusalMark) {
    const { provider, accountId } = mark;
    const signedIn = await this.signIns.check(provider, accountId);
    // Anything changed meanwhile (stopped, closed, moved, another agent or account, a message sent or a
    // turn ended since): the person decides what happens next; nothing is retried, nothing is said.
    if (!this.sameRefusal(rt, mark)) return;
    const refused = mark.refusedId ? rt.get<UserItem>(mark.refusedId) : undefined;
    if (signedIn && refused && this.signIns.mayRetry(rt.id, refused.id)) return void (await this.sendAfterSignIn(rt, refused, refusal.background, mark));
    void this.emitProvider(provider).catch(() => {});
    if (signedIn) return void rt.notice('error', 'The sign-in was refused again');
    this.signIns.wait(provider, accountId, rt.id, refusal.background);
    // What the chat was when it began to wait: closed or stopped meanwhile, it is not started again.
    this.signInWaits.set(rt.id, { stops: mark.stops, closes: mark.closes });
    // One notice for the chat, however many requests and sub-agents were refused.
    if (rt.items.some((i) => i.type === 'notice' && !!i.auth)) return;
    const label = this.accountList(provider).length > 1 ? this.accountLabel(provider, accountId) : undefined;
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
    this.hydrate(rt);
    const handle = await this.ensureHandle(rt);
    await this.applyDue(rt, handle);
    // Checked again right before it goes: what was refused is still the chat's last word (#8).
    if (!this.sameRefusal(rt, mark) || mark.refusedId !== refused.id) return;
    const at = rt.items.findIndex((i) => i.id === refused.id);
    const after = at >= 0 ? rt.items.slice(at + 1) : [];
    const progressed = background.length > 0 || after.some((i) => (i.type === 'text' && i.text.trim()) || i.type === 'tool');
    for (const i of after) if (i.type === 'turn' && !i.parentId) rt.remove(i.id);
    const item: UserItem = progressed ? { id: randomUUID(), ts: Date.now(), type: 'user', text: `${RESUME_AFTER_SIGN_IN}${signInBackgroundNote(background)}`, state: 'sent' } : refused;
    const unhand = this.handOver(rt, refused.id);
    try {
      const out = this.withHandover(rt, item);
      await handle.send(out.item);
      out.taken();
    } catch (err) {
      unhand?.();
      rt.notice('error', 'Could not send the message', (err as Error).message);
      rt.endTurn((err as Error).message);
    }
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
  }

  /** The message the last limit notice refused: the user message just before it. */
  private refusedMessage(rt: SessionRuntime): UserItem | undefined {
    const at = rt.items.findLastIndex((i) => i.type === 'notice' && !!i.limit && !i.limit.continuedWith && !i.parentId);
    if (at < 0) return undefined;
    for (let i = at - 1; i >= 0; i--) {
      const it = rt.items[i];
      if (it.type === 'user' && !it.parentId) return it;
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
    opts: { retry?: boolean; line?: string; compact?: boolean; onCompacting?: () => void } = {},
    ctx?: CallContext,
  ): Promise<RpcMethods['session.switchAccount']['result']> {
    this.hydrate(rt);
    if (rt.turnActive) throw new Error('The agent is still working. Stop it first.');
    if (this.moving.has(rt.id)) throw new Error('This chat is moving to another account already.');
    // One transition at a time (review wave 8, #10): never while its agent is still starting (its
    // handle would come up on the account it leaves), while it switches agent, or while background
    // work runs in the process the move would close.
    if (this.opening.has(rt.id) || this.delivering.has(rt.id)) throw new Error('The agent is still starting. Move when it is ready.');
    if (this.switching.has(rt.id)) throw new Error('This chat is switching agent. Move when it is done.');
    // At a limit (the notice's move, by itself or by the click): what still runs works on the account
    // at its limit and is refused with its next request, so it stops at the limit and the chat moves.
    const atLimit = opts.retry ? rt.items.findLast((i): i is NoticeItem => i.type === 'notice' && !!i.limit && !i.limit.continuedWith && !i.parentId) : undefined;
    const target = this.provider(rt.meta.provider, accountId);
    const to = accountKey(rt.meta.provider, accountId);
    if (this.removingAccounts.has(to)) throw new Error('This account is being removed. Pick another account for this agent.');
    // The destination is held from here, before the first wait (stopping background work at a limit
    // takes a moment): it is not removed while a chat is on its way to it.
    this.movingTo.set(to, (this.movingTo.get(to) ?? 0) + 1);
    let moving = false;
    let compacted = false;
    const stops = this.stopsOf(rt);
    try {
      if (atLimit?.limit && rt.items.some((i) => worksInBackground(i) && !this.unstoppable.get(rt.id)?.has(i.id)) && (rt.meta.accountId ?? DEFAULT_ACCOUNT) !== accountId && !this.moving.has(rt.id)) await this.stopLiveBackground(rt, atLimit.limit);
      // Work a limit's stop could not end does not hold the move (it stays on the account it ran on).
      const left = this.unstoppable.get(rt.id);
      if (rt.items.some((i) => worksInBackground(i) && !left?.has(i.id))) throw new Error('Background work is still running in this chat. Move when it is done.');
      if ((rt.meta.accountId ?? DEFAULT_ACCOUNT) === accountId) return { ok: true, carried: 'none' };
      // Another move of this chat began while the background work was stopped: one at a time.
      if (this.moving.has(rt.id)) throw new Error('This chat is moving to another account already.');
      this.moving.add(rt.id);
      moving = true;
      return await this.moveAccount(rt, accountId, target, opts, ctx, () => (compacted = true));
    } finally {
      const holds = (this.movingTo.get(to) ?? 1) - 1;
      if (holds > 0) this.movingTo.set(to, holds);
      else this.movingTo.delete(to);
      if (moving) this.moved(rt, stops, compacted);
    }
  }

  /** A move ended, however: what was sent meanwhile goes out. */
  private moved(rt: SessionRuntime, stops: number, compacted: boolean) {
    this.moving.delete(rt.id);
    // What was sent meanwhile (or waited behind the compaction) goes out on the new account; after a
    // Stop or a close meanwhile it waits for the person (review wave 8, #21).
    const waited = this.queuedWhileMoving.delete(rt.id);
    if ((waited || compacted) && rt.queue.length) {
      setTimeout(() => {
        if (rt.turnActive || rt.stopRequested || this.stopsOf(rt) !== stops || this.moving.has(rt.id) || this.sessions.get(rt.id) !== rt) return;
        this.sendNextQueued(rt);
      }, 0);
    }
  }

  /** Messages a phone sent while its chat moved, queued: the guard of the pairing that sent each (by queue id). */
  private queueGuards = new Map<string, CallContext>();
  /** `session.send` by submission id: a retry of a send that went out is answered, not sent again. */
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
  private stopped(rt: SessionRuntime) {
    this.stops.set(rt.id, this.stopsOf(rt) + 1);
  }
  private closed(rt: SessionRuntime) {
    this.stopped(rt);
    this.closes.set(rt.id, this.closesOf(rt) + 1);
    // A limit decision or a return armed before never starts it again (review wave 16, #10).
    this.dropLimitTimers(rt);
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
  private async compactBeforeMove(rt: SessionRuntime, label: string): Promise<MoveOutcome & { stable: boolean }> {
    const before = rt.meta.usage.contextTokens ?? 0;
    const opener = rt.add<UserItem>({ type: 'user', text: COMPACT_OPENER, state: 'sent' });
    const status = rt.notice('info', `Compacting before the move to ${label}`);
    let ended!: (error: string | undefined) => void;
    const done = new Promise<{ error?: string }>((resolve) => (ended = (error) => resolve({ error })));
    this.compacting.set(rt.id, (error) => ended(error));
    // One deadline for all of it, from before the agent is opened (review wave 8, #11): a start, a
    // send or a Stop that stalls never holds the move past it.
    const deadline = Date.now() + this.compactTimeoutMs;
    const TIMEOUT = Symbol('timeout');
    const within = <T,>(p: Promise<T>, ms = Math.max(0, deadline - Date.now())): Promise<T | typeof TIMEOUT> => {
      let timer: NodeJS.Timeout | undefined;
      return Promise.race([p, new Promise<typeof TIMEOUT>((r) => (timer = setTimeout(() => r(TIMEOUT), ms)))]).finally(() => clearTimeout(timer));
    };
    let ok = false;
    // The agent said the compaction turn ended (finished, failed or stopped): its transcript is whole.
    let confirmed = false;
    let handle: ProviderSession | undefined;
    try {
      const opened = await within(this.ensureHandle(rt));
      if (opened === TIMEOUT) throw new Error('the agent did not start in time');
      handle = opened;
      const sent = await within(handle.send({ ...opener, text: '/compact' }).then(() => 'sent' as const));
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
        ok = !r.error && !rt.stopRequested;
      }
    } catch (err) {
      this.log('compaction before a move failed', (err as Error).message);
      // Nothing was sent or the send failed at once: there is no turn whose writing could go on.
      confirmed = !rt.turnActive;
    } finally {
      if (rt.turnActive) {
        rt.settle('cancelled');
        rt.endTurn();
      }
      this.compacting.delete(rt.id);
      rt.remove(status.id);
    }
    const from = rt.items.findIndex((i) => i.id === opener.id);
    const after = from >= 0 ? rt.items.slice(from + 1) : [];
    // Nothing came of it (the send failed at once): the opener goes too.
    if (!after.some((i) => !i.parentId && i.type !== 'turn')) rt.remove(opener.id);
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

  private async moveAccount(
    rt: SessionRuntime,
    accountId: string,
    target: Provider,
    opts: { retry?: boolean; line?: string; compact?: boolean; onCompacting?: () => void },
    ctx: CallContext | undefined,
    onCompacted: () => void,
  ): Promise<RpcMethods['session.switchAccount']['result']> {
    const provider = rt.meta.provider;
    const fromId = rt.meta.accountId ?? DEFAULT_ACCOUNT;
    const label = this.findAccount(provider, accountId)?.label ?? 'another account';
    const refused = opts.retry ? this.refusedMessage(rt) : undefined;
    // Closed or deleted meanwhile: the move goes no further (nothing copied, the runtime untouched);
    // stopped meanwhile: it completes, but starts no turn (review wave 8, #21).
    const closes = this.closesOf(rt);
    const stops = this.stopsOf(rt);
    const live = () => {
      if (this.sessions.get(rt.id) !== rt || this.closesOf(rt) !== closes) throw new Error('The chat was closed during the move.');
      still(ctx);
    };
    // Whether the old account's transcript is whole: false when its agent may still be writing it
    // (a compaction that did not say it stopped, a close that failed or hung). Then it is not copied
    // and the chat goes on from a summary instead (review wave 8, #11).
    let stable = true;

    // A big chat compacts first where it is, when that account can still run a turn (never to carry on a refused one).
    const tokens = rt.meta.usage.contextTokens;
    let outcome: MoveOutcome = { kind: 'plain' };
    if (rt.meta.providerSessionId && target.adoptConversation && bigContext(tokens, rt.meta.usage.contextWindow)) {
      const caps = rt.caps ?? this.cache.get<Capabilities>(capsCacheKey(provider, fromId, rt.meta.cwd)) ?? this.cache.get<Capabilities>(capsCacheKey(provider, fromId));
      const can = opts.compact !== false && !opts.retry && caps?.features.compact !== false && (await this.canRunTurn(rt, fromId));
      live();
      if (can && !rt.turnActive) {
        opts.onCompacting?.();
        onCompacted();
        const compacted = await this.compactBeforeMove(rt, label);
        stable = compacted.stable;
        const { stable: _s, ...rest } = compacted;
        outcome = rest as MoveOutcome;
        live();
        if (rt.turnActive) throw new Error('The agent is still working. Stop it first.');
      } else outcome = { kind: 'asIs', tokens: tokens! };
    }

    rt.cancelPrompts();
    // A start still under way is waited for (bounded) so its handle is closed here, not installed later.
    const opening = this.opening.get(rt.id);
    if (opening) await Promise.race([opening.catch(() => {}), new Promise((r) => setTimeout(r, MOVE_CLOSE_MS))]);
    const old = rt.handle;
    rt.handle = undefined;
    if (old) {
      const closedOk = await Promise.race([
        Promise.resolve()
          .then(() => old.close())
          .then(
            () => true,
            (err: Error) => (this.log('the agent did not close cleanly before a move', err.message), false),
          ),
        new Promise<false>((r) => setTimeout(() => r(false), MOVE_CLOSE_MS)),
      ]);
      if (!closedOk) stable = false;
    }
    // A caller removed while the agent closed (a phone, review wave 6, #3): no conversation is copied, nothing moves.
    live();

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
      const adopted =
        stable && !!fromHome && !!target.adoptConversation && (await target.adoptConversation(fromHome, id).catch((err) => (this.log('could not carry the conversation over', (err as Error).message), false)));
      live();
      if (adopted) carried = 'conversation';
      else {
        // The conversation stays behind, and the timeline it would be told from could not be read: the
        // chat keeps its account and its conversation rather than starting with nothing.
        if (this.unreadable.has(rt.id)) throw new Error('This chat could not be read from disk, so it cannot start over on another account. Restart Sable and try again.');
        rt.update({ providerSessionId: undefined });
        // Kept with the chat (its switch line, below) and taken by the first message the agent accepts.
        if (handoverText(withoutChecks(rt.items), { skip: refused?.id })) {
          summaryAt = true;
          carried = 'summary';
        }
      }
    }
    // Anything that opened meanwhile on the old account goes (review wave 8, #10).
    // (Read again: an await above may have installed one.)
    const stray = rt.handle as ProviderSession | undefined;
    if (stray) {
      rt.handle = undefined;
      await Promise.race([Promise.resolve().then(() => stray.close()).catch(() => {}), new Promise((r) => setTimeout(r, MOVE_CLOSE_MS))]);
      live();
    }
    // A new conversation starts from the summary: the old count says nothing about it (the ring is
    // empty until its first turn says). A carried one keeps its count, compacted or not.
    const usage = carried === 'summary' ? { usage: { ...rt.meta.usage, contextTokens: undefined } } : {};
    if (carried === 'summary' || carried === 'none') outcome = { kind: 'plain' };
    rt.update({ accountId: accountId === DEFAULT_ACCOUNT ? undefined : accountId, status: 'idle', lastError: undefined, ...usage });
    this.persistSessions();

    // A move by a cap says why in its own line; a move at a limit closes the limit's notice. The
    // line says what the move did to the context: compacted (before and after), or read again in full.
    const clause = contextClause(outcome, !!refused);
    const summaryLine = 'With a summary of the conversation so far';
    const open = opts.line ? undefined : rt.items.findLast((i): i is NoticeItem => i.type === 'notice' && !!i.limit && !i.limit.continuedWith && !i.parentId);
    if (open) rt.patch<NoticeItem>(open.id, { limit: { ...open.limit, continuedWith: accountId } });
    let line: NoticeItem | undefined;
    if (opts.line) line = rt.notice('info', `${opts.line}${clause.suffix ?? ''}`, carried === 'summary' ? summaryLine : clause.detail);
    else if (!open || carried === 'summary') {
      line = rt.notice('info', carried === 'summary' ? `New conversation with ${label}` : `Continued with ${label}${clause.suffix ?? ''}`, carried === 'summary' ? summaryLine : clause.detail);
    } else if (clause.suffix || clause.detail) {
      // The limit's notice says where it went; one quiet line says what that did to the context.
      line = rt.notice('info', clause.suffix ? `Context${clause.suffix.replace(/^ · context/, '')}` : 'Carried as it is', clause.detail);
    }
    // The first message after the move tells the agent (moveNote): anchored at the line, so what the
    // person waits on is read from before it, also after a restart.
    const anchor = line?.id ?? open?.id ?? rt.items.findLast((i) => !i.parentId)?.id;
    // The summary, when the conversation stayed behind, is the chat before the line; one from an
    // earlier move that no message took yet stays (review wave 8, #22).
    const prev = rt.meta.moveNote;
    const summary = summaryAt && line ? { summary: line.id, ...(refused ? { skip: refused.id } : {}) } : prev?.summary ? { summary: prev.summary, ...(prev.skip ? { skip: prev.skip } : {}) } : {};
    if (anchor) rt.update({ moveNote: { line: anchor, ...summary } });
    // Stopped during the move: the refused turn does not start again by itself.
    if (refused && this.stopsOf(rt) === stops) {
      const handle = await this.ensureHandle(rt);
      // Asked again once the new account's agent is there, and by the agent's own dispatch.
      live();
      if (this.stopsOf(rt) !== stops) return { ok: true, carried };
      // Its sender (a phone) removed meanwhile: the refused message never goes (review wave 17, #3).
      if (!this.refusedAllowed(rt, refused.id)) return { ok: true, carried };
      await this.applyModeDue(rt, handle);
      const unhand = this.handOver(rt, refused.id);
      try {
        const out = this.withHandover(rt, this.resumeMessage(rt, refused, carried));
        await handle.send(out.item, { check: () => (still(ctx), still(this.refusedGuards.get(refused.id))) });
        this.refusedGuards.delete(refused.id);
        out.taken();
      } catch (err) {
        unhand();
        if (err instanceof CallerGone) {
          if (rt.turnActive) {
            rt.settle('cancelled');
            rt.endTurn();
          }
          throw err;
        }
        rt.notice('error', 'Could not send the message', (err as Error).message);
        rt.endTurn((err as Error).message);
      }
    }
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
    this.hydrate(rt);
    const from = rt.meta.provider;
    if (provider === from) {
      if (opts.model) this.setSessionModel(rt, opts.model);
      return { ok: true };
    }
    if (!this.providers.has(provider)) throw new Error(`Provider not available: ${provider}`);
    // The Customize chat only with an agent that gets its brief (`services/custom.ts`).
    if (rt.meta.custom && !customAgent(provider)) throw new Error(CUSTOM_AGENT_ONLY);
    if (rt.turnActive || this.opening.has(rt.id) || this.delivering.has(rt.id) || this.capChecks.has(rt.id)) throw new Error('The agent is still working. Switch when it is done.');
    // Never over a move of account, nor two switches at once (review wave 8, #10).
    if (this.moving.has(rt.id) || this.switching.has(rt.id)) throw new Error('This chat is changing account or agent. Switch when it is done.');
    if (backgroundRunning(rt.items)) throw new Error('Background work is still running in this chat. Switch when it is done.');
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
    const cached = this.cache.get<Capabilities>(capsCacheKey(provider, accountId, cwd));
    const defaultModel = (caps: Capabilities | undefined) => caps?.models.find((m) => m.isDefault)?.id ?? caps?.models[0]?.id;
    const model = opts.model || (keeps ? target!.model : '') || settings.defaultModels[provider] || defaultModel(cached) || '';
    const prev = legs.find((l) => l.provider === from);

    rt.cancelPrompts();
    this.switching.add(rt.id);
    try {
      await rt.handle?.close().catch(() => {});
    } finally {
      this.switching.delete(rt.id);
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
  private afterTurn(rt: SessionRuntime, error?: string, hold = false) {
    // The compaction before a move ended: the move goes on (nothing is sent, nothing else follows).
    const compacted = this.compacting.get(rt.id);
    if (compacted) return compacted(error);
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
    const ran = this.spare.turnEnded(rt);
    const hit = rt.items.findLast((i): i is NoticeItem => i.type === 'notice' && !!i.limit && !i.limit.provider && !i.parentId);
    if (hit) {
      // A turn Spare started waits again at a limit instead of going on with another account.
      if (ran) this.spareLimitHit(rt, ran, hit);
      void this.onLimitHit(rt, hit, !!ran).catch((err) => this.log('limit follow-up failed', (err as Error).message));
    } else {
      // Past its cap now: the session moves before anything else goes out (a queued message waits for it).
      void this.checkCap(rt);
      // Spare's own turns never go on with credits or another account (a spare turn on credits is stopped).
      if (!error && !ran) void this.onCredits(rt).catch((err) => this.log('credits follow-up failed', (err as Error).message));
    }
    // An until loop stopped during the turn says so after it.
    this.until.turnOver(rt);
    // What the turn took (nothing of a failed or stopped one, nor of one whose end is not known).
    const consumed = this.consumed(rt, !error && !rt.stopRequested && !hold);
    if (error || rt.stopRequested || hold) {
      // Steered messages the agent never took go back to the queue, to send or edit again.
      const back = rt.returnUntaken({ reason: error ? 'failed' : 'stopped' });
      if (hold && !back && rt.queue.length) rt.notice('info', 'Queued messages wait', 'The agent did not say how the last turn ended. Send them when you are ready.');
      // An until loop waits for the next turn, as the queue waits for the user.
      this.until.turnHeld(rt);
      return;
    }
    // The chat's first turn settled: a small model names it from the message it took, in the background.
    this.titles.turnEnded(rt, consumed);
    // Let the adapter finish its own bookkeeping (it may start a turn of its own first, with a
    // steered message the turn ended before taking).
    setTimeout(() => {
      if (rt.turnActive || rt.stopRequested || this.sessions.get(rt.id) !== rt) return;
      // A steered message no turn took and no adapter carried on is never left waiting: it goes out first.
      rt.returnUntaken();
      const rest = !rt.queue.length && !rt.meta.until;
      this.sendNextQueued(rt);
      // Nothing more to do: a chat a limit moved away goes back once that account takes work again.
      if (rest) void this.returnAfterLimit(rt).catch((err) => this.log('return after a limit failed', (err as Error).message));
    }, 0);
  }

  /** Sessions whose next queued message is being taken back by a phone: the queue goes on when that take settles. */
  private drainWaiting = new Set<string>();

  /** After a turn: the next queued message goes out, or (nothing waits) an until loop runs its check. */
  private sendNextQueued(rt: SessionRuntime): void {
    // Moving to another account: the queue goes on there once the move is done.
    if (this.moving.has(rt.id)) return void this.queuedWhileMoving.add(rt.id);
    // Messages held for Spare stay where they are: the chat starts them by itself.
    const held = this.spare.held(rt);
    const nextId = rt.queue.find((q) => !held.has(q.id))?.id;
    // A phone is taking it back right now: it neither goes nor is skipped; the queue goes on once that settles.
    if (rt.isReserved(nextId)) return void this.drainWaiting.add(rt.id);
    const next = nextId ? rt.takeQueued(nextId) : undefined;
    const guard = next ? this.queueGuards.get(next.id) : undefined;
    if (next) this.queueGuards.delete(next.id);
    // Queued during a move by a phone removed since: it never goes out; the next one may.
    if (next && guard?.allowed && !guard.allowed()) {
      rt.notice('info', 'A message from a removed phone was not sent');
      return this.sendNextQueued(rt);
    }
    if (next) void this.deliver(rt, next.text, next.attachments, undefined, guard).catch((err) => this.log('queued send failed', (err as Error).message));
    // Nothing waits: an until loop runs its check (the user's messages always go first).
    else this.until.turnEnded(rt);
  }

  /** A phone's take of a queued message went through (phone.ts): it leaves the queue if it is still the one reserved. */
  takeReserved(rt: SessionRuntime, id: string, rev: number) {
    const message = rt.commitReserved(id, rev);
    if (message) this.spare.queueChanged(rt);
    return message;
  }

  private async ensureHandle(rt: SessionRuntime) {
    const opening = this.opening.get(rt.id);
    if (opening) {
      await opening;
      if (this.sessions.get(rt.id) !== rt) throw new Error('The session was closed while the agent was starting.');
    }
    if (rt.handle) return rt.handle;
    this.hydrate(rt);
    // One start per session: a second message sent while the agent starts waits for the same one.
    // The handle is the agent and account it was opened for: one that comes up after the chat moved
    // or switched agent is closed, never installed (review wave 8, #10), and the start is made again.
    for (let tries = 0; ; tries++) {
      const agent = rt.meta.provider;
      const account = rt.meta.accountId ?? DEFAULT_ACCOUNT;
      const opened = this.provider(agent, account)
        .open(rt, { loadTranscript: false })
        .then((handle) => {
          if (this.sessions.get(rt.id) !== rt) {
            void Promise.resolve(handle.close()).catch(() => {});
            throw new Error('The session was closed while the agent was starting.');
          }
          if (rt.meta.provider !== agent || (rt.meta.accountId ?? DEFAULT_ACCOUNT) !== account) {
            void Promise.resolve(handle.close()).catch(() => {});
            return;
          }
          rt.handle = handle;
          this.seedCaps(rt);
        });
      this.opening.set(rt.id, opened);
      try {
        await opened;
      } finally {
        if (this.opening.get(rt.id) === opened) this.opening.delete(rt.id);
      }
      if (rt.handle) return rt.handle;
      if (tries >= 2) throw new Error('The chat changed account or agent while its agent was starting.');
    }
  }

  /** Shows what the agent offers right away from the cache; the adapter's own answer replaces it. */
  private seedCaps(rt: SessionRuntime) {
    const cached = this.cache.get<Capabilities>(capsCacheKey(rt.meta.provider, rt.meta.accountId ?? DEFAULT_ACCOUNT, rt.meta.cwd));
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
    await rt.handle?.close().catch(() => {});
    rt.handle = undefined;
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

  private async createSession(p: RpcMethods['session.create']['params'], extra: { lane?: { slug: string; detail?: string }; custom?: boolean } = {}, ctx?: CallContext): Promise<SessionSnapshot> {
    const settings = this.store.state.settings;
    let accountId = p.accountId ?? this.defaultAccountId(p.provider);
    this.provider(p.provider, accountId);
    // The agents a session may hand work to are read when it starts: a first answer still on its way
    // counts (a few seconds at most: an agent that hangs is left out).
    await this.firstWord(undefined, FIRST_WORD_WAIT_MS);
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
    this.sessions.set(meta.id, rt);
    if (capStart) rt.notice('info', capStart.line);
    // Continue in the other agent: the first message carries a compact account of the source
    // conversation (read from Sable's timeline; the source and its transcript stay untouched).
    const source = p.handoverFrom ? this.sessions.get(p.handoverFrom) : undefined;
    if (source) {
      this.hydrate(source);
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
    const opened = this.lanes.atStart(rt, p.title ?? p.chat?.text).then(() => provider.open(rt, { loadTranscript: !!p.resume })).then(
      (handle) => {
        // Closed while it was starting: let the agent go.
        if (this.sessions.get(rt.id) !== rt) return void Promise.resolve(handle.close()).catch(() => {});
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
      this.persistSessions();
      // A chat started with `/spare` from home waited for its agent to be there.
      if (rt.meta.spare) this.spare.poke();
    });
    // A slow start answers early (status "starting"): the UI opens the session and the first
    // message shows at once, waiting in deliver() for the agent.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([opened, new Promise<void>((r) => (timer = setTimeout(r, 1500)))]);
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
    this.register('auth.refresh', ({ provider, accountId }) => this.emitProvider(provider, accountId ?? DEFAULT_ACCOUNT));
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
      this.loginCancelled.delete(key);
      this.loginTimedOut.delete(key);
      this.emit({ type: 'auth.progress', provider, accountId, state: 'started' });
      // A sign-in nobody finishes in the browser is given up, so the flow never hangs on "waiting".
      const timer = setTimeout(() => {
        this.loginTimedOut.add(key);
        this.loginCancelled.add(key);
        void p.cancelLogin().catch(() => {});
        this.emit({ type: 'auth.progress', provider, accountId, state: 'timeout' });
      }, this.loginTimeoutMs);
      timer.unref?.();
      void p
        .login()
        .then(async () => {
          if (this.loginTimedOut.has(key)) return;
          const info = await this.emitProvider(provider, accountId);
          const signedIn = info.accounts?.find((a) => a.id === accountId)?.auth;
          if (signedIn?.loggedIn) {
            // A new account takes its name from the sign-in ("Account 2" becomes "Ada").
            const stored = this.store.state.accounts.find((a) => a.provider === provider && a.id === accountId);
            const name = stored?.autoLabel ? labelFromAuth(signedIn, this.accountList(provider).filter((a) => a.id !== accountId).map((a) => a.label)) : undefined;
            if (stored && name) {
              stored.label = name;
              stored.autoLabel = false;
              this.store.saveState();
              await this.emitProvider(provider);
            }
            this.emit({ type: 'auth.progress', provider, accountId, state: 'done' });
          } else if (!this.loginCancelled.has(key)) this.emit({ type: 'auth.progress', provider, accountId, state: 'cancelled' });
        })
        .catch((err: Error) => {
          // Cancelling kills the CLI, which rejects the login: already reported as 'cancelled'.
          if (!this.loginCancelled.has(key)) this.emit({ type: 'auth.progress', provider, accountId, state: 'error', message: err.message });
        })
        .finally(() => {
          clearTimeout(timer);
          this.loginCancelled.delete(key);
          this.loginTimedOut.delete(key);
        });
      return { started: true };
    });
    this.register('auth.cancel', async ({ provider, accountId = DEFAULT_ACCOUNT }) => {
      this.loginCancelled.add(accountKey(provider, accountId));
      await this.provider(provider, accountId).cancelLogin();
      this.emit({ type: 'auth.progress', provider, accountId, state: 'cancelled' });
      return { ok: true };
    });
    this.register('auth.logout', async ({ provider, accountId = DEFAULT_ACCOUNT }) => {
      await this.provider(provider, accountId).logout();
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
      const taken = this.accountList(provider).find((a) => a.id !== DEFAULT_ACCOUNT && sameDir(this.accountDir(provider, a.id), abs));
      if (taken) throw new Error(`That folder is already the account ${taken.label}.`);
      if (sameDir(abs, path.join(this.userHome, provider === 'codex' ? '.codex' : '.claude'))) throw new Error('That folder is the built-in account.');
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
      if (this.movingTo.get(key)) throw new Error('A chat is moving to this account. Remove it when the move is done.');
      // Held the other way round too: no move to it begins while its agents are closed below.
      this.removingAccounts.add(key);
      try {
        for (const rt of mine) {
          rt.cancelPrompts();
          await rt.handle?.close().catch(() => {});
          rt.handle = undefined;
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
      this.limitsCache.delete(key);
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
    this.register('provider.limits', async ({ provider, accountId = DEFAULT_ACCOUNT, force }) => (await this.readLimits(provider, accountId, !!force)).limits);
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

    this.register('session.snapshot', async ({ sessionId, peek }) => {
      const rt = this.runtime(sessionId);
      await this.hydrateAsync(rt).catch(() => {});
      this.hydrate(rt);
      // Fetched ahead of an open (`peek`): not read yet.
      if (rt.meta.unread && !peek) rt.update({ unread: false });
      return rt.snapshot();
    });
    // A window gets finished steps cut (core/trim.ts): one whole, when it opens. A chat not read yet
    // (a picture of a file asked after a restart) is read off the main thread, one read for all, as a snapshot is.
    this.register('session.item', async ({ sessionId, itemId }) => {
      const rt = this.runtime(sessionId);
      await this.hydrateAsync(rt).catch(() => {});
      this.hydrate(rt);
      const item = rt.get(itemId);
      if (!item) throw new Error('That part of the conversation is no longer there');
      return { item: { ...item } };
    });

    // A retry of a submission the bridge already took (its window lost the answer) is answered, not sent again.
    this.register('session.send', ({ sessionId, text, attachments, steer, submitId }, ctx) => this.submissions.run(sessionId, submitId, async () => {
      // A message is words (maybe empty, with pictures) before anything holds it: the queue, the timeline, the agent.
      validMessage(text, attachments);
      const rt = this.runtime(sessionId);
      // A chat not read yet (a phone's message after a restart): read off the main thread, as a snapshot is;
      // a big one read here synchronously held the window for most of a second.
      await this.hydrateAsync(rt).catch(() => {});
      this.hydrate(rt);
      // `/model <name>` changes the model; it never goes to the agent (whose own /model restarts it).
      const model = typeof text === 'string' && !attachments?.length ? /^\/model(?:\s+([\s\S]*))?$/i.exec(text.trim()) : null;
      if (model) return this.modelCommand(rt, (model[1] ?? '').trim());
      // While the agent works the bridge holds the message until the turn ends, unless it is
      // steered into the running turn (and the agent can take one).
      if (rt.turnActive && !(steer && rt.caps?.features.steer !== false)) {
        const q = rt.enqueue(text, attachments);
        // A phone's message keeps its pairing's guard in the queue: once that phone is removed it
        // never goes out by itself (review wave 8, #21; a move's compaction is such a turn).
        if (ctx.allowed) this.queueGuards.set(q.id, ctx);
        return { ok: true, queued: true };
      }
      await this.deliver(rt, text, attachments, undefined, ctx);
      return { ok: true };
    }, messagePrint(text, attachments)));

    this.register('queue.update', ({ sessionId, id, text, attachments }, ctx) => {
      // Omitted attachments keep the message's; an empty list removes them.
      validMessage(text, attachments);
      const rt = this.runtime(sessionId);
      this.hydrate(rt);
      // The message as this edit finds it, in the same step: the desktop's swap takes it into its
      // field, so an edit another window made just before is never lost (review wave 10, #8).
      const found = rt.queue.find((q) => q.id === id);
      const previous = found ? { ...found, ...(found.attachments ? { attachments: [...found.attachments] } : {}) } : undefined;
      const ok = rt.updateQueued(id, text, attachments ?? undefined);
      this.spare.queueChanged(rt);
      // Only for an edit that kept the message (one that emptied it removed it), and never to a phone.
      return ok && previous && !ctx.allowed && rt.queue.some((q) => q.id === id) ? { ok, previous } : { ok };
    });
    this.register('queue.take', ({ sessionId, id }) => {
      const rt = this.runtime(sessionId);
      this.hydrate(rt);
      const message = rt.takeQueued(id);
      this.spare.queueChanged(rt);
      return message ? { message } : {};
    });
    this.register('queue.reorder', ({ sessionId, ids }) => {
      const rt = this.runtime(sessionId);
      this.hydrate(rt);
      rt.reorderQueued(Array.isArray(ids) ? ids : []);
      return { ok: true };
    });
    this.register('queue.remove', ({ sessionId, id }) => {
      const rt = this.runtime(sessionId);
      this.hydrate(rt);
      const ok = !!rt.takeQueued(id);
      this.spare.queueChanged(rt);
      return { ok };
    });
    this.register('queue.sendNow', async ({ sessionId, id }, ctx) => {
      const rt = this.runtime(sessionId);
      this.hydrate(rt);
      const q = rt.takeQueued(id);
      this.spare.queueChanged(rt);
      if (!q) return { ok: false };
      // Mid-turn this is steered into the running turn.
      try {
        await this.deliver(rt, q.text, q.attachments, undefined, ctx);
      } catch (err) {
        // Its phone was removed while it waited: the message goes back where it was, unsent.
        if (err instanceof CallerGone) {
          rt.requeue([q]);
          this.spare.queueChanged(rt);
        }
        throw err;
      }
      return { ok: true };
    });

    this.register('session.interrupt', async ({ sessionId }) => {
      const rt = this.runtime(sessionId);
      if (rt.turnActive) rt.stopRequested = true;
      this.stopped(rt);
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
        rt.heldMode = undefined;
        this.modeDue.delete(rt.id);
        await rt.handle?.setMode(mode);
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
      this.hydrate(rt);
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
      this.hydrate(rt);
      return this.checks.start(rt, String(turnId ?? ''));
    });
    this.register('turn.checkStop', ({ sessionId, itemId }) => ({ ok: this.checks.stop(this.runtime(sessionId), String(itemId ?? '')) }));

    // Spare (server/core/spare.ts): `/spare <message>` and "Continue at reset".
    this.register('spare.send', ({ sessionId, text, attachments }) => {
      const rt = this.runtime(sessionId);
      this.hydrate(rt);
      const body = typeof text === 'string' ? text.trim() : '';
      if (!body && !attachments?.length) return { ok: false, error: 'Add a message after /spare' };
      // A new chat is named by the message it waits with, not "New session" for hours.
      if (rt.meta.titleSource === 'auto' && !rt.items.some((i) => i.type === 'user') && !rt.meta.spare) rt.update({ title: autoTitle(body) });
      return { ok: true, spare: this.spare.hold(rt, body, attachments) };
    });
    this.register('spare.atReset', ({ sessionId }) => this.spare.atReset(this.runtime(sessionId)));
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
    this.register('lane.land', ({ sessionId, message }) => this.lanes.land(this.loaded(sessionId), typeof message === 'string' ? message : undefined));
    this.register('lane.discard', ({ sessionId }) => this.lanes.discard(this.loaded(sessionId)));
    this.register('lane.create', ({ sessionId }) => this.lanes.create(this.loaded(sessionId)));
    this.register('lane.open', ({ sessionId }) => this.lanes.open(this.runtime(sessionId)));
    this.register('lane.diff', ({ sessionId }) => this.lanes.diff(this.runtime(sessionId)));

    // Race (server/core/race.ts).
    this.register('race.start', ({ cwd, task, provider, modes }) =>
      this.races.start({ cwd: String(cwd ?? ''), task: typeof task === 'string' ? task : '', provider, modes: modes && typeof modes === 'object' ? modes : undefined }),
    );
    this.register('race.keep', ({ sessionId, message }) => this.races.keep(this.loaded(sessionId), typeof message === 'string' ? message : undefined));
    this.register('race.discard', ({ sessionId }) => this.races.discardBoth(this.loaded(sessionId)));

    this.register('session.rename', ({ sessionId, title }) => {
      this.runtime(sessionId).update({ title: title.trim() || 'Untitled', titleSource: 'user' });
      return { ok: true };
    });
    this.register('session.update', ({ sessionId, patch }) => {
      this.runtime(sessionId).update(patch);
      return { ok: true };
    });

    this.register('session.close', async ({ sessionId, remove }) => {
      const rt = this.runtime(sessionId);
      this.closed(rt);
      this.until.closed(rt);
      await this.checks.closed(rt);
      rt.stopRequested = true;
      rt.cancelPrompts();
      await rt.handle?.close().catch(() => {});
      rt.handle = undefined;
      if (rt.turnActive) {
        rt.settle('cancelled');
        rt.endTurn();
      }
      if (remove) {
        this.sessions.delete(sessionId);
        this.handed.delete(sessionId);
        this.pinned.delete(sessionId);
        this.store.deleteSession(sessionId);
        this.emit({ type: 'session.removed', id: sessionId });
        // A deleted chat takes its folder along when nothing was ever put in it.
        if (rt.meta.chat) removeEmptyChatFolder(this.chatsRoot(), rt.meta.cwd);
        // A deleted chat's lane goes too when it holds nothing to land (otherwise its branch keeps the work).
        void this.lanes.closed(rt);
        // Its rival races no more.
        this.races.closed(rt);
      }
      this.persistSessions();
      return { ok: true };
    });

    this.register('session.rewind', async ({ sessionId, itemId, restoreFiles }) => {
      const rt = this.runtime(sessionId);
      const handle = await this.ensureHandle(rt);
      if (!handle.rewind) return { ok: false, message: 'This provider cannot rewind.' };
      const done = await handle.rewind(itemId, restoreFiles);
      // A check of a turn the rewind took away stops with it.
      this.checks.pruned(rt);
      return done;
    });
    // Fork at an answer: a new session with the same agent and settings that continues from the
    // end of that turn. The agent's own fork carries the real transcript; without one (or when it
    // fails) the new session starts from a summary up to there. The source is never changed.
    this.register('session.fork', async ({ sessionId, itemId }) => {
      const src = this.runtime(sessionId);
      this.hydrate(src);
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
      const snap = await this.call('session.create', {
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
      });
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
    this.register('session.switchAccount', async ({ sessionId, accountId, retry }, ctx) => {
      const rt = this.runtime(sessionId);
      const from = rt.meta.accountId ?? DEFAULT_ACCOUNT;
      // A big chat compacts first, which can take minutes: the answer comes as it starts, and the
      // chat shows the compaction and then the switch line (a failure later is said there too).
      let started!: () => void;
      const compacting = new Promise<'compacting'>((resolve) => (started = () => resolve('compacting')));
      const run = this.switchAccount(rt, accountId, { retry, onCompacting: () => started() }, ctx).then((result) => {
        // Moved by hand: a wait for the old account's reset is over.
        if ((rt.meta.accountId ?? DEFAULT_ACCOUNT) !== from) {
          this.spare.movedByHand(rt);
          // Carried on at a limit ("Continue with"): it goes back once that account takes work again.
          // Any other move is the person's choice: nothing to go back to.
          const card = retry ? rt.items.findLast((i): i is NoticeItem => i.type === 'notice' && i.limit?.continuedWith === accountId && !i.parentId) : undefined;
          if (card) this.movedByLimit(rt, from, accountId, card.limit?.resetsAt);
          else {
            rt.update({ movedFrom: undefined, returnAt: undefined });
            this.armReturn(rt);
          }
        }
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
      rt.browserPage = page && typeof page.url === 'string' ? { url: page.url.slice(0, 2000), title: String(page.title ?? '').slice(0, 300) } : null;
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

  private disposed = false;

  async dispose() {
    this.disposed = true;
    clearTimeout(this.resetTimer);
    this.updates?.dispose();
    this.until.dispose();
    this.spare.dispose();
    this.resets.dispose();
    this.titles.dispose();
    await this.checks.dispose();
    for (const fn of this.disposers.splice(0)) await Promise.resolve(fn()).catch(() => {});
    for (const rt of this.sessions.values()) {
      rt.cancelPrompts();
      await rt.handle?.close().catch(() => {});
    }
    await Promise.all([...this.providers.values(), ...this.instances.values()].map((p) => p.dispose().catch(() => {})));
    this.instances.clear();
    await this.store.flush();
    await this.cache.flush();
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

function fallbackInfo(p: Provider) {
  return { id: p.id, name: p.name, installed: false, auth: { loggedIn: false }, problem: 'Could not query the CLI' };
}

/** A sign-in that bills per token (an API key, the Console): never a plan with a week to use up. */
export function isApiKeyAuth(auth: AuthState): boolean {
  return /api/i.test(auth.method ?? '') || /^(api key|console)$/i.test(auth.plan ?? '');
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
