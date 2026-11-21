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
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FileDiff, LaneForecast, LaneLandResult, SessionLane, ToolItem } from '../../shared/protocol';
import { repoRoot, runGit } from '../services/git';
import { createLane, forecastLane, landLane, laneDiff, laneSlug, removeLane, renameLane } from '../services/git-lanes';
import type { SessionRuntime } from './runtime';

/**
 * Where lanes' worktrees go: the folder the person chose (`AppSettings.worktreesFolder`, `~` for
 * their home folder), else `<Sable home>/lanes`. Paths are resolved, so both `/` and `\` work.
 */
export function worktreesRoot(chosen: string | undefined, userHome: string, sableHome: string): string {
  const picked = chosen?.trim();
  return picked ? path.resolve(picked.replace(/^~(?=$|[\\/])/, userHome)) : path.join(sableHome, 'lanes');
}

export interface LaneHost {
  /** Sable's home folder (`~/.sable`). */
  home(): string;
  /** Where new lanes go (`worktreesRoot`); absent means `<home>/lanes`. */
  root?(): string;
  sessions(): Iterable<SessionRuntime>;
  /** Automatic lanes (`AppSettings.autoLanes`, absent means off). */
  auto(): boolean;
  /** Lets the session's agent go; it starts again in the session's `cwd` with the next message. */
  release(rt: SessionRuntime): Promise<void>;
  /** The agent's config folder for the session's account (Claude Code keeps transcripts per folder there). */
  configHome(rt: SessionRuntime): string | undefined;
  persist(): void;
  log(...args: unknown[]): void;
}

const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (p: string, root: string) => {
  const rel = path.relative(path.resolve(root).toLowerCase(), path.resolve(p).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

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

/** Whether a session is working right now (its turn runs, or it waits on the user mid-turn). */
const working = (rt: SessionRuntime) => rt.turnActive || rt.meta.status === 'running' || rt.meta.status === 'awaiting';

/** Claude Code's folder key for its transcripts: every character other than a letter or digit becomes `-`. */
export const claudeFolderKey = (cwd: string) => path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');

/**
 * Claude Code resumes a conversation from the transcript kept under its working folder's key:
 * a conversation that moves to another folder (into a lane, or back) takes a copy along.
 */
export function carryClaudeToFolder(configHome: string, sessionId: string, toCwd: string): boolean {
  if (!/^[\w-]{1,128}$/.test(sessionId)) return false;
  const projects = path.join(configHome, 'projects');
  let keys: string[];
  try {
    keys = readdirSync(projects, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return false;
  }
  const to = claudeFolderKey(toCwd);
  const from = keys.find((k) => existsSync(path.join(projects, k, `${sessionId}.jsonl`)));
  if (!from) return false;
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

  /**
   * Only a lane in a folder Sable made is ever removed: the chosen worktrees folder, or the default
   * one (a lane made before the folder was changed still goes).
   */
  ours(lane: SessionLane | null | undefined): lane is SessionLane {
    if (!lane) return false;
    return [this.dir, path.join(this.host.home(), 'lanes')].some((root) => inside(lane.path, root) && !same(lane.path, root));
  }

  /** A new lane's folder: `<lanes>/<repo name>-<hash>/<id>`, short for Windows paths. */
  private laneDir(root: string): string {
    const name = path.basename(root).replace(/[^\w.-]+/g, '').slice(0, 16) || 'repo';
    const hash = createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 6);
    for (;;) {
      const dir = path.join(this.dir, `${name}-${hash}`, randomBytes(2).toString('hex'));
      if (!existsSync(dir)) return dir;
    }
  }

  /**
   * The title of another session that keeps `folder`'s repository busy for `self`: its turn runs
   * there, or files it edited there are still uncommitted. Null when the folder is free, or is not
   * in a repository. Sessions in lanes of their own do not count; git runs only when another
   * session could count.
   */
  async busyWith_(self: SessionRuntime, folder: string): Promise<string | null> {
    const others = [...this.host.sessions()].filter((o) => o !== self && !o.meta.lane && !o.meta.chat && !o.meta.archived && (working(o) || o.items.length > 0));
    if (!others.length) return null;
    const root = await repoRoot(folder);
    if (!root) return null;
    const here = others.filter((o) => inside(o.meta.cwd, root));
    const running = here.find(working);
    if (running) return running.meta.title;
    const edited = here.map((o) => ({ o, files: editedFiles(o).filter((f) => inside(f, root)) })).filter((x) => x.files.length);
    if (!edited.length) return null;
    const st = await runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeoutMs: 15_000 });
    if (st.code !== 0) return null;
    const dirty = new Set(
      st.stdout
        .split('\0')
        .filter((r) => r.length > 3)
        .map((r) => path.resolve(root, r.slice(3)).toLowerCase()),
    );
    return edited.find((x) => x.files.some((f) => dirty.has(path.resolve(f).toLowerCase())))?.o.meta.title ?? null;
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
    const folder = rt.meta.cwd;
    const root = await repoRoot(folder);
    if (!root) return { error: 'This folder is not a git repository.' };
    const made = await createLane({ folder, dir: this.laneDir(root), slug, provisional });
    if ('error' in made) return made;
    this.carry(rt, made.cwd);
    rt.update({ cwd: made.cwd, lane: made.lane });
    this.host.persist();
    return { lane: made.lane };
  }

  /** A conversation the agent keeps per folder goes along to the new one. */
  private carry(rt: SessionRuntime, toCwd: string) {
    const id = rt.meta.providerSessionId;
    if (!id || rt.meta.provider !== 'claude') return;
    const home = this.host.configHome(rt);
    if (home && !carryClaudeToFolder(home, id, toCwd)) this.host.log('lane: the conversation was not found to carry', id);
  }

  private say(rt: SessionRuntime, lane: SessionLane, other: string | null) {
    rt.notice('info', `Working in lane ${lane.branch}`, other ? `“${other}” is working in ${path.basename(lane.folder)}` : undefined);
  }

  /**
   * A session about to start: when its folder is busy it starts in a lane. The branch is named
   * from `title` when there is one, else made up and renamed by the first message. Never throws.
   */
  atStart(rt: SessionRuntime, title?: string): Promise<void> {
    if (!this.host.auto() || rt.meta.chat || rt.meta.lane || rt.meta.providerSessionId) return Promise.resolve();
    const run = this.start(rt, title).finally(() => this.starts.get(rt.id) === run && this.starts.delete(rt.id));
    this.starts.set(rt.id, run);
    return run;
  }

  /** Start checks in flight, so the first message does not check twice. */
  private starts = new Map<string, Promise<void>>();

  private async start(rt: SessionRuntime, title?: string): Promise<void> {
    try {
      const other = await this.busyWith_(rt, rt.meta.cwd);
      if (!other) return;
      const slug = title ? laneSlug(title) : '';
      const res = await this.once(rt, () => this.enter(rt, slug || randomBytes(2).toString('hex'), !slug));
      if ('error' in res) return void this.host.log('lane: not made', res.error);
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
   * became busy since the session started. Never throws.
   */
  async beforeFirstSend(rt: SessionRuntime, text: string): Promise<void> {
    if (rt.items.some((i) => i.type === 'user')) return;
    // The start check is still deciding (the agent waits for it anyway): the lane, if any, is named
    // once it is there, without holding the message up.
    const starting = this.starts.get(rt.id);
    if (starting) return void starting.then(() => this.name(rt, text));
    try {
      const lane = rt.meta.lane;
      if (lane?.provisional) return await this.name(rt, text);
      if (lane || !this.host.auto() || rt.meta.chat || rt.meta.providerSessionId) return;
      const other = await this.busyWith_(rt, rt.meta.cwd);
      if (!other) return;
      await this.host.release(rt);
      const res = await this.once(rt, () => this.enter(rt, laneSlug(text) || randomBytes(2).toString('hex'), false));
      if ('error' in res) return void this.host.log('lane: not made', res.error);
      this.say(rt, res.lane, other);
    } catch (err) {
      this.host.log('lane: first message check failed', (err as Error).message);
    }
  }

  /** Gives a lane made up at the start its name from the first message, and says where the session works. */
  private async name(rt: SessionRuntime, text: string): Promise<void> {
    const lane = rt.meta.lane;
    if (!lane?.provisional) return;
    try {
      const next = await this.once(rt, () => renameLane(lane, laneSlug(text)));
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
    const lane = rt.meta.lane;
    this.pending.delete(rt.id);
    if (!this.ours(lane)) return;
    try {
      const f = await forecastLane(lane);
      if (f.state !== 'nothing' || f.ahead > 0) return void this.host.log('lane: kept with its work', lane.branch);
      await removeLane(lane, { force: true });
    } catch (err) {
      this.host.log('lane: could not remove', (err as Error).message);
    }
  }

  /** A lane for the session now, on request (the conversation goes along). */
  async create(rt: SessionRuntime): Promise<{ ok: boolean; error?: string; lane?: SessionLane }> {
    if (rt.meta.lane) return { ok: false, error: 'This chat already works in a lane.' };
    if (rt.meta.chat) return { ok: false, error: 'A chat without a folder has nothing to share.' };
    if (rt.turnActive) return { ok: false, error: 'The agent is still working. Stop it first.' };
    await this.host.release(rt);
    const slug = laneSlug(rt.meta.titleSource === 'user' || rt.items.length ? rt.meta.title : '') || randomBytes(2).toString('hex');
    const res = await this.once(rt, () => this.enter(rt, slug, false));
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
    if (rt.turnActive) return { ok: false, error: 'The agent is still working. Stop it first.' };
    return this.once(rt, async () => {
      const res = await landLane(lane, message?.trim() || rt.meta.title);
      if (!res.ok) return res;
      await this.leave(rt, lane);
      rt.notice('info', `Landed ${lane.branch} on ${res.target}`, res.commits ? `${res.commits} ${res.commits === 1 ? 'commit' : 'commits'}` : undefined);
      return res;
    });
  }

  /** Drops the lane and its work; the session goes back to the folder. */
  async discard(rt: SessionRuntime): Promise<{ ok: boolean; error?: string }> {
    const lane = rt.meta.lane;
    if (!lane) return { ok: false, error: 'This chat does not work in a lane.' };
    if (rt.turnActive) return { ok: false, error: 'The agent is still working. Stop it first.' };
    return this.once(rt, async () => {
      const left = await this.leave(rt, lane, { force: true });
      if (!left.ok) return left;
      rt.notice('info', `Discarded lane ${lane.branch}`);
      return { ok: true };
    });
  }

  /** The session returns to its folder; the lane's worktree and branch go (a merged branch only, unless `force`). */
  private async leave(rt: SessionRuntime, lane: SessionLane, opts: { force?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
    // The agent lets go of the lane folder first (Windows cannot remove a folder a process works in).
    await this.host.release(rt);
    if (this.ours(lane)) {
      const removed = await removeLane(lane, opts);
      if ('error' in removed) {
        this.host.log('lane: could not remove', lane.path, removed.error);
        // A discard that could not remove the lane keeps the session in it, to try again.
        if (opts.force) return { ok: false, error: removed.error };
      }
    }
    this.carry(rt, lane.folder);
    rt.update({ cwd: lane.folder, lane: null });
    this.host.persist();
    return { ok: true };
  }
}
