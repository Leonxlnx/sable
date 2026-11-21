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

/**
 * The writes an open row has in flight. Done closes the row only once all of them are stored
 * (`closeWhenStored`); one the bridge refuses (another window changed that field after this one
 * looked) keeps the row open with what was typed, and the conflict shows when the list comes back.
 * One refused after the row was closed another way (another row opened) calls `refusedClosed`, so the
 * row opens again on its words; once nothing is in flight and all was stored, a closed row may follow
 * the prompt again (`idle`).
 */
export class RowWrites {
  private inflight = new Set<Promise<boolean>>();
  private refusedWhileClosed = false;

  constructor(
    private write: (patch: Partial<PromptFields>, was: Partial<PromptFields>) => Promise<boolean>,
    private hooks: { isOpen: () => boolean; refusedClosed: () => void; idle?: () => void },
  ) {}

  /** A write in flight now. */
  get busy() {
    return this.inflight.size > 0;
  }

  /** Sends the fields; true once stored (nothing to send: true at once). */
  send(patch: Partial<PromptFields>, was: Partial<PromptFields>): Promise<boolean> {
    if (!Object.keys(patch).length) return Promise.resolve(true);
    const w = this.write(patch, was).catch(() => false);
    this.inflight.add(w);
    void w.then((ok) => {
      this.inflight.delete(w);
      if (!ok && !this.hooks.isOpen()) this.refusedWhileClosed = true;
      if (this.inflight.size || this.hooks.isOpen()) return;
      if (this.refusedWhileClosed) {
        this.refusedWhileClosed = false;
        this.hooks.refusedClosed();
      } else this.hooks.idle?.();
    });
    return w;
  }

  /** Closes once every write sent so far is stored and the row is still open; false (left open, its words kept) when one was refused. */
  async closeWhenStored(close: () => void): Promise<boolean> {
    const all = await Promise.all([...this.inflight]);
    if (!all.every(Boolean) || !this.hooks.isOpen()) return false;
    close();
    return true;
  }
}
