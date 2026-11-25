import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { record, type AuthScope, type EndReason } from './auth-journal';
import { PassThrough } from 'node:stream';
import { isAuthFailure } from '../../shared/synthetic';
import { retireReader, terminateDelegateProcess } from '../util/proc';

/**
 * Schedules Sable-owned starts per config folder. Refreshes inside a CLI and processes
 * started outside the bridge are invisible to this gate.
 *
 * Why: Claude Code and Codex sign in with OAuth, and each renewal of the access token spends the
 * refresh token and hands out a new one. A process that renews and exits (or is killed) before it
 * wrote the new pair can leave a spent token in the folder and the next renewal can be refused.
 * The bridge cannot observe how the CLI locks, persists or recovers a renewal. It starts processes
 * per account (one per chat, kept for Remote Control; prewarm; the capabilities and limits probes;
 * `auth status`; chat titles; commit drafts; checks). After a sleep, tokens may have expired and
 * many timers can become due together.
 *
 * The rules (`GATE` has the numbers):
 * - Process starts of one config folder go one at a time: a start holds the gate until its process
 *   first answers on stdout and a short settle after it (its first request may renew the sign-in),
 *   at most `holdMs`. Two accounts never wait for each other.
 * - Auxiliary requests (a limits read, a sign-in status, a title or draft, which are starts too)
 *   take the same gate. Established chats run independently. A standalone account reader
 *   takes an auxiliary lease only on a quiet folder. Interactive dialogs serialize with each other.
 * - The gate is exclusive: a waiter never goes in beside what holds it (review wave 16, #9: a waiter's
 *   own deadline once let two starts in together). Waiters go in order, except that a chat's start
 *   goes ahead of auxiliary requests still waiting. What is bounded is the hold: a start gives the
 *   gate back at its first answer plus `settleMs`, at most `holdMs`; an auxiliary request at its end,
 *   at most `auxLeaseMs` (Sable's own `auth status` calls end well inside it). A holder that died or
 *   hangs loses the gate when its lease ends, so no start waits for ever: a chat's start waits at
 *   most for the holder's remaining lease plus the starts ahead of it (usually a second or two).
 * - A process asked to close before it answered, or in its first seconds, is let go only once it
 *   answered and is `minLifeMs` old. A responding process drains observable requests before kill.
 *   Unresponsive startup and application quit have bounded waits.
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
  let folder = path.resolve(configDir);
  // Resolve directory junctions too. Only the directory name is resolved.
  try { folder = realpathSync.native(folder); } catch { /* first launch may create it */ }
  return `${provider}:${folder.replace(/[\\/]+$/, '').toLowerCase()}`;
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

  // A pending or live process prevents standalone reads. It never prevents a chat start.
  private processes = new Map<string, number>();
  private dialogs = new Map<string, () => void>();

  canReadAlone(key: string) { return !this.processes.has(key); }

  trackProcess(key: string) {
    this.processes.set(key, (this.processes.get(key) ?? 0) + 1);
    let tracked = true;
    return () => {
      if (!tracked) return;
      tracked = false;
      const remaining = this.processes.get(key)! - 1;
      if (remaining) this.processes.set(key, remaining);
      else this.processes.delete(key);
    };
  }

  async claimDialog(key: string, scope: AuthScope, cancelled: () => boolean) {
    if (this.dialogs.has(key)) record(scope, { event: 'wait', reason: scope.reason });
    while (this.dialogs.has(key) && !cancelled()) await sleep(200);
    if (cancelled()) return () => {};
    // The reset console is the longest dialog (30 minutes). A lost exit must not
    // retain this dialog slot indefinitely. A late close cannot release a newer slot.
    const freeSlot = () => {
      if (this.dialogs.get(key) === freeSlot) this.dialogs.delete(key);
    };
    const deadline = setTimeout(freeSlot, 30 * 60_000);
    deadline.unref?.();
    this.dialogs.set(key, freeSlot);
    // A reset wrapper can outlive its dialog lease. Readers still defer until it exits.
    const untrack = this.trackProcess(key);
    return () => { clearTimeout(deadline); freeSlot(); untrack(); };
  }

  /** Whether anything holds the gate of `key` now. */
  busy(key: string): boolean {
    return !!this.keys.get(key)?.held;
  }

  /**
   * Waits until the gate of `key` is free and it is this one's turn, then holds it until the
   * returned release is called or the lease (`holdMs` for a start, `auxLeaseMs` otherwise) ends,
   * whichever is first. Never beside another holder. The release can be called any number of times.
   */
  async enter(key: string, kind: 'start' | 'aux', scope?: AuthScope): Promise<() => void> {
    this.checkClock();
    if (scope && ['limits', 'status', 'caps', 'history'].includes(scope.reason)) await this.beforeRead();
    const st = this.keys.get(key) ?? { held: false, waiting: [] };
    this.keys.set(key, st);
    const asked = Date.now();
    if (st.held || st.waiting.length) {
      if (scope) record(scope, { event: 'wait', reason: scope.reason });
      await new Promise<void>((go) => {
        const w = { kind, go };
        // A chat's start goes ahead of auxiliary requests that wait, behind starts that wait.
        const at = kind === 'start' ? st.waiting.findIndex((x) => x.kind === 'aux') : -1;
        if (at < 0) st.waiting.push(w);
        else st.waiting.splice(at, 0, w);
      });
    }
    st.held = true;
    this.checkClock();
    // Reserve the wake slot when this folder can actually dispatch. Slots spent
    // while waiting for other holders could all turn into starts in the same instant.
    if (this.waking()) await this.pace(scope);
    if (scope) record(scope, { event: 'enter', reason: scope.reason });
    const waitedMs = Date.now() - asked;
    this.trace.push({ key, kind, at: Date.now(), waitedMs });
    if (this.trace.length > 200) this.trace.splice(0, this.trace.length - 200);
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      if (scope) record(scope, { event: 'leave', reason: scope.reason });
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
  async run<T>(key: string, fn: () => Promise<T>, scope?: AuthScope): Promise<T> {
    const leave = await this.enter(key, 'aux', scope);
    try {
      return await fn();
    } finally {
      leave();
    }
  }

  // ── wakes ──

  private wokeAt = 0;
  private nextSlot = 0;
  private wakeQueue: (() => void)[] = [];
  private slotTimer?: NodeJS.Timeout;
  private expected = 0;
  private watchers = new Set<() => void>();
  private heartbeat?: NodeJS.Timeout;

  watchWake(fn: () => void) {
    this.watchers.add(fn);
    if (!this.heartbeat) {
      this.expected = Date.now() + 5000;
      this.heartbeat = setInterval(() => { this.checkClock(); this.expected = Date.now() + 5000; }, 5000);
      this.heartbeat.unref?.();
    }
    return () => {
      this.watchers.delete(fn);
      if (!this.watchers.size) { clearInterval(this.heartbeat); this.heartbeat = undefined; this.expected = 0; }
    };
  }
  private checkClock() {
    if (this.expected && this.noteTimer(this.expected)) this.expected = Date.now() + 5000;
  }
  readsPaused() { this.checkClock(); return this.wokeAt > 0 && Date.now() - this.wokeAt < 30_000; }
  async beforeRead() {
    while (this.readsPaused()) await sleep(this.wokeAt + 30_000 - Date.now());
  }

  /** A timer meant for `expectedAt` fired now: more than `lateMs` late is a wake. Returns whether it was. */
  noteTimer(expectedAt: number, now = Date.now()): boolean {
    if (now - expectedAt <= this.n.lateMs) return false;
    if (!this.wokeAt || expectedAt > this.wokeAt || now - this.wokeAt > this.n.wakeWindowMs) {
      this.wokeAt = now;
      this.nextSlot = now;
      for (const watch of this.watchers) watch();
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
    this.wakeQueue.push(fn);
    this.scheduleSlot(now);
  }

  private async pace(scope?: AuthScope) {
    // A second sleep can interrupt either wait. Recheck before starting the lease.
    let wake: number;
    do {
      wake = this.wokeAt;
      if (scope && ['limits', 'status', 'caps', 'history'].includes(scope.reason)) await this.beforeRead();
      await new Promise<void>(resolve => this.afterWake(resolve));
      this.checkClock();
    } while (this.wokeAt !== wake);
  }

  private scheduleSlot(now: number) {
    if (this.slotTimer || !this.wakeQueue.length) return;
    const at = Math.max(now, this.nextSlot) + Math.random() * this.n.jitterMs;
    this.slotTimer = setTimeout(() => {
      this.slotTimer = undefined;
      const fired = Date.now();
      this.noteTimer(at, fired);
      this.nextSlot = fired + this.n.spreadMs;
      try { this.wakeQueue.shift()?.(); }
      finally { this.scheduleSlot(fired); }
    }, Math.max(0, at - now));
    this.slotTimer.unref?.();
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
  spawner(stderr?: (data: string) => void, keyOf: (env: SpawnRequest['env']) => string = (env) => gateKey('claude', claudeHomeOf(env)), scope?: AuthScope) {
    return (o: SpawnRequest): GatedProcess => new GatedProcess(this, keyOf(o.env), o, stderr, scope);
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
  private untrack?: () => void;
  private closing?: { at: number; signal?: NodeJS.Signals };
  private _exitCode: number | null = null;
  private _signal: NodeJS.Signals | null = null;
  private _killed = false;

  private controls = new Set<string>();
  private callbacks = new Set<string>();
  private inputs = 0;
  private endEvent?: (reason: EndReason, inFlight: boolean) => void;
  endReason?: EndReason;
  get pending() { return !!(this.controls.size || this.callbacks.size || this.inputs); }
  get pid() { return this.child?.pid; }

  constructor(
    private gate: AuthGate,
    readonly key: string,
    private o: SpawnRequest,
    private stderr?: (data: string) => void,
    private scope?: AuthScope,
  ) {
    super();
    if (scope) this.scope = { ...scope }; // Each physical launch gets its own PID.
    // Errors are reported through 'error' listeners the SDK adds; none must throw meanwhile.
    this.on('error', () => {});
    // Closed before the start: nothing to carry over. After it: once all that was written reached the process.
    this.stdin.on('finish', () => !this.child && this.askClose());
    this.stdin.on('end', () => this.askClose());
    o.signal?.addEventListener('abort', () => this.askClose('SIGTERM'), { once: true });
    if (o.signal?.aborted) { queueMicrotask(() => this.askClose('SIGTERM')); return; }
    void this.start().catch(err => { this.emit('error', err); this.exited(1, null); });
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

  /** The owner of a delegated query is gone. Bypass SDK drain and retire its process tree. */
  async terminateDelegate() {
    if (this.ended) return;
    if (!this.child) return this.askClose('SIGKILL');
    const child = this.child;
    let end!: () => void;
    const exited = new Promise<void>(resolve => { end = resolve; this.once('exit', end); });
    const kill = () => retireReader(child);
    try { await terminateDelegateProcess(() => !this.ended && child.exitCode === null && !child.signalCode, exited, kill, kill); }
    finally { this.off('exit', end); }
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this._killed = true;
    this.askClose(signal);
    return true;
  }

  private async start() {
    const reader = this.scope?.reason === 'limits' || this.scope?.reason === 'caps';
    if (!reader) this.untrack = this.gate.trackProcess(this.key);
    const leave = await this.gate.enter(this.key, reader ? 'aux' : 'start', this.scope);
    this.leave = leave;
    if (this.cancelled || this.scope?.closing?.()) { leave(); return this.exited(null, null); }
    if (reader) {
      if (!this.gate.canReadAlone(this.key)) { leave(); throw new Error('Standalone read deferred'); }
      this.untrack = this.gate.trackProcess(this.key);
    }
    let child: ChildProcess;
    try {
      child = spawn(this.o.command, this.o.args, { cwd: this.o.cwd, env: this.o.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      leave();
      this.emit('error', err as Error);
      return this.exited(1, null);
    }
    this.child = child;
    this.bornAt = Date.now();
    if (this.scope && child.pid) this.endEvent = this.scope.journal?.started(this.scope, this.key, child.pid, () => this.pending, this.bornAt);
    this.stdin.pipe(child.stdin!, { end: false });
    // Keep protocol IDs and a count. Never put frame contents into the journal.
    const requests = createInterface({ input: this.stdin });
    const replies = createInterface({ input: child.stdout! });
    const frame = (line: string, incoming: boolean) => {
      if (!/"(?:control_request|control_response|control_cancel_request|user|result|session_state_changed)"/.test(line)) return;
      try {
        const m = JSON.parse(line);
        if (m.type === 'control_request' && typeof m.request_id === 'string') (incoming ? this.callbacks : this.controls).add(m.request_id);
        if (m.type === 'control_response') (incoming ? this.controls : this.callbacks).delete(m.response?.request_id);
        if (incoming && m.type === 'control_cancel_request') this.callbacks.delete(m.request_id);
        if (!incoming && m.type === 'user') this.inputs++;
        if (incoming && m.type === 'result') this.inputs = Math.max(0, this.inputs - 1);
        if (incoming && m.subtype === 'session_state_changed' && m.state === 'idle') this.inputs = 0;
        if (!this.pending) this.closeIfDue();
      } catch { /* a CLI can write plain text */ }
    };
    requests.on('line', line => frame(line, false));
    replies.on('line', line => frame(line, true));
    this.once('exit', () => { requests.close(); replies.close(); });
    child.stdin?.on('error', () => {});
    child.stdout?.on('data', (d: Buffer) => {
      if (this.ended) return;
      if (!this.answered) {
        this.answered = true;
        if (!reader) setTimeout(leave, this.gate.n.settleMs).unref?.();
        this.closeIfDue();
      }
      this.stdout.write(d);
    });
    child.stderr?.on('data', (d: Buffer) => this.stderr?.(d.toString()));
    child.on('error', (err) => {
      leave();
      this.emit('error', err);
      if (child.pid === undefined) this.exited(1, null);
    });
    child.on('exit', (code, signal) => {
      leave();
      this.exited(code, signal);
    });
    if (this.closing) this.closeIfDue();
  }

  private exited(code: number | null, signal: NodeJS.Signals | null) {
    if (this.ended) return;
    this.ended = true;
    this.endEvent?.(this.endReason ?? (this.closing ? this._killed || this.closing.signal ? 'abort' : 'eof' : code === 0 ? 'exit' : 'error'), this.pending);
    this.untrack?.();
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
    if (signal) this.endReason ??= 'abort';
    this.closing = { at: this.closing?.at ?? Date.now(), signal: signal ?? this.closing?.signal };
    if (first) {
      const reader = this.scope?.reason === 'limits' || this.scope?.reason === 'caps';
      const t = setTimeout(async () => {
        if (this.ended) return;
        if (reader) {
          this.endReason = 'timeout';
          try { await retireReader(this.child!); } catch { /* the child may already be gone */ }
          this.leave?.();
          this.exited(null, 'SIGKILL');
          return;
        }
        // A silent startup still has a deadline. A known request on a responding
        // process owns the transport until its reply, including after SDK abort.
        if (!this.answered || !this.pending || this.scope?.closing?.()) this.closeNow();
      }, reader ? Math.max(1500, this.gate.n.minLifeMs - (Date.now() - this.bornAt)) : this.gate.n.lingerMs);
      t.unref?.();
    }
    this.closeIfDue();
  }

  private closeIfDue() {
    if (!this.closing || !this.child || this.ended) return;
    const age = Date.now() - this.bornAt;
    if (this.answered && age >= this.gate.n.minLifeMs) {
      if (!this.pending) return this.closeNow();
      // For string prompts EOF is the end of the prompt. The CLI still returns its
      // result on stdout. Never forward a kill here while it owes that result.
      if ((this.scope?.reason === 'title' || this.scope?.reason === 'draft') && !this.controls.size && !this.callbacks.size && !this.child.stdin?.writableEnded) this.child.stdin?.end();
      return;
    }
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
  observed?: boolean;
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
export function noteAuthFailure(chatId: string, step?: string, turn?: string, scope?: AuthScope, pid?: number) {
  const known = refusals.get(chatId);
  const r: Refusal = known && known.turn === turn ? known : { at: Date.now(), turn, background: [] };
  if (scope?.journal) {
    record(scope, { event: 'refused', pid });
    r.observed = true;
  }
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
  ask: (provider: string, accountId: string) => Promise<boolean | undefined>;
  /** The moment waited before asking (a sibling process may still be writing the renewed sign-in). */
  delayMs?: number | (() => number);
}

/** The checks after a refusal and the chats that wait for an account's sign-in. */
export class SignInChecks {
  private inflight = new Map<string, Promise<boolean | undefined>>();
  private waits = new Map<string, Map<string, string[]>>();
  /** Chats sent once more after a refusal, by the message sent (never twice for one message). */
  private retried = new Set<string>();

  constructor(private o: SignInCheckOptions) {}

  /** Whether the account is signed in, asked once for every chat refused meanwhile. */
  check(provider: string, accountId: string): Promise<boolean | undefined> {
    const key = `${provider}:${accountId}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const delay = typeof this.o.delayMs === 'function' ? this.o.delayMs() : this.o.delayMs;
    const run = sleep(delay ?? 1500)
      .then(() => this.o.ask(provider, accountId))
      .catch(() => undefined)
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
