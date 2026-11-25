import type { TimelineItem } from '@shared/protocol';
import { syntheticOf, userItemText } from '@shared/synthetic';
import { parseReview, REVIEW_HEAD, type ParsedReview } from '@desk/features/review/model';

export function changesHeading(lead?: TimelineItem) {
  if (lead?.type !== 'user' || syntheticOf(lead)?.role === 'hidden') return 'This turn';
  const review = readReview(lead.text, true);
  const title = review ? review.lead || 'Your review' : userItemText(lead);
  return title.trim().split('\n')[0].slice(0, 140) || 'This turn';
}

/** A review read back from a message, and whether the phone holds only its start (`more`: Show all fetches the rest). */
export type PhoneReview = ParsedReview & { more?: boolean };

/**
 * A message made by the desktop's review bar (`reviewMessage`), read back with the desktop's own
 * `parseReview`, so the bubble shows what was typed and the comments as a short list, not the
 * quoted lines the agent gets. A long one the phone got cut short (`cut`, phone.ts) keeps its
 * whole comments; null for any other message.
 */
export function readReview(text: string, cut = false): PhoneReview | null {
  if (!text.includes(REVIEW_HEAD)) return null;
  const whole = parseReview(text);
  if (whole || !cut) return whole;
  const heads = [...text.matchAll(/\n\n\d+\. \S[^\n]*\n`{3,}diff\n/g)].map((m) => m.index ?? 0);
  for (let i = heads.length - 1; i >= 0; i--) {
    const part = parseReview(text.slice(0, heads[i]));
    if (part) return { ...part, more: true };
  }
  return null;
}
