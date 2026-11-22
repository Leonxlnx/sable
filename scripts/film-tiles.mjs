/**
 * Cuts one region out of every frame of a film sheet written by `scripts/shot.mjs --film … --cut N`
 * (frames stacked top to bottom, each 24 px of label and then the page) and lays the cuts out as a
 * grid, so a motion can be read at full size: a contact sheet of whole frames is scaled down until
 * a one-frame jump of a few pixels cannot be seen.
 *
 *   node scripts/film-tiles.mjs <sheet.png> <frames> <x,y,w,h> <out.png> [cols=4] [zoom=1]
 *
 * `frames` is the number the film printed ("16 of 42 frames": 16). `x,y,w,h` are in the sheet's own
 * pixels within one frame (the label's 24 px included in y; whole frames: 0,24,1456,900 at 1440x900).
 * Headless, through the installed Edge or Chrome like shot.mjs; no window is opened.
 */
import { chromium } from 'playwright-core';
import { existsSync, readFileSync } from 'node:fs';

const [sheet, framesArg, region, out, colsArg = '4', zoomArg = '1'] = process.argv.slice(2);
if (!sheet || !framesArg || !region || !out) {
  console.error('usage: node scripts/film-tiles.mjs <sheet.png> <frames> <x,y,w,h> <out.png> [cols] [zoom]');
  process.exit(2);
}
const frames = Number(framesArg);
const [x, y, w, h] = region.split(',').map(Number);
const cols = Number(colsArg);
const zoom = Number(zoomArg);
const buf = readFileSync(sheet);
// A PNG's size stands in its first chunk.
const W = buf.readUInt32BE(16);
const H = buf.readUInt32BE(20);
const fh = H / frames;
const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath: exe, headless: true });
const rows = Math.ceil(frames / cols);
const page = await browser.newPage({ viewport: { width: Math.ceil(cols * (w * zoom + 6) + 6), height: Math.ceil(rows * (h * zoom + 6) + 6) } });
const cells = Array.from({ length: frames }, (_, i) => `<div class="c" style="width:${w * zoom}px;height:${h * zoom}px;background-position:${-x * zoom}px ${-(i * fh + y) * zoom}px"><span>${i + 1}</span></div>`).join('');
// The sheet is served once to the page (as a data address per cell it would be sent once per frame).
await page.route('**/sheet.png', (route) => route.fulfill({ body: buf, contentType: 'image/png' }));
await page.goto('about:blank');
await page.setContent(
  `<style>body{margin:6px;background:#222;display:grid;grid-template-columns:repeat(${cols},max-content);gap:6px}.c{position:relative;outline:1px solid #444;background-image:url(http://tiles.invalid/sheet.png);background-size:${W * zoom}px ${H * zoom}px;background-repeat:no-repeat}.c span{position:absolute;right:2px;bottom:1px;font:10px sans-serif;color:#fff;background:#000a;padding:0 3px}</style>${cells}`,
  { waitUntil: 'load' },
);
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(400);
await page.screenshot({ path: out });
await browser.close();
console.log(`tiles → ${out} (${frames} frames of ${W}x${Math.round(fh)})`);
