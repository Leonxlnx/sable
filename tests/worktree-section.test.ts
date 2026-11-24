import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { LaneSection } from '../src/features/rail/LaneSection';
import type { SessionLane } from '../shared/protocol';

const { session } = vi.hoisted(() => ({ session: { status: 'idle', title: 'Work', background: 0, commands: 0 } }));
vi.mock('../src/state/store', () => ({
  useStore: (select: (state: { sessions: { a: typeof session } }) => unknown) => select({ sessions: { a: session } }),
}));
vi.mock('../src/features/rail/git-state', () => ({ useRepo: () => undefined }));
vi.mock('../src/features/session/lane', () => ({
  useLaneForecast: () => ({ forecast: { state: 'clean', ahead: 0, behind: 0, files: 1, conflicts: [], blocked: [] } }),
  laneName: (name: string) => name,
}));
vi.mock('../src/features/session/LaneMark', () => ({ LaneGlyph: () => null }));
vi.mock('../src/ui', () => ({ IconButton: () => null, Tip: ({ children }: { children: ReactNode }) => children }));

it('disables landing and discarding while the lane has background work', () => {
  const lane: SessionLane = { root: 'repo', folder: 'repo', path: 'lane', branch: 'sable/side', from: 'main', base: 'sha', createdAt: 1 };
  const buttons = () => renderToStaticMarkup(createElement(LaneSection, { lane, sessionId: 'a', cwd: lane.path })).match(/<button\b[^>]*>/g)!;
  const disabled = (button: string) => /\sdisabled(?:=|\s|>)/.test(button);
  for (const field of ['background', 'commands'] as const) {
    session[field] = 1;
    expect(buttons().every(disabled)).toBe(true);
    session[field] = 0;
  }
  expect(buttons().some(disabled)).toBe(false);
});
