/**
 * Before / after: when a turn edits a local web page, the page is captured headless just before
 * the turn's first edit and again when the turn ends, and the regions that changed are found.
 *
 * When the before is taken, in order of preference:
 *   - when the turn starts, if a local page is already known for the session (the page its
 *     Browser tab shows, or the page the last such turn worked on);
 *   - when a local page is first named in the turn (a command's output, the agent's words, a
 *     Browser tab tool) before any edit;
 *   - at the turn's first edit call, racing the edit: a before taken after that edit landed is
 *     dropped, and the capture says plainly that there is no before.
 * The after is taken when the turn ends, if it changed files and a local page is known for it
 * (named in the turn, else the before's page). Nothing runs for sessions without a local page.
 *
 * Pictures live under `<home>/captures/<session>/` (JPEG, an index beside them), the last
 * `maxTurns` turns per session, removed with the session. The browser is `capture-browser.ts`.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BridgeEvent, CaptureView, TimelineItem, ToolItem, TurnCapture } from '../../shared/protocol';
import { syntheticOf } from '../../shared/synthetic';
import type { App } from '../app';
import { BrowserCapturer, CELL, findBrowser, type Capturer, type Picture } from './capture-browser';
import { diffRegions, toPixels } from './capture-diff';
import { anyPageHeld } from './sign-ins';

// ───────────────────────────── local pages in text ─────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const LOCAL_URL = /https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|(?:[a-z0-9-]+\.)+localhost)(?::\d{2,5})?(?:[/?#][^\s'"`<>)\]}]*)?/gi;

/** Local http(s) pages in `text`, first mention first (the rule of the timeline's Preview: a bare host needs a port). */
export function localPages(text: string | undefined): string[] {
  if (!text || !text.includes('://')) return [];
  const out: string[] = [];
  for (const m of text.replace(ANSI, '').matchAll(LOCAL_URL)) {
    const raw = m[0].replace(/[.,;:!?*_]+$/, '').replace(/^(https?:\/\/)0\.0\.0\.0/i, '$1localhost');
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (!u.port && !u.hostname.endsWith('.localhost')) continue;
    if (!out.includes(u.href)) out.push(u.href);
  }
  return out;
}

/** Only pages on this machine are ever captured. */
export function isLocalPage(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
  } catch {
    return false;
  }
}

/** The same page on this machine: localhost, 127.0.0.1 and [::1] are one host. */
export function samePage(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const key = (u: URL) => `${u.protocol}//${/^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(u.hostname) ? 'localhost' : u.hostname}:${u.port}${u.pathname.replace(/\/+$/, '')}${u.search}`;
    return key(new URL(a)) === key(new URL(b));
  } catch {
    return false;
  }
}

const isEdit = (it: TimelineItem | undefined): boolean => it?.type === 'tool' && (it.kind === 'edit' || it.kind === 'write');

/** What a finished item says about local pages. */
function pagesIn(it: TimelineItem | undefined, whole?: (item: TimelineItem) => TimelineItem): string[] {
  if (!it) return [];
  if (it.type === 'text') return localPages(it.text);
  if (it.type === 'tool' && it.kind === 'bash') {
    const step = (whole?.(it) ?? it) as ToolItem;
    return localPages(`${step.output ?? ''}\n${step.result?.text ?? ''}`);
  }
  if (it.type === 'tool' && it.kind === 'browser' && isLocalPage(it.detail.url)) return [it.detail.url];
  return [];
}

// ───────────────────────────────── the service ─────────────────────────────────

export interface CaptureHost {
  /** Where pictures are kept (`<home>/captures`). */
  dir: string;
  items(sessionId: string): readonly TimelineItem[];
  item(sessionId: string, id: string): TimelineItem | undefined;
  whole?(sessionId: string, item: TimelineItem): TimelineItem;
  /** The page the session's Browser tab shows. */
  page(sessionId: string): string | undefined;
  /** Every session that exists (captures of others are removed). */
  sessions(): string[];
  emit(e: BridgeEvent): void;
  log(...args: unknown[]): void;
}

export interface CaptureOptions {
  /** After the turn ends, let dev servers rebuild for this long before the after. */
  settleMs?: number;
  /** Turns kept per session. */
  maxTurns?: number;
  /** Is anything listening there? (A cheap check before a browser starts for a page that is not up.) */
  probe?: (url: string) => Promise<boolean>;
  now?: () => number;
}

interface Before {
  url: string;
  pictures: Picture[];
}

interface Track {
  /** The before for each page asked for in this turn (null: it did not load). */
  befores: Map<string, Promise<Before | null>>;
  /** Local pages named in the turn so far, first first. */
  pages: string[];
  /** When the first edit call appeared, and when the first edit finished. */
  editCalled?: number;
  editDone?: number;
  edited: boolean;
}

interface Entry {
  capture: TurnCapture;
  bytes: number;
}

interface Index {
  /** The page the last captured turn worked on: known at the next turn's start. */
  lastUrl?: string;
  turns: Entry[];
}

/** Probes with a plain request: any answer at all means the page's server is up. */
async function probeHttp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(2500) });
    void res.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

const NO_BEFORE = {
  unknown: 'There is no before: the page was not known before the first edit',
  late: 'There is no before: the first edit landed before the page could be captured',
  failed: 'There is no before: the page did not load before the first edit',
};

export class CaptureService {
  private tracks = new Map<string, Track>();
  private indexes = new Map<string, Index>();
  private work = new Set<Promise<unknown>>();
  private capturer?: Capturer | null;
  private settleMs: number;
  private maxTurns: number;
  private probe: (url: string) => Promise<boolean>;
  private now: () => number;
  private disposed = false;

  constructor(
    private host: CaptureHost,
    private makeCapturer: () => Capturer | null,
    opts: CaptureOptions = {},
  ) {
    this.settleMs = opts.settleMs ?? 700;
    this.maxTurns = opts.maxTurns ?? 30;
    this.probe = opts.probe ?? probeHttp;
    this.now = opts.now ?? Date.now;
  }

  /** Every bridge event passes here; only a few matter. Never throws. */
  feed(e: BridgeEvent) {
    if (this.disposed) return;
    try {
      switch (e.type) {
        case 'session.updated': {
          const status = e.patch.status;
          if (status === 'running' && !this.tracks.has(e.id)) this.turnStarted(e.id);
          else if ((status === 'idle' || status === 'error') && this.tracks.has(e.id)) this.turnEnded(e.id);
          return;
        }
        case 'item.added': {
          const t = this.tracks.get(e.sessionId);
          if (!t) return;
          if (isEdit(e.item)) this.editCalled(e.sessionId, t);
          else if (e.item.type === 'tool' && e.item.kind === 'browser') this.named(e.sessionId, t, pagesIn(e.item));
          return;
        }
        case 'item.patch': {
          const t = this.tracks.get(e.sessionId);
          if (!t) return;
          const p = e.patch as Partial<ToolItem> & { streaming?: boolean };
          const done = p.status === 'done' || p.status === 'error';
          if (!done && p.streaming !== false) return;
          const it = this.host.item(e.sessionId, e.id);
          if (isEdit(it)) {
            if (p.status === 'done') {
              t.edited = true;
              t.editDone ??= p.endedAt ?? this.now();
            }
          } else this.named(e.sessionId, t, pagesIn(it, item => this.host.whole?.(e.sessionId, item) ?? item));
          return;
        }
        case 'session.removed':
          this.tracks.delete(e.id);
          this.remove(e.id);
          return;
        default:
          return;
      }
    } catch (err) {
      this.host.log('capture:', (err as Error).message);
    }
  }

  // ── a turn ──

  private turnStarted(sessionId: string) {
    const t: Track = { befores: new Map(), pages: [], edited: false };
    this.tracks.set(sessionId, t);
    const known = this.knownPage(sessionId);
    if (known) this.before(t, known);
  }

  /** The page known for the session without the turn: its Browser tab's, else the last captured turn's. */
  private knownPage(sessionId: string): string | undefined {
    const shown = this.host.page(sessionId);
    if (isLocalPage(shown)) return shown;
    return this.index(sessionId).lastUrl;
  }

  private named(sessionId: string, t: Track, pages: string[]) {
    for (const url of pages) {
      if (t.pages.some((p) => samePage(p, url))) continue;
      t.pages.push(url);
      // Named before any edit: the page as it is now is the before.
      if (t.editCalled === undefined && t.befores.size < 2) this.before(t, url);
    }
  }

  private editCalled(sessionId: string, t: Track) {
    if (t.editCalled !== undefined) return;
    t.editCalled = this.now();
    if (t.befores.size) return;
    const url = this.knownPage(sessionId) ?? t.pages[0];
    if (url) this.before(t, url);
  }

  private before(t: Track, url: string) {
    if (t.befores.has(url)) return;
    const p = this.shoot(url, 'auto').then(
      (pictures) => (pictures ? { url, pictures } : null),
      () => null,
    );
    t.befores.set(url, p);
    this.track(p);
  }

  /** Pictures of `url`, or null when nothing answers there or capture is not available. */
  private async shoot(url: string, phone: boolean | 'auto'): Promise<Picture[] | null> {
    if (!(await this.probe(url))) return null;
    const capturer = this.getCapturer();
    if (!capturer) return null;
    return (await capturer.shoot(url, { phone })).pictures;
  }

  private getCapturer(): Capturer | null {
    if (this.capturer === undefined) this.capturer = this.makeCapturer();
    return this.capturer;
  }

  private turnEnded(sessionId: string) {
    const t = this.tracks.get(sessionId)!;
    this.tracks.delete(sessionId);
    const items = this.host.items(sessionId);
    const turnId = leadOf(items);
    if (!t.edited || !turnId) {
      // Nothing changed: no pictures are kept (a before in flight is simply not used).
      if (t.pages.length && turnId) this.remember(sessionId, t.pages[t.pages.length - 1]);
      return;
    }
    const named = namedInTurn(items, turnId, item => this.host.whole?.(sessionId, item) ?? item);
    const url = named[0] ?? [...t.befores.keys()][0] ?? this.knownPage(sessionId);
    if (!url) return;
    this.track(this.after(sessionId, turnId, url, t));
  }

  private async after(sessionId: string, turnId: string, url: string, t: Track) {
    const index = this.index(sessionId);
    index.lastUrl = url;
    const beforeP = t.befores.get([...t.befores.keys()].find((k) => samePage(k, url)) ?? url);
    await this.sleep(this.settleMs);
    let before = beforeP ? await beforeP : null;
    let noBefore: string | undefined;
    if (!beforeP) noBefore = NO_BEFORE.unknown;
    else if (!before) noBefore = NO_BEFORE.failed;
    else if (t.editDone !== undefined) {
      // A picture taken once the first edit had landed may already show it: not a before.
      const editDone = t.editDone;
      const valid = before.pictures.filter((p) => p.at < editDone);
      before = valid.length && valid[0].view.kind === 'desktop' ? { ...before, pictures: valid } : null;
      if (!before) noBefore = NO_BEFORE.late;
    }
    if (this.disposed) return;
    // A turn captured again (a retry under the same message) replaces its pictures.
    const old = index.turns.findIndex((x) => x.capture.turnId === turnId);
    const had = old >= 0 ? index.turns.splice(old, 1)[0] : undefined;
    if (had) this.dropImages(sessionId, had);
    if (!before) {
      // With no before there is nothing to compare: no picture is taken and the turn offers no
      // "Before / after" (it used to offer one that said "After only"). What the turn showed
      // before, under the same message, goes.
      if (had) {
        this.save(sessionId);
        this.publish(sessionId, { capture: { turnId, url, state: 'failed', views: [], error: noBefore }, bytes: 0 });
      }
      return;
    }
    const entry: Entry = { capture: { turnId, url, state: 'capturing', views: [] }, bytes: 0 };
    index.turns.push(entry);
    this.publish(sessionId, entry);

    let after: Picture[] | null = null;
    let error: string | undefined;
    try {
      after = await this.shoot(url, before.pictures.some((p) => p.view.kind === 'phone') ? true : 'auto');
      if (!after) error = 'The page did not load';
    } catch (err) {
      error = (err as Error).message;
    }
    if (this.disposed || !this.index(sessionId).turns.includes(entry)) return;
    if (!after) {
      entry.capture = { turnId, url, state: 'failed', views: [], error };
      this.save(sessionId);
      this.publish(sessionId, entry);
      return;
    }
    const dir = path.join(this.host.dir, sessionId);
    mkdirSync(dir, { recursive: true });
    const store = (p: Picture) => {
      const id = randomUUID().slice(0, 12);
      writeFileSync(path.join(dir, `${id}.jpg`), p.jpeg);
      entry.bytes += p.jpeg.length;
      return { id, at: p.at };
    };
    const views: CaptureView[] = after.map((a) => {
      const b = before.pictures.find((p) => p.view.kind === a.view.kind);
      const { kind, width, height, scale } = a.view;
      const view: CaptureView = { kind, width, height, scale, after: store(a) };
      if (b) {
        view.before = store(b);
        const d = diffRegions(b.thumb, a.thumb);
        view.regions = toPixels(d.boxes, CELL, 8, width, height);
        view.changed = Math.round(d.changed * 10_000) / 10_000;
      }
      return view;
    });
    entry.capture = { turnId, url, state: 'ready', views };
    this.prune(sessionId);
    this.save(sessionId);
    this.publish(sessionId, entry);
  }

  /** Remembers the page a turn named (it worked on it without changing files): known at the next turn's start. */
  private remember(sessionId: string, url: string) {
    const index = this.index(sessionId);
    if (index.lastUrl === url) return;
    index.lastUrl = url;
    this.save(sessionId);
  }

  private sleep(ms: number) {
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }

  private track<T>(p: Promise<T>) {
    const q = p.catch((err) => this.host.log('capture failed:', (err as Error).message)).finally(() => this.work.delete(q));
    this.work.add(q);
  }

  /** Resolves when no capture is in flight (tests). */
  async idle() {
    while (this.work.size) await Promise.all([...this.work]);
  }

  // ── storage ──

  private file(sessionId: string) {
    return path.join(this.host.dir, sessionId, 'index.json');
  }

  private index(sessionId: string): Index {
    let index = this.indexes.get(sessionId);
    if (index) return index;
    try {
      const raw = JSON.parse(readFileSync(this.file(sessionId), 'utf8')) as Index;
      index = { lastUrl: typeof raw.lastUrl === 'string' ? raw.lastUrl : undefined, turns: Array.isArray(raw.turns) ? raw.turns : [] };
      // Whatever was mid-capture when Sable closed did not finish.
      for (const e of index.turns) if (e.capture.state === 'capturing') e.capture = { ...e.capture, state: 'failed', error: 'Sable closed during the capture' };
    } catch {
      index = { turns: [] };
    }
    this.indexes.set(sessionId, index);
    return index;
  }

  private save(sessionId: string) {
    const index = this.indexes.get(sessionId);
    if (!index) return;
    try {
      mkdirSync(path.dirname(this.file(sessionId)), { recursive: true });
      writeFileSync(this.file(sessionId), JSON.stringify(index));
    } catch (err) {
      this.host.log('could not save captures', (err as Error).message);
    }
  }

  private publish(sessionId: string, entry: Entry) {
    this.host.emit({ type: 'capture.updated', sessionId, capture: entry.capture });
  }

  private prune(sessionId: string) {
    const index = this.index(sessionId);
    while (index.turns.length > this.maxTurns) this.dropImages(sessionId, index.turns.shift()!);
  }

  private dropImages(sessionId: string, entry: Entry) {
    for (const v of entry.capture.views) {
      for (const s of [v.before, v.after]) if (s) rmSync(path.join(this.host.dir, sessionId, `${s.id}.jpg`), { force: true });
    }
  }

  private remove(sessionId: string) {
    this.indexes.delete(sessionId);
    if (!/^[\w-]+$/.test(sessionId)) return;
    rmSync(path.join(this.host.dir, sessionId), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }

  /** Removes the captures of sessions that no longer exist. */
  sweep() {
    let names: string[];
    try {
      names = readdirSync(this.host.dir);
    } catch {
      return;
    }
    const alive = new Set(this.host.sessions());
    for (const name of names) if (!alive.has(name)) this.remove(name);
  }

  list(sessionId: string): TurnCapture[] {
    return this.index(sessionId).turns.map((e) => e.capture);
  }

  image(sessionId: string, id: string): string | null {
    if (!/^[\w-]+$/.test(sessionId) || !/^[\w-]+$/.test(id)) return null;
    try {
      return `data:image/jpeg;base64,${readFileSync(path.join(this.host.dir, sessionId, `${id}.jpg`)).toString('base64')}`;
    } catch {
      return null;
    }
  }

  async dispose() {
    this.disposed = true;
    this.tracks.clear();
    await this.capturer?.dispose().catch(() => {});
  }
}

/**
 * The message that started the latest turn (the timeline's turn key), read as the window groups
 * turns (timeline/turns.ts): a notification the agent's harness wrote (a task finished) opens a
 * turn only when none is open, and a command's output or a reminder never opens one.
 */
export function leadOf(items: readonly TimelineItem[]): string | undefined {
  let lead: string | undefined;
  let open = false;
  for (const it of items) {
    if (it.parentId) continue;
    if (it.type === 'user') {
      if (it.steered || it.state === 'queued') continue;
      const syn = syntheticOf(it);
      // Inside a turn a notification joins it; a command's output or a summary never opens one.
      if (syn && syn.role !== 'command' && (open || syn.role === 'output' || syn.role === 'summary')) continue;
      lead = it.id;
      open = true;
    } else if (it.type === 'turn' || (it.type === 'notice' && (it.variant === 'interrupted' || !!it.until || !!it.agentSwitch))) open = false;
  }
  return lead;
}

/** Local pages the turn names: its last words first, then what its commands printed, latest first. */
export function namedInTurn(items: readonly TimelineItem[], turnId: string, whole?: (item: TimelineItem) => TimelineItem): string[] {
  const at = items.findIndex((i) => i.id === turnId);
  if (at < 0) return [];
  const turn = items.slice(at + 1).filter((i) => !i.parentId);
  const out: string[] = [];
  const add = (urls: string[]) => urls.forEach((u) => !out.includes(u) && out.push(u));
  for (let i = turn.length - 1; i >= 0; i--) if (turn[i].type === 'text') add(pagesIn(turn[i]));
  for (let i = turn.length - 1; i >= 0; i--) if (turn[i].type === 'tool') add(pagesIn(turn[i], whole));
  return out;
}

// ───────────────────────────────── registration ─────────────────────────────────

export function registerCapture(app: App, opts: { enabled?: boolean } = {}) {
  const enabled = opts.enabled ?? !process.env.VITEST;
  const svc = new CaptureService(
    {
      dir: path.join(app.store.dir, 'captures'),
      items: (id) => app.sessions.get(id)?.items ?? [],
      item: (sid, id) => app.sessions.get(sid)?.get(id),
      whole: (sid, item) => app.store.wholeItem(sid, item),
      // A page held for a sign-in is never captured (its picture would be published).
      page: (id) => (anyPageHeld() ? undefined : app.sessions.get(id)?.browserPage?.url),
      sessions: () => app.store.state.sessions.map((s) => s.id),
      emit: (e) => app.emit(e),
      log: app.log,
    },
    () => {
      const executable = findBrowser();
      if (!executable) app.log('before / after is off: no Edge or Chrome found');
      return executable ? new BrowserCapturer({ executable, log: app.log }) : null;
    },
  );
  // Off in unit tests: no browser starts there.
  const off = enabled ? app.subscribe((e) => svc.feed(e)) : () => {};
  app.register('capture.list', ({ sessionId }) => svc.list(sessionId));
  app.register('capture.image', ({ sessionId, id }) => {
    const data = svc.image(sessionId, id);
    return data ? { data } : null;
  });
  // Captures of chats deleted while Sable was closed: a moment after start, off the start-up path.
  const sweep = setTimeout(() => svc.sweep(), 30_000);
  sweep.unref?.();
  app.onDispose(async () => {
    clearTimeout(sweep);
    off();
    await svc.dispose();
  });
  return svc;
}
