/**
 * Race: one task given to two agents at once (Claude Code and Codex, or two models of one agent
 * where only one is signed in), each chat in a lane of its own made from the same folder, so the
 * two never touch the same checkout. The person watches both, then keeps one: its lane lands on
 * the folder's branch through the lanes' own land path (dry merge first, nothing changed on a
 * conflict), and only then is the other lane discarded and its chat archived. Nothing is landed or
 * discarded without that explicit request.
 *
 * The pairing is a property of both chats (`SessionMeta.race`), stored with the sessions, so a race
 * survives a restart. Nothing runs at rest.
 */
import { randomUUID } from 'node:crypto';
import type { LaneForecast, LaneLandResult, ProviderId, RaceKeepResult, SessionRace, SessionSnapshot } from '../../shared/protocol';
import { repoRoot } from '../services/git';
import { laneSlug } from '../services/git-lanes';
import type { SessionRuntime } from './runtime';

/** One side of a race: an agent with its model and account. */
export interface Contender {
  provider: ProviderId;
  /** Empty: the agent's own default model. */
  model: string;
  accountId: string;
  /** What tells this side from the other: the agent's name, or the model's when both are one agent. */
  label: string;
  /** Part of its lane's branch name: `claude`, `codex`, or the model's slug. */
  slug: string;
}

export interface RaceHost {
  get(id: string): SessionRuntime | undefined;
  /** The two that race in `cwd`: Claude Code and Codex, or two models of one agent; `error` when none can. */
  contenders(cwd: string, hint?: ProviderId): Promise<Contender[] | { error: string }>;
  /**
   * A new chat in `cwd` for one side, in a lane of its own made before its agent starts (`slug`
   * names the branch, `detail` goes under the lane's line). Rejects when the lane cannot be made;
   * the chat is gone then.
   */
  create(c: Contender, cwd: string, opts: { slug: string; detail: string; mode?: string }): Promise<SessionRuntime>;
  /** Deletes a chat this race made (when its rival could not start). */
  remove(rt: SessionRuntime): Promise<void>;
  send(rt: SessionRuntime, text: string): Promise<void>;
  /** Ends the session's turn and lets its agent go, so its lane can be removed. */
  stop(rt: SessionRuntime): Promise<void>;
  forecast(rt: SessionRuntime): Promise<LaneForecast>;
  land(rt: SessionRuntime, message: string): Promise<LaneLandResult>;
  discard(rt: SessionRuntime): Promise<{ ok: boolean; error?: string }>;
  persist(): void;
  log(...args: unknown[]): void;
}

/** Working now, or about to: its turn runs, it waits on the person mid-turn, or its agent is still starting. */
const working = (rt: SessionRuntime) => rt.turnActive || rt.meta.status === 'running' || rt.meta.status === 'awaiting' || rt.meta.status === 'starting';

/** A race's title in a few words, for its commits and its lanes' names. */
const short = (task: string) => task.replace(/\s+/g, ' ').trim().slice(0, 72);

export class Races {
  /** Races being decided: one decision at a time per race. */
  private busy = new Map<string, Promise<unknown>>();

  constructor(private host: RaceHost) {}

  /** The chat's race and its rival, while the race is open. */
  private open(rt: SessionRuntime): { race: SessionRace; rival?: SessionRuntime } | { error: string } {
    const race = rt.meta.race;
    if (!race) return { error: 'This chat is not in a race.' };
    if (race.outcome) return { error: 'This race is decided.' };
    const rival = this.host.get(race.rival);
    return { race, rival: rival?.meta.race?.id === race.id ? rival : undefined };
  }

  private once<T>(id: string, work: () => Promise<T>): Promise<T> {
    const prev = this.busy.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(work);
    this.busy.set(id, next);
    void next.finally(() => this.busy.get(id) === next && this.busy.delete(id)).catch(() => {});
    return next;
  }

  /**
   * Starts a race in `cwd`: two chats, each in a new lane, both sent `task`. Refused outside a git
   * folder, or when no agent can race; a side whose lane cannot be made takes the other side down too.
   */
  async start(p: { cwd: string; task: string; provider?: ProviderId; modes?: Partial<Record<ProviderId, string>> }): Promise<{ ok: boolean; error?: string; raceId?: string; sessions?: SessionSnapshot[] }> {
    const task = p.task.trim();
    if (!task) return { ok: false, error: 'Add a task after /race' };
    const root = await repoRoot(p.cwd);
    if (!root) return { ok: false, error: 'Race needs a folder in a git repository.' };
    const sides = await this.host.contenders(p.cwd, p.provider);
    if ('error' in sides) return { ok: false, error: sides.error };
    const [a, b] = sides;
    const base = laneSlug(task, 22) || 'race';
    // One lane after the other: two worktrees added at once may meet on git's locks.
    const made: SessionRuntime[] = [];
    try {
      for (const [me, other] of [
        [a, b],
        [b, a],
      ] as const) {
        made.push(await this.host.create(me, p.cwd, { slug: `race-${base}-${me.slug}`, detail: `Racing ${other.label} on the same task`, mode: p.modes?.[me.provider] }));
      }
    } catch (err) {
      for (const rt of made) await this.host.remove(rt).catch(() => {});
      return { ok: false, error: (err as Error).message || 'Could not start the race.' };
    }
    const id = randomUUID();
    const now = Date.now();
    const folder = made[0].meta.lane?.folder ?? p.cwd;
    made.forEach((rt, i) => rt.update({ race: { id, rival: made[1 - i].id, side: i as 0 | 1, task, folder, startedAt: now } }));
    this.host.persist();
    await Promise.all(made.map(rt => this.host.send(rt, task)));
    return { ok: true, raceId: id, sessions: made.map((rt) => rt.snapshot()) };
  }

  /**
   * Keeps this chat's lane: it lands on the folder's branch (refused, with nothing changed, when it
   * would conflict or the folder has uncommitted edits in its files), then the rival's lane is
   * discarded (its agent stopped first when it still works) and its chat archived.
   */
  keep(rt: SessionRuntime, message?: string): Promise<RaceKeepResult> {
    const o = this.open(rt);
    if ('error' in o) return Promise.resolve({ ok: false, error: o.error });
    return this.once(o.race.id, async () => {
      const { race, rival } = o;
      if (!rt.meta.lane) return { ok: false, error: 'This chat has no lane to land.' };
      if (working(rt)) return { ok: false, error: 'This agent is still working. Stop it first.' };
      const f = await this.host.forecast(rt);
      const target = f.target ?? rt.meta.lane.from ?? 'the branch';
      if (f.state === 'conflicts') return { ok: false, conflicts: f.conflicts, target: f.target, error: `It conflicts with ${target}. Nothing was changed.` };
      if (f.state === 'blocked') return { ok: false, blocked: f.blocked, target: f.target, error: `The folder has uncommitted edits in files this lane changes. Nothing was changed.` };
      if (f.state === 'nothing') return { ok: false, error: 'This lane has no changes to land.' };
      if (f.state === 'unavailable') return { ok: false, error: f.reason ?? 'Could not check the lane.' };
      const landed = await this.host.land(rt, message?.trim() || short(race.task));
      if (!landed.ok) return landed;
      const endedAt = Date.now();
      rt.update({ race: { ...race, outcome: 'kept', endedAt } });
      let discarded = true;
      let warning: string | undefined;
      if (rival) {
        const dropped = await this.drop(rival);
        discarded = dropped.ok;
        if (!dropped.ok) warning = `Landed. The other lane could not be removed: ${dropped.error ?? 'unknown error'}`;
        rival.update({ race: { ...rival.meta.race!, outcome: 'dropped', endedAt }, ...(dropped.ok ? { archived: true } : {}) });
      }
      this.host.persist();
      return { ...landed, discarded, ...(warning ? { warning } : {}) };
    });
  }

  /** Discards both lanes of the race (agents still working are stopped first); both chats are archived. */
  discardBoth(rt: SessionRuntime): Promise<{ ok: boolean; error?: string }> {
    const o = this.open(rt);
    if ('error' in o) return Promise.resolve({ ok: false, error: o.error });
    return this.once(o.race.id, async () => {
      const both = [rt, ...(o.rival ? [o.rival] : [])];
      const results = [];
      for (const s of both) results.push(await this.drop(s));
      const failed = results.find((r) => !r.ok);
      // A lane that could not go keeps the race open, to try again (the one that went stays gone).
      if (failed) return { ok: false, error: failed.error ?? 'Could not remove a lane.' };
      const endedAt = Date.now();
      for (const s of both) s.update({ archived: true, race: { ...s.meta.race!, outcome: 'dropped', endedAt } });
      this.host.persist();
      return { ok: true };
    });
  }

  /** One side out of the race: its agent stopped, its lane and branch removed with their work. */
  private async drop(rt: SessionRuntime): Promise<{ ok: boolean; error?: string }> {
    if (working(rt)) await this.host.stop(rt);
    if (!rt.meta.lane) return { ok: true };
    return this.host.discard(rt);
  }

  /** A chat deleted: its rival races no more (it keeps its lane, to land or discard as any lane). */
  closed(rt: SessionRuntime) {
    const race = rt.meta.race;
    if (!race || race.outcome) return;
    const rival = this.host.get(race.rival);
    if (rival?.meta.race?.id !== race.id) return;
    rival.update({ race: null });
    this.host.persist();
  }
}
