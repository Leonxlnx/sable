/**
 * The prompt bar of 22 Nov: where its menus stand, the agent's last known answer for the bar's
 * first frame, the path of ultracode's moment, the shade, and the message card the drop lands as.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Capabilities } from '@shared/protocol';
import { rememberCaps, resetSeenCaps, seenCaps } from '../src/features/composer/caps-seen';
import { FAR, GAP, NEAR, panePlace, placeMenu, roomBeyond } from '../src/features/composer/menu-place';
import { rimRun } from '../src/features/composer/ultra-run';
import { INK, inkAt } from '../src/features/composer/liquid-shape';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('a menu the bar opens stands clear of the pane', () => {
  // A docked bar, 760 by 90: its last line is 28 tall, 6 from the bottom and the sides.
  const pane = { left: 400, top: 700, right: 1160, bottom: 790 };
  const mode = { left: 440, top: 756, right: 520, bottom: 784 };
  const effort = { left: 1000, top: 756, right: 1108, bottom: 784 };

  it('8 px beyond the pane’s edge and flush with its side', () => {
    // Above the pane in a chat: from the chip's top to the pane's top, and the gap.
    expect(panePlace(mode, pane, 'top', 'start')).toEqual({ sideOffset: 56 + GAP, alignOffset: -40 });
    expect(panePlace(effort, pane, 'top', 'end')).toEqual({ sideOffset: 56 + GAP, alignOffset: -52 });
    // Below it on home.
    expect(panePlace(effort, pane, 'bottom', 'end')).toEqual({ sideOffset: 6 + GAP, alignOffset: -52 });
  });

  it('measures in the interface’s own pixels', () => {
    const z = 1.25;
    const scaled = (b: typeof pane) => ({ left: b.left * z, top: b.top * z, right: b.right * z, bottom: b.bottom * z });
    expect(panePlace(scaled(mode), scaled(pane), 'top', 'start', z)).toEqual({ sideOffset: 64, alignOffset: -40 });
  });

  it('stays by its chip over a tall draft, and where there is no pane round the chip', () => {
    const tall = { ...pane, top: pane.bottom - 34 - FAR - 1 };
    expect(panePlace(mode, tall, 'top', 'start')).toEqual(NEAR);
    expect(panePlace({ left: 0, top: 0, right: 10, bottom: 10 }, pane, 'top', 'start')).toEqual(NEAR);
  });

  it('opens on the side it is wanted on when the window has the room, else on the other, decided before it is drawn', () => {
    // Home, a window 800 tall: the pane in its middle, the last line 6 from its bottom.
    const home = { left: 400, top: 360, right: 1160, bottom: 472 };
    const chip = { left: 1000, top: 438, right: 1108, bottom: 466 };
    // 800 - 472 - 8 - 10 = 310 below, 360 - 8 - 10 = 342 above.
    expect([roomBeyond(home, 'bottom', 800), roomBeyond(home, 'top', 800)]).toEqual([310, 342]);
    // A menu that fits below (five rows of 28 and its padding) opens below, off the pane's bottom edge.
    expect(placeMenu(chip, home, 'bottom', 'end', 5 * 28 + 8, 800)).toEqual({ side: 'bottom', avoid: false, sideOffset: 6 + GAP, alignOffset: -52 });
    // One that does not goes above, with the offsets of that side (never across the pane).
    expect(placeMenu(chip, home, 'bottom', 'end', 330, 800)).toEqual({ side: 'top', avoid: false, sideOffset: 78 + GAP, alignOffset: -52 });
    // A long list that scrolls inside the menu needs only a few rows: it stays below.
    expect(placeMenu(chip, home, 'bottom', 'end', 240, 800).side).toBe('bottom');
    // In a chat the pane is docked at the bottom: above, always.
    expect(placeMenu(mode, pane, 'top', 'start', 400, 800)).toEqual({ side: 'top', avoid: false, sideOffset: 56 + GAP, alignOffset: -40 });
  });

  it('hangs by its chip and keeps itself in the window where neither side of the pane has the room', () => {
    const home = { left: 400, top: 200, right: 1160, bottom: 312 };
    const chip = { left: 1000, top: 278, right: 1108, bottom: 306 };
    expect(placeMenu(chip, home, 'bottom', 'end', 300, 520)).toEqual({ side: 'bottom', avoid: true, ...NEAR });
    // Over a tall draft the wanted side is by the chip too (the pane's far edge is too far away).
    const tall = { ...pane, top: pane.bottom - 34 - FAR - 1 };
    expect(placeMenu(mode, tall, 'top', 'start', 100, 900)).toEqual({ side: 'top', avoid: true, ...NEAR });
  });

  it('is what every menu of the bar uses, and their rows nest in the menu’s corner', () => {
    const controls = read('src/features/composer/Controls.tsx');
    expect(controls.match(/sideOffset=\{place\.sideOffset\}/g)?.length).toBe(2);
    // The side and whether it may move itself come from the placement, on all four menus.
    for (const file of ['Controls.tsx', 'Thinking.tsx', 'Composer.tsx']) {
      const src = read(`src/features/composer/${file}`);
      expect(src).toContain('side={place.side}');
      expect(src).toContain('avoidCollisions={place.avoid}');
      expect(src).not.toContain('avoidCollisions={false}');
    }
    expect(read('src/features/composer/Thinking.tsx')).toMatch(/sideOffset=\{place\.sideOffset\}\s*alignOffset=\{place\.alignOffset\}/);
    expect(read('src/features/composer/Composer.tsx')).toMatch(/sideOffset=\{place\.sideOffset\} alignOffset=\{place\.alignOffset\}/);
    // A menu's corner is 16 and its rows stand 4 in: 12, for the row and the highlight under it.
    const css = read('src/features/composer/composer.css');
    expect(css).toMatch(/\.cm-pop \.menu-item,\n\.cm-pop > \.menu-glide \{\n  border-radius: 12px;/);
    expect(read('src/styles/ui.css')).toMatch(/\.pop \{[^}]*border-radius: var\(--r-float\);/s);
    expect(Number(/--r-float: (\d+)px;/.exec(read('src/styles/tokens.css'))?.[1]) - Number(/\.cm-pop \{\n  padding: (\d+)px;/.exec(css)?.[1])).toBe(12);
  });
});

describe('the agent’s last known answer fills the bar’s first frame', () => {
  const caps = (name: string): Capabilities => ({
    models: [{ id: 'm1', name, efforts: ['low', 'high'], defaultEffort: 'high' }],
    modes: [{ id: 'bypassPermissions', name: 'Bypass', description: 'Never asks', tone: 'danger' }],
    commands: [{ name: 'deploy', description: 'Runs the deploy', kind: 'command' }],
    skills: [],
    agents: [],
    mcpServers: [],
    tools: ['Bash'],
    skillTrigger: '/',
    features: { images: true, thinking: true, rewind: true, steer: true, compact: true, fast: false, ultracode: true },
  });
  let store: Record<string, string>;
  const g = globalThis as { localStorage?: unknown };
  const had = g.localStorage;

  beforeEach(() => {
    store = {};
    g.localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) };
    resetSeenCaps();
  });
  afterEach(() => {
    g.localStorage = had;
    resetSeenCaps();
  });

  it('knows nothing of an agent never seen', () => {
    expect(seenCaps('claude', undefined)).toBeUndefined();
  });

  it('names the mode, the model and its levels after a restart, and nothing to run', () => {
    rememberCaps('claude', undefined, caps('Opus 5.5'));
    // A new start: only what was written is left.
    resetSeenCaps();
    const seen = seenCaps('claude', 'default');
    expect(seen?.models[0]).toMatchObject({ id: 'm1', name: 'Opus 5.5', efforts: ['low', 'high'] });
    expect(seen?.modes[0]).toMatchObject({ id: 'bypassPermissions', name: 'Bypass', tone: 'danger' });
    expect(seen?.features.ultracode).toBe(true);
    expect([seen?.commands, seen?.tools, seen?.mcpServers]).toEqual([[], [], []]);
  });

  it('is one object per account until the answer changes (a selector never renders for it)', () => {
    rememberCaps('claude', undefined, caps('Opus 5.5'));
    const a = seenCaps('claude', undefined);
    expect(seenCaps('claude', undefined)).toBe(a);
    rememberCaps('claude', undefined, caps('Opus 5.5'));
    expect(seenCaps('claude', undefined)).toBe(a);
    rememberCaps('claude', undefined, caps('Opus 6'));
    expect(seenCaps('claude', undefined)?.models[0].name).toBe('Opus 6');
  });

  it('is kept per account, and one account never stands in for another: what shows can be picked', () => {
    rememberCaps('claude', 'work', caps('Fable 5.2'));
    expect(seenCaps('claude', 'work')?.models[0].name).toBe('Fable 5.2');
    expect(seenCaps('claude', undefined)).toBeUndefined();
    expect(seenCaps('claude', 'other')).toBeUndefined();
    expect(seenCaps('codex', undefined)).toBeUndefined();
    rememberCaps('claude', undefined, caps('Opus 5.5'));
    expect(seenCaps('claude', undefined)?.models[0].name).toBe('Opus 5.5');
    expect(seenCaps('claude', 'work')?.models[0].name).toBe('Fable 5.2');
  });

  it('survives a store that cannot be read or written', () => {
    store['sable.capsSeen.v1'] = '{not json';
    resetSeenCaps();
    expect(seenCaps('claude', undefined)).toBeUndefined();
    g.localStorage = undefined;
    resetSeenCaps();
    rememberCaps('claude', undefined, caps('Opus 5.5'));
    expect(seenCaps('claude', undefined)?.models[0].name).toBe('Opus 5.5');
  });

  it('is what the composer falls back to, and nothing waits for the conversation to load', () => {
    const choice = read('src/features/composer/choice.ts');
    expect(choice).toMatch(/const caps = told \?\? seenCaps\(provider, accountId\);/);
    expect(choice).toMatch(/if \(told\) rememberCaps\(provider, accountId, told\);/);
    expect(read('src/features/composer/Composer.tsx')).not.toContain('data-opening');
    expect(read('src/features/composer/composer.css')).not.toContain('data-opening');
  });
});

describe('ultracode’s moment: two lights round the pane’s rim', () => {
  const run = rimRun(760, 90, 640);
  const far = (pts: { x: number; y: number }[]) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0);

  it('leave the chip both ways along the bottom edge', () => {
    expect([run.a[0].x, run.a[0].y]).toEqual([640, 90]);
    expect([run.b[0].x, run.b[0].y]).toEqual([640, 90]);
    expect(run.a[1]).toMatchObject({ x: 0, y: 90 });
    // The other one turns into the cove where the bottom edge ends (66 from the corner).
    expect(run.b[1]).toMatchObject({ x: 760 - 66, y: 90 });
  });

  it('travel the same distance at one speed and meet in one point on the far side', () => {
    expect(far(run.a)).toBeCloseTo(run.length, 6);
    expect(far(run.b)).toBeCloseTo(run.length, 6);
    const [ea, eb] = [run.a.at(-1)!, run.b.at(-1)!];
    expect(ea.x).toBeCloseTo(eb.x, 6);
    expect(ea.y).toBeCloseTo(eb.y, 6);
    expect(run.meet.y).toBe(0);
    // On the top edge, about as far from the left as the chip stands from the right.
    expect(run.meet.x).toBeGreaterThan(60);
    expect(run.meet.x).toBeLessThan(140);
  });

  it('are timed by the distance covered (the offsets of one eased run)', () => {
    for (const path of [run.a, run.b]) {
      let done = 0;
      path.forEach((p, i) => {
        if (i) done += Math.hypot(p.x - path[i - 1].x, p.y - path[i - 1].y);
        expect(p.at).toBeCloseTo(done / run.length, 6);
      });
      expect(path[0].at).toBe(0);
      expect(path.at(-1)!.at).toBe(1);
    }
  });

  it('holds for a chip anywhere on the line and for a tall pane', () => {
    for (const [w, h, x] of [
      [300, 90, 200],
      [760, 250, 700],
      [760, 112, 10],
    ]) {
      const r = rimRun(w, h, x);
      expect(far(r.a)).toBeCloseTo(far(r.b), 6);
      expect(r.a.at(-1)!.x).toBeCloseTo(r.b.at(-1)!.x, 6);
      expect(r.a.at(-1)!.y).toBeCloseTo(r.b.at(-1)!.y, 6);
    }
  });

  it('moves discs inside the rim’s own rings: transform and opacity, and the field answers once', () => {
    const src = read('src/features/composer/Ultracode.tsx');
    expect(src).toContain("fieldBeatAt('pulse'");
    expect(src).toMatch(/<i className="cr-edge">\s*<b data-way="a" \/>\s*<b data-way="b" \/>/);
    expect(src).not.toMatch(/boxShadow|filter/);
    const css = read('src/features/composer/composer.css');
    expect(css).not.toContain('uc-flash');
  });
});

describe('the shade: the bar casts little, and focus darkens nothing round it', () => {
  const css = read('src/features/composer/composer.css');
  const tokens = read('src/styles/tokens.css');

  it('uses the pane’s own depth, not a menu’s', () => {
    expect(css).toMatch(/\.sh-body \{[^}]*box-shadow: var\(--shadow-pane\);/s);
    expect(css).toMatch(/--cove-far: var\(--pane-far\);/);
    // One soft shadow that stays under the pane: no layer reaches further than 30 px.
    const far = /--pane-far: 0 (\d+)px (\d+)px (-?\d+)px rgb\(0 0 0 \/ ([\d.]+)\);/.exec(tokens);
    expect(far).not.toBeNull();
    const [y, blur, spread, a] = far!.slice(1).map(Number);
    expect(y + blur + spread).toBeLessThanOrEqual(30);
    expect(a).toBeLessThanOrEqual(0.5);
    expect(tokens).toMatch(/--shadow-pane: var\(--pane-contact\), var\(--pane-near\), var\(--pane-far\);/);
  });

  it('has no layer that focus fades in outside the outline', () => {
    expect(css).not.toContain('shadow-glass-lift');
    expect(css).not.toContain('cmp-shade-lift');
    expect(read('src/features/composer/Cove.tsx')).not.toContain('cmp-shade-lift');
    // What focus does change lies inside the pane.
    expect(css).toMatch(/ \.cmp-rim-lift,\n[^\n]* \.cmp-glass > \.gl-ink \{\n  opacity: 1;/);
  });

  it('never goes lighter: held while one of its menus is open, and dark ink when the blur is shed', () => {
    // Opening a menu takes focus out of the field: the pane keeps what focus gave it. The holder
    // is the composer (the chips under the home composer open menus too), or a card on its own.
    const held = ":is(.composer, .cmp-card):is(:focus-within, :has([aria-expanded='true']))";
    expect(css).toContain(`${held} .cmp-rim-lift,\n${held} .cmp-glass > .gl-ink {\n  opacity: 1;`);
    expect(css).toContain(`${held} .cmp-input::placeholder {`);
    // The copy that flies to the dock never shows it: its rule comes later, with as much weight.
    expect(css.indexOf('.handoff-ghost .cmp-card > .cmp-rim-lift')).toBeGreaterThan(css.indexOf(`${held} .cmp-rim-lift`));
    expect(css).not.toContain('textarea.cmp-input:focus)');
    // Under load the glass is opaque: the pane's own tone over the bare stage, not a menu's lighter grey.
    expect(css).toMatch(/:root\[data-quality\] \.cmp-glass \{[^}]*--cmp-fill: var\(--glass-pane-solid\);/s);
    expect(css).not.toContain('var(--glass-solid)');
    const rgb = (name: string) =>
      new RegExp(`--${name}: rgb\\((\\d+) (\\d+) (\\d+)(?: \\/ ([\\d.]+))?\\);`)
        .exec(tokens)!
        .slice(1)
        .map((v) => (v === undefined ? 1 : Number(v)));
    const sheet = /--sheet: #([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2});/
      .exec(tokens)!
      .slice(1)
      .map((h) => parseInt(h, 16));
    const pane = rgb('glass-pane');
    const solid = rgb('glass-pane-solid');
    const menu = rgb('glass-solid');
    for (let i = 0; i < 3; i++) {
      // The pane's fill laid over the stage, within a step; and darker than an opaque menu.
      expect(Math.abs(solid[i] - (pane[i] * pane[3] + sheet[i] * (1 - pane[3])))).toBeLessThanOrEqual(1);
      expect(solid[i]).toBeLessThan(menu[i]);
    }
  });
});

describe('the person’s message is a well, and the drop lands as it', () => {
  const surface = (css: string, rule: string) => {
    const body = new RegExp(`${rule} \\{([^}]*)\\}`, 's').exec(css)?.[1] ?? '';
    const fill = /background-color: rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\);/.exec(body);
    const rim = /box-shadow: inset 0 0 0 1px rgb\(255 255 255 \/ ([\d.]+)\);/.exec(body);
    const radius = /border-radius: ([^;]+);/.exec(body)?.[1];
    return { fill: fill?.slice(1).map(Number), rim: Number(rim?.[1]), radius, body };
  };
  const card = surface(read('src/features/timeline/timeline.css'), '\\.user-card::before');
  const flying = surface(read('src/features/composer/composer.css'), '\\.send-surface');

  it('no grey pane: darker than the stage, one even hairline, nothing lifted', () => {
    expect(card.fill?.slice(0, 3)).toEqual([0, 0, 0]);
    expect(card.body).not.toMatch(/shadow-composer|rim-inner|0 0 0 1px rgb\(0 0 0/);
    expect(card.rim).toBeGreaterThan(0.05);
    expect(card.rim).toBeLessThan(0.1);
  });

  it('has the same numbers on the card, on the flying copy and in the liquid', () => {
    expect(flying.fill).toEqual(card.fill);
    expect(flying.rim).toBe(card.rim);
    expect(flying.radius).toBe(card.radius);
    expect([...INK.fill, INK.a]).toEqual(card.fill);
    expect(INK.rim).toBe(card.rim);
  });

  it('is the bar’s dense ink in the air and thins into the well only as it settles', () => {
    expect(inkAt(0)).toEqual([...INK.air, INK.airA]);
    expect(inkAt(1)).toEqual([...INK.lift, INK.airA]);
    expect(inkAt(0.4, 1)).toEqual([...INK.fill, INK.a]);
    const mid = inkAt(0.5, 0.5);
    expect(mid[3]).toBeCloseTo((INK.airA + INK.a) / 2, 6);
    expect(mid[3]).toBeLessThan(inkAt(0.5, 0.25)[3]);
  });
});

describe('nothing on the bar blinks', () => {
  const css = read('src/features/composer/composer.css');

  it('a card whose row is late keeps its tone: only a hairline says it waits', () => {
    const flight = read('src/features/composer/flight.ts');
    expect(flight).not.toContain('WAIT_TONE');
    // The waiting state is the line's fill alone, and the swap starts no fade of the row.
    expect(flight).toMatch(/f\.wait = fill \? \[fill\] : \[\];/);
    const finish = flight.slice(flight.indexOf('function finishWait('), flight.indexOf('/** A message\'s hold'));
    expect(finish).not.toMatch(/opacity: tone/);
    expect(finish).toContain("line.className = 'send-wait'");
  });

  it('chips that came in late arrive once: not again on the copy that flies to the dock, and never from nothing', () => {
    expect(css).toMatch(/\.handoff-ghost \.tb-chip\[data-late\] \{\n  animation: none;/);
    const from = /@keyframes chip-arrive \{\n  from \{\n    opacity: ([\d.]+);/.exec(css);
    expect(Number(from?.[1])).toBeGreaterThan(0.2);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\n  \.tb-chip\[data-late\] \{\n    animation: none;/);
  });

  it('a chip’s focus ring is its skin’s, so it glides with the chip when the keys change its name', () => {
    expect(css).toMatch(/:is\(\.cmp-card, \.gal\) \.tb-chip:focus-visible \{\n  outline: none;\n  --chip-ring: inset 0 0 0 var\(--focus-w\) var\(--focus\);/);
    // After every rule that sets the ring of one of the bar's chips for another state.
    const after = css.slice(css.indexOf(':is(.cmp-card, .gal) .tb-chip:focus-visible') + 40);
    expect(after).not.toMatch(/\.(tb-chip|th-chip|cm-mode|cm-model)[^{}]*\{[^}]*--chip-ring:/);
  });

  it('the emptied field shows no caret while its words still leave', () => {
    expect(css).toMatch(/\.cmp-card\[data-pouring\] \.cmp-input \{\n  caret-color: transparent;/);
  });
});

describe('a steered message the agent takes moves, it does not arrive again', () => {
  it('a row with the id of one that left a moment ago is that message moving, once', async () => {
    const { MOVE_MS, rowLeft, rowMoved } = await import('../src/features/timeline/user-card');
    rowLeft('m1', { left: 900, top: 220, queued: true }, 1000);
    // The bridge takes the row out and adds it again within the same moment.
    expect(rowMoved('m1', 1004)).toEqual({ left: 900, top: 220, queued: true, at: 1000 });
    // Taken once: a later row with that id (the chat opened again) is a row like any other.
    expect(rowMoved('m1', 1010)).toBeNull();
    expect(rowMoved('never', 1010)).toBeNull();
    // A row that comes back long after it left (a rewind, another chat) did not move.
    rowLeft('m2', { left: 900, top: 220, queued: false }, 2000);
    expect(rowMoved('m2', 2000 + MOVE_MS + 1)).toBeNull();
    // Only a few are ever kept: what left long ago is forgotten when the next one leaves.
    rowLeft('m3', { left: 1, top: 1, queued: false }, 3000);
    rowLeft('m4', { left: 2, top: 2, queued: false }, 3000 + MOVE_MS + 5);
    expect(rowMoved('m3', 3000 + MOVE_MS + 6)).toBeNull();
    expect(rowMoved('m4', 3000 + MOVE_MS + 6)?.left).toBe(2);
  });

  it('the row that mounts glides from there and plays no entrance (only steered messages are watched)', () => {
    const user = read('src/features/timeline/User.tsx');
    expect(user).toMatch(/const was = item\.steered \? rowMoved\(item\.id, performance\.now\(\)\) : null;/);
    // The attribute first (it cancels the entrance before anything is measured), then the whole row glides.
    expect(user).toMatch(/el\.setAttribute\('data-moved', ''\);[\s\S]{0,500}play\(el, \[\{ transform: `translate\(/);
    // A moved row claims no flight; a row that is not steered reads no layout as it leaves.
    expect(user).toMatch(/\} else if \(item\.text\) landInTimeline\(el, item\.text,/);
    expect(user).toMatch(/if \(!item\.steered\) return;\n[^\n]*\n    return \(\) => \{/);
    expect(read('src/features/timeline/timeline.css')).toMatch(/\.tl-item \.user\[data-moved\] \{\n  animation: none !important;/);
  });
});
