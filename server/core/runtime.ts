import { randomUUID } from 'node:crypto';
import type {
  BridgeEvent,
  BrowserAnswer,
  BrowserRequest,
  Capabilities,
  NoticeItem,
  PendingPrompts,
  PermissionRequest,
  Question,
  QueuedMessage,
  QuestionRequest,
  SessionMeta,
  SessionSnapshot,
  TimelineItem,
  Todo,
  ToolItem,
  UserItem,
} from '../../shared/protocol';
import type { ProviderSession } from '../providers/types';
import { userText } from '../../shared/synthetic';
import { runsTask, worksInBackground } from '../../shared/background';
import { approvedShare, handOver, type ApprovedShare } from './handed';

export type Emit = (event: BridgeEvent) => void;

/** How long a weak browser answer ("not here") waits for a window that can serve the request. */
export const BROWSER_GRACE_MS = 800;

export interface PermissionAnswer {
  optionId: string;
  message?: string;
}

/** What one of the person's messages came to, by the agent's result for it. */
export type MessageOutcome = 'ok' | 'failed' | 'stopped';

/** A plan limit met outside the chat's own turn (`SessionRuntime.limitInBackground`). */
export interface BackgroundLimit {
  /** The background step whose request it refused; none when it was the agent's own. */
  stepId?: string;
  /** Which window, as the limit rows name it, and when it resets, when known. */
  window?: string;
  resetsAt?: number;
  /** The agent's own words for it. */
  detail?: string;
}

type NewItem<T extends TimelineItem> = T extends TimelineItem ? Omit<T, 'id' | 'ts'> & { id?: string; ts?: number } : never;


export { runsTask, worksInBackground };

/** Why a background command was lost: its process ended or was let go, Sable restarted, the chat moved, a limit. */
export type LostWhy = 'process' | 'restart' | 'move' | 'limit';

/** How a cut turn is said under its "Ended early" line (`cutTurn`), by what cut it. */
const CUT_DETAIL: Record<'died' | 'closed' | 'restart', string> = {
  died: "The agent's process ended by itself while it worked.",
  closed: "Sable closed the agent's process while it worked.",
  restart: 'Sable closed while the agent worked.',
};

/**
 * The line that tells the person, at rest, that background commands were lost with their process
 * (`SessionRuntime.tasksLost` gives the names for its detail). Never "ended": a child of the agent's
 * shell can outlive it.
 */
export function lostLine(count: number, why: LostWhy): string {
  const what = count === 1 ? '1 background command was' : `${count} background commands were`;
  return why === 'move' ? `${what} lost when the chat moved` : why === 'restart' ? `${what} lost when Sable closed` : `${what} lost with the agent's process`;
}

/** At most this many lost tasks are named to the agent at once, each cut to `TASK_NAME_MAX` characters. */
const LOST_NAMES_MAX = 12;
const TASK_NAME_MAX = 90;
/** Lost tasks kept for the agent's next message: a chat that loses more before it is told keeps the newest. */
const LOST_KEPT = 64;

/** A task step's name as the person knows it: what the agent said it does, else the step's label. */
function taskName(i: ToolItem): string {
  const name = (i.detail?.description || i.title || i.name || 'Background command').replace(/\s+/g, ' ').trim();
  return name.length > TASK_NAME_MAX ? `${name.slice(0, TASK_NAME_MAX - 1).trimEnd()}…` : name;
}

/** The step with its sub-agent or workflow marked stopped (their process is gone), or the step itself when nothing of it runs. */
export function stoppedBackground(i: TimelineItem): TimelineItem {
  if (i.type !== 'tool') return i;
  let out = i;
  if (i.result?.agent?.background === 'running') out = { ...out, result: { ...i.result, agent: { ...i.result.agent, background: 'stopped' } } };
  if (i.workflow?.status === 'running') out = { ...out, workflow: { ...i.workflow, status: 'stopped' } };
  return out;
}

/**
 * One open session: metadata, the normalized timeline and any prompt waiting on the
 * user. Provider adapters write to it; every mutation is broadcast to the UI.
 */
export class SessionRuntime {
  items: TimelineItem[] = [];
  caps?: Capabilities;
  todos: Todo[] = [];
  suggestion?: string;
  handle?: ProviderSession;
  turnActive = false;
  turnStartedAt = 0;
  /**
   * A mode that never asks was chosen from a phone while work ran (a turn, background agents): what
   * that work asks still waits as before (the phone could not be shown it), and the mode answers at
   * once only from the person's next message on (`App.applyDue` lifts it; review wave 7, #1).
   */
  dangerHeld = false;
  /** The mode before the held switch: what the work in progress still runs under (`workMode`). */
  heldMode?: string;
  /**
   * The mode the agent's work runs under now. `meta.mode` is the one chosen (shown, and taken with the
   * next message); while a phone's switch to a mode that never asks is held it is the mode before it.
   * Every place that decides what work may do reads this: a permission answered by the adapter, a
   * thread or process (re)opened mid-turn, a sub-agent started by the running turn (review wave 8, #5).
   */
  get workMode(): string {
    return this.dangerHeld && this.heldMode !== undefined ? this.heldMode : this.meta.mode;
  }
  /** The mode answers asks at once now (`danger`: the mode is one that never asks). */
  answersAtOnce(danger: boolean): boolean {
    return danger && !this.dangerHeld;
  }
  /** Messages sent while a turn was running; the app sends them as turns end. */
  queue: QueuedMessage[] = [];
  /**
   * The user stopped the current turn (interrupt or close): its end sends nothing from the queue, and
   * that hold stays until a turn begins for the person (a turn the agent begins by itself carries it:
   * `beginTurn` with `keepHold`).
   */
  get stopRequested() {
    return this.stopped;
  }
  set stopRequested(v: boolean) {
    this.stopped = v;
    this.carried = false;
  }
  private stopped = false;
  /** The running turn carries a stop's hold it did not make (the agent began it by itself): the person's next message lifts it (`personSent`). */
  private carried = false;
  /**
   * Called after every turn end; `error` is set when the turn failed. `hold`: the agent could not say
   * how the turn ended (it went idle without its end), so nothing queued goes out by itself.
   */
  onTurnEnd?: (rt: SessionRuntime, error?: string, opts?: { hold?: boolean }) => void;
  /** Called as a turn begins (an until loop's check in flight gives way to it). */
  onTurnStart?: (rt: SessionRuntime) => void;
  /** A plan limit refused work of the chat outside its own turn (a background agent's request, or the agent's own): the bridge decides (`limitInBackground`). */
  onBackgroundLimit?: (rt: SessionRuntime, hit: BackgroundLimit) => void;
  /** The last background work ended with no turn running: the chat is at rest. */
  onRest?: (rt: SessionRuntime) => void;
  /** The limit notice the bridge wrote when work outside a turn met a limit: a turn refused at it says it there (one notice). */
  limitCard?: string;

  private index = new Map<string, TimelineItem>();
  /** `share`: for a share's permission, the files as it showed them (core/handed.ts `approvedShare`). */
  private permissions = new Map<string, { request: PermissionRequest; resolve: (a: PermissionAnswer | null) => void; share?: ApprovedShare }>();
  private questions = new Map<string, { request: QuestionRequest; resolve: (a: Record<string, string[]> | null) => void }>();
  /** Spans in which a prompt waited for the user ([start, end] ms), and the start of the open one. */
  private waits: [number, number][] = [];
  private waitSince?: number;

  constructor(
    public meta: SessionMeta,
    private emit: Emit,
    private onDirty: (rt: SessionRuntime, what: 'meta' | 'items') => void,
  ) {}

  get id() {
    return this.meta.id;
  }

  // ── timeline ──

  /**
   * Items changed or added since the store last saved them, or 'all' when it cannot tell (a fresh
   * load, a reset): the store writes a long chat's unchanged start only when it has to
   * (core/session-file.ts). Everything that changes an item goes through this class.
   */
  private dirty: Set<string> | 'all' = 'all';

  /** What changed since the last call (the store's save takes it). */
  takeDirty(): Set<string> | 'all' {
    const d = this.dirty;
    this.dirty = new Set();
    return d;
  }

  /** The items are as on disk (just read from it). */
  markSaved() {
    this.dirty = new Set();
  }

  private markDirty(id: string) {
    if (this.dirty !== 'all') this.dirty.add(id);
  }

  /**
   * As `load`, for a chat read from disk after a restart: no agent process carries anything from before,
   * so sub-agents and workflows still marked running are stopped first and the count starts at 0, with
   * nothing announced on the way (review wave 7, #4). A background command still marked running was
   * lost with that process (`lost`, why `restart`): the agent is told with its next message
   * (`takeLost`), and their names as the person knows them are returned, for the line that tells
   * them (`lostLine`, the caller's to write). The steps it changed go with the next save.
   */
  loadRestored(items: TimelineItem[], todos: Todo[] = [], queue?: QueuedMessage[]): string[] {
    const changed: string[] = [];
    const lost: string[] = [];
    const names: string[] = [];
    const out = items.map((i) => {
      let s = stoppedBackground(i);
      if (runsTask(s)) {
        names.push(taskName(s));
        s = { ...s, task: { ...s.task, state: 'lost', why: 'restart' } };
        lost.push(i.id);
      }
      if (s !== i) changed.push(i.id);
      return s;
    });
    this.load(out, todos, queue);
    this.markSaved();
    for (const id of changed) this.markDirty(id);
    for (const id of lost) this.keepLost(id);
    return names;
  }

  load(items: TimelineItem[], todos: Todo[] = [], queue?: QueuedMessage[]) {
    this.dirty = 'all';
    this.items = items;
    this.todos = todos;
    if (queue) this.queue = queue;
    this.index = new Map(items.map((i) => [i.id, i]));
    this.working.clear();
    this.running.clear();
    this.taskSteps.clear();
    for (const i of items) {
      if (worksInBackground(i)) this.working.add(i.id);
      if (i.type === 'tool' && i.task) this.taskSteps.set(i.task.id, i.id);
      if (runsTask(i)) this.running.add(i.id);
    }
    // As read: whoever loads gets the whole chat next (a snapshot), so nothing is announced here.
    this.meta.background = this.working.size;
    this.meta.commands = this.running.size;
  }

  // ── background work ──

  /** Steps whose sub-agent or workflow still works in the background (`SessionMeta.background` is their count). */
  private working = new Set<string>();
  /** Steps whose background command or monitor still runs (`SessionMeta.commands` is their count). */
  private running = new Set<string>();
  /** The step of each task the chat has seen, by the agent's own task id. */
  private taskSteps = new Map<string, string>();

  /**
   * A step was added or changed: the chat's counts of background work follow it. At rest (`onRest`)
   * when the last sub-agent or workflow ends, as before, or the last command when no sub-agent works
   * either, with no turn running; a command still running then is the bridge's to weigh (a move waits
   * only for a young one).
   */
  private trackBackground(item: TimelineItem) {
    if (item.type === 'tool' && item.task) this.taskSteps.set(item.task.id, item.id);
    const works = worksInBackground(item);
    const runs = runsTask(item);
    const patch: Partial<SessionMeta> = {};
    let agentsDone = false;
    let commandsDone = false;
    if (works !== this.working.has(item.id)) {
      if (works) this.working.add(item.id);
      else {
        this.working.delete(item.id);
        agentsDone = !this.working.size;
      }
      patch.background = this.working.size;
    }
    if (runs !== this.running.has(item.id)) {
      if (runs) this.running.add(item.id);
      else {
        this.running.delete(item.id);
        commandsDone = !this.running.size;
      }
      patch.commands = this.running.size;
    }
    if (!('background' in patch) && !('commands' in patch)) return;
    this.update(patch);
    if (!this.turnActive && !this.working.size && (agentsDone || commandsDone)) this.onRest?.(this);
  }

  /** When the youngest background command or monitor still running began; undefined when none runs. */
  get newestCommandAt(): number | undefined {
    let at: number | undefined;
    for (const id of this.running) {
      const i = this.index.get(id);
      if (runsTask(i)) at = Math.max(at ?? 0, i.task.since);
    }
    return at;
  }

  /**
   * A step left work running in the agent's process (a background command, a monitor). Sets `task`
   * (state running, since now) and counts it. Said again for the same task, or after its end came
   * first, it changes nothing.
   */
  taskStarted(itemId: string, mark: { id: string; kind: 'command' | 'monitor' }) {
    const item = this.index.get(itemId);
    if (item?.type !== 'tool' || item.task?.id === mark.id) return;
    // A task already known by another step stays with it (the first word of it named its step).
    const known = this.taskSteps.get(mark.id);
    if (known && known !== itemId && this.index.has(known)) return;
    if (item.task && this.taskSteps.get(item.task.id) === itemId) this.taskSteps.delete(item.task.id);
    this.taskSteps.set(mark.id, itemId);
    this.patch<ToolItem>(itemId, { task: { id: mark.id, kind: mark.kind, state: 'running', since: Date.now() } });
  }

  /**
   * Word of a task's end, by the agent's task id. Unknown ids are ignored, and so is a second end. A
   * task already marked `lost` takes its real end when word of it comes after all (a resumed process
   * may report what its predecessor left), and is no longer named to the agent as lost.
   */
  taskEnded(taskId: string, state: 'done' | 'failed' | 'stopped', at?: number) {
    const id = this.taskSteps.get(taskId);
    const item = id ? this.index.get(id) : undefined;
    if (item?.type !== 'tool' || item.task?.id !== taskId) return;
    const t = item.task;
    if (t.state !== 'running' && t.state !== 'lost') return;
    this.lost.delete(item.id);
    this.patch<ToolItem>(item.id, { task: { id: t.id, kind: t.kind, state, since: t.since, endedAt: Math.max(at ?? Date.now(), t.since) } });
  }

  /** Task steps lost since the agent was last told (`takeLost`), oldest first. */
  private lost = new Set<string>();

  private keepLost(id: string) {
    this.lost.delete(id);
    this.lost.add(id);
    if (this.lost.size > LOST_KEPT) this.lost.delete(this.lost.values().next().value as string);
  }

  /**
   * The process is gone: every running task becomes `lost` (with `why`, and no end: when or whether it
   * ended is not known). Returns their names as the person knows them, for the notice that tells
   * them (`lostLine`), and keeps them for `takeLost`.
   */
  tasksLost(why: LostWhy): string[] {
    const names: string[] = [];
    const ids = this.items.filter((i) => this.running.has(i.id)).map((i) => i.id);
    for (const id of ids) {
      const item = this.index.get(id);
      if (!runsTask(item)) continue;
      names.push(taskName(item));
      this.keepLost(id);
      this.patch<ToolItem>(id, { task: { ...item.task, state: 'lost', why } });
    }
    return names;
  }

  /**
   * The tasks lost since the last call, as the agent knows them (`"Run app tests" (command, task
   * b1x2)`; at most 12, then "N more"), for the hidden note its next message carries
   * (shared/synthetic.ts `lostTasksNote`). Empties the list; a task whose end was heard since is left
   * out. Take it only with a message the agent accepted.
   */
  takeLost(): string[] {
    const out: string[] = [];
    let more = 0;
    for (const id of this.lost) {
      const item = this.index.get(id);
      if (item?.type !== 'tool' || item.task?.state !== 'lost') continue;
      if (out.length >= LOST_NAMES_MAX) {
        more++;
        continue;
      }
      out.push(`"${taskName(item).replace(/"/g, "'")}" (${item.task.kind}, task ${item.task.id})`);
    }
    if (more) out.push(`${more} more`);
    this.lost.clear();
    return out;
  }

  /**
   * A plan limit refused work outside the chat's own turn. `stepId`: the background sub-agent or
   * workflow whose request it was (its own step or one under it): it works no more, and says why
   * ("Stopped · 5-hour limit reached"). The bridge hears of every refusal and decides once.
   */
  limitInBackground(hit: BackgroundLimit) {
    const step = hit.stepId ? this.backgroundStepOf(hit.stepId) : undefined;
    if (step) this.stopAtLimit((i) => i.id === step.id, hit);
    else if (hit.stepId && this.get(hit.stepId)?.type === 'tool') this.limitStopped.add(hit.stepId);
    this.onBackgroundLimit?.(this, { ...hit, ...(step ? { stepId: step.id } : {}) });
  }

  /** Steps a plan limit stopped since the chat last carried on (the bridge names them to the agent, `takeLimitStopped`). */
  private limitStopped = new Set<string>();

  /** Steps whose stop was not confirmed after all: never named to the agent as stopped. */
  forgetLimitStopped(ids: Iterable<string>) {
    for (const id of ids) this.limitStopped.delete(id);
  }

  /** The steps a plan limit stopped since the last call. */
  takeLimitStopped(): Set<string> {
    const out = this.limitStopped;
    this.limitStopped = new Set();
    return out;
  }

  /** The background step a step belongs to: itself or the nearest of its parents that works in the background. */
  private backgroundStepOf(id: string): ToolItem | undefined {
    for (let i = this.get(id), n = 0; i && n < 32; i = i.parentId ? this.get(i.parentId) : undefined, n++) if (worksInBackground(i)) return i as ToolItem;
    return undefined;
  }

  /** Background steps (`only`, else every one) stopped by a plan limit: stopped, with the window that refused them. */
  stopAtLimit(only: ((item: TimelineItem) => boolean) | undefined, limit: { window?: string; resetsAt?: number }): string[] {
    const marked: string[] = [];
    for (const item of this.items) {
      if (!worksInBackground(item) || (only && !only(item))) continue;
      const stopped = stoppedBackground(item) as ToolItem;
      const window = limit.window ?? 'Plan limit';
      const agent = { ...stopped.result?.agent, limit: { window, ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}) } };
      this.limitStopped.add(item.id);
      marked.push(item.id);
      this.patch<ToolItem>(item.id, { result: { ...stopped.result, agent }, ...(stopped.workflow !== (item as ToolItem).workflow ? { workflow: stopped.workflow } : {}) });
    }
    return marked;
  }

  // ── queue ──

  private queueChanged() {
    this.emit({ type: 'queue.updated', sessionId: this.id, queue: this.queue.map((q) => ({ ...q })) });
    this.onDirty(this, 'items');
  }

  enqueue(text: string, attachments?: QueuedMessage['attachments']): QueuedMessage {
    // Nothing without words goes in (a page of the queue reads each one's).
    if (typeof text !== 'string') throw new Error('A message needs its words.');
    const q: QueuedMessage = { id: randomUUID(), text, attachments: attachments?.length ? attachments : undefined, createdAt: Date.now() };
    this.queue.push(q);
    this.queueChanged();
    return q;
  }

  /**
   * New text, and new attachments when given (empty clears them). Left empty, the message goes. A
   * change is a new object with a new revision; a message a phone is taking back is not changed
   * (`reserveQueued`).
   */
  updateQueued(id: string, text: string, attachments?: QueuedMessage['attachments']) {
    const at = this.queue.findIndex((x) => x.id === id);
    if (at < 0 || this.reserved.has(id)) return false;
    const q = this.queue[at];
    const files = attachments === undefined ? q.attachments : attachments.length ? attachments : undefined;
    if (!text.trim() && !files?.length) {
      this.queue.splice(at, 1);
    } else {
      this.queue[at] = { ...q, text, attachments: files };
    }
    this.queueRev.set(id, (this.queueRev.get(id) ?? 0) + 1);
    this.queueChanged();
    return true;
  }

  // A queued message a phone takes back to edit (phone.ts): it stays in its place while the phone's
  // reply goes, neither edited nor sent, then the take commits (it leaves the queue) or rolls back
  // (it is exactly where and as it was, its scheduling untouched). A queue that would have sent it
  // meanwhile goes on once it is released (`onQueueReleased`).

  /** Messages reserved by a take, with their revision then. */
  private reserved = new Map<string, number>();
  /** Each queued message's revision (one more with every change). */
  private queueRev = new Map<string, number>();
  /** A reservation ended (committed or rolled back): what waited for it may go now. */
  onQueueReleased?: (rt: SessionRuntime) => void;

  /** Reserves a queued message for a take: a copy of it as it is and its revision, or undefined (not there, or already reserved). */
  reserveQueued(id: string): { message: QueuedMessage; rev: number } | undefined {
    const q = this.queue.find((x) => x.id === id);
    if (!q || this.reserved.has(id)) return undefined;
    const rev = this.queueRev.get(id) ?? 0;
    this.reserved.set(id, rev);
    return { message: { ...q, ...(q.attachments ? { attachments: q.attachments.map((a) => ({ ...a })) } : {}) }, rev };
  }

  isReserved(id: string | undefined): boolean {
    return !!id && this.reserved.has(id);
  }

  /** The take went through: the message leaves the queue, if it is still that revision. */
  commitReserved(id: string, rev: number): QueuedMessage | undefined {
    const had = this.reserved.get(id);
    if (had === undefined) return undefined;
    this.reserved.delete(id);
    const at = this.queue.findIndex((x) => x.id === id);
    const out = at >= 0 && had === rev && (this.queueRev.get(id) ?? 0) === rev ? this.queue.splice(at, 1)[0] : undefined;
    if (out) {
      this.queueRev.delete(id);
      this.queueChanged();
    }
    this.onQueueReleased?.(this);
    return out;
  }

  /** The take did not go through: the message stays as and where it is. */
  rollbackReserved(id: string) {
    if (!this.reserved.delete(id)) return;
    this.onQueueReleased?.(this);
  }

  /** `ids` first in that order; messages not named keep their relative order after them. */
  reorderQueued(ids: string[]) {
    const byId = new Map(this.queue.map((q) => [q.id, q]));
    const seen = new Set<string>();
    const front: QueuedMessage[] = [];
    for (const id of ids) {
      const q = byId.get(id);
      if (q && !seen.has(id)) {
        seen.add(id);
        front.push(q);
      }
    }
    const next = [...front, ...this.queue.filter((q) => !seen.has(q.id))];
    if (next.every((q, i) => q === this.queue[i])) return false;
    this.queue = next;
    this.queueChanged();
    return true;
  }

  /** Puts messages back at the front of the queue (steered messages the agent never took). */
  requeue(messages: QueuedMessage[]) {
    if (!messages.length) return;
    this.queue.unshift(...messages.map((m) => ({ ...m, attachments: m.attachments?.length ? m.attachments : undefined })));
    this.queueChanged();
  }

  /**
   * Messages in the timeline no agent took (steered into a turn that ended first; with `all`, any
   * left waiting, as after a restart) go back to the front of the queue in the order they were
   * sent, so none is lost. With `reason`, one quiet line in the timeline says so. Returns how many.
   */
  returnUntaken(opts: { all?: boolean; reason?: 'stopped' | 'failed' | 'closed' } = {}): number {
    const untaken = this.items.filter((i): i is UserItem => i.type === 'user' && !i.parentId && i.state === 'queued' && (opts.all || !!i.steered));
    if (!untaken.length) return 0;
    for (const u of untaken) this.remove(u.id);
    this.requeue(untaken.map((u) => ({ id: u.id, text: u.text, attachments: u.attachments, createdAt: u.ts })));
    if (opts.reason) {
      const one = untaken.length === 1;
      const it = one ? 'it' : 'them';
      const why = opts.reason === 'closed' ? `Sable closed before the agent took ${it}.` : opts.reason === 'failed' ? `The turn failed before the agent took ${it}.` : `The turn stopped before the agent took ${it}.`;
      this.notice('info', one ? 'Your message is back in the queue' : `${untaken.length} messages are back in the queue`, why);
    }
    return untaken.length;
  }

  /** Takes a message out of the queue (the first one without an id); never one a phone is taking back. */
  takeQueued(id?: string): QueuedMessage | undefined {
    const at = id ? this.queue.findIndex((x) => x.id === id) : this.queue.length ? 0 : -1;
    if (at < 0 || this.reserved.has(this.queue[at].id)) return undefined;
    const [q] = this.queue.splice(at, 1);
    this.queueRev.delete(q.id);
    this.queueChanged();
    return q;
  }

  add<T extends TimelineItem>(item: NewItem<T>): T {
    const full = { ...item, id: item.id ?? randomUUID(), ts: item.ts ?? Date.now() } as unknown as T;
    if (full.type === 'tool' && full.kind === 'share' && full.status === 'done' && !full.handed) full.handed = this.hand(full);
    this.items.push(full);
    this.index.set(full.id, full);
    this.markDirty(full.id);
    // Emit a copy: the live object keeps mutating as deltas arrive.
    this.emit({ type: 'item.added', sessionId: this.id, item: { ...full } });
    this.onDirty(this, 'items');
    this.trackBackground(full);
    return full;
  }

  get<T extends TimelineItem = TimelineItem>(id: string): T | undefined {
    return this.index.get(id) as T | undefined;
  }

  delta(id: string, field: 'text' | 'inputText' | 'output', delta: string) {
    const item = this.index.get(id) as Record<string, unknown> | undefined;
    if (!item || !delta) return;
    item[field] = ((item[field] as string | undefined) ?? '') + delta;
    this.markDirty(id);
    this.emit({ type: 'item.delta', sessionId: this.id, id, field, delta });
    this.onDirty(this, 'items');
  }

  patch<T extends TimelineItem>(id: string, patch: Partial<T>) {
    const item = this.index.get(id);
    if (!item) return;
    // A step that ends: the time it spent waiting for the user does not count as its own.
    const endedAt = (patch as Partial<ToolItem>).endedAt;
    if (item.type === 'tool' && endedAt && !('waitedMs' in patch)) {
      const waited = this.waitedBetween(item.ts, endedAt);
      if (waited > 0) patch = { ...patch, waitedMs: waited };
    }
    // A share that goes through now: the files as they are at this moment are what it handed over.
    if (item.type === 'tool' && item.kind === 'share' && (patch as Partial<ToolItem>).status === 'done' && item.status !== 'done' && !item.handed) {
      patch = { ...patch, handed: this.hand({ ...item, ...(patch as Partial<ToolItem>) }) };
    }
    Object.assign(item, patch);
    this.markDirty(id);
    this.emit({ type: 'item.patch', sessionId: this.id, id, patch: patch as Partial<TimelineItem> });
    this.onDirty(this, 'items');
    this.trackBackground(item);
  }

  /** Share steps the person allowed themselves (a permission they answered with an allow), by item id: the files as they were shown. */
  private allowedShares = new Map<string, ApprovedShare>();

  /** Share steps whose digests are still being read (core/handed.ts `handOver`), by item id: settled once they are recorded. */
  private handings = new Map<string, Promise<void>>();

  /**
   * What share step `item` hands over, captured as it goes through (core/handed.ts): outside the
   * folder, only what the person was shown. The records go on the step at once; each file's digest
   * is read after, through the handle opened here, and lands as a patch of its own (saved with the
   * session), unless the step was rewound, removed or recorded anew meanwhile.
   */
  private hand(item: ToolItem) {
    const approved = this.allowedShares.get(item.id);
    this.allowedShares.delete(item.id);
    const { handed, digests } = handOver(this.meta.cwd, item.detail?.files, approved);
    if (digests) {
      const id = item.id;
      const done = digests
        .then((next) => {
          const now = this.index.get(id);
          if (now?.type === 'tool' && now.handed === handed) this.patch<ToolItem>(id, { handed: next });
        })
        .catch(() => {})
        .finally(() => {
          if (this.handings.get(id) === done) this.handings.delete(id);
        });
      this.handings.set(id, done);
    }
    return handed;
  }

  /**
   * Settles once the digests of share step `itemId` are recorded on it (`handed[i].sha256` or
   * `unhashed`); undefined when none are being read (recorded already, or never captured here).
   */
  handing(itemId: string): Promise<void> | undefined {
    return this.handings.get(itemId);
  }

  /**
   * What each message of the person's came to, as its agent reported it (Claude Code: one result per
   * message, so one turn can answer one message failed and the next ok). Only one answered `ok` may
   * name a chat; a message with no word of its own goes by its turn's end. `pending`: handed to an
   * agent that reports per message (`expectOutcome`), with no word yet. Every one is kept, however
   * many a turn answers, until the bridge has looked at the turn's end (`forgetOutcomes`).
   */
  private outcomes = new Map<string, MessageOutcome | 'pending'>();
  /**
   * The result that answered each such message: its TurnItem's id, or null when none of its own did
   * (it came to its turn's end), so which texts were its answer is not known (core/titles.ts).
   */
  private answers = new Map<string, string | null>();

  /** Message `itemId` goes to an agent that says what each message came to: until it does, it came to nothing (never ok by default). */
  expectOutcome(itemId: string) {
    this.outcomes.set(itemId, 'pending');
  }

  /** `resultId`: the TurnItem of the result that answered them (absent: none of their own). */
  answered(itemIds: readonly string[], outcome: MessageOutcome, resultId?: string) {
    for (const id of itemIds) {
      this.outcomes.set(id, outcome);
      this.answers.set(id, resultId ?? null);
    }
  }

  /** The TurnItem of the result that answered message `itemId`; null: answered by none of its own; undefined: its agent says nothing per message. */
  answeredBy(itemId: string): string | null | undefined {
    return this.answers.get(itemId);
  }

  outcomeOf(itemId: string): MessageOutcome | 'pending' | undefined {
    return this.outcomes.get(itemId);
  }

  /**
   * Whether message `itemId` went ok as far as its agent said: one handed to an agent that reports per
   * message needs that agent's own word (a missing one is no success); one of an agent that says
   * nothing per message goes by its turn's end.
   */
  answeredOk(itemId: string): boolean {
    const o = this.outcomes.get(itemId);
    return o === undefined || o === 'ok';
  }

  /** The bridge has looked at a turn's end: every record goes but those of `keep` (messages still to be taken, or still to be named from). */
  forgetOutcomes(keep: readonly string[] = []) {
    const kept = new Set(keep);
    for (const id of [...this.outcomes.keys()]) if (!kept.has(id)) this.outcomes.delete(id);
    for (const id of [...this.answers.keys()]) if (!kept.has(id)) this.answers.delete(id);
  }

  /**
   * Marks a message the agent has taken: it stands where the agent took it. A queued one moves down
   * to here; so does a steered one when the agent wrote something after it was sent and before it
   * had it (a note, another step): that stays above the message, and the first words under the
   * message are the reply to it, never a line written without having read it. A steered message
   * keeps the time it was sent.
   */
  taken(id: string, patch: Partial<UserItem> = {}) {
    const item = this.index.get(id);
    if (item?.type !== 'user') return;
    if (item.state !== 'queued') this.patch<UserItem>(id, { state: 'sent', ...patch });
    else this.move(id, { state: 'sent', ...patch } as Partial<TimelineItem>, !!item.steered);
  }

  /** Moves a root item to the end of the timeline (a message once the agent takes it); `keepTime`: its time stays. */
  move(id: string, patch: Partial<TimelineItem> = {}, keepTime = false) {
    const item = this.index.get(id);
    if (!item) return;
    const at = this.items.indexOf(item);
    // Only its own children after it (none for a message): it is already the last thing said.
    const last = at >= 0 && this.items.slice(at + 1).every((i) => !!i.parentId);
    if (at < 0 || last || item.parentId) {
      this.patch(id, patch);
      return;
    }
    Object.assign(item, patch, keepTime ? {} : { ts: Date.now() });
    this.markDirty(id);
    this.items.splice(at, 1);
    this.items.push(item);
    // One move, said as the two events every reader knows; the marks let the window make it one update.
    this.emit({ type: 'item.removed', sessionId: this.id, id, moving: true });
    this.emit({ type: 'item.added', sessionId: this.id, item: { ...item }, moved: true });
    this.onDirty(this, 'items');
  }

  /** Removes an item and every item nested under it (children of a tool or agent, and theirs). */
  remove(id: string) {
    if (!this.index.has(id)) return;
    const gone = new Set([id]);
    // Items are appended after their parent, but walk until stable so order never matters.
    for (let grew = true; grew; ) {
      grew = false;
      for (const i of this.items) {
        if (i.parentId && gone.has(i.parentId) && !gone.has(i.id)) {
          gone.add(i.id);
          grew = true;
        }
      }
    }
    for (const g of gone) this.index.delete(g);
    this.items = this.items.filter((i) => !gone.has(i.id));
    // One event for the root: clients drop its descendants themselves.
    this.emit({ type: 'item.removed', sessionId: this.id, id });
    this.onDirty(this, 'items');
    let had = false;
    let ran = false;
    for (const g of gone) {
      had = this.working.delete(g) || had;
      ran = this.running.delete(g) || ran;
      this.lost.delete(g);
    }
    for (const [task, step] of [...this.taskSteps]) if (gone.has(step)) this.taskSteps.delete(task);
    if (had || ran) this.update({ ...(had ? { background: this.working.size } : {}), ...(ran ? { commands: this.running.size } : {}) });
  }

  reset(items: TimelineItem[]) {
    const before = this.meta.background ?? 0;
    const commands = this.meta.commands ?? 0;
    this.load(items, this.todos);
    this.emit({ type: 'timeline.reset', sessionId: this.id, items: items.map((i) => ({ ...i })) });
    this.onDirty(this, 'items');
    // `load` set the counts silently: a reset happens under clients that are listening.
    if (before !== this.working.size) {
      this.meta.background = before;
      this.update({ background: this.working.size });
    }
    if (commands !== this.running.size) {
      this.meta.commands = commands;
      this.update({ commands: this.running.size });
    }
    for (const id of [...this.lost]) if (!this.index.has(id)) this.lost.delete(id);
  }

  notice(variant: NoticeItem['variant'], text: string, detail?: string, parentId?: string) {
    return this.add<NoticeItem>({ type: 'notice', variant, text, detail, parentId });
  }

  // ── metadata ──

  update(patch: Partial<SessionMeta>) {
    const changed: Partial<SessionMeta> = {};
    for (const [k, v] of Object.entries(patch) as [keyof SessionMeta, never][]) {
      if (JSON.stringify(this.meta[k]) !== JSON.stringify(v)) {
        (this.meta as unknown as Record<string, unknown>)[k] = v;
        (changed as Record<string, unknown>)[k] = v;
      }
    }
    if (!Object.keys(changed).length) return;
    this.emit({ type: 'session.updated', id: this.id, patch: changed });
    this.onDirty(this, 'meta');
  }

  touch() {
    this.update({ updatedAt: Date.now() });
  }

  setCaps(caps: Capabilities) {
    this.caps = caps;
    this.emit({ type: 'session.caps', id: this.id, caps });
  }

  setTodos(todos: Todo[]) {
    this.todos = todos;
    this.emit({ type: 'todos.updated', sessionId: this.id, todos });
    this.onDirty(this, 'items');
  }

  setSuggestion(text: string | undefined) {
    this.suggestion = text;
    this.emit({ type: 'suggestion', sessionId: this.id, text: text ?? '' });
  }

  // ── turn state ──

  /**
   * `keepHold`: the agent begins this turn by itself (it read a message withdrawn at a stop after all,
   * a background task woke it): a stop's hold on the queue stays through it, so its end sends nothing
   * queued either, until the person sends something.
   */
  beginTurn(activity?: string, opts: { keepHold?: boolean } = {}) {
    const hold = !!opts.keepHold && this.stopped && !this.turnActive;
    this.turnActive = true;
    this.turnStartedAt = Date.now();
    this.stopped = hold;
    this.carried = hold;
    // A turn of the person's own is past the limit notice its background work met; one the agent begins by itself (a notification) is not.
    if (!opts.keepHold) this.limitCard = undefined;
    this.setSuggestion(undefined);
    this.update({ status: 'running', lastError: undefined, activity, updatedAt: Date.now() });
    this.onTurnStart?.(this);
  }

  /** The person sent a message into the running turn: a hold it carries from an earlier stop is theirs to lift. */
  personSent() {
    if (!this.carried) return;
    this.carried = false;
    this.stopped = false;
  }

  endTurn(error?: string, opts?: { hold?: boolean }) {
    this.turnActive = false;
    this.carried = false;
    this.cancelPrompts();
    this.update({ status: error ? 'error' : 'idle', lastError: error, activity: undefined, updatedAt: Date.now() });
    this.onTurnEnd?.(this, error, opts);
  }

  /** How long, between `from` and `to`, the session waited for the user (some prompt was open). */
  waitedBetween(from: number, to: number): number {
    let ms = 0;
    const spans = this.waitSince !== undefined ? [...this.waits, [this.waitSince, to] as const] : this.waits;
    for (const [a, b] of spans) ms += Math.max(0, Math.min(b, to) - Math.max(a, from));
    return ms;
  }

  /** Opens or closes a waiting span as the first prompt opens and the last one closes. */
  private trackWait() {
    const open = this.permissions.size + this.questions.size > 0;
    if (open && this.waitSince === undefined) this.waitSince = Date.now();
    else if (!open && this.waitSince !== undefined) {
      this.waits.push([this.waitSince, Date.now()]);
      this.waitSince = undefined;
      if (this.waits.length > 200) this.waits.shift();
    }
  }

  private refreshStatus() {
    this.trackWait();
    if (!this.turnActive) return;
    const waiting = this.permissions.size + this.questions.size > 0;
    this.update({ status: waiting ? 'awaiting' : 'running' });
  }

  // ── prompts ──

  requestPermission(
    req: Omit<PermissionRequest, 'id' | 'sessionId' | 'createdAt'>,
    signal?: AbortSignal,
  ): Promise<PermissionAnswer | null> {
    const request: PermissionRequest = { ...req, id: randomUUID(), sessionId: this.id, createdAt: Date.now() };
    // A share: the files it lists, as they are now that the person is shown them (an allow grants only those).
    const share = req.kind === 'share' && req.itemId ? approvedShare(this.meta.cwd, req.detail?.files) : undefined;
    return new Promise((resolve) => {
      const done = (a: PermissionAnswer | null) => {
        if (!this.permissions.delete(request.id)) return;
        this.emit({ type: 'permission.removed', sessionId: this.id, id: request.id });
        this.refreshStatus();
        resolve(a);
      };
      this.permissions.set(request.id, { request, resolve: done, share });
      signal?.addEventListener('abort', () => done(null), { once: true });
      this.emit({ type: 'permission.added', request });
      this.refreshStatus();
    });
  }

  /**
   * `person`: the person answered it themselves (the desktop or a phone), not a mode that answers for
   * them. A share they allowed may hand a file outside the chat's folder to a phone: exactly a file
   * they were shown, unchanged when the share goes through.
   */
  answerPermission(requestId: string, answer: PermissionAnswer, opts: { person?: boolean } = {}) {
    const p = this.permissions.get(requestId);
    if (!p) return false;
    const tone = p.request.options.find((o) => o.id === answer.optionId)?.tone;
    if (opts.person && p.request.kind === 'share' && p.request.itemId && p.share && tone && tone !== 'deny') this.allowedShares.set(p.request.itemId, p.share);
    p.resolve(answer);
    return true;
  }

  ask(questions: Question[], itemId?: string, signal?: AbortSignal): Promise<Record<string, string[]> | null> {
    const request: QuestionRequest = { id: randomUUID(), sessionId: this.id, itemId, questions, createdAt: Date.now() };
    return new Promise((resolve) => {
      const done = (a: Record<string, string[]> | null) => {
        if (!this.questions.delete(request.id)) return;
        this.emit({ type: 'question.removed', sessionId: this.id, id: request.id });
        this.refreshStatus();
        resolve(a);
      };
      this.questions.set(request.id, { request, resolve: done });
      signal?.addEventListener('abort', () => done(null), { once: true });
      this.emit({ type: 'question.added', request });
      this.refreshStatus();
    });
  }

  answerQuestion(requestId: string, answers: Record<string, string[]> | null) {
    const q = this.questions.get(requestId);
    if (!q) return false;
    q.resolve(answers);
    return true;
  }

  cancelPrompts() {
    for (const p of [...this.permissions.values()]) p.resolve(null);
    for (const q of [...this.questions.values()]) q.resolve(null);
  }

  // ── the session's Browser tab (in the window, not here) ──

  /** What the session's Browser tab shows, as the window last reported it (null: nothing, or closed). */
  browserPage: { url: string; title: string } | null = null;
  /** The page the agent was last told about with a message (its URL and title), so the line goes once per page. */
  browserTold?: string;
  private browserCalls = new Map<string, { resolve: (a: BrowserAnswer) => void; weak?: BrowserAnswer; graceTimer?: NodeJS.Timeout }>();

  /**
   * Asks the window that shows this session's Browser tab to do something with its page. Every
   * connected window hears it; one that cannot serve it (the web build, a window on another session)
   * answers weakly, and its answer stands only when no better one comes within `BROWSER_GRACE_MS`.
   * Nobody answering within `timeoutMs` is an answer too.
   */
  browserRequest(req: Omit<BrowserRequest, 'id' | 'sessionId'>, timeoutMs = 15_000, signal?: AbortSignal): Promise<BrowserAnswer> {
    const request: BrowserRequest = { ...req, id: randomUUID(), sessionId: this.id };
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (a: BrowserAnswer) => {
        const c = this.browserCalls.get(request.id);
        if (!c) return;
        this.browserCalls.delete(request.id);
        clearTimeout(timer);
        clearTimeout(c.graceTimer);
        resolve(a);
      };
      this.browserCalls.set(request.id, { resolve: done });
      timer = setTimeout(() => {
        const c = this.browserCalls.get(request.id);
        done(c?.weak ?? { ok: false, error: 'Sable did not answer in time. Is the app window open?' });
      }, timeoutMs);
      signal?.addEventListener('abort', () => done({ ok: false, error: 'Stopped.' }), { once: true });
      this.emit({ type: 'browser.request', request });
    });
  }

  answerBrowser(requestId: string, answer: BrowserAnswer): boolean {
    const c = this.browserCalls.get(requestId);
    if (!c) return false;
    if (!answer.weak) {
      c.resolve(answer);
      return true;
    }
    if (!c.weak) {
      c.weak = answer;
      c.graceTimer = setTimeout(() => c.resolve(answer), BROWSER_GRACE_MS);
    }
    return true;
  }

  /**
   * Root steps that run on their own, apart from the session's turns (a turn check, core/check.ts):
   * settling a turn leaves them and everything nested under them as they are. In memory only, so
   * after a restart they settle like anything else.
   */
  readonly apart = new Set<string>();

  /** `roots` and every item nested under them. */
  private subtree(roots: Iterable<string>): Set<string> {
    const out = new Set(roots);
    for (let grew = true; grew; ) {
      grew = false;
      for (const i of this.items) {
        if (i.parentId && out.has(i.parentId) && !out.has(i.id)) {
          out.add(i.id);
          grew = true;
        }
      }
    }
    return out;
  }

  /**
   * Sub-agents and workflows still marked as running in the background whose agent process is gone
   * (it ended, or Sable restarted): they died with it and their end will never be reported.
   */
  stopBackground(only?: (item: TimelineItem) => boolean) {
    for (const item of this.items) {
      if (only && !only(item)) continue;
      const stopped = stoppedBackground(item);
      if (stopped === item || stopped.type !== 'tool') continue;
      const was = item as ToolItem;
      this.patch<ToolItem>(item.id, { ...(stopped.result !== was.result ? { result: stopped.result } : {}), ...(stopped.workflow !== was.workflow ? { workflow: stopped.workflow } : {}) });
    }
  }

  /**
   * Settles anything left "in flight" (after an interrupt, crash or restart). Only steps of the turn
   * being settled (begun at or after its start; with no turn since the chat was read, after the last
   * record of a turn's end) get an end, at `at` (default now): a step left running by older work got
   * its status long ago in truth, and is given it with no end time, so the hours between never count
   * as its work. The subtree of a step that still works in the background (a sub-agent, a workflow)
   * and a step whose background command runs are left alone: their process still runs them.
   * `endUnknown`: read from disk after a restart, when these ended is not known (now is when the chat
   * was opened, maybe long after): none gets an end.
   */
  settle(reason: 'cancelled' | 'error' = 'cancelled', opts: { endUnknown?: boolean; at?: number } = {}) {
    this.settleSteps(reason, opts, true);
  }

  /** `settle`; `live`: what still works in the background is left alone (false: its process is gone too). */
  private settleSteps(reason: 'cancelled' | 'error', opts: { endUnknown?: boolean; at?: number }, live: boolean) {
    const roots = [...this.apart];
    if (live) for (const i of this.items) if (worksInBackground(i) || runsTask(i)) roots.push(i.id);
    const keep = roots.length ? this.subtree(roots) : undefined;
    const from = this.turnStartedAt || this.lastTurnStart();
    const at = opts.at ?? Date.now();
    for (const item of this.items) {
      if (keep?.has(item.id)) continue;
      const end = opts.endUnknown || item.ts < from ? {} : { endedAt: Math.max(at, item.ts) };
      if ((item.type === 'text' || item.type === 'thinking') && item.streaming) {
        this.patch(item.id, { streaming: false, ...(item.type === 'thinking' ? end : {}) } as Partial<TimelineItem>);
      } else if (item.type === 'tool' && (item.status === 'running' || item.status === 'pending' || item.status === 'awaiting')) {
        this.patch(item.id, { status: reason, ...end } as Partial<TimelineItem>);
      }
    }
  }

  /** Whether a root item records the end of a turn: its result, an interrupt, a cut. */
  private static endsTurn(i: TimelineItem): boolean {
    return !i.parentId && (i.type === 'turn' || (i.type === 'notice' && (i.variant === 'interrupted' || !!i.early)));
  }

  /** When the last turn began, read from the items (a chat read from disk has no turn of this run): the first root after the last record of an end. */
  private lastTurnStart(): number {
    // Nothing after the last end: no turn is open, and whatever still runs is older than any.
    let start = Infinity;
    for (let k = this.items.length - 1; k >= 0; k--) {
      const i = this.items[k];
      if (i.parentId) continue;
      if (SessionRuntime.endsTurn(i)) break;
      start = i.ts;
    }
    return start;
  }

  /**
   * The bridge knows the open turn was cut before the agent finished: `died` its process ended by
   * itself, `closed` Sable had to close it mid-work, `restart` Sable itself went down while it ran
   * (said when the chat is read again, with `at` the time of the turn's last item, never now). The
   * process is gone, so its running steps are settled at `at` (default now), background work's too;
   * then one notice says so ("Ended early", `early`; `detail`: the agent's own words, after the
   * reason) and the turn ends with the queue held. No turn open: what was left running in the process
   * is settled and nothing is written, except for `restart`, which the load path asks for with no turn
   * open (once: a chat whose last word is already such a notice gets no second).
   * Mark what ran in the background first (`stopBackground`, `tasksLost`): this settles steps only.
   */
  cutTurn(reason: 'died' | 'closed' | 'restart', opts: { at?: number; detail?: string } = {}) {
    const at = opts.at ?? Date.now();
    const open = this.turnActive;
    this.settleSteps('cancelled', { at }, false);
    if (!open && reason !== 'restart') return;
    const last = this.items.findLast((i) => !i.parentId);
    if (open || !(last?.type === 'notice' && last.early)) {
      const detail = opts.detail?.trim() ? `${CUT_DETAIL[reason]}\n\n${opts.detail.trim()}` : CUT_DETAIL[reason];
      this.add<NoticeItem>({ type: 'notice', variant: 'info', text: 'Ended early', detail, early: reason, ts: at });
    }
    if (open) this.endTurn(undefined, { hold: true });
  }

  /** The prompts open now, oldest first (as the snapshot lists them). */
  prompts(): PendingPrompts {
    return { permissions: [...this.permissions.values()].map((p) => p.request), questions: [...this.questions.values()].map((q) => q.request) };
  }

  snapshot(): SessionSnapshot {
    return {
      session: this.meta,
      items: this.items,
      caps: this.caps,
      permissions: [...this.permissions.values()].map((p) => p.request),
      questions: [...this.questions.values()].map((q) => q.request),
      todos: this.todos,
      suggestion: this.suggestion,
      queue: this.queue,
    };
  }
}

/** What waits on the user across sessions, for `app.hello` (`AppState.prompts`). */
export function pendingPrompts(runtimes: Iterable<SessionRuntime>): PendingPrompts {
  const out: PendingPrompts = { permissions: [], questions: [] };
  for (const rt of runtimes) {
    const p = rt.prompts();
    out.permissions.push(...p.permissions);
    out.questions.push(...p.questions);
  }
  return out;
}

export function autoTitle(text: string): string {
  // What the agent's harness writes in the person's place reads by its plain words, never as tags.
  const line =
    userText(text)
      .replace(/```[\s\S]*?```/g, ' ')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? 'New session';
  const clean = line.replace(/\s+/g, ' ').replace(/^[#>*\-\s]+/, '').trim();
  if (!clean) return 'New session';
  return clean.length > 56 ? clean.slice(0, 54).trimEnd() + '…' : clean;
}
