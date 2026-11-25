import type { Attachment, RpcMethods } from '@shared/protocol';
import type { Draft } from './drafts';

export type Packet = Required<Pick<RpcMethods['session.send']['params'], 'sessionId' | 'submitId' | 'text' | 'steer'>> & { attachments?: Attachment[] };
export interface Press {
  packet: Packet;
  source: string;
  revision: number;
  // The empty revision in the destination chat which may display these words again.
  returnRevision: number;
}
/** Capture the composition at the press. Home binds the destination once createChat returns. */
export function pressFrom(source: string, draft: Draft, steer = false) {
  const submitId = crypto.randomUUID();
  const revision = draft.r;
  const attachments = draft.files?.length ? draft.files.map(file => ({ ...file })) : undefined;
  const payload = { submitId, text: draft.t, attachments, steer };
  return (sessionId = source, returnRevision = revision + 1): Press => ({
    packet: { ...payload, sessionId }, source, revision, returnRevision,
  });
}
export interface Submission extends Press {
  state: 'sending' | 'unsure' | 'refused';
}
export type SendEvent = { type: 'press'; press: Press } | { type: 'retry' | 'lost' | 'refused' | 'accepted' | 'discard' };

/** One deliberate press. Absence means no entry (including an accepted or discarded one). */
export function transition(entry: Submission | undefined, event: SendEvent): Submission | undefined {
  switch (event.type) {
    case 'press': return entry ?? { ...event.press, state: 'sending' };
    case 'retry': return entry && entry.state !== 'sending' ? { ...entry, state: 'sending' } : entry;
    case 'lost': return entry?.state === 'sending' ? { ...entry, state: 'unsure' } : entry;
    case 'refused': return entry && entry.state !== 'refused' ? { ...entry, state: 'refused' } : entry;
    case 'accepted': return undefined;
    case 'discard': return entry?.state === 'sending' ? entry : undefined;
  }
}

/** Project a failed press into the unchanged empty field. Its payload stays in the outbox
 * until a receipt or an explicit discard. Editing the projection creates a newer draft. */
export function offers(entries: readonly Submission[], sid: string, draft: Draft) {
  const waiting = entries.filter(s => s.packet.sessionId === sid && s.state !== 'sending');
  const field = !draft.t && !draft.files?.length
    ? waiting.find(s => s.returnRevision === draft.r && (s.source !== sid || draft.afterSend))
    : undefined;
  return { field, rows: waiting.filter(s => s !== field) };
}

export function receipt(id: string, answer?: { ok?: boolean; submitId?: string }) {
  if (answer?.ok === true && answer.submitId === id) return 'accepted';
  if (answer?.ok === false && (!answer.submitId || answer.submitId === id)) return 'refused';
  return 'lost';
}
