/**
 * What an open row in Settings › Prompts sends when a field is left: only the fields edited since
 * the edit began (`seen`: the prompt as it was when the row opened, or when a field was last
 * settled), each with what this window saw in it (`was`), so the bridge refuses it if another window
 * changed that field in the meantime. A field edited here that another window also changed
 * (`latest` differs from `seen`) is a conflict: it is held, not sent, until the person picks.
 */

export type PromptField = 'name' | 'text';
export type PromptFields = { name: string; text: string };

export function promptEdits(seen: PromptFields, local: PromptFields, latest: PromptFields): { patch: Partial<PromptFields>; was: Partial<PromptFields>; conflicts: PromptField[] } {
  const patch: Partial<PromptFields> = {};
  const was: Partial<PromptFields> = {};
  const conflicts: PromptField[] = [];
  // An emptied name keeps the old one; an emptied text is not saved.
  const value: PromptFields = { name: local.name.trim() || seen.name, text: local.text };
  for (const f of ['name', 'text'] as const) {
    if (local[f] === seen[f] || value[f] === seen[f]) continue;
    if (f === 'text' && !value.text.trim()) continue;
    if (value[f] === latest[f]) continue;
    if (latest[f] !== seen[f]) {
      conflicts.push(f);
      continue;
    }
    patch[f] = value[f];
    was[f] = seen[f];
  }
  return { patch, was, conflicts };
}
