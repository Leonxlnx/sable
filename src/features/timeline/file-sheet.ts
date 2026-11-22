/**
 * What a file card's sheet shows (FileCard.tsx), from the file's name and its first bytes. Pure:
 * no DOM, no bridge.
 *
 * - text and code: the first lines as they are (a Markdown heading set a little stronger);
 * - CSV and TSV: the first rows as a small table;
 * - SVG: the drawing itself (as an image: nothing in it runs);
 * - anything else, or a file that could not be read: a cover with its kind (`coverKind`: a document,
 *   a table, a picture, an archive, a video, sound, code, or a plain file).
 */

export type Sheet =
  | { kind: 'cover' }
  | { kind: 'text'; lines: { text: string; head?: boolean }[] }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'image'; src: string };

const TEXT =
  /\.(txt|md|mdx|markdown|rst|log|csv|tsv|json|jsonc|json5|ya?ml|toml|ini|cfg|conf|env|ts|mts|cts|tsx|js|mjs|cjs|jsx|css|scss|sass|less|html?|xml|py|rs|go|java|kt|swift|rb|php|sh|bash|ps1|sql|c|h|cpp|cc|hpp|cs|lua|vue|svelte|astro|diff|patch)$/i;
const TABLE = /\.(csv|tsv)$/i;
const SVG = /\.svg$/i;

/** A page's worth of text: enough for its first lines, never the file. */
const TEXT_BYTES = 2400;
/** A drawing is read whole or not shown. */
const SVG_BYTES = 96 * 1024;

const LINES = 16;
const LINE_CHARS = 64;
const ROWS = 9;
const COLS = 4;
const CELL_CHARS = 18;

/** How many bytes to read for this file's sheet (0: it gets a cover, nothing is read). */
export function wantsText(name: string, size?: number): number {
  if (size === 0) return 0;
  if (SVG.test(name)) return size != null && size > SVG_BYTES ? 0 : SVG_BYTES;
  return TEXT.test(name) ? TEXT_BYTES : 0;
}

/**
 * Which picture the bridge may have of a file that is not read as text (`file.thumb`): a picture, a
 * document's first page, a frame of a video; null for anything else (no picture is asked for).
 */
export function pictureKind(name: string): 'image' | 'page' | 'video' | null {
  if (/\.(png|jpe?g|jfif|gif|webp|bmp|tiff?|heic|heif|avif|ico)$/i.test(name)) return 'image';
  if (/\.(pdf|docx|pptx|xlsx)$/i.test(name)) return 'page';
  if (/\.(mp4|m4v|mov|webm|mkv|avi|wmv|mpe?g|3gp)$/i.test(name)) return 'video';
  return null;
}

/**
 * How a picture stands on its sheet, from its size in pixels: a document's page keeps the sheet's
 * shape (its top shows, as with text); a picture or a frame takes its own proportions on the sheet's
 * width (between a wide strip and the sheet's full height), and a small one (an icon) stands at its
 * own size in the middle of the page.
 */
export function pictureFit(kind: 'image' | 'page' | 'video', w: number, h: number, sheetW = 156, sheetH = 140): { height: number; small: boolean } {
  if (kind === 'page' || !(w > 0 && h > 0)) return { height: sheetH, small: false };
  if (kind === 'image' && w < sheetW * 0.75 && h < sheetH * 0.6) return { height: sheetH, small: true };
  return { height: Math.round(Math.min(sheetH, Math.max(72, (sheetW * h) / w))), small: false };
}

/** What a cover draws under the file's extension (FileCard.tsx `Cover`): each kind has its own few hairlines and its own small motion. */
export type CoverKind = 'doc' | 'table' | 'picture' | 'archive' | 'video' | 'audio' | 'code' | 'file';

const COVER_KINDS: [CoverKind, RegExp][] = [
  ['picture', /\.(png|jpe?g|jfif|gif|webp|bmp|tiff?|heic|heif|avif|ico|svg|psd|ai|fig|sketch|xcf|raw)$/i],
  ['video', /\.(mp4|m4v|mov|webm|mkv|avi|wmv|mpe?g|3gp)$/i],
  ['audio', /\.(mp3|wav|flac|ogg|oga|m4a|aac|opus|aiff?|midi?)$/i],
  ['archive', /\.(zip|tar|gz|tgz|bz2|xz|zst|7z|rar|jar|war|apk|ipa|dmg|iso|deb|rpm|msi|cab)$/i],
  ['table', /\.(xlsx?|xlsm|ods|numbers|csv|tsv|parquet)$/i],
  ['doc', /\.(pdf|docx?|odt|rtf|pages|txt|md|mdx|markdown|rst|epub|pptx?|key|odp|log)$/i],
  [
    'code',
    /\.(json|jsonc|json5|ya?ml|toml|ini|cfg|conf|env|ts|mts|cts|tsx|js|mjs|cjs|jsx|css|scss|sass|less|html?|xml|py|rs|go|java|kt|swift|rb|php|sh|bash|ps1|sql|c|h|cpp|cc|hpp|cs|lua|vue|svelte|astro|diff|patch|wasm|exe|dll|so|dylib|bin|class|lock)$/i,
  ],
];

/** The kind of cover a file gets, from its name alone. */
export function coverKind(name: string): CoverKind {
  for (const [kind, re] of COVER_KINDS) if (re.test(name)) return kind;
  return 'file';
}

/** The kind as the cover writes it: the extension as typed, in lower case (".pdf"); "file" when there is none. */
export function coverWord(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return 'file';
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(ext) ? `.${ext}` : 'file';
}

/** One CSV line into cells (quotes kept simple: a quoted cell may hold the separator). */
function cells(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === sep && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function sheetOf(name: string, content: string, truncated: boolean): Sheet {
  const text = content.replace(/^﻿/, '');
  if (!text.trim()) return { kind: 'cover' };
  if (SVG.test(name)) {
    // Whole drawings only, and only what is one.
    if (truncated || !/<svg[\s>]/i.test(text)) return { kind: 'cover' };
    return { kind: 'image', src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}` };
  }
  const raw = text.split(/\r?\n/);
  // The last line of a cut read is a piece of one.
  if (truncated && raw.length > 1) raw.pop();
  if (TABLE.test(name)) {
    const sep = /\.tsv$/i.test(name) ? '\t' : ',';
    const rows = raw
      .filter((l) => l.trim())
      .slice(0, ROWS)
      .map((l) => cells(l, sep).slice(0, COLS).map((c) => c.trim().slice(0, CELL_CHARS)));
    if (rows.length && rows.some((r) => r.length > 1)) {
      const width = Math.max(...rows.map((r) => r.length));
      return { kind: 'table', rows: rows.map((r) => (r.length < width ? [...r, ...Array<string>(width - r.length).fill('')] : r)) };
    }
  }
  const md = /\.(md|mdx|markdown)$/i.test(name);
  const lines = raw.slice(0, LINES).map((l) => {
    const t = l.replace(/\t/g, '  ').slice(0, LINE_CHARS);
    return md && /^#{1,6}\s/.test(t) ? { text: t.replace(/^#{1,6}\s+/, ''), head: true } : { text: t };
  });
  // Leading blank lines are no first page.
  while (lines.length && !lines[0].text.trim()) lines.shift();
  return lines.length ? { kind: 'text', lines } : { kind: 'cover' };
}
