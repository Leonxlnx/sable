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
import { approvedShare, handFiles, type ApprovedShare } from './handed';

export type Emit = (event: BridgeEvent) => void;

/** How long a weak browser answer ("not here") waits for a window that can serve the request. */
export const BROWSER_GRACE_MS = 800;

export interface PermissionAnswer {
  optionId: string;
  message?: string;
}

/** What one of the person's messages came to, by the agent's result for it. */
export type MessageOutcome = 'ok' | 'failed' | 'stopped';

type NewItem<T extends TimelineItem> = T extends TimelineItem ? Omit<T, 'id' | 'ts'> & { id?: string; ts?: number } : never;

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

  load(items: TimelineItem[], todos: Todo[] = [], queue?: QueuedMessage[]) {
    this.dirty = 'all';
    this.items = items;
    this.todos = todos;
    if (queue) this.queue = queue;
    this.index = new Map(items.map((i) => [i.id, i]));
  }

  // ── queue ──

  private queueChanged() {
    this.emit({ type: 'queue.updated', sessionId: this.id, queue: this.queue.map((q) => ({ ...q })) });
    this.onDirty(this, 'items');
  }

  enqueue(text: string, attachments?: QueuedMessage['attachments']): QueuedMessage {
    const q: QueuedMessage = { id: randomUUID(), text, attachments: attachments?.length ? attachments : undefined, createdAt: Date.now() };
    this.queue.push(q);
    this.queueChanged();
    return q;
  }

  /** New text, and new attachments when given (empty clears them). Left empty, the message goes. */
  updateQueued(id: string, text: string, attachments?: QueuedMessage['attachments']) {
    const at = this.queue.findIndex((x) => x.id === id);
    if (at < 0) return false;
    const q = this.queue[at];
    const files = attachments === undefined ? q.attachments : attachments.length ? attachments : undefined;
    if (!text.trim() && !files?.length) {
      this.queue.splice(at, 1);
    } else {
      q.text = text;
      q.attachments = files;
    }
    this.queueChanged();
    return true;
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

  /** Takes a message out of the queue (the first one without an id). */
  takeQueued(id?: string): QueuedMessage | undefined {
    const at = id ? this.queue.findIndex((x) => x.id === id) : this.queue.length ? 0 : -1;
    if (at < 0) return undefined;
    const [q] = this.queue.splice(at, 1);
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
  }

  /** Share steps the person allowed themselves (a permission they answered with an allow), by item id: the files as they were shown. */
  private allowedShares = new Map<string, ApprovedShare>();

  /** What share step `item` hands over, captured as it goes through (core/handed.ts): outside the folder, only what the person was shown. */
  private hand(item: ToolItem) {
    const approved = this.allowedShares.get(item.id);
    this.allowedShares.delete(item.id);
    return handFiles(this.meta.cwd, item.detail?.files, approved);
  }

  /**
   * What each message of the person's came to, as its agent reported it (Claude Code: one result per
   * message, so one turn can answer one message failed and the next ok). Only one answered `ok` may
   * name a chat; a message with no word of its own goes by its turn's end. Kept until the turn's end
   * has been looked at (`forgetOutcome`).
   */
  private outcomes = new Map<string, MessageOutcome>();
  /**
   * The result that answered each such message: its TurnItem's id, or null when none of its own did
   * (it came to its turn's end), so which texts were its answer is not known (core/titles.ts).
   */
  private answers = new Map<string, string | null>();

  /** `resultId`: the TurnItem of the result that answered them (absent: none of their own). */
  answered(itemIds: readonly string[], outcome: MessageOutcome, resultId?: string) {
    for (const id of itemIds) {
      this.outcomes.delete(id);
      this.outcomes.set(id, outcome);
      this.answers.delete(id);
      this.answers.set(id, resultId ?? null);
    }
    while (this.outcomes.size > 200) this.outcomes.delete(this.outcomes.keys().next().value!);
    while (this.answers.size > 200) this.answers.delete(this.answers.keys().next().value!);
  }

  /** The TurnItem of the result that answered message `itemId`; null: answered by none of its own; undefined: its agent says nothing per message. */
  answeredBy(itemId: string): string | null | undefined {
    return this.answers.get(itemId);
  }

  outcomeOf(itemId: string): MessageOutcome | undefined {
    return this.outcomes.get(itemId);
  }

  forgetOutcome(itemId: string) {
    this.outcomes.delete(itemId);
  }

  /** Marks a message the agent has taken: a steered one stays where it was sent, a queued one moves down to here. */
  taken(id: string, patch: Partial<UserItem> = {}) {
    const item = this.index.get(id);
    if (item?.type !== 'user') return;
    if (item.steered || item.state !== 'queued') this.patch<UserItem>(id, { state: 'sent', ...patch });
    else this.move(id, { state: 'sent', ...patch } as Partial<TimelineItem>);
  }

  /** Moves a root item to the end of the timeline (a queued message once the agent takes it). */
  move(id: string, patch: Partial<TimelineItem> = {}) {
    const item = this.index.get(id);
    if (!item) return;
    const at = this.items.indexOf(item);
    if (at < 0 || at === this.items.length - 1 || item.parentId) {
      this.patch(id, patch);
      return;
    }
    Object.assign(item, patch, { ts: Date.now() });
    this.markDirty(id);
    this.items.splice(at, 1);
    this.items.push(item);
    this.emit({ type: 'item.removed', sessionId: this.id, id });
    this.emit({ type: 'item.added', sessionId: this.id, item: { ...item } });
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
  }

  reset(items: TimelineItem[]) {
    this.load(items, this.todos);
    this.emit({ type: 'timeline.reset', sessionId: this.id, items: items.map((i) => ({ ...i })) });
    this.onDirty(this, 'items');
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

  /** Settles anything left "in flight" (after an interrupt, crash or restart). */
  /**
   * Sub-agents and workflows still marked as running in the background whose agent process is gone
   * (it ended, or Sable restarted): they died with it and their end will never be reported.
   */
  stopBackground() {
    for (const item of this.items) {
      if (item.type !== 'tool') continue;
      if (item.result?.agent?.background === 'running') this.patch<ToolItem>(item.id, { result: { ...item.result, agent: { ...item.result.agent, background: 'stopped' } } });
      if (item.workflow?.status === 'running') this.patch<ToolItem>(item.id, { workflow: { ...item.workflow, status: 'stopped' } });
    }
  }

  settle(reason: 'cancelled' | 'error' = 'cancelled') {
    const keep = this.apart.size ? this.subtree(this.apart) : undefined;
    for (const item of this.items) {
      if (keep?.has(item.id)) continue;
      if ((item.type === 'text' || item.type === 'thinking') && item.streaming) {
        this.patch(item.id, { streaming: false, ...(item.type === 'thinking' ? { endedAt: Date.now() } : {}) } as Partial<TimelineItem>);
      } else if (item.type === 'tool' && (item.status === 'running' || item.status === 'pending' || item.status === 'awaiting')) {
        this.patch(item.id, { status: reason, endedAt: Date.now() } as Partial<TimelineItem>);
      }
    }
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
