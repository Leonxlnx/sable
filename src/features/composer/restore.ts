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
 * field's text, so text equal to the sent text is the sent text, unless `typed` says the field was
 * typed in since: then it is a new message, even with the same words), and of the files only those
 * that went with it go; files added while it was on its way stay.
 */
export function leaveField(now: FieldDraft | undefined, sent: FieldDraft, typed?: boolean): FieldDraft {
  const text = now?.text ?? '';
  const gone = idsOf(sent.attachments);
  return { text: text === sent.text && !typed ? '' : text, attachments: (now?.attachments ?? NONE).filter((a) => !gone.has(a.id)) };
}

/**
 * A refused message back in the field: its words first, then what was typed since on a line of
 * its own (the same words typed again are another message: both stay); its files first, then the
 * files added since (never twice). The composer's own sends go back through pending.ts `sendBack`,
 * which also keeps several refused messages in the order they were sent.
 */
export function putBack(now: FieldDraft | undefined, sent: FieldDraft): FieldDraft {
  const cur = now?.text ?? '';
  const text = !cur.trim() ? sent.text : sent.text ? `${sent.text}\n${cur}` : cur;
  const back = idsOf(sent.attachments);
  return { text, attachments: [...sent.attachments, ...(now?.attachments ?? NONE).filter((a) => !back.has(a.id))] };
}

/**
 * What was typed or attached on home while the first send made its chat, carried into that chat's
 * field: after what the field holds (a refused first message put back there), files never twice.
 */
export function carryOver(now: FieldDraft | undefined, extra: FieldDraft): FieldDraft {
  const cur = now?.text ?? '';
  const text = !cur.trim() ? extra.text : extra.text.trim() ? `${cur}\n${extra.text}` : cur;
  const have = idsOf(now?.attachments ?? NONE);
  return { text, attachments: [...(now?.attachments ?? NONE), ...extra.attachments.filter((a) => !have.has(a.id))] };
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
