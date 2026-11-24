import type { ProviderSession } from '../providers/types';

export type WorkSession = {
  meta: { status: string; background?: number; commands?: number; moving?: boolean };
  turnActive: boolean;
  readonly newestCommandAt?: number;
  handle?: Pick<ProviderSession, 'liveWork'>;
};

export const COMMAND_HOLDS_MS = 30 * 60_000;
export const WAKE_DELIVERY_GRACE_MS = 2 * 60_000;
const WAKE_HOLDS_MS = 60 * 60_000;
const wakeHeldSince = new WeakMap<NonNullable<WorkSession['handle']>, number>();

/** What still runs in the agent's process, as the agent says it (`ProviderSession.liveWork`). */
type LiveWork = ReturnType<NonNullable<ProviderSession['liveWork']>>;

/** The work a chat holds now (`App.workOf`): one reading for every move, the agent switch and `atRest`. */
export interface ChatWork {
  /** A turn runs: one Sable began, or one the agent runs by itself and says so. */
  turn: boolean;
  /** Sub-agents and workflows working in the background. */
  agents: number;
  /** Background commands and monitors running. */
  commands: number;
  /** Until when what runs holds a move Sable can postpone (a young command, a wake-up due soon); undefined when nothing that ages does. */
  holds?: number;
  /** A future wake-up in the process this move would close. */
  wakeAt?: number;
}

export function workOf(rt: WorkSession, waitable = false, now = Date.now()): ChatWork {
  let live: LiveWork | undefined;
  try {
    live = rt.handle?.liveWork?.();
  } catch {
    live = undefined;
  }
  let holds: number | undefined;
  const newest = rt.meta.commands ? rt.newestCommandAt : undefined;
  if (newest !== undefined) holds = newest + COMMAND_HOLDS_MS;
  const commandAt = live?.newestCommandAt ?? live?.oldestCommandAt;
  if (live?.commands && commandAt !== undefined) holds = Math.max(holds ?? 0, commandAt + COMMAND_HOLDS_MS);
  if (waitable && live?.notificationUntil) holds = Math.max(holds ?? 0, live.notificationUntil);
  const turn = rt.turnActive || !!live?.turn;
  const agents = Math.max(rt.meta.background ?? 0, live?.agents ?? 0);
  const wakeAt = live?.wakeAt;
  if (rt.handle && waitable && !turn && !agents && !(holds && holds > now)) {
    if (wakeAt !== undefined && wakeAt + WAKE_DELIVERY_GRACE_MS > now && wakeAt - now <= WAKE_HOLDS_MS) {
      const since = wakeHeldSince.get(rt.handle) ?? now;
      wakeHeldSince.set(rt.handle, since);
      holds = Math.min(wakeAt + WAKE_DELIVERY_GRACE_MS, since + WAKE_HOLDS_MS);
    } else wakeHeldSince.delete(rt.handle);
  }
  return {
    turn, agents, wakeAt,
    commands: Math.max(rt.meta.commands ?? 0, live?.commands ?? 0),
    ...(holds !== undefined && holds > now ? { holds } : {}),
  };
}
