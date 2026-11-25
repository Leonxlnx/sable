/**
 * A tiny scripting DSL for the demo provider. A `Script` wraps one turn on a
 * SessionRuntime and offers agent-shaped verbs (think, say, read, edit, bash…) that
 * stream into the timeline with realistic pacing, honour the permission mode and keep
 * usage numbers moving. Every write checks the abort signal first, so an interrupt
 * stops a scenario at the very next step without leaking items into the timeline.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SessionRuntime } from '../core/runtime';
import type {
  FileDiff,
  RateLimit,
  NoticeItem,
  PermissionOption,
  PermissionRequest,
  Question,
  SessionUsage,
  TextItem,
  ThinkingItem,
  Todo,
  ToolDetail,
  ToolItem,
  ToolKind,
  ToolResult,
  TurnItem,
  UserItem,
} from '../../shared/protocol';
import { makeFileDiff } from '../../shared/diff';
import { WIDGET_SERVER, WIDGET_SHOWN, WIDGET_TOOL_ID } from './widget-tool';
import { BROWSER_TOOLS, cleanToolInput, describeBrowser, runBrowserTool, type BrowserOp, type BrowserToolResult } from './browser-tool';

// ───────────────────────────── control-flow signals ─────────────────────────────

/** The turn was interrupted; the provider has already settled the timeline. */
/** What the live line says while a Browser tab tool runs. */
const BROWSER_ACTIVITY: Partial<Record<BrowserOp, string>> = {
  open: 'Opening the page',
  read: 'Reading the page',
  snapshot: 'Reading the page',
  click: 'Clicking',
  type: 'Typing',
  press: 'Pressing a key',
  scroll: 'Scrolling the page',
  eval: 'Running a script in the page',
  logs: "Reading the page's log",
  wait: 'Waiting for the page',
  navigate: 'Loading the page',
  sign_in: 'Signing in',
};

export class Aborted extends Error {
  constructor() {
    super('Scenario aborted');
    this.name = 'Aborted';
  }
}

/** A prompt was dismissed without an answer (null): stop quietly. */
export class Halt extends Error {
  constructor() {
    super('Prompt dismissed');
    this.name = 'Halt';
  }
}

/** The user denied a gated tool; the provider reacts in text and ends the turn. */
export class Denied extends Error {
  constructor(
    /** e.g. "the edit to `src/auth/middleware.ts`" */
    public subject: string,
    public feedback?: string,
  ) {
    super(`Denied: ${subject}`);
    this.name = 'Denied';
  }
}

// ─────────────────────────────────── helpers ───────────────────────────────────

export const CONTEXT_WINDOW = 200_000;
/** System prompt + tool definitions + memory: what a fresh session already holds. */
export const BASE_CONTEXT = 20_000;

export function between(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Splits text into 1–4 word chunks whose concatenation is exactly the input — the UI
 * rebuilds text from deltas, so nothing may be lost or added.
 */
export function chunkText(text: string): string[] {
  const tokens = text.split(/(?<=\s)(?=\S)/);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const r = Math.random();
    const n = r < 0.35 ? 1 : r < 0.7 ? 2 : r < 0.9 ? 3 : 4;
    out.push(tokens.slice(i, i + n).join(''));
    i += n;
  }
  return out;
}

/** Smallest line range that differs between two texts — what an Edit call would carry. */
export function changedRegion(before: string, after: string): { oldText: string; newText: string } {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  return { oldText: a.slice(start, endA + 1).join('\n'), newText: b.slice(start, endB + 1).join('\n') };
}

const posix = (p: string) => p.replace(/\\/g, '/');

export type OutLine = string | [line: string, delayMs: number];

export interface Pricing {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  /** Multiplier on streaming delays (smaller models type faster). */
  pace: number;
}

export interface ScriptEnv {
  rt: SessionRuntime;
  signal: AbortSignal;
  /** 1 = realistic pacing, 0 = no delays at all. */
  speed: number;
  pricing: Pricing;
  /** Permission keys granted with an "always" option for this session. */
  allowed: Set<string>;
  /** Whether thinking blocks are shown (off at minimal effort). */
  thinking: boolean;
  /** A plan window this account just reached (a sub-agent on another model hit its weekly limit). */
  onLimit?: (limit: RateLimit) => void;
}

export interface ToolSpec {
  name: string;
  kind: ToolKind;
  title: string;
  detail?: ToolDetail;
  input?: unknown;
  parentId?: string;
  /** Stream the JSON input through `inputText` before the call starts. */
  streamInput?: boolean;
}

interface Common {
  parentId?: string;
  activity?: string;
}

// ──────────────────────────────────── Script ────────────────────────────────────

export class Script {
  readonly rt: SessionRuntime;
  readonly startedAt = Date.now();
  private usage: SessionUsage;
  private turnIn = 0;
  private turnOut = 0;
  private turnCost = 0;
  private sinceFlush = 0;
  /** Messages steered into this turn, answered at the next step. */
  private steers: UserItem[] = [];
  private steerReady = new WeakMap<UserItem, Promise<boolean>>();
  private answering = false;

  constructor(private env: ScriptEnv) {
    this.rt = env.rt;
    const u = env.rt.meta.usage;
    this.usage = {
      ...u,
      contextTokens: u.contextTokens ?? BASE_CONTEXT,
      contextWindow: u.contextWindow ?? CONTEXT_WINDOW,
      cacheReadTokens: u.cacheReadTokens ?? 0,
      costUsd: u.costUsd ?? 0,
    };
  }

  get cwd() {
    return this.rt.meta.cwd;
  }

  get mode() {
    return this.rt.meta.mode;
  }

  get aborted() {
    return this.env.signal.aborted;
  }

  /**
   * A session in a lane (a worktree Sable made for it, core/lanes.ts) gets its edits for real, so a
   * lane or a race has work to compare, land or discard. Only ever inside that lane, and only where
   * the file is missing or still reads as the script's `before` (a scenario that writes its own
   * files for real, or a file of the person's, is left as it is).
   */
  private applyInLane(abs: string, content: string, before: string | null) {
    const lane = this.rt.meta.lane;
    if (!lane) return;
    const rel = path.relative(path.resolve(lane.path), path.resolve(abs));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    try {
      if (existsSync(abs) && (before === null || readFileSync(abs, 'utf8') !== before)) return;
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    } catch {
      /* the scripted turn goes on */
    }
  }

  abs(rel: string) {
    return path.join(this.cwd, rel);
  }

  check() {
    if (this.env.signal.aborted) throw new Aborted();
  }

  // ── time ──

  /** Abort-aware sleep scaled by `speed`. At speed 0 it still yields to the event loop. */
  sleep(ms: number): Promise<void> {
    this.check();
    const delay = ms * this.env.speed;
    const signal = this.env.signal;
    return new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let immediate: NodeJS.Immediate | undefined;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        if (immediate) clearImmediate(immediate);
        reject(new Aborted());
      };
      const done = () => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(new Aborted());
        else resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (delay >= 1) timer = setTimeout(done, delay);
      else immediate = setImmediate(done);
    });
  }

  pause(min: number, max = min) {
    return this.sleep(between(min, max));
  }

  // ── session meta ──

  activity(text: string) {
    this.check();
    this.rt.update({ activity: text });
  }

  setMode(mode: string) {
    this.check();
    this.rt.update({ mode });
  }

  notice(variant: NoticeItem['variant'], text: string, detail?: string, parentId?: string) {
    this.check();
    return this.rt.notice(variant, text, detail, parentId);
  }

  /** This account reached a plan window (said like a turn's rate-limit event). */
  limitReached(limit: RateLimit) {
    this.check();
    this.env.onLimit?.(limit);
  }

  patchTool(id: string, patch: Partial<ToolItem>) {
    this.check();
    this.rt.patch<ToolItem>(id, patch);
  }

  // ── usage accounting ──

  /** One model request: the whole context is re-read, mostly from cache. */
  step() {
    const ctx = this.usage.contextTokens ?? BASE_CONTEXT;
    const fresh = Math.min(ctx, Math.round(between(350, 1400)));
    const cached = ctx - fresh;
    this.usage.inputTokens += fresh;
    this.usage.cacheReadTokens = (this.usage.cacheReadTokens ?? 0) + cached;
    this.turnIn += ctx;
    this.addCost((fresh * this.env.pricing.input + cached * this.env.pricing.cacheRead) / 1e6);
  }

  private addCost(usd: number) {
    this.turnCost += usd;
    this.usage.costUsd = (this.usage.costUsd ?? 0) + usd;
  }

  private countOut(text: string) {
    const t = Math.max(1, Math.round(text.length / 4));
    this.usage.outputTokens += t;
    this.turnOut += t;
    this.addContext(t);
    this.addCost((t * this.env.pricing.output) / 1e6);
    if (++this.sinceFlush >= 40) this.flush();
  }

  addContext(tokens: number) {
    const window = this.usage.contextWindow ?? CONTEXT_WINDOW;
    this.usage.contextTokens = Math.min(Math.round(window * 0.95), (this.usage.contextTokens ?? BASE_CONTEXT) + tokens);
  }

  setContext(tokens: number) {
    this.usage.contextTokens = tokens;
    this.flush();
  }

  get contextTokens() {
    return this.usage.contextTokens ?? BASE_CONTEXT;
  }

  flush() {
    this.sinceFlush = 0;
    if (this.aborted) return;
    this.rt.update({ usage: { ...this.usage, costUsd: Math.round((this.usage.costUsd ?? 0) * 10_000) / 10_000 } });
  }

  // ── streaming text ──

  private async stream(id: string, field: 'text' | 'inputText' | 'output', text: string, min: number, max: number) {
    const pace = this.env.pricing.pace;
    for (const chunk of chunkText(text)) {
      this.check();
      this.rt.delta(id, field, chunk);
      this.countOut(chunk);
      let d = between(min, max) * pace;
      if (/[.!?]["')*`]*\s+$/.test(chunk)) d += between(70, 180);
      else if (/\n\s*$/.test(chunk)) d += between(25, 110);
      await this.sleep(d);
    }
  }

  // ── steering ──

  /** A message sent into the running turn: answered at the next step, then the work goes on. */
  steer(item: UserItem) {
    this.steers.push(item);
    const committed = this.rt.persistInput?.();
    if (committed) {
      // The simulated next step follows admission, just as a native replay follows the write.
      this.steerReady.set(item, committed.then(() => new Promise<boolean>(resolve => setImmediate(resolve, true)), () => false));
    }
    return committed;
  }

  /** Steered messages the turn ended before taking (the session sends them next). */
  takeSteers(): UserItem[] {
    return this.steers.splice(0);
  }

  /** Every model step starts here: take steered messages first and answer them in a short text. */
  private async answerSteers() {
    if (this.answering || !this.steers.length) return;
    this.answering = true;
    try {
      while (this.steers.length) {
        this.check();
        const item = this.steers.shift()!;
        const ready = this.steerReady.get(item);
        if (ready && !await ready) continue;
        this.check();
        if (!this.rt.get(item.id)) continue;
        this.rt.taken(item.id);
        this.step();
        await this.sayNow(steerReply(item.text));
      }
    } finally {
      this.answering = false;
    }
  }

  async think(text: string, parentId?: string) {
    if (!this.env.thinking) return;
    await this.answerSteers();
    this.check();
    this.activity('Thinking');
    const item = this.rt.add<ThinkingItem>({ type: 'thinking', text: '', streaming: true, parentId });
    await this.stream(item.id, 'text', text, 8, 24);
    this.check();
    this.rt.patch<ThinkingItem>(item.id, { streaming: false, endedAt: Date.now() });
    this.flush();
  }

  async say(text: string, parentId?: string) {
    await this.answerSteers();
    return this.sayNow(text, parentId);
  }

  private async sayNow(text: string, parentId?: string) {
    this.check();
    const item = this.rt.add<TextItem>({ type: 'text', text: '', streaming: true, parentId });
    await this.stream(item.id, 'text', text, 12, 40);
    this.check();
    this.rt.patch<TextItem>(item.id, { streaming: false });
    this.flush();
    return item.id;
  }

  // ── tools: low level ──

  async tool(spec: ToolSpec): Promise<string> {
    await this.answerSteers();
    this.check();
    const item = this.rt.add<ToolItem>({
      type: 'tool',
      name: spec.name,
      kind: spec.kind,
      title: spec.title,
      status: 'pending',
      detail: spec.detail ?? {},
      input: spec.streamInput ? undefined : spec.input,
      parentId: spec.parentId,
    });
    if (spec.streamInput && spec.input !== undefined) {
      const json = JSON.stringify(spec.input);
      for (let i = 0; i < json.length; ) {
        const n = Math.round(between(14, 56));
        const part = json.slice(i, i + n);
        this.check();
        this.rt.delta(item.id, 'inputText', part);
        this.countOut(part);
        i += n;
        await this.sleep(between(10, 26) * this.env.pricing.pace);
      }
      this.check();
      this.rt.patch<ToolItem>(item.id, { input: spec.input });
    } else {
      this.countOut(JSON.stringify(spec.input ?? {}));
      await this.pause(60, 170);
    }
    return item.id;
  }

  /**
   * A show_widget call, the way an agent sends it: the input streams in as JSON (title first,
   * then the code, in larger chunks than prose), then the call completes. The timeline shows it
   * as the widget itself.
   */
  async widget(title: string, code: string, opts: { parentId?: string; whole?: boolean } = {}): Promise<string> {
    await this.answerSteers();
    this.check();
    const input = { title, code };
    this.activity(title);
    if (opts.whole) {
      // As real agents usually deliver it: the call arrives complete, in one piece.
      const json = JSON.stringify(input);
      const item = this.rt.add<ToolItem>({ type: 'tool', name: WIDGET_TOOL_ID, kind: 'widget', title, status: 'running', detail: {}, inputText: json, input, parentId: opts.parentId });
      this.countOut(json);
      await this.pause(30, 60);
      this.complete(item.id, { text: WIDGET_SHOWN });
      return item.id;
    }
    const item = this.rt.add<ToolItem>({ type: 'tool', name: WIDGET_TOOL_ID, kind: 'widget', title, status: 'pending', detail: {}, inputText: '', parentId: opts.parentId });
    const json = JSON.stringify(input);
    for (let i = 0; i < json.length; ) {
      const n = Math.round(between(60, 150));
      const part = json.slice(i, i + n);
      this.check();
      this.rt.delta(item.id, 'inputText', part);
      this.countOut(part);
      i += n;
      await this.sleep(between(16, 34) * this.env.pricing.pace);
    }
    this.check();
    this.rt.patch<ToolItem>(item.id, { input, status: 'running' });
    await this.pause(60, 140);
    this.complete(item.id, { text: WIDGET_SHOWN });
    return item.id;
  }

  /**
   * A Browser tab tool call through the same code path the real agents' tools take
   * (browser-tool.ts: the window's answer, the permission prompt for pages that are not local).
   */
  async browser(op: BrowserOp, input: Record<string, unknown>, opts: Common = {}): Promise<BrowserToolResult> {
    const name = `mcp__${WIDGET_SERVER}__${BROWSER_TOOLS[op]}`;
    const view = describeBrowser(name, input);
    if (!opts.parentId) this.activity(opts.activity ?? BROWSER_ACTIVITY[op] ?? 'Looking at the page');
    const id = await this.tool({ name, ...view, input: cleanToolInput(name, input) as Record<string, unknown>, parentId: opts.parentId });
    this.start(id);
    const r = await runBrowserTool(this.rt, op, input, this.env.signal);
    this.check();
    const result: ToolResult = { text: r.text, ...(r.ok ? {} : { isError: true }), ...(r.image ? { images: [r.image.dataUrl] } : {}) };
    if (this.rt.get<ToolItem>(id)?.status === 'denied') {
      this.rt.patch<ToolItem>(id, { result, endedAt: Date.now() });
      this.step();
    } else this.complete(id, result, r.ok ? 'done' : 'error');
    return r;
  }

  start(id: string) {
    this.check();
    this.rt.patch<ToolItem>(id, { status: 'running' });
  }

  async output(id: string, lines: OutLine[]) {
    for (const entry of lines) {
      const [line, delay] = typeof entry === 'string' ? [entry, between(25, 90)] : entry;
      this.check();
      this.rt.delta(id, 'output', line + '\n');
      await this.sleep(delay);
    }
  }

  complete(id: string, result: ToolResult, status: 'done' | 'error' | 'cancelled' = 'done') {
    this.check();
    this.rt.patch<ToolItem>(id, { status, result, endedAt: Date.now() });
    const size = (result.text?.length ?? 0) + (result.file?.content?.length ?? 0) + (result.stderr?.length ?? 0);
    this.addContext(Math.round(size / 4) + 60);
    this.step();
    this.flush();
  }

  // ── permissions ──

  /** Whether a tool of this class needs approval under the current mode. */
  needsApproval(kind: 'edit' | 'bash', key: string): boolean {
    const mode = this.mode;
    if (mode === 'bypassPermissions') return false;
    if (this.env.allowed.has(key)) return false;
    if (kind === 'bash') return true;
    return mode !== 'acceptEdits';
  }

  /** Raw permission prompt; returns the chosen option. Throws Halt when dismissed. */
  async requestPermission(
    id: string,
    req: Omit<PermissionRequest, 'id' | 'sessionId' | 'createdAt' | 'itemId'>,
  ): Promise<{ option: PermissionOption; message?: string }> {
    this.check();
    this.rt.patch<ToolItem>(id, { status: 'awaiting' });
    this.activity('Waiting for approval');
    const answer = await this.rt.requestPermission({ allowFeedback: true, ...req, itemId: id }, this.env.signal);
    this.check();
    if (!answer) throw new Halt();
    const option = req.options.find((o) => o.id === answer.optionId) ?? {
      id: answer.optionId,
      label: answer.optionId,
      tone: /allow|yes|approve/i.test(answer.optionId) ? ('allow' as const) : ('deny' as const),
    };
    return { option, message: answer.message?.trim() || undefined };
  }

  /** Asks the user structured questions; null means dismissed (throws if interrupted). */
  async ask(questions: Question[], itemId: string): Promise<Record<string, string[]> | null> {
    this.check();
    this.rt.patch<ToolItem>(itemId, { status: 'awaiting' });
    this.activity('Waiting for your answers');
    const answers = await this.rt.ask(questions, itemId, this.env.signal);
    this.check();
    return answers;
  }

  /** Gates a tool: allow → continue, always → remember `key`, deny → throw Denied. */
  async gate(
    id: string,
    key: string,
    subject: string,
    req: Omit<PermissionRequest, 'id' | 'sessionId' | 'createdAt' | 'itemId'>,
  ) {
    const { option, message } = await this.requestPermission(id, req);
    if (option.tone === 'deny') {
      this.rt.patch<ToolItem>(id, {
        status: 'denied',
        endedAt: Date.now(),
        result: { text: message ? `Denied with feedback: ${message}` : 'Denied by user', isError: true },
      });
      throw new Denied(subject, message);
    }
    if (option.tone === 'always') this.env.allowed.add(key);
    this.rt.patch<ToolItem>(id, { status: 'pending' });
  }

  // ── tools: agent verbs ──

  async read(rel: string, content: string, opts: Common & { range?: [number, number] } = {}) {
    const abs = this.abs(rel);
    const all = content.replace(/\n$/, '').split('\n');
    const [from, to] = opts.range ?? [1, all.length];
    if (!opts.parentId) this.activity(opts.activity ?? `Reading ${path.basename(rel)}`);
    const id = await this.tool({
      name: 'Read',
      kind: 'read',
      title: `Read ${path.basename(rel)}`,
      detail: { path: abs, range: opts.range },
      input: opts.range ? { file_path: abs, offset: from, limit: to - from + 1 } : { file_path: abs },
      parentId: opts.parentId,
    });
    this.start(id);
    await this.pause(120, 320);
    const slice = all.slice(from - 1, to).join('\n') + '\n';
    this.complete(id, { file: { path: abs, content: slice, startLine: from, numLines: to - from + 1, totalLines: all.length } });
    return id;
  }

  /** Several reads issued in one assistant message, completing out of order. */
  async readMany(files: { rel: string; content: string }[], opts: Common = {}) {
    if (!opts.parentId) this.activity(opts.activity ?? `Reading ${files.map((f) => path.basename(f.rel)).join(', ')}`);
    const ids: string[] = [];
    for (const f of files) {
      const abs = this.abs(f.rel);
      ids.push(
        await this.tool({
          name: 'Read',
          kind: 'read',
          title: `Read ${path.basename(f.rel)}`,
          detail: { path: abs },
          input: { file_path: abs },
          parentId: opts.parentId,
        }),
      );
    }
    ids.forEach((id) => this.start(id));
    for (let i = files.length - 1; i >= 0; i--) {
      await this.pause(110, 260);
      const abs = this.abs(files[i].rel);
      const lines = files[i].content.replace(/\n$/, '').split('\n');
      this.complete(ids[i], { file: { path: abs, content: files[i].content, startLine: 1, numLines: lines.length, totalLines: lines.length } });
    }
    return ids;
  }

  async glob(pattern: string, files: string[], opts: Common = {}) {
    if (!opts.parentId) this.activity(opts.activity ?? `Finding files matching ${pattern}`);
    const id = await this.tool({
      name: 'Glob',
      kind: 'glob',
      title: `Find ${pattern}`,
      detail: { pattern, path: this.cwd },
      input: { pattern },
      parentId: opts.parentId,
    });
    this.start(id);
    await this.pause(90, 220);
    this.complete(id, { files, count: files.length, text: files.join('\n') });
    return id;
  }

  async grep(pattern: string, matches: string[], opts: Common & { glob?: string; path?: string } = {}) {
    if (!opts.parentId) this.activity(opts.activity ?? `Searching for ${pattern}`);
    const id = await this.tool({
      name: 'Grep',
      kind: 'search',
      title: `Search for ${pattern}`,
      detail: { pattern, glob: opts.glob, path: opts.path ? this.abs(opts.path) : this.cwd },
      input: { pattern, ...(opts.path ? { path: opts.path } : {}), ...(opts.glob ? { glob: opts.glob } : {}), output_mode: 'content', '-n': true },
      parentId: opts.parentId,
    });
    this.start(id);
    await this.pause(140, 340);
    const files = [...new Set(matches.map((m) => m.split(':')[0]))];
    this.complete(id, { text: matches.length ? matches.join('\n') : 'No matches found', count: matches.length, files });
    return id;
  }

  async edit(rel: string, before: string, after: string, opts: Common & { description?: string } = {}) {
    const abs = this.abs(rel);
    const base = path.basename(rel);
    const diff = makeFileDiff(posix(rel), before, after);
    const { oldText, newText } = changedRegion(before, after);
    if (!opts.parentId) this.activity(opts.activity ?? `Editing ${base}`);
    const id = await this.tool({
      name: 'Edit',
      kind: 'edit',
      title: `Edit ${base}`,
      detail: { path: abs, oldText, newText, description: opts.description },
      input: { file_path: abs, old_string: oldText, new_string: newText },
      streamInput: true,
      parentId: opts.parentId,
    });
    await this.gateEdit(id, `Edit ${posix(rel)}`, `the edit to \`${posix(rel)}\``, opts.description, { path: abs, oldText, newText }, diff);
    this.start(id);
    await this.pause(80, 200);
    this.applyInLane(abs, after, before);
    this.complete(id, { diff: [diff], text: `Updated ${posix(rel)}: ${diff.additions} additions, ${diff.deletions} deletions` });
    return diff;
  }

  async write(rel: string, content: string, opts: Common & { description?: string } = {}) {
    const abs = this.abs(rel);
    const diff = makeFileDiff(posix(rel), null, content);
    if (!opts.parentId) this.activity(opts.activity ?? `Writing ${path.basename(rel)}`);
    const id = await this.tool({
      name: 'Write',
      kind: 'write',
      title: `Write ${path.basename(rel)}`,
      detail: { path: abs, content, description: opts.description },
      input: { file_path: abs, content },
      streamInput: true,
      parentId: opts.parentId,
    });
    await this.gateEdit(id, `Create ${posix(rel)}`, `creating \`${posix(rel)}\``, opts.description, { path: abs, content }, diff);
    this.start(id);
    await this.pause(70, 160);
    this.applyInLane(abs, content, null);
    this.complete(id, { diff: [diff], text: `Created ${posix(rel)} (${diff.additions} lines)` });
    return diff;
  }

  private async gateEdit(id: string, title: string, subject: string, description: string | undefined, detail: ToolDetail, diff: FileDiff) {
    if (!this.needsApproval('edit', 'edit')) return;
    await this.gate(id, 'edit', subject, {
      toolName: diff.status === 'added' ? 'Write' : 'Edit',
      kind: diff.status === 'added' ? 'write' : 'edit',
      title,
      description,
      detail,
      diff: [diff],
      options: [
        { id: 'allow', label: 'Allow edit', tone: 'allow' },
        { id: 'always', label: 'Allow all edits this session', tone: 'always' },
        { id: 'deny', label: 'Deny', tone: 'deny' },
      ],
    });
  }

  async bash(
    command: string,
    opts: Common & {
      description: string;
      lines?: OutLine[];
      exitCode?: number;
      stderr?: string;
      /** Read-only commands (git status, ls…) never ask. */
      readonly?: boolean;
      /** Permission key, e.g. "npm test"; defaults to the first two words. */
      key?: string;
      startDelay?: number;
    },
  ): Promise<{ exitCode: number; output: string }> {
    const key = `bash:${opts.key ?? command.split(/\s+/).slice(0, 2).join(' ')}`;
    const label = key.slice(5);
    const id = await this.tool({
      name: 'Bash',
      kind: 'bash',
      title: opts.description,
      detail: { command, description: opts.description, cwd: this.cwd },
      input: { command, description: opts.description },
      parentId: opts.parentId,
    });
    if (!opts.readonly && this.needsApproval('bash', key)) {
      await this.gate(id, key, `running \`${command}\``, {
        toolName: 'Bash',
        kind: 'bash',
        title: command,
        description: opts.description,
        detail: { command, description: opts.description, cwd: this.cwd },
        options: [
          { id: 'allow', label: 'Allow once', tone: 'allow' },
          { id: 'always', label: `Always allow ${label}`, hint: 'for the rest of this session', tone: 'always' },
          { id: 'deny', label: 'Deny', tone: 'deny' },
        ],
      });
    }
    if (!opts.parentId) this.activity(opts.activity ?? opts.description);
    this.start(id);
    await this.pause(opts.startDelay ?? 180);
    const lines = opts.lines ?? [];
    await this.output(id, lines);
    const exitCode = opts.exitCode ?? 0;
    const output = lines.map((l) => (typeof l === 'string' ? l : l[0])).join('\n');
    if (opts.stderr) {
      await this.pause(80);
      this.check();
      this.rt.delta(id, 'output', opts.stderr.endsWith('\n') ? opts.stderr : opts.stderr + '\n');
    }
    this.complete(
      id,
      { text: output, stderr: opts.stderr, exitCode, isError: exitCode !== 0 || undefined },
      exitCode === 0 ? 'done' : 'error',
    );
    return { exitCode, output };
  }

  async todos(todos: Todo[]) {
    this.check();
    this.rt.setTodos(todos.map((t) => ({ ...t })));
    const id = await this.tool({
      name: 'TodoWrite',
      kind: 'todo',
      title: 'Update todos',
      detail: { todos: todos.map((t) => ({ ...t })) },
      input: { todos },
    });
    this.start(id);
    await this.pause(40, 90);
    const done = todos.filter((t) => t.status === 'completed').length;
    this.complete(id, { text: `Todos updated (${done}/${todos.length} completed)` });
  }

  async websearch(query: string, links: { title: string; url: string }[], summary: string, opts: Common = {}) {
    if (!opts.parentId) this.activity(opts.activity ?? `Searching the web for “${query}”`);
    const id = await this.tool({
      name: 'WebSearch',
      kind: 'websearch',
      title: `Search the web for “${query}”`,
      detail: { query },
      input: { query },
      parentId: opts.parentId,
    });
    this.start(id);
    await this.pause(900, 1600);
    this.complete(id, { links, count: links.length, text: summary });
    return id;
  }

  async fetch(url: string, prompt: string, text: string, opts: Common = {}) {
    const host = new URL(url).host;
    if (!opts.parentId) this.activity(opts.activity ?? `Fetching ${host}`);
    const id = await this.tool({
      name: 'WebFetch',
      kind: 'fetch',
      title: `Fetch ${host}${new URL(url).pathname}`,
      detail: { url, prompt },
      input: { url, prompt },
      parentId: opts.parentId,
    });
    this.start(id);
    await this.pause(700, 1400);
    this.complete(id, { text });
    return id;
  }

  async mcp(server: string, tool: string, input: Record<string, unknown>, result: unknown, opts: Common & { title?: string } = {}) {
    if (!opts.parentId) this.activity(opts.activity ?? `Calling ${server}.${tool}`);
    const id = await this.tool({
      name: `mcp__${server}__${tool}`,
      kind: 'mcp',
      title: opts.title ?? `${server} · ${tool}`,
      detail: { server, tool },
      input,
      parentId: opts.parentId,
    });
    this.start(id);
    await this.pause(500, 1100);
    this.complete(id, { text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) });
    return id;
  }

  async skill(skill: string, args: string | undefined, text: string, opts: Common = {}) {
    if (!opts.parentId) this.activity(opts.activity ?? `Loading the ${skill} skill`);
    const id = await this.tool({
      name: 'Skill',
      kind: 'skill',
      title: `Use skill ${skill}`,
      detail: { skill, description: args },
      input: args ? { skill, args } : { skill },
      parentId: opts.parentId,
    });
    this.start(id);
    await this.pause(200, 420);
    this.complete(id, { text });
    return id;
  }

  // ── turn end ──

  finish(opts: { suggestion?: string; error?: string; stopReason?: string } = {}) {
    this.check();
    this.usage.turns += 1;
    this.flush();
    this.rt.add<TurnItem>({
      type: 'turn',
      durationMs: Date.now() - this.startedAt,
      costUsd: Math.round(this.turnCost * 10_000) / 10_000,
      inputTokens: this.turnIn,
      outputTokens: this.turnOut,
      stopReason: opts.stopReason ?? (opts.error ? 'error' : 'end_turn'),
      error: opts.error,
    });
    if (opts.suggestion && !opts.error) this.rt.setSuggestion(opts.suggestion);
  }
}

/** The demo's answer to a steered message: a plain reply, then back to work. */
export function steerReply(text: string): string {
  const m = text.match(/(-?\d+(?:\.\d+)?)\s*([+\-*x×/])\s*(-?\d+(?:\.\d+)?)/);
  if (m) {
    const [a, op, b] = [Number(m[1]), m[2], Number(m[3])];
    const v = op === '+' ? a + b : op === '-' ? a - b : op === '/' ? a / b : a * b;
    const sym = op === 'x' || op === '×' ? '×' : op;
    return `${m[1]} ${sym} ${m[3]} = ${Number.isFinite(v) ? +v.toFixed(6) : 'undefined'}. Carrying on.`;
  }
  const gist = text.replace(/\s+/g, ' ').trim();
  return `Noted: ${gist.length > 90 ? gist.slice(0, 88).trimEnd() + '…' : gist} I will take that into account as I continue.`;
}
