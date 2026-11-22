import type { BrowserAnswer, BrowserRequest } from '@shared/protocol';
import { listSignIns, markSignInUsed, reportBrowserPage, respondBrowser, revealSignIn, saveSignIn, signInState } from '@/state/actions';
import { useStore } from '@/state/store';
import { activeTab, getLog, getPage, getTabs, onPages, openTab, setPage, type AgentWork } from './browser-store';
import { clickScript, evalScript, focusedScript, locateScript, pickCancelScript, keyProbeRead, keyProbeScript, pressScript, requestsScript, scrollScript, signInCheckScript, signInFillScript, signInProbeScript, snapshotScript, typeScript, userIdleScript, waitScript } from './browser-scripts';
import { askSignIn, SIGNED_LINE_MS, type SignInChoice } from './sign-in';

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
}

const TEXT_MAX = 20_000;
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
 * A password Sable filled is still in this document: asks the page whether the field was cleared
 * (then the hold ends early); an answer that cannot be read keeps the hold until the page navigates.
 */
async function stillFilled(c: PageController): Promise<boolean> {
  const tab = c.tabId;
  if (!getPage(tab).filled) return false;
  const r = (await within(c.run(signInCheckScript), 3_000).catch(() => null)) as { cleared?: boolean } | null;
  if (r && r.cleared === true) {
    setPage(tab, { filled: undefined });
    return false;
  }
  return true;
}

export async function handleBrowserRequest(req: BrowserRequest) {
  let answer: BrowserAnswer;
  try {
    answer = await serve(req);
  } catch (err) {
    answer = { ok: false, error: (err as Error)?.message || 'The Browser tab could not do that.' };
  }
  void respondBrowser(req.sessionId, req.id, answer);
}

async function serve(req: BrowserRequest): Promise<BrowserAnswer> {
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
  if (!/^https?:/i.test(url)) return { ok: false, error: 'Sable reads only web pages (http or https).' };
  if (req.expectOrigin && originOf(url) !== req.expectOrigin) return { ok: false, error: 'The page changed while it was being checked. Try again.' };
  if (p.crashed) return { ok: false, url, error: 'The page stopped working. The user can reload it.' };
  if (p.hung) return { ok: false, url, error: 'The page is not responding (it may be busy in a loop). The user can reload it.' };
  if (p.error) return { ok: false, url, error: `The page did not load: ${loadFailure(p.errorCode, url)} (${p.error}).` };
  // A load in flight: wait a little for it to settle.
  if (p.loading) await waitFor(tab, () => !getPage(tab).loading, 8_000);

  if (req.op === 'read') {
    return marked(tab, 'read', async () => {
      const r = await c.read(req.selector, TEXT_MAX);
      if (r.badSelector) return { ok: false, url, error: `"${req.selector}" is not a valid CSS selector.` };
      if (r.missing) return { ok: false, url, error: `Nothing on the page matches "${req.selector}".` };
      const log = getLog(tab);
      return {
        ok: true,
        url: c.url() || url,
        title: r.title || getPage(tab).title,
        text: r.text.slice(0, TEXT_MAX),
        truncated: r.length > TEXT_MAX,
        console: log.console.slice(-30),
        failed: log.failed.slice(-30),
        more: { console: log.more.console + Math.max(0, log.console.length - 30), failed: log.more.failed + Math.max(0, log.failed.length - 30) },
      };
    });
  }

  // While a password Sable filled is in the page: no scripts and no pictures for the agent, until the page moves on or the field is cleared.
  if ((req.op === 'eval' || req.op === 'screenshot') && (await stillFilled(c))) {
    return { ok: false, url, error: 'A password Sable filled is still in a field of this page. Scripts and screenshots are refused until the page moves on or the field is cleared; browser_snapshot and browser_read work.' };
  }

  if (req.op === 'signIn') return marked(tab, 'signIn', () => signIn(req, c, url));

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
      const values = !(await stillFilled(c));
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

/** How long a submitted sign-in may take to leave its form before it counts as refused. */
export const SIGN_IN_SETTLE_MS = 6_000;

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

/**
 * browser_sign_in on the tab's page. The agent named the fields; the person (or a sign-in they saved
 * for exactly this origin) supplies the values, Sable fills and submits in one step, and the answer
 * is only whether it worked and the user name. The origin is the page's own as the view reports it
 * (never a name the page or the agent supplies), checked when the call comes, again right before the
 * values are fetched, and inside the page at the moment of filling.
 */
async function signIn(req: BrowserRequest, c: PageController, url: string): Promise<BrowserAnswer> {
  const tab = c.tabId;
  const origin = signInAllowed(url);
  if (!origin) return { ok: false, url, error: 'Sable signs in only on https sites (and on localhost for tests).' };
  if (req.expectOrigin && req.expectOrigin !== origin) return { ok: false, url, error: 'The page moved to another site. Take a new browser_snapshot.' };
  const refs = { userRef: req.userRef ?? '', passRef: req.passRef ?? '', ...(req.submitRef ? { submitRef: req.submitRef } : {}) };
  if (!/^e\d{1,6}$/.test(refs.userRef) || !/^e\d{1,6}$/.test(refs.passRef)) return { ok: false, url, error: 'Name the fields by their references from browser_snapshot.' };
  const probe = (await within(c.run(signInProbeScript(refs, !native)), 5_000)) as { error?: string; origin?: string; user?: Rect; pass?: Rect; submit?: Rect | null; vw?: number } | null;
  if (!probe || probe.error) return { ok: false, url, error: String(probe?.error ?? 'The page did not answer.').slice(0, 300) };
  if (probe.origin !== origin) return { ok: false, url, error: 'The page moved to another site. Take a new browser_snapshot.' };

  // The bridge answers off while sign-ins do not ship (services/sign-ins.ts): then no card ever opens.
  let state: { canSave: boolean };
  try {
    state = await signInState();
  } catch {
    return { ok: false, url, error: 'sign-ins are not available in this version of Sable.' };
  }
  const saved = await listSignIns(origin).catch(() => []);
  const here = () => signInAllowed(c.url() || getPage(tab).url) === origin && controllers.get(tab) === c;
  const alive = { cancelled: () => !here() };
  // The card and the line are the Browser tab's: it comes to the front for them.
  useStore.getState().setUi({ railOpen: true, railTab: 'browser' });
  let choice: SignInChoice = saved.length === 1 ? await askSignIn({ tabId: tab, origin, mode: 'auto', saved, canSave: state.canSave }, alive) : { kind: 'notNow' };
  if (choice.kind === 'notNow') choice = await askSignIn({ tabId: tab, origin, mode: 'card', saved: saved.length > 1 ? saved : [], canSave: state.canSave }, alive);
  if (choice.kind === 'cancel' || choice.kind === 'notNow') return { ok: false, url, error: here() ? 'the user cancelled the sign-in.' : 'the page moved on before the sign-in.' };

  let username = choice.username;
  let password = '';
  if (choice.kind === 'saved') {
    // Fetched only now, for exactly this origin, and only into this function.
    if (!here()) return { ok: false, url, error: 'the page moved on before the sign-in.' };
    try {
      password = (await revealSignIn(choice.id, origin)).password;
    } catch {
      return { ok: false, url, error: 'the saved sign-in cannot be read on this computer. The user can sign in again.' };
    }
  } else password = choice.password;

  // Watch it: the pointer goes to each field and the submit control, then the form is filled and sent at once.
  if (c.point && probe.vw) {
    for (const r of [probe.user, probe.pass, probe.submit]) {
      if (!r) continue;
      await c.point(r, probe.vw);
      await c.press?.();
    }
  }
  if (!here()) return { ok: false, url, error: 'the page moved on before the sign-in.' };
  const before = c.url() || getPage(tab).url;
  let filled: { ok?: boolean; error?: string } | null;
  try {
    filled = (await within(c.run(signInFillScript(refs, origin, username, password, !native)), 5_000)) as typeof filled;
  } catch {
    filled = null;
  }
  // Nothing of it is kept here past the fill (and it never went anywhere but the page).
  password = '';
  if (!filled?.ok) return { ok: false, url, error: filled?.error === 'moved' ? 'the page moved to another site before the sign-in.' : 'the sign-in form changed before it could be filled. Take a new browser_snapshot.' };
  setPage(tab, { filled: true });

  // Through: the page moved on, or the password field went away. Still there after a while: refused.
  const t0 = Date.now();
  let through = false;
  while (Date.now() - t0 < SIGN_IN_SETTLE_MS) {
    await sleep(250);
    const p = getPage(tab);
    if (p.loading || (c.url() || p.url).split('#')[0] !== before.split('#')[0]) {
      through = true;
      break;
    }
    const r = (await within(c.run(signInCheckScript), 2_000).catch(() => null)) as { gone?: boolean; cleared?: boolean } | null;
    if (r?.cleared) setPage(tab, { filled: undefined });
    if (r?.gone) {
      through = true;
      break;
    }
  }
  if (!through) return { ok: false, url, error: 'the page still shows the sign-in form; it may have refused the user name or password.' };
  if (choice.kind === 'typed' && choice.save && state.canSave) await saveSignIn(origin, username, choice.password).catch(() => {});
  if (choice.kind === 'saved') void markSignInUsed(choice.id);
  setPage(tab, { signedInAs: username });
  setTimeout(() => getPage(tab).signedInAs === username && setPage(tab, { signedInAs: undefined }), SIGNED_LINE_MS);
  const user = username;
  username = '';
  return { ok: true, url: c.url() || getPage(tab).url, title: getPage(tab).title, signedIn: true, user };
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
