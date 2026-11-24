import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  query as sdkQuery,
  listSessions,
  getSessionMessages,
  forkSession,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  Attachment,
  Capabilities,
  CapabilityState,
  SessionMeta,
  SessionOptions,
  CommandInfo,
  ContextBreakdown,
  Effort,
  HistoryEntry,
  LimitsMeta,
  McpServerInfo,
  ModeInfo,
  ModelInfo,
  NoticeItem,
  PermissionOption,
  PermissionSave,
  PermissionScope,
  ProviderInfo,
  RateLimit,
  ResetOffer,
  SessionUsage,
  TextItem,
  ThinkingItem,
  TimelineItem,
  Todo,
  ToolItem,
  WorkflowRun,
  AgentStats,
  TurnItem,
  UserItem,
} from '../../shared/protocol';
import { lostLine, type BackgroundLimit, type LossTrigger, type LostWhy, type MessageOutcome, type SessionRuntime } from '../core/runtime';
import type { TitlePrompt } from '../core/titles';
import { dropRemote, holdRemote, idleSince, type RemoteHolder } from '../core/remote-keep';
import { claudeForkPoint, cutAt } from '../core/fork';
import { killTree, runCli, spawnCli } from '../util/proc';
import { agentLimitOf, appPictures, backgroundTaskOf, baseName, describeTool, flattenContent, mapResult, mergeWorkflow, normalizeTodos, peekPartialInput, plainWords, previewDiff, taskKindOf, wakeOf, workflowStart, type TaskKind } from './claude-tools';
import type { Provider, ProviderContext, ProviderSession, SendOptions, WarmChoice } from './types';
import { claudePlan } from './plans';
import { carryClaudeConversation } from '../accounts/handover';
import { CONCISE_REPLIES_PROMPT, STEER_FIRST_BLOCK } from '../../shared/protocol';
import { HANDOVER_JOIN, isAuthFailure, isCompactOutput, isStandIn, parseSynthetic, stripWrappers, syntheticLine } from '../../shared/synthetic';
import { widgetServer } from './claude-widget';
import { BROWSER_HINT, BROWSER_TOOL_IDS, browserTabEnabled, cleanToolInput, streamsInput } from './browser-tool';
import { DEVICE_HINT, DEVICE_TOOL_IDS, deviceEnabled } from './device-tool';
import { WIDGET_FENCE_HINT, WIDGET_SERVER, WIDGET_TOOL_ID, widgetsEnabled } from './widget-tool';
import { AGENT_TOOLS, agentOfTool, agentToolId, type AgentCall } from './agent-tool';
import { PROFILE_TOOL_ID } from './profile-tool';
import { claimStep } from '../core/sub-agent';
import { authFailurePending, authGate, gateKey, noteAuthFailure, refusedForSignIn } from '../core/auth-gate';
import { compactScope, WHERE, withScope } from '../core/permission-scope';

type Obj = Record<string, any>;

/**
 * Every Claude Code process Sable starts goes through its account's gate (server/core/auth-gate.ts):
 * starts of one config folder one at a time, and no process let go while it may be renewing the
 * sign-in. The options' own stderr callback still gets what the process writes there.
 */
const query: typeof sdkQuery = (p) => sdkQuery({ ...p, options: { ...p.options, spawnClaudeCodeProcess: p.options?.spawnClaudeCodeProcess ?? authGate.spawner(p.options?.stderr) } });

// All accounts use the same installed binary. Sessions opened before a named result learn it too.
const seenCli = { names: false };

const IDLE_CLOSE_MS = 8 * 60_000;
/**
 * A turn Claude Code began by itself is over once it has gone this quiet: no frame of its own work, no
 * step of it running, nothing of anyone's waiting. The bound for a CLI that never says it is idle, so
 * no such turn reads "Thinking" for ever.
 */
const WAKE_QUIET_MS = 90_000;
/** How long the CLI's own word that it works (`running`) is believed while nothing at all is heard from it. */
const CLI_TRUST_MS = 10 * 60_000;
/** A wake-up the agent scheduled holds its process when it is due within this (never longer: a guess must not keep a process for ever). */
const WAKE_HOLD_MS = 60 * 60_000;
/** A wake-up past its time is looked for this long, then taken as gone. */
const WAKE_GRACE_MS = 2 * 60_000;
/** How long `close()` waits for the process it let go to end. */
const EXIT_WAIT_MS = 3_000;
/** A background command gone from the CLI's live list with no word of its end is taken as stopped after this (its word comes first as a rule). */
const LIST_GRACE_MS = 3_000;
/** Frames about tasks and the CLI's state: no sign of the agent's own work at the root. */
const TASK_FRAMES = new Set(['task_started', 'task_progress', 'task_updated', 'task_notification', 'background_tasks_changed', 'session_state_changed']);
/** The live line of a turn whose messages wait for a stopped turn's result (`held`). */
const HELD_LINE = 'Waiting for the stopped turn to end';
/** Said by a session the bridge let go when it is asked to start its process again. */
const RETIRED = 'The agent was closed before the message reached it.';
/** How many of the messages it sent a session remembers as its own (`own`): far more than a turn's bookkeeping ever lets go of unread. */
const OWN_MAX = 500;
/**
 * A message of Sable's own that Claude Code takes after its turn's bookkeeping let it go begins a turn
 * of its own when it was sent this recently to the same process; older, it is only marked as Sable's
 * (a repeat, never new work).
 */
const OWN_LATE_MS = 30 * 60_000;
/**
 * A message of Sable's own that Claude Code has not read keeps its turn, but not for ever: once the
 * process has said nothing for this long and works on nothing, the message is not coming.
 */
const UNREAD_QUIET_MS = 60_000;
/** Pictures a message from the Claude app keeps: how many, the biggest one and all of them together (data URL lengths). */
const APP_PICTURES = { count: 4, each: 4 * 1024 * 1024, total: 8 * 1024 * 1024 };

const MODES: ModeInfo[] = [
  { id: 'default', name: 'Ask first', description: 'Asks before editing files or running commands', tone: 'ask' },
  { id: 'acceptEdits', name: 'Accept edits', description: 'Edits files freely, still asks before commands', tone: 'edit' },
  { id: 'plan', name: 'Plan', description: 'Explores and proposes a plan without changing anything', tone: 'plan' },
  { id: 'auto', name: 'Auto', description: 'A safety classifier approves routine actions for you', tone: 'auto' },
  { id: 'bypassPermissions', name: 'Bypass', description: 'Runs everything without asking. Use in sandboxes only', tone: 'danger' },
];

/** Fast mode, which Claude Code bills as extra usage (it is refused with `extra_usage_disabled` otherwise). */
const CLAUDE_FAST = { id: 'fast', name: 'Fast', note: 'Extra usage', paid: true };

const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'default', name: 'Default', description: 'Recommended model for your plan', isDefault: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'fable', name: 'Fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'opus', name: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'sonnet', name: 'Sonnet', efforts: ['low', 'medium', 'high'] },
  { id: 'haiku', name: 'Haiku' },
];

/** Minimal async queue: the SDK reads user messages from it for the life of the process. */
class PushQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(item: T) {
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  end() {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** The SDK's sign-in requests (on the query object, not in its public types). */
type AuthQuery = Query & {
  claudeAuthenticate(loginWithClaudeAi: boolean): Promise<{ manualUrl: string; automaticUrl: string }>;
  claudeOAuthCallback(authorizationCode: string, state: string): Promise<unknown>;
  claudeOAuthWaitForCompletion(): Promise<unknown>;
};

/** Opens a link in the default browser (no shell: the link's & and = stay as they are). */
function openInBrowser(url: string) {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args as string[], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* the link is in Sable too */
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const sdkEffort = (e?: Effort) => (e === 'minimal' ? 'low' : e);

/**
 * The Claude Code binary the SDK starts. The packaged desktop app ships its own copy and points
 * SABLE_CLAUDE_BIN at it (electron/main.ts); otherwise the SDK finds its platform package.
 * Read per call: the desktop shell sets it after this module has loaded.
 */
const claudeBinary = () => process.env.SABLE_CLAUDE_BIN || undefined;

/** The user's own CLAUDE_CONFIG_DIR (usually unset): what the built-in default account uses. */
const OWN_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;

/**
 * The command a person runs in a terminal for this account's reset dialog, where Sable cannot open a
 * console window: the resolved CLI and, for an account of its own, its config folder, each quoted for
 * the shell (review wave 8, #19). Without either it is the plain `claude "/limit-reset"`.
 */
export function resetLine(bin: string, configDir: string | undefined, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const q = (s: string) => (/^[\w.:\\-]+$/.test(s) ? s : `"${s}"`);
    return `${configDir ? `set "CLAUDE_CONFIG_DIR=${configDir}" && ` : ''}${q(bin)} "/limit-reset"`;
  }
  const q = (s: string) => (/^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  return `${configDir ? `CLAUDE_CONFIG_DIR=${q(configDir)} ` : ''}${q(bin)} "/limit-reset"`;
}

/** The turn a chat is in: its last message from the person (a refusal for the sign-in is kept under it). */
const turnOf = (rt: SessionRuntime): string | undefined => rt.items.findLast((i) => i.type === 'user' && !i.parentId)?.id;

/** Environment for a Claude Code process: the account's config folder, or the user's own setup. */
function claudeEnv(configDir: string | undefined): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const dir = configDir ?? OWN_CONFIG_DIR;
  if (dir) env.CLAUDE_CONFIG_DIR = dir;
  else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

let configLock: Promise<unknown> = Promise.resolve();

/**
 * The SDK's history readers (listSessions, getSessionMessages) take no config option and read
 * process.env.CLAUDE_CONFIG_DIR. Point it at the account for one call at a time, then restore it.
 * Agent processes get an explicit env, so they never see the temporary value.
 */
function withConfigDir<T>(configDir: string | undefined, fn: () => Promise<T>): Promise<T> {
  const run = configLock.then(async () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    const dir = configDir ?? OWN_CONFIG_DIR;
    if (dir) process.env.CLAUDE_CONFIG_DIR = dir;
    else delete process.env.CLAUDE_CONFIG_DIR;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
  configLock = run.catch(() => {});
  return run;
}

/** Tools a read-only agent (a turn check) never gets, whatever the user's allow rules say. */
const READ_ONLY_BLOCKED = ['Bash', 'BashOutput', 'KillShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'];

export class ClaudeProvider implements Provider {
  readonly id = 'claude' as const;
  readonly name = 'Claude Code';
  private infoCache?: { at: number; info: ProviderInfo };
  private capsCache = new Map<string, { at: number; caps: Capabilities }>();
  private capsInflight = new Map<string, Promise<Capabilities>>();
  /** Tool steps a sub-agent call has already nested under (see `claimStep`). */
  private claimedSteps = new Set<string>();
  private loginProc?: ChildProcess;
  /** The sign-in in progress, run through Claude Code's own SDK flow (see `login`). */
  private auth?: { q: AuthQuery; input: PushQueue<SDKUserMessage> };
  private limitsCache: RateLimit[] = [];
  /** Extra usage as last known: from the usage request, and whether turns run on it (rate_limit_event). */
  private extraCache?: NonNullable<LimitsMeta['extra']>;
  /** When limits were last read, the read in flight, and the last on-demand probe. */
  private limitsAt = 0;
  private limitsRun?: Promise<RateLimit[]>;
  private limitsProbeAt = 0;
  /** The usage endpoint refused: no unasked reads until then. */
  private limitsRefusedUntil = 0;
  private limitsRefusedLogged = false;
  readonly sessions = new Set<ClaudeSession>();
  /**
   * What this provider's CLI was seen to do in any session: name the messages a result answers. Every
   * session runs the same binary, so a chat's first result after Sable started is read with what the
   * others already showed (review of 23 Nov, D-own).
   */
  readonly seen = seenCli;
  /** The account's own config folder; undefined for the built-in default account. */
  private readonly configDir?: string;

  constructor(readonly ctx: ProviderContext) {
    this.configDir = ctx.account?.dir;
  }

  /** Environment for every CLI call and agent process of this account. */
  env(): NodeJS.ProcessEnv {
    return claudeEnv(this.configDir);
  }

  /**
   * Claude Code's own reset dialog: the binary the SDK runs (else `claude` on PATH) with the hidden
   * `/limit-reset` command as its initial prompt, which an interactive session runs as if typed, and
   * this account's config folder. Sable never runs it itself: only a console window the person sees.
   */
  limitResetCommand() {
    const bin = claudeBinary() ?? 'claude';
    return { bin, args: ['/limit-reset'], env: this.env(), line: resetLine(bin, this.configDir) };
  }

  /** Runs an SDK history read against this account's config folder. */
  withHistory<T>(fn: () => Promise<T>): Promise<T> {
    return withConfigDir(this.configDir, fn);
  }

  async info(force = false): Promise<ProviderInfo> {
    if (!force && this.infoCache && Date.now() - this.infoCache.at < 30_000) return this.infoCache.info;
    // The same binary the SDK runs (SABLE_CLAUDE_BIN, set by the desktop shell), so the check does
    // not depend on what PATH the app was started with.
    const bin = claudeBinary() ?? 'claude';
    // `auth status` may renew the sign-in: one at a time per account, never beside a start of it
    // (server/core/auth-gate.ts); both end inside the gate's lease for it (`auxLeaseMs`, 20 s).
    const [ver, [status, text]] = await Promise.all([
      runCli(bin, ['--version'], { timeoutMs: 12_000, env: this.env() }),
      authGate.run(gateKey('claude', this.configHome()), async () => {
        const json = await runCli(bin, ['auth', 'status', '--json'], { timeoutMs: 12_000, env: this.env() });
        // The CLI's own name for the plan ("Login method: Claude Max account"); JSON has only a raw id.
        return [json, await runCli(bin, ['auth', 'status', '--text'], { timeoutMs: 6_000, env: this.env() })] as const;
      }),
    ]);
    const info: ProviderInfo = { id: 'claude', name: this.name, installed: !ver.missing && ver.code === 0, auth: { loggedIn: false } };
    if (info.installed) info.version = ver.stdout.trim().split(/\s+/)[0];
    else info.problem = 'Claude Code CLI was not found on PATH';
    try {
      const s = JSON.parse(status.stdout.slice(status.stdout.indexOf('{')));
      const plan = s.loggedIn ? claudePlan(s, text.code === 0 ? text.stdout : undefined) : {};
      info.auth = {
        loggedIn: !!s.loggedIn,
        method: s.authMethod,
        email: s.email,
        plan: plan.plan,
        planId: plan.planId,
        org: s.orgName,
      };
    } catch {
      /* not logged in or old CLI */
    }
    this.infoCache = { at: Date.now(), info };
    return info;
  }

  /**
   * Signs in through Claude Code's SDK sign-in flow: it gives two links, one that returns to this
   * computer by itself (opened in the browser) and one whose page shows a code to paste. Either
   * finishes it: the browser's return, or the code pasted into Sable (`submitLoginCode`). Older
   * CLIs without the flow fall back to `claude auth login`.
   */
  async login(): Promise<void> {
    await this.cancelLogin();
    // SABLE_LOGIN=cli: the CLI's own `claude auth login` (the tests drive a fake CLI that way).
    if (process.env.SABLE_LOGIN === 'cli') return this.loginWithCli();
    const input = new PushQueue<SDKUserMessage>();
    const q = query({ prompt: input, options: { ...this.baseOptions(homedir()), settingSources: [], strictMcpConfig: true, persistSession: false } }) as AuthQuery;
    if (typeof q.claudeAuthenticate !== 'function') {
      input.end();
      q.close();
      return this.loginWithCli();
    }
    const auth = { q, input };
    this.auth = auth;
    try {
      const urls = await withTimeout(q.claudeAuthenticate(true), 30_000, 'Claude Code sign-in');
      this.ctx.emit({ type: 'auth.progress', provider: 'claude', state: 'url', url: urls.automaticUrl, codeUrl: urls.manualUrl });
      openInBrowser(urls.automaticUrl);
      await q.claudeOAuthWaitForCompletion();
    } finally {
      if (this.auth === auth) this.auth = undefined;
      input.end();
      try {
        q.close();
      } catch {
        /* already gone */
      }
      this.infoCache = undefined;
    }
  }

  async submitLoginCode(code: string): Promise<void> {
    const auth = this.auth;
    if (!auth) throw new Error('No sign-in is waiting for a code. Start it again.');
    const [authorizationCode, state] = code.trim().split('#');
    if (!authorizationCode || !state) throw new Error('That is not the whole code. Copy it again from the browser.');
    await auth.q.claudeOAuthCallback(authorizationCode, state);
  }

  private loginWithCli(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawnCli('claude', ['auth', 'login', '--claudeai'], { env: this.env() });
      this.loginProc = child;
      let out = '';
      let announced = false;
      const scan = (d: Buffer) => {
        out += d.toString();
        const url = out.match(/https:\/\/[^\s"'<>]+/);
        if (url && !announced) {
          announced = true;
          this.ctx.emit({ type: 'auth.progress', provider: 'claude', state: 'url', url: url[0] });
        }
      };
      child.stdout?.on('data', scan);
      child.stderr?.on('data', scan);
      child.on('error', (e) => reject(e));
      child.on('close', (code) => {
        if (this.loginProc === child) this.loginProc = undefined;
        this.infoCache = undefined;
        if (code === 0) resolve();
        else reject(new Error(out.trim().split('\n').pop() || 'Sign-in was not completed'));
      });
    });
  }

  async cancelLogin() {
    killTree(this.loginProc);
    this.loginProc = undefined;
    const auth = this.auth;
    this.auth = undefined;
    if (auth) {
      auth.input.end();
      try {
        auth.q.close();
      } catch {
        /* already gone */
      }
    }
  }

  async logout() {
    await runCli('claude', ['auth', 'logout'], { timeoutMs: 15_000, env: this.env() });
    this.infoCache = undefined;
  }

  baseOptions(cwd: string): Options {
    return {
      cwd,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      env: this.env(),
      stderr: () => {},
      pathToClaudeCodeExecutable: claudeBinary(),
    };
  }

  /** Options for a session's agent process. Permission prompts go to whichever session owns it. */
  /** Whether new agent processes get the short-answers instruction (Settings > General). */
  concise() {
    return this.ctx.settings?.().conciseReplies !== false;
  }

  /** Whether new agent processes get the show_widget tool (Settings > General > Generative UI). */
  widgets() {
    return widgetsEnabled(this.ctx.settings?.());
  }

  /**
   * What Sable appends to Claude Code's own prompt: the short-answers instruction and, with
   * generative UI on, one line that reminds the model the widget tool exists (a tool description
   * alone is rarely enough for a model to reach for an optional tool unprompted).
   */
  appendix(meta?: Pick<SessionMeta, 'options' | 'custom'>): string {
    return [this.concise() ? CONCISE_REPLIES_PROMPT : '', this.widgets() ? WIDGET_FENCE_HINT : '', meta && browserTabEnabled(meta) ? BROWSER_HINT : '', meta && deviceEnabled(meta) ? DEVICE_HINT : '', this.profileText(), this.customText(meta)].filter(Boolean).join('\n\n');
  }

  /** The Customize chat's brief: only for that chat (`SessionMeta.custom`). */
  customText(meta?: Pick<SessionMeta, 'custom'>): string {
    if (!meta?.custom) return '';
    try {
      return this.ctx.customBrief?.() ?? '';
    } catch (err) {
      this.ctx.log('claude: the Customize brief could not be made:', (err as Error).message);
      return '';
    }
  }

  /** Whether new agent processes get the user's profile and remember_about_user (Settings › Profile). */
  profileOn() {
    return !!this.ctx.profile?.().enabled();
  }

  /** The user's profile as it goes into the prompt, with the line about the tool (empty when off). */
  profileText() {
    try {
      return this.ctx.profile?.().prompt(true) ?? '';
    } catch (err) {
      this.ctx.log('claude: the profile could not be read:', (err as Error).message);
      return '';
    }
  }

  agentOptions(meta: Pick<SessionMeta, 'cwd' | 'model' | 'effort' | 'mode' | 'options' | 'providerSessionId' | 'ultracode' | 'custom'>, owner: WarmOwner, resumeAt?: string): Options {
    const extraArgs: Record<string, string | null> = { 'replay-user-messages': null };
    // Claude in Chrome is a start-up flag; without it the CLI follows the machine's /chrome setting.
    if (meta.options?.browser) extraArgs.chrome = null;
    else if (meta.options?.browser === false) extraArgs['no-chrome'] = null;
    const base = this.baseOptions(meta.cwd);
    const appendix = this.appendix(meta);
    // Sable's own tools: show_widget (generative UI) and the Browser tab tools (the session's capability),
    // allowed without the CLI's prompt (the browser tools ask for pages that are not local themselves).
    const browser = browserTabEnabled(meta);
    // Sub-agents from the other agent (Codex), while it is installed and signed in.
    const delegates = (this.ctx.otherAgents?.() ?? []).filter((a) => a !== 'claude' && AGENT_TOOLS[a]);
    // The Android device tools (the session's "Device" capability) ask for real phones themselves.
    const device = deviceEnabled(meta);
    // The user's profile: remember_about_user merges one fact into it (never secrets).
    const profile = this.profileOn() ? (fact: unknown) => this.ctx.profile!().remember(fact) : undefined;
    const own = this.widgets() || browser || device || delegates.length > 0 || !!profile;
    const allowed = [...(this.widgets() ? [WIDGET_TOOL_ID] : []), ...(browser ? BROWSER_TOOL_IDS : []), ...(device ? DEVICE_TOOL_IDS : []), ...delegates.map(agentToolId), ...(profile ? [PROFILE_TOOL_ID] : [])];
    const runAgent = this.ctx.runAgent;
    const delegate =
      delegates.length && runAgent
        ? {
            agents: delegates,
            run: (call: AgentCall, signal?: AbortSignal) => {
              const rt = owner.session?.runtime();
              if (!rt) return Promise.resolve({ ok: false, text: 'No session is attached yet.' });
              const step = claimStep(rt, (it) => agentOfTool(it.name) === call.agent, this.claimedSteps);
              return runAgent(rt, call, step, signal);
            },
          }
        : undefined;
    return {
      ...base,
      // The CLI's own word on when the session is idle or runs (session_state_changed): the SDK
      // swallows it unless the host asks for it, and it is what ends a turn that no result closes.
      env: { ...base.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
      // Appended to Claude Code's own prompt: CLAUDE.md, output styles and settings still apply.
      systemPrompt: appendix ? { type: 'preset', preset: 'claude_code', append: appendix } : base.systemPrompt,
      // Flag-tier settings for this process (what applyFlagSettings changes later on).
      settings: startSettings(meta),
      model: meta.model && meta.model !== 'default' ? meta.model : undefined,
      effort: sdkEffort(meta.effort) as Options['effort'],
      permissionMode: (meta.mode || 'default') as PermissionMode,
      // A turn check reads only: the user's own allow rules must not let it run or change anything.
      ...(meta.options?.readOnly ? { disallowedTools: READ_ONLY_BLOCKED } : {}),
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      forwardSubagentText: true,
      promptSuggestions: true,
      enableFileCheckpointing: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      resume: meta.providerSessionId,
      resumeSessionAt: resumeAt,
      extraArgs,
      // Generative UI: an in-process server with the show_widget tool, allowed without asking.
      // The user's own MCP servers still load from their settings.
      ...(own
        ? { mcpServers: { [WIDGET_SERVER]: widgetServer({ widgets: this.widgets(), session: browser ? () => owner.session?.runtime() : undefined, device: device ? () => owner.session?.runtime() : undefined, delegate, profile }) }, allowedTools: allowed }
        : {}),
      canUseTool: (name, toolInput, o) =>
        owner.session ? owner.session.canUseTool(name, toolInput, o) : Promise.resolve({ behavior: 'deny', message: 'No session is attached yet.' } as PermissionResult),
      stderr: (d) => {
        if (/error|fatal/i.test(d)) this.ctx.log('claude stderr:', d.trim().slice(0, 400));
      },
    };
  }

  /**
   * A chat's title from Claude Code's Haiku, on this account (`this.env()`: its own config folder):
   * one prompt, no tools, no settings, MCP servers or CLAUDE.md, no thinking, a small output cap,
   * one turn, and nothing saved to the account's history.
   */
  async quickTitle(prompt: TitlePrompt, signal: AbortSignal): Promise<string | null> {
    const ctrl = new AbortController();
    const stop = () => ctrl.abort();
    if (signal.aborted) return null;
    signal.addEventListener('abort', stop, { once: true });
    const q = query({ prompt: prompt.user, options: titleOptions(prompt, this.env(), ctrl) });
    let text = '';
    try {
      for await (const m of q) {
        const any = m as Obj;
        if (m.type === 'assistant' && !any.parent_tool_use_id) {
          for (const b of (any.message?.content as Obj[] | undefined) ?? []) if (b.type === 'text' && b.text) text += String(b.text);
          // Longer than any title or commit message: stop there (review wave 8, #24).
          if (text.length > QUICK_MAX_CHARS) {
            text = text.slice(0, QUICK_MAX_CHARS);
            break;
          }
        } else if (m.type === 'result') {
          if (any.subtype === 'success' && typeof any.result === 'string' && any.result.trim()) text = any.result.slice(0, QUICK_MAX_CHARS);
          else if (any.subtype !== 'success') this.ctx.log('claude: no title:', any.subtype, (any.errors as string[] | undefined)?.join('; ') ?? '');
          break;
        }
      }
    } finally {
      signal.removeEventListener('abort', stop);
      try {
        q.close();
      } catch {
        /* already closed */
      }
    }
    return text.trim() || null;
  }

  // ── prewarm: one agent process started ahead of the first send ──

  private warm?: { key: string; q: Query; input: PushQueue<SDKUserMessage>; owner: WarmOwner; timer: NodeJS.Timeout };

  async prewarm(choice: WarmChoice) {
    const key = warmKey(choice, this.concise(), this.widgets(), this.profileText());
    if (this.warm?.key === key) {
      this.warm.timer.refresh();
      return;
    }
    await this.discardWarm();
    if (!existsSync(choice.cwd)) return;
    const input = new PushQueue<SDKUserMessage>();
    const owner: WarmOwner = {};
    const q = sessionQuery(input, this.agentOptions({ ...choice, model: choice.model ?? '', mode: choice.mode ?? 'default' }, owner), owner);
    const timer = setTimeout(() => void this.discardWarm(), WARM_TTL_MS);
    timer.unref?.();
    this.warm = { key, q, input, owner, timer };
    this.ctx.log('claude: prewarming an agent process for', choice.cwd);
    // Surface a failed start now rather than on the first send (which then starts cold).
    q.initializationResult().catch(() => {
      if (this.warm?.q === q) void this.discardWarm();
    });
  }

  /** Hands the warm process to a session whose choice matches. */
  takeWarm(key: string) {
    const w = this.warm;
    if (!w || w.key !== key) return undefined;
    clearTimeout(w.timer);
    this.warm = undefined;
    return w;
  }

  async discardWarm() {
    const w = this.warm;
    if (!w) return;
    this.warm = undefined;
    clearTimeout(w.timer);
    w.input.end();
    try {
      w.q.close();
    } catch {
      /* already gone */
    }
  }

  caps(cwd = process.cwd()): Promise<Capabilities> {
    const hit = this.capsCache.get(cwd);
    if (hit && Date.now() - hit.at < 5 * 60_000) return Promise.resolve(hit.caps);
    const running = this.capsInflight.get(cwd);
    if (running) return running;
    const p = this.probe(cwd)
      .catch((err) => {
        this.ctx.log('claude caps probe failed:', (err as Error).message);
        return this.buildCaps(undefined, []);
      })
      .finally(() => this.capsInflight.delete(cwd));
    this.capsInflight.set(cwd, p);
    return p;
  }

  /** Starts a throwaway CLI process just to read what this project offers. Costs no tokens. */
  private async probe(cwd: string): Promise<Capabilities> {
    const input = new PushQueue<SDKUserMessage>();
    const q = query({ prompt: input, options: { ...this.baseOptions(cwd), persistSession: false } });
    try {
      const init = await withTimeout(q.initializationResult(), 25_000, 'Claude Code startup');
      const mcp = await withTimeout(q.mcpServerStatus(), 8_000, 'MCP status').catch(() => []);
      // Which commands are skills: a live session learns this from system/init, the probe asks.
      const skills = await withTimeout(q.reloadSkills(), 8_000, 'Skill list')
        .then((r) => r.skills.map((s) => s.name))
        .catch(() => undefined);
      // Read plan limits while this process is alive: there is no other cheap moment to ask.
      await this.readLimits(q);
      const caps = this.buildCaps(init, mcp, skills);
      this.capsCache.set(cwd, { at: Date.now(), caps });
      return caps;
    } finally {
      input.end();
      try {
        q.close();
      } catch {
        /* already gone */
      }
    }
  }

  buildCaps(init: Obj | undefined, mcp: Obj[], skillNames?: string[]): Capabilities {
    const models: ModelInfo[] = init?.models?.length
      ? (init.models as Obj[]).map((m, i) => ({
          id: String(m.value),
          name: String(m.displayName ?? m.value),
          description: m.description ? String(m.description) : undefined,
          efforts: m.supportsEffort ? ((m.supportedEffortLevels as Effort[] | undefined) ?? ['low', 'medium', 'high']) : undefined,
          supportsFast: !!m.supportsFastMode,
          isDefault: m.value === 'default' || i === 0,
          // Claude Code reports the models its own picker offers.
          picker: true,
          ...(m.supportsFastMode ? { speeds: [CLAUDE_FAST] } : {}),
        }))
      : FALLBACK_MODELS;
    const skills = new Set(skillNames ?? []);
    const commands: CommandInfo[] = ((init?.commands as Obj[] | undefined) ?? []).map((c) => ({
      name: String(c.name),
      description: String(c.description ?? ''),
      argumentHint: c.argumentHint ? String(c.argumentHint) : undefined,
      kind: skills.has(String(c.name)) ? 'skill' : c.builtin ? 'builtin' : 'command',
    }));
    const autoOk = !init || (init.models as Obj[] | undefined)?.some((m) => m.supportsAutoMode);
    return {
      models,
      modes: MODES.filter((m) => m.id !== 'auto' || autoOk),
      commands,
      skills: commands.filter((c) => c.kind === 'skill').map((c) => ({ name: c.name, description: c.description })),
      agents: ((init?.agents as Obj[] | undefined) ?? []).map((a) => ({ name: String(a.name), description: String(a.description ?? ''), model: a.model })),
      mcpServers: mcp.map(mapMcp),
      tools: [],
      skillTrigger: '/',
      features: {
        images: true,
        thinking: true,
        rewind: true,
        steer: true,
        compact: true,
        fast: models.some((m) => m.supportsFast),
        // Claude in Chrome ships with the CLI (the extension is the user's part, shown as state).
        browser: !!init,
        // The built-in computer-use server exists only where the CLI offers it (macOS).
        computerUse: mcp.some((s) => s.name === COMPUTER_USE_SERVER),
        remoteControl: !!init?.remote_control_available,
        // A setting of this CLI generation; the live process narrows it to whether the Workflow tool is there.
        ultracode: !!init,
      },
    };
  }

  /**
   * Reads plan limits through a live agent process (the SDK's usage request; no tokens). Reads
   * closer together than `minGapMs` share the last answer.
   */
  readLimits(q: Query, minGapMs = 15_000): Promise<RateLimit[]> {
    if (this.limitsRun) return this.limitsRun;
    if (Date.now() - this.limitsAt < minGapMs) return Promise.resolve(this.limitsCache);
    // The usage endpoint refused lately (the CLI remembers that for up to an hour): asking again
    // only adds load. Turns keep the windows current through rate_limit_event meanwhile.
    if (minGapMs > 0 && Date.now() < this.limitsRefusedUntil) return Promise.resolve(this.limitsCache);
    // An auxiliary request: never beside another one of this account, nor beside a start of it (auth-gate.ts).
    const run = authGate.run(gateKey('claude', this.configHome()), () => this.readLimitsNow(q)).finally(() => {
      if (this.limitsRun === run) this.limitsRun = undefined;
    });
    this.limitsRun = run;
    return run;
  }

  private async readLimitsNow(q: Query, retried = false): Promise<RateLimit[]> {
    try {
      const u = (await withTimeout(q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), 10_000, 'usage')) as Obj;
      void retried;
      this.limitsAt = Date.now();
      const rl = u?.rate_limits as Obj | null;
      // Available but empty: the usage endpoint refused (HTTP 429, remembered by the CLI per
      // sign-in for up to an hour) and the process has no reply headers to fall back on yet. A
      // quick retry cannot help; keep the last known windows and wait for a turn's rate_limit_event.
      if (!rl && u?.rate_limits_available) {
        this.limitsRefusedUntil = Date.now() + LIMITS_REFUSED_BACKOFF_MS;
        if (!this.limitsRefusedLogged) this.ctx.log('claude: the usage endpoint gave no plan limits; using the last known ones and the limits turns report');
        this.limitsRefusedLogged = true;
        return this.limitsCache;
      }
      // No subscription and no plan limits: an API key or a cloud provider. (Without the
      // subscription missing too it is only a token that cannot read them: say nothing.)
      if (!rl && u?.rate_limits_available === false && !u?.subscription_type) {
        this.limitsCache = [];
        this.ctx.emit({ type: 'limits.updated', provider: 'claude', limits: [], meta: { planLimits: false } });
        return [];
      }
      if (!rl) {
        this.ctx.log('claude: no plan limits in the usage answer', u?.rate_limits_available, u?.subscription_type ?? 'no subscription');
        return this.limitsCache;
      }
      const { rows, partial } = usageWindows(rl, this.limitsCache);
      const meta: LimitsMeta = partial ? { partial: true } : {};
      const ex = rl.extra_usage as Obj | null | undefined;
      if (ex) {
        meta.extra = { enabled: !!ex.is_enabled };
        if (ex.utilization != null) meta.extra.percent = Math.round(Number(ex.utilization));
        if (ex.used_credits != null) meta.extra.used = Number(ex.used_credits);
        if (ex.monthly_limit != null) meta.extra.limit = Number(ex.monthly_limit);
        if (ex.currency) meta.extra.currency = String(ex.currency);
        if (this.extraCache?.inUse !== undefined) meta.extra.inUse = this.extraCache.inUse;
        if (this.extraCache?.resetsAt) meta.extra.resetsAt = this.extraCache.resetsAt;
      }
      // Usage credits as the usage page tells them (`spend`): fills what extra_usage leaves out, and the balance.
      const credits = claudeSpend(rl.spend);
      if (credits) meta.extra = { ...credits, ...meta.extra, ...(credits.balance !== undefined ? { balance: credits.balance } : {}) };
      if (meta.extra) this.extraCache = meta.extra;
      // Limit resets the plan granted, when the answer carries them (never spent from here).
      const resets = claudeResets(rl, rows);
      if (resets) meta.resets = resets;
      if (rows.length) {
        meta.planLimits = true;
        this.limitsCache = rows;
        this.ctx.emit({ type: 'limits.updated', provider: 'claude', limits: rows, meta });
      }
    } catch (err) {
      // Limits are optional: say why once in the log.
      this.ctx.log('claude: plan limits could not be read:', (err as Error).message);
    }
    return this.limitsCache;
  }

  /**
   * A `rate_limit_event` from a turn: the CLI sends one with the first reply of a process and again
   * whenever a window moves by a percent, with every window it tracks (`unifiedWindows`, read from
   * the reply's headers, so it costs nothing and works when the usage endpoint refuses). A refusal
   * marks its window full. Returns the window that refused the turn, if it did.
   */
  onRateLimit(info: Obj | undefined): { resetsAt?: number; window?: string } | undefined {
    if (!info) return undefined;
    // A remembered window whose reset has passed has rolled over: it is empty until the next
    // message starts it again. Kept as such (not dropped), since the CLI may not report that
    // window again (real turns often send only the weekly one) and the 5-hour row must not vanish.
    const now = Date.now();
    const rows = new Map(this.limitsCache.map((l) => [l.id, rolledOver(l, now)]));
    let changed = this.limitsCache.some((l) => l !== rows.get(l.id));
    // The event's id for a window, as the rows name it: its per-model weekly window is the usage
    // answer's `model_<name>` row (the only one the account has), Fable's when none is known yet.
    const rowId = (id: string) => {
      if (id !== OVERAGE_INCLUDED) return id;
      const own = [...rows.keys()].filter(isModelWindow);
      return own.length === 1 ? own[0] : MODEL_WINDOW_DEFAULT;
    };
    const put = (eventId: string, utilization: unknown, resetsAt: unknown, full = false) => {
      const id = rowId(eventId);
      const prev = rows.get(id);
      const known = isModelWindow(id) ? { label: prev?.label ?? modelWindowLabel(id), mins: 10_080 } : (LIMIT_WINDOWS[id] ?? unnamedWindow(id));
      if (!known) return;
      const pct = full ? 100 : typeof utilization === 'number' ? Math.round(Math.max(0, Math.min(1, utilization)) * 100) : prev?.percent;
      if (pct === undefined) return;
      const reset = epochMs(resetsAt) ?? prev?.resetsAt;
      rows.set(id, { id, label: known.label, percent: pct, resetsAt: reset, windowMins: known.mins });
      changed = changed || pct !== prev?.percent || reset !== prev?.resetsAt;
    };
    const windows = info.unifiedWindows as Obj | undefined;
    if (windows && typeof windows === 'object') for (const [id, w] of Object.entries(windows)) put(id, (w as Obj)?.utilization, (w as Obj)?.resetsAt, (w as Obj)?.status === 'rejected');
    const type = info.rateLimitType ? String(info.rateLimitType) : undefined;
    const rejected = info.status === 'rejected';
    if (type) put(type, info.utilization, info.resetsAt, rejected);
    // Past a window, the account may carry on with extra usage (its own setting decides). An event
    // carries only the windows the reply's headers had: the others stay as last known.
    const meta: LimitsMeta = { planLimits: true, partial: true };
    const over = info.isUsingOverage ?? info.overageInUse;
    // Only an account with extra usage on (or already known) gets a record of it.
    if (over || (info.overageStatus && info.overageStatus !== 'rejected') || this.extraCache) {
      const prev = this.extraCache;
      const extra = { ...prev, enabled: info.overageStatus ? info.overageStatus !== 'rejected' : (prev?.enabled ?? !!over), inUse: !!over, resetsAt: epochMs(info.overageResetsAt) ?? prev?.resetsAt };
      if (extra.inUse !== prev?.inUse || extra.enabled !== prev?.enabled || extra.resetsAt !== prev?.resetsAt) changed = true;
      this.extraCache = meta.extra = extra;
    }
    if (changed) {
      this.limitsCache = sortWindows([...rows.values()]);
      this.limitsAt = Date.now();
      this.ctx.emit({ type: 'limits.updated', provider: 'claude', limits: this.limitsCache, meta });
    }
    if (!rejected) return undefined;
    const row = type ? rows.get(rowId(type)) : undefined;
    return { resetsAt: row?.resetsAt ?? epochMs(info.resetsAt), window: row?.label };
  }

  /** The reset of a window as last known, by its row label ("Weekly · Fable"). */
  windowReset(label: string): number | undefined {
    const want = label.toLowerCase();
    const row = this.limitsCache.find((l) => l.label.toLowerCase() === want);
    return row?.resetsAt && row.resetsAt > Date.now() ? row.resetsAt : undefined;
  }

  /**
   * Limits from a running agent process when there is one (a session's, or the warm one). With
   * `force` (the user asked) and none running, a short process starts just to read them: no
   * settings, plugins or MCP servers, no tokens, at most once a minute.
   */
  async limits(force: boolean | 'fresh' = false): Promise<RateLimit[]> {
    const fresh = force === 'fresh';
    // A read already under way began before this call: a fresh one waits for it and asks again.
    const read = async (q: Query) => {
      if (fresh) while (this.limitsRun) await this.limitsRun.catch(() => undefined);
      return this.readLimits(q, force ? 0 : 15_000);
    };
    for (const s of this.sessions) {
      const q = s.liveQuery();
      if (q) return read(q);
    }
    if (this.warm) return read(this.warm.q);
    // The probe's once-a-minute throttle holds for clicks, not for a reset's reading after its
    // dialog: that one must be taken after the dialog closed (review wave 8, #17).
    if (!force || (!fresh && Date.now() - this.limitsProbeAt < 60_000)) return this.limitsCache;
    this.limitsProbeAt = Date.now();
    const input = new PushQueue<SDKUserMessage>();
    const q = query({ prompt: input, options: { ...this.baseOptions(homedir()), settingSources: [], strictMcpConfig: true, persistSession: false } });
    try {
      await withTimeout(q.initializationResult(), 25_000, 'Claude Code startup');
      return await this.readLimits(q, 0);
    } catch (err) {
      this.ctx.log('claude: the limits probe failed:', (err as Error).message);
      return this.limitsCache;
    } finally {
      input.end();
      try {
        q.close();
      } catch {
        /* already gone */
      }
    }
  }

  /** The config folder this account's Claude Code uses: its own, the user's CLAUDE_CONFIG_DIR, or ~/.claude. */
  configHome(): string {
    return this.configDir ?? OWN_CONFIG_DIR ?? path.join(homedir(), '.claude');
  }

  /** Copies the conversation's transcript files from another account's folder into this one (see accounts/handover). */
  async adoptConversation(fromHome: string, providerSessionId: string): Promise<boolean> {
    return carryClaudeConversation(fromHome, this.configHome(), providerSessionId);
  }

  async history(cwd?: string, limit = 40): Promise<HistoryEntry[]> {
    const list = await this.withHistory(() => listSessions({ dir: cwd, limit }));
    return list.map((s) => ({
      provider: 'claude' as const,
      providerSessionId: s.sessionId,
      title: s.customTitle || s.summary || s.firstPrompt || 'Untitled session',
      cwd: s.cwd,
      branch: s.gitBranch,
      updatedAt: s.lastModified,
      preview: s.firstPrompt,
    }));
  }

  async open(rt: SessionRuntime, opts: { loadTranscript?: boolean }): Promise<ProviderSession> {
    const session = new ClaudeSession(rt, this);
    this.sessions.add(session);
    void this.caps(rt.meta.cwd).then((caps) => {
      // The probe beats a cached guess; a live process's own report beats the probe.
      if (!rt.caps || !session.liveCaps) rt.setCaps(caps);
      if (!rt.meta.model) rt.update({ model: caps.models.find((m) => m.isDefault)?.id ?? caps.models[0]?.id ?? 'default' });
    });
    if (opts.loadTranscript && rt.meta.providerSessionId) await session.loadTranscript().catch((e) => this.ctx.log('transcript load failed', e));
    return session;
  }

  async dispose() {
    await this.cancelLogin();
    await this.discardWarm();
    await Promise.all([...this.sessions].map((s) => s.close()));
  }
}

const WARM_TTL_MS = 3 * 60_000;
/** The most of a quick answer (a title, a commit message) kept. */
const QUICK_MAX_CHARS = 16_000;
/** How long after the usage endpoint refused before Sable asks it again unasked. */
const LIMITS_REFUSED_BACKOFF_MS = 10 * 60_000;
/** Plan windows as `rate_limit_event` names them, with the rows the usage answer gives them. */
const LIMIT_WINDOWS: Record<string, { label: string; mins: number }> = {
  five_hour: { label: '5-hour limit', mins: 300 },
  seven_day: { label: 'Weekly · all models', mins: 10_080 },
  seven_day_opus: { label: 'Weekly · Opus', mins: 10_080 },
  seven_day_sonnet: { label: 'Weekly · Sonnet', mins: 10_080 },
};
const LIMIT_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];
/** The fixed windows of the usage answer, with their rows. */
const USAGE_WINDOWS = LIMIT_ORDER.map((id) => [id, LIMIT_WINDOWS[id]] as const);
/**
 * The event's name for the per-model weekly window ("overage-included" models: the CLI calls it
 * the Fable limit). The usage answer lists the same window under `model_scoped` by its model.
 */
const OVERAGE_INCLUDED = 'seven_day_overage_included';
const MODEL_WINDOW_DEFAULT = 'model_Fable';
const isModelWindow = (id: string) => id.startsWith('model_');
const modelWindowLabel = (id: string) => `Weekly · ${id.slice('model_'.length)}`;

/** A mode in which nothing waits for a yes (Bypass): permission prompts are answered at once, questions still wait. */
export function bypassesAsking(mode: string | undefined): boolean {
  return mode === 'bypassPermissions';
}

/** The 5-hour window, the weekly one, Opus and Sonnet, then the per-model ones and anything else. */
export function sortWindows(rows: RateLimit[]): RateLimit[] {
  const rank = (id: string) => LIMIT_ORDER.indexOf(id) + 1 || (id.startsWith('five_hour') ? 10 : isModelWindow(id) ? 15 : 20);
  return rows.sort((a, b) => rank(a.id) - rank(b.id));
}

/**
 * The rows of a usage answer's `rate_limits`, over the windows known so far. What the answer says
 * nothing about is kept as last known (rolled over when its reset passed): a fixed window whose
 * key is missing, and the per-model weekly windows (Fable) when `model_scoped` is absent, which the
 * CLI does for an answer served from cached data or before its model allowlist has loaded. A key
 * that is there, even null, and a `model_scoped` list, even empty, are the account's own word.
 * `partial` when anything was kept that way.
 */
export function usageWindows(rl: Obj, known: RateLimit[], now = Date.now()): { rows: RateLimit[]; partial: boolean } {
  const rows: RateLimit[] = [];
  let partial = false;
  const keep = (test: (id: string) => boolean) => {
    partial = true;
    for (const l of known) if (test(l.id)) rows.push(rolledOver(l, now));
  };
  const add = (id: string, label: string, w: Obj | null | undefined, windowMins: number) => {
    if (!w || w.utilization == null) return;
    const resetsAt = w.resets_at ? Date.parse(w.resets_at) : NaN;
    rows.push({ id, label, percent: Math.max(0, Math.min(100, Math.round(Number(w.utilization)))), resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined, windowMins });
  };
  for (const [id, w] of USAGE_WINDOWS) {
    if (id in rl) add(id, w.label, rl[id], w.mins);
    else keep((x) => x === id);
  }
  const scoped = rl.model_scoped as Obj[] | undefined;
  if (Array.isArray(scoped)) {
    for (const m of scoped) if (m?.display_name) add(`model_${m.display_name}`, `Weekly · ${m.display_name}`, m, 10_080);
  } else keep(isModelWindow);
  return { rows: sortWindows(rows), partial };
}

/** A window whose reset has passed: empty, with no reset until the next message starts it. */
export function rolledOver(l: RateLimit, now: number): RateLimit {
  return l.resetsAt && l.resetsAt <= now ? { ...l, percent: 0, resetsAt: undefined } : l;
}
/**
 * Limit resets in a usage answer, read the way Claude Code reads them: `cedar_ember` (the reset
 * grants a plan carries: full, weekly or 5-hour, each with uses left and an end date) and
 * `juniper_tide` (a 5-hour reset once a week, usable at the limit). The CLI's plain usage read,
 * the one the SDK's usage request makes, gets both as null (it asks for them only at a limit), so
 * undefined here says nothing about the account. Sable never uses one (`spendable: false`): only
 * Claude Code's own `/limit-reset` and claude.ai can.
 */
export function claudeResets(rl: Obj, limits: RateLimit[], now = Date.now()): LimitsMeta['resets'] {
  const offers: ResetOffer[] = [];
  let said = false;
  const grants = rl?.cedar_ember as Obj | null | undefined;
  if (grants && typeof grants === 'object' && typeof grants.eligible === 'boolean') {
    said = true;
    if (grants.eligible && Array.isArray(grants.grants))
      for (const g of grants.grants) {
        const o = grantOffer(g, limits);
        if (o && o.left > 0 && (!o.expiresAt || o.expiresAt > now)) offers.push(o);
      }
  }
  const weekly = rl?.juniper_tide as Obj | null | undefined;
  if (weekly && typeof weekly === 'object' && typeof weekly.eligible === 'boolean') {
    said = true;
    if (weekly.eligible && weekly.arm === 'reset' && weekly.available === true) offers.push({ kind: 'session', left: 1, windows: claudeWindowIds(['five_hour'], limits), atLimitOnly: true });
  }
  if (!said) return undefined;
  const usable = offers.filter((o) => !o.paused);
  return { available: usable.reduce((n, o) => n + o.left, 0), windows: [...new Set(usable.flatMap((o) => o.windows))], offers, spendable: false };
}

/** One `cedar_ember` grant as an offer; undefined when it is malformed. */
function grantOffer(g: Obj, limits: RateLimit[]): ResetOffer | undefined {
  if (!g || typeof g !== 'object') return undefined;
  const left = Number(g.resets_left);
  if (!Number.isInteger(left) || left < 0) return undefined;
  const clears: string[] = Array.isArray(g.clears) ? g.clears.filter((c: unknown): c is string => typeof c === 'string') : [];
  const type = g.type === 'session' || g.type === 'weekly' || g.type === 'full' ? (g.type as ResetOffer['kind']) : undefined;
  const kind: ResetOffer['kind'] = type ?? (clears.length === 1 && clears[0] === 'five_hour' ? 'session' : clears.includes('five_hour') ? 'full' : clears.length ? 'weekly' : undefined);
  const ends = typeof g.ends_at === 'string' ? Date.parse(g.ends_at) : NaN;
  const total = Number(g.resets_total);
  const offer: ResetOffer = { left, windows: claudeWindowIds(clears, limits) };
  if (kind) offer.kind = kind;
  if (typeof g.label === 'string' && g.label.trim()) offer.label = g.label.trim().slice(0, 60);
  if (Number.isInteger(total) && total >= left && total > 0) offer.total = total;
  if (Number.isFinite(ends)) offer.expiresAt = ends;
  if (g.use_requires_limit !== false) offer.atLimitOnly = true;
  if (g.paused === true) offer.paused = true;
  return offer;
}

/** Claude Code's window names as Sable's row ids: the "overage-included" week is the per-model row (Fable). */
function claudeWindowIds(clears: string[], limits: RateLimit[]): string[] {
  const models = limits.filter((l) => isModelWindow(l.id)).map((l) => l.id);
  return [...new Set(clears.flatMap((c) => (c === OVERAGE_INCLUDED ? (models.length ? models : [MODEL_WINDOW_DEFAULT]) : [c])))];
}

/**
 * Usage credits from a usage answer's `spend` block (what claude.ai's usage page shows): whether
 * they are on, spent and cap, and the balance left, in hundredths of the currency (cents).
 * Undefined when the answer has no such block.
 */
export function claudeSpend(spend: unknown): NonNullable<LimitsMeta['extra']> | undefined {
  if (!spend || typeof spend !== 'object') return undefined;
  const sp = spend as Obj;
  const used = moneyCents(sp.used);
  const limit = moneyCents(sp.limit);
  const balance = moneyCents(sp.balance);
  const currency = [sp.used, sp.limit, sp.balance].map((m) => (m && typeof m === 'object' && typeof m.currency === 'string' ? (m.currency as string) : undefined)).find(Boolean);
  const out: NonNullable<LimitsMeta['extra']> = { enabled: sp.enabled === true };
  if (used !== undefined) out.used = used;
  if (limit !== undefined) out.limit = limit;
  if (balance !== undefined) out.balance = balance;
  if (typeof sp.percent === 'number' && Number.isFinite(sp.percent)) out.percent = Math.round(sp.percent);
  if (currency) out.currency = currency;
  return out;
}

/** `{ amount_minor, exponent }` as hundredths (the unit the other amounts use). */
function moneyCents(m: unknown): number | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const v = Number((m as Obj).amount_minor);
  const exp = Number((m as Obj).exponent ?? 2);
  if (!Number.isFinite(v) || !Number.isInteger(exp) || exp < 0 || exp > 6) return undefined;
  return Math.round((v / 10 ** exp) * 100);
}

/** A window the table does not name (a newer plan, a model of its own): labelled by its length. */
function unnamedWindow(id: string): { label: string; mins: number } | undefined {
  const m = /^(five_hour|seven_day)_(\w+)$/.exec(id);
  if (!m) return undefined;
  const name = m[2]
    .split('_')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
  return m[1] === 'five_hour' ? { label: `5-hour limit · ${name}`, mins: 300 } : { label: `Weekly · ${name}`, mins: 10_080 };
}
/** Epoch seconds or milliseconds to milliseconds. */
const epochMs = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? (v < 1e12 ? v * 1000 : v) : undefined);
const CHROME_SERVER = 'claude-in-chrome';
const COMPUTER_USE_SERVER = 'computer-use';

/** Who answers permission prompts for an agent process (set when a session adopts a warm one). */
interface WarmOwner {
  session?: ClaudeSession;
  childExited?: Promise<void>;
  streamEnded?: () => void;
}

/** Capture the actual process even when it starts asynchronously or is adopted from the warm pool. */
function sessionQuery(prompt: PushQueue<SDKUserMessage>, options: Options, owner: WarmOwner): Query {
  const spawnProcess = options.spawnClaudeCodeProcess ?? authGate.spawner(options.stderr);
  let spawned = false;
  let exit!: () => void;
  owner.childExited = new Promise<void>((resolve) => { exit = resolve; });
  // A query that failed before spawning has no child to wait for.
  owner.streamEnded = () => { if (!spawned) exit(); };
  return query({
    prompt,
    options: {
      ...options,
      spawnClaudeCodeProcess(request) {
        const child = spawnProcess(request);
        spawned = true;
        child.once('exit', exit);
        child.once('error', (err) => {
          if (/^spawn(?: |$)/.test((err as NodeJS.ErrnoException).syscall ?? '')) exit();
        });
        return child;
      },
    },
  });
}

/** Everything a process is started with: a warm process is only reused for the same choice. */
/** The output cap for a title: a few words, with room to spare. */
const TITLE_MAX_TOKENS = '96';

/**
 * Options for the one-shot title query (`ClaudeProvider.quickTitle`): Haiku, its own short system
 * prompt instead of Claude Code's, no tools at all (any call is refused), no settings, hooks, MCP
 * servers or CLAUDE.md, no thinking, one turn, a small output cap, nothing written to the history.
 * `env` is the account's: the title is asked of the chat's own account and no other.
 */
export function titleOptions(prompt: TitlePrompt, env: NodeJS.ProcessEnv, abortController: AbortController): Options {
  return {
    cwd: existsSync(prompt.cwd) ? prompt.cwd : homedir(),
    model: 'haiku',
    systemPrompt: prompt.system,
    tools: [],
    allowedTools: [],
    canUseTool: async () => ({ behavior: 'deny', message: 'No tools here.' }),
    settingSources: [],
    mcpServers: {},
    strictMcpConfig: true,
    thinking: { type: 'disabled' },
    effort: 'low',
    maxTurns: 1,
    persistSession: false,
    env: { ...env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: prompt.maxTokens ?? TITLE_MAX_TOKENS, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    pathToClaudeCodeExecutable: claudeBinary(),
    abortController,
    stderr: () => {},
  };
}

function warmKey(c: { cwd: string; model?: string; mode?: string; effort?: Effort; options?: SessionOptions; ultracode?: boolean; custom?: boolean }, concise: boolean, widgets = true, profile = '') {
  const o = c.options ?? {};
  // A process warmed for an ordinary chat never serves the Customize chat (its prompt carries the brief).
  return JSON.stringify([path.resolve(c.cwd).toLowerCase(), c.model && c.model !== 'default' ? c.model : '', c.mode || 'default', sdkEffort(c.effort) ?? '', o.browser ?? null, !!c.ultracode, concise, widgets, o.browserTab !== false, deviceEnabled(c), profile, !!c.custom]);
}

/** Control requests the SDK does not wrap (remote_control, mcp_call): the CLI answers them on stdio. */
function controlRequest(q: Query, request: Obj): Promise<unknown> {
  const send = (q as unknown as { request?: (r: Obj) => Promise<{ response?: unknown }> }).request;
  if (typeof send !== 'function') return Promise.reject(new Error('This Claude Code version does not support it.'));
  return send.call(q, request).then((r) => r?.response);
}

function mapMcp(s: Obj): McpServerInfo {
  return {
    name: String(s.name),
    status: s.status,
    scope: s.scope,
    error: s.error,
    version: s.serverInfo?.version,
    tools: Array.isArray(s.tools) ? s.tools.map((t: Obj) => ({ name: String(t.name), description: t.description })) : undefined,
  };
}

interface StreamState {
  messageId?: string;
  blocks: Map<number, { itemId: string; type: 'text' | 'thinking' | 'tool'; name?: string; json: string; peeked?: string; confirmed?: boolean }>;
}

type UserPayload = Pick<UserItem, 'text' | 'attachments'>;

function samePayload(a: UserPayload, b: UserPayload) {
  return a.text === b.text && isDeepStrictEqual(a.attachments ?? [], b.attachments ?? []);
}

/** A message a session sent, as it remembers it (`ClaudeSession.own`). */
interface OwnSend {
  /** Its card (none in the timeline for a message Sable sends unseen, a carry-on). */
  itemId: string;
  /** The card's words, and what went (with what Sable added), each as `plainWords`. */
  words: string;
  sent: string;
  /** When it went, and to which process. */
  at: number;
  q?: object;
  /** Claude Code took it (replayed, stamped on a reply, or found by its words); and replayed it under its own uuid. */
  read: boolean;
  replayed: boolean;
  answered?: boolean;
  guessed?: boolean;
  onTaken?: () => void;
  uncertain?: () => void;
  release?: () => void;
  /** Exact Sable-added blocks that can distinguish a replay from an identical app message. */
  proofBlocks: string[];
  /** Root text crossed by a delayed replay, in case the result identifies it as this send's reply. */
  crossed?: string[];
  /** A replay under another uuid taken for it by its words: the app's own message after all if this one comes back under its own (`unalias`). */
  alias?: { uuid: string; text: string; attachments?: Attachment[]; at: number; after?: string; identified: boolean; answer?: { outcome: MessageOutcome; resultId?: string } };
}

class ClaudeSession implements ProviderSession {
  private q?: Query;
  private input?: PushQueue<SDKUserMessage>;
  private streams = new Map<string, StreamState>();
  private pendingUsers = new Map<string, string>(); // sdk uuid → UserItem id
  /**
   * Every message this session sent, by the uuid it went with (review of 23 Nov, D-own): its card, its
   * words as the card shows them and as they went (wrappers and Sable's additions aside), when and to
   * which process it went, and whether Claude Code took it (`read`: replayed, stamped on a reply, or
   * found by its words) or replayed it under its own uuid. Turn bookkeeping never forgets one, so a
   * replay of a message of Sable's own is never a message from the Claude app, whatever a result or a
   * turn's end did meanwhile. Bounded (`OWN_MAX`); a close forgets them all.
   */
  private own = new Map<string, OwnSend>();
  /** The bound on a turn kept open by a message of ours Claude Code has not read (`UNREAD_QUIET_MS`). */
  private unreadNet?: NodeJS.Timeout;
  /**
   * Messages from people (ours, or from the Claude app) whose turn has not ended yet, by their uuid,
   * and whether Claude Code has read them (replayed them): a result can only answer a message it read.
   */
  private awaiting = new Map<string, { read: boolean }>();
  /**
   * Claude Code's own messages (a background task's notification, a teammate's message) taken since
   * the last result. They wake the model with a turn whose result names no message of anyone's, or
   * are folded into the running turn: never in `awaiting`, which only people's messages close.
   */
  private wakes = 0;
  /** This CLI names the messages a result answers (`user_message_uuids`, or `user_message_uuid`); older ones do not. */
  private get namesMessages() { return this.provider.seen.names; }
  /** A message of ours Claude Code replayed under another uuid (a folded steer): its uuid there → ours. */
  private aliases = new Map<string, string>();
  /** A later replay can bind an unfamiliar result UUID to any of the inputs still awaiting an answer then. */
  private unmatchedResults = new Map<string, { pending: Set<string>; turn: number; before: string; result: string; error?: string; final?: string }>();
  /** Our messages whose result has not come yet, by sdk uuid → UserItem id: each result says what its messages came to (`rt.answered`). */
  private sentItems = new Map<string, string>();
  /**
   * Steers Claude Code had not read when the person stopped: they went back to the queue (sdk uuid →
   * the UserItem's id and the words and pictures as they went to Claude Code). One it reads after all
   * is shown as it went, and its copy in the queue is taken out (never sent twice) unless the person
   * changed it there since; sent again from the queue meanwhile, the card that went is this one too.
   */
  private withdrawn = new Map<string, { itemId: string; text: string; attachments?: UserItem['attachments']; steered?: boolean; at: number }>();
  /** The CLI's own state (session_state_changed), as last reported. */
  private cliState?: 'idle' | 'running' | 'requires_action';
  private interrupted = false;
  /** Turns settled here so far: a stop's safety net (`interruptTimer`) acts only on the turn it was for. */
  private turnSeq = 0;
  private interruptTimer?: NodeJS.Timeout;
  /**
   * Results still owed by turns a stop's safety net settled without one (oldest first): the messages
   * each turn had read, each still owing its own result, as every uuid a result may name it by → its
   * sdk uuid; empty for a turn Claude Code began by itself. It answers its turns in order, so a result
   * that names only such messages, or (naming none) the next one owed, is that settled turn's, come
   * late (`late`), and pays for those messages only.
   */
  private owed: { names: Map<string, string>; notices: Map<string | undefined, string>; window?: BackgroundLimit; wakeReported: boolean }[] = [];
  /**
   * Messages held back from the process (`hold`): a result it still owes (`owed`) could not be told
   * from theirs, and it cannot be let go for a new one while background tasks run in it. They go once
   * that result comes, the process goes idle or ends, or its last task ends (`release`); a stop sends
   * them back to the queue.
   */
  private held?: SDKUserMessage[];
  /** A new agent process has not said hello yet (system/init): the live line says "Starting", not "Thinking". */
  private booting = false;
  private idleTimer?: NodeJS.Timeout;
  /**
   * Live tasks of this process (agents, shells, monitors), by task id, from three kinds of word
   * (review of 23 Nov, A4). `liveTasks`: those known from their own events (started, moved to the
   * background) until their end is heard; a background one also leaves when the CLI's next list is in,
   * as that list covers it. `foreground`: those of them a call blocks on, which no list holds; one also
   * ends with its call's result. `level`: the CLI's own list of every live background task (replaced
   * by each `background_tasks_changed`; none until the first). Ambient tasks (watchers, housekeeping)
   * are nobody's work and never count (`ambient`).
   */
  private liveTasks = new Set<string>();
  private foreground = new Set<string>();
  private level?: Set<string>;
  private ambient = new Set<string>();
  /** What each task of this process is, and when it was first seen. */
  private taskInfo = new Map<string, { kind: TaskKind; since: number; description?: string; reportedRow?: string }>();
  /** Tasks whose end was heard: a start that comes after its end never marks one running again. */
  private endedTasks = new Set<string>();

  private taskRuns = new Map<string, string>();
  private taskEndUntil = 0;
  private taskEndTimer?: NodeJS.Timeout;
  private restartTimer?: NodeJS.Timeout;
  /**
   * The step each task of this process belongs to (task id to item id), from the task events that named
   * it: a task's end that names no step still finds it, and the live task list settles a step whose task
   * is gone (review wave 7, #8).
   */
  private taskItems = new Map<string, string>();
  /** Wake-ups the agent scheduled, read from its calls' results: the dynamic loop's next one, and each scheduled task's next fire. */
  private loopWakeAt?: number;
  private cronWakes = new Map<string, number>();
  /** When this process last said anything at all, and anything of the agent's own work at the root (`WAKE_QUIET_MS`). */
  private heardAt = 0;
  private rootHeardAt = 0;
  /**
   * The turn this session's process runs (its `rt.turnStartedAt`), and the one Claude Code began by
   * itself: a close ends only a turn of its own process (`ownsTurn`), and only the agent's own turn
   * ends by going quiet (`wakeNet`).
   */
  private turnAt = -1;
  private agentTurnAt = -1;
  private wakeNet?: NodeJS.Timeout;
  /** Messages held back while the CLI says it works: looked at again once that word is too old to believe. */
  private releaseTimer?: NodeJS.Timeout;
  /** Let go by the bridge (`close`): it never starts a process again, so a message meant for it never reaches the account the chat left. */
  private retired = false;
  /** Children which may still be writing this session's transcript, including after SDK cleanup. */
  private exits = new Set<Promise<void>>();
  /**
   * The CLI's running total (`total_cost_usd`) as last seen in this process, which each result's cost
   * is counted from (review of 23 Nov, D-cost). A process that resumes a conversation starts from the
   * total this chat last saw for it (`SessionUsage.cliCost`); undefined when that is not known (a chat
   * from before, a fork): its first result then carries the conversation's past, and books nothing.
   */
  private lastTotalCost: number | undefined = 0;
  /** No result with a total has come from this process yet: one below where it started is a resume from an earlier point. */
  private costFresh = false;
  private retryNotice?: string;
  private tasks = new Map<string, Todo>();
  private chain: string[] = [];
  private resumeAt?: string;
  private skillNames: string[] = [];
  private closed = false;
  private seenMessages = new Set<string>();
  private syntheticTexts = new Set<string>();
  /** Set by a compact boundary until the turn ends. */
  private compacted = false;
  /** The options the running process was started with. */
  private applied?: SessionOptions;
  /**
   * A start-up option changed while the process held work: restart once it holds none
   * (`restartWhenFree`). What the notice says starts or stops ("Browser control starts"), and whether
   * it has said that it waits for background work.
   */
  private restartPending?: string;
  private restartTold = false;
  /** The running process has reported its own capabilities (better than the probe's). */
  liveCaps = false;
  /** This turn was refused at a plan limit: the window that refused it, and the notice that says so. */
  private limitHit?: { resetsAt?: number; window?: string };
  /** Each independently refused input keeps its own retry card until this turn settles. */
  private turnLimits = new Map<string | undefined, string>();
  private wakeLimit?: { hit: BackgroundLimit; provisional?: string };
  /** An idle/frame-only refusal was already handed off, but the CLI can still send its closing result. */
  private limitResultOwed = false;

  private autonomousTurn(): boolean {
    if (!this.rt.turnActive || this.agentTurnAt !== this.rt.turnStartedAt) return false;
    for (const delivery of this.awaiting.values()) if (delivery.read) return false;
    return true;
  }

  private refusal(words: string, event = this.limitHit): BackgroundLimit {
    const named = agentLimitOf(words);
    const stamp = epochMs(Number(/\|(\d{9,13})\b/.exec(words)?.[1]));
    const detail = words.replace(/\|\d{9,13}\b/, '').trim();
    const window = named?.window === 'Plan limit' ? event?.window ?? named.window : named?.window ?? event?.window;
    const eventReset = !event?.window || event.window === window ? event?.resetsAt : undefined;
    return { window, resetsAt: eventReset ?? stamp ?? named?.resetsAt, ...(detail && !isStandIn(detail) ? { detail } : {}) };
  }

  /** Reuse a pending limit card for the person's turn and fill in any window learned later. */
  private showTurnLimit({ window, resetsAt, detail }: BackgroundLimit, uuid?: string, notices = this.turnLimits) {
    const rt = this.rt;
    const own = uuid && this.own.get(this.aliases.get(uuid) ?? uuid);
    const card = own ? rt.get(own.itemId) : uuid ? rt.items.findLast((i) => i.type === 'user' && i.providerId === uuid) : undefined;
    const owner = card?.type === 'user' ? { origin: 'user' as const, userItemId: card.id } : {};
    const key = uuid ? this.aliases.get(uuid) ?? uuid : undefined;
    const existing = notices.get(key) ?? notices.get(undefined);
    const pending = !existing && notices === this.turnLimits && this.openLimitCard(window);
    const id = existing ?? (pending || undefined);
    const notice = id ? rt.get<NoticeItem>(id) : undefined;
    if (!notice?.limit) {
      const added = rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: errorLabel('rate_limit'), detail, limit: { window, resetsAt, ...owner } });
      notices.set(key, added.id);
      return added;
    }
    notices.delete(undefined);
    notices.set(key, notice.id);
    const limit = { ...notice.limit, ...owner, window: notice.limit.window ?? window, resetsAt: notice.limit.resetsAt ?? resetsAt };
    if (pending) {
      rt.limitCard = undefined;
      rt.move(notice.id, { detail: detail ?? notice.detail, limit });
    } else if (limit.window !== notice.limit.window || limit.resetsAt !== notice.limit.resetsAt || limit.userItemId !== notice.limit.userItemId) {
      rt.patch<NoticeItem>(notice.id, { limit });
    }
    return notice;
  }

  /** When this chat was last used (a message, a turn's end, Remote Control on): for the Remote Control keeper. */
  private lastActive = Date.now();
  /** This chat's place with the Remote Control keeper (server/core/remote-keep.ts). */
  private readonly remoteHolder: RemoteHolder;

  constructor(
    private rt: SessionRuntime,
    private provider: ClaudeProvider,
  ) {
    this.remoteHolder = {
      id: rt.id,
      lastActive: () => this.lastActive,
      // A process that holds work (a turn, also one the agent began by itself, its own word that it
      // works, a background task, a wake-up due soon) is never let go, and counts toward the max.
      busy: () => this.holdsWork(),
      release: () => {
        // Work began while the release waited: declined, and the keeper holds it again.
        if (this.holdsWork()) return false;
        this.log('claude: Remote Control process released (not used recently)');
        // As the idle close: the remote status says it reconnects when the chat is used again.
        this.tellLost(this.shutdown(), 'process');
      },
    };
  }

  // ── what the process holds ──

  /**
   * Whether the process holds work (review of 23 Nov, D-hold): a turn (Sable's or one Claude Code began
   * by itself), a question or permission open, the CLI's own word that it works, a task that is not
   * ambient (foreground or background: a sub-agent, a workflow, a command, a monitor), or a wake-up it
   * scheduled that is due within the hour. Housekeeping (the idle close, the Remote Control keeper, a
   * restart for a changed option) never lets go of a process that holds work.
   */
  holdsWork(): boolean {
    if (this.rt.turnActive) return true;
    if (!this.q) return false;
    return this.worksNow() || this.wakeDue() || Date.now() < this.taskEndUntil;
  }

  /** Work running in the process now, a turn aside: a prompt open, the CLI's own word that it works, a live task. */
  private worksNow(): boolean {
    return this.promptsOpen() || this.cliBusy() || this.liveIds().size > 0;
  }

  private promptsOpen(): boolean {
    const p = this.rt.prompts();
    return p.permissions.length + p.questions.length > 0;
  }

  /**
   * The CLI says it works (`running`, or waiting on a prompt). Believed while it is heard from: a
   * missed idle never keeps a process for ever (`CLI_TRUST_MS`).
   */
  private cliBusy(): boolean {
    return (this.cliState === 'running' || this.cliState === 'requires_action') && Date.now() - this.heardAt < CLI_TRUST_MS;
  }

  /** Every live task of this process that is somebody's work. */
  private liveIds(): Set<string> {
    const out = new Set<string>(this.liveTasks);
    for (const id of this.level ?? []) out.add(id);
    for (const id of this.ambient) out.delete(id);
    return out;
  }

  private *backgroundTasks() {
    for (const id of this.liveIds()) {
      if (this.foreground.has(id)) continue;
      const info = this.taskInfo.get(id);
      yield { id, itemId: this.taskItems.get(id), agent: info?.kind === 'agent', since: info?.since, description: info?.description };
    }
  }

  /** The next wake-up the agent scheduled in this process that is not yet past its grace. */
  private wakeAt(now = Date.now()): number | undefined {
    let at: number | undefined;
    for (const t of [this.loopWakeAt, ...this.cronWakes.values()]) if (t !== undefined && t > now - WAKE_GRACE_MS) at = Math.min(at ?? t, t);
    return at;
  }

  private wakeDue(now = Date.now()): boolean {
    const at = this.wakeAt(now);
    return at !== undefined && at - now <= WAKE_HOLD_MS;
  }

  /**
   * What still runs in the agent's process, as Claude Code says it: its turn, background sub-agents
   * and workflows, background commands and monitors (and any other task that is not ambient), when the
   * oldest of those commands began, and its next scheduled wake-up. Nothing without a process.
   */
  liveWork(): ReturnType<NonNullable<ProviderSession['liveWork']>> {
    if (!this.q) return { turn: false, agents: 0, commands: 0 };
    let agents = 0;
    let commands = 0;
    let oldest: number | undefined;
    let newest: number | undefined;
    for (const task of this.backgroundTasks()) {
      if (task.agent) agents++;
      else {
        commands++;
        if (task.since !== undefined) {
          oldest = Math.min(oldest ?? task.since, task.since);
          newest = Math.max(newest ?? task.since, task.since);
        }
      }
    }
    const wakeAt = this.wakeAt();
    // The CLI says it runs for as long as its background agents run (its idle comes once they are
    // done, sdk.d.ts): that is their work, counted as agents, not a turn. Read as a turn it would hold
    // a move at a limit off the very agents that move stops, and a send after a sign-in for minutes.
    const turn = this.rt.turnActive || this.promptsOpen() || this.foreground.size > 0 || (this.cliBusy() && !agents);
    return { turn, agents, commands, ...(oldest !== undefined ? { oldestCommandAt: oldest, newestCommandAt: newest } : {}), ...(wakeAt !== undefined ? { wakeAt } : {}),
      ...(Date.now() < this.taskEndUntil ? { notificationUntil: this.taskEndUntil } : {}) };
  }

  /** Whether the open turn runs in this session's process: a close ends no turn of another's (review of 23 Nov, D2). */
  private ownsTurn(): boolean {
    return !!this.q && this.rt.turnActive && this.turnAt === this.rt.turnStartedAt;
  }

  /**
   * Resolves once the children of this handle have exited. Rejects when a child has
   * still not exited after `EXIT_WAIT_MS`, so a move never copies a transcript it may still be writing
   * (app.ts `moveAccount`).
   */
  exited(): Promise<void> {
    if (!this.exits.size) return Promise.resolve();
    const p = Promise.all(this.exits);
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('The agent process has not ended yet.')), EXIT_WAIT_MS);
      void p.then(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /** The person is told, once, which background commands went with a process (`tasksLost` gave their names). */
  private tellLost(names: string[], why: LostWhy) {
    if (names.length) this.rt.lossNotice = this.rt.notice('info', lostLine(names.length, why), names.join('\n')).id;
  }

  /** Tasks, wakes, pending option changes and unmatched frames belong to one query. */
  private resetProcessState() {
    this.wakeLimit = undefined;
    this.limitResultOwed = false;
    this.limitHit = undefined;
    this.turnLimits = new Map();
    this.liveTasks.clear();
    this.foreground.clear();
    this.level = undefined;
    this.ambient.clear();
    this.taskInfo.clear();
    this.endedTasks.clear();
    this.taskItems.clear();
    this.streams.clear();
    this.taskRuns.clear();
    this.unmatchedResults.clear();
    this.taskEndUntil = 0;
    this.rt.setReportedTasks([]);
    this.restartPending = undefined;
    this.restartTold = false;
    clearTimeout(this.restartTimer);
    clearTimeout(this.taskEndTimer);
    this.loopWakeAt = undefined;
    this.cronWakes.clear();
    clearTimeout(this.releaseTimer);
  }

  liveQuery() {
    return this.q;
  }

  /** The session this process works for (the browser tools ask its window). */
  runtime() {
    return this.rt;
  }

  private get log() {
    return this.provider.ctx.log;
  }

  // ── process lifecycle ──

  private ensure(): Query {
    if (this.q) return this.q;
    if (this.retired) throw new Error(RETIRED);
    // A process (re)started while a phone's switch is held runs under the mode the work had (`workMode`).
    const rt = this.rt;
    const meta = rt.workMode === rt.meta.mode ? rt.meta : { ...rt.meta, mode: rt.workMode };
    // A process started while the user was typing on the home screen, for exactly this choice.
    const warm = !meta.providerSessionId && !this.resumeAt ? this.provider.takeWarm(warmKey(meta, this.provider.concise(), this.provider.widgets(), this.provider.profileText())) : undefined;
    let q: Query;
    let input: PushQueue<SDKUserMessage>;
    const owner: WarmOwner = warm?.owner ?? {};
    owner.session = this;
    if (warm) {
      ({ q, input } = warm);
      this.log('claude: adopted the prewarmed agent process');
    } else {
      input = new PushQueue<SDKUserMessage>();
      q = sessionQuery(input, this.provider.agentOptions(meta, owner, this.resumeAt), owner);
    }
    this.booting = !warm;
    this.resumeAt = undefined;
    this.q = q;
    this.input = input;
    this.lastActive = Date.now();
    if (meta.options?.remoteControl) holdRemote(this.remoteHolder);
    this.applied = { ...meta.options };
    // Its running total starts where the conversation it resumes left it (D-cost): what this chat last
    // saw for that conversation; not known for one it never counted. A new conversation starts at 0.
    const counted = meta.usage.cliCost;
    this.lastTotalCost = !meta.providerSessionId ? 0 : counted?.session === meta.providerSessionId ? counted.total : undefined;
    this.costFresh = true;
    this.liveCaps = false;
    // A new process owes no result of the last one's turns, and runs none of its tasks.
    this.owed = [];
    this.resetProcessState();
    this.heardAt = Date.now();
    const exit = owner.childExited!; // Installed when this query was created, including for a warm process.
    this.exits.add(exit);
    void exit.then(() => this.exits.delete(exit));
    void this.pump(q).catch((err) => this.log('claude: reading the agent process failed:', (err as Error).message)).finally(owner.streamEnded);
    void q
      .initializationResult()
      .then(async (init) => {
        const mcp = await q.mcpServerStatus().catch(() => []);
        // Until system/init names the skills, keep what the probe found for this folder.
        const skills = this.skillNames.length ? this.skillNames : (this.rt.caps?.skills.map((s) => s.name) ?? []);
        if (this.q !== q) return;
        this.liveCaps = true;
        this.rt.setCaps(this.provider.buildCaps(init as Obj, mcp as Obj[], skills));
        void this.provider.readLimits(q);
        await this.applyLiveOptions(q, mcp as Obj[]);
      })
      .catch(() => {});
    return q;
  }

  /** Options that work on a running process: remote control, the computer-use server, the Chrome check. */
  private async applyLiveOptions(q: Query, mcp?: Obj[]) {
    const o = this.rt.meta.options ?? {};
    if (o.remoteControl) await this.setRemote(q, true);
    if (o.browser) await this.checkBrowser(q);
    const servers = mcp ?? ((await q.mcpServerStatus().catch(() => [])) as Obj[]);
    if (servers.some((s) => s.name === COMPUTER_USE_SERVER)) {
      const on = !!o.computerUse;
      await q.toggleMcpServer(COMPUTER_USE_SERVER, on).catch((err: Error) => {
        if (on) this.rt.notice('error', 'Computer use could not be turned on', err.message);
      });
      this.setCapState('computerUse', on ? { status: 'Ready. Claude asks before using an app', tone: 'ok' } : undefined);
    }
  }

  private setCapState(key: 'browser' | 'computerUse', state: CapabilityState | undefined) {
    const cur = this.rt.meta.capState ?? {};
    if (JSON.stringify(cur[key]) === JSON.stringify(state)) return;
    this.rt.update({ capState: { ...cur, [key]: state } });
  }

  /** Remote Control: the CLI registers this session on claude.ai/code and answers with its link. */
  private async setRemote(q: Query, on: boolean) {
    try {
      const r = (await withTimeout(controlRequest(q, { subtype: 'remote_control', enabled: on }), 20_000, 'Remote Control')) as Obj | undefined;
      if (this.q !== q) return;
      if (!on) return this.rt.update({ remote: undefined });
      const url = typeof r?.session_url === 'string' ? r.session_url : undefined;
      this.rt.update({ remote: url ? { url, status: 'Continue on claude.ai/code or in the Claude app', tone: 'ok' } : { status: 'Remote Control started without a link', tone: 'waiting' } });
    } catch (err) {
      if (!on) return this.rt.update({ remote: undefined });
      const message = (err as Error).message;
      this.rt.update({ remote: { status: 'Remote Control is not available', tone: 'error' } });
      // On by default in every chat: where the sign-in has no Remote Control, the session says so in its status only.
      if (this.rt.caps?.features.remoteControl !== false) this.rt.notice('error', 'Remote Control could not start', message);
    }
  }

  /** Claude in Chrome: is the server up, and is a browser with the extension connected? Reads only. */
  private async checkBrowser(q: Query) {
    const servers = (await q.mcpServerStatus().catch(() => [])) as Obj[];
    const s = servers.find((x) => x.name === CHROME_SERVER);
    let state: CapabilityState;
    if (!s) state = { status: 'Claude in Chrome is not available here', tone: 'error' };
    else if (s.status !== 'connected') state = { status: s.error ? String(s.error).slice(0, 120) : 'Claude in Chrome did not start', tone: 'error' };
    else {
      try {
        const r = (await withTimeout(controlRequest(q, { subtype: 'mcp_call', tool: `mcp__${CHROME_SERVER}__list_connected_browsers`, arguments: {} }), 10_000, 'Chrome check')) as Obj;
        const text = String(((r?.content as Obj[] | undefined) ?? []).find((c) => c.type === 'text')?.text ?? '');
        let list: unknown[] = [];
        try {
          const parsed = JSON.parse(text);
          list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.browsers) ? parsed.browsers : [];
        } catch {
          list = /no (connected )?browser/i.test(text) || !text.trim() ? [] : [text];
        }
        const first = list[0] as Obj | string | undefined;
        const name = typeof first === 'object' && first ? String(first.name ?? first.browser ?? 'Chrome') : 'Chrome';
        state = list.length ? { status: `Connected to ${name}`, tone: 'ok' } : { status: 'Chrome extension not connected. Open Chrome with Claude in Chrome', tone: 'waiting' };
      } catch (err) {
        state = { status: `Could not reach Chrome: ${(err as Error).message}`, tone: 'error' };
      }
    }
    if (this.q === q) this.setCapState('browser', state);
  }

  async setOptions(options: SessionOptions) {
    // Let go by the bridge: a process started here now would be one nobody owns.
    if (this.retired) return;
    const q = this.q;
    const before = this.applied ?? {};
    if (!q) {
      // Nothing running: the next start applies everything. Remote Control needs a process now.
      if (options.remoteControl) {
        if (!existsSync(this.rt.meta.cwd)) throw new Error(`The folder ${this.rt.meta.cwd} does not exist.`);
        this.closed = false;
        this.ensure();
      } else {
        this.rt.update({ remote: undefined, capState: undefined });
      }
      return;
    }
    if (!!options.browser !== !!before.browser) {
      // A CLI flag: only a new process has it.
      this.restartFor(options.browser ? 'Browser control starts' : 'Browser control stops');
      return;
    }
    if ((options.browserTab !== false) !== (before.browserTab !== false) || deviceEnabled({ options }) !== deviceEnabled({ options: before })) {
      // The Browser tab tools live in the process's own MCP server: only a new process changes them.
      this.restartFor(options.browserTab !== false ? 'The Browser tab tools start' : 'The Browser tab tools stop');
      return;
    }
    if (!!options.remoteControl !== !!before.remoteControl) {
      this.applied = { ...before, remoteControl: options.remoteControl };
      await this.setRemote(q, !!options.remoteControl);
      // Off: the process closes as any idle one; on: the keeper counts it as just used.
      if (!options.remoteControl) {
        dropRemote(this.remoteHolder);
        if (!this.rt.turnActive) this.scheduleIdleClose();
      } else {
        this.lastActive = Date.now();
        holdRemote(this.remoteHolder);
      }
    }
    if (!!options.computerUse !== !!before.computerUse) {
      this.applied = { ...this.applied, computerUse: options.computerUse };
      await this.applyLiveOptions(q);
    }
  }

  /**
   * A start-up option changed (`subject`: what starts or stops): a new process takes it. Never one
   * that holds work: after the turn, or once its background work is over (a restart would end a test
   * run the agent waits for; review of 23 Nov, visible-M1), and the chat says which.
   */
  private restartFor(subject: string) {
    if (this.rt.turnActive) {
      this.restartPending = subject;
      this.restartTold = false;
      this.rt.notice('info', `${subject} after this turn`);
    } else {
      this.restartPending = subject;
      this.restartTold = false;
      this.restartWhenFree();
    }
  }

  /** The restart a changed option waits for, once the turn is over and nothing else holds the process; said once when background work still does. */
  private restartWhenFree() {
    if (!this.restartPending || this.retired || this.rt.turnActive) return;
    if (Date.now() < this.taskEndUntil) return;
    if (this.holdsWork()) {
      if (!this.worksNow() && this.wakeDue()) this.freeLater(this.wakeAt()! + WAKE_GRACE_MS + 1 - Date.now());
      if (!this.restartTold && (this.liveIds().size || this.promptsOpen() || this.wakeDue())) {
        this.restartTold = true;
        this.rt.notice('info', `${this.restartPending} ${this.whenFree()}`);
      }
      return;
    }
    this.restart();
  }

  /** Looks at a waiting restart once the event at hand is handled. */
  private freeLater(ms = 0) {
    if (!this.restartPending) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.restartWhenFree(), ms);
    this.restartTimer.unref?.();
  }

  /** Allow the CLI to deliver a finished task's notification and begin the turn it wakes. */
  private waitForNotification() {
    this.taskEndUntil = Date.now() + LIST_GRACE_MS;
    clearTimeout(this.taskEndTimer);
    this.taskEndTimer = setTimeout(() => {
      for (const task of this.unlistedCommands()) this.taskOver(task, 'stopped', undefined, true);
      this.taskEndUntil = 0;
      this.release();
      this.restartWhenFree();
    }, LIST_GRACE_MS);
    this.taskEndTimer.unref?.();
  }

  /** When a waiting restart can happen, as the person reads it. */
  private whenFree(): string {
    const w = this.liveWork();
    if (w.commands && !w.agents) return w.commands === 1 ? 'when the background command finishes' : 'when the background commands finish';
    if (w.agents || w.commands) return 'when the background work finishes';
    if (this.wakeDue()) return 'after the scheduled wake-up';
    return 'when the agent is done';
  }

  /** Replaces the idle agent process so new start-up options take effect (the conversation resumes). */
  private restart() {
    this.restartPending = undefined;
    this.restartTold = false;
    const keepRunning = !!this.rt.meta.options?.remoteControl;
    this.tellLost(this.shutdown('process', 'capability'), 'process');
    this.rt.update({ remote: undefined, capState: undefined });
    if (keepRunning) this.ensure();
  }

  private async pump(q: Query) {
    let failure: string | undefined;
    try {
      for await (const m of q) {
        // A process let go (closed, restarted, set aside after a stop): what it still writes is no turn's
        // here. Drain its iterator while the spawner independently watches for the child's exit.
        if (this.q !== q) continue;
        try {
          this.onMessage(m);
        } catch (err) {
          this.log('claude message handling failed:', (err as Error).stack);
        }
      }
    } catch (err) {
      failure = (err as Error).message || String(err);
    }
    // Let go by Sable: what it held was settled then (`shutdown`).
    if (this.q !== q) return;
    // The process ended by itself.
    const wakeLimit = this.takeWakeLimit();
    this.releaseQueryReceipts(q);
    const lost = this.rt.tasksLost('process', 'death');
    this.rt.processGeneration++;
    this.q = undefined;
    this.input = undefined;
    this.resetProcessState();
    this.wakes = 0;
    this.cliState = undefined;
    this.owed = [];
    clearTimeout(this.wakeNet);
    clearTimeout(this.unreadNet);
    clearTimeout(this.idleTimer);
    dropRemote(this.remoteHolder);
    // What the process had not read went with it.
    this.withdrawn.clear();
    this.clearLiveState();
    // What ran in it went with it (review of 23 Nov, A3): background sub-agents and workflows ended;
    // its commands and monitors are lost (a child of its shell may outlive it unseen, so never "ended").
    this.rt.stopBackground();
    if (!wakeLimit && this.held && this.rt.turnActive && !this.closed) {
      // Messages held back from it never reached it (they are all the running turn has): they go to a new one.
      this.tellLost(lost, 'process');
      return this.release();
    }
    for (const held of this.held ?? []) this.releaseReceipt(this.own.get(held.uuid ?? ''));
    this.held = undefined;
    this.retire(this.sentItems.keys(), 'failed');
    if (this.rt.turnActive && !this.closed) {
      // Its turn was cut, and the bridge knows it: it ended early (D-early), with the process's own words.
      this.turnSeq++;
      clearTimeout(this.interruptTimer);
      this.interrupted = false;
      this.awaiting.clear();
      this.rt.cutTurn('died', { detail: failure });
    } else if (!this.rt.turnActive) {
      // No turn open: the steps it left running end with it, at this moment, and nothing is said of them.
      this.rt.cutTurn('died');
    }
    if (wakeLimit) this.rt.limitInBackground(wakeLimit);
    // Said once, after the turn's own line: the agent is told with its next message (`takeLost`).
    this.tellLost(lost, 'process');
  }

  /** The step a task event belongs to: the one it names, or the one its task was seen with. */
  private taskItem(m: Obj): ToolItem | undefined {
    const named = m.tool_use_id && this.rt.get<ToolItem>(String(m.tool_use_id));
    if (named && named.name !== 'SendMessage') return named;
    const id = this.taskItems.get(String(m.task_id));
    return id ? this.rt.get<ToolItem>(id) : undefined;
  }

  /** A message can start another run of the same agent without another Agent tool call. */
  private linkAgentRun(m: Obj) {
    const id = String(m.task_id);
    const info = this.taskInfo.get(id);
    if (info?.kind !== 'agent' || this.endedTasks.has(id)) return;
    let item = this.taskItem(m);
    if (item?.kind !== 'agent') {
      item = this.rt.items.findLast((i): i is ToolItem => i.type === 'tool' && i.result?.agent?.taskId === id);
    }
    // A level can precede the start or be the only frame. Replace its row if the actual call arrives.
    if (!item && m.task_type === 'local_agent') {
      item = this.rt.add<ToolItem>({
        type: 'tool', name: 'local_agent', kind: 'agent', status: 'done', title: m.description || 'Background agent',
        detail: { description: m.description, subagent: m.subagent_type, background: true },
      });
      info.reportedRow = item.id;
    }
    if (!item || item.workflow) return;
    if (info.reportedRow && item.id !== info.reportedRow) {
      this.rt.remove(info.reportedRow);
      delete info.reportedRow;
    }
    this.taskItems.set(id, item.id);
    const agent = item.result?.agent;
    if (agent?.taskId === id && agent.background === 'running') return;
    this.rt.patch<ToolItem>(item.id, {
      status: ['cancelled', 'denied', 'error'].includes(item.status) ? 'done' : item.status,
      result: { ...item.result, agent: { taskId: id, background: 'running' } },
    });
  }

  /** What a task is and when it was first seen, kept from the first word of it that says. */
  private noteTask(id: string, taskType?: unknown, toolName?: string, description?: string) {
    const known = this.taskInfo.get(id);
    const kind = taskKindOf(taskType, toolName);
    if (!known) this.taskInfo.set(id, { kind, since: Date.now(), description });
    else if (known.kind === 'other' && kind !== 'other') known.kind = kind;
  }

  /**
   * A task of this process runs in the background now (its start, or its call moved to the
   * background): a command or monitor marks its step (`ToolItem.task`), so the bridge counts it.
   */
  private backgrounded(id: string, item: ToolItem | undefined) {
    if (!item || this.endedTasks.has(id) || this.ambient.has(id)) return;
    const kind = this.taskInfo.get(id)?.kind;
    if (kind === 'command' || kind === 'monitor') this.rt.taskStarted(item.id, { id, kind });
  }

  /** Word of a task's end (its notification, or its state): it no longer holds the process, and a command's step says how it ended. */
  private taskOver(id: string, state: 'done' | 'failed' | 'stopped', at?: number, fromList = false) {
    if (!fromList && !this.foreground.has(id) && !this.endedTasks.has(id) && !this.ambient.has(id)) this.waitForNotification();
    this.liveTasks.delete(id);
    this.foreground.delete(id);
    this.level?.delete(id);
    this.endedTasks.add(id);
    if (this.endedTasks.size > 500) this.endedTasks.delete(this.endedTasks.values().next().value as string);
    this.rt.taskEnded(id, state, at);
    if (fromList) return; // The list's notification grace already scheduled release and restart.
    // The last one ended: messages held for this process's owed result can go, and a waiting restart too.
    this.release();
    this.freeLater();
  }

  /**
   * The live task list is Claude Code's own word on what runs in the background: a step whose task is
   * not on it, or any background step at all when nothing runs, has ended without its end reaching
   * here (it is stopped). A step whose own call still runs is not background work yet. A command or
   * monitor off the list whose end was not heard is taken as stopped after a short grace (its word
   * comes first as a rule): a stale "running" never stays.
   */
  private reconcileTasks() {
    const live = new Set([...(this.level ?? []), ...this.foreground]);
    const called = (i: TimelineItem) => i.type === 'tool' && i.status !== 'running' && i.status !== 'pending' && i.status !== 'awaiting';
    const gone = new Set<string>();
    for (const [task, id] of this.taskItems) if (!live.has(task)) gone.add(id);
    const off = this.unlistedCommands();
    if (off.size && Date.now() >= this.taskEndUntil) this.waitForNotification();
    if (!live.size) this.rt.stopBackground(called);
    else if (gone.size) this.rt.stopBackground((i) => gone.has(i.id) && called(i));
    // A task off the list is forgotten once its step's call has returned (a running call's own end still comes).
    for (const [task, id] of [...this.taskItems]) {
      const item = this.rt.get(id);
      if (!live.has(task) && !off.has(task) && (!item || called(item))) this.taskItems.delete(task);
    }
  }

  private unlistedCommands() {
    const missing = new Set<string>();
    if (!this.level) return missing;
    for (const [task, id] of this.taskItems) {
      if (this.level.has(task) || this.liveTasks.has(task) || this.foreground.has(task) || this.endedTasks.has(task)) continue;
      const mark = this.rt.get<ToolItem>(id)?.task;
      if (mark?.id === task && mark.state === 'running') missing.add(task);
    }
    return missing;
  }

  /**
   * At a plan limit: every background task of this process is stopped for real, so nothing goes on
   * on the account at its limit. False while a turn runs (that turn's end decides), also one the agent
   * began by itself. The tasks it stops are its point, so they never hold it, nor does the CLI's own
   * "running", which lasts while its background agents run (review of 23 Nov, A1).
   */
  async stopBackgroundWork(automatic = true): Promise<boolean> {
    const q = this.q as (Query & { stopTask?: (taskId: string) => Promise<void> }) | undefined;
    if (!q || this.rt.turnActive) return !q;
    // Each task asked to stop first; then the process goes, and whatever it ran (also a task whose
    // start never reached here) ends with it. The next message resumes the conversation in a new one.
    if (typeof q.stopTask === 'function') await Promise.all([...this.liveIds()].map((task) => withTimeout(Promise.resolve(q.stopTask!(task)), 5_000, 'stopTask').catch(() => {})));
    // Never the process a turn now uses (one the agent began meanwhile): then nothing is confirmed (review wave 17, #5).
    if (this.rt.turnActive) return false;
    // A command whose stop was not heard before the process went is lost at the limit, and said so.
    if (this.q === q) this.tellLost(this.shutdown('limit', automatic ? 'limit' : undefined), 'limit');
    return true;
  }

  private scheduleIdleClose() {
    clearTimeout(this.idleTimer);
    this.lastActive = Date.now();
    // Remote Control lives in this process: the keeper (server/core/remote-keep.ts) decides when it closes.
    if (this.q && this.rt.meta.options?.remoteControl) holdRemote(this.remoteHolder);
    this.armIdleClose(IDLE_CLOSE_MS);
  }

  /**
   * The idle close (Remote Control off): the process goes once it has held no work (`holdsWork`) for
   * `IDLE_CLOSE_MS`, counted from the later of its last use and the last wake from sleep (a laptop
   * that slept was not idle; work the sleep suspended goes on when it wakes). While it holds work the
   * clock starts again.
   */
  private armIdleClose(ms: number) {
    clearTimeout(this.idleTimer);
    const expected = Date.now() + ms;
    this.idleTimer = setTimeout(() => {
      if (!this.q || this.rt.meta.options?.remoteControl) return;
      // A timer that fired far too late slept with the laptop: noted, so the sleep counts as no idleness.
      authGate.noteTimer(expected);
      if (this.holdsWork()) return this.scheduleIdleClose();
      const left = idleSince(this.lastActive) + IDLE_CLOSE_MS - Date.now();
      if (left > 1_000) return this.armIdleClose(left);
      // After a sleep every chat's close falls due at once, while each process renews its sign-in:
      // spread out (server/core/auth-gate.ts), and only when the chat still holds no work then.
      authGate.afterWake(() => {
        if (this.q && !this.rt.meta.options?.remoteControl && !this.holdsWork()) this.tellLost(this.shutdown(), 'process');
      });
    }, ms);
    this.idleTimer.unref?.();
  }

  /** The process is gone: its remote link and Chrome connection went with it. */
  private clearLiveState() {
    const meta = this.rt.meta;
    if (meta.remote) this.rt.update({ remote: meta.options?.remoteControl && !this.closed ? { status: 'Reconnects when the agent starts again', tone: 'waiting' } : undefined });
    if (meta.capState) this.rt.update({ capState: undefined });
  }

  /**
   * Lets the process go: it is closed, and nothing it writes after this reaches a turn here (`pump`).
   * What ran in it went with it: background sub-agents and workflows are stopped, its commands and
   * monitors lost (`why`), and the steps it left running with no turn open settle now, at the moment
   * of the cut (an open turn is its caller's to end). Returns the names of the commands lost, for the
   * caller to tell (`tellLost`).
   */
  private shutdown(why: LostWhy = 'process', trigger?: LossTrigger): string[] {
    clearTimeout(this.idleTimer);
    clearTimeout(this.wakeNet);
    clearTimeout(this.unreadNet);
    dropRemote(this.remoteHolder);
    const q = this.q;
    let lost: string[] = [];
    if (q) {
      this.releaseQueryReceipts(q);
      this.clearLiveState();
      // Its pump, which settles all this when the process ends by itself, skips a process let go here (review wave 7, #5).
      lost = this.rt.tasksLost(why, trigger);
      this.rt.processGeneration++;
      this.resetProcessState();
      this.rt.stopBackground();
      if (!this.rt.turnActive) this.rt.cutTurn('closed');
    }
    this.q = undefined;
    this.cliState = undefined;
    this.input?.end();
    this.input = undefined;
    try {
      q?.close();
    } catch {
      /* already closed */
    }
    return lost;
  }

  /**
   * Let go by the bridge (a move, the chat closed, a switch of agent, Sable quitting). The session is
   * retired: it never starts a process again, so a message sent to it late throws instead of reaching
   * the account the chat left (review of 23 Nov, D6). A turn its own process still ran was cut by
   * Sable and says so ("Ended early"); a turn it does not run is left to whoever does. Resolves once
   * the process has really ended, or after `EXIT_WAIT_MS` (a move copies a transcript only once
   * `exited` says it ended).
   */
  async close() {
    this.retired = true;
    this.closed = true;
    this.held = undefined;
    clearTimeout(this.interruptTimer);
    clearTimeout(this.releaseTimer);
    clearTimeout(this.unreadNet);
    // Nothing of its process reaches it any more: what it sent is no longer looked for.
    for (const own of this.own.values()) this.releaseReceipt(own);
    this.own.clear();
    const owned = this.ownsTurn();
    const wakeLimit = this.takeWakeLimit();
    const lost = this.shutdown();
    if (owned) {
      this.turnSeq++;
      this.interrupted = false;
      this.awaiting.clear();
      this.wakes = 0;
      this.retire(this.sentItems.keys(), 'stopped');
      this.rt.cutTurn('closed');
      if (wakeLimit) this.rt.limitInBackground(wakeLimit);
    }
    this.tellLost(lost, 'process');
    this.provider.sessions.delete(this);
    // Bounded: a process that does not end in time is not waited for here (`exited` says so to a move).
    await this.exited().catch(() => {});
  }

  /**
   * Lets the idle process go with the results it still owes (`owed`): nothing it writes after this
   * reaches a turn here (`pump`), and the next message starts a new one. What it had not read went
   * back to the queue at the stop.
   */
  private setAside() {
    this.log('claude: a stopped turn never sent its result; the next message goes to a new agent process');
    this.tellLost(this.shutdown(), 'process');
    this.owed = [];
    this.streams.clear();
    this.wakes = 0;
    this.withdrawn.clear();
  }

  // ── commands from the UI ──

  async send(item: UserItem, opts?: SendOptions) {
    try {
      this.sendInput(item, opts);
    } catch (error) {
      opts?.release?.();
      throw error;
    }
  }

  private sendInput(item: UserItem, opts?: SendOptions) {
    // The sender's guard (review wave 6, #3): everything from here to the push into the stream runs at once.
    opts?.check?.();
    // Let go by the bridge (the chat moved, or closed): never a process on the account it left (review of 23 Nov, D6).
    if (this.retired) throw new Error(RETIRED);
    // Otherwise the SDK reports a missing cwd as a binary that "failed to launch".
    if (!existsSync(this.rt.meta.cwd)) throw new Error(`The folder ${this.rt.meta.cwd} does not exist.`);
    this.closed = false;
    this.lastActive = Date.now();
    // A stopped turn still owes its result on a stream that has not shown it names what a result
    // answers: a result naming nothing could then be either turn's. The next turn goes to a new process
    // (the conversation resumes there), whose results are all its own. With work running in it (a
    // background task, the CLI's own word that it works), letting it go would end that: the message
    // waits instead (`held`) until that result is told apart (`release`). A wake-up it scheduled does
    // not hold the person's message: it goes, and the wake-up with the process.
    if (this.q && !this.rt.turnActive && this.owed.length && !this.namesMessages) {
      if (this.worksNow() || Date.now() < this.taskEndUntil) {
        this.held ??= [];
        this.recheckHeld();
      } else this.setAside();
    }
    this.ensure();
    clearTimeout(this.idleTimer);
    const uuid = randomUUID();
    this.pendingUsers.set(uuid, item.id);
    const images = (item.attachments ?? []).filter((a) => a.kind === 'image' && a.dataUrl);
    const files = (item.attachments ?? []).filter((a) => a.kind !== 'image' && a.path);
    const card = this.rt.get<UserItem>(item.id);
    let text = item.text;
    if (files.length) {
      // The app adds notes after the person's words, sometimes with a handover before them.
      // File references belong with the words, so the transcript reader can strip the trailing notes.
      const words = card?.type === 'user' ? card.text : text;
      const joined = text.indexOf(HANDOVER_JOIN + words);
      let end = text.length;
      if (joined >= 0 && (!words || !text.startsWith(words))) end = joined + HANDOVER_JOIN.length + words.length;
      else if (text.startsWith(words)) end = words.length;
      const references = files.map((f) => `@${f.path}`).join(' ');
      text = text.slice(0, end) + '\n\n' + references + text.slice(end);
    }
    // Steered into a running turn: the person waits for a reply, so the agent is told to answer first
    // (a block of its own after their words; the conversation shows only what they wrote). Not for a
    // slash command, which is not a question.
    const steerFirst = !!item.steered && this.rt.turnActive && !/^\/[\w:-]+/.test(item.text.trim());
    const content: unknown =
      images.length || steerFirst
        ? [
            ...images.map((a) => {
              const m = a.dataUrl!.match(/^data:([^;]+);base64,(.*)$/);
              return { type: 'image', source: { type: 'base64', media_type: m?.[1] ?? 'image/png', data: m?.[2] ?? '' } };
            }),
            { type: 'text', text },
            ...(steerFirst ? [{ type: 'text', text: STEER_FIRST_BLOCK }] : []),
          ]
        : text;
    this.awaiting.set(uuid, { read: false });
    this.sentItems.set(uuid, item.id);
    // Sable's own for good (D-own): its card's words, and what went (Sable may have added a summary, a line, files).
    this.own.set(uuid, {
      itemId: item.id, words: plainWords(card?.type === 'user' ? card.text : item.text), sent: plainWords(text),
      at: Date.now(), q: this.held ? undefined : this.q, read: false, replayed: false, onTaken: opts?.taken, release: opts?.release, uncertain: opts?.uncertain,
      proofBlocks: [
        ...(steerFirst ? [STEER_FIRST_BLOCK] : []),
        ...(card?.type === 'user' && item.text !== card.text ? [text] : []),
      ],
    });
    while (this.own.size > OWN_MAX) {
      const oldest = this.own.keys().next().value!;
      this.releaseReceipt(this.own.get(oldest));
      this.own.delete(oldest);
    }
    // Its result says what it came to (`retire`): until then it went ok for nobody (the bridge names a chat only from one that did).
    this.rt.expectOutcome(item.id);
    this.interrupted = false;
    // Local commands (/cost, /context) can take a while and never "think".
    const command = /^\/[\w:-]+/.exec(item.text.trim())?.[0];
    if (!this.rt.turnActive) {
      this.rt.beginTurn(command ? `Running ${command}` : this.booting ? 'Starting' : 'Thinking');
      this.agentTurnAt = -1;
      this.limitResultOwed = false;
    }
    // Steered into a turn the agent began by itself after a stop: the person lifts the stop's hold.
    else this.rt.personSent();
    // The turn runs in this process (`ownsTurn`).
    this.turnAt = this.rt.turnStartedAt;
    const msg = {
      type: 'user',
      uuid,
      session_id: this.rt.meta.providerSessionId ?? '',
      parent_tool_use_id: null,
      message: { role: 'user', content },
      // Steered: taken at the agent's next step (between tool calls) and nothing it did is discarded.
      // "now" would abort the step in flight; "later" would wait for the turn to end.
      ...(item.steered && this.rt.turnActive ? { priority: 'next' } : {}),
    } as unknown as SDKUserMessage;
    if (this.held) {
      this.held.push(msg);
      this.rt.update({ activity: HELD_LINE });
      return;
    }
    this.input!.push(msg);
  }

  /**
   * Sends the messages held back (`held`) once their results can be told apart: the owed result came,
   * the process went idle or ended (none is coming any more), or its last background task ended (then
   * the process, which still owes it, is let go and they go to a new one). Otherwise they wait on.
   */
  private release() {
    const held = this.held;
    if (!held) return;
    if (this.q && this.owed.length && !this.namesMessages) {
      if (this.worksNow() || Date.now() < this.taskEndUntil) return this.recheckHeld();
      this.setAside();
    }
    clearTimeout(this.releaseTimer);
    this.held = undefined;
    this.ensure();
    for (const m of held) {
      // It goes to this process now (a late take is looked for only from the process a message went to).
      const o = this.own.get((m as { uuid?: string }).uuid ?? '');
      if (o) o.q = this.q;
      this.input!.push(m);
    }
    if (this.rt.turnActive && this.rt.meta.activity === HELD_LINE) this.rt.update({ activity: this.booting ? 'Starting' : 'Thinking' });
  }

  /**
   * Messages held while the CLI's own word that it works is what holds them: looked at again once that
   * word is too old to believe (`CLI_TRUST_MS`), so a missed idle never holds them for ever.
   */
  private recheckHeld() {
    clearTimeout(this.releaseTimer);
    if (!this.cliBusy()) return;
    this.releaseTimer = setTimeout(() => this.release(), Math.max(1_000, this.heardAt + CLI_TRUST_MS - Date.now() + 50));
    this.releaseTimer.unref?.();
  }

  async interrupt() {
    if (this.held && this.rt.turnActive) {
      // Nothing of this turn reached Claude Code: what was held goes back to the queue (finishTurn), and
      // the process keeps the background tasks it runs, and the result it owes.
      this.held = undefined;
      this.interrupted = true;
      this.finishTurn(undefined, true);
      return;
    }
    if (!this.q || !this.rt.turnActive) return;
    // The turn this stop is for: its safety net never ends another (one begun after it settled).
    const turn = this.turnSeq;
    const since = this.rt.turnStartedAt;
    const ours = () => this.turnSeq === turn && this.rt.turnStartedAt === since && this.rt.turnActive;
    this.interrupted = true;
    let taken = true;
    try {
      await withTimeout(Promise.resolve(this.q.interrupt()), 4_000, 'interrupt');
    } catch {
      taken = false;
    }
    if (!ours()) return;
    // The CLI answers with a result message; if it does not, close the turn ourselves.
    clearTimeout(this.interruptTimer);
    this.interruptTimer = setTimeout(() => {
      if (!this.interrupted || !ours()) return;
      // Claude Code never said it took the stop, and no end came: it may still be at work.
      if (!taken) return this.terminate();
      // Settled without its result: should that come after all, it is this turn's, never a newer one's.
      this.owe();
      this.finishTurn(undefined, true);
    }, 2_500);
  }

  /**
   * A stop Claude Code never confirmed (its interrupt failed or went unanswered) and no end came: it may
   * still be at work, so the turn is not ended on a guess while it lives. Its process is closed, which
   * ends whatever it still did, and then the turn ends, stopped; nothing the process writes after this
   * reaches a turn here (`pump`), and the next message resumes the conversation in a new one.
   */
  private terminate() {
    this.log('claude: the stop was not confirmed; the agent process is closed');
    // Its background sub-agents and workflows end with it, its commands are lost (`shutdown`).
    const wakeLimit = this.takeWakeLimit();
    const lost = this.shutdown();
    this.wakeLimit = wakeLimit && { hit: wakeLimit };
    this.owed = [];
    this.streams.clear();
    this.wakes = 0;
    this.finishTurn(undefined, true);
    // What it had not read went back to the queue (finishTurn); no process is left to read it.
    this.withdrawn.clear();
    this.tellLost(lost, 'process');
  }

  /** The running turn is settled without its result: the result it still owes is told apart when it comes (`late`). */
  private owe() {
    const names = new Map<string, string>();
    // On a stream that has not shown it names what a result answers, a message it has not replayed may
    // have been taken all the same (a replay is not always seen): it may still be answered too.
    for (const [u, a] of this.awaiting) if (a.read || !this.namesMessages) names.set(u, u);
    for (const [alias, u] of this.aliases) if (names.get(u) === u) names.set(alias, u);
    // Nothing read and nothing that woke it: Claude Code began no turn for it, and owes no result.
    if (!names.size && !this.wakes) return;
    this.owed.push({ names, notices: this.turnLimits, window: this.limitHit, wakeReported: !!this.wakeLimit });
    if (this.owed.length > 8) this.owed.shift();
  }

  /** Message `uuid` is answered in a turn of its own after all: no settled turn owes its result any more. */
  private forgive(uuid: string) {
    this.owed = this.owed.filter(({ names: debt }) => {
      const had = debt.size;
      for (const [name, u] of [...debt]) if (u === uuid) debt.delete(name);
      // A turn Claude Code began by itself (no message of anyone's) still owes its own.
      return !had || debt.size > 0;
    });
  }

  /**
   * Whether result `m` is one a turn settled by the safety net owed (`owed`): naming messages, when it
   * names only that turn's; naming none, the oldest owed that named none (any, in a CLI that names
   * none). It pays for the messages it answers only (named, or in a CLI that names none, the oldest):
   * a turn that had read more still owes their results. Claude Code answers its turns in order: what
   * was owed before the result that came is not coming any more.
   */
  private late(m: Obj) {
    if (!this.owed.length) return;
    const named = resultUuids(m);
    if (named.length) this.learnNames();
    const at = named.length ? this.owed.findIndex(s => named.every(u => s.names.has(u))) : this.owed.findIndex(s => !this.namesMessages || !s.names.size);
    if (at < 0) {
      this.owed = [];
      return;
    }
    this.owed.splice(0, at);
    const { names, notices, window, wakeReported } = this.owed[0];
    const paid = new Set(named.length ? named.map(u => names.get(u)) : [names.values().next().value]);
    for (const [name, u] of names) if (paid.has(u)) names.delete(name);
    if (!names.size) this.owed.shift();
    return { owner: [...paid].at(-1), notices, window, wakeReported };
  }

  async setModel(model: string) {
    await this.q?.setModel(model === 'default' ? undefined : model);
  }

  async setEffort(effort: Effort) {
    // A new effort level alone turns ultracode off: send both to keep it on.
    await this.q?.applyFlagSettings({ effortLevel: sdkEffort(effort), ...(this.rt.meta.ultracode ? { ultracode: true } : {}) } as never);
  }

  async setUltracode(on: boolean) {
    await this.q?.applyFlagSettings({ ultracode: on } as never);
  }

  async setMode(mode: string) {
    await this.q?.setPermissionMode(mode as PermissionMode);
  }

  async setFast(fast: boolean) {
    await this.q?.applyFlagSettings({ fastMode: fast } as never);
  }

  /** Claude Code has one speed beyond standard: fast mode. */
  async setSpeed(speed: string) {
    await this.setFast(speed === 'fast');
  }

  async context(): Promise<ContextBreakdown | null> {
    if (!this.q) return null;
    const c = (await withTimeout(this.q.getContextUsage({ detail: 'summary' }), 15_000, 'context')) as Obj;
    return {
      totalTokens: c.totalTokens,
      maxTokens: c.maxTokens,
      percent: c.percentage,
      model: c.model,
      categories: (c.categories as Obj[]).map((x) => ({ name: x.name, tokens: x.tokens, kind: x.kind === 'free' ? 'free' : x.kind === 'buffer' ? 'buffer' : 'used' })),
    };
  }

  async mcp(): Promise<McpServerInfo[]> {
    if (!this.q) return this.rt.caps?.mcpServers ?? [];
    return ((await this.q.mcpServerStatus()) as Obj[]).map(mapMcp);
  }

  async rewind(itemId: string, restoreFiles: boolean) {
    const item = this.rt.get<UserItem>(itemId);
    if (!item || item.type !== 'user') return { ok: false, message: 'Pick one of your own messages to rewind to.' };
    if (this.rt.turnActive) return { ok: false, message: 'Stop the current turn first.' };
    let note = '';
    if (restoreFiles && item.providerId) {
      try {
        // A real rewind may not list the files it touched; the dry run does.
        const q = this.ensure();
        const dry = await q.rewindFiles(item.providerId, { dryRun: true });
        const r = dry.canRewind ? await q.rewindFiles(item.providerId) : dry;
        const n = (r.filesChanged ?? dry.filesChanged)?.length;
        if (!r.canRewind) note = r.error ?? 'Files could not be restored.';
        else if (n === undefined) note = 'Restored files to this point.';
        else note = n ? `Restored ${n} file${n === 1 ? '' : 's'}.` : 'No files needed restoring.';
      } catch (err) {
        note = (err as Error).message;
      }
    }
    // The agent may have begun a turn by itself meanwhile: a rewind never cuts one (what the files came to is still said).
    if (this.rt.turnActive) return { ok: false, message: note ? `${note} The conversation was not rewound: the agent began working meanwhile.` : 'Stop the current turn first.' };
    const at = item.providerId ? this.chain.indexOf(item.providerId) : -1;
    const lost = this.shutdown();
    if (at > 0) this.resumeAt = this.chain[at - 1];
    else this.rt.update({ providerSessionId: undefined });
    this.chain = at > 0 ? this.chain.slice(0, at) : [];
    const idx = this.rt.items.findIndex((i) => i.id === itemId);
    if (idx >= 0) this.rt.reset(this.rt.items.slice(0, idx));
    this.rt.notice('rewind', 'Rewound the conversation', note || undefined);
    this.tellLost(lost, 'process');
    return { ok: true, message: note || undefined };
  }

  /**
   * Fork at the end of the turn that holds `itemId`: the SDK copies the transcript up to that
   * message into a new session (this one is left as it is). Null when the point is not known.
   */
  async fork(itemId: string): Promise<string | null> {
    const id = this.rt.meta.providerSessionId;
    const cut = cutAt(this.rt.items, itemId);
    if (!id || !cut) return null;
    // A rewound session that has not resumed yet ends at its rewind point.
    const upTo = cut.next ? claudeForkPoint(this.chain, cut.next) : this.resumeAt;
    if (upTo === null) return null;
    const r = await this.provider.withHistory(() => forkSession(id, { dir: this.rt.meta.cwd, ...(upTo ? { upToMessageId: upTo } : {}) }));
    return r.sessionId || null;
  }

  // ── permission prompts ──

  async canUseTool(name: string, input: Obj, o: Obj): Promise<PermissionResult> {
    const rt = this.rt;
    const toolUseId: string | undefined = o.toolUseID;
    const item = toolUseId ? rt.get<ToolItem>(toolUseId) : undefined;

    // Showing a widget changes nothing outside Sable's sandboxed frame: never ask.
    if (name === WIDGET_TOOL_ID) return { behavior: 'allow', updatedInput: input };
    // The Browser tab tools ask for themselves, with the page's host (local pages need no answer).
    if (BROWSER_TOOL_IDS.includes(name)) return { behavior: 'allow', updatedInput: input };
    // The device tools likewise: an emulator is the agent's, a real phone asks in the tool.
    if (DEVICE_TOOL_IDS.includes(name)) return { behavior: 'allow', updatedInput: input };
    // A sub-agent from the other agent: its own steps ask here, as they come, in this session's mode.
    if (agentOfTool(name)) return { behavior: 'allow', updatedInput: input };
    // A fact for the user's profile: Sable checks it (never secrets) and the user can remove it.
    if (name === PROFILE_TOOL_ID) return { behavior: 'allow', updatedInput: input };

    if (name === 'AskUserQuestion') {
      const questions = describeTool(name, input).detail.questions ?? [];
      if (item) rt.patch<ToolItem>(item.id, { status: 'awaiting' });
      const answers = await rt.ask(questions, item?.id, o.signal);
      if (!answers) {
        if (item) rt.patch<ToolItem>(item.id, { status: 'cancelled', endedAt: Date.now() });
        return { behavior: 'deny', message: 'The user dismissed the question without answering.' };
      }
      if (item) rt.patch<ToolItem>(item.id, { status: 'running', result: { answers } });
      return { behavior: 'allow', updatedInput: { ...input, answers: Object.fromEntries(Object.entries(answers).map(([q, a]) => [q, a.join(', ')])) } };
    }

    // Bypass runs everything without asking. Claude Code's own safety checks still send some calls
    // here in that mode (compound commands, deletes with a glob, protected paths): they run too. Only
    // real questions (AskUserQuestion, above) wait for the person.
    // Bypass chosen from a phone while this work ran: its asks still wait (`SessionRuntime.dangerHeld`).
    if (rt.answersAtOnce(bypassesAsking(rt.meta.mode))) {
      if (item && name === 'ExitPlanMode' && input.plan) rt.patch<ToolItem>(item.id, { input, detail: describeTool(name, input).detail });
      return { behavior: 'allow', updatedInput: input };
    }

    const view = describeTool(name, input);
    // The streamed ExitPlanMode call is empty; the CLI fills the plan in only here.
    if (item && name === 'ExitPlanMode' && input.plan) rt.patch<ToolItem>(item.id, { input, detail: view.detail });
    let diff = undefined as ReturnType<typeof previewDiff>;
    if ((name === 'Edit' || name === 'Write') && typeof input.file_path === 'string') {
      const current = await readFile(input.file_path, 'utf8').catch(() => null);
      diff = previewDiff(name, input, current);
    }

    const suggestions = (o.suggestions as PermissionUpdate[] | undefined) ?? [];
    let options: PermissionOption[];
    let scope: PermissionScope | undefined;
    if (name === 'ExitPlanMode') {
      options = [
        { id: 'plan-auto', label: 'Approve and accept edits', tone: 'always' },
        { id: 'plan-ask', label: 'Approve, ask before edits', tone: 'allow' },
        { id: 'deny', label: 'Keep planning', hint: 'Send feedback on the plan', tone: 'deny' },
      ];
    } else {
      options = [{ id: 'allow', label: 'Allow once', tone: 'allow' }];
      const always = !o.suppressAlwaysAllowRule && suggestions.length ? describeSuggestion(suggestions[0], view.detail.path) : undefined;
      if (always) {
        options.push({ id: 'always', label: always.label, hint: always.hint, tone: 'always' });
        // "Always" saves every suggestion, its label names the first (shortened): each one whole, what
        // it does and where it is kept, in the request's words and as data (review wave 6, #5); a kind
        // of change Sable does not name leaves that answer to the desktop.
        scope = compactScope(alwaysScope(suggestions));
      }
      options.push({ id: 'deny', label: 'Deny', hint: 'Tell Claude what to do instead', tone: 'deny' });
    }

    if (item) rt.patch<ToolItem>(item.id, { status: 'awaiting' });
    rt.update({ activity: 'Waiting for your approval' });
    const title = String(o.title || view.title);
    // Claude Code often sends the same sentence as title and description: say it once.
    const description = String(o.description || o.decisionReason || '').trim();
    const answer = await rt.requestPermission(
      {
        itemId: item?.id,
        toolName: name,
        kind: view.kind,
        title,
        description: description && description !== title.trim() ? description : undefined,
        detail: view.detail,
        diff,
        reason: scope ? withScope(o.blockedPath ? `Outside the allowed folders: ${o.blockedPath}` : undefined, scope) : o.blockedPath ? `Outside the allowed folders: ${o.blockedPath}` : undefined,
        ...(scope ? { scope } : {}),
        options,
        allowFeedback: true,
      },
      o.signal,
    );

    if (!answer || answer.optionId === 'deny') {
      if (item) rt.patch<ToolItem>(item.id, { status: 'denied', endedAt: Date.now() });
      const message = answer?.message?.trim()
        ? `The user declined this and said: ${answer.message.trim()}`
        : name === 'ExitPlanMode'
          ? 'The user wants to keep planning. Ask what to change.'
          : 'The user declined this action.';
      return { behavior: 'deny', message, interrupt: !answer };
    }
    if (item) rt.patch<ToolItem>(item.id, { status: 'running' });
    if (answer.optionId === 'plan-auto' || answer.optionId === 'plan-ask') {
      const mode: PermissionMode = answer.optionId === 'plan-auto' ? 'acceptEdits' : 'default';
      rt.update({ mode });
      return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] };
    }
    if (answer.optionId === 'always') {
      const mode = suggestions.find((s) => s.type === 'setMode') as Extract<PermissionUpdate, { type: 'setMode' }> | undefined;
      if (mode) rt.update({ mode: mode.mode });
      return { behavior: 'allow', updatedInput: input, updatedPermissions: suggestions };
    }
    return { behavior: 'allow', updatedInput: input };
  }

  // ── message stream ──

  private stream(parent: string | null): StreamState {
    const key = parent ?? '';
    let s = this.streams.get(key);
    if (!s) {
      s = { blocks: new Map() };
      this.streams.set(key, s);
    }
    return s;
  }

  /**
   * Every frame of the process. Around it: when the process was last heard (its own root work apart,
   * `WAKE_QUIET_MS`), and whose the open turn is. A turn open while a frame of this process is handled
   * runs in it (`ownsTurn`); one that began with the frame is Claude Code's own, not the person's
   * (a notification, a message withdrawn at a stop read after all, a wake), and it ends when it goes
   * quiet if nothing else ends it (`wakeNet`).
   */
  private onMessage(m: SDKMessage) {
    const any = m as Obj;
    const now = Date.now();
    this.heardAt = now;
    if (!any.parent_tool_use_id && !(m.type === 'system' && TASK_FRAMES.has(any.subtype)) && m.type !== 'rate_limit_event' && m.type !== 'prompt_suggestion') this.rootHeardAt = now;
    const rt = this.rt;
    const before = rt.turnActive ? rt.turnStartedAt : -1;
    const seq = this.turnSeq;
    this.handleMessage(m);
    if (m.type === 'system' && TASK_FRAMES.has(any.subtype)) rt.setReportedTasks([...this.backgroundTasks()]);
    if (!rt.turnActive) return;
    if (rt.turnStartedAt !== before || this.turnSeq !== seq) {
      // Begun by Claude Code with this frame: the chat was just used (the Remote Control keeper, the idle close).
      this.agentTurnAt = rt.turnStartedAt;
      this.limitResultOwed = false;
      this.lastActive = now;
      this.armWakeNet();
    }
    this.turnAt = rt.turnStartedAt;
  }

  /**
   * Claude Code works at the root while no turn is open here (review of 23 Nov, D-turn): work it took up
   * after a result, a wake-up with no message to replay, a new process taking up work. It begins a turn
   * of its own, not the person's (`keepHold`: a stop's hold on the queue stays through it), which its
   * result, the CLI's idle or the quiet bound ends. None for a process let go, and none while a turn a
   * stop's safety net settled still owes its result: what comes before that result is that turn's.
   */
  private wake() {
    const rt = this.rt;
    if (rt.turnActive || !this.q || this.closed || this.owed.length) return;
    this.wakes++;
    rt.beginTurn('Thinking', { keepHold: true });
  }

  /** The bound on a turn Claude Code began by itself (`WAKE_QUIET_MS`), looked at again until that turn ends. */
  private armWakeNet(ms = WAKE_QUIET_MS) {
    clearTimeout(this.wakeNet);
    const at = this.agentTurnAt;
    this.wakeNet = setTimeout(() => this.wakeNetDue(at), ms);
    this.wakeNet.unref?.();
  }

  /**
   * A turn Claude Code began by itself has gone quiet: no frame of its own root work for
   * `WAKE_QUIET_MS`, no step of it running, no prompt open, nothing of anyone's waiting for its answer,
   * nothing held, no stop under way, and the CLI not saying it works. It is over: a CLI that never says
   * it is idle never leaves the chat "Thinking". Should the agent go on after all, its next output begins
   * a turn again.
   */
  private wakeNetDue(at: number) {
    const rt = this.rt;
    if (!rt.turnActive || rt.turnStartedAt !== at || this.agentTurnAt !== at || !this.q) return;
    const quiet = Date.now() - Math.max(this.rootHeardAt, at);
    const busy = !!this.held || this.interrupted || this.promptsOpen() || this.cliBusy() || this.rootStepRunning();
    if (busy || quiet < WAKE_QUIET_MS) return this.armWakeNet(busy ? WAKE_QUIET_MS : WAKE_QUIET_MS - quiet + 50);
    if (this.unread()) return this.unreadNetDue(at);
    this.log('claude: a turn the agent began went quiet with no end; it is over');
    this.finishTurn(undefined, false, this.awaiting.size > 0);
  }

  /** Whether a root step of the open turn still runs (a call the agent waits on). */
  private rootStepRunning(): boolean {
    const from = this.rt.turnStartedAt;
    const items = this.rt.items;
    for (let k = items.length - 1, n = 0; k >= 0 && n < 5_000; k--, n++) {
      const i = items[k];
      if (!i.parentId && i.type === 'tool' && i.ts >= from && (i.status === 'running' || i.status === 'pending' || i.status === 'awaiting')) return true;
    }
    return false;
  }

  private handleMessage(m: SDKMessage) {
    const any = m as Obj;
    if (any.session_id && any.session_id !== this.rt.meta.providerSessionId) this.rt.update({ providerSessionId: any.session_id });
    if (this.booting) {
      // The process is up and the turn has reached the model.
      this.booting = false;
      if (this.rt.turnActive && this.rt.meta.activity === 'Starting') this.rt.update({ activity: 'Thinking' });
    }
    // A reply stamped with the messages its turn took: one of Sable's is taken there, before the reply shows.
    if ((m.type === 'assistant' || m.type === 'stream_event') && !any.parent_tool_use_id) this.stamped(any);
    switch (m.type) {
      case 'stream_event':
        return this.onStreamEvent(any.event, any.parent_tool_use_id ?? null);
      case 'assistant':
        return this.onAssistant(any);
      case 'user':
        return this.onUser(any);
      case 'result':
        return this.onResult(any);
      case 'system':
        return this.onSystem(any);
      case 'conversation_reset': {
        const session = any.new_conversation_id;
        if (typeof session === 'string' && session) {
          this.lastTotalCost = 0;
          this.costFresh = false;
          this.rt.update({ providerSessionId: session, usage: { ...this.rt.meta.usage, cliCost: { session, total: 0 } } });
        }
        return;
      }
      case 'rate_limit_event': {
        // The windows come with the event itself: no usage read needed.
        const hit = this.provider.onRateLimit(any.rate_limit_info);
        if (hit) {
          this.limitHit = hit;
          for (const [uuid, id] of this.turnLimits) {
            const limit = this.rt.get<NoticeItem>(id)?.limit;
            if (limit && (!limit.window || limit.window === hit.window)) this.showTurnLimit(hit, uuid);
          }
        }
        return;
      }
      case 'prompt_suggestion':
        this.rt.setSuggestion(any.suggestion);
        return;
      default:
        return;
    }
  }

  private onStreamEvent(ev: Obj, parent: string | null) {
    const rt = this.rt;
    const s = this.stream(parent);
    const parentId = parent ?? undefined;
    switch (ev.type) {
      case 'message_start':
        s.messageId = ev.message?.id;
        s.blocks.clear();
        break;
      case 'content_block_start': {
        const b = ev.content_block ?? {};
        // The model writes at the root while no turn is open: Claude Code's own work, in a turn of its own
        // (begun before the first thing it writes is shown).
        if (!parent && (b.type === 'text' || b.type === 'thinking' || b.type === 'tool_use' || b.type === 'server_tool_use')) this.wake();
        if (b.type === 'text') {
          const item = rt.add<TextItem>({ type: 'text', text: b.text ?? '', streaming: true, parentId });
          s.blocks.set(ev.index, { itemId: item.id, type: 'text', json: '' });
          if (!parent) rt.update({ activity: 'Writing' });
        } else if (b.type === 'thinking') {
          const item = rt.add<ThinkingItem>({ type: 'thinking', text: b.thinking ?? '', streaming: true, parentId });
          s.blocks.set(ev.index, { itemId: item.id, type: 'thinking', json: '' });
          if (!parent) rt.update({ activity: 'Thinking' });
        } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
          const view = describeTool(b.name, {});
          if (!rt.get(b.id)) {
            rt.add<ToolItem>({ id: b.id, type: 'tool', name: b.name, ...view, status: 'pending', inputText: '', parentId });
          }
          s.blocks.set(ev.index, { itemId: b.id, type: 'tool', name: b.name, json: '' });
          if (!parent) rt.update({ activity: view.title });
        }
        break;
      }
      case 'content_block_delta': {
        const blk = s.blocks.get(ev.index);
        const d = ev.delta ?? {};
        if (!blk) break;
        if (d.type === 'text_delta') rt.delta(blk.itemId, 'text', d.text ?? '');
        else if (d.type === 'thinking_delta') rt.delta(blk.itemId, 'text', d.thinking ?? '');
        else if (d.type === 'input_json_delta') {
          blk.json += d.partial_json ?? '';
          // browser_sign_in's input never streams into the timeline: it is published once cleaned (toolReady).
          if (streamsInput(blk.name)) rt.delta(blk.itemId, 'inputText', d.partial_json ?? '');
          // A widget's title is all there is to peek at; its code can be long, so stop looking once found.
          if (blk.peeked && blk.name === WIDGET_TOOL_ID) break;
          // Surface the file / command as soon as it has streamed in.
          const peek = peekPartialInput(blk.json);
          const sig = JSON.stringify(peek);
          if (sig !== blk.peeked && Object.keys(peek).length) {
            blk.peeked = sig;
            const view = describeTool(blk.name!, peek);
            rt.patch<ToolItem>(blk.itemId, { title: view.title, detail: view.detail });
            if (!parent) rt.update({ activity: view.title });
          }
        }
        break;
      }
      case 'content_block_stop': {
        const blk = s.blocks.get(ev.index);
        if (!blk) break;
        if (blk.type === 'text') rt.patch<TextItem>(blk.itemId, { streaming: false });
        else if (blk.type === 'thinking') rt.patch<ThinkingItem>(blk.itemId, { streaming: false, endedAt: Date.now() });
        else {
          let input: Obj = {};
          try {
            input = blk.json ? JSON.parse(blk.json) : {};
          } catch {
            /* the full assistant message will carry the parsed input */
          }
          this.toolReady(blk.itemId, blk.name!, input);
        }
        break;
      }
      default:
        break;
    }
  }

  /** A tool call's input is complete: finalize its view and start "running". */
  private toolReady(id: string, name: string, input: Obj) {
    const rt = this.rt;
    const item = rt.get<ToolItem>(id);
    if (!item) return;
    const view = describeTool(name, input);
    const patch: Partial<ToolItem> = { input: cleanToolInput(name, input) as Obj, title: view.title, detail: view.detail, kind: view.kind, inputText: undefined };
    if (item.status === 'pending') patch.status = 'running';
    if ((name === 'Edit' || name === 'Write') && !item.result) patch.result = { diff: previewDiff(name, input) };
    if (name === 'Workflow' && !item.workflow) patch.workflow = workflowStart(input);
    rt.patch<ToolItem>(id, patch);
    if (name === 'TodoWrite') rt.setTodos(normalizeTodos(input.todos));
    if (!item.parentId) rt.update({ activity: view.title });
  }

  /** A message_start alone is no proof that this particular block reached the timeline. */
  private confirmStreamed(parent: string | undefined, message: string | undefined, type: 'text' | 'thinking', full: string): boolean {
    const stream = this.streams.get(parent ?? '');
    if (!message || stream?.messageId !== message) return false;
    for (const block of stream.blocks.values()) {
      if (block.type !== type || block.confirmed) continue;
      const item = this.rt.get<TextItem | ThinkingItem>(block.itemId);
      if (item?.type !== type || !full.startsWith(item.text)) continue;
      block.confirmed = true;
      if (item.text !== full || item.streaming) this.rt.patch<TextItem | ThinkingItem>(item.id, { text: full, streaming: false });
      return true;
    }
    return false;
  }

  private onAssistant(m: Obj) {
    const rt = this.rt;
    const parentId: string | undefined = m.parent_tool_use_id ?? undefined;
    const msg = m.message ?? {};
    const synthetic = msg.model === '<synthetic>';
    // Keyed by uuid, not message.id: the CLI sends one assistant message per content block under one id.
    // After /compact it re-sends local command output (/context, /cost) it already showed.
    const texts = ((msg.content as Obj[] | undefined) ?? []).filter((b) => b.type === 'text' && b.text).map((b) => String(b.text));
    const repeat = (m.uuid && this.seenMessages.has(m.uuid)) || (synthetic && !m.error && this.compacted && texts.length > 0 && texts.every((t) => this.syntheticTexts.has(t)));
    if (m.uuid) this.seenMessages.add(m.uuid);
    if (repeat) return;
    if (m.uuid && !parentId) this.chain.push(m.uuid);
    if (this.retryNotice) {
      rt.remove(this.retryNotice);
      this.retryNotice = undefined;
    }
    // Refused at a plan limit: the CLI's own words ("usage limit reached…") become the limit notice, not a reply.
    // The turn's own request: its notice. A sub-agent's, or anything outside a turn (background agents
    // working on after the turn ended): no notice of its own; the step stops at the limit and the
    // bridge says it once for the chat (`SessionRuntime.limitInBackground`).
    const refusedAtLimit = m.error === 'rate_limit';
    if (refusedAtLimit && m.rate_limit_info) this.limitHit = this.provider.onRateLimit(m.rate_limit_info) ?? this.limitHit;
    const atLimit = refusedAtLimit && !parentId && rt.turnActive && !this.autonomousTurn();
    // Claude Code's own words for a request that failed (an API error, a refusal at a limit): said by
    // the notice below, never as the agent's answer. Its stand-in "No response requested." (written
    // when a cut conversation is taken up again, and as a refused request's words) is nobody's words.
    const standIn = synthetic && texts.length > 0 && texts.every(isStandIn);
    const failedWords = (!!m.error || texts.some(isAuthFailure)) && synthetic;
    // The agent's own output at the root while no turn is open begins one (`wake`), after the refusal
    // above is read: a refusal at a limit outside the person's turn stays the background's to decide
    // (`limitInBackground`). A frame Claude Code wrote itself (a stand-in, a refusal, an error) is no work.
    if (!parentId && !synthetic && !m.error && ((msg.content as Obj[] | undefined) ?? []).some((b) => (b.type === 'text' && b.text) || (b.type === 'thinking' && b.thinking) || b.type === 'tool_use' || b.type === 'server_tool_use')) this.wake();
    if (synthetic) for (const t of texts) this.syntheticTexts.add(t);
    for (const b of (msg.content as Obj[] | undefined) ?? []) {
      if (b.type === 'tool_use' || b.type === 'server_tool_use') {
        if (!rt.get(b.id)) {
          const view = describeTool(b.name, b.input ?? {});
          rt.add<ToolItem>({ id: b.id, type: 'tool', name: b.name, ...view, status: 'pending', parentId });
        }
        this.toolReady(b.id, b.name, b.input ?? {});
      } else if (!refusedAtLimit && !standIn && !failedWords && b.type === 'text' && b.text && !this.confirmStreamed(parentId, msg.id, 'text', b.text)) {
        if (synthetic && !parentId && this.compacted && isCompactOutput(b.text, true)) continue;
        rt.add<TextItem>({ type: 'text', text: b.text, streaming: false, parentId });
      } else if (b.type === 'thinking' && b.thinking && !this.confirmStreamed(parentId, msg.id, 'thinking', b.thinking)) {
        rt.add<ThinkingItem>({ type: 'thinking', text: b.thinking, streaming: false, endedAt: Date.now(), parentId });
      }
    }
    if (refusedAtLimit) {
      const hit = this.refusal(texts.join(' '));
      const provisional = !parentId && !rt.turnActive && this.provisionalAtRest();
      if (provisional) {
        // Its UUID may still prove this was a separate app request. The existing wake
        // bound hands it off at rest if no identifying result follows.
        this.wake();
        this.wakeLimit = { hit, provisional: provisional.uuid };
      } else if (atLimit) this.showTurnLimit(hit, resultUuids(m).at(-1) ?? (this.awaiting.size === 1 ? this.awaiting.keys().next().value : undefined));
      else if (!parentId && rt.turnActive) this.wakeLimit = { hit };
      else {
        if (!parentId) this.limitResultOwed = true;
        rt.limitInBackground(parentId ? { ...hit, stepId: parentId } : hit);
      }
    } else if (refusedForSignIn(m.error, synthetic ? texts : [])) {
      // Refused for the sign-in (its words are Claude Code's, never an answer): no red box per request.
      // When the turn ends the bridge asks the CLI whether the account is signed in, sends once more
      // when it is, and says it once for the chat when it is not (server/core/auth-gate.ts).
      noteAuthFailure(rt.id, parentId ? rt.get<ToolItem>(parentId)?.title : undefined, turnOf(rt));
    } else if (m.error) {
      const words = failedWords ? texts.join('\n').trim() : '';
      rt.notice('error', errorLabel(m.error), words && !isStandIn(words) && words !== errorLabel(m.error) ? words : undefined);
    }
    // Local command output carries zero usage: it says nothing about the context size.
    if (!parentId && !synthetic) {
      const u = msg.usage as Obj | undefined;
      const ctx = m.context_usage as Obj | undefined;
      const patch: Partial<SessionUsage> = {};
      if (ctx?.total_tokens) {
        patch.contextTokens = ctx.total_tokens;
        patch.contextWindow = ctx.raw_max_tokens;
      } else if (u) {
        patch.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
      }
      if (Object.keys(patch).length) rt.update({ usage: { ...rt.meta.usage, ...patch } });
    }
  }

  private onUser(m: Obj) {
    const rt = this.rt;
    if (m.isReplay) {
      if (m.parent_tool_use_id) return;
      // One of Sable's own whose turn's bookkeeping let it go before Claude Code took it (a result named
      // it, or its turn ended, first): still the person's message, never one from the Claude app.
      if (m.uuid && this.takeOwn(m.uuid, 'replay')) return;
      // The same message replayed again (a reconnect, a repeat) is already in the conversation.
      if (m.uuid && (this.chain.includes(m.uuid) || rt.items.some((i) => i.type === 'user' && i.providerId === m.uuid))) return;
      const content = m.message?.content;
      const text = replayText(content);
      if (this.compacted && isCompactOutput(text)) return;
      // Written by Claude Code in the person's place (a task finished, a command and its output):
      // shown as a line (shared/synthetic.ts), never as a message from the Claude app.
      const syn = text ? parseSynthetic(text) : null;
      // A slash command Sable sent comes back in the CLI's own tags (`<command-name>/compact</command-name>…`).
      const echo = syn?.role === 'command' ? syntheticLine(syn) : '';
      // One of ours under another uuid (a steer the CLI folded in): only one it has not read yet, and only
      // by its very words. A message from the app that merely holds them stays the app's; one with the
      // same words is the app's again once ours comes back under its own uuid (`unalias`).
      const mine = this.ownByWords(text, echo, content);
      if (mine) {
        const [uuid, o, identified] = mine;
        if (o.guessed) this.takeOwn(uuid, 'match');
        this.reclaim(uuid, m.uuid ?? uuid, !this.unmatchedResults.get(m.uuid)?.pending.has(uuid));
        this.pendingUsers.delete(uuid);
        this.markRead(uuid);
        o.read = true;
        if (m.uuid && m.uuid !== uuid) {
          // A result may name it by either uuid.
          this.aliases.set(m.uuid, uuid);
          if (identified) this.confirmDelivery(o);
          // A second verified spelling can coexist with an earlier ambiguous app replay.
          if (!o.alias || o.alias.identified) {
            o.alias = { uuid: m.uuid, text, attachments: appPictures(content, APP_PICTURES), at: Date.now(), identified, after: rt.items.at(-1)?.id };
          }
        }
        if (m.uuid) this.chain.push(m.uuid);
        if (!o.answered || identified) this.takeCard(o, m.uuid);
        this.bindEarlierResult(uuid, o, m.uuid);
        return;
      }
      const synthetic = !!syn || m.isSynthetic === true;
      const pictures = synthetic ? undefined : appPictures(content, APP_PICTURES);
      if (!text && !pictures) return;
      if (m.uuid) this.chain.push(m.uuid);
      // Claude Code's own (a background task ended, a teammate wrote): it wakes the model with a turn of
      // its own, whose result names no message, or is folded into the running turn and has none.
      if (synthetic) {
        if (syn) rt.add<UserItem>({ type: 'user', text, state: 'sent', providerId: m.uuid });
        // Marked as Claude Code's with no wrapper Sable knows (C4): its line, never the person's words
        // nor a message from the app.
        else {
          const plain = stripWrappers(text).trim() || text.trim();
          const nl = plain.indexOf('\n');
          const head = (nl < 0 ? plain : plain.slice(0, nl)).trim();
          const rest = nl < 0 ? '' : plain.slice(nl + 1).trim();
          rt.notice('info', head.length > 160 ? `${head.slice(0, 159)}…` : head, rest ? (rest.length > 2000 ? `${rest.slice(0, 1999)}…` : rest) : undefined);
        }
        // Output, summaries and wrappers belong to the turn they came in; a notification or a command opens one.
        if (syn?.role === 'output' || syn?.role === 'summary' || syn?.role === 'hidden') return;
        this.wakes++;
        // Not the person's: a stop's hold on the queue stays through the turn it wakes.
        if (!rt.turnActive) rt.beginTurn('Thinking', { keepHold: true });
        return;
      }
      // A message sent from elsewhere (Remote Control in the Claude app or on claude.ai): it belongs
      // in this conversation, with its pictures (bounded), and the turn it starts runs here too.
      rt.add<UserItem>({ type: 'user', text, ...(pictures ? { attachments: pictures } : {}), state: 'sent', providerId: m.uuid, remote: true });
      // It gets a result of its own (or is folded into the running turn's): either way the turn waits for it.
      this.awaiting.set(m.uuid || `remote-${randomUUID()}`, { read: true });
      if (!rt.turnActive) rt.beginTurn('Thinking');
      else rt.personSent();
      return;
    }
    if (m.uuid && !m.parent_tool_use_id) this.chain.push(m.uuid);
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    // A call's result at the root while no turn is open: Claude Code works on, in a turn of its own.
    if (!m.parent_tool_use_id && (content as Obj[]).some((b) => b?.type === 'tool_result')) this.wake();
    for (const b of content as Obj[]) {
      if (b.type !== 'tool_result') continue;
      const item = rt.get<ToolItem>(b.tool_use_id);
      if (!item) continue;
      const result = mapResult(item.name, (item.input as Obj) ?? {}, m.tool_use_result, b.content, !!b.is_error);
      const status = item.status === 'denied' || item.status === 'cancelled' ? item.status : b.is_error ? 'error' : 'done';
      // Keep answers / preview diff when the result itself carries less.
      const merged = { ...item.result, ...result, diff: result.diff ?? item.result?.diff, answers: result.answers ?? item.result?.answers };
      if (item.result?.agent?.taskId && result.agent) {
        const previous = item.result.agent;
        merged.agent = { ...previous, ...result.agent };
        if (this.endedTasks.has(item.result.agent.taskId) && previous.background) merged.agent.background = previous.background;
      }
      if (status === 'denied') merged.diff = item.result?.diff;
      const limit = merged.agent?.limit;
      if (limit && !limit.resetsAt) {
        const resetsAt = this.provider.windowReset(limit.window) ?? (this.limitHit?.window === limit.window ? this.limitHit.resetsAt : undefined);
        if (resetsAt) merged.agent = { ...merged.agent, limit: { ...limit, resetsAt } };
      }
      // A step already settled (cancelled when its turn was cut or settled, or denied) keeps the end it
      // got then: a result that comes hours later is no measure of its work.
      rt.patch<ToolItem>(item.id, { status, result: merged, ...(item.status === 'cancelled' || item.status === 'denied' ? {} : { endedAt: Date.now() }) });
      this.trackTasks(item, m.tool_use_result);
      this.trackLive(item, (item.input as Obj) ?? {}, m.tool_use_result);
    }
    if (!m.parent_tool_use_id && rt.turnActive) rt.update({ activity: 'Thinking' });
  }

  /**
   * What a call's result says of work left in the process: the background task it started (a command's
   * `backgroundTaskId`, a monitor's `taskId`; the tie needs no task event), a foreground task it waited
   * on, which ends with this result, and a wake-up it scheduled or cancelled.
   */
  private trackLive(item: ToolItem, input: Obj, structured: unknown) {
    const bg = backgroundTaskOf(item.name, structured);
    for (const [task, step] of [...this.taskItems]) if (step === item.id && this.foreground.has(task) && task !== bg?.id) this.taskOver(task, 'done');
    if (bg && !this.endedTasks.has(bg.id) && !this.ambient.has(bg.id)) {
      // Its call returned with the task still running (moved to the background at its timeout, or by the person): it goes on.
      this.foreground.delete(bg.id);
      this.liveTasks.add(bg.id);
      if (item.name !== 'SendMessage') this.taskItems.set(bg.id, item.id);
      this.noteTask(bg.id, bg.kind, item.name);
      if (bg.kind === 'agent') this.linkAgentRun({ task_id: bg.id, task_type: 'local_agent', tool_use_id: item.id, description: input.summary ?? input.description });
      this.backgrounded(bg.id, this.rt.get<ToolItem>(item.id));
      this.rt.setReportedTasks([...this.backgroundTasks()]);
    }
    const wake = wakeOf(item.name, input, structured);
    if (wake?.loop !== undefined) this.loopWakeAt = wake.loop ?? undefined;
    if (wake?.cron) {
      if (wake.cron.at) this.cronWakes.set(wake.cron.id, wake.cron.at);
      else this.cronWakes.delete(wake.cron.id);
      // A chat that schedules many keeps the newest few.
      while (this.cronWakes.size > 32) this.cronWakes.delete(this.cronWakes.keys().next().value as string);
    }
  }

  /** TaskCreate / TaskUpdate (the newer task tools) → the pinned task list. */
  private trackTasks(item: ToolItem, structured: unknown) {
    const input = (item.input as Obj) ?? {};
    const r = (structured && typeof structured === 'object' ? structured : {}) as Obj;
    if (item.name === 'TaskCreate') {
      const id = String(r.task?.id ?? r.id ?? this.tasks.size + 1);
      this.tasks.set(id, { id, content: String(input.subject ?? r.task?.subject ?? ''), activeForm: input.activeForm, status: 'pending' });
    } else if (item.name === 'TaskUpdate') {
      const id = String(input.taskId ?? '');
      const t = this.tasks.get(id);
      if (input.status === 'deleted') this.tasks.delete(id);
      else if (t) {
        if (input.status === 'completed' || input.status === 'in_progress' || input.status === 'pending') t.status = input.status;
        if (input.subject) t.content = String(input.subject);
        if (input.activeForm) t.activeForm = String(input.activeForm);
      }
    } else return;
    this.rt.setTodos([...this.tasks.values()]);
  }

  /**
   * Messages still pending at a normal turn end are taken, even when no replay said so.
   * Each card gets the uuid it went with (D-own): a replay of it that comes after all is a repeat of a
   * message of Sable's own, also once the chat is read again.
   */
  private takeUsers() {
    for (const [uuid, itemId] of this.pendingUsers) {
      this.pendingUsers.delete(uuid);
      const card = this.rt.get<UserItem>(itemId);
      if (card?.type === 'user' && (card.state === 'queued' || !card.providerId)) this.rt.taken(itemId, { providerId: uuid });
    }
  }

  /**
   * Place a queued steer at its acknowledgement. A late stamp or result may identify a reply
   * that is already on screen. Keep those same text items below the card, including a block
   * still receiving deltas. Work from an earlier result or before a tool call stays in place.
   */
  private takeCard(own: OwnSend, providerId: string, reply?: Set<string> | 'result') {
    const rt = this.rt;
    const card = rt.get<UserItem>(own.itemId);
    if (card?.state !== 'queued') {
      rt.taken(own.itemId, { providerId });
      return;
    }
    const tail: string[] = [];
    for (let i = rt.items.length - 1; i >= 0; i--) {
      const row = rt.items[i];
      if (row.id === card.id) break;
      if (row.parentId || (row.type === 'user' && row.state === 'queued')) continue;
      if (row.type !== 'text') break;
      tail.push(row.id);
    }
    tail.reverse();
    // A replay can arrive between the text delta and the full assistant frame.
    const streamed = this.streams.get('')?.blocks.values() ?? [];
    const known = reply ?? new Set(Array.from(streamed).filter((b) => !b.confirmed && b.type === 'text').map((b) => b.itemId));
    rt.taken(card.id, { providerId });
    own.crossed = tail.filter((id) => known !== 'result' && !known.has(id));
    for (const id of tail) if (known === 'result' || known.has(id)) rt.move(id, {}, true);
  }

  /** A withdrawn send was consumed after all. Preserve any edits to the copy waiting in the queue. */
  private reclaim(uuid: string, providerId: string, awaitsResult = true): boolean {
    const back = this.withdrawn.get(uuid);
    if (!back) return false;
    this.withdrawn.delete(uuid);
    const rt = this.rt;
    const copy = rt.queue.find((q) => q.id === back.itemId);
    let id = back.itemId;
    if (copy) {
      if (!samePayload(copy, back) || !rt.takeQueued(id)) id = randomUUID();
    } else if (!rt.get(id)) id = this.sentAgain(back) ?? id;
    const card = rt.get(id);
    if (card?.type === 'user' && samePayload(card, back)) rt.taken(id, { providerId });
    else {
      if (card) id = randomUUID();
      rt.add<UserItem>({ id, type: 'user', text: back.text, attachments: back.attachments, steered: back.steered, state: 'sent', providerId });
    }
    const own = this.own.get(uuid);
    if (own) {
      own.read = true;
      own.itemId = id;
    }
    if (awaitsResult) this.awaiting.set(uuid, { read: true });
    this.sentItems.set(uuid, id);
    rt.expectOutcome(id);
    this.forgive(uuid);
    if (awaitsResult && !rt.turnActive) rt.beginTurn('Thinking', { keepHold: true });
    this.release();
    return true;
  }

  /** The previously unidentified result was this card's. Restore its position before that reply. */
  private bindEarlierResult(uuid: string, own: OwnSend, replay: string) {
    const paid = this.unmatchedResults.get(replay);
    if (!paid?.pending.has(uuid)) return;
    this.unmatchedResults.delete(replay);
    own.answered = true;
    this.awaiting.delete(uuid);
    this.retire([uuid], paid.error ? 'failed' : 'ok', paid.result);
    const rt = this.rt;
    const card = rt.get<UserItem>(own.itemId);
    const anchor = rt.items.findIndex((i) => i.id === paid.before);
    if (card && anchor >= 0 && rt.items.indexOf(card) > anchor) {
      const ordered = rt.items.filter((i) => i.id !== card.id);
      ordered.splice(anchor, 0, card);
      rt.reset(ordered);
    }
    if (card?.steered && paid.final) this.finishSteerReply(own, paid.final, paid.result);
    if (rt.turnActive && this.turnSeq === paid.turn && !this.awaiting.size) this.finishTurn(paid.error, false);
  }

  /** Claude Code read a message of ours (it replayed it). */
  private markRead(uuid: string) {
    const a = this.awaiting.get(uuid);
    if (a) a.read = true;
  }

  /** Whether a message of ours is still on its way to Claude Code (sent, not read): its own turn is still to come. */
  private unread(): boolean {
    for (const a of this.awaiting.values()) if (!a.read) return true;
    return false;
  }

  /** The cards of Sable's own messages still on their way to Claude Code (sent, not read), oldest first. */
  private unreadOwn(): string[] {
    const out: string[] = [];
    for (const [uuid, a] of this.awaiting) {
      const o = a.read ? undefined : this.own.get(uuid);
      if (o) out.push(o.itemId);
    }
    return out;
  }

  /** The CLI names the messages a result answers: every session of this provider reads its results so from now on. */
  private learnNames() {
    this.provider.seen.names = true;
  }

  /**
   * Claude Code took message `uuid` of Sable's own: its replay (`replay`), or a reply frame stamped with
   * it (`stamp`). False when the uuid is not one Sable sent. On its way, it is taken where the agent
   * took it. Let go by its turn's bookkeeping first (a result named it, or its turn ended, before
   * Claude Code read it): still the person's message, never one from the Claude app; it stands where
   * the agent took it. A result already naming it is proof of delivery, so a subsequent replay
   * leaves its card and turn in place.
   */
  private takeOwn(uuid: string, via: 'replay' | 'stamp' | 'match', reply?: Set<string>): boolean {
    const o = this.own.get(uuid);
    if (!o) return this.reclaim(uuid, uuid);
    if (via !== 'match') this.confirmDelivery(o);
    const rt = this.rt;
    // Its canonical identity distinguishes this send from a provisional match with the same content.
    if (o.alias && !o.alias.identified) this.unalias(o, uuid);
    if (via === 'replay') {
      if (o.replayed) return true;
      o.replayed = true;
      if (!this.chain.includes(uuid)) this.chain.push(uuid);
    }
    if (this.reclaim(uuid, uuid)) return true;
    const itemId = this.pendingUsers.get(uuid);
    if (itemId) {
      // From here on what the agent writes was written knowing the message.
      this.pendingUsers.delete(uuid);
      this.markRead(uuid);
      o.read = true;
      this.takeCard(o, uuid, reply);
      return true;
    }
    if (o.read || o.answered) return true;
    o.read = true;
    const card = rt.get<UserItem>(o.itemId);
    // Only from the process it went to, and soon after: anything else is a repeat of what was settled.
    if (o.q !== this.q || !this.q || Date.now() - o.at > OWN_LATE_MS) {
      if (card?.type === 'user' && !card.providerId) rt.patch<UserItem>(card.id, { providerId: uuid });
      return true;
    }
    if (card?.type === 'user') rt.move(card.id, { state: 'sent', providerId: uuid } as Partial<TimelineItem>, true);
    else {
      // Taken back to the queue meanwhile (a stop, a failure): out of it again, never sent twice. A
      // message Sable sent with no card of its own (a carry-on) stays unseen.
      const copy = rt.queue.find((q) => q.id === o.itemId);
      if (copy && rt.takeQueued(copy.id)) rt.add<UserItem>({ id: copy.id, type: 'user', text: copy.text, attachments: copy.attachments, state: 'sent', providerId: uuid });
    }
    this.awaiting.set(uuid, { read: true });
    this.sentItems.set(uuid, o.itemId);
    rt.expectOutcome(o.itemId);
    // Its result answers it in the turn it begins now, never as a settled turn's debt (`owe`).
    this.forgive(uuid);
    // Begun by Claude Code, not by a send: a stop's hold on the queue stays through it.
    if (!rt.turnActive) rt.beginTurn('Thinking', { keepHold: true });
    return true;
  }

  /**
   * A message from the Claude app was taken for Sable's own `o` by its words, and `o` came back under
   * its own uuid: the app's message was the app's. It gets its own card (with its pictures), at the
   * time it came; `o`'s card keeps its own uuid. What the app's message's result says, it says for it.
   */
  private unalias(o: OwnSend, uuid: string) {
    const a = o.alias!;
    o.alias = undefined;
    this.aliases.delete(a.uuid);
    const rt = this.rt;
    const card = rt.get<UserItem>(o.itemId);
    if (card) rt.patch<UserItem>(card.id, { providerId: uuid });
    const remote = rt.add<UserItem>({ ts: a.at, type: 'user', text: a.text, attachments: a.attachments, state: 'sent', providerId: a.uuid, remote: true });
    if (a.answer) {
      // Its result named only the app's UUID. Replace the provisional card in that exchange
      // and let the canonical acknowledgement take Sable's send here.
      rt.answered([remote.id], a.answer.outcome, a.answer.resultId);
      if (card) {
        const place = rt.items.indexOf(card);
        const ordered = rt.items.filter((i) => i !== remote && i !== card);
        ordered.splice(place, 0, remote);
        ordered.push(card);
        rt.reset(ordered);
      }
      o.answered = false;
    } else {
      this.awaiting.set(a.uuid, { read: true });
      if (!rt.turnActive) rt.beginTurn('Thinking');
    }
    if (!o.answered) o.read = false;
  }

  /**
   * A message of Sable's own that Claude Code has not read yet whose very words a replay under another
   * uuid has (wrappers, the steer note and Sable's additions aside): the oldest. Never by a part of the
   * words. A result can precede the replay, including when the CLI rewrites its UUID.
   */
  private ownByWords(text: string, echo: string, content: unknown): [string, OwnSend, boolean] | undefined {
    const said = plainWords(text);
    const command = plainWords(echo);
    const images = Array.isArray(content) ? content.filter((b) => b?.type === 'image') : [];
    if (!said && !command && !images.length) return;
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
    const textBlocks = new Set(blocks.filter(b => b?.type === 'text').map(b => b.text));
    let late: [string, OwnSend, boolean] | undefined;
    for (const [uuid, o] of this.own) {
      const decorated = o.proofBlocks.some(block => textBlocks.has(block));
      if (!decorated && (o.alias || textBlocks.has(STEER_FIRST_BLOCK))) continue;
      const withdrawn = this.withdrawn.get(uuid);
      const pending = o.q === this.q && (this.pendingUsers.has(uuid) || !!withdrawn);

      if (!decorated && (o.q !== this.q || o.replayed || (!pending && !o.answered && !o.guessed))) continue;
      if (!pending && Date.now() - o.at > OWN_LATE_MS) continue;
      const attachments = withdrawn?.attachments ?? this.rt.get<UserItem>(o.itemId)?.attachments ?? [];
      const files = attachments.some((a) => a.kind !== 'image' && a.path);
      const sameWords = said === o.sent || (!files && (said === o.words || (!!command && command === o.words)));
      if (!sameWords) continue;
      const sentImages = attachments.filter((a) => a.kind === 'image' && a.dataUrl);
      if (images.length !== sentImages.length || !images.every((b, i) => b.source?.type === 'base64' && sentImages[i].dataUrl === `data:${b.source.media_type};base64,${b.source.data}`)) continue;
      if (pending) return [uuid, o, decorated];
      late = [uuid, o, decorated];
    }
    return late;
  }

  /**
   * A steer withdrawn at a stop that the person sent again from the queue (its words, after the stop):
   * the card that went then, if it is still there.
   */
  private sentAgain(back: UserPayload & { at: number }): string | undefined {
    for (const o of this.own.values()) {
      if (o.at < back.at) continue;
      const card = this.rt.get<UserItem>(o.itemId);
      if (card?.type === 'user' && samePayload(card, back)) return card.id;
    }
    return undefined;
  }

  /**
   * A reply frame stamped with the messages its turn took (`user_message_uuids`): this CLI names them,
   * and each of Sable's own is taken there, also one Claude Code folded in and never replays.
   */
  private stamped(m: Obj) {
    const named = resultUuids(m);
    if (!named.length) return;
    this.learnNames();
    const stream = this.streams.get('');
    const message = m.type === 'assistant' ? m.message?.id : m.event?.type === 'message_start' ? m.event.message?.id : stream?.messageId;
    const reply = new Set<string>();
    if (stream && message && stream.messageId === message) {
      for (const block of stream.blocks.values()) if (block.type === 'text') reply.add(block.itemId);
    }
    for (const u of named) this.takeOwn(u, 'stamp', reply);
  }

  /**
   * The chat's limit card its background work wrote, while nothing is decided on it yet: a turn refused
   * at the same limit is said by it. A decided one (moved on, or waiting for its reset) is history,
   * and a new refusal gets a card of its own, which the bridge decides again (review of 23 Nov, D4).
   */
  private openLimitCard(window?: string): string | undefined {
    const id = this.rt.limitCard;
    const card = id ? this.rt.get<NoticeItem>(id) : undefined;
    if (card?.type !== 'notice' || !card.limit || card.limit.provider || card.limit.continuedWith) return;
    if (window && card.limit.window && window !== 'Plan limit' && card.limit.window !== 'Plan limit' && window !== card.limit.window) return;
    return card.id;
  }

  /**
   * The messages a result answers, by identity. Named (`user_message_uuids`, or `user_message_uuid`):
   * those. Named none: in a CLI that names what its turns answer, none (a turn Claude Code began by
   * itself), unless it failed (a zeroed result: what it read last); in an older one, one message, the
   * oldest it has read. A message Claude Code has not read yet is never answered by a result that does
   * not name it once the CLI is known to name what its results answer (by any session of this
   * provider), nor while it says sends still wait (`queued_turn_count`); only a CLI never seen to name
   * one answers its messages in order (review of 23 Nov, D-own; a message that never comes back is
   * bounded by `armUnreadNet`).
   */
  private answer(m: Obj, named: string[]): string[] {
    if (named.length) {
      this.learnNames();
      const ids = named.map((u) => this.aliases.get(u) ?? u);
      // The messages this result answers for (a steer folded into the turn is one of them).
      for (const id of ids) this.awaiting.delete(id);
      for (const u of named) this.aliases.delete(u);
      return ids;
    }
    const failed = m.subtype !== 'success' || !!m.is_error;
    if (this.namesMessages && (!failed || this.wakes > 0)) return [];
    for (const [id, a] of this.awaiting) {
      if (!a.read) continue;
      this.awaiting.delete(id);
      return [id];
    }
    if (this.wakes > 0 || this.namesMessages || Number(m.queued_turn_count) > 0) return [];
    // A CLI never seen to name what its results answer (an older one): each result answers one, the oldest.
    const oldest = this.awaiting.keys().next().value;
    if (oldest === undefined) return [];
    this.awaiting.delete(oldest);
    return [oldest];
  }

  /**
   * Messages of ours a result (or the turn's end) answered, and what they came to: the bridge names a
   * chat only from one answered ok. `resultId`: the TurnItem of the result that answered them (its
   * texts are their answer); none for messages that came to the turn's end.
   */
  private retire(uuids: Iterable<string>, outcome: MessageOutcome, resultId?: string) {
    const ids: string[] = [];
    for (const u of [...uuids]) {
      const id = this.sentItems.get(u);
      if (id) ids.push(id);
      this.sentItems.delete(u);
    }
    if (ids.length) this.rt.answered(ids, outcome, resultId);
  }

  /**
   * At a stop: messages Claude Code has not read are no part of the stopped turn. Their bookkeeping
   * goes, and the bridge puts them back in the queue (runtime `returnUntaken`); one Claude Code reads
   * after all is taken back out of the queue then (onUser), so it never goes twice. What each was when
   * it went is kept with it: the queue's copy may be edited meanwhile.
   */
  private withdrawUnread() {
    const ids = new Set<string>();
    for (const [uuid, a] of [...this.awaiting]) {
      if (a.read) continue;
      this.releaseReceipt(this.own.get(uuid));
      this.awaiting.delete(uuid);
      const itemId = this.sentItems.get(uuid) ?? this.pendingUsers.get(uuid);
      this.pendingUsers.delete(uuid);
      this.sentItems.delete(uuid);
      if (itemId) ids.add(itemId);
      const row = itemId ? this.rt.get<UserItem>(itemId) : undefined;
      if (itemId) this.withdrawn.set(uuid, { itemId, text: row?.type === 'user' ? row.text : '', attachments: row?.type === 'user' ? row.attachments : undefined, steered: row?.steered, at: Date.now() });
    }
    while (this.withdrawn.size > 50) this.withdrawn.delete(this.withdrawn.keys().next().value!);
    return ids;
  }

  /** A completed reply can precede the replay, or arrive only as the result's final text. */
  private finishSteerReply(own: OwnSend, final: unknown, footer?: string) {
    const rt = this.rt;
    const text = typeof final === 'string' ? final.trim() : '';
    const end = footer ? rt.items.findIndex(i => i.id === footer) : rt.items.length;
    if (end < 0) return;
    for (let i = end - 1; i >= 0 && rt.items[i].id !== own.itemId; i--) {
      const row = rt.items[i];
      if (row.parentId) continue;
      if (row.type === 'turn') break;
      if (row.type === 'text' && row.text.trim() && (!text || row.text.trim() === text)) return;
    }
    const previous = footer ? [] : own.crossed ?? [];
    const reply = text ? previous.find((id) => rt.get<TextItem>(id)?.text.trim() === text) : previous.at(-1);
    if (reply) rt.move(reply, {}, true);
    else if (text && !isStandIn(text) && !parseSynthetic(text)) {
      const answer = rt.add<TextItem>({ type: 'text', ts: rt.items[end]?.ts, text: final as string, streaming: false });
      if (footer) {
        const ordered = rt.items.slice(0, -1);
        ordered.splice(end, 0, answer);
        rt.reset(ordered);
      }
    }
  }

  private releaseQueryReceipts(q: Query) {
    for (const own of this.own.values()) if (own.q === q) this.releaseReceipt(own);
  }

  private releaseReceipt(own: OwnSend | undefined) {
    if (!own?.release) return;
    const release = own.release;
    own.release = undefined;
    own.uncertain = undefined;
    release();
  }

  private confirmDelivery(own: OwnSend | undefined) {
    if (!own?.onTaken || own.q !== this.q) return;
    const taken = own.onTaken;
    own.onTaken = undefined;
    own.release = undefined;
    own.uncertain = undefined;
    taken();
  }

  private provisionalAtRest() {
    for (const own of Array.from(this.own.values()).reverse()) {
      const alias = own.alias;
      if (own.q === this.q && own.answered && alias && !alias.identified && !alias.answer &&
          this.rt.items.at(-1)?.id === alias.after && Date.now() - alias.at <= OWN_LATE_MS) return alias;
    }
  }

  /** Distinct consumed UUIDs, in one result or consecutive results, prove two messages. */
  private separateAppResult(named: string[]) {
    const rt = this.rt;
    let refusal: BackgroundLimit | undefined;
    for (const [uuid, own] of this.own) {
      const alias = own.alias;
      if (own.q !== this.q || !alias || alias.identified || alias.answer || !named.includes(alias.uuid)) continue;
      if (!own.answered && !named.includes(uuid)) continue;
      const canonicalResult = rt.answeredBy(own.itemId);
      const after = Math.max(rt.items.findIndex((i) => i.id === alias.after), rt.items.findIndex((i) => i.id === canonicalResult));
      rt.patch<UserItem>(own.itemId, { providerId: uuid });
      const remote = rt.add<UserItem>({ ts: alias.at, type: 'user', text: alias.text, attachments: alias.attachments, state: 'sent', providerId: alias.uuid, remote: true });
      if (after >= 0 && after + 1 < rt.items.length - 1) {
        const ordered = rt.items.slice(0, -1);
        ordered.splice(after + 1, 0, remote);
        rt.reset(ordered);
      }
      this.sentItems.set(alias.uuid, remote.id);
      this.awaiting.set(alias.uuid, { read: true });
      if (!rt.turnActive) rt.beginTurn('Thinking');
      else rt.personSent();
      this.aliases.delete(alias.uuid);
      own.alias = undefined;
      if (this.wakeLimit?.provisional === alias.uuid) refusal = this.takeWakeLimit();
    }
    return refusal;
  }

  private onResult(m: Obj) {
    const rt = this.rt;
    // The result of a turn the stop's safety net already settled, come late: what it cost counts, and
    // nothing else of it. It answers nothing of the running turn, and never reads that turn's stop.
    const named = resultUuids(m);
    const appRefusal = named.length ? this.separateAppResult(named) : undefined;
    const settledLimit = this.limitResultOwed && !this.awaiting.size && !named.length;
    this.limitResultOwed = false;
    for (const uuid of named) this.confirmDelivery(this.own.get(uuid));
    const debt = this.late(m);
    const late = !!debt || settledLimit;
    for (const uuid of named) {
      if (this.reclaim(uuid, uuid, !late) && late) {
        const own = this.own.get(uuid);
        if (own) own.answered = true;
        this.retire([uuid], m.is_error || m.subtype !== 'success' ? 'failed' : 'ok');
      }
    }
    const autonomous = this.autonomousTurn();
    const onlyOutstanding = this.awaiting.size === 1;
    const answered = late ? [] : this.answer(m, named);
    const wakeResult = !answered.length && (autonomous || !!this.wakeLimit);
    for (const uuid of answered) {
      const own = this.own.get(uuid);
      if (!own) continue;
      own.answered = own.read || named.length > 0;
      own.guessed = !own.answered;
      if (!named.length && own.q === this.q) {
        const reply = typeof m.result === 'string' && m.result.trim() && !isStandIn(m.result);
        const answeredAlone = onlyOutstanding && !autonomous && !this.interrupted && !m.is_error && m.subtype === 'success' && (reply || Number(m.usage?.output_tokens) > 0);
        if ((!own.alias || own.alias.identified) && (own.read || answeredAlone)) this.confirmDelivery(own);
        else own.uncertain?.();
        own.uncertain = undefined;
      }
      if (this.pendingUsers.delete(uuid)) this.takeCard(own, uuid, 'result');
      if (!m.is_error && m.subtype === 'success' && rt.get<UserItem>(own.itemId)?.steered) this.finishSteerReply(own, m.result);
      own.crossed = undefined;
    }
    // Messages held back for a result owed go once that result is in (`release` checks what is still owed).
    this.release();
    // Its own messages are taken when they are replayed: whatever woke the model is answered by now.
    if (!late) this.wakes = 0;
    const total = Number(m.total_cost_usd ?? 0);
    const usage: SessionUsage = { ...rt.meta.usage };
    // total_cost_usd is the CLI's running total for the conversation: this result costs what it added.
    const turnCost = this.costOf(total);
    usage.costUsd = (usage.costUsd ?? 0) + turnCost;
    // Kept per conversation: a process that resumes it starts from here (`ensure`).
    const conversation = typeof m.session_id === 'string' && m.session_id ? m.session_id : rt.meta.providerSessionId;
    if (total > 0 && conversation) usage.cliCost = { session: conversation, total };
    usage.turns += 1;
    usage.inputTokens += Number(m.usage?.input_tokens ?? 0) + Number(m.usage?.cache_creation_input_tokens ?? 0);
    usage.outputTokens += Number(m.usage?.output_tokens ?? 0);
    usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + Number(m.usage?.cache_read_input_tokens ?? 0);
    const window = Object.values((m.modelUsage as Record<string, Obj>) ?? {}).reduce((max, u) => Math.max(max, Number(u.contextWindow ?? 0)), 0);
    if (window) usage.contextWindow = window;
    rt.update({ usage });
    const failed = m.subtype !== 'success' || m.is_error;
    const wasInterrupted = this.interrupted;
    let failure: string | undefined;
    if (failed) {
      failure =
        (Array.isArray(m.errors) && m.errors.length ? m.errors.join('\n') : undefined) ??
        (typeof m.result === 'string' && m.result ? m.result : undefined) ??
        resultLabel(m.subtype);
    }
    const error = wasInterrupted ? undefined : failure;
    // Refused for the sign-in: the bridge says it once for the chat (or sends once more), never the CLI's words on the turn's line.
    const signIn = !!error && (refusedForSignIn(undefined, [error]) || authFailurePending(rt.id, turnOf(rt)));
    if (!late && signIn && error) noteAuthFailure(rt.id, undefined, turnOf(rt));
    // Cut off at a plan limit while it worked ("You've hit your 5-hour limit · resets 6pm (Europe/Berlin)",
    // a 429): a limit like one met at the start, said by the chat's one limit notice (the bridge moves
    // it at the turn's end), never as "The turn ended with an error" with "Try again".
    const cutAtLimit = !!failure && !signIn && (
      m.error === 'rate_limit' || Number(m.api_error_status ?? m.apiErrorStatus) === 429 ||
      !!agentLimitOf(failure) || /usage limit reached|\b(?:http|api error|status code)\s*:?\s*429\b|\b429\s+too many requests\b/i.test(failure)
    );
    if (late) {
      if (debt && cutAtLimit && failure) {
        const hit = this.refusal(failure, debt.window ?? (rt.turnActive ? {} : this.limitHit));
        if (debt.owner) {
          const known = debt.notices.has(debt.owner) || debt.notices.has(undefined);
          const notice = this.showTurnLimit(hit, debt.owner, debt.notices);
          if (!known) rt.onStoppedLimit?.(rt, notice);
        } else if (!debt.wakeReported) {
          if (rt.turnActive) this.wakeLimit ??= { hit };
          else rt.limitInBackground(hit);
        }
      }
      if (this.q) void this.provider.readLimits(this.q);
      return;
    }
    this.compacted = false;
    if (cutAtLimit && error && !rt.turnActive) {
      rt.limitInBackground(this.refusal(error));
      this.limitHit = undefined;
      return;
    }
    if (wakeResult && cutAtLimit && failure) {
      const hit = this.refusal(failure);
      if (!this.wakeLimit) this.wakeLimit = { hit };
      else {
        this.wakeLimit.hit.window ??= hit.window;
        this.wakeLimit.hit.resetsAt ??= hit.resetsAt;
      }
    }
    if (appRefusal) this.showTurnLimit(appRefusal, answered.at(-1));
    else if (cutAtLimit && failure && !wakeResult) this.showTurnLimit(this.refusal(failure), answered.at(-1));
    const inputTokens = Number(m.usage?.input_tokens ?? 0) + Number(m.usage?.cache_read_input_tokens ?? 0) + Number(m.usage?.cache_creation_input_tokens ?? 0);
    const outputTokens = Number(m.usage?.output_tokens ?? 0);
    const shownError = signIn || cutAtLimit || (wakeResult && this.wakeLimit) ? undefined : error;
    // A message of ours still on its way to Claude Code is no part of what this result closes: a result
    // that answers none of ours then belongs to earlier work (a turn it took up by itself, a start that
    // failed, a resumed process's first word) and never ends the person's turn. Its line stands above
    // the message, which begins what comes next (review of 23 Nov, D-own); one that shows nothing (no
    // tokens, no error) is not written at all, so nothing stands between message and answer. A cost
    // alone is nothing to show: a resumed process's first result may book what ran unseen since the
    // chat last heard a total (its sub-agents' last requests), and that stood as a bare "$0.10" under
    // the person's message with no working line (the chat's own total above already has it).
    const ahead = wasInterrupted ? [] : this.unreadOwn();
    const blank = !answered.length && ahead.length > 0 && !inputTokens && !outputTokens && !shownError;
    // What the messages this result answers came to, whatever the turn does next, and the result's
    // line in the timeline that closes their answer.
    const resultId = wasInterrupted || blank ? undefined : randomUUID();
    const outcome = wasInterrupted ? 'stopped' : failed ? 'failed' : 'ok';
    for (const uuid of answered) {
      const own = this.own.get(uuid);
      if (own?.alias && named.includes(own.alias.uuid) && !named.includes(uuid)) own.alias.answer = { outcome, resultId };
    }
    this.retire(answered, outcome, resultId);
    if (resultId) {
      if (this.awaiting.size) {
        const pending = new Set(this.awaiting.keys());
        const last = rt.items.findLast((i) => !i.parentId);
        for (const u of answered) if (!this.own.has(u) && !this.chain.includes(u)) {
          this.unmatchedResults.set(u, {
            pending, turn: this.turnSeq, before: last?.type === 'text' ? last.id : resultId,
            result: resultId, error, final: !failed && typeof m.result === 'string' ? m.result : undefined,
          });
        }
        while (this.unmatchedResults.size > OWN_MAX) this.unmatchedResults.delete(this.unmatchedResults.keys().next().value!);
      }
      rt.add<TurnItem>({
        id: resultId,
        type: 'turn',
        durationMs: Number(m.duration_ms ?? Date.now() - rt.turnStartedAt),
        costUsd: turnCost || undefined,
        inputTokens,
        outputTokens,
        stopReason: m.stop_reason ?? undefined,
        error: shownError,
      });
      for (const id of ahead) if (rt.get<UserItem>(id)?.state === 'sent') rt.move(id, {}, true);
    }
    // Fresh plan limits after every turn (shared with any read in the last few seconds).
    if (this.q) void this.provider.readLimits(this.q);
    if (this.awaiting.size > 0 && !wasInterrupted) {
      // Messages it has not answered yet are still coming (a steer it has not read): their turn starts
      // right away. One that never comes back does not keep it for ever (`armUnreadNet`).
      rt.update({ activity: 'Thinking' });
      this.armUnreadNet();
      return;
    }
    // A stop holds through the turn's end: steers it has not read go back to the queue (finishTurn), and
    // one it read but did not answer yet is stopped too.
    if (wasInterrupted && [...this.awaiting.values()].some((a) => a.read) && this.q) {
      const q = this.q;
      void Promise.resolve()
        .then(() => q.interrupt())
        .catch(() => {});
    }
    this.finishTurn(wakeResult && this.wakeLimit ? undefined : error, wasInterrupted);
    this.limitResultOwed = false;
  }

  private takeWakeLimit(): BackgroundLimit | undefined {
    const hit = this.wakeLimit?.hit;
    this.wakeLimit = undefined;
    if (hit) {
      if (!hit.window || hit.window === 'Plan limit') hit.window = this.limitHit?.window ?? hit.window;
      if (!this.limitHit?.window || this.limitHit.window === hit.window) hit.resetsAt = this.limitHit?.resetsAt ?? hit.resetsAt;
    }
    return hit;
  }

  private finishTurn(error: string | undefined, interrupted: boolean, hold = false) {
    const rt = this.rt;
    if (!rt.turnActive) return;
    // This turn is settled: its stop's safety net and its quiet bounds go with it.
    this.turnSeq++;
    clearTimeout(this.interruptTimer);
    clearTimeout(this.wakeNet);
    clearTimeout(this.unreadNet);
    if (interrupted) rt.returnUntaken({ ids: this.withdrawUnread(), reason: 'stopped' });
    // Messages no result named on its own (an older CLI, a steer folded in, one the turn went idle
    // without answering) come to the turn's stop or failure. Otherwise what they came to is not known:
    // nothing is recorded, and a message with no word of its own is never taken as having gone ok.
    if (interrupted || error) this.retire(this.sentItems.keys(), interrupted ? 'stopped' : 'failed');
    else {
      for (const uuid of this.sentItems.keys()) this.releaseReceipt(this.own.get(uuid));
      this.sentItems.clear();
    }
    this.interrupted = false;
    this.awaiting.clear();
    this.aliases.clear();
    this.wakes = 0;
    const wakeLimit = this.takeWakeLimit();
    const backgroundOnly = !!wakeLimit && !this.turnLimits.size && !error;
    this.limitHit = undefined;
    this.turnLimits = new Map();
    rt.settle(interrupted ? 'cancelled' : error ? 'error' : 'cancelled');
    if (interrupted) rt.notice('interrupted', 'Interrupted');
    // Every message sent has had its result: a steer whose replay never came (or came under
    // another uuid) was taken all the same. After an interrupt the bridge takes untaken ones back.
    else this.takeUsers();
    rt.endTurn(error, wakeLimit ? { hold: true, backgroundLimit: backgroundOnly } : { hold });
    if (wakeLimit) {
      this.limitResultOwed = true;
      rt.limitInBackground(wakeLimit);
    }
    this.scheduleIdleClose();
    // A changed option restarts the process once nothing holds it any more (`restartWhenFree`).
    if (this.restartPending) this.freeLater();
    else if (this.q && rt.meta.options?.browser) void this.checkBrowser(this.q);
  }

  /**
   * A message of ours Claude Code has not read keeps the turn: its own turn is still to come. Not for
   * ever (a delivery that failed, a zeroed result that named nothing): once the process has said
   * nothing for `UNREAD_QUIET_MS` since then, and works on nothing (no word that it runs, no step of
   * the turn running, no prompt open, nothing held, no stop under way), the message is not coming and
   * the turn ends. Should Claude Code take it after all, it is still Sable's (`takeOwn`), and its
   * turn begins then.
   */
  private armUnreadNet(ms = UNREAD_QUIET_MS) {
    clearTimeout(this.unreadNet);
    const at = this.rt.turnStartedAt;
    this.unreadNet = setTimeout(() => this.unreadNetDue(at), ms);
    this.unreadNet.unref?.();
  }

  private unreadNetDue(at: number) {
    const rt = this.rt;
    if (!rt.turnActive || rt.turnStartedAt !== at || !this.q || !this.awaiting.size) return;
    let since = Math.max(this.rootHeardAt, at);
    for (const [uuid, a] of this.awaiting) if (!a.read) since = Math.max(since, this.own.get(uuid)?.at ?? 0);
    const quiet = Date.now() - since;
    const rootBusy = this.cliBusy() && quiet < CLI_TRUST_MS;
    const busy = !!this.held || this.interrupted || this.promptsOpen() || rootBusy || this.rootStepRunning();
    if (busy || quiet < UNREAD_QUIET_MS) return this.armUnreadNet(busy ? UNREAD_QUIET_MS : UNREAD_QUIET_MS - quiet + 50);
    this.log('claude: an outstanding message received no result before the quiet bound');
    if (this.unread()) {
      rt.returnUntaken({ ids: this.withdrawUnread(), reason: 'stopped', holdQueue: true });
    }
    this.finishTurn(undefined, false, true);
  }

  /**
   * What a result cost, from the CLI's running total for the conversation (review of 23 Nov, D-cost):
   * what it added since the last total seen. A zeroed total (a crash, a refused start) says nothing and
   * costs nothing. Where this process started is not known (a resumed conversation this chat never
   * counted): its first total carries the conversation's past, so nothing is booked rather than all of
   * it. A total below the last one restarted the count: within a process (a /clear) it all counts; as
   * the process's first (a resume from an earlier point, a transcript that saved less) nothing does.
   */
  private costOf(total: number): number {
    if (!(total > 0)) return 0;
    const base = this.lastTotalCost;
    const first = this.costFresh;
    this.costFresh = false;
    this.lastTotalCost = total;
    if (base === undefined) return 0;
    if (total >= base) return total - base;
    return first ? 0 : total;
  }

  private currentTaskRun(m: Obj): boolean {
    if (!m.task_id || typeof m.run_id !== 'string') return true;
    const id = String(m.task_id);
    const last = this.taskRuns.get(id);
    if (last && m.run_id < last) return false;
    if (last !== m.run_id) {
      this.taskRuns.set(id, m.run_id);
      if (last) {
        const superseded = this.taskItems.get(id);
        if (superseded) {
          this.rt.stopBackground((item) => item.id === superseded);
          this.rt.taskEnded(id, 'stopped');
        }
        this.endedTasks.delete(id);
        this.taskInfo.delete(id);
        this.taskItems.delete(id);
        this.foreground.delete(id);
        this.ambient.delete(id);
      }
    }
    return true;
  }

  private onSystem(m: Obj) {
    const rt = this.rt;
    if (m.task_id && !this.currentTaskRun(m)) return;
    switch (m.subtype) {
      case 'init': {
        if (Array.isArray(m.skills)) this.skillNames = m.skills.map(String);
        if (m.permissionMode && m.permissionMode !== rt.workMode && !rt.dangerHeld) rt.update({ mode: m.permissionMode });
        if (rt.caps && this.skillNames.length) {
          const names = new Set(this.skillNames);
          const commands = rt.caps.commands.map((c) => (names.has(c.name) ? { ...c, kind: 'skill' as const } : c));
          rt.setCaps({ ...rt.caps, commands, skills: commands.filter((c) => c.kind === 'skill').map((c) => ({ name: c.name, description: c.description })), tools: m.tools ?? [] });
        }
        // Ultracode runs through the Workflow tool: without it (workflows off) there is nothing to switch.
        if (rt.caps && Array.isArray(m.tools) && m.tools.length) {
          const ultracode = m.tools.includes('Workflow');
          if (rt.caps.features.ultracode !== ultracode) rt.setCaps({ ...rt.caps, features: { ...rt.caps.features, ultracode } });
        }
        break;
      }
      case 'status':
        if (m.status === 'compacting') rt.update({ activity: 'Compacting the conversation' });
        if (m.permissionMode && m.permissionMode !== rt.workMode && !rt.dangerHeld) rt.update({ mode: m.permissionMode });
        break;
      case 'compact_boundary': {
        const meta = m.compact_metadata ?? {};
        const detail = meta.post_tokens ? `${fmtTokens(meta.pre_tokens)} → ${fmtTokens(meta.post_tokens)} tokens` : `${fmtTokens(meta.pre_tokens)} tokens summarized`;
        rt.notice('compact', 'Conversation compacted', detail);
        this.compacted = true;
        if (meta.post_tokens) rt.update({ usage: { ...rt.meta.usage, contextTokens: Number(meta.post_tokens) } });
        break;
      }
      case 'api_retry': {
        const text = `Retrying, attempt ${m.attempt} of ${m.max_retries}`;
        if (this.retryNotice && rt.get(this.retryNotice)) rt.patch(this.retryNotice, { text, detail: errorLabel(m.error) } as Partial<TimelineItem>);
        else this.retryNotice = rt.notice('retry', text, errorLabel(m.error)).id;
        break;
      }
      case 'local_command_output':
        if (m.content && !(this.compacted && isCompactOutput(String(m.content), true))) rt.notice('command', 'Command output', String(m.content));
        break;
      case 'informational':
        // A warning stands as a card (variant `error`, for every reader) and says its own level: it is no failure.
        if (m.content && m.level === 'warning') rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: String(m.content), level: 'warn' });
        else if (m.content && m.level !== 'suggestion') rt.notice('info', String(m.content));
        break;
      case 'permission_denied': {
        const item = rt.get<ToolItem>(m.tool_use_id);
        if (item && item.status !== 'denied') rt.patch<ToolItem>(item.id, { status: 'denied', endedAt: Date.now(), result: { ...item.result, text: m.message } });
        break;
      }
      case 'task_progress': {
        if (m.task_id && m.tool_use_id && rt.get<ToolItem>(m.tool_use_id)?.name !== 'SendMessage') this.taskItems.set(String(m.task_id), String(m.tool_use_id));
        const item = this.taskItem(m);
        if (item?.workflow) {
          rt.patch<ToolItem>(item.id, { workflow: workflowProgress(item.workflow, m) });
          break;
        }
        if (item && m.summary) rt.patch<ToolItem>(item.id, { output: String(m.summary) });
        // A background sub-agent has its (placeholder) result already: its figures keep counting on it.
        if (item?.kind === 'agent' && item.result?.agent?.background === 'running') {
          rt.patch<ToolItem>(item.id, { result: { ...item.result, agent: { ...item.result.agent, ...taskFigures(m.usage) } } });
        }
        break;
      }
      case 'background_tasks_changed': {
        // Every live background task (replace, never merge: a missed start or end leaves nothing stale).
        // Ambient ones (watchers, housekeeping) are nobody's work and never hold the process.
        const previous = this.liveIds();
        const level = new Set<string>();
        for (const t of (m.tasks as Obj[] | undefined) ?? []) {
          if (!t?.task_id) continue;
          const id = String(t.task_id);
          if (!this.currentTaskRun(t)) {
            if (previous.has(id) && !this.foreground.has(id)) level.add(id);
            continue;
          }
          if (t.ambient === true) {
            this.ambient.add(id);
            continue;
          }
          if (this.endedTasks.has(id)) continue;
          this.ambient.delete(id);
          level.add(id);
          this.noteTask(id, t.task_type, undefined, t.description);
          this.linkAgentRun(t);
        }
        this.level = level;
        // The list covers every background task started before it (they join it before their start is said).
        for (const id of [...this.liveTasks]) if (!this.foreground.has(id)) this.liveTasks.delete(id);
        if ([...previous].some((id) => !level.has(id) && !this.foreground.has(id))) this.waitForNotification();
        this.reconcileTasks();
        // The last one ended: messages held for this process's owed result can go to a new one, and a waiting restart.
        this.release();
        this.freeLater();
        break;
      }
      case 'task_started': {
        const item = m.tool_use_id ? rt.get<ToolItem>(m.tool_use_id) : undefined;
        if (m.task_id && m.tool_use_id && item?.name !== 'SendMessage') this.taskItems.set(String(m.task_id), String(m.tool_use_id));
        if (item?.workflow && m.workflow_name && !item.workflow.name) rt.patch<ToolItem>(item.id, { workflow: { ...item.workflow, name: String(m.workflow_name) } });
        if (!m.task_id) break;
        const id = String(m.task_id);
        // Housekeeping (a watcher, a task that writes no transcript): nobody's work.
        if (m.ambient === true || m.skip_transcript === true) {
          this.ambient.add(id);
          break;
        }
        if (this.endedTasks.has(id)) break;
        this.noteTask(id, m.task_type, item?.name, m.description);
        this.liveTasks.add(id);
        // A call that blocks on it (a sub-agent run in the foreground, a command waited for): it ends with that call.
        if (m.is_backgrounded === false) this.foreground.add(id);
        else {
          this.linkAgentRun(m);
          this.backgrounded(id, item);
        }
        break;
      }
      case 'task_updated': {
        const id = m.task_id ? String(m.task_id) : '';
        const p = (m.patch ?? {}) as Obj;
        if (!id) break;
        // Moved to the background (at its timeout, or by the person): its call returns, the task goes on.
        if (p.is_backgrounded === true && !this.endedTasks.has(id) && !this.ambient.has(id)) {
          this.foreground.delete(id);
          this.liveTasks.add(id);
          this.backgrounded(id, this.taskItem({ task_id: id }));
        }
        const end = p.status === 'completed' ? 'done' : p.status === 'failed' ? 'failed' : p.status === 'killed' ? 'stopped' : undefined;
        if (end) {
          this.taskOver(id, end, typeof p.end_time === 'number' && p.end_time > 1e12 ? p.end_time : undefined);
          const item = this.taskItem(m);
          if (item?.result?.agent?.background === 'running' && !item.workflow) {
            rt.patch<ToolItem>(item.id, { result: { ...item.result, agent: { ...item.result.agent, background: end } } });
          }
        }
        break;
      }
      case 'task_notification': {
        // Its end: it holds the process no more, and a background command's step says how it ended.
        if (m.task_id) this.taskOver(String(m.task_id), m.status === 'completed' ? 'done' : m.status === 'failed' ? 'failed' : 'stopped');
        // How a sub-agent ended, with its own figures. For one started in the background this is the only word of it.
        const item = this.taskItem(m);
        if (m.task_id) this.taskItems.delete(String(m.task_id));
        if (item?.workflow) {
          const run = workflowProgress(item.workflow, m);
          run.status = m.status === 'completed' ? 'done' : m.status === 'failed' ? 'failed' : 'stopped';
          if (typeof m.usage?.duration_ms === 'number') run.durationMs = m.usage.duration_ms;
          delete run.limitWait;
          rt.patch<ToolItem>(item.id, { workflow: run });
        }
        if (item?.kind !== 'agent' || !item.result) break;
        const agent = { ...item.result.agent, ...taskFigures(m.usage) };
        const wasRunning = !!agent.background && !agent.limit;
        if (agent.background) agent.background = m.status === 'completed' ? 'done' : m.status === 'failed' ? 'failed' : 'stopped';
        // Ended by a plan limit: stopped at the limit, said once by the chat (never a notice of its own).
        const limit = m.status !== 'completed' && !agent.limit ? agentLimitOf(String(m.summary ?? '')) : undefined;
        if (limit) agent.limit = limit;
        rt.patch<ToolItem>(item.id, { result: { ...item.result, agent } });
        if (limit && wasRunning) rt.limitInBackground({ stepId: item.id, window: this.limitHit?.window ?? limit.window, resetsAt: this.limitHit?.resetsAt ?? limit.resetsAt });
        break;
      }
      case 'commands_changed':
        if (rt.caps && Array.isArray(m.commands)) {
          const commands = this.provider.buildCaps({ commands: m.commands }, [], this.skillNames).commands;
          rt.setCaps({ ...rt.caps, commands, skills: commands.filter((c) => c.kind === 'skill').map((c) => ({ name: c.name, description: c.description })) });
        }
        break;
      case 'session_state_changed': {
        // Claude Code's own word on its turns (asked for with CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).
        const prev = this.cliState;
        this.cliState = m.state;
        // Idle: a turn's result comes before it, so what settled turns still owed is not coming (`owed`),
        // and messages held for it go now.
        if (m.state === 'idle') {
          this.owed = [];
          this.release();
          this.freeLater();
        }
        // Idle with nothing of Sable's still on its way: whatever no result closed (a message from the Claude
        // app folded into the turn, a background task's notification that woke no model turn) is over.
        // A message of ours it has not read yet keeps the turn: its own turn is still to come (bounded,
        // `armUnreadNet`). After a stop, idle is the end whatever it has not read (that goes back to the queue).
        if (m.state === 'idle' && rt.turnActive && (this.interrupted || !this.unread())) this.finishTurn(undefined, this.interrupted);
        else if (m.state === 'idle' && rt.turnActive) this.unreadNetDue(rt.turnStartedAt);
        // Work it started on its own, with no message to replay (a scheduled wake-up): a turn like any other
        // (`wake`), which its result or the next idle ends. From idle, or as the first word of a new process
        // (a process taking up work by itself); after a prompt it is the same work going on (a sub-agent's
        // permission answered), and root work then begins its turn with its first output.
        else if (m.state === 'running' && (prev === 'idle' || prev === undefined)) this.wake();
        break;
      }
      case 'worker_shutting_down':
        // Also read back from a transcript on a resume: never more than a line in the log.
        this.log('claude: the agent process says it is shutting down');
        break;
      default:
        break;
    }
  }

  // ── stored transcripts ──

  async loadTranscript() {
    const rt = this.rt;
    const id = rt.meta.providerSessionId;
    if (!id) return;
    const messages = (await this.provider.withHistory(() => getSessionMessages(id, { dir: rt.meta.cwd, includeSystemMessages: true }))) as Obj[];
    const items: TimelineItem[] = [];
    const tools = new Map<string, ToolItem>();
    const unstamped = new Set<string>();
    // Stored messages may carry no timestamps: then keep the order but invent no durations.
    const firstStamp = messages.map((m) => Date.parse(String(m.timestamp ?? ''))).find(Number.isFinite);
    const stamped = firstStamp !== undefined;
    let ts = stamped ? firstStamp - 1 : rt.meta.createdAt - messages.length * 1000;
    let real: number | undefined;
    const push = (item: Obj) => {
      ts = real && real > ts ? real : ts + (stamped ? 1 : 1000);
      const full = { id: randomUUID(), ts, ...item } as TimelineItem;
      items.push(full);
      return full;
    };
    let firstPrompt: string | undefined;
    let planDraft: string | undefined;
    const afterCompact = () => {
      const last = items.at(-1);
      return last?.type === 'notice' && last.variant === 'compact';
    };
    const readUserText = (text: string, uuid: string) => {
      const role = parseSynthetic(text)?.role;
      if (role === 'output') {
        if (afterCompact() && isCompactOutput(text)) return;
      } else {
        if (role === 'hidden' || !isHumanText(text)) return;
        firstPrompt ??= text;
      }
      push({ type: 'user', text, state: 'sent', providerId: uuid });
    };
    for (const m of messages) {
      const parentId: string | undefined = m.parent_tool_use_id ?? undefined;
      const msg = (m.message ?? {}) as Obj;
      const content = msg.content;
      const stamp = Date.parse(String(m.timestamp ?? ''));
      real = Number.isFinite(stamp) ? stamp : undefined;
      if (m.type === 'system' && (m.subtype ?? msg.subtype) === 'compact_boundary') {
        const meta = m.compact_metadata ?? msg.compact_metadata ?? {};
        push({ type: 'notice', variant: 'compact', text: 'Conversation compacted', detail: meta.post_tokens ? `${fmtTokens(meta.pre_tokens)} → ${fmtTokens(meta.post_tokens)} tokens` : undefined });
      } else if (m.type === 'system' && (m.subtype ?? msg.subtype) === 'local_command_output') {
        const detail = m.content ?? content;
        if (typeof detail === 'string' && detail && !(afterCompact() && isCompactOutput(detail, true))) {
          push({ type: 'notice', variant: 'command', text: 'Command output', detail });
        }
      } else if (m.type === 'user' && m.isCompactSummary && !parentId) {
        // Some saved histories expose only the SDK's summary marker for this boundary.
        if (!afterCompact()) push({ type: 'notice', variant: 'compact', text: 'Conversation compacted' });
      } else if (m.type === 'assistant' && Array.isArray(content)) {
        if (!parentId) this.chain.push(m.uuid);
        for (const b of content as Obj[]) {
          // Claude Code's stand-in where a cut turn has no answer: nobody's words.
          if (b.type === 'text' && b.text && msg.model === '<synthetic>' && (isStandIn(String(b.text)) || isAuthFailure(String(b.text)))) continue;
          if (!parentId && b.type === 'text' && afterCompact() && isCompactOutput(String(b.text), msg.model === '<synthetic>')) continue;
          if (b.type === 'text' && b.text) push({ type: 'text', text: b.text, streaming: false, parentId });
          else if (b.type === 'thinking' && b.thinking) push({ type: 'thinking', text: b.thinking, streaming: false, endedAt: real, parentId });
          else if (b.type === 'tool_use') {
            // Read back from a transcript (child steps too): browser_sign_in keeps only valid references.
            let input: Obj = cleanToolInput(b.name, b.input ?? {}) as Obj;
            // The plan lives in the plan file the agent wrote just before; the stored call is often empty.
            if ((b.name === 'Write' || b.name === 'Edit') && isPlanFile(input.file_path)) planDraft = b.name === 'Write' ? input.content : planDraft;
            if (b.name === 'ExitPlanMode' && planDraft) input = { ...input, plan: planDraft };
            const view = describeTool(b.name, input);
            // Done only by its own result below: a call the agent stopped at (a share still waiting for its
            // answer when Claude Code stopped) comes back incomplete, never as having gone through.
            const t = push({ id: b.id, type: 'tool', name: b.name, ...view, input, status: 'cancelled', parentId }) as ToolItem;
            if (b.name === 'Edit' || b.name === 'Write') t.result = { diff: previewDiff(b.name, input) };
            if (b.name === 'Workflow') t.workflow = { ...workflowStart(input), status: 'done' };
            tools.set(b.id, t);
            // A call whose own message carries no time took its place from the item before it: its start is not known.
            if (!real) unstamped.add(b.id);
          }
        }
      } else if (m.type === 'user') {
        if (!parentId) this.chain.push(m.uuid);
        if (typeof content === 'string') {
          if (!parentId) readUserText(content, m.uuid);
        } else if (Array.isArray(content)) {
          const text = flattenContent(content.filter((b: Obj) => b.type === 'text')).text;
          for (const b of content as Obj[]) {
            if (b.type !== 'tool_result') continue;
            const t = tools.get(b.tool_use_id);
            if (!t) continue;
            const result = mapResult(t.name, (t.input as Obj) ?? {}, undefined, b.content, !!b.is_error);
            t.result = { ...t.result, ...result, diff: result.diff ?? t.result?.diff };
            t.status = !b.is_error ? 'done' : isDenial(flattenContent(b.content).text) ? 'denied' : 'error';
            // A step's time runs from its own start to its result: with either not known it shows none.
            if (real && !unstamped.has(t.id)) t.endedAt = real;
          }
          if (text && !parentId && !content.some((b: Obj) => b.type === 'tool_result')) readUserText(text, m.uuid);
        }
      }
    }
    rt.reset(items);
    if (rt.meta.titleSource === 'auto' && rt.meta.title === 'New session' && firstPrompt) {
      rt.update({ title: firstPrompt.split('\n')[0].slice(0, 56) });
    }
  }
}

function isPlanFile(p: unknown) {
  // The default profile keeps plans in ~/.claude/plans, an extra account in <sable>/accounts/claude/<id>/plans.
  return typeof p === 'string' && /[\\/](\.claude|accounts[\\/]claude[\\/][\w-]+)[\\/]plans[\\/][^\\/]+\.md$/i.test(p);
}

/** Tool results that mean "the user said no" (ours and the CLI's own wording). */
function isDenial(text: string) {
  return /^(The user (declined|dismissed|wants to keep planning|doesn't want to proceed)|User rejected|Permission to use \S+ (has been|was) denied)/i.test(text.trim());
}

function isHumanText(text: string) {
  const t = text.trimStart();
  return !!t && !t.startsWith('<') && !t.startsWith('Caveat:') && !t.startsWith('[Request interrupted');
}

function describeSuggestion(s: PermissionUpdate, filePath?: string): { label: string; hint?: string } | undefined {
  const where = (d: string) => WHERE[d as PermissionSave['where']] ?? 'for this project';
  if (s.type === 'setMode') {
    if (s.mode === 'acceptEdits') return { label: 'Allow all edits', hint: where(s.destination) };
    return { label: `Switch to ${s.mode}`, hint: where(s.destination) };
  }
  if (s.type === 'addRules' && s.rules.length) {
    const r = s.rules[0];
    const what = ruleText(r);
    const verb = s.behavior === 'deny' ? 'Always deny' : s.behavior === 'ask' ? 'Always ask before' : 'Always allow';
    return { label: `${verb} ${what.length > 44 ? what.slice(0, 42) + '…' : what}`, hint: where(s.destination) };
  }
  if (s.type === 'addDirectories' && s.directories.length) {
    return { label: `Allow access to ${baseName(s.directories[0])}`, hint: where(s.destination) };
  }
  void filePath;
  return undefined;
}

const ruleText = (r: { toolName: string; ruleContent?: string }) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);

/**
 * What an "always" answer saves (it saves every suggestion): each suggestion as one entry, with what
 * it does (folders added, rules added and their behaviour, a mode) and where it is kept, so every one
 * shows whole on a phone (review wave 6, #5). A kind Sable does not name (rules replaced or removed,
 * folders removed) or a destination it does not know makes that answer desktop-only (`savesUnknown`).
 */
export function alwaysScope(suggestions: readonly PermissionUpdate[]): PermissionScope {
  const saves: PermissionSave[] = [];
  let unknown = false;
  for (const s of suggestions) {
    const where = s && typeof s === 'object' && typeof s.destination === 'string' && s.destination in WHERE ? (s.destination as PermissionSave['where']) : undefined;
    if (!where) unknown = true;
    else if (s.type === 'addDirectories' && Array.isArray(s.directories) && s.directories.every((d) => typeof d === 'string')) saves.push({ dirs: [...s.directories], where });
    else if (s.type === 'addRules' && Array.isArray(s.rules) && (s.behavior === 'allow' || s.behavior === 'deny' || s.behavior === 'ask')) saves.push({ rules: s.rules.map(ruleText), behavior: s.behavior, where });
    else if (s.type === 'setMode' && typeof s.mode === 'string') saves.push({ mode: s.mode, where });
    else unknown = true;
  }
  return { saves, ...(unknown ? { savesUnknown: true as const } : {}) };
}

function errorLabel(code?: string): string {
  switch (code) {
    case 'authentication_failed':
      return 'Not signed in. Connect your Claude account again.';
    case 'rate_limit':
      return 'You have reached your usage limit.';
    case 'overloaded':
      return 'Claude is overloaded right now.';
    case 'billing_error':
      return 'There is a billing problem on this account.';
    case 'max_output_tokens':
      return 'The response hit the output limit.';
    case 'model_not_found':
      return 'That model is not available on this account.';
    case 'server_error':
      return 'The API had a server error.';
    default:
      return code ? code.replace(/_/g, ' ') : 'Something went wrong';
  }
}

function resultLabel(subtype?: string): string {
  switch (subtype) {
    case 'error_max_turns':
      return 'Stopped after reaching the turn limit.';
    case 'error_max_budget_usd':
      return 'Stopped after reaching the spending limit.';
    default:
      return 'The turn ended with an error.';
  }
}

/** The messages a result names as the ones it answers (`user_message_uuids`, or `user_message_uuid`); none in an older CLI. */
function resultUuids(m: Obj): string[] {
  const named = (Array.isArray(m.user_message_uuids) ? (m.user_message_uuids as unknown[]) : []).filter((u): u is string => typeof u === 'string' && !!u);
  if (!named.length && typeof m.user_message_uuid === 'string' && m.user_message_uuid) named.push(m.user_message_uuid);
  return named;
}

function fmtTokens(n?: number) {
  if (!n) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}

/**
 * A workflow's task_progress or task_notification folded into its run: the CLI's rows (phases and
 * agents), its totals, and whether it waits for a plan limit to reset.
 */
export function workflowProgress(run: WorkflowRun, m: Obj): WorkflowRun {
  const next = mergeWorkflow(run, m.workflow_progress);
  const u = (m.usage ?? {}) as Obj;
  const out: WorkflowRun = { ...next };
  if (typeof u.total_tokens === 'number') out.tokens = u.total_tokens;
  if (typeof u.tool_uses === 'number') out.steps = u.tool_uses;
  const wait = m.usage_limit_wait as Obj | undefined;
  if (wait && typeof wait === 'object') {
    const at = Number(wait.resets_at ?? wait.resetsAt ?? wait.resume_at_ms ?? wait.resumeAtMs);
    out.limitWait = Number.isFinite(at) && at > 0 ? { resetsAt: at < 1e12 ? at * 1000 : at } : {};
  } else if (m.subtype === 'task_progress') delete out.limitWait;
  return out;
}

/** The figures a task event carries (`usage` of task_progress and task_notification), only those it has. */
export function taskFigures(usage: unknown): AgentStats {
  const u = (usage && typeof usage === 'object' ? usage : {}) as Obj;
  const out: AgentStats = {};
  if (typeof u.total_tokens === 'number') out.tokens = u.total_tokens;
  if (typeof u.tool_uses === 'number') out.steps = u.tool_uses;
  if (typeof u.duration_ms === 'number') out.durationMs = u.duration_ms;
  return out;
}

/**
 * Flag settings an agent process starts with: ultracode, and fast mode only when this session chose
 * it. Fast mode is billed as extra usage and Claude Code keeps its own `/fast` choice across
 * sessions, so a session that never chose it starts with it off (a flag overlay: nothing is saved).
 */
export function startSettings(meta: Pick<SessionMeta, 'ultracode' | 'speed'>): Options['settings'] | undefined {
  const out: Record<string, unknown> = {};
  if (meta.ultracode) out.ultracode = true;
  out.fastMode = meta.speed === 'fast';
  return Object.keys(out).length ? (out as Options['settings']) : undefined;
}

/** The words of a replayed user message (a string, or its text blocks); empty for tool results and images only. */
function replayText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Obj[])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
}
