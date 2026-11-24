import type { BrowserAnswer, BrowserRequest } from '@shared/protocol';
import { listSignIns, reportBrowserPage, respondBrowser } from '@/state/actions';
import { useStore } from '@/state/store';
import { activeTab, getLog, getPage, getTabs, onPages, openTab, setPage, type AgentWork } from './browser-store';
import { clickScript, evalScript, focusedScript, locateScript, pickCancelScript, keyProbeRead, keyProbeScript, pressScript, requestsScript, scrollScript, signInProbeScript, snapshotScript, typeScript, userIdleScript, waitScript } from './browser-scripts';
import { askSignIn, type SignInChoice } from './sign-in';

/**
 * The window's side of the agent's browser tools (server/providers/browser-tool.ts): the bridge asks
 * with a `browser.request` event, the live Browser tab of that session does the work on the
 * <webview> of the page in front (its active tab), and the answer goes back with `browser.respond`. Only text, a picture, the page's
 * console problems and its failed requests ever leave the page: never cookies, storage or headers.
 */

/** What a live page offers the agent; registered while its <webview> exists. */
export interface PageController {
  sessionId: string;
  /** The page's tab (browser-store); the agent works on the session's active tab. */
  tabId: string;
  /** The address the view is on. */
  url(): string;
  /** The page's readable text (or of `selector`), cut at `max` characters. */
  read(selector: string | undefined, max: number): Promise<{ title: string; text: string; length: number; missing?: boolean; badSelector?: boolean }>;
  /** A picture of the page, sized for the agent. */
  capture(): Promise<string>;
  /** Runs one of Sable's page scripts (browser-scripts.ts) and gives its plain result. */
  run(script: string): Promise<unknown>;
  /** A real key press through the shell; false when it could not be sent. */
  key(combo: string): Promise<boolean>;
  /** Back, forward or reload; false when there is nowhere to go. */
  history(action: 'back' | 'forward' | 'reload'): boolean;
  /**
   * The agent's pointer (agent-pointer.ts): travels to the centre of `rect` (the page's CSS pixels,
   * `vw` its viewport width), and presses there. Absent where the tab draws none.
   */
  point?(rect: { x: number; y: number; w: number; h: number }, vw: number): Promise<void>;
  press?(): Promise<void>;
  /** The desktop app: the page view's webContents id (Electron main fills sign-ins into it). */
  guestId?(): number;
}

const TEXT_MAX = 20_000;
const LOAD_LOG_MS = 750;
const SNAPSHOT_MAX = 12_000;
const EVAL_MAX = 8_000;
const EVAL_MS = 5_000;
const LINES_MAX = 60;
const controllers = new Map<string, PageController>();

const desktop = (window as { sableDesktop?: { browser?: unknown } }).sableDesktop;
const native = !!desktop?.browser;
/**
 * The dev build's frames: a local page that answers Sable's messages (dev-frame.ts, the Demo's test
 * page) can be worked there too, so the pointer and the sign-in card can be filmed without the desktop app.
 */
const devFrames = !native && import.meta.env.DEV;

/** A tab of `c.sessionId` has a live page: the agent can look at it while it is in front. */
export function registerPage(c: PageController): () => void {
  controllers.set(c.tabId, c);
  schedulePageReport();
  return () => {
    if (controllers.get(c.tabId) === c) controllers.delete(c.tabId);
    schedulePageReport();
  };
}

/* ── what the tab shows, for the line the agent gets with the next message ── */

const reported = new Map<string, string>();
let reportTimer: ReturnType<typeof setTimeout> | undefined;

function schedulePageReport() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(reportPages, 300);
}

function reportPages() {
  const seen = new Set<string>();
  for (const c of controllers.values()) {
    const { sessionId } = c;
    // The page in front is the one the agent hears about.
    if (seen.has(sessionId) || activeTab(sessionId) !== c.tabId) continue;
    seen.add(sessionId);
    const p = getPage(c.tabId);
    // Settled pages only: a load in flight reports once it is done.
    if (p.loading) continue;
    const url = c.url() || p.url;
    const page = url && !p.error && /^https?:/.test(url) ? { url, title: p.title } : null;
    const key = page ? `${page.url}\n${page.title}` : '';
    if (reported.get(sessionId) === key) continue;
    reported.set(sessionId, key);
    void reportBrowserPage(sessionId, page);
  }
  for (const sessionId of [...reported.keys()]) {
    if (seen.has(sessionId)) continue;
    reported.delete(sessionId);
    void reportBrowserPage(sessionId, null);
  }
}

onPages(() => {
  if (controllers.size || reported.size) schedulePageReport();
});

/* ── requests from the bridge ── */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for `test` to hold on the tab's page (checked on every change), or gives up. */
function waitFor(tabId: string, test: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (test()) return resolve(true);
    let off = () => {};
    const timer = setTimeout(() => {
      off();
      clearInterval(poll);
      resolve(test());
    }, ms);
    // Page changes and controllers registering both count; a slow poll covers the latter.
    const check = () => {
      if (!test()) return;
      clearTimeout(timer);
      clearInterval(poll);
      off();
      resolve(true);
    };
    off = onPages(check);
    const poll = setInterval(check, 150);
    void tabId;
  });
}

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

/** Shows the agent's work in the bar for its moment (at least long enough to be seen). */
async function marked<T>(tabId: string, op: AgentWork, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  setPage(tabId, { agent: op, ...(DRIVES.has(op) ? { driving: true } : {}) });
  try {
    return await fn();
  } finally {
    const left = 700 - (Date.now() - started);
    if (left > 0) await sleep(left);
    if (getPage(tabId).agent === op) setPage(tabId, { agent: undefined });
  }
}

/** The tools that use the page as a person would: while one runs in a turn, the tab says the agent is driving. */
const DRIVES: ReadonlySet<AgentWork> = new Set<AgentWork>(['click', 'type', 'press', 'scroll', 'navigate', 'signIn']);

/** How long the agent keeps its hands off after the person used the page, and how long it waits for them at most. */
export const YIELD_QUIET_MS = 900;
export const YIELD_MAX_MS = 12_000;

/**
 * The person's pointer always wins: when they moved, clicked, scrolled or typed in the page a moment
 * ago, the agent's next action waits until they have been still for `YIELD_QUIET_MS` (at most `YIELD_MAX_MS`).
 */
async function yieldToPerson(c: PageController) {
  const tab = c.tabId;
  const until = Date.now() + YIELD_MAX_MS;
  try {
    for (;;) {
      const idle = Number(await within(c.run(userIdleScript), 3_000).catch(() => -1));
      if (!(idle >= 0 && idle < YIELD_QUIET_MS) || Date.now() > until) return;
      setPage(tab, { yielding: true });
      await sleep(YIELD_QUIET_MS - idle + 60);
    }
  } finally {
    if (getPage(tab).yielding) setPage(tab, { yielding: undefined });
  }
}

/** The pointer travels to an element and presses on it; a page or view without a pointer does nothing. */
async function pointAt(c: PageController, q: { ref?: string; selector?: string; text?: string }): Promise<{ error?: string }> {
  if (!c.point) return {};
  const loc = (await within(c.run(locateScript(q)), 4_000).catch(() => null)) as { error?: string; none?: boolean; rect?: { x: number; y: number; w: number; h: number }; vw?: number } | null;
  if (!loc || loc.none) return {};
  if (loc.error) return { error: String(loc.error).slice(0, 400) };
  if (!loc.rect || !(Number(loc.vw) > 0)) return {};
  await c.point(loc.rect, Number(loc.vw));
  await c.press?.();
  return {};
}

/**
 * The page is held for a sign-in: armed when the sign-in begins (before any card or fill) and ended
 * only by Electron main (electron/sign-in.ts), when a new document replaced the filled one or the
 * sign-in ended before anything was filled. Nothing the page does releases it.
 */
const held = (tab: string) => !!getPage(tab).filled;

/** Main said there are no tokens (sign-ins are off, for as long as the app runs): no later call waits to ask. */
let noTokens = false;

/** A token from Electron main for this request, for the page that serves it (none in the dev build, or with sign-ins off). */
async function attestFor(guestId: number | undefined): Promise<string | undefined> {
  const fn = (desktop as { browser?: { attest?: (id: number) => Promise<string | null> } } | undefined)?.browser?.attest;
  if (!fn || !guestId || noTokens) return undefined;
  try {
    const token = await fn(guestId);
    // Null is main's answer with sign-ins off (a page it will not vouch for is refused, not null):
    // the wait before the work is then for nothing, and in it the tab in front can change.
    if (token === null) noTokens = true;
    return token ?? undefined;
  } catch {
    return undefined;
  }
}

export async function handleBrowserRequest(req: BrowserRequest) {
  // Asked of main before the work starts, for the page that will serve it: the bridge believes main's
  // word about this token (which page, whether it is or became held), never the answer's own.
  const attest = await attestFor(controllers.get(activeTab(req.sessionId))?.guestId?.());
  let answer: BrowserAnswer;
  try {
    answer = await serve(req, attest);
  } catch (err) {
    answer = { ok: false, error: (err as Error)?.message || 'The Browser tab could not do that.' };
  }
  if (attest) answer = { ...answer, attest };
  void respondBrowser(req.sessionId, req.id, answer);
}

async function serve(req: BrowserRequest, attest?: string): Promise<BrowserAnswer> {
  if (!native && !devFrames) return { ok: false, weak: true, error: 'The Browser tab is only available in the desktop app.' };
  const st = useStore.getState();
  if (st.ui.activeSessionId !== req.sessionId) {
    return { ok: false, weak: true, error: 'The Browser tab shows another session right now. It works while the user has this session open.' };
  }
  const { sessionId } = req;

  if (req.op === 'open') {
    const url = req.url ?? '';
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Only http and https addresses open in the Browser tab.' };
    if (originOf(url) === location.origin) return { ok: false, error: 'Sable itself does not open in the Browser tab.' };
    // A new tab when the agent asks for one and the tab in front already shows a page; else the tab in front.
    const tab = req.newTab && getPage(activeTab(sessionId)).url ? (openTab(sessionId) ?? activeTab(sessionId)) : activeTab(sessionId);
    return marked(tab, 'open', async () => {
      let sawLoad = false;
      // The page view may not exist yet (panel closed, or another pane in front): open the panel on it.
      useStore.getState().setUi({ railOpen: true, railTab: 'browser', browserUrl: url });
      const settled = await waitFor(
        tab,
        () => {
          const p = getPage(tab);
          if (p.loading) sawLoad = true;
          return (devFrames || !!controllers.get(tab)) && sawLoad && !p.loading && !!p.url;
        },
        35_000,
      );
      // A dev frame registers once its page answered (dev-frame.ts); a page that never does is not worked.
      if (devFrames && settled) await waitFor(tab, () => !!controllers.get(tab), 1_500);
      const p = getPage(tab);
      if (!getTabs(sessionId).ids.includes(tab)) return { ok: false, error: 'The user closed the tab before the page loaded.' };
      if (!settled) return p.loading ? { ok: false, error: `The page is still loading after 35 seconds (${p.url || url}).` } : { ok: false, error: 'The Browser tab did not open the page.' };
      if (p.error) return { ok: false, url: p.url, error: `The page did not load: ${loadFailure(p.errorCode, p.url)} (${p.error}).` };
      // The title often arrives just after the load.
      if (!p.title) await waitFor(tab, () => !!getPage(tab).title, 800);
      const now = getPage(tab);
      return { ok: true, url: controllers.get(tab)?.url() || now.url, title: now.title };
    });
  }

  // Every tool works on the tab in front when the call comes, and stays on that tab until it is done.
  const tab = activeTab(sessionId);
  const c = controllers.get(tab);
  const p = getPage(tab);
  if (!c) {
    return p.url
      ? { ok: false, error: `The Browser tab is closed. Use browser_open to open ${p.url} again.` }
      : { ok: false, error: 'No page is open in the Browser tab. Use browser_open to open one.' };
  }
  const url = c.url() || p.url;
  if (req.op === 'state') return { ok: true, url, title: p.title };
  // While a sign-in is under way on this page, the agent gets nothing of it.
  if (p.signing && req.op !== 'signIn') return { ok: false, url, error: 'A sign-in is under way on this page. Wait for it to finish.' };
  if (!/^https?:/i.test(url)) return { ok: false, error: 'Sable reads only web pages (http or https).' };
  if (req.expectOrigin && originOf(url) !== req.expectOrigin) return { ok: false, error: 'The page changed while it was being checked. Try again.' };
  if (p.crashed) return { ok: false, url, error: 'The page stopped working. The user can reload it.' };
  if (p.hung) return { ok: false, url, error: 'The page is not responding (it may be busy in a loop). The user can reload it.' };
  if (p.error) return { ok: false, url, error: `The page did not load: ${loadFailure(p.errorCode, url)} (${p.error}).` };
  // A load in flight: wait a little for it to settle.
  if (p.loading) await waitFor(tab, () => !getPage(tab).loading, 8_000);

  if (req.op === 'read') {
    return marked(tab, 'read', async () => {
      const doc = getPage(tab).viewDoc;
      const changed = () => {
        const page = getPage(tab);
        return controllers.get(tab) !== c || page.viewDoc !== doc || (doc !== undefined && (page.logDoc ?? 0) > doc);
      };
      // The DOM answer and the shell's batches arrive on separate channels, even for a reload
      // of the same URL. A ready marker follows this document's entries through the window store.
      const [r] = await Promise.all([
        c.read(req.selector, TEXT_MAX),
        native && waitFor(tab, () => changed() || (!!doc && getPage(tab).loadedLog === doc), LOAD_LOG_MS),
      ]);
      if (r.badSelector) return { ok: false, url, error: `"${req.selector}" is not a valid CSS selector.` };
      if (r.missing) return { ok: false, url, error: `Nothing on the page matches "${req.selector}".` };
      const page = getPage(tab);
      const nowUrl = c.url() || url;
      if (changed() || (req.expectOrigin && originOf(nowUrl) !== req.expectOrigin)) {
        return { ok: false, error: 'The page changed during the read. Try again.' };
      }
      const answer: BrowserAnswer = {
        ok: true,
        url: nowUrl,
        title: r.title || page.title,
        text: r.text.slice(0, TEXT_MAX),
        truncated: r.length > TEXT_MAX,
        timedOut: native && (!doc || page.loadedLog !== doc),
      };
      if (native && (!doc || page.logDoc !== doc)) return answer;
      const log = getLog(tab);
      return {
        ...answer,
        console: log.console.slice(-30),
        failed: log.failed.slice(-30),
        more: { console: log.more.console + Math.max(0, log.console.length - 30), failed: log.more.failed + Math.max(0, log.failed.length - 30) },
      };
    });
  }

  // While the page is held for a sign-in: no scripts, pictures or logs for the agent, until a new document replaces it.
  if ((req.op === 'eval' || req.op === 'screenshot' || req.op === 'logs') && held(tab)) {
    return { ok: false, url, error: 'This page holds a sign-in. Scripts, screenshots and logs are refused until it loads another page (browser_navigate reload works); browser_snapshot and browser_read work.' };
  }

  if (req.op === 'signIn') return marked(tab, 'signIn', () => signIn(req, c, url, attest ?? ''));

  if (req.op !== 'screenshot') return marked(tab, req.op, () => work(req, c, url));

  return marked(tab, 'screenshot', async () => {
    if (!native) return { ok: false, url, error: 'Screenshots need the desktop app.' };
    const image = await c.capture();
    const size = await imageSize(image);
    return { ok: true, url: c.url() || url, title: getPage(tab).title, image, ...size };
  });
}

/** A page script's answer, or a plain failure when the page does not give one in time (it went away, or hangs). */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error('The page did not answer in time.')), ms))]);
}

const isLocal = (url: string) => {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
  } catch {
    return false;
  }
};

type Done = { error?: string; target?: string; text?: string; title?: string; count?: number; truncated?: boolean; length?: number; timedOut?: boolean; secret?: boolean };
const plain = (v: unknown): Done => (v && typeof v === 'object' ? (v as Done) : {});
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);

/** The tools that work the page: outline, click, type, press, scroll, script, logs, wait, history. */
async function work(req: BrowserRequest, c: PageController, url: string): Promise<BrowserAnswer> {
  // The tab the call started on, even if another one comes to the front meanwhile.
  const tab = c.tabId;
  const before = c.url() || url;
  const q = { ref: req.ref, selector: req.selector };
  /** After an action: a load it started is waited for, then where the page is. */
  const after = async (extra: Partial<BrowserAnswer> = {}): Promise<BrowserAnswer> => {
    await sleep(250);
    if (getPage(tab).loading) await waitFor(tab, () => !getPage(tab).loading, 10_000);
    const now = c.url() || getPage(tab).url;
    return { ok: true, url: now, title: getPage(tab).title, navigated: now.split('#')[0] !== before.split('#')[0] || undefined, ...extra };
  };

  // The person's pick mode swallows clicks and keys in the page: an action of the agent ends it first.
  if (req.op === 'click' || req.op === 'type' || req.op === 'press') await within(c.run(pickCancelScript), 3_000).catch(() => {});
  if (req.op === 'click' || req.op === 'type' || req.op === 'press' || req.op === 'scroll') await yieldToPerson(c);

  switch (req.op) {
    case 'snapshot': {
      const values = !held(c.tabId);
      const r = plain(await within(c.run(snapshotScript(SNAPSHOT_MAX, values)), 8_000));
      return { ok: true, url: before, title: text(r.title, 300) || getPage(tab).title, text: text(r.text, SNAPSHOT_MAX) ?? '', count: Number(r.count) || 0, truncated: r.truncated === true };
    }
    case 'click': {
      // The pointer travels there and presses; only then the click.
      const pointed = await pointAt(c, { ...q, text: req.find });
      if (pointed.error) return { ok: false, url: before, error: pointed.error };
      const r = plain(await within(c.run(clickScript({ ...q, text: req.find })), 8_000));
      if (r.error) return { ok: false, url: before, error: String(r.error).slice(0, 400) };
      return after({ target: text(r.target, 200) });
    }
    case 'type': {
      // Shows where it types: the pointer goes to the field and presses into it.
      if (q.ref || q.selector) {
        const pointed = await pointAt(c, q);
        if (pointed.error) return { ok: false, url: before, error: pointed.error };
      }
      const r = plain(await within(c.run(typeScript(q, (req.text ?? '').slice(0, 2_000), req.submit === true)), 8_000));
      if (r.error) return { ok: false, url: before, error: String(r.error).slice(0, 400) };
      return after({ target: text(r.target, 200) });
    }
    case 'press': {
      const key = req.key ?? '';
      const focus = plain(await within(c.run(focusedScript), 5_000));
      // Characters into a password field would be typing it, one key at a time.
      if (focus.secret && /(^|\+)[\x21-\x7e]$/.test(key)) return { ok: false, url: before, error: 'Sable does not type into password or payment fields. Ask the user to fill this one in the Browser tab.' };
      await within(c.run(keyProbeScript), 5_000);
      const sent = await c.key(key).catch(() => false);
      await sleep(90);
      const moved = getPage(tab).loading || (c.url() || '') !== before;
      const arrived = moved || (sent && (await within(c.run(keyProbeRead), 5_000).catch(() => true)) === true);
      // The shell's key did not reach the page (no focus in it): the same press as events on the focused element.
      if (!arrived) await within(c.run(pressScript(key)), 5_000);
      return after({ target: text(focus.target, 200) });
    }
    case 'scroll': {
      // The page glides while the pointer rests where it is.
      const r = plain(await within(c.run(scrollScript(q, req.to, req.by, !!c.point)), 5_000));
      if (r.error) return { ok: false, url: before, error: String(r.error).slice(0, 400) };
      return { ok: true, url: before, title: getPage(tab).title, target: text(r.target, 200), text: text(r.text, 120) };
    }
    case 'eval': {
      let r: Done;
      try {
        r = plain(await within(c.run(evalScript(req.script ?? '', EVAL_MAX, EVAL_MS, !isLocal(before))), EVAL_MS + 3_000));
      } catch (err) {
        // A script that does not parse never starts: the shell reports only that it failed.
        return { ok: false, url: before, error: `The script did not run (${(err as Error)?.message || 'it could not be parsed'}). It is the body of an async function: check its syntax.` };
      }
      if (r.error) return { ok: false, url: before, error: String(r.error).slice(0, 500) };
      return after({ text: text(r.text, EVAL_MAX) ?? 'undefined', truncated: (Number(r.length) || 0) > EVAL_MAX });
    }
    case 'logs': {
      const log = getLog(tab);
      if (req.kind === 'network') {
        const got = (await within(c.run(requestsScript(LINES_MAX)), 5_000)) as { total?: number; requests?: { url?: unknown; kind?: unknown; status?: unknown; ms?: unknown }[] } | null;
        const requests = (Array.isArray(got?.requests) ? got.requests : []).slice(-LINES_MAX).map((e) => ({ url: String(e.url ?? '').slice(0, 300), kind: String(e.kind ?? '').slice(0, 20), status: Number(e.status) || undefined, ms: Number(e.ms) || 0 }));
        // Requests that failed outright have no timing entry: the shell saw them.
        const known = new Set(requests.filter((r) => (r.status ?? 0) >= 400).map((r) => r.url));
        const failed = log.failed.filter((f) => !known.has(f.url)).slice(-20).map((f) => ({ url: f.url, method: f.method, status: f.status, error: f.status ? undefined : f.error || 'failed' }));
        return { ok: true, url: before, title: getPage(tab).title, requests: [...requests, ...failed], more: { failed: Math.max(0, (Number(got?.total) || 0) - requests.length) } };
      }
      return { ok: true, url: before, title: getPage(tab).title, lines: log.lines.slice(-LINES_MAX), more: { console: log.moreLines + Math.max(0, log.lines.length - LINES_MAX) } };
    }
    case 'wait': {
      const ms = Math.max(100, Math.min(30_000, req.timeoutMs ?? 5_000));
      const started = Date.now();
      let r: Done;
      try {
        r = plain(await within(c.run(waitScript(req.selector, ms)), ms + 3_000));
      } catch {
        // The document went away while waiting (a navigation): the wait ends with the page as it is now.
        r = { count: Date.now() - started, timedOut: !!req.selector };
      }
      if (r.error) return { ok: false, url: before, error: String(r.error).slice(0, 400) };
      return { ok: true, url: c.url() || before, title: text(r.title, 300) || getPage(tab).title, count: Number(r.count) || 0, timedOut: r.timedOut === true || undefined };
    }
    case 'navigate': {
      const action = req.action ?? 'reload';
      let sawLoad = false;
      if (!c.history(action)) return { ok: false, url: before, error: action === 'reload' ? 'The page could not be reloaded.' : `There is no page to go ${action} to.` };
      // A step inside one document (a hash, pushState) never loads: a short wait tells the two apart.
      await waitFor(tab, () => (sawLoad ||= getPage(tab).loading), 1_200);
      if (sawLoad) await waitFor(tab, () => !getPage(tab).loading, 30_000);
      const p = getPage(tab);
      if (p.error) return { ok: false, url: p.url, error: `The page did not load: ${loadFailure(p.errorCode, p.url)} (${p.error}).` };
      if (p.loading) return { ok: false, url: p.url, error: 'The page is still loading after 30 seconds.' };
      // The title often arrives just after the load.
      if (sawLoad && !p.title) await waitFor(tab, () => !!getPage(tab).title, 800);
      return { ok: true, url: c.url() || p.url, title: getPage(tab).title };
    }
    default:
      return { ok: false, error: 'The Browser tab does not know that request.' };
  }
}

/** The origin a sign-in may be filled on: https anywhere, http on this machine only. */
export function signInAllowed(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && isLocal(url))) return u.origin;
  } catch {
    /* not an address */
  }
  return undefined;
}

/** The desktop shell's sign-in calls (electron/preload.ts): main fills, the window never holds a saved password. */
type SignInShell = {
  begin(webContentsId: number, origin: string, token: string): Promise<{ ticket: string; hold: string; canSave: boolean; address: string; action: string }>;
  fill(webContentsId: number, ticket: string, cred: { kind: 'typed'; username: string; password: string; save: boolean } | { kind: 'saved'; id: string; username: string }, token: string): Promise<{ ok: boolean; code: string; user?: string }>;
  cancel(webContentsId: number, ticket: string, token: string, why: 'cancelled' | 'not-looking'): Promise<void>;
  finish(webContentsId: number, hold: string, how: 'continue' | 'close'): Promise<boolean>;
};
const shell = () => (desktop as { browser?: { signIn?: SignInShell } } | undefined)?.browser?.signIn;

/** After a fill, the person ends the hold from the tab's own line (BrowserAgentUi.tsx): Continue or Close. */
export async function finishSignIn(tabId: string, how: 'continue' | 'close') {
  const c = controllers.get(tabId);
  const hold = getPage(tabId).hold;
  const wc = c?.guestId?.();
  if (!hold || !wc) return;
  await shell()?.finish(wc, hold, how).catch(() => false);
}

/**
 * browser_sign_in on the tab's page. The agent named the fields; the person (or a sign-in they saved
 * for exactly this origin) supplies the values; Electron main fills and submits (electron/sign-in-core.ts).
 * Every outcome the agent hears is main's, as a fixed code bound to this request's token: what this
 * function answers itself is never passed on. Only in the desktop app: the dev build's frame cannot sign in.
 */
async function signIn(req: BrowserRequest, c: PageController, url: string, token: string): Promise<BrowserAnswer> {
  const tab = c.tabId;
  const sh = shell();
  const wc = c.guestId?.() ?? 0;
  const no: BrowserAnswer = { ok: false, url };
  if (!native || !sh || !wc || !token) return no;
  const origin = signInAllowed(url);
  if (!origin || req.expectOrigin !== origin) return no;
  const refs = { userRef: req.userRef ?? '', passRef: req.passRef ?? '', ...(req.submitRef ? { submitRef: req.submitRef } : {}) };
  if (!/^e\d{1,6}$/.test(refs.userRef) || !/^e\d{1,6}$/.test(refs.passRef)) return no;
  // Where the fields stand, for the pointer only, read before main replaces the page (no value is read or written).
  const probe = (await within(c.run(signInProbeScript(refs, false)), 5_000).catch(() => null)) as { error?: string; origin?: string; user?: Rect; pass?: Rect; submit?: Rect | null; vw?: number } | null;

  // The card is only for a person who is looking: this window focused and its Browser tab on screen.
  useStore.getState().setUi({ railOpen: true, railTab: 'browser' });
  const looking = () => document.visibilityState === 'visible' && document.hasFocus() && activeTab(c.sessionId) === tab && useStore.getState().ui.activeSessionId === c.sessionId;
  if (!looking()) {
    void sh.cancel(wc, '', token, 'not-looking').catch(() => {});
    return no;
  }
  // Main arms the hold, loads the page again and finds its form before any card shows.
  let begun: { ticket: string; hold: string; canSave: boolean; address: string; action: string };
  try {
    begun = await sh.begin(wc, origin, token);
  } catch {
    return no;
  }
  setPage(tab, { filled: true, signing: true, hold: begun.hold });
  let filling = false;
  try {
    const saved = await listSignIns(origin).catch(() => []);
    const here = () => signInAllowed(c.url() || getPage(tab).url) === origin && controllers.get(tab) === c;
    const alive = { cancelled: () => !here() || document.visibilityState !== 'visible' || activeTab(c.sessionId) !== tab };
    // Always asked: the person chooses on the visible card every time (nothing picks an entry by itself).
    const choice: SignInChoice = await askSignIn({ tabId: tab, origin, address: begun.address, action: begun.action, saved, canSave: begun.canSave }, alive);
    if (choice.kind === 'cancel') return no;

    // Watch it: the pointer goes to each field and the submit control; main then fills and sends.
    if (c.point && probe?.vw && !probe.error) {
      for (const r of [probe.user, probe.pass, probe.submit]) {
        if (!r) continue;
        await c.point(r, probe.vw);
        await c.press?.();
      }
    }
    filling = true;
    const cred = choice.kind === 'saved' ? { kind: 'saved' as const, id: choice.id, username: choice.username } : { kind: 'typed' as const, username: choice.username, password: choice.password, save: choice.save };
    const r = await sh.fill(wc, begun.ticket, cred, token).catch(() => ({ ok: false, code: 'failed' }) as { ok: boolean; code: string; user?: string });
    if (!r.ok || r.code !== 'signed-in') return no;
    setPage(tab, { signedInAs: String(r.user ?? '').slice(0, 200) });
    return { ok: true, url };
  } finally {
    setPage(tab, { signing: undefined });
    // Nothing was handed to main: the ticket ends here, and with it the hold (main says when).
    if (!filling) void sh.cancel(wc, begun.ticket, token, 'cancelled').catch(() => {});
  }
}

type Rect = { x: number; y: number; w: number; h: number };

function imageSize(src: string): Promise<{ width?: number; height?: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({});
    img.src = src;
  });
}

/** A failed load in plain words (the same words the tab shows). */
function loadFailure(code: number | undefined, url: string): string {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep the address */
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)|\.localhost(:|$)/.test(host);
  const c = code ?? 0;
  if (c === -102 || c === -101 || c === -100 || c === -109) return local ? `Nothing is running at ${host}` : `${host} refused to connect`;
  if (c === -105 || c === -137) return `Could not find ${host}`;
  if (c === -106) return 'You are offline';
  if (c === -7 || c === -118) return `${host} took too long to answer`;
  return `${host} did not load`;
}

/** The script that reads a page's text. Runs in the page; only reads text, never storage or cookies. */
export function readScript(selector: string | undefined, max: number): string {
  return `(() => {
  const sel = ${JSON.stringify(selector ?? '')};
  let root = document.body;
  if (sel) {
    try { root = document.querySelector(sel); } catch (e) { return { badSelector: true, title: document.title, text: '', length: 0 }; }
    if (!root) return { missing: true, title: document.title, text: '', length: 0 };
  }
  const t = root ? String(root.innerText || root.textContent || '') : '';
  return { title: String(document.title || ''), text: t.slice(0, ${max + 1}), length: t.length };
})()`;
}
