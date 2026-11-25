import { DEFAULT_ACCOUNT, type BridgeEvent, type SessionMeta, type SessionSnapshot, type SnapshotCursor, type TimelineItem, type ToolItem, type ToolKind, type ToolResult, type ToolStatus } from '../../shared/protocol';
import { syntheticOf } from '../../shared/synthetic';
import { runsTask, worksInBackground } from '../../shared/background';
import { constants as bufferLimits } from 'node:buffer';

// ── what a window gets of an existing conversation ──
//
// Snapshots and resets keep what the timeline rows show. The socket and indexed disk reader
// share the old-turn rule for steps, thoughts and message attachments. A cut row carries
// `more`, and `session.item` reads the original when needed. Live work stays whole.
// The phone cuts further on its own (services/phone.ts).

/**
 * A field longer than this (characters) is cut. Below the cap Claude Code puts on a command's output
 * by default (30,000 characters), so long command output is cut too, not only reads and pictures.
 */
export const CUT_AT = 16_000;
/**
 * What a cut text keeps of its start and of its end (characters): more than an opened step shows
 * at first (300 px of output or code), so the step looks the same before its whole text arrives.
 */
export const KEEP = { head: 3_000, tail: 3_000 };
/**
 * Steps before the last few turns are rarely opened (and fetched whole in a few ms when they are):
 * they keep only a short start and end, so a chat of hundreds of megabytes reaches the window in a
 * few. The last `RECENT_TURNS` turns keep `KEEP`.
 */
export const OLD = { row: true, at: 96, head: 48, tail: 24 };
export const RECENT_TURNS = 3;
type Cut = { row?: boolean; at: number; head: number; tail: number };
const RECENT: Cut = { at: CUT_AT, head: KEEP.head, tail: KEEP.tail };
/** A cut file list keeps this many paths. */
const KEEP_FILES = 200;

export const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** The first `max` lines of a text, within `chars`, and a line saying how many more there are. */
export function lines(s: string, max: number, chars: number): string {
  const all = s.split('\n');
  const head = all.slice(0, max).join('\n');
  return cap(head, chars) + (all.length > max ? `\n… ${all.length - max} more lines` : '');
}

// Also executed by the standalone CommonJS reading worker. Pass its dependencies explicitly.
export function timelineCut(recent: Cut, keepFiles: number, taskRunning: typeof runsTask) {
  /** Where a text's start ends: at a line break near `n`, else at `n`. */
  function headEnd(s: string, n: number): number {
    const at = s.lastIndexOf('\n', n);
    return at > n / 2 ? at : n;
  }

  /** The start and the end of a long text, cut at line breaks where one is near, with a line between them. */
  function headTail(s: string, head = recent.head, tail = recent.tail): string {
    if (s.length <= head + tail) return s;
    const a = headEnd(s, head);
    const from = s.length - tail;
    const nl = s.indexOf('\n', from);
    const b = nl >= 0 && nl < from + tail / 2 ? nl + 1 : from;
    return `${s.slice(0, a)}\n…\n${s.slice(b)}`;
  }

  /** The start of a long text (a file: its lines keep their numbers), with a line saying it goes on. */
  function headOnly(s: string, head = recent.head + recent.tail): string {
    if (s.length <= head) return s;
    return `${s.slice(0, headEnd(s, head))}\n…`;
  }

  const SETTLED = new Set<ToolStatus>(['done', 'error', 'denied', 'cancelled']);
  /** Shown whole without opening them (a widget is its HTML, tasks and questions are their rows, a plan its card). */
  const WHOLE = new Set<ToolKind>(['widget', 'todo', 'question', 'plan', 'share']);

  /**
   * A step that is over and whose result will not change: one that runs, or a sub-agent or workflow
   * still at work in the background, stays whole. A turn check stays whole: its findings show without
   * opening it and go to the composer as they are.
   */
  function settled(t: TimelineItem): boolean {
    if (t.type === 'thinking') return !t.streaming;
    if (t.type === 'user') return t.state !== 'queued';
    if (t.type !== 'tool') return false;
    return SETTLED.has(t.status) && !WHOLE.has(t.kind) && !t.check && !taskRunning(t) && t.result?.agent?.background !== 'running' && t.workflow?.status !== 'running';
  }

  const size = (list: string[]) => list.reduce((n, s) => n + s.length + 3, 0);

  /**
   * A result without its bulk: long texts keep their start and end, a file read its first lines,
   * pictures go, a long file list keeps its first paths. Its diff (edits), answers and the agent's
   * figures stay as they are. The same object when nothing is long.
   */
  function cutResult(r: ToolResult, c: Cut): ToolResult {
    let out: ToolResult | undefined;
    const put = <K extends keyof ToolResult>(k: K, v: ToolResult[K]) => {
      out ??= { ...r };
      if (v === undefined) delete out[k];
      else out[k] = v;
    };
    if (r.text && r.text.length > c.at) put('text', headTail(r.text, c.head, c.tail));
    if (r.stderr && r.stderr.length > c.at) put('stderr', headTail(r.stderr, c.head, c.tail));
    if (r.file?.content && r.file.content.length > c.at) put('file', { ...r.file, content: headOnly(r.file.content, c.head + c.tail) });
    if (r.images?.length && size(r.images) > c.at) put('images', undefined);
    if (r.files && r.files.length > keepFiles && size(r.files) > c.at) put('files', r.files.slice(0, keepFiles));
    return out ?? r;
  }

  // The folded command chip and turn footer scan local URLs. Keep the announcement lines,
  // including ANSI and error context. At >48k the chip uses character offsets into the
  // original; retain that exceptional field if shortening it would change its scan window.
  function localLines(s: string): string | undefined {
    if (!s.includes('://') || !/localhost|127\.\d|0\.0\.0\.0|\[::/i.test(s)) return;
    const announcements = (part: string) => part.split('\n').filter(line => line.includes('://') && /localhost|127\.\d|0\.0\.0\.0|\[::/i.test(line)).join('\n');
    if (s.length > 48_000) {
      const head = Math.max(0, s.lastIndexOf('\n', 32_000));
      const end = s.indexOf('\n', s.length - 16_000);
      // A URL in this middle is eligible for the footer but outside the chip's scan.
      const middle = s.slice(head, end < 0 ? undefined : end);
      if (middle.includes('://') && /localhost|127\.\d|0\.0\.0\.0|\[::/i.test(middle)) {
        // Keep the chip's two scan windows at their original offsets from either end.
        // Of the intervening complete lines, only those naming a page reach the footer.
        const left = s.indexOf('\n', 32_001);
        const right = s.lastIndexOf('\n', s.length - 16_001);
        if (left < 0 || right <= left) return s;
        return s.slice(0, left + 1) + announcements(s.slice(left + 1, right)) + s.slice(right);
      }
    }
    return announcements(s) || undefined;
  }

  function oldTool(it: ToolItem, c: Cut): ToolItem {
    const out = { ...it };
    let changed = false;
    const d = it.detail;
    const legacyBackground = it.kind === 'bash' && (it.input as { run_in_background?: unknown } | undefined)?.run_in_background === true;
    if (legacyBackground && !d.background) {
      out.detail = { ...d, background: true };
      changed = true;
    }
    // A generic tool with only raw input had a disclosure caret. A one-character
    // input preview preserves it without making a detail-only or output-only row openable.
    const inputOnly = (it.input !== undefined || it.more && it.inputText === '…') && !it.result && !d.pattern && !d.query && !d.url;
    if (it.input !== undefined) { delete out.input; changed = true; }
    if (inputOnly && it.inputText !== '…') { out.inputText = '…'; changed = true; }
    else if (!inputOnly && it.inputText) { delete out.inputText; changed = true; }
    const hasUrl = it.kind === 'bash' && (d.command?.length ?? 0) > 400 && [it.output, it.result?.text].some(s => s && s.includes('://') && /localhost|127\.\d|0\.0\.0\.0|\[::/i.test(s));
    for (const k of ['command', 'oldText', 'newText', 'content', 'prompt'] as const) {
      const value = d[k];
      // Command tooltips on background rows show the full command. A command can also
      // decide whether its output is a server announcement or an HTTP client response.
      if (k === 'command' && (legacyBackground || d.background || it.task || hasUrl)) continue;
      const max = k === 'command' ? 400 : c.head;
      if (value && value.length > max) {
        if (out.detail === d) out.detail = { ...d };
        out.detail[k] = value.slice(0, max);
        changed = true;
      }
    }
    const preview = (s: string) => (it.kind === 'bash' ? localLines(s) : undefined) ?? headTail(s, c.head, c.tail);
    if (it.output && it.output.length > c.at) {
      out.output = preview(it.output);
      changed ||= out.output !== it.output;
    }
    const r = it.result;
    if (r) {
      const part = { ...r };
      for (const k of ['text', 'stderr'] as const) {
        const s = r[k];
        if (!s || s.length <= c.at) continue;
        // A failed step shows the first three lines under its folded row.
        if (it.status === 'error' && it.kind !== 'bash' && (k === 'stderr' || !r.stderr)) {
          const lines = s.trim().split('\n', 4);
          part[k] = lines.length > 3 ? lines.slice(0, 3).join('\n') + '\n…' : s;
        } else part[k] = k === 'text' ? preview(s) : headTail(s, c.head, c.tail);
      }
      if (r.file?.content && r.file.content.length > c.at) part.file = { ...r.file, content: r.file.content.slice(0, c.head) };
      if (r.images?.length && size(r.images) > c.at) delete part.images;
      if (r.files && r.files.length > 1) part.files = r.files.slice(0, 1);
      if (r.diff?.some(f => f.hunks.length)) part.diff = r.diff.map(f => f.hunks.length ? { ...f, hunks: [] } : f);
      if (Object.keys(r).some(k => r[k as keyof ToolResult] !== part[k as keyof ToolResult])) { out.result = part; changed = true; }
    }
    if (!changed) return it;
    out.more = true;
    return out;
  }

  function cutItem(it: TimelineItem, c: Cut = recent): TimelineItem {
    if (!settled(it)) return it;
    if (c.row && it.type === 'thinking' && it.text.length > 320) {
      let text = it.text.slice(0, 320);
      // The caret depends on whether the thought contains any non-space character.
      if (!text.trim() && it.text.trim()) text += it.text.trimStart()[0];
      return { ...it, text, more: true };
    }
    if (c.row && it.type === 'user' && it.attachments?.some(a => (a.dataUrl?.length ?? 0) > 1024 || (a.text?.length ?? 0) > 1024)) {
      return { ...it, more: true, attachments: it.attachments.map(a => {
        const attachment = { ...a };
        // Empty dataUrl reserves the original thumbnail; a path-only image remains a file chip.
        if (a.dataUrl && a.dataUrl.length > 1024) attachment.dataUrl = '';
        else if (a.dataUrl === '') delete attachment.dataUrl;
        if (a.text && a.text.length > 1024) delete attachment.text;
        return attachment;
      }) };
    }
    if (it.type !== 'tool') return it;
    if (c.row) return oldTool(it, c);
    let out: ToolItem | undefined;
    if (it.output && it.output.length > c.at) (out ??= { ...it }).output = headTail(it.output, c.head, c.tail);
    if (it.result) {
      const r = cutResult(it.result, c);
      if (r !== it.result) (out ??= { ...it }).result = r;
    }
    if (!out) return it;
    out.more = true;
    return out;
  }
  return { cutItem, settled, headTail, headOnly };
}
export const { cutItem, settled, headTail, headOnly } = timelineCut(RECENT, KEEP_FILES, runsTask);

/** Private indexed-row metadata for phone summaries and provider input lookups. */
export const LIGHT = '\0sable.baseStep';
type LightItem = Extract<TimelineItem, { type: 'tool' | 'thinking' | 'user' }> & { [LIGHT]: { recent?: true; reread?: true; pictures: number; hunks: boolean; input?: true; legacyBackground?: true } };
export function isLight(item: Partial<TimelineItem>): item is LightItem {
  return Object.hasOwn(item, LIGHT);
}

export function recentStart(items: TimelineItem[], turns: number): number {
  for (let i = items.length - 1, seen = 0; i >= 0; i--) {
    if (items[i].type === 'turn' && ++seen > turns) return i + 1;
  }
  return 0;
}

export const workerCut = {
  factory: timelineCut.toString(), task: runsTask.toString(),
  recent: RECENT, old: OLD, keepFiles: KEEP_FILES, turns: RECENT_TURNS, mark: LIGHT,
};

/** The old disk-backed steps already have exactly the window's cut. */
export function cutItems(items: TimelineItem[], whole?: (item: TimelineItem) => TimelineItem, from = recentStart(items, RECENT_TURNS)): TimelineItem[] {
  return items.map((item, i) => windowItem(item, i >= from, whole));
}

function windowItem(item: TimelineItem, recent: boolean, whole?: (item: TimelineItem) => TimelineItem): TimelineItem {
  if (isLight(item)) {
    if (whole && (!settled(item) || recent !== !!item[LIGHT].recent)) return cutItem(whole(item), recent ? RECENT : OLD);
    const { [LIGHT]: _count, ...view } = item;
    return view;
  }
  return cutItem(item, recent ? RECENT : OLD);
}

export const SNAPSHOT_THRESHOLD = 2048;

export function turnBoundary(item: TimelineItem) {
  if (item.parentId || item.type !== 'user' || item.steered || item.state === 'queued') return false;
  const syn = syntheticOf(item);
  return !syn || syn.role === 'command';
}

/** Eight ordinary prompt boundaries cover the largest tailStart can build.
 * A queued steer, streaming row or background task takes its entire turn too. */
export function snapshotEnd(items: TimelineItem[]) {
  let start = 0, prompts = 0, live = items.length;
  let roots = 0, shownRoots = 0;
  const parents = new Set<string>();
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it.parentId) roots++;
    if ((parents.size && parents.delete(it.id)) || it.type === 'tool' && (it.status === 'running' || it.status === 'pending' || it.status === 'awaiting' || runsTask(it) || worksInBackground(it)) ||
        (it.type === 'text' || it.type === 'thinking') && it.streaming || it.type === 'user' && it.state === 'queued' ||
        it.type === 'notice' && it.limit?.provider && !it.limit.continuedWith && !it.limit.atReset) {
      live = i;
      if (it.parentId) parents.add(it.parentId);
    }
    if (prompts >= 8 && live >= start || !turnBoundary(it)) continue;
    if (++prompts === 8 || i <= live && live < start) {
      start = i;
      shownRoots = roots;
    }
  }
  return start && start <= live ? { start, roots: roots - shownRoots } : { start: 0, roots: 0 };
}

export function snapshotPage(snap: SessionSnapshot, request: 'end' | SnapshotCursor, known?: ReturnType<typeof snapshotEnd>): SessionSnapshot {
  const items = snap.items;
  let end = items.length, start: number, roots: number;
  if (request === 'end') {
    if (end <= SNAPSHOT_THRESHOLD) return snap;
    ({ start, roots } = known ?? snapshotEnd(items));
    if (!start) return snap;
  } else {
    end = request.at;
    // A rewind or move crossed this boundary. A whole authoritative answer
    // replaces the interrupted read, including events applied along the way.
    if (!Number.isSafeInteger(end) || end <= 0 || items[end]?.id !== request.id) return snap;
    start = Math.max(0, end - 512);
    // Align pages to sent messages where possible so grouping can keep its suffix.
    const floor = Math.max(0, start - 64);
    while (start > floor && !turnBoundary(items[start])) start--;
    roots = request.roots;
    for (let i = start; i < end; i++) if (!items[i].parentId) roots--;
  }
  return { ...snap,
    // Metadata is live in the window after the first answer. A waiting queue
    // may contain image attachments and must not ride along on every page.
    ...(request !== 'end' && { permissions: [], questions: [], todos: [], queue: [], caps: undefined, suggestion: undefined }),
    items: items.slice(start, end), page: {
    kind: request === 'end' ? 'end' : 'older',
    before: start, rootsBefore: roots, recentAt: Math.max(0, recentStart(items, RECENT_TURNS) - start),
  } };
}

/** A conversation as RPC results carry it (session.snapshot, session.create, session.fork, ...). */
export const isSnapshot = (r: unknown): r is SessionSnapshot => !!r && typeof r === 'object' && Array.isArray((r as SessionSnapshot).items) && !!(r as SessionSnapshot).session;

/** An RPC result as a window gets it: a conversation (opened, created, forked, carried over) with its items cut. */
type ResolveItem = (sessionId: string, item: TimelineItem) => TimelineItem;
export const PAGE_LIMIT = { bytes: 4 << 20, chars: bufferLimits.MAX_STRING_LENGTH };

/** Count JSON as it will be encoded, without ever building an enormous row string. */
function wireSize(value: unknown) {
  let bytes = 0, chars = 0;
  const literal = (s: string) => { chars += s.length; bytes += Buffer.byteLength(s); };
  function visit(v: unknown) {
    if (typeof v === 'string') {
      if (v.length <= 65536) { literal(JSON.stringify(v)); return; }
      literal('""');
      for (let at = 0; at < v.length;) {
        let end = Math.min(at + 65536, v.length);
        if (end < v.length && /[\uD800-\uDBFF]/.test(v[end - 1])) end--;
        literal(JSON.stringify(v.slice(at, end)).slice(1, -1));
        at = end;
      }
    } else if (Array.isArray(v)) {
      literal('[]');
      for (let i = 0; i < v.length; i++) {
        if (i) literal(',');
        visit(v[i]);
      }
    } else if (v && typeof v === 'object') {
      literal('{}');
      let first = true;
      for (const [key, val] of Object.entries(v)) {
        if (val === undefined) continue;
        if (!first) literal(',');
        first = false;
        visit(key); literal(':');
        visit(val);
      }
    } else literal(JSON.stringify(v) ?? 'null');
  }
  visit(value);
  return { bytes, chars };
}

function oversizedRow(item: TimelineItem): TimelineItem {
  const base = { id: item.id, ts: item.ts, parentId: item.parentId, more: true, byParts: true as const };
  switch (item.type) {
    case 'tool': return { ...base, type: item.type, kind: item.kind, status: item.status,
      name: item.name.slice(0, 120), title: item.title.slice(0, 256), detail: {} };
    case 'user': return { ...base, type: item.type, text: item.text.slice(0, 256), state: item.state, steered: item.steered, steerWait: item.steerWait, authored: item.authored,
      submitPrint: item.submitPrint, remote: item.remote, phoneSender: item.phoneSender, issuedUuid: item.issuedUuid, issuedTo: item.issuedTo,
      ...(item.until?.check && { until: { check: { ...item.until.check, command: (item.until.check.command ?? '').slice(0, 256), output: undefined } } }) };
    case 'text': case 'thinking': return { ...base, type: item.type, text: item.text.slice(0, 256), streaming: item.streaming };
    case 'notice': return { ...base, type: item.type, variant: item.variant, text: item.text.slice(0, 256) };
    case 'turn': return { ...base, type: item.type, durationMs: item.durationMs };
  }
}

function boundedWindowPage(snap: SessionSnapshot, whole?: (i: TimelineItem) => TimelineItem): SessionSnapshot {
  const recent = snap.page?.recentAt ?? recentStart(snap.items, RECENT_TURNS);
  // Reserve the frame and cursor as well as the live metadata on the first answer.
  const header = wireSize({ ...snap, items: [] });
  let bytes = header.bytes + 256, chars = header.chars + 256, start = snap.items.length;
  const items: TimelineItem[] = [];
  while (start && items.length < 576) {
    const at = start - 1;
    let row = windowItem(snap.items[at], at >= recent, whole);
    const size = wireSize(row);
    if (items.length && (bytes + size.bytes + 1 > PAGE_LIMIT.bytes || chars + size.chars + 1 > PAGE_LIMIT.chars)) break;
    if (chars + size.chars + 1 > PAGE_LIMIT.chars) row = oversizedRow(row);
    items.push(row);
    start = at;
    bytes += size.bytes + 1;
    chars += size.chars + 1;
    if (bytes >= PAGE_LIMIT.bytes || chars >= PAGE_LIMIT.chars) break;
  }
  items.reverse();
  if (!start) return { ...snap, items };
  let roots = snap.page?.rootsBefore ?? 0;
  for (let i = 0; i < start; i++) if (!snap.items[i].parentId) roots++;
  return { ...snap, items, page: { kind: snap.page?.kind ?? 'end', before: (snap.page?.before ?? 0) + start,
    rootsBefore: roots, recentAt: Math.max(0, recent - start) } };
}

export function resultForWindow<T>(result: T, resolve?: ResolveItem, bounded = false): T {
  if (isSnapshot(result)) {
    const whole = resolve && ((i: TimelineItem) => resolve(result.session.id, i));
    if (bounded || result.page) return boundedWindowPage(result, whole) as T;
    return { ...result, items: cutItems(result.items, whole) };
  }
  // race.start returns its new conversations together.
  const sessions = (result as { sessions?: unknown[] } | null)?.sessions;
  if (Array.isArray(sessions) && sessions.some(isSnapshot)) return { ...result, sessions: sessions.map(s => resultForWindow(s, resolve)) };
  return result;
}

// Every window gets the same event object: it is cut once.
const cutEvents = new WeakMap<BridgeEvent, BridgeEvent>();

/** JSON omits undefined. A missing patch key means keep the old value, so send an explicit clear. */
export function sessionPatchForJson(patch: Partial<SessionMeta>, clearable?: ReadonlySet<string>) {
  return Object.fromEntries(Object.entries(patch)
    .filter(([key, value]) => value != null || !clearable || clearable.has(key))
    .map(([key, value]) => [key, value ?? (key === 'accountId' ? DEFAULT_ACCOUNT : null)]));
}

/** An event as a window gets it: a reset timeline cut; everything live as it is. */
export function eventForWindow(event: BridgeEvent, resolve?: ResolveItem): BridgeEvent {
  if (event.type === 'item.added' && isLight(event.item)) {
    const { [LIGHT]: _count, ...view } = event.item;
    return { ...event, item: resolve?.(event.sessionId, event.item) ?? view };
  }
  if (event.type === 'item.patch' && isLight(event.patch)) {
    const { [LIGHT]: _count, ...patch } = event.patch;
    return { ...event, patch };
  }
  if (event.type !== 'timeline.reset') return event;
  let out = cutEvents.get(event);
  if (!out) {
    out = { ...event, items: cutItems(event.items, resolve && (i => resolve(event.sessionId, i))) };
    cutEvents.set(event, out);
  }
  return out;
}
