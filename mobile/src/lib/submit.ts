import { onForget } from './forget';

/**
 * A send from this phone, known by an id of its own (`session.send` `submitId`; review 0235b, finding 4).
 *
 * The id is made with the words and their files before the first request. When the connection cuts
 * the answer off, the words go back into the field and the send is kept here: it may or may not have
 * arrived. A retry of the same words and files carries the same id, so the desktop answers it without
 * sending twice. The kept send is settled by its own id and by nothing else: by the desktop's answer
 * to a `session.send` that carried it, or by its yes to `session.submission` under that id (a question
 * that sends nothing, asked once connected again: `confirmKept`). Never by a message that merely
 * reads the same: another window's identical words are another message.
 *
 * A kept send belongs to the field's words as they were put back: once they are edited, it is let go
 * (`draftChanged`), so words typed anew are a new message even when they read the same. Kept while
 * the app lives; forgetting the computer forgets them.
 */
export interface Submission {
  /** Made before the first request; the same on every retry. */
  id: string;
  text: string;
  /** Its files (`filesKey`). */
  files: string;
  /** Its answer was cut off by the connection: the words are back in the field. */
  unsure?: boolean;
}

/** At most this many sends are kept per chat (one field, so more than one is rare). */
const MOST = 8;
const book = new Map<string, Submission[]>();

/** What a send's files are, for telling a retry from another message. */
export const filesKey = (files: readonly { id: string }[] | undefined): string => (files ?? []).map((f) => f.id).join('\u0000');

const randomId = () => crypto.randomUUID();

/**
 * The send of these words and files in `sid`: the one already begun for exactly them (a retry keeps
 * its id), else a new one with a new id.
 */
export function submissionFor(sid: string, text: string, files: readonly { id: string }[] | undefined, newId: () => string = randomId): Submission {
  const key = filesKey(files);
  const list = book.get(sid) ?? [];
  const had = list.find((s) => s.text === text && s.files === key);
  if (had) return had;
  const sub: Submission = { id: newId(), text, files: key };
  book.set(sid, [...list, sub].slice(-MOST));
  return sub;
}

/** The desktop answered under this id (taken, queued or refused): nothing more is owed under it. */
export function submissionDone(sid: string, id: string): void {
  const list = book.get(sid);
  if (!list?.some((s) => s.id === id)) return;
  const rest = list.filter((s) => s.id !== id);
  if (rest.length) book.set(sid, rest);
  else book.delete(sid);
}

/** Its answer was cut off: kept, so a retry of the same words and files carries the same id. */
export function submissionUnsure(sid: string, id: string): void {
  const sub = book.get(sid)?.find((s) => s.id === id);
  if (sub) sub.unsure = true;
}

/** The sends of `sid` whose answer was cut off. */
export const unsureOf = (sid: string): Submission[] => (book.get(sid) ?? []).filter((s) => s.unsure);

/**
 * The field's words or files changed: a kept send that is not exactly them any more is let go (words
 * edited, or typed anew, are a new message). A send still on its way is not touched.
 */
export function draftChanged(sid: string, text: string, files: readonly { id: string }[] | undefined): void {
  const list = book.get(sid);
  if (!list?.some((s) => s.unsure)) return;
  const key = filesKey(files);
  const rest = list.filter((s) => !s.unsure || (s.text === text.trim() && s.files === key));
  if (rest.length === list.length) return;
  if (rest.length) book.set(sid, rest);
  else book.delete(sid);
}

/**
 * Asks the desktop about each kept send of `sid` by its own id (`ask`: `session.submission`, which
 * sends nothing). The ones it has are done with and returned: their receipt is the desktop's yes
 * under that very id. A no leaves the send kept (it never arrived: the retry carries its id), and so
 * does a question that got no answer (asked again at the next connection).
 */
export async function confirmKept(sid: string, ask: (submitId: string) => Promise<{ ok?: boolean; submitId?: string } | undefined>): Promise<Submission[]> {
  const got: Submission[] = [];
  for (const sub of unsureOf(sid)) {
    try {
      const r = await ask(sub.id);
      if (r?.ok !== true || r.submitId !== sub.id) continue;
      // Let go meanwhile (the words were edited, the computer forgotten): nothing to settle.
      if (!unsureOf(sid).some((s) => s === sub)) continue;
      submissionDone(sid, sub.id);
      got.push(sub);
    } catch {
      /* still not known */
    }
  }
  return got;
}

/** Forgetting the computer forgets the sends kept for it. */
export function forgetSubmissions(): void {
  book.clear();
}
onForget(forgetSubmissions);
