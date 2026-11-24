/**
 * The triage deck's logic, kept free of React so it can be tested: the order of the stack, which
 * key does what, and when the deck may take a key at all.
 */
import type { PermissionOption } from '@shared/protocol';

// ── the stack ──

/** How a card left the stack: answered yes (up), answered no (aside), sent to the back, or gone elsewhere. */
export type Exit = 'allow' | 'deny' | 'back' | 'away';

export interface DeckState {
  /** Card keys front to back. */
  order: string[];
  /**
   * Cards answered here, with how they left. Kept while the deck is open: a card still flying off
   * when the bridge confirms keeps its path, and an answered card never comes back meanwhile.
   */
  gone: Record<string, Exit>;
  /** Cards answered in this opening of the deck (for its end state). */
  answered: number;
}

export type DeckEvent =
  /** The prompts waiting now, oldest first. */
  | { type: 'sync'; keys: string[] }
  /** The front card goes to the back. */
  | { type: 'next' }
  /** The back card comes to the front. */
  | { type: 'prev' }
  | { type: 'answer'; key: string; exit: Exit }
  /** This card comes to the front (a notification's click asked for it); the order behind it is kept. */
  | { type: 'raise'; key: string };

export const emptyDeck = (keys: string[] = []): DeckState => ({ order: keys, gone: {}, answered: 0 });

/**
 * Cards keep their place while the deck is open: one answered elsewhere leaves, a new one joins at
 * the back, and the user's own moves (next, previous) are not undone by the next update.
 */
export function deckReducer(state: DeckState, e: DeckEvent): DeckState {
  switch (e.type) {
    case 'sync': {
      const live = new Set(e.keys);
      const kept = state.order.filter((k) => live.has(k));
      const have = new Set(kept);
      const order = [...kept, ...e.keys.filter((k) => !have.has(k) && !state.gone[k])];
      return sameList(order, state.order) ? state : { ...state, order };
    }
    case 'next':
      return state.order.length < 2 ? state : { ...state, order: [...state.order.slice(1), state.order[0]] };
    case 'prev':
      return state.order.length < 2 ? state : { ...state, order: [state.order[state.order.length - 1], ...state.order.slice(0, -1)] };
    case 'raise': {
      const at = state.order.indexOf(e.key);
      return at <= 0 ? state : { ...state, order: [...state.order.slice(at), ...state.order.slice(0, at)] };
    }
    case 'answer':
      if (!state.order.includes(e.key)) return state;
      return { order: state.order.filter((k) => k !== e.key), gone: { ...state.gone, [e.key]: e.exit }, answered: state.answered + 1 };
  }
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** How a card that is no longer drawn left: as answered here, sent beyond the visible stack, or answered elsewhere. */
export function exitOf(state: DeckState, key: string, live: ReadonlySet<string>): Exit {
  return state.gone[key] ?? (live.has(key) ? 'back' : 'away');
}

// ── keys ──

export type DeckAction =
  | { type: 'close' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'open' }
  /** Enter on a permission: its allow answer. */
  | { type: 'allow' }
  /** Shift+Enter on a permission: its first "always" answer. */
  | { type: 'always' }
  /** D on a permission: its first deny answer (with a note where the agent takes one). */
  | { type: 'deny' }
  /** 1 to 9: a permission's answer, or a question's option ("Other" right after the last), by position. */
  | { type: 'pick'; index: number }
  /** Enter on a question: the next question, or send the answers. */
  | { type: 'advance' }
  /** S on a question: send no answer. */
  | { type: 'skip' }
  /** Left and right on a question with several parts. */
  | { type: 'step'; by: 1 | -1 };

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** What a key does in the deck, for the front card's kind (null: no card in front). */
export function deckAction(e: KeyLike, kind: 'permission' | 'question' | null): DeckAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === 'Escape') return { type: 'close' };
  if (!kind) return null;
  if (!e.shiftKey && (k === 'j' || k === 'ArrowDown')) return { type: 'next' };
  if (!e.shiftKey && (k === 'k' || k === 'ArrowUp')) return { type: 'prev' };
  if (!e.shiftKey && k === 'o') return { type: 'open' };
  if (/^[1-9]$/.test(k) && !e.shiftKey) return { type: 'pick', index: Number(k) - 1 };
  if (kind === 'permission') {
    if (k === 'Enter') return { type: e.shiftKey ? 'always' : 'allow' };
    if (k === 'd' && !e.shiftKey) return { type: 'deny' };
    return null;
  }
  if (k === 'Enter' && !e.shiftKey) return { type: 'advance' };
  if (k === 's' && !e.shiftKey) return { type: 'skip' };
  if (!e.shiftKey && (k === 'ArrowRight' || k === 'ArrowLeft')) return { type: 'step', by: k === 'ArrowRight' ? 1 : -1 };
  return null;
}

/**
 * Whether the deck may act on a key: not a held key (a held Enter must not approve card after card),
 * not while composing text, and not while typing in a field (the note, "Other") or with a button
 * focused for Enter and Space (it answers those itself). Escape always reaches the deck.
 */
export function deckKeyAllowed(e: KeyLike & { repeat?: boolean; isComposing?: boolean; defaultPrevented?: boolean; target?: EventTarget | null }): boolean {
  if (e.defaultPrevented || e.isComposing || e.repeat) return false;
  const t = e.target as (Partial<HTMLElement> & { tagName?: string }) | null | undefined;
  if (!t?.tagName) return true;
  if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return false;
  if ((e.key === 'Enter' || e.key === ' ') && /^(BUTTON|A)$/.test(t.tagName)) return false;
  return true;
}

// ── a permission's answers ──

export interface OptionKeys {
  allow?: PermissionOption;
  always?: PermissionOption;
  deny?: PermissionOption;
  /** The key for each answer, in the options' order (named in the button's tooltip, never printed on it). */
  hints: string[];
}

/** Which answer Enter, Shift+Enter and D give, and the key for each answer (the rest by position). */
export function optionKeys(options: PermissionOption[]): OptionKeys {
  const allow = options.find((o) => o.tone === 'allow') ?? options.find((o) => o.tone !== 'deny');
  const always = options.find((o) => o.tone === 'always' && o !== allow);
  const deny = options.find((o) => o.tone === 'deny');
  const hints = options.map((o, i) => (o === allow ? '↵' : o === always ? '⇧↵' : o === deny ? 'D' : i < 9 ? String(i + 1) : ''));
  return { allow, always, deny, hints };
}

/**
 * One order of a permission's answers wherever it is asked (the card in the chat and the deck's):
 * every no first, apart on the left; then the other answers in the agent's order; the plain allow
 * (the primary, Enter's answer) last, on the right edge.
 */
export function answerOrder(options: PermissionOption[]): { no: PermissionOption[]; yes: PermissionOption[] } {
  const { allow } = optionKeys(options);
  const no = options.filter((o) => o.tone === 'deny' && o !== allow);
  const yes = options.filter((o) => o.tone !== 'deny' && o !== allow);
  return { no, yes: allow ? [...yes, allow] : yes };
}
