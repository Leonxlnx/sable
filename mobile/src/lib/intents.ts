/**
 * What the phone just picked for a chat (its model, effort, speed or permission mode), shown at once
 * and held against older answers until the desktop confirms it (the desktop answers in a few hundred
 * ms, the Claude agent later still; without this the effort dial went back to the old level when the
 * finger let go and came forward again with the answer, and two quick picks arrived as old, new, old,
 * new).
 *
 * Each pick has a generation per field: only the newest pick of a field may roll it back when the
 * desktop refuses it, and it goes back to what the desktop last said for that field (an update, a
 * snapshot, or a pick it accepted), never to what was shown when the refused pick was made. An older
 * pick failing after a newer one was accepted changes nothing. Pure: the store applies what it says.
 */
export type Field = 'model' | 'effort' | 'speed' | 'mode';
export const FIELDS: readonly Field[] = ['model', 'effort', 'speed', 'mode'];

type Fields = Record<string, unknown>;
interface Held {
  value: unknown;
  gen: number;
  until: number;
}

export class Intents {
  private held = new Map<string, Partial<Record<Field, Held>>>();
  /** What the desktop last said for each chat's fields: the value a refused pick goes back to. */
  private known = new Map<string, Partial<Record<Field, unknown>>>();
  private gen = 0;

  constructor(
    private readonly ms = 6000,
    private readonly now: () => number = Date.now,
  ) {}

  private live(id: string) {
    const h = this.held.get(id);
    if (!h) return undefined;
    const t = this.now();
    for (const f of FIELDS) if (h[f] && h[f]!.until < t) delete h[f];
    if (!FIELDS.some((f) => h[f])) {
      this.held.delete(id);
      return undefined;
    }
    return h;
  }

  /** What the desktop says for a chat (a list, a snapshot, an update): the truth for the fields it names. */
  heard(id: string, from: Fields) {
    let k = this.known.get(id);
    for (const f of FIELDS) {
      if (!(f in from)) continue;
      if (!k) this.known.set(id, (k = {}));
      k[f] = from[f];
    }
  }

  /** A pick shown at once; `before`: the field as shown now (the truth while the desktop has said nothing). Returns the pick's generation. */
  pick(id: string, field: Field, value: unknown, before: unknown): number {
    const k = this.known.get(id);
    if (!k || !(field in k)) this.heard(id, { [field]: before });
    let h = this.live(id);
    if (!h) this.held.set(id, (h = {}));
    const gen = ++this.gen;
    h[field] = { value, gen, until: this.now() + this.ms };
    return gen;
  }

  /** The desktop accepted a pick (any of them, in the order it answers): its value is the truth now. */
  accepted(id: string, field: Field, value: unknown) {
    this.heard(id, { [field]: value });
  }

  /**
   * The desktop refused pick `gen`. The newest pick of that field lets go and the field shows what
   * the desktop last said (`{ value }`); an older pick gets null: nothing changes.
   */
  refused(id: string, field: Field, gen: number): { value: unknown } | null {
    const h = this.live(id);
    if (h?.[field]?.gen !== gen) return null;
    delete h[field];
    if (!FIELDS.some((f) => h[f])) this.held.delete(id);
    const k = this.known.get(id);
    return k && field in k ? { value: k[field] } : null;
  }

  /** An update from the desktop without the fields still waiting for their answer (a field it confirms lets go). */
  sieve<T extends Fields>(id: string, patch: T): T {
    this.heard(id, patch);
    const h = this.live(id);
    if (!h) return patch;
    const out = { ...patch } as Fields;
    for (const f of FIELDS) {
      const want = h[f];
      if (!want || !(f in out)) continue;
      if (out[f] === want.value) delete h[f];
      else delete out[f];
    }
    if (!FIELDS.some((f) => h[f])) this.held.delete(id);
    return out as T;
  }

  /** A whole chat from the desktop (a snapshot, the list) with the picks still waiting on top. */
  over<T extends Fields & { id: string }>(meta: T): T {
    const theirs: Fields = {};
    for (const f of FIELDS) theirs[f] = meta[f];
    this.sieve(meta.id, theirs);
    const h = this.live(meta.id);
    if (!h) return meta;
    const mine: Fields = {};
    for (const f of FIELDS) if (h[f]) mine[f] = h[f]!.value;
    return { ...meta, ...mine };
  }

  /** The value a field shows now for a pick still waiting (tests, and nothing else needs it). */
  waiting(id: string, field: Field): unknown {
    return this.live(id)?.[field]?.value;
  }
}
