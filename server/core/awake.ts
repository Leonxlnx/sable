import type { AppSettings, BridgeEvent, PhoneStatus, SessionMeta } from '../../shared/protocol';

/**
 * Keep awake: while an agent works (a turn runs, or an /until loop runs its check between turns)
 * the computer should not go to sleep, or an overnight run stops halfway. The bridge only says
 * whether work is running; the desktop shell holds the OS's sleep block (`electron/main.ts`,
 * `powerSaveBlocker` 'prevent-app-suspension': the screen may still turn off).
 *
 * Nothing runs at rest: the state is recomputed only when a session's status or loop changes.
 */

export interface AwakeSource {
  sessions: Iterable<{ meta: SessionMeta; turnActive: boolean }>;
  subscribe(listener: (e: BridgeEvent) => void): () => void;
}

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
  // Sub-agents still working after their chat's own turn ended keep the computer awake too.
  const working = (s: { meta: SessionMeta; turnActive: boolean }) => atWork(s) || (s.meta.background ?? 0) > 0;
  const check = () => {
    const now = [...src.sessions].some(working);
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
        if ([...src.sessions].some(working)) return;
        busy = false;
        onChange(false);
      }, graceMs);
      release.unref?.();
    }
  };
  const off = src.subscribe((e) => {
    if (e.type === 'session.updated' && ('status' in e.patch || 'until' in e.patch || 'background' in e.patch)) check();
    else if (e.type === 'session.removed' || e.type === 'session.added') check();
  });
  check();
  return () => {
    off();
    clearTimeout(release);
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
