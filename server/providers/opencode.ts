/**
 * OpenCode, through its Agent Client Protocol server (`opencode acp`): one process serves every
 * session, each session is an ACP session, and what the agent does streams back as
 * `session/update` notifications that are normalized into the same timeline as the other agents.
 *
 * OpenCode has no accounts of its own (it signs in to model providers, and runs on its free models
 * with no sign-in). Its plan limits are OpenCode Go's windows, read from the CLI (`limits()`). It
 * takes no message mid-turn: a message sent while it works waits in the queue.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  Capabilities,
  ContextBreakdown,
  Effort,
  HistoryEntry,
  McpServerInfo,
  ModelInfo,
  ProviderInfo,
  RateLimit,
  TextItem,
  ThinkingItem,
  ToolItem,
  TurnItem,
  UserItem,
} from '../../shared/protocol';
import type { SessionRuntime } from '../core/runtime';
import { runCli } from '../util/proc';
import { openCodeConfig } from '../services/config';
import { killTree } from './codex-rpc';
import { AcpClient, AcpError, type AcpExit } from './opencode-acp';
import {
  ALLOW_ALL_MODE,
  MODES,
  agentModeFor,
  commandsOf,
  describeCall,
  effortsOf,
  inputOf,
  locationPath,
  modelsOf,
  mapGoLimits,
  parseAuthList,
  promptBlocks,
  resultOf,
  statusOf,
  todosOf,
} from './opencode-map';
import type { Provider, ProviderContext, ProviderSession } from './types';
import { VERSION } from '../version';

/** How long a read of the plan limits is reused when nothing forces a new one. */
const LIMITS_TTL_MS = 60_000;

type Obj = Record<string, any>;

/** How long the process runs on with no session open before it is stopped. */
const IDLE_STOP_MS = 60_000;
/** How long a probe's capabilities stay fresh. */
const CAPS_TTL_MS = 10 * 60_000;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface CapsInfo {
  models: ModelInfo[];
  efforts?: Effort[];
  commands: Capabilities['commands'];
  at: number;
}

export class OpenCodeProvider implements Provider {
  readonly id = 'opencode' as const;
  readonly name = 'OpenCode';

  /** ACP session id → session */
  readonly sessions = new Map<string, OpenCodeSession>();
  private acp: AcpClient | null = null;
  private starting: Promise<AcpClient> | null = null;
  private disposed = false;
  private idleTimer?: NodeJS.Timeout;
  private versionCache?: { installed: boolean; version?: string; problem?: string };
  private limitsRead?: { at: number; run: Promise<RateLimit[]> };
  private capsCache?: CapsInfo;
  private capsLoading?: Promise<CapsInfo>;
  /** Commands announced by a session the provider itself opened to read the capabilities. */
  private probeCommands = new Map<string, Capabilities['commands']>();
  private login_?: { child: ChildProcess; cancelled: boolean };

  constructor(readonly ctx: ProviderContext) {}

  configHome(): string {
    return process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, 'opencode') : path.join(homedir(), '.local', 'share', 'opencode');
  }

  // ── process ──

  async client(): Promise<AcpClient> {
    if (this.disposed) throw new Error('OpenCode provider is shut down');
    this.armIdle();
    if (this.acp?.alive) return this.acp;
    if (!this.starting) {
      this.starting = AcpClient.start({ log: this.ctx.log, clientVersion: VERSION })
        .then(async (acp) => {
          if (this.disposed) {
            await acp.close();
            throw new Error('OpenCode provider is shut down');
          }
          acp.onNotification = (m, p) => this.onNotification(m, p);
          acp.onRequest = (m, p) => this.onRequest(m, p);
          acp.onExit = (info) => this.onExit(acp, info);
          this.acp = acp;
          return acp;
        })
        .finally(() => {
          this.starting = null;
        });
    }
    return this.starting;
  }

  private armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.sessions.size || this.capsLoading || this.starting) return this.armIdle();
      const acp = this.acp;
      if (!acp) return;
      this.ctx.log('[opencode] stopping idle process');
      this.acp = null;
      void acp.close().catch(() => {});
    }, IDLE_STOP_MS);
    this.idleTimer.unref?.();
  }

  private onExit(acp: AcpClient, info: AcpExit) {
    if (this.acp === acp) this.acp = null;
    if (this.disposed) return;
    const tail = info.stderr
      .replace(/\x1b\[[0-9;]*m/g, '')
      .trim()
      .split('\n')
      .slice(-3)
      .join('\n');
    this.ctx.log('[opencode] process exited', info.code ?? info.signal ?? '', tail);
    const msg = `OpenCode stopped${info.code !== null ? ` (code ${info.code})` : ''}`;
    for (const s of [...this.sessions.values()]) s.onServerDied(msg, tail);
    this.sessions.clear();
  }

  private onNotification(method: string, p: Obj) {
    if (method !== 'session/update') return;
    const sid = String(p.sessionId ?? '');
    const s = this.sessions.get(sid);
    if (s) return s.onUpdate(p.update ?? {});
    if (p.update?.sessionUpdate === 'available_commands_update') this.probeCommands.set(sid, commandsOf(p.update.availableCommands));
  }

  private async onRequest(method: string, p: Obj): Promise<unknown> {
    if (method === 'session/request_permission') {
      const s = this.sessions.get(String(p.sessionId ?? ''));
      // Nobody to ask: refuse.
      return s ? s.onPermission(p) : { outcome: { outcome: 'cancelled' } };
    }
    throw new AcpError(`Sable does not support ${method}`, -32601);
  }

  // ── info & sign-in ──

  private version(force: boolean): Promise<{ installed: boolean; version?: string; problem?: string }> {
    if (this.versionCache && !force) return Promise.resolve(this.versionCache);
    return runCli('opencode', ['--version'], { timeoutMs: 15_000 }).then((r) => {
      const m = r.stdout.match(/(\d+\.\d+\.\d+[\w.-]*)/);
      this.versionCache =
        r.missing || (!m && r.code !== 0)
          ? { installed: false, problem: r.missing ? 'OpenCode is not installed (npm i -g opencode-ai)' : `opencode --version failed: ${(r.stderr || r.stdout).trim().split('\n')[0].slice(0, 160)}` }
          : { installed: true, version: m?.[1] ?? r.stdout.trim() };
      return this.versionCache;
    });
  }

  async info(force = false): Promise<ProviderInfo> {
    const v = await this.version(force);
    const base = { id: this.id, name: this.name, installed: v.installed, version: v.version };
    if (!v.installed) return { ...base, auth: { loggedIn: false }, problem: v.problem };
    const r = await runCli('opencode', ['auth', 'list'], { timeoutMs: 15_000 });
    return { ...base, auth: r.code === 0 ? parseAuthList(r.stdout) : { loggedIn: true, method: 'free', plan: 'Free models', org: 'No sign-in needed' } };
  }

  /** `opencode auth login` and `logout` are terminal dialogs: each runs in a console window of its own, and ends when that closes. */
  private async inConsole(command: 'login' | 'logout'): Promise<void> {
    await this.cancelLogin();
    if (process.platform !== 'win32') throw new Error(`Run \`opencode auth ${command}\` in a terminal.`);
    if (command === 'login') this.ctx.emit({ type: 'auth.progress', provider: 'opencode', state: 'url', message: 'Finish signing in in the OpenCode window that opened.' });
    const child = spawn('cmd.exe', ['/c', 'start', `"OpenCode ${command}"`, '/wait', 'opencode', 'auth', command], { windowsHide: false, stdio: 'ignore' });
    const l = { child, cancelled: false };
    this.login_ = l;
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => resolve());
    }).finally(() => {
      if (this.login_ === l) this.login_ = undefined;
      this.capsCache = undefined;
    });
  }

  login(): Promise<void> {
    return this.inConsole('login');
  }

  async cancelLogin(): Promise<void> {
    const l = this.login_;
    if (!l) return;
    l.cancelled = true;
    killTree(l.child);
  }

  async logout(): Promise<void> {
    await this.inConsole('logout');
    this.ctx.emit({ type: 'provider.updated', provider: await this.info(true) });
  }

  // ── capabilities ──

  capsOf(info: CapsInfo, mcpServers: McpServerInfo[] = []): Capabilities {
    return {
      models: info.models,
      modes: MODES,
      commands: info.commands,
      skills: [],
      agents: [],
      mcpServers,
      tools: [],
      skillTrigger: '/',
      features: { images: true, thinking: true, rewind: false, steer: false, compact: info.commands.some((c) => c.name === 'compact'), fast: false },
    };
  }

  /** What the agent offers, read from an ACP session opened for the purpose and deleted again. */
  private probe(cwd?: string): Promise<CapsInfo> {
    this.capsLoading ??= (async () => {
      const acp = await this.client();
      const r = await acp.request('session/new', { cwd: cwd && existsSync(cwd) ? cwd : homedir(), mcpServers: [] }, 60_000);
      const sid = String(r.sessionId);
      await new Promise((resolve) => setTimeout(resolve, 250)).catch(() => {});
      const info = this.readOptions(r.configOptions, this.probeCommands.get(sid));
      this.probeCommands.delete(sid);
      await this.discard(acp, sid);
      return info;
    })()
      .then((info) => (this.capsCache = info))
      .finally(() => {
        this.capsLoading = undefined;
      });
    return this.capsLoading;
  }

  /** Remembers what a session's config options say (models, efforts) as the provider's capabilities. */
  readOptions(options: unknown, commands?: Capabilities['commands']): CapsInfo {
    const list = (Array.isArray(options) ? options : []) as Obj[];
    const efforts = effortsOf(list.find((o) => o.id === 'effort' || o.category === 'thought_level'));
    const info: CapsInfo = {
      models: modelsOf(
        list.find((o) => o.id === 'model' || o.category === 'model'),
        efforts,
      ),
      efforts,
      commands: commands ?? this.capsCache?.commands ?? [],
      at: Date.now(),
    };
    if (info.models.length) this.capsCache = info;
    return info;
  }

  setCommands(commands: Capabilities['commands']) {
    if (this.capsCache) this.capsCache = { ...this.capsCache, commands };
  }

  private async discard(acp: AcpClient, sessionId: string) {
    const can = acp.init?.agentCapabilities?.sessionCapabilities ?? {};
    const method = can.delete ? 'session/delete' : can.close ? 'session/close' : undefined;
    if (method) await acp.request(method, { sessionId }, 15_000).catch(() => {});
  }

  async caps(cwd?: string): Promise<Capabilities> {
    const hit = this.capsCache;
    if (hit && Date.now() - hit.at < CAPS_TTL_MS) return this.capsOf(hit, await this.servers(cwd));
    if (hit) {
      void this.probe(cwd).catch(() => {});
      return this.capsOf(hit, await this.servers(cwd));
    }
    return this.capsOf(await this.probe(cwd), await this.servers(cwd));
  }

  /** The MCP servers named in OpenCode's config (user and project): it does not say which of them started. */
  async servers(cwd?: string): Promise<McpServerInfo[]> {
    try {
      return (await openCodeConfig(homedir(), cwd && existsSync(cwd) ? cwd : undefined)).servers;
    } catch {
      return [];
    }
  }

  /**
   * OpenCode Go's plan windows, asked of the CLI (`opencode api experimental.usage.limits`, which
   * uses the sign-in OpenCode keeps; Sable reads no credential file). Read at most once a minute
   * unless forced. A failed read keeps what was known: it returns nothing and says nothing.
   */
  limits(force = false): Promise<RateLimit[]> {
    if (!force && this.limitsRead && Date.now() - this.limitsRead.at < LIMITS_TTL_MS) return this.limitsRead.run;
    const run = runCli('opencode', ['api', 'experimental.usage.limits'], { timeoutMs: 20_000 }).then((r) => {
      if (r.code !== 0) return [];
      const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as unknown;
      const { limits, meta } = mapGoLimits(json);
      this.ctx.emit({ type: 'limits.updated', provider: 'opencode', limits, meta });
      return limits;
    }).catch(() => []);
    this.limitsRead = { at: Date.now(), run };
    return run;
  }

  // ── history ──

  async history(cwd?: string, limit?: number): Promise<HistoryEntry[]> {
    const acp = await this.client();
    const out: HistoryEntry[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await acp.request('session/list', { ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) }, 30_000);
      for (const s of (r.sessions ?? []) as Obj[]) {
        const title = typeof s.title === 'string' ? s.title : '';
        // A session that never had a message keeps OpenCode's placeholder title.
        if (!title || /^New session - \d{4}-/.test(title)) continue;
        out.push({ provider: 'opencode', providerSessionId: String(s.sessionId), title, cwd: typeof s.cwd === 'string' ? s.cwd : undefined, updatedAt: Date.parse(s.updatedAt) || 0 });
      }
      cursor = r.nextCursor ?? undefined;
      if (!cursor || (limit && out.length >= limit)) break;
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return limit ? out.slice(0, limit) : out;
  }

  // ── sessions ──

  async open(rt: SessionRuntime, opts: { loadTranscript?: boolean }): Promise<ProviderSession> {
    const session = new OpenCodeSession(this, rt);
    await session.attach(!!opts.loadTranscript);
    return session;
  }

  sessionClosed() {
    if (!this.sessions.size) this.armIdle();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    await this.cancelLogin();
    for (const s of this.sessions.values()) s.onServerDied('OpenCode provider is shut down');
    this.sessions.clear();
    const acp = this.acp ?? (await this.starting?.catch(() => null)) ?? null;
    this.acp = null;
    await acp?.close();
  }
}

// ─────────────────────────────────── session ───────────────────────────────────

interface ToolState {
  id: string;
  name: string;
  claudeName: string;
  input: Obj;
}

interface Queued {
  item: UserItem;
}

class OpenCodeSession implements ProviderSession {
  sessionId = '';
  private closed = false;
  private turn?: { stop?: NodeJS.Timeout; done: boolean };
  private queue: Queued[] = [];
  private tools = new Map<string, ToolState>();
  private text?: { id: string; messageId?: string };
  private thinking?: { id: string; messageId?: string };
  /** Replaying a stored conversation (`session/load`): user messages and turn ends come from the replay, not from a prompt. */
  private replaying?: { user?: { id: string; messageId?: string } };
  /** The values OpenCode runs the session with, as it last said (model, effort, agent mode). */
  private applied: { model?: string; effort?: string; mode?: string } = {};
  private options: Obj[] = [];
  private prompts = new AbortController();

  constructor(
    private provider: OpenCodeProvider,
    private rt: SessionRuntime,
  ) {}

  private log(...a: unknown[]) {
    this.provider.ctx.log('[opencode]', ...a);
  }

  // ── lifecycle ──

  async attach(loadTranscript: boolean) {
    const rt = this.rt;
    const acp = await this.provider.client();
    const base = { cwd: rt.meta.cwd, mcpServers: [] as unknown[] };
    const stored = rt.meta.providerSessionId;
    let found: Obj | undefined;
    if (stored) {
      try {
        if (loadTranscript) {
          rt.reset([]);
          this.sessionId = stored;
          this.provider.sessions.set(stored, this);
          this.replaying = {};
          found = await acp.request('session/load', { sessionId: stored, ...base }, 120_000);
          this.endReplay();
        } else {
          found = await acp.request('session/resume', { sessionId: stored, ...base }, 60_000);
        }
        this.sessionId = stored;
      } catch (err) {
        this.replaying = undefined;
        this.provider.sessions.delete(stored);
        this.log('could not resume', stored, errMsg(err));
        found = undefined;
        rt.notice('info', 'OpenCode no longer has this conversation', 'Starting a new one in the same folder.');
      }
    }
    const resp: Obj = found ?? (await acp.request('session/new', base, 60_000));
    if (!found) this.sessionId = String(resp.sessionId);
    this.provider.sessions.set(this.sessionId, this);
    this.options = (resp.configOptions as Obj[]) ?? [];
    this.readApplied();
    const info = this.provider.readOptions(this.options);
    rt.setCaps(this.provider.capsOf(info, await this.provider.servers(rt.meta.cwd)));
    const model = this.applied.model;
    rt.update({ providerSessionId: this.sessionId, model: rt.meta.model || model || '', mode: MODES.some((m) => m.id === rt.meta.mode) ? rt.meta.mode : 'build' });
    if (!rt.meta.model && !model) {
      const def = info.models.find((m) => m.isDefault) ?? info.models[0];
      if (def) rt.update({ model: def.id });
    }
    if (rt.meta.titleSource === 'auto' && rt.meta.title === 'New session' && loadTranscript) {
      const first = rt.items.find((i): i is UserItem => i.type === 'user')?.text;
      if (first) rt.update({ title: first.trim().split('\n')[0].slice(0, 56) });
    }
  }

  private readApplied() {
    const get = (id: string, category: string) => this.options.find((o) => o.id === id || o.category === category)?.currentValue as string | undefined;
    this.applied = { model: get('model', 'model'), effort: get('effort', 'thought_level'), mode: get('mode', 'mode') };
  }

  onServerDied(message: string, detail?: string) {
    if (this.closed) return;
    this.closed = true;
    const rt = this.rt;
    this.prompts.abort();
    if (rt.turnActive) {
      rt.settle('error');
      rt.notice('error', message, detail);
      rt.endTurn(message);
    }
  }

  // ── settings (applied right before the next message) ──

  async setModel(_model: string) {}
  async setEffort(_effort: Effort) {}
  async setMode(mode: string) {
    // "Allow all" is Sable's: OpenCode keeps running as it did, and permission prompts are answered here.
    if (mode === ALLOW_ALL_MODE) return;
  }

  private async setOption(id: string, category: string, value: string) {
    const opt = this.options.find((o) => o.id === id || o.category === category);
    if (!opt || !((opt.options as Obj[] | undefined) ?? []).some((o) => o.value === value)) return;
    const acp = await this.provider.client();
    const r = await acp.request('session/set_config_option', { sessionId: this.sessionId, configId: opt.id, value }, 30_000);
    if (Array.isArray(r?.configOptions)) this.options = r.configOptions;
    this.readApplied();
  }

  private async applyChoices() {
    const { model, effort, mode } = this.rt.meta;
    // The model first: the efforts a model offers come with it.
    if (model && model !== this.applied.model) await this.setOption('model', 'model', model).catch((err) => this.rt.notice('error', 'Could not switch the model', errMsg(err)));
    if (effort && effort !== this.applied.effort) await this.setOption('effort', 'thought_level', effort).catch((err) => this.log('effort', errMsg(err)));
    const want = agentModeFor(mode);
    if (want !== this.applied.mode) await this.setOption('mode', 'mode', want).catch((err) => this.log('mode', errMsg(err)));
  }

  // ── sending ──

  async send(item: UserItem) {
    if (this.closed) throw new Error('Session is closed');
    if (!existsSync(this.rt.meta.cwd)) throw new Error(`The folder ${this.rt.meta.cwd} does not exist.`);
    if (this.turn) {
      // OpenCode takes one prompt at a time: the message waits for the turn to end.
      this.queue.push({ item });
      if (item.state !== 'queued') this.rt.patch<UserItem>(item.id, { state: 'queued' });
      return;
    }
    await this.startTurn([item]);
  }

  private async startTurn(items: UserItem[]) {
    const rt = this.rt;
    const turn: { stop?: NodeJS.Timeout; done: boolean } = { done: false };
    this.turn = turn;
    rt.beginTurn('Thinking');
    for (const it of items) if (it.state === 'queued') rt.taken(it.id);
    this.text = this.thinking = undefined;
    const started = Date.now();
    try {
      await this.applyChoices();
      const blocks = items.length === 1 ? promptBlocks(items[0].text, items[0].attachments) : items.flatMap((it, i) => promptBlocks(i ? `\n\n${it.text}` : it.text, it.attachments));
      const acp = await this.provider.client();
      // One prompt runs for as long as the agent works: it is answered when the turn ends.
      void acp
        .request('session/prompt', { sessionId: this.sessionId, prompt: mergeText(blocks) }, 0)
        .then((r) => this.completeTurn(turn, started, r, undefined, items))
        .catch((err) => this.completeTurn(turn, started, undefined, errMsg(err), items));
    } catch (err) {
      this.completeTurn(turn, started, undefined, errMsg(err));
    }
  }

  private completeTurn(turn: { stop?: NodeJS.Timeout; done: boolean }, started: number, result?: Obj, error?: string, items: UserItem[] = []) {
    const rt = this.rt;
    if (turn.done || this.turn !== turn) return;
    turn.done = true;
    clearTimeout(turn.stop);
    this.turn = undefined;
    this.closeText();
    const reason = String(result?.stopReason ?? (error ? 'error' : 'end_turn'));
    const compacting = items.length === 1 && /^\/compact(\s|$)/.test(items[0].text.trim());
    const cancelled = reason === 'cancelled';
    if (this.closed && !rt.turnActive) return;
    rt.cancelPrompts();
    rt.settle(error ? 'error' : 'cancelled');
    if (cancelled) rt.notice('interrupted', 'Interrupted');
    else if (reason === 'refusal') rt.notice('info', 'OpenCode declined to answer');
    else if (reason === 'max_tokens' || reason === 'max_turn_requests') rt.notice('info', 'The turn stopped at its limit');
    const u = result?.usage as Obj | undefined;
    const input = Number(u?.inputTokens) || 0;
    const output = Number(u?.outputTokens) || 0;
    rt.add<TurnItem>({ type: 'turn', durationMs: Date.now() - started, inputTokens: input || undefined, outputTokens: output || undefined, stopReason: reason, error });
    const prev = rt.meta.usage;
    rt.update({
      usage: { ...prev, inputTokens: prev.inputTokens + input, outputTokens: prev.outputTokens + output, cacheReadTokens: (prev.cacheReadTokens ?? 0) + (Number(u?.cachedReadTokens) || 0), turns: prev.turns + 1 },
    });
    if (error) rt.notice('error', 'OpenCode could not finish the turn', error);
    else if (!cancelled && compacting) rt.notice('compact', 'Context compacted');
    rt.endTurn(error);
    this.drainQueue();
  }

  private drainQueue() {
    if (!this.queue.length || this.turn || this.closed) return;
    // Messages the bridge took back (the turn was stopped or failed before they were taken) go out from its queue, not twice.
    const q = this.queue.splice(0).filter((x) => this.rt.get<UserItem>(x.item.id)?.state === 'queued');
    if (!q.length) return;
    void this.startTurn(q.map((x) => x.item)).catch((err) => this.rt.notice('error', 'Could not send the queued message', errMsg(err)));
  }

  async interrupt() {
    const turn = this.turn;
    if (!turn) return;
    const acp = await this.provider.client().catch(() => null);
    acp?.notify('session/cancel', { sessionId: this.sessionId });
    // The prompt answers "cancelled" by itself; if it does not, the turn ends anyway.
    clearTimeout(turn.stop);
    turn.stop = setTimeout(() => this.completeTurn(turn, this.rt.turnStartedAt || Date.now(), { stopReason: 'cancelled' }), 8_000);
    turn.stop.unref?.();
  }

  // ── what the agent streams ──

  private closeText() {
    const rt = this.rt;
    if (this.text) rt.patch<TextItem>(this.text.id, { streaming: false });
    if (this.thinking) rt.patch<ThinkingItem>(this.thinking.id, { streaming: false, endedAt: Date.now() });
    this.text = this.thinking = undefined;
  }

  onUpdate(u: Obj) {
    if (this.closed) return;
    const rt = this.rt;
    const chunk = typeof u.content?.text === 'string' ? u.content.text : '';
    switch (u.sessionUpdate) {
      case 'user_message_chunk': {
        if (!this.replaying) return;
        this.closeText();
        const cur = this.replaying.user;
        if (cur && cur.messageId === u.messageId) return rt.delta(cur.id, 'text', chunk);
        this.endExchange();
        const item = rt.add<UserItem>({ type: 'user', text: chunk, state: 'sent', providerId: typeof u.messageId === 'string' ? u.messageId : undefined });
        this.replaying.user = { id: item.id, messageId: u.messageId };
        return;
      }
      case 'agent_message_chunk': {
        if (!chunk) return;
        if (this.replaying) this.replaying.user = undefined;
        if (this.thinking) {
          rt.patch<ThinkingItem>(this.thinking.id, { streaming: false, endedAt: Date.now() });
          this.thinking = undefined;
        }
        if (rt.turnActive) rt.update({ activity: undefined });
        if (this.text && this.text.messageId === u.messageId) return rt.delta(this.text.id, 'text', chunk);
        if (this.text) rt.patch<TextItem>(this.text.id, { streaming: false });
        const item = rt.add<TextItem>({ type: 'text', text: chunk, streaming: !this.replaying });
        this.text = { id: item.id, messageId: u.messageId };
        return;
      }
      case 'agent_thought_chunk': {
        if (!chunk) return;
        if (this.replaying) this.replaying.user = undefined;
        if (this.text) {
          rt.patch<TextItem>(this.text.id, { streaming: false });
          this.text = undefined;
        }
        if (this.thinking && this.thinking.messageId === u.messageId) return rt.delta(this.thinking.id, 'text', chunk);
        if (this.thinking) rt.patch<ThinkingItem>(this.thinking.id, { streaming: false, endedAt: Date.now() });
        const item = rt.add<ThinkingItem>({ type: 'thinking', text: chunk, streaming: !this.replaying });
        this.thinking = { id: item.id, messageId: u.messageId };
        return;
      }
      case 'tool_call':
      case 'tool_call_update':
        return this.onTool(u);
      case 'plan':
        return rt.setTodos(todosOf(u.entries));
      case 'usage_update': {
        const prev = rt.meta.usage;
        rt.update({
          usage: {
            ...prev,
            contextTokens: typeof u.used === 'number' ? u.used : prev.contextTokens,
            contextWindow: typeof u.size === 'number' ? u.size : prev.contextWindow,
            costUsd: typeof u.cost?.amount === 'number' && u.cost.amount > 0 ? u.cost.amount : prev.costUsd,
          },
        });
        return;
      }
      case 'current_mode_update':
        if (typeof u.currentModeId === 'string' && agentModeFor(rt.meta.mode) !== u.currentModeId) rt.update({ mode: u.currentModeId });
        return;
      case 'config_option_update':
        if (Array.isArray(u.configOptions)) {
          this.options = u.configOptions;
          this.readApplied();
        }
        return;
      case 'available_commands_update': {
        const commands = commandsOf(u.availableCommands);
        this.provider.setCommands(commands);
        if (rt.caps) rt.setCaps({ ...rt.caps, commands, features: { ...rt.caps.features, compact: commands.some((c) => c.name === 'compact') } });
        return;
      }
      default:
        return;
    }
  }

  /** A replayed conversation: each exchange closes with a turn marker, as a live turn does. */
  private endExchange() {
    const rt = this.rt;
    const last = rt.items[rt.items.length - 1];
    if (last && last.type !== 'turn' && rt.items.some((i) => i.type === 'user')) rt.add<TurnItem>({ type: 'turn', durationMs: 0, stopReason: 'end_turn' });
  }

  private endReplay() {
    const rt = this.rt;
    this.closeText();
    if (rt.items.length) this.endExchange();
    rt.settle('cancelled');
    this.replaying = undefined;
    this.tools.clear();
  }

  private onTool(u: Obj) {
    const rt = this.rt;
    const id = String(u.toolCallId ?? '');
    if (!id) return;
    if (this.replaying) this.replaying.user = undefined;
    if (this.text || this.thinking) this.closeText();
    let state = this.tools.get(id);
    const name = String(u.name ?? state?.name ?? u.title ?? 'tool');
    const input = inputOf(u, state?.input);
    const kind = typeof u.kind === 'string' ? u.kind : undefined;
    const view = describeCall(name, kind, input, typeof u.title === 'string' ? u.title : undefined);
    const status = statusOf(u.status ?? (u.sessionUpdate === 'tool_call' ? 'pending' : 'in_progress'));
    const patch: Partial<ToolItem> = { title: view.title, kind: view.kind, detail: { ...view.detail, ...(locationPath(u) && (view.kind === 'read' || view.kind === 'edit' || view.kind === 'write') ? { path: locationPath(u) } : {}) }, status: status === 'pending' ? 'running' : status, input };
    const finished = status === 'done' || status === 'error';
    if (finished) {
      patch.result = resultOf(view.claudeName, view.kind, input, u, status === 'error');
      patch.endedAt = Date.now();
    }
    if (!state) {
      const item = rt.add<ToolItem>({ type: 'tool', name: view.claudeName, kind: view.kind, title: view.title, status: patch.status!, detail: patch.detail!, input, ...(finished ? { result: patch.result, endedAt: patch.endedAt } : {}) });
      state = { id: item.id, name, claudeName: view.claudeName, input };
      this.tools.set(id, state);
    } else {
      state.input = input;
      // A step waiting for an answer stays so until it is given.
      if (rt.get<ToolItem>(state.id)?.status === 'awaiting' && !finished) delete patch.status;
      rt.patch<ToolItem>(state.id, patch);
    }
    if (view.kind === 'todo' && Array.isArray(input.todos)) rt.setTodos(todosOf(input.todos));
  }

  // ── permissions ──

  async onPermission(p: Obj): Promise<unknown> {
    const rt = this.rt;
    const options = ((p.options as Obj[]) ?? []).filter((o) => typeof o?.optionId === 'string');
    const pickKind = (...kinds: string[]) => options.find((o) => kinds.includes(String(o.kind)))?.optionId as string | undefined;
    const selected = (optionId: string) => ({ outcome: { outcome: 'selected', optionId } });
    if (rt.meta.mode === ALLOW_ALL_MODE) {
      const yes = pickKind('allow_once', 'allow_always');
      if (yes) return selected(yes);
    }
    const call = (p.toolCall ?? {}) as Obj;
    const tool = this.tools.get(String(call.toolCallId ?? ''));
    const kind = typeof call.kind === 'string' ? call.kind : undefined;
    const input = inputOf(call, tool?.input);
    const view = describeCall(tool?.name ?? String(call.name ?? call.title ?? 'tool'), kind, input, typeof call.title === 'string' ? call.title : undefined);
    const result = resultOf(view.claudeName, view.kind, input, call, false);
    if (tool) rt.patch<ToolItem>(tool.id, { status: 'awaiting' });
    const label: Record<string, { label: string; tone: 'allow' | 'always' | 'deny' }> = {
      allow_once: { label: 'Allow once', tone: 'allow' },
      allow_always: { label: 'Always allow', tone: 'always' },
      reject_once: { label: 'Deny', tone: 'deny' },
      reject_always: { label: 'Always deny', tone: 'deny' },
    };
    const answer = await rt.requestPermission(
      {
        itemId: tool?.id,
        toolName: view.claudeName,
        kind: view.kind,
        title: view.title,
        detail: view.detail,
        diff: result.diff,
        options: options.map((o) => ({ id: String(o.optionId), ...(label[String(o.kind)] ?? { label: String(o.name ?? 'Allow'), tone: /reject|deny/i.test(String(o.kind)) ? 'deny' : 'allow' }) })),
      },
      this.prompts.signal,
    );
    if (tool && rt.get<ToolItem>(tool.id)?.status === 'awaiting') rt.patch<ToolItem>(tool.id, { status: answer && options.find((o) => o.optionId === answer.optionId && /allow/.test(String(o.kind))) ? 'running' : answer ? 'denied' : 'cancelled' });
    return answer ? selected(answer.optionId) : { outcome: { outcome: 'cancelled' } };
  }

  // ── other ──

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
    return this.provider.servers(this.rt.meta.cwd);
  }

  async setOptions() {}

  async close() {
    if (this.closed) return;
    if (this.turn) await this.interrupt().catch(() => {});
    this.closed = true;
    this.prompts.abort();
    this.queue = [];
    if (this.provider.sessions.get(this.sessionId) === this) this.provider.sessions.delete(this.sessionId);
    this.provider.sessionClosed();
  }
}

/** Adjacent text blocks become one (queued messages sent together). */
function mergeText(blocks: Obj[]): Obj[] {
  const out: Obj[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (b.type === 'text' && last?.type === 'text') last.text += b.text;
    else out.push({ ...b });
  }
  return out;
}
