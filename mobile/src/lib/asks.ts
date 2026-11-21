import type { FileDiff, PermissionOption, PermissionRequest, PhoneMethods, PhoneQuestionRequest, QuestionRequest, RpcMethods } from '@shared/protocol';

/**
 * What the phone does with the agent's permission prompts and questions, free of the screens
 * (Prompts.tsx), so it can be tested.
 *
 * - A permission the desktop marked `incomplete` (some of what it would allow was shortened for the
 *   phone) offers no allowing key: only its refusals and Later; the desktop answers the rest.
 * - The change an edit asks to make shows whole, every line the phone got (the desktop sends at most
 *   600 and marks a longer one incomplete).
 * - Questions are answered by the ids the desktop gave each question and option (`phone.answer`),
 *   never by their words, which may be shortened for the phone; an `incomplete` questionnaire is
 *   answered on the desktop. A desktop from before ids gets the words, as before.
 */

type Phone = PermissionRequest & { incomplete?: true };

/** The keys a permission sheet offers: allowing ones only when the phone was shown all of it. */
export function permissionKeys(req: Phone): { grants: PermissionOption[]; denials: PermissionOption[]; desktopOnly: boolean } {
  const rank = (o: PermissionOption) => (o.tone === 'allow' ? 0 : o.tone === 'always' ? 1 : 2);
  const ordered = [...req.options].sort((a, b) => rank(a) - rank(b));
  const desktopOnly = !!req.incomplete;
  return { grants: desktopOnly ? [] : ordered.filter((o) => o.tone !== 'deny'), denials: ordered.filter((o) => o.tone === 'deny'), desktopOnly };
}

/** Every line of a change as the sheet shows it: a file's name over its hunks when there are several, each hunk's header. */
export function patchLines(diff: FileDiff[]): string[] {
  const lines: string[] = [];
  for (const f of diff) {
    if (diff.length > 1) lines.push(`@@ ${f.path.split(/[\\/]/).pop()}`);
    for (const h of f.hunks) {
      lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines}`);
      lines.push(...h.lines);
    }
  }
  return lines;
}

/** Questions as the phone got them: with the desktop's ids (and maybe marked), or an older desktop's words only. */
export type AnyQuestions = QuestionRequest | PhoneQuestionRequest;

/** Answered by ids (`phone.answer`): every question and option has one. */
export const byIds = (req: AnyQuestions): req is PhoneQuestionRequest =>
  req.questions.every((q) => typeof (q as { id?: unknown }).id === 'string' && q.options.every((o) => typeof (o as { id?: unknown }).id === 'string'));

/** Only the desktop answers these (questions or options were left out for the phone). */
export const questionsDesktopOnly = (req: AnyQuestions) => !!(req as PhoneQuestionRequest).incomplete;

/** The key a question's picks are kept under, and an option's: its id, or (older desktop) its place and words. */
export const questionKey = (req: AnyQuestions, i: number) => (byIds(req) ? req.questions[i].id : `#${i}`);
export const optionKey = (req: AnyQuestions, i: number, j: number) => (byIds(req) ? req.questions[i].options[j].id : req.questions[i].options[j].label);

export type Answer =
  | { method: 'phone.answer'; params: PhoneMethods['phone.answer']['params'] }
  | { method: 'question.respond'; params: RpcMethods['question.respond']['params'] };

/**
 * The call that answers: `picked` (option keys) and `other` (words of the person's own) per question
 * key. By ids when the desktop gave them; by words for an older desktop. Skipping is always words
 * (`answers: null`). Null when it may not go from the phone (desktop only, or a question unanswered).
 */
export function answerCall(sid: string, req: AnyQuestions, picked: Record<string, string[]>, other: Record<string, string>, skip = false): Answer | null {
  if (skip) return { method: 'question.respond', params: { sessionId: sid, requestId: req.id, answers: null } };
  if (questionsDesktopOnly(req)) return null;
  if (byIds(req)) {
    const picks: Record<string, { options?: string[]; other?: string }> = {};
    for (const q of req.questions) {
      const options = (picked[q.id] ?? []).filter((id) => q.options.some((o) => o.id === id));
      const words = (other[q.id] ?? '').trim();
      if (!options.length && !words) return null;
      picks[q.id] = { ...(options.length ? { options } : {}), ...(words ? { other: words } : {}) };
    }
    return { method: 'phone.answer', params: { sessionId: sid, requestId: req.id, picks } };
  }
  const answers: Record<string, string[]> = {};
  for (let i = 0; i < req.questions.length; i++) {
    const q = req.questions[i];
    const list = [...(picked[`#${i}`] ?? [])];
    const words = (other[`#${i}`] ?? '').trim();
    if (words) list.push(words);
    if (!list.length) return null;
    answers[q.question] = list;
  }
  return { method: 'question.respond', params: { sessionId: sid, requestId: req.id, answers } };
}
