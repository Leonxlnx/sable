import type { FieldDraft } from './restore';

/**
 * Messages on their way to the bridge (review wave 10, findings 1, 2, 9). A send leaves the field
 * at once, but until the bridge accepted it, it is kept here beside the field's draft: written
 * with the drafts on unload (drafts.ts `packDrafts`), so a reload brings its words back, and put
 * back into the field when it is refused, in the order the messages were sent and never merged
 * with an identical message typed since. Each send has an id (`submitId` on `session.send`): the
 * bridge answers a second send with the same id as accepted without sending it twice, so a retry
 * of a refused message whose first try reached the bridge after all goes out once. A message put
 * back keeps its id until its words or files change.
 */

export interface PendingSend {
  /** The draft it left (`home`, a chat's id). */
  key: string;
  /** Order of sending (refused messages go back in this order). */
  seq: number;
  /** The submission's id: the same for a retry of the same words and files. */
  id: string;
  draft: FieldDraft;
}

let seq = 0;
const out = new Map<string, PendingSend[]>();
/** What a field holds at its start from refused messages put back (still unedited there). */
const back = new Map<string, { parts: PendingSend[]; text: string }>();
/** The id a retry of exactly this message reuses. */
const retry = new Map<string, { id: string; text: string; files: string }>();
const subs = new Set<() => void>();

const filesKey = (d: FieldDraft) => d.attachments.map((a) => a.id).join('\u0000');
const changed = () => subs.forEach((f) => f());

let ids = 0;
function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `s${Date.now().toString(36)}-${(++ids).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Called on every change of what is on its way (drafts.ts writes again). */
export function onPending(fn: () => void): () => void {
  subs.add(fn);
  return () => void subs.delete(fn);
}

/**
 * The message `draft` left the field `key`: kept until the bridge answers. A message put back and
 * sent again unchanged keeps its id.
 */
export function holdSend(key: string, draft: FieldDraft): PendingSend {
  const r = retry.get(key);
  const id = r && r.text === draft.text && r.files === filesKey(draft) ? r.id : newId();
  retry.delete(key);
  // The field's words left with this send: what was put back there is gone from it.
  back.delete(key);
  const p: PendingSend = { key, seq: ++seq, id, draft };
  out.set(key, [...(out.get(key) ?? []), p]);
  changed();
  return p;
}

function drop(p: PendingSend) {
  const list = (out.get(p.key) ?? []).filter((x) => x !== p);
  if (list.length) out.set(p.key, list);
  else out.delete(p.key);
}

/**
 * The chat a first send from home made exists now: the message on its way is that chat's (a
 * reload brings its words back there, where the conversation shows whether it went, not to home,
 * where a retry would make a second chat).
 */
export function moveSend(p: PendingSend, key: string) {
  if (p.key === key) return;
  drop(p);
  p.key = key;
  out.set(key, [...(out.get(key) ?? []), p]);
  changed();
}

/** The bridge took it. */
export function sendDone(p: PendingSend) {
  drop(p);
  changed();
}

/** Text before `rest`, each on a line of its own; nothing but space in `rest` is nothing. */
const join = (head: string, rest: string) => (!rest.trim() ? head : head ? `${head}\n${rest}` : rest);

function merged(parts: PendingSend[], now: FieldDraft | undefined, rest: string): FieldDraft {
  const head = parts
    .map((x) => x.draft.text)
    .filter(Boolean)
    .join('\n');
  const files = parts.flatMap((x) => x.draft.attachments);
  const seen = new Set<string>();
  const attachments = [...files, ...(now?.attachments ?? [])].filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
  return { text: join(head, rest), attachments };
}

/**
 * Refused: the field `into` (the draft it left, or the chat a first send from home made) with the
 * message back in it. Messages put back go first, in the order they were sent, while what they
 * put there is unedited; then whatever was typed since. Identical words typed since are another
 * message and stay.
 */
export function sendBack(p: PendingSend, now: FieldDraft | undefined, into: string = p.key): FieldDraft {
  drop(p);
  const cur = now?.text ?? '';
  const prev = back.get(into);
  const holds = !!prev && (cur === prev.text || cur.startsWith(`${prev.text}\n`) || !prev.text);
  const parts = holds ? [...prev!.parts, p].sort((a, b) => a.seq - b.seq) : [p];
  const rest = holds ? cur.slice(prev!.text.length).replace(/^\n/, '') : cur;
  const next = merged(parts, now, rest);
  const head = parts
    .map((x) => x.draft.text)
    .filter(Boolean)
    .join('\n');
  back.set(into, { parts, text: head });
  // The field is exactly this one message again: a retry is the same submission.
  if (parts.length === 1 && next.text === p.draft.text && next.attachments.length === p.draft.attachments.length) retry.set(into, { id: p.id, text: p.draft.text, files: filesKey(p.draft) });
  else retry.delete(into);
  changed();
  return next;
}

/**
 * What the field `key` should bring back after a reload: its messages still on their way, in the
 * order they were sent, before what it holds now.
 */
export function withPending(key: string, now: FieldDraft | undefined): FieldDraft {
  const list = out.get(key);
  if (!list?.length) return now ?? { text: '', attachments: [] };
  return merged(list, now, now?.text ?? '');
}

/** The drafts with what is on their way merged in (for drafts.ts to write). */
export function draftsWithPending<T extends FieldDraft>(drafts: Record<string, T>): Record<string, FieldDraft> {
  if (!out.size) return drafts;
  const all: Record<string, FieldDraft> = { ...drafts };
  for (const key of out.keys()) all[key] = withPending(key, drafts[key]);
  return all;
}

/** Tests: forget everything. */
export function resetPending() {
  out.clear();
  back.clear();
  retry.clear();
  seq = 0;
}
