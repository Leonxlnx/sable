import type { AppSettings, BridgeEvent, PhoneStatus, SessionMeta } from '../../shared/protocol';

/**
 * Keep awake: while an agent works (a turn runs, or an /until loop runs its check between turns)
 * the computer should not go to sleep, or an overnight run stops halfway. The bridge only says
 * whether work is running; the desktop shell holds the OS's sleep block (`electron/main.ts`,
 * `powerSaveBlocker` 'prevent-app-suspension': the screen may still turn off).
 *
 * Nothing runs at rest: the state is recomputed only when a session's status, loop or background
 * work changes, and once when a background command grows too old to keep the computer awake.
 */

/** A session as keep awake reads it: `newestCommandAt`, when its youngest background command still running began. */
export type AwakeSession = { meta: SessionMeta; turnActive: boolean; readonly newestCommandAt?: number };

export interface AwakeSource {
  sessions: Iterable<AwakeSession>;
  subscribe(listener: (e: BridgeEvent) => void): () => void;
}

/**
 * How long a background command keeps the computer awake: a test run or a build the agent waits on
 * does, a dev server left running for the evening does not keep the laptop up all night.
 */
export const COMMAND_AWAKE_MS = 2 * 60 * 60_000;

/** Whether this session's agent is at work now. */
export function working(s: { meta: SessionMeta; turnActive: boolean }): boolean {
  const st = s.meta.status;
  return s.turnActive || st === 'running' || st === 'starting' || s.meta.until?.phase === 'checking';
}

/**
 * Calls `onChange(true)` when work starts anywhere and `onChange(false)` once nothing has worked
 * for `graceMs` (an /until loop's gap between check and next turn, or a queued message starting,
 * does not release and take the block again). Returns a stop function.
 */
const atWork = working;

export function watchAwake(src: AwakeSource, onChange: (busy: boolean) => void, graceMs = 60_000): () => void {
  let busy = false;
  let release: ReturnType<typeof setTimeout> | undefined;
  // A command that ages past its bound changes nothing the bridge says: a timer looks again then.
  let aging: ReturnType<typeof setTimeout> | undefined;
  /** A command younger than `COMMAND_AWAKE_MS` runs in the session: until when it keeps it awake, else 0. */
  const commandUntil = (s: AwakeSession, now: number) => {
    const at = (s.meta.commands ?? 0) > 0 ? s.newestCommandAt : undefined;
    return at !== undefined && now - at < COMMAND_AWAKE_MS ? at + COMMAND_AWAKE_MS : 0;
  };
  // Sub-agents still working after their chat's own turn ended keep the computer awake too, and so
  // does a background command that is not old.
  const working = (s: AwakeSession, now = Date.now()) => atWork(s) || (s.meta.background ?? 0) > 0 || commandUntil(s, now) > 0;
  const check = () => {
    const t = Date.now();
    const now = [...src.sessions].some((s) => working(s, t));
    clearTimeout(aging);
    aging = undefined;
    let until = Infinity;
    for (const s of src.sessions) {
      const u = commandUntil(s, t);
      if (u) until = Math.min(until, u);
    }
    if (Number.isFinite(until)) {
      aging = setTimeout(check, Math.max(1000, until - t + 50));
      aging.unref?.();
    }
    if (now) {
      clearTimeout(release);
      release = undefined;
      if (!busy) {
        busy = true;
        onChange(true);
      }
    } else if (busy && !release) {
      release = setTimeout(() => {
        release = undefined;
        if ([...src.sessions].some((s) => working(s))) return;
        busy = false;
        onChange(false);
      }, graceMs);
      release.unref?.();
    }
  };
  const off = src.subscribe((e) => {
    if (e.type === 'session.updated' && ('status' in e.patch || 'until' in e.patch || 'background' in e.patch || 'commands' in e.patch)) check();
    else if (e.type === 'session.removed' || e.type === 'session.added') check();
  });
  check();
  return () => {
    off();
    clearTimeout(release);
    clearTimeout(aging);
    if (busy) onChange(false);
    busy = false;
  };
}

/**
 * The phone: a paired phone can only reach this computer while it is awake. With the phone on,
 * at least one phone paired and `AppSettings.phoneAwake` not off, the shell keeps the computer
 * from sleeping while it runs on mains power (never on battery). Recomputed on the phone's and
 * the settings' own events.
 */
export interface PhoneAwakeSource {
  subscribe(listener: (e: BridgeEvent) => void): () => void;
  phone(): Promise<PhoneStatus | undefined>;
  settings(): AppSettings;
}

export const phoneWantsAwake = (status: PhoneStatus | undefined, settings: AppSettings) => !!status?.enabled && status.devices.length > 0 && settings.phoneAwake !== false;

export function watchPhoneAwake(src: PhoneAwakeSource, onChange: (on: boolean) => void): () => void {
  let status: PhoneStatus | undefined;
  let on = false;
  const check = () => {
    const now = phoneWantsAwake(status, src.settings());
    if (now !== on) {
      on = now;
      onChange(now);
    }
  };
  const off = src.subscribe((e) => {
    if (e.type === 'phone.updated') status = e.status;
    if (e.type === 'phone.updated' || e.type === 'settings.updated') check();
  });
  void src.phone().then(
    (s) => {
      status ??= s;
      check();
    },
    () => {},
  );
  return () => {
    off();
    if (on) onChange(false);
    on = false;
  };
}
