import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SavedPrompt } from '../../shared/protocol';
import type { App } from '../app';

/**
 * Saved prompts: texts the person keeps under a name and puts into the composer from the palette
 * or the `/` menu (never sent by themselves). One small file, `<home>/prompts.json`, in the order
 * the person arranged them; every change is pushed to the windows as `prompts.updated`.
 */

export const PROMPTS_FILE = 'prompts.json';
/** The longest name kept (characters). */
export const MAX_NAME = 80;
/** The longest text kept (characters). */
export const MAX_TEXT = 50_000;
/** How many prompts are kept. */
export const MAX_PROMPTS = 300;

interface PromptsFile {
  version: 1;
  prompts: SavedPrompt[];
}

/** A name as one tidy line: no line breaks or control characters, one space between words, at most `MAX_NAME`. */
export function cleanName(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > MAX_NAME ? s.slice(0, MAX_NAME).trimEnd() : s;
}

/** A name for a prompt saved without one: its first sentence when that is short, else its first words, on one line. */
export function nameFromText(text: string): string {
  const first = text.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) ?? '';
  const end = first.search(/[.!?](\s|$)/);
  const line = end > 0 && end <= 48 ? first.slice(0, end) : first;
  const words = line.split(/\s+/).filter(Boolean);
  let out = '';
  for (const w of words) {
    if (out && (out + ' ' + w).length > 48) break;
    out = out ? `${out} ${w}` : w;
    if (out.split(' ').length >= 7) break;
  }
  return cleanName(out.replace(/[.,:;]+$/, '')) || 'Prompt';
}

/** The text as kept: line endings made plain, no trailing blank space, at most `MAX_TEXT`. */
export function cleanText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+$/, '')
    .slice(0, MAX_TEXT);
}

const newId = () => randomBytes(6).toString('hex');

function isPrompt(p: unknown): p is SavedPrompt {
  const x = p as SavedPrompt;
  return !!x && typeof x === 'object' && typeof x.id === 'string' && !!x.id && typeof x.name === 'string' && typeof x.text === 'string';
}

export class PromptStore {
  readonly file: string;
  private list?: SavedPrompt[];

  constructor(
    dir: string,
    private emit?: (prompts: SavedPrompt[]) => void,
  ) {
    this.file = path.join(dir, PROMPTS_FILE);
  }

  /** Every prompt, in order (copies). */
  all(): SavedPrompt[] {
    return this.load().map((p) => ({ ...p }));
  }

  private load(): SavedPrompt[] {
    if (this.list) return this.list;
    let list: SavedPrompt[] = [];
    try {
      if (existsSync(this.file)) {
        const f = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PromptsFile>;
        const seen = new Set<string>();
        for (const p of Array.isArray(f.prompts) ? f.prompts : []) {
          if (!isPrompt(p) || seen.has(p.id)) continue;
          seen.add(p.id);
          const now = Date.now();
          list.push({ id: p.id, name: cleanName(p.name) || nameFromText(p.text), text: cleanText(p.text), createdAt: Number(p.createdAt) || now, updatedAt: Number(p.updatedAt) || now });
        }
      }
    } catch {
      // An unreadable file is left as it is (never overwritten until something is saved).
      list = [];
    }
    this.list = list.slice(0, MAX_PROMPTS);
    return this.list;
  }

  private save(list: SavedPrompt[]) {
    this.list = list;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, prompts: list } satisfies PromptsFile, null, 2), 'utf8');
    renameSync(tmp, this.file);
    this.emit?.(this.all());
  }

  /** A new prompt, first in the list. */
  add(name: unknown, text: unknown): SavedPrompt {
    const body = cleanText(text);
    if (!body.trim()) throw new Error('There is no text to save');
    const list = this.load();
    if (list.length >= MAX_PROMPTS) throw new Error(`At most ${MAX_PROMPTS} prompts can be saved`);
    const now = Date.now();
    const p: SavedPrompt = { id: newId(), name: cleanName(name) || nameFromText(body), text: body, createdAt: now, updatedAt: now };
    this.save([p, ...list]);
    return { ...p };
  }

  update(id: string, patch: { name?: unknown; text?: unknown }): SavedPrompt {
    const list = this.load();
    const i = list.findIndex((p) => p.id === id);
    if (i < 0) throw new Error('That prompt is no longer there');
    const cur = list[i];
    const text = patch.text === undefined ? cur.text : cleanText(patch.text);
    if (!text.trim()) throw new Error('A prompt needs some text');
    // An emptied name keeps the old one.
    const name = patch.name === undefined ? cur.name : cleanName(patch.name) || cur.name;
    if (name === cur.name && text === cur.text) return { ...cur };
    const next = { ...cur, name, text, updatedAt: Date.now() };
    this.save(list.map((p, j) => (j === i ? next : p)));
    return { ...next };
  }

  remove(id: string): boolean {
    const list = this.load();
    if (!list.some((p) => p.id === id)) return false;
    this.save(list.filter((p) => p.id !== id));
    return true;
  }

  /** The named prompts first, in that order; the rest keep their order after them. */
  reorder(ids: string[]): SavedPrompt[] {
    const list = this.load();
    const byId = new Map(list.map((p) => [p.id, p]));
    const head: SavedPrompt[] = [];
    for (const id of ids) {
      const p = byId.get(id);
      if (p && !head.includes(p)) head.push(p);
    }
    const next = [...head, ...list.filter((p) => !head.includes(p))];
    if (next.every((p, i) => p === list[i])) return this.all();
    this.save(next);
    return this.all();
  }
}

const stores = new WeakMap<App, PromptStore>();

/** The app's saved prompts (one store per app). */
export function promptsOf(app: App): PromptStore {
  let s = stores.get(app);
  if (!s) {
    s = new PromptStore(app.store.dir, (prompts) => app.emit({ type: 'prompts.updated', prompts }));
    stores.set(app, s);
  }
  return s;
}

export function registerPrompts(app: App) {
  const store = () => promptsOf(app);
  const id = (v: unknown) => {
    if (typeof v !== 'string' || !v) throw new Error('Missing id');
    return v;
  };
  app.register('prompts.list', () => store().all());
  app.register('prompts.save', ({ name, text }) => store().add(name, text));
  app.register('prompts.update', ({ id: pid, name, text }) => store().update(id(pid), { name, text }));
  app.register('prompts.remove', ({ id: pid }) => ({ ok: store().remove(id(pid)) }));
  app.register('prompts.reorder', ({ ids }) => store().reorder(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []));
}
