import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

describe('a chat renamed in place moves no letter', () => {
  const css = read('src/features/sidebar/sidebar.css');
  const row = read('src/features/sidebar/SessionRow.tsx');

  it('puts the field’s words exactly where the title’s stood, in the title’s weight', () => {
    // The title starts 36 px into the row; the field's words start at its margin + 1 px edge + 6 px padding.
    expect(css).toMatch(/\.srow-main \{[^}]*padding: 0 44px 0 36px;/);
    expect(css).toMatch(/\.srow-rename,\n\.sgroup-rename \{[^}]*padding: 0 6px;\n  border: 1px solid/);
    expect(css).toMatch(/\.srow-rename \{\n  margin-left: 29px;\n\}/);
    // An open or unread chat's title is medium: so is its field.
    expect(css).toMatch(/\.srow\[data-active\] \.srow-title,\n\.srow\[data-unread\] \.srow-title \{[^}]*font-weight: var\(--w-medium\);/);
    expect(css).toMatch(/\.srow\[data-active\] \.srow-rename,\n\.srow\[data-unread\] \.srow-rename \{\n  font-weight: var\(--w-medium\);\n\}/);
  });

  it('shows the new name from the frame the field goes, until the bridge has answered', () => {
    // Between the field going and the bridge's answer the old title stood again for two frames.
    expect(row).toContain('const title = given ?? session.title;');
    expect(row).toContain('<span className="srow-title truncate">{title}</span>');
    const field = row.slice(row.indexOf('function RenameField'), row.indexOf('// ── the row ──'));
    expect(field.indexOf('onGiven(title);')).toBeGreaterThan(-1);
    expect(field.indexOf('onGiven(title);')).toBeLessThan(field.indexOf('renameSession(session.id, title)'));
    // Refused or accepted, the row then reads the store again.
    expect(field).toContain('.finally(() => onGiven(ownName(title)))');
  });

  it('keeps a second name when the first rename is answered', async () => {
    const { ownName } = await import('../src/features/sidebar/rename');
    // The row's "name just given", as React keeps it: a value, changed by a value or by an updater.
    let given: string | null = null;
    const onGiven = (next: string | null | ((cur: string | null) => string | null)) => {
      given = typeof next === 'function' ? next(given) : next;
    };
    // Renamed to A, then to B before the bridge has answered A.
    const answers: (() => void)[] = [];
    const rename = (title: string) => {
      onGiven(title);
      answers.push(() => onGiven(ownName(title)));
    };
    rename('A');
    rename('B');
    // A's answer: B was given since, and B still shows (it used to be taken away here).
    answers[0]();
    expect(given).toBe('B');
    // B's answer: the row reads the store again.
    answers[1]();
    expect(given).toBeNull();
    // One rename alone: its answer takes its name away, refused or accepted.
    rename('C');
    answers[2]();
    expect(given).toBeNull();
  });
});

describe('a folder that changes its list slides from where it stood', () => {
  const sidebar = read('src/features/sidebar/Sidebar.tsx');
  const move = read('src/features/sidebar/move.ts');

  it('is said before the store is told, at every way a folder gets into or out of a project', async () => {
    // The menu (into a project, into a new one, out), a drop on a project's header, a drag out of one.
    expect((sidebar.match(/moveCue\(/g) ?? []).length).toBe(5);
    expect(sidebar).toContain('(moveCue(group.key), void addToGroup(group.path, g.id))');
    expect(sidebar).toContain('(moveCue(group.key), void removeFromGroup(group.path, topArrangeKeys()))');
    const drop = sidebar.slice(sidebar.indexOf('const TOP_DROP'), sidebar.indexOf('/** Alt+Up / Alt+Down'));
    expect(drop.indexOf('moveCue(key);')).toBeLessThan(drop.indexOf('void addToGroup(f.path, into.slice(6));'));
    // The section that mounts for it plays no entrance and no unfold: it slides.
    expect(sidebar).toContain('const [moved] = useState(() => cued(group.key));');
    expect(sidebar).toContain('const [enter] = useState(() => !moved && lateMount());');
    expect(sidebar).toContain('if (moved) arrive(section.current, group.key);');
    expect(move).toContain("play(el, [{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], { duration: MOVE.duration, easing: MOVE.easing })");
  });

  it('slides a short way only, and never from out of view', async () => {
    const { arrival } = await import('../src/features/sidebar/move');
    expect(arrival(10, -8, true)).toBe('slide');
    expect(arrival(0, 200, true)).toBe('slide');
    // Across the list its words would cross everything between: it arrives in place.
    expect(arrival(0, 900, true)).toBe('place');
    expect(arrival(10, -8, false)).toBe('place');
  });

  it('unfolds a body only when its folder is opened, never when the whole section mounts', () => {
    // The list's Flip moves what is below a section that mounts: an unfold on top of it added up to twice the way.
    expect(sidebar).toContain('<FoldBody className="sgroup-body" enter={stood.current}>');
    expect(sidebar).toContain('<FoldBody className="sgroup-body sset-body" enter={stood.current}>');
    expect(sidebar).not.toMatch(/enter=\{[^}]*lateMount\(\)\}/);
  });
});
