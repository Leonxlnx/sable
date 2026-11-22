import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listShift } from '../src/features/sidebar/leave';

const read = (p: string) => readFileSync(p, 'utf8');

describe('a row leaves the list in the frame of the click', () => {
  const leave = read('src/features/sidebar/leave.ts');
  const dissolve = read('src/lib/dissolve.ts');
  const sidebar = read('src/features/sidebar/Sidebar.tsx');
  const row = read('src/features/sidebar/SessionRow.tsx');

  it('draws nothing per frame: the exit is opacity and transform on a dead copy', () => {
    // A canvas drawn per rAF showed as three frames while the list rendered again.
    expect(dissolve).not.toContain('requestAnimationFrame');
    expect(dissolve).not.toContain('canvas');
    expect(dissolve).toContain('.animate(');
    // Only opacity, transform and translate are animated, here and in the list's slide.
    for (const src of [dissolve, leave]) {
      for (const m of src.matchAll(/(?:\.animate|play)\(/g)) {
        const keyframes = src.slice(m.index, m.index! + 420).split('duration')[0];
        expect(keyframes).not.toMatch(/(height|width|top|left|margin\w*|padding\w*|filter|boxShadow|clipPath|maskImage|backgroundColor)\s*:/);
      }
    }
  });

  it('reads every place before the first write, and works the new places out', () => {
    const writes = leave.indexOf('// ── writes ──');
    expect(writes).toBeGreaterThan(leave.indexOf('// ── reads ──'));
    const after = leave.slice(writes);
    // A read after the row is hidden lays the whole list out inside the click.
    expect(after).not.toMatch(/getBoundingClientRect|offsetTop|offsetHeight|scrollHeight|getComputedStyle/);
    const ghost = dissolve.slice(dissolve.indexOf('export function ghostOf'), dissolve.indexOf('/** The cell of the dither'));
    expect(ghost.indexOf('getComputedStyle')).toBeLessThan(ghost.indexOf('cloneNode'));
    expect(ghost.slice(ghost.indexOf('insertBefore'))).not.toMatch(/getBoundingClientRect|offsetParent|getComputedStyle/);
  });

  it('slides the list on translate, which adds to the transform Flip slides on', () => {
    expect(leave).toMatch(/\{ translate: `0 \$\{dy\}px` \}, \{ translate: '0 0' \}/);
    expect(read('src/features/sidebar/flip.tsx')).toContain('transform: `translateY(${dy}px)`');
  });

  it('waits for nothing: the open chat gives way to home and the row leaves before the bridge is asked', () => {
    const remove = sidebar.slice(sidebar.indexOf('function removeRow'), sidebar.indexOf('function selectActiveKey'));
    expect(remove.indexOf('goHome()')).toBeGreaterThan(-1);
    expect(remove.indexOf('goHome()')).toBeLessThan(remove.indexOf('closeSession('));
    expect(remove.indexOf("leaveRow(row, 'delete')")).toBeLessThan(remove.indexOf('closeSession('));
    const archive = row.slice(row.indexOf('function toggleArchive'), row.indexOf('function rowActions'));
    expect(archive.indexOf("leaveRow(row, 'archive')")).toBeLessThan(archive.indexOf('updateSession('));
    // Refused by the bridge: the row comes back.
    expect(remove).toContain('back?.()');
    expect(archive).toContain('back()');
  });

  it('keeps the dialog its words while it leaves', () => {
    const dialog = sidebar.slice(sidebar.indexOf('function DeleteDialog'), sidebar.indexOf('function removeRow'));
    expect(dialog).toContain('(now ?? shown)?.title');
  });

  it('lifts a pinned row out of its place at once and leaves the place for the list to close', () => {
    const pin = row.slice(row.indexOf('function togglePin'), row.indexOf('function toggleArchive'));
    expect(pin.indexOf('liftRow(row')).toBeGreaterThan(-1);
    expect(pin.indexOf('liftRow(row')).toBeLessThan(pin.indexOf('updateSession('));
    const lift = leave.slice(leave.indexOf('export function liftRow'), leave.indexOf('export function leaveRow'));
    // The place stays (closing it here would move everything below up, and back down when Pinned grows).
    expect(lift).toContain("row.style.visibility = 'hidden'");
    expect(lift).not.toContain("display = 'none'");
    expect(lift).not.toMatch(/translate:/);
  });

  it('lets a folder leave like a row, its copies never standing between two sections', () => {
    const remove = sidebar.slice(sidebar.indexOf('function removeFolder'), sidebar.indexOf('// ── projects: several folders under one name ──'));
    expect(remove).toContain("leaveRow(el, 'folder')");
    expect(remove.indexOf("leaveRow(el, 'folder')")).toBeLessThan(remove.indexOf('removeProject(path)'));
    // The sections are spaced by `.sgroup + .sgroup`: a stray sibling between two of them took the
    // lower one's 12 px away until it went, and the list jumped.
    expect(read('src/features/sidebar/sidebar.css')).toMatch(/\.sgroup \+ \.sgroup \{\s*margin-top: 12px;/);
    expect(leave).toContain("const place = above ? { into: above } : { before: row };");
    expect(dissolve).toContain('if (opts.into) parent.appendChild(wrap);');
  });

  it('keeps a list whole once it was shown whole', () => {
    // Counted in rows, a list that grew by one dropped its last row for a task: the row came back as
    // a new one (fading in) and everything below jumped a row without a slide.
    const list = sidebar.slice(sidebar.indexOf('const SessionList = memo'), sidebar.indexOf('const FOLD ='));
    expect(list).toMatch(/const n = rowsNow\(all\.length\);\s*return n >= all\.length \? Infinity : n;/);
  });

  it('knows how far a scrolled list comes down when it loses a row', () => {
    // A list that does not scroll never moves.
    expect(listShift(0, 640, 640, 31)).toBe(0);
    // Scrolled to its end: down by the row.
    expect(listShift(360, 1000, 640, 31)).toBe(31);
    // Ten pixels above its end: by what is missing.
    expect(listShift(350, 1000, 640, 31)).toBe(21);
    // Further up: not at all.
    expect(listShift(100, 1000, 640, 31)).toBe(0);
    // A list that only just scrolls and stops scrolling.
    expect(listShift(12, 652, 640, 31)).toBe(12);
  });
});

describe('an answered card leaves in the frame of the answer', () => {
  const leave = read('src/features/prompts/leave.ts');
  const dissolve = read('src/lib/dissolve.ts');

  it('is out of the layout at once, its copy held by the dock’s lower edge', () => {
    expect(leave).toContain("putAway(slot, 0, 8, 150, { anchor: 'bottom' })");
    expect(leave.indexOf('putAway(')).toBeLessThan(leave.indexOf("slot.style.display = 'none'"));
    // The dock's ground grows upward: a copy held by its top would drop with the dock's top edge.
    expect(dissolve).toMatch(/opts\.anchor === 'bottom' \? `bottom:\$\{bottom\}px` : `top:\$\{top\}px`/);
    // Not taken by the bridge: it comes back, and may be answered again (the card had locked itself).
    expect(leave).toMatch(/if \(slot\) slot\.style\.display = '';\n\s+back\?\.\(\);/);
    expect(read('src/features/prompts/PermissionCard.tsx')).toContain('leaveCard(req.id, () => setSent(false));');
    expect(read('src/features/prompts/QuestionCard.tsx')).toContain('deliver(skip ? null : out, () => setSent(false));');
  });

  it('is asked to leave before the bridge is asked', () => {
    const card = read('src/features/prompts/PermissionCard.tsx');
    expect(card.indexOf('leaveCard(req.id, ')).toBeGreaterThan(-1);
    expect(card.indexOf('leaveCard(req.id, ')).toBeLessThan(card.indexOf('void respondPermission(sessionId, req.id, o.id, msg)'));
    const question = read('src/features/prompts/QuestionCard.tsx');
    expect(question.indexOf('leaveCard(req.id, back)')).toBeGreaterThan(-1);
    expect(question.indexOf('leaveCard(req.id, back)')).toBeLessThan(question.indexOf('void respondQuestion(sessionId, req.id, answers)'));
    // A key during a drag of the effort scale is the drag's: Escape never skips a waiting question.
    expect(read('src/features/prompts/keys.ts')).toContain("if (document.querySelector('.th-chip[data-scrub]')) return false;");
    expect(read('src/features/prompts/PromptDock.tsx')).toContain('data-req={head.req.id}');
  });
});
