/**
 * The prompt bar: where its menus stand, the agent's last known answer for the bar's first frame,
 * ultracode's moment, the shade, and the message card the drop lands as.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Capabilities } from '@shared/protocol';
import { rememberCaps, resetSeenCaps, seenCaps } from '../src/features/composer/caps-seen';
import { GAP, placeMenu, roomBeside } from '../src/features/composer/menu-place';
import { INK } from '../src/features/composer/signal-shape';
import { snapShift, toDevicePixel } from '../src/features/composer/pixel-snap';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// 23 Nov: the menus open at their chip again. 0.2.21 stood them clear of the pane, flush with its
// side (`panePlace`, tested here until then); with a draft of a few lines and an attachment the
// model menu opened about 150 px above the chip that was clicked, and the owner called it worse.
describe('a menu the bar opens stands by its own chip', () => {
  // A docked bar with a draft of three lines and an attachment, 760 by 186: its last line is 28
  // tall, 6 from the bottom and the sides.
  const mode = { left: 440, top: 756, right: 520, bottom: 784 };
  const effort = { left: 1000, top: 756, right: 1108, bottom: 784 };

  it('8 px off the chip, on the chip’s own edge, however tall the draft', () => {
    expect(placeMenu(mode, 'top', 4 * 28 + 8, 800)).toEqual({ side: 'top', sideOffset: GAP, alignOffset: 0 });
    expect(placeMenu(effort, 'top', 400, 800)).toEqual({ side: 'top', sideOffset: GAP, alignOffset: 0 });
    // Nothing about the pane goes in: the place is the chip's alone.
    expect(placeMenu.length).toBe(4);
  });

  it('opens on the side it is wanted on when the window has the room, else on the side with more, decided before it is drawn', () => {
    // Home, a window 800 tall: the pane in its middle, the chip on its last line.
    const chip = { left: 1000, top: 438, right: 1108, bottom: 466 };
    // 800 - 466 - 8 - 10 = 316 below, 438 - 8 - 10 = 420 above.
    expect([roomBeside(chip, 'bottom', 800), roomBeside(chip, 'top', 800)]).toEqual([316, 420]);
    expect(placeMenu(chip, 'bottom', 5 * 28 + 8, 800)).toEqual({ side: 'bottom', sideOffset: GAP, alignOffset: 0 });
    // One that does not fit below goes above, by the same chip.
    expect(placeMenu(chip, 'bottom', 330, 800)).toEqual({ side: 'top', sideOffset: GAP, alignOffset: 0 });
    // Where neither side has the room it takes the side with more (a list that scrolls is held to it).
    expect(placeMenu(chip, 'bottom', 500, 800).side).toBe('top');
    expect(placeMenu({ ...chip, top: 300, bottom: 328 }, 'bottom', 500, 800).side).toBe('bottom');
  });

  it('measures in the interface’s own pixels', () => {
    const z = 1.25;
    const chip = { left: 1250, top: 547.5, right: 1385, bottom: 582.5 };
    // 438 and 466 at a zoom of 1.25 in a window 1000 device px tall: the same room as above.
    expect([roomBeside(chip, 'bottom', 1000, z), roomBeside(chip, 'top', 1000, z)]).toEqual([316, 420]);
  });

  it('is what every menu of the bar uses, and their rows nest in the menu’s corner', () => {
    const controls = read('src/features/composer/Controls.tsx');
    // The mode menu; the model and effort panel is Phrase.tsx's.
    expect(controls.match(/sideOffset=\{place\.sideOffset\}/g)?.length).toBe(1);
    expect(controls).not.toMatch(/panePlace|usePanePlace|closest<HTMLElement>\('\.cmp-card'\)/);
    // The side comes from the placement on all four menus, and Radix never flips it (a flipped mode
    // menu kept the row order of the side it left).
    for (const file of ['Controls.tsx', 'Phrase.tsx', 'Composer.tsx']) {
      const src = read(`src/features/composer/${file}`);
      expect(src).toContain('side={place.side}');
      expect(src).toContain('useMenuPlace(');
      expect(src).toContain('avoidCollisions={false}');
      expect(src).not.toContain('avoidCollisions={place.avoid}');
    }
    // The home chips' menus (agent, folder, working tree) hang below their chips by the same gap.
    expect(controls.match(/side="bottom"\s+align="start"\s+sideOffset=\{GAP\}/g)?.length).toBe(3);
    // The panel hangs from the phrase's right end, which holds whatever the phrase says
    // (tests/composer-effort.test.ts has the rule).
    const phrase = read('src/features/composer/Phrase.tsx');
    expect(phrase).toMatch(/align="end"\s*sideOffset=\{place\.sideOffset\}\s*alignOffset=\{0\}/);
    // One column: its width in the CSS is the one Phrase.tsx names, on the 4 px grid.
    const w = /\n\.mx \{\n  width: (\d+)px;/.exec(read('src/features/composer/composer.css'));
    expect(Number(w?.[1])).toBe(Number(/export const PANEL_W = (\d+);/.exec(phrase)?.[1]));
    expect(Number(w?.[1]) % 4).toBe(0);
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

describe('ultracode’s moment: one even hairline, and the field answers once', () => {
  // 23 Nov: the two lights that ran round the rim are gone (the owner wants the rim even): the
  // clearer hairline comes up all round at once, on the rim's own ring, and the field pulses once.
  it('comes up all round at once, on the rim’s own ring: opacity only, nothing runs round it', () => {
    const src = read('src/features/composer/Ultracode.tsx');
    expect(src).toContain('<CoveRing className="uc-line" />');
    expect(src).not.toMatch(/rimRun|data-way|translate\(/);
    expect(src).not.toMatch(/boxShadow|filter/);
    const css = read('src/features/composer/composer.css');
    expect(css).toMatch(/\.uc\[data-phase='rise'\] > \.uc-line \{\n  animation: fade-in /);
    expect(css).not.toMatch(/uc-run|uc-flash/);
  });

  it('the field answers once, from ultracode’s own chip, with a real beat and no flash (drawn by the worker)', () => {
    const src = read('src/features/composer/Ultracode.tsx');
    expect(src.match(/fieldBeat\(/g)?.length).toBe(1);
    // The wave without the flash at its start, from the chip that is on (the phrase for an Ultra level).
    expect(src).toContain("fieldBeat('pulse', beatFrom(card.current), BEAT)");
    expect(src).toMatch(/card\?\.querySelector\('\.ux\[data-on\]'\) \?\? card\?\.querySelector\('\.ph'\) \?\? card/);
    const beat = Number(/const BEAT = ([\d.]+);/.exec(src)?.[1]);
    // More than the soft pulse it was (0.7), within what the field takes (1.6).
    expect(beat).toBeGreaterThanOrEqual(1);
    expect(beat).toBeLessThanOrEqual(1.6);
  });
});

describe('the pane stands on whole device pixels', () => {
  // The pane's fill, words and rim are a compositor layer of their own (they lie above its blur), placed
  // where the card's first whole CSS pixel falls on the screen. Between device pixels it is drawn smeared.
  const lands = (pos: number, dpr: number) => (Math.floor(pos + 1 / 128) + snapShift(pos, dpr)) * dpr;

  it('moves the card by the missing part of a device pixel, at most half of one', () => {
    // The docked pane in a 760 px tall window at 125%: its top at CSS pixel 643, device pixel 803.75.
    expect(snapShift(643, 1.25)).toBeCloseTo(0.2, 6);
    expect(lands(643, 1.25)).toBeCloseTo(804, 6);
    // One line taller (22 px): 621 is 776.25, a quarter of a pixel the other way.
    expect(snapShift(621, 1.25)).toBeCloseTo(-0.2, 6);
    for (const dpr of [1.1, 1.25, 1.5, 1.75]) {
      for (let pos = 300; pos < 340; pos += 0.37) {
        const d = lands(pos, dpr);
        expect(Math.abs(d - Math.round(d))).toBeLessThan(1e-6);
        expect(Math.abs(snapShift(pos, dpr)) * dpr).toBeLessThanOrEqual(0.5 + 1e-9);
      }
    }
  });

  it('moves nothing where a CSS pixel is whole device pixels, or where the pane already stands on one', () => {
    for (const pos of [0, 312, 312.67, 643, 643.5]) {
      expect(snapShift(pos, 1)).toBe(0);
      expect(snapShift(pos, 2)).toBe(0);
    }
    // 348 at 125% is device pixel 435; home's pane at 312.67 starts on CSS pixel 312, device pixel 390.
    expect(snapShift(348, 1.25)).toBe(0);
    expect(snapShift(348.5, 1.25)).toBe(0);
    expect(snapShift(312.67, 1.25)).toBe(0);
  });

  it('puts a line on the nearest whole device pixel (where a chip’s two skin windows meet, before it glides)', () => {
    for (const dpr of [1, 1.25, 1.5, 1.75, 2, 2.5]) {
      for (let pos = 900; pos < 906; pos += 0.13) {
        const on = (pos + toDevicePixel(pos, dpr)) * dpr;
        expect(Math.abs(on - Math.round(on))).toBeLessThan(1e-6);
        expect(Math.abs(toDevicePixel(pos, dpr)) * dpr).toBeLessThanOrEqual(0.5 + 1e-9);
      }
    }
    // A chip that ends at 1045.5 with a cap of 20: the line at 1025.5 is device pixel 1281.875 at 125%.
    expect(toDevicePixel(1025.5, 1.25)).toBeCloseTo(0.1, 6);
    expect(toDevicePixel(1024, 1.25)).toBe(0);
    expect(toDevicePixel(Number.NaN, 1.25)).toBe(0);
  });

  it('counts from the card’s first whole pixel, not from its own fraction (the layer starts there)', () => {
    // Half a pixel in (an odd stage width): the same shift as on the pixel before it.
    expect(snapShift(41.5, 1.25)).toBeCloseTo(snapShift(41, 1.25), 9);
    // A position a rounding error short of a whole pixel is that pixel.
    expect(snapShift(642.9999, 1.25)).toBeCloseTo(0.2, 3);
    expect(snapShift(Number.NaN, 1.25)).toBe(0);
    expect(snapShift(10, 0)).toBe(0);
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
    // The placeholder reads the state from a property on the holder: a `:has()` selector that ends in a
    // pseudo-element makes every insertion anywhere restyle the whole document.
    expect(css).toContain(`${held} {
  --cmp-ph:`);
    expect(css).toContain('color: var(--cmp-ph, var(--text-3));');
    expect(css).not.toMatch(/:has\([^{]*::placeholder\s*\{/);
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

  it('has the same numbers on the card, on the flying copy and in the signal', () => {
    expect(flying.fill).toEqual(card.fill);
    expect(flying.rim).toBe(card.rim);
    expect(flying.radius).toBe(card.radius);
    expect([...INK.fill, INK.a]).toEqual(card.fill);
    expect(INK.rim).toBe(card.rim);
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
    expect(after).not.toMatch(/\.(tb-chip|ph|ux|cm-mode)[^{}]*\{[^}]*--chip-ring:/);
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
