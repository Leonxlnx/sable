import { isDeepStrictEqual } from 'node:util';
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
  TaskMark,
  TimelineItem,
  Todo,
  ToolItem,
  UserItem,
} from '../../shared/protocol';
import type { ProviderSession } from '../providers/types';
import { agentOfTool } from '../providers/agent-tool';
import { isCompactOutput, personalOrigin, userItemText } from '../../shared/synthetic';
import { runsTask, worksInBackground } from '../../shared/background';
import { taskServing } from './task-serving';
import { turnLive, TurnLiveIndex } from '../../shared/turn-live';
import { approvedShare, handOver, type ApprovedShare } from './handed';
import { anonymousDelegateStep, resultDigest, restoreWorkingDelegate, savedDelegateEnds } from './delegate-result';
import { backgroundAgentName } from './limit-policy';

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
export type LossTrigger = 'death' | 'capability' | 'move' | 'limit';

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
  if (why === 'limit') return `${what} lost at the plan limit`;
  return why === 'move' ? `${what} lost when the chat moved` : why === 'restart' ? `${what} lost when Sable closed` : `${what} lost with the agent's process`;
}

/** At most this many lost tasks are named to the agent at once, each cut to `TASK_NAME_MAX` characters. */
const LOST_NAMES_MAX = 12;
const TASK_NAME_MAX = 90;

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
export interface ReportedTask {
  id: string;
  itemId?: string;
  agent: boolean;
  description?: string;
  since?: number;
}

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
  /** Sable owns these children independently of their provider's tool requests. */
  readonly delegates = new Map<string, { detach(): void; callerGone?(): void; stop(person: boolean): void; revoke?(): void; quit?(): Promise<void>; ended: Promise<unknown> }>();
  onDelegateReport?: () => void;
  /** Include an unissued report's destination in the result save. Call back once that save succeeds. */
  stageDelegateReports?: () => (() => void) | undefined;
  readonly pendingDelegateReports = new Set<string>();
  readonly reservedDelegateReports = new Map<string, symbol>();
  private owedDelegateReports = new Set<string>();
  private waitingSteers = new Map<string, ReturnType<typeof setTimeout> | undefined>();
  private lastSteerOrder = 0;
  nextSteerOrder() {
    return this.lastSteerOrder = Math.max(Date.now(), this.lastSteerOrder + 1);
  }
  onUnreadSteer?: (id: string, fresh?: boolean) => void;
  persistInput?: () => Promise<void>;
  persistDelegate?: () => Promise<void>;
  /** Keep the closing child's native result listener until a terminal frame or confirmed exit. */
  awaitingQuitResult = false;
  saveQuitResult?: (row: ToolItem) => () => void;
  reapDelegate?: (confirmed: Promise<void>) => void;
  offerToolResult?: (row: ToolItem) => void;

  waitForSteer(id: string, delay: number, fire: () => void, since?: number, reason?: string) {
    const item = this.get<UserItem>(id);
    if (!this.turnActive || this.stopRequested || item?.state !== 'queued' || this.waitingSteers.has(id) && !reason) return;
    const autoAt = delay > 0 ? (since ?? item.ts) + delay : undefined;
    const arm = () => {
      const remaining = autoAt === undefined ? 0 : autoAt - Date.now();
      const timer = autoAt === undefined ? undefined : setTimeout(() => {
        if (this.waitingSteers.get(id) !== timer) return;
        if (Date.now() < autoAt) arm(); // Node limits a single timeout to a signed 32-bit interval.
        else {
          this.waitingSteers.set(id, undefined);
          this.patch<UserItem>(id, { steerWait: { stepId: this.foregroundStep() } });
          fire();
        }
      }, Math.max(0, Math.min(remaining, 2_147_483_647)));
      timer?.unref?.();
      this.waitingSteers.set(id, timer);
    };
    arm();
    this.patch<UserItem>(id, { steerWait: { autoAt, stepId: this.foregroundStep(), ...(reason && { reason }) } });
  }

  get hasUnreadSteer() { return this.waitingSteers.size > 0; }

  private foregroundStep() {
    for (let n = this.items.length - 1; n >= 0; n--) {
      const it = this.items[n];
      if (it.parentId) continue;
      if (it.type === 'turn' || it.type === 'user' && it.state !== 'queued') break;
      if (it.type === 'tool' && !it.check && !worksInBackground(it) && !runsTask(it) &&
        (it.status === 'running' || it.status === 'pending' || it.status === 'awaiting')) return it.id;
    }
  }

  private refreshSteerWaits(item: TimelineItem) {
    if (item.parentId || item.type !== 'tool' || !this.waitingSteers.size) return;
    const stepId = this.foregroundStep();
    for (const id of this.waitingSteers.keys()) {
      const wait = this.get<UserItem>(id)?.steerWait;
      if (wait && wait.stepId !== stepId) this.patch<UserItem>(id, { steerWait: { ...wait, stepId } });
    }
  }

  clearSteerWaits(id?: string) {
    if (!this.waitingSteers.size) return;
    for (const key of id === undefined ? this.waitingSteers.keys() : [id]) {
      if (!this.waitingSteers.has(key)) continue;
      clearTimeout(this.waitingSteers.get(key));
      this.waitingSteers.delete(key);
      this.patch<UserItem>(key, { steerWait: null });
    }
  }

  /** Tool start frames can precede the request that supplies the child. */
  readonly steeredDelegateSteps = new Set<string>();
  releaseDelegates() {
    for (let n = this.items.length - 1; n >= 0; n--) {
      const it = this.items[n];
      if (it.type === 'turn' && !it.parentId) break;
      if (it.type === 'tool' && !it.parentId && !it.delegateReport && agentOfTool(it.name) && !this.delegates.has(it.id)
        && (it.status === 'running' || it.status === 'pending')) this.steeredDelegateSteps.add(it.id);
    }
    for (const call of this.delegates.values()) call.detach();
  }

  stopDelegates(person: boolean) {
    if (person) this.holdDelegateReports('stop');
    for (const call of this.delegates.values()) call.stop(person);
  }

  holdDelegateReports(why: 'stop' | 'budget', unissued?: (attempt: NonNullable<ToolItem['delegateAttempt']>) => boolean) {
    const ids = why === 'stop' ? [...this.pendingDelegateReports, ...this.reservedDelegateReports.keys()] : this.pendingDelegateReports;
    let changed = false;
    for (const id of ids) {
      const row = this.get<ToolItem>(id);
      if (row?.delegateReport !== 'pending' || row.delegateWait === why || row.delegateWait === 'stop') continue;
      if (why === 'budget' && (row.delegateWait === 'retry' || row.delegateAttempt && !unissued?.(row.delegateAttempt))) continue;
      this.patch<ToolItem>(id, { delegateWait: why });
      changed = true;
    }
    if (changed) void this.persistDelegate?.().catch(err => this.notice('error', 'Could not save the held delegate report', String(err)));
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
    const resumed = this.stopped && !v;
    if (v) this.clearSteerWaits();
    this.stopped = v;
    this.carried = false;
    if (!v) this.onWakeEligibilityChanged?.();
    if (resumed && !this.turnActive && this.queue.length) this.onQueueRunnable?.();
  }
  private stopped = false;
  /** Unread messages returned to the queue wait for the person's next send. */
  private unreadHeld = false;
  get unreadQueueHeld() { return this.unreadHeld; }
  set unreadQueueHeld(value: boolean) {
    if (this.unreadHeld === value) return;
    this.unreadHeld = value;
    this.onWakeEligibilityChanged?.();
    if (!value && this.queue.length) this.onQueueRunnable?.();
  }
  /** Preserve a phone sender's guard when its unread timeline card returns to the queue. */
  onReturnUntaken?: (item: UserItem) => void;
  /** The running turn carries a stop's hold it did not make (the agent began it by itself): the person's next message lifts it (`personSent`). */
  private carried = false;
  /**
   * Called after every turn end; `error` is set when the turn failed. `hold`: the agent could not say
   * how the turn ended (it went idle without its end), so nothing queued goes out by itself.
   * A backgroundLimit end is followed immediately by the refused wake's handoff at rest.
   */
  onTurnEnd?: (rt: SessionRuntime, error?: string, opts?: { hold?: boolean; backgroundLimit?: boolean }) => void;
  /** Called as a turn begins (an until loop's check in flight gives way to it). */
  canBeginTurn?: () => boolean;
  onTurnStart?: (rt: SessionRuntime) => void;
  /** A plan limit refused work of the chat outside its own turn (a background agent's request, or the agent's own): the bridge decides (`limitInBackground`). */
  onBackgroundLimit?: (rt: SessionRuntime, hit: BackgroundLimit) => void;
  /** First evidence of a personal limit arrived after Stop settled its turn. Offer a manual continuation. */
  onStoppedLimit?: (rt: SessionRuntime, notice: NoticeItem) => void;
  /** A queue, limit or work transition can make an owed report eligible. */
  onWakeEligibilityChanged?: () => void;
  /** The last background work ended with no turn running: the chat is at rest. */
  onRest?: (rt: SessionRuntime) => void;
  /** Sable took work away, or the process died (also reported with zero losses for crash protection). */
  onWorkLost?: (rt: SessionRuntime, trigger: LossTrigger, count: number) => void;
  /** Changes whenever Claude retires a process on this handle. */
  processGeneration = 0;
  private foregroundResults = new Map<string, NodeJS.Timeout>();
  private expiredToolResults = new WeakMap<NonNullable<ToolItem['delegateAttempt']>, number>();

  private trackToolReceipt(row: ToolItem) {
    if (row.delegateCaller === undefined || !row.delegateAttempt?.tool) {
      clearTimeout(this.foregroundResults.get(row.id));
      this.foregroundResults.delete(row.id);
    } else if (!this.foregroundResults.has(row.id)) {
      const timer = setTimeout(() => {
        if (row.delegateAttempt && !row.delegateAttempt.prepared) this.expiredToolResults.set(row.delegateAttempt, this.processGeneration);
        this.releaseToolResult(row.id);
        this.onDelegateReport?.();
      }, Math.max(1, Math.min(90_000, (row.endedAt ?? Date.now()) + 90_000 - Date.now())));
      timer.unref?.();
      this.foregroundResults.set(row.id, timer);
    }
  }

  private releaseToolResult(id: string) {
    const row = this.get<ToolItem>(id);
    if (!row) return;
    this.patch<ToolItem>(id, { delegateCaller: undefined, delegateReport: this.stopRequested ? 'stopped' : 'pending',
      ...(row.delegateAttempt?.prepared ? { delegateAttempt: undefined } : {}) });
    if (!this.stopRequested) this.pendingDelegateReports.add(id);
  }

  /** A late acknowledgement can only settle the very attempt that was released. */
  confirmLateDelegate(id: string, attempt: NonNullable<ToolItem['delegateAttempt']>) {
    const row = this.get<ToolItem>(id);
    if (row?.delegateReport !== 'pending' || row.delegateAttempt !== attempt) return false;
    if (row.delegateRetryId) {
      const token = '/report-retry ' + row.delegateRetryId;
      const notice = this.items.findLast(i => i.type === 'notice' && i.detail?.endsWith(token));
      if (notice) this.patch<NoticeItem>(notice.id, { text: 'Delivery confirmed for ' + row.title, detail: 'The agent acknowledged the saved answer.' });
    }
    this.pendingDelegateReports.delete(id);
    this.patch<ToolItem>(id, { delegateReport: 'delivered', delegateWait: null, delegateAttempt: undefined, delegateReceiptState: null, delegateRetryId: null });
    return true;
  }

  /** A completed tool result stays with its caller until the provider echoes the result. */
  delegateReceipt(id: string, content?: unknown) {
    if (!this.get<ToolItem>(id)?.delegateAttempt?.tool) {
      const synthetic = anonymousDelegateStep(content);
      if (!synthetic || synthetic !== 'delegate-' + this.get<ToolItem>(synthetic)?.delegateDeliveryId) return;
      id = synthetic;
    }
    const row = this.get<ToolItem>(id);
    const attempt = row?.delegateAttempt;
    if (!row || !attempt?.tool) return;
    const late = this.expiredToolResults.get(attempt) === this.processGeneration;
    if (!late && (row.delegateCaller !== this.processGeneration || !this.foregroundResults.has(id))) return;
    this.promote?.(row);
    const digest = resultDigest(row.result?.text);
    if (anonymousDelegateStep(content) !== 'delegate-' + row.delegateDeliveryId && (!digest || digest !== resultDigest(content))) return;
    if (late) {
      if (!this.confirmLateDelegate(id, attempt)) return;
    } else this.patch<ToolItem>(id, { delegateCaller: undefined, delegateAttempt: undefined });
    void this.persistDelegate?.().catch(err => this.notice('error', 'Could not save the delegate receipt', String(err)));
  }

  endDelegateGeneration() {
    this.processGeneration++;
    for (const owner of this.delegates.values()) owner.callerGone?.();
    const hadResults = this.foregroundResults.size > 0;
    for (const id of this.foregroundResults.keys()) this.releaseToolResult(id);
    if (hadResults) void this.persistDelegate?.().catch(err => this.notice('error', 'Could not save the delegate report', String(err)));
    if (this.pendingDelegateReports.size) this.onDelegateReport?.();
  }

  revokeAllDelegates() {
    return this.revokeDelegates(new Set([...this.delegates.keys(), ...this.pendingDelegateReports,
      ...this.reservedDelegateReports.keys(), ...this.foregroundResults.keys()]));
  }

  revokeDelegates(ids: Iterable<string>) {
    const cleanup: Promise<unknown>[] = [];
    for (const id of ids) {
      const owner = this.delegates.get(id);
      this.delegates.delete(id);
      this.pendingDelegateReports.delete(id);
      this.reservedDelegateReports.delete(id);
      clearTimeout(this.foregroundResults.get(id));
      this.foregroundResults.delete(id);
      if (owner) {
        if (owner.revoke) owner.revoke();
        else owner.stop(true);
        cleanup.push(owner.ended);
      }
    }
    return Promise.all(cleanup);
  }
  /** The existing line for this loss can be updated when the agent confirms the wake. */
  lossNotice?: string;
  /** The limit notice the bridge wrote when work outside a turn met a limit: a turn refused at it says it there (one notice). */
  limitCard?: string;

  private index = new Map<string, TimelineItem>();
  /** `share`: for a share's permission, the files as it showed them (core/handed.ts `approvedShare`). */
  private permissions = new Map<string, { request: PermissionRequest; resolve: (a: PermissionAnswer | null) => void; share?: ApprovedShare }>();
  private questions = new Map<string, { request: QuestionRequest; resolve: (a: Record<string, string[]> | null) => void }>();
  /** Spans in which a prompt waited for the user ([start, end] ms), and the start of the open one. */
  private waits: [number, number][] = [];
  private waitSince?: number;
  private liveTurn?: TurnLiveIndex;
  private nextHead?: UserItem;
  private liveTimer?: ReturnType<typeof setTimeout>;
  private publishedLive?: SessionMeta['live'];
  private livePublishedAt = 0;

  constructor(
    public meta: SessionMeta,
    private emit: Emit,
    private onDirty: (rt: SessionRuntime, what: 'meta' | 'items') => void,
  ) {
    // Even a lazy restored chat is listed before anyone reads its timeline.
    delete meta.live;
  }

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
    const names: string[] = [];
    const ends = savedDelegateEnds(items);
    const out = items.map((i) => {
      if (i.type === 'tool' && (i.delegateReport === 'working' || i.delegateCaller !== undefined) && i.result?.text) this.promote?.(i);
      let s = stoppedBackground(i);
      if (s.type === 'tool' && s.delegateReport === 'stopping') s = { ...s, status: 'cancelled', delegateReport: 'stopped' };
      if (s.type === 'tool' && s.delegateCaller !== undefined) {
        s = { ...s, delegateCaller: undefined, delegateReport: s.delegateAttempt?.tool ? 'pending' : 'working' };
      }
      if (s.type === 'tool' && s.delegateReport === 'working') {
        s = restoreWorkingDelegate(s, ends.get(i.id));
      }
      if (runsTask(s)) {
        names.push(taskName(s));
        s = { ...s, task: { ...s.task, state: 'lost', why: 'restart' } };
      }
      if (s !== i) changed.push(i.id);
      return s;
    });
    let afterCompact = false;
    this.load(this.meta.provider === 'claude' ? out.filter(item => {
      if (afterCompact && !item.parentId && (
        (item.type === 'text' && isCompactOutput(item.text, true)) ||
        (item.type === 'user' && !personalOrigin(item) && isCompactOutput(item.text)) ||
        (item.type === 'notice' && item.variant === 'command' && item.detail && isCompactOutput(item.detail, true))
      )) return false;
      afterCompact = !item.parentId && item.type === 'notice' && item.variant === 'compact';
      return true;
    }) : out, todos, queue);
    this.markSaved();
    for (const id of changed) this.markDirty(id);
    return names;
  }

  load(items: TimelineItem[], todos: Todo[] = [], queue?: QueuedMessage[]) {
    this.dropLive();
    delete this.meta.live;
    this.dirty = 'all';
    this.items = items;
    this.todos = todos;
    if (queue) this.queue = queue;
    this.index = new Map(items.map((i) => [i.id, i]));
    this.working.clear();
    this.running.clear();
    this.serving.clear();
    this.lost.clear();
    this.taskSteps.clear();
    this.pendingDelegateReports.clear();
    this.owedDelegateReports.clear();
    for (const timer of this.foregroundResults.values()) clearTimeout(timer);
    this.foregroundResults.clear();
    for (const i of items) {
      if (i.type === 'tool' && i.delegateCaller !== undefined && i.delegateAttempt?.tool) this.trackToolReceipt(i);
      if (i.type === 'tool' && (i.delegateCaller !== undefined || i.delegateReport === 'pending' || i.delegateReport === 'working')) this.owedDelegateReports.add(i.id);
      if (i.type === 'tool' && i.delegateReport === 'pending' && !this.reservedDelegateReports.has(i.id)) this.pendingDelegateReports.add(i.id);
      if (worksInBackground(i)) this.working.add(i.id);
      this.trackTask(i);
      if (runsTask(i)) {
        const serving = taskServing(i);
        if (serving) {
          i.task = { ...i.task, serving };
          this.serving.set(i.id, i.task);
        }
        this.running.add(i.id);
      }
    }
    // As read: whoever loads gets the whole chat next (a snapshot), so nothing is announced here.
    Object.assign(this.meta, this.taskCounts(), { delegateRecovery: this.owedDelegateReports.size ? true : undefined });
  }

  // ── background work ──

  /** Steps whose sub-agent or workflow still works in the background (`SessionMeta.background` is their count). */
  private working = new Set<string>();
  /** All live command steps, including the subset that serves. */
  private running = new Set<string>();
  private serving = new Map<string, TaskMark>();
  /** The step of each task the chat has seen, by the agent's own task id. */
  private taskSteps = new Map<string, string>();
  /** Steps whose lost-task note has yet to reach the agent. */
  private lost = new Set<string>();
  private lossReservations = new Map<string, { token: symbol; task: NonNullable<ToolItem['task']> }>();

  private trackTask(item: TimelineItem) {
    if (item.type !== 'tool') return;
    if (item.task) this.taskSteps.set(item.task.id, item.id);
    if (item.task?.state === 'lost' && !item.task.lossTold) this.lost.add(item.id);
    else this.lost.delete(item.id);
  }

  /**
   * A step was added or changed: the chat's counts of background work follow it. At rest (`onRest`)
   * when the last sub-agent or workflow ends, as before, or the last command when no sub-agent works
   * either, with no turn running; a command still running then is the bridge's to weigh (a move waits
   * only for a young one).
   */
  private trackBackground(item: TimelineItem) {
    this.trackTask(item);
    const works = worksInBackground(item);
    const runs = runsTask(item);
    const serves = runs && item.task.serving ? item.task : undefined;
    if (works === this.working.has(item.id) && runs === this.running.has(item.id) && serves === this.serving.get(item.id)) return;
    if (serves) this.serving.set(item.id, serves);
    else this.serving.delete(item.id);
    if (works) this.working.add(item.id);
    else this.working.delete(item.id);
    if (runs) this.running.add(item.id);
    else this.running.delete(item.id);
    this.publishTaskCounts();
  }

  private reportedTasks: ReportedTask[] = [];

  setReportedTasks(tasks: ReportedTask[]) {
    if (!tasks.length && !this.reportedTasks.length) return;
    this.reportedTasks = tasks;
    this.publishTaskCounts();
  }

  /** SDK task lists can arrive before the step or once more after its end. */
  private reportedMark(task: ReportedTask) {
    const id = this.taskSteps.get(task.id) ?? task.itemId;
    return id ? this.get<ToolItem>(id)?.task : undefined;
  }

  private taskCounts() {
    let background = this.working.size;
    const serving = this.serving.size;
    let commands = this.running.size - serving;
    for (const task of this.reportedTasks) {
      if (task.agent) {
        if (!task.itemId || !this.working.has(task.itemId)) background++;
      } else if (!this.reportedMark(task)) commands++;
    }
    let servingSince: number | undefined;
    let servingAddress: string | undefined;
    for (const task of this.serving.values()) {
      servingSince = Math.min(servingSince ?? task.since, task.since);
      if (serving === 1 && typeof task.serving === 'string') servingAddress = task.serving;
    }
    return { background, commands, serving, servingSince, servingAddress };
  }

  private publishTaskCounts() {
    const counts = this.taskCounts();
    const { background, commands, serving } = counts;
    const agentsDone = !!this.meta.background && !background;
    const commandsDone = !!(this.meta.commands || this.meta.serving) && !commands && !serving;
    this.update(counts);
    if (!this.turnActive && !background && (agentsDone || commandsDone)) this.onRest?.(this);
  }

  /** The most recent start used for sleep and updates excludes serving. Moves protect every process. */
  get newestCommandAt() { return this.commandTime(false); }
  get newestProcessCommandAt() { return this.commandTime(true); }

  taskServes(id: string): boolean {
    const step = this.taskSteps.get(id);
    return step !== undefined && this.serving.has(step);
  }

  private commandTime(includeServing: boolean): number | undefined {
    let at: number | undefined;
    for (const id of this.running) {
      const i = this.index.get(id);
      if (runsTask(i) && (includeServing || !i.task.serving)) at = Math.max(at ?? 0, i.task.since);
    }
    for (const t of this.reportedTasks) {
      if (t.agent || t.since === undefined) continue;
      const mark = this.reportedMark(t);
      if (mark && (mark.state !== 'running' || (!includeServing && mark.serving))) continue;
      at = Math.max(at ?? 0, t.since);
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
    this.patch<ToolItem>(item.id, { task: { id: t.id, kind: t.kind, state, since: t.since, ...(state === 'stopped' && t.serving && { serving: t.serving }), endedAt: Math.max(at ?? Date.now(), t.since) } });
  }

  /**
   * The process is gone: every running task becomes `lost` (with `why`, and no end: when or whether it
   * ended is not known). Returns their names as the person knows them, for the notice that tells
   * them (`lostLine`), and keeps them for `takeLost`.
   */
  tasksLost(why: LostWhy, trigger?: LossTrigger): string[] {
    const names: string[] = [];
    const reports: string[] = [];
    const independent = this.delegates.size && this.subtree(this.delegates.keys());
    if (trigger) {
      for (const t of this.reportedTasks) {
        if (this.running.has(this.taskSteps.get(t.id) ?? '') || (t.itemId && this.working.has(t.itemId))) continue;
        reports.push(`"${(t.description || t.id).replace(/\s+/g, ' ').slice(0, TASK_NAME_MAX)}" (${t.agent ? 'agent' : 'task'}, task ${t.id.slice(0, TASK_NAME_MAX)})`);
      }
      // A provider's confirmed process exit ends its agents too. A move may leave an
      // unstoppable remote agent alive, so the move records only confirmed stops.
      if (trigger === 'death' || trigger === 'capability') {
        for (const id of this.working) {
          const step = this.get<ToolItem>(id)!;
          if (!step.delegateReport && !(independent && independent.has(id))) reports.push(backgroundAgentName(step));
        }
      }
    }
    const ids = this.items.filter((i) => this.running.has(i.id) && !(independent && independent.has(i.id))).map((i) => i.id);
    for (const id of ids) {
      const item = this.index.get(id);
      if (!runsTask(item)) continue;
      names.push(taskName(item));
      this.patch<ToolItem>(id, { task: { ...item.task, state: 'lost', why } });
    }
    if (trigger) this.reportLoss(trigger, reports, names.length);
    return names;
  }

  /** Reports without a command mark still share the same delivery reservation and receipt. */
  reportLoss(trigger: LossTrigger, reports: string[], marked = 0) {
    if (reports.length) this.update({ lostReports: [...(this.meta.lostReports ?? []), ...reports.map(name => ({ key: randomUUID(), name }))] });
    if (reports.length || marked) this.lossNotice = undefined;
    this.onWorkLost?.(this, trigger, reports.length + marked);
  }

  /**
   * The lost tasks to mention with a send (at most twelve names, then "N more").
   * Call `taken` once that send is accepted. Losses that arrive meanwhile wait for the next send.
   */
  pendingLost() {
    return this.lostBatch();
  }

  /** Claim these losses while one send waits for its delivery receipt. */
  reserveLost() {
    return this.lostBatch(Symbol());
  }

  private reportReservations = new Map<string, symbol>();

  private lostBatch(token?: symbol) {
    const names: string[] = [];
    const batch = new Map<string, NonNullable<ToolItem['task']>>();
    for (const id of this.lost) {
      const item = this.index.get(id);
      if (item?.type !== 'tool' || item.task?.state !== 'lost') continue;
      if (token) {
        const held = this.lossReservations.get(id);
        if (held?.task.id === item.task.id && held.task.since === item.task.since) continue;
        this.lossReservations.set(id, { token, task: item.task });
      }
      batch.set(id, item.task);
      if (names.length < LOST_NAMES_MAX) {
        names.push(`"${taskName(item).replace(/"/g, "'")}" (${item.task.kind}, task ${item.task.id})`);
      }
    }
    const reports = (this.meta.lostReports ?? []).filter(r => !token || !this.reportReservations.has(r.key));
    const keys = new Set(reports.map(r => r.key));
    for (const r of reports) {
      if (token) this.reportReservations.set(r.key, token);
      if (names.length < LOST_NAMES_MAX) names.push(r.name);
    }
    const count = batch.size + reports.length;
    if (count > names.length) names.push(`${count - names.length} more`);
    const release = () => {
      if (token) for (const key of keys) if (this.reportReservations.get(key) === token) this.reportReservations.delete(key);
      if (token) for (const id of batch.keys()) {
        if (this.lossReservations.get(id)?.token === token) this.lossReservations.delete(id);
      }
    };
    const taken = () => {
      release();
      if (keys.size && this.meta.lostReports?.some(r => keys.has(r.key))) {
        const rest = this.meta.lostReports.filter(r => !keys.has(r.key));
        this.update({ lostReports: rest.length ? rest : undefined });
      }
      for (const [id, sent] of batch) {
        const task = this.get<ToolItem>(id)?.task;
        if (task?.state === 'lost' && !task.lossTold && task.id === sent.id && task.since === sent.since) {
          this.patch<ToolItem>(id, { task: { ...task, lossTold: true } });
        }
      }
    };
    return { names, count, taken, release };
  }

  /** Takes and acknowledges the current list together, for an already accepted message. */
  takeLost(): string[] {
    const batch = this.reserveLost();
    batch.taken();
    return batch.names;
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

  /** Only pre-pairing callers have a socket guard. Its owner is this chat's waiting row. */
  readonly transientQueueGuards = new Map<string, () => boolean>();

  private queueChanged() {
    if (!this.queue.length) this.unreadQueueHeld = false;
    this.onWakeEligibilityChanged?.();
    this.emit({ type: 'queue.updated', sessionId: this.id, queue: this.queue.map((q) => ({ ...q })) });
    this.onDirty(this, 'items');
  }

  enqueue(text: string, attachments?: QueuedMessage['attachments'], phoneSender?: QueuedMessage['phoneSender'], until?: QueuedMessage['until']): QueuedMessage {
    // Nothing without words goes in (a page of the queue reads each one's).
    if (typeof text !== 'string') throw new Error('A message needs its words.');
    const q: QueuedMessage = { id: randomUUID(), text, attachments: attachments?.length ? attachments : undefined, createdAt: Date.now(), ...(phoneSender && { phoneSender }), ...(until && { until }) };
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
      this.transientQueueGuards.delete(id);
      this.queueRev.delete(id);
    } else {
      if (q.text === text && isDeepStrictEqual(q.attachments ?? [], files ?? [])) {
        this.queueChanged(); // Spare also publishes its hold by updating the same payload.
        return true;
      }
      const edited = { ...q, text, attachments: files };
      if (q.issuedUuid) {
        edited.issuedPayload ??= { text: q.text, attachments: q.attachments };
        if (edited.issuedPayload.text === text && isDeepStrictEqual(edited.issuedPayload.attachments ?? [], files ?? [])) delete edited.issuedPayload;
        edited.byHand = true;
      }
      this.queue[at] = edited;
      this.queueRev.set(id, (this.queueRev.get(id) ?? 0) + 1);
    }
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
  onQueueRunnable?: () => void;

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
      this.transientQueueGuards.delete(id);
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

  queueReason(id: string, reason: string) {
    const entry = this.queue.find(q => q.id === id);
    if (!entry) return;
    if (entry.steerWait?.reason !== reason) {
      entry.steerWait = { reason };
      this.queueChanged();
    }
  }

  markStillQueued(id: string, uuid: string) {
    const card = this.get<UserItem>(id);
    const row = card?.issuedUuid === uuid ? card : this.queue.find(q => q.issuedUuid === uuid);
    if (!row?.issuedTo) return;
    const issuedTo = { ...row.issuedTo, stillQueued: true };
    const steerWait = { reason: 'Claude still has this input queued.' };
    if (row === card) this.patch<UserItem>(id, { issuedTo, steerWait });
    else {
      Object.assign(row, { issuedTo, steerWait, byHand: true });
      this.queueChanged();
    }
  }

  /** A native receipt belongs to the payload that went out, even if the waiting row was edited. */
  confirmSteerReceipt(uuid: string): UserItem | undefined {
    const row = this.queue.find(q => q.issuedUuid === uuid);
    if (!row || this.get(row.id)) return;
    const edited = row.issuedPayload;
    if (edited) {
      delete row.issuedPayload;
      delete row.issuedUuid;
      delete row.issuedTo;
      row.byHand = true;
      this.queueReason(row.id, 'Claude received the original message. The edit waits for you.');
    } else {
      this.rollbackReserved(row.id);
      this.takeQueued(row.id);
    }
    return this.add<UserItem>({
      type: 'user', id: edited ? undefined : row.id, ts: row.createdAt,
      text: (edited ?? row).text, attachments: (edited ?? row).attachments,
      ...(row.until ? { until: row.until } : { ...(!row.issuedAtRest && { steered: true }), authored: true }), phoneSender: row.phoneSender,
      submitPrint: row.submitPrint, state: 'sent', providerId: uuid,
    });
  }

  /** A survivor belongs to one live SDK queue. Losing that process leaves only receipt uncertainty. */
  forgetLiveQueue(uuid: string) {
    const row = this.queue.find(q => q.issuedUuid === uuid);
    const reason = 'The Claude process ended. Check the conversation before sending again.';
    if (row?.issuedTo?.stillQueued) {
      delete row.issuedTo.stillQueued;
      row.steerWait = { reason };
      this.queueChanged();
    }
    const card = this.items.find((i): i is UserItem => i.type === 'user' && i.issuedUuid === uuid);
    if (card?.issuedTo?.stillQueued) this.patch<UserItem>(card.id, { issuedTo: { ...card.issuedTo, stillQueued: undefined }, steerWait: { reason } });
  }

  confirmDropped(uuid: string) {
    const entry = this.queue.find(q => q.issuedUuid === uuid);
    if (!entry) return;
    delete entry.issuedUuid;
    delete entry.issuedTo;
    if (!entry.issuedPayload) delete entry.byHand;
    delete entry.issuedPayload;
    entry.steerWait = { reason: 'Claude confirmed withdrawal.' };
    this.queueChanged();
    if (!entry.byHand) this.onQueueRunnable?.();
  }

  /** Keep a failed offer actionable, including an idle card whose provider never wrote it. */
  returnUnwritten(ids: readonly string[], why: string) {
    const waiting = new Set(ids.filter(id => this.get<UserItem>(id)?.state === 'queued'));
    this.returnUntaken({ ids: waiting, byHand: waiting });
    for (const id of waiting) this.queueReason(id, why);
  }

  /** An outstanding native request owns its waiting cards until its receipt settles. */
  readonly pendingNativeInputs = new WeakSet<UserItem>();

  /** Puts messages back at the front of the queue (steered messages the agent never took). */
  requeue(messages: QueuedMessage[]) {
    if (!messages.length) return;
    const returned = new Set(messages.map(m => m.id));
    this.queue = [...messages, ...this.queue.filter(q => !returned.has(q.id))];
    for (const id of returned) this.rollbackReserved(id);
    this.queueChanged();
  }

  /**
   * Messages in the timeline no agent took (steered into a turn that ended first; with `all`, any
   * left waiting, as after a restart) go back to the front of the queue in the order they were
   * sent, so none is lost. With `reason`, one quiet line in the timeline says so. Returns how many.
   */
  returnUntaken(opts: { ids?: ReadonlySet<string>; from?: UserItem[]; all?: boolean; byHand?: ReadonlySet<string>; holdQueue?: boolean; reason?: 'stopped' | 'failed' | 'closed' } = {}): number {
    const candidates = opts.ids ? Array.from(opts.ids, id => this.index.get(id)) : opts.from?.filter(i => this.get(i.id) === i) ?? this.items;
    const untaken = candidates.filter((i): i is UserItem => i?.type === 'user' && !i.parentId &&
      (!!opts.ids || i.state === 'queued' && !i.heldAtLimit && (opts.all || !this.pendingNativeInputs.has(i)) && (opts.all || !!i.steered || !!i.steerAttempts || !!i.issuedUuid)));
    if (!untaken.length) return 0;
    if (opts.holdQueue) this.unreadQueueHeld = true;
    for (const u of untaken) {
      this.onReturnUntaken?.(u);
      this.promote?.(u);
      this.remove(u.id);
    }
    const returned: QueuedMessage[] = untaken.map(u => ({
      id: u.id, text: u.text, attachments: u.attachments, createdAt: u.ts,
      ...(u.submitPrint && { submitPrint: u.submitPrint }), ...(u.phoneSender && { phoneSender: u.phoneSender }),
      ...(u.steerOrder && { steerOrder: u.steerOrder }), ...(u.steerAttempts && { steerAttempts: u.steerAttempts }),
      ...(u.until && { until: u.until }),
      ...(u.issuedUuid && { issuedUuid: u.issuedUuid, ...(!u.steered && { issuedAtRest: true as const }), issuedTo: u.issuedTo, steerWait: { reason: u.issuedTo?.stillQueued ? 'Claude still has this input queued.' : 'Issued to Claude. Receipt unknown.' } }),
      ...(opts.all && u.awaitingNativeReceipt && { steerWait: { reason: 'The provider receipt was not saved. Check the conversation before sending again.' } }),
      ...(u.issuedUuid || opts.all && u.awaitingNativeReceipt || opts.byHand?.has(u.id) ? { byHand: true } : {}),
    }));
    this.requeue(returned);
    if (returned.some(q => q.steerOrder)) {
      const ordered = this.queue.filter(q => q.steerOrder).sort((a, b) => a.steerOrder! - b.steerOrder!);
      let index = 0;
      this.reorderQueued(this.queue.map(q => q.steerOrder ? ordered[index++].id : q.id));
    }
    if (opts.reason) {
      const one = untaken.length === 1;
      const it = one ? 'it' : 'them';
      const why = untaken.some(u => u.issuedUuid) ? 'Claude did not confirm delivery. Review the waiting messages before sending again.' : opts.reason === 'closed' ? `Sable closed before the agent took ${it}.` : opts.reason === 'failed' ? `The turn failed before the agent took ${it}.` : `The turn stopped before the agent took ${it}.`;
      this.notice('info', one ? 'Your message is back in the queue' : `${untaken.length} messages are back in the queue`, why);
    }
    return untaken.length;
  }

  /** Takes a message out of the queue (the first one without an id); never one a phone is taking back. */
  takeQueued(id?: string): QueuedMessage | undefined {
    const at = id ? this.queue.findIndex((x) => x.id === id) : this.queue.length ? 0 : -1;
    if (at < 0 || this.reserved.has(this.queue[at].id)) return undefined;
    const [q] = this.queue.splice(at, 1);
    this.transientQueueGuards.delete(q.id);
    this.queueRev.delete(q.id);
    this.queueChanged();
    return q;
  }

  add<T extends TimelineItem>(item: NewItem<T>): T {
    const full = { ...item, id: item.id ?? randomUUID(), ts: item.ts ?? Date.now() } as unknown as T;
    if (full.type === 'tool' && full.kind === 'share' && full.status === 'done' && !full.handed) full.handed = this.hand(full);
    if (runsTask(full)) {
      const serving = taskServing(full);
      if (serving) full.task = { ...full.task, serving };
    }
    this.items.push(full);
    this.index.set(full.id, full);
    this.markDirty(full.id);
    // Emit a copy: the live object keeps mutating as deltas arrive.
    this.emit({ type: 'item.added', sessionId: this.id, item: { ...full } });
    this.onDirty(this, 'items');
    this.trackBackground(full);
    this.refreshSteerWaits(full);
    this.liveItem(full, true);
    return full;
  }

  /** Restore a disk-backed row in place before interpreting an authoritative provider replacement. */
  promote?: (item: TimelineItem) => TimelineItem;

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
    const step = this.index.get(id);
    if (field === 'text' && step?.type === 'text' && this.liveTurn?.textChanged(step)) this.refreshLive();
    if (field === 'output' && runsTask(step) && step.task.kind === 'command') {
      // Include the preceding partial line when a banner crosses a stream boundary.
      const output = step.output ?? '';
      const from = Math.max(0, output.length - delta.length - 4096);
      const serving = taskServing(step, output.slice(from), {});
      if (serving && serving !== step.task.serving) this.patch<ToolItem>(id, { task: { ...step.task, serving } });
    }
  }

  patch<T extends TimelineItem>(id: string, patch: Partial<T>) {
    const item = this.index.get(id);
    if (!item) return;
    if (item.type === 'user' && (patch as Partial<UserItem>).state === 'sent') this.clearSteerWaits(id);
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
    const previous = item.type === 'tool' ? item.task : undefined;
    const taken = item.type === 'user' && item.state === 'queued' && (patch as Partial<UserItem>).state === 'sent';
    Object.assign(item, patch);
    if (item.type === 'notice' && 'limit' in patch) this.onWakeEligibilityChanged?.();
    if (item.type === 'tool' && ('delegateReport' in patch || 'delegateCaller' in patch)) {
      this.trackToolReceipt(item);
      if (item.delegateCaller !== undefined || item.delegateReport === 'working' || item.delegateReport === 'pending') this.owedDelegateReports.add(id);
      else this.owedDelegateReports.delete(id);
      const recovery = this.owedDelegateReports.size ? true : undefined;
      if (recovery !== this.meta.delegateRecovery) this.update({ delegateRecovery: recovery });
    }
    if (item.type === 'tool' && item.task && ('task' in patch || 'detail' in patch || 'output' in patch || 'result' in patch)) {
      const previousServing = previous?.id === item.task.id ? previous.serving : undefined;
      const mark = item.task;
      if (previousServing && !mark.serving && mark.state !== 'done' && mark.state !== 'failed') item.task = { ...mark, serving: previousServing };
      if (mark.state === 'running' && (!item.task.serving || 'output' in patch || 'result' in patch)) {
        const serving = taskServing(item);
        if (serving && serving !== item.task.serving) item.task = { ...item.task, serving };
      }
      if (item.task !== mark) patch = { ...patch, task: item.task };
    }
    this.markDirty(id);
    this.emit({ type: 'item.patch', sessionId: this.id, id, patch: patch as Partial<TimelineItem> });
    this.onDirty(this, 'items');
    this.trackBackground(item);
    this.refreshSteerWaits(item);
    if (['status', 'kind', 'result', 'detail', 'check', 'streaming', 'text', 'variant', 'early', 'until',
      'agentSwitch', 'state', 'steered', 'parentId', 'ts', 'type'].some(key => key in patch)) {
      this.liveItem(item, taken);
    }
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
    const issued = item.issuedUuid;
    const native = item.awaitingNativeReceipt;
    if (native) patch = { ...patch, awaitingNativeReceipt: undefined };
    if (issued) patch = { ...patch, issuedUuid: undefined, issuedTo: undefined };
    if (item.state !== 'queued') this.patch<UserItem>(id, { state: 'sent', ...patch });
    else this.move(id, { state: 'sent', ...patch } as Partial<TimelineItem>, !!item.steered || !!item.steerAttempts);
    if (issued) void this.persistInput?.().catch(err => this.notice('error', 'Could not save the delivery receipt', (err as Error).message));
  }

  /** Moves a root item to the end of the timeline (a message once the agent takes it); `keepTime`: its time stays. */
  move(id: string, patch: Partial<TimelineItem> = {}, keepTime = false) {
    if ((patch as Partial<UserItem>).state === 'sent') this.clearSteerWaits(id);
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
    this.liveTurn?.remove(id);
    this.liveItem(item, true);
  }

  /** Removes an item and every item nested under it (children of a tool or agent, and theirs). */
  remove(id: string) {
    const removed = this.get(id);
    if (!removed) return;
    this.clearSteerWaits(id);
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
    if (this.delegates.size || this.pendingDelegateReports.size || this.reservedDelegateReports.size) void this.revokeDelegates(gone);
    if (removed.type === 'notice' && removed.limit) this.onWakeEligibilityChanged?.();
    for (const g of gone) this.index.delete(g);
    if (this.nextHead && gone.has(this.nextHead.id)) this.nextHead = undefined;
    if (this.liveTurn) {
      for (const g of gone) this.liveTurn.remove(g);
      this.refreshLive();
    }
    this.items = this.items.filter((i) => !gone.has(i.id));
    this.refreshSteerWaits(removed);
    // One event for the root: clients drop its descendants themselves.
    this.emit({ type: 'item.removed', sessionId: this.id, id });
    this.onDirty(this, 'items');
    let had = false;
    let ran = false;
    for (const g of gone) {
      had = this.working.delete(g) || had;
      ran = this.running.delete(g) || ran;
      this.serving.delete(g);
      this.lost.delete(g);
    }
    for (const [task, step] of [...this.taskSteps]) if (gone.has(step)) this.taskSteps.delete(task);
    if (had || ran) this.publishTaskCounts();
  }

  reset(items: TimelineItem[]) {
    const previous = this.liveTurn;
    this.update({ live: undefined });
    const before = this.meta.background ?? 0;
    const commands = this.meta.commands ?? 0;
    const { serving, servingSince, servingAddress } = this.meta;
    this.load(items, this.todos);
    for (const id of this.waitingSteers.keys()) {
      if (this.get<UserItem>(id)?.state !== 'queued') this.clearSteerWaits(id);
    }
    // Claude can also reorder a steer with a reset mid-turn. Retain the surviving
    // acts in their new order for the next live event. A rewind discards the rest.
    if (previous && this.turnActive) {
      this.liveTurn = new TurnLiveIndex();
      for (const item of items) if (previous.has(item.id)) this.liveTurn.put(item);
    }
    this.onWakeEligibilityChanged?.();
    this.emit({ type: 'timeline.reset', sessionId: this.id, items: items.map((i) => ({ ...i })) });
    this.onDirty(this, 'items');
    // Re-publish the effective counts after the silent load.
    this.meta.background = before;
    this.meta.commands = commands;
    Object.assign(this.meta, { serving, servingSince, servingAddress });
    this.publishTaskCounts();
  }

  notice(variant: NoticeItem['variant'], text: string, detail?: string, parentId?: string) {
    return this.add<NoticeItem>({ type: 'notice', variant, text, detail, parentId });
  }

  // ── metadata ──

  update(patch: Partial<SessionMeta>) {
    if (patch.title !== undefined && patch.title !== this.meta.title && this.meta.titleAuthored && !('titleAuthored' in patch)) patch = { ...patch, titleAuthored: undefined };
    const changed: Partial<SessionMeta> = {};
    for (const [k, v] of Object.entries(patch) as [keyof SessionMeta, never][]) {
      if (JSON.stringify(this.meta[k]) !== JSON.stringify(v)) {
        (this.meta as unknown as Record<string, unknown>)[k] = v;
        (changed as Record<string, unknown>)[k] = v;
      }
    }
    if (!Object.keys(changed).length) return;
    if ('commands' in changed || 'background' in changed || 'spare' in changed || 'accountId' in changed || 'status' in changed || 'lossWake' in changed) this.onWakeEligibilityChanged?.();
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

  private dropLive() {
    clearTimeout(this.liveTimer);
    this.liveTimer = undefined;
    this.liveTurn = undefined;
    this.publishedLive = undefined;
    this.nextHead = undefined;
  }

  private liveItem(item: TimelineItem, added: boolean) {
    if (!this.liveTurn) {
      // Providers may add/take the message immediately before beginTurn.
      if (added && item.type === 'user' && !item.parentId && item.state !== 'queued') this.nextHead = item;
      else if (SessionRuntime.endsTurn(item)) this.nextHead = undefined;
      return;
    }
    if (!added && !this.liveTurn.has(item.id)) return;
    this.liveTurn.put(item);
    this.refreshLive();
  }

  private refreshLive() {
    if (!this.liveTurn) return;
    const live = turnLive(this.liveTurn, this.turnStartedAt, this.permissions.size + this.questions.size > 0);
    if (!live) {
      this.finishLive();
      this.update({ live: undefined });
      return;
    }
    this.meta.live = live; // hello/snapshot always sees the current counts, even between broadcasts.
    const previous = this.publishedLive;
    if (previous && previous.doing === live.doing && previous.checkpoints === live.checkpoints && previous.startedAt === live.startedAt) {
      if (previous.files === live.files && previous.steps === live.steps && previous.checkpointSteps === live.checkpointSteps &&
          previous.checkpointAt === live.checkpointAt && previous.doingCount === live.doingCount) return;
      const delay = this.livePublishedAt + 1000 - Date.now();
      if (delay > 0) {
        this.liveTimer ??= setTimeout(() => { this.liveTimer = undefined; this.refreshLive(); }, delay);
        return;
      }
    }
    this.publishLive();
  }

  private publishLive() {
    clearTimeout(this.liveTimer);
    this.liveTimer = undefined;
    this.livePublishedAt = Date.now();
    this.publishedLive = this.meta.live;
    this.emit({ type: 'session.updated', id: this.id, patch: { live: this.meta.live } });
  }

  private finishLive() {
    // The result notification reads the final file count, even if the last edit
    // settled inside the coalescing interval.
    if (this.liveTimer && this.meta.live?.files !== this.publishedLive?.files) this.publishLive();
    clearTimeout(this.liveTimer);
    this.liveTimer = undefined;
    this.publishedLive = undefined;
  }

  /**
   * `keepHold`: the agent begins this turn by itself (it read a message withdrawn at a stop after all,
   * a background task woke it): a stop's hold on the queue stays through it, so its end sends nothing
   * queued either, until the person sends something.
   */
  beginTurn(activity?: string, opts: { keepHold?: boolean } = {}) {
    if (this.canBeginTurn?.() === false) return;
    const hold = !!opts.keepHold && this.stopped && !this.turnActive;
    this.turnActive = true;
    this.turnStartedAt = Date.now();
    this.liveTurn ??= new TurnLiveIndex();
    if (this.nextHead) this.liveTurn.put(this.nextHead);
    this.nextHead = undefined;
    this.stopped = hold;
    this.carried = hold;
    // An undecided background card can be taken over by the person's refusal in this turn.
    if (!opts.keepHold && this.limitCard) {
      const limit = this.get<NoticeItem>(this.limitCard)?.limit;
      if (!limit || limit.provider || limit.continuedWith) this.limitCard = undefined;
    }
    this.setSuggestion(undefined);
    this.update({ status: 'running', lastError: undefined, activity, updatedAt: Date.now() });
    this.refreshLive();
    this.onTurnStart?.(this);
  }

  /** The person sent a message into the running turn: a hold it carries from an earlier stop is theirs to lift. */
  personSent() {
    if (!this.carried) return;
    this.carried = false;
    this.stopped = false;
    this.onWakeEligibilityChanged?.();
  }

  endTurn(error?: string, opts?: { hold?: boolean; backgroundLimit?: boolean }) {
    this.finishLive();
    this.dropLive();
    this.turnActive = false;
    this.carried = false;
    this.clearSteerWaits();
    this.steeredDelegateSteps.clear();
    this.cancelPrompts(true);
    this.update({ status: error ? 'error' : 'idle', live: undefined, lastError: error, activity: undefined, updatedAt: Date.now() });
    this.onTurnEnd?.(this, error, this.unreadQueueHeld ? { ...opts, hold: true } : opts);
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
    this.refreshLive();
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

  ask(questions: Question[], itemId?: string, signal?: AbortSignal, delegateId?: string): Promise<Record<string, string[]> | null> {
    const request: QuestionRequest = { id: randomUUID(), sessionId: this.id, itemId, ...(delegateId && { delegateId }), questions, createdAt: Date.now() };
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

  cancelPrompts(keepDelegates = false) {
    const keep = (delegateId?: string) => keepDelegates && delegateId !== undefined && this.delegates.has(delegateId);
    for (const p of [...this.permissions.values()]) if (!keep(p.request.delegateId)) p.resolve(null);
    for (const q of [...this.questions.values()]) if (!keep(q.request.delegateId)) q.resolve(null);
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
    const independent = this.delegates.size && this.subtree(this.delegates.keys());
    for (const item of this.items) {
      if (independent && independent.has(item.id) || only && !only(item)) continue;
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
    // A separate delegate process can still be confirming its interrupt after its parent died.
    if (!live) roots.push(...this.delegates.keys());
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

  /** The first root act after the last end record. Informational notices can arrive at rest. */
  private lastTurnStart(): number {
    // Nothing after the last end: no turn is open, and whatever still runs is older than any.
    let start = Infinity;
    for (let k = this.items.length - 1; k >= 0; k--) {
      const i = this.items[k];
      if (i.parentId) continue;
      if (SessionRuntime.endsTurn(i)) break;
      if (i.type !== 'notice') start = i.ts;
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
   * open and only when the timeline has work after its last end record.
   * Mark what ran in the background first (`stopBackground`, `tasksLost`): this settles steps only.
   */
  cutTurn(reason: 'died' | 'closed' | 'restart', opts: { at?: number; detail?: string } = {}) {
    const at = opts.at ?? Date.now();
    const open = this.turnActive;
    this.settleSteps('cancelled', { at }, false);
    if (!open && (reason !== 'restart' || this.lastTurnStart() === Infinity)) return;
    const detail = opts.detail?.trim() ? `${CUT_DETAIL[reason]}\n\n${opts.detail.trim()}` : CUT_DETAIL[reason];
    this.add<NoticeItem>({ type: 'notice', variant: 'info', text: 'Ended early', detail, early: reason, ts: at });
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

export function autoTitle(text: string, authored = false): string {
  // What the agent's harness writes in the person's place reads by its plain words, never as tags.
  const line =
    userItemText({ type: 'user', text, authored })
      .replace(/```[\s\S]*?```/g, ' ')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? 'New session';
  const clean = line.replace(/\s+/g, ' ').replace(/^[#>*\-\s]+/, '').trim();
  if (!clean) return 'New session';
  return clean.length > 56 ? clean.slice(0, 54).trimEnd() + '…' : clean;
}
