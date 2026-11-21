import path from 'node:path';
import type { DiffHunk, FileDiff, GitStatus, PhoneChangedFile, PhoneChanges, PhoneDiff, SessionSnapshot, TimelineItem } from '../../shared/protocol';
import { cap } from '../core/trim';
import { gitDiff, gitStatus } from './git';

/**
 * What a chat changed, for the phone's Changes view (`phone.changes`, `phone.diff`, answered in
 * phone.ts). Read-only, and only ever about the chat's own folder (its lane's worktree when it has
 * one): the phone names a chat, never a folder.
 * - In a git repository: the working tree, as the desktop's Changes tab shows it. A diff is read only
 *   for a file the status lists for that folder now, so no other path on the computer can be read.
 * - Outside one: the chat's own edits (its edit and write steps' diffs, merged per file, as the
 *   desktop's Changes tab does there). No file is read at all.
 * - A turn (`items`): the edits of the steps the phone names, sub-agents' steps included.
 * Lists and diffs are capped for the phone.
 */

export const CHANGES_CAP = {
  /** Files in a list. */
  files: 400,
  path: 400,
  /** Lines of one diff, characters of one line, bytes of one diff. */
  lines: 3000,
  lineChars: 1000,
  bytes: 400_000,
  /** Step ids a turn may name. */
  ids: 4000,
};

/** How long a folder's status stands for `phone.diff`'s check before git is asked again. */
const STATUS_TTL_MS = 20_000;

const slash = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');

/** A path relative to the chat's folder (forward slashes) when it is inside it, as the agent knows it. */
export function relTo(p: string, cwd: string): string {
  const n = slash(p);
  const r = slash(cwd);
  if (r && n.toLowerCase().startsWith(r.toLowerCase() + '/')) return n.slice(r.length + 1);
  return n;
}

export interface EditedFile extends FileDiff {
  /** How many edits made it. */
  edits: number;
}

/**
 * Edit and write steps' diffs, merged per file in order (the desktop's Changes tab outside a
 * repository). `ids`: only these steps, and the steps of the sub-agents among them.
 */
export function editsOf(items: readonly TimelineItem[], cwd: string, ids?: readonly string[]): EditedFile[] {
  let tools: readonly TimelineItem[] = items;
  if (ids) {
    const byId = new Map(items.map((i) => [i.id, i]));
    const kids = new Map<string, string[]>();
    for (const it of items) {
      if (!it.parentId) continue;
      const list = kids.get(it.parentId);
      if (list) list.push(it.id);
      else kids.set(it.parentId, [it.id]);
    }
    const out: TimelineItem[] = [];
    const seen = new Set<string>();
    const walk = (list: readonly string[], depth: number) => {
      for (const id of list) {
        if (seen.has(id)) continue;
        seen.add(id);
        const it = byId.get(id);
        if (it?.type !== 'tool') continue;
        if (it.kind === 'agent') {
          if (depth < 4) walk(kids.get(id) ?? [], depth + 1);
        } else out.push(it);
      }
    };
    walk(ids, 0);
    tools = out;
  }
  const byPath = new Map<string, EditedFile>();
  for (const it of tools) {
    if (it.type !== 'tool' || (it.kind !== 'edit' && it.kind !== 'write') || it.status !== 'done') continue;
    for (const d of it.result?.diff ?? []) {
      const p = relTo(d.path, cwd);
      const cur = byPath.get(p);
      if (!cur) {
        byPath.set(p, { ...d, path: p, ...(d.oldPath ? { oldPath: relTo(d.oldPath, cwd) } : {}), hunks: [...d.hunks], edits: 1 });
        continue;
      }
      cur.additions += d.additions;
      cur.deletions += d.deletions;
      cur.hunks = [...cur.hunks, ...d.hunks];
      cur.edits++;
      if (d.binary) cur.binary = true;
      if (d.status === 'deleted') cur.status = 'deleted';
      else if (cur.status === 'deleted') cur.status = 'modified';
    }
  }
  return [...byPath.values()];
}

const LETTER: Record<FileDiff['status'], string> = { added: 'A', deleted: 'D', renamed: 'R', modified: 'M' };

function listOf(files: PhoneChangedFile[]): Pick<PhoneChanges, 'files' | 'more'> {
  return { files: files.slice(0, CHANGES_CAP.files), ...(files.length > CHANGES_CAP.files ? { more: files.length - CHANGES_CAP.files } : {}) };
}

function editList(scope: 'edits' | 'turn', files: EditedFile[]): PhoneChanges {
  return {
    scope,
    ...listOf(
      files.map((f) => ({
        path: cap(f.path, CHANGES_CAP.path),
        status: LETTER[f.status] ?? 'M',
        additions: f.additions,
        deletions: f.deletions,
        edits: f.edits,
        ...(f.binary ? { binary: true } : {}),
      })),
    ),
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

/** A diff within the phone's budget: the first lines (each cut to a length), the hunks' counts kept true to what is there. */
export function phoneDiffOf(d: FileDiff | null | undefined, numbered: boolean): PhoneDiff {
  if (!d) return { diff: null, numbered };
  let left = CHANGES_CAP.lines;
  let bytes = 0;
  let cut = false;
  const hunks: DiffHunk[] = [];
  for (const h of d.hunks) {
    if (left <= 0 || bytes >= CHANGES_CAP.bytes) {
      cut = true;
      break;
    }
    const lines: string[] = [];
    for (const raw of h.lines) {
      if (left <= 0 || bytes >= CHANGES_CAP.bytes) break;
      const l = raw.length > CHANGES_CAP.lineChars ? `${raw.slice(0, CHANGES_CAP.lineChars)}…` : raw;
      lines.push(l);
      left--;
      bytes += l.length + 4;
    }
    if (lines.length === h.lines.length) hunks.push({ ...h, lines });
    else {
      cut = true;
      let o = 0;
      let n = 0;
      for (const l of lines) {
        if (l[0] === '\\') continue;
        if (l[0] !== '+') o++;
        if (l[0] !== '-') n++;
      }
      if (lines.length) hunks.push({ ...h, lines, oldLines: o, newLines: n });
    }
  }
  const diff: FileDiff = {
    path: cap(d.path, CHANGES_CAP.path),
    ...(d.oldPath ? { oldPath: cap(d.oldPath, CHANGES_CAP.path) } : {}),
    status: d.status,
    additions: d.additions,
    deletions: d.deletions,
    hunks,
    ...(d.binary ? { binary: true } : {}),
  };
  return { diff, numbered, ...(cut ? { cut: true } : {}) };
}

/** Step ids as a phone sends them: strings, a bounded number of them; undefined when none were sent. */
export function stepIds(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 200).slice(0, CHANGES_CAP.ids);
}

/** Answers `phone.changes` and `phone.diff` for one phone endpoint. */
export class PhoneChangesReader {
  private trees = new Map<string, { at: number; status: Promise<GitStatus> }>();

  /** `snapshot`: the chat's own snapshot (its folder and its steps), as the bridge has it. */
  constructor(private snapshot: (sessionId: string) => Promise<SessionSnapshot>) {}

  /** The folder's status: a fresh one (or one being read right now), or one read moments ago. */
  private tree(cwd: string, maxAge: number): Promise<GitStatus> {
    const key = path.resolve(cwd);
    const hit = this.trees.get(key);
    if (hit && Date.now() - hit.at < maxAge) return hit.status;
    // Only the chat's own folder: never a sibling folder of the same repository.
    const status = gitStatus(key, { within: true });
    this.trees.set(key, { at: Date.now(), status });
    status.catch(() => this.trees.delete(key));
    while (this.trees.size > 24) this.trees.delete(this.trees.keys().next().value as string);
    return status;
  }

  async changes(sessionId: string, items?: string[]): Promise<PhoneChanges> {
    const snap = await this.snapshot(sessionId);
    const cwd = snap.session.cwd;
    if (items) return editList('turn', editsOf(snap.items, cwd, items));
    const st = await this.tree(cwd, 1000);
    if (!st.isRepo) return editList('edits', editsOf(snap.items, cwd));
    return {
      scope: 'tree',
      ...(st.branch ? { branch: cap(st.branch, 200) } : {}),
      ...(st.ahead ? { ahead: st.ahead } : {}),
      ...(st.behind ? { behind: st.behind } : {}),
      ...listOf(st.files.map((f) => ({ path: cap(f.path, CHANGES_CAP.path), status: f.status, additions: f.additions ?? 0, deletions: f.deletions ?? 0 }))),
      additions: st.additions,
      deletions: st.deletions,
    };
  }

  async diff(sessionId: string, file: string, items?: string[]): Promise<PhoneDiff> {
    if (!file || file.length > 1000) throw new Error('That file is not among the changes.');
    const snap = await this.snapshot(sessionId);
    const cwd = snap.session.cwd;
    const want = slash(file);
    const fromEdits = (list: EditedFile[]) => {
      const f = list.find((x) => x.path === want);
      if (!f) throw new Error('That file is not among the changes.');
      return phoneDiffOf(f, f.edits === 1);
    };
    if (items) return fromEdits(editsOf(snap.items, cwd, items));
    let st = await this.tree(cwd, STATUS_TTL_MS);
    if (!st.isRepo) return fromEdits(editsOf(snap.items, cwd));
    // In a repository a file is named as the list names it: relative to the chat's folder, inside it.
    if (path.isAbsolute(file) || /^[\\/]|^[a-z]:/i.test(file) || want.split('/').includes('..')) throw new Error('That file is not among the changes.');
    // Only a file the folder's status lists now (asked again once when it is not in the last answer).
    let listed = st.files.find((f) => slash(f.path) === want);
    if (!listed) {
      st = await this.tree(cwd, 0);
      listed = st.isRepo ? st.files.find((f) => slash(f.path) === want) : undefined;
    }
    if (!listed) throw new Error('That file is not among the changes.');
    const list = await gitDiff(cwd, listed.path, false, { within: true });
    // That file's diff and no other (a rename's other side, a file git listed beside it).
    const d = list.find((x) => slash(x.path) === want) ?? null;
    return phoneDiffOf(d, true);
  }
}
