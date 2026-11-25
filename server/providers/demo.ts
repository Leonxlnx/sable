/**
 * The scripted "demo" provider: a fake coding agent that replays realistic sessions
 * against a fictional TypeScript project, streaming token by token. It exercises the
 * whole normalized timeline model (thinking, text, every tool kind, permissions,
 * questions, plans, sub-agents, notices, usage) without spending model quota.
 *
 *   speed: constructor option or SABLE_DEMO_SPEED (1 = realistic, 0 = no delays).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  SessionOptions,
  AuthState,
  Capabilities,
  ContextBreakdown,
  Effort,
  HistoryEntry,
  McpServerInfo,
  NoticeItem,
  ProviderInfo,
  LimitsMeta,
  RateLimit,
  ResetOutcome,
  TextItem,
  TimelineItem,
  ToolItem,
  TurnItem,
  UserItem,
} from '../../shared/protocol';
import type { SessionRuntime } from '../core/runtime';
import type { Provider, ProviderContext, ProviderSession } from './types';
import type { TitlePrompt } from '../core/titles';
import {
  DEFAULT_MODEL,
  MCP_SERVERS,
  MODELS,
  PRICING,
  capabilities,
  contextBreakdown,
  pastSessions,
  rateLimits,
  demoResetCredits,
  freshLimits,
  type DemoLimitProfile,
} from './demo-catalog';
import { pickScenario, SCENARIOS, deniedReply } from './demo-scenarios';
import { stripBrowserLine } from './browser-tool';
import { stripWrappers } from '../../shared/synthetic';
import { Aborted, BASE_CONTEXT, CONTEXT_WINDOW, Denied, Halt, Script } from './demo-script';

export interface DemoOptions {
  /** Delay multiplier: 1 = realistic pacing, 0 = instant (tests). */
  speed?: number;
}

function resolveSpeed(opt?: number): number {
  if (typeof opt === 'number' && Number.isFinite(opt) && opt >= 0) return opt;
  const env = Number(process.env.SABLE_DEMO_SPEED);
  if (process.env.SABLE_DEMO_SPEED !== undefined && Number.isFinite(env) && env >= 0) return env;
  return 1;
}

/**
 * Made-up people for extra demo accounts, in the order accounts sign in, each with plan limits
 * in a different state (near a cap, at a cap, an API key without plan limits...).
 */
const DEMO_PEOPLE: { email: string; plan: string; method?: string; limits: DemoLimitProfile }[] = [
  { email: 'margaret@hamilton.dev', plan: 'Max', limits: 'light' },
  { email: 'ada@lovelace.dev', plan: 'Max', limits: 'near' },
  { email: 'grace@hopper.dev', plan: 'Pro', limits: 'cap' },
  { email: 'alan@turing.dev', plan: 'API key', method: 'apiKey', limits: 'none' },
  { email: 'linus@kernel.dev', plan: 'Pro', limits: 'calm' },
];

export class DemoProvider implements Provider {
  readonly id = 'demo' as const;
  readonly name = 'Demo';
  private speed: number;
  /** Extra accounts keep their pretend sign-in in their own folder; the default is always signed in. */
  private authFile?: string;
  private pendingLogin?: { timer: NodeJS.Timeout; settle: () => void };

  constructor(
    private ctx: ProviderContext,
    opts: DemoOptions = {},
  ) {
    this.speed = resolveSpeed(opts.speed);
    if (ctx.account?.dir) this.authFile = path.join(ctx.account.dir, 'demo-auth.json');
  }

  private auth(): AuthState {
    return this.person()?.auth ?? { loggedIn: false };
  }

  /** Who this account is signed in as, and how its plan limits stand; undefined when signed out. */
  private person(): { auth: AuthState; limits: DemoLimitProfile } | undefined {
    if (!this.authFile) return { auth: { loggedIn: true, method: 'local', email: 'demo@sable.local', plan: 'Demo' }, limits: 'calm' };
    try {
      if (!existsSync(this.authFile)) return undefined;
      const a = JSON.parse(readFileSync(this.authFile, 'utf8')) as { email: string; plan: string; method?: string; limits?: DemoLimitProfile };
      return { auth: { loggedIn: true, method: a.method ?? 'local', email: a.email, plan: a.plan }, limits: a.limits ?? 'calm' };
    } catch {
      return undefined;
    }
  }

  /** The plan-limit state of this account (for the made-up usage too); undefined when signed out. */
  limitProfile(): DemoLimitProfile | undefined {
    return this.person()?.limits;
  }

  async info(): Promise<ProviderInfo> {
    return { id: 'demo', name: 'Demo', installed: true, version: '1.0', auth: this.auth() };
  }

  /** A pretend browser sign-in: announces itself, then finishes after a moment. */
  login(): Promise<void> {
    const file = this.authFile;
    if (!file) return Promise.resolve();
    void this.cancelLogin();
    this.ctx.emit({ type: 'auth.progress', provider: 'demo', state: 'url', message: 'The demo signs in by itself in a moment.' });
    return new Promise((resolve) => {
      const settle = () => {
        this.pendingLogin = undefined;
        resolve();
      };
      const timer = setTimeout(() => {
        // The next person in line: as many as other demo accounts are signed in already.
        let signedIn = 0;
        try {
          const root = path.dirname(path.dirname(file));
          signedIn = readdirSync(root).filter((d) => existsSync(path.join(root, d, 'demo-auth.json'))).length;
        } catch {
          /* the first one */
        }
        const person = DEMO_PEOPLE[signedIn % DEMO_PEOPLE.length];
        try {
          writeFileSync(file, JSON.stringify(person));
        } catch {
          /* the folder is gone: the account was removed */
        }
        settle();
      }, 2200 * this.speed);
      this.pendingLogin = { timer, settle };
    });
  }

  async cancelLogin() {
    const p = this.pendingLogin;
    if (!p) return;
    clearTimeout(p.timer);
    p.settle();
  }

  async logout() {
    if (this.authFile) rmSync(this.authFile, { force: true });
  }

  async caps(): Promise<Capabilities> {
    return capabilities();
  }

  /**
   * Resets this demo account spent (kept beside its pretend sign-in); the default account has none.
   * `at` is when its windows last started over: a spent reset, or a window end set with `limitResetIn` that has passed.
   */
  private resetState(): { used: number; at?: number } {
    if (!this.authFile) return { used: 0 };
    const end = this.windowEnd();
    const passed = end !== undefined && end <= Date.now() ? end : undefined;
    try {
      const r = JSON.parse(readFileSync(path.join(path.dirname(this.authFile), 'demo-resets.json'), 'utf8')) as { used?: number; at?: number };
      const at = typeof r.at === 'number' ? r.at : undefined;
      return { used: Math.max(0, Number(r.used) || 0), at: passed && (!at || passed > at) ? passed : at };
    } catch {
      return { used: 0, at: passed };
    }
  }

  /** Development only: when this account's full windows reset, as set with `limitResetIn` (they never do by themselves). */
  private windowEnd(): number | undefined {
    if (!this.authFile) return undefined;
    try {
      const at = (JSON.parse(readFileSync(path.join(path.dirname(this.authFile), 'demo-window.json'), 'utf8')) as { at?: number }).at;
      return typeof at === 'number' ? at : undefined;
    } catch {
      return undefined;
    }
  }

  /** Development only (`demo.limitResetIn`): the account's full windows reset `ms` from now; after that it is fresh, as after a reset. */
  limitResetIn(ms: number) {
    if (!this.authFile) return;
    writeFileSync(path.join(path.dirname(this.authFile), 'demo-window.json'), JSON.stringify({ at: Date.now() + ms }));
    void this.limits();
  }

  /** The windows as they stand now: full ones end when `limitResetIn` said, if it did. */
  private windowsNow(profile: DemoLimitProfile, now = Date.now()): RateLimit[] {
    const end = this.windowEnd();
    const limits = rateLimits(now, profile);
    return end && end > now ? limits.map((l) => (l.percent >= 100 ? { ...l, resetsAt: end } : l)) : limits;
  }

  /** The limit state a turn meets: an account at its cap is free again after a reset. */
  private turnProfile(): DemoLimitProfile | undefined {
    const profile = this.limitProfile();
    return profile === 'cap' && this.resetState().at ? 'light' : profile;
  }

  async limits(): Promise<RateLimit[]> {
    const profile = this.limitProfile();
    if (!profile) return [];
    const now = Date.now();
    const state = this.resetState();
    const limits = state.at ? freshLimits(rateLimits(state.at, profile), state.at) : this.windowsNow(profile, now);
    const granted = this.authFile ? demoResetCredits(profile) : 0;
    // After a reset the account is off credits again (said explicitly: the limits book keeps what a read leaves out).
    const meta: LimitsMeta = { planLimits: profile !== 'none', ...(state.at ? { credits: { has: false } } : demoCredits(profile, limits)) };
    if (granted) meta.resets = { available: Math.max(0, granted - state.used), windows: limits.map((l) => l.id) };
    this.ctx.emit({ type: 'limits.updated', provider: 'demo', limits, meta });
    return limits;
  }

  /** Spends a pretend reset: the windows start over now. Same outcomes as Codex's. */
  async useReset(_key: string): Promise<ResetOutcome> {
    const profile = this.limitProfile();
    if (!profile || !this.authFile) return 'noCredit';
    const state = this.resetState();
    if (demoResetCredits(profile) - state.used <= 0) return 'noCredit';
    writeFileSync(path.join(path.dirname(this.authFile), 'demo-resets.json'), JSON.stringify({ used: state.used + 1, at: Date.now() }));
    await this.limits();
    return 'reset';
  }

  async history(cwd?: string, limit?: number): Promise<HistoryEntry[]> {
    return pastSessions(cwd)
      .slice(0, limit ?? undefined)
      .map(({ prompt: _p, reply: _r, readPath: _f, ...entry }) => entry);
  }

  async open(rt: SessionRuntime, opts: { loadTranscript?: boolean }): Promise<ProviderSession> {
    rt.setCaps(capabilities());
    const patch: Parameters<SessionRuntime['update']>[0] = {};
    if (!rt.meta.model) patch.model = DEFAULT_MODEL;
    const model = MODELS.find((m) => m.id === (patch.model ?? rt.meta.model)) ?? MODELS[0];
    if (!rt.meta.effort) patch.effort = model.defaultEffort;
    if (rt.meta.usage.contextWindow === undefined) {
      patch.usage = { ...rt.meta.usage, contextTokens: rt.meta.usage.contextTokens ?? BASE_CONTEXT, contextWindow: CONTEXT_WINDOW };
    }
    const resumeId = rt.meta.providerSessionId;
    patch.providerSessionId = resumeId ?? `demo-${randomUUID()}`;
    rt.update(patch);
    if (resumeId && opts.loadTranscript) rt.reset(transcript(rt, resumeId));
    this.ctx.log(`demo session ${rt.id} opened (${resumeId ? 'resumed' : 'new'})`);
    const session = new DemoSession(rt, this.speed, this.ctx, () => this.turnProfile(), (profile) => this.windowsNow(profile));
    if (rt.meta.options) void session.setOptions(rt.meta.options);
    return session;
  }

  /** An extra account's own folder (the default account has none: it keeps nothing on disk). */
  configHome(): string {
    return this.ctx.account?.dir ?? '';
  }

  /** The demo keeps no transcripts: any account can carry on with any conversation. */
  async adoptConversation(): Promise<boolean> {
    return true;
  }

  /** A pretend small model names the chat: a few of the message's own words, after a short pause. No model is asked. */
  async quickTitle(prompt: TitlePrompt, signal: AbortSignal): Promise<string | null> {
    await new Promise((r) => setTimeout(r, 600 * this.speed));
    if (signal.aborted) return null;
    return demoTitle(prompt.user);
  }

  async dispose() {
    await this.cancelLogin();
  }
}

/** The Demo's title: the message's words without a greeting or a request's lead-in, five at most, sentence case. */
export function demoTitle(prompt: string): string | null {
  const message = /<message>\n?([\s\S]*?)\n?<\/message>/.exec(prompt)?.[1] ?? prompt;
  const words = message
    .replace(/[`*_#>]/g, ' ')
    .replace(/^\s*(hi|hey|hello)\b[\s,!.]*/i, '')
    .replace(/^\s*(please|can you|could you|would you|i want you to|i'd like you to)\s+/i, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  if (!words.length) return null;
  const t = words.join(' ').replace(/[.,:;!?…]+$/, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** A short finished exchange for a resumed session. */
function transcript(rt: SessionRuntime, providerSessionId: string): TimelineItem[] {
  const all = pastSessions(rt.meta.cwd);
  const past = all.find((p) => p.providerSessionId === providerSessionId) ?? all[0];
  const t0 = past.updatedAt - 95_000;
  const abs = path.join(rt.meta.cwd, past.readPath);
  const items: TimelineItem[] = [
    { id: randomUUID(), ts: t0, type: 'user', text: past.prompt, state: 'sent' } satisfies UserItem,
    {
      id: randomUUID(),
      ts: t0 + 4_000,
      type: 'tool',
      name: 'Read',
      kind: 'read',
      title: `Read ${past.readPath.split('/').pop()}`,
      status: 'done',
      detail: { path: abs },
      input: { file_path: abs },
      result: { file: { path: abs, startLine: 1, numLines: 48, totalLines: 48 } },
      endedAt: t0 + 4_300,
    } satisfies ToolItem,
    { id: randomUUID(), ts: t0 + 9_000, type: 'text', text: past.reply, streaming: false } satisfies TextItem,
    { id: randomUUID(), ts: t0 + 21_000, type: 'turn', durationMs: 21_000, costUsd: 0.0412, inputTokens: 24_310, outputTokens: 286, stopReason: 'end_turn' } satisfies TurnItem,
    {
      id: randomUUID(),
      ts: Date.now(),
      type: 'notice',
      variant: 'info',
      text: 'Session resumed',
      detail: `Conversation restored from ${new Date(past.updatedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`,
    } satisfies NoticeItem,
  ];
  return items;
}

class DemoSession implements ProviderSession {
  private queue: UserItem[] = [];
  private current?: AbortController;
  /** The running turn's script (steered messages go to it). */
  private script?: Script;
  private ultracode = false;
  private speedChoice = 'standard';
  private allowed = new Set<string>();
  private rotation = 0;
  private model: string;
  private effort?: Effort;
  private mode: string;

  constructor(
    private rt: SessionRuntime,
    private speed: number,
    private ctx: ProviderContext,
    private limitProfile: () => DemoLimitProfile | undefined = () => undefined,
    private windows: (profile: DemoLimitProfile) => RateLimit[] = (profile) => rateLimits(Date.now(), profile),
  ) {
    this.model = rt.meta.model;
    this.effort = rt.meta.effort;
    this.mode = rt.meta.mode;
  }

  async send(item: UserItem): Promise<void> {
    if (this.current && item.steered && this.script) {
      return this.script.steer(item);
    }
    if (this.current) {
      this.queue.push(item);
      if (item.state !== 'queued') this.rt.patch<UserItem>(item.id, { state: 'queued' });
      await this.rt.persistInput?.();
      return;
    }
    this.start(item);
  }

  private start(item: UserItem) {
    const ctrl = new AbortController();
    this.current = ctrl;
    if (item.state === 'queued') this.rt.taken(item.id);
    this.rt.beginTurn('Thinking');
    void this.play(item, ctrl);
  }

  private async play(item: UserItem, ctrl: AbortController) {
    const model = this.rt.meta.model || this.model || DEFAULT_MODEL;
    const effort = this.rt.meta.effort ?? this.effort;
    const s = new Script({
      rt: this.rt,
      signal: ctrl.signal,
      speed: this.speed,
      pricing: PRICING[model] ?? PRICING[DEFAULT_MODEL],
      allowed: this.allowed,
      thinking: effort !== 'minimal',
      // Said like a turn's rate-limit event: every window as known, this one at its cap.
      onLimit: (limit) => {
        const profile = this.limitProfile();
        const known = profile ? rateLimits(Date.now(), profile).filter((l) => l.id !== limit.id) : [];
        this.ctx.emit({ type: 'limits.updated', provider: 'demo', limits: [...known, limit], meta: { planLimits: true } });
      },
    });
    this.script = s;
    // The line Sable adds about the Browser tab, and its notes for the agent, are not the user's words: they never pick a scenario.
    const { id, rotated } = pickScenario(stripWrappers(stripBrowserLine(item.text)), this.rt.meta.mode || this.mode, this.rotation);
    if (rotated) this.rotation++;
    let error: string | undefined;
    // An account at its cap refuses the turn the way a real agent does: the limit is reported, nothing runs.
    if (this.limitProfile() === 'cap') {
      await s.sleep(300).catch(() => {});
      const limits = this.windows('cap');
      this.ctx.emit({ type: 'limits.updated', provider: 'demo', limits, meta: { planLimits: true } });
      const full = limits.find((l) => l.percent >= 100);
      this.rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'You have reached your usage limit.', limit: { resetsAt: full?.resetsAt, window: full?.label } });
      return this.complete(ctrl, 'You have reached your usage limit.');
    }
    try {
      await s.sleep(250 + Math.random() * 350);
      if (id !== 'command') s.step();
      const result = await SCENARIOS[id]({ s, prompt: item.text, item, model });
      if (result && 'error' in result) error = result.error;
    } catch (err) {
      if (this.current !== ctrl || err instanceof Aborted) {
        // Interrupted or closed: interrupt() already settled the timeline.
        if (this.current === ctrl) this.rt.settle('cancelled');
      } else if (err instanceof Halt) {
        this.rt.settle('cancelled');
      } else if (err instanceof Denied) {
        try {
          await s.say(deniedReply(err));
          s.finish({ suggestion: 'Go ahead, but keep the existing public API unchanged' });
        } catch {
          /* interrupted while reacting */
        }
      } else {
        error = (err as Error).message ?? String(err);
        this.ctx.log('demo scenario failed', err);
        this.rt.settle('error');
        this.rt.notice('error', 'Demo scenario failed', error);
      }
    }
    this.complete(ctrl, error);
  }

  /** Ends the turn owned by `ctrl` (idempotent) and starts the next queued message. */
  private complete(ctrl: AbortController, error?: string) {
    if (this.current !== ctrl) return;
    this.current = undefined;
    // Steered messages the turn did not get to go first in the next one.
    const left = this.script?.takeSteers() ?? [];
    this.script = undefined;
    this.queue.unshift(...left);
    this.rt.endTurn(error);
    // After a stop or a failure the bridge takes waiting messages back to its queue: those are not sent twice.
    this.queue = this.queue.filter((u) => this.rt.get<UserItem>(u.id)?.state === 'queued');
    const next = this.queue.shift();
    if (next) this.start(next);
  }

  async interrupt(): Promise<void> {
    const ctrl = this.current;
    if (!ctrl) return;
    ctrl.abort();
    // Steered messages not taken yet stay unanswered: the bridge hands them back to the queue.
    this.script?.takeSteers();
    this.rt.settle('cancelled');
    this.rt.notice('interrupted', 'Interrupted');
    this.complete(ctrl);
  }

  async setModel(model: string): Promise<void> {
    const prev = this.model;
    this.model = model;
    if (prev && prev !== model && this.rt.items.length) {
      const name = MODELS.find((m) => m.id === model)?.name ?? model;
      this.rt.notice('model', `Switched to ${name}`);
    }
  }

  async setEffort(effort: Effort): Promise<void> {
    this.effort = effort;
  }

  async setMode(mode: string): Promise<void> {
    this.mode = mode;
  }

  /** Pretend speed: remembered, so the UI can be built against it. */
  async setSpeed(speed: string): Promise<void> {
    this.speedChoice = speed;
  }

  /** Pretend ultracode: remembered, so the UI can be built against it. */
  async setUltracode(on: boolean): Promise<void> {
    this.ultracode = on;
  }

  async rewind(itemId: string, restoreFiles: boolean): Promise<{ ok: boolean; message?: string }> {
    if (this.current) return { ok: false, message: 'Stop the current turn before rewinding.' };
    const idx = this.rt.items.findIndex((i) => i.id === itemId);
    if (idx < 0) return { ok: false, message: 'That message is no longer in the conversation.' };
    const removed = this.rt.items.slice(idx);
    const edits = removed.filter((i) => i.type === 'tool' && (i.kind === 'edit' || i.kind === 'write') && i.status === 'done').length;
    this.rt.reset(this.rt.items.slice(0, idx));
    this.rt.notice(
      'rewind',
      'Conversation rewound',
      restoreFiles ? `Restored ${edits} file change${edits === 1 ? '' : 's'} to their earlier state` : 'Files were left as they are',
    );
    return { ok: true };
  }

  async context(): Promise<ContextBreakdown | null> {
    const u = this.rt.meta.usage;
    return contextBreakdown(u.contextTokens, u.turns, this.rt.meta.model || this.model);
  }

  async mcp(): Promise<McpServerInfo[]> {
    return MCP_SERVERS.map((s) => ({ ...s, tools: s.tools?.map((t) => ({ ...t })) }));
  }

  /** Pretend capabilities, so the UI can be shown and tested without a real agent. */
  async setOptions(options: SessionOptions) {
    const rt = this.rt;
    rt.update({
      remote: options.remoteControl ? { url: `https://example.com/sable-demo/${rt.meta.providerSessionId ?? rt.id}`, status: 'Continue on another device (demo link)', tone: 'ok' } : undefined,
      capState: {
        browser: options.browser ? { status: 'Connected to Chrome (demo)', tone: 'ok' } : undefined,
        computerUse: options.computerUse ? { status: 'Asks before using an app (demo)', tone: 'ok' } : undefined,
      },
    });
  }

  async close(): Promise<void> {
    this.queue = [];
    const ctrl = this.current;
    if (!ctrl) return;
    // The app settles and ends the turn itself after close().
    this.current = undefined;
    ctrl.abort();
  }
}

/**
 * Made-up credits, so the credit settings and lines can be seen: the default account has extra
 * usage (some spent), an account at its cap carries on with a credits balance.
 */
function demoCredits(profile: DemoLimitProfile, limits: RateLimit[]): Pick<LimitsMeta, 'extra' | 'credits'> {
  if (profile === 'calm') return { extra: { enabled: true, used: 1240, limit: 5000, currency: 'USD' } };
  if (profile === 'cap') {
    const full = limits.filter((l) => l.percent >= 100 && l.resetsAt).map((l) => l.resetsAt!);
    return { credits: { balance: '1250.5', has: true, inUse: true, ...(full.length ? { resetsAt: Math.max(...full) } : {}) } };
  }
  return {};
}
