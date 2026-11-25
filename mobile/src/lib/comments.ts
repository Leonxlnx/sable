import { useSyncExternalStore } from 'react';
import { addComment, clearReview, editComment, pruneReviews, removeComment, reviewMessage, type ReviewComment, type Reviews } from '@desk/features/review/model';
import { packReviews, unpackReviews } from '@desk/features/review/persist';
import { conn } from './conn';
import { onForget } from './forget';
import { epoch, still } from './epoch';
import { isUncertain } from './errors';
import { submissionDone, submissionFor, submissionUnsure } from './submit';
import { notSentHere, sentHere } from './follow';

/**
 * A chat's review written on the phone: comments on lines of its diffs, kept per chat until sent
 * (and across restarts: Android may close the app in the background). They go as one message made
 * by the desktop's own `reviewMessage`, so the desktop and the phone both show it as a review.
 * The changes to the list are the desktop's own (`addComment`, `editComment`, …), and so is how it
 * is stored and read back (`packReviews`, `unpackReviews`: anything malformed is dropped).
 */

const KEY = 'sable.reviews';
const NONE: ReviewComment[] = [];

let reviews: Reviews = (() => {
  try {
    return unpackReviews(localStorage.getItem(KEY));
  } catch {
    return {};
  }
})();
/** What was typed above the comments in the review sheet, per chat (this run only). */
const leads = new Map<string, string>();
const listeners = new Set<() => void>();

function set(next: Reviews) {
  if (next === reviews) return;
  reviews = next;
  try {
    localStorage.setItem(KEY, packReviews(reviews));
  } catch {
    /* full or private: kept for this run */
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The chat's pending comments, oldest first. */
export const useComments = (sid: string): ReviewComment[] => useSyncExternalStore(subscribe, () => reviews[sid] ?? NONE);
export const commentsOf = (sid: string): ReviewComment[] => reviews[sid] ?? NONE;

export const putComment = (sid: string, c: ReviewComment) => set(addComment(reviews, sid, c));
/** New words for a comment; empty words remove it. */
export const rewordComment = (sid: string, id: string, text: string) => set(editComment(reviews, sid, id, text));
export const dropComment = (sid: string, id: string) => set(removeComment(reviews, sid, id));
export const discardComments = (sid: string) => {
  leads.delete(sid);
  set(clearReview(reviews, sid));
};
/** Chats the desktop no longer has lose their comments. */
export const pruneComments = (alive: (sid: string) => boolean) => set(pruneReviews(reviews, alive));

export const leadOf = (sid: string) => leads.get(sid) ?? '';
export const setLead = (sid: string, text: string) => (text ? leads.set(sid, text) : leads.delete(sid));

/**
 * Sends the chat's comments as one review message (what was typed in the sheet first). While a
 * turn runs the desktop holds it like any message. The comments sent are cleared once the desktop
 * has it; a failure throws and keeps them.
 */
export async function sendReview(sid: string): Promise<{ queued: boolean }> {
  const list = commentsOf(sid);
  if (!list.length) return { queued: false };
  const lead = leadOf(sid).trim();
  const e = epoch();
  sentHere(sid);
  // One id for this review (lib/submit.ts): sent again after a connection that cut its answer off, the
  // same comments carry the same id, so the desktop answers without sending them twice.
  const text = reviewMessage(list, lead);
  const sub = submissionFor(sid, text, undefined);
  const r = await conn.call('session.send', { sessionId: sid, text, submitId: sub.id }).catch((err) => {
    notSentHere(sid);
    if (isUncertain(err)) submissionUnsure(sid, sub.id);
    else submissionDone(sid, sub.id);
    throw err;
  });
  submissionDone(sid, sub.id);
  if (r.queued || !r.ok) notSentHere(sid);
  // Forgotten while it went: nothing of that computer is written again.
  if (!still(e)) return { queued: !!r.queued };
  if (!r.ok) throw new Error(r.error ?? 'The review was not sent');
  leads.delete(sid);
  set(clearReview(reviews, sid, new Set(list.map((c) => c.id))));
  return { queued: !!r.queued };
}

// Forgetting the computer forgets what was written for it.
const forgetAll = () => {
  leads.clear();
  set({});
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
};
onForget(forgetAll);
conn.onState(() => {
  if (conn.state === 'unpaired') forgetAll();
});
