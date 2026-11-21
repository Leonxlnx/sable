import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { open as openFile, readFile as readFileAsync, stat as statFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  PHONE_METHODS,
  PHONE_OWN_METHODS,
  PHONE_PATH,
  PHONE_PORT,
  type Attachment,
  type BridgeEvent,
  type PhoneDevice,
  type PhoneFrame,
  type PhoneHello,
  type PhoneItem,
  type PhoneReset,
  type PhoneStatus,
  type PhoneTail,
  type PermissionRequest,
  type QuestionRequest,
  type QueuedMessage,
  type RpcName,
  type RpcRequest,
  type ServerFrame,
  type SessionSnapshot,
  type TimelineItem,
  type ToolDetail,
  type ToolItem,
  type ToolResult,
  type WorkflowRun,
} from '../../shared/protocol';
import { partOfTurn, stripWrappers, syntheticOf } from '../../shared/synthetic';
import type { App } from '../app';
import { cap, isSnapshot, lines } from '../core/trim';
import { VERSION } from '../version';
import { PhoneChangesReader, stepIds } from './phone-changes';
import { FRAME_MAX, grantFor, openGrant, phoneAttachments, readHello, type FileGrant } from './phone-guard';
import { qrSvgPath } from './qr';

/**
 * The phone endpoint: Sable's phone app (`mobile/`) on the home network.
 *
 * - Its own HTTP server on all interfaces at `PHONE_PORT`, started only while Settings › Phone is
 *   on. The localhost bridge is untouched: nothing here is reachable through it, and the phone
 *   never reaches the localhost bridge.
 * - Pairing: a one-time key (QR code / link, valid 10 minutes, used up by the first phone that
 *   presents it), then "Allow <phone>?" on the desktop. An allowed phone gets a 256-bit token,
 *   stored here only as a SHA-256 hash; Settings › Phone revokes it.
 * - Every socket authenticates first (`hello` with the token) within a few seconds; wrong keys and
 *   tokens are counted per address and block it for a while; there is a cap on sockets.
 * - Authenticated sockets may call only `PHONE_METHODS`, with their parameters narrowed; they get
 *   the conversation events, never terminal output, browser requests, sign-in links or this
 *   service's own state (which holds the pairing key).
 * - Conversations reach a phone in pages (`phone.tail`, `phone.item`; a snapshot from any method
 *   is cut to its newest page), items trimmed to what the phone shows, and item events only for
 *   the conversations it has open, trimmed the same way. Frames over 1 KB are compressed.
 * - A chat's changes and their diffs (`phone.changes`, `phone.diff`, phone-changes.ts): read-only,
 *   named by the chat (never a folder or a path outside what its folder's status lists).
 */

interface StoredPhone {
  id: string;
  name: string;
  /** SHA-256 of the token, hex. */
  tokenHash: string;
  pairedAt: number;
  lastSeen?: number;
}

interface PhoneFile {
  enabled: boolean;
  devices: StoredPhone[];
}

export interface PhoneOptions {
  /** Port to listen on (tests use 0). */
  port?: number;
  /** Interface to listen on (tests use 127.0.0.1). */
  host?: string;
  /** Where the paired phones are kept (defaults to `<SABLE_HOME>/phone.json`). */
  file?: string;
}

const PAIR_TTL_MS = 10 * 60_000;
const REQUEST_TTL_MS = 2 * 60_000;
const HELLO_TIMEOUT_MS = 8_000;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60_000;
const BLOCK_MS = 15 * 60_000;
const GLOBAL_FAILS_PER_MIN = 30;
const MAX_SOCKETS = 12;
const MAX_HELLO_BYTES = 4096;
/** A phone that falls this far behind (bytes queued) is dropped; it reconnects and reloads. */
const MAX_BUFFERED = 24 * 1024 * 1024;

/** Events a phone needs to show conversations, limits and folders. */
const PHONE_EVENTS = new Set<BridgeEvent['type']>([
  'provider.updated',
  'projects.updated',
  'settings.updated',
  'session.added',
  'session.updated',
  'session.removed',
  'session.caps',
  'item.added',
  'item.delta',
  'item.patch',
  'item.removed',
  'timeline.reset',
  'permission.added',
  'permission.removed',
  'question.added',
  'question.removed',
  'todos.updated',
  'suggestion',
  'queue.updated',
  'limits.updated',
  'limits.report',
  'limit.reset',
  'caps.updated',
  'toast',
]);

const ALLOWED = new Set<string>(PHONE_METHODS);
const OWN = new Set<string>(PHONE_OWN_METHODS);

/** Events that carry a conversation's items: sent only for the conversations a phone has open. */
const ITEM_EVENTS = new Set<BridgeEvent['type']>(['item.added', 'item.delta', 'item.patch', 'item.removed', 'timeline.reset']);
/** Conversations a socket follows (the ones it opened last). */
const WATCH_MAX = 8;

// ── what a phone gets of a conversation ──
//
// Real conversations reach hundreds of MB (tool output, file reads, screenshots). A phone gets
// pages of root items with what it shows: titles, kinds, states, a change's counts, texts up to a
// generous length; `phone.item` returns one item with more of it.

/** Root items per page, by default and at most. */
export const PAGE_ITEMS = 40;
const PAGE_MAX = 120;
/** A page stops growing past this many bytes of JSON (it always holds a few items). */
export const PAGE_BYTES = 90_000;
/** How far a page reaches back for the message that opened its first turn. */
const TURN_REACH = 160;
/** Text lengths: an answer or a message, text between steps, thinking, a notice. */
export const LIMITS = { answer: 8000, step: 1600, thinking: 320, notice: 1200, field: 400 };
/** `phone.item`: how much of one item. */
const FULL = { text: 200_000, thinking: 40_000, field: 4000, outLines: 200, outChars: 12_000, files: 6, hunks: 4, hunkLines: 80, children: 40 };
/** Pictures of one step a phone can ask for, and the biggest one it gets (a data URL's length). */
const MAX_PICS = 12;
export const IMAGE_MAX = 12 * 1024 * 1024;
/** `phone.tail` with `to`: how far back a page may reach for the item asked for (roots, bytes). */
export const REACH = { roots: 2400, bytes: 3_000_000 };

const DETAIL_TEXT = ['command', 'description', 'cwd', 'path', 'url', 'query', 'pattern', 'glob', 'subagent', 'server', 'tool', 'skill', 'caption'] as const;

function trimDetail(d: ToolDetail | undefined, n: number, full = false): ToolDetail {
  const out: ToolDetail = {};
  if (!d) return out;
  for (const k of DETAIL_TEXT) if (typeof d[k] === 'string') out[k] = cap(d[k] as string, n);
  if (d.range) out.range = d.range;
  // A `share` step: the files' names and sizes for its cards (the phone downloads one through `phone.fileLink`).
  if (d.files) out.files = d.files.slice(0, 12).map((f) => ({ path: cap(f.path, 400), name: cap(f.name, 200), ...(typeof f.size === 'number' ? { size: f.size } : {}) }));
  if (d.background) out.background = true;
  if (full) {
    for (const k of ['oldText', 'newText', 'content', 'prompt', 'plan'] as const) if (typeof d[k] === 'string') out[k] = cap(d[k] as string, n);
    if (d.todos) out.todos = d.todos.slice(0, 40);
  }
  return out;
}

function trimResult(r: ToolResult | undefined, full = false): ToolResult | undefined {
  if (!r) return undefined;
  const out: ToolResult = {};
  for (const k of ['exitCode', 'isError', 'interrupted', 'truncated', 'count'] as const) if (r[k] !== undefined) (out as Record<string, unknown>)[k] = r[k];
  if (r.agent) out.agent = r.agent;
  if (r.diff) {
    out.diff = r.diff.slice(0, full ? FULL.files : 24).map((f) => ({
      path: cap(f.path, 400),
      ...(f.oldPath ? { oldPath: cap(f.oldPath, 400) } : {}),
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      ...(f.binary ? { binary: true } : {}),
      hunks: full ? f.hunks.slice(0, FULL.hunks).map((h) => ({ ...h, lines: h.lines.slice(0, FULL.hunkLines).map((l) => cap(l, 400)) })) : [],
    }));
  }
  if (full) {
    if (r.text) out.text = lines(r.text, FULL.outLines, FULL.outChars);
    if (r.stderr) out.stderr = lines(r.stderr, FULL.outLines, FULL.outChars);
    if (r.files) out.files = r.files.slice(0, 50);
    if (r.links) out.links = r.links.slice(0, 20);
    if (r.file) out.file = { path: r.file.path, startLine: r.file.startLine, numLines: r.file.numLines, totalLines: r.file.totalLines, ...(r.file.content ? { content: lines(r.file.content, FULL.outLines, FULL.outChars) } : {}) };
  }
  return out;
}

function trimWorkflow(w: WorkflowRun): WorkflowRun {
  return {
    ...w,
    phases: w.phases.slice(0, 24).map((p) => ({ title: cap(p.title, 120), ...(p.detail ? { detail: cap(p.detail, 200) } : {}) })),
    agents: w.agents.slice(0, 40).map((a) => ({ ...a, label: cap(a.label, 120), ...(a.activity ? { activity: cap(a.activity, 160) } : {}), ...(a.error ? { error: cap(a.error, 200) } : {}) })),
  };
}

/** Attachments without their data (a picture shows as its name). */
const trimAttachments = (list: Attachment[] | undefined) => list?.map((a) => ({ id: a.id, kind: a.kind, name: cap(a.name, 120), ...(a.mime ? { mime: a.mime } : {}), ...(a.size ? { size: a.size } : {}) }));

function hasMore(t: ToolItem): boolean {
  const r = t.result;
  const d = t.detail ?? {};
  return !!(t.output || r?.text || r?.stderr || r?.diff?.some((f) => f.hunks.length) || r?.file?.content || r?.files?.length || r?.links?.length || d.oldText || d.newText || d.content || d.prompt || d.plan);
}

/**
 * An item as a phone gets it. `role` says where it shows: an answer or a message (long texts),
 * text between steps (shortened), or `full` for `phone.item`.
 */
export function phoneItem(it: TimelineItem, opts: { role?: 'answer' | 'step' | 'full'; kids?: number } = {}): PhoneItem {
  const full = opts.role === 'full';
  const textCap = (s: string, n: number): { text: string; cut?: true } => (s.length > n ? { text: s.slice(0, n), cut: true } : { text: s });
  // A `/until` check's output: the start of it (the phone shows a few lines).
  const until = (it.type === 'user' || it.type === 'notice') && it.until?.check?.output ? { until: { ...it.until, check: { ...it.until.check, output: cap(it.until.check.output, full ? FULL.field : 3000) } } } : {};
  switch (it.type) {
    case 'user': {
      const { attachments, ...rest } = it;
      return { ...rest, ...textCap(it.text, full ? FULL.text : it.until ? LIMITS.step : LIMITS.answer), ...(attachments ? { attachments: trimAttachments(attachments) } : {}), ...until };
    }
    case 'text':
      return { ...it, ...textCap(it.text, full ? FULL.text : opts.role === 'step' ? LIMITS.step : LIMITS.answer) };
    case 'thinking':
      return { ...it, ...textCap(it.text, full ? FULL.thinking : LIMITS.thinking) };
    case 'notice':
      return { ...it, text: cap(it.text, full ? FULL.field : LIMITS.notice), ...(it.detail ? { detail: cap(it.detail, full ? FULL.field : LIMITS.notice) } : {}), ...until };
    case 'turn':
      return it.error ? { ...it, error: cap(it.error, LIMITS.notice) } : it;
    case 'tool': {
      const n = full ? FULL.field : LIMITS.field;
      const out: PhoneItem = {
        id: it.id,
        ts: it.ts,
        ...(it.parentId ? { parentId: it.parentId } : {}),
        type: 'tool',
        name: cap(it.name, 120),
        kind: it.kind,
        title: cap(it.title, 300),
        status: it.status,
        detail: trimDetail(it.detail, n, full),
        ...(it.endedAt ? { endedAt: it.endedAt } : {}),
        ...(it.waitedMs ? { waitedMs: it.waitedMs } : {}),
        ...(it.result ? { result: trimResult(it.result, full) } : {}),
        ...(it.workflow ? { workflow: trimWorkflow(it.workflow) } : {}),
        // A check of a turn by the other agent: which turn and who, and its findings (they are its answer).
        ...(it.check ? { check: it.check } : {}),
        ...(opts.kids ? { kids: opts.kids } : {}),
        ...(!full && hasMore(it) ? { more: true } : {}),
        // Pictures (a screenshot) stay on the desktop: their count, and `phone.image` for each.
        ...(it.result?.images?.length ? { pics: Math.min(it.result.images.length, MAX_PICS) } : {}),
      };
      if (it.check && it.result?.text && out.result) (out.result as ToolResult).text = cap(it.result.text, full ? FULL.text : LIMITS.answer);
      // A widget shows by its title only.
      if (it.kind === 'widget') {
        const title = (it.input as { title?: unknown } | undefined)?.title;
        if (typeof title === 'string') (out as ToolItem).input = { title: cap(title, 200) };
      }
      if (full && it.output) (out as ToolItem).output = lines(it.output.replace(/\x1b\[[0-9;]*m/g, ''), FULL.outLines, FULL.outChars);
      return out;
    }
  }
}

/** A patch to an item, trimmed like the item (no output, input or images; long text cut). */
export function phonePatch(patch: Partial<TimelineItem>): Partial<PhoneItem> | null {
  const p = { ...patch } as Record<string, unknown>;
  delete p.input;
  delete p.inputText;
  delete p.output;
  if (p.detail) p.detail = trimDetail(p.detail as ToolDetail, LIMITS.field);
  if (p.result) p.result = trimResult(p.result as ToolResult);
  if (p.workflow) p.workflow = trimWorkflow(p.workflow as WorkflowRun);
  if (p.attachments) p.attachments = trimAttachments(p.attachments as Attachment[]);
  if (typeof p.text === 'string' && p.text.length > LIMITS.answer) {
    p.text = p.text.slice(0, LIMITS.answer);
    p.cut = true;
  }
  if (typeof p.detail === 'string') p.detail = cap(p.detail, LIMITS.notice);
  if (typeof p.error === 'string') p.error = cap(p.error, LIMITS.notice);
  if ((patch as Partial<ToolItem>).output || (patch as Partial<ToolItem>).result?.text) p.more = true;
  const pics = (patch as Partial<ToolItem>).result?.images?.length;
  if (pics) p.pics = Math.min(pics, MAX_PICS);
  return Object.keys(p).length ? (p as Partial<PhoneItem>) : null;
}

/**
 * A permission request as a phone gets it, cut like a step opened in full (`phone.item`): what it
 * shows (title, command, path, url, plan, the change's first hunks), never an edit's whole text.
 */
export function phonePermission(p: PermissionRequest): PermissionRequest {
  const detail = trimDetail(p.detail, FULL.field, true);
  if (typeof p.detail?.plan === 'string') detail.plan = cap(p.detail.plan, FULL.thinking);
  const diff = p.diff ? trimResult({ diff: p.diff }, true)?.diff : undefined;
  return {
    ...p,
    title: cap(p.title, 300),
    ...(p.description ? { description: cap(p.description, LIMITS.notice) } : {}),
    ...(p.reason ? { reason: cap(p.reason, LIMITS.notice) } : {}),
    detail,
    ...(diff ? { diff } : {}),
    options: p.options.slice(0, 12).map((o) => ({ ...o, label: cap(o.label, 200), ...(o.hint ? { hint: cap(o.hint, LIMITS.field) } : {}) })),
  };
}

/** A question as a phone gets it: a bounded number of questions and options, their words cut. */
export function phoneQuestion(q: QuestionRequest): QuestionRequest {
  return {
    ...q,
    questions: q.questions.slice(0, 12).map((x) => ({
      ...x,
      question: cap(x.question, LIMITS.notice),
      ...(x.header ? { header: cap(x.header, 200) } : {}),
      options: x.options.slice(0, 24).map((o) => ({ ...o, label: cap(o.label, 300), ...(o.description ? { description: cap(o.description, LIMITS.field) } : {}) })),
    })),
  };
}

/** A message that opens a turn: not a steer, not a command's output or a reminder the agent's harness wrote. */
const turnStart = (it: TimelineItem) => it.type === 'user' && !it.steered && !partOfTurn(syntheticOf(it));

/**
 * One page of a conversation's root items, newest last: up to `limit` before `before` (or the
 * newest), reaching back to the message that opened the first turn when that is near, within a
 * byte budget. Text between steps is shortened (`LIMITS.step`); answers keep their length.
 */
export function phonePage(items: TimelineItem[], opts: { before?: string; limit?: number; budget?: number; to?: string } = {}): { items: PhoneItem[]; cursor?: string; total: number } {
  const roots: TimelineItem[] = [];
  const kids = new Map<string, number>();
  for (const it of items) {
    if (it.parentId) kids.set(it.parentId, (kids.get(it.parentId) ?? 0) + 1);
    else roots.push(it);
  }
  const total = roots.length;
  let end = total;
  if (opts.before) {
    end = roots.findIndex((r) => r.id === opts.before);
    if (end < 0) return { items: [], total };
  }
  const limit = Math.max(1, Math.min(PAGE_MAX, opts.limit ?? PAGE_ITEMS));
  const budget = opts.budget ?? PAGE_BYTES;
  // A text item is an answer unless a step follows it in its turn (then it is a report along the way, shortened).
  const roleAt = (i: number): 'answer' | 'step' => {
    if (roots[i].type !== 'text') return 'answer';
    for (let j = i + 1; j < total; j++) {
      const t = roots[j];
      if (turnStart(t) || t.type === 'turn') return 'answer';
      if (t.type === 'tool' || t.type === 'thinking') return 'step';
    }
    return 'answer';
  };
  const out: PhoneItem[] = [];
  let bytes = 0;
  let start = end;
  const take = (i: number) => {
    const p = phoneItem(roots[i], { role: roleAt(i), kids: kids.get(roots[i].id) });
    out.push(p);
    bytes += JSON.stringify(p).length;
    start = i;
  };
  // An item asked for (a search hit): the page reaches back to it, within `REACH` (the phone asks again from the cursor when it is further).
  let reach = -1;
  if (opts.to) {
    const at = roots.findIndex((r) => r.id === opts.to);
    if (at >= 0 && at < end) reach = Math.max(at, end - REACH.roots);
  }
  const short = () => reach >= 0 && start > reach && bytes < REACH.bytes;
  while (start > 0 && (short() || (end - start < limit && (bytes < budget || end - start < 4)))) take(start - 1);
  // Reach back to the message that opened this turn when it is near (a turn is not split).
  if (start > 0 && !turnStart(roots[start])) {
    let s = start - 1;
    while (s > 0 && start - s < TURN_REACH && !turnStart(roots[s])) s--;
    const room = reach >= 0 ? Math.max(budget * 1.6, REACH.bytes * 1.3) : budget * 1.6;
    if (turnStart(roots[s])) while (start > s && bytes < room) take(start - 1);
  }
  out.reverse();
  return { items: out, ...(start > 0 ? { cursor: roots[start].id } : {}), total };
}

const trimQueue = (q: QueuedMessage[]) => q.map((m) => (m.attachments ? { ...m, attachments: trimAttachments(m.attachments) } : m)) as QueuedMessage[];

/** A snapshot as a phone gets it: the newest page instead of every item. */
export function phoneTail(snap: SessionSnapshot, opts: { before?: string; limit?: number; to?: string } = {}): PhoneTail {
  const page = phonePage(snap.items, opts);
  return {
    ...snap,
    queue: trimQueue(snap.queue ?? []),
    permissions: (snap.permissions ?? []).map(phonePermission),
    questions: (snap.questions ?? []).map(phoneQuestion),
    items: page.items,
    total: page.total,
    ...(page.cursor ? { cursor: page.cursor } : {}),
  };
}

/**
 * A result as a phone gets it, besides conversations (a snapshot goes out as `phoneTail`): what
 * waits across chats without whole edits (`app.hello`), a queued message taken back without its
 * pictures' data (`queue.take`).
 */
export function phoneResult(method: string, result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  if (method === 'app.hello') {
    const r = result as { prompts?: { permissions: PermissionRequest[]; questions: QuestionRequest[] } };
    return r.prompts ? { ...r, prompts: { permissions: r.prompts.permissions.map(phonePermission), questions: r.prompts.questions.map(phoneQuestion) } } : r;
  }
  if (method === 'queue.take') {
    const r = result as { message?: QueuedMessage };
    return r.message ? { ...r, message: trimQueue([r.message])[0] } : r;
  }
  return result;
}

/** One item with more of it, and the last steps nested under it. */
export function phoneDetail(items: TimelineItem[], itemId: string): { item: PhoneItem; children: PhoneItem[] } {
  const it = items.find((i) => i.id === itemId);
  if (!it) throw new Error('That part of the conversation is no longer there');
  const kids = items.filter((i) => i.parentId === itemId);
  const count = new Map<string, number>();
  for (const k of items) if (k.parentId) count.set(k.parentId, (count.get(k.parentId) ?? 0) + 1);
  return { item: phoneItem(it, { role: 'full', kids: kids.length }), children: kids.slice(-FULL.children).map((k) => phoneItem(k, { role: 'step', kids: count.get(k.id) })) };
}

/** An event as a phone gets it, or null when it does not need it. */
export function phoneEvent(event: BridgeEvent): BridgeEvent | PhoneReset | null {
  switch (event.type) {
    case 'item.added':
      return { ...event, item: phoneItem(event.item, { role: event.item.type === 'text' && event.item.parentId ? 'step' : 'answer' }) };
    case 'item.delta':
      // Live tool output and streamed tool input stay on the desktop (`phone.item` has it).
      return event.field === 'text' ? event : null;
    case 'item.patch': {
      const patch = phonePatch(event.patch);
      return patch ? { ...event, patch } : null;
    }
    case 'timeline.reset': {
      const page = phonePage(event.items);
      return { type: 'timeline.reset', sessionId: event.sessionId, items: page.items, total: page.total, ...(page.cursor ? { cursor: page.cursor } : {}) };
    }
    case 'permission.added':
      return { ...event, request: phonePermission(event.request) };
    case 'question.added':
      return { ...event, request: phoneQuestion(event.request) };
    case 'queue.updated':
      return { ...event, queue: trimQueue(event.queue) };
    default:
      return event;
  }
}

// ── search across chats (`phone.search`) ──
//
// Messages only: what the person wrote and what the agents said (root items), never steps, outputs or
// files. A chat open on the desktop is read from memory; another is read from its file on disk, line
// by line, decoding only the lines of messages (a step's line with screenshots is skipped unread), and
// what it says is kept (keyed by the files' size and time) so the next search does not read it again.
// Each call is bounded in time and bytes read; what was not read yet is read by the next call.

export const SEARCH = { min: 2, max: 120, hits: 40, perChat: 5, text: 20_000, snippet: 150, bytes: 48 * 1024 * 1024, ms: 900, line: 1024 * 1024, keep: 24_000_000 };

/** A message as search reads it. */
interface Said {
  id: string;
  role: 'user' | 'agent';
  /** Its words, cut to `SEARCH.text`. */
  text: string;
  ts: number;
}

/** The messages of a timeline that search reads: the person's own (not what the agent's harness wrote) and the agent's texts. */
export function saidOf(items: Iterable<TimelineItem>): Said[] {
  const out: Said[] = [];
  for (const it of items) {
    const s = sayOf(it);
    if (s) out.push(s);
  }
  return out;
}

function sayOf(it: TimelineItem): Said | null {
  if (it.parentId) return null;
  if (it.type === 'user') {
    if (it.until?.check || syntheticOf(it)) return null;
    const text = stripWrappers(it.text).trim();
    return text ? { id: it.id, role: 'user', text: text.slice(0, SEARCH.text), ts: it.ts } : null;
  }
  if (it.type === 'text') {
    const text = it.text.trim();
    return text ? { id: it.id, role: 'agent', text: text.slice(0, SEARCH.text), ts: it.ts } : null;
  }
  return null;
}

/** Markdown read as words: links and pictures by their text, no code ticks, emphasis or heading marks. */
const plainOf = (md: string) =>
  md
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/(^|[\s(])[*_](?=\S)([^*_\n]*?\S)[*_](?=[\s).,:;!?]|$)/gm, '$1$2')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '');

/** The words around the first match: a line or two, cut at word boundaries. */
export function snippetOf(text: string, words: string[]): string {
  const flat = plainOf(text).replace(/\s+/g, ' ').trim();
  const low = flat.toLowerCase();
  let at = Infinity;
  for (const w of words) {
    const i = low.indexOf(w);
    if (i >= 0 && i < at) at = i;
  }
  if (!Number.isFinite(at) || flat.length <= SEARCH.snippet) return flat.slice(0, SEARCH.snippet);
  let from = Math.max(0, at - 48);
  if (from > 0) {
    const sp = flat.indexOf(' ', from);
    if (sp >= 0 && sp < at) from = sp + 1;
  }
  let to = Math.min(flat.length, from + SEARCH.snippet);
  if (to < flat.length) {
    const sp = flat.lastIndexOf(' ', to);
    if (sp > at) to = sp;
  }
  return `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`;
}

const MARKS = ['"type":"user"', '"type":"text"'];

/**
 * A chat's messages from its files (`session-file.ts`: a base of one item per line, and a tail that
 * replaces the base from item `from` on), reading only what it must. Null when it cannot be read.
 */
async function readSaid(base: string, tail: string): Promise<{ said: Said[]; read: number } | null> {
  let fh: Awaited<ReturnType<typeof openFile>> | undefined;
  let read = 0;
  try {
    fh = await openFile(base, 'r');
    const size = (await fh.stat()).size;
    const said: { k: number; s: Said }[] = [];
    let gen: number | undefined;
    let k = -1; // the item's index (-1: the head line)
    let pending: Buffer[] = [];
    let pendingLen = 0;
    let skipping = false;
    const buf = Buffer.alloc(1 << 20);
    const line = (b: Buffer) => {
      if (k === -1) {
        const m = /^\{"gen":(\d+),"items":\[$/.exec(b.toString('utf8'));
        if (!m) throw new Error('old');
        gen = Number(m[1]);
      } else if (b[0] !== 93 /* ] */ && MARKS.some((m) => b.includes(m))) {
        const t = b.toString('utf8');
        const s = sayOf(JSON.parse(t.endsWith(',') ? t.slice(0, -1) : t) as TimelineItem);
        if (s) said.push({ k, s });
      }
      k++;
    };
    for (let pos = 0; pos < size; ) {
      const { bytesRead: n } = await fh.read(buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      read += n;
      let from = 0;
      for (let nl = buf.indexOf(10, from); nl >= 0 && nl < n; nl = buf.indexOf(10, from)) {
        if (skipping) {
          skipping = false;
          k++;
        } else if (pendingLen) {
          pending.push(buf.subarray(from, nl));
          line(Buffer.concat(pending));
          pending = [];
          pendingLen = 0;
        } else line(buf.subarray(from, nl));
        from = nl + 1;
      }
      // The rest of a line: kept for the next piece, unless the line is too long to be a message.
      if (from < n && !skipping) {
        pendingLen += n - from;
        if (pendingLen > SEARCH.line) {
          if (k === -1) throw new Error('old');
          pending = [];
          pendingLen = 0;
          skipping = true;
        } else pending.push(Buffer.from(buf.subarray(from, n)));
      }
    }
    if (gen === undefined) throw new Error('old');
    let out = said;
    try {
      const st = await statFile(tail);
      if (st.size <= 16 * 1024 * 1024) {
        const t = JSON.parse(await readFileAsync(tail, 'utf8')) as { baseGen?: number; from?: number; items?: TimelineItem[] };
        read += st.size;
        if (t.baseGen === gen && Array.isArray(t.items)) {
          const cut = typeof t.from === 'number' && t.from >= 0 ? t.from : Infinity;
          out = said.filter((x) => x.k < cut);
          for (const s of saidOf(t.items)) out.push({ k: Infinity, s });
        }
      }
    } catch {
      /* no tail */
    }
    return { said: out.map((x) => x.s), read };
  } catch (err) {
    // A file of an older version is one line of JSON: read whole when it is not huge.
    if ((err as Error).message === 'old') {
      try {
        const st = await statFile(base);
        if (st.size > 64 * 1024 * 1024) return null;
        const f = JSON.parse(await readFileAsync(base, 'utf8')) as { items?: TimelineItem[] };
        return { said: saidOf(f.items ?? []), read: read + st.size };
      } catch {
        return null;
      }
    }
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { said: [], read };
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** Searches the chats' messages for the phone, with what it read from disk kept between calls. */
export class ChatSearch {
  private kept = new Map<string, { key: string; said: Said[]; chars: number }>();
  private chars = 0;

  constructor(private app: App) {}

  private keep(id: string, key: string, said: Said[]) {
    const old = this.kept.get(id);
    if (old) (this.chars -= old.chars), this.kept.delete(id);
    const chars = said.reduce((n, s) => n + s.text.length + 48, 0);
    this.kept.set(id, { key, said, chars });
    this.chars += chars;
    for (const [k, v] of this.kept) {
      if (this.chars <= SEARCH.keep) break;
      this.kept.delete(k);
      this.chars -= v.chars;
    }
  }

  /** A chat's messages: from memory when the desktop has it open, else from its files (kept), or undefined when the budget is spent. */
  private async said(id: string, budget: { bytes: number; until: number; fresh: boolean }): Promise<Said[] | undefined> {
    const rt = this.app.sessions.get(id);
    if (rt?.items.length) return saidOf(rt.items);
    const base = path.join(this.app.store.dir, 'sessions', `${id}.json`);
    const tail = base.replace(/\.json$/, '.tail.json');
    const st = (f: string) => statFile(f).then((s) => `${s.size}:${s.mtimeMs}`, () => '-');
    const key = `${await st(base)}|${await st(tail)}`;
    const have = this.kept.get(id);
    if (have?.key === key) {
      // Used again: the newest kept last.
      this.kept.delete(id);
      this.kept.set(id, have);
      return have.said;
    }
    if (!budget.fresh && (budget.bytes <= 0 || Date.now() > budget.until)) return undefined;
    budget.fresh = false;
    const r = await readSaid(base, tail);
    if (!r) return [];
    budget.bytes -= r.read;
    this.keep(id, key, r.said);
    return r.said;
  }

  async search(query: string): Promise<{ hits: { sessionId: string; itemId: string; role: 'user' | 'agent'; text: string; ts: number }[]; partial?: boolean }> {
    const q = String(query ?? '').trim().toLowerCase().slice(0, SEARCH.max);
    const words = [...new Set(q.split(/\s+/).filter(Boolean))];
    if (q.length < SEARCH.min || !words.length) return { hits: [] };
    const chats = [...this.app.sessions.values()].map((rt) => rt.meta).filter((m) => !m.archived).sort((a, b) => b.updatedAt - a.updatedAt);
    const budget = { bytes: SEARCH.bytes, until: Date.now() + SEARCH.ms, fresh: true };
    const hits: { sessionId: string; itemId: string; role: 'user' | 'agent'; text: string; ts: number }[] = [];
    let partial = false;
    for (const m of chats) {
      if (hits.length >= SEARCH.hits) break;
      const said = await this.said(m.id, budget);
      if (!said) {
        partial = true;
        continue;
      }
      let n = 0;
      for (let i = said.length - 1; i >= 0 && n < SEARCH.perChat && hits.length < SEARCH.hits; i--) {
        const s = said[i];
        const low = s.text.toLowerCase();
        if (!words.every((w) => low.includes(w))) continue;
        hits.push({ sessionId: m.id, itemId: s.id, role: s.role, text: snippetOf(s.text, words), ts: s.ts });
        n++;
      }
    }
    return partial ? { hits, partial } : { hits };
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(sha256(a), 'hex');
  const y = Buffer.from(sha256(b), 'hex');
  return timingSafeEqual(x, y);
}

/** A phone's name as shown on the desktop: printable, short. */
function cleanName(name: unknown): string {
  const s = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 40);
  return s || 'Phone';
}

/** Only pages of the phone app itself (or non-browser clients) may open a socket here. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    return o.hostname === 'localhost' && ['http:', 'https:', 'capacitor:'].includes(o.protocol);
  } catch {
    return false;
  }
}

/** This computer's IPv4 addresses on private networks, the likely home network first. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal || a.family !== 'IPv4') continue;
      if (/^169\.254\./.test(a.address)) continue;
      out.push(a.address);
    }
  }
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) ? 3 : 4);
  return [...new Set(out)].sort((a, b) => rank(a) - rank(b)).slice(0, 4);
}

/**
 * Narrows what a phone may pass to a method beyond the allowlist itself. `queued`: the attachments
 * the desktop holds for a queued message (a phone that edits one names them by id).
 */
function narrow(method: string, params: Record<string, unknown>, queued?: (sessionId: string, id: string) => Attachment[] | undefined): Record<string, unknown> {
  const p = { ...params };
  // Pictures as data, never a path on the computer: a message from the phone carries nothing of the desktop's.
  if (method === 'session.send' || method === 'queue.update') {
    const known = method === 'queue.update' ? queued?.(String(p.sessionId ?? ''), String(p.id ?? '')) : undefined;
    const list = phoneAttachments(p.attachments, known);
    if (list) p.attachments = list;
    else delete p.attachments;
  }
  if (method === 'session.setOptions') {
    const o = (p.options ?? {}) as Record<string, unknown>;
    p.options = 'remoteControl' in o ? { remoteControl: !!o.remoteControl } : {};
  }
  if (method === 'session.create') {
    const o = p.options as Record<string, unknown> | undefined;
    if (o && typeof o === 'object') p.options = 'remoteControl' in o ? { remoteControl: !!o.remoteControl } : undefined;
    delete p.handoverFrom;
  }
  if (method === 'session.update') {
    const patch = (p.patch ?? {}) as Record<string, unknown>;
    const out: Record<string, boolean> = {};
    for (const k of ['pinned', 'archived', 'unread'] as const) if (typeof patch[k] === 'boolean') out[k] = patch[k] as boolean;
    p.patch = out;
  }
  if (method === 'provider.limits') delete p.force;
  return p;
}

export class PhoneService {
  private server?: Server;
  private wss?: WebSocketServer;
  private file: string;
  private data: PhoneFile;
  private listening = false;
  private error?: string;
  private port: number;
  private host: string;
  private pairing?: { key: string; expiresAt: number; link: string; qr: string; size: number };
  private request?: { id: string; name: string; address: string; at: number; ws: WebSocket; timer: NodeJS.Timeout };
  private fails = new Map<string, { count: number; first: number; blockedUntil?: number }>();
  private globalFails: number[] = [];
  /** Authenticated sockets per device id. */
  private live = new Map<string, Set<WebSocket>>();
  private saveTimer?: NodeJS.Timeout;
  private starting?: Promise<void>;
  /** A chat's changes and diffs, read-only (`phone.changes`, `phone.diff`). */
  private changes: PhoneChangesReader;
  /** Messages across chats (`phone.search`). */
  private finder: ChatSearch;

  constructor(
    private app: App,
    opts: PhoneOptions = {},
  ) {
    this.changes = new PhoneChangesReader((sessionId) => this.app.call('session.snapshot', { sessionId }));
    this.finder = new ChatSearch(app);
    this.file = opts.file ?? path.join(app.store.dir, 'phone.json');
    this.port = opts.port ?? PHONE_PORT;
    this.host = opts.host ?? process.env.SABLE_PHONE_HOST ?? '0.0.0.0';
    this.data = this.read();
  }

  get enabled() {
    return this.data.enabled;
  }

  private read(): PhoneFile {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PhoneFile>;
      const devices = Array.isArray(raw.devices) ? raw.devices.filter((d) => d && typeof d.id === 'string' && typeof d.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(d.tokenHash)) : [];
      return { enabled: !!raw.enabled, devices };
    } catch {
      return { enabled: false, devices: [] };
    }
  }

  private save(now = false) {
    clearTimeout(this.saveTimer);
    const write = () => {
      try {
        mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        renameSync(tmp, this.file);
      } catch (err) {
        this.app.log('phone: could not save', (err as Error).message);
      }
    };
    if (now) write();
    else this.saveTimer = setTimeout(write, 2000);
  }

  status(): PhoneStatus {
    if (this.pairing && this.pairing.expiresAt < Date.now()) this.pairing = undefined;
    const devices: PhoneDevice[] = this.data.devices
      .map((d) => ({ id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeen: d.lastSeen, ...(this.live.get(d.id)?.size ? { online: true } : {}) }))
      .sort((a, b) => (b.lastSeen ?? b.pairedAt) - (a.lastSeen ?? a.pairedAt));
    return {
      enabled: this.data.enabled,
      listening: this.listening,
      port: this.port,
      hosts: lanAddresses(),
      name: os.hostname(),
      devices,
      ...(this.pairing ? { pairing: { link: this.pairing.link, expiresAt: this.pairing.expiresAt, qr: this.pairing.qr, size: this.pairing.size } } : {}),
      ...(this.request ? { request: { id: this.request.id, name: this.request.name, address: this.request.address, at: this.request.at } } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  private changed() {
    this.app.emit({ type: 'phone.updated', status: this.status() });
  }

  async setEnabled(on: boolean) {
    this.data.enabled = on;
    this.save(true);
    if (on) await this.start();
    else await this.stop();
    this.changed();
    return this.status();
  }

  start(): Promise<void> {
    if (this.server) return this.starting ?? Promise.resolve();
    this.error = undefined;
    const server = createServer((req, res) => {
      // A file the agent handed over, by the link `phone.fileLink` made (the token is the only key).
      if (req.method === 'GET' && req.url?.startsWith('/f/')) return void this.serveFile(req, res).catch(() => res.destroy());
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end();
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 10_000;
    // Compressed frames (permessage-deflate) above 1 KB: JSON of a conversation shrinks several times over Wi-Fi.
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: 16 * 1024 * 1024,
      perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 5 }, concurrencyLimit: 4 },
    });
    server.on('upgrade', (req, socket, head) => this.onUpgrade(wss, req, socket, head));
    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => this.onSocket(ws, req));
    this.server = server;
    this.wss = wss;
    this.starting = new Promise<void>((resolve) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        this.listening = false;
        this.error = err.code === 'EADDRINUSE' ? `Port ${this.port} is in use by another program` : err.message;
        this.server = undefined;
        this.wss = undefined;
        this.changed();
        resolve();
      });
      server.listen(this.port, this.host, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') this.port = addr.port;
        this.listening = true;
        this.app.log(`phone endpoint on ${this.host}:${this.port}`);
        this.changed();
        resolve();
      });
    });
    return this.starting;
  }

  async stop() {
    this.listening = false;
    this.pairing = undefined;
    this.endRequest('Phone access was turned off');
    // Download links end with phone access.
    this.dropLinks();
    const server = this.server;
    const wss = this.wss;
    this.server = undefined;
    this.wss = undefined;
    this.starting = undefined;
    if (wss) {
      for (const c of wss.clients) c.terminate();
      wss.close();
    }
    this.live.clear();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  pair(cancel?: boolean) {
    if (cancel) this.pairing = undefined;
    else {
      const key = randomBytes(16).toString('base64url');
      const hosts = lanAddresses();
      const link = `sable://pair?h=${hosts.join(',')}&p=${this.port}&k=${key}&n=${encodeURIComponent(os.hostname().slice(0, 30))}`;
      const { path: qr, size } = qrSvgPath(link);
      this.pairing = { key, expiresAt: Date.now() + PAIR_TTL_MS, link, qr, size };
    }
    this.changed();
    return this.status();
  }

  approve(requestId: string, allow: boolean) {
    const r = this.request;
    if (!r || r.id !== requestId) return this.status();
    clearTimeout(r.timer);
    this.request = undefined;
    if (!allow) {
      this.sendFrame(r.ws, { denied: 'The desktop did not allow this phone' });
      r.ws.close(4003, 'denied');
    } else if (r.ws.readyState === r.ws.OPEN) {
      const token = randomBytes(32).toString('base64url');
      const device: StoredPhone = { id: randomUUID(), name: r.name, tokenHash: sha256(token), pairedAt: Date.now(), lastSeen: Date.now() };
      this.data.devices.push(device);
      this.save(true);
      this.sendFrame(r.ws, { paired: { token, deviceId: device.id, desktop: os.hostname() } });
      this.authenticated(r.ws, device);
    }
    this.changed();
    return this.status();
  }

  revoke(deviceId: string) {
    this.data.devices = this.data.devices.filter((d) => d.id !== deviceId);
    this.save(true);
    // Its download links go with it.
    this.dropLinks(deviceId);
    for (const ws of this.live.get(deviceId) ?? []) {
      this.sendFrame(ws, { denied: 'This phone was removed on the desktop' });
      ws.close(4001, 'revoked');
    }
    this.live.delete(deviceId);
    this.changed();
    return this.status();
  }

  private endRequest(reason: string) {
    const r = this.request;
    if (!r) return;
    clearTimeout(r.timer);
    this.request = undefined;
    this.sendFrame(r.ws, { denied: reason });
    r.ws.close(4003, 'denied');
  }

  // ── rate limits ──

  private blocked(ip: string): boolean {
    const now = Date.now();
    this.globalFails = this.globalFails.filter((t) => now - t < 60_000);
    if (this.globalFails.length >= GLOBAL_FAILS_PER_MIN) return true;
    const f = this.fails.get(ip);
    return !!f?.blockedUntil && f.blockedUntil > now;
  }

  private failed(ip: string) {
    const now = Date.now();
    this.globalFails.push(now);
    let f = this.fails.get(ip);
    if (!f || now - f.first > FAIL_WINDOW_MS) f = { count: 0, first: now };
    f.count++;
    if (f.count >= MAX_FAILS) f.blockedUntil = now + BLOCK_MS;
    this.fails.set(ip, f);
    if (this.fails.size > 1000) for (const [k, v] of this.fails) if (now - v.first > FAIL_WINDOW_MS) this.fails.delete(k);
  }

  // ── sockets ──

  /**
   * Download links for files the agent handed over (`phone.fileLink`): token -> the one file of a
   * finished share, for the phone it was made for, as it was then (phone-guard.ts), until it expires,
   * that phone is removed or phone access is turned off.
   */
  private files = new Map<string, FileGrant>();

  private async fileLink(deviceId: string, sessionId: string, itemId: string, index: number): Promise<{ path: string; name: string; size?: number }> {
    const snap = await this.app.call('session.snapshot', { sessionId });
    const grant = grantFor(snap, itemId, index, deviceId);
    const now = Date.now();
    for (const [t, f] of this.files) if (f.expires < now) this.files.delete(t);
    while (this.files.size >= 50) this.files.delete(this.files.keys().next().value as string);
    const token = randomBytes(24).toString('base64url');
    this.files.set(token, grant);
    return { path: `/f/${token}/${encodeURIComponent(grant.name)}`, name: grant.name, size: grant.size };
  }

  /** The links made for one phone (or all of them) stop working. */
  private dropLinks(deviceId?: string) {
    for (const [t, f] of this.files) if (!deviceId || f.deviceId === deviceId) this.files.delete(t);
  }

  /** `phone.image`: one picture of a step's result in this chat (a data URL of an image, capped), nothing else. */
  private async image(sessionId: string, itemId: string, index: number): Promise<{ data: string }> {
    const snap = await this.app.call('session.snapshot', { sessionId });
    const item = snap.items.find((i) => i.id === itemId);
    const src = item?.type === 'tool' && Number.isInteger(index) && index >= 0 && index < MAX_PICS ? item.result?.images?.[index] : undefined;
    if (typeof src !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,/.test(src)) throw new Error('That picture is not in this chat.');
    if (src.length > IMAGE_MAX) throw new Error('That picture is too big to show on the phone.');
    return { data: src };
  }

  /** `phone.mkdir`: one new folder in an existing one, by a plain name (no separators, nothing hidden, no overwrite). */
  private makeFolder(parent: string, name: string): { path: string } {
    const n = name.trim();
    if (!n || n.length > 120 || n.startsWith('.') || /[\\/:*?"<>|\x00-\x1f]/.test(n) || /[. ]$/.test(n)) throw new Error('That name cannot be a folder name.');
    if (!path.isAbsolute(parent)) throw new Error('That folder is not on this computer.');
    try {
      if (!statSync(parent).isDirectory()) throw new Error();
    } catch {
      throw new Error('That folder is not on this computer.');
    }
    const target = path.join(parent, n);
    if (path.dirname(target) !== path.resolve(parent)) throw new Error('That name cannot be a folder name.');
    try {
      mkdirSync(target);
    } catch (err) {
      throw new Error((err as NodeJS.ErrnoException).code === 'EEXIST' ? 'A folder with that name is already there.' : 'The folder could not be made there.');
    }
    return { path: target };
  }

  private async serveFile(req: IncomingMessage, res: ServerResponse) {
    const token = (req.url ?? '').split('/')[2] ?? '';
    const entry = this.files.get(token);
    const fail = (code: number, text: string) => void res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(text);
    if (!entry) return fail(404, 'Not found');
    if (entry.expires < Date.now()) {
      this.files.delete(token);
      return fail(410, 'This link has expired. Open the file again in Sable.');
    }
    // The phone it was made for is still paired and phone access is on.
    if (!this.data.enabled || !this.data.devices.some((d) => d.id === entry.deviceId)) {
      this.files.delete(token);
      return fail(404, 'Not found');
    }
    // The file as it was when the link was made, read through the handle that was checked.
    const opened = await openGrant(entry);
    if ('code' in opened) return fail(opened.code, opened.text);
    const type = /\.apk$/i.test(entry.name) ? 'application/vnd.android.package-archive' : 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': String(entry.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    if (!entry.size) {
      await opened.fh.close().catch(() => {});
      return void res.end();
    }
    opened.fh
      .createReadStream({ start: 0, end: entry.size - 1 })
      .on('error', () => res.destroy())
      .pipe(res);
  }

  private onUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer) {
    const ip = req.socket.remoteAddress ?? '?';
    const url = new URL(req.url ?? '/', 'http://phone');
    const refuse = (code: number, text: string) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nconnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== PHONE_PATH) return refuse(404, 'Not Found');
    if (!originAllowed(req)) return refuse(403, 'Forbidden');
    if (this.blocked(ip)) return refuse(429, 'Too Many Requests');
    if (wss.clients.size >= MAX_SOCKETS) return refuse(503, 'Service Unavailable');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }

  /**
   * One frame to a phone, within its budget (`FRAME_MAX`): a result too big for it goes as an error,
   * an event too big is left out (an item event goes as its conversation's newest page instead).
   */
  private sendFrame(ws: WebSocket, frame: PhoneFrame | ServerFrame) {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      ws.terminate();
      return;
    }
    let json = JSON.stringify(frame);
    const f = frame as { id?: unknown; event?: BridgeEvent };
    if (f.event && json.length > FRAME_MAX.event) {
      const page = this.pageFor(f.event);
      json = page ? JSON.stringify({ event: page }) : '';
      if (!json || json.length > FRAME_MAX.event) {
        this.app.log(`phone: left out a ${f.event.type} event too big for the phone`);
        return;
      }
    } else if (typeof f.id === 'number' && json.length > FRAME_MAX.result) {
      json = JSON.stringify({ id: f.id, ok: false, error: 'That is too big to send to the phone.' });
    }
    ws.send(json);
  }

  /** In place of an item event too big for a phone: the newest page of its conversation. */
  private pageFor(e: BridgeEvent): BridgeEvent | PhoneReset | null {
    if (!ITEM_EVENTS.has(e.type)) return null;
    const rt = this.app.sessions.get((e as { sessionId: string }).sessionId);
    return rt ? phoneEvent({ type: 'timeline.reset', sessionId: rt.id, items: rt.items }) : null;
  }

  private onSocket(ws: WebSocket, req: IncomingMessage) {
    const ip = req.socket.remoteAddress ?? '?';
    let state: 'hello' | 'waiting' | 'open' = 'hello';
    const helloTimer = setTimeout(() => {
      if (state === 'hello') ws.close(4000, 'timeout');
    }, HELLO_TIMEOUT_MS);

    const hello = (raw: RawData) => {
      if (state !== 'hello') return;
      const text = raw.toString();
      if (text.length > MAX_HELLO_BYTES) return ws.close(1009, 'too big');
      // Its shape first (an object with a token or a key): anything else closes this socket and nothing more.
      const msg: PhoneHello | null = readHello(text);
      if (!msg) return ws.close(4000, 'bad hello');
      if ('hello' in msg) {
        const hash = sha256(msg.hello.token);
        const device = this.data.devices.find((d) => timingSafeEqual(Buffer.from(d.tokenHash, 'hex'), Buffer.from(hash, 'hex')));
        if (!device) {
          this.failed(ip);
          this.sendFrame(ws, { denied: 'This phone is not paired with this computer' });
          return ws.close(4001, 'unknown token');
        }
        this.fails.delete(ip);
        clearTimeout(helloTimer);
        ws.off('message', onHello);
        state = 'open';
        this.authenticated(ws, device);
        return;
      }
      if ('pair' in msg && msg.pair && typeof msg.pair.key === 'string') {
        const p = this.pairing;
        if (!p || p.expiresAt < Date.now() || !sameSecret(msg.pair.key, p.key)) {
          this.failed(ip);
          this.sendFrame(ws, { denied: p ? 'This pairing code is not valid. Show a new one on the desktop.' : 'Pairing is not open. Show the code in Settings › Phone.' });
          return ws.close(4002, 'bad key');
        }
        // One phone per key; a second request replaces nothing while one waits.
        if (this.request) {
          this.sendFrame(ws, { denied: 'Another phone is pairing. Try again in a moment.' });
          return ws.close(4003, 'busy');
        }
        this.pairing = undefined;
        clearTimeout(helloTimer);
        state = 'waiting';
        const id = randomUUID();
        this.request = {
          id,
          name: cleanName(msg.pair.name),
          address: ip.replace(/^::ffff:/, ''),
          at: Date.now(),
          ws,
          timer: setTimeout(() => {
            if (this.request?.id === id) {
              this.endRequest('Nobody answered on the desktop');
              this.changed();
            }
          }, REQUEST_TTL_MS),
        };
        this.sendFrame(ws, { waiting: true });
        ws.off('message', onHello);
        this.changed();
        return;
      }
      ws.close(4000, 'bad hello');
    };
    // Nothing thrown while a first frame is read leaves this listener: only this socket closes.
    const onHello = (raw: RawData) => {
      try {
        hello(raw);
      } catch (err) {
        this.app.log('phone: a first frame failed', (err as Error).message);
        ws.close(4000, 'bad hello');
      }
    };
    ws.on('message', onHello);
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (this.request?.ws === ws) {
        clearTimeout(this.request.timer);
        this.request = undefined;
        this.changed();
      }
    });
    ws.on('error', () => ws.terminate());
  }

  /** From here on the socket is a narrowed bridge connection for `device`. */
  private authenticated(ws: WebSocket, device: StoredPhone) {
    device.lastSeen = Date.now();
    this.save();
    let set = this.live.get(device.id);
    if (!set) this.live.set(device.id, (set = new Set()));
    set.add(ws);
    // Its addresses now: a phone keeps new ones (Tailscale, a new network) and reaches it there later.
    this.sendFrame(ws, { welcome: { deviceId: device.id, desktop: os.hostname(), version: VERSION, hosts: lanAddresses() } });
    this.changed();

    // The conversations this socket has open (opened last at the end): their items' events reach it.
    const watching: string[] = [];
    const watch = (id: string) => {
      const i = watching.indexOf(id);
      if (i >= 0) watching.splice(i, 1);
      watching.push(id);
      if (watching.length > WATCH_MAX) watching.shift();
    };
    const unsubscribe = this.app.subscribe((event) => {
      if (!PHONE_EVENTS.has(event.type)) return;
      if (ITEM_EVENTS.has(event.type) && !watching.includes((event as { sessionId: string }).sessionId)) return;
      const e = phoneEvent(event);
      if (e) this.sendFrame(ws, { event: e as BridgeEvent });
    });
    let alive = true;
    ws.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 25_000);

    ws.on('message', async (raw) => {
      let req: RpcRequest;
      try {
        req = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof req?.id !== 'number' || typeof req.method !== 'string') return;
      if (!ALLOWED.has(req.method) && !OWN.has(req.method)) {
        this.sendFrame(ws, { id: req.id, ok: false, error: `Not available from the phone: ${req.method}` });
        return;
      }
      try {
        const raw = req.params && typeof req.params === 'object' ? (req.params as Record<string, unknown>) : {};
        const own = req.method as string;
        let result: unknown;
        if (own === 'phone.fileLink') {
          result = await this.fileLink(device.id, String(raw.sessionId ?? ''), String(raw.itemId ?? ''), Number(raw.index ?? 0));
        } else if (own === 'phone.mkdir') {
          result = this.makeFolder(String(raw.parent ?? ''), String(raw.name ?? ''));
        } else if (own === 'phone.changes') {
          result = await this.changes.changes(String(raw.sessionId ?? ''), stepIds(raw.items));
        } else if (own === 'phone.diff') {
          result = await this.changes.diff(String(raw.sessionId ?? ''), typeof raw.path === 'string' ? raw.path : '', stepIds(raw.items));
        } else if (own === 'phone.search') {
          result = await this.finder.search(typeof raw.query === 'string' ? raw.query : '');
        } else if (own === 'phone.image') {
          result = await this.image(String(raw.sessionId ?? ''), String(raw.itemId ?? ''), Number(raw.index ?? 0));
        } else if (own === 'phone.tail' || own === 'phone.item') {
          const sessionId = String(raw.sessionId ?? '');
          // The session's own snapshot (loads it from disk the first time, marks it read), then trimmed.
          const snap = await this.app.call('session.snapshot', { sessionId });
          if (own === 'phone.tail') {
            watch(sessionId);
            const before = typeof raw.before === 'string' ? raw.before : undefined;
            const limit = typeof raw.limit === 'number' ? raw.limit : undefined;
            const to = typeof raw.to === 'string' ? raw.to : undefined;
            result = phoneTail(snap, { before, limit, to });
          } else result = phoneDetail(snap.items, String(raw.itemId ?? ''));
        } else {
          const params = narrow(req.method, raw, (sessionId, id) => this.app.sessions.get(sessionId)?.queue.find((q) => q.id === id)?.attachments);
          result = phoneResult(req.method, await this.app.call(req.method as RpcName, params as never));
          // Folder browsing for a new chat: folders only, never file names.
          if (req.method === 'fs.list' && result && typeof result === 'object') {
            const r = result as { entries?: { dir: boolean }[] };
            result = { ...r, entries: (r.entries ?? []).filter((e) => e.dir) };
          }
          // A conversation (opened, created, carried to another account): its newest page, never all of it.
          if (isSnapshot(result)) {
            watch(result.session.id);
            result = phoneTail(result);
          }
        }
        this.sendFrame(ws, { id: req.id, ok: true, result });
      } catch (err) {
        this.sendFrame(ws, { id: req.id, ok: false, error: (err as Error).message ?? String(err) });
      }
    });
    const done = () => {
      clearInterval(ping);
      unsubscribe();
      const s = this.live.get(device.id);
      s?.delete(ws);
      if (s && !s.size) this.live.delete(device.id);
      const d = this.data.devices.find((x) => x.id === device.id);
      if (d) {
        d.lastSeen = Date.now();
        this.save();
      }
      this.changed();
    };
    ws.once('close', done);
  }

  async dispose() {
    clearTimeout(this.saveTimer);
    this.save(true);
    await this.stop();
  }
}

export function registerPhone(app: App, opts: PhoneOptions = {}) {
  const phone = new PhoneService(app, opts);
  app.register('phone.status', () => phone.status());
  app.register('phone.setEnabled', ({ on }) => phone.setEnabled(!!on));
  app.register('phone.pair', ({ cancel } = {}) => phone.pair(!!cancel));
  app.register('phone.approve', ({ requestId, allow }) => phone.approve(String(requestId), !!allow));
  app.register('phone.revoke', ({ deviceId }) => phone.revoke(String(deviceId)));
  app.onDispose(() => phone.dispose());
  if (phone.enabled) void phone.start();
  return phone;
}
