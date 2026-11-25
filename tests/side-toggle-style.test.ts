import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The sidebar's toggle changes `data-sidebar` on .app. Measured (scratch/day7/design4-speed/side-attr3.mjs):
// three rules made that restyle every element under .app in the toggle's first frame (3,498 elements,
// 80-130 ms with a long chat list): an inherited custom property set on .app per state, an inherited
// property (`pointer-events`) on the closed column, and a rule whose subject names nothing. Without
// them: 164 elements, 16-27 ms.
const css = readFileSync('src/app/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
const keyed = rules.filter((r) => r.sel.includes('data-sidebar'));

describe('the sidebar toggle restyles only what changes', () => {
  it('has rules keyed on data-sidebar, each with a subject that names a class', () => {
    expect(keyed.length).toBeGreaterThan(2);
    for (const r of keyed) for (const s of r.sel.split(/,(?![^(]*\))/)) expect(s.trim()).not.toMatch(/(^|[\s>+~])\*$/);
  });

  it('changes nothing inherited: no custom property and no pointer-events per state', () => {
    for (const r of keyed) {
      // On the column and the sidebar (thousands of rows under them); a leaf button may.
      if (/\.app-side|\.side\b/.test(r.sel)) expect(r.body).not.toMatch(/pointer-events|visibility/);
      // A custom property per state only on the boxes that read it, never on .app itself.
      if (/--[\w-]+\s*:/.test(r.body)) expect(r.sel).not.toMatch(/^\.app\[data-sidebar=[^\]]+\]$/);
    }
  });

  it('keeps --rail-fit registered as not inherited', () => {
    expect(css).toMatch(/@property --rail-fit\s*\{[^}]*inherits:\s*false/);
    const app = rules.find((r) => r.sel === '.app');
    expect(app?.body ?? '').not.toMatch(/--rail-fit/);
  });
});
