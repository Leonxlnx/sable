import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { STEER_FIRST_BLOCK, type TimelineItem, type UserItem } from '@shared/protocol';
import { userItemText } from '@shared/synthetic';
import { UserMessage } from '@/features/timeline/User';

// What a person's message shows, copies and repeats (review 0235b, finding 20): a card the person sent
// keeps every word, also when it is, or ends in, a quoted note of Sable's own. Only a card with no
// origin mark (read back from a transcript) has the harness's wrappers taken off.
const state = vi.hoisted(() => ({
  sessions: { chat: { status: 'idle', provider: 'claude' } } as Record<string, { status: string; provider: string }>,
  data: { chat: { items: {} as Record<string, TimelineItem>, roots: [] as string[], caps: undefined } },
}));
vi.mock('@/state/store', () => ({
  useStore: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state, subscribe: vi.fn() }),
}));
vi.mock('@/state/actions', () => ({ rewindTo: vi.fn(), steerNow: vi.fn() }));
vi.mock('@/features/timeline/ctx', () => ({ useTimeline: () => ({ sessionId: 'chat', stuck: { current: true } }) }));
vi.mock('@/features/timeline/Again', () => ({ MessageAgain: () => null }));
vi.mock('@/features/composer/flight', () => ({ landInTimeline: () => false }));
vi.mock('@/features/composer/settle', () => ({ afterSend: () => () => {}, sendInAir: () => false }));
// What Copy would take, written into the markup.
vi.mock('@/components/CopyButton', () => ({ CopyButton: ({ text }: { text: string }) => createElement('i', { 'data-copy': text }) }));

const read = (file: string) => readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
const card = (over: Partial<UserItem>): UserItem => ({ type: 'user', id: 'm', ts: 1, text: '', state: 'sent', ...over });
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const show = (item: UserItem) => renderToStaticMarkup(createElement(UserMessage, { item }));
/** The words in the bubble and the words Copy takes, as the markup has them. */
const shown = (html: string) => ({ words: /class="user-text"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1], copy: /data-copy="([^"]*)"/.exec(html)?.[1] });

describe('a person’s own message keeps every word', () => {
  const quoted = `What does this mean?\n\n${STEER_FIRST_BLOCK}`;

  it.each([
    ['sent from Sable', { authored: true as const }],
    ['steered into a turn', { steered: true }],
    ['sent with a submission', { submitPrint: 'p-1' }],
    ['sent from the Claude app', { remote: true }],
  ])('%s: a quoted note of Sable’s at its end is shown and copied', (_name, mark) => {
    const html = show(card({ text: quoted, ...mark }));
    expect(shown(html).words).toBe(esc(quoted));
    expect(shown(html).copy).toBe(esc(quoted));
  });

  it('a message that is nothing but the quoted note is not empty', () => {
    const html = show(card({ text: STEER_FIRST_BLOCK, authored: true }));
    expect(shown(html).words).toBe(esc(STEER_FIRST_BLOCK));
    expect(shown(html).copy).toBe(esc(STEER_FIRST_BLOCK));
  });

  it('a card with no origin mark still loses the reminder the harness added', () => {
    const html = show(card({ text: quoted }));
    expect(shown(html).words).toBe('What does this mean?');
    expect(shown(html).copy).toBe('What does this mean?');
  });

  it('is one projection for the bubble, Copy, edit, retry and the composer’s history', () => {
    const personal = card({ text: quoted, authored: true });
    expect(userItemText(personal)).toBe(quoted);
    // No reader of a person's words in the window or on the phone takes the wrappers off by itself.
    for (const file of ['src/features/timeline/User.tsx', 'src/features/timeline/Again.tsx', 'src/features/timeline/repeat-message.ts', 'src/features/composer/Composer.tsx', 'mobile/src/screens/Timeline.tsx', 'mobile/src/lib/review.ts']) {
      expect(read(file), file).not.toMatch(/stripWrappers/);
      expect(read(file), file).toMatch(/userItemText\(/);
    }
    expect(read('src/features/timeline/User.tsx')).toMatch(/const text = useMemo\(\(\) => userItemText\(item\), \[item\]\);/);
    expect(read('src/features/timeline/Again.tsx')).toMatch(/const text = userItemText\(item\);/);
    // A cut row sends the whole message's words again, read the same way.
    expect(read('src/features/timeline/repeat-message.ts')).toMatch(/text === userItemText\(item\)\)\) text = userItemText\(whole\);/);
    // The composer's history recalls the same words, and nothing for a card with none of the person's.
    expect(read('src/features/composer/Composer.tsx')).toMatch(/const words = userItemText\(it\);\s*if \(words\.trim\(\)\) out\.push\(words\);/);
  });

  it('the card that stands in from the press is the person’s own too, so its words never change when the row takes over', () => {
    expect(read('src/features/timeline/StandIn.tsx')).toMatch(/\{ id: s\.id, type: 'user', text: s\.text, ts: s\.wall, authored: true \}/);
  });

  it('the phone’s bubble, its copy on hold and the Changes heading read the same projection', () => {
    const screen = read('mobile/src/screens/Timeline.tsx');
    expect(screen).toMatch(/const words = review \? review\.lead : userItemText\(it\);/);
    expect(screen).toMatch(/fetchItem\(sid, id\)\.then\(\(r\) => userItemText\(r\.item as UserItem\)\)/);
    expect(read('mobile/src/lib/review.ts')).toMatch(/review \? review\.lead \|\| 'Your review' : userItemText\(lead\);/);
  });
});
