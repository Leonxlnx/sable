import type { Attachment } from '@shared/protocol';

/**
 * Words and files leave the composer's field only for good: what is sent is taken out of the
 * field as it leaves (so the field is free for the next message at once), and when the bridge
 * refuses it, it is put back exactly as it was, merged with whatever the person typed or attached
 * meanwhile. Pure, so the composer's send, queue edit and commands share one set of rules (and
 * tests/composer-restore.test.ts can check them).
 */

export interface FieldDraft {
  text: string;
  attachments: Attachment[];
}

const NONE: Attachment[] = [];
const idsOf = (list: readonly Attachment[]) => new Set(list.map((a) => a.id));

/**
 * The field once `sent` has left it: words typed since stay (typing after a send replaces the
 * field's text, so text equal to the sent text is the sent text), and of the files only those that
 * went with it go; files added while it was on its way stay.
 */
export function leaveField(now: FieldDraft | undefined, sent: FieldDraft): FieldDraft {
  const text = now?.text ?? '';
  const gone = idsOf(sent.attachments);
  return { text: text === sent.text ? '' : text, attachments: (now?.attachments ?? NONE).filter((a) => !gone.has(a.id)) };
}

/**
 * A refused message back in the field: its words first, then what was typed since on a line of
 * its own; its files first, then the files added since (never twice).
 */
export function putBack(now: FieldDraft | undefined, sent: FieldDraft): FieldDraft {
  const cur = now?.text ?? '';
  const text = !cur.trim() || cur === sent.text ? sent.text : sent.text ? `${sent.text}\n${cur}` : cur;
  const back = idsOf(sent.attachments);
  return { text, attachments: [...sent.attachments, ...(now?.attachments ?? NONE).filter((a) => !back.has(a.id))] };
}

/**
 * Edit on a queued message: `got` comes into the field. `before` is what the field held when Edit
 * was chosen (it went into the queue in the message's place, or the field was empty); `now` is the
 * field once the bridge answered. Words typed or files attached during the request stay, after the
 * message's own.
 */
export function swapIn(now: FieldDraft | undefined, before: FieldDraft, got: FieldDraft): FieldDraft {
  const cur = now?.text ?? '';
  const typed = cur === before.text ? '' : cur;
  const had = idsOf(before.attachments);
  const own = idsOf(got.attachments);
  const added = (now?.attachments ?? NONE).filter((a) => !had.has(a.id) && !own.has(a.id));
  return { text: typed.trim() ? (got.text ? `${got.text}\n${typed}` : typed) : got.text, attachments: [...got.attachments, ...added] };
}

/**
 * Ultracode as just switched in this composer, over the value the session had then, tied to the
 * request that made it (`seq`). It shows while the request is out and the session still has the
 * old value; the bridge's answer (taken or refused) ends it, and from then on the session's own
 * value is the only truth.
 */
export interface UltraPick {
  on: boolean;
  over: boolean;
  seq: number;
  /** The chat it was switched in (another chat shown in the same composer never wears it). */
  session?: string;
}

export const shownUltra = (stored: boolean, pick: UltraPick | null): boolean => (pick && pick.over === stored ? pick.on : stored);

/** The request `seq` was answered: its pick ends (a newer pick stays). */
export const ultraAnswered = (pick: UltraPick | null, seq: number): UltraPick | null => (pick?.seq === seq ? null : pick);
