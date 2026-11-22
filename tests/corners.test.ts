import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Day 5, the owner: "the corners everywhere are still random and bad". One family (tokens.css,
 * "shape"): a thing has the radius of its kind; what nests in a rounded surface within 8px of its
 * edge takes that surface's radius less its distance to the edge, written as a calc on the holder's
 * token; nothing in flow is rounder than what holds it.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

/** The declarations of every rule that opens with exactly this line (a selector may close a list, too). */
const rule = (css: string, sel: string) => {
  let out = '';
  for (let at = css.indexOf(`\n${sel}\n`); at >= 0; at = css.indexOf(`\n${sel}\n`, at + 1)) out += css.slice(css.indexOf('{', at), css.indexOf('}', at));
  expect(out, sel).not.toBe('');
  return out;
};
const px = (decls: string, prop: string) => Number(new RegExp(`\\n\\s*${prop}: (\\d+)px;`).exec(decls)?.[1]);

const tokens = read('src/styles/tokens.css');
const token = (name: string) => Number(new RegExp(`--r-${name}: (\\d+)px;`).exec(tokens)?.[1]);

function sheets(dir: string, out: string[] = []) {
  for (const f of readdirSync(path.join(root, dir))) {
    const p = `${dir}/${f}`;
    if (statSync(path.join(root, p)).isDirectory()) sheets(p, out);
    else if (p.endsWith('.css')) out.push(p);
  }
  return out;
}

describe('one family of corners', () => {
  it('has these steps', () => {
    expect([token('xs'), token('sm'), token('md'), token('lg'), token('xl'), token('float'), token('pane')]).toEqual([5, 8, 10, 12, 14, 16, 20]);
  });

  it('a corner of 5px or more is written with a token, never as a number', () => {
    // The composer's outline is derived from its own numbers (tests/cove.test.ts), and the message's card and
    // the strips above the pane belong to it; the Appearance preview is a drawing of the window in small.
    const own: Record<string, RegExp> = {
      'src/features/composer/composer.css': /./,
      'src/features/composer/until.css': /^\.us \{$/,
      'src/features/timeline/timeline.css': /^\.user-card::before \{$/,
      'src/features/settings/background.css': /^\.bg-mini-/,
      'src/dev/gallery.css': /./,
    };
    const raw: string[] = [];
    for (const file of sheets('src')) {
      const lines = read(file).split('\n');
      lines.forEach((line, i) => {
        const m = /^\s*border(?:-[a-z]+)*-radius:\s*([^;]+);/.exec(line);
        if (!m) return;
        const big = m[1].split(/\s+/).some((v) => /^\d+(\.\d+)?px$/.test(v) && parseFloat(v) >= 5 && parseFloat(v) < 99);
        if (!big) return;
        let j = i;
        while (j > 0 && !lines[j].includes('{')) j--;
        if (own[file]?.test(lines[j].trim())) return;
        raw.push(`${file}:${i + 1} ${lines[j].trim()} ${m[1]}`);
      });
    }
    expect(raw).toEqual([]);
  });

  it('what floats is one corner, and its rows stand 4px in', () => {
    const ui = read('src/styles/ui.css');
    expect(rule(ui, '.pop {')).toContain('border-radius: var(--r-float);');
    expect(rule(ui, '.dialog {')).toContain('border-radius: var(--r-float);');
    expect(token('float') - px(rule(ui, '.pop {'), 'padding')).toBe(token('lg'));
    const palette = read('src/features/palette/palette.css');
    expect(rule(palette, '.palette {')).toContain('border-radius: var(--r-float);');
    expect(px(rule(palette, '.palette-list {'), 'padding')).toBe(4);
    expect(rule(palette, '.palette-row {')).toContain('border-radius: calc(var(--r-float) - 4px);');
    const quick = read('src/features/session/quick.css');
    expect(rule(quick, '.qs {')).toContain('border-radius: var(--r-float);');
    expect(px(rule(quick, '.qs {'), 'padding')).toBe(4);
    expect(rule(quick, '.qs-row {')).toContain('border-radius: calc(var(--r-float) - 4px);');
    const nav = read('src/features/timeline/navigator.css');
    expect(rule(nav, '.nav-index {')).toContain('border-radius: var(--r-float);');
    expect(px(rule(nav, '.nav-list {'), 'padding')).toBe(4);
    expect(rule(nav, '.nav-row {')).toContain('border-radius: calc(var(--r-float) - 4px);');
  });

  it('a pill that slides is given the radius its stylesheet states', () => {
    const slide = (file: string) => Number(/useSlidePill\([^;]*?, (\d+)(?:, byKeys)?\);/.exec(read(file))?.[1]);
    expect(slide('src/features/palette/Palette.tsx')).toBe(token('float') - 4);
    expect(slide('src/features/session/QuickSwitch.tsx')).toBe(token('float') - 4);
    expect(slide('src/features/composer/SuggestMenu.tsx')).toBe(12);
    expect(rule(read('src/features/composer/composer.css'), '.sg-row {')).toContain('border-radius: 12px;');
    // The segmented control: the track's corner less its 2px of padding and its 1px edge.
    const ui = read('src/styles/ui.css');
    const seg = rule(ui, '.seg {');
    expect(seg).toContain('border-radius: var(--r-sm);');
    expect(px(seg, 'padding') + 1).toBe(3);
    expect(rule(ui, '.seg-pill {')).toContain('border-radius: calc(var(--r-sm) - 3px);');
    expect(rule(ui, '.seg-item {')).toContain('border-radius: calc(var(--r-sm) - 3px);');
    expect(/const pill = useSlidePill\(value, (\d+)\);/.exec(read('src/ui/index.tsx'))?.[1]).toBe(String(token('sm') - 3));
  });

  it('a nested corner is the holder’s less the distance between their edges', () => {
    // A sidebar row's tools: 22px in a 30px row, 4px in from its end.
    const side = read('src/features/sidebar/sidebar.css');
    expect(rule(side, '.srow {')).toContain('border-radius: var(--r-sm);');
    expect(rule(side, '.srow-act {')).toContain('border-radius: calc(var(--r-sm) - 4px);');
    expect(rule(side, '.srow-acts {')).toContain('padding: 0 4px 0 18px;');
    expect(px(rule(side, '.sgroup-tools {'), 'right')).toBe(4);
    expect((30 - Number(/--ctl-h-xs: (\d+)px;/.exec(tokens)?.[1])) / 2).toBe(4);
    // Settings: an option row 3px and the card's hairline in.
    const settings = read('src/features/settings/settings.css');
    expect(px(rule(settings, '.pick-list {'), 'padding') + 1).toBe(4);
    expect(rule(settings, '.pick {')).toContain('border-radius: calc(var(--r-lg) - 4px);');
    // A file card's well, the find bar's field: 6px in.
    const files = read('src/features/timeline/files.css');
    expect(px(rule(files, '.fcard {'), 'padding')).toBe(6);
    expect(rule(files, '.fcard {')).toContain('border-radius: var(--r-xl);');
    expect(rule(files, '.fcard-stage {')).toContain('border-radius: calc(var(--r-xl) - 6px);');
    const find = read('src/features/session/find.css');
    expect(rule(find, '.cfind {')).toContain('border-radius: var(--r-xl);');
    expect(rule(find, '.cfind-field {')).toContain('border-radius: calc(var(--r-xl) - 6px);');
    // A changed file's row inside its card's hairline, and the diff set into that card.
    const rail = read('src/features/rail/rail.css');
    expect(rule(rail, '.ch-item {')).toContain('border-radius: var(--r-md);');
    expect(rule(rail, '.ch-row {')).toContain('border-radius: calc(var(--r-md) - 1px);');
    expect(rule(rail, '.ch-diff .dv {')).toContain('border-radius: max(4px, calc(var(--r-md) - 7px));');
  });

  it('what stands in the conversation’s column has one corner', () => {
    const timeline = read('src/features/timeline/timeline.css');
    const md = read('src/components/markdown.css');
    for (const [css, sel] of [
      [read('src/components/code.css'), '.cb {'],
      [read('src/components/diff.css'), '.dv {'],
      [timeline, '.term {'],
      [timeline, '.plan {'],
      [timeline, '.notice-error {'],
      [md, '.md-table {'],
      [md, '.md-callout {'],
      [read('src/features/genui/genui.css'), '.gw-box {'],
    ] as const)
      expect(rule(css, sel), sel).toContain('border-radius: var(--r-lg);');
    // Set into a card, a diff is a well.
    expect(rule(read('src/features/prompts/prompts.css'), '.pc-diffs > .dv {')).toContain('border-radius: var(--r-md);');
  });
});
