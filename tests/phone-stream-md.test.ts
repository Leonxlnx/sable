/**
 * A streaming answer on the phone (mobile/src/lib/md.ts `settledCut`, Timeline.tsx `useStreamed`):
 * the blocks before the cut are parsed once and kept, only what follows is parsed again as words
 * arrive. That holds only if the settled part parsed alone reads exactly as it does inside the whole.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@m/ui/icon-data', async () => await import('../mobile/src/ui/icon-data'));

// By a path the root type check does not follow (the phone's module resolves `@m` through its own config).
const MD = '../mobile/src/lib/md';
const { renderMarkdown, settledCut } = (await import(/* @vite-ignore */ MD)) as { renderMarkdown: (t: string, streaming?: boolean) => string; settledCut: (t: string, from?: number) => number };

const DOC = [
  '## Section 1',
  '',
  'The session store keeps entries in a map keyed by token, so memory stays bounded.',
  'A second line of the same paragraph with `inline code`.',
  '',
  '- one point about the module',
  '- another point, with **bold**',
  '',
  '- a loose list item',
  '',
  '  its second paragraph, indented',
  '',
  '1. first',
  '2. second',
  '',
  '```ts',
  'const store = new SessionStore({ ttlMs: 1_000 });',
  '',
  "store.create('u_1');",
  '',
  '## not a heading inside code',
  '```',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '> a quote',
  '',
  '    indented code',
  '',
  '**Bold start** of a paragraph.',
  '',
  '~~~',
  'tilde fence',
  '',
  '~~~',
  '',
  'The end.',
  '',
].join('\n');

/** The page as the phone builds it while the text streams: settled blocks once, then the rest. */
function streamed(text: string): string {
  let prefix = '';
  let html = '';
  const cut = settledCut(text, 0);
  if (cut > 0) {
    prefix = text.slice(0, cut);
    html = renderMarkdown(prefix, true);
  }
  return html + renderMarkdown(text.slice(prefix.length), true);
}

/** The same as `streamed`, but grown chunk by chunk with the cut carried along (as the hook does). */
function grown(text: string, step: number): string {
  let from = 0;
  let settled = '';
  let last = '';
  for (let n = step; ; n += step) {
    const t = text.slice(0, Math.min(n, text.length));
    const cut = settledCut(t, from);
    if (cut > from) {
      settled += renderMarkdown(t.slice(from, cut), true);
      from = cut;
    }
    last = settled + renderMarkdown(t.slice(from), true);
    if (n >= text.length) return last;
  }
}

const norm = (html: string) => html.replace(/>\s+</g, '><').trim();

describe('a streaming answer, block by block', () => {
  it('cuts only between blocks that read the same alone', () => {
    const cut = settledCut(DOC);
    expect(cut).toBeGreaterThan(0);
    // Never inside a fence, never before a list item or an indented line.
    for (let at = 0; at <= DOC.length; at++) {
      const t = DOC.slice(0, at);
      const c = settledCut(t);
      if (!c) continue;
      const line = t.slice(c, t.indexOf('\n', c));
      expect(line).not.toMatch(/^(\s|[-*+]\s|\d+[.)]\s)/);
      expect(t[c - 1]).toBe('\n');
      expect(t[c - 2]).toBe('\n');
    }
  });

  it('builds the same page as parsing the whole text, at every length', () => {
    for (let at = 1; at <= DOC.length; at++) {
      const t = DOC.slice(0, at);
      expect(norm(streamed(t)), `at ${at}`).toBe(norm(renderMarkdown(t, true)));
    }
  });

  it('grown in chunks, with the cut carried along, ends as the whole', () => {
    for (const step of [1, 7, 40, 900]) expect(norm(grown(DOC, step)), `step ${step}`).toBe(norm(renderMarkdown(DOC, true)));
  });

  it('keeps an unclosed fence in the part parsed again', () => {
    const t = 'Intro paragraph.\n\n```js\nconst a = 1;\n\nconst b = 2;\n\nmore\n';
    expect(settledCut(t)).toBe('Intro paragraph.\n\n'.length);
  });
});
