/**
 * Headless screenshots of the running dev server, for visual checks when no display is
 * available. Uses the installed Edge (or Chrome) through playwright-core: no download.
 *
 *   node scripts/shot.mjs [--size 1280x800] [--url http://localhost:5174/] <steps...>
 *
 * Steps run in order:
 *   --wait 800                 pause (ms)
 *   --eval "js"                run in the page (async allowed; `sable` helpers exist in dev builds only)
 *   --click "css"   --hover "css"   --fill "css=>text"   --type "text"   --key "Enter"
 *   --shot out.png             full viewport        --shot "out.png@css"  one element
 *   --scale 2                  device scale factor (before the first step)
 *   --film "sheet.png[@css]"   start recording every painted frame (cropped to the element's box as it is now)
 *   --cut 12                   stop, and write up to that many frames, evenly picked, as one contact sheet with
 *                              each frame's time in ms: for checking a motion frame by frame (a jump, a flash)
 *
 * Each run starts with a clean browser profile, so the app opens on the home screen.
 * Point it at a production build with SABLE_URL=http://localhost:<port>/ (only --wait/--shot/--click there).
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The dev server prefers 5173 and moves to 5174 when that is taken: use whichever answers. */
async function findServer() {
  if (process.env.SABLE_URL) return process.env.SABLE_URL;
  // 127.0.0.1 first: the test server (scripts/dev-test.mjs) listens there only, and a browser may take `localhost` for ::1.
  for (const host of ['127.0.0.1', 'localhost']) {
    for (const port of [5173, 5174, 4173]) {
      try {
        const res = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(1500) });
        if (res.ok && (await res.text()).includes('<title>Sable</title>')) return `http://${host}:${port}/`;
      } catch {
        /* not this one */
      }
    }
  }
  throw new Error('No Sable dev server found on 5173/5174. Start it with "pnpm dev".');
}

const args = process.argv.slice(2);
let size = [1280, 800];
let url = await findServer();
let scale = 1;
const steps = [];
for (let i = 0; i < args.length; i += 2) {
  const key = args[i];
  const val = args[i + 1];
  if (key === '--size') size = val.split('x').map(Number);
  else if (key === '--url') url = val;
  else if (key === '--scale') scale = Number(val);
  else steps.push([key.replace(/^--/, ''), val]);
}

const candidates = [
  ['msedge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'],
  ['msedge', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'],
  ['chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
];
const found = candidates.find(([, p]) => existsSync(p));
const browser = await chromium.launch({ headless: true, ...(found ? { executablePath: found[1] } : { channel: 'chrome' }) });
const context = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: scale, colorScheme: 'dark' });
const page = await context.newPage();
const errors = [];

/** A recording under way (`--film`): the frames Chromium painted, with their times. */
let film = null;
async function startFilm(val) {
  if (film) throw new Error('a film is already recording: --cut it first');
  const [file, sel] = val.split('@');
  const box = sel ? await page.locator(sel).first().boundingBox() : null;
  // A selector that names nothing visible must not turn into a film of the whole window.
  if (sel && !box) throw new Error(`film: nothing visible matches ${sel}`);
  const cdp = await context.newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', (f) => {
    frames.push({ data: f.data, t: f.metadata.timestamp * 1000 });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  film = { file, box, cdp, frames };
}
async function cutFilm(count) {
  if (!film) throw new Error('--cut without --film');
  const { file, box, cdp, frames } = film;
  film = null;
  await cdp.send('Page.stopScreencast').catch(() => {});
  // The session and its frame listener go with the recording (several films in one run kept every frame).
  await cdp.detach().catch(() => {});
  if (!frames.length) return console.log('film: no frames were painted');
  const n = Math.max(1, Math.min(count || 12, frames.length));
  const picked = n === frames.length ? frames : Array.from({ length: n }, (_, i) => frames[Math.round((i * (frames.length - 1)) / (n - 1 || 1))]);
  const t0 = frames[0].t;
  const sheet = await context.newPage();
  const url = await sheet.evaluate(
    async ({ picked, box, t0, vw }) => {
      const imgs = await Promise.all(picked.map((f) => new Promise((res) => Object.assign(new Image(), { onload: (e) => res(e.target), src: `data:image/png;base64,${f.data}` }))));
      const k = imgs[0].naturalWidth / vw;
      const c = box ? { x: box.x * k, y: box.y * k, w: box.width * k, h: box.height * k } : { x: 0, y: 0, w: imgs[0].naturalWidth, h: imgs[0].naturalHeight };
      const cols = Math.min(imgs.length, Math.max(1, Math.floor(1800 / (c.w + 8))) || 1);
      const rows = Math.ceil(imgs.length / cols);
      const label = 16;
      const cv = Object.assign(document.createElement('canvas'), { width: cols * (c.w + 8) + 8, height: rows * (c.h + label + 8) + 8 });
      const g = cv.getContext('2d');
      g.fillStyle = '#202020';
      g.fillRect(0, 0, cv.width, cv.height);
      g.font = '11px sans-serif';
      imgs.forEach((im, i) => {
        const x = 8 + (i % cols) * (c.w + 8);
        const y = 8 + Math.floor(i / cols) * (c.h + label + 8);
        g.fillStyle = '#c8c8c8';
        g.fillText(`${Math.round(picked[i].t - t0)} ms`, x, y + 11);
        g.drawImage(im, c.x, c.y, c.w, c.h, x, y + label, c.w, c.h);
      });
      return cv.toDataURL('image/png');
    },
    { picked, box, t0, vw: size[0] },
  );
  await sheet.close();
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  console.log(`film → ${file} (${picked.length} of ${frames.length} frames over ${Math.round(frames.at(-1).t - t0)} ms)`);
}
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`);
});

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Dev builds expose `sable`; production builds do not, so fall back to the DOM (shell drawn, boot loader gone).
  await page
    .waitForFunction(() => (window.sable ? window.sable.store.getState().ready : !!document.querySelector('.app') && !document.querySelector('.boot, .logo-intro')), null, { timeout: 30_000 })
    .catch(() => errors.push('app never became ready'));
  for (const [kind, val] of steps) {
    if (kind === 'wait') await page.waitForTimeout(Number(val));
    else if (kind === 'eval') {
      const out = await page.evaluate(`(async () => { ${val} })()`);
      if (out !== undefined) console.log('eval →', typeof out === 'string' ? out : JSON.stringify(out));
    } else if (kind === 'click') await page.click(val, { timeout: 8000 });
    else if (kind === 'hover') await page.hover(val, { timeout: 8000 });
    else if (kind === 'fill') {
      const [sel, text] = val.split('=>');
      await page.fill(sel, text, { timeout: 8000 });
    } else if (kind === 'type') await page.keyboard.type(val, { delay: 12 });
    else if (kind === 'key') await page.keyboard.press(val);
    else if (kind === 'shot') {
      const [file, sel] = val.split('@');
      mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      if (sel) await page.locator(sel).first().screenshot({ path: file });
      else await page.screenshot({ path: file });
      console.log('shot →', file);
    } else if (kind === 'film') await startFilm(val);
    else if (kind === 'cut') await cutFilm(Number(val));
    else console.log('unknown step', kind);
  }
} catch (err) {
  console.error('step failed:', err.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  if (errors.length) console.log([...new Set(errors)].slice(0, 12).join('\n'));
  await browser.close();
}
