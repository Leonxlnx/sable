/**
 * The window's order of surfaces: its body (`--shell`: the sidebar and the frame between the
 * sheets) is one clear step above the sheets (`--sheet`: the stage and the side panel), which are
 * wells of the deepest ink in it. Text keeps its contrast on both, and where the panel moves apart
 * from the stage the stage's end is drawn on every frame, as the two tones no longer hide it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const tokens = read('src/styles/tokens.css');
const app = read('src/app/app.css');
const sidebar = read('src/features/sidebar/sidebar.css');
const rail = read('src/features/rail/rail.css');

/** The declarations of every rule whose selector (or the last of its list) is exactly this one. */
function rule(css: string, selector: string): string {
  const head = `\n${selector} {`;
  let out = '';
  for (let at = css.indexOf(head); at >= 0; at = css.indexOf(head, at + 1)) out += css.slice(at, css.indexOf('\n}', at));
  expect(out, `rule ${selector}`).not.toBe('');
  return out;
}

function token(name: string): string {
  const m = new RegExp(`\\n\\s*${name}:\\s*(#[0-9a-f]{6});`).exec(tokens);
  expect(m, `token ${name}`).not.toBeNull();
  return m![1];
}

/** Relative luminance (WCAG) of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('the order of surfaces', () => {
  it('the body is a clear step above the sheets, and still calm ink', () => {
    const [bg, sheet, shell, panel3] = ['--bg', '--sheet', '--shell', '--panel-3'].map(token);
    expect(luminance(sheet)).toBeGreaterThan(luminance(bg));
    // A step the eye takes at a glance (the two were one tone), never past the third panel step.
    expect(luminance(shell) / luminance(sheet)).toBeGreaterThan(1.8);
    expect(luminance(shell)).toBeLessThan(luminance(panel3));
  });

  it('the window and the sidebar are the body; the stage and the panel are sheets', () => {
    expect(rule(app, '.app')).toContain('background-color: var(--shell);');
    expect(rule(sidebar, '.side')).toContain('--side-bg: var(--shell);');
    expect(rule(app, '.stage')).toContain('background-color: var(--sheet);');
    expect(rule(rail, '.rail')).toContain('background-color: var(--sheet);');
  });

  it("the sidebar's fades and row fills are made of its own ground, never the sheet's", () => {
    expect(sidebar).not.toContain('var(--sheet)');
    expect(rule(sidebar, '.side-list')).toContain('background-color: var(--side-bg);');
    expect(rule(sidebar, '.side-list::before')).toContain('var(--side-bg)');
    expect(rule(sidebar, '.side-list::after')).toContain('var(--side-bg)');
  });

  it('text keeps its contrast on the body and on a sheet', () => {
    for (const ground of [token('--shell'), token('--sheet')]) {
      expect(contrast(token('--text'), ground)).toBeGreaterThan(14);
      expect(contrast(token('--text-2'), ground)).toBeGreaterThan(7);
      expect(contrast(token('--text-3'), ground)).toBeGreaterThan(4);
    }
  });

  it('the dimmest words (times, counts) are no fainter on the body than on a sheet', () => {
    const onSheet = contrast(token('--text-4'), token('--sheet'));
    const onShell = contrast(token('--text-4-shell'), token('--shell'));
    expect(onSheet).toBeGreaterThan(2.5);
    expect(onShell).toBeGreaterThanOrEqual(onSheet);
    // The sidebar is the body's own surface: it reads the body's tone for them.
    expect(rule(sidebar, '.side')).toContain('--text-4: var(--text-4-shell);');
  });
});

describe('the panel moving apart from the stage', () => {
  it("the veil over the panel's contents stays on the sheet, off the gap beside it", () => {
    const veil = rule(app, '.app-rail-inner > .veil');
    expect(veil).toContain('left: var(--gap);');
    expect(veil).toContain('border-radius: var(--r-xl);');
  });

  it('sliding over the stage the panel stands on the body, not on the sheet', () => {
    expect(rule(app, '.app-rail[data-step] > .app-rail-inner')).toContain('background-color: var(--shell);');
    expect(rule(app, '.app-rail:not([data-open]) > .app-rail-inner')).toContain('background-color: var(--shell);');
  });

  it("on its way out the column is cut by a clip that leaves a corner's reach over the stage's end", () => {
    const leaving = rule(app, '.app-rail:not([data-open])');
    expect(leaving).toContain('overflow: visible;');
    expect(leaving).toContain('clip-path: inset(0 0 0 calc(var(--r-xl) * -1 - 1px));');
  });

  it('the column reads as stage under the moving panel, with the round end travelling at the gap', () => {
    const under = rule(app, '.app-rail:is([data-step], :not([data-open]))::before');
    expect(under).toContain('background-color: var(--sheet);');
    expect(under).toContain('border-radius: 0 var(--r-xl) var(--r-xl) 0;');
    const end = rule(app, '.app-rail:is([data-step], :not([data-open])) > .app-rail-inner::after');
    expect(end).toContain('background-color: var(--sheet);');
    expect(end).toContain('border-radius: 0 var(--r-xl) var(--r-xl) 0;');
    expect(rule(app, '.app-rail:is([data-step], :not([data-open])) > .app-rail-inner::before')).toContain('background-color: var(--shell);');
  });
});
