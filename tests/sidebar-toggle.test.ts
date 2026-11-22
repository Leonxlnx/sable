/**
 * The sidebar's toggle moves on one clock: the column's width, the top bar's slot for the mark and
 * the frozen view's centring are all laid out on the same frames. What ran on the compositor alone
 * (a slide of the view) kept its own time and left the composer behind whenever the page was busy;
 * a slot that came or went at once stepped the toggle and the title by its width for a frame.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const css = read('src/app/app.css');

/** The declarations of the first rule with exactly this selector. */
function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `rule ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('\n}', at));
}

const EASE = 'calc(var(--d-3) * 1.3) var(--ease-out)';

describe("the sidebar's toggle", () => {
  it("the bar's slot for the mark opens and closes with the column: the same duration and curve", () => {
    expect(rule('.app-side')).toContain(`width ${EASE}`);
    const open = rule('.topbar-home');
    expect(open).toContain(`width ${EASE}`);
    expect(open).toContain(`margin-right ${EASE}`);
    const closed = rule(".app[data-sidebar='true'] .topbar-home");
    expect(closed).toMatch(/\bwidth: 0;/);
    // The bar's gap after the closed slot is taken back, or the toggle would stand 4 px off.
    expect(rule('.topbar')).toMatch(/\bgap: 4px;/);
    expect(closed).toMatch(/\bmargin-right: -4px;/);
    expect(closed).toContain(`width ${EASE}`);
    // Out of reach once closed, not before (it still shows while it closes).
    expect(closed).toMatch(/visibility 0s linear calc\(var\(--d-3\) \* 1\.3\)/);
  });

  it('the slot is always in the bar, inert while the sidebar shows', () => {
    const app = read('src/app/App.tsx');
    expect(app).toMatch(/className="topbar-home".*inert=\{sidebarOpen\}/);
    expect(app).not.toMatch(/\{!sidebarOpen && \(\s*<button type="button" className="topbar-home"/);
  });

  it('the frozen view is centred by layout, never slid by an animation', () => {
    const frozen = rule(".stage-body[data-freeze='side'] > .stage-view");
    expect(frozen).toMatch(/\bleft: 50%;/);
    expect(frozen).toMatch(/\btranslate: -50% 0;/);
    const side = read('src/features/sidebar/Sidebar.tsx');
    const hook = side.slice(side.indexOf('function useStageFreeze()'), side.indexOf('\n}\n', side.indexOf('function useStageFreeze()')));
    expect(hook).toContain("body.dataset.freeze = 'side'");
    expect(hook).not.toMatch(/\.animate\(/);
    // Released by the column's own transition, with a timer behind it.
    expect(hook).toMatch(/addEventListener\('transitionend', done\)/);
    expect(hook).toMatch(/setTimeout\(\(\) => release\(body\), ms \+ 400\)/);
  });

  it('the flying mark rests where the open slot will hold it, and the slot takes no pointer meanwhile', () => {
    const fly = read('src/features/sidebar/brand-flight.ts');
    expect(fly).toContain("getPropertyValue('--tb-slot')");
    expect(fly).toContain("slot.style.pointerEvents = 'none'");
    expect(fly).toContain("slot?.style.removeProperty('pointer-events')");
    expect(rule('.topbar-home')).toMatch(/--tb-slot: 28px;/);
  });
});
