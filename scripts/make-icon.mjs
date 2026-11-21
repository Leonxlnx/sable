// Renders the Sable mark (src/art/Logo.tsx, public/favicon.svg) as the desktop app icon:
// build/icon.ico (16, 20, 24, 32, 40, 48, 64, 96, 128, 256 px, PNG-compressed entries) and
// build/icon.png (512 px), plus the macOS icon: build/icon.icns (16 to 1024 px, with the 2x sizes)
// and build/icon-mac.png (1024 px, the Dock icon of `electron .`). A Mac icon is not full bleed: the
// plate is the "Big Sur" squircle at 80% of the canvas with a soft drop shadow, so it sits in the
// Dock at the same size as every other app. Each size is drawn at its own pixel size in headless Edge (or Chrome)
// through playwright-core, the same way scripts/shot.mjs launches it.
//
// The mark is a 4 x 4 field of square cells: a solid block whose last corner dissolves into
// ordered dither (two cells out, the corner cell holding on by a point). Every size is hinted by
// hand: the cell is a whole number of pixels, so no edge ever falls on half a pixel. The plate is
// flat ink (one hairline from 48 px up, so it holds its edge on a dark taskbar).
//
//   node scripts/make-icon.mjs [--previews]   (previews go to scratch/icon/)
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

/** The mark's outline in cell units (same as MARK_PATH in src/art/Logo.tsx). */
const MARK_PATH = 'M0 0H4V2H3V3H2V4H0Z M3 3H4V4H3Z';

/**
 * Cell size in pixels per icon size: the glyph spans about 55% of the canvas (a little less on
 * the big tiles, where a solid block reads heavier), more at the smallest sizes so the cells
 * stay readable. Every value keeps the glyph centred on whole pixels.
 */
const CELL = { 16: 3, 20: 3, 24: 4, 32: 5, 40: 6, 48: 7, 64: 9, 96: 13, 128: 17, 256: 35, 512: 69 };

const INK = '#0c0c0e';
const IVORY = '#f2f1ee';

function svg(size) {
  const cell = CELL[size];
  // Large icons sit a hair inside their canvas, as Windows icons do; small ones use every pixel.
  const inset = size >= 32 ? Math.round(size / 32) : 0;
  const side = size - inset * 2;
  const radius = size <= 16 ? 3.5 : +(side * 0.225).toFixed(2);
  // The block's weight sits up and left of its box (the missing cells are bottom right): from
  // 64 px up the glyph moves a whole pixel or two toward that corner so it looks centred.
  const nudge = size >= 64 ? Math.round(cell * 0.07) : 0;
  const at = (size - cell * 4) / 2 + nudge;
  const hair = size >= 48 ? Math.max(1, Math.round(size / 128)) : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="${inset}" y="${inset}" width="${side}" height="${side}" rx="${radius}" fill="${INK}"/>
  ${hair ? `<rect x="${inset + hair / 2}" y="${inset + hair / 2}" width="${side - hair}" height="${side - hair}" rx="${radius - hair / 2}" fill="none" stroke="#fff" stroke-opacity="0.1" stroke-width="${hair}"/>` : ''}
  <path transform="translate(${at} ${at}) scale(${cell})" fill="${IVORY}" d="${MARK_PATH}" shape-rendering="crispEdges"/>
</svg>`;
}

/**
 * The macOS icon at one pixel size: the plate on an 824/1024 squircle (corner radius 22.4% of the
 * plate), a short soft shadow under it, and the mark at the same share of the plate as on Windows.
 */
function macSvg(size) {
  const plate = size * (824 / 1024);
  const at0 = (size - plate) / 2;
  const radius = plate * 0.2237;
  // The mark spans 62% of the plate; whole pixels at small sizes so the cells stay sharp.
  const exact = (plate * 0.62) / 4;
  const cell = size <= 256 ? Math.max(1, Math.round(exact)) : exact;
  const nudge = size >= 64 ? Math.round(cell * 0.07) : 0;
  const at = (size - cell * 4) / 2 + nudge;
  const hair = size >= 64 ? Math.max(1, Math.round(size / 256)) : 0;
  const shadow = size >= 32 ? `<filter id="s" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="${(size * 0.011).toFixed(2)}" stdDeviation="${(size * 0.012).toFixed(2)}" flood-color="#000" flood-opacity="0.42"/></filter>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${shadow ? `<defs>${shadow}</defs>` : ''}
  <rect x="${at0}" y="${at0}" width="${plate}" height="${plate}" rx="${radius}" fill="${INK}"${shadow ? ' filter="url(#s)"' : ''}/>
  ${hair ? `<rect x="${at0 + hair / 2}" y="${at0 + hair / 2}" width="${plate - hair}" height="${plate - hair}" rx="${radius - hair / 2}" fill="none" stroke="#fff" stroke-opacity="0.12" stroke-width="${hair}"/>` : ''}
  <path transform="translate(${at} ${at}) scale(${cell})" fill="${IVORY}" d="${MARK_PATH}" shape-rendering="crispEdges"/>
</svg>`;
}

/** The sizes of an .icns file: [type code, pixel size]. The 2x entries are the next size up under the smaller name. */
const ICNS = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
];

/** An ICNS container: 'icns', its length, then one chunk (type, length, PNG) per size. */
function icns(images) {
  const chunks = ICNS.map(([type, size]) => {
    const png = images.get(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...chunks]);
}

/** An ICO container with PNG entries: a 6-byte header, a 16-byte directory entry per image, then the PNGs. */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e); // 0 means 256
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2); // no palette
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4); // colour planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}

const candidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const found = candidates.find((p) => existsSync(p));
const browser = await chromium.launch({ headless: true, ...(found ? { executablePath: found } : { channel: 'chrome' }) });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const render = async (size) => {
    await page.setViewportSize({ width: Math.max(size, 64), height: Math.max(size, 64) });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg(size)}`);
    return page.locator('svg').screenshot({ omitBackground: true, type: 'png' });
  };
  const renderMac = async (size) => {
    await page.setViewportSize({ width: Math.max(size, 64), height: Math.max(size, 64) });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${macSvg(size)}`);
    return page.locator('svg').screenshot({ omitBackground: true, type: 'png' });
  };
  const images = [];
  for (const size of ICO_SIZES) images.push({ size, png: await render(size) });
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'icon.ico'), ico(images));
  writeFileSync(path.join(out, 'icon.png'), await render(512));
  const mac = new Map();
  for (const size of new Set(ICNS.map(([, n]) => n))) mac.set(size, await renderMac(size));
  writeFileSync(path.join(out, 'icon.icns'), icns(mac));
  writeFileSync(path.join(out, 'icon-mac.png'), mac.get(1024));
  if (process.argv.includes('--previews')) {
    const dir = path.join(root, 'scratch', 'icon');
    mkdirSync(dir, { recursive: true });
    for (const [size, png] of mac) writeFileSync(path.join(dir, `mac-${size}.png`), png);
  }
  if (process.argv.includes('--previews')) {
    const dir = path.join(root, 'scratch', 'icon');
    mkdirSync(dir, { recursive: true });
    for (const { size, png } of images) writeFileSync(path.join(dir, `app-${size}.png`), png);
  }
  console.log(`Wrote build/icon.ico (${ICO_SIZES.join(', ')} px), build/icon.png (512 px), build/icon.icns and build/icon-mac.png (1024 px)`);
} finally {
  await browser.close();
}
