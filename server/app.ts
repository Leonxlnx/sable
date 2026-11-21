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
import { normalizeBackdrop } from '../shared/backdrop';
import { readableTitle } from '../shared/synthetic';
import { Races, type Contender } from './core/race';
import { laneSlug } from './services/git-lanes';
import { gitDraftInput, gitWorktrees } from './services/git';
import { cleanCommit, commitPrompt } from './core/commit-draft';
import { SessionRuntime, autoTitle, pendingPrompts } from './core/runtime';
import { Store, type StoredAccount } from './core/store';
import { DiskCache } from './core/cache';
import { capReached, capReason, creditsKey, decideAtLimit, dueResets, hasCap, nextResetAlert, runningOnCredits } from './core/limit-policy';
import { defaultChatsRoot, makeChatFolder, removeEmptyChatFolder } from './core/chats';
import { speedFor, startSpeedFor } from '../shared/speed';
import type { Provider, ProviderContext, ProviderSession } from './providers/types';
import { findAccountFolders, folderLabel, labelFromAuth, pickNextAccount } from './accounts/folders';
import { handoverText } from './accounts/handover';
import { backgroundRunning, itemsSince, lastSwitch, legOf, rootBefore, undoableSwitch, withLeg, workedIn } from './core/agent-switch';
import { runSubAgent } from './core/sub-agent';
import { readOnlyMode, TurnChecks, withoutChecks } from './core/check';
import { cutAt } from './core/fork';
import { orderAccounts } from './accounts/order';
import { withBrowserLine } from './providers/browser-tool';
import { profileOf } from './services/profile';
import { parseUntil, runCheck, UntilLoops } from './core/until';
import { ChatTitles, type TitleModel, type TitlePrompt } from './core/titles';
import { Lanes, worktreesRoot } from './core/lanes';
import { isAllModelsWeekly } from './core/limit-policy';
import { effectiveModel, planWeight, SpareWaits, type SpareAccount, type SpareRun } from './core/spare';
import { VERSION } from './version';

type Handler<M extends RpcName> = (params: RpcMethods[M]['params']) => Promise<RpcMethods[M]['result']> | RpcMethods[M]['result'];

export interface AppOptions {
  home?: string;
  /** Provider factories; injected so tests can run with the demo provider only. */
  providers: ((ctx: ProviderContext) => Provider)[];
  quiet?: boolean;
  /** How long after serving a cached answer the fresh one is fetched (tests shorten these). */
  refreshDelays?: { info?: number; caps?: number };
  /** The user's home folder, where "Use an existing folder" looks for agent config folders (tests point it elsewhere). */
  userHome?: string;
  /** How long a sign-in may wait for the browser before it is given up (tests shorten it). */
  loginTimeoutMs?: number;
}

export { VERSION };

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
      const reached = capReached((await this.knownLimits(rt.meta.provider)).get(accountId)?.limits, cap, rt.meta.model || undefined);
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
    model: (rt) => effectiveModel(rt.meta.model, (rt.caps ?? this.cache.get<Capabilities>(capsCacheKey(rt.meta.provider, rt.meta.accountId ?? DEFAULT_ACCOUNT, rt.meta.cwd)))?.models, this.store.state.settings.defaultModels[rt.meta.provider]),
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
    model: (rt) => this.titleModel(rt),
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

  constructor(opts: AppOptions) {
    this.quiet = !!opts.quiet;
    this.delays = opts.refreshDelays ?? {};
    this.userHome = opts.userHome ?? homedir();
    this.loginTimeoutMs = opts.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
    this.store = new Store(opts.home);
    this.cache = new DiskCache(this.store.dir);
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
      // An until loop does not outlive Sable: the session says so when it is opened.
      if (meta.until) this.untilLost.set(meta.id, meta.until), (meta.until = undefined);
      // A chat titled from a message the agent's harness wrote (`<task-notification>`): its plain words.
      const plain = meta.titleSource === 'user' ? meta.title : readableTitle(meta.title);
      if (plain !== meta.title) meta.title = plain || 'New session';
      this.sessions.set(meta.id, this.makeRuntime(meta, true));
    }
    this.seedFolderOrder();
    this.registerCore();
    // Chats that waited when Sable closed go on waiting (a reset that passed meanwhile is due now).
    if (this.spare.hasWaits()) this.spare.poke(4000);
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

  async call<M extends RpcName>(method: M, params: RpcMethods[M]['params']): Promise<RpcMethods[M]['result']> {
    const h = this.handlers.get(method);
    if (!h) throw new Error(`Unknown method: ${method}`);
    return (await h(params as never)) as RpcMethods[M]['result'];
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
   * Haiku). An agent without one (Codex) borrows Claude Code's Haiku on Claude's default account
   * while Claude Code is signed in; otherwise none, and the chat keeps its title.
   */
  private titleModel(rt: SessionRuntime): TitleModel | undefined {
    const ask = (p: Provider) => (p.quickTitle ? (prompt: TitlePrompt, signal: AbortSignal) => p.quickTitle!(prompt, signal) : undefined);
    try {
      const own = ask(this.provider(rt.meta.provider, rt.meta.accountId ?? DEFAULT_ACCOUNT));
      if (own) return own;
      if (rt.meta.provider === 'claude' || !this.otherAgents().includes('claude')) return undefined;
      return ask(this.provider('claude', this.defaultAccountId('claude')));
    } catch {
      return undefined;
    }
  }

  /**
   * A commit message for a folder's changes, written by Claude Code's Haiku on the default account.
   * Nothing is staged or committed: the person reads it and commits.
   */
  private async draftCommit(cwd: string): Promise<{ ok: boolean; message?: string; error?: string }> {
    const input = await gitDraftInput(cwd);
    if ('error' in input) return { ok: false, error: input.error };
    let model: Provider;
    try {
      model = this.provider('claude', this.defaultAccountId('claude'));
    } catch {
      return { ok: false, error: 'Claude Code is not set up, so no message can be written.' };
    }
    if (!model.quickTitle) return { ok: false, error: 'Claude Code is not set up, so no message can be written.' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const message = cleanCommit(await model.quickTitle(commitPrompt(input, path.resolve(cwd)), ctrl.signal));
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
    const info = p.info(force).catch(() => fallbackInfo(p));
    this.infoCache.set(key, info);
    return info;
  }

  /** The provider as the UI sees it: the default account's CLI state plus every account. `force` re-reads one account. */
  async providerInfo(provider: ProviderId, force?: string): Promise<ProviderInfo> {
    const p = this.provider(provider);
    const base = await p.info(force === DEFAULT_ACCOUNT).catch(() => fallbackInfo(p));
    const defaultId = this.defaultAccountId(provider);
    const accounts = await Promise.all(
      this.accountList(provider).map(async (a): Promise<AccountInfo> => {
        const own = a.id === DEFAULT_ACCOUNT;
        // A missing CLI has no accounts to ask about.
        const info = own ? base : base.installed ? await this.accountAuth(provider, a.id, force === a.id) : undefined;
        return {
          id: a.id,
          provider,
          label: a.label,
          isDefault: a.id === defaultId,
          auth: info?.auth ?? { loggedIn: false },
          limits: this.limitsCache.get(accountKey(provider, a.id)),
          dir: own ? undefined : this.accountDir(provider, a.id),
          problem: own ? undefined : info?.problem,
          ...(a.dir ? { external: true } : {}),
        };
      }),
    );
    return { ...base, accounts };
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
    if (!cached?.installed) return this.providerInfo(provider).then((info) => (this.cache.set(`info:${provider}`, info), info));
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
      };
    });
    // Setup warnings belong to the run that saw them: the fresh read brings this run's.
    return Promise.resolve({ ...cached, accounts, warnings: undefined });
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

  private makeRuntime(meta: SessionMeta, lazy = false): SessionRuntime {
    if (lazy) this.lazy.add(meta.id);
    const rt = new SessionRuntime(meta, this.emit, (rt, what) => {
      if (what === 'meta') this.store.saveState();
      else this.store.saveSession(rt.id, () => ({ items: rt.items, todos: rt.todos, queue: rt.queue, dirty: rt.takeDirty() }));
    });
    rt.onTurnEnd = (r, error) => this.afterTurn(r, error);
    rt.onTurnStart = (r) => {
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
    rt.load(file.items, file.todos, file.queue ?? []);
    rt.markSaved();
    // A file that is there but cannot be read is left exactly as it is (nothing is written to it).
    if (file.unreadable) rt.notice('error', 'This chat could not be read from disk', 'Nothing is written to it. Restart Sable to try again.');
    rt.settle('cancelled');
    // No agent process carries anything from before: background sub-agents and workflows ended with it.
    rt.stopBackground();
    // Messages still waiting for the agent when Sable closed (a steer not taken yet) would wait forever: back to the queue.
    rt.returnUntaken({ all: true, reason: 'closed' });
    const lost = this.untilLost.get(rt.id);
    if (lost) this.untilLost.delete(rt.id), this.until.restored(rt, lost);
  }

  /**
   * Puts a message in the timeline and hands it to the agent. Mid-turn it is steered: the agent
   * takes it at its next step and it stays where it was sent.
   */
  private async deliver(rt: SessionRuntime, text: string, attachments?: UserItem['attachments'], extra?: Pick<UserItem, 'until'>) {
    // Past its account's cap, the session moves to the next account before the message goes out.
    // The first message names the session's lane, or moves it into one when its folder got busy.
    if (!extra?.until && !rt.items.some((i) => i.type === 'user')) await this.lanes.beforeFirstSend(rt, text);
    if (!rt.turnActive && !this.opening.has(rt.id)) await this.checkCap(rt);
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
    // A model chosen since the agent started takes effect now, with this message (never inside a running turn).
    await this.applyDue(rt, handle);
    const item = early ?? addUser();
    const runningSince = item.steered ? rt.turnStartedAt : undefined;
    try {
      await handle.send(this.withBrowserPage(rt, this.withHandover(rt, item)));
    } catch (err) {
      // A steer the agent could not take: the turn it was meant for goes on, and the message waits in the queue.
      if (item.steered && rt.turnActive && rt.turnStartedAt === runningSince && rt.get<UserItem>(item.id)?.state === 'queued') {
        this.log('steer failed; back to the queue', (err as Error).message);
        rt.remove(item.id);
        rt.requeue([{ id: item.id, text: item.text, attachments: item.attachments, createdAt: item.ts }]);
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
  private withHandover(rt: SessionRuntime, item: UserItem): UserItem {
    const pending = rt.meta.agentHandover;
    if (pending) rt.update({ agentHandover: null });
    // A summary of the whole conversation covers what a switch would hand over.
    const summary = this.handovers.get(rt.id) ?? (pending ? this.agentHandoverText(rt, pending, item.id) : '');
    this.handovers.delete(rt.id);
    if (!summary) return item;
    return { ...item, text: `${summary}\n\n---\n\n${item.text}` };
  }

  /** What an agent the chat switched to has not seen: the whole chat, or what happened since it was left (`since`). */
  private agentHandoverText(rt: SessionRuntime, pending: AgentHandover, skip?: string): string {
    const range = withoutChecks(itemsSince(rt.items, pending.since)).filter((i) => i.id !== skip);
    const worked = workedIn(range, pending.from).filter((p) => p !== rt.meta.provider);
    const from = (worked.length ? worked : [pending.from]).map((p) => this.agentName(p)).join(' and ');
    return handoverText(range, { from, since: !!pending.since, maxChars: SWITCH_HANDOVER_CHARS });
  }

  /** An agent's name, also for one this build does not have. */
  private agentName(provider: ProviderId): string {
    return this.providers.get(provider)?.name ?? AGENT_NAMES[provider] ?? provider;
  }

  // ── the session's model ──

  /** Sessions whose model changed while their agent was there: it takes the model right before the next message (`speed`: the speed fell back too). */
  private modelDue = new Map<string, { speed: boolean }>();

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

  /** A model chosen since the agent started goes to it now (never into a running turn: a steer leaves it for the next message). */
  private async applyDue(rt: SessionRuntime, handle: ProviderSession) {
    const due = this.modelDue.get(rt.id);
    if (!due || rt.turnActive) {
      // An effort the running agent did not take when it was chosen goes with this message.
      if (this.effortDue.has(rt.id)) await this.applyEffort(rt, handle);
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
    if (rt.meta.effort) await this.applyEffort(rt, handle);
  }

  /** Sessions whose running agent has not taken the effort they hold (it refused, or failed to answer). */
  private effortDue = new Set<string>();

  /**
   * The session's effort to its running agent (none running: the next start reads it from the session).
   * Never throws: a refusal leaves it due, and it goes again right before the next message.
   */
  private async applyEffort(rt: SessionRuntime, handle: ProviderSession | undefined) {
    const effort = rt.meta.effort;
    if (!handle || !effort) return void this.effortDue.delete(rt.id);
    this.effortDue.add(rt.id);
    try {
      await handle.setEffort(effort);
      // A later pick went out meanwhile: it settles what is due.
      if (rt.meta.effort === effort) this.effortDue.delete(rt.id);
    } catch (err) {
      this.log('effort change failed; it goes with the next message', (err as Error).message);
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
    const out = new Map<string, { limits?: RateLimit[]; planLimits?: boolean }>();
    if (this.handlers.has('usage.limits')) {
      const reports = await this.call('usage.limits', {}).catch(() => []);
      for (const r of reports) if (r.provider === provider) out.set(r.accountId, { limits: r.limits, planLimits: r.planLimits });
    }
    for (const a of this.accountList(provider)) {
      const l = this.limitsCache.get(accountKey(provider, a.id));
      if (l?.length) out.set(a.id, { ...out.get(a.id), limits: l });
    }
    return out;
  }

  /**
   * The signed-in account of `provider` to go on with, other than `current`: under its own cap, one
   * on the same plan first, then the most room (with `model`, other models' full windows do not
   * count); with `byCap`, the next one in the person's order and never an API key. Undefined when
   * none has room.
   */
  async nextAccount(provider: ProviderId, current: string, model?: string, byCap = false): Promise<string | undefined> {
    const [info, known] = await Promise.all([this.providerInfo(provider), this.knownLimits(provider)]);
    const accounts = info.accounts ?? [];
    return pickNextAccount(
      current,
      accounts.map((a) => ({
        id: a.id,
        signedIn: a.auth.loggedIn,
        isDefault: a.isDefault,
        limits: known.get(a.id)?.limits ?? a.limits,
        // An API key bills per token: known as such from its sign-in even before its limits were read.
        planLimits: known.get(a.id)?.planLimits ?? (/api/i.test(a.auth.method ?? '') || /^(api key|console)$/i.test(a.auth.plan ?? '') ? false : undefined),
        cap: this.capOf(provider, a.id),
        plan: a.auth.plan,
      })),
      Date.now(),
      { model: model || undefined, plan: accounts.find((a) => a.id === current)?.auth.plan, byCap },
    );
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
  private async underCapStart(provider: ProviderId, accountId: string, model: string | undefined): Promise<{ to: string; line: string } | undefined> {
    const cap = this.capOf(provider, accountId);
    if (!cap) return undefined;
    const known = await this.knownLimits(provider);
    const reached = capReached(known.get(accountId)?.limits, cap, model || undefined);
    if (!reached) return undefined;
    const next = await this.nextAccount(provider, accountId, model, true).catch(() => undefined);
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
    const model = rt.meta.model || undefined;
    const known = await this.knownLimits(provider);
    const reached = capReached(known.get(from)?.limits, this.capOf(provider, from), model);
    if (!reached) return;
    // The next account in the person's order, never an API key (a cap does not start paying per token).
    const next = await this.nextAccount(provider, from, model, true).catch(() => undefined);
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
  private async onLimitHit(rt: SessionRuntime, notice: NoticeItem, spare = false) {
    const provider = rt.meta.provider;
    const accountId = rt.meta.accountId ?? DEFAULT_ACCOUNT;
    const known = await this.knownLimits(provider);
    const own = (known.get(accountId)?.limits ?? []).filter((l) => l.percent >= 100);
    // Every window that is used up has to reset before the account can work again.
    const full = own.sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0];
    const next = await this.nextAccount(provider, accountId, rt.meta.model).catch(() => undefined);
    const limit = { ...notice.limit, provider, accountId, resetsAt: notice.limit?.resetsAt ?? full?.resetsAt, window: notice.limit?.window ?? full?.label, ...(next ? { next } : {}) };
    rt.patch<NoticeItem>(notice.id, { limit });
    if (spare) return;
    // A refused turn was not carried by credits, so only the next account or the notice remain.
    const settings = this.store.state.settings;
    const moves = decideAtLimit({ creditsAllowed: false, creditsAvailable: false, continueAtLimit: !!settings.continueAtLimit, next }) === 'next' && !!next;
    // No other account takes over: the chat waits for this account's reset and then carries on by itself.
    if (!moves && !rt.turnActive && settings.continueAtReset) this.spare.atReset(rt);
    if (!moves || rt.turnActive) return;
    const refused = this.refusedMessage(rt);
    const done = this.autoContinued.get(rt.id) ?? new Set<string>();
    const key = `${refused?.id ?? ''}:${next}`;
    if (done.has(key)) return;
    done.add(key);
    this.autoContinued.set(rt.id, done);
    this.movedByLimit(rt, accountId, next, full?.resetsAt ?? limit.resetsAt);
    await this.switchAccount(rt, next, { retry: true });
  }

  /** Remembers a limit handover: the session's preferred account, and where new sessions go meanwhile. */
  private movedByLimit(rt: SessionRuntime, from: string, to: string, until?: number) {
    rt.update({ movedFrom: rt.meta.movedFrom ?? from });
    if (from === this.defaultAccountId(rt.meta.provider)) {
      this.fallbacks.set(rt.meta.provider, { from, to, until });
      void this.emitProvider(rt.meta.provider).catch(() => {});
      this.scheduleResetAlert();
    }
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
    const next = settings.continueAtLimit ? await this.nextAccount(provider, accountId).catch(() => undefined) : undefined;
    const decision = decideAtLimit({ creditsAllowed: !!settings.creditsAtLimit?.[creditsKey(provider, accountId)], creditsAvailable: true, continueAtLimit: !!settings.continueAtLimit, next });
    if (decision === 'credits' || rt.turnActive) return;
    const until = meta?.extra?.resetsAt ?? meta?.credits?.resetsAt;
    if (decision === 'next' && next) {
      this.movedByLimit(rt, accountId, next, until);
      await this.switchAccount(rt, next);
      return;
    }
    const key = `${rt.id}:${accountId}:${until ?? ''}`;
    if (this.creditsWarned.has(key)) return;
    this.creditsWarned.add(key);
    rt.notice('info', meta?.extra?.inUse ? 'Running on extra usage' : 'Running on credits', 'This account is past its limit. Its setting with the provider decides whether credits are spent.');
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
    if (!progressed) return refused;
    const text =
      carried === 'reset'
        ? 'Usage has been restored. Continue the task from where it stopped. Do not repeat steps that are already done.'
        : carried === 'conversation'
          ? 'The last turn was cut off by a usage limit; the conversation now continues under another account. Carry on with the task from where it stopped. Do not repeat steps that are already done.'
          : `${refused.text}\n\n(Part of this was already done before a usage limit cut the turn off: the summary above shows how far it got. Carry on from there.)`;
    return { id: randomUUID(), ts: Date.now(), type: 'user', text, state: 'sent' };
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
        planLimits: r?.planLimits,
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
      : { id: randomUUID(), ts: Date.now(), type: 'user', text: 'Usage has been restored. Continue the task from where it stopped.', state: 'sent' };
    const handle = await this.ensureHandle(rt);
    await this.applyDue(rt, handle);
    try {
      await handle.send(this.withHandover(rt, item));
    } catch (err) {
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
   */
  async switchAccount(rt: SessionRuntime, accountId: string, opts: { retry?: boolean; line?: string } = {}): Promise<RpcMethods['session.switchAccount']['result']> {
    this.hydrate(rt);
    if (rt.turnActive) throw new Error('The agent is still working. Stop it first.');
    const provider = rt.meta.provider;
    const fromId = rt.meta.accountId ?? DEFAULT_ACCOUNT;
    const target = this.provider(provider, accountId);
    const label = this.findAccount(provider, accountId)?.label ?? 'another account';
    if (fromId === accountId) return { ok: true, carried: 'none' };
    const refused = opts.retry ? this.refusedMessage(rt) : undefined;

    rt.cancelPrompts();
    await rt.handle?.close().catch(() => {});
    rt.handle = undefined;

    let carried: 'conversation' | 'summary' | 'none' = 'none';
    const id = rt.meta.providerSessionId;
    if (id) {
      let fromHome: string | undefined;
      try {
        fromHome = this.provider(provider, fromId).configHome?.();
      } catch {
        /* the old account was removed: nothing to copy from */
      }
      const adopted = !!fromHome && !!target.adoptConversation && (await target.adoptConversation(fromHome, id).catch((err) => (this.log('could not carry the conversation over', (err as Error).message), false)));
      if (adopted) carried = 'conversation';
      else {
        rt.update({ providerSessionId: undefined });
        const summary = handoverText(withoutChecks(rt.items), { skip: refused?.id });
        if (summary) {
          this.handovers.set(rt.id, summary);
          carried = 'summary';
        }
      }
    }
    rt.update({ accountId: accountId === DEFAULT_ACCOUNT ? undefined : accountId, status: 'idle', lastError: undefined });
    this.persistSessions();

    // A move by a cap says why in its own line; a move at a limit closes the limit's notice.
    const open = opts.line ? undefined : rt.items.findLast((i): i is NoticeItem => i.type === 'notice' && !!i.limit && !i.limit.continuedWith && !i.parentId);
    if (open) rt.patch<NoticeItem>(open.id, { limit: { ...open.limit, continuedWith: accountId } });
    if (opts.line) rt.notice('info', opts.line, carried === 'summary' ? 'With a summary of the conversation so far' : undefined);
    else if (!open || carried === 'summary') {
      rt.notice('info', carried === 'summary' ? `New conversation with ${label}` : `Continued with ${label}`, carried === 'summary' ? 'With a summary of the conversation so far' : undefined);
    }
    if (refused) {
      const handle = await this.ensureHandle(rt);
      try {
        await handle.send(this.withHandover(rt, this.resumeMessage(rt, refused, carried)));
      } catch (err) {
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
    if (rt.turnActive || this.opening.has(rt.id) || this.delivering.has(rt.id) || this.capChecks.has(rt.id)) throw new Error('The agent is still working. Switch when it is done.');
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
    await rt.handle?.close().catch(() => {});
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
   * end). After an interrupt, a close or a failure the queue waits for the user.
   */
  private afterTurn(rt: SessionRuntime, error?: string) {
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
    if (error || rt.stopRequested) {
      // Steered messages the agent never took go back to the queue, to send or edit again.
      rt.returnUntaken({ reason: error ? 'failed' : 'stopped' });
      // An until loop waits for the next turn, as the queue waits for the user.
      this.until.turnHeld(rt);
      return;
    }
    // The chat's first turn settled: a small model names it, in the background.
    this.titles.turnEnded(rt);
    // Let the adapter finish its own bookkeeping (it may start a turn of its own first, with a
    // steered message the turn ended before taking).
    setTimeout(() => {
      if (rt.turnActive || rt.stopRequested || this.sessions.get(rt.id) !== rt) return;
      // A steered message no turn took and no adapter carried on is never left waiting: it goes out first.
      rt.returnUntaken();
      // Messages held for Spare stay where they are: the chat starts them by itself.
      const held = this.spare.held(rt);
      const nextId = rt.queue.find((q) => !held.has(q.id))?.id;
      const next = nextId ? rt.takeQueued(nextId) : undefined;
      if (next) void this.deliver(rt, next.text, next.attachments).catch((err) => this.log('queued send failed', (err as Error).message));
      // Nothing waits: an until loop runs its check (the user's messages always go first).
      else this.until.turnEnded(rt);
    }, 0);
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
    const opened = this.provider(rt.meta.provider, rt.meta.accountId)
      .open(rt, { loadTranscript: false })
      .then((handle) => {
        if (this.sessions.get(rt.id) !== rt) {
          void Promise.resolve(handle.close()).catch(() => {});
          throw new Error('The session was closed while the agent was starting.');
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
    return rt.handle!;
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

  async state(): Promise<AppState> {
    const providers = await Promise.all([...this.providers.values()].map((p) => this.providerInfoFast(p.id).catch(() => fallbackInfo(p))));
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
  private async createSession(p: RpcMethods['session.create']['params'], extra: { lane?: { slug: string; detail?: string } } = {}): Promise<SessionSnapshot> {
    const settings = this.store.state.settings;
    let accountId = p.accountId ?? this.defaultAccountId(p.provider);
    this.provider(p.provider, accountId);
    // An account past its cap: the session starts on the next one under its own (a resumed
    // conversation stays where it lives).
    const capStart = p.resume ? undefined : await this.underCapStart(p.provider, accountId, p.model ?? settings.defaultModels[p.provider]).catch(() => undefined);
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
    this.register('app.hello', () => this.state());

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
      for (const rt of mine) {
        rt.cancelPrompts();
        await rt.handle?.close().catch(() => {});
        rt.handle = undefined;
      }
      const key = accountKey(provider, accountId);
      const inst = this.instances.get(key);
      this.instances.delete(key);
      if (inst) {
        await inst.cancelLogin().catch(() => {});
        await inst.dispose().catch(() => {});
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
    this.register('provider.limits', async ({ provider, accountId = DEFAULT_ACCOUNT, force }) => {
      const key = accountKey(provider, accountId);
      const seq = this.limitsSeq.get(key) ?? 0;
      const limits = await this.provider(provider, accountId).limits(!!force);
      this.limitsCache.set(key, limits);
      // A provider that read them announced it already (with what it knows about the read).
      if ((this.limitsSeq.get(key) ?? 0) === seq) this.emit({ type: 'limits.updated', provider, accountId, limits });
      return limits;
    });
    // Spends a reset credit: only the confirmed click in the UI calls this, never anything automatic.
    this.register('provider.useReset', async ({ provider, accountId = DEFAULT_ACCOUNT, key }) => {
      const p = this.provider(provider, accountId);
      if (!p.useReset) throw new Error('This agent has no resets');
      if (!key || typeof key !== 'string') throw new Error('Missing reset key');
      return { outcome: await p.useReset(key) };
    });

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
    this.register('session.create', (p) => this.createSession(p));

    this.register('session.snapshot', async ({ sessionId }) => {
      const rt = this.runtime(sessionId);
      await this.hydrateAsync(rt).catch(() => {});
      this.hydrate(rt);
      if (rt.meta.unread) rt.update({ unread: false });
      return rt.snapshot();
    });
    // A window gets finished steps cut (core/trim.ts): one whole, when it opens.
    this.register('session.item', ({ sessionId, itemId }) => {
      const rt = this.runtime(sessionId);
      this.hydrate(rt);
      const item = rt.get(itemId);
      if (!item) throw new Error('That part of the conversation is no longer there');
      return { item: { ...item } };
    });

    this.register('session.send', async ({ sessionId, text, attachments, steer }) => {
      const rt = this.runtime(sessionId);
      this.hydrate(rt);
      // `/model <name>` changes the model; it never goes to the agent (whose own /model restarts it).
      const model = typeof text === 'string' && !attachments?.length ? /^\/model(?:\s+([\s\S]*))?$/i.exec(text.trim()) : null;
      if (model) return this.modelCommand(rt, (model[1] ?? '').trim());
      // While the agent works the bridge holds the message until the turn ends, unless it is
      // steered into the running turn (and the agent can take one).
      if (rt.turnActive && !(steer && rt.caps?.features.steer !== false)) {
        rt.enqueue(text, attachments);
        return { ok: true, queued: true };
      }
      await this.deliver(rt, text, attachments);
      return { ok: true };
    });

    this.register('queue.update', ({ sessionId, id, text, attachments }) => {
      const rt = this.runtime(sessionId);
      this.hydrate(rt);
      const ok = rt.updateQueued(id, text, attachments);
      this.spare.queueChanged(rt);
      return { ok };
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
    this.register('queue.sendNow', async ({ sessionId, id }) => {
      const rt = this.runtime(sessionId);
      this.hydrate(rt);
      const q = rt.takeQueued(id);
      this.spare.queueChanged(rt);
      if (!q) return { ok: false };
      // Mid-turn this is steered into the running turn.
      await this.deliver(rt, q.text, q.attachments);
      return { ok: true };
    });

    this.register('session.interrupt', async ({ sessionId }) => {
      const rt = this.runtime(sessionId);
      if (rt.turnActive) rt.stopRequested = true;
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
    this.register('session.setMode', async ({ sessionId, mode }) => {
      const rt = this.runtime(sessionId);
      await rt.handle?.setMode(mode);
      rt.update({ mode });
      // The mode that never asks (Bypass, Full access) answers what already waits too; questions stay.
      if (rt.caps?.modes.find((m) => m.id === mode)?.tone === 'danger') {
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
    this.register('git.draft', ({ cwd }) => this.draftCommit(String(cwd ?? '')));
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
    this.register('session.switchAccount', async ({ sessionId, accountId, retry }) => {
      const rt = this.runtime(sessionId);
      const from = rt.meta.accountId ?? DEFAULT_ACCOUNT;
      const result = await this.switchAccount(rt, accountId, { retry });
      // Moved by hand: a wait for the old account's reset is over.
      if ((rt.meta.accountId ?? DEFAULT_ACCOUNT) !== from) this.spare.movedByHand(rt);
      return result;
    });
    this.register('session.context', async ({ sessionId }) => (await this.runtime(sessionId).handle?.context?.()) ?? null);
    this.register('session.setOptions', async ({ sessionId, options }) => {
      const rt = this.runtime(sessionId);
      const next = { ...rt.meta.options, ...options };
      rt.update({ options: next });
      this.persistSessions();
      try {
        const handle = await this.ensureHandle(rt);
        await handle.setOptions?.(next);
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
      ok: this.runtime(sessionId).answerPermission(requestId, { optionId, message }),
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
/** How long after a cached capabilities answer the fresh one is fetched. */
const CAPS_REFRESH_DELAY_MS = 2_500;

/** Cached capabilities are per agent, account and folder (plan models, project skills and MCP servers differ). */
function capsCacheKey(provider: ProviderId, accountId: string, cwd?: string) {
  return `caps:${provider}:${accountId}:${cwd ? path.resolve(cwd).toLowerCase() : ''}`;
}

function fallbackInfo(p: Provider) {
  return { id: p.id, name: p.name, installed: false, auth: { loggedIn: false }, problem: 'Could not query the CLI' };
}
