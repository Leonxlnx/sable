import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARRIVE, layoutBox, rideFrame, type LayoutNode } from '../src/ui/glide';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const node = (o: Partial<LayoutNode> = {}): LayoutNode => ({
  offsetLeft: 0,
  offsetTop: 0,
  offsetWidth: 0,
  offsetHeight: 0,
  clientLeft: 0,
  clientTop: 0,
  scrollLeft: 0,
  scrollTop: 0,
  offsetParent: null,
  parentElement: null,
  ...o,
});

/** The declarations of the rule whose selector list starts with `sel`. */
const rule = (css: string, sel: string) => {
  const at = css.indexOf(`\n${sel}`);
  expect(at, sel).toBeGreaterThanOrEqual(0);
  return css.slice(css.indexOf('{', at), css.indexOf('}', at));
};

/**
 * Day 5, the owner: "the placement of the selected thing when you open the limits tab bottom left:
 * it's like laggy in between two". The pill was put where its row was drawn in the frame it took
 * focus: a row still arriving behind the pane stands 5px short of its place then, so the pill
 * rested 5px off its row until the next move (measured: pill 348, row 343).
 */
describe("the menu highlight's place is its row's place in the layout", () => {
  it('a row straight in the pane: its own offsets', () => {
    const pop = node();
    const row = node({ offsetLeft: 4, offsetTop: 71, offsetWidth: 284, offsetHeight: 28, offsetParent: pop, parentElement: pop });
    expect(layoutBox(row, pop)).toEqual({ x: 4, y: 71, w: 284, h: 28 });
  });

  it('a row in a list that scrolls (the accounts): the list’s place, less what it has scrolled', () => {
    const pop = node();
    const many = node({ parentElement: pop });
    const list = node({ offsetLeft: 4, offsetTop: 37, scrollTop: 56, offsetParent: pop, parentElement: many });
    const group = node({ parentElement: list });
    const row = node({ offsetTop: 140, offsetWidth: 284, offsetHeight: 28, offsetParent: list, parentElement: group });
    expect(layoutBox(row, pop)).toEqual({ x: 4, y: 37 + 140 - 56, w: 284, h: 28 });
    // A list with a border: a row's offset starts inside it.
    list.clientTop = 1;
    list.clientLeft = 1;
    expect(layoutBox(row, pop)).toEqual({ x: 5, y: 37 + 1 + 140 - 56, w: 284, h: 28 });
  });

  it('a scroller that is not positioned still counts', () => {
    const pop = node();
    const scroller = node({ scrollTop: 40, parentElement: pop });
    const row = node({ offsetLeft: 4, offsetTop: 200, offsetWidth: 232, offsetHeight: 26, offsetParent: pop, parentElement: scroller });
    expect(layoutBox(row, pop)).toEqual({ x: 4, y: 160, w: 232, h: 26 });
  });

  it('never reads where the row is drawn: a row 5px short of its place gets its resting box', () => {
    const drawn = () => {
      throw new Error('a drawn rectangle was read');
    };
    const pop = Object.assign(node(), { getBoundingClientRect: drawn });
    const row = Object.assign(node({ offsetLeft: 4, offsetTop: 71, offsetWidth: 284, offsetHeight: 28, offsetParent: pop, parentElement: pop }), { getBoundingClientRect: drawn });
    expect(layoutBox(row, pop)).toEqual({ x: 4, y: 71, w: 284, h: 28 });
  });

  it('says so when the offsets do not lead to the pane', () => {
    const pop = node();
    const elsewhere = node();
    expect(layoutBox(node({ offsetParent: elsewhere, parentElement: pop }), pop)).toBeNull();
    expect(layoutBox(node({ offsetParent: null, parentElement: pop }), pop)).toBeNull();
  });

  it('the pill is placed by that box, and the drawn rectangles are only the way out', () => {
    const glide = read('../src/ui/glide.ts');
    const boxIn = glide.slice(glide.indexOf('function boxIn('), glide.indexOf('function place('));
    expect(boxIn.indexOf('layoutBox(row, pop)')).toBeGreaterThan(0);
    expect(boxIn.indexOf('if (laid) return laid;')).toBeLessThan(boxIn.indexOf('getBoundingClientRect'));
    // Nothing else in the module measures a row.
    expect(glide.split('getBoundingClientRect').length - 1).toBe(2);
  });
});

describe('a pill never shows before its row', () => {
  it('takes the opacity and the timing of the row’s arrival, never its offset', () => {
    const frame = rideFrame({ computedOffset: 0.32, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', opacity: '0', transform: 'translateY(5px)' } as never);
    expect(frame).toEqual({ offset: 0.32, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', opacity: 0 });
    expect('transform' in frame).toBe(false);
    expect(rideFrame({ computedOffset: 1, easing: 'linear', opacity: '1' }).opacity).toBe(1);
  });

  it('the rows’ arrival carries the id the pill looks for, in either order', () => {
    const grow = read('../src/ui/grow.ts');
    const glide = read('../src/ui/glide.ts');
    expect(ARRIVE).toBe('menu-arrive');
    // The rows set off first (a pointer opened the menu, the row takes focus a frame later) …
    expect(grow).toContain('if (a) a.id = ARRIVE;');
    const place = glide.slice(glide.indexOf('function place('), glide.indexOf('function hide('));
    expect(place).toContain('rideWith(g, row);');
    // … or the pill was there first (the keys opened it: Radix focuses a row as the menu mounts).
    expect(grow).toMatch(/\n {2}arriving\(pop\);\n\}/);
    // A row whose arrival has no start yet (a busy page) hands it on the moment it has one.
    expect(glide).toContain('a.ready.then(sync, () => {});');
    // A pill that lets go ends its copy of the arrival, or it would fade in with no row under it.
    expect(glide.slice(glide.indexOf('function hide('), glide.indexOf('function drop('))).toContain('endRide(g);');
    expect(glide.slice(glide.indexOf('function drop('), glide.indexOf('// ── a pick is taken once ──'))).toContain('endRide(g);');
  });
});

/**
 * Measured in a short window, the account in use the list's last row: the list was scrolled 33 of
 * what settled as 28 (the last row, drawn 5px low while it arrived, lengthened what could scroll),
 * so rows and highlight were pulled back 5px when it landed.
 */
describe('a list that scrolls inside a menu', () => {
  it('its last row only fades in when the rows are drawn below their place', () => {
    const grow = read('../src/ui/grow.ts');
    expect(grow).toContain("pop.querySelectorAll<HTMLElement>('.scroll')");
    expect(grow).toContain('const dy = Math.abs(d) < 14 ? 0 : d > 0 ? -5 : lastIn.has(el) ? 0 : 5;');
    // The accounts' list is such a scroller.
    expect(read('../src/features/accounts/ManyAccounts.tsx')).toContain('className="acs-list scroll"');
  });
});

describe('the account switcher', () => {
  const switcher = read('../src/features/accounts/Switcher.tsx');
  const ui = read('../src/styles/ui.css');
  const usage = read('../src/features/usage/usage.css');
  const accounts = read('../src/features/accounts/accounts.css');
  const tokens = read('../src/styles/tokens.css');

  it('the account in use is the menu’s first focus: the highlight lands once', () => {
    const focus = switcher.slice(switcher.indexOf('const FOCUS_IN_USE'), switcher.indexOf('} as object;'));
    // Radix's own focus (the menu, then its first row when the keys opened it) is skipped.
    expect(focus).toContain('onOpenAutoFocus');
    expect(focus).toContain('e.preventDefault();');
    expect(focus.split('requestAnimationFrame').length - 1).toBe(1);
    // The list is scrolled to the row before the row takes focus.
    expect(focus.indexOf('scroller.scrollTop =')).toBeGreaterThan(0);
    expect(focus.indexOf('scroller.scrollTop =')).toBeLessThan(focus.indexOf('.focus({ preventScroll: true })'));
    expect(switcher).toContain('{...FOCUS_IN_USE}');
  });

  it('the pane beside the menu comes out when the menu has unfolded (its clip would cut it)', () => {
    const open = /--d-open: (\d+)ms;/.exec(ui)?.[1];
    expect(switcher).toContain(`export const OPEN_MS = ${open};`);
    expect(switcher).toContain('delay: peekDelay');
  });

  it('what nests in a pane takes the pane’s radius less its distance to the edge', () => {
    const pop = rule(ui, '.pop {');
    expect(pop).toMatch(/padding: 4px;/);
    expect(pop).toMatch(/border-radius: 16px;/);
    expect(tokens).toMatch(/--r-lg: 12px;/);
    // A row and the highlight under it.
    expect(rule(ui, '.menu-item {')).toMatch(/border-radius: var\(--r-lg\);/);
    expect(rule(ui, '.menu-glide {')).toMatch(/border-radius: var\(--r-lg\);/);
    // The limits pane: the menu's radius, 4px of padding, and its last row a row of the menu.
    expect(rule(accounts, '.acs-peek {')).toMatch(/border-radius: 16px;/);
    expect(rule(accounts, '.acs-peek-in {')).toMatch(/padding: 4px;/);
    const usageRow = rule(usage, '.ul-glance-open {');
    expect(usageRow).toMatch(/border-radius: var\(--r-lg\);/);
    for (const d of ['gap: 9px;', 'min-height: 28px;', 'padding: 3px 8px;']) expect(usageRow).toContain(d);
    expect(rule(ui, '.menu-item {')).toContain('padding: 3px 8px;');
    expect(rule(ui, '.menu-item {')).toContain('gap: 9px;');
  });

  it('the filter is a row of the menu, not a field with a shape of its own', () => {
    const filter = rule(accounts, '.acs-filter {');
    expect(filter).not.toMatch(/background|box-shadow|border/);
    // Its icon on the rows' mark column, its words on the names' column.
    expect(filter).toContain('padding: 0 8px;');
    expect(filter).toContain('gap: 9px;');
    // Under it the menu's own hairline.
    const many = read('../src/features/accounts/ManyAccounts.tsx');
    expect(many).toMatch(/<\/label>\s*<RM\.Separator className="menu-sep" \/>\s*<div className="acs-list scroll"/);
  });
});
