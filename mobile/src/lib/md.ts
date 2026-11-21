import { Marked, type Tokens } from 'marked';
import { ICON_DATA } from '@m/ui/icon-data';

/**
 * Markdown for answers. Raw HTML is shown as text (answers come from agents: nothing in them may
 * run in the app that holds the desktop's token); links open outside the app; widget and mermaid
 * blocks become a line pointing to the desktop.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const safeHref = (href: string) => (/^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : '');

/** Extensions that make `name.ext` a file even without a folder in front (`res.status` stays code). */
const FILE_EXT = new Set('ts tsx js jsx mjs cjs json jsonc md mdx css scss less html htm py rs go java kt kts swift c h cc cpp hpp cs rb php sh ps1 bat yml yaml toml lock txt log sql vue svelte xml gradle apk aab zip tar gz png jpg jpeg gif webp svg pdf env ini cfg conf dart lua csv tsv wasm'.split(' '));
const FILE_RE = /^((?:[A-Za-z]:)?(?:[\w@.+~-]*[\\/])*)([\w@+~-][\w@.+~-]*\.([A-Za-z][A-Za-z0-9]{0,7}))(:\d+(?:[:-]\d+)?)?$/;
const FILE_ICON = `<svg viewBox="0 0 256 256" aria-hidden="true">${ICON_DATA.file[0]}</svg>`;

/** `src/server/admin.ts:42` as a chip: the file's name (and line); a tap copies the whole path. */
function fileChip(text: string): string | null {
  const t = text.trim();
  if (t.length > 240 || /\s/.test(t)) return null;
  const m = FILE_RE.exec(t);
  if (!m) return null;
  const [, dir, name, ext, line] = m;
  if (!dir && !FILE_EXT.has(ext.toLowerCase())) return null;
  return `<span class="md-file" role="button" tabindex="0" data-path="${esc(t)}" aria-label="${esc(name)}, copy path">${FILE_ICON}<span class="md-file-name">${esc(name)}</span>${line ? `<span class="md-file-line">${esc(line)}</span>` : ''}</span>`;
}

const md = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return esc(text);
    },
    link({ href, tokens }: Tokens.Link) {
      const inner = this.parser.parseInline(tokens);
      const h = safeHref(href);
      return h ? `<a href="${esc(h)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : `<span class="md-link">${inner}</span>`;
    },
    image({ href, text }: Tokens.Image) {
      const h = safeHref(href);
      return h ? `<a href="${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(text || 'Image')}</a>` : esc(text || '');
    },
    codespan({ text }: Tokens.Codespan) {
      // Marked 16 hands the span's raw text (`<b>x</b>` stays a tag): the file test reads it as it is,
      // and what shows is escaped, so an answer can never put markup in the app.
      return fileChip(text) ?? `<code>${esc(text)}</code>`;
    },
    code({ text, lang }: Tokens.Code) {
      const l = (lang ?? '').trim().split(/\s+/)[0].toLowerCase();
      if (l === 'widget' || l === 'mermaid') return `<div class="md-widget">${l === 'mermaid' ? 'Diagram' : 'Widget'} <span>Open on the desktop to see it</span></div>`;
      const body = l === 'diff' || l === 'patch' ? diffLines(text) : esc(text);
      // A named language heads the block (its copy key beside it); a nameless block keeps the key in its corner.
      const head = l && /^[\w+#.-]{1,20}$/.test(l) ? `<div class="md-code-head"><span>${esc(l)}</span></div>` : '';
      return `<div class="md-code${head ? ' md-code-named' : ''}">${head}<pre class="md-pre no-drag"><code>${body}</code></pre><button type="button" class="md-copy" aria-label="Copy">${COPY}</button></div>`;
    },
  },
});

// Phosphor's Copy (regular), drawn inline in the rendered HTML.
const COPY =
  '<svg viewBox="0 0 256 256" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"/></svg>';

/** Diff lines with their colour: additions green, removals red, hunk headers dim. */
export function diffLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const c = line.startsWith('+') && !line.startsWith('+++') ? 'dl-add' : line.startsWith('-') && !line.startsWith('---') ? 'dl-del' : line.startsWith('@@') ? 'dl-hunk' : '';
      return c ? `<span class="${c}">${esc(line)}</span>` : esc(line);
    })
    .join('\n');
}

const cache = new Map<string, string>();

/** A line that continues the block before a blank line: a list item, or indented (a list's next paragraph, indented code). */
const GOES_ON = /^(\s|[-*+](\s|$)|\d{1,9}[.)](\s|$))/;

/**
 * Where the settled blocks of a streaming text end: the start of the last complete line, at or past
 * `from` (itself such a place, or 0), that begins a block of its own (after a blank line, outside a
 * fenced code block, not a list item or an indented line, which would belong to the block before).
 * What is before it reads the same parsed alone, so it is parsed once; only what follows is parsed
 * again as words arrive. Returns `from` when there is no such place yet.
 */
export function settledCut(text: string, from = 0): number {
  let cut = from;
  let fence = '';
  let blank = false;
  for (let i = from; ; ) {
    const nl = text.indexOf('\n', i);
    if (nl < 0) return cut;
    const line = text.slice(i, nl);
    if (fence) {
      const t = line.trim();
      if (t[0] === fence[0] && t.length >= fence.length && /^(`+|~+)$/.test(t)) fence = '';
      blank = false;
    } else {
      const empty = !line.trim();
      if (!empty && blank && i > from && !GOES_ON.test(line)) cut = i;
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (f) fence = f[1];
      blank = empty;
    }
    i = nl + 1;
  }
}

export function renderMarkdown(text: string, streaming = false): string {
  if (!streaming) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
  }
  let html: string;
  try {
    // Tables scroll sideways inside a card of their own.
    html = (md.parse(text, { async: false }) as string).replace(/<table>/g, '<div class="md-table"><table>').replace(/<\/table>/g, '</table></div>');
  } catch {
    html = `<p>${esc(text)}</p>`;
  }
  if (!streaming) {
    if (cache.size > 300) cache.clear();
    cache.set(text, html);
  }
  return html;
}
