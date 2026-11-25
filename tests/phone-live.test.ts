import { expect, it } from 'vitest';
import type { SessionMeta, TurnLive } from '../shared/protocol';
import { phoneEvent, sessionsPage } from '../server/services/phone';

it('includes the current turn in the chat list and sends both a live update and its explicit clear', () => {
  const live: TurnLive = { startedAt: 9, files: 1, steps: 4, checkpoints: 2, checkpointAt: 37, checkpointSteps: 1, doing: 'edit', doingCount: 1 };
  const s = { id: 'unopened', live } as SessionMeta;
  expect(sessionsPage([s], 0, 2000).sessions[0].live).toEqual(live);
  const frame = (value?: TurnLive) => JSON.parse(JSON.stringify(phoneEvent({ type: 'session.updated', id: s.id, patch: { live: value } })));
  expect(frame(live).patch).toEqual({ live });
  expect(frame().patch).toEqual({ live: null });
});
