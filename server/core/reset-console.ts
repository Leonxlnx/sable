/**
 * A limit reset used in the agent's own dialog (Claude Code's `/limit-reset`). Sable cannot spend
 * one: that needs the CLI's sign-in, which Sable never reads. So it opens the account's own agent in
 * a console window, straight into the dialog, where the person reads what a reset clears and
 * confirms. Sable types nothing there. When the window closes it reads the account's limits again;
 * only windows that were full before and have room now count as cleared, and only then do chats
 * that waited on that account go on (through the same path as a reset by time).
 *
 * One attempt per account at a time. Nothing is offered while nothing is at a limit.
 */
import type { ProviderId, RateLimit, ResetRun } from '../../shared/protocol';
import { closedNormally, type OpenConsole } from '../util/console';

/** Windows that hold an account now: full, with their reset still ahead (or not known). */
export function fullWindows(limits: RateLimit[] | undefined, now: number): RateLimit[] {
  return (limits ?? []).filter((l) => l.percent >= 100 && !(l.resetsAt && l.resetsAt <= now));
}

/** The windows full in `before` that `after` shows with room (by id); a window `after` leaves out is not counted. */
export function clearedWindows(before: RateLimit[], after: RateLimit[], now: number): RateLimit[] {
  const fresh = new Map(after.map((l) => [l.id, l]));
  return fullWindows(before, now).filter((l) => {
    const a = fresh.get(l.id);
    return !!a && a.percent < 100;
  });
}

/**
 * One read of an account's limits: `fresh` when the agent itself answered after it was asked (not
 * a last known answer handed back by a throttle, a refusal or a failure); `signIn` the generation of
 * the account's sign-in the reading belongs to.
 */
export interface ResetReading {
  limits: RateLimit[];
  fresh: boolean;
  signIn?: number;
}

export interface ResetConsoleHost {
  open: OpenConsole;
  /** The agent's command for its reset dialog on this account; undefined when it has none. */
  command: (provider: ProviderId, accountId: string) => { bin: string; args: string[]; env: NodeJS.ProcessEnv } | undefined;
  /** The neutral folder the window starts in (never a project). */
  cwd: () => string;
  /** The window's title. */
  title: (provider: ProviderId, accountId: string) => string;
  /** The account's limits as last known, with the sign-in generation they belong to. */
  known: (provider: ProviderId, accountId: string) => { limits: RateLimit[] | undefined; signIn?: number };
  /** Reads the account's limits from its agent now (no tokens), past any throttle. */
  read: (provider: ProviderId, accountId: string) => Promise<ResetReading>;
  /** Windows of the account cleared before their time: what waited on them goes on. */
  cleared: (provider: ProviderId, accountId: string, windows: RateLimit[]) => void;
  emit: (provider: ProviderId, accountId: string, run: ResetRun | null) => void;
  log: (...args: unknown[]) => void;
  now?: () => number;
  /** A second read this long after the first when it showed no change (the plan's answer may lag). */
  settleMs?: number;
  /** The window is closed after this long (a dialog left open). */
  maxOpenMs?: number;
  /** How long a window asked to close may take before the attempt is given up as failed. */
  closeGraceMs?: number;
}

const SETTLE_MS = 4000;
const MAX_OPEN_MS = 30 * 60_000;
const CLOSE_GRACE_MS = 15_000;

interface Attempt {
  close: () => void;
  cancelled: boolean;
  run: ResetRun;
  /** Closed by Sable (Cancel, or open too long): the exit code says nothing. */
  closedByUs?: boolean;
  /** Over: whatever the window does later is no one's. */
  over?: boolean;
  timers: NodeJS.Timeout[];
}

export class ResetConsoles {
  private attempts = new Map<string, Attempt>();
  private disposed = false;

  constructor(private host: ResetConsoleHost) {}

  private now() {
    return this.host.now?.() ?? Date.now();
  }

  /** The attempt under way for the account, when there is one. */
  current(provider: ProviderId, accountId: string): ResetRun | undefined {
    return this.attempts.get(`${provider}:${accountId}`)?.run;
  }

  /**
   * Opens the account's agent in its reset dialog. Resolves once the window is open (or refused);
   * what follows comes as `emit`. A Cancel or Sable closing while the limits are read first opens
   * nothing (review wave 8, #20).
   */
  async start(provider: ProviderId, accountId: string): Promise<{ ok: boolean; error?: string }> {
    const key = `${provider}:${accountId}`;
    if (this.disposed) return { ok: false, error: 'Sable is closing' };
    if (this.attempts.has(key)) return { ok: false, error: 'Claude Code is already open for this account' };
    const command = this.host.command(provider, accountId);
    if (!command) return { ok: false, error: 'This agent has no reset dialog' };
    // Taken before anything awaits: a second click meanwhile is refused.
    const attempt: Attempt = { close: () => {}, cancelled: false, run: { state: 'open', startedAt: this.now() }, timers: [] };
    this.attempts.set(key, attempt);
    const known = this.host.known(provider, accountId);
    let before = known.limits ?? [];
    let signIn = known.signIn;
    if (!fullWindows(before, this.now()).length) {
      // Last known says nothing is full: ask once before saying so (a limit may have been met since).
      const read = await this.host.read(provider, accountId).catch(() => undefined);
      if (this.attempts.get(key) !== attempt || attempt.cancelled || this.disposed) {
        if (this.attempts.get(key) === attempt) this.attempts.delete(key);
        return { ok: false };
      }
      if (read) {
        before = read.limits;
        signIn = read.signIn;
      }
      if (!fullWindows(before, this.now()).length) {
        this.attempts.delete(key);
        return { ok: false, error: 'Nothing is at a limit right now' };
      }
    }
    let window: ReturnType<OpenConsole>;
    try {
      window = this.host.open({ title: this.host.title(provider, accountId), bin: command.bin, args: command.args, env: command.env, cwd: this.host.cwd() });
    } catch (err) {
      this.attempts.delete(key);
      this.host.log('reset console failed to open', (err as Error).message);
      return { ok: false, error: 'Claude Code could not be opened' };
    }
    attempt.close = () => {
      if (attempt.closedByUs) return;
      attempt.closedByUs = true;
      try {
        window.close();
      } catch (err) {
        this.host.log('reset console close failed', (err as Error).message);
      }
      // A window that does not go when asked never holds the account: given up after a grace.
      const grace = setTimeout(() => {
        if (attempt.over) return;
        this.host.log('reset console did not close');
        this.finish(key, provider, accountId, attempt, attempt.cancelled ? null : { state: 'failed', startedAt: attempt.run.startedAt, message: 'Claude Code did not close' });
      }, this.host.closeGraceMs ?? CLOSE_GRACE_MS);
      grace.unref?.();
      attempt.timers.push(grace);
    };
    this.host.emit(provider, accountId, attempt.run);
    const limit = setTimeout(() => attempt.close(), this.host.maxOpenMs ?? MAX_OPEN_MS);
    limit.unref?.();
    attempt.timers.push(limit);
    void window.closed
      .then(
        (code) => ({ code, err: undefined }),
        (err: Error) => ({ code: undefined, err }),
      )
      .then(async (end: { code?: number | null | void; err?: Error }) => {
        for (const t of attempt.timers) clearTimeout(t);
        if (attempt.over || this.attempts.get(key) !== attempt) return;
        if (end.err) {
          this.host.log('reset console failed', end.err.message);
          this.finish(key, provider, accountId, attempt, { state: 'failed', startedAt: attempt.run.startedAt, message: 'Claude Code could not be opened' });
          return;
        }
        // The program ended with an error of its own (not the person closing its window): the limits
        // are still read (a reset may have gone through), and the result says so when none cleared.
        const failed = !attempt.closedByUs && !closedNormally(end.code);
        if (failed) this.host.log('reset console ended with', end.code);
        await this.settle(key, provider, accountId, attempt, before, signIn, failed);
      });
    return { ok: true };
  }

  /** Closes the window (or stops before it opens). The limits are still read again: the reset may have gone through before. */
  cancel(provider: ProviderId, accountId: string): boolean {
    const a = this.attempts.get(`${provider}:${accountId}`);
    if (!a || a.run.state !== 'open') return false;
    a.cancelled = true;
    a.close();
    return true;
  }

  /**
   * After the window closed: reads the limits (again when the first read shows no change or was not
   * the agent's own answer) and says what cleared. Only a fresh reading of the same sign-in counts
   * (review wave 8, #17).
   */
  private async settle(key: string, provider: ProviderId, accountId: string, attempt: Attempt, before: RateLimit[], signIn: number | undefined, failed: boolean) {
    if (this.disposed) return;
    const startedAt = attempt.run.startedAt;
    attempt.run = { state: 'reading', startedAt };
    this.host.emit(provider, accountId, attempt.run);
    let cleared: RateLimit[] = [];
    let read = false;
    for (let round = 0; round < 3 && !cleared.length; round++) {
      // A third round only while no read so far was the agent's own answer.
      if (round === 2 && read) break;
      if (round) await new Promise((r) => setTimeout(r, this.host.settleMs ?? SETTLE_MS));
      if (this.disposed || attempt.over) return;
      try {
        const r = await this.host.read(provider, accountId);
        if (this.disposed || attempt.over) return;
        if (!r.fresh) continue;
        read = true;
        // Another sign-in now: what was full before was someone else's.
        if (signIn !== undefined && r.signIn !== undefined && r.signIn !== signIn) break;
        cleared = clearedWindows(before, r.limits, this.now());
      } catch (err) {
        this.host.log('limits read after a reset failed', (err as Error).message);
      }
    }
    if (cleared.length) {
      try {
        this.host.cleared(provider, accountId, cleared);
      } catch (err) {
        this.host.log('waking chats after a reset failed', (err as Error).message);
      }
      this.finish(key, provider, accountId, attempt, { state: 'cleared', startedAt, cleared: cleared.map((l) => l.label) });
    } else if (attempt.cancelled) this.finish(key, provider, accountId, attempt, null);
    else if (failed) this.finish(key, provider, accountId, attempt, { state: 'failed', startedAt, message: 'Claude Code ended with an error' });
    else this.finish(key, provider, accountId, attempt, { state: 'unchanged', startedAt, ...(read ? {} : { message: 'The limits could not be read' }) });
  }

  private finish(key: string, provider: ProviderId, accountId: string, attempt: Attempt, run: ResetRun | null) {
    if (attempt.over) return;
    attempt.over = true;
    for (const t of attempt.timers) clearTimeout(t);
    if (this.attempts.get(key) === attempt) this.attempts.delete(key);
    if (!this.disposed) this.host.emit(provider, accountId, run);
  }

  /** Sable is closing: a window still open stays with the person (they may be confirming in it). */
  dispose() {
    this.disposed = true;
    for (const a of this.attempts.values()) {
      a.over = true;
      for (const t of a.timers) clearTimeout(t);
    }
    this.attempts.clear();
  }
}
