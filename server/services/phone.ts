import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { answerHello, loadIdentity, PlainLink, readSecHello, SealedLink, type Identity, type Link, type SecHello } from './phone-secure';
import {
  PHONE_METHODS,
  PHONE_OWN_METHODS,
  PHONE_PATH,
  PHONE_PORT,
  PAIR_LINK_PREFIX,
  type AppState,
  type Attachment,
  type BridgeEvent,
  type DiffHunk,
  type FileDiff,
  type PhoneDevice,
  type PhoneFrame,
  type PhoneHello,
  type PhoneItem,
  type PhonePermission,
  type PhoneQuestion,
  type PhoneQuestionRequest,
  type PhoneReset,
  type PhoneRetryReply,
  type PhoneStale,
  type PhoneStatus,
  type PhoneTail,
  type PermissionRequest,
  type QuestionRequest,
  type QueuedMessage,
  type RpcName,
  type RpcRequest,
  type ServerFrame,
  type SessionMeta,
  type SessionSnapshot,
  type TimelineItem,
  type TrackedWork,
  type ToolDetail,
  type ToolItem,
  type ToolResult,
  type WorkflowRun,
} from '../../shared/protocol';
import { canonicalName, isPackageName } from '../../shared/file-name';
import { partOfTurn, syntheticOf } from '../../shared/synthetic';
import type { App } from '../app';
import { fileLine, saveLines, scopeLines } from '../core/permission-scope';
import { cap, isLight, LIGHT, isSnapshot, lines, sessionPatchForJson } from '../core/trim';
import { VERSION } from '../version';
import { PhoneChangesReader, relTo, stepIds } from './phone-changes';
import { phoneRefusal } from './custom';
import { blockDigests, FILE_CHUNK, PhoneFiles, RetryLater } from './phone-files';
import { FRAME_MAX, grantFor, openGrant, phoneAttachments, readHello, type FileGrant } from './phone-guard';
import { qrMatrix, qrSvgPath } from './qr';
import { searchOf, type ChatSearch } from './search';
import { pictureOf } from './thumbs';

/** The search limits, as the phone's tests read them (the search itself is in search.ts). */
export { SEARCH } from './search';

/**
 * The phone endpoint: Sable's phone app (`mobile/`) on the home network.
 *
 * - Its own HTTP server on all interfaces at `PHONE_PORT`, started only while Settings › Phone is
 *   on. The localhost bridge is untouched: nothing here is reachable through it, and the phone
 *   never reaches the localhost bridge.
 * - Pairing: a one-time key (QR code / link, valid 10 minutes, used up by the first phone that
 *   presents it), then "Allow <phone>?" on the desktop. An allowed phone gets a 256-bit token,
 *   stored here only as a SHA-256 hash; Settings › Phone revokes it.
 * - The secure channel (phone-secure.ts): the link carries the desktop's identity key fingerprint;
 *   the phone checks the desktop's signed handshake against it, and every frame after it is sealed
 *   (AES-GCM, keys bound to the pairing key or the token, sequence-numbered). Pairing happens only
 *   that way; a phone paired before it keeps its plain connection until it pairs again, and a phone
 *   paired securely never connects plain.
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
 * - A small picture of a file the agent handed over (`phone.thumb`, thumbs.ts `pictureOf` by the
 *   phone's rule: the very file the share step handed over, unchanged, as a download link), for its row.
 */

interface StoredPhone {
  id: string;
  name: string;
  /** SHA-256 of the token, hex. */
  tokenHash: string;
  pairedAt: number;
  lastSeen?: number;
  /** Paired over the secure channel: it may connect only that way (phone-secure.ts). */
  secure?: true;
}

interface PhoneFile {
  generation?: number;
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
  /** The desktop's identity key for the secure channel (defaults to `phone-identity.pem` beside `file`). */
  identity?: string;
}

const PAIR_TTL_MS = 10 * 60_000;
/** Live migration tickets one phone may hold at once (`phone.migrate` asked again keeps the earlier ones). */
const TICKETS_PER_PHONE = 4;
/** A queued message a phone takes back with a receipt stays reserved this long for its word (`phone.takeDone`); a receipt is remembered this long after. */
const TAKE_HOLD_MS = 45_000;
const TAKE_KEEP_MS = 15 * 60_000;
const REQUEST_TTL_MS = 2 * 60_000;
const HELLO_TIMEOUT_MS = 8_000;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60_000;
const BLOCK_MS = 15 * 60_000;
const GLOBAL_FAILS_PER_MIN = 30;
const MAX_SOCKETS = 12;
const MAX_HELLO_BYTES = 4096;
/** How soon a failed write of the paired phones is tried again. */
const SAVE_RETRY_MS = 3000;
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

// The phone can arm a reset only for the particular limit card it shows (narrow).
const ALLOWED = new Set<string>([...PHONE_METHODS, 'spare.atReset']);
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
/** A widget's own pictures (`<img src="data:image/png;base64,...">`): what a phone shows of it. */
const WIDGET_PIC = /data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}/g;
/** Shorter sources are spacers and dots (a 1 px GIF), not pictures. */
const WIDGET_PIC_MIN = 256;
const widgetPicsOf = new WeakMap<object, string[]>();

/**
 * The pictures in a widget's code, in order, each source once, at most `MAX_PICS`: a phone shows
 * them after any pictures of the step's result (`phone.image` by the same index). Remembered per
 * input (an item's input is replaced, never changed, so a page reads a long code once).
 */
export function widgetPics(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const code = (input as { code?: unknown }).code;
  if (typeof code !== 'string' || !code.includes('data:image/')) return [];
  const known = widgetPicsOf.get(input);
  if (known) return known;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of code.matchAll(WIDGET_PIC)) {
    const src = m[0];
    if (src.length < WIDGET_PIC_MIN || seen.has(src)) continue;
    seen.add(src);
    out.push(src);
    if (out.length >= MAX_PICS) break;
  }
  widgetPicsOf.set(input, out);
  return out;
}

/** How many pictures a phone may ask for: a result's (a screenshot), then a widget's own. */
function picCount(it: Partial<ToolItem>, kind: string | undefined = it.kind): number {
  const n = (it.result?.images?.length ?? (isLight(it) ? it[LIGHT].pictures : 0)) + (kind === 'widget' ? widgetPics(it.input).length : 0);
  return Math.min(n, MAX_PICS);
}

/** How wide a file row's picture is made for the phone (a 40 px tile at up to 4x). */
const PHONE_THUMB_PX = 160;
/** `phone.tail` with `to`: how far back a page may reach for the item asked for (roots, bytes). */
export const REACH = { roots: 2400, bytes: 3_000_000 };

const DETAIL_TEXT = ['command', 'description', 'cwd', 'path', 'url', 'query', 'pattern', 'glob', 'subagent', 'server', 'tool', 'skill', 'caption'] as const;

function trimDetail(d: ToolDetail | undefined, n: number, full = false): ToolDetail {
  const out: ToolDetail = {};
  if (!d) return out;
  for (const k of DETAIL_TEXT) if (typeof d[k] === 'string') out[k] = cap(d[k] as string, n);
  if (d.range) out.range = d.range;
  // A `share` step: the files' names and sizes for its cards (the phone downloads one through
  // `phone.fileStart`). The name canonical, as the download names it, so a card never shows one name
  // ("setup.apk " with a space, a bidi override) and saves another.
  if (d.files) out.files = d.files.slice(0, 12).map((f) => ({ path: cap(f.path, 400), name: canonicalName(f.name), ...(typeof f.size === 'number' ? { size: f.size } : {}) }));
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
      const { attachments, issuedTo, more: _more, ...rest } = it;
      Reflect.deleteProperty(rest, LIGHT);
      return { ...rest, ...textCap(it.text, full ? FULL.text : it.until ? LIMITS.step : LIMITS.answer), ...(attachments ? { attachments: trimAttachments(attachments) } : {}), ...until };
    }
    case 'text':
      return { ...it, ...textCap(it.text, full ? FULL.text : opts.role === 'step' ? LIMITS.step : LIMITS.answer) };
    case 'thinking': {
      const { more, ...rest } = it;
      Reflect.deleteProperty(rest, LIGHT);
      return { ...rest, ...textCap(it.text, full ? FULL.thinking : LIMITS.thinking), ...(more ? { cut: true } : {}) };
    }
    case 'notice':
      return { ...it, text: cap(it.text, full ? FULL.field : LIMITS.notice), ...(it.detail ? { detail: cap(it.detail, full ? FULL.field : LIMITS.notice) } : {}), ...until };
    case 'turn':
      return it.error ? { ...it, error: cap(it.error, LIMITS.notice) } : it;
    case 'tool': {
      const n = full ? FULL.field : LIMITS.field;
      const detail = trimDetail(it.detail, n, full);
      // The desktop infers a background job from legacy shell input. A phone row
      // historically carries this flag only when the provider set it in detail.
      if (isLight(it) && it[LIGHT].legacyBackground) delete detail.background;
      const out: PhoneItem = {
        id: it.id,
        ts: it.ts,
        ...(it.parentId ? { parentId: it.parentId } : {}),
        type: 'tool',
        name: cap(it.name, 120),
        kind: it.kind,
        title: cap(it.title, 300),
        status: it.status,
        ...(it.delegateReport ? { delegateReport: it.delegateReport } : {}),
        ...(it.delegateWait ? { delegateWait: it.delegateWait } : {}),
        ...(it.delegateReceiptState && { delegateReceiptState: it.delegateReceiptState }),
        ...(it.delegateRetryId && { delegateRetryId: it.delegateRetryId }),
        detail,
        ...(it.endedAt ? { endedAt: it.endedAt } : {}),
        ...(it.waitedMs ? { waitedMs: it.waitedMs } : {}),
        ...(it.result ? { result: trimResult(it.result, full) } : {}),
        ...(it.workflow ? { workflow: trimWorkflow(it.workflow) } : {}),
        ...(it.task ? { task: { ...it.task, id: cap(it.task.id, 200), ...(typeof it.task.serving === 'string' && { serving: cap(it.task.serving, 300) }) } } : {}),
        ...(it.tracked ? { tracked: phoneTracked(it.tracked) } : {}),
        // A check of a turn by the other agent: which turn and who, and its findings (they are its answer).
        ...(it.check ? { check: it.check } : {}),
        ...(opts.kids ? { kids: opts.kids } : {}),
        ...(!full && (hasMore(it) || isLight(it) && it[LIGHT].hunks) ? { more: true } : {}),
        // Pictures (a screenshot, a widget's own) stay on the desktop: their count, and `phone.image` for each.
        ...(picCount(it) ? { pics: picCount(it) } : {}),
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

/**
 * Tracked work as a phone gets it: the row's words (who runs it, the log's last line, where it stands
 * and since when), never the log's place on this computer, the process id or its start.
 */
export function phoneTracked(t: TrackedWork): TrackedWork {
  return {
    pid: 0,
    state: t.state,
    since: t.since,
    ...(t.endedAt ? { endedAt: t.endedAt } : {}),
    ...(t.by ? { by: cap(t.by, 80) } : {}),
    ...(t.line ? { line: cap(t.line, 300) } : {}),
  };
}

/**
 * A patch to an item, trimmed like the item (no output, input, images or the record of what a share
 * handed over; long text cut). `kind`: the item's own (a widget's input brings its pictures).
 */
export function phonePatch(patch: Partial<TimelineItem>, kind?: string): Partial<PhoneItem> | null {
  const p = { ...patch } as Record<string, unknown>;
  delete p[LIGHT];
  delete p.input;
  delete p.inputText;
  delete p.output;
  // What a share handed over (real paths, file ids, grants) stays on the desktop, as in a page.
  delete p.handed;
  delete p.delegateAttempt;
  delete p.delegateCaller;
  delete p.delegateReceiversPending;
  delete p.issuedTo;
  delete p.delegateContinuations;
  delete p.delegateDeliveryId;
  if (p.detail) p.detail = trimDetail(p.detail as ToolDetail, LIMITS.field);
  if (p.result) p.result = trimResult(p.result as ToolResult);
  if (p.workflow) p.workflow = trimWorkflow(p.workflow as WorkflowRun);
  if (p.tracked) p.tracked = phoneTracked(p.tracked as TrackedWork);
  if (p.attachments) p.attachments = trimAttachments(p.attachments as Attachment[]);
  if (typeof p.text === 'string' && p.text.length > LIMITS.answer) {
    p.text = p.text.slice(0, LIMITS.answer);
    p.cut = true;
  }
  if (typeof p.detail === 'string') p.detail = cap(p.detail, LIMITS.notice);
  if (typeof p.error === 'string') p.error = cap(p.error, LIMITS.notice);
  if ((patch as Partial<ToolItem>).output || (patch as Partial<ToolItem>).result?.text) p.more = true;
  // A widget's code arrives with its input (streamed, then patched in whole): its pictures counted then.
  const pics = picCount(patch as Partial<ToolItem>, (patch as Partial<ToolItem>).kind ?? kind);
  if (pics) p.pics = pics;
  return Object.keys(p).length ? (p as Partial<PhoneItem>) : null;
}

/** A change a phone is asked to allow: whole hunks while they fit (files, lines, characters). */
const ASK_DIFF = { files: 6, lines: 600, chars: 40_000, line: 2000 };

/** The change of a permission request for the phone, and whether any of it was left out or shortened. */
function askDiff(diff: FileDiff[]): { diff: FileDiff[]; cut: boolean } {
  let cut = diff.length > ASK_DIFF.files;
  let lines = 0;
  let chars = 0;
  const out = diff.slice(0, ASK_DIFF.files).map((f): FileDiff => {
    if (f.path.length > 400 || (f.oldPath?.length ?? 0) > 400) cut = true;
    const hunks: DiffHunk[] = [];
    for (const h of f.hunks) {
      const kept: string[] = [];
      for (const l of h.lines) {
        if (lines >= ASK_DIFF.lines || chars + Math.min(l.length, ASK_DIFF.line) > ASK_DIFF.chars) break;
        if (l.length > ASK_DIFF.line) cut = true;
        kept.push(cap(l, ASK_DIFF.line));
        lines++;
        chars += Math.min(l.length, ASK_DIFF.line);
      }
      if (kept.length < h.lines.length) cut = true;
      if (kept.length || !h.lines.length) hunks.push({ ...h, lines: kept });
      if (kept.length < h.lines.length) break;
    }
    if (hunks.length < f.hunks.length) cut = true;
    return { path: cap(f.path, 400), ...(f.oldPath ? { oldPath: cap(f.oldPath, 400) } : {}), status: f.status, additions: f.additions, deletions: f.deletions, ...(f.binary ? { binary: true } : {}), hunks };
  });
  return { diff: out, cut };
}

/** Words of a permission request the phone shows, and how long each may be. */
const ASK_TEXT = { title: 300, description: FULL.field, reason: LIMITS.notice, label: 200, hint: LIMITS.field, id: 200 };

/**
 * A permission request as a phone gets it, cut like a step opened in full (`phone.item`): what it
 * shows (title, command, path, url, plan, the change's first hunks), never an edit's whole text.
 * `incomplete` when any of what it would allow was shortened or left out (a command, a list of
 * folders in its description, the change's lines, an option): then the phone may only decline it
 * (`phoneAllowed`), the desktop has the whole of it. An "always" answer whose saves do not all show
 * whole (each with what it does and where it is kept, review wave 6, #5) is not among the phone's
 * options: only the desktop offers it.
 * Every field is its own bounded copy (review wave 6, #15): nothing of the request is passed on as
 * it came (its `scope` stays on the desktop once it was checked to show), so a record is never
 * bigger than its caps.
 */
export function phonePermission(p: PermissionRequest): PhonePermission {
  let cut = false;
  const c = (s: string, n: number) => {
    if (s.length > n) cut = true;
    return cap(s, n);
  };
  const text = (s: unknown) => (typeof s === 'string' ? s : '');
  const d = p.detail ?? {};
  const detail = trimDetail(d, FULL.field, true);
  for (const k of DETAIL_TEXT) if (typeof d[k] === 'string' && (d[k] as string).length > FULL.field) cut = true;
  if (typeof d.prompt === 'string' && d.prompt.length > FULL.field) cut = true;
  if (typeof d.plan === 'string') detail.plan = c(d.plan, FULL.thinking);
  if (d.files && (d.files.length > 12 || d.files.some((f) => f.path.length > 400 || f.name.length > 200))) cut = true;
  const change = p.diff ? askDiff(p.diff) : undefined;
  if (change?.cut) cut = true;
  // An edit's own text is what it allows where no whole change shows it.
  if (!change || change.cut) for (const k of ['oldText', 'newText', 'content'] as const) if (typeof d[k] === 'string' && (d[k] as string).length > FULL.field) cut = true;
  const all = Array.isArray(p.options) ? p.options : [];
  if (all.length > 12) cut = true;
  // An option is answered by its id: one too long to pass on whole is left out (and the request is the desktop's).
  const options = all.slice(0, 12).filter((o) => {
    const ok = !!o && typeof o.id === 'string' && o.id.length <= ASK_TEXT.id;
    if (!ok) cut = true;
    return ok;
  });
  const out: PhonePermission = {
    id: p.id,
    sessionId: p.sessionId,
    ...(typeof p.itemId === 'string' && p.itemId.length <= ASK_TEXT.id ? { itemId: p.itemId } : {}),
    ...(typeof p.delegateId === 'string' && p.delegateId.length <= ASK_TEXT.id ? { delegateId: p.delegateId } : {}),
    toolName: cap(text(p.toolName), ASK_TEXT.label),
    kind: p.kind,
    title: c(text(p.title), ASK_TEXT.title),
    ...(p.description ? { description: c(p.description, ASK_TEXT.description) } : {}),
    ...(p.reason ? { reason: c(p.reason, ASK_TEXT.reason) } : {}),
    detail,
    ...(change ? { diff: change.diff } : {}),
    options: options.map((o) => ({ id: o.id, label: c(text(o.label), ASK_TEXT.label), ...(o.hint ? { hint: c(o.hint, ASK_TEXT.hint) } : {}), tone: o.tone })),
    ...(p.allowFeedback ? { allowFeedback: true } : {}),
    createdAt: p.createdAt,
  };
  if (!scopeShown(p.scope, out)) cut = true;
  // What "always" saves, all of it in words, or that answer is the desktop's alone.
  if (p.scope && !savesShown(p.scope, out)) out.options = out.options.filter((o) => o.tone !== 'always');
  return cut ? { ...out, incomplete: true } : { ...out, revision: sha256(JSON.stringify(out)) };
}

/** Whether every save of an "always" answer shows whole as a line of the description or reason (and none is unnamed). */
function savesShown(scope: NonNullable<PermissionRequest['scope']>, shown: PhonePermission): boolean {
  if (scope.savesUnknown) return false;
  const said = new Set([...(shown.description?.split('\n') ?? []), ...(shown.reason?.split('\n') ?? [])]);
  return saveLines(scope.saves).every((l) => said.has(l));
}

/**
 * Whether the phone shows all of where an approval reaches (`PermissionScope`): each grant root,
 * network destination and sandbox path as a whole line of its description or reason, each changed
 * file in the change the phone gets (a moved one with both ends) or as its own line. A scope not
 * known yet (an approval that came before its change) is never shown whole.
 */
function scopeShown(scope: PermissionRequest['scope'], shown: PhonePermission): boolean {
  if (!scope) return true;
  if (scope.unknown) return false;
  const said = new Set([...(shown.description?.split('\n') ?? []), ...(shown.reason?.split('\n') ?? [])]);
  // What "always" saves is checked on its own (`savesShown`): it decides that answer alone.
  const saves = new Set(saveLines(scope.saves));
  if (scopeLines(scope).some((l) => !saves.has(l) && !said.has(l))) return false;
  return (scope.files ?? []).every((f) => said.has(fileLine(f)) || !!shown.diff?.some((d) => d.path === f.path && (f.from ? d.oldPath === f.from : !d.oldPath || d.oldPath === d.path)));
}

/**
 * Refuses an answer from the phone that allows more than the phone was shown: any option but a
 * decline of an `incomplete` request (the desktop answers that one). An option the request does not
 * have is refused too. Nothing for a request that is gone (the bridge says so).
 */
export function phoneAllowed(req: PermissionRequest | undefined, optionId: unknown): void {
  if (!req) return;
  const o = req.options.find((x) => x.id === optionId);
  if (!o) throw new Error('That is not one of the answers to this request.');
  const shown = phonePermission(req);
  if (o.tone !== 'deny' && shown.incomplete) throw new Error('This request is longer than the phone shows. Answer it on the desktop.');
  // An answer the phone was not offered (an "always" whose saves it cannot show whole).
  if (!shown.options.some((x) => x.id === o.id)) throw new Error('That answer is only on the desktop.');
}

/** Questions and options a phone gets, and how long their words may be (also `incomplete` when two questions read the same). */
const ASK_Q = { questions: 12, options: 24, question: FULL.field, header: 200, label: 300, description: LIMITS.field, other: 4000 };

/**
 * A question as a phone gets it: stable ids for each question (`q<i>`) and option (`o<j>`, its place
 * in that question) to answer by (`phone.answer`), the words for display only, cut (`cut` on that
 * question). `incomplete` when questions or options were left out: only the desktop answers those.
 */
export function phoneQuestion(q: QuestionRequest): PhoneQuestionRequest {
  // Two questions in the same words would come back as one answer (the agent's answers are keyed by
  // a question's words): only the desktop answers those.
  const twice = new Set(q.questions.map((x) => x.question)).size !== q.questions.length;
  const incomplete = twice || q.questions.length > ASK_Q.questions || q.questions.some((x) => x.options.length > ASK_Q.options);
  // Each field its own bounded copy (review wave 6, #15): nothing else of the request goes along.
  const out: PhoneQuestionRequest = {
    id: q.id,
    sessionId: q.sessionId,
    ...(typeof q.itemId === 'string' && q.itemId.length <= ASK_TEXT.id ? { itemId: q.itemId } : {}),
    ...(typeof q.delegateId === 'string' && q.delegateId.length <= ASK_TEXT.id ? { delegateId: q.delegateId } : {}),
    createdAt: q.createdAt,
    questions: q.questions.slice(0, ASK_Q.questions).map((x, i): PhoneQuestion => {
      const cut = x.question.length > ASK_Q.question || (x.header?.length ?? 0) > ASK_Q.header || x.options.some((o) => o.label.length > ASK_Q.label || (o.description?.length ?? 0) > ASK_Q.description);
      return {
        id: `q${i}`,
        question: cap(x.question, ASK_Q.question),
        ...(x.header ? { header: cap(x.header, ASK_Q.header) } : {}),
        ...(x.multiSelect ? { multiSelect: true } : {}),
        options: x.options.slice(0, ASK_Q.options).map((o, j) => ({ id: `o${j}`, label: cap(o.label, ASK_Q.label), ...(o.description ? { description: cap(o.description, ASK_Q.description) } : {}) })),
        ...(cut ? { cut: true as const } : {}),
      };
    }),
  };
  return incomplete ? { ...out, incomplete: true } : out;
}

const plainObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * `phone.answer`: the phone's picks (per question id, option ids and words of its own) as the
 * answers the agent gets, keyed by the original question with the original option labels. Throws
 * for an incomplete request, a question left unanswered, an id that is not there, two answers to a
 * single-answer question.
 */
export function phonePicks(req: QuestionRequest, picks: unknown): Record<string, string[]> {
  if (phoneQuestion(req).incomplete) throw new Error('These questions are longer than the phone shows. Answer them on the desktop.');
  const given = plainObject(picks);
  if (!given) throw new Error('Answer every question.');
  const ids = new Set(req.questions.map((_, i) => `q${i}`));
  if (Object.keys(given).some((k) => !ids.has(k))) throw new Error('That answer is for a question that is not there.');
  const out: Record<string, string[]> = {};
  req.questions.forEach((q, i) => {
    const p = plainObject(given[`q${i}`]) ?? {};
    const opts = p.options === undefined ? [] : p.options;
    if (!Array.isArray(opts)) throw new Error('That is not one of the answers to this question.');
    const labels = opts.map((id) => {
      const m = typeof id === 'string' ? /^o(\d{1,3})$/.exec(id) : null;
      const o = m ? q.options[Number(m[1])] : undefined;
      if (!o) throw new Error('That is not one of the answers to this question.');
      return o.label;
    });
    if (new Set(labels).size !== labels.length) throw new Error('That answer was picked twice.');
    if (p.other !== undefined && typeof p.other !== 'string') throw new Error('Answer every question.');
    const other = typeof p.other === 'string' ? p.other.trim() : '';
    if (other.length > ASK_Q.other) throw new Error('That answer is too long.');
    const list = other ? [...labels, other] : labels;
    if (!list.length) throw new Error('Answer every question.');
    if (!q.multiSelect && list.length > 1) throw new Error('Pick one answer to that question.');
    out[q.question] = list;
  });
  return out;
}

/**
 * `question.respond` from the phone in the shape keyed by the question's words (a phone app from
 * before `phone.answer`): taken only when it is not lossy, i.e. the phone got every question and
 * option whole and the answer names each question by its exact words. Null (skipping) always goes.
 */
export function phoneWordAnswers(req: QuestionRequest, answers: unknown): Record<string, string[]> | null {
  if (answers === null) return null;
  const shortened = phoneQuestion(req).incomplete || req.questions.some((q) => q.question.length > ASK_Q.question || q.options.some((o) => o.label.length > ASK_Q.label));
  if (shortened) throw new Error('These questions were shortened on the phone. Answer them on the desktop.');
  const given = plainObject(answers);
  if (!given) throw new Error('Answer every question.');
  const words = new Set(req.questions.map((q) => q.question));
  if (Object.keys(given).some((k) => !words.has(k))) throw new Error('That answer is for a question that is not there.');
  const out: Record<string, string[]> = {};
  for (const q of req.questions) {
    const v = given[q.question];
    if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== 'string' || !x.trim() || x.length > ASK_Q.other)) throw new Error('Answer every question.');
    out[q.question] = v as string[];
  }
  return out;
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

/**
 * A bounded page of root items `around` one (a search hit far back: some before it, some after,
 * whole turns), or the page that starts `after` at one, toward the newest. `cursor` is the page
 * before (as `phonePage`'s), `next` the first root after it when it stops before the newest. Throws
 * when the item is not a root of this conversation (rewound, or another chat's).
 */
export function phoneWindow(items: TimelineItem[], opts: { around?: string; after?: string; limit?: number; budget?: number }): { items: PhoneItem[]; cursor?: string; next?: string; total: number } {
  const roots: TimelineItem[] = [];
  const kids = new Map<string, number>();
  for (const it of items) {
    if (it.parentId) kids.set(it.parentId, (kids.get(it.parentId) ?? 0) + 1);
    else roots.push(it);
  }
  const total = roots.length;
  const id = opts.around ?? opts.after;
  const at = id ? roots.findIndex((r) => r.id === id) : -1;
  if (at < 0) throw new Error('That message is no longer in this chat.');
  const limit = Math.max(1, Math.min(PAGE_MAX, opts.limit ?? (opts.around ? PAGE_ITEMS * 1.5 : PAGE_ITEMS)));
  const budget = opts.budget ?? PAGE_BYTES;
  const roleAt = (i: number): 'answer' | 'step' => {
    if (roots[i].type !== 'text') return 'answer';
    for (let j = i + 1; j < total; j++) {
      const t = roots[j];
      if (turnStart(t) || t.type === 'turn') return 'answer';
      if (t.type === 'tool' || t.type === 'thinking') return 'step';
    }
    return 'answer';
  };
  const made = new Map<number, PhoneItem>();
  let bytes = 0;
  const take = (i: number) => {
    const p = phoneItem(roots[i], { role: roleAt(i), kids: kids.get(roots[i].id) });
    made.set(i, p);
    bytes += JSON.stringify(p).length;
  };
  let s = at;
  let e = at + 1;
  take(at);
  if (opts.around) {
    // One back, one forward, while it fits (the item about a third down the page, as it shows).
    for (let n = 0; e - s < limit && bytes < budget && (s > 0 || e < total); n++) {
      if ((n % 3 !== 2 && s > 0) || e >= total) take(--s);
      else take(e++);
    }
    // Back to the message that opened its first turn when that is near (a turn is not split).
    if (s > 0 && !turnStart(roots[s])) {
      let k = s - 1;
      while (k > 0 && s - k < TURN_REACH && !turnStart(roots[k])) k--;
      if (turnStart(roots[k])) while (s > k && bytes < budget * 1.6) take(--s);
    }
  } else {
    while (e < total && e - s < limit && (bytes < budget || e - s < 4)) take(e++);
  }
  // On to the end of its last turn, within reach (the next page goes on from `next` otherwise).
  while (e < total && !turnStart(roots[e]) && roots[e - 1].type !== 'turn' && bytes < budget * 1.6) take(e++);
  const out: PhoneItem[] = [];
  for (let i = s; i < e; i++) out.push(made.get(i)!);
  return { items: out, ...(s > 0 ? { cursor: roots[s].id } : {}), ...(e < total ? { next: roots[e].id } : {}), total };
}

/** A queued message's words as a phone shows them (one line; `queue.take` gives the whole message). */
const QUEUE_TEXT = LIMITS.answer;
/** Queued messages per page (`phone.tail` holds the first, `phone.queue` reads on), and permissions or questions a page holds. */
export const QUEUE_PAGE = 20;
export const PROMPTS_PAGE = 20;
const trimQueue = (q: QueuedMessage[]) =>
  q.map(({ issuedPayload, issuedTo, ...m }) => ({ ...m, ...(m.attachments ? { attachments: trimAttachments(m.attachments) } : {}), ...(m.text.length > QUEUE_TEXT ? { text: m.text.slice(0, QUEUE_TEXT), cut: true } : {}) })) as QueuedMessage[];

/**
 * Byte budgets, counted in UTF-8 as the frames go out: `app.hello` for a phone (its chats' list, and
 * what waits across chats), a page of what waits (`phone.prompts`, and in `phone.tail`), a page of the
 * chats' list (`phone.sessions`). What does not fit comes by cursor; together they stay well under a
 * result frame (`FRAME_MAX.result`).
 */
export const PHONE_BYTES = { helloSessions: 6_000_000, helloPrompts: 4_000_000, prompts: 3_000_000, sessions: 6_000_000 };

const utf8 = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/**
 * A place in a list for a cursor: its index and the id there. A list that changed meanwhile goes on
 * from that id; with that entry gone it starts over (entries before it may be gone too, so its old
 * index could skip one still there; a page may repeat entries, the phone takes them by id).
 */
const placeOf = (i: number, id: string) => `${i}:${id}`;
function placeIn(list: { id: string }[], cursor: unknown): number {
  if (typeof cursor !== 'string') return 0;
  const m = /^(\d{1,9}):(.*)$/s.exec(cursor);
  if (!m) return 0;
  const i = Number(m[1]);
  if (list[i]?.id === m[2]) return i;
  const at = list.findIndex((x) => x.id === m[2]);
  return at >= 0 ? at : 0;
}

/** Chats' list entries from `from` on, within `budget` bytes (one at least); `cursor` where the next page starts. */
export function sessionsPage(sessions: SessionMeta[], from: number, budget: number): { sessions: SessionMeta[]; cursor?: string; total: number } {
  const out: SessionMeta[] = [];
  let bytes = 0;
  let i = from;
  for (; i < sessions.length; i++) {
    // With its comma in the list.
    const n = utf8(sessions[i]) + 1;
    if (out.length && bytes + n > budget) break;
    out.push(sessions[i]);
    bytes += n;
  }
  return { sessions: out, ...(i < sessions.length ? { cursor: placeOf(i, sessions[i].id) } : {}), total: sessions.length };
}

/**
 * What waits, as a phone gets it, from a cursor on (permissions, then questions), within `budget`
 * bytes and `count` of each kind; `cursor` where the next page starts, and the totals.
 */
export function promptsPage(p: { permissions: PermissionRequest[]; questions: QuestionRequest[] }, cursor: unknown, budget: number, count = Infinity): { permissions: PhonePermission[]; questions: PhoneQuestionRequest[]; cursor?: string; permissionsTotal: number; questionsTotal: number } {
  const all: ({ kind: 'p'; r: PermissionRequest } | { kind: 'q'; r: QuestionRequest })[] = [...p.permissions.map((r) => ({ kind: 'p' as const, r })), ...p.questions.map((r) => ({ kind: 'q' as const, r }))];
  const permissions: PhonePermission[] = [];
  const questions: PhoneQuestionRequest[] = [];
  const start = placeIn(all.map((x) => x.r), cursor);
  const taken = new Set<number>();
  let bytes = 0;
  for (let i = start; i < all.length; i++) {
    const x = all[i];
    // A kind whose page is full lets the other kind still come (the rest of it by cursor).
    if ((x.kind === 'p' ? permissions : questions).length >= count) continue;
    const made = x.kind === 'p' ? phonePermission(x.r) : phoneQuestion(x.r);
    const n = utf8(made) + 1;
    if (taken.size && bytes + n > budget) break;
    if (x.kind === 'p') permissions.push(made as PhonePermission);
    else questions.push(made as PhoneQuestionRequest);
    taken.add(i);
    bytes += n;
  }
  // The next page starts at the first one left out (it may hold again some this one had: they are keyed by id).
  let next = -1;
  for (let i = start; i < all.length && next < 0; i++) if (!taken.has(i)) next = i;
  return { permissions, questions, ...(next >= 0 ? { cursor: placeOf(next, all[next].r.id) } : {}), permissionsTotal: p.permissions.length, questionsTotal: p.questions.length };
}

/** A snapshot as a phone gets it: the newest page instead of every item (or a page `around` / `after` an item). */
export function phoneTail(snap: SessionSnapshot, opts: { before?: string; limit?: number; to?: string; around?: string; after?: string } = {}): PhoneTail {
  const page: { items: PhoneItem[]; cursor?: string; next?: string; total: number } = opts.around || opts.after ? phoneWindow(snap.items, opts) : phonePage(snap.items, opts);
  // Every collection bounded, so the page always fits the phone's frame (a long queue reads on with
  // `phone.queue`, what waits with `phone.prompts`: bounded by count and by bytes).
  const queue = snap.queue ?? [];
  const waiting = promptsPage({ permissions: snap.permissions ?? [], questions: snap.questions ?? [] }, undefined, PHONE_BYTES.prompts, PROMPTS_PAGE);
  return {
    ...snap,
    queue: trimQueue(queue.slice(0, QUEUE_PAGE)),
    ...(queue.length > QUEUE_PAGE ? { queueTotal: queue.length } : {}),
    permissions: waiting.permissions,
    ...(waiting.permissions.length < waiting.permissionsTotal ? { permissionsTotal: waiting.permissionsTotal } : {}),
    questions: waiting.questions,
    ...(waiting.questions.length < waiting.questionsTotal ? { questionsTotal: waiting.questionsTotal } : {}),
    ...(waiting.cursor ? { promptsCursor: waiting.cursor } : {}),
    todos: (snap.todos ?? []).slice(0, 100).map((t) => ({ ...t, content: cap(t.content, LIMITS.field) })),
    items: page.items,
    total: page.total,
    ...(page.cursor ? { cursor: page.cursor } : {}),
    ...(page.next ? { next: page.next } : {}),
    ...(opts.around ? { at: opts.around } : {}),
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
    // Within a byte budget for the chats' list and one for what waits; the rest by cursor
    // (`sessionsCursor` with `phone.sessions`, `promptsCursor` with `phone.prompts`), with the totals.
    const r = result as AppState;
    const list = sessionsPage(r.sessions ?? [], 0, PHONE_BYTES.helloSessions);
    const waiting = r.prompts ? promptsPage(r.prompts, undefined, PHONE_BYTES.helloPrompts) : undefined;
    return {
      ...r,
      sessions: list.sessions,
      ...(list.cursor ? { sessionsCursor: list.cursor, sessionsTotal: list.total } : {}),
      ...(waiting
        ? {
            prompts: { permissions: waiting.permissions, questions: waiting.questions },
            ...(waiting.cursor ? { promptsCursor: waiting.cursor, permissionsTotal: waiting.permissionsTotal, questionsTotal: waiting.questionsTotal } : {}),
          }
        : {}),
    };
  }
  if (method === 'queue.take') {
    // Its words whole (the phone edits them); its pictures without their data.
    const r = result as { message?: QueuedMessage };
    if (!r.message) return r;
    const { issuedPayload, issuedTo, ...message } = r.message;
    return { ...r, message: { ...message, ...(message.attachments ? { attachments: trimAttachments(message.attachments) } : {}) } };
  }
  return result;
}

/** One item with more of it, and the last steps nested under it. */
export function phoneDetail(items: TimelineItem[], itemId: string, whole: (item: TimelineItem) => TimelineItem = i => i): { item: PhoneItem; children: PhoneItem[] } {
  const it = items.find((i) => i.id === itemId);
  if (!it) throw new Error('That part of the conversation is no longer there');
  const kids = items.filter((i) => i.parentId === itemId);
  const count = new Map<string, number>();
  for (const k of items) if (k.parentId) count.set(k.parentId, (count.get(k.parentId) ?? 0) + 1);
  return { item: phoneItem(whole(it), { role: 'full', kids: kids.length }), children: kids.slice(-FULL.children).map((k) => phoneItem(k, { role: 'step', kids: count.get(k.id) })) };
}

// Installed phones shallow-merge updates. Send clears for fields they read as optional or
// already accept as null. In particular, keep required strings and the usage object intact.
const PHONE_CLEARABLE = new Set<string>([
  'live',
  'accountId', 'movedFrom', 'returnAt', 'activity', 'lastError', 'remote', 'capState', 'moving',
  'pendingRestart', 'providerSessionId', 'until', 'spare', 'race', 'lane', 'agentHandover', 'moveNote',
  'background', 'commands', 'serving', 'servingSince', 'servingAddress', 'tracked', 'trackedSince', 'trackedTitle', 'options', 'effort', 'speed', 'fast', 'ultracode', 'pinned', 'archived', 'unread', 'branch',
  'chat', 'custom', 'titleAsked', 'agents', 'returnModels',
] satisfies (keyof SessionMeta)[]);

/** An event as a phone gets it, or null when it does not need it. */
export function phoneEvent(event: BridgeEvent, kindOf?: (sessionId: string, id: string) => string | undefined): BridgeEvent | PhoneReset | null {
  switch (event.type) {
    case 'session.updated':
      return { ...event, patch: sessionPatchForJson(event.patch, PHONE_CLEARABLE) };
    case 'item.added':
      return { ...event, item: phoneItem(event.item, { role: event.item.type === 'text' && event.item.parentId ? 'step' : 'answer' }) };
    case 'item.delta':
      // Live tool output and streamed tool input stay on the desktop (`phone.item` has it).
      return event.field === 'text' ? event : null;
    case 'item.patch': {
      const patch = phonePatch(event.patch, (event.patch as Partial<ToolItem>).input ? kindOf?.(event.sessionId, event.id) : undefined);
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
      return { ...event, queue: trimQueue(event.queue.slice(0, QUEUE_PAGE)), ...(event.queue.length > QUEUE_PAGE ? { total: event.queue.length } : {}) };
    default:
      return event;
  }
}

/** JSON text over `limit` UTF-8 bytes as it goes out (a character takes up to 3 bytes; counted only when that can matter). */
export const overBytes = (json: string, limit: number) => json.length > limit || (json.length * 3 > limit && Buffer.byteLength(json, 'utf8') > limit);

/**
 * `phone.stale` in place of an event too big for a phone: which chat it was about (so the phone
 * fetches that chat again) and its type. A toast has no state to fetch: none.
 */
export function staleOf(event: BridgeEvent | PhoneReset): PhoneStale | null {
  if (event.type === 'toast') return null;
  const e = event as { sessionId?: unknown; session?: { id?: unknown }; request?: { sessionId?: unknown } };
  const sessionId = [e.sessionId, e.session?.id, e.request?.sessionId].find((v): v is string => typeof v === 'string');
  return { type: 'phone.stale', ...(sessionId ? { sessionId } : {}), of: event.type };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Until a response can take more (it drained), or rejects when it closed, failed or `signal` aborted. */
function roomIn(res: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (res.destroyed || signal.aborted) return reject(new Error('closed'));
    const off = () => {
      res.off('drain', ok);
      res.off('close', gone);
      res.off('error', gone);
      signal.removeEventListener('abort', gone);
    };
    const ok = () => (off(), resolve());
    const gone = () => (off(), reject(new Error('closed')));
    res.on('drain', ok);
    res.on('close', gone);
    res.on('error', gone);
    signal.addEventListener('abort', gone);
  });
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(sha256(a), 'hex');
  const y = Buffer.from(sha256(b), 'hex');
  return timingSafeEqual(x, y);
}

/** Two token hashes (hex) compared in constant time. */
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

const IDENTITY_ERROR = 'Sable could not read its phone key. Phones cannot pair until it can.';
/** A pairing that names the plain one it replaces by a ticket that is not (or no longer) that phone's. */
const TICKET_REFUSED = 'This pairing could not replace the earlier one on this computer. Pair again from the phone.';

/**
 * The pairing link (version 2, `PAIR_LINK_PREFIX`): `sable://pair/2?h=<addresses>&p=<port>&s=<one-time
 * secret>&f=<the desktop's key fingerprint>&n=<its name>`, short enough for the QR code (the name,
 * then addresses give way). An app older than the secure channel reads only `sable://pair?…&k=`: it
 * cannot take this link, so it never sends the secret in the clear.
 */
export function pairLink(hosts: string[], port: number, key: string, fingerprint: string, name: string): string {
  const make = (h: string[], n: string) => `${PAIR_LINK_PREFIX}h=${h.join(',')}&p=${port}&s=${key}&f=${fingerprint}${n ? `&n=${encodeURIComponent(n)}` : ''}`;
  const fits = (s: string) => {
    try {
      qrMatrix(s);
      return true;
    } catch {
      return false;
    }
  };
  for (let n = Math.max(1, hosts.length); n >= 1; n--) {
    const h = hosts.slice(0, n);
    for (const nm of [name.slice(0, 30), name.slice(0, 12), '']) if (fits(make(h, nm))) return make(h, nm);
  }
  return make(hosts.slice(0, 1), '');
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
 * `session.create` from the phone, built only from what a phone's new chat may choose: the agent,
 * its folder (or a chat of its own, `chat`), model, effort, mode, speed, account, a title and Remote
 * Control. Never `resume` (a transcript or a thread another chat holds), a handover, a lane or any
 * other desktop-only field. A field of the wrong kind is refused.
 */
export function phoneCreate(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const text = (k: string, required = false) => {
    const v = p[k];
    if (v === undefined || v === null) {
      if (required) throw new Error(`A new chat needs its ${k}.`);
      return;
    }
    if (typeof v !== 'string' || v.length > 4000) throw new Error(`That ${k} cannot start a chat.`);
    out[k] = v;
  };
  text('provider', true);
  text('cwd', true);
  for (const k of ['model', 'effort', 'mode', 'speed', 'accountId', 'title']) text(k);
  const o = p.options;
  if (o !== undefined && o !== null) {
    const opts = plainObject(o);
    if (!opts) throw new Error('Those options cannot start a chat.');
    if ('remoteControl' in opts) out.options = { remoteControl: !!opts.remoteControl };
  }
  if (p.chat !== undefined && p.chat !== null) {
    const chat = plainObject(p.chat);
    if (!chat || (chat.text !== undefined && typeof chat.text !== 'string')) throw new Error('That chat cannot be started.');
    out.chat = typeof chat.text === 'string' ? { text: chat.text.slice(0, 4000) } : {};
  }
  return out;
}

/**
 * Narrows what a phone may pass to a method beyond the allowlist itself. `queued`: the attachments
 * the desktop holds for a queued message (a phone that edits one names them by id).
 */
function narrow(method: string, params: Record<string, unknown>, queued?: (sessionId: string, id: string) => Attachment[] | undefined): Record<string, unknown> {
  const p = { ...params };
  if (method === 'spare.atReset' || (method === 'session.switchAccount' && 'refusalId' in p)) {
    if (typeof p.sessionId !== 'string' || !p.sessionId || typeof p.refusalId !== 'string' || !p.refusalId.trim() || p.refusalId.length > ASK_TEXT.id)
      throw new Error('Choose a limit card in this chat.');
    if (method === 'spare.atReset') return { sessionId: p.sessionId, refusalId: p.refusalId };
  }
  // Pictures as data, never a path on the computer: a message from the phone carries nothing of the desktop's.
  // The authenticated handler namespaces a phone's submission ID to its own pairing.
  if (method === 'session.send') delete p.submitId;
  if (method === 'session.send' || method === 'queue.update') {
    // Words first: nothing is queued, edited or sent for a message without them.
    if (typeof p.text !== 'string') throw new Error('A message needs its words.');
    const known = method === 'queue.update' ? queued?.(String(p.sessionId ?? ''), String(p.id ?? '')) : undefined;
    const list = phoneAttachments(p.attachments, known);
    if (list) p.attachments = list;
    // An edit that removes every picture says so with an empty list (omitted keeps them).
    else if (method === 'queue.update' && Array.isArray(p.attachments)) p.attachments = [];
    else delete p.attachments;
  }
  if (method === 'session.setOptions') {
    const o = (p.options ?? {}) as Record<string, unknown>;
    p.options = 'remoteControl' in o ? { remoteControl: !!o.remoteControl } : {};
  }
  if (method === 'session.create') return phoneCreate(p);
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
  /** A phone that presented the pairing key and waits for "Allow"; `replaces`: its older plain pairing with this desktop, by its migration ticket. */
  private request?: { id: string; name: string; address: string; at: number; link: Link; socket: WebSocket; timer: NodeJS.Timeout; replaces?: { id: string; ticket: string }; replacesName?: string };
  /**
   * Migration tickets (`phone.migrate`): per phone paired before the secure channel, the hash of a
   * one-time ticket it got over its own connection, and until when it holds. A secure pairing that
   * names it replaces that phone's old entry; nothing else does.
   */
  private tickets = new Map<string, { hash: string; expires: number }[]>();
  /** Per authenticated connection: stops its dispatch at once (a removed phone's requests are never acted on). */
  private detach = new Map<Link, () => void>();
  /** Files going to securely paired phones over their sealed connections (phone-files.ts). */
  private sending = new PhoneFiles();
  private fails = new Map<string, { count: number; first: number; blockedUntil?: number }>();
  private globalFails: number[] = [];
  /** Authenticated connections per device id. */
  private live = new Map<string, Set<Link>>();
  private saveTimer?: NodeJS.Timeout;
  /** The paired phones could not be written (the change holds in memory; tried again). */
  private saveError?: string;
  private starting?: Promise<void>;
  /** A chat's changes and diffs, read-only (`phone.changes`, `phone.diff`). */
  private changes: PhoneChangesReader;
  /** Messages across chats (`phone.search`). */
  private finder: ChatSearch;
  /** The desktop's identity for the secure channel (phone-secure.ts), read or made when first needed. */
  private identityFile: string;
  private ident?: Identity;

  constructor(
    private app: App,
    opts: PhoneOptions = {},
  ) {
    this.changes = new PhoneChangesReader((sessionId) => this.app.call('session.snapshot', { sessionId }));
    this.finder = searchOf(app);
    this.file = opts.file ?? path.join(app.store.dir, 'phone.json');
    this.identityFile = opts.identity ?? path.join(path.dirname(this.file), 'phone-identity.pem');
    this.port = opts.port ?? PHONE_PORT;
    this.host = opts.host ?? process.env.SABLE_PHONE_HOST ?? '0.0.0.0';
    this.data = this.read();
    app.phoneStillPaired = sender => this.data.enabled && sender.generation === (this.data.generation ?? 0) && this.data.devices.some(d => d.id === sender.deviceId);
  }

  get enabled() {
    return this.data.enabled;
  }

  /** The identity key, read (or made) once; throws when its file is there but cannot be read. */
  identity(): Identity {
    return (this.ident ??= loadIdentity(this.identityFile, (...a) => this.app.log(...a)));
  }

  private read(): PhoneFile {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PhoneFile>;
      const devices = Array.isArray(raw.devices)
        ? raw.devices
            .filter((d) => d && typeof d.id === 'string' && typeof d.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(d.tokenHash))
            .map((d) => ({ id: d.id, name: String(d.name ?? 'Phone'), tokenHash: d.tokenHash, pairedAt: Number(d.pairedAt) || 0, ...(typeof d.lastSeen === 'number' ? { lastSeen: d.lastSeen } : {}), ...(d.secure === true ? { secure: true as const } : {}) }))
        : [];
      return { enabled: !!raw.enabled, generation: raw.generation ?? 0, devices };
    } catch {
      return { enabled: false, devices: [] };
    }
  }

  /**
   * Writes the paired phones (at once, or in a moment for a last-seen time). A write that fails (a
   * locked file on Windows) leaves the change in effect in memory, says so in Settings › Phone
   * (`saveError`) and is tried again until it goes through. Returns whether it was written now.
   */
  private save(now = false): boolean {
    clearTimeout(this.saveTimer);
    const write = (): boolean => {
      try {
        mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        renameSync(tmp, this.file);
        if (this.saveError) {
          this.saveError = undefined;
          this.changed();
        }
        return true;
      } catch (err) {
        this.app.log('phone: could not save', (err as Error).message);
        const was = this.saveError;
        this.saveError = 'Could not save the paired phones. Sable tries again; until then, a restart would undo this change.';
        if (!was) this.changed();
        this.saveTimer = setTimeout(() => this.save(true), SAVE_RETRY_MS);
        this.saveTimer.unref?.();
        return false;
      }
    };
    if (now) return write();
    this.saveTimer = setTimeout(write, 2000);
    return true;
  }

  status(): PhoneStatus {
    if (this.pairing && this.pairing.expiresAt < Date.now()) this.pairing = undefined;
    const devices: PhoneDevice[] = this.data.devices
      .map((d) => ({ id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeen: d.lastSeen, ...(this.live.get(d.id)?.size ? { online: true } : {}), ...(d.secure ? { secure: true } : {}) }))
      .sort((a, b) => (b.lastSeen ?? b.pairedAt) - (a.lastSeen ?? a.pairedAt));
    return {
      enabled: this.data.enabled,
      listening: this.listening,
      port: this.port,
      hosts: lanAddresses(),
      name: os.hostname(),
      devices,
      ...(this.pairing ? { pairing: { link: this.pairing.link, expiresAt: this.pairing.expiresAt, qr: this.pairing.qr, size: this.pairing.size } } : {}),
      ...(this.request ? { request: { id: this.request.id, name: this.request.name, address: this.request.address, at: this.request.at, ...(this.request.replacesName !== undefined ? { replaces: this.request.replacesName } : {}) } } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.saveError ? { saveError: this.saveError } : {}),
    };
  }

  private changed() {
    this.app.emit({ type: 'phone.updated', status: this.status() });
  }

  async setEnabled(on: boolean) {
    if (this.data.enabled && !on) this.data.generation = (this.data.generation ?? 0) + 1;
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
    for (const off of [...this.detach.values()]) off();
    this.detach.clear();
    this.live.clear();
    this.sending.drop();
    this.tickets.clear();
    this.releaseTakes();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  pair(cancel?: boolean) {
    if (cancel) this.pairing = undefined;
    else {
      try {
        const key = randomBytes(16).toString('base64url');
        // The link carries the desktop's identity (its key's fingerprint): the phone trusts no other.
        const link = pairLink(lanAddresses(), this.port, key, this.identity().fingerprint, os.hostname());
        const { path: qr, size } = qrSvgPath(link);
        this.pairing = { key, expiresAt: Date.now() + PAIR_TTL_MS, link, qr, size };
        if (this.error === IDENTITY_ERROR) this.error = undefined;
      } catch (err) {
        this.pairing = undefined;
        this.app.log('phone: no pairing code', (err as Error).message);
        this.error = IDENTITY_ERROR;
      }
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
      this.sendFrame(r.link, { denied: 'The desktop did not allow this phone' });
      r.link.close(4003, 'denied');
    } else if (r.link.open) {
      // A replacement goes only with a live ticket for that plain pairing (it may have expired, or that
      // pairing been removed, while the desktop asked): never a separate pairing in its place.
      const old = r.replaces ? this.ticketFor(r.replaces.id, r.replaces.ticket) : undefined;
      if (r.replaces && !old) {
        this.sendFrame(r.link, { denied: TICKET_REFUSED });
        r.link.close(4002, 'bad ticket');
        this.changed();
        return this.status();
      }
      const token = randomBytes(32).toString('base64url');
      // Pairing happens only over the secure channel now: this phone connects only that way.
      const device: StoredPhone = { id: randomUUID(), name: r.name, tokenHash: sha256(token), pairedAt: Date.now(), lastSeen: Date.now(), secure: true };
      // The new entry and the removal of the plain one it replaces are written together, and in effect only once written.
      if (!this.commitDevices([...this.data.devices.filter((d) => d.id !== old?.id), device])) {
        this.sendFrame(r.link, { denied: 'This computer could not save the pairing. Try again.' });
        r.link.close(4003, 'not saved');
        this.changed();
        return this.status();
      }
      // The plain pairing this phone had with this desktop is gone: its connections close, its tickets end.
      if (old) this.dropDevice(old.id, false);
      this.sendFrame(r.link, { paired: { token, deviceId: device.id, desktop: os.hostname(), ...(old ? { replaced: old.id } : {}) } });
      this.authenticated(r.link, device);
    }
    this.changed();
    return this.status();
  }

  /**
   * Removes a phone: at once in memory (its token no longer works, its connections close, its links
   * and downloads end), then on disk; a write that fails says so (`saveError`) and is tried again.
   */
  revoke(deviceId: string) {
    this.dropDevice(deviceId, true);
    this.save(true);
    this.changed();
    return this.status();
  }

  private dropDevice(deviceId: string, tell: boolean) {
    this.data.devices = this.data.devices.filter((d) => d.id !== deviceId);
    // Nothing it sends from now on is acted on, before its sockets get to close (they close behind what is still going out).
    for (const link of this.live.get(deviceId) ?? []) this.detach.get(link)?.();
    // Its download links, files under way and migration ticket go with it.
    this.dropLinks(deviceId);
    this.sending.drop(deviceId);
    this.tickets.delete(deviceId);
    // A message it was taking back stays in the queue as it was.
    this.releaseTakes(deviceId);
    for (const link of this.live.get(deviceId) ?? []) {
      if (tell) this.sendFrame(link, { denied: 'This phone was removed on the desktop' });
      link.close(4001, 'revoked');
    }
    this.live.delete(deviceId);
  }

  /**
   * A one-time ticket for a phone paired plain (`phone.migrate`), 10 minutes. Asking again (a retry)
   * does not void the ones it already has (a few at most); the pairing that uses one ends them all.
   */
  private ticketOf(deviceId: string): string {
    const ticket = randomBytes(24).toString('base64url');
    const now = Date.now();
    const live = (this.tickets.get(deviceId) ?? []).filter((t) => t.expires >= now).slice(-(TICKETS_PER_PHONE - 1));
    this.tickets.set(deviceId, [...live, { hash: sha256(ticket), expires: now + PAIR_TTL_MS }]);
    return ticket;
  }

  /**
   * The plain pairing a ticket names, if it is one of that phone's live tickets. Only checked: an
   * attempt that does not match uses nothing up; the pairing that commits ends them (`approve`).
   */
  private ticketFor(deviceId: string, ticket: string): StoredPhone | undefined {
    const now = Date.now();
    const hash = sha256(ticket);
    if (!(this.tickets.get(deviceId) ?? []).some((t) => t.expires >= now && sameHash(t.hash, hash))) return undefined;
    return this.data.devices.find((d) => d.id === deviceId && !d.secure);
  }

  /**
   * Writes the paired phones as `devices` and only then makes them the ones in effect: written whole
   * to a temporary file, flushed to the disk and moved over the old one, so a pairing and the removal
   * it replaces are on disk together or not at all. False when it could not be written (nothing changed).
   */
  private commitDevices(devices: StoredPhone[]): boolean {
    const next: PhoneFile = { ...this.data, devices };
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      const fd = openSync(tmp, 'w');
      try {
        writeSync(fd, JSON.stringify(next, null, 2));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.file);
    } catch (err) {
      this.app.log('phone: could not save a pairing', (err as Error).message);
      return false;
    }
    this.data.devices = devices;
    if (this.saveError) {
      this.saveError = undefined;
      clearTimeout(this.saveTimer);
    }
    return true;
  }

  private endRequest(reason: string) {
    const r = this.request;
    if (!r) return;
    clearTimeout(r.timer);
    this.request = undefined;
    this.sendFrame(r.link, { denied: reason });
    r.link.close(4003, 'denied');
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
  private files = new Map<string, FileGrant & { blocks: Buffer }>();

  /**
   * The grant for a share's file with the digest the share recorded when it completed (core/handed.ts):
   * while that is still being read, it is waited for; a share without one (from a stored transcript,
   * from before Sable kept one, or one too big or changed while it was read) is not downloaded.
   */
  private async sharedFile(deviceId: string, sessionId: string, itemId: string, index: number): Promise<FileGrant & { sha256: string }> {
    let snap = await this.app.call('session.snapshot', { sessionId });
    let grant = grantFor(snap, itemId, index, deviceId);
    if (!grant.sha256 && !grant.unhashed) {
      const pending = this.app.sessions.get(sessionId)?.handing(itemId);
      if (pending) {
        await Promise.race([pending, new Promise((r) => setTimeout(r, 60_000).unref?.())]);
        snap = await this.app.call('session.snapshot', { sessionId });
        grant = grantFor(snap, itemId, index, deviceId);
      }
    }
    if (grant.unhashed === 'big') throw new Error('That file is too big to send to the phone.');
    if (grant.unhashed === 'changed') throw new Error('That file changed while it was shared. Ask the agent to share it again.');
    if (!grant.sha256) throw new Error('Ask the agent to share that file again.');
    return grant as FileGrant & { sha256: string };
  }

  /** A phone paired before the secure channel: a plain HTTP link (never for an APK, which nothing could check on the way). */
  private async fileLink(deviceId: string, sessionId: string, itemId: string, index: number): Promise<{ path: string; name: string; size?: number; sha256?: string }> {
    const grant = await this.sharedFile(deviceId, sessionId, itemId, index);
    const name = canonicalName(grant.name);
    if (isPackageName(name)) throw new Error('Pair again for a secure connection to get this file.');
    // The file must still be the bytes the share recorded before a link to it is made.
    const opened = await openGrant(grant);
    if ('code' in opened) throw new Error(opened.code === 409 ? 'That file changed after it was shared.' : 'That file is no longer on the computer.');
    // Each block's digest too: the link serves a block only while it is still those bytes (`serveFile`).
    let read: { sha256: string; blocks: Buffer } | null;
    try {
      read = await blockDigests(opened.fh, grant.size);
    } finally {
      await opened.fh.close().catch(() => {});
    }
    const sha256 = read?.sha256;
    if (!read || sha256 !== grant.sha256) throw new Error('That file changed after it was shared.');
    grant.name = name;
    const now = Date.now();
    for (const [t, f] of this.files) if (f.expires < now) this.files.delete(t);
    while (this.files.size >= 50) this.files.delete(this.files.keys().next().value as string);
    const token = randomBytes(24).toString('base64url');
    this.files.set(token, { ...grant, blocks: read.blocks });
    return { path: `/f/${token}/${encodeURIComponent(grant.name)}`, name: grant.name, size: grant.size, sha256 };
  }

  /** Downloads under way, per phone: each one's abort (it ends the transfer and closes the file). */
  private transfers = new Map<string, Set<AbortController>>();

  /** The links made for one phone (or all of them) stop working, and their downloads under way end. */
  private dropLinks(deviceId?: string) {
    for (const [t, f] of this.files) if (!deviceId || f.deviceId === deviceId) this.files.delete(t);
    for (const [d, set] of this.transfers) if (!deviceId || d === deviceId) for (const ac of set) ac.abort();
  }

  /** Downloads under way for one phone (tests). */
  downloads(deviceId: string): number {
    return this.transfers.get(deviceId)?.size ?? 0;
  }

  /** This link still serves: its phone paired (plain: a secure phone downloads over its connection), phone access on, the link not dropped. */
  private linkLive(token: string, entry: FileGrant): boolean {
    return this.files.get(token) === entry && this.data.enabled && this.data.devices.some((d) => d.id === entry.deviceId && !d.secure);
  }

  /** An item's kind (a tool's), for a patch that brings a widget's input. */
  private kindOf = (sessionId: string, id: string): string | undefined => {
    const it = this.app.sessions.get(sessionId)?.get(id);
    return it?.type === 'tool' ? it.kind : undefined;
  };

  /** `phone.image`: one picture of a step's result in this chat (a data URL of an image, capped), nothing else. */
  private async image(sessionId: string, itemId: string, index: number): Promise<{ data: string }> {
    const { item } = await this.app.call('session.item', { sessionId, itemId });
    // A result's pictures first, then a widget's own, as `pics` counts them.
    const shots = item?.type === 'tool' ? (item.result?.images ?? []) : [];
    const src =
      item?.type === 'tool' && Number.isInteger(index) && index >= 0 && index < MAX_PICS
        ? index < shots.length
          ? shots[index]
          : item.kind === 'widget'
            ? widgetPics(item.input)[index - shots.length]
            : undefined
        : undefined;
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
    if (!this.linkLive(token, entry)) {
      this.files.delete(token);
      return fail(404, 'Not found');
    }
    // The file as it was when the link was made, read through the handle that was checked.
    const opened = await openGrant(entry);
    if ('code' in opened) return fail(opened.code, opened.text);
    // Asked again once the file is open: the phone may have been removed (or access turned off) meanwhile.
    if (!this.linkLive(token, entry)) {
      await opened.fh.close().catch(() => {});
      return fail(404, 'Not found');
    }
    // Tracked per phone: removing it, turning phone access off or the phone going away ends it, and the file closes on every path.
    const ac = new AbortController();
    let set = this.transfers.get(entry.deviceId);
    if (!set) this.transfers.set(entry.deviceId, (set = new Set()));
    set.add(ac);
    try {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(entry.size),
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      if (!entry.size) return void res.end();
      // Block by block, each checked against its digest from when the link was made before it goes:
      // a file rewritten in place since sends nothing new (the download ends short).
      const buf = Buffer.allocUnsafe(Math.min(FILE_CHUNK, entry.size));
      for (let at = 0; at < entry.size; at += FILE_CHUNK) {
        if (ac.signal.aborted || !this.linkLive(token, entry)) throw new Error('ended');
        const want = Math.min(FILE_CHUNK, entry.size - at);
        for (let got = 0; got < want; ) {
          const { bytesRead } = await opened.fh.read(buf, got, want - got, at + got);
          if (!bytesRead) throw new Error('short');
          got += bytesRead;
        }
        const block = at / FILE_CHUNK;
        if (!createHash('sha256').update(buf.subarray(0, want)).digest().equals(entry.blocks.subarray(block * 32, block * 32 + 32))) throw new Error('changed');
        if (!res.write(Buffer.from(buf.subarray(0, want)))) await roomIn(res, ac.signal);
      }
      res.end();
    } catch {
      res.destroy();
    } finally {
      set.delete(ac);
      if (!set.size && this.transfers.get(entry.deviceId) === set) this.transfers.delete(entry.deviceId);
      await opened.fh.close().catch(() => {});
    }
  }

  private onUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer) {
    const refuse = (code: number, text: string) => {
      socket.end(`HTTP/1.1 ${code} ${text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
      setTimeout(() => socket.destroy(), 1000).unref();
    };
    // Nothing a request carries leaves this listener: a malformed one closes only its own socket.
    try {
      const ip = req.socket.remoteAddress ?? '?';
      // The route compared as the origin-form target it must be (no URL parsing of what was sent).
      const target = typeof req.url === 'string' ? req.url : '';
      if (!target.startsWith('/') || target.startsWith('//')) return refuse(400, 'Bad Request');
      const q = target.indexOf('?');
      if ((q < 0 ? target : target.slice(0, q)) !== PHONE_PATH) return refuse(404, 'Not Found');
      if (!originAllowed(req)) return refuse(403, 'Forbidden');
      if (this.blocked(ip)) return refuse(429, 'Too Many Requests');
      if (wss.clients.size >= MAX_SOCKETS) return refuse(503, 'Service Unavailable');
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (err) {
      this.app.log('phone: an upgrade failed', (err as Error).message);
      try {
        refuse(400, 'Bad Request');
      } catch {
        socket.destroy();
      }
    }
  }

  /**
   * One frame to a phone, within its budget (`FRAME_MAX`, in UTF-8 bytes as it goes out): a result
   * too big for it goes as an error; an event too big goes as its conversation's newest page (an item
   * event) or else as `phone.stale`, which makes the phone fetch the current state.
   */
  private sendFrame(link: Link, frame: PhoneFrame | ServerFrame, sent?: (err?: Error) => void) {
    if (!link.open) return void sent?.(new Error('closed'));
    if (link.buffered > MAX_BUFFERED) {
      link.terminate();
      return void sent?.(new Error('behind'));
    }
    let json = JSON.stringify(frame);
    const f = frame as { id?: unknown; event?: BridgeEvent };
    let replaced = false;
    if (f.event && overBytes(json, FRAME_MAX.event)) {
      replaced = true;
      const page = this.pageFor(f.event);
      json = page ? JSON.stringify({ event: page }) : '';
      if (!json || overBytes(json, FRAME_MAX.event)) {
        this.app.log(`phone: a ${f.event.type} event too big for the phone went as phone.stale`);
        const stale = staleOf(f.event);
        if (!stale) return void sent?.(new Error('too big'));
        json = JSON.stringify({ event: stale });
      }
    } else if (typeof f.id === 'number' && overBytes(json, FRAME_MAX.result)) {
      replaced = true;
      json = JSON.stringify({ id: f.id, ok: false, error: 'That is too big to send to the phone.' });
    }
    if (sent && replaced) {
      link.send(json);
      sent(new Error('Frame was replaced'));
    } else link.send(json, sent);
  }

  /** The reply as it would go to this phone, or why it cannot go now (closed, behind, over its budget). */
  private deliverable(link: Link, frame: ServerFrame): string | null {
    if (!link.open || link.buffered > MAX_BUFFERED) return null;
    const json = JSON.stringify(frame);
    return overBytes(json, FRAME_MAX.result) ? null : json;
  }

  /**
   * `queue.take` from the phone. The message is reserved, not removed, while its reply goes: the
   * reply goes first (refused when it cannot go: closed, behind, over its budget), and only once it
   * went out is the message taken from the queue, by the bridge's own `queue.take` (so a Spare wait
   * ends as it does for a take on the desktop). A reply that fails leaves the message, its place and
   * its scheduling exactly as they were.
   */
  private async takeQueued(link: Link, id: number, params: Record<string, unknown>, allowed: () => boolean, deviceId: string) {
    const sessionId = String(params.sessionId ?? '');
    const qid = String(params.id ?? '');
    const tooBig = 'That message is too big to take back to the phone. Edit it on the desktop.';
    // Loads the chat when the desktop has not yet (as the bridge's own take would).
    await this.app.call('session.snapshot', { sessionId });
    const rt = this.app.sessions.get(sessionId);
    if (!rt || !allowed()) return this.sendFrame(link, { id, ok: true, result: {} });
    // Reserved: neither edited nor sent while the reply goes (core/runtime.ts `reserveQueued`).
    const held = rt.reserveQueued(qid);
    if (!held) return this.sendFrame(link, { id, ok: true, result: {} });
    if (held.message.attachments?.length) {
      rt.rollbackReserved(qid);
      return this.sendFrame(link, { id, ok: false, error: 'This message has attachments. Take it back on the desktop.' });
    }
    // A phone that confirms (`ack`) gets a receipt: the message stays reserved until it says it kept
    // the words (`phone.takeDone`), never on the reply's way out alone.
    const take = params.ack === true ? randomBytes(18).toString('base64url') : undefined;
    const json = this.deliverable(link, { id, ok: true, result: { ...(phoneResult('queue.take', { message: held.message }) as object), ...(take ? { take } : {}) } });
    if (!json) {
      rt.rollbackReserved(qid);
      return this.sendFrame(link, { id, ok: false, error: tooBig });
    }
    if (take) this.holdTake(take, { deviceId, sessionId, id: qid, rev: held.rev });
    link.send(json, (err) => {
      if (take) {
        // Not gone out (or the phone removed meanwhile): back as it was, the receipt void.
        if (err || !allowed()) this.releaseTake(take, true);
        return;
      }
      // A phone from before receipts: gone out to a phone still allowed, the message leaves the queue (if it is still that revision); otherwise it stays as it was.
      if (err || !allowed()) return rt.rollbackReserved(qid);
      if (this.app.takeReserved(rt, qid, held.rev)) void rt.persistInput?.().catch(err => rt.notice('error', 'Could not save the queue', String(err)));
    });
  }

  /**
   * Takes a phone holds a receipt for (`queue.take` with `ack`), by receipt: `held` while the message
   * waits reserved for the phone's word, `taken` once it left the queue for it, `released` when it
   * went back as it was (the phone did not answer within `TAKE_HOLD_MS`, or said it could not keep
   * the words). Kept a while after, so a confirmation that comes again, or late, answers the same.
   */
  private takes = new Map<string, { deviceId: string; sessionId: string; id: string; rev: number; state: 'held' | 'taken' | 'released'; at: number; timer?: NodeJS.Timeout }>();
  /** How long a take waits for the phone's word (tests shorten it). */
  takeHoldMs = TAKE_HOLD_MS;

  private holdTake(take: string, t: { deviceId: string; sessionId: string; id: string; rev: number }) {
    const now = Date.now();
    for (const [k, v] of this.takes) if (v.state !== 'held' && now - v.at > TAKE_KEEP_MS) this.takes.delete(k);
    const timer = setTimeout(() => this.releaseTake(take), this.takeHoldMs);
    timer.unref?.();
    this.takes.set(take, { ...t, state: 'held', at: now, timer });
  }

  /** A held take goes back as it was (`forget`: and its receipt is void, as for a reply that never went out). */
  private releaseTake(take: string, forget = false) {
    const t = this.takes.get(take);
    if (!t) return;
    clearTimeout(t.timer);
    if (t.state === 'held') this.app.sessions.get(t.sessionId)?.rollbackReserved(t.id);
    if (forget) this.takes.delete(take);
    else Object.assign(t, { state: 'released', at: Date.now(), timer: undefined });
  }

  /**
   * `phone.takeDone`: the phone kept the words of a take (`kept`, by default) or could not. Idempotent:
   * the same receipt answers the same. Kept: a held message leaves the queue now; one that went back
   * meanwhile leaves it if it is still there as it was; `taken` says whether it is out of the queue.
   */
  private async takeDone(deviceId: string, raw: Record<string, unknown>): Promise<{ taken: boolean }> {
    const take = typeof raw.take === 'string' ? raw.take : '';
    const t = this.takes.get(take);
    if (!t || t.deviceId !== deviceId) return { taken: false };
    const rt = this.app.sessions.get(t.sessionId);
    if (!rt) return { taken: false };
    if (t.state === 'taken') {
      await this.app.store.persistInput(rt.id, true);
      return { taken: true };
    }
    if (raw.kept === false) {
      this.releaseTake(take);
      return { taken: false };
    }
    clearTimeout(t.timer);
    // Went back meanwhile: taken now only while it is still that message, unchanged and not reserved by another take.
    if (t.state === 'released' && !rt.reserveQueued(t.id)) return { taken: false };
    const out = this.app.takeReserved(rt, t.id, t.rev);
    Object.assign(t, { state: out ? 'taken' : 'released', at: Date.now(), timer: undefined });
    // This device RPC bypasses App.call's shutdown fence. A sealed snapshot cannot acknowledge a take.
    if (out) await this.app.store.persistInput(rt.id, true);
    return { taken: !!out };
  }

  /** Every held take of one phone (or all of them) goes back as it was. */
  private releaseTakes(deviceId?: string) {
    for (const [k, t] of this.takes) if (!deviceId || t.deviceId === deviceId) this.releaseTake(k, true);
  }

  /** In place of an item event too big for a phone: the newest page of its conversation. */
  private pageFor(e: BridgeEvent): BridgeEvent | PhoneReset | null {
    if (!ITEM_EVENTS.has(e.type)) return null;
    const rt = this.app.sessions.get((e as { sessionId: string }).sessionId);
    return rt ? phoneEvent({ type: 'timeline.reset', sessionId: rt.id, items: rt.items }) : null;
  }

  private onSocket(ws: WebSocket, req: IncomingMessage) {
    const ip = req.socket.remoteAddress ?? '?';
    // Until the phone is in (or waits for "Allow"), a few seconds; then the socket closes.
    const gate = { admitted: false };
    const helloTimer = setTimeout(() => {
      if (!gate.admitted) ws.close(4000, 'timeout');
    }, HELLO_TIMEOUT_MS);
    const first = (raw: RawData, binary: boolean) => {
      if (binary) return ws.close(4000, 'bad hello');
      const text = raw.toString();
      if (text.length > MAX_HELLO_BYTES) return ws.close(1009, 'too big');
      // Its shape first: the secure channel's hello, or (a phone paired before it) a token or a key; anything else closes this socket and nothing more.
      const sec = readSecHello(text);
      if (sec) return this.secureStart(ws, ip, sec, gate, helloTimer);
      const msg: PhoneHello | null = readHello(text);
      if (!msg) return ws.close(4000, 'bad hello');
      this.admit(new PlainLink(ws), ip, msg, null, gate, helloTimer);
    };
    // Nothing thrown while a first frame is read leaves this listener: only this socket closes.
    ws.once('message', (raw, binary) => {
      try {
        first(raw, binary);
      } catch (err) {
        this.app.log('phone: a first frame failed', (err as Error).message);
        ws.close(4000, 'bad hello');
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (this.request?.socket === ws) {
        clearTimeout(this.request.timer);
        this.request = undefined;
        this.changed();
      }
    });
    ws.on('error', () => ws.terminate());
  }

  /**
   * The secure channel's handshake (phone-secure.ts): the pairing secret it is bound to is the open
   * pairing code's key (`pair`) or the named device's token hash (`hello`). An unknown device, or no
   * pairing open, gets a signed refusal. Then the first sealed frame is the phone's own hello or pair,
   * which must agree with what the handshake was for; one that does not open counts as a failure.
   */
  private secureStart(ws: WebSocket, ip: string, sec: SecHello, gate: { admitted: boolean }, helloTimer: NodeJS.Timeout) {
    let identity: Identity;
    try {
      identity = this.identity();
    } catch (err) {
      this.app.log('phone:', (err as Error).message);
      return ws.close(1011, 'no identity');
    }
    const refuse = (text: string, code: number) => {
      ws.send(answerHello(identity, sec, null, text).reply);
      ws.close(code, 'denied');
    };
    let psk: Buffer;
    let pairKey: string | undefined;
    if (sec.kind === 'hello') {
      const device = this.data.devices.find((d) => d.id === sec.id);
      if (!device) {
        this.failed(ip);
        return refuse('This phone is not paired with this computer', 4001);
      }
      psk = Buffer.from(device.tokenHash, 'hex');
    } else {
      const p = this.pairing;
      if (!p || p.expiresAt < Date.now()) {
        this.failed(ip);
        return refuse(p ? 'This pairing code is not valid. Show a new one on the desktop.' : 'Pairing is not open. Show the code in Settings › Phone.', 4002);
      }
      psk = Buffer.from(p.key, 'utf8');
      pairKey = p.key;
    }
    const answer = answerHello(identity, sec, psk);
    if (!answer.keys) return ws.close(4000, 'bad hello');
    ws.send(answer.reply);
    const link = new SealedLink(ws, answer.keys, {
      z: sec.z,
      onBroken: (why) => {
        this.failed(ip);
        this.app.log(`phone: closed a secure connection from ${ip}: ${why}`);
      },
    });
    const off = link.onMessage((text) => {
      off();
      try {
        const msg = text.length <= MAX_HELLO_BYTES ? readHello(text) : null;
        if (!msg) return link.close(4000, 'bad hello');
        this.admit(link, ip, msg, { kind: sec.kind, deviceId: sec.id, pairKey, socket: ws }, gate, helloTimer);
      } catch (err) {
        this.app.log('phone: a first frame failed', (err as Error).message);
        link.close(4000, 'bad hello');
      }
    });
  }

  /**
   * A phone's hello or pair, over a plain link (paired before the secure channel) or inside one.
   * Plain: a token of a phone paired then still works; a phone paired securely never connects plain,
   * and pairing anew plain is refused (the app is too old). Sealed: it must be what the handshake was
   * for (the same device, the same pairing key).
   */
  private admit(link: Link, ip: string, msg: PhoneHello, sec: { kind: 'pair' | 'hello'; deviceId: string; pairKey?: string; socket: WebSocket } | null, gate: { admitted: boolean }, helloTimer: NodeJS.Timeout) {
    if ('hello' in msg) {
      const hash = sha256(msg.hello.token);
      const device = this.data.devices.find((d) => sameHash(d.tokenHash, hash));
      const ok = !!device && (sec ? sec.kind === 'hello' && device.id === sec.deviceId : !device.secure);
      if (!ok) {
        this.failed(ip);
        this.sendFrame(link, { denied: 'This phone is not paired with this computer' });
        return link.close(4001, 'unknown token');
      }
      this.fails.delete(ip);
      clearTimeout(helloTimer);
      gate.admitted = true;
      this.authenticated(link, device!);
      return;
    }
    if (!sec) {
      // An app too old for the secure channel sent the code in the clear: someone on the way may have read it, so it no longer pairs.
      const p = this.pairing;
      if (p && sameSecret(msg.pair.key, p.key)) {
        this.pairing = undefined;
        this.app.log('phone: a pairing code came in the clear; it no longer pairs');
        this.changed();
      } else this.failed(ip);
      this.sendFrame(link, { denied: 'Update Sable on this phone to pair with this computer.' });
      return link.close(4003, 'update');
    }
    const p = this.pairing;
    if (sec.kind !== 'pair' || !p || p.key !== sec.pairKey || p.expiresAt < Date.now() || !sameSecret(msg.pair.key, p.key)) {
      this.failed(ip);
      this.sendFrame(link, { denied: p ? 'This pairing code is not valid. Show a new one on the desktop.' : 'Pairing is not open. Show the code in Settings › Phone.' });
      return link.close(4002, 'bad key');
    }
    // One phone per key; a second request replaces nothing while one waits.
    if (this.request) {
      this.sendFrame(link, { denied: 'Another phone is pairing. Try again in a moment.' });
      return link.close(4003, 'busy');
    }
    // A replacement needs a live ticket of the pairing it names, before anyone is asked; a wrong one
    // uses nothing up (neither the code nor that phone's ticket) and counts as a failure.
    const replaces = msg.pair.replaces;
    const old = replaces ? this.ticketFor(replaces.id, replaces.ticket) : undefined;
    if (replaces && !old) {
      this.failed(ip);
      this.sendFrame(link, { denied: TICKET_REFUSED });
      return link.close(4002, 'bad ticket');
    }
    this.pairing = undefined;
    clearTimeout(helloTimer);
    gate.admitted = true;
    const id = randomUUID();
    this.request = {
      id,
      name: cleanName(msg.pair.name),
      address: ip.replace(/^::ffff:/, ''),
      at: Date.now(),
      link,
      socket: sec.socket,
      ...(replaces && old ? { replaces, replacesName: old.name } : {}),
      timer: setTimeout(() => {
        if (this.request?.id === id) {
          this.endRequest('Nobody answered on the desktop');
          this.changed();
        }
      }, REQUEST_TTL_MS),
    };
    this.sendFrame(link, { waiting: true });
    this.changed();
  }

  /** From here on the link is a narrowed bridge connection for `device`. */
  private authenticated(link: Link, device: StoredPhone) {
    device.lastSeen = Date.now();
    this.save();
    let set = this.live.get(device.id);
    if (!set) this.live.set(device.id, (set = new Set()));
    set.add(link);
    // Its addresses now: a phone keeps new ones (Tailscale, a new network) and reaches it there later.
    this.sendFrame(link, { welcome: { deviceId: device.id, desktop: os.hostname(), version: VERSION, hosts: lanAddresses() } });
    this.changed();

    // The conversations this socket has open (opened last at the end): their items' events reach it.
    const watching: string[] = [];
    const watch = (id: string) => {
      const i = watching.indexOf(id);
      if (i >= 0) watching.splice(i, 1);
      watching.push(id);
      if (watching.length > WATCH_MAX) watching.shift();
    };
    const displayed = new Map<string, string>();
    const remember = (p: PhonePermission) => {
      if (!p.incomplete && p.revision) displayed.set(p.id, p.revision);
    };
    const unsubscribe = this.app.subscribe((event) => {
      if (!PHONE_EVENTS.has(event.type)) return;
      if (ITEM_EVENTS.has(event.type) && !watching.includes((event as { sessionId: string }).sessionId)) return;
      const e = phoneEvent(event, this.kindOf);
      if (e?.type === 'permission.removed') displayed.delete(e.id);
      if (e?.type === 'permission.added') {
        const p = e.request;
        this.sendFrame(link, { event: e }, error => { if (!error) remember(p); });
      } else if (e) this.sendFrame(link, { event: e as BridgeEvent });
    });
    let alive = true;
    link.onPong(() => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return link.terminate();
      alive = false;
      link.ping();
    }, 25_000);

    // Still allowed to act: this connection not detached (its phone removed, phone access off) and its
    // phone still paired with this token. Asked before every request and again before anything a
    // request does after a wait.
    let attached = true;
    const phoneSender = { deviceId: device.id, generation: this.data.generation ?? 0 };
    const allowed = () => attached && this.data.enabled && this.data.devices.some((d) => d.id === device.id && d.tokenHash === device.tokenHash);
    const act = () => {
      if (!allowed()) throw new Error('This phone was removed on the desktop');
    };

    const offMessage = link.onMessage(async (text) => {
      if (!allowed()) return;
      let req: RpcRequest;
      try {
        req = JSON.parse(text);
      } catch {
        return;
      }
      if (typeof req?.id !== 'number' || typeof req.method !== 'string') return;
      if (!ALLOWED.has(req.method) && !OWN.has(req.method)) {
        this.sendFrame(link, { id: req.id, ok: false, error: `Not available from the phone: ${req.method}` });
        return;
      }
      try {
        const raw = req.params && typeof req.params === 'object' ? (req.params as Record<string, unknown>) : {};
        const own = req.method as string;
        // Never the person's stylesheet through a chat: no chat in Sable's own folder, the Customize chat read-only.
        const refused = phoneRefusal(this.app, own, raw);
        if (refused) throw new Error(refused);
        let result: unknown;
        if (own === 'phone.fileLink') {
          // Plain HTTP downloads only for a phone paired before the secure channel; a secure one gets its files over this connection.
          if (link.secure) throw new Error('Update Sable on this phone to download files.');
          result = await this.fileLink(device.id, String(raw.sessionId ?? ''), String(raw.itemId ?? ''), Number(raw.index ?? 0));
          act();
        } else if (own === 'phone.fileStart' || own === 'phone.fileChunk' || own === 'phone.fileEnd') {
          if (!link.secure) throw new Error('Pair again for a secure connection to get this file.');
          try {
            if (own === 'phone.fileStart') {
              const grant = await this.sharedFile(device.id, String(raw.sessionId ?? ''), String(raw.itemId ?? ''), Number(raw.index ?? 0));
              act();
              result = await this.sending.start(device.id, grant, grant.sha256, allowed);
            } else if (own === 'phone.fileChunk') result = await this.sending.chunk(device.id, raw.transfer, raw.offset, raw.length);
            else result = this.sending.end(device.id, raw.transfer);
          } catch (err) {
            // Refused for now (starts in line, parts still on their way): the phone asks the same again after a moment.
            if (!(err instanceof RetryLater)) throw err;
            const reply: PhoneRetryReply = { id: req.id, ok: false, error: err.message, retry: true, retryAfterMs: err.retryAfterMs };
            return void this.sendFrame(link, reply);
          }
          act();
        } else if (own === 'phone.migrate') {
          // Only over a pairing from before the secure channel: what lets its secure pairing replace it here, and nowhere else.
          if (link.secure || device.secure) throw new Error('This phone is already paired securely.');
          result = { fingerprint: this.identity().fingerprint, ticket: this.ticketOf(device.id) };
        } else if (own === 'phone.queue') {
          const sessionId = String(raw.sessionId ?? '');
          await this.app.call('session.snapshot', { sessionId });
          const q = this.app.sessions.get(sessionId)?.queue ?? [];
          const from = typeof raw.from === 'number' && Number.isInteger(raw.from) && raw.from >= 0 ? raw.from : 0;
          result = { queue: trimQueue(q.slice(from, from + QUEUE_PAGE)), from, total: q.length };
        } else if (own === 'phone.sessions') {
          // The chats' list on from where `app.hello` (or the page before) stopped.
          const state = await this.app.call('app.hello', {});
          result = sessionsPage(state.sessions, placeIn(state.sessions, raw.cursor), PHONE_BYTES.sessions);
        } else if (own === 'phone.prompts') {
          // What waits on from a cursor: in one chat (`sessionId`, after `phone.tail`) or across chats (after `app.hello`).
          const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : undefined;
          let all: { permissions: PermissionRequest[]; questions: QuestionRequest[] };
          if (sessionId) all = this.app.sessions.get(sessionId)?.prompts() ?? { permissions: [], questions: [] };
          else all = (await this.app.call('app.hello', {})).prompts ?? { permissions: [], questions: [] };
          result = promptsPage(all, raw.cursor, PHONE_BYTES.prompts);
        } else if (own === 'phone.mkdir') {
          act();
          result = this.makeFolder(String(raw.parent ?? ''), String(raw.name ?? ''));
        } else if (own === 'phone.changes') {
          result = await this.changes.changes(String(raw.sessionId ?? ''), stepIds(raw.items));
        } else if (own === 'phone.diff') {
          const file = typeof raw.path === 'string' ? raw.path.replace(/\\/g, '/') : '';
          // Only this request's matching file needs its stored hunks. Keep that view local to
          // the request, so two phones can inspect different files in the same chat.
          const reader = new PhoneChangesReader(async sessionId => {
            const snap = await this.app.call('session.snapshot', { sessionId });
            const items = snap.items.map(it => {
              if (!isLight(it) || it.type !== 'tool' || !it.result?.diff?.some(d => relTo(d.path, snap.session.cwd) === file)) return it;
              const files = it.result.diff.map((d, index) => {
                if (relTo(d.path, snap.session.cwd) !== file) return d;
                // editsOf reads hunks only after selecting this turn's edits. A working-tree
                // request goes straight to git and never opens a stored line.
                const read = () => (this.app.store.wholeItem(sessionId, it) as ToolItem).result?.diff?.[index]?.hunks ?? [];
                let hunks: FileDiff['hunks'] | undefined;
                return { ...d, get hunks() { return hunks ??= read(); } };
              });
              return { ...it, result: { ...it.result, diff: files } };
            });
            return { ...snap, items };
          });
          result = await reader.diff(String(raw.sessionId ?? ''), file, stepIds(raw.items));
        } else if (own === 'phone.search') {
          // Each phone its own search: one phone's query never goes on with, or stops, another's.
          result = await this.finder.search(typeof raw.query === 'string' ? raw.query : '', { scope: `phone:${device.id}`, cursor: typeof raw.cursor === 'string' ? raw.cursor : undefined });
        } else if (own === 'phone.image') {
          result = await this.image(String(raw.sessionId ?? ''), String(raw.itemId ?? ''), Number(raw.index ?? 0));
        } else if (own === 'phone.thumb') {
          result = await pictureOf(this.app, { sessionId: raw.sessionId, itemId: raw.itemId, index: Number(raw.index ?? 0), size: PHONE_THUMB_PX }, 'phone');
        } else if (own === 'phone.tail' || own === 'phone.item') {
          const sessionId = String(raw.sessionId ?? '');
          // The session's own snapshot (loads it from disk the first time, marks it read), then trimmed.
          // `peek` (a tail only): the phone reads the newest words for a notification while it is in the
          // background: the chat stays unread on the desktop and its steps are not streamed to the phone.
          const peek = own === 'phone.tail' && raw.peek === true;
          const snap = await this.app.call('session.snapshot', peek ? { sessionId, peek: true } : { sessionId }, { allowed });
          act();
          if (own === 'phone.tail') {
            if (!peek) watch(sessionId);
            const str = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string) : undefined);
            const limit = typeof raw.limit === 'number' ? raw.limit : undefined;
            result = phoneTail(snap, { before: str('before'), limit, to: str('to'), around: str('around'), after: str('after') });
          } else result = phoneDetail(snap.items, String(raw.itemId ?? ''), item => this.app.store.wholeItem(sessionId, item));
        } else if (own === 'phone.steerNow') {
          const { sessionId, itemId } = raw;
          if (typeof sessionId !== 'string' || typeof itemId !== 'string') throw new Error('Select a message in its conversation.');
          const card = this.app.sessions.get(sessionId)?.get(itemId);
          if (card?.type !== 'user' || card.parentId || card.remote || syntheticOf(card)?.role === 'hidden') throw new Error('That message is unavailable.');
          act();
          result = await this.app.call('session.steerNow', { sessionId, itemId }, {
            phoneSender, allowed: () => !!this.app.phoneStillPaired?.(phoneSender) && !phoneRefusal(this.app, own, { sessionId }),
          });
        } else if (own === 'phone.answer') {
          // By the ids the phone got, into the agent's own keys (the original question and option words).
          const sessionId = String(raw.sessionId ?? '');
          const requestId = String(raw.requestId ?? '');
          const asked = this.app.sessions.get(sessionId)?.prompts().questions.find((q) => q.id === requestId);
          if (!asked) throw new Error('Those questions were already answered.');
          const answers = phonePicks(asked, raw.picks);
          act();
          result = await this.app.call('question.respond', { sessionId, requestId, answers }, { allowed });
        } else if (own === 'queue.take') {
          return void (await this.takeQueued(link, req.id, raw, allowed, device.id));
        } else if (own === 'phone.takeDone') {
          act();
          result = await this.takeDone(device.id, raw);
        } else if (own === 'session.setMode') {
          // A mode that never asks answers only what the phone could allow itself; what only the desktop may answer keeps waiting there.
          const sessionId = String(raw.sessionId ?? '');
          act();
          const shown = new Map<string, string>();
          if (Array.isArray(raw.shownPermissions)) for (const seen of raw.shownPermissions) {
            if (typeof seen?.revision === 'string' && displayed.get(seen.id) === seen.revision) shown.set(seen.id, seen.revision);
          }
          result = await this.app.call('session.setMode', { sessionId, mode: String(raw.mode ?? ''), answerWaiting: false }, { allowed });
          const rt = this.app.sessions.get(sessionId);
          if (rt && allowed() && rt.caps?.modes.find((m) => m.id === rt.meta.mode)?.tone === 'danger') {
            for (const p of rt.prompts().permissions) {
              const view = phonePermission(p);
              if (p.toolName === 'ExitPlanMode' || view.incomplete || !view.revision || shown.get(p.id) !== view.revision) continue;
              const ok = p.options.find((o) => o.tone === 'allow');
              if (ok) rt.answerPermission(p.id, { optionId: ok.id });
            }
          }
        } else {
          const params = narrow(req.method, raw, (sessionId, id) => this.app.sessions.get(sessionId)?.queue.find((q) => q.id === id)?.attachments);
          const submission = own === 'session.send' || own === 'session.submission';
          if (submission && (raw.submitId !== undefined || own === 'session.submission') && (typeof raw.submitId !== 'string' || !raw.submitId.length || raw.submitId.length > 128))
            throw new Error('A submission ID must contain 1 to 128 characters.');
          if (submission && typeof raw.submitId === 'string' && raw.submitId.length > 0 && raw.submitId.length <= 128) {
            params.submitId = 'phone-' + sha256(JSON.stringify([device.id, raw.submitId]));
          }
          // An answer from the phone allows only what the phone was shown, and answers questions it got whole.
          const prompts = own === 'permission.respond' || own === 'question.respond' ? this.app.sessions.get(String(params.sessionId ?? ''))?.prompts() : undefined;
          if (own === 'permission.respond') phoneAllowed(prompts?.permissions.find((p) => p.id === params.requestId), params.optionId);
          if (own === 'question.respond') {
            const asked = prompts?.questions.find((q) => q.id === params.requestId);
            if (asked) params.answers = phoneWordAnswers(asked, params.answers);
          }
          act();
          // The guard goes along: a handler that waits (a send for the agent to start, a model change to apply) asks it again before it acts.
          // (`settled`: a phone knows a sign-in only as in or out, so its hello never says "not known yet".)
          result = phoneResult(req.method, await this.app.call(req.method as RpcName, params as never, { allowed, settled: true, ...((submission || own === 'queue.sendNow') && { phoneSender }) }));
          if (submission && params.submitId && (result as { ok?: boolean })?.ok)
            result = { ...result as object, submitId: raw.submitId };
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
        const page = result as { permissions?: PhonePermission[]; prompts?: { permissions?: PhonePermission[] } } | undefined;
        const prompts = page?.permissions ?? page?.prompts?.permissions;
        this.sendFrame(link, { id: req.id, ok: true, result }, Array.isArray(prompts) ? err => { if (!err) prompts.forEach(remember); } : undefined);
      } catch (err) {
        this.sendFrame(link, { id: req.id, ok: false, error: (err as Error).message ?? String(err) });
      }
    });
    // Detached at once when the phone is removed or phone access goes off: no request of it is acted on from then.
    const detach = () => {
      attached = false;
      offMessage();
      unsubscribe();
      this.detach.delete(link);
    };
    this.detach.set(link, detach);
    const done = () => {
      clearInterval(ping);
      detach();
      const s = this.live.get(device.id);
      s?.delete(link);
      if (s && !s.size) this.live.delete(device.id);
      // Its files under way end with its last connection (the phone starts them again when it is back).
      if (!this.live.get(device.id)?.size) this.sending.drop(device.id);
      const d = this.data.devices.find((x) => x.id === device.id);
      if (d) {
        d.lastSeen = Date.now();
        this.save();
      }
      this.changed();
    };
    link.onClose(done);
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
