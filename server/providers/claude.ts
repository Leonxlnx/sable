import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  query,
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
import type { SessionRuntime } from '../core/runtime';
import type { TitlePrompt } from '../core/titles';
import { dropRemote, holdRemote, type RemoteHolder } from '../core/remote-keep';
import { claudeForkPoint, cutAt } from '../core/fork';
import { killTree, runCli, spawnCli } from '../util/proc';
import { baseName, describeTool, flattenContent, mapResult, mergeWorkflow, normalizeTodos, peekPartialInput, previewDiff, workflowStart } from './claude-tools';
import type { Provider, ProviderContext, ProviderSession, WarmChoice } from './types';
import { claudePlan } from './plans';
import { carryClaudeConversation } from '../accounts/handover';
import { CONCISE_REPLIES_PROMPT } from '../../shared/protocol';
import { parseSynthetic, syntheticLine } from '../../shared/synthetic';
import { widgetServer } from './claude-widget';
import { BROWSER_HINT, BROWSER_TOOL_IDS, browserTabEnabled } from './browser-tool';
import { DEVICE_HINT, DEVICE_TOOL_IDS, deviceEnabled } from './device-tool';
import { WIDGET_FENCE_HINT, WIDGET_SERVER, WIDGET_TOOL_ID, widgetsEnabled } from './widget-tool';
import { AGENT_TOOLS, agentOfTool, agentToolId, type AgentCall } from './agent-tool';
import { PROFILE_TOOL_ID } from './profile-tool';
import { claimStep } from '../core/sub-agent';

type Obj = Record<string, any>;

const IDLE_CLOSE_MS = 8 * 60_000;

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
  /** The account's own config folder; undefined for the built-in default account. */
  private readonly configDir?: string;

  constructor(readonly ctx: ProviderContext) {
    this.configDir = ctx.account?.dir;
  }

  /** Environment for every CLI call and agent process of this account. */
  env(): NodeJS.ProcessEnv {
    return claudeEnv(this.configDir);
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
    const [ver, status, text] = await Promise.all([
      runCli(bin, ['--version'], { timeoutMs: 12_000, env: this.env() }),
      runCli(bin, ['auth', 'status', '--json'], { timeoutMs: 12_000, env: this.env() }),
      // The CLI's own name for the plan ("Login method: Claude Max account"); JSON has only a raw id.
      runCli(bin, ['auth', 'status', '--text'], { timeoutMs: 12_000, env: this.env() }),
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
  appendix(meta?: Pick<SessionMeta, 'options'>): string {
    return [this.concise() ? CONCISE_REPLIES_PROMPT : '', this.widgets() ? WIDGET_FENCE_HINT : '', meta && browserTabEnabled(meta) ? BROWSER_HINT : '', meta && deviceEnabled(meta) ? DEVICE_HINT : '', this.profileText()].filter(Boolean).join('\n\n');
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

  agentOptions(meta: Pick<SessionMeta, 'cwd' | 'model' | 'effort' | 'mode' | 'options' | 'providerSessionId' | 'ultracode'>, owner: WarmOwner, resumeAt?: string): Options {
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
        } else if (m.type === 'result') {
          if (any.subtype === 'success' && typeof any.result === 'string' && any.result.trim()) text = any.result;
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
    const q = query({ prompt: input, options: this.agentOptions({ ...choice, model: choice.model ?? '', mode: choice.mode ?? 'default' }, owner) });
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
    const run = this.readLimitsNow(q).finally(() => {
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
  async limits(force = false): Promise<RateLimit[]> {
    for (const s of this.sessions) {
      const q = s.liveQuery();
      if (q) return this.readLimits(q, force ? 0 : 15_000);
    }
    if (this.warm) return this.readLimits(this.warm.q, force ? 0 : 15_000);
    if (!force || Date.now() - this.limitsProbeAt < 60_000) return this.limitsCache;
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

function warmKey(c: { cwd: string; model?: string; mode?: string; effort?: Effort; options?: SessionOptions; ultracode?: boolean }, concise: boolean, widgets = true, profile = '') {
  const o = c.options ?? {};
  return JSON.stringify([path.resolve(c.cwd).toLowerCase(), c.model && c.model !== 'default' ? c.model : '', c.mode || 'default', sdkEffort(c.effort) ?? '', o.browser ?? null, !!c.ultracode, concise, widgets, o.browserTab !== false, deviceEnabled(c), profile]);
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
  blocks: Map<number, { itemId: string; type: 'text' | 'thinking' | 'tool'; name?: string; json: string; peeked?: string }>;
}

class ClaudeSession implements ProviderSession {
  private q?: Query;
  private input?: PushQueue<SDKUserMessage>;
  private streams = new Map<string, StreamState>();
  private streamedMessages = new Set<string>();
  private pendingUsers = new Map<string, string>(); // sdk uuid → UserItem id
  /** Messages from people (ours, or from the Claude app) whose turn has not ended yet. */
  private outstanding = 0;
  /**
   * Claude Code's own messages (a background task's notification, a teammate's message) taken since
   * the last result. They wake the model with a turn whose result names no message of anyone's, or
   * are folded into the running turn: never counted with `outstanding`, which only people's messages close.
   */
  private wakes = 0;
  /** This CLI names the messages a result answers (`user_message_uuids`); older ones do not. */
  private namesMessages = false;
  /** The CLI's own state (session_state_changed), as last reported. */
  private cliState?: 'idle' | 'running' | 'requires_action';
  private interrupted = false;
  /** A new agent process has not said hello yet (system/init): the live line says "Starting", not "Thinking". */
  private booting = false;
  private idleTimer?: NodeJS.Timeout;
  /** Background tasks (agents, shells, monitors) running in this process, by task id. */
  private liveTasks = new Set<string>();
  private costBase = 0;
  private lastTotalCost = 0;
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
  /** A start-up option changed mid-turn: restart once the turn ends. */
  private restartPending = false;
  /** The running process has reported its own capabilities (better than the probe's). */
  liveCaps = false;
  /** This turn was refused at a plan limit: the window that refused it, and the notice that says so. */
  private limitHit?: { resetsAt?: number; window?: string };
  private limitNoticeId?: string;

  /** When this chat was last used (a message, a turn's end, Remote Control on): for the Remote Control keeper. */
  private lastActive = Date.now();
  /** This chat's place with the Remote Control keeper (server/core/remote-keep.ts). */
  private readonly remoteHolder: RemoteHolder;

  constructor(
    private rt: SessionRuntime,
    private provider: ClaudeProvider,
  ) {
    this.costBase = rt.meta.usage.costUsd ?? 0;
    this.remoteHolder = {
      id: rt.id,
      lastActive: () => this.lastActive,
      busy: () => this.rt.turnActive || this.liveTasks.size > 0,
      release: () => {
        if (this.rt.turnActive || this.liveTasks.size) return;
        this.log('claude: Remote Control process released (not used recently)');
        // As the idle close: the remote status says it reconnects when the chat is used again.
        this.shutdown();
      },
    };
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
    const meta = this.rt.meta;
    // A process started while the user was typing on the home screen, for exactly this choice.
    const warm = !meta.providerSessionId && !this.resumeAt ? this.provider.takeWarm(warmKey(meta, this.provider.concise(), this.provider.widgets(), this.provider.profileText())) : undefined;
    let q: Query;
    let input: PushQueue<SDKUserMessage>;
    if (warm) {
      warm.owner.session = this;
      ({ q, input } = warm);
      this.log('claude: adopted the prewarmed agent process');
    } else {
      input = new PushQueue<SDKUserMessage>();
      const owner: WarmOwner = { session: this };
      q = query({ prompt: input, options: this.provider.agentOptions(meta, owner, this.resumeAt) });
    }
    this.booting = !warm;
    this.resumeAt = undefined;
    this.q = q;
    this.input = input;
    this.lastActive = Date.now();
    if (meta.options?.remoteControl) holdRemote(this.remoteHolder);
    this.applied = { ...meta.options };
    this.lastTotalCost = 0;
    this.liveCaps = false;
    void this.pump(q);
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
      if (this.rt.turnActive) {
        this.restartPending = true;
        this.rt.notice('info', options.browser ? 'Browser control starts after this turn' : 'Browser control stops after this turn');
      } else this.restart();
      return;
    }
    if ((options.browserTab !== false) !== (before.browserTab !== false) || deviceEnabled({ options }) !== deviceEnabled({ options: before })) {
      // The Browser tab tools live in the process's own MCP server: only a new process changes them.
      if (this.rt.turnActive) {
        this.restartPending = true;
        this.rt.notice('info', options.browserTab !== false ? 'The Browser tab tools start after this turn' : 'The Browser tab tools stop after this turn');
      } else this.restart();
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

  /** Replaces the idle agent process so new start-up options take effect (the conversation resumes). */
  private restart() {
    this.restartPending = false;
    const keepRunning = !!this.rt.meta.options?.remoteControl;
    this.shutdown();
    this.rt.update({ remote: undefined, capState: undefined });
    if (keepRunning) this.ensure();
  }

  private async pump(q: Query) {
    let failure: string | undefined;
    try {
      for await (const m of q) {
        try {
          this.onMessage(m);
        } catch (err) {
          this.log('claude message handling failed:', (err as Error).stack);
        }
      }
    } catch (err) {
      failure = (err as Error).message || String(err);
    }
    if (this.q !== q) return;
    this.q = undefined;
    this.input = undefined;
    this.streams.clear();
    this.liveTasks.clear();
    this.wakes = 0;
    this.cliState = undefined;
    this.clearLiveState();
    // Background sub-agents and workflows lived in this process: they ended with it.
    this.rt.stopBackground();
    if (this.rt.turnActive && !this.closed) {
      this.rt.settle(failure ? 'error' : 'cancelled');
      const text = failure ?? 'Claude Code stopped unexpectedly';
      this.rt.notice('error', 'The agent process ended', text);
      this.outstanding = 0;
      this.rt.endTurn(text);
    }
  }

  private scheduleIdleClose() {
    clearTimeout(this.idleTimer);
    this.lastActive = Date.now();
    // Remote Control lives in this process: the keeper (server/core/remote-keep.ts) decides when it closes.
    if (this.q && this.rt.meta.options?.remoteControl) holdRemote(this.remoteHolder);
    this.idleTimer = setTimeout(() => {
      if (this.rt.turnActive || this.rt.meta.options?.remoteControl) return;
      // Background agents and shells live in this process too, and wake the agent when they end:
      // it stays while any runs, and the idle clock starts again once the last one is done.
      if (this.liveTasks.size) return this.scheduleIdleClose();
      this.shutdown();
    }, IDLE_CLOSE_MS);
  }

  /** The process is gone: its remote link and Chrome connection went with it. */
  private clearLiveState() {
    const meta = this.rt.meta;
    if (meta.remote) this.rt.update({ remote: meta.options?.remoteControl && !this.closed ? { status: 'Reconnects when the agent starts again', tone: 'waiting' } : undefined });
    if (meta.capState) this.rt.update({ capState: undefined });
  }

  private shutdown() {
    clearTimeout(this.idleTimer);
    dropRemote(this.remoteHolder);
    const q = this.q;
    if (q) this.clearLiveState();
    this.q = undefined;
    this.cliState = undefined;
    this.input?.end();
    this.input = undefined;
    this.costBase = this.rt.meta.usage.costUsd ?? this.costBase;
    try {
      q?.close();
    } catch {
      /* already closed */
    }
  }

  async close() {
    this.closed = true;
    this.shutdown();
    this.provider.sessions.delete(this);
  }

  // ── commands from the UI ──

  async send(item: UserItem) {
    // Otherwise the SDK reports a missing cwd as a binary that "failed to launch".
    if (!existsSync(this.rt.meta.cwd)) throw new Error(`The folder ${this.rt.meta.cwd} does not exist.`);
    this.closed = false;
    this.lastActive = Date.now();
    this.ensure();
    clearTimeout(this.idleTimer);
    const uuid = randomUUID();
    this.pendingUsers.set(uuid, item.id);
    const images = (item.attachments ?? []).filter((a) => a.kind === 'image' && a.dataUrl);
    const files = (item.attachments ?? []).filter((a) => a.kind !== 'image' && a.path);
    let text = item.text;
    if (files.length) text += '\n\n' + files.map((f) => `@${f.path}`).join(' ');
    const content: unknown = images.length
      ? [
          ...images.map((a) => {
            const m = a.dataUrl!.match(/^data:([^;]+);base64,(.*)$/);
            return { type: 'image', source: { type: 'base64', media_type: m?.[1] ?? 'image/png', data: m?.[2] ?? '' } };
          }),
          { type: 'text', text },
        ]
      : text;
    this.outstanding++;
    this.interrupted = false;
    // Local commands (/cost, /context) can take a while and never "think".
    const command = /^\/[\w:-]+/.exec(item.text.trim())?.[0];
    if (!this.rt.turnActive) this.rt.beginTurn(command ? `Running ${command}` : this.booting ? 'Starting' : 'Thinking');
    this.input!.push({
      type: 'user',
      uuid,
      session_id: this.rt.meta.providerSessionId ?? '',
      parent_tool_use_id: null,
      message: { role: 'user', content },
      // Steered: taken at the agent's next step (between tool calls) and nothing it did is discarded.
      // "now" would abort the step in flight; "later" would wait for the turn to end.
      ...(item.steered && this.rt.turnActive ? { priority: 'next' } : {}),
    } as unknown as SDKUserMessage);
  }

  async interrupt() {
    if (!this.q || !this.rt.turnActive) return;
    this.interrupted = true;
    try {
      await withTimeout(Promise.resolve(this.q.interrupt()), 4_000, 'interrupt');
    } catch {
      /* fall through to the safety net */
    }
    // The CLI answers with a result message; if it does not, close the turn ourselves.
    setTimeout(() => {
      if (this.interrupted && this.rt.turnActive) this.finishTurn(undefined, true);
    }, 2_500);
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
    const at = item.providerId ? this.chain.indexOf(item.providerId) : -1;
    this.shutdown();
    if (at > 0) this.resumeAt = this.chain[at - 1];
    else this.rt.update({ providerSessionId: undefined });
    this.chain = at > 0 ? this.chain.slice(0, at) : [];
    const idx = this.rt.items.findIndex((i) => i.id === itemId);
    if (idx >= 0) this.rt.reset(this.rt.items.slice(0, idx));
    this.rt.notice('rewind', 'Rewound the conversation', note || undefined);
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
    if (bypassesAsking(rt.meta.mode)) {
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
    if (name === 'ExitPlanMode') {
      options = [
        { id: 'plan-auto', label: 'Approve and accept edits', tone: 'always' },
        { id: 'plan-ask', label: 'Approve, ask before edits', tone: 'allow' },
        { id: 'deny', label: 'Keep planning', hint: 'Send feedback on the plan', tone: 'deny' },
      ];
    } else {
      options = [{ id: 'allow', label: 'Allow once', tone: 'allow' }];
      const always = !o.suppressAlwaysAllowRule && suggestions.length ? describeSuggestion(suggestions[0], view.detail.path) : undefined;
      if (always) options.push({ id: 'always', label: always.label, hint: always.hint, tone: 'always' });
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
        reason: o.blockedPath ? `Outside the allowed folders: ${o.blockedPath}` : undefined,
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

  private onMessage(m: SDKMessage) {
    const any = m as Obj;
    if (any.session_id && any.session_id !== this.rt.meta.providerSessionId) this.rt.update({ providerSessionId: any.session_id });
    if (this.booting) {
      // The process is up and the turn has reached the model.
      this.booting = false;
      if (this.rt.turnActive && this.rt.meta.activity === 'Starting') this.rt.update({ activity: 'Thinking' });
    }
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
      case 'rate_limit_event': {
        // The windows come with the event itself: no usage read needed.
        const hit = this.provider.onRateLimit(any.rate_limit_info);
        if (hit) {
          this.limitHit = hit;
          const n = this.limitNoticeId ? this.rt.get<NoticeItem>(this.limitNoticeId) : undefined;
          if (n?.limit && !n.limit.resetsAt) this.rt.patch<NoticeItem>(n.id, { limit: { ...n.limit, ...hit } });
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
        if (s.messageId) this.streamedMessages.add(s.messageId);
        break;
      case 'content_block_start': {
        const b = ev.content_block ?? {};
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
          rt.delta(blk.itemId, 'inputText', d.partial_json ?? '');
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
    const patch: Partial<ToolItem> = { input, title: view.title, detail: view.detail, kind: view.kind, inputText: undefined };
    if (item.status === 'pending') patch.status = 'running';
    if ((name === 'Edit' || name === 'Write') && !item.result) patch.result = { diff: previewDiff(name, input) };
    if (name === 'Workflow' && !item.workflow) patch.workflow = workflowStart(input);
    rt.patch<ToolItem>(id, patch);
    if (name === 'TodoWrite') rt.setTodos(normalizeTodos(input.todos));
    if (!item.parentId) rt.update({ activity: view.title });
  }

  private onAssistant(m: Obj) {
    const rt = this.rt;
    const parentId: string | undefined = m.parent_tool_use_id ?? undefined;
    const msg = m.message ?? {};
    const synthetic = msg.model === '<synthetic>';
    // Keyed by uuid, not message.id: the CLI sends one assistant message per content block under one id.
    // After /compact it re-sends local command output (/context, /cost) it already showed.
    const texts = ((msg.content as Obj[] | undefined) ?? []).filter((b) => b.type === 'text' && b.text).map((b) => String(b.text));
    const repeat = (m.uuid && this.seenMessages.has(m.uuid)) || (synthetic && this.compacted && texts.length > 0 && texts.every((t) => this.syntheticTexts.has(t)));
    if (m.uuid) this.seenMessages.add(m.uuid);
    if (repeat) return;
    if (m.uuid && !parentId) this.chain.push(m.uuid);
    if (this.retryNotice) {
      rt.remove(this.retryNotice);
      this.retryNotice = undefined;
    }
    const streamed = msg.id && this.streamedMessages.has(msg.id);
    // Refused at a plan limit: the CLI's own words ("usage limit reached…") become the limit notice, not a reply.
    const atLimit = m.error === 'rate_limit' && !parentId;
    if (synthetic) for (const t of texts) this.syntheticTexts.add(t);
    for (const b of (msg.content as Obj[] | undefined) ?? []) {
      if (b.type === 'tool_use' || b.type === 'server_tool_use') {
        if (!rt.get(b.id)) {
          const view = describeTool(b.name, b.input ?? {});
          rt.add<ToolItem>({ id: b.id, type: 'tool', name: b.name, ...view, status: 'pending', parentId });
        }
        this.toolReady(b.id, b.name, b.input ?? {});
      } else if (!streamed && !atLimit && b.type === 'text' && b.text) {
        rt.add<TextItem>({ type: 'text', text: b.text, streaming: false, parentId });
      } else if (!streamed && b.type === 'thinking' && b.thinking) {
        rt.add<ThinkingItem>({ type: 'thinking', text: b.thinking, streaming: false, endedAt: Date.now(), parentId });
      }
    }
    if (atLimit) {
      if (!this.limitNoticeId) {
        const said = texts.join(' ');
        // Older CLIs say "Claude AI usage limit reached|<reset time in epoch seconds>".
        const stamp = epochMs(Number(/\|(\d{9,13})\b/.exec(said)?.[1]));
        const detail = said.replace(/\|\d{9,13}\b/, '').trim() || undefined;
        this.limitNoticeId = rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: errorLabel(m.error), detail, limit: { resetsAt: this.limitHit?.resetsAt ?? stamp, window: this.limitHit?.window } }).id;
      }
    } else if (m.error) rt.notice('error', errorLabel(m.error));
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
      const itemId = m.uuid ? this.pendingUsers.get(m.uuid) : undefined;
      if (itemId) {
        this.pendingUsers.delete(m.uuid);
        this.chain.push(m.uuid);
        // Replayed when the agent takes it: a steered message stays where it was sent.
        rt.taken(itemId, { providerId: m.uuid });
        return;
      }
      if (m.parent_tool_use_id) return;
      // The same message replayed again (a reconnect, a repeat) is already in the conversation.
      if (m.uuid && (this.chain.includes(m.uuid) || rt.items.some((i) => i.type === 'user' && i.providerId === m.uuid))) return;
      const text = replayText(m.message?.content);
      if (!text) return;
      // Written by Claude Code in the person's place (a task finished, a command and its output):
      // shown as a line (shared/synthetic.ts), never as a message from the Claude app.
      const syn = parseSynthetic(text);
      // A slash command Sable sent comes back in the CLI's own tags (`<command-name>/compact</command-name>…`).
      const echo = syn?.role === 'command' ? syntheticLine(syn) : '';
      // One of ours under another uuid (a steer the CLI folded in): the same words, still waiting.
      for (const [uuid, id] of this.pendingUsers) {
        const mine = rt.get<UserItem>(id);
        // Sable may have sent more than the words (a summary before them, a line on the Browser tab, pictures).
        const words = mine?.text.trim() ?? '';
        if (mine && (words === text.trim() || (words.length >= 12 && text.includes(words)) || (!!echo && words === echo))) {
          this.pendingUsers.delete(uuid);
          if (m.uuid) this.chain.push(m.uuid);
          rt.taken(id, { providerId: m.uuid });
          return;
        }
      }
      if (m.uuid) this.chain.push(m.uuid);
      // Claude Code's own (a background task ended, a teammate wrote): it wakes the model with a turn of
      // its own, whose result names no message, or is folded into the running turn and has none.
      if (syn || m.isSynthetic === true) {
        rt.add<UserItem>({ type: 'user', text, state: 'sent', providerId: m.uuid, ...(syn ? {} : { remote: true }) });
        // Output, summaries and wrappers belong to the turn they came in; a notification or a command opens one.
        if (syn?.role === 'output' || syn?.role === 'summary' || syn?.role === 'hidden') return;
        this.wakes++;
        if (!rt.turnActive) rt.beginTurn('Thinking');
        return;
      }
      // A message sent from elsewhere (Remote Control in the Claude app or on claude.ai): it belongs
      // in this conversation, and the turn it starts runs here too.
      rt.add<UserItem>({ type: 'user', text, state: 'sent', providerId: m.uuid, remote: true });
      // It gets a result of its own (or is folded into the running turn's): either way the turn waits for it.
      this.outstanding++;
      if (!rt.turnActive) rt.beginTurn('Thinking');
      return;
    }
    if (m.uuid && !m.parent_tool_use_id) this.chain.push(m.uuid);
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content as Obj[]) {
      if (b.type !== 'tool_result') continue;
      const item = rt.get<ToolItem>(b.tool_use_id);
      if (!item) continue;
      const result = mapResult(item.name, (item.input as Obj) ?? {}, m.tool_use_result, b.content, !!b.is_error);
      const status = item.status === 'denied' || item.status === 'cancelled' ? item.status : b.is_error ? 'error' : 'done';
      // Keep answers / preview diff when the result itself carries less.
      const merged = { ...item.result, ...result, diff: result.diff ?? item.result?.diff, answers: result.answers ?? item.result?.answers };
      if (status === 'denied') merged.diff = item.result?.diff;
      const limit = merged.agent?.limit;
      if (limit && !limit.resetsAt) {
        const resetsAt = this.provider.windowReset(limit.window) ?? (this.limitHit?.window === limit.window ? this.limitHit.resetsAt : undefined);
        if (resetsAt) merged.agent = { ...merged.agent, limit: { ...limit, resetsAt } };
      }
      rt.patch<ToolItem>(item.id, { status, result: merged, endedAt: Date.now() });
      this.trackTasks(item, m.tool_use_result);
    }
    if (!m.parent_tool_use_id && rt.turnActive) rt.update({ activity: 'Thinking' });
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

  /** Messages the CLI has answered for (`uuids`, or all sent so far): taken, even when no replay said so. */
  private takeUsers(uuids?: readonly unknown[]) {
    for (const uuid of uuids ?? [...this.pendingUsers.keys()]) {
      const itemId = typeof uuid === 'string' ? this.pendingUsers.get(uuid) : undefined;
      if (!itemId) continue;
      this.pendingUsers.delete(uuid as string);
      if (this.rt.get<UserItem>(itemId)?.state === 'queued') this.rt.taken(itemId);
    }
  }

  private onResult(m: Obj) {
    const rt = this.rt;
    // The messages this result answers for (a steer folded into the turn is one of them).
    if (Array.isArray(m.user_message_uuids)) this.takeUsers(m.user_message_uuids);
    const listed = Array.isArray(m.user_message_uuids) ? m.user_message_uuids.length : 0;
    if (listed) this.namesMessages = true;
    // A result that names no message ends a turn Claude Code started on its own (a wake) when this CLI
    // names the messages its turns answer; an older one names none, and each result answers one.
    const answered = listed || (this.wakes > 0 && this.namesMessages ? 0 : 1);
    this.outstanding = Math.max(0, this.outstanding - answered);
    // Its own messages are taken when they are replayed: whatever woke the model is answered by now.
    this.wakes = 0;
    const total = Number(m.total_cost_usd ?? 0);
    const usage: SessionUsage = { ...rt.meta.usage };
    // total_cost_usd counts from the start of this CLI process (reset in ensure()).
    const turnCost = Math.max(0, total - this.lastTotalCost);
    usage.costUsd = (usage.costUsd ?? 0) + turnCost;
    this.lastTotalCost = total;
    usage.turns += 1;
    usage.inputTokens += Number(m.usage?.input_tokens ?? 0) + Number(m.usage?.cache_creation_input_tokens ?? 0);
    usage.outputTokens += Number(m.usage?.output_tokens ?? 0);
    usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + Number(m.usage?.cache_read_input_tokens ?? 0);
    const window = Object.values((m.modelUsage as Record<string, Obj>) ?? {}).reduce((max, u) => Math.max(max, Number(u.contextWindow ?? 0)), 0);
    if (window) usage.contextWindow = window;
    rt.update({ usage });

    this.compacted = false;
    const failed = m.subtype !== 'success' || m.is_error;
    const wasInterrupted = this.interrupted;
    let error: string | undefined;
    if (failed && !wasInterrupted) {
      error =
        (Array.isArray(m.errors) && m.errors.length ? m.errors.join('\n') : undefined) ??
        (typeof m.result === 'string' && m.result ? m.result : undefined) ??
        resultLabel(m.subtype);
    }
    if (!wasInterrupted) {
      rt.add<TurnItem>({
        type: 'turn',
        durationMs: Number(m.duration_ms ?? Date.now() - rt.turnStartedAt),
        costUsd: turnCost || undefined,
        inputTokens: Number(m.usage?.input_tokens ?? 0) + Number(m.usage?.cache_read_input_tokens ?? 0) + Number(m.usage?.cache_creation_input_tokens ?? 0),
        outputTokens: Number(m.usage?.output_tokens ?? 0),
        stopReason: m.stop_reason ?? undefined,
        error,
      });
    }
    // Fresh plan limits after every turn (shared with any read in the last few seconds).
    if (this.q) void this.provider.readLimits(this.q);
    if (this.outstanding > 0) {
      // Queued messages are still coming: the next turn starts right away.
      this.interrupted = false;
      rt.update({ activity: 'Thinking' });
      return;
    }
    this.finishTurn(error, wasInterrupted);
  }

  private finishTurn(error: string | undefined, interrupted: boolean) {
    const rt = this.rt;
    if (!rt.turnActive) return;
    this.interrupted = false;
    this.outstanding = 0;
    this.wakes = 0;
    this.limitHit = undefined;
    this.limitNoticeId = undefined;
    rt.settle(interrupted ? 'cancelled' : error ? 'error' : 'cancelled');
    if (interrupted) rt.notice('interrupted', 'Interrupted');
    // Every message sent has had its result: a steer whose replay never came (or came under
    // another uuid) was taken all the same. After an interrupt the bridge takes untaken ones back.
    else this.takeUsers();
    rt.endTurn(error);
    this.scheduleIdleClose();
    if (this.restartPending) setTimeout(() => !this.rt.turnActive && this.restartPending && this.restart(), 0);
    else if (this.q && rt.meta.options?.browser) void this.checkBrowser(this.q);
  }

  private onSystem(m: Obj) {
    const rt = this.rt;
    switch (m.subtype) {
      case 'init': {
        if (Array.isArray(m.skills)) this.skillNames = m.skills.map(String);
        if (m.permissionMode && m.permissionMode !== rt.meta.mode) rt.update({ mode: m.permissionMode });
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
        if (m.permissionMode && m.permissionMode !== rt.meta.mode) rt.update({ mode: m.permissionMode });
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
        if (m.content) rt.notice('command', 'Command output', String(m.content));
        break;
      case 'informational':
        if (m.content && m.level !== 'suggestion') rt.notice(m.level === 'warning' ? 'error' : 'info', String(m.content));
        break;
      case 'permission_denied': {
        const item = rt.get<ToolItem>(m.tool_use_id);
        if (item && item.status !== 'denied') rt.patch<ToolItem>(item.id, { status: 'denied', endedAt: Date.now(), result: { ...item.result, text: m.message } });
        break;
      }
      case 'task_progress': {
        const item = m.tool_use_id ? rt.get<ToolItem>(m.tool_use_id) : undefined;
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
      case 'background_tasks_changed':
        // Every live background task (replace, not merge): the process is kept open while any runs.
        this.liveTasks = new Set(((m.tasks as Obj[] | undefined) ?? []).map((t) => String(t.task_id)));
        break;
      case 'task_started': {
        if (m.task_id) this.liveTasks.add(String(m.task_id));
        const item = m.tool_use_id ? rt.get<ToolItem>(m.tool_use_id) : undefined;
        if (item?.workflow && m.workflow_name && !item.workflow.name) rt.patch<ToolItem>(item.id, { workflow: { ...item.workflow, name: String(m.workflow_name) } });
        break;
      }
      case 'task_notification': {
        if (m.task_id) this.liveTasks.delete(String(m.task_id));
        // How a sub-agent ended, with its own figures. For one started in the background this is the only word of it.
        const item = m.tool_use_id ? rt.get<ToolItem>(m.tool_use_id) : undefined;
        if (item?.workflow) {
          const run = workflowProgress(item.workflow, m);
          run.status = m.status === 'completed' ? 'done' : m.status === 'failed' ? 'failed' : 'stopped';
          if (typeof m.usage?.duration_ms === 'number') run.durationMs = m.usage.duration_ms;
          delete run.limitWait;
          rt.patch<ToolItem>(item.id, { workflow: run });
        }
        if (item?.kind !== 'agent' || !item.result) break;
        const agent = { ...item.result.agent, ...taskFigures(m.usage) };
        if (agent.background) agent.background = m.status === 'completed' ? 'done' : m.status === 'failed' ? 'failed' : 'stopped';
        rt.patch<ToolItem>(item.id, { result: { ...item.result, agent } });
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
        // Idle with nothing of Sable's still on its way: whatever no result closed (a message from the Claude
        // app folded into the turn, a background task's notification that woke no model turn) is over.
        // A message of ours it has not read yet keeps the turn: its own turn is still to come.
        if (m.state === 'idle' && rt.turnActive && (this.outstanding <= 0 || this.pendingUsers.size === 0)) this.finishTurn(undefined, this.interrupted);
        // Work it started on its own, with no message to replay (a scheduled wake-up): a turn like any other,
        // which its result or the next idle ends. Only from idle: after a prompt it is the same work going on.
        else if (m.state === 'running' && prev === 'idle' && !rt.turnActive && this.q && !this.closed) {
          this.wakes++;
          rt.beginTurn('Thinking');
        }
        break;
      }
      default:
        break;
    }
  }

  // ── stored transcripts ──

  async loadTranscript() {
    const rt = this.rt;
    const id = rt.meta.providerSessionId;
    if (!id) return;
    const messages = (await this.provider.withHistory(() => getSessionMessages(id, { dir: rt.meta.cwd }))) as Obj[];
    const items: TimelineItem[] = [];
    const tools = new Map<string, ToolItem>();
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
    for (const m of messages) {
      const parentId: string | undefined = m.parent_tool_use_id ?? undefined;
      const msg = (m.message ?? {}) as Obj;
      const content = msg.content;
      const stamp = Date.parse(String(m.timestamp ?? ''));
      real = Number.isFinite(stamp) ? stamp : undefined;
      if (m.type === 'assistant' && Array.isArray(content)) {
        if (!parentId) this.chain.push(m.uuid);
        for (const b of content as Obj[]) {
          if (b.type === 'text' && b.text) push({ type: 'text', text: b.text, streaming: false, parentId });
          else if (b.type === 'thinking' && b.thinking) push({ type: 'thinking', text: b.thinking, streaming: false, endedAt: real, parentId });
          else if (b.type === 'tool_use') {
            let input: Obj = b.input ?? {};
            // The plan lives in the plan file the agent wrote just before; the stored call is often empty.
            if ((b.name === 'Write' || b.name === 'Edit') && isPlanFile(input.file_path)) planDraft = b.name === 'Write' ? input.content : planDraft;
            if (b.name === 'ExitPlanMode' && planDraft) input = { ...input, plan: planDraft };
            const view = describeTool(b.name, input);
            const t = push({ id: b.id, type: 'tool', name: b.name, ...view, input, status: 'done', parentId }) as ToolItem;
            if (b.name === 'Edit' || b.name === 'Write') t.result = { diff: previewDiff(b.name, input) };
            if (b.name === 'Workflow') t.workflow = { ...workflowStart(input), status: 'done' };
            tools.set(b.id, t);
          }
        }
      } else if (m.type === 'user') {
        if (!parentId) this.chain.push(m.uuid);
        if (typeof content === 'string') {
          if (isHumanText(content) && !parentId) {
            firstPrompt ??= content;
            push({ type: 'user', text: content, state: 'sent', providerId: m.uuid });
          }
        } else if (Array.isArray(content)) {
          const text = flattenContent(content.filter((b: Obj) => b.type === 'text')).text;
          for (const b of content as Obj[]) {
            if (b.type !== 'tool_result') continue;
            const t = tools.get(b.tool_use_id);
            if (!t) continue;
            const result = mapResult(t.name, (t.input as Obj) ?? {}, undefined, b.content, !!b.is_error);
            t.result = { ...t.result, ...result, diff: result.diff ?? t.result?.diff };
            t.status = !b.is_error ? 'done' : isDenial(flattenContent(b.content).text) ? 'denied' : 'error';
            if (real) t.endedAt = real;
          }
          if (text && isHumanText(text) && !parentId && !content.some((b: Obj) => b.type === 'tool_result')) {
            firstPrompt ??= text;
            push({ type: 'user', text, state: 'sent', providerId: m.uuid });
          }
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
  const where = (d: string) => (d === 'session' ? 'this session' : d === 'userSettings' ? 'everywhere' : 'this project');
  if (s.type === 'setMode') {
    if (s.mode === 'acceptEdits') return { label: 'Allow all edits', hint: `for ${where(s.destination)}` };
    return { label: `Switch to ${s.mode}`, hint: `for ${where(s.destination)}` };
  }
  if (s.type === 'addRules' && s.rules.length) {
    const r = s.rules[0];
    const what = r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName;
    return { label: `Always allow ${what.length > 44 ? what.slice(0, 42) + '…' : what}`, hint: `in ${where(s.destination)}` };
  }
  if (s.type === 'addDirectories' && s.directories.length) {
    return { label: `Allow access to ${baseName(s.directories[0])}`, hint: `for ${where(s.destination)}` };
  }
  void filePath;
  return undefined;
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
