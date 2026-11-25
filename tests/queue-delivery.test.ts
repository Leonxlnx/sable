import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { QueuedMessage } from '../shared/protocol';
import { rowActs, rowDelivery } from '../src/features/composer/queue-rows';

const read = (file: string) => readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
const queued = (over: Partial<QueuedMessage> = {}): QueuedMessage => ({ id: 'q1', text: 'answer me', createdAt: 1, ...over });

describe('what a queued message says of its delivery', () => {
  it('a message the bridge issued and got no receipt for: its reason, Send again and Discard', () => {
    const d = rowDelivery(queued({ byHand: true, issuedUuid: 'u-1', steerWait: { reason: 'Issued to Claude. Receipt unknown.' } }));
    expect(d).toEqual({ reason: 'Issued to Claude. Receipt unknown.', again: true, hand: false });
    expect(rowActs(d, false)).toEqual({ send: 'Send again', remove: 'Discard' });
    // Also while a turn runs that takes a message now: it was sent before, so it is never "Steer now".
    expect(rowActs(d, true)).toEqual({ send: 'Send again', remove: 'Discard' });
  });

  it('a message from before the update, and one edited after an attempt, read the same way', () => {
    for (const reason of ['Delivery before the update was not confirmed.', 'Edited after the previous delivery attempt.']) {
      expect(rowDelivery(queued({ byHand: true, steerWait: { reason } }))).toEqual({ reason, again: true, hand: false });
    }
  });

  it('a message kept from a Spare wait is by hand with no reason: the hand mark, Send now and Remove', () => {
    const d = rowDelivery(queued({ byHand: true }));
    expect(d).toEqual({ reason: '', again: false, hand: true });
    expect(rowActs(d, false)).toEqual({ send: 'Send now', remove: 'Remove' });
  });

  it('a reason on a message the bridge still sends by itself is said, and nothing else changes', () => {
    const d = rowDelivery(queued({ steerWait: { reason: 'Claude confirmed withdrawal.' } }));
    expect(d).toEqual({ reason: 'Claude confirmed withdrawal.', again: false, hand: false });
    expect(rowActs(d, true)).toEqual({ send: 'Steer now', remove: 'Remove' });
  });

  it('a plain queued message says nothing', () => {
    for (const q of [queued(), queued({ steerWait: null }), queued({ steerWait: {} }), queued({ steerWait: { autoAt: 5 } })]) {
      expect(rowDelivery(q)).toEqual({ reason: '', again: false, hand: false });
    }
    expect(rowActs(rowDelivery(queued()), false)).toEqual({ send: 'Send now', remove: 'Remove' });
  });

  it('takes the reason as one bounded line (an error’s own text may be long)', () => {
    const d = rowDelivery(queued({ byHand: true, steerWait: { reason: `Refused:\n${'x'.repeat(400)}` } }));
    expect(d.reason).toHaveLength(160);
    expect(d.reason).not.toContain('\n');
  });
});

describe('the desktop’s tray row', () => {
  const tray = read('src/features/composer/QueueTray.tsx');
  const row = tray.slice(tray.indexOf('function Row('), tray.indexOf('/** An icon that grows a label pill'));

  it('says the reason after the words, in place of the hand mark, and in its accessible name', () => {
    expect(row).toMatch(/const delivery = rowDelivery\(q\);/);
    expect(row).toMatch(/\{delivery\.reason && \(\s*<span className="cq-why truncate" title=\{delivery\.reason\}>\s*\{delivery\.reason\}\s*<\/span>\s*\)\}/);
    expect(row).toMatch(/\{delivery\.hand && \(/);
    expect(row).not.toMatch(/\{q\.byHand && \(/);
    expect(row).toContain("${delivery.reason ? `${delivery.reason} ` : ''}Alt+Arrow keys move it.`}");
    expect(row.indexOf('className="cq-text truncate"')).toBeLessThan(row.indexOf('className="cq-why truncate"'));
  });

  it('names its acts by the delivery and sends them down the row’s own paths', () => {
    expect(row).toMatch(/const acts = rowActs\(delivery, running && steerable\);/);
    expect(row).toMatch(/label=\{acts\.send\} onClick=\{onSend\}/);
    expect(row).toMatch(/<Act icon="trash" label=\{acts\.remove\} onClick=\{\(\) => onRemove\(ref\.current\)\} \/>/);
    // The same two bridge calls as any row: nothing new is sent, nothing new moves.
    expect(tray).toMatch(/onSend=\{\(\) => void sendQueuedNow\(sessionId, q\.id\)\}/);
    expect(tray).toMatch(/void removeQueued\(sessionId, q\.id\)/);
    const actions = read('src/state/actions.ts');
    expect(actions).toMatch(/export const removeQueued = \(sessionId: string, id: string\) => bridge\.call\('queue\.remove', \{ sessionId, id \}\)/);
    expect(actions).toMatch(/export const sendQueuedNow = \(sessionId: string, id: string\) => bridge\.call\('queue\.sendNow', \{ sessionId, id \}\)/);
  });

  it('draws the reason in the row’s second tone and never lets it take more than half the row', () => {
    const css = read('src/features/composer/composer.css');
    const why = /\n\.cq-why \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(why).toMatch(/color: var\(--text-3\);/);
    expect(why).toMatch(/font-size: var\(--t-small\);/);
    expect(why).toMatch(/flex: 0 1 auto;/);
    // Never more than half the row: in a narrow pane the words are not squeezed out.
    expect(Number(/max-width: (\d+)%/.exec(why)?.[1])).toBeLessThanOrEqual(50);
    // No motion of its own but stepping back by opacity under the first act's label: a row that comes
    // or goes is the dock's glide.
    expect(why).not.toMatch(/animation/);
    expect(/transition: ([^;]*);/.exec(why)?.[1]).toBe('opacity var(--d-1) var(--ease)');
    expect(css).toMatch(/\n\.cq-row:has\(\.cq-act:first-child:is\(:hover, :focus-visible\)\) \.cq-why \{\s*opacity: 0;\s*\}/);
  });
});

describe('the phone’s queue row', () => {
  const screen = read('mobile/src/screens/Composer.tsx');
  const row = screen.slice(screen.indexOf('function QueueRow('), screen.indexOf('/** Photos go to the desktop'));

  it('reads the desktop’s model and says the reason under the words', () => {
    expect(screen).toMatch(/import \{ rowActs, rowDelivery \} from '@desk\/features\/composer\/queue-rows';/);
    expect(row).toContain('q ? rowDelivery(q)');
    expect(row).toMatch(/<span className="queued-why">\{delivery\.reason\}<\/span>/);
    const css = read('mobile/src/styles/chat.css');
    expect(css).toMatch(/\n\.queued-text\[data-why\] \{[^}]*flex-direction: column;/);
    expect(css).toMatch(/\n\.queued-why \{[^}]*color: var\(--text-3\);/);
  });

  it('names its two keys Send again and Discard, on the same two calls', () => {
    expect(row).toMatch(/aria-label=\{acts\.send\}/);
    expect(row).toMatch(/aria-label=\{acts\.remove\}/);
    expect(row).toMatch(/conn\.call\('queue\.sendNow', \{ sessionId: sid, id: q\.id \}\)/);
    expect(row).toMatch(/conn\.call\('queue\.remove', \{ sessionId: sid, id: q\.id \}\)/);
  });
});
