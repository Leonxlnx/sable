import { deflateSync } from 'node:zlib';

/**
 * The web client's icons, drawn in code from Sable's own mark at build time (mobile/vite.web.config.ts):
 * the favicon as SVG; the Home Screen icons as PNG (iPadOS takes no SVG for an apple-touch-icon), each a
 * plain raster of the same cells on the launch's ink. No picture is stored anywhere: the mark's path is
 * src/art/Logo.tsx's (mobile/src/ui/marks.tsx `MARK_PATH`), a 4 by 4 grid with two cells left out.
 */

/** The mark's cells on its 4 by 4 grid: rows 0 and 1 whole, row 2 without its last cell, row 3 its first two and its last. */
export const MARK: readonly (readonly [number, number])[] = [
  [0, 0], [1, 0], [2, 0], [3, 0],
  [0, 1], [1, 1], [2, 1], [3, 1],
  [0, 2], [1, 2], [2, 2],
  [0, 3], [1, 3], [3, 3],
];
const INK = [0x07, 0x07, 0x08];
const IVORY = [0xf2, 0xf1, 0xee];

/** The favicon: the mark in ivory on a rounded ink tile (a tab's light or dark bar shows it either way). */
export function faviconSvg(): string {
  const cells = MARK.map(([c, r]) => `<rect x="${8 + c * 4}" y="${8 + r * 4}" width="4" height="4"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges"><rect width="32" height="32" rx="7" fill="#070708"/><g fill="#f2f1ee">${cells}</g></svg>`;
}

/**
 * A square PNG of `size` pixels: the ink, and the mark centred at `share` of the side (whole pixels per
 * cell, so its edges are crisp). Full bleed: the system rounds a Home Screen icon's corners itself.
 */
export function iconPng(size: number, share = 0.44): Buffer {
  const cell = Math.max(1, Math.round((size * share) / 4));
  const at = Math.round((size - cell * 4) / 2);
  const filled = new Set(MARK.map(([c, r]) => r * 4 + c));
  const row = 1 + size * 3;
  const raw = Buffer.alloc(row * size);
  for (let y = 0; y < size; y++) {
    raw[y * row] = 0; // no filter
    for (let x = 0; x < size; x++) {
      const cx = Math.floor((x - at) / cell), cy = Math.floor((y - at) / cell);
      const on = x >= at && y >= at && cx < 4 && cy < 4 && filled.has(cy * 4 + cx);
      const rgb = on ? IVORY : INK;
      raw.set(rgb, y * row + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** The web app manifest: "Add to Home Screen" opens Sable on its own, without the browser's bars, on the launch's ink. */
export function manifest(): string {
  return JSON.stringify({
    name: 'Sable',
    short_name: 'Sable',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#070708',
    theme_color: '#070708',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  });
}

/** What index.html's head gets: the icon, the Home Screen icon, the manifest, and the standalone look on iPadOS. */
export const HEAD_LINKS = [
  '<link rel="icon" type="image/svg+xml" href="./assets/favicon.svg" />',
  '<link rel="apple-touch-icon" href="./assets/icon-180.png" />',
  '<link rel="manifest" href="./assets/manifest.webmanifest" />',
  '<meta name="apple-mobile-web-app-capable" content="yes" />',
  '<meta name="mobile-web-app-capable" content="yes" />',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
  '<meta name="apple-mobile-web-app-title" content="Sable" />',
].join('\n    ');
