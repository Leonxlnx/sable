import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHONE_OWN_METHODS, type TimelineItem, type ToolItem, type UserItem } from '../shared/protocol';
import {
  AUTO_GRACE_MS,
  STEER_AFTER,
  countdown,
  firstAutoAt,
  foregroundSteps,
  steerAfterChoice,
  steerAfterMs,
  steerWaitLine,
  steerWaitSpoken,
  waitedRoom,
  waitReason,
  waitedWords,
  waitingOn,
  waitsAsSteer,
} from '../src/features/timeline/steer-wait';
import { takenInPlace } from '../src/features/timeline/user-card';

const T0 = 1_800_000_000_000;
const read = (file: string) => readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');

const tool = (id: string, over: Partial<ToolItem> = {}): ToolItem => ({ id, ts: T0, type: 'tool', name: 'Bash', kind: 'bash', title: `Run ${id}`, status: 'running', detail: {}, ...over });
const user = (id: string, over: Partial<UserItem> = {}): UserItem => ({ id, ts: T0, type: 'user', text: id, state: 'sent', ...over });
const steer = (over: Partial<UserItem> = {}): UserItem => user('steer', { steered: true, state: 'queued', ...over });

/** A conversation as the stores hold it: the items by id and the roots in order. */
function chat(list: TimelineItem[]) {
  const map = new Map(list.map((it) => [it.id, it]));
  return { item: (id: string) => map.get(id), roots: list.filter((it) => !it.parentId).map((it) => it.id) };
}

describe('the card a waiting line stands under', () => {
  it('is a root message steered into a turn that the agent has not taken', () => {
    expect(waitsAsSteer(steer())).toBe(true);
    expect(waitsAsSteer(steer({ state: 'sent' }))).toBe(false);
    expect(waitsAsSteer(user('queued', { state: 'queued' }))).toBe(false);
    expect(waitsAsSteer(steer({ parentId: 'agent' }))).toBe(false);
    expect(waitsAsSteer(tool('t'))).toBe(false);
    expect(waitsAsSteer(undefined)).toBe(false);
  });
});

describe('what a steer waits on', () => {
  it('names the root steps under way in the running turn, the newest first', () => {
    const c = chat([
      user('old'),
      tool('before', { status: 'running' }),
      { id: 'end', ts: T0, type: 'turn' } as TimelineItem,
      user('ask'),
      tool('done', { status: 'done', endedAt: T0 + 5 }),
      tool('build', { ts: T0 + 10 }),
      tool('lint', { ts: T0 + 20, status: 'pending' }),
      tool('deploy', { ts: T0 + 30, status: 'awaiting' }),
      steer(),
    ]);
    expect(foregroundSteps(c.item, c.roots).map((s) => s.id)).toEqual(['deploy', 'lint', 'build']);
  });

  it('leaves out a turn check, work sent to the background, a command that outlived its step and a sub-agent’s own steps', () => {
    const c = chat([
      user('ask'),
      tool('check', { check: { turn: 'ask', agent: 'codex' } }),
      tool('agent-bg', { kind: 'agent', status: 'done', result: { agent: { background: 'running' } } }),
      tool('flow', { workflow: { status: 'running' } as ToolItem['workflow'] }),
      tool('server', { status: 'done', task: { id: 't', kind: 'command', state: 'running', since: T0 } as ToolItem['task'] }),
      tool('watch', { status: 'running', task: { id: 'w', kind: 'monitor', state: 'running', since: T0 } as ToolItem['task'] }),
      tool('agent', { kind: 'agent', title: 'Review the token refresh' }),
      tool('inner', { parentId: 'agent' }),
      steer(),
    ]);
    expect(foregroundSteps(c.item, c.roots).map((s) => s.id)).toEqual(['agent']);
  });

  it('stops at the newest message the agent took: nothing before it still runs in the foreground', () => {
    const c = chat([user('ask'), tool('stale'), user('taken', { steered: true }), tool('now'), steer()]);
    expect(foregroundSteps(c.item, c.roots).map((s) => s.id)).toEqual(['now']);
    // Messages that wait (queued, or steered and untaken) are no boundary.
    const d = chat([user('ask'), tool('build'), steer({ id: 'a' }), user('q', { state: 'queued' }), steer({ id: 'b' })]);
    expect(foregroundSteps(d.item, d.roots).map((s) => s.id)).toEqual(['build']);
  });

  it('puts the step the bridge names first, and trusts it over its own reading', () => {
    const c = chat([user('ask'), tool('build'), tool('lint'), steer()]);
    expect(waitingOn(c.item, c.roots).map((s) => s.id)).toEqual(['lint', 'build']);
    expect(waitingOn(c.item, c.roots, 'build').map((s) => s.id)).toEqual(['build', 'lint']);
    // A step the window would not have listed (it reads it as done): still the bridge's word.
    const d = chat([user('ask'), tool('agent', { status: 'done' }), steer()]);
    expect(waitingOn(d.item, d.roots, 'agent').map((s) => s.id)).toEqual(['agent']);
    // An id that names nothing here (a phone's page without it), or no step at all: the window's reading.
    expect(waitingOn(c.item, c.roots, 'gone').map((s) => s.id)).toEqual(['lint', 'build']);
    expect(waitingOn(c.item, c.roots, 'steer').map((s) => s.id)).toEqual(['lint', 'build']);
  });
});

describe('when the bridge sends by itself', () => {
  it('is the earliest time among the steers that wait: its send delivers them all', () => {
    const c = chat([
      user('ask'),
      tool('build'),
      steer({ id: 'a', steerWait: { stepId: 'build', autoAt: T0 + 30_000 } }),
      steer({ id: 'b', ts: T0 + 10_000, steerWait: { stepId: 'build', autoAt: T0 + 40_000 } }),
    ]);
    expect(firstAutoAt(c.item, c.roots)).toBe(T0 + 30_000);
    // The second card counts down to the first one's time, not to its own.
    const b = c.item('b') as UserItem;
    expect(steerWaitLine({ item: b, steps: [], autoAt: firstAutoAt(c.item, c.roots), now: T0 + 12_000 })).toMatchObject({ phase: 'countdown', clock: '0:18' });
    expect(steerWaitLine({ item: b, steps: [], now: T0 + 12_000 })).toMatchObject({ phase: 'countdown', clock: '0:28' });
  });

  it('is never, for steers the bridge sends only on a press, a taken one, or a turn before this one', () => {
    const never = chat([user('ask'), steer({ id: 'a', steerWait: { stepId: 'x' } }), steer({ id: 'b', steerWait: {} })]);
    expect(firstAutoAt(never.item, never.roots)).toBeUndefined();
    const taken = chat([user('ask'), steer({ id: 'a', state: 'sent', steerWait: { autoAt: T0 } }), steer({ id: 'b', steerWait: {} })]);
    expect(firstAutoAt(taken.item, taken.roots)).toBeUndefined();
    const earlier = chat([steer({ id: 'old', steerWait: { autoAt: T0 } }), { id: 'end', ts: T0, type: 'turn' } as TimelineItem, user('ask'), steer({ id: 'b', steerWait: { autoAt: T0 + 9 } })]);
    expect(firstAutoAt(earlier.item, earlier.roots)).toBe(T0 + 9);
  });

  it('counts for nothing on a card the bridge did not mark', () => {
    expect(steerWaitLine({ item: steer(), steps: [], autoAt: T0 + 30_000, now: T0 })).toMatchObject({ phase: 'waiting', action: false });
  });
});

describe('the clocks', () => {
  it('says a wait in the live line’s words, a whole minute with its seconds', () => {
    expect(waitedWords(400)).toBe('1s');
    expect(waitedWords(8_000)).toBe('8s');
    expect(waitedWords(130_000)).toBe('2m 10s');
    expect(waitedWords(3_900_000)).toBe('1h 5m');
    // Never "2m" for one second between "1m 59s" and "2m 1s": the clock would lose four characters and take them back.
    expect([119_000, 120_000, 121_000].map(waitedWords)).toEqual(['1m 59s', '2m 0s', '2m 1s']);
  });

  it('never differs from its room by more than one character within a minute or an hour', () => {
    for (let s = 1; s < 3600; s++) {
      const gap = waitedRoom(s * 1000).length - waitedWords(s * 1000).length;
      expect(gap === 0 || gap === 1).toBe(true);
    }
  });

  it('keeps room for the widest clock of its size, so the label beside it never moves within it', () => {
    for (let s = 1; s < 60; s++) expect(waitedWords(s * 1000).length).toBeLessThanOrEqual(waitedRoom(s * 1000).length);
    for (let s = 60; s < 600; s += 7) expect(waitedWords(s * 1000).length).toBeLessThanOrEqual(waitedRoom(s * 1000).length);
    for (let s = 600; s < 3600; s += 31) expect(waitedWords(s * 1000).length).toBeLessThanOrEqual(waitedRoom(s * 1000).length);
    for (let s = 3600; s < 400_000; s += 1777) expect(waitedWords(s * 1000).length).toBeLessThanOrEqual(waitedRoom(s * 1000).length);
    expect([waitedRoom(9_000), waitedRoom(59_400), waitedRoom(60_000), waitedRoom(599_000), waitedRoom(600_000), waitedRoom(3_600_000)]).toEqual(['59s', '59s', '9m 59s', '9m 59s', '59m 59s', '9h 59m']);
  });

  it('counts down in minutes and seconds, a started second counting whole', () => {
    expect(countdown(30_000)).toBe('0:30');
    expect(countdown(23_400)).toBe('0:24');
    expect(countdown(114_000)).toBe('1:54');
    expect(countdown(1)).toBe('0:01');
    expect(countdown(0)).toBe('0:00');
    expect(countdown(-5)).toBe('0:00');
  });
});

describe('the line under a waiting steer', () => {
  const build = { title: 'Run the build', ts: T0 - 130_000 };

  it('waiting on a known step: its title and its own time, and Send now where the bridge can interrupt', () => {
    const line = steerWaitLine({ item: steer({ steerWait: { stepId: 'build' } }), steps: [build], now: T0 });
    expect(line).toEqual({ phase: 'waiting', why: '', label: 'Waiting for Run the build', clock: '2m 10s', room: '9m 59s', action: true, disabled: false, cost: 'Interrupts the running step' });
    expect(steerWaitSpoken(line)).toBe('Waiting for Run the build 2m 10s');
  });

  it('waiting on several steps: the one named and how many more', () => {
    const line = steerWaitLine({ item: steer({ steerWait: {} }), steps: [build, { title: 'Lint', ts: T0 }, { title: 'Test', ts: T0 }], now: T0 });
    expect(line.label).toBe('Waiting for Run the build and 2 more');
    expect(line.cost).toBe('Interrupts the running steps');
  });

  it('waiting with no step known: the agent’s next step, and how long the message has waited', () => {
    const line = steerWaitLine({ item: steer({ ts: T0 - 12_000, steerWait: {} }), steps: [], agent: 'Claude Code', now: T0 });
    expect(line).toMatchObject({ phase: 'waiting', label: 'Waiting for Claude Code’s next step', clock: '12s', room: '59s', action: true, disabled: false, cost: 'Interrupts what the agent is doing' });
    expect(steerWaitLine({ item: steer({ steerWait: {} }), steps: [], now: T0 }).label).toBe('Waiting for the next step');
    // In its first second there is no figure yet.
    expect(steerWaitLine({ item: steer({ steerWait: {} }), steps: [], now: T0 + 400 })).toMatchObject({ clock: '', room: '' });
    // A step with an empty title still reads as a sentence.
    expect(steerWaitLine({ item: steer(), steps: [{ title: ' ', ts: T0 }], now: T0 }).label).toBe('Waiting for the running step');
  });

  it('offers no action where the bridge did not mark the steer (another agent, or the mark cleared)', () => {
    for (const steerWait of [undefined, null]) {
      const line = steerWaitLine({ item: steer({ steerWait }), steps: [build], now: T0 });
      expect(line).toMatchObject({ phase: 'waiting', label: 'Waiting for Run the build', action: false });
    }
  });

  it('counts down to the bridge’s own send, and keeps the action', () => {
    const item = steer({ steerWait: { stepId: 'build', autoAt: T0 + 30_000 } });
    expect(steerWaitLine({ item, steps: [build], now: T0 + 6_000 })).toEqual({ phase: 'countdown', why: '', label: 'Sends in', clock: '0:24', room: '0:24', action: true, disabled: false, cost: 'Interrupts the running step' });
    expect(steerWaitLine({ item, steps: [build], now: T0 + 29_999 }).clock).toBe('0:01');
    expect(steerWaitSpoken(steerWaitLine({ item, steps: [build], now: T0 + 6_000 }))).toBe('Sends in 0:24');
  });

  it('says Sending once the bridge’s time has come, and takes no press meanwhile', () => {
    const item = steer({ steerWait: { autoAt: T0 + 30_000 } });
    for (const now of [T0 + 30_000, T0 + 31_000, T0 + 30_000 + AUTO_GRACE_MS - 1]) {
      expect(steerWaitLine({ item, steps: [build], now })).toMatchObject({ phase: 'sending', label: 'Sending', clock: '', action: true, disabled: true });
    }
    // "At once" (1 ms): on its way from the first frame.
    expect(steerWaitLine({ item: steer({ steerWait: { autoAt: T0 + 1 } }), steps: [], now: T0 + 16 }).phase).toBe('sending');
  });

  it('never stays on Sending: a send of the bridge’s that did not deliver gives the line and the action back', () => {
    const item = steer({ steerWait: { autoAt: T0 + 30_000 } });
    const line = steerWaitLine({ item, steps: [build], now: T0 + 30_000 + AUTO_GRACE_MS });
    expect(line).toMatchObject({ phase: 'waiting', label: 'Waiting for Run the build', action: true, disabled: false });
  });

  it('says Sending while the person’s own press is with the bridge, whatever the clock says', () => {
    const waiting = steerWaitLine({ item: steer({ steerWait: {} }), steps: [build], now: T0, sending: true });
    expect(waiting).toMatchObject({ phase: 'sending', label: 'Sending', clock: '', room: '', action: true, disabled: true });
    const counting = steerWaitLine({ item: steer({ steerWait: { autoAt: T0 + 30_000 } }), steps: [build], now: T0 + 1000, sending: true });
    expect(counting).toMatchObject({ phase: 'sending', disabled: true });
  });

  it('a refused press brings back what the card says now', () => {
    const item = steer({ steerWait: { autoAt: T0 + 30_000 } });
    expect(steerWaitLine({ item, steps: [build], now: T0 + 2_000, sending: false })).toMatchObject({ phase: 'countdown', clock: '0:28', disabled: false });
  });

  it('a wait with no time of its own (never by itself, a time that is no number) just waits', () => {
    for (const autoAt of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(steerWaitLine({ item: steer({ steerWait: { autoAt } }), steps: [build], now: T0 }).phase).toBe('waiting');
    }
  });
});

describe('why a steer still waits', () => {
  const build = { title: 'Run the build', ts: T0 - 130_000 };

  it('reads the bridge’s reason as one bounded line, and nothing where it gave none', () => {
    expect(waitReason({ reason: '  Claude did not\nconfirm   withdrawal. ' })).toBe('Claude did not confirm withdrawal.');
    for (const wait of [undefined, null, {}, { reason: '' }, { reason: '   ' }, { reason: 7 as unknown as string }]) expect(waitReason(wait)).toBe('');
    const long = waitReason({ reason: 'x'.repeat(400) });
    expect(long).toHaveLength(160);
    expect(long.endsWith('…')).toBe(true);
  });

  it('stands where the countdown stood when the bridge has no time of its own, and keeps Send now', () => {
    const line = steerWaitLine({ item: steer({ steerWait: { stepId: 'build', reason: 'Automatic interruption limit reached.' } }), steps: [build], now: T0 });
    expect(line).toEqual({ phase: 'held', why: 'Automatic interruption limit reached.', label: '', clock: '', room: '', action: true, disabled: false, cost: 'Interrupts the running step' });
    expect(steerWaitSpoken(line)).toBe('Automatic interruption limit reached.');
  });

  it('stands before the countdown while the bridge will try once more', () => {
    const item = steer({ steerWait: { stepId: 'build', autoAt: T0 + 60_000, reason: 'Claude did not confirm withdrawal.' } });
    const line = steerWaitLine({ item, steps: [build], now: T0 + 2_000 });
    expect(line).toMatchObject({ phase: 'countdown', why: 'Claude did not confirm withdrawal.', label: 'Sends in', clock: '0:58', action: true, disabled: false });
    expect(steerWaitSpoken(line)).toBe('Claude did not confirm withdrawal. Sends in 0:58');
  });

  it('shows no countdown without a time: a time that passed leaves the reason, never "Sends in"', () => {
    const item = steer({ steerWait: { autoAt: T0 + 30_000, reason: 'Claude did not confirm the turn ended.' } });
    expect(steerWaitLine({ item, steps: [build], now: T0 + 30_000 + AUTO_GRACE_MS })).toMatchObject({ phase: 'held', why: 'Claude did not confirm the turn ended.', label: '', clock: '' });
    for (const autoAt of [undefined, Number.NaN]) {
      expect(steerWaitLine({ item: steer({ steerWait: { autoAt, reason: 'Refused.' } }), steps: [], now: T0 })).toMatchObject({ phase: 'held', why: 'Refused.', clock: '' });
    }
  });

  it('is not said while the message is on its way', () => {
    const item = steer({ steerWait: { autoAt: T0 + 30_000, reason: 'Claude did not confirm withdrawal.' } });
    expect(steerWaitLine({ item, steps: [build], now: T0, sending: true })).toMatchObject({ phase: 'sending', why: '', label: 'Sending', disabled: true });
    expect(steerWaitLine({ item, steps: [build], now: T0 + 31_000 })).toMatchObject({ phase: 'sending', why: '', label: 'Sending' });
  });

  it('never borrows a sibling’s countdown once its own tries are spent: the bridge’s send leaves it out', () => {
    const c = chat([
      user('ask'),
      steer({ id: 'capped', steerWait: { stepId: 'build', reason: 'Automatic interruption limit reached.' } }),
      steer({ id: 'fresh', ts: T0 + 5_000, steerWait: { autoAt: T0 + 35_000 } }),
      steer({ id: 'retry', ts: T0 + 6_000, steerWait: { autoAt: T0 + 60_000, reason: 'Claude did not confirm withdrawal.' } }),
    ]);
    const first = firstAutoAt(c.item, c.roots);
    expect(first).toBe(T0 + 35_000);
    const at = (id: string) => steerWaitLine({ item: c.item(id) as UserItem, steps: [], autoAt: first, now: T0 + 10_000 });
    // The capped card keeps its reason and Send now, and shows no time, before and after the sibling's send.
    expect(at('capped')).toEqual({ phase: 'held', why: 'Automatic interruption limit reached.', label: '', clock: '', room: '', action: true, disabled: false, cost: 'Interrupts what the agent is doing' });
    expect(steerWaitLine({ item: c.item('capped') as UserItem, steps: [], autoAt: first, now: T0 + 36_000 })).toMatchObject({ phase: 'held', clock: '' });
    // Cards the send still takes count down to the earliest time: a plain one, and one with a reason and its own time.
    expect(at('fresh')).toMatchObject({ phase: 'countdown', why: '', clock: '0:25' });
    expect(at('retry')).toMatchObject({ phase: 'countdown', why: 'Claude did not confirm withdrawal.', clock: '0:25' });
  });

  it('is cut before the words and the clock after it are, on the desktop and on the phone', () => {
    const css = read('src/features/timeline/timeline.css');
    expect(css).toMatch(/\n\.steer-wait-why \{\s*min-width: 0;\s*\}/);
    expect(css).toMatch(/\n\.steer-wait-why \+ \.steer-wait-label \{\s*flex-shrink: 0;\s*\}/);
    const phone = read('mobile/src/styles/chat.css');
    expect(phone).toMatch(/\n\.steer-note-label\[data-why\] \+ \.steer-note-label \{\s*flex-shrink: 0;\s*\}/);
    const screen = read('mobile/src/screens/Timeline.tsx');
    expect(screen).toMatch(/\{line\.why && <span className="steer-note-label" data-why>\{line\.why\}<\/span>\}/);
    expect(screen).toMatch(/\{line\.label && <span className="steer-note-label">\{line\.label\}<\/span>\}/);
  });
});

describe('taken where it stands', () => {
  it('is a row that still shows the message waiting while the store says the agent has it', () => {
    expect(takenInPlace(true, steer({ state: 'sent' }))).toBe(true);
    expect(takenInPlace(true, steer({ state: undefined }))).toBe(true);
    // Still waiting, gone from the conversation, or a row that already shows it taken: no take.
    expect(takenInPlace(true, steer())).toBe(false);
    expect(takenInPlace(true, undefined)).toBe(false);
    expect(takenInPlace(false, steer({ state: 'sent' }))).toBe(false);
    // Only a message waits and is taken: a step under the same id is no take.
    expect(takenInPlace(true, tool('steer'))).toBe(false);
  });

  it('is read from the row, never from the store’s state before the write (its items change in place)', () => {
    const row = read('src/features/timeline/User.tsx');
    expect(row).toMatch(/takenInPlace\(queuedNow\.current, s\.data\[sessionId\]\?\.items\[item\.id\]\)/);
    expect(row).not.toMatch(/takenInPlace\(prev\./);
  });
});

describe('the row with the line', () => {
  const css = read('src/features/timeline/timeline.css');
  const px = (rule: RegExp, prop: string) => {
    const body = rule.exec(css)?.[1] ?? '';
    const m = new RegExp(`(?:^|[;{\\s])${prop}:\\s*(-?\\d+(?:\\.\\d+)?)px`).exec(body);
    if (!m) throw new Error(`no ${prop} in ${rule}`);
    return Number(m[1]);
  };
  const message = /\n\.tl-item\[data-t='user'\] \{([^}]*)\}/;
  const waiting = /\n\.tg > \.tl-item\[data-t='user'\]:has\(> \.user\[data-steered\]\[data-queued\]\) \{([^}]*)\}/;
  const line = /\n\.steer-wait \{([^}]*)\}/;

  it('is exactly as tall as the row the card has once the agent took it, so the take moves nothing but the card', () => {
    const taken = px(message, 'padding-top') + px(message, 'padding-bottom');
    const waits = px(waiting, 'padding-top') + px(line, 'margin-top') + px(line, 'height') + px(waiting, 'padding-bottom');
    expect(waits).toBe(taken);
    // The card stands one item's gap under what the turn shows last while it waits.
    expect(px(waiting, 'padding-top')).toBe(8);
  });

  it('keeps the chip at the line’s height and its words on the card’s edge', () => {
    const chip = /\n\.steer-now \{([^}]*)\}/;
    expect(px(chip, 'height')).toBe(px(line, 'height'));
    // Its right padding hangs past the card's edge by exactly itself.
    const pad = /padding:\s*0 (\d+)px 0 \d+px/.exec(chip.exec(css)?.[1] ?? '');
    expect(Number(pad?.[1])).toBe(-px(chip, 'margin-right'));
  });
});

describe('the phone', () => {
  it('may ask for it: phone.steerNow is one of the phone’s own methods', () => {
    expect(PHONE_OWN_METHODS).toContain('phone.steerNow');
  });

  it('draws the line from the same model and asks the desktop with the waiting card’s id, never with its words', () => {
    const screen = read('mobile/src/screens/Timeline.tsx');
    expect(screen).toMatch(/import \{[^}]*steerWaitLine[^}]*\} from '@desk\/features\/timeline\/steer-wait'/);
    expect(screen).toMatch(/\.call\('phone\.steerNow', \{ sessionId: sid, itemId: it\.id \}\)/);
    const note = screen.slice(screen.indexOf('function SteerNote('));
    const body = note.slice(0, note.indexOf('\n}\n'));
    expect(body).not.toMatch(/session\.send|queue\.sendNow/);
    // Its clock is the screen's own second, which waits while nobody looks.
    expect(body).toMatch(/useSecond\(true\)/);
    expect(screen).toMatch(/function useSecond[\s\S]{0,400}onScreen\(\) && setNow/);
  });

  it('gives Send now a 48 px target that ends where the bubble does', () => {
    const chat = read('mobile/src/styles/chat.css');
    const base = read('mobile/src/styles/base.css');
    const drawn = Number(/\n\.steer-now \{[^}]*?height: (\d+)px/.exec(chat)?.[1]);
    const reach = Number(/\n\.steer-now \{\s*--hit: -(\d+)px 0;/.exec(base)?.[1]);
    expect(drawn + 2 * reach).toBe(48);
    expect(base).toMatch(/\.steer-now::after\s*\{\s*content: '';/);
    // The row's gap under the bubble plus the line's own margin: as far up as the target reaches.
    const gap = Number(/\n\.user-row \{[^}]*?gap: (\d+)px/.exec(chat)?.[1]);
    const lift = Number(/\n\.steer-note \{[^}]*?margin-top: (\d+)px/.exec(chat)?.[1]);
    expect(gap + lift).toBeGreaterThanOrEqual(reach);
  });
});

describe('Settings: interrupt for a waiting message', () => {
  it('offers at once, 30 seconds, two minutes and never, and stores what the bridge reads', () => {
    expect(STEER_AFTER.map((o) => o.label)).toEqual(['At once', 'After 30 seconds', 'After 2 minutes', 'Never']);
    expect(STEER_AFTER.map((o) => steerAfterMs(o.id))).toEqual([1, 30_000, 120_000, 0]);
  });

  it('shows a stored value as its choice: absent is 30 seconds, zero is never, anything else the nearest', () => {
    expect(steerAfterChoice(undefined)).toBe('30s');
    expect(steerAfterChoice(Number.NaN)).toBe('30s');
    expect(steerAfterChoice(0)).toBe('never');
    expect(steerAfterChoice(-1)).toBe('never');
    expect(steerAfterChoice(1)).toBe('now');
    expect(steerAfterChoice(500)).toBe('now');
    expect(steerAfterChoice(30_000)).toBe('30s');
    expect(steerAfterChoice(45_000)).toBe('30s');
    expect(steerAfterChoice(120_000)).toBe('2m');
    expect(steerAfterChoice(600_000)).toBe('2m');
    for (const o of STEER_AFTER) expect(steerAfterChoice(o.ms)).toBe(o.id);
  });
});
