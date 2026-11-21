/**
 * The phone's markdown (mobile/src/lib/md.ts): an agent's answer is shown, never run. Marked 16 hands
 * a code span's raw text to the renderer, so `<b>sample</b>` in backticks used to become a live tag in
 * the WebView (wave 3 review, finding 1). Every answer, report, plan and the Select text sheet use
 * this renderer.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@m/ui/icon-data', async () => await import('../mobile/src/ui/icon-data'));

// By a path the root type check does not follow (the phone's module resolves `@m` through its own config).
const MD = '../mobile/src/lib/md';
const { renderMarkdown, diffLines } = (await import(/* @vite-ignore */ MD)) as { renderMarkdown: (t: string) => string; diffLines: (t: string) => string };

/** Tags the renderer may produce; anything else in the output came from the answer. */
const ALLOWED = new Set(['p', 'code', 'pre', 'a', 'span', 'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'button', 'svg', 'path', 'br', 'hr', 'input']);
const tags = (html: string) => [...html.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)].map((m) => ({ name: m[1].toLowerCase(), attrs: m[2] }));

describe("the phone's markdown", () => {
  it('shows a code span with markup in it as text', () => {
    const html = renderMarkdown('Use `<b>sample</b>` and `<img src=x onerror=alert(1)>` here.');
    expect(html).toContain('<code>&lt;b&gt;sample&lt;/b&gt;</code>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toMatch(/<b>|<img/);
    // Literal entities and ampersands in code stay what was written.
    expect(renderMarkdown('`a & b` `&lt;x&gt;`')).toContain('<code>a &amp; b</code> <code>&amp;lt;x&amp;gt;</code>');
  });

  it('still turns a path in backticks into a file chip, its words escaped', () => {
    const html = renderMarkdown('See `src/server/admin.ts:42`.');
    expect(html).toContain('class="md-file"');
    expect(html).toContain('data-path="src/server/admin.ts:42"');
    expect(renderMarkdown('`res.status`')).toContain('<code>res.status</code>');
  });

  it('never lets an answer add a tag or an event attribute, wherever the markup stands', () => {
    const hostile = [
      '<script>alert(1)</script>',
      'x <img src=x onerror=alert(1)> y',
      '| a |\n|---|\n| <b onmouseover=x>c</b> `<i>z</i>` |',
      '# <svg onload=alert(1)>',
      '[<b>l</b>](javascript:alert(1)) [ok](https://example.com "t\\"onclick=x")',
      '![a" onerror="x](https://x/"onerror)',
      '**<u>s</u>** ~~<s>d</s>~~ <details open ontoggle=alert(1)>',
      '```html\n<script>alert(1)</script>\n```',
      '```diff\n+<img src=x onerror=1>\n-<b>\n```',
      '> quote `<iframe src=//evil>`',
      '- item `</code><b>out</b>`',
      '<https://a.b/<x>>',
    ];
    for (const text of hostile) {
      const html = renderMarkdown(text);
      for (const t of tags(html)) {
        expect(ALLOWED.has(t.name), `${t.name} in ${html}`).toBe(true);
        expect(t.attrs, html).not.toMatch(/\son\w+\s*=/i);
        expect(t.attrs, html).not.toMatch(/javascript:/i);
      }
    }
  });

  it('colours diff lines with their words escaped', () => {
    expect(diffLines('+<b>x</b>\n-y')).toBe('<span class="dl-add">+&lt;b&gt;x&lt;/b&gt;</span>\n<span class="dl-del">-y</span>');
  });
});
