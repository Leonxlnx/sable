/**
 * The effort's rules, kept apart from the view so they can be tested.
 *
 * The levels a model offers are a scale: one stop per level, lowest first. A position is a
 * level's index; -1 is "nothing set" (a model whose level the agent decides). The phrase on the
 * bar steps it one stop at a time (its own Up and Down, the chord from the field) and the panel
 * picks from it.
 *
 * Ultracode is no stop of that scale. It is a switch of its own, at any level: turning it on or
 * off never touches the level, a level stepped or picked never touches it, and the scale ends at
 * its top level (Claude Code's Max) whatever ultracode does. (Until 24 Nov it stood as one more
 * stop past the top and took the level's word; the owner: "bei claude kann man ultracode nutzen
 * wann man will bei jedem effort".)
 */

/** The last stop's index (-1: the model offers no level). */
export const lastStop = (levels: number) => levels - 1;

/** A position held to the scale: a level's index, or -1 where nothing is set. */
export const clampStop = (pos: number, levels: number) => (levels > 0 ? Math.max(-1, Math.min(levels - 1, pos)) : -1);

/**
 * One step from `pos`, up (1) or down (-1); null where there is nowhere to go. The ends hold: up
 * from the top level stays there (the word nudges, it never wraps round and never becomes
 * anything but a level), down from the lowest stays, and "nothing set" steps only up, onto the
 * lowest level.
 */
export function stepStop(pos: number, dir: 1 | -1, levels: number): number | null {
  if (levels <= 0) return null;
  const next = pos + dir;
  if (next > levels - 1 || next < 0) return null;
  return next;
}

/** What is set: the level's index (-1: none) and whether ultracode is on. */
export interface Setting {
  level: number;
  ultra: boolean;
}

/** What a change sends: the level (its index) when it changes, ultracode when it changes. Never both. */
export interface Change {
  level?: number;
  ultra?: boolean;
}

/** Landing on a level: that level when it is another one. Ultracode stays as it is. */
export function landLevel(now: Setting, pos: number, levels: number): Change {
  const to = clampStop(pos, levels);
  return to >= 0 && to !== now.level ? { level: to } : {};
}

/** Switching ultracode: on or off when that is a change. The level stays as it is. */
export function landUltra(now: Setting, on: boolean, offered: boolean): Change {
  return offered && on !== now.ultra ? { ultra: on } : {};
}

/** What a key event says, for the rules below. */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  getModifierState?(key: string): boolean;
}

/** Windows also reports AltGr as Ctrl+Alt on layouts without an AltGraph flag. */
export const altGraph = (e: KeyLike) => !!e.getModifierState?.('AltGraph') || (e.ctrlKey && e.altKey);

/** The effort keys' modifier: Alt alone (Command+Option on a Mac, where Option with a key types). */
const effortMod = (e: KeyLike, mac: boolean) => !altGraph(e) && !e.shiftKey && (mac ? e.metaKey && e.altKey && !e.ctrlKey : e.altKey && !e.ctrlKey && !e.metaKey);

/**
 * The chord that steps the level from the field, with nothing opening and the caret where it
 * was: Alt+Right one level up, Alt+Left one down. Alt+Up and Down are the navigator's, and
 * Ctrl+Shift+Up and Down select to the paragraph's end in a field; Alt with the side arrows does
 * nothing in a field on Windows. On a Mac Option with an arrow moves by word, so there it is
 * Command+Option.
 */
export function levelChord(e: KeyLike, mac: boolean): 1 | -1 | null {
  if (!effortMod(e, mac)) return null;
  return e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : null;
}

/** The keys the chord is shown and announced with. */
export const chordKeys = (mac: boolean) => (mac ? 'mod+alt+←→' : 'alt+←→');

/**
 * The key that switches ultracode from anywhere in the composer: Alt+U (Command+Option+U on a
 * Mac), the effort keys' own modifier. Free everywhere: Alt with a digit is the side panel's tabs,
 * Alt with an arrow the navigator's, the find bar's and the level's; no Ctrl or Command key is a
 * U. Read by the letter the key types, or by its place where Alt makes it type something else
 * (Option+U on a Mac is a dead key). A held key switches once.
 */
export function ultraChord(e: KeyLike, mac: boolean): boolean {
  if (!effortMod(e, mac)) return false;
  return /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() === 'u' : e.code === 'KeyU';
}

/** The keys ultracode's switch is shown and announced with. */
export const ultraKeys = (mac: boolean) => (mac ? 'mod+alt+u' : 'alt+u');

/** Ctrl+. (Command+. on a Mac) opens the model and effort panel from anywhere in the composer. */
export function opensPanel(e: KeyLike, mac: boolean): boolean {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && !altGraph(e) && !e.altKey && !e.shiftKey && (e.key === '.' || e.code === 'Period');
}

/**
 * Whether ultracode is offered here: it is Claude Code's (the Demo plays it), and only where this
 * account's agent says so for the chat (`Capabilities.features.ultracode`, narrowed to the CLIs
 * that have its Workflow tool). Never Codex's or OpenCode's, also not for a moment after a switch
 * of agent in place while caps of the agent it left are still around. The one place the provider id
 * decides it; the chip, Alt+U and what the composer remembers of a switch all follow it.
 */
export function ultraOffered(provider: string | undefined, caps: { features: { ultracode?: boolean } } | undefined): boolean {
  return (provider === 'claude' || provider === 'demo') && !!caps?.features.ultracode;
}
