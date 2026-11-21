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
import type { OpenConsole } from '../util/console';

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

export interface ResetConsoleHost {
  open: OpenConsole;
  /** The agent's command for its reset dialog on this account; undefined when it has none. */
  command: (provider: ProviderId, accountId: string) => { bin: string; args: string[]; env: NodeJS.ProcessEnv } | undefined;
  /** The neutral folder the window starts in (never a project). */
  cwd: () => string;
  /** The window's title. */
  title: (provider: ProviderId, accountId: string) => string;
  /** The account's limits as last known. */
  known: (provider: ProviderId, accountId: string) => RateLimit[] | undefined;
  /** Reads the account's limits from its agent now (no tokens). */
  read: (provider: ProviderId, accountId: string) => Promise<RateLimit[]>;
  /** Windows of the account cleared before their time: what waited on them goes on. */
  cleared: (provider: ProviderId, accountId: string, windows: RateLimit[]) => void;
  emit: (provider: ProviderId, accountId: string, run: ResetRun | null) => void;
  log: (...args: unknown[]) => void;
  now?: () => number;
  /** A second read this long after the first when it showed no change (the plan's answer may lag). */
  settleMs?: number;
  /** The window is closed after this long (a dialog left open). */
  maxOpenMs?: number;
}

const SETTLE_MS = 4000;
const MAX_OPEN_MS = 30 * 60_000;

interface Attempt {
  close: () => void;
  cancelled: boolean;
  run: ResetRun;
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
   * what follows comes as `emit`.
   */
  async start(provider: ProviderId, accountId: string): Promise<{ ok: boolean; error?: string }> {
    const key = `${provider}:${accountId}`;
    if (this.disposed) return { ok: false, error: 'Sable is closing' };
    if (this.attempts.has(key)) return { ok: false, error: 'Claude Code is already open for this account' };
    const command = this.host.command(provider, accountId);
    if (!command) return { ok: false, error: 'This agent has no reset dialog' };
    // Taken before anything awaits: a second click meanwhile is refused.
    const attempt: Attempt = { close: () => {}, cancelled: false, run: { state: 'open', startedAt: this.now() } };
    this.attempts.set(key, attempt);
    let before = this.host.known(provider, accountId) ?? [];
    if (!fullWindows(before, this.now()).length) {
      // Last known says nothing is full: ask once before saying so (a limit may have been met since).
      before = await this.host.read(provider, accountId).catch(() => before);
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
    attempt.close = () => window.close();
    this.host.emit(provider, accountId, attempt.run);
    const limit = setTimeout(() => window.close(), this.host.maxOpenMs ?? MAX_OPEN_MS);
    limit.unref?.();
    void window.closed
      .then(
        () => undefined,
        (err: Error) => err,
      )
      .then(async (failed) => {
        clearTimeout(limit);
        if (failed) {
          this.host.log('reset console failed', failed.message);
          this.finish(key, provider, accountId, { state: 'failed', startedAt: attempt.run.startedAt, message: 'Claude Code could not be opened' });
          return;
        }
        await this.settle(key, provider, accountId, attempt, before);
      });
    return { ok: true };
  }

  /** Closes the window. The limits are still read again: the reset may have gone through before. */
  cancel(provider: ProviderId, accountId: string): boolean {
    const a = this.attempts.get(`${provider}:${accountId}`);
    if (!a || a.run.state !== 'open') return false;
    a.cancelled = true;
    a.close();
    return true;
  }

  /** After the window closed: reads the limits (twice when the first read shows no change) and says what cleared. */
  private async settle(key: string, provider: ProviderId, accountId: string, attempt: Attempt, before: RateLimit[]) {
    if (this.disposed) return;
    const startedAt = attempt.run.startedAt;
    attempt.run = { state: 'reading', startedAt };
    this.host.emit(provider, accountId, attempt.run);
    let cleared: RateLimit[] = [];
    let read = false;
    for (let round = 0; round < 2 && !cleared.length; round++) {
      if (round) await new Promise((r) => setTimeout(r, this.host.settleMs ?? SETTLE_MS));
      if (this.disposed) return;
      try {
        cleared = clearedWindows(before, await this.host.read(provider, accountId), this.now());
        read = true;
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
      this.finish(key, provider, accountId, { state: 'cleared', startedAt, cleared: cleared.map((l) => l.label) });
    } else if (attempt.cancelled) this.finish(key, provider, accountId, null);
    else this.finish(key, provider, accountId, { state: 'unchanged', startedAt, ...(read ? {} : { message: 'The limits could not be read' }) });
  }

  private finish(key: string, provider: ProviderId, accountId: string, run: ResetRun | null) {
    this.attempts.delete(key);
    if (!this.disposed) this.host.emit(provider, accountId, run);
  }

  /** Sable is closing: a window still open stays with the person (they may be confirming in it). */
  dispose() {
    this.disposed = true;
    this.attempts.clear();
  }
}
