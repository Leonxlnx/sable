import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { keyAfterPick, onFocusIn, reconcile, taken } from '../src/ui/glide';
import { takeRun } from '../src/features/palette/once';

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean }> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

/** Review wave 10, finding 6: a pick is taken once. */
describe('a pick is taken once', () => {
  it('a menu picked from takes no second pick, by key or click', () => {
    // Radix keeps the item mounted while the menu leaves; the closed state (or inert) refuses it.
    expect(taken({ inert: false, dataset: { state: 'closed' } })).toBe(true);
    expect(taken({ inert: true, dataset: { state: 'open' } })).toBe(true);
    // A row that keeps its menu open (a toggle) can be picked again.
    expect(taken({ inert: false, dataset: { state: 'open' } })).toBe(false);
  });

  it('a second Enter while the menu leaves does nothing', () => {
    expect(keyAfterPick('', key('Enter'))).toEqual({ act: 'drop', text: '' });
    expect(keyAfterPick('ab', key('Enter'))).toEqual({ act: 'drop', text: 'ab' });
  });

  it('typing right after a pick is kept for the field that takes focus next', () => {
    let text = '';
    for (const k of ['f', 'i', 'x', ' ', 'i', 't', 'Backspace', 'Backspace', 'n', 'o', 'w']) {
      const r = keyAfterPick(text, key(k));
      expect(r.act).toBe('hold');
      text = r.text;
    }
    expect(text).toBe('fix now');
    expect(keyAfterPick('', key('ü')).text).toBe('ü');
  });

  it('shortcuts, Escape, Tab and an empty Backspace go on as usual', () => {
    expect(keyAfterPick('', key('k', { ctrlKey: true })).act).toBe('pass');
    expect(keyAfterPick('', key('k', { metaKey: true })).act).toBe('pass');
    expect(keyAfterPick('', key('Escape')).act).toBe('pass');
    expect(keyAfterPick('', key('Tab')).act).toBe('pass');
    expect(keyAfterPick('', key('Backspace')).act).toBe('pass');
    expect(keyAfterPick('a', key('b', { isComposing: true }))).toEqual({ act: 'pass', text: 'a' });
  });

  it('the palette runs one action per opening', () => {
    const ran = { current: false };
    let runs = 0;
    const onRun = () => takeRun(ran) && ++runs;
    onRun(); // Enter
    onRun(); // a second Enter during the close
    onRun(); // a click on a row during the close
    expect(runs).toBe(1);
    ran.current = false; // opened again
    onRun();
    expect(runs).toBe(2);
  });
});

/** Review wave 10, finding 16: the highlight only rests on the row Enter picks. */
describe('the menu highlight', () => {
  it('lets go when focus goes to a control that is not a row (the search field)', () => {
    expect(onFocusIn(false)).toBe('hide');
    expect(onFocusIn(true)).toBe('place');
  });

  it('is reconciled when a filter takes its row away or moves it', () => {
    // The row it was on is gone: never left over the row that moved into its place.
    expect(reconcile({ inMenu: false, box: '' }, '4,60,232,28')).toBe('drop');
    // A row above it was filtered out: it follows the row.
    expect(reconcile({ inMenu: true, box: '4,32,232,28' }, '4,60,232,28')).toBe('follow');
    expect(reconcile({ inMenu: true, box: '4,60,232,28' }, '4,60,232,28')).toBe('keep');
    expect(reconcile(null, '')).toBe('keep');
  });
});

/** Review wave 10, finding 15: tools not shown yet cannot be clicked. */
describe('row tools take the pointer only once they show', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const sidebar = read('../src/features/sidebar/sidebar.css');
  const rail = read('../src/features/rail/rail.css');
  /** The declarations of the rule whose selector list starts with `sel`. */
  const rule = (css: string, sel: string) => {
    const at = css.indexOf(`\n${sel}`);
    expect(at, sel).toBeGreaterThanOrEqual(0);
    return css.slice(css.indexOf('{', at), css.indexOf('}', at));
  };

  for (const [name, css, rest, show, focus] of [
    ['chat row', sidebar, '.srow-acts {', '.srow:hover .srow-acts,', '.srow:has(:focus-visible) :is(.srow-acts'],
    ['folder header', sidebar, '.sgroup-tools {', '.sgroup-head:hover .sgroup-tools,', '.sgroup-head:has(:focus-visible) :is(.sgroup-tools'],
    ['rail row', rail, '.rail-row-acts {', '.rail-row-host:is(:hover, :focus-within) > .rail-row-acts {', '.rail-row-host:has(:focus-visible) > .rail-row-acts'],
  ] as const) {
    it(`${name}: no hit test at rest, pointer-events steps with the opacity's delay, keys show them at once`, () => {
      expect(rule(css, rest)).toMatch(/pointer-events: none;/);
      const on = rule(css, show);
      expect(on).toMatch(/pointer-events: auto;/);
      const delay = /opacity [^,;]*? ([\w()-]+);?\s*,/.exec(on)?.[1];
      expect(delay).toBeTruthy();
      expect(on).toContain(`pointer-events 0s linear ${delay} allow-discrete`);
      expect(rule(css, focus)).toMatch(/transition-delay: 0s;/);
    });
  }
});
