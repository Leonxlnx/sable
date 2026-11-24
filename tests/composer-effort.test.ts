/**
 * Model and effort on the bar (composer/Phrase.tsx): what one step up or down selects, ultracode
 * as a switch of its own at any level, what the keys do (on the phrase, the chords from the field,
 * in the panel), the panel's one column and its place at the phrase, a model picked mid-turn, the reel a word rolls on, the order a narrow pane sheds in; and the rules
 * for a speed billed outside the plan.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@shared/protocol';
import { linesOf } from '../src/features/composer/attach';
import { inPose, reel, reelFrom, rollAt, ROLL_MS, ROLL_PX } from '../src/features/composer/reel';
import { chordKeys, clampStop, landLevel, landUltra, lastStop, levelChord, opensPanel, stepStop, ultraChord, ultraKeys, ultraOffered, type KeyLike, type Setting } from '../src/features/composer/effort-track';
import { flushRight } from '../src/features/composer/menu-place';
import { capOn } from '../src/features/composer/Chip';
import { askLine } from '../src/features/composer/paid-speed';
import { blocks, digitLevel, listRows, modelDue, navigate, panelReach, panelRows, returnsToTrigger, scaleKey, type Shape } from '../src/features/composer/panel-nav';
import { defaultableSpeeds, offeredSpeeds, startSpeedFor, toggledSpeed } from '../shared/speed';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('the levels: one step up or down', () => {
  // Claude Code's five levels: Low, Medium, High, Extra high, Max.
  const claude = 5;
  const high: Setting = { level: 2, ultra: false };

  it('has one stop per level and nothing past the top, whatever ultracode does', () => {
    expect(lastStop(claude)).toBe(4);
    expect(lastStop(0)).toBe(-1);
    expect(clampStop(9, claude)).toBe(4);
    expect(clampStop(9, 3)).toBe(2);
    // Nothing set stays nothing set; a model without levels has no stop at all.
    expect(clampStop(-1, claude)).toBe(-1);
    expect(clampStop(2, 0)).toBe(-1);
  });

  it('steps one level at a time, and the ends hold: it never wraps round', () => {
    expect(stepStop(2, 1, claude)).toBe(3);
    expect(stepStop(2, -1, claude)).toBe(1);
    expect(stepStop(0, -1, claude)).toBeNull();
    expect(stepStop(2, 1, 3)).toBeNull();
    // Nothing set (the agent decides): up is the lowest level, down is nowhere.
    expect(stepStop(-1, 1, claude)).toBe(0);
    expect(stepStop(-1, -1, claude)).toBeNull();
    // Nothing to step on a model with no level.
    expect(stepStop(-1, 1, 0)).toBeNull();
  });

  it('ends at Max and stays there: no step leads to ultracode, held or fresh, on or off', () => {
    expect(stepStop(4, 1, claude)).toBeNull();
    // Every key from the lowest level upward: five presses, then it holds at the top.
    let at = 0;
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      at = stepStop(at, 1, claude) ?? at;
      seen.push(at);
    }
    expect(seen).toEqual([1, 2, 3, 4, 4, 4, 4, 4]);
    // The rule takes no ultracode at all: the scale is the model's levels and nothing else.
    expect(stepStop.length).toBe(3);
  });

  it('a step lands on what it names: a level sends that level, and only when it is another one', () => {
    expect(landLevel(high, stepStop(2, 1, claude)!, claude)).toEqual({ level: 3 });
    expect(landLevel(high, 0, claude)).toEqual({ level: 0 });
    expect(landLevel(high, 2, claude)).toEqual({});
    expect(landLevel({ level: -1, ultra: false }, 0, claude)).toEqual({ level: 0 });
  });
});

describe('ultracode is a switch of its own, at any level', () => {
  const claude = 5;

  it('a level stepped or picked never touches it', () => {
    for (let level = 0; level < claude; level++) {
      const on: Setting = { level, ultra: true };
      for (let to = 0; to < claude; to++) {
        const out = landLevel(on, to, claude);
        expect(out.ultra).toBeUndefined();
        expect(out).toEqual(to === level ? {} : { level: to });
      }
    }
    // The top level with ultracode on, one more step up: nothing changes, and ultracode stays on.
    expect(stepStop(4, 1, claude)).toBeNull();
  });

  it('switching it never touches the level: on and off at Low, at Max, with no level set', () => {
    for (const level of [-1, 0, 2, 4]) {
      expect(landUltra({ level, ultra: false }, true, true)).toEqual({ ultra: true });
      expect(landUltra({ level, ultra: true }, false, true)).toEqual({ ultra: false });
      expect(landUltra({ level, ultra: true }, true, true)).toEqual({});
      expect(landUltra({ level, ultra: false }, false, true)).toEqual({});
    }
  });

  it('is switched only where the agent and model offer it', () => {
    expect(landUltra({ level: 2, ultra: false }, true, false)).toEqual({});
    expect(landUltra({ level: 2, ultra: true }, false, false)).toEqual({});
  });

  it('is offered only by Claude Code (and the Demo), and only where its caps say so', () => {
    const on = { features: { ultracode: true } };
    const off = { features: { ultracode: false } };
    expect(ultraOffered('claude', on)).toBe(true);
    expect(ultraOffered('demo', on)).toBe(true);
    // An account whose CLI has no Workflow tool says so in its caps.
    expect(ultraOffered('claude', off)).toBe(false);
    expect(ultraOffered('claude', { features: {} })).toBe(false);
    // Caps not known yet (a switch of agent or account in flight): not offered.
    expect(ultraOffered('claude', undefined)).toBe(false);
    // Never Codex or OpenCode, whatever caps are around (the agent a chat just left included).
    expect(ultraOffered('codex', on)).toBe(false);
    expect(ultraOffered('opencode', on)).toBe(false);
    expect(ultraOffered(undefined, on)).toBe(false);
  });

  it('the chip, Alt+U and a switch just made follow that one rule, and a switch of agent or account forgets the switch', () => {
    const composer = read('src/features/composer/Composer.tsx');
    expect(composer).toMatch(/const ultraOffered = offersUltra\(choice\.provider, caps\);/);
    expect(composer).toMatch(/const ultra = ultraOffered && shownUltra\(/);
    expect(composer).toMatch(/if \(ultraOffered && ultraChord\(e, MAC\)\)/);
    expect(composer).toMatch(/\{ultraOffered && <UltraChip /);
    expect(composer).toMatch(/const ultraKey = `\$\{choice\.provider\}\|\$\{choice\.accountId \?\? ''\}`;[\s\S]{0,200}if \(ultraPick\) setUltraPick\(null\);/);
  });

  it('sends what it always sent: a level, or ultracode on or off, never the two as one', () => {
    const composer = read('src/features/composer/Composer.tsx');
    // The switch goes to the bridge as `session.setUltracode` (home keeps it for the next chat).
    expect(composer).toMatch(/void setUltracode\(sessionId, on\)/);
    expect(composer).toMatch(/if \(!sessionId\) return setHomeUltracode\(on\);/);
    // The chip and the key call that one switch; the phrase's handle steps levels only.
    expect(composer).toMatch(/<UltraChip on=\{ultra\} onToggle=\{toggleUltra\}/);
    expect(composer).toMatch(/if \(!e\.repeat\) toggleUltra\(!ultra\);/);
    expect(read('src/features/composer/Phrase.tsx')).not.toMatch(/'Ultracode'\s*:|onUltracode\(false\)|word = [^;]*Ultracode/);
  });
});

describe('the keys', () => {
  const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

  it('from the field, Alt with the side arrows steps the level; nothing else does', () => {
    expect(levelChord(key('ArrowRight', { altKey: true }), false)).toBe(1);
    expect(levelChord(key('ArrowLeft', { altKey: true }), false)).toBe(-1);
    // Alt+Up and Down are the navigator's; Ctrl+Shift+Up and Down select in the field; plain arrows move the caret.
    expect(levelChord(key('ArrowUp', { altKey: true }), false)).toBeNull();
    expect(levelChord(key('ArrowDown', { altKey: true }), false)).toBeNull();
    expect(levelChord(key('ArrowUp', { ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(levelChord(key('ArrowRight'), false)).toBeNull();
    expect(levelChord(key('ArrowRight', { altKey: true, shiftKey: true }), false)).toBeNull();
    expect(levelChord(key('ArrowRight', { altKey: true, ctrlKey: true }), false)).toBeNull();
    // On a Mac Option with an arrow moves by word: there it is Command+Option.
    expect(levelChord(key('ArrowRight', { altKey: true }), true)).toBeNull();
    expect(levelChord(key('ArrowRight', { altKey: true, metaKey: true }), true)).toBe(1);
    expect([chordKeys(false), chordKeys(true)]).toEqual(['alt+←→', 'mod+alt+←→']);
  });

  it('Alt+U switches ultracode (Command+Option+U on a Mac), read by the letter or by the key’s place', () => {
    expect(ultraChord(key('u', { altKey: true }), false)).toBe(true);
    expect(ultraChord(key('U', { altKey: true }), false)).toBe(true);
    // Plain U types; with Shift, Ctrl or Command it is another key.
    expect(ultraChord(key('u'), false)).toBe(false);
    expect(ultraChord(key('u', { altKey: true, shiftKey: true }), false)).toBe(false);
    expect(ultraChord(key('u', { altKey: true, ctrlKey: true }), false)).toBe(false);
    expect(ultraChord(key('u', { ctrlKey: true }), false)).toBe(false);
    // Another letter is another key, also where it stands on U's place (a layout that moves the letters).
    expect(ultraChord({ ...key('g', { altKey: true }), code: 'KeyU' }, false)).toBe(false);
    expect(ultraChord({ ...key('u', { altKey: true }), code: 'KeyF' }, false)).toBe(true);
    // A Mac: Option+U is a dead key (it types no letter), so the key's place says it; Command+Option.
    expect(ultraChord({ ...key('Dead', { altKey: true, metaKey: true }), code: 'KeyU' }, true)).toBe(true);
    expect(ultraChord({ ...key('Dead', { altKey: true }), code: 'KeyU' }, true)).toBe(false);
    expect(ultraChord(key('u', { altKey: true }), true)).toBe(false);
    expect([ultraKeys(false), ultraKeys(true)]).toEqual(['alt+u', 'mod+alt+u']);
    // It shares its modifier with the level's chord and never its key.
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) expect(ultraChord(key(k, { altKey: true }), false)).toBe(false);
    expect(levelChord(key('u', { altKey: true }), false)).toBeNull();
  });

  it('Alt+U is free: no other key of the app is a U, and Alt is taken only with digits and arrows', () => {
    const files = ['src/app/App.tsx', 'src/features/session/FindBar.tsx', 'src/features/timeline/Navigator.tsx', 'src/features/session/QuickSwitch.tsx', 'src/features/prompts/keys.ts', 'src/state/hooks.ts'];
    for (const f of files) expect(read(f)).not.toMatch(/['"]mod\+(?:alt\+)?u['"]|=== 'u'|KeyU/);
    // The side panel's tabs are Alt with a digit.
    expect(read('src/app/App.tsx')).toMatch(/\/\^Digit\[1-8\]\$\/\.test\(e\.code\)/);
  });

  it('takes nothing from the navigator, the find bar, the prompt cards or the field', () => {
    // The navigator and the find bar step with Alt+Up and Down; the navigator's index opens with Ctrl+G.
    expect(read('src/features/session/FindBar.tsx')).toMatch(/e\.altKey && !mod && !e\.shiftKey && \(e\.key === 'ArrowUp' \|\| e\.key === 'ArrowDown'\)/);
    expect(read('src/features/timeline/Navigator.tsx')).toContain("e.key.toLowerCase() === 'g'");
    // The prompt cards' keys never take a key with Alt.
    expect(read('src/features/prompts/keys.ts')).toMatch(/e\.repeat \|\| e\.altKey/);
    // The composer reads the chord in its field before anything else reads the key.
    const composer = read('src/features/composer/Composer.tsx');
    expect(composer.indexOf('levelChord(e, MAC)')).toBeGreaterThan(-1);
    expect(composer.indexOf('levelChord(e, MAC)')).toBeLessThan(composer.indexOf('if (menuOpen) {'));
  });

  it('Ctrl+. opens the panel (Command+. on a Mac), with no Shift needed on any layout', () => {
    expect(opensPanel(key('.', { ctrlKey: true }), false)).toBe(true);
    expect(opensPanel({ ...key(':', { ctrlKey: true }), code: 'Period' }, false)).toBe(true);
    expect(opensPanel(key('.', { ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(opensPanel(key('.'), false)).toBe(false);
    expect(opensPanel(key('.', { metaKey: true }), true)).toBe(true);
    expect(opensPanel(key('.', { ctrlKey: true }), true)).toBe(false);
  });

  // A chat's panel above the phrase: six rows of models on top (Demo Large in use at row 4), a
  // hairline, three speeds (Standard in use), and the effort slider nearest the phrase.
  const shape: Shape = { side: 'top', models: 6, scale: 1, speeds: 3, current: 4, speed: 0 };

  it('the blocks stand as on screen: the slider nearest the phrase, then the speeds, then the models', () => {
    expect(blocks(shape)).toEqual(['models', 'speeds', 'scale']);
    expect(blocks({ ...shape, side: 'bottom' })).toEqual(['scale', 'speeds', 'models']);
    // A model with one level or none: its track is there but takes no focus; an agent with no speeds has no row of them.
    expect(blocks({ ...shape, scale: 0, speeds: 0 })).toEqual(['models']);
  });

  it('Up and Down move through the models and on into the block next on screen, stopping at the panel’s ends', () => {
    expect(navigate({ col: 'models', i: 2 }, 'ArrowDown', false, shape)).toEqual({ col: 'models', i: 3 });
    // From the last model down into the speeds (on the one in use), then the slider, the panel's end.
    expect(navigate({ col: 'models', i: 5 }, 'ArrowDown', false, { ...shape, speed: 2 })).toEqual({ col: 'speeds', i: 2 });
    expect(navigate({ col: 'speeds', i: 1 }, 'ArrowDown', false, shape)).toEqual({ col: 'scale', i: 0 });
    expect(navigate({ col: 'scale', i: 0 }, 'ArrowDown', false, shape)).toBeNull();
    // And back up: the speeds, then the last model; the first model is the far end.
    expect(navigate({ col: 'scale', i: 0 }, 'ArrowUp', false, shape)).toEqual({ col: 'speeds', i: 0 });
    expect(navigate({ col: 'speeds', i: 1 }, 'ArrowUp', false, shape)).toEqual({ col: 'models', i: 5 });
    expect(navigate({ col: 'models', i: 0 }, 'ArrowUp', false, shape)).toBeNull();
    // Below the phrase (home) the slider comes first: down into the speeds, then the first model.
    const home: Shape = { ...shape, side: 'bottom' };
    expect(navigate({ col: 'scale', i: 0 }, 'ArrowDown', false, home)).toEqual({ col: 'speeds', i: 0 });
    expect(navigate({ col: 'speeds', i: 0 }, 'ArrowDown', false, home)).toEqual({ col: 'models', i: 0 });
    expect(navigate({ col: 'models', i: 0 }, 'ArrowUp', false, home)).toEqual({ col: 'speeds', i: 0 });
    expect(navigate({ col: 'scale', i: 0 }, 'ArrowUp', false, home)).toBeNull();
    // No speeds: from the last model straight into the slider.
    expect(navigate({ col: 'models', i: 5 }, 'ArrowDown', false, { ...shape, speeds: 0 })).toEqual({ col: 'scale', i: 0 });
  });

  it('the scale keeps its own keys: Left, Right, Home, End and the page keys; the panel moves it by none of them', () => {
    for (const k of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']) {
      expect(scaleKey(k)).toBe(true);
      expect(navigate({ col: 'scale', i: 0 }, k, false, shape)).toBeNull();
    }
    expect(scaleKey('ArrowUp')).toBe(false);
    expect(scaleKey('ArrowDown')).toBe(false);
  });

  it('the speeds are one row: Left and Right move along it and stop at its ends', () => {
    expect(navigate({ col: 'speeds', i: 0 }, 'ArrowRight', false, shape)).toEqual({ col: 'speeds', i: 1 });
    expect(navigate({ col: 'speeds', i: 2 }, 'ArrowRight', false, shape)).toBeNull();
    expect(navigate({ col: 'speeds', i: 1 }, 'ArrowLeft', false, shape)).toEqual({ col: 'speeds', i: 0 });
    expect(navigate({ col: 'speeds', i: 0 }, 'ArrowLeft', false, shape)).toBeNull();
    expect(navigate({ col: 'speeds', i: 1 }, 'Home', false, shape)).toEqual({ col: 'speeds', i: 0 });
    expect(navigate({ col: 'speeds', i: 1 }, 'End', false, shape)).toEqual({ col: 'speeds', i: 2 });
    // Left and Right in the models move nothing.
    expect(navigate({ col: 'models', i: 2 }, 'ArrowRight', false, shape)).toBeNull();
  });

  it('Tab goes slider, speeds, models and round, landing on the speed and the model in use; Shift+Tab back', () => {
    expect(navigate({ col: 'scale', i: 0 }, 'Tab', false, shape)).toEqual({ col: 'speeds', i: 0 });
    expect(navigate({ col: 'scale', i: 0 }, 'Tab', false, { ...shape, speed: 2 })).toEqual({ col: 'speeds', i: 2 });
    expect(navigate({ col: 'speeds', i: 1 }, 'Tab', false, shape)).toEqual({ col: 'models', i: 4 });
    expect(navigate({ col: 'models', i: 2 }, 'Tab', false, shape)).toEqual({ col: 'scale', i: 0 });
    expect(navigate({ col: 'scale', i: 0 }, 'Tab', true, shape)).toEqual({ col: 'models', i: 4 });
    // No speeds, and a model with no scale: the models alone.
    expect(navigate({ col: 'scale', i: 0 }, 'Tab', false, { ...shape, speeds: 0 })).toEqual({ col: 'models', i: 4 });
    expect(navigate({ col: 'models', i: 1 }, 'Tab', false, { ...shape, speeds: 0, scale: 0 })).toBeNull();
  });

  it('Home and End: the first and the last model', () => {
    expect(navigate({ col: 'models', i: 2 }, 'Home', false, shape)).toEqual({ col: 'models', i: 0 });
    expect(navigate({ col: 'models', i: 2 }, 'End', false, shape)).toEqual({ col: 'models', i: 5 });
    expect(navigate({ col: 'models', i: 0 }, 'Home', false, shape)).toBeNull();
  });

  it('a digit picks a level, 1 the lowest', () => {
    expect(digitLevel('1', 5)).toBe(0);
    expect(digitLevel('5', 5)).toBe(4);
    expect(digitLevel('6', 5)).toBeNull();
    expect(digitLevel('0', 5)).toBeNull();
    expect(digitLevel('a', 5)).toBeNull();
  });

  it('Escape gives the keyboard back to the phrase when the keys opened the panel there, else it goes on to the field', () => {
    expect(returnsToTrigger('keys', true)).toBe(true);
    // A pick (or a click outside) after the keys opened it: on to the field, to go on typing.
    expect(returnsToTrigger('keys', false)).toBe(false);
    // Opened by a click, or from the field (Ctrl+., /model, /effort): the field, also on Escape.
    expect(returnsToTrigger('pointer', true)).toBe(false);
    expect(returnsToTrigger('field', true)).toBe(false);
    expect(returnsToTrigger('field', false)).toBe(false);
  });
});

describe('the panel hangs flush with the phrase', () => {
  it('its right edge on the phrase’s right edge, whatever the phrase’s width', () => {
    // Radix puts the panel's left edge `alignOffset` right of the chip's left edge (align="start").
    for (const chip of [81, 172, 288, 340]) {
      const left = 600;
      const panelLeft = left + flushRight(chip, 288);
      expect(panelLeft + 288).toBe(left + chip);
    }
    expect(flushRight(288, 288)).toBe(0);
  });

  it('the phrase is as wide as its words and holds its right end, so the panel hangs flush from it in every frame', () => {
    const css = read('src/features/composer/composer.css');
    // Tight at every level: the dot is one fixed gap, nothing stretches, no slot sized by the longest level.
    expect(css).toMatch(/\n\.ph-dot \{\n  flex: none;\n  justify-content: center;\n  width: 15px;/);
    expect(css).not.toMatch(/\.ph-size|\.ph-words|justify-self: stretch;\n  gap: 0;/);
    expect(css).not.toMatch(/\n\.ph-word \{\n  margin-left: auto;/);
    const phrase = read('src/features/composer/Phrase.tsx');
    expect(phrase).not.toContain('ph-size');
    // The right end is the one that holds, and the panel hangs from it (Radix align="end").
    expect(phrase).toMatch(/className="tb-chip ph"\s+anchor="right"\s+data-glide="reel"/);
    expect(phrase).toMatch(/align="end"\s*sideOffset=\{place\.sideOffset\}\s*alignOffset=\{0\}/);
    // The dot stays when the level changes (it glides with the name; only the word rolls).
    expect(phrase).toContain("k: 'dot', className: 'ph-dot'");
  });
});

describe('the gliding pill has no seam', () => {
  it('its two windows meet on a whole CSS pixel that is a whole device pixel, 16 to 24 px into the chip', () => {
    for (const k of [1, 1.25, 1.5, 1.75, 2]) {
      for (const end of [914.375, 1056, 803.7, 640.015625]) {
        for (const dir of [-1, 1] as const) {
          const cap = Number(capOn(end, dir, k));
          const line = end + dir * cap;
          expect(cap).toBeGreaterThanOrEqual(16);
          expect(cap).toBeLessThanOrEqual(24);
          expect(Math.abs(line - Math.round(line))).toBeLessThan(1e-6);
          expect(Math.abs(line * k - Math.round(line * k))).toBeLessThan(1e-3);
        }
      }
    }
    // A whole line at a whole scale: the cap stays 20.
    expect(capOn(1056, -1, 1.25)).toBe('20.000000');
  });
});

describe('a word that changes by direction rolls like a reel', () => {
  const at = (frames: Keyframe[], p: number) => {
    // Linear between the keyframes around p (the animation's easing is one curve for both words).
    const pts = frames.map((f, i) => ({ o: (f.offset as number | undefined) ?? i / (frames.length - 1), y: Number(/translateY\((-?[\d.]+)px\)/.exec(String(f.transform))![1]), a: Number(f.opacity) }));
    const j = Math.max(1, pts.findIndex((q) => q.o >= p));
    const [a, b] = [pts[j - 1], pts[j]];
    const k = (p - a.o) / (b.o - a.o || 1);
    return { y: a.y + (b.y - a.y) * k, a: a.a + (b.a - a.a) * k };
  };

  it('the old word and the new one stay one line apart all the way: they never share a pixel', () => {
    for (const way of [-1, 1] as const) {
      const r = reel(way);
      for (let p = 0; p <= 1.0001; p += 0.05) {
        const out = at(r.out, Math.min(1, p));
        const inn = at(r.in, Math.min(1, p));
        expect(Math.abs(out.y - inn.y)).toBeCloseTo(ROLL_PX, 5);
        // Up: the old one leaves upward (negative y), the new one comes from below.
        if (p > 0 && p < 1) expect(Math.sign(out.y)).toBe(way);
      }
      // A line is taller than a word at the bar's size (13 px text, ascender to descender).
      expect(ROLL_PX).toBeGreaterThanOrEqual(14);
    }
  });

  it('the place is never empty and never holds two whole words', () => {
    const r = reel(-1);
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const out = at(r.out, Math.min(1, p));
      const inn = at(r.in, Math.min(1, p));
      // Together they are one word's worth of ink at every moment of the handover.
      expect(out.a + inn.a).toBeCloseTo(1, 5);
    }
    expect(at(r.in, 1)).toEqual({ y: 0, a: 1 });
    expect(at(r.out, 0)).toEqual({ y: 0, a: 1 });
  });

  it('a step while the last word still rolls in sends it on from where it stands: no jump, no empty place, no shared pixel', () => {
    // The pose worked out from the roll's own start agrees with the keyframes at that point of the curve.
    for (const ms of [0, 17, 40, 70, 100, ROLL_MS]) {
      const p = rollAt(ms);
      const pose = inPose(-1, ms);
      const k = at(reel(-1).in, p);
      expect(pose.y).toBeCloseTo(k.y, 5);
      expect(pose.opacity).toBeCloseTo(k.a, 5);
    }
    expect(rollAt(0)).toBe(0);
    expect(rollAt(ROLL_MS)).toBe(1);
    // Three steps 70 ms apart, either way after either way.
    for (const prev of [-1, 1] as const)
      for (const way of [-1, 1] as const) {
        const from = inPose(prev, 70);
        const out = reelFrom(way, from);
        // It starts exactly where the word stood and as much of it showed: nothing jumps or blinks.
        expect(at(out, 0)).toEqual({ y: Number(from.y.toFixed(2)), a: from.opacity });
        expect(from.opacity).toBe(1);
        const inn = reel(way).in;
        for (let p = 0; p <= 1.0001; p += 0.05) {
          const o = at(out, Math.min(1, p));
          const n = at(inn, Math.min(1, p));
          // While both show, they stay more than a word's height apart (13 px text: about 12.5 from cap to descender).
          if (o.a > 0.02 && n.a > 0.02) expect(Math.abs(o.y - n.y)).toBeGreaterThan(12.5);
          // One word's worth of ink at most, and never nothing while the old one still shows.
          expect(o.a + n.a).toBeGreaterThan(0.99);
        }
      }
  });
});

describe('small truths on the pane', () => {
  it('a text attachment says how long it is in words that agree', () => {
    expect(linesOf('one')).toBe('1 line');
    expect(linesOf('one\n')).toBe('1 line');
    expect(linesOf('one\ntwo')).toBe('2 lines');
    expect(linesOf('a\nb\nc\n')).toBe('3 lines');
    expect(linesOf('')).toBe('1 line');
  });

  it('the question before a paid speed keeps the speed’s name', () => {
    expect(askLine('Fast')).toBe('Fast · Billed as extra usage');
  });
});

describe('the panel: one column, the models nearest the phrase, no empty band', () => {
  it('lists every agent’s models, a header per agent (the first one too) once there are several', () => {
    // Four models of the chat's agent alone: four rows.
    expect(listRows(4, [])).toBe(4);
    // With Codex (six) and OpenCode (none listed): the two agents' models and two headers.
    expect(listRows(4, [6, 0])).toBe(12);
    expect(listRows(4, [6, 3])).toBe(16);
  });

  it('is as tall as its list is now, scrolling past twelve rows, never less than one row', () => {
    expect(panelRows(4)).toBe(4);
    expect(panelRows(30)).toBe(12);
    expect(panelRows(0)).toBe(1);
  });

  it('decides its side once, for the tallest it can come to (the slider’s row is always there)', () => {
    // Four models, a scale and speeds: 8 + 4 rows of 28 + the scale's 50, the speeds' 28 and 4 between, a separator of 8.
    expect(panelReach({ list: 4, scale: true, speeds: true })).toBe(8 + 4 * 28 + 50 + 4 + 28 + 8);
    // No scale at any model and no speeds: the list alone.
    expect(panelReach({ list: 4, scale: false, speeds: false })).toBe(8 + 4 * 28);
    expect(panelReach({ list: 30, scale: true, speeds: false })).toBe(8 + 12 * 28 + 50 + 8);
  });

  it('is one column: every model row led by its agent’s mark, the check at the end of the model in use', () => {
    const src = read('src/features/composer/Phrase.tsx');
    expect(src).not.toMatch(/Ultracode<|data-uc|SwitchLook|mx-rung|mx-scale|mx-agent|aimsAt/);
    // Every row: the mark, the name, and the check (or, for another agent's model while the chat works, why it waits).
    expect(src).toMatch(/<ProviderMark provider=\{provider\} size=\{14\} className="mm-mark" \/>\n\s+<span className="mm-name truncate">/);
    expect(src).toMatch(/<span className="mm-check">\{current && <Icon name="check" size=\{14\} \/>\}<\/span>/);
    expect(src).toMatch(/<span className="mx-why">After this turn<\/span>/);
    // The effort is the slider of stops; the speeds are one segmented row.
    expect(src).toMatch(/<Slider stops=\{stopNames\} value=\{scaleAt\} onChange=\{slide\} onCommit=\{land\}/);
    expect(src).toMatch(/className="seg mx-speeds"/);
    // Nearest the phrase what is set for the model (above it: at the bottom), beyond a hairline the list.
    expect(src).toMatch(/\{place\.side !== 'top' && settings\}[\s\S]*\{listView\}[\s\S]*\{place\.side === 'top' && settings\}/);
    // The slider's row is always there: a model with one level or none shows the disabled track.
    expect(src).toMatch(/<Slider stops=\{NO_STOPS\} value=\{0\} onChange=\{\(\) => \{\}\} label=\{`\$\{name\} has no effort levels`\} className="mx-slider" disabled \/>/);
    expect(read('src/styles/ui.css')).toMatch(/\.seg-pill \{[^}]*background-color: var\(--fill-3\);\n  box-shadow: var\(--press-up\);/s);
  });
});

describe('a model picked while the chat works', () => {
  it('is due from the next message while the turn that began on another model runs', () => {
    expect(modelDue(true, true, 'demo-large', 'demo-deep')).toBe(true);
    // The model the turn runs on, the chat at rest, or a turn whose start this window never saw: nothing to say.
    expect(modelDue(true, true, 'demo-large', 'demo-large')).toBe(false);
    expect(modelDue(false, true, 'demo-large', 'demo-deep')).toBe(false);
    expect(modelDue(true, false, undefined, 'demo-deep')).toBe(false);
    // A turn that began with no model named (the agent's default) and a model picked since.
    expect(modelDue(true, true, undefined, 'demo-deep')).toBe(true);
  });

  it('says so on the bar in the waiting tone, with the tooltip', () => {
    const src = read('src/features/composer/Phrase.tsx');
    expect(src).toMatch(/const tip = due \? 'From your next message' :/);
    expect(src).toMatch(/<span className="ph-name" data-due=\{due \? '' : undefined\}>/);
    expect(read('src/features/composer/composer.css')).toMatch(/\.ph-name\[data-due\] \{\n  opacity: 0\.6;/);
  });
});

describe('a narrow pane sheds in order', () => {
  const css = read('src/features/composer/composer.css');
  const at = (w: number) => {
    const from = css.indexOf(`@container cmp (max-width: ${w}px) {`);
    return css.slice(from, css.indexOf('\n}\n', from) + 3);
  };

  it('first ultracode keeps its mark alone: on, a disc that is on', () => {
    expect(at(520)).toMatch(/\.ux > \.ux-word \{\n    display: none;/);
    expect(at(520)).toMatch(/\.ux\[data-on\] \{\n    width: 28px;\n    padding: 0;/);
    // The mark itself never goes.
    expect(css).not.toMatch(/\.ux(\[data-on\])? \{[^}]*display: none/);
    expect(at(520)).not.toMatch(/ux-mark|ph-/);
  });

  it('at 400 px the model’s name and the dot go and the level’s word stays', () => {
    expect(at(400)).toMatch(/\.ph\[data-word\] > :is\(\.ph-model, \.ph-dot\) \{\n    display: none;/);
    expect(at(400)).not.toContain('ph-word');
  });

  it('at 330 px the mode keeps only its icon; the cove and the key never change', () => {
    expect(at(330)).toMatch(/\.cm-mode > \.cm-mode-label \{\n    display: none;/);
    expect(css.indexOf('@container cmp (max-width: 520px)')).toBeLessThan(css.indexOf('@container cmp (max-width: 400px)'));
    expect(css.indexOf('@container cmp (max-width: 400px)')).toBeLessThan(css.indexOf('@container cmp (max-width: 330px)'));
    for (const w of [520, 400, 330]) expect(at(w)).not.toMatch(/cmp-send|cmp-keys|cove/);
  });

  it('no part of the old scale is left: no pips, no drag, no ladder', () => {
    expect(css).not.toMatch(/\.th-(chip|pips|word|pop|row|seg)/);
    expect(read('src/features/composer/Phrase.tsx')).not.toMatch(/setPointerCapture|scrub|onPointerUp=/);
  });
});

describe('a speed billed outside the plan', () => {
  const model: ModelInfo = {
    id: 'm',
    name: 'M',
    speeds: [
      { id: 'priority', name: 'Fast' },
      { id: 'fast', name: 'Fast', note: 'Extra usage', paid: true },
    ],
  };
  const claude: ModelInfo = { id: 'opus', name: 'Opus', speeds: [{ id: 'fast', name: 'Fast', paid: true }] };

  it('is offered only with extra usage on', () => {
    expect(offeredSpeeds(model, false).map((s) => s.id)).toEqual(['priority']);
    expect(offeredSpeeds(model, undefined).map((s) => s.id)).toEqual(['priority']);
    expect(offeredSpeeds(model, true).map((s) => s.id)).toEqual(['priority', 'fast']);
  });

  it('is never a default, and a saved one starts a session at standard', () => {
    expect(defaultableSpeeds(model).map((s) => s.id)).toEqual(['priority']);
    expect(startSpeedFor(claude, 'fast')).toBe('standard');
    expect(startSpeedFor(model, 'priority')).toBe('priority');
  });

  it('/fast toggles only what is offered', () => {
    expect(toggledSpeed(claude, 'standard', offeredSpeeds(claude, false))).toBe('standard');
    expect(toggledSpeed(claude, 'standard', offeredSpeeds(claude, true))).toBe('fast');
    expect(toggledSpeed(claude, 'fast', offeredSpeeds(claude, true))).toBe('standard');
  });
});
