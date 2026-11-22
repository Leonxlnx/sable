import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { isAuthFailure } from '../../shared/synthetic';

/**
 * One gate per account, so Sable never makes two processes of one sign-in renew it at the same
 * moment, and never closes a process while it may be renewing it.
 *
 * Why: Claude Code and Codex sign in with OAuth, and each renewal of the access token spends the
 * refresh token and hands out a new one. A process that renews and exits (or is killed) before it
 * wrote the new pair leaves the spent token on disk; the next process is refused (`invalid_grant`),
 * and Claude Code then blanks the stored sign-in, so every chat of that account reads "Not signed
 * in" at once. Claude Code serializes renewals across its processes with a lock, but the gap
 * between a renewal and its write stays, and bursts make it likely: Sable starts many processes
 * per account (one per chat, kept for Remote Control; prewarm; the capabilities and limits probes;
 * `auth status`; chat titles; commit drafts; checks) and after a wake from sleep every token has
 * expired and every timer fires at once.
 *
 * The rules (`GATE` has the numbers):
 * - Process starts of one config folder go one at a time: a start holds the gate until its process
 *   first answers on stdout and a short settle after it (its first request may renew the sign-in),
 *   at most `holdMs`. Two accounts never wait for each other.
 * - Auxiliary requests (a limits read, a sign-in status, a title or draft, which are starts too)
 *   take the same gate, so they never overlap each other nor a start of that account.
 * - The gate is exclusive: a waiter never goes in beside what holds it (review wave 16, #9: a waiter's
 *   own deadline once let two starts in together). Waiters go in order, except that a chat's start
 *   goes ahead of auxiliary requests still waiting. What is bounded is the hold: a start gives the
 *   gate back at its first answer plus `settleMs`, at most `holdMs`; an auxiliary request at its end,
 *   at most `auxLeaseMs` (Sable's own `auth status` calls end well inside it). A holder that died or
 *   hangs loses the gate when its lease ends, so no start waits for ever: a chat's start waits at
 *   most for the holder's remaining lease plus the starts ahead of it (usually a second or two).
 * - A process asked to close before it answered, or in its first seconds, is let go only once it
 *   answered and is `minLifeMs` old (at most `lingerMs` after the ask): its stdin closes then, and a
 *   kill waits for the same moment.
 * - A timer that fires more than a minute late (the laptop slept) is a wake: for a while after it,
 *   work routed through `afterWake` is spread out (`spreadMs` apart, with jitter) instead of all at
 *   once.
 */

export const GATE = {
  /** An auxiliary request holds the gate at most this long; then it passes on (the request may still end later). */
  auxLeaseMs: 20_000,
  /** A start holds the gate until its process first answers, at most this long. */
  holdMs: 12_000,
  /** After the first answer the gate stays shut this much longer. */
  settleMs: 1500,
  /** A process is never let go before it is this old (once it answered). */
  minLifeMs: 3000,
  /** A close asked for is carried out at most this long after the ask. */
  lingerMs: 10_000,
  /** A timer this late means the machine slept. */
  lateMs: 60_000,
  /** How long after a wake work is spread out, and how far apart. */
  wakeWindowMs: 120_000,
  spreadMs: 4000,
  jitterMs: 1500,
};

export type GateNumbers = typeof GATE;

const sleep = (ms: number) =>
  new Promise<'timeout'>((r) => {
    const t = setTimeout(() => r('timeout'), ms);
    t.unref?.();
  });

/** The gate's key for an agent's config folder (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`): one per sign-in store. */
export function gateKey(provider: string, configDir: string): string {
  return `${provider}:${path.resolve(configDir).replace(/[\\/]+$/, '').toLowerCase()}`;
}

/** The Claude Code config folder a process environment points at (the CLI's own default without one). */
export function claudeHomeOf(env: Record<string, string | undefined> | undefined): string {
  // A supplied environment is the child's whole environment: its own folder, or the CLI's default. The
  // bridge's own variable is not asked then: reading another account's history points it elsewhere for a
  // moment, and a start for the built-in account would take that account's gate instead of its own.
  return (env ? env.CLAUDE_CONFIG_DIR : process.env.CLAUDE_CONFIG_DIR) || path.join(homedir(), '.claude');
}

export class AuthGate {
  /** Per key: whether something holds the gate, and who waits (starts ahead of auxiliary requests). */
  private keys = new Map<string, { held: boolean; waiting: { kind: 'start' | 'aux'; go: () => void }[] }>();
  /** Every entry in order (for tests and logs): key, kind, when it went in, how long it waited. */
  readonly trace: { key: string; kind: 'start' | 'aux'; at: number; waitedMs: number }[] = [];

  constructor(
    readonly n: GateNumbers = GATE,
    private log: (...a: unknown[]) => void = () => {},
  ) {}

  /** Whether anything holds the gate of `key` now. */
  busy(key: string): boolean {
    return !!this.keys.get(key)?.held;
  }

  /**
   * Waits until the gate of `key` is free and it is this one's turn, then holds it until the
   * returned release is called or the lease (`holdMs` for a start, `auxLeaseMs` otherwise) ends,
   * whichever is first. Never beside another holder. The release can be called any number of times.
   */
  async enter(key: string, kind: 'start' | 'aux'): Promise<() => void> {
    const st = this.keys.get(key) ?? { held: false, waiting: [] };
    this.keys.set(key, st);
    const asked = Date.now();
    if (st.held || st.waiting.length) {
      await new Promise<void>((go) => {
        const w = { kind, go };
        // A chat's start goes ahead of auxiliary requests that wait, behind starts that wait.
        const at = kind === 'start' ? st.waiting.findIndex((x) => x.kind === 'aux') : -1;
        if (at < 0) st.waiting.push(w);
        else st.waiting.splice(at, 0, w);
      });
    }
    st.held = true;
    const waitedMs = Date.now() - asked;
    this.trace.push({ key, kind, at: Date.now(), waitedMs });
    if (this.trace.length > 200) this.trace.splice(0, this.trace.length - 200);
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      clearTimeout(lease);
      const next = st.waiting.shift();
      if (next) return next.go();
      st.held = false;
      this.keys.delete(key);
    };
    const leaseMs = kind === 'start' ? this.n.holdMs : this.n.auxLeaseMs;
    const lease = setTimeout(() => {
      if (!left) this.log(`auth gate: a ${kind} for ${key} held the gate ${leaseMs} ms; passing it on`);
      leave();
    }, leaseMs);
    lease.unref?.();
    return leave;
  }

  /** Runs an auxiliary request with the gate of `key` held (in turn; see `enter`). */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const leave = await this.enter(key, 'aux');
    try {
      return await fn();
    } finally {
      leave();
    }
  }

  // ── wakes ──

  private wokeAt = 0;
  private slots = 0;

  /** A timer meant for `expectedAt` fired now: more than `lateMs` late is a wake. Returns whether it was. */
  noteTimer(expectedAt: number, now = Date.now()): boolean {
    if (now - expectedAt <= this.n.lateMs) return false;
    if (now - this.wokeAt > this.n.wakeWindowMs) {
      this.wokeAt = now;
      this.slots = 0;
      this.log(`auth gate: a timer fired ${Math.round((now - expectedAt) / 1000)} s late; spreading the catch-up`);
    }
    return true;
  }

  /** Whether a wake was seen within `wakeWindowMs`. */
  waking(now = Date.now()): boolean {
    return this.wokeAt > 0 && now - this.wokeAt <= this.n.wakeWindowMs;
  }

  /**
   * Runs `fn` now, or, within the window after a wake, at the next free slot (`spreadMs` apart, with
   * jitter): a timer that slept through its time and everything that fires with it do not all start
   * or close processes in the same second. `expectedAt`: when the caller's timer was meant to fire.
   */
  afterWake(fn: () => void, expectedAt?: number, now = Date.now()): void {
    if (expectedAt !== undefined) this.noteTimer(expectedAt, now);
    if (!this.waking(now)) return fn();
    const slot = this.slots++;
    const at = this.wokeAt + slot * this.n.spreadMs + Math.random() * this.n.jitterMs;
    const t = setTimeout(fn, Math.max(0, at - now));
    t.unref?.();
  }

  /** A small offset per key, the same every time, so timers of different accounts do not line up. */
  stagger(key: string, spanMs = this.n.spreadMs, jitterMs = this.n.jitterMs): number {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
    return ((h >>> 0) % 1000) / 1000 * spanMs + Math.random() * jitterMs;
  }

  // ── process starts ──

  /**
   * A spawner for the Agent SDK (`spawnClaudeCodeProcess`): the process starts once the gate of its
   * config folder lets it, holds the gate until it first answers (and `settleMs`), and is let go
   * only by the linger rule above. `stderr`: what the SDK's own spawner would hand the options'
   * callback.
   */
  spawner(stderr?: (data: string) => void, keyOf: (env: SpawnRequest['env']) => string = (env) => gateKey('claude', claudeHomeOf(env))) {
    return (o: SpawnRequest): GatedProcess => new GatedProcess(this, keyOf(o.env), o, stderr);
  }
}

/** What the SDK hands a spawner (its `SpawnOptions`). */
export interface SpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
}

/**
 * A Claude Code process that starts when its account's gate opens. The SDK sees it at once (its
 * stdin buffers what is written before the start), so a session's code never waits on the gate
 * itself; only the process does, in its turn (see `AuthGate.enter`).
 */
export class GatedProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  private child?: ChildProcess;
  private cancelled = false;
  private ended = false;
  private answered = false;
  private bornAt = 0;
  private leave?: () => void;
  private closing?: { at: number; signal?: NodeJS.Signals };
  private _exitCode: number | null = null;
  private _signal: NodeJS.Signals | null = null;
  private _killed = false;

  constructor(
    private gate: AuthGate,
    readonly key: string,
    private o: SpawnRequest,
    private stderr?: (data: string) => void,
  ) {
    super();
    // Errors are reported through 'error' listeners the SDK adds; none must throw meanwhile.
    this.on('error', () => {});
    // Closed before the start: nothing to carry over. After it: once all that was written reached the process.
    this.stdin.on('finish', () => !this.child && this.askClose());
    this.stdin.on('end', () => this.askClose());
    o.signal?.addEventListener('abort', () => this.askClose('SIGTERM'), { once: true });
    void this.start();
  }

  get killed() {
    return this._killed;
  }
  get exitCode() {
    return this._exitCode;
  }
  get signalCode() {
    return this._signal;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this._killed = true;
    this.askClose(signal);
    return true;
  }

  private async start() {
    const leave = await this.gate.enter(this.key, 'start');
    this.leave = leave;
    if (this.cancelled) return leave();
    // Held until the first answer and a settle; the gate's lease ends it at holdMs whatever happens.
    const hold = setTimeout(leave, this.gate.n.holdMs);
    hold.unref?.();
    let child: ChildProcess;
    try {
      child = spawn(this.o.command, this.o.args, { cwd: this.o.cwd, env: this.o.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      clearTimeout(hold);
      leave();
      this.emit('error', err as Error);
      return this.exited(1, null);
    }
    this.child = child;
    this.bornAt = Date.now();
    this.stdin.pipe(child.stdin!, { end: false });
    child.stdin?.on('error', () => {});
    child.stdout?.on('data', (d: Buffer) => {
      if (!this.answered) {
        this.answered = true;
        const settle = setTimeout(() => (clearTimeout(hold), leave()), this.gate.n.settleMs);
        settle.unref?.();
        this.closeIfDue();
      }
      this.stdout.write(d);
    });
    child.stderr?.on('data', (d: Buffer) => this.stderr?.(d.toString()));
    child.on('error', (err) => {
      clearTimeout(hold);
      leave();
      this.emit('error', err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(hold);
      leave();
      this.exited(code, signal);
    });
    if (this.closing) this.closeIfDue();
  }

  private exited(code: number | null, signal: NodeJS.Signals | null) {
    if (this.ended) return;
    this.ended = true;
    this._exitCode = code;
    this._signal = signal;
    this.stdout.end();
    this.emit('exit', code, signal);
  }

  /** The SDK closed stdin (or asked for a kill): carried out by the linger rule. */
  private askClose(signal?: NodeJS.Signals) {
    if (this.ended) return;
    if (!this.child) {
      // Never started (the gate still held it): nothing ran, nothing to wait for.
      this.cancelled = true;
      this.leave?.();
      return this.exited(null, signal ?? null);
    }
    const first = !this.closing;
    this.closing = { at: this.closing?.at ?? Date.now(), signal: signal ?? this.closing?.signal };
    if (first) {
      const t = setTimeout(() => this.closeNow(), this.gate.n.lingerMs);
      t.unref?.();
    }
    this.closeIfDue();
  }

  private closeIfDue() {
    if (!this.closing || !this.child || this.ended) return;
    const age = Date.now() - this.bornAt;
    if (this.answered && age >= this.gate.n.minLifeMs) return this.closeNow();
    if (this.answered) {
      const t = setTimeout(() => this.closeIfDue(), this.gate.n.minLifeMs - age);
      t.unref?.();
    }
  }

  private closeNow() {
    const c = this.child;
    if (!c || this.ended || !this.closing) return;
    const signal = this.closing.signal;
    this.closing.signal = undefined;
    if (!c.stdin?.writableEnded) c.stdin?.end();
    if (signal) {
      try {
        c.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }
}

/** The one gate of this process: every agent process and auxiliary request of every account. */
export const authGate = new AuthGate();

// ───────────────────── a request refused for the sign-in ─────────────────────
//
// A refusal is not believed at once: another process of the account may have renewed the sign-in
// a moment before (the refused one lost the race), or the CLI's renewal lock was busy. The provider
// notes the refusal (`noteAuthFailure`, no notice); when the chat's turn ends the bridge takes it
// (`takeAuthFailure`), waits a moment, asks the CLI for the account's sign-in status the way Sable
// always does (`SignInChecks.check`, one ask per account however many chats were refused), and
// sends the request once more, silently, when the CLI says signed in. Only when the CLI itself says
// signed out does the chat get its one notice, and it waits (`SignInChecks.wait`) until the
// account is signed in again, then carries on by itself.

/** Whether a refusal is for the sign-in: the SDK's `authentication_failed`, or Claude Code's own words for it. */
export function refusedForSignIn(error?: string, texts: readonly (string | undefined)[] = []): boolean {
  return error === 'authentication_failed' || texts.some((t) => isAuthFailure(t));
}

interface Refusal {
  at: number;
  /** The person's message whose turn was running when it happened (the chat's last one then). */
  turn?: string;
  /** Steps of the chat's sub-agents and background tasks that were refused with it (their titles). */
  background: string[];
}

const refusals = new Map<string, Refusal>();

/**
 * A request of chat `chatId` was refused for the sign-in (`step`: the sub-agent or task step it ran in;
 * `turn`: the message whose turn it happened in). A refusal noted in an earlier turn does not count for
 * a later one: it starts over.
 */
export function noteAuthFailure(chatId: string, step?: string, turn?: string) {
  const known = refusals.get(chatId);
  const r: Refusal = known && known.turn === turn ? known : { at: Date.now(), turn, background: [] };
  if (step && !r.background.includes(step) && r.background.length < 12) r.background.push(step.slice(0, 120));
  refusals.set(chatId, r);
}

/** Whether a refusal of chat `chatId` waits to be read (`turn` given: one that happened in that turn). */
export const authFailurePending = (chatId: string, turn?: string) => {
  const r = refusals.get(chatId);
  return !!r && (turn === undefined || r.turn === undefined || r.turn === turn);
};

/** The chat's refusal, once: the bridge reads it when the turn ends. */
export function takeAuthFailure(chatId: string): Refusal | undefined {
  const r = refusals.get(chatId);
  refusals.delete(chatId);
  return r;
}

/** For tests: forget every refusal. */
export function resetAuthFailures() {
  refusals.clear();
}

export interface SignInCheckOptions {
  /** Asks the agent's CLI whether the account is signed in now (fresh: not a cached answer). */
  ask: (provider: string, accountId: string) => Promise<boolean>;
  /** The moment waited before asking (a sibling process may still be writing the renewed sign-in). */
  delayMs?: number | (() => number);
}

/** The checks after a refusal and the chats that wait for an account's sign-in. */
export class SignInChecks {
  private inflight = new Map<string, Promise<boolean>>();
  private waits = new Map<string, Map<string, string[]>>();
  /** Chats sent once more after a refusal, by the message sent (never twice for one message). */
  private retried = new Set<string>();

  constructor(private o: SignInCheckOptions) {}

  /** Whether the account is signed in, asked once for every chat refused meanwhile. */
  check(provider: string, accountId: string): Promise<boolean> {
    const key = `${provider}:${accountId}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const delay = typeof this.o.delayMs === 'function' ? this.o.delayMs() : this.o.delayMs;
    const run = sleep(delay ?? 1500)
      .then(() => this.o.ask(provider, accountId))
      .catch(() => false)
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  /** Whether message `messageId` of chat `chatId` may be sent once more (true once, then false). */
  mayRetry(chatId: string, messageId: string): boolean {
    const k = `${chatId}:${messageId}`;
    if (this.retried.has(k)) return false;
    this.retried.add(k);
    if (this.retried.size > 500) this.retried.delete(this.retried.values().next().value!);
    return true;
  }

  /** Chat `chatId` waits for the account's sign-in (`background`: the steps the refusal stopped, named when it carries on). */
  wait(provider: string, accountId: string, chatId: string, background: string[] = []) {
    const key = `${provider}:${accountId}`;
    const map = this.waits.get(key) ?? new Map<string, string[]>();
    const known = map.get(chatId) ?? [];
    map.set(chatId, [...known, ...background.filter((b) => !known.includes(b))].slice(0, 12));
    this.waits.set(key, map);
  }

  /** Whether chat `chatId` waits for a sign-in (of any account). */
  waiting(chatId: string): boolean {
    for (const map of this.waits.values()) if (map.has(chatId)) return true;
    return false;
  }

  /** The chat no longer waits (it moved, was closed, or the person carried on by hand). */
  drop(chatId: string) {
    for (const [key, map] of this.waits) if (map.delete(chatId) && !map.size) this.waits.delete(key);
  }

  /** The account is signed in again: the chats that waited on it (with what the refusal stopped), once. */
  take(provider: string, accountId: string): [chatId: string, background: string[]][] {
    const key = `${provider}:${accountId}`;
    const map = this.waits.get(key);
    this.waits.delete(key);
    return map ? [...map] : [];
  }
}
