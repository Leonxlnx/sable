/**
 * A commit message written by a small model from the changes in a folder (`git.draft`). The model
 * gets the changed files, the start of the diff and the recent subjects, and answers with the
 * message only. Nothing is staged or committed here: the person reads the message and commits it.
 */
import type { CommitDraftInput } from '../services/git';
import type { TitlePrompt } from './titles';

/**
 * Every field has a budget (review wave 8, #24): the diff's start is what the model sees; the file
 * list stays whole up to this many names, each name and all of them bounded; the recent subjects are
 * for style only, so a few short ones.
 */
const PATCH_CHARS = 12_000;
const MAX_FILES = 200;
const FILE_CHARS = 300;
const FILES_CHARS = 12_000;
const MAX_SUBJECTS = 8;
const SUBJECT_CHARS = 120;

/** `s` cut to `n` characters, marked when cut. */
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** As many of `lines` as fit in `budget` characters, each cut to `each`. */
function fit(lines: string[], each: number, budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    const line = cut(l, each);
    if (used + line.length > budget) break;
    out.push(line);
    used += line.length + 1;
  }
  return out;
}
/** A subject is one line; the body is a few sentences. */
export const COMMIT_MAX_TOKENS = '600';

export const COMMIT_SYSTEM = [
  'You write git commit messages for the changes you are shown.',
  'Reply with the message only: a subject line of at most 72 characters in the imperative mood, no trailing period, no quotes, no markdown, no emoji.',
  'Then, only when the change needs explaining, a blank line and a short body of plain sentences wrapped at 72 characters.',
  'Write in the language the recent subjects use, English when they give no clue.',
].join(' ');

export function commitPrompt(input: CommitDraftInput, cwd: string): TitlePrompt {
  const files = fit(input.files.slice(0, MAX_FILES), FILE_CHARS, FILES_CHARS);
  const more = input.files.length > files.length ? [`… and ${input.files.length - files.length} more`] : [];
  const patch = input.patch.length > PATCH_CHARS ? `${input.patch.slice(0, PATCH_CHARS)}\n… (cut)` : input.patch;
  const parts = ['Files changed:', ...files, ...more];
  const subjects = fit(input.subjects.slice(0, MAX_SUBJECTS), SUBJECT_CHARS, MAX_SUBJECTS * (SUBJECT_CHARS + 2));
  if (subjects.length) parts.push('', 'Recent commit subjects, for style:', ...subjects);
  parts.push('', 'Diff against HEAD (new files are only listed above):', '<diff>', patch || '(none)', '</diff>', '', 'The commit message:');
  return { system: COMMIT_SYSTEM, user: parts.join('\n'), cwd, maxTokens: COMMIT_MAX_TOKENS };
}

/**
 * The model's answer as a commit message: no code fence, no "Commit message:" lead, no quotes
 * around the subject, no trailing period on it. Null when there is nothing left.
 */
export function cleanCommit(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let text = raw.replace(/\r\n/g, '\n').trim();
  text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  text = text.replace(/^(\*\*|__)?\s*commit message\s*(\*\*|__)?\s*[:：]\s*/i, '').trim();
  const lines = text.split('\n');
  const subject = lines[0]
    .replace(/^#+\s*/, '')
    .replace(/^[*_`]+|[*_`]+$/g, '')
    .replace(/^["'`“”„«»]+|["'`“”„«»]+$/g, '')
    .replace(/[\s.。]+$/u, '')
    .trim();
  if (!subject) return null;
  const body = lines.slice(1).join('\n').replace(/\s+$/, '');
  // A blank line between the subject and the body, as git wants it (without one the body joins the subject).
  return body.trim() ? `${subject}\n\n${body.replace(/^\n+/, '')}` : subject;
}
