/**
 * Empty states: one calm sentence each, in the same type, arriving the same way (styles/ui.css).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
/** The declarations of the first rule whose selector list holds `selector` on a line of its own. */
function rule(css: string, selector: string): string {
  const at = css.search(new RegExp(`(^|\n)${selector.replace(/[.[\]]/g, '\$&')}(,\n[^{]*)? \{`));
  expect(at, selector).toBeGreaterThan(-1);
  return css.slice(css.indexOf('{', at), css.indexOf('}', at));
}

const PLACES: [string, string][] = [
  ['src/features/rail/rail.css', '.rail-empty'],
  ['src/features/palette/palette.css', '.palette-empty'],
  ['src/features/history/history.css', '.history-note'],
  ['src/features/timeline/navigator.css', '.nav-none'],
  ['src/features/settings/settings.css', '.set-nav-empty'],
  ['src/features/settings/settings.css', '.set-empty'],
  ['src/features/settings/settings.css', '.cfg-empty'],
  ['src/features/settings/profile.css', '.prof-empty'],
  ['src/features/usage/usage.css', '.ul-empty'],
  ['src/features/race/race.css', '.race-empty'],
  ['src/features/sidebar/sidebar.css', '.side-empty'],
  ['src/features/sidebar/sidebar.css', '.sset-empty'],
  // A menu's filter that finds nothing: the model menu, the composer's suggestions, the account list.
  ['src/features/composer/composer.css', '.mm-empty'],
  ['src/features/composer/composer.css', '.sg-empty'],
  ['src/features/accounts/accounts.css', '.acs-empty'],
];

describe('empty states', () => {
  const ui = read('src/styles/ui.css');

  it('arrive one way: unseen for 150 ms, then a fade of opacity alone', () => {
    expect(ui).toContain('--empty-in: empty-in var(--d-3) var(--ease) 150ms backwards;');
    expect(ui).toMatch(/@keyframes empty-in \{\n  from \{\n    opacity: 0;\n  \}\n\}/);
  });

  it('are 13px in --text-3 everywhere, and every place takes the shared arrival', () => {
    for (const [file, selector] of PLACES) {
      const css = read(file);
      // Its type: the rule that names the class (the rail's shares it with the loading line).
      const type = rule(css, selector);
      expect(type, selector).toContain('font-size: var(--t-ui);');
      expect(type, selector).toContain('color: var(--text-3);');
      // The arrival, in that rule or in one of the class alone.
      const rules = [...css.matchAll(new RegExp(`(?:^|\\n)\\${selector}(?:,\\n[^{]*)? \\{([^}]*)\\}`, 'g'))].map((m) => m[1]);
      expect(rules.some((r) => r.includes('animation: var(--empty-in);')), selector).toBe(true);
    }
    // The conversation's own waits longer on purpose (a first message is on its way), in the same type.
    const tl = rule(read('src/features/timeline/timeline.css'), '.tl-empty');
    expect(tl).toContain('font-size: var(--t-ui);');
    expect(tl).toContain('900ms backwards');
  });

  it('are whole sentences', () => {
    const words: [string, RegExp][] = [
      ['src/features/timeline/Timeline.tsx', /className="tl-empty">([^<]+)</],
      ['src/features/sidebar/Sidebar.tsx', /className="sset-empty">([^<]+)</],
      ['src/features/settings/AgentConfig.tsx', /className="cfg-empty">(No rules[^<]+)</],
      ['src/features/settings/Hooks.tsx', /className="cfg-empty">(No hooks[^<]+)</],
      ['src/features/rail/TasksTab.tsx', /className="rail-empty">([^<]+)</],
      ['src/features/rail/AgentsTab.tsx', /className="rail-empty">([^<]+)</],
      ['src/features/accounts/ManyAccounts.tsx', /className="acs-empty">([^<]+)</],
      ['src/features/composer/Controls.tsx', /className="mm-empty">\{q \? `([^`]+)`/],
      ['src/features/composer/Controls.tsx', /className="mm-empty">\{q \? `[^`]+` : '([^']+)'/],
    ];
    for (const [file, re] of words) {
      const m = read(file).match(re);
      expect(m, file).not.toBeNull();
      expect(m![1].trim(), file).toMatch(/^[A-Z].*\.$/);
    }
  });

  it('stand 40px under the bar in a pane, and say nothing twice', () => {
    expect(rule(read('src/features/rail/rail.css'), '.rail-empty')).toContain('padding: 40px 28px;');
    expect(rule(read('src/features/palette/palette.css'), '.palette-empty')).toContain('padding: 40px 12px 28px;');
    expect(rule(read('src/features/history/history.css'), '.history-note')).toContain('padding: 40px 24px 24px;');
    // An empty History list says so in its sentence: no "0 conversations" under it.
    expect(read('src/features/history/History.tsx')).toContain('{entries && rows.length > 0 && <span className="history-count num">');
  });
});
