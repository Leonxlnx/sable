import type { FileDiff, TimelineItem, ToolKind, TurnLive } from './protocol';
import { isLeadIn } from '../src/features/timeline/lead-in';
import { PositionIndex, rootShape, turnBoundary, type Boundary, type RootShape, type TurnState } from './turn-live-index';

// A fold of adjacent pieces of a running segment. 'open' is the position of the first
// folded item in its last run. Times are read from those positions only at publication.
interface Flow {
  firstWork: boolean;
  runs: number;
  steps: number;
  open?: number;
  openSteps: number;
  at: number;
}
function flow(a?: Flow, b?: Flow): Flow | undefined {
  if (!a || !b) return a ?? b;
  const joined = a.open !== undefined && b.firstWork;
  const continues = joined && b.runs === 1 && b.open !== undefined;
  return {
    firstWork: a.firstWork, runs: a.runs + b.runs - Number(joined), steps: a.steps + b.steps,
    open: continues ? a.open : b.open, openSteps: b.openSteps + (continues ? a.openSteps : 0),
    at: continues ? a.at : b.at,
  };
}
const work = (pos: number, steps = 0): Flow => ({ firstWork: true, runs: 1, steps, open: pos, openSteps: steps, at: pos });
const shown = (pos: number): Flow => ({ firstWork: false, runs: 0, steps: 0, openSteps: 0, at: pos });

interface Piece {
  // A trailing lead-in folds unless the next item puts it in view. A steer reply
  // stands ahead of the flow, even when steps arrived between it and the steer.
  closer?: boolean;
  lead?: number;
  reply?: number;
  body?: Flow;
  substantial?: boolean;
  last?: number;
  anchor?: number;
  stopped?: boolean;
}
function pieces(a: Piece, b: Piece): Piece {
  if (b.closer === undefined) return a;
  const lead = a.lead === undefined ? undefined : b.closer ? shown(a.lead) : work(a.lead);
  return {
    anchor: a.anchor, stopped: a.stopped || b.stopped, closer: a.closer ?? b.closer, lead: b.lead, reply: a.reply ?? b.reply,
    substantial: a.substantial || b.substantial, last: b.last, body: flow(flow(a.body, lead), b.body),
  };
}
// An empty taken segment inherits the previous active run. A Stop explicitly clears it.
interface Runs { runs: number; steps: number; active?: Flow | null }
const empty: Runs = { runs: 0, steps: 0 };
function finish(p: Piece): Runs {
  // A segment that only contains notices shows each one. A taken steer with no
  // content leaves the live run above it in place (TurnGroup.liveSegment).
  const last = p.last ?? p.anchor;
  if (last === undefined) return empty;
  const active = p.substantial
    ? flow(p.reply === undefined ? undefined : shown(p.reply), flow(p.body, p.lead === undefined ? undefined : work(p.lead)))!
    : shown(last);
  return { runs: active.runs, steps: active.steps, active: p.stopped ? null : active };
}
function runs(a: Runs, b: Runs): Runs {
  return { runs: a.runs + b.runs, steps: a.steps + b.steps, active: b.active === undefined ? a.active : b.active };
}

// Only the segments on either edge can still join their neighbours. Keep the
// interior as counts, so even a patch in the first checkpoint never replays the turn.
interface Segments { first: Piece; middle?: Runs; last?: Piece }
function segments(a: Segments, b: Segments): Segments {
  const seam = pieces(a.last ?? a.first, b.first);
  if (!a.last) return { ...b, first: seam };
  if (!b.last) return { ...a, last: seam };
  return { first: a.first, middle: runs(runs(a.middle ?? empty, finish(seam)), b.middle ?? empty), last: b.last };
}
interface Part { segments: Segments; owesReply: boolean }
// Two possible incoming states of a range: a steer may still be waiting for its
// first words. A notification between that steer and its reply folds as work.
type Range = readonly [Part, Part];
function join(a: Range, b: Range): Range {
  const append = (p: Part) => {
    const next = b[Number(p.owesReply)];
    return { segments: segments(p.segments, next.segments), owesReply: next.owesReply };
  };
  return [append(a[0]), append(a[1])];
}
type Shape = RootShape | 'lead';
function shape(i: TimelineItem): Shape | undefined {
  const kind = rootShape(i);
  return kind === 'text' && i.type === 'text' && isLeadIn(i.text, !!i.streaming) ? 'lead' : kind;
}
function atom(kind: Shape, pos: number): Range {
  const boundary = (steer: boolean): Part => ({ segments: { first: {}, last: steer ? {} : { anchor: pos } }, owesReply: steer });
  const word = kind === 'text' || kind === 'lead';
  const part = (owesReply: boolean): Part => {
    // A Stop settles an unfinished announcement and contributes no work of its own.
    if (kind === 'interrupt') return { segments: { first: { stopped: true, closer: true, last: pos } }, owesReply };
    if (kind === 'steer') return boundary(true);
    if (kind === 'notification' && !owesReply) return boundary(false);
    const closer = kind === 'text' || kind === 'visible' || kind === 'output' || kind === 'card';
    const first: Piece = { closer, last: pos, substantial: kind !== 'notice' && kind !== 'card' };
    if (owesReply && word) first.reply = pos;
    else if (kind === 'lead') first.lead = pos;
    else first.body = closer ? shown(pos) : work(pos, Number(kind === 'step'));
    return { segments: { first }, owesReply: owesReply && !word };
  };
  return [part(false), part(true)];
}

type Boundaries = Record<TurnState, Boundary>;
function boundaries(kind: Shape, pos: number): Boundaries {
  const after = (state: TurnState) => turnBoundary(state, kind === 'lead' ? 'text' : kind, pos);
  return { closed: after('closed'), quiet: after('quiet'), open: after('open'), cut: after('cut') };
}
function joinBoundaries(a: Boundaries, b: Boundaries): Boundaries {
  const after = (prev: Boundary) => {
    const next = b[prev.state];
    return next.pos === undefined ? { state: next.state, pos: prev.pos } : next;
  };
  return { closed: after(a.closed), quiet: after(a.quiet), open: after(a.open), cut: after(a.cut) };
}

// Kinds reach a lock screen. A malformed provider item must not put its tool name there.
const toolKinds = new Set<ToolKind>(['bash', 'read', 'edit', 'write', 'search', 'glob', 'fetch',
  'websearch', 'agent', 'todo', 'mcp', 'question', 'plan', 'skill', 'widget', 'browser', 'device', 'share', 'other']);

const sum = (a: number, b: number) => a + b;
function count(index: PositionIndex<number>, pos: number, delta: number) {
  const n = (index.range(pos, pos + 1) ?? 0) + delta;
  index.set(pos, n || undefined);
}
// A path counts in a suffix exactly when its newest occurrence is in the suffix.
class Paths {
  private paths = new Map<string, PositionIndex<number>>();
  private latest = new PositionIndex(sum);
  change(path: string, pos: number, delta: number) {
    const uses = this.paths.get(path) ?? new PositionIndex(sum);
    const before = uses.last;
    count(uses, pos, delta);
    if (uses.last === undefined) this.paths.delete(path);
    else this.paths.set(path, uses);
    if (before === uses.last) return;
    if (before !== undefined) count(this.latest, before, -1);
    if (uses.last !== undefined) count(this.latest, uses.last, 1);
  }
  since(pos: number) { return this.latest.range(pos) ?? 0; }
}

interface Entry {
  ts: number;
  pos: number;
  shape?: Shape;
  path?: string;
  paths?: Paths;
  doing?: TurnLive['doing'];
  running?: 'bash' | 'agent';
  changed?: readonly string[];
  owner?: number;
  ancestors?: string[];
  agent?: boolean;
  parent?: string;
}

/** Mutable index of this turn only. Runtime items mutate in place, so each entry
 * keeps its previous contributions separately from the provider's item. */
export class TurnLiveIndex {
  private entries = new Map<string, Entry>();
  /** Only settled edits whose file count depends on a particular ancestor. */
  private nestedEdits = new Map<string, Set<Entry>>();
  private order: Entry[] = [];
  private flow = new PositionIndex(join);
  private bounds = new PositionIndex(joinBoundaries);
  private reads = new Paths();
  private edits = new Paths();
  private files = new Paths();
  // A save can replace a step by its light row during the turn. Keep its paths
  // for corrections without keeping the full diff and its hunks alive.
  private diffPaths = new WeakMap<FileDiff[], readonly string[]>();
  private bash = new PositionIndex(sum);
  private agents = new PositionIndex(sum);

  has(id: string) { return this.entries.has(id); }

  /** A streamed word can turn a lead-in into a report. Once its shape is the
   * same there is nothing to update, even in an answer still receiving words. */
  textChanged(item: TimelineItem) {
    const entry = this.entries.get(item.id);
    if (!entry || item.parentId || shape(item) === entry.shape) return false;
    this.put(item);
    return true;
  }

  put(item: TimelineItem) {
    let e = this.entries.get(item.id);
    if (!e) {
      e = { ts: item.ts, pos: this.order.length };
      this.entries.set(item.id, e);
      this.order.push(e);
    }
    e.ts = item.ts;
    const { pos } = e;
    const k = item.parentId ? undefined : shape(item);
    if (k !== e.shape) {
      e.shape = k;
      this.bounds.set(pos, k && boundaries(k, pos));
      const part = k && k !== 'head' && k !== 'command' && k !== 'hidden' && k !== 'end';
      this.flow.set(pos, part ? atom(k, pos) : undefined);
    }
    const t = item.type === 'tool' && !item.check ? item : undefined;
    const parent = item.parentId;
    const agent = t?.kind === 'agent';
    const ancestryChanged = e.parent !== parent || !!e.agent !== agent;
    e.parent = parent;
    e.agent = agent;
    const diff = t?.status === 'done' && (t.kind === 'edit' || t.kind === 'write') ? t.result?.diff : undefined;
    let changed = diff && this.diffPaths.get(diff);
    if (diff && !changed) this.diffPaths.set(diff, changed = diff.map(d => d.path));
    if (changed !== e.changed || ancestryChanged) this.trackFiles(e, changed);
    if (ancestryChanged) for (const edit of this.nestedEdits.get(item.id) ?? []) this.trackFiles(edit, edit.changed);

    let paths: Paths | undefined;
    if (!parent && t?.kind === 'read') paths = this.reads;
    if (!parent && (t?.kind === 'edit' || t?.kind === 'write')) paths = this.edits;
    const path = paths && typeof t?.detail?.path === 'string' ? t.detail.path.trim() : undefined;
    if (e.paths !== paths || e.path !== path) {
      if (e.path) e.paths?.change(e.path, pos, -1);
      if (path) paths?.change(path, pos, 1);
      e.path = path;
      e.paths = paths;
    }
    const active = !parent && t && (t.status === 'pending' || t.status === 'running' || t.status === 'awaiting');
    e.doing = 'other';
    if (active && toolKinds.has(t.kind)) e.doing = t.kind;
    if (active && t.status === 'awaiting') e.doing = 'waiting';
    if (item.type === 'text' && item.streaming) e.doing = 'writing';
    if (item.type === 'thinking' && item.streaming) e.doing = 'thinking';
    // An awaiting call is still one of the commands/agents in flight.
    const running = active && (t.kind === 'bash' || t.kind === 'agent') ? t.kind : undefined;
    if (e.running !== running) {
      if (e.running === 'bash' || running === 'bash') this.bash.set(pos, running === 'bash' ? 1 : undefined);
      if (e.running === 'agent' || running === 'agent') this.agents.set(pos, running === 'agent' ? 1 : undefined);
      e.running = running;
    }
  }

  private trackFiles(e: Entry, changed: readonly string[] | undefined) {
    if (!changed && !e.changed) return;
    const ancestors: string[] = [];
    let ancestor: Entry | undefined = e;
    // The Changes view descends through at most four agents. Remember even a
    // missing parent: a later arrival or reclassification can make the edit count.
    while (changed?.length && ancestor?.parent && ancestors.length < 4) {
      ancestors.push(ancestor.parent);
      ancestor = this.entries.get(ancestor.parent);
      if (!ancestor?.agent) { ancestor = undefined; break; }
    }
    for (const id of e.ancestors ?? []) {
      if (ancestors.includes(id)) continue;
      const edits = this.nestedEdits.get(id);
      edits?.delete(e);
      if (!edits?.size) this.nestedEdits.delete(id);
    }
    for (const id of ancestors) {
      if (e.ancestors?.includes(id)) continue;
      let edits = this.nestedEdits.get(id);
      if (!edits) this.nestedEdits.set(id, edits = new Set());
      edits.add(e);
    }
    e.ancestors = ancestors;
    const owner = changed?.length && ancestor && !ancestor.parent ? ancestor.pos : undefined;
    if (changed === e.changed && owner === e.owner) return;
    if (e.owner !== undefined) for (const path of e.changed ?? []) this.files.change(path, e.owner, -1);
    if (owner !== undefined) for (const path of changed ?? []) this.files.change(path, owner, 1);
    e.changed = changed;
    e.owner = owner;
  }

  remove(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    // Remove all contributions via the same replacement path as a provider patch.
    this.put({ type: 'text', id, ts: e.ts, text: '', streaming: false });
    this.entries.delete(id);
  }

  read(fallback?: number, waiting = false): TurnLive | undefined {
    const boundary = this.bounds.all?.closed;
    if (boundary?.state === 'cut' || (boundary?.state === 'closed' && boundary.pos !== undefined)) return;
    const start = boundary?.pos;
    const stamp = start === undefined ? undefined : this.order[start].ts;
    const startedAt = stamp !== undefined && Number.isFinite(stamp) ? stamp : fallback;
    if (startedAt === undefined || !Number.isFinite(startedAt)) return;
    // A notification opening a turn is its head. Inside one it opens a segment.
    const fromWork = start === undefined ? this.order.length
      : this.order[start].shape === 'notification' ? start + 1 : start;
    // Only immediate words answer the opening message. Read past empty/queued rows
    // and checks without walking the turn or consuming a later lead-in after work.
    const first = start !== undefined && this.order[start].shape === 'head' ? this.flow.firstFrom(fromWork) : undefined;
    let range: Range | undefined;
    if (first !== undefined && this.order[first].shape === 'lead') {
      const reply = atom('text', first);
      const rest = this.flow.range(first + 1);
      range = rest ? join(reply, rest) : reply;
    } else range = this.flow.range(fromWork);
    const seg = range?.[0].segments;
    const total = seg ? runs(runs(finish(seg.first), seg.middle ?? empty), seg.last ? finish(seg.last) : empty) : empty;
    const active = total.active;
    const checkpointAt = active ? this.order[active.at].ts : undefined;
    const last = this.flow.last;
    const newest = last !== undefined && last >= fromWork ? this.order[last].doing : undefined;
    const doing = waiting ? 'waiting' : newest ?? 'other';
    const open = active?.open;
    let doingCount: number | undefined;
    if (open !== undefined) {
      if (doing === 'read') doingCount = this.reads.since(open);
      if (doing === 'edit' || doing === 'write') doingCount = this.edits.since(open);
      if (doing === 'bash') doingCount = this.bash.range(open) ?? 0;
      if (doing === 'agent') doingCount = this.agents.range(open) ?? 0;
    }
    return {
      startedAt,
      steps: total.steps, checkpoints: total.runs - Number(open !== undefined),
      checkpointSteps: active?.openSteps ?? 0, ...(Number.isFinite(checkpointAt) && { checkpointAt }),
      files: this.files.since(fromWork), doing, ...(doingCount !== undefined && { doingCount: Math.max(1, doingCount) }),
    };
  }
}

/** Read the running turn from timeline items in order (including nested edits), or
 * its already indexed items. Without an opener/act or an explicit start, no reading. */
export function turnLive(items: Iterable<TimelineItem> | TurnLiveIndex, startedAt?: number, waiting = false): TurnLive | undefined {
  if (items instanceof TurnLiveIndex) return items.read(startedAt, waiting);
  const index = new TurnLiveIndex();
  for (const item of items) index.put(item);
  return index.read(startedAt, waiting);
}
