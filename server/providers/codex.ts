import { VERSION } from '../version';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { carryCodexConversation } from '../accounts/handover';
import type {
  AuthState,
  SessionMeta,
  SessionOptions,
  Capabilities,
  CommandInfo,
  ContextBreakdown,
  Effort,
  HistoryEntry,
  McpServerInfo,
  ModelInfo,
  NoticeItem,
  PermissionOption,
  ProviderId,
  ProviderInfo,
  Question,
  RateLimit,
  ResetOutcome,
  TextItem,
  ThinkingItem,
  TimelineItem,
  ToolItem,
  TurnItem,
  UserItem,
} from '../../shared/protocol';
import type { SessionRuntime } from '../core/runtime';
import type { TitlePrompt } from '../core/titles';
import { codexForkTurn, cutAt } from '../core/fork';
import type { Provider, ProviderContext, ProviderSession } from './types';
import { codexPlan } from './plans';
import { CONCISE_REPLIES_PROMPT } from '../../shared/protocol';
import { WIDGET_DESCRIPTION, WIDGET_FENCE_HINT, WIDGET_INPUT_SCHEMA, WIDGET_TOOL, dynamicToolAnswer, widgetsEnabled } from './widget-tool';
import { BROWSER_CORE, BROWSER_DESCRIPTIONS, BROWSER_HINT, BROWSER_INPUT_SCHEMAS, BROWSER_OPS, BROWSER_TOOLS, browserDynamicAnswer, browserOp, browserTabEnabled } from './browser-tool';
import { DEVICE_CORE, DEVICE_DESCRIPTIONS, DEVICE_HINT, DEVICE_INPUT_SCHEMAS, DEVICE_NAMESPACE, DEVICE_NAMESPACE_DESCRIPTION, DEVICE_OPS, DEVICE_TOOLS, deviceDynamicAnswer, deviceEnabled, deviceOp } from './device-tool';
import { CodexRpc, RpcError, resolveCodexCommand, type ExitInfo } from './codex-rpc';
import { serviceTierFor } from './codex-map';
import { AGENT_INPUT_SCHEMA, AGENT_TOOLS, agentOfTool, agentToolDescription, readAgentCall } from './agent-tool';
import { PROFILE_DESCRIPTION, PROFILE_INPUT_SCHEMA, PROFILE_TOOL, isProfileTool, profileDynamicAnswer } from './profile-tool';
import { claimStep } from '../core/sub-agent';
import {
  PRESETS,
  activityFor,
  buildInput,
  changesToDiffs,
  commandTitle,
  draftItem,
  firstLine,
  mapHistory,
  mapLimits,
  limitsMeta,
  resetsMeta,
  mapMcp,
  mapModel,
  mapPlan,
  mapSkill,
  modeInfo,
  preset,
  samePath,
  sandboxPolicy,
  toEffort,
  transcript,
  unwrapCommand,
  warningNotice,
} from './codex-map';

/** Codex warnings already shown in this app run (config warnings arrive again for every thread). */
const shownWarnings = new Set<string>();
/** Codex's warnings about its own setup in this app run, for Settings › Agents (never the timeline). */
const setupWarnings: { text: string; detail?: string }[] = [];
const setupSeen = new Set<string>();

/** A warning about Codex's configuration or setup rather than this thread's work. */
export function isSetupWarning(w: { threadId?: string | null; message?: string | null }): boolean {
  return !w.threadId || /config(uration)?\b|config\.toml|setting|deprecat|feature flag/i.test(w.message ?? '');
}
import type {
  AccountLoginCompletedNotification,
  ApplyPatchApprovalParams,
  CommandExecutionApprovalDecision,
  CommandExecutionRequestApprovalParams,
  ErrorNotification,
  ExecCommandApprovalParams,
  FileChangeApprovalDecision,
  FileChangePatchUpdatedNotification,
  FileChangeRequestApprovalParams,
  GetAccountRateLimitsResponse,
  ConsumeAccountRateLimitResetCreditResponse,
  GetAccountResponse,
  ItemDeltaNotification,
  ItemNotification,
  ListMcpServerStatusResponse,
  LoginAccountResponse,
  ModelListResponse,
  PermissionsRequestApprovalParams,
  PermissionsRequestApprovalResponse,
  RateLimitSnapshot,
  RequestId,
  ReviewDecision,
  ReviewTarget,
  SkillsListResponse,
  Thread,
  ThreadListResponse,
  ThreadStartResponse,
  TokenUsageBreakdown,
  ThreadTokenUsageUpdatedNotification,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  Turn,
  TurnNotification,
  TurnPlanUpdatedNotification,
  TurnStartParams,
  UserInput,
  WarningNotification,
} from './codex-types';

const CLIENT_VERSION = VERSION;
const CAPS_TTL = 60_000;
const THREAD_TIMEOUT = 120_000;
/** The Codex app's plugin behind browser and computer use, when the app-server does not name it. */
const CUA_PLUGIN = 'unified-computer-use@openai-bundled';
const MCP_TTL = 10 * 60_000;
/** An app-server nobody uses is stopped after this long, so idle accounts cost no memory. */
const IDLE_STOP_MS = 3 * 60_000;
/** After the last session of an account closes, its app-server goes sooner. */
const LAST_SESSION_STOP_MS = 45_000;

/** Slash commands handled by CodexSession.send(). Keep in sync with runCommand(). */
const COMMANDS: CommandInfo[] = [
  { name: 'compact', description: 'Summarize the conversation to free up context', kind: 'builtin' },
  {
    name: 'review',
    description: 'Review uncommitted changes, or follow custom review instructions',
    argumentHint: '[instructions]',
    kind: 'builtin',
  },
];

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * OpenAI Codex via `codex app-server` (JSON-RPC v2 over stdio). One shared child process
 * per provider, started lazily and restarted on demand; threads are multiplexed by id.
 */
/** A function tool as `thread/start` takes it (`DynamicToolFunctionSpec`). */
export type CodexFunctionTool = { type: 'function'; name: string; description: string; inputSchema: unknown; deferLoading?: boolean };
/** A dynamic tool: a function, or a namespace of functions (`DynamicToolSpec`); a deferred function must sit in a namespace. */
export type CodexDynamicTool = CodexFunctionTool | { type: 'namespace'; name: string; description: string; tools: CodexFunctionTool[] };
/**
 * How small a Codex model says it is, by its name (a nano, a mini) and the words of its catalog entry
 * ("Fast and affordable model for easier tasks"); 0 for one that says nothing of it.
 */
function smallness(m: ModelInfo): number {
  const name = `${m.id} ${m.name}`;
  const said = m.description ?? '';
  let n = 0;
  if (/\bnano\b/i.test(name)) n += 4;
  else if (/\bmini\b/i.test(name)) n += 3;
  if (/\b(affordable|cheap(est)?|lightweight|small(est)?|mini)\b/i.test(said)) n += 2;
  if (/\b(fast(est)?|quick(est)?|easier|simpler|simple tasks)\b/i.test(said)) n += 1;
  return n;
}

/**
 * The model that names a chat (`CodexProvider.quickTitle`): the smallest one this account's Codex
 * offers (by name and catalog words; a current one before a legacy one, one in the picker before a
 * hidden one), with its lowest effort. None when no model says it is small: no title then.
 */
export function titleModelOf(models: readonly ModelInfo[]): { id: string; effort?: Effort } | undefined {
  const legacy = (m: ModelInfo) => /^(legacy|previous generation)\b/i.test(m.description ?? '');
  const rank = (m: ModelInfo) => smallness(m) * 4 + (legacy(m) ? 0 : 2) + (m.picker ? 1 : 0);
  let best: ModelInfo | undefined;
  for (const m of models) if (smallness(m) > 0 && (!best || rank(m) > rank(best))) best = m;
  if (!best) return undefined;
  const m = best;
  const effort = (['minimal', 'low'] as Effort[]).find((e) => m.efforts?.includes(e));
  return { id: m.id, ...(effort ? { effort } : {}) };
}

/**
 * The thread a title is asked in: ephemeral (never written to the account's history), the title's
 * own instructions instead of Codex's, no environment (so no shell and no file of the folder read),
 * read-only and never asking, no web search, no AGENTS.md, and an explicit empty tool configuration
 * that does not depend on what the inventory knows: the account's MCP servers replaced by none (a
 * config override replaces the whole table), apps off by default with none listed, the plugins
 * table replaced by the known ones (`plugins`, the bundled computer-use one always) switched off,
 * no tools of Sable's and no capability roots. `titleIsolated` then checks the thread itself.
 */
export function titleThreadParams(prompt: TitlePrompt, model: string, plugins: readonly string[] = []): Record<string, unknown> {
  const config: Record<string, unknown> = {
    web_search: 'disabled',
    project_doc_max_bytes: 0,
    mcp_servers: {},
    apps: { _default: { enabled: false, destructive_enabled: false, open_world_enabled: false } },
    plugins: Object.fromEntries([...new Set([CUA_PLUGIN, ...plugins])].map((id) => [id, { enabled: false }])),
  };
  return {
    model,
    cwd: existsSync(prompt.cwd) ? prompt.cwd : homedir(),
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: true,
    baseInstructions: prompt.system,
    environments: [],
    dynamicTools: [],
    selectedCapabilityRoots: [],
    config,
  };
}

/** How long the title thread's own MCP listing may take (with no server it answers at once). */
const TITLE_CHECK_MS = 10_000;

/** The one turn of a title thread: the prompt as text, the lowest effort, no reasoning summary. */
export function titleTurnParams(threadId: string, prompt: TitlePrompt, effort?: Effort): TurnStartParams & { summary: string } {
  return { threadId, input: [{ type: 'text', text: prompt.user, text_elements: [] }], ...(effort ? { effort } : {}), summary: 'none' };
}

/** The namespace that holds the deferred Browser tab tools. */
export const BROWSER_NAMESPACE = 'sable_browser';
const BROWSER_NAMESPACE_DESCRIPTION = "Tools that work the page open in Sable's Browser tab: snapshot, click, type, press, scroll, evaluate, logs, wait, navigate.";

export class CodexProvider implements Provider {
  readonly id = 'codex' as const;
  readonly name = 'Codex';

  /** threadId → session */
  readonly sessions = new Map<string, CodexSession>();
  private rpc: CodexRpc | null = null;
  private starting: Promise<CodexRpc> | null = null;
  private disposed = false;
  private versionCache?: { installed: boolean; version?: string; problem?: string };
  private capsCache = new Map<string, { at: number; caps: Promise<Capabilities> }>();
  private lastAuth?: string;
  private snapshots = new Map<string, RateLimitSnapshot>();
  private mcpCache?: McpServerInfo[];
  private mcpAt = 0;
  private mcpLoading?: Promise<McpServerInfo[]>;
  private pendingLogin?: { loginId: string; resolve: () => void; reject: (e: Error) => void; cancelled: boolean; timer: NodeJS.Timeout };
  /** CODEX_HOME for an extra account; empty for the built-in default (the CLI's own ~/.codex). */
  private readonly env?: Record<string, string>;
  private lastUse = 0;
  private idleTimer?: NodeJS.Timeout;
  /** An app-server this provider is stopping on purpose (its exit is not news). */
  private stopping?: CodexRpc;
  /** Threads a title is being asked in (`quickTitle`), by id: their notifications go to that call, never to a chat. */
  private titleThreads = new Map<string, (method: string, p: any) => void>();

  constructor(readonly ctx: ProviderContext) {
    if (ctx.account?.dir) this.env = { CODEX_HOME: ctx.account.dir };
  }

  /** The CODEX_HOME this account's Codex uses: its own, the user's CODEX_HOME, or ~/.codex. */
  configHome(): string {
    return this.env?.CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
  }

  /** Copies the thread's rollout from another account's CODEX_HOME into this one (see accounts/handover). */
  async adoptConversation(fromHome: string, threadId: string): Promise<boolean> {
    return carryCodexConversation(fromHome, this.configHome(), threadId);
  }

  /** The used-up window of the last known limits (for a refused turn's notice). */
  fullWindow(): RateLimit | undefined {
    return mapLimits([...this.snapshots.values()])
      .filter((l) => l.percent >= 100)
      .sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0];
  }

  // ── idle stop ──

  private armIdle(ms = IDLE_STOP_MS) {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stopIfIdle(ms), ms);
    this.idleTimer.unref?.();
  }

  private stopIfIdle(ms: number) {
    const rpc = this.rpc;
    if (!rpc || this.disposed) return;
    const busy = this.sessions.size > 0 || this.titleThreads.size > 0 || this.remoteWanted.size > 0 || !!this.pendingLogin || !!this.mcpLoading || !!this.starting;
    const quietFor = Date.now() - this.lastUse;
    if (busy || quietFor < ms) return this.armIdle(busy ? IDLE_STOP_MS : Math.max(1000, ms - quietFor));
    this.ctx.log('[codex] stopping idle app-server');
    this.rpc = null;
    this.stopping = rpc;
    void rpc.close().catch(() => {});
  }

  /** Called by a session when it closes: the last one lets the app-server go soon. */
  sessionClosed() {
    if (this.sessions.size === 0) this.armIdle(LAST_SESSION_STOP_MS);
  }

  // ── process ──

  async client(): Promise<CodexRpc> {
    if (this.disposed) throw new Error('Codex provider is shut down');
    this.lastUse = Date.now();
    if (this.rpc?.alive) return this.rpc;
    this.armIdle();
    if (!this.starting) {
      // Experimental API: remote control lives there (the rest of the protocol is unchanged).
      this.starting = CodexRpc.start({ log: this.ctx.log, clientVersion: CLIENT_VERSION, env: this.env, experimental: true })
        .then(async (rpc) => {
          if (this.disposed) {
            await rpc.close();
            throw new Error('Codex provider is shut down');
          }
          rpc.onNotification = (m, p) => this.onNotification(m, p);
          rpc.onRequest = (m, p, id) => this.onServerRequest(m, p, id);
          rpc.onExit = (info) => this.onExit(rpc, info);
          this.rpc = rpc;
          // Remote control belongs to the process: a new one picks it up again.
          if (this.remoteWanted.size) setTimeout(() => void this.syncRemote(), 0);
          return rpc;
        })
        .finally(() => {
          this.starting = null;
        });
    }
    return this.starting;
  }

  private onExit(rpc: CodexRpc, info: ExitInfo) {
    if (this.rpc === rpc) this.rpc = null;
    this.remoteOn = false;
    if (this.stopping === rpc) {
      this.stopping = undefined;
      return;
    }
    if (this.disposed) return;
    const tail = info.stderr
      .replace(/\x1b\[[0-9;]*m/g, '')
      .trim()
      .split('\n')
      .slice(-3)
      .join('\n');
    this.ctx.log('[codex] app-server exited', info.code ?? info.signal ?? '', tail);
    const msg = `Codex app-server exited${info.code !== null ? ` (code ${info.code})` : ''}`;
    for (const s of [...this.sessions.values()]) s.onServerDied(msg, tail);
    this.sessions.clear();
    if (this.pendingLogin) this.finishLogin(new Error(msg));
  }

  private onNotification(method: string, p: any) {
    // Fresh plan limits when a turn ends (the rolling updates are sparse).
    if (method === 'turn/completed') this.refreshLimitsSoon();
    switch (method) {
      case 'account/login/completed':
        return this.onLoginCompleted(p as AccountLoginCompletedNotification);
      case 'remoteControl/status/changed':
        this.remoteStatus = p?.status;
        return this.broadcastRemote();
      case 'configWarning':
        return this.noteWarning(p?.summary, p?.details);
      case 'warning':
        // A warning for no thread in particular (the app-server's own start-up); a thread's goes to its session.
        if (!p?.threadId) return this.noteWarning(p?.message);
        if (typeof p.threadId === 'string') this.sessions.get(p.threadId)?.onNotification(method, p);
        return;
      case 'account/updated':
        void this.info()
          .then((info) => {
            const key = JSON.stringify(info.auth);
            if (this.lastAuth !== undefined && key !== this.lastAuth) this.ctx.emit({ type: 'provider.updated', provider: info });
          })
          .catch(() => {});
        return;
      case 'account/rateLimits/updated': {
        const snap = p?.rateLimits as RateLimitSnapshot | undefined;
        if (!snap) return;
        const key = snap.limitId ?? 'codex';
        const prev = this.snapshots.get(key);
        // Sparse update: merge over the last full read.
        this.snapshots.set(key, { ...prev, ...snap, primary: snap.primary ?? prev?.primary ?? null, secondary: snap.secondary ?? prev?.secondary ?? null });
        this.ctx.emit({ type: 'limits.updated', provider: 'codex', limits: mapLimits([...this.snapshots.values()]), meta: limitsMeta([...this.snapshots.values()]) });
        return;
      }
      default: {
        const tid = p?.threadId;
        if (typeof tid !== 'string') return;
        const title = this.titleThreads.get(tid);
        if (title) return title(method, p);
        this.sessions.get(tid)?.onNotification(method, p);
      }
    }
  }

  /**
   * A chat's title from Codex's smallest model, on this account (its own app-server and CODEX_HOME):
   * one prompt in an ephemeral thread with no environment, no tools and the title's own instructions,
   * the lowest effort, nothing kept. Null when this account has no small model or gives no answer.
   * `holds`: whether the chat still wants this title (ChatTitles: still open, titles on, its title
   * unchanged, the same agent and account); checked with the signal right before the prompt goes
   * out, so a title given up or no longer wanted while its thread started sends nothing. Null too
   * when the thread cannot be shown to have no MCP server (`titleIsolated`).
   */
  async quickTitle(prompt: TitlePrompt, signal: AbortSignal, holds?: () => boolean): Promise<string | null> {
    const wanted = () => !signal.aborted && (holds?.() ?? true);
    if (!wanted()) return null;
    const caps = await this.caps().catch(() => undefined);
    const pick = titleModelOf(caps?.models ?? []);
    if (!pick || !wanted()) return null;
    const rpc = await this.client();
    if (!wanted()) return null;
    const plugins = (this.mcpCache ?? []).flatMap((s) => (s.scope ? [s.scope] : []));
    const started = await rpc.request<ThreadStartResponse>('thread/start', titleThreadParams(prompt, pick.id, plugins), THREAD_TIMEOUT);
    const threadId = started.thread.id;
    // The thread exists from here: whatever happens next, it is let go (thread/unsubscribe) and never gets a prompt it should not.
    if (!wanted() || !(await this.titleIsolated(rpc, threadId)) || !wanted()) {
      void rpc.request('thread/unsubscribe', { threadId }, 10_000).catch(() => {});
      return null;
    }
    let text = '';
    let deltas = '';
    let turnId: string | undefined;
    let quit = () => {};
    const done = new Promise<void>((resolve, reject) => {
      quit = resolve;
      this.titleThreads.set(threadId, (method, p) => {
        if (method === 'item/agentMessage/delta' && typeof p?.delta === 'string') deltas += p.delta;
        else if (method === 'item/completed' && p?.item?.type === 'agentMessage' && typeof p.item.text === 'string') text = p.item.text;
        else if (method === 'turn/started' && p?.turn?.id) turnId ??= p.turn.id;
        else if (method === 'error' && !p?.willRetry) reject(new Error(p?.error?.message ?? 'Codex error'));
        else if (method === 'turn/completed') {
          if (p?.turn?.status === 'failed') reject(new Error(p.turn.error?.message ?? 'The title turn failed'));
          else resolve();
        }
      });
    });
    // Settled before it is awaited (an error while the turn starts): no unhandled rejection meanwhile.
    done.catch(() => {});
    const stop = () => quit();
    signal.addEventListener('abort', stop, { once: true });
    try {
      const r = await rpc.request<{ turn: Turn }>('turn/start', titleTurnParams(threadId, prompt, pick.effort), 60_000);
      turnId ??= r.turn?.id;
      if (!signal.aborted) await done;
    } finally {
      signal.removeEventListener('abort', stop);
      this.titleThreads.delete(threadId);
      if (signal.aborted && turnId) void rpc.request('turn/interrupt', { threadId, turnId }, 10_000).catch(() => {});
      void rpc.request('thread/unsubscribe', { threadId }, 10_000).catch(() => {});
    }
    if (signal.aborted) return null;
    return (text || deltas).trim() || null;
  }

  /**
   * Whether a title thread is shown to have no MCP server (none of the account's, no plugin's, no
   * app's): its own listing (`threadId`: that thread's connections) answers with an empty list. Any
   * server listed, no list, a failure or no answer in time: not shown, so no title.
   */
  private async titleIsolated(rpc: CodexRpc, threadId: string): Promise<boolean> {
    try {
      const r = await rpc.request<ListMcpServerStatusResponse>('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', limit: 1 }, TITLE_CHECK_MS);
      if (Array.isArray(r?.data) && r.data.length === 0) return true;
      this.ctx.log('[codex] the title thread has MCP servers; no title');
    } catch (err) {
      this.ctx.log('[codex] the title thread could not be checked; no title:', errMsg(err));
    }
    return false;
  }

  private async onServerRequest(method: string, p: any, id: RequestId): Promise<unknown> {
    const tid: string | undefined = p?.threadId ?? p?.conversationId;
    const s = tid ? this.sessions.get(tid) : undefined;
    if (s) return s.onRequest(method, p, id);
    // Nobody to ask: refuse safely.
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        return { decision: 'decline' };
      case 'item/permissions/requestApproval':
        return { permissions: {}, scope: 'turn' };
      case 'item/tool/requestUserInput':
        return { answers: {} };
      case 'item/tool/call':
        return dynamicToolAnswer(p);
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null };
      case 'execCommandApproval':
      case 'applyPatchApproval':
        return { decision: 'abort' };
      default:
        throw new RpcError(`Sable does not support ${method}`, -32601);
    }
  }

  // ── info & auth ──

  private version(force: boolean): Promise<{ installed: boolean; version?: string; problem?: string }> {
    if (this.versionCache && !force) return Promise.resolve(this.versionCache);
    const cmd = resolveCodexCommand(['--version'], this.env);
    return new Promise((resolve) => {
      execFile(cmd.file, cmd.args, { shell: cmd.shell, windowsHide: true, timeout: 15_000, env: cmd.env }, (err, stdout, stderr) => {
        const out = `${stdout ?? ''}`.trim();
        const m = out.match(/(\d+\.\d+\.\d+[\w.-]*)/);
        this.versionCache =
          err && !m
            ? { installed: false, problem: /ENOENT|not recognized|not found/i.test(`${err.message}${stderr}`) ? 'Codex CLI is not installed (npm i -g @openai/codex)' : `codex --version failed: ${firstLine(`${stderr || err.message}`, 160)}` }
            : { installed: true, version: m?.[1] ?? out };
        resolve(this.versionCache);
      });
    });
  }

  async info(force = false): Promise<ProviderInfo> {
    const v = await this.version(force);
    const base = { id: this.id, name: this.name, installed: v.installed, version: v.version };
    if (!v.installed) return { ...base, auth: { loggedIn: false }, problem: v.problem };
    try {
      const rpc = await this.client();
      const r = await rpc.request<GetAccountResponse>('account/read', { refreshToken: false }, 20_000);
      const a = r.account;
      let auth: AuthState = { loggedIn: false };
      const plan = codexPlan(a, !a && !r.requiresOpenaiAuth);
      if (a?.type === 'chatgpt') auth = { loggedIn: true, method: 'chatgpt', email: a.email ?? undefined, ...plan, org: a.workspaceName ?? undefined };
      else if (a) auth = { loggedIn: true, method: a.type, ...plan };
      else if (!r.requiresOpenaiAuth) auth = { loggedIn: true, method: 'custom provider', ...plan };
      this.lastAuth = JSON.stringify(auth);
      // The app-server is up and signed in: read the limits now (free, about half a second), so a
      // first launch has them when the app is ready instead of asking only once the UI is up and
      // waiting another round trip. A view that asks meanwhile shares this read.
      if (auth.loggedIn && !this.limitsPrimed) {
        this.limitsPrimed = true;
        void this.limits().catch(() => {});
      }
      return { ...base, auth, ...(setupWarnings.length ? { warnings: setupWarnings.map((w) => ({ ...w })) } : {}) };
    } catch (err) {
      return { ...base, auth: { loggedIn: false }, problem: errMsg(err) };
    }
  }

  /**
   * Records a warning about Codex's own setup (once per app run) and tells the UI, which shows it
   * as one quiet line in Settings › Agents. Never a timeline item.
   */
  noteWarning(message: string | null | undefined, detail?: string | null) {
    const n = warningNotice(detail ? `${message ?? ''}\n${detail}` : message, setupSeen);
    if (!n) return;
    setupWarnings.push(n);
    void this.info()
      .then((info) => this.ctx.emit({ type: 'provider.updated', provider: info }))
      .catch(() => {});
  }

  async login(): Promise<void> {
    const rpc = await this.client();
    if (this.pendingLogin) await this.cancelLogin();
    const r = await rpc.request<LoginAccountResponse>('account/login/start', { type: 'chatgpt' }, 30_000);
    if (r.type !== 'chatgpt' && r.type !== 'chatgptDeviceCode') return;
    const url = r.type === 'chatgpt' ? r.authUrl : r.verificationUrl;
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        void rpc.request('account/login/cancel', { loginId: r.loginId }).catch(() => {});
        this.finishLogin(new Error('Login timed out'));
      }, 10 * 60_000);
      timer.unref();
      this.pendingLogin = { loginId: r.loginId, resolve, reject, cancelled: false, timer };
    });
    this.ctx.emit({
      type: 'auth.progress',
      provider: 'codex',
      state: 'url',
      url,
      message: r.type === 'chatgptDeviceCode' ? `Enter code ${r.userCode}` : 'Sign in with ChatGPT in your browser',
    });
    return done;
  }

  private finishLogin(err?: Error) {
    const l = this.pendingLogin;
    if (!l) return;
    this.pendingLogin = undefined;
    clearTimeout(l.timer);
    this.capsCache.clear();
    if (err && !l.cancelled) l.reject(err);
    else l.resolve();
  }

  private onLoginCompleted(p: AccountLoginCompletedNotification) {
    const l = this.pendingLogin;
    if (!l || (p.loginId && p.loginId !== l.loginId)) return;
    this.finishLogin(p.success ? undefined : new Error(p.error || 'Login failed'));
  }

  async cancelLogin(): Promise<void> {
    const l = this.pendingLogin;
    if (!l) return;
    l.cancelled = true;
    try {
      await this.rpc?.request('account/login/cancel', { loginId: l.loginId }, 10_000);
    } catch {
      /* already finished */
    }
    this.finishLogin();
  }

  async logout(): Promise<void> {
    const rpc = await this.client();
    await rpc.request('account/logout', undefined, 20_000);
    this.capsCache.clear();
  }

  // ── remote control (one per app-server process, shared by its sessions) ──

  private remoteWanted = new Set<CodexSession>();
  private remoteOn = false;
  private remoteStatus?: string;
  private pairing?: { code: string; expiresAt: number };
  private remoteSync?: Promise<void>;

  setRemote(session: CodexSession, on: boolean) {
    if (on) this.remoteWanted.add(session);
    else {
      this.remoteWanted.delete(session);
      session.setRemoteState(undefined);
    }
    return this.syncRemote();
  }

  private syncRemote(): Promise<void> {
    const run = (this.remoteSync ?? Promise.resolve()).then(async () => {
      const want = this.remoteWanted.size > 0;
      if (want === this.remoteOn && (!want || this.pairing)) return this.broadcastRemote();
      const rpc = await this.client();
      if (want) {
        const r = await rpc.request<{ status: string }>('remoteControl/enable', { ephemeral: true }, 20_000);
        this.remoteOn = true;
        this.remoteStatus = r.status;
        const p = await rpc.request<{ manualPairingCode: string | null; pairingCode: string; expiresAt: number | bigint }>('remoteControl/pairing/start', { manualCode: true }, 20_000).catch((err) => {
          this.ctx.log('[codex] remote pairing failed:', errMsg(err));
          return undefined;
        });
        if (p) this.pairing = { code: p.manualPairingCode ?? p.pairingCode, expiresAt: Number(p.expiresAt) * 1000 };
      } else {
        await rpc.request('remoteControl/disable', { ephemeral: true }, 20_000).catch(() => {});
        this.remoteOn = false;
        this.pairing = undefined;
      }
      this.broadcastRemote();
    });
    this.remoteSync = run.catch((err) => {
      const msg = errMsg(err);
      this.ctx.log('[codex] remote control failed:', msg);
      for (const s of this.remoteWanted) s.setRemoteState({ status: /unknown|not supported|-32601/i.test(msg) ? 'This Codex version has no remote control' : 'Remote control could not start', tone: 'error' });
    });
    return this.remoteSync;
  }

  private broadcastRemote() {
    const s = this.remoteStatus;
    const code = this.pairing && this.pairing.expiresAt > Date.now() ? this.pairing.code : undefined;
    const state =
      s === 'connected'
        ? { status: code ? 'Connected. Pair from the Codex app on another device with this code' : 'Connected', tone: 'ok' as const, code }
        : s === 'connecting'
          ? { status: 'Connecting to remote control', tone: 'waiting' as const, code }
          : s === 'errored'
            ? { status: 'Remote control could not connect. It may already be on in the Codex app', tone: 'error' as const }
            : { status: 'Remote control is off', tone: 'waiting' as const };
    for (const sess of this.remoteWanted) sess.setRemoteState(state);
  }

  /** The plugin that gives Codex browser and computer use (from the Codex app), when this setup has it. */
  computerUsePlugin(list = this.mcpCache): string | undefined {
    return list?.find((s) => s.scope && /computer-use/i.test(s.scope))?.scope;
  }

  // ── developer instructions ──

  /** Whether new threads get the user's profile and remember_about_user (Settings › Profile). */
  profileOn() {
    return !!this.ctx.profile?.().enabled();
  }

  /** The user's profile as it goes into the instructions, with the line about the tool (empty when off). */
  profileText() {
    try {
      return this.ctx.profile?.().prompt(true) ?? '';
    } catch (err) {
      this.ctx.log('[codex] the profile could not be read:', errMsg(err));
      return '';
    }
  }

  /** remember_about_user: one fact into the profile. */
  rememberAboutUser(args: unknown): { ok: boolean; text: string } {
    const profile = this.ctx.profile?.();
    if (!profile) return { ok: false, text: 'The profile is not available.' };
    const fact = args && typeof args === 'object' ? (args as Record<string, unknown>).fact : undefined;
    return profile.remember(fact);
  }

  /**
   * Developer instructions for a thread: what the user configured for this folder
   * (developer_instructions in config.toml) followed by the short-answers instruction and the
   * generative UI hint when those settings are on. Undefined means "send nothing" (Codex then uses
   * the config as it is).
   */
  async developerInstructions(cwd: string, meta?: Pick<SessionMeta, 'options'>): Promise<string | undefined> {
    const settings = this.ctx.settings?.();
    const ours = [settings?.conciseReplies === false ? '' : CONCISE_REPLIES_PROMPT, widgetsEnabled(settings) ? WIDGET_FENCE_HINT : '', meta && browserTabEnabled(meta) ? BROWSER_HINT : '', meta && deviceEnabled(meta) ? DEVICE_HINT : '', this.profileText()].filter(Boolean).join('\n\n');
    if (!ours) return undefined;
    let own: string | undefined;
    try {
      const rpc = await this.client();
      const r = await rpc.request<{ config?: { developer_instructions?: string | null } }>('config/read', { cwd }, 15_000);
      own = r.config?.developer_instructions?.trim() || undefined;
    } catch (err) {
      this.ctx.log('[codex] config/read failed:', errMsg(err));
    }
    return own ? `${own}\n\n${ours}` : ours;
  }

  /**
   * Client-defined tools for a new thread: show_widget while generative UI is on, and the Browser tab
   * tools while that capability is on. The app-server accepts a deferred tool only inside a namespace,
   * so the page-acting ones go in one (`sable_browser`); a call to them arrives as
   * `{ namespace: 'sable_browser', tool: 'browser_click' }`, and `browserOp` reads the plain tool name.
   */
  dynamicTools(meta?: Pick<SessionMeta, 'options'>): CodexDynamicTool[] | undefined {
    const tools: CodexDynamicTool[] = [];
    if (widgetsEnabled(this.ctx.settings?.())) tools.push({ type: 'function', name: WIDGET_TOOL, description: WIDGET_DESCRIPTION, inputSchema: WIDGET_INPUT_SCHEMA });
    // The user's profile: one short fact at a time, merged by Sable (never secrets).
    if (this.profileOn()) tools.push({ type: 'function', name: PROFILE_TOOL, description: PROFILE_DESCRIPTION, inputSchema: PROFILE_INPUT_SCHEMA });
    // Sub-agents from the other agent (Claude Code), while it is installed and signed in.
    if (meta && this.ctx.runAgent)
      for (const agent of this.ctx.otherAgents?.() ?? []) {
        const name = AGENT_TOOLS[agent];
        if (agent !== 'codex' && name) tools.push({ type: 'function', name, description: agentToolDescription(agent), inputSchema: AGENT_INPUT_SCHEMA });
      }
    // The Browser tab tools, while the session's capability is on (a thread keeps what it was started with).
    // Those that work an open page wait behind Codex's tool search until the agent looks for them.
    if (meta && browserTabEnabled(meta)) {
      const deferred: CodexFunctionTool[] = [];
      for (const op of BROWSER_OPS) {
        const fn: CodexFunctionTool = { type: 'function', name: BROWSER_TOOLS[op], description: BROWSER_DESCRIPTIONS[op], inputSchema: BROWSER_INPUT_SCHEMAS[op] };
        if (BROWSER_CORE.has(op)) tools.push(fn);
        else deferred.push({ ...fn, deferLoading: true });
      }
      if (deferred.length) tools.push({ type: 'namespace', name: BROWSER_NAMESPACE, description: BROWSER_NAMESPACE_DESCRIPTION, tools: deferred });
    }
    // The Android device tools, while the session's "Device" capability is on: looking in the prompt, working the device deferred.
    if (meta && deviceEnabled(meta)) {
      const deferred: CodexFunctionTool[] = [];
      for (const op of DEVICE_OPS) {
        const fn: CodexFunctionTool = { type: 'function', name: DEVICE_TOOLS[op], description: DEVICE_DESCRIPTIONS[op], inputSchema: DEVICE_INPUT_SCHEMAS[op] };
        if (DEVICE_CORE.has(op)) tools.push(fn);
        else deferred.push({ ...fn, deferLoading: true });
      }
      if (deferred.length) tools.push({ type: 'namespace', name: DEVICE_NAMESPACE, description: DEVICE_NAMESPACE_DESCRIPTION, tools: deferred });
    }
    return tools.length ? tools : undefined;
  }

  // ── capabilities ──

  caps(cwd?: string): Promise<Capabilities> {
    const key = cwd ? path.resolve(cwd) : '';
    const hit = this.capsCache.get(key);
    if (hit && Date.now() - hit.at < CAPS_TTL) return hit.caps;
    const caps = this.loadCaps(key || undefined);
    this.capsCache.set(key, { at: Date.now(), caps });
    caps.catch(() => this.capsCache.delete(key));
    return caps;
  }

  private async loadCaps(cwd?: string): Promise<Capabilities> {
    const rpc = await this.client();
    const models = async (): Promise<ModelInfo[]> => {
      const out: ModelInfo[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const r: ModelListResponse = await rpc.request<ModelListResponse>('model/list', { cursor, limit: 100 }, 20_000);
        // Hidden and superseded models come too (listed under Show all); the picker flag says which the agent offers.
        for (const m of r.data ?? []) out.push(mapModel(m));
        cursor = r.nextCursor;
        if (!cursor) break;
      }
      if (out.length && !out.some((m) => m.isDefault)) (out.find((m) => m.picker) ?? out[0]).isDefault = true;
      return out;
    };
    const skills = async () => {
      const r = await rpc.request<SkillsListResponse>('skills/list', cwd ? { cwds: [cwd] } : {}, 20_000);
      const seen = new Set<string>();
      return (r.data ?? [])
        .flatMap((e) => e.skills ?? [])
        .filter((s) => s.enabled !== false && !seen.has(s.name) && seen.add(s.name))
        .map(mapSkill);
    };
    const soft = <T,>(p: Promise<T>, fallback: T, what: string) =>
      p.catch((err) => {
        this.ctx.log(`[codex] ${what} failed:`, errMsg(err));
        return fallback;
      });
    // MCP inventory is slow (it boots every configured server; ~50s here): never block on it.
    if (!this.mcpCache || Date.now() - this.mcpAt > MCP_TTL) void this.refreshMcp();
    const [m, s] = await Promise.all([models(), soft(skills(), [], 'skills/list')]);
    return {
      models: m,
      modes: PRESETS.map(modeInfo),
      commands: COMMANDS,
      skills: s,
      agents: [],
      mcpServers: this.mcpCache ?? [],
      tools: ['shell', 'apply_patch', 'update_plan', 'web_search', 'view_image'],
      skillTrigger: '$',
      features: { images: true, thinking: true, rewind: false, steer: true, compact: true, fast: false, ultracode: false, ...this.optionalFeatures() },
    };
  }

  /** What this setup adds: the Codex app's computer-use plugin (browser + desktop), remote control. */
  optionalFeatures(list = this.mcpCache) {
    const cua = !!this.computerUsePlugin(list);
    return { browser: cua, computerUse: cua, linkedBrowserComputer: cua, remoteControl: !!this.lastAuth?.includes('"chatgpt"') };
  }

  /** Background MCP refresh; pushes the result into cached caps and open sessions. */
  refreshMcp(threadId?: string): Promise<McpServerInfo[]> {
    if (this.mcpLoading) return this.mcpLoading;
    const run = (async () => {
      const rpc = await this.client();
      const r = await rpc.request<ListMcpServerStatusResponse>(
        'mcpServerStatus/list',
        { detail: 'toolsAndAuthOnly', limit: 100, ...(threadId ? { threadId } : {}) },
        120_000,
      );
      return (r.data ?? []).map(mapMcp);
    })()
      .then((list) => {
        this.mcpCache = list;
        this.mcpAt = Date.now();
        const features = this.optionalFeatures(list);
        for (const [cwd, entry] of this.capsCache) {
          entry.caps = entry.caps.then((c) => ({ ...c, mcpServers: list, features: { ...c.features, ...features } }));
          // The home composer asked before this slow inventory finished: tell it.
          void entry.caps.then((caps) => this.ctx.emit({ type: 'caps.updated', provider: 'codex', cwd: cwd || undefined, caps })).catch(() => {});
        }
        for (const s of this.sessions.values()) s.updateMcp(list);
        return list;
      })
      .catch((err) => {
        this.ctx.log('[codex] mcpServerStatus/list failed:', errMsg(err));
        this.mcpAt = Date.now();
        this.mcpCache ??= [];
        return this.mcpCache;
      })
      .finally(() => {
        if (this.mcpLoading === run) this.mcpLoading = undefined;
      });
    this.mcpLoading = run;
    return run;
  }

  /** A read in flight: callers that ask meanwhile (the start-up read, a view opening) share it. */
  private limitsRun?: Promise<RateLimit[]>;
  /** The first sign-in seen in this run started a limits read. */
  private limitsPrimed = false;

  limits(): Promise<RateLimit[]> {
    if (this.limitsRun) return this.limitsRun;
    const run = (async () => {
      const rpc = await this.client();
      const r = await rpc.request<GetAccountRateLimitsResponse>('account/rateLimits/read', { excludeResetCreditDetails: true }, 20_000);
      this.snapshots.clear();
      const byId = r.rateLimitsByLimitId ? Object.values(r.rateLimitsByLimitId).filter((x): x is RateLimitSnapshot => !!x) : [];
      for (const s of byId.length ? byId : r.rateLimits ? [r.rateLimits] : []) this.snapshots.set(s.limitId ?? 'codex', s);
      const snaps = [...this.snapshots.values()];
      const limits = mapLimits(snaps);
      const resets = resetsMeta(r.rateLimitResetCredits, limits);
      this.ctx.emit({ type: 'limits.updated', provider: 'codex', limits, meta: { ...limitsMeta(snaps), ...(resets ? { resets } : {}) } });
      return limits;
    })().finally(() => {
      if (this.limitsRun === run) this.limitsRun = undefined;
    });
    this.limitsRun = run;
    return run;
  }

  /**
   * Spends one granted reset (the backend picks the next available credit), then reads the
   * limits again. Only ever called from the user's confirmed click (`provider.useReset`).
   */
  async useReset(key: string): Promise<ResetOutcome> {
    const rpc = await this.client();
    const r = await rpc.request<ConsumeAccountRateLimitResetCreditResponse>('account/rateLimitResetCredit/consume', { idempotencyKey: key }, 30_000);
    await this.limitsRun?.catch(() => {}); // a read started before the reset would show the old state
    await this.limits().catch(() => {});
    return r.outcome;
  }

  private limitsTimer?: NodeJS.Timeout;
  private limitsAt = 0;

  /** One limits read shortly after a turn ends, at most every 20 seconds. */
  private refreshLimitsSoon() {
    if (this.limitsTimer || this.disposed) return;
    const wait = Math.max(1500, 20_000 - (Date.now() - this.limitsAt));
    this.limitsTimer = setTimeout(() => {
      this.limitsTimer = undefined;
      this.limitsAt = Date.now();
      if (!this.disposed && this.rpc) void this.limits().catch(() => {});
    }, wait);
    this.limitsTimer.unref?.();
  }

  async history(cwd?: string, limit = 50): Promise<HistoryEntry[]> {
    const rpc = await this.client();
    limit = Math.max(1, Math.min(limit, 100)); // the server caps pages at 100
    // useStateDbOnly: without it the server re-scans every JSONL rollout (~60s on a big history).
    const list = (extra: object) =>
      rpc.request<ThreadListResponse>('thread/list', { limit, sortKey: 'updated_at', archived: false, useStateDbOnly: true, ...extra }, 30_000);
    let threads: Thread[];
    if (cwd) {
      threads = (await list({ cwd: path.resolve(cwd) })).data ?? [];
      // The server filter is an exact string match; fall back to a normalized client-side match.
      if (!threads.length) threads = ((await list({ limit: 100 })).data ?? []).filter((t) => t.cwd && samePath(t.cwd, cwd));
    } else threads = (await list({})).data ?? [];
    return threads
      .filter((t) => !t.parentThreadId)
      .slice(0, limit)
      .map(mapHistory);
  }

  // ── sessions ──

  async open(rt: SessionRuntime, opts: { loadTranscript?: boolean }): Promise<ProviderSession> {
    const session = new CodexSession(this, rt);
    await session.attach(!!opts.loadTranscript);
    return session;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    if (this.pendingLogin) this.finishLogin(new Error('Codex provider is shut down'));
    for (const s of this.sessions.values()) s.abortPrompts();
    this.sessions.clear();
    const rpc = this.rpc ?? (await this.starting?.catch(() => null)) ?? null;
    this.rpc = null;
    await rpc?.close();
  }
}

// ─────────────────────────────────── session ───────────────────────────────────

interface Queued {
  item: UserItem;
  input: UserInput[];
}

/** How long an idle thread waits for its turn's own turn/completed before the turn is ended without it. */
const THREAD_IDLE_GRACE_MS = 1_500;
/**
 * While the thread stays idle and its store still says the turn runs (a stale answer), it is asked
 * again after each of these waits; after the last the turn ends with nothing queued going out.
 */
const IDLE_RECHECK_MS = [2_000, 4_000, 8_000, 16_000];


class CodexSession implements ProviderSession {
  threadId = '';
  /** The thread is loaded in the current app-server process. */
  private loaded = false;
  private closed = false;
  private turnId?: string;
  private turnStarting?: Promise<unknown>;
  private queue: Queued[] = [];
  private policyDirty = false;
  private interruptTimer?: NodeJS.Timeout;
  private commandTimer?: NodeJS.Timeout;
  /** The thread reported idle while a turn was open: the turn ends unless turn/completed comes first. */
  private idleTimer?: NodeJS.Timeout;
  /** The turn's generation: a new one for every turn begun here or by Codex, so late news of an earlier one is told apart. */
  private gen = 0;
  /** This turn showed itself (turn/started, or the thread went active) since it began. */
  private sawActive = false;
  /** The thread went idle (after this turn showed itself) while turn/start was still out: considered when it returns. */
  private idleSeen = false;
  /** The person asked to stop this turn. */
  private interrupting = false;
  /** News of the thread's state seen (a status change, a turn started): a probe of an idle answers only while nothing newer came. */
  private statusSeen = 0;
  /** The waits between rechecks of a stale idle (IDLE_RECHECK_MS; tests make them short). */
  private idleRecheckMs: readonly number[] = IDLE_RECHECK_MS;
  /** Turns that ended (newest last, a few): a turn/completed for one of them is late news, never the running turn's end. */
  private doneTurns: string[] = [];
  private prompts = new Map<string, AbortController>();
  private reasoningSource = new Map<string, 'summary' | 'content'>();
  private compactSeen = false;
  /**
   * Errors that ended a turn, by the provider turn id they name ('' for one that names none): only
   * the running turn's own counts, also while its turn/start is out and its id not known yet.
   */
  private turnErrors = new Map<string, string>();
  /** Last thread-wide total seen in this session (undefined until the first usage update). */
  private lastTotal?: TokenUsageBreakdown;
  private turnTokens = { input: 0, output: 0 };
  /** Thread config the loaded thread was started or resumed with (JSON), and whether it is out of date. */
  private appliedConfig = 'null';
  private optionsDirty = false;
  /** What the thread was last started or resumed with (read by tests and smoke scripts). */
  sentParams?: Record<string, unknown>;

  constructor(
    private provider: CodexProvider,
    private rt: SessionRuntime,
  ) {}

  private log(...a: unknown[]) {
    this.provider.ctx.log('[codex]', ...a);
  }

  // ── lifecycle ──

  async attach(loadTranscript: boolean) {
    const rt = this.rt;
    const { resp, resumed } = await this.resumeOrStart(rt.meta.providerSessionId);
    if (resumed && loadTranscript) rt.reset(transcript(await this.loadTurns(resp.thread.id)));
    // A resumed thread opened without a title: its name, else the first prompt (as Claude sessions do).
    if (resumed && rt.meta.titleSource === 'auto' && rt.meta.title === 'New session') {
      const first = rt.items.find((i): i is UserItem => i.type === 'user')?.text || resp.thread.preview || '';
      const title = (resp.thread.name?.trim() || first.trim()).split('\n')[0].slice(0, 56);
      if (title) rt.update({ title });
    }
    rt.update({
      providerSessionId: this.threadId,
      model: rt.meta.model || resp.model || resp.thread.model || '',
      effort: rt.meta.effort ?? toEffort(resp.reasoningEffort ?? resp.thread.reasoningEffort),
    });
    try {
      const caps = await this.provider.caps(rt.meta.cwd);
      rt.setCaps(caps);
      if (!rt.meta.model) {
        const def = caps.models.find((m) => m.isDefault) ?? caps.models[0];
        if (def) rt.update({ model: def.id });
      }
    } catch (err) {
      this.log('caps failed', errMsg(err));
    }
    this.showCuaState();
    if (rt.meta.options?.remoteControl) void this.provider.setRemote(this, true).catch(() => {});
  }

  /** Full stored history, oldest turn first. */
  private async loadTurns(threadId: string): Promise<Turn[]> {
    const rpc = await this.provider.client();
    try {
      const turns: Turn[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 100; page++) {
        const r: { data: Turn[]; nextCursor: string | null } = await rpc.request('thread/turns/list', { threadId, cursor, limit: 50, sortDirection: 'asc', itemsView: 'full' }, 30_000);
        turns.push(...(r.data ?? []));
        cursor = r.nextCursor;
        if (!cursor) break;
      }
      return turns;
    } catch (err) {
      this.log('thread/turns/list failed, falling back to thread/read', errMsg(err));
      const r = await rpc.request<{ thread: Thread }>('thread/read', { threadId, includeTurns: true }, 60_000);
      return r.thread.turns ?? [];
    }
  }

  /** Re-resumes the thread after an app-server restart. */
  private async ensureLoaded() {
    if (this.closed) throw new Error('Session is closed');
    if (this.loaded && this.provider.sessions.get(this.threadId) === this) return;
    const { resp } = await this.resumeOrStart(this.threadId);
    if (resp.thread.id !== this.rt.meta.providerSessionId) this.rt.update({ providerSessionId: resp.thread.id });
  }

  /**
   * Resumes `threadId` (or starts a thread when there is none). Codex only writes a rollout
   * once the first turn runs, so a thread that never had a turn cannot be resumed after an
   * app-server restart ("no rollout found"); nothing is lost then, so start a fresh one.
   */
  private async resumeOrStart(threadId: string | undefined): Promise<{ resp: ThreadStartResponse; resumed: boolean }> {
    const rt = this.rt;
    const rpc = await this.provider.client();
    const p = preset(rt.meta.mode);
    const config = this.threadConfig();
    const developerInstructions = await this.provider.developerInstructions(rt.meta.cwd, rt.meta);
    const params = {
      cwd: rt.meta.cwd,
      approvalPolicy: p.approval,
      sandbox: p.sandbox,
      model: rt.meta.model || null,
      ...(config ? { config } : {}),
      ...(developerInstructions ? { developerInstructions } : {}),
    };
    this.sentParams = params;
    this.appliedConfig = JSON.stringify(config ?? null);
    this.optionsDirty = false;
    let resp: ThreadStartResponse | undefined;
    let resumed = false;
    if (threadId) {
      try {
        resp = await rpc.request<ThreadStartResponse>('thread/resume', { ...params, threadId, excludeTurns: true }, THREAD_TIMEOUT);
        resumed = true;
      } catch (err) {
        if (!/no rollout found/i.test(errMsg(err))) throw err;
        this.log('thread', threadId, 'has no rollout yet; starting a new thread');
      }
    }
    // Dynamic tools exist only on thread/start (a resumed thread keeps what it was started with).
    const dynamicTools = this.provider.dynamicTools(rt.meta);
    resp ??= await rpc.request<ThreadStartResponse>('thread/start', dynamicTools ? { ...params, dynamicTools } : params, THREAD_TIMEOUT);
    if (this.threadId && this.threadId !== resp.thread.id && this.provider.sessions.get(this.threadId) === this) this.provider.sessions.delete(this.threadId);
    this.threadId = resp.thread.id;
    this.loaded = true;
    this.policyDirty = false;
    this.provider.sessions.set(this.threadId, this);
    return { resp, resumed };
  }

  onServerDied(msg: string, detail?: string) {
    this.loaded = false;
    this.turnStarting = undefined;
    this.abortPrompts();
    // Drop the queue first so completeTurn() doesn't immediately restart the server for it.
    const dropped = this.queue.length;
    this.queue = [];
    if (this.rt.turnActive) {
      this.rt.notice('error', msg, detail || undefined);
      this.completeTurn({ status: 'failed', error: msg });
    }
    if (dropped) this.rt.notice('error', 'Queued messages were not sent', 'The Codex app-server stopped. Send them again.');
  }

  abortPrompts() {
    for (const ac of this.prompts.values()) ac.abort();
    this.prompts.clear();
  }

  async close() {
    if (this.closed) return;
    if (this.rt.turnActive) await this.interrupt().catch(() => {});
    this.closed = true;
    void this.provider.setRemote(this, false).catch(() => {});
    this.abortPrompts();
    clearTimeout(this.interruptTimer);
    clearTimeout(this.commandTimer);
    clearTimeout(this.idleTimer);
    this.queue = [];
    if (this.provider.sessions.get(this.threadId) === this) this.provider.sessions.delete(this.threadId);
    if (this.loaded) {
      const rpc = await this.provider.client().catch(() => null);
      await rpc?.request('thread/unsubscribe', { threadId: this.threadId }, 10_000).catch(() => {});
    }
    this.provider.sessionClosed();
    this.loaded = false;
  }

  // ── settings ──

  async setModel(_model: string) {
    // Applied as a turn/start override (which persists for later turns).
  }
  async setEffort(_effort: Effort) {}
  async setSpeed(_speed: string) {
    // Applied as a turn/start override, like the model.
  }
  async setMode(_mode: string) {
    this.policyDirty = true;
  }

  private effortFor(): string | undefined {
    const e = this.rt.meta.effort;
    if (!e) return undefined;
    const m = this.rt.caps?.models.find((x) => x.id === this.rt.meta.model);
    if (m?.efforts && !m.efforts.includes(e)) return undefined;
    return e;
  }

  /**
   * Fork at the end of the turn that holds `itemId`: the app-server copies the thread through
   * that turn into a new thread (this one is left as it is). Null when the turn is not known.
   */
  async fork(itemId: string): Promise<string | null> {
    const threadId = this.threadId ?? this.rt.meta.providerSessionId;
    const cut = cutAt(this.rt.items, itemId);
    const lastTurnId = cut && codexForkTurn(cut.kept);
    if (!threadId || !lastTurnId) return null;
    const rpc = await this.provider.client();
    const r = await rpc.request<{ thread?: { id?: string } }>('thread/fork', { threadId, lastTurnId, excludeTurns: true }, THREAD_TIMEOUT);
    return r.thread?.id ?? null;
  }

  async context(): Promise<ContextBreakdown | null> {
    const u = this.rt.meta.usage;
    if (!u.contextWindow || u.contextTokens === undefined) return null;
    const used = Math.min(u.contextTokens, u.contextWindow);
    return {
      totalTokens: used,
      maxTokens: u.contextWindow,
      percent: Math.round((used / u.contextWindow) * 100),
      model: this.rt.meta.model,
      categories: [
        { name: 'Conversation', tokens: used, kind: 'used' },
        { name: 'Free', tokens: u.contextWindow - used, kind: 'free' },
      ],
    };
  }

  async mcp(): Promise<McpServerInfo[]> {
    return this.provider.refreshMcp(this.loaded ? this.threadId : undefined);
  }

  updateMcp(list: McpServerInfo[]) {
    if (this.rt.caps && !this.closed) this.rt.setCaps({ ...this.rt.caps, mcpServers: list, features: { ...this.rt.caps.features, ...this.provider.optionalFeatures(list) } });
    this.showCuaState();
  }

  // ── capabilities: the Codex app's computer-use plugin, remote control ──

  /** Per-thread config: the plugin is on unless the user switched both browser and computer use off. */
  private threadConfig(): Record<string, unknown> | undefined {
    const o = this.rt.meta.options;
    if (!o || o.browser !== false || o.computerUse !== false) return undefined;
    const plugin = this.provider.computerUsePlugin() ?? CUA_PLUGIN;
    return { plugins: { [plugin]: { enabled: false } } };
  }

  private showCuaState() {
    const o = this.rt.meta.options ?? {};
    const has = !!this.provider.computerUsePlugin();
    const on = has && (o.browser !== false || o.computerUse !== false);
    const state = on ? { status: 'Runs through the Codex app, which must be open', tone: 'ok' as const } : undefined;
    const next = state ? { browser: state, computerUse: state } : undefined;
    if (JSON.stringify(this.rt.meta.capState) !== JSON.stringify(next)) this.rt.update({ capState: next });
  }

  setRemoteState(state: SessionMeta['remote']) {
    if (JSON.stringify(this.rt.meta.remote) !== JSON.stringify(state)) this.rt.update({ remote: state });
  }

  async setOptions(options: SessionOptions) {
    const before = this.appliedConfig;
    if (JSON.stringify(this.threadConfig() ?? null) !== before) {
      // Thread config applies when the thread is (re)loaded; never mid-turn.
      this.optionsDirty = true;
      if (!this.rt.turnActive) await this.reloadForOptions();
    }
    this.showCuaState();
    await this.provider.setRemote(this, !!options.remoteControl);
  }

  /** Unloads the thread so the next resume carries the new config. */
  private async reloadForOptions() {
    if (!this.optionsDirty || !this.loaded) return;
    this.optionsDirty = false;
    const rpc = await this.provider.client().catch(() => null);
    await rpc?.request('thread/unsubscribe', { threadId: this.threadId }, 10_000).catch(() => {});
    this.loaded = false;
  }

  // ── sending ──

  async send(item: UserItem) {
    if (!existsSync(this.rt.meta.cwd)) throw new Error(`The folder ${this.rt.meta.cwd} does not exist.`);
    const cmd = item.text.trim().match(/^\/(compact|review)(?:\s+([\s\S]*))?$/);
    if (cmd) return this.runCommand(item, cmd[1] as 'compact' | 'review', cmd[2]?.trim());
    const input = buildInput(item.text, item.attachments, this.rt.caps?.skills ?? []);
    if (this.rt.turnActive) return this.steerOrQueue(item, input);
    await this.startTurn([item], input);
  }

  private async startTurn(items: UserItem[], input: UserInput[]) {
    const rt = this.rt;
    rt.beginTurn('Thinking');
    // Queued messages move down to where the agent picks them up (steered ones stay where they were sent).
    for (const it of items) if (it.state === 'queued') rt.taken(it.id);
    this.resetTurnState();
    // This turn's generation, before the first await: a Stop (or anything that ends or replaces the
    // turn) while the thread reloads changes it, and then nothing is sent.
    const gen = this.gen;
    if (this.optionsDirty) await this.reloadForOptions();
    await this.ensureLoaded();
    if (!this.dispatchable(gen)) return;
    const params: TurnStartParams = { threadId: this.threadId, input };
    if (rt.meta.model) params.model = rt.meta.model;
    const effort = this.effortFor();
    if (effort) params.effort = effort;
    // The speed as a service tier (it persists for later turns); null asks for standard. Unchosen leaves Codex's own.
    const tier = serviceTierFor(rt.caps?.models.find((x) => x.id === rt.meta.model), rt.meta.speed);
    if (tier !== undefined) params.serviceTier = tier;
    if (this.policyDirty) {
      const p = preset(rt.meta.mode);
      params.approvalPolicy = p.approval;
      params.sandboxPolicy = sandboxPolicy(p.sandbox);
    }
    const started = (this.turnStarting = (async () => {
      const rpc = await this.provider.client();
      // Checked again right before dispatch (client() may have waited for a new app-server).
      if (!this.dispatchable(gen)) return;
      const r = await rpc.request<{ turn: Turn }>('turn/start', params, 60_000);
      // The turn may have ended already (its turn/completed came first): its id is no running turn's.
      if (this.gen === gen && r.turn?.id && !this.doneTurns.includes(r.turn.id)) this.turnId ??= r.turn.id;
      // Its generation ended here while the start was out: the turn is over to us, and its late news (an end, an error) belongs to nobody running.
      else if (this.gen !== gen && r.turn?.id) this.endedTurn(r.turn.id);
      this.policyDirty = false;
    })());
    try {
      await started;
    } finally {
      if (this.turnStarting === started) this.turnStarting = undefined;
      // The thread went idle while the start was out, after this turn showed itself: its end is looked at now.
      if (this.idleSeen && this.gen === gen && rt.turnActive && !this.turnStarting) this.armIdleEnd();
    }
  }

  /**
   * Whether the turn of generation `gen` (captured when it began, before any await) may still go to
   * Codex: the session open, the turn still the running one, and no stop asked for it. A stop that
   * came while the thread reloaded has ended the turn here already; one that came while the start
   * was about to go is ended by interrupt() once the start returns without a turn id.
   */
  private dispatchable(gen: number): boolean {
    return !this.closed && this.rt.turnActive && this.gen === gen && !this.interrupting && !this.rt.stopRequested;
  }

  private resetTurnState() {
    this.gen++;
    this.sawActive = false;
    this.idleSeen = false;
    this.interrupting = false;
    clearTimeout(this.idleTimer);
    this.turnId = undefined;
    this.turnErrors.clear();
    this.compactSeen = false;
    this.turnTokens = { input: 0, output: 0 };
    this.reasoningSource.clear();
  }

  private async steerOrQueue(item: UserItem, input: UserInput[]) {
    if (this.turnStarting) await this.turnStarting.catch(() => {});
    // A turn the user is stopping drops input steered into it: the message waits instead (the bridge
    // hands it back to the queue when the turn ends).
    if (this.turnId && this.rt.turnActive && this.loaded && !this.rt.stopRequested) {
      try {
        const rpc = await this.provider.client();
        await rpc.request('turn/steer', { threadId: this.threadId, input, expectedTurnId: this.turnId }, 30_000);
        this.rt.patch<UserItem>(item.id, { state: 'sent' });
        return;
      } catch (err) {
        this.log('turn/steer failed; queueing', errMsg(err));
      }
    }
    // The bridge took it back in the meantime (the turn ended first): it goes out from the queue.
    if (this.takenBack(item)) return;
    if (!this.rt.turnActive) return this.startTurn([item], input);
    this.queue.push({ item, input });
  }

  /** A message that waited in the timeline and is gone from it: the bridge put it back in its queue (or it was deleted). */
  private takenBack(item: UserItem) {
    return item.state === 'queued' && !this.rt.get(item.id);
  }

  private drainQueue() {
    if (!this.queue.length || this.rt.turnActive || this.closed) return;
    // Messages the bridge took back (the turn was stopped or failed before they were taken) go out from its queue, not twice.
    const q = this.queue.splice(0).filter((x) => !this.takenBack(x.item));
    if (!q.length) return;
    void this.startTurn(
      q.map((x) => x.item),
      q.flatMap((x) => x.input),
    ).catch((err) => {
      this.rt.notice('error', 'Could not send the queued message', errMsg(err));
      if (this.rt.turnActive) this.completeTurn({ status: 'failed', error: errMsg(err) });
    });
  }

  private async runCommand(item: UserItem, name: 'compact' | 'review', args?: string) {
    const rt = this.rt;
    if (rt.turnActive) {
      rt.patch<UserItem>(item.id, { state: 'sent' });
      rt.notice('info', `/${name} can only run while Codex is idle`);
      return;
    }
    rt.beginTurn(name === 'compact' ? 'Compacting context' : 'Reviewing');
    this.resetTurnState();
    // As for a message: the command's generation before the first await, checked right before it goes.
    const gen = this.gen;
    if (this.optionsDirty) await this.reloadForOptions();
    await this.ensureLoaded();
    const rpc = await this.provider.client();
    if (!this.dispatchable(gen)) return;
    if (name === 'compact') {
      await rpc.request('thread/compact/start', { threadId: this.threadId }, 60_000);
    } else {
      const target: ReviewTarget = args ? { type: 'custom', instructions: args } : { type: 'uncommittedChanges' };
      const r = await rpc.request<{ turn: Turn }>('review/start', { threadId: this.threadId, target, delivery: 'inline' }, 60_000);
      this.turnId ??= r.turn?.id;
    }
    // Safety net: if the server never reports a turn for this command, don't stay "running".
    clearTimeout(this.commandTimer);
    if (!rt.turnActive || this.turnId) return;
    this.commandTimer = setTimeout(() => {
      if (rt.turnActive && !this.turnId) this.completeTurn({ status: 'completed' });
    }, 15_000);
  }

  async interrupt() {
    const rt = this.rt;
    if (!rt.turnActive) return;
    this.interrupting = true;
    if (this.turnStarting) await this.turnStarting.catch(() => {});
    if (!this.turnId || !this.loaded) {
      this.completeTurn({ status: 'interrupted' });
      return;
    }
    const turnId = this.turnId;
    try {
      const rpc = await this.provider.client();
      await rpc.request('turn/interrupt', { threadId: this.threadId, turnId }, 15_000);
    } catch (err) {
      this.log('turn/interrupt failed', errMsg(err));
    }
    clearTimeout(this.interruptTimer);
    // turn/completed (status "interrupted") often lands before the request returns; then
    // a safety net armed now would end the user's next turn.
    if (!rt.turnActive || this.turnId !== turnId) return;
    // turn/completed normally follows; don't hang if it doesn't.
    this.interruptTimer = setTimeout(() => {
      if (rt.turnActive && this.turnId === turnId) this.completeTurn({ status: 'interrupted' });
    }, 8_000);
  }

  /**
   * Closes the running turn: settles items, adds the TurnItem, ends the turn, drains the queue.
   * `hold`: how it ended is not known (the thread went idle and neither its end nor the thread said
   * more): it ends, but nothing queued goes out by itself.
   */
  private completeTurn(t: { status: Turn['status']; error?: string; durationMs?: number | null; hold?: boolean; id?: string }) {
    const rt = this.rt;
    clearTimeout(this.interruptTimer);
    clearTimeout(this.commandTimer);
    clearTimeout(this.idleTimer);
    if (!rt.turnActive) return;
    const ended = t.id ?? this.turnId;
    if (ended) this.endedTurn(ended);
    this.abortPrompts();
    if (t.status === 'interrupted') {
      rt.settle('cancelled');
      rt.notice('interrupted', 'Interrupted');
    } else {
      rt.settle(t.status === 'failed' ? 'error' : 'cancelled');
    }
    const error = t.status === 'failed' ? (t.error ?? this.errorOf(ended) ?? 'Turn failed') : undefined;
    const inTok = this.turnTokens.input;
    const outTok = this.turnTokens.output;
    rt.add<TurnItem>({
      type: 'turn',
      durationMs: t.durationMs ?? (rt.turnStartedAt ? Date.now() - rt.turnStartedAt : 0),
      inputTokens: inTok > 0 ? inTok : undefined,
      outputTokens: outTok > 0 ? outTok : undefined,
      stopReason: t.status,
      error,
    });
    rt.update({ usage: { ...rt.meta.usage, turns: rt.meta.usage.turns + 1 } });
    this.turnId = undefined;
    this.gen++;
    rt.endTurn(error, t.hold ? { hold: true } : undefined);
    if (!t.hold) this.drainQueue();
  }

  /** Remembers a turn that ended (a few, newest last). */
  private endedTurn(id: string) {
    if (this.doneTurns.includes(id)) return;
    this.doneTurns.push(id);
    if (this.doneTurns.length > 16) this.doneTurns.shift();
  }

  /** The error that ended turn `turnId`: one naming it, or one naming no turn while this turn ran. */
  private errorOf(turnId: string | undefined): string | undefined {
    return (turnId ? this.turnErrors.get(turnId) : undefined) ?? this.turnErrors.get('');
  }

  /**
   * The thread is idle with this turn open: its own end gets a moment (it normally lands with the
   * idle), then it is ended from what is known. `attempt`: rechecks of a stale answer made so far.
   */
  private armIdleEnd(wait = THREAD_IDLE_GRACE_MS, attempt = 0) {
    clearTimeout(this.idleTimer);
    const gen = this.gen;
    const turnId = this.turnId;
    const seen = this.statusSeen;
    if (!turnId) return;
    this.idleTimer = setTimeout(() => void this.idleEnd(gen, turnId, seen, attempt).catch((err) => this.log('idle end failed', errMsg(err))), wait);
  }

  /**
   * Ends a turn whose turn/completed never came, with what is known: an error that ended it, a stop
   * asked for, else the outcome the thread has stored for it. When even that is not known it ends
   * without anything queued going out (`hold`). `seen`: the thread's news when the idle was armed;
   * anything newer (the thread active again, another idle) makes this probe moot, whatever it answers.
   * A stored "still running" while the thread stays idle is asked again a few times (IDLE_RECHECK_MS),
   * then the turn ends held.
   */
  private async idleEnd(gen: number, turnId: string, seen: number, attempt: number) {
    const rt = this.rt;
    const current = () => rt.turnActive && this.gen === gen && this.turnId === turnId && !this.turnStarting && !this.closed && this.statusSeen === seen;
    if (!current()) return;
    const failed = this.errorOf(turnId);
    if (failed) return this.completeTurn({ status: 'failed', error: failed });
    if (this.interrupting || rt.stopRequested) return this.completeTurn({ status: 'interrupted' });
    let stored: Turn | undefined;
    // Asked of the app-server that runs the thread (never one started for this).
    if (this.loaded && this.provider.sessions.get(this.threadId) === this) {
      try {
        const rpc = await this.provider.client();
        const r = await rpc.request<{ data?: Turn[] }>('thread/turns/list', { threadId: this.threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }, 10_000);
        stored = r?.data?.find((x) => x?.id === turnId);
      } catch (err) {
        this.log('thread/turns/list failed; the turn ends without its outcome', errMsg(err));
      }
    }
    if (!current()) return;
    // Known by now (an error or a stop came while the thread was asked).
    const late = this.errorOf(turnId);
    if (late) return this.completeTurn({ status: 'failed', error: late });
    if (this.interrupting || rt.stopRequested) return this.completeTurn({ status: 'interrupted' });
    if (stored?.status === 'inProgress') {
      // Still running by the store while the thread says idle: its end (or newer news) normally
      // comes; else it is asked again, a few times, and then ends held.
      const wait = this.idleRecheckMs[attempt];
      if (wait !== undefined) return this.armIdleEnd(wait, attempt + 1);
      this.log('the thread stays idle while its store says turn', turnId, 'runs; it ends without its outcome');
      return this.completeTurn({ status: 'completed', hold: true });
    }
    if (stored?.status) return this.completeTurn({ status: stored.status, error: stored.error?.message, durationMs: stored.durationMs });
    this.completeTurn({ status: 'completed', hold: true });
  }

  // ── notifications ──

  onNotification(method: string, p: any) {
    if (this.closed) return;
    const rt = this.rt;
    switch (method) {
      case 'turn/started': {
        const turn = (p as TurnNotification).turn;
        // Late news of a turn that ended already.
        if (turn?.id && this.doneTurns.includes(turn.id)) return;
        if (!rt.turnActive) {
          rt.beginTurn('Thinking');
          this.resetTurnState();
        }
        if (turn?.id) this.turnId = turn.id;
        this.sawActive = true;
        this.idleSeen = false;
        // Newer news than any idle probe out now.
        this.statusSeen++;
        return;
      }
      case 'turn/completed': {
        const turn = (p as TurnNotification).turn;
        // A turn that ended already (late, or ended from an idle): never the running turn's end, also while
        // the next turn is still starting and has no id yet.
        if (turn?.id && this.doneTurns.includes(turn.id)) return;
        if (this.turnId && turn?.id && turn.id !== this.turnId) return; // another turn's
        return this.completeTurn({ status: turn?.status ?? 'completed', error: turn?.error?.message, durationMs: turn?.durationMs, id: turn?.id });
      }
      case 'thread/status/changed': {
        // The thread's own word that nothing runs: a turn whose turn/completed never came (or was
        // dropped as another turn's) must not keep the chat busy. turn/completed normally lands with
        // it and carries the real outcome, so it gets a moment first. Any newer status makes an idle
        // probe already out moot (statusSeen): the thread active again must not have its turn closed.
        clearTimeout(this.idleTimer);
        this.statusSeen++;
        const type = p?.status?.type;
        if (type === 'active') {
          this.sawActive = true;
          this.idleSeen = false;
          return;
        }
        if (type !== 'idle' || !rt.turnActive) return;
        if (this.turnStarting) {
          // turn/start is still out. An idle after this turn showed itself is its end (a fast turn):
          // looked at once the start returns. One before is the thread's state from before it began.
          if (this.sawActive) this.idleSeen = true;
          return;
        }
        this.armIdleEnd();
        return;
      }
      case 'item/started':
        return this.onItem(p as ItemNotification, false);
      case 'item/completed':
        return this.onItem(p as ItemNotification, true);
      case 'item/agentMessage/delta':
        return this.onTextDelta(p as ItemDeltaNotification, 'text');
      case 'item/reasoning/summaryTextDelta':
        return this.onReasoningDelta(p as ItemDeltaNotification, 'summary');
      case 'item/reasoning/textDelta':
        return this.onReasoningDelta(p as ItemDeltaNotification, 'content');
      case 'item/reasoning/summaryPartAdded': {
        const id = `${p.turnId}:${p.itemId}`;
        const it = rt.get<ThinkingItem>(id);
        if (it?.text && this.reasoningSource.get(id) !== 'content') rt.delta(id, 'text', '\n\n');
        return;
      }
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta': {
        const d = p as ItemDeltaNotification;
        return rt.delta(`${d.turnId}:${d.itemId}`, 'output', d.delta);
      }
      case 'item/fileChange/patchUpdated': {
        const d = p as FileChangePatchUpdatedNotification;
        const id = `${d.turnId}:${d.itemId}`;
        const it = rt.get<ToolItem>(id);
        if (it?.type === 'tool') rt.patch<ToolItem>(id, { detail: { ...it.detail, path: d.changes?.[0]?.path ?? it.detail.path }, result: { ...it.result, diff: changesToDiffs(d.changes) } });
        return;
      }
      case 'turn/plan/updated':
        return rt.setTodos(mapPlan(p as TurnPlanUpdatedNotification));
      case 'thread/tokenUsage/updated': {
        const u = (p as ThreadTokenUsageUpdatedNotification).tokenUsage;
        if (!u?.total) return;
        if (rt.turnActive) {
          // Per-turn counts: delta of the thread total; on the first update after a resume
          // there is no baseline, so use the last request's usage.
          const prev = this.lastTotal;
          this.turnTokens.input += Math.max(0, prev ? u.total.inputTokens - prev.inputTokens : (u.last?.inputTokens ?? 0));
          this.turnTokens.output += Math.max(0, prev ? u.total.outputTokens - prev.outputTokens : (u.last?.outputTokens ?? 0));
        }
        this.lastTotal = u.total;
        rt.update({
          usage: {
            ...rt.meta.usage,
            inputTokens: u.total.inputTokens,
            outputTokens: u.total.outputTokens,
            cacheReadTokens: u.total.cachedInputTokens,
            contextTokens: u.last?.totalTokens ?? rt.meta.usage.contextTokens,
            contextWindow: u.modelContextWindow ?? rt.meta.usage.contextWindow,
          },
        });
        return;
      }
      case 'thread/compacted':
        // Deprecated duplicate of the contextCompaction item.
        if (!this.compactSeen) {
          this.compactSeen = true;
          rt.notice('compact', 'Context compacted');
        }
        return;
      case 'error': {
        const e = p as ErrorNotification;
        const msg = e.error?.message ?? 'Codex error';
        // An error belongs to the turn it names: late news of a turn that ended already is never the
        // running turn's (nor shown in it), also while the next turn/start is out with no id yet.
        const tid = typeof e.turnId === 'string' ? e.turnId : '';
        if (tid && this.doneTurns.includes(tid)) {
          this.log('error of turn', tid, 'after it ended:', msg);
          return;
        }
        if (!e.willRetry) this.turnErrors.set(tid, msg);
        // Refused at a plan limit ("You've hit your usage limit…"): a limit notice the bridge can act on.
        const info = (e.error as { codexErrorInfo?: unknown } | undefined)?.codexErrorInfo;
        if (!e.willRetry && (info === 'usageLimitExceeded' || /usage limit/i.test(msg))) {
          const full = this.provider.fullWindow();
          rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: msg, detail: e.error?.additionalDetails ?? undefined, limit: { resetsAt: full?.resetsAt, window: full?.label } });
          return;
        }
        rt.notice(e.willRetry ? 'retry' : 'error', msg, e.error?.additionalDetails ?? undefined);
        return;
      }
      case 'warning': {
        // Codex's warnings about its own setup (unknown config.toml keys, sent again for every
        // thread) are not part of the conversation: once per app run, to the agent's status in
        // Settings › Agents. Only a warning about this thread's work stays in the timeline.
        const w = p as WarningNotification;
        if (isSetupWarning(w)) return void this.provider.noteWarning(w.message);
        const n = warningNotice(w.message, shownWarnings);
        if (n) rt.notice('info', n.text, n.detail);
        return;
      }
      case 'model/rerouted':
        return void rt.notice('model', `Switched to ${p.toModel}`, p.fromModel ? `Rerouted from ${p.fromModel}` : undefined);
      case 'serverRequest/resolved':
        this.prompts.get(String(p.requestId))?.abort();
        return;
      default:
        return; // unknown / uninteresting notifications are ignored
    }
  }

  private onItem(n: ItemNotification, completed: boolean) {
    const rt = this.rt;
    const item = n.item;
    if (!item || item.type === 'userMessage') return;
    const id = `${n.turnId}:${item.id}`;
    const existing = rt.get(id);
    if (item.type === 'contextCompaction' && completed) {
      if (this.compactSeen) return;
      this.compactSeen = true;
    }
    if (!completed) {
      const act = activityFor(item);
      if (act) rt.update({ activity: act });
      const d = draftItem(item, { streaming: true });
      if (!d) return;
      if (!existing) {
        if (d.type === 'tool' && d.kind === 'bash' && (d as ToolItem).output === undefined) (d as ToolItem).output = '';
        rt.add({ ...d, id, ts: item.startedAtMs ?? Date.now() } as TimelineItem);
      } else if (d.type === 'tool' && existing.type === 'tool') {
        // Created early by an approval request: fill in details, keep the awaiting state.
        const { status, output, ...rest } = d as ToolItem;
        rt.patch<ToolItem>(id, existing.status === 'awaiting' ? rest : { ...rest, status });
      }
      return;
    }
    const d = draftItem(item, { streaming: false });
    if (!d) return;
    // An empty reply (Codex often ends a turn with one right after a widget): nothing to show.
    if (d.type === 'text' && !d.text.trim() && !(existing as TextItem | undefined)?.text?.trim()) {
      if (existing) rt.remove(id);
      return;
    }
    if (!existing) {
      if (d.type === 'thinking' && !d.text) return;
      rt.add({ ...d, id, ts: item.startedAtMs ?? Date.now() } as TimelineItem);
    } else {
      if (d.type === 'thinking' && !d.text && !(existing as ThinkingItem).text) return rt.remove(id);
      const patch = { ...d } as Record<string, unknown>;
      delete patch.type;
      delete patch.ts;
      if ((d.type === 'text' || d.type === 'thinking') && !d.text) delete patch.text;
      if (d.type === 'tool' && patch.output === undefined) delete patch.output;
      rt.patch(id, patch as Partial<TimelineItem>);
    }
    if (rt.turnActive && d.type === 'tool') rt.update({ activity: 'Thinking' });
  }

  private onTextDelta(d: ItemDeltaNotification, _field: 'text') {
    const id = `${d.turnId}:${d.itemId}`;
    if (!this.rt.get(id)) this.rt.add<TextItem>({ id, type: 'text', text: '', streaming: true });
    this.rt.delta(id, 'text', d.delta);
  }

  private onReasoningDelta(d: ItemDeltaNotification, source: 'summary' | 'content') {
    const id = `${d.turnId}:${d.itemId}`;
    const current = this.reasoningSource.get(id);
    if (current && current !== source) return; // summary and raw content both stream; show one
    this.reasoningSource.set(id, source);
    if (!this.rt.get(id)) this.rt.add<ThinkingItem>({ id, type: 'thinking', text: '', streaming: true });
    this.rt.delta(id, 'text', d.delta);
  }

  // ── server requests (approvals & questions) ──

  async onRequest(method: string, p: any, reqId: RequestId): Promise<unknown> {
    const ac = new AbortController();
    const key = String(reqId);
    this.prompts.set(key, ac);
    try {
      switch (method) {
        case 'item/commandExecution/requestApproval':
          return await this.approveCommand(p as CommandExecutionRequestApprovalParams, ac.signal);
        case 'item/fileChange/requestApproval':
          return await this.approveFileChange(p as FileChangeRequestApprovalParams, ac.signal);
        case 'item/permissions/requestApproval':
          return await this.approvePermissions(p as PermissionsRequestApprovalParams, ac.signal);
        case 'item/tool/requestUserInput':
          return await this.askUser(p as ToolRequestUserInputParams, ac.signal);
        case 'item/tool/call': {
          // The Browser tab tools ask the session's window (and the user, for pages that are not local).
          const op = browserOp(typeof p?.tool === 'string' ? p.tool : undefined);
          if (op) return await browserDynamicAnswer(this.rt, op, p?.arguments, ac.signal);
          // The Android device tools run in the bridge (and ask before touching a real phone).
          const dop = deviceOp(typeof p?.tool === 'string' ? p.tool : undefined);
          if (dop) return await deviceDynamicAnswer(this.rt, dop, p?.arguments, ac.signal);
          // A fact for the user's profile: Sable merges it (and refuses secrets).
          if (isProfileTool(typeof p?.tool === 'string' ? p.tool : undefined)) return profileDynamicAnswer(this.provider.rememberAboutUser(p?.arguments));
          // A sub-agent from the other agent (Claude Code): it runs nested under this call's step.
          const agent = agentOfTool(typeof p?.tool === 'string' ? p.tool : undefined);
          if (agent) return await this.runDelegate(agent, p?.arguments, ac.signal);
          // Client-defined tools (show_widget): the timeline already shows the call as the widget.
          return dynamicToolAnswer(p);
        }
        case 'execCommandApproval':
          return await this.legacyExec(p as ExecCommandApprovalParams, ac.signal);
        case 'applyPatchApproval':
          return await this.legacyPatch(p as ApplyPatchApprovalParams, ac.signal);
        case 'mcpServer/elicitation/request':
          this.rt.notice('info', `MCP server "${p.serverName}" asked for input`, `${p.message ?? ''}\nSable cannot answer MCP elicitations yet; it was declined.`.trim());
          return { action: 'decline', content: null, _meta: null };
        default:
          throw new RpcError(`Sable does not support ${method}`, -32601);
      }
    } finally {
      this.prompts.delete(key);
    }
  }

  /** Ensures a ToolItem exists for the approval and marks it awaiting. */
  private gate(id: string, fallback: Omit<ToolItem, 'id' | 'ts' | 'type' | 'status'>): ToolItem {
    const existing = this.rt.get<ToolItem>(id);
    if (existing?.type === 'tool') {
      this.rt.patch<ToolItem>(id, { status: 'awaiting' });
      return existing;
    }
    return this.rt.add<ToolItem>({ ...fallback, id, type: 'tool', status: 'awaiting' });
  }

  private afterDecision(id: string, allowed: boolean) {
    const it = this.rt.get<ToolItem>(id);
    if (it?.type === 'tool' && it.status === 'awaiting') {
      this.rt.patch<ToolItem>(id, allowed ? { status: 'running' } : { status: 'denied', endedAt: Date.now() });
    }
    if (this.rt.turnActive) this.rt.update({ activity: allowed ? (it ? firstLine(`Running ${it.title}`, 70) : 'Working') : 'Thinking' });
  }

  private claimedSteps = new Set<string>();

  /** Runs a sub-agent of `agent` for this session under the call's step; its final answer is the tool's result. */
  private async runDelegate(agent: ProviderId, args: unknown, signal: AbortSignal) {
    const answer = (text: string, ok: boolean) => ({ contentItems: [{ type: 'inputText' as const, text }], success: ok });
    const call = readAgentCall(agent, args);
    if (!call) return answer('The task is empty: say what the sub-agent should do in `prompt`.', false);
    const run = this.provider.ctx.runAgent;
    if (!run) return answer('Sub-agents are not available here.', false);
    const mine = (it: ToolItem) => agentOfTool(it.name) === agent;
    // The call's step usually exists already; give it a moment when the request came first.
    let step = claimStep(this.rt, mine, this.claimedSteps);
    if (!step) {
      await new Promise((r) => setTimeout(r, 250));
      step = claimStep(this.rt, mine, this.claimedSteps);
    }
    const r = await run(this.rt, call, step, signal);
    return answer(r.text, r.ok);
  }

  private async approveCommand(p: CommandExecutionRequestApprovalParams, signal: AbortSignal) {
    const id = `${p.turnId}:${p.itemId}`;
    const raw = p.command ?? '';
    const command = unwrapCommand(raw);
    const stdin = p.kind === 'writeStdin';
    const item = this.gate(id, {
      name: 'shell',
      kind: 'bash',
      title: stdin ? 'Send input to a running command' : commandTitle(raw, p.commandActions),
      detail: { command, cwd: p.cwd ?? undefined },
      input: { command: raw, cwd: p.cwd },
      output: '',
    });
    this.rt.update({ activity: 'Waiting for approval' });
    const amend = p.proposedExecpolicyAmendment?.length ? p.proposedExecpolicyAmendment : null;
    const options: PermissionOption[] = [
      { id: 'accept', label: 'Allow once', tone: 'allow' },
      { id: 'acceptForSession', label: 'Allow for this session', tone: 'always' },
    ];
    if (amend) options.push({ id: 'amend', label: `Always allow “${amend.join(' ')}”`, hint: 'Saves a rule; matching commands run without asking', tone: 'always' });
    options.push({ id: 'decline', label: 'Decline', hint: 'Codex continues without running it', tone: 'deny' }, { id: 'cancel', label: 'Decline and stop', hint: 'Ends the turn', tone: 'deny' });
    const reason = p.reason ?? (p.networkApprovalContext ? `Network access to ${p.networkApprovalContext.host}` : undefined);
    const answer = await this.rt.requestPermission(
      {
        itemId: id,
        toolName: 'shell',
        kind: 'bash',
        title: stdin ? 'Send input to a running command?' : 'Run this command?',
        description: item.title,
        detail: { command: command || (item.detail.command ?? ''), cwd: p.cwd ?? item.detail.cwd },
        reason,
        options,
        allowFeedback: false,
      },
      signal,
    );
    let decision: CommandExecutionApprovalDecision;
    switch (answer?.optionId) {
      case 'accept':
        decision = 'accept';
        break;
      case 'acceptForSession':
        decision = 'acceptForSession';
        break;
      case 'amend':
        decision = amend ? { acceptWithExecpolicyAmendment: { execpolicy_amendment: amend } } : 'accept';
        break;
      case 'decline':
        decision = 'decline';
        break;
      default:
        decision = 'cancel';
    }
    this.afterDecision(id, decision !== 'decline' && decision !== 'cancel');
    return { decision };
  }

  private async approveFileChange(p: FileChangeRequestApprovalParams, signal: AbortSignal) {
    const id = `${p.turnId}:${p.itemId}`;
    const item = this.gate(id, { name: 'apply_patch', kind: 'edit', title: 'Edit files', detail: {} });
    this.rt.update({ activity: 'Waiting for approval' });
    const answer = await this.rt.requestPermission(
      {
        itemId: id,
        toolName: 'apply_patch',
        kind: item.kind,
        title: `${item.title}?`,
        description: item.detail.path,
        detail: item.detail,
        diff: item.result?.diff,
        reason: p.reason ?? (p.grantRoot ? `Allow writes under ${p.grantRoot} for this session` : undefined),
        options: [
          { id: 'accept', label: 'Allow once', tone: 'allow' },
          { id: 'acceptForSession', label: 'Allow edits for this session', tone: 'always' },
          { id: 'decline', label: 'Decline', hint: 'Codex continues without this change', tone: 'deny' },
          { id: 'cancel', label: 'Decline and stop', hint: 'Ends the turn', tone: 'deny' },
        ],
        allowFeedback: false,
      },
      signal,
    );
    const map: Record<string, FileChangeApprovalDecision> = { accept: 'accept', acceptForSession: 'acceptForSession', decline: 'decline' };
    const decision: FileChangeApprovalDecision = (answer && map[answer.optionId]) || 'cancel';
    this.afterDecision(id, decision === 'accept' || decision === 'acceptForSession');
    return { decision };
  }

  private async approvePermissions(p: PermissionsRequestApprovalParams, signal: AbortSignal): Promise<PermissionsRequestApprovalResponse> {
    const wants: string[] = [];
    if (p.permissions?.network?.enabled) wants.push('Network access');
    if (p.permissions?.fileSystem?.write?.length) wants.push(`Write: ${p.permissions.fileSystem.write.join(', ')}`);
    if (p.permissions?.fileSystem?.read?.length) wants.push(`Read: ${p.permissions.fileSystem.read.join(', ')}`);
    this.rt.update({ activity: 'Waiting for approval' });
    const answer = await this.rt.requestPermission(
      {
        toolName: 'permissions',
        kind: 'other',
        title: 'Grant additional permissions?',
        description: wants.join('\n') || 'Codex asked for more sandbox access',
        detail: { cwd: p.cwd },
        reason: p.reason ?? undefined,
        options: [
          { id: 'turn', label: 'Allow for this turn', tone: 'allow' },
          { id: 'session', label: 'Allow for this session', tone: 'always' },
          { id: 'deny', label: 'Decline', tone: 'deny' },
        ],
        allowFeedback: false,
      },
      signal,
    );
    if (this.rt.turnActive) this.rt.update({ activity: 'Thinking' });
    if (answer?.optionId === 'turn' || answer?.optionId === 'session') {
      const granted: PermissionsRequestApprovalResponse['permissions'] = {};
      if (p.permissions?.network) granted.network = p.permissions.network;
      if (p.permissions?.fileSystem) granted.fileSystem = p.permissions.fileSystem;
      return { permissions: granted, scope: answer.optionId };
    }
    return { permissions: {}, scope: 'turn' };
  }

  private async askUser(p: ToolRequestUserInputParams, signal: AbortSignal): Promise<ToolRequestUserInputResponse> {
    const questions: Question[] = (p.questions ?? []).map((q) => ({
      question: q.question,
      header: q.header || undefined,
      multiSelect: false,
      options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description || undefined })),
    }));
    const answers = await this.rt.ask(questions, `${p.turnId}:${p.itemId}`, signal);
    const out: ToolRequestUserInputResponse = { answers: {} };
    for (const q of p.questions ?? []) out.answers[q.id] = { answers: answers?.[q.question] ?? answers?.[q.id] ?? [] };
    return out;
  }

  private async legacyExec(p: ExecCommandApprovalParams, signal: AbortSignal): Promise<{ decision: ReviewDecision }> {
    const command = (p.command ?? []).join(' ');
    const answer = await this.rt.requestPermission(
      {
        toolName: 'shell',
        kind: 'bash',
        title: 'Run this command?',
        description: unwrapCommand(command),
        detail: { command: unwrapCommand(command), cwd: p.cwd },
        reason: p.reason ?? undefined,
        options: [
          { id: 'approved', label: 'Allow once', tone: 'allow' },
          { id: 'approved_for_session', label: 'Allow for this session', tone: 'always' },
          { id: 'denied', label: 'Decline', tone: 'deny' },
        ],
        allowFeedback: true,
      },
      signal,
    );
    if (answer?.optionId === 'approved' || answer?.optionId === 'approved_for_session') return { decision: answer.optionId };
    if (answer?.optionId === 'denied') return { decision: { denied: { rejection: answer.message || 'The user declined this command.' } } };
    return { decision: 'abort' };
  }

  private async legacyPatch(p: ApplyPatchApprovalParams, signal: AbortSignal): Promise<{ decision: ReviewDecision }> {
    const files = Object.keys(p.fileChanges ?? {});
    const answer = await this.rt.requestPermission(
      {
        toolName: 'apply_patch',
        kind: 'edit',
        title: files.length === 1 ? `Edit ${path.basename(files[0])}?` : `Edit ${files.length} files?`,
        description: files.join('\n'),
        detail: { path: files[0] },
        reason: p.reason ?? undefined,
        options: [
          { id: 'approved', label: 'Allow once', tone: 'allow' },
          { id: 'approved_for_session', label: 'Allow for this session', tone: 'always' },
          { id: 'denied', label: 'Decline', tone: 'deny' },
        ],
        allowFeedback: true,
      },
      signal,
    );
    if (answer?.optionId === 'approved' || answer?.optionId === 'approved_for_session') return { decision: answer.optionId };
    if (answer?.optionId === 'denied') return { decision: { denied: { rejection: answer.message || 'The user declined this change.' } } };
    return { decision: 'abort' };
  }
}
