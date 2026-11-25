/**
 * Lanes: when a session starts in a git folder where another session is working (its turn runs,
 * or files it edited are still uncommitted there), it gets a worktree of its own on a branch
 * `sable/<short title>` and works there; the two never edit the same checkout. The lane is a
 * property of the chat (`SessionMeta.lane`): the chat stays in its folder in the sidebar, its
 * `cwd` is inside the lane, and it returns to the folder when the lane lands or is discarded.
 *
 * Where lanes live: `<worktrees folder>/<repo name>-<hash>/<id>`, the folder the person chose
 * (`AppSettings.worktreesFolder`), by default `<Sable home>/lanes`. Not beside the repository
 * (`../.repo-lanes/`): that would put folders of Sable's into the user's own tree (often a synced,
 * shared or read-only parent, and every file watcher and search there would see them), and one
 * place is easy to find, clean and keep short (Windows path lengths).
 *
 * Nothing runs at rest: the busy check runs when a session starts or sends its first message,
 * the dry merge when the lane is looked at, and every git call has a timeout.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FileDiff, LaneForecast, LaneLandResult, SessionLane, ToolItem } from '../../shared/protocol';
import { repoRoot } from '../services/git';
import { checkoutChanges, createLane, forecastLane, landLane, laneDiff, laneProblem, laneSlug, removeLane, renameLane } from '../services/git-lanes';
import type { SessionRuntime } from './runtime';
import { folderNow, pinFolder } from './contain';

/**
 * Where lanes' worktrees go: the folder the person chose (`AppSettings.worktreesFolder`, `~` for
 * their home folder), else `<Sable home>/lanes`. Paths are resolved, so both `/` and `\` work.
 */
export function worktreesRoot(chosen: string | undefined, userHome: string, sableHome: string): string {
  const picked = chosen?.trim();
  return picked ? path.resolve(picked.replace(/^~(?=$|[\\/])/, userHome)) : path.join(sableHome, 'lanes');
}

export class LaneUnavailable extends Error {}

export interface LaneHost {
  /** Sable's home folder (`~/.sable`). */
  home(): string;
  /** Where new lanes go (`worktreesRoot`); absent means `<home>/lanes`. */
  root?(): string;
  sessions(): Iterable<SessionRuntime>;
  /** Read a restored chat's edits only when its checkout is dirty. */
  load?(rt: SessionRuntime): Promise<void>;
  sending?(rt: SessionRuntime): boolean;
  /** Automatic lanes (`AppSettings.autoLanes`, absent means off). */
  auto(): boolean;
  /** Lets the session's agent go; it starts again in the session's `cwd` with the next message. */
  release(rt: SessionRuntime): Promise<void>;
  /** The agent's config folder for the session's account (Claude Code keeps transcripts per folder there). */
  configHome(rt: SessionRuntime): string | undefined;
  persist(): void;
  kept?(path: string): void;
  log(...args: unknown[]): void;
}

const same = (a: string, b: string) => path.relative(a, b) === '';
const inside = (p: string, root: string) => {
  const rel = path.relative(root, p);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};

function canonical(dir: string) {
  try { return realpathSync.native(dir); } catch { return path.resolve(dir); }
}

function bucket(root: string) {
  const name = path.basename(root).replace(/[^\w.-]+/g, '').slice(0, 16) || 'repo';
  const hash = createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 6);
  return name + '-' + hash;
}

/** Files a session's own edit and write tools changed (absolute), sub-agents' included. */
export function editedFiles(rt: SessionRuntime): string[] {
  const out = new Set<string>();
  for (const it of rt.items) {
    if (it.type !== 'tool') continue;
    const t = it as ToolItem;
    if ((t.kind !== 'edit' && t.kind !== 'write') || t.status !== 'done') continue;
    for (const d of t.result?.diff ?? []) if (d.path) out.add(path.resolve(rt.meta.cwd, d.path));
  }
  return [...out];
}

/** Keep the checkout while a turn, background task or local server depends on it. */
const working = (rt: SessionRuntime) => rt.turnActive || rt.meta.status === 'running' || rt.meta.status === 'awaiting' || !!rt.meta.background || !!rt.meta.commands || !!rt.meta.serving;

/** Claude Code's folder key for its transcripts: every character other than a letter or digit becomes `-`. */
export const claudeFolderKey = (cwd: string) => path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');

/**
 * Claude Code resumes a conversation from the transcript kept under its working folder's key:
 * a conversation that moves to another folder (into a lane, or back) takes a copy along.
 */
export function carryClaudeToFolder(configHome: string, sessionId: string, toCwd: string, fromCwd?: string): boolean {
  if (!/^[\w-]{1,128}$/.test(sessionId)) return false;
  const projects = path.join(configHome, 'projects');
  const to = claudeFolderKey(toCwd);
  const transcript = (key: string) => path.join(projects, key, sessionId + '.jsonl');
  let from = fromCwd ? claudeFolderKey(fromCwd) : '';
  if (!from || !existsSync(transcript(from))) {
    // Older sessions or a provider-specific project key: prefer the newest copy.
    if (!existsSync(projects)) return false;
    let newest = -Infinity;
    for (const entry of readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const st = statSync(transcript(entry.name), { throwIfNoEntry: false });
      if (st?.isFile() && st.mtimeMs >= newest) {
        newest = st.mtimeMs;
        from = entry.name;
      }
    }
    if (newest === -Infinity) return false;
  }
  if (from === to) return true;
  const dst = path.join(projects, to);
  mkdirSync(dst, { recursive: true });
  copyFileSync(path.join(projects, from, `${sessionId}.jsonl`), path.join(dst, `${sessionId}.jsonl`));
  const side = path.join(projects, from, sessionId);
  try {
    if (statSync(side).isDirectory()) cpSync(side, path.join(dst, sessionId), { recursive: true, force: true });
  } catch {
    /* no side folder */
  }
  return true;
}

/** Opens a folder in the system's file manager (the shell inside the desktop app). */
async function openFolder(dir: string): Promise<void> {
  if (process.versions.electron) {
    const { shell } = await import('electron');
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
    return;
  }
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).unref();
}

export class Lanes {
  /** Sessions whose lane is being made, landed or discarded: one at a time per session. */
  private busyWith = new Map<string, Promise<unknown>>();

  constructor(private host: LaneHost) {}

  /** The folder new lanes are made in. */
  get dir() {
    return this.host.root?.() ?? path.join(this.host.home(), 'lanes');
  }

  /** Recognizes Sable's layout, including a lane under an earlier worktrees folder. */
  ours(lane: SessionLane | null | undefined): lane is SessionLane {
    if (!lane || !lane.branch.startsWith('sable/')) return false;
    if ([this.dir, path.join(this.host.home(), 'lanes')].some((dir) => inside(lane.path, dir) && !same(lane.path, dir))) return true;
    // Persisted lanes outlive a change of worktrees folder. Their generated bucket and id
    // identify them there too. removeLane separately checks Git's current registration.
    return path.basename(path.dirname(lane.path)) === bucket(lane.root) && /^[a-f0-9]{4}$/.test(path.basename(lane.path));
  }

  /** A new lane's folder: `<lanes>/<repo name>-<hash>/<id>`, short for Windows paths. */
  private laneDir(root: string): string {
    for (;;) {
      const dir = path.join(this.dir, bucket(root), randomBytes(2).toString('hex'));
      if (!existsSync(dir)) return dir;
    }
  }

  /**
   * The title of another session that keeps `folder`'s repository busy for `self`: its turn runs
   * there, or files it edited there are still uncommitted. Null when the folder is free, or is not
   * in a repository. Each checkout has its own working files, including a nested worktree or submodule.
   */
  async busyWith_(self: SessionRuntime, folder: string): Promise<string | null> {
    const order = this.firstClaims.get(self) ?? Infinity;
    const claimed = (o: SessionRuntime) => (this.firstClaims.get(o) ?? Infinity) < order && !o.items.some((i) => i.type === 'user');
    const others = [...this.host.sessions()].filter((o) => o !== self && !o.meta.chat && (working(o) || claimed(o) || (!o.meta.archived && (o.items.length || this.host.load))));
    if (!others.length) return null;
    const active = new Set(others.filter((o) => working(o) || claimed(o)));
    const root = await repoRoot(folder);
    if (!root) return null;
    const here: SessionRuntime[] = [];
    for (const other of others) {
      const cwd = canonical(other.meta.cwd);
      if (same(cwd, root) || (inside(cwd, root) && same(await repoRoot(cwd) ?? cwd, root))) here.push(other);
    }
    const running = here.find((o) => active.has(o) || working(o));
    if (running) return running.meta.title;
    if (!here.length) return null;
    const status = await checkoutChanges(root);
    if (!status?.paths.length) return null;
    const key = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;
    const dirty = new Set(status.paths.map((p) => key(path.resolve(root, p))));
    for (const other of here) {
      await this.host.load?.(other);
      if (editedFiles(other).some((p) => dirty.has(key(canonical(p))))) return other.meta.title;
    }
    return null;
  }

  private once<T>(rt: SessionRuntime, work: () => Promise<T>): Promise<T> {
    const prev = this.busyWith.get(rt.id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(work);
    this.busyWith.set(rt.id, next);
    void next.finally(() => this.busyWith.get(rt.id) === next && this.busyWith.delete(rt.id)).catch(() => {});
    return next;
  }

  /** Makes a lane for the session's folder and moves the session into it (its agent must not be running there). */
  private async enter(rt: SessionRuntime, slug: string, provisional: boolean): Promise<{ lane: SessionLane } | { error: string }> {
    if (rt.meta.lane) return { error: 'This chat already works in a lane.' };
    const folder = rt.meta.cwd;
    const root = await repoRoot(folder);
    if (!root) return { error: 'This folder is not a git repository.' };
    const made = await createLane({ folder, dir: this.laneDir(root), slug, provisional });
    if ('error' in made) return made;
    try {
      if (!(await pinFolder(made.cwd, true))) throw new Error();
      this.carry(rt, made.cwd);
    } catch {
      await removeLane(made.lane);
      return { error: 'Could not copy the conversation to the lane.' };
    }
    rt.update({ cwd: made.cwd, lane: made.lane });
    this.host.persist();
    return { lane: made.lane };
  }

  /** A conversation the agent keeps per folder goes along to the new one. */
  private carry(rt: SessionRuntime, toCwd: string) {
    const id = rt.meta.providerSessionId;
    if (!id || rt.meta.provider !== 'claude') return;
    const home = this.host.configHome(rt);
    if (home && !carryClaudeToFolder(home, id, toCwd, rt.meta.cwd)) this.host.log('lane: the conversation was not found to carry', id);
  }

  private say(rt: SessionRuntime, lane: SessionLane, other: string | null) {
    rt.notice('info', `Working in lane ${lane.branch}`, other ? `“${other}” is working in ${path.basename(lane.folder)}` : undefined);
  }

  /**
   * A session about to start: when its folder is busy it starts in a lane. The branch is named
   * from `title` when there is one, else made up and renamed by the first message. Never throws.
   */
  atStart(rt: SessionRuntime, title?: string): Promise<void> {
    if (rt.meta.providerSessionId) this.resumed.add(rt);
    if (!this.host.auto() || rt.meta.chat || rt.meta.lane || rt.meta.providerSessionId) return Promise.resolve();
    const run = this.start(rt, title).finally(() => this.starts.get(rt.id) === run && this.starts.delete(rt.id));
    this.starts.set(rt.id, run);
    return run;
  }

  /** Start checks in flight, so the first message does not check twice. */
  private starts = new Map<string, Promise<void>>();
  private resumed = new WeakSet<SessionRuntime>();
  private firstClaims = new WeakMap<SessionRuntime, number>();
  private nextClaim = 0;

  sent(rt: SessionRuntime) { this.firstClaims.delete(rt); }

  /** An already-open agent or a restored one must still have the checkout the chat owns. */
  async ready(rt: SessionRuntime) {
    await this.busyWith.get(rt.id);
    const lane = rt.meta.lane;
    if (!lane) return;
    const folder = await folderNow(rt.meta.cwd);
    if (folder === 'gone') throw new LaneUnavailable('The lane folder is gone. Restore it or discard the lane in Changes.');
    if (folder === 'changed') throw new LaneUnavailable('The lane folder changed. Restore the original checkout before sending.');
    const problem = await laneProblem(lane, 'send');
    if (problem) throw new LaneUnavailable(problem);
  }

  private async start(rt: SessionRuntime, title?: string): Promise<void> {
    try {
      const other = await this.busyWith_(rt, rt.meta.cwd);
      if (!other) return;
      const slug = title ? laneSlug(title) : '';
      const res = await this.once(rt, () => this.enter(rt, slug || randomBytes(2).toString('hex'), !slug));
      if ('error' in res) return void rt.notice('info', 'Could not make a lane', res.error);
      if (slug) this.say(rt, res.lane, other);
      else this.pending.set(rt.id, other);
    } catch (err) {
      this.host.log('lane: start check failed', (err as Error).message);
    }
  }

  /** Who kept the folder busy, for a lane whose line waits for its name. */
  private pending = new Map<string, string>();

  /**
   * The session's first message: names a lane made up at the start, or makes one when the folder
   * became busy since the session started. Refuse the send if isolation was needed and failed.
   */
  async beforeFirstSend(rt: SessionRuntime, text: string): Promise<void> {
    if (rt.items.some((i) => i.type === 'user')) return;
    if (this.resumed.has(rt) || rt.meta.chat) return;
    if (!this.firstClaims.has(rt)) this.firstClaims.set(rt, ++this.nextClaim);
    const starting = this.starts.get(rt.id);
    if (starting) await starting;
    try {
      await this.once(rt, async () => {
        const lane = rt.meta.lane;
        if (lane?.provisional) return this.name(rt, text);
        if (lane || !this.host.auto()) return;
        const other = await this.busyWith_(rt, rt.meta.cwd);
        if (!other) return;
        await this.host.release(rt);
        const res = await this.enter(rt, laneSlug(text) || randomBytes(2).toString('hex'), false);
        if ('error' in res) throw new Error('Could not start in a separate lane. ' + res.error);
        this.say(rt, res.lane, other);
      });
    } catch (err) {
      this.firstClaims.delete(rt);
      throw err;
    }
  }

  /** Gives a lane made up at the start its name from the first message, and says where the session works. */
  private async name(rt: SessionRuntime, text: string): Promise<void> {
    const lane = rt.meta.lane;
    if (!lane?.provisional) return;
    try {
      const next = await renameLane(lane, laneSlug(text));
      if (rt.meta.lane?.path !== lane.path) return;
      const named: SessionLane = { ...rt.meta.lane, branch: next ?? lane.branch };
      delete named.provisional;
      rt.update({ lane: named });
      this.host.persist();
      this.say(rt, named, this.pending.get(rt.id) ?? null);
    } catch (err) {
      this.host.log('lane: could not name', (err as Error).message);
    } finally {
      this.pending.delete(rt.id);
    }
  }

  /** A deleted chat: its lane goes when it holds nothing to land; otherwise the branch keeps the work. */
  async closed(rt: SessionRuntime): Promise<void> {
    await this.starts.get(rt.id);
    await this.once(rt, async () => {
      for (const lane of [rt.meta.lane, ...(rt.meta.retainedLanes ?? [])]) {
        if (lane) await this.cleanClosed(rt, lane);
      }
    });
  }

  private async cleanClosed(rt: SessionRuntime, lane: SessionLane): Promise<void> {
    this.pending.delete(rt.id);
    if (!this.ours(lane) || this.usedByAnother(rt, lane)) return this.host.kept?.(lane.path);
    try {
      const result = await removeLane(lane, { keepUnmergedBranch: true });
      if ('error' in result) {
        this.host.log('lane: kept with its work', lane.path, result.error);
        this.host.kept?.(lane.path);
      }
      else if (result.branchKept) this.host.log('lane: kept branch', lane.branch);
    } catch (err) {
      this.host.log('lane: could not remove', (err as Error).message);
      this.host.kept?.(lane.path);
    }
  }

  private usedByAnother(rt: SessionRuntime, lane: SessionLane) {
    return [...this.host.sessions()].some((other) => other !== rt && (
      inside(canonical(other.meta.cwd), canonical(lane.path)) || (other.meta.lane && inside(canonical(other.meta.lane.root), canonical(lane.path)))
    ));
  }

  /** A lane for the session now, on request (the conversation goes along). */
  async create(rt: SessionRuntime): Promise<{ ok: boolean; error?: string; lane?: SessionLane }> {
    if (rt.meta.lane) return { ok: false, error: 'This chat already works in a lane.' };
    if (rt.meta.chat) return { ok: false, error: 'A chat without a folder has nothing to share.' };
    const res = await this.once(rt, async () => {
      if (rt.meta.lane) return { error: 'This chat already works in a lane.' };
      if (working(rt) || this.host.sending?.(rt)) return { error: 'The agent is still working. Stop it first.' };
      await this.host.release(rt);
      const slug = laneSlug(rt.meta.titleSource === 'user' || rt.items.length ? rt.meta.title : '') || randomBytes(2).toString('hex');
      return this.enter(rt, slug, false);
    });
    if ('error' in res) return { ok: false, error: res.error };
    this.say(rt, res.lane, null);
    return { ok: true, lane: res.lane };
  }

  /**
   * A lane for a session that is about to start, whatever the folder's state and the setting (a
   * race: each chat works in a lane of its own). Its agent must not have started yet. Says where
   * the session works (`detail` under that line).
   */
  async enterNow(rt: SessionRuntime, slug: string, detail?: string): Promise<{ ok: boolean; error?: string; lane?: SessionLane }> {
    if (rt.meta.lane) return { ok: true, lane: rt.meta.lane };
    if (rt.meta.chat) return { ok: false, error: 'A chat without a folder has nothing to share.' };
    const res = await this.once(rt, () => this.enter(rt, slug || randomBytes(2).toString('hex'), false));
    if ('error' in res) return { ok: false, error: res.error };
    rt.notice('info', `Working in lane ${res.lane.branch}`, detail);
    return { ok: true, lane: res.lane };
  }

  /** What the session's lane would bring to the folder's branch, file by file (empty without a lane). */
  async diff(rt: SessionRuntime): Promise<FileDiff[]> {
    const lane = rt.meta.lane;
    return lane ? laneDiff(lane) : [];
  }

  /** Opens the session's lane folder (only ever the lane's own path). */
  async open(rt: SessionRuntime): Promise<{ ok: boolean; error?: string }> {
    const lane = rt.meta.lane;
    if (!lane) return { ok: false, error: 'This chat does not work in a lane.' };
    try {
      if (!statSync(lane.path).isDirectory()) throw new Error();
    } catch {
      return { ok: false, error: 'The lane folder is gone.' };
    }
    try {
      await openFolder(lane.path);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async forecast(rt: SessionRuntime): Promise<LaneForecast> {
    const lane = rt.meta.lane;
    if (!lane) return { state: 'unavailable', ahead: 0, behind: 0, uncommitted: 0, files: 0, additions: 0, deletions: 0, conflicts: [], blocked: [], reason: 'This chat does not work in a lane.' };
    return forecastLane(lane);
  }

  /** Lands the lane on the folder's branch and brings the session back to the folder. */
  async land(rt: SessionRuntime, message?: string): Promise<LaneLandResult> {
    const lane = rt.meta.lane;
    if (!lane) return { ok: false, error: 'This chat does not work in a lane.' };
    if (working(rt)) return { ok: false, error: 'The agent is still working. Stop it first.' };
    return this.once(rt, async () => {
      if (!this.ours(lane) || rt.meta.lane?.path !== lane.path || working(rt) || this.host.sending?.(rt)) return { ok: false, error: 'The chat changed while waiting to land.' };
      if (this.usedByAnother(rt, lane)) return { ok: false, error: 'Another chat still uses this lane folder.' };
      const res = await landLane(lane, message?.trim() || rt.meta.title);
      if (!res.ok) return res;
      const left = await this.leave(rt, lane);
      const detail = left.ok
        ? left.detail ?? (res.commits ? `${res.commits} ${res.commits === 1 ? 'commit' : 'commits'}` : undefined)
        : `${left.error} The chat kept its lane at ${lane.path}.`;
      rt.notice('info', `Landed ${lane.branch} on ${res.target}`, detail);
      return res;
    });
  }

  /** Drops the lane and its work; the session goes back to the folder. */
  async discard(rt: SessionRuntime): Promise<{ ok: boolean; error?: string }> {
    const lane = rt.meta.lane ?? rt.meta.retainedLanes?.at(-1);
    if (!lane) return { ok: false, error: 'This chat does not work in a lane.' };
    if (working(rt)) return { ok: false, error: 'The agent is still working. Stop it first.' };
    return this.once(rt, async () => {
      if ((rt.meta.lane ?? rt.meta.retainedLanes?.at(-1))?.path !== lane.path || working(rt) || this.host.sending?.(rt)) return { ok: false, error: 'The chat changed while waiting to discard.' };
      const left = await this.leave(rt, lane, { force: true });
      if (!left.ok) return left;
      rt.notice('info', `Discarded lane ${lane.branch}`);
      return { ok: true };
    });
  }

  /** The session returns to its folder; the lane's worktree and branch go (a merged branch only, unless `force`). */
  private async leave(rt: SessionRuntime, lane: SessionLane, opts: { force?: boolean } = {}): Promise<{ ok: boolean; error?: string; detail?: string }> {
    // The agent lets go of the lane folder first (Windows cannot remove a folder a process works in).
    const active = rt.meta.lane?.path === lane.path;
    if (active) await this.host.release(rt);
    if (!this.ours(lane)) return { ok: false, error: 'This folder could not be identified as a Sable lane.' };
    if (this.usedByAnother(rt, lane)) return { ok: false, error: 'Another chat still uses this lane folder.' };
    try {
      if (active) this.carry(rt, lane.folder);
    } catch {
      return { ok: false, error: 'Could not copy the conversation back to its folder. The lane was kept.' };
    }
    const others = (rt.meta.retainedLanes ?? []).filter(kept => kept.path !== lane.path);
    // Once merged and carried, the next send belongs at home even if cleanup is interrupted.
    if (active && !opts.force) {
      rt.update({ cwd: lane.folder, lane: null, retainedLanes: [...others, lane] });
      this.host.persist();
    }
    const removed = await removeLane(lane, opts).catch((err: Error) => ({ error: err.message }));
    if ('error' in removed) {
      if (opts.force) return { ok: false, error: removed.error };
      return { ok: true, detail: `${removed.error} Worktree kept at ${lane.path}.` };
    }
    rt.update({ ...(active ? { cwd: lane.folder, lane: null } : {}), retainedLanes: others });
    this.host.persist();
    if (removed.branchKept) rt.notice('info', 'Git kept the branch ' + lane.branch, 'The lane folder was removed.');
    return { ok: true };
  }
}
