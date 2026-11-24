/**
 * Work per interaction, measured headless (no window): fixed scenarios against the running dev
 * server, each read through the DevTools protocol and a trace.
 *
 *   node scripts/perf-headless.mjs [--label before] [--only idle-home,sweep-side] [--repeat 1]
 *
 * Per scenario: main-thread script, style, layout and task time and counts (Performance.getMetrics
 * deltas), and from a trace the busy time of every thread that draws (renderer main, compositor,
 * raster workers, the backdrop's worker, GPU), paint count and painted area, rAF and timer counts,
 * long tasks, and the layer count afterwards. Results go to scratch/speed/<label>.json and a table
 * is printed. Uses the installed Edge (or Chrome) through playwright-core, like shot.mjs.
 *
 * The sends (`send`, `send-home`) also time the flight itself, from the key to the landing (the
 * moment the last flight layer, `.send-bubble` or `.handoff-ghost`, leaves the page):
 * - `raf`: the main thread's frames in that span (a rAF probe): dropped frames (16.7 ms slots
 *   missed) and the longest frame;
 * - `cc`: the compositor's frames from the trace (`PipelineReporter`): presented in full, presented
 *   partially (the compositor moved on without the main thread: compositor animations still smooth),
 *   and dropped (nothing new on screen: what the eye sees as a stutter), with the longest gap
 *   between presented frames;
 * - main-thread long tasks inside the span.
 *
 *   --throttle 4   slows the page's CPU 4x (Emulation.setCPUThrottlingRate), a stand-in for a loaded laptop
 *   PERF_TRACE=1   also writes each scenario's raw trace to scratch/speed/<label>-<scenario>-<n>.trace.json
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const label = opt('label', 'run');
const only = opt('only', '')
  .split(',')
  .filter(Boolean);
const repeat = Number(opt('repeat', '1'));
const size = opt('size', '1440x900').split('x').map(Number);
const throttle = Number(opt('throttle', '1'));

async function findServer() {
  if (process.env.SABLE_URL) return process.env.SABLE_URL;
  // 127.0.0.1 first, as shot.mjs: the test server (scripts/dev-test.mjs, a throwaway profile) listens there only.
  for (const host of ['127.0.0.1', 'localhost'])
    for (const port of [5173, 5174]) {
      try {
        const res = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(1500) });
        if (res.ok && (await res.text()).includes('<title>Sable</title>')) return `http://${host}:${port}/`;
      } catch {
        /* not this one */
      }
    }
  throw new Error('No Sable dev server on 5173/5174.');
}

const CATEGORIES = [
  'toplevel',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'gpu',
  'viz',
  ...(process.env.PERF_DETAIL ? ['disabled-by-default-devtools.timeline.stack'] : []),
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── trace analysis ──

function analyse(events) {
  const procName = new Map();
  const threadName = new Map();
  for (const e of events) {
    if (e.ph !== 'M') continue;
    if (e.name === 'process_name') procName.set(e.pid, e.args.name);
    if (e.name === 'thread_name') threadName.set(`${e.pid}:${e.tid}`, e.args.name);
  }
  // The page's renderer: the process whose main thread ran FireAnimationFrame / Layout / our scripts.
  const kind = (pid, tid) => {
    const t = threadName.get(`${pid}:${tid}`) ?? '';
    const p = procName.get(pid) ?? '';
    if (p === 'Renderer') {
      if (t === 'CrRendererMain') return 'main';
      if (t === 'Compositor') return 'compositor';
      if (t.startsWith('CompositorTileWorker')) return 'raster';
      if (t.startsWith('DedicatedWorker')) return 'worker';
      return 'renderer-other';
    }
    if (p === 'GPU Process') {
      if (t === 'CrGpuMain') return 'gpu';
      if (t === 'VizCompositorThread') return 'viz';
      return 'gpu-other';
    }
    if (p === 'Browser') return 'browser';
    return 'other';
  };

  // Busy time per thread kind: the union of top-level task intervals.
  const intervals = new Map();
  const out = {
    styleN: 0,
    styleMs: 0,
    layoutN: 0,
    layoutMs: 0,
    paintN: 0,
    paintMs: 0,
    paintArea: 0,
    prePaintMs: 0,
    layerizeMs: 0,
    commitN: 0,
    rafReq: 0,
    rafFire: 0,
    timerInstall: 0,
    timerFire: 0,
    rasterN: 0,
    rasterMs: 0,
    gpuTaskMs: 0,
    longTasks: 0,
    eventN: 0,
    frames: 0,
  };
  for (const e of events) {
    if (e.ph === 'M') continue;
    const k = kind(e.pid, e.tid);
    const dur = (e.dur ?? 0) / 1000;
    if (e.ph === 'X' && (e.name === 'ThreadControllerImpl::RunTask' || e.name === 'RunTask' || e.name === 'ThreadPool_RunTask')) {
      if (!intervals.has(k)) intervals.set(k, []);
      intervals.get(k).push([e.ts, e.ts + e.dur]);
      if (k === 'main' && dur > 50) out.longTasks++;
    }
    if (k === 'main' && process.env.PERF_DETAIL && e.ph === 'X') {
      const key =
        e.name === 'FunctionCall'
          ? `fn ${e.args?.data?.functionName || '?'} ${String(e.args?.data?.url ?? '').split('/').pop()}:${e.args?.data?.lineNumber ?? ''}`
          : e.name === 'TimeStamp'
            ? `ts ${e.args?.data?.message ?? e.args?.data?.name ?? '?'}`
            : e.name === 'EventDispatch'
            ? `event ${e.args?.data?.type}`
            : e.name === 'TimerFire'
              ? `timer ${e.args?.data?.timerId}`
              : e.name;
      const d0 = (out.detail ??= {});
      const slot = (d0[key] ??= [0, 0]);
      slot[0]++;
      slot[1] += dur;
      // Forced (synchronous) style and layout: who asked.
      const st = e.args?.beginData?.stackTrace ?? e.args?.data?.stackTrace;
      if ((e.name === 'Layout' || e.name === 'UpdateLayoutTree') && st?.length) {
        const f = st[0];
        const k2 = `forced ${e.name === 'Layout' ? 'layout' : 'style'} ${f.functionName || '?'} ${String(f.url).split('/').pop().split('?')[0]}:${f.lineNumber}`;
        const s2 = (d0[k2] ??= [0, 0]);
        s2[0]++;
        s2[1] += dur;
      }
    }
    if (k === 'main') {
      switch (e.name) {
        case 'UpdateLayoutTree':
          if (e.ph === 'X') {
            out.styleN++;
            out.styleMs += dur;
            const n = e.args?.elementCount ?? 0;
            out.styleEls = (out.styleEls ?? 0) + n;
            out.styleMax = Math.max(out.styleMax ?? 0, n);
          }
          break;
        case 'Layout':
          if (e.ph === 'X') (out.layoutN++, (out.layoutMs += dur));
          break;
        case 'Paint': {
          if (e.ph !== 'X') break;
          out.paintN++;
          out.paintMs += dur;
          const q = e.args?.data?.clip;
          if (q && q.length >= 8) {
            // Clip to the viewport: a layer's paint can report an unbounded clip.
            const xs = [q[0], q[2], q[4], q[6]].map((v) => Math.max(0, Math.min(size[0], v)));
            const ys = [q[1], q[3], q[5], q[7]].map((v) => Math.max(0, Math.min(size[1], v)));
            const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
            out.paintArea += area;
            if (process.env.PERF_DETAIL) {
              const pn = (out.paintNodes ??= {});
              const id = e.args.data.nodeId ?? 0;
              const s = (pn[id] ??= [0, 0, 0, `${Math.round(Math.max(...xs) - Math.min(...xs))}x${Math.round(Math.max(...ys) - Math.min(...ys))}`]);
              s[0]++;
              s[1] += area;
              s[2] += dur;
            }
          }
          break;
        }
        case 'PrePaint':
          if (e.ph === 'X') out.prePaintMs += dur;
          break;
        case 'Layerize':
          if (e.ph === 'X') out.layerizeMs += dur;
          break;
        case 'Commit':
          if (e.ph === 'X') out.commitN++;
          break;
        case 'RequestAnimationFrame':
          out.rafReq++;
          break;
        case 'FireAnimationFrame':
          if (e.ph === 'X') out.rafFire++;
          break;
        case 'TimerInstall':
          out.timerInstall++;
          break;
        case 'TimerFire':
          if (e.ph === 'X') out.timerFire++;
          break;
        case 'EventDispatch':
          if (e.ph === 'X') out.eventN++;
          break;
        case 'BeginMainThreadFrame':
          out.frames++;
          break;
      }
    }
    if (e.name === 'RasterTask' && e.ph === 'X') (out.rasterN++, (out.rasterMs += dur));
    if (e.name === 'GPUTask' && e.ph === 'X') out.gpuTaskMs += dur;
    // Headless presents with a swap that can block for seconds at random (no display to pace it):
    // a wait, not work. Kept apart so the GPU's busy time below means drawing.
    if (k === 'gpu' && e.ph === 'X' && e.name === 'SkiaOutputSurfaceImplOnGpu::SwapBuffers') out.swapMs = (out.swapMs ?? 0) + dur;
  }
  const busy = {};
  for (const [k, list] of intervals) {
    list.sort((a, b) => a[0] - b[0]);
    let total = 0;
    let s = -1;
    let end = -1;
    for (const [a, b] of list) {
      if (a > end) {
        if (end > s) total += end - s;
        s = a;
        end = b;
      } else if (b > end) end = b;
    }
    if (end > s) total += end - s;
    busy[k] = total / 1000;
  }
  if (busy.gpu !== undefined && out.swapMs) busy.gpu = Math.max(0, busy.gpu - out.swapMs);
  out.busy = busy;
  return out;
}

/**
 * The compositor's frames between the trace marks `sable:send` and `sable:land` (set by the flight
 * probe in measure()): PipelineReporter states, DrawFrame gaps, and main-thread long tasks.
 */
function flightFrames(events, from = 'sable:send', to = 'sable:land') {
  const mark = (m) => events.find((e) => e.name === 'TimeStamp' && (e.args?.data?.message === m || e.args?.data?.name === m));
  const s = mark(from);
  if (!s) return { cc: null };
  const l = mark(to);
  const t0 = s.ts;
  const t1 = l ? l.ts : t0 + 1_200_000;
  // The page's renderer and its threads.
  const pid = s.pid;
  const mainTid = s.tid;
  // Per frame sequence the best outcome among its reporters (a frame can have a forked reporter
  // for main-thread work that lands later).
  const RANK = { STATE_DROPPED: 1, STATE_PRESENTED_PARTIAL: 2, STATE_PRESENTED_ALL: 3 };
  const bySeq = new Map();
  for (const e of events) {
    if (e.name !== 'PipelineReporter' || (e.ph !== 'b' && e.ph !== 'X') || e.pid !== pid) continue;
    const fr = e.args?.frame_reporter ?? e.args?.chrome_frame_reporter;
    if (!fr?.state || !RANK[fr.state] || e.ts < t0 || e.ts > t1) continue;
    const prev = bySeq.get(fr.frame_sequence);
    if (!prev || RANK[fr.state] > RANK[prev.state]) bySeq.set(fr.frame_sequence, { state: fr.state, ts: e.ts });
  }
  const states = {};
  const presented = [];
  for (const v of bySeq.values()) {
    states[v.state] = (states[v.state] ?? 0) + 1;
    if (v.state !== 'STATE_DROPPED') presented.push(v.ts);
  }
  let draws = events.filter((e) => e.name === 'DrawFrame' && e.pid === pid && e.ts >= t0 && e.ts <= t1).map((e) => e.ts);
  if (!draws.length) draws = events.filter((e) => e.name === 'DrawFrame' && e.ts >= t0 && e.ts <= t1).map((e) => e.ts);
  const gap = (list) => {
    list.sort((a, b) => a - b);
    let worst = 0;
    for (let i = 1; i < list.length; i++) worst = Math.max(worst, list[i] - list[i - 1]);
    return Math.round(worst / 1000);
  };
  let long = 0;
  let longMs = 0;
  let maxTask = 0;
  const spans = [];
  for (const e of events) {
    if (e.ph !== 'X' || e.pid !== pid || e.tid !== mainTid) continue;
    if (e.name !== 'ThreadControllerImpl::RunTask' && e.name !== 'RunTask') continue;
    const a = Math.max(e.ts, t0);
    const b = Math.min(e.ts + e.dur, t1);
    if (b <= a) continue;
    spans.push([a, b]);
    maxTask = Math.max(maxTask, e.dur / 1000);
    if (e.dur > 50_000) (long++, (longMs += e.dur / 1000));
  }
  // Busy: the union of the tasks (they nest).
  spans.sort((x, y) => x[0] - y[0]);
  let busy = 0;
  let cs = -1;
  let ce = -1;
  for (const [a, b] of spans) {
    if (a > ce) {
      if (ce > cs) busy += ce - cs;
      cs = a;
      ce = b;
    } else if (b > ce) ce = b;
  }
  if (ce > cs) busy += ce - cs;
  return {
    span: Math.round((t1 - t0) / 1000),
    cc: {
      all: states.STATE_PRESENTED_ALL ?? 0,
      partial: states.STATE_PRESENTED_PARTIAL ?? 0,
      dropped: states.STATE_DROPPED ?? 0,
      gap: gap(presented),
    },
    draws: draws.length,
    drawGap: gap(draws),
    mainBusy: Math.round(busy / 1000),
    long,
    longMs: Math.round(longMs),
    maxTask: Math.round(maxTask),
  };
}

/**
 * PERF_PROFILE=1: a sampled JS profile of the run, limited to the flight (between the trace marks
 * `sable:send` and `sable:land`) when there is one: self time per file, and the time inside each
 * of the app's own functions (inclusive: its hooks and what it calls, not the children React renders).
 */
function profileSummary(p, events) {
  const mark = (m) => events.find((e) => e.name === 'TimeStamp' && (e.args?.data?.message === m || e.args?.data?.name === m));
  const s = mark('sable:send');
  const l = mark('sable:land');
  const from = s ? s.ts : -Infinity;
  const to = l ? l.ts : s ? s.ts + 8_000_000 : Infinity;
  const nodes = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const file = (n) => String(n.callFrame.url).split('?')[0].split('/').slice(-2).join('/') || `(${n.callFrame.functionName || 'program'})`;
  const self = {};
  const incl = {};
  let t = p.startTime;
  let total = 0;
  for (let i = 0; i < p.samples.length; i++) {
    t += p.timeDeltas[i];
    if (t < from || t > to) continue;
    const dt = (p.timeDeltas[i + 1] ?? 0) / 1000;
    const n = nodes.get(p.samples[i]);
    if (!n || n.callFrame.functionName === '(idle)') continue;
    total += dt;
    const k = file(n);
    self[k] = (self[k] ?? 0) + dt;
    const seen = new Set();
    for (let id = n.id; id != null; id = parent.get(id)) {
      const f = nodes.get(id).callFrame;
      if (!/\/src\//.test(f.url) || !f.functionName) continue;
      const key = `${f.functionName} ${f.url.split('?')[0].split('/').pop()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      incl[key] = (incl[key] ?? 0) + dt;
    }
  }
  const top = (o, n) =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${k} ${v.toFixed(0)}`)
      .join(', ');
  console.log(`    profile ${total.toFixed(0)}ms${s ? ' (flight)' : ''}`);
  console.log(`    self by file: ${top(self, 18)}`);
  console.log(`    app functions: ${top(incl, 30)}`);
}

// ── harness ──

const url = await findServer();
const candidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const exe = candidates.find((p) => existsSync(p));
const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : { channel: 'chrome' }) });
const context = await browser.newContext({ viewport: { width: size[0], height: size[1] }, colorScheme: 'dark' });
// A production build exposes the `sable` helpers only to a debug desktop shell: stand one in
// (with page-drawn window controls, as on Windows). Its home agent is Demo, so nothing prewarms.
await context.addInitScript(() => {
  try {
    const ui = JSON.parse(localStorage.getItem('sable.ui.v1') ?? '{}');
    localStorage.setItem('sable.ui.v1', JSON.stringify({ ...ui, homeProvider: 'demo' }));
  } catch {
    /* ignore */
  }
  if (location.port === '5173' || location.port === '5174') return;
  window.sableDesktop = {
    platform: 'win32',
    version: '0.1.0',
    debug: true,
    window: { minimize() {}, toggleMaximize() {}, close() {}, getState: async () => ({ maximized: false, focused: true, fullScreen: false }), onState: () => () => {} },
  };
});
// PERF_RENDERS=1: count React component renders per commit through the devtools hook
// (a fiber with the PerformedWork flag ran its component this commit). Dev server for names.
if (process.env.PERF_RENDERS)
  await context.addInitScript(() => {
    window.__renders = {};
    const nameOf = (f) => {
      const t = f.type;
      if (!t || typeof t === 'string') return null;
      return t.displayName || t.name || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name || null;
    };
    // Skipped subtrees keep stale flags from their last render, so a fiber counts only when it also
    // started work after the previous commit (dev builds time every unit of work).
    let since = 0;
    // Per commit: the time each component took to render itself (selfBaseDuration), for the flight's
    // commit log (window.__commits: when, total ms, the costliest components).
    window.__commits = [];
    let cost = {};
    const walk = (f) => {
      while (f) {
        if (f.flags & 1 && (f.actualStartTime ?? Infinity) > since) {
          const n = nameOf(f);
          if (n) window.__renders[n] = (window.__renders[n] ?? 0) + 1;
          const k = n ?? (typeof f.type === 'string' ? 'host' : 'other');
          cost[k] = (cost[k] ?? 0) + (f.selfBaseDuration ?? 0);
        }
        if (f.child) walk(f.child);
        f = f.sibling;
      }
    };
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject() {
        return 1;
      },
      onCommitFiberRoot(_id, root) {
        cost = {};
        try {
          walk(root.current.child);
        } catch {
          /* ignore */
        }
        const F = window.__flight;
        if (F?.t0 && !F.land) {
          const all = Object.values(cost).reduce((a, b) => a + b, 0);
          const top = Object.entries(cost)
            .sort((a, b) => b[1] - a[1])
            .slice(0, all > 40 ? 40 : 6)
            .map(([k, v]) => `${k} ${v.toFixed(1)}`)
            .join(', ');
          window.__commits.push(`@${Math.round(performance.now() - F.t0)} ${all.toFixed(1)}ms: ${top}`);
        }
        since = performance.now();
      },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      checkDCE() {},
    };
  });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable', { timeDomain: 'threadTicks' });
let traceN = 0;
mkdirSync(path.resolve('scratch/speed'), { recursive: true });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 200)}`));

async function metrics() {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

async function layerCount() {
  const got = new Promise((resolve) => {
    const on = (e) => {
      if (!e.layers) return;
      cdp.off('LayerTree.layerTreeDidChange', on);
      resolve(e.layers);
    };
    cdp.on('LayerTree.layerTreeDidChange', on);
  });
  await cdp.send('LayerTree.enable');
  // A frame has to be produced for the tree to be reported.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const layers = await Promise.race([got, sleep(3000).then(() => null)]);
  await cdp.send('LayerTree.disable');
  if (!layers) return { layers: -1, drawn: -1, area: 0 };
  const drawn = layers.filter((l) => l.drawsContent);
  if (process.env.PERF_LAYERS) {
    await cdp.send('DOM.getDocument', { depth: 0 });
    const names = [];
    for (const l of layers) {
      let who = l.backendNodeId ? '?' : '-';
      if (l.backendNodeId)
        try {
          const { node } = await cdp.send('DOM.describeNode', { backendNodeId: l.backendNodeId });
          const cls = (node.attributes ?? []).reduce((acc, v, i, arr) => (v === 'class' ? arr[i + 1] : acc), '');
          who = `${node.localName || node.nodeName}.${cls.split(' ').slice(0, 2).join('.')}`;
        } catch {
          /* gone */
        }
      names.push(`${who}${l.drawsContent ? '' : '(empty)'} ${Math.round(l.width)}x${Math.round(l.height)}`);
    }
    console.log(`    layers: ${names.join(' | ')}`);
  }
  return { layers: layers.length, drawn: drawn.length, area: Math.round(drawn.reduce((s, l) => s + l.width * l.height, 0) / 1000) };
}

async function measure(name, run) {
  // In-page: long animation frames and running CSS / Web animations.
  await page.evaluate(() => {
    window.__loaf = [];
    window.__loafObs?.disconnect();
    try {
      window.__loafObs = new PerformanceObserver((l) =>
        window.__loaf.push(
          ...l.getEntries().map((e) => {
            const d = e.duration;
            const s = new Number(d);
            // Where the frame went: scripts (by invoker), then rendering (style/layout, paint).
            s.at = e.startTime;
            s.info = `${Math.round(d)}ms: render ${Math.round(e.startTime + d - (e.renderStart || e.startTime + d))} style+layout ${Math.round(e.startTime + d - (e.styleAndLayoutStart || e.startTime + d))} | ${(e.scripts ?? [])
              .map((x) => `${x.invoker || x.name} ${Math.round(x.duration)}ms (fsl ${Math.round(x.forcedStyleAndLayoutDuration)})`)
              .join(', ')}`;
            return s;
          }),
        ),
      );
      window.__loafObs.observe({ type: 'long-animation-frame', buffered: false });
    } catch {
      /* unsupported */
    }
    // The flight probe: from Enter to the moment no flight layer is left. A rAF loop records the
    // main thread's frames; trace marks bound the span for the compositor's frames.
    window.__flightMo?.disconnect();
    if (window.__flightKey) window.removeEventListener('keydown', window.__flightKey, true);
    const F = (window.__flight = { t0: 0, land: 0, seen: 0, frames: [], log: [] });
    const LAYERS = '.send-bubble, .handoff-ghost';
    window.__flightKey = (e) => {
      if (e.key !== 'Enter' || F.t0) return;
      F.t0 = performance.now();
      if (window.__renders) F.r0 = { ...window.__renders };
      console.timeStamp('sable:send');
      const loop = (t) => {
        F.frames.push(t);
        if (t - F.t0 < 2500 && !F.land) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    };
    window.addEventListener('keydown', window.__flightKey, true);
    window.__flightMo = new MutationObserver((recs) => {
      for (const r of recs) {
        for (const n of r.addedNodes) if (n.nodeType === 1 && n.matches(LAYERS)) (F.seen++, F.log.push(`+${n.className.split(' ').pop()}@${Math.round(performance.now() - F.t0)}`));
        for (const n of r.removedNodes) if (n.nodeType === 1 && n.matches(LAYERS)) F.log.push(`-${n.className.split(' ').pop()}@${Math.round(performance.now() - F.t0)}`);
      }
      if (F.seen && !F.land && !document.querySelector(LAYERS)) {
        F.land = performance.now();
        if (window.__renders) F.r1 = { ...window.__renders };
        console.timeStamp('sable:land');
      }
    });
    window.__flightMo.observe(document.body, { childList: true });
  });
  await page.evaluate(() => ((window.__renders = {}), (window.__commits = [])));
  const m0 = await metrics();
  if (process.env.PERF_PROFILE) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');
  }
  await browser.startTracing(page, { categories: CATEGORIES });
  const t0 = Date.now();
  await run();
  const wall = Date.now() - t0;
  const buf = await browser.stopTracing();
  const prof = process.env.PERF_PROFILE ? (await cdp.send('Profiler.stop')).profile : null;
  const m1 = await metrics();
  const trace = JSON.parse(buf.toString());
  if (process.env.PERF_TRACE) writeFileSync(path.resolve(`scratch/speed/${label}-${name}-${++traceN}.trace.json`), buf);
  if (prof) profileSummary(prof, trace.traceEvents ?? trace);
  if (prof && process.env.PERF_TRACE) writeFileSync(path.resolve(`scratch/speed/${label}-${name}-${traceN}.cpuprofile`), JSON.stringify(prof));
  const a = analyse(trace.traceEvents ?? trace);
  const flight = await page.evaluate(() => {
    const F = window.__flight;
    window.__flightMo?.disconnect();
    if (!F?.t0) return null;
    const end = F.land || F.t0 + 1200;
    const fr = F.frames.filter((t) => t <= end + 17);
    let dropped = 0;
    let worst = 0;
    for (let i = 1; i < fr.length; i++) {
      const dt = fr[i] - fr[i - 1];
      worst = Math.max(worst, dt);
      dropped += Math.max(0, Math.round(dt / 16.667) - 1);
    }
    // Renders between the key and the landing (PERF_RENDERS).
    const r1 = F.r1 ?? window.__renders;
    const renders = F.r0 && r1 ? Object.entries(r1).map(([k, v]) => [k, v - (F.r0[k] ?? 0)]).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).slice(0, 40).map(([k, v]) => `${k} ${v}`).join(', ') : undefined;
    // The first frame after the key: how long the press waited for anything to draw.
    return {
      log: F.log.join(' '),
      renders, ms: Math.round(end - F.t0), landed: !!F.land, frames: fr.length, dropped, worst: Math.round(worst), first: fr.length ? Math.round(fr[0] - F.t0) : -1 };
  });
  if (flight) Object.assign(flight, flightFrames(trace.traceEvents ?? trace));
  // A span the scenario marked itself (the scroll and work scenarios): frames, long tasks, long animation frames.
  const span = flightFrames(trace.traceEvents ?? trace, 'sable:span0', 'sable:span1');
  if (span.cc)
    span.loaf = await page.evaluate(() => {
      const l = window.__loaf.filter((x) => x.at >= (window.__span0 ?? 0) && x.at <= (window.__span1 ?? Infinity));
      return { n: l.length, ms: Math.round(l.reduce((s, d) => s + Number(d), 0)), worst: Math.round(Math.max(0, ...l.map(Number))) };
    });
  const page2 = await page.evaluate(() => {
    const anims = document.getAnimations().filter((x) => x.playState === 'running');
    const who = anims.slice(0, 6).map((x) => {
      const t = x.effect?.target;
      return t ? `${t.tagName.toLowerCase()}.${String(t.className?.baseVal ?? t.className).split(' ').slice(0, 2).join('.')}` : '?';
    });
    const field = document.querySelector('.dither');
    return {
      loaf: window.__loaf.length,
      loafMs: Math.round(window.__loaf.reduce((s, d) => s + d, 0)),
      anims: anims.length,
      who,
      focus: document.hasFocus(),
      loafInfo: window.__loaf.map((x) => x.info),
      field: field ? `${field.dataset.thread}/${field.dataset.ms ?? '-'}ms/q${document.documentElement.dataset.quality ?? 0}` : 'none',
    };
  });
  if (process.env.PERF_DETAIL) for (const l of page2.loafInfo.slice(0, 8)) console.log(`    loaf ${l}`);
  delete page2.loafInfo;
  if (process.env.PERF_RENDERS) {
    const commits = await page.evaluate(() => window.__commits ?? []);
    for (const c of commits.filter((x) => parseFloat(x.split(' ')[1]) >= Number(process.env.PERF_COMMIT_MIN ?? 2))) console.log(`    commit ${c}`);
    const r = await page.evaluate(() => window.__renders);
    const top = Object.entries(r ?? {})
      .sort((x, y) => y[1] - x[1])
      .slice(0, 30);
    console.log(`    renders: ${top.map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  if (a.paintNodes) {
    await cdp.send('DOM.getDocument', { depth: 0 });
    const top = Object.entries(a.paintNodes)
      .sort((x, y) => y[1][1] - x[1][1])
      .slice(0, 10);
    for (const [id, s] of top) {
      let who = '?';
      try {
        const { node } = await cdp.send('DOM.describeNode', { backendNodeId: Number(id) });
        const cls = (node.attributes ?? []).reduce((acc, v, i, arr) => (v === 'class' ? arr[i + 1] : acc), '');
        who = `${node.localName || node.nodeName}.${cls.split(' ').slice(0, 3).join('.')}`;
      } catch {
        /* gone */
      }
      console.log(`    paint ${who.padEnd(50)} n=${s[0]} area=${(s[1] / 1e6).toFixed(1)}Mpx ${s[2].toFixed(1)}ms last ${s[3]}`);
    }
  }
  const L = await layerCount();
  const d = (k) => (m1[k] ?? 0) - (m0[k] ?? 0);
  return {
    name,
    wall,
    scriptMs: +(d('ScriptDuration') * 1000).toFixed(1),
    styleMs: +(d('RecalcStyleDuration') * 1000).toFixed(1),
    styleN: d('RecalcStyleCount'),
    layoutMs: +(d('LayoutDuration') * 1000).toFixed(1),
    layoutN: d('LayoutCount'),
    taskMs: +(d('TaskDuration') * 1000).toFixed(1),
    flight,
    span: span.cc ? span : undefined,
    trace: a,
    ...page2,
    ...L,
  };
}

const ev = (js, arg) => page.evaluate(js, arg);

async function waitIdle(id, timeout = 60_000) {
  await page.waitForFunction((sid) => window.sable?.store.getState().sessions[sid]?.status === 'idle', id, { timeout, polling: 250 });
}

async function sweep(from, to, steps = 60, gap = 16) {
  await page.mouse.move(from[0], from[1]);
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    await page.mouse.move(from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k);
    await sleep(gap);
  }
}

/** A slow landing (a loaded machine) stays inside the trace: wait for it, up to 8 s after the key. */
async function landed() {
  await page.waitForFunction(() => !window.__flight?.t0 || window.__flight.land || performance.now() - window.__flight.t0 > 8000, null, { timeout: 9000, polling: 50 }).catch(() => {});
  await sleep(100);
}

async function box(sel) {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error(`no box for ${sel}`);
  return b;
}

let finishedId = null;
let longId = null;

async function home() {
  await page.waitForFunction(() => window.sable?.store.getState().ready, null, { timeout: 30_000 });
  await ev(() => window.sable.actions.goHome());
  await page.mouse.move(size[0] - 4, size[1] - 4);
  await sleep(1500);
}

async function finishedSession() {
  if (!finishedId) {
    finishedId = await ev(() => window.sable.demo('hi', { mode: 'bypassPermissions' }));
    await waitIdle(finishedId);
  } else await ev((id) => window.sable.actions.openSession(id), finishedId);
  await ev(() => window.sable.store.getState().setUi({ railOpen: false }));
  await page.mouse.move(size[0] / 2, size[1] - 40);
  await sleep(1500);
}

// ── the conversation: scrolling and a working turn ──

/** Marks the span the frame figures cover (`r.span`): from the first input to the last. */
const span0 = () => ev(() => ((window.__span0 = performance.now()), console.timeStamp('sable:span0')));
const span1 = () => ev(() => ((window.__span1 = performance.now()), console.timeStamp('sable:span1')));

/** A trackpad flick: a wheel event every 8 ms, fast at first and decaying like momentum. dir -1 up, 1 down. */
async function flick(dir, v0 = 70, n = 70) {
  let v = v0;
  for (let i = 0; i < n; i++) {
    await page.mouse.wheel(0, dir * Math.max(2, Math.round(v)));
    v *= 0.955;
    await sleep(8);
  }
}

/** Mouse wheel notches, 100 px each, about 20 a second. */
async function notches(dir, n = 20) {
  for (let i = 0; i < n; i++) {
    await page.mouse.wheel(0, dir * 100);
    await sleep(45);
  }
}

/** The reading pattern of the scroll scenarios: flicks up through history, notches back and forth, flicks down. */
async function readBack() {
  await span0();
  for (let i = 0; i < 3; i++) (await flick(-1), await sleep(120));
  await notches(-1, 16);
  await notches(1, 16);
  await sleep(120);
  for (let i = 0; i < 2; i++) (await flick(1), await sleep(120));
  await span1();
  await sleep(300);
}

let convoId = null;

/** The page is up (a reload by the dev server, when another file changes, drops `sable` for a moment). */
async function ready() {
  await page.waitForFunction(() => window.sable?.store.getState().ready, null, { timeout: 30_000 });
}

/**
 * A long conversation: four Demo turns (edits and diffs, markdown with code and tables, a table,
 * a web search), then their items copied in front until there are about `PERF_TURNS` (36) turns.
 * The copies live in this page's store only (the bridge never hears of them): made again after a reload.
 */
async function longConversation() {
  await ready();
  if (!convoId) {
    const id = await ev(() => window.sable.demo('refactor the session module', { mode: 'bypassPermissions' }));
    await waitIdle(id, 240_000);
    for (const text of ['markdown showcase', 'a table of the endpoints', 'search the docs for retry headers']) {
      await ev(([sid, t]) => window.sable.actions.sendMessage(sid, t), [id, text]);
      await sleep(800);
      await waitIdle(id, 240_000);
    }
    convoId = id;
  }
  await ev(() => window.sable.actions.goHome());
  await sleep(400);
  await ev((id) => window.sable.actions.openSession(id), convoId);
  await page.waitForFunction((id) => window.sable.store.getState().data[id]?.loaded, convoId, { timeout: 30_000 });
  const cloned = await ev((id) => window.sable.store.getState().data[id].roots.some((r) => r.includes('~')), convoId);
  if (!cloned) {
    const turns = Number(process.env.PERF_TURNS ?? 36);
    await ev(
      ([sid, copies]) => {
        const st = window.sable.store.getState();
        const d = st.data[sid];
        const items = {};
        const children = {};
        const roots = [];
        for (let k = copies; k >= 1; k--) {
          const re = (x) => `${x}~${k}`;
          for (const [key, it] of Object.entries(d.items)) {
            const c = { ...it, id: re(key), ts: it.ts - k * 3_600_000 };
            if (it.parentId) c.parentId = re(it.parentId);
            if ('endedAt' in it && it.endedAt) c.endedAt = it.endedAt - k * 3_600_000;
            items[c.id] = c;
          }
          for (const [key, list] of Object.entries(d.children)) children[re(key)] = list.map(re);
          roots.push(...d.roots.map(re));
        }
        window.sable.store.setState({
          data: { ...st.data, [sid]: { ...d, items: { ...items, ...d.items }, children: { ...children, ...d.children }, roots: [...roots, ...d.roots] } },
        });
        // Opened afresh, as a long transcript is: away and back.
        window.sable.actions.goHome();
      },
      [convoId, Math.max(0, Math.ceil(turns / 4) - 1)],
    );
    await sleep(600);
    await ev((sid) => window.sable.actions.openSession(sid), convoId);
  }
  await ev(() => window.sable.store.getState().setUi({ railOpen: false }));
  await sleep(1500);
  const b = await box('.tl-scroll');
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * 0.55);
  await ev(() => {
    const el = document.querySelector('.tl-scroll');
    el.scrollTop = el.scrollHeight;
  });
  await sleep(800);
  return convoId;
}

const SCENARIOS = {
  'idle-home': async () => {
    await home();
    return measure('idle-home', () => sleep(10_000));
  },
  'idle-session': async () => {
    await finishedSession();
    return measure('idle-session', () => sleep(10_000));
  },
  // At rest: the same, after the field has eased to its still frame (20 s without input or a turn).
  'rest-home': async () => {
    await home();
    await page.mouse.move(size[0] / 2, size[1] - 4);
    await sleep(22_000);
    return measure('rest-home', () => sleep(10_000));
  },
  'rest-session': async () => {
    await finishedSession();
    await page.mouse.move(size[0] / 2, size[1] - 4);
    await sleep(22_000);
    return measure('rest-session', () => sleep(10_000));
  },
  'sweep-side': async () => {
    await home();
    const b = await box('.side-list');
    return measure('sweep-side', () => sweep([b.x + b.width / 2, b.y + 10], [b.x + b.width / 2, b.y + Math.min(b.height, 600) - 10]));
  },
  'sweep-stage': async () => {
    await finishedSession();
    await ev(() => window.sable.store.getState().setUi({ railOpen: true, railTab: 'files' }));
    await sleep(900);
    return measure('sweep-stage', () => sweep([300, size[1] * 0.45], [size[0] - 20, size[1] * 0.55], 80));
  },
  'sweep-composer': async () => {
    await finishedSession();
    const b = await box('.cmp-card');
    return measure('sweep-composer', () => sweep([b.x + 10, b.y + b.height / 2], [b.x + b.width - 10, b.y + b.height / 2], 60));
  },
  // One session's shown fields change (as a status or activity event does): what re-renders.
  'touch-session': async () => {
    await home();
    return measure('touch-session', async () => {
      for (let i = 0; i < 10; i++) {
        await ev((n) => {
          const st = window.sable.store.getState();
          const ids = Object.keys(st.sessions);
          const id = ids[ids.length - 1];
          window.sable.store.setState({ sessions: { ...st.sessions, [id]: { ...st.sessions[id], activity: `touch ${n}`, updatedAt: Date.now() } } });
        }, i);
        await sleep(100);
      }
    });
  },
  'menu-model': async () => {
    await finishedSession();
    return measure('menu-model', async () => {
      for (let i = 0; i < 2; i++) {
        await page.click('button.ph');
        await sleep(400);
        await page.keyboard.press('Escape');
        await sleep(400);
      }
    });
  },
  'menu-effort': async () => {
    await finishedSession();
    return measure('menu-effort', async () => {
      for (let i = 0; i < 2; i++) {
        await page.click('button.ph');
        await sleep(400);
        await page.keyboard.press('Escape');
        await sleep(400);
      }
    });
  },
  settings: async () => {
    await finishedSession();
    return measure('settings', async () => {
      for (let i = 0; i < 2; i++) {
        await ev(() => window.sable.actions.openSettings());
        await sleep(700);
        await page.keyboard.press('Escape');
        await sleep(600);
      }
    });
  },
  // The command palette (mod+k) opened and closed twice in a finished session.
  palette: async () => {
    await finishedSession();
    await page.click('.composer[data-variant=session]:not(.handoff-ghost) textarea.cmp-input:not(.cmp-mirror)');
    await sleep(300);
    return measure('palette', async () => {
      for (let i = 0; i < 2; i++) {
        await page.keyboard.press('Control+K');
        await sleep(500);
        await page.keyboard.press('Escape');
        await sleep(500);
      }
    });
  },
  menus: async () => {
    await finishedSession();
    return measure('menus', async () => {
      await page.click('button.ph');
      await sleep(400);
      await page.keyboard.press('Escape');
      await sleep(400);
      await page.click('button.ph');
      await sleep(400);
      await page.keyboard.press('Escape');
      await sleep(400);
      await ev(() => window.sable.actions.openSettings());
      await sleep(700);
      await page.keyboard.press('Escape');
      await sleep(600);
    });
  },
  type: async () => {
    await finishedSession();
    await page.click('.composer textarea:not(.cmp-mirror)');
    await sleep(300);
    const r = await measure('type', () => page.keyboard.type('make the session expiry check run hourly', { delay: 35 }));
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    return r;
  },
  // A message sent in a finished Demo session: the flight of the words and the short turn.
  send: async () => {
    await finishedSession();
    const left = await ev(() => [...document.querySelectorAll('.handoff-ghost, .send-bubble')].map((g) => `${g.className} op ${getComputedStyle(g).opacity} anims ${g.getAnimations().map((a) => a.playState).join(',')}`));
    if (left.length) console.log('    left on the page:', left.join(' ; '));
    if (process.env.PERF_ERR)
      console.log(
        '    state:',
        await ev((id) => {
          const s = window.sable.store.getState();
          return JSON.stringify({ want: id, active: s.ui.activeSessionId, status: s.sessions[id]?.status, home: !!document.querySelector('.home'), dock: !!document.querySelector('.dock'), composers: [...document.querySelectorAll('.composer')].map((c) => `${c.className}/${c.dataset.variant}`) });
        }, finishedId),
      );
    await page.click('.composer[data-variant=session]:not(.handoff-ghost) textarea.cmp-input:not(.cmp-mirror)');
    await sleep(300);
    const r = await measure('send', async () => {
      await page.keyboard.type('hi');
      await page.keyboard.press('Enter');
      await sleep(3000);
      await landed();
    });
    await waitIdle(finishedId).catch(() => {});
    return r;
  },
  // The first message from home (the composer's glide to the dock). Demo only: refuses otherwise.
  'send-home': async () => {
    await home();
    await ev(() => {
      const s = window.sable.store.getState();
      s.setUi({ homeProvider: 'demo', homeCwd: s.ui.homeCwd ?? s.home, homeMode: { ...s.ui.homeMode, demo: 'bypassPermissions' } });
    });
    await sleep(300);
    const p = await ev(() => window.sable.actions.homeChoice()?.provider);
    if (p !== 'demo') throw new Error('send-home: the home agent is not Demo (' + p + ')');
    await page.click('.home-composer textarea.cmp-input:not(.cmp-mirror)');
    return measure('send-home', async () => {
      await page.keyboard.type('hi');
      await page.keyboard.press('Enter');
      await sleep(2500);
      await landed();
    });
  },
  // Six switches between two finished sessions, 400 ms apart.
  switch: async () => {
    await finishedSession();
    const other = await ev(() => window.sable.demo('hi', { mode: 'bypassPermissions' }));
    await waitIdle(other);
    await sleep(800);
    return measure('switch', async () => {
      for (let i = 0; i < 6; i++) {
        await ev((id) => window.sable.actions.openSession(id), i % 2 ? other : finishedId);
        await sleep(400);
      }
      await sleep(400);
    });
  },
  stream: async () => {
    await home();
    return measure('stream', async () => {
      longId = await ev(() => window.sable.demo('long', { mode: 'bypassPermissions' }));
      await sleep(8000);
    });
  },
  scroll: async () => {
    if (!longId) {
      longId = await ev(() => window.sable.demo('long', { mode: 'bypassPermissions' }));
    } else await ev((id) => window.sable.actions.openSession(id), longId);
    await waitIdle(longId, 120_000);
    await ev(() => window.sable.store.getState().setUi({ railOpen: false }));
    await sleep(1200);
    const b = await box('.tl-scroll');
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    return measure('scroll', async () => {
      for (let i = 0; i < 30; i++) (await page.mouse.wheel(0, -100), await sleep(16));
      for (let i = 0; i < 30; i++) (await page.mouse.wheel(0, 100), await sleep(16));
      await sleep(300);
    });
  },
  // Reading back through a long conversation (about 36 turns with diffs, code and tables), idle.
  'scroll-long': async () => {
    await longConversation();
    return measure('scroll-long', readBack);
  },
  // The same while a turn streams at the end of it (the reader is away from the end).
  'scroll-stream': async () => {
    const id = await longConversation();
    await ev((sid) => window.sable.actions.sendMessage(sid, 'refactor the session module'), id);
    await sleep(1500);
    const r = await measure('scroll-stream', readBack);
    await waitIdle(id, 240_000).catch(() => {});
    return r;
  },
  // One 4000-line answer: scrolling a single huge text.
  'scroll-tome': async () => {
    await home();
    const id = await ev(() => window.sable.demo('tome', { mode: 'bypassPermissions' }));
    await waitIdle(id, 240_000);
    await ev(() => window.sable.store.getState().setUi({ railOpen: false }));
    await sleep(1500);
    const b = await box('.tl-scroll');
    await page.mouse.move(b.x + b.width / 2, b.y + b.height * 0.55);
    return measure('scroll-tome', readBack);
  },
  // A working turn followed at the end: 300 quick steps (Demo marathon), the first 9 s.
  'work-marathon': async () => {
    await home();
    return measure('work-marathon', async () => {
      await span0();
      await ev(() => window.sable.demo('marathon', { mode: 'bypassPermissions' }));
      await sleep(9000);
      await span1();
    });
  },
  // A mixed working turn followed at the end (Demo refactor: thinking, reads, edits, a command, prose), 12 s.
  'work-refactor': async () => {
    await home();
    return measure('work-refactor', async () => {
      await span0();
      await ev(() => window.sable.demo('refactor the session module', { mode: 'bypassPermissions' }));
      await sleep(12000);
      await span1();
    });
  },
  // The side panel: three opens and closes, 700 ms apart, on Changes (or --rail-tab name).
  'rail-open': async () => {
    await finishedSession();
    await ev((tab) => window.sable.store.getState().setUi({ railTab: tab }), opt('rail-tab', 'changes'));
    await sleep(300);
    return measure('rail-open', async () => {
      for (let i = 0; i < 3; i++) {
        await ev(() => window.sable.store.getState().setUi({ railOpen: true }));
        await sleep(700);
        await ev(() => window.sable.store.getState().setUi({ railOpen: false }));
        await sleep(700);
      }
    });
  },
  // Every tab but Device (which would talk to a real emulator) twice, 300 ms apart: the first round
  // mounts each pane, the second only switches.
  'rail-tabs': async () => {
    await finishedSession();
    await ev(() => window.sable.store.getState().setUi({ railOpen: true, railTab: 'changes' }));
    await sleep(1200);
    const tabs = ['files', 'browser', 'terminal', 'tasks', 'context', 'agents', 'changes'];
    return measure('rail-tabs', async () => {
      for (const t of [...tabs, ...tabs]) {
        await ev((tab) => window.sable.store.getState().setUi({ railTab: tab }), t);
        await sleep(300);
      }
    });
  },
  // Every tab visited, then the panel rests on Changes for 8 s: the hidden panes must do nothing.
  'rail-idle': async () => {
    await finishedSession();
    for (const t of ['files', 'browser', 'terminal', 'tasks', 'context', 'agents', 'changes']) {
      await ev((tab) => window.sable.store.getState().setUi({ railOpen: true, railTab: tab }), t);
      await sleep(250);
    }
    await page.mouse.move(size[0] / 2, size[1] - 40);
    await sleep(1500);
    return measure('rail-idle', () => sleep(8000));
  },
  'drag-rail': async () => {
    await finishedSession();
    await ev(() => window.sable.store.getState().setUi({ railOpen: true, railTab: 'files' }));
    await sleep(900);
    const b = await box('.rail-resize');
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    const r = await measure('drag-rail', async () => {
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 1; i <= 40; i++) (await page.mouse.move(x - i * 5, y), await sleep(16));
      for (let i = 39; i >= 0; i--) (await page.mouse.move(x - i * 5, y), await sleep(16));
      await page.mouse.up();
      await sleep(300);
    });
    return r;
  },
};

const results = [];
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.sable?.store.getState().ready, null, { timeout: 30_000 });
  // A build error elsewhere in the tree (another lazy chunk) puts Vite's overlay over the page: out of the way.
  await page.addStyleTag({ content: 'vite-error-overlay { display: none !important; }' });
  // The backdrop as a new install has it (DEFAULT_BACKDROP), set locally only: backdropLive is never saved by itself.
  const bd = opt('backdrop', 'default');
  await page.evaluate((mode) => {
    const DEFAULT = { source: 'pattern', pattern: 'streaks', image: null, style: 'dither', amount: 14, sessionAmount: 30, focus: { x: 0.72, y: 0.78 }, reach: 100, detail: 90, speed: 30, angle: 35, colour: 'agent', hue: 28, saturation: 70, react: true };
    const cfg = mode === 'off' ? { ...DEFAULT, source: 'off' } : mode === 'still' ? { ...DEFAULT, speed: 0 } : DEFAULT;
    window.sable.store.setState({ backdropLive: cfg });
  }, bd);
  // Experiments: --css "rule" is added to the page before measuring.
  const css = opt('css', '');
  if (css) await page.addStyleTag({ content: css });
  // Experiments: --init "js" runs in the page before measuring (e.g. a switch the code reads).
  const init = opt('init', '');
  if (init) await page.evaluate(init);
  await sleep(3000);
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  const names = Object.keys(SCENARIOS).filter((n) => !only.length || only.includes(n));
  for (let rep = 0; rep < repeat; rep++)
    for (const n of names) {
      try {
        const r = await SCENARIOS[n]();
        results.push(r);
        const t = r.trace;
        const b = t.busy;
        console.log(
          [
            n.padEnd(13),
            `main ${(b.main ?? 0).toFixed(0)}ms`,
            `script ${r.scriptMs}`,
            `style ${r.styleN}/${r.styleMs}ms els ${t.styleEls ?? 0} max ${t.styleMax ?? 0}`,
            `layout ${r.layoutN}/${r.layoutMs}ms`,
            `paint ${t.paintN}/${t.paintMs.toFixed(1)}ms ${(t.paintArea / 1e6).toFixed(2)}Mpx`,
            `raster ${t.rasterN}/${t.rasterMs.toFixed(0)}ms`,
            `comp ${(b.compositor ?? 0).toFixed(0)}`,
            `worker ${(b.worker ?? 0).toFixed(0)}`,
            `gpu ${((b.gpu ?? 0) + (b.viz ?? 0)).toFixed(0)}`,
            `raf ${t.rafReq}/${t.rafFire}`,
            `timers ${t.timerInstall}/${t.timerFire}`,
            `frames ${t.frames}`,
            `long ${t.longTasks} loaf ${r.loaf}/${r.loafMs}ms`,
            `anims ${r.anims}${r.anims ? ` [${r.who.join(' ')}]` : ''}`,
            `layers ${r.layers}/${r.drawn} ${r.area}kpx`,
            `focus ${r.focus} field ${r.field}`,
          ].join(' | '),
        );
        const f = r.flight;
        if (f?.renders) console.log(`    renders in flight: ${f.renders}`);
        if (f)
          console.log(
            [
              `    flight ${f.ms}ms${f.landed ? '' : ' (no landing)'}`,
              `raf ${f.frames} frames, dropped ${f.dropped}, worst ${f.worst}ms, first ${f.first}ms`,
              f.cc ? `cc all ${f.cc.all} partial ${f.cc.partial} dropped ${f.cc.dropped} gap ${f.cc.gap}ms` : 'cc -',
              `draws ${f.draws} gap ${f.drawGap}ms`,
              `main busy ${f.mainBusy}ms long ${f.long}/${f.longMs}ms max ${f.maxTask}ms`,
              f.log,
            ].join(' | '),
          );
        const sp = r.span;
        if (sp)
          console.log(
            [
              `    span ${sp.span}ms`,
              `cc all ${sp.cc.all} partial ${sp.cc.partial} dropped ${sp.cc.dropped} gap ${sp.cc.gap}ms`,
              `draws ${sp.draws} gap ${sp.drawGap}ms`,
              `main busy ${sp.mainBusy}ms long ${sp.long}/${sp.longMs}ms max ${sp.maxTask}ms`,
              `loaf ${sp.loaf?.n}/${sp.loaf?.ms}ms worst ${sp.loaf?.worst}ms`,
            ].join(' | '),
          );
        if (t.detail)
          console.log(
            Object.entries(t.detail)
              .sort((a, b) => b[1][1] - a[1][1])
              .slice(0, 25)
              .map(([k, [c, ms]]) => `    ${k.padEnd(60)} ${String(c).padStart(5)} ${ms.toFixed(1)}ms`)
              .join('\n'),
          );
      } catch (err) {
        console.log(n, 'failed:', err.message.split('\n').slice(0, process.env.PERF_ERR ? 30 : 1).join('\n'));
      }
    }
} finally {
  writeFileSync(path.resolve(`scratch/speed/${label}.json`), JSON.stringify(results, null, 1));
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
  if (errors.length) console.log([...new Set(errors)].slice(0, 8).join('\n'));
  await browser.close();
}
