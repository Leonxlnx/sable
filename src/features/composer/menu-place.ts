/**
 * Where a menu the bar opens stands. Its chip sits inside the pane, so a menu hung 8 px off the
 * chip lay across the pane: its edge a few pixels from the pane's own, two corners side by side
 * at no particular distance, and over the words being typed. Instead it stands clear of the pane:
 * 8 px beyond the pane's edge (above it in a chat, below it on home) and flush with the pane's
 * side (the left one for the attach and mode menus, the right one for model and effort), so the
 * two are aligned rectangles. Pure: Controls.tsx measures and passes the boxes.
 */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Place {
  /** Radix `sideOffset`: from the chip's edge to the menu, in CSS px. */
  sideOffset: number;
  /** Radix `alignOffset`: negative moves the menu outward, past the chip's aligned edge. */
  alignOffset: number;
}

/** The gap between a menu and what it hangs off. */
export const GAP = 8;

/** A menu with no pane to stand off (or one that would stand too far away): by its chip. */
export const NEAR: Place = { sideOffset: GAP, alignOffset: 0 };

/**
 * A draft of many lines makes the pane tall: past this distance between the chip and the pane's
 * far edge the menu stays by its chip, or the pointer would have to cross the whole draft to it.
 */
export const FAR = 150;

export function panePlace(chip: Box, pane: Box, side: 'top' | 'bottom', align: 'start' | 'end', zoom = 1): Place {
  const z = zoom > 0 ? zoom : 1;
  const out = (side === 'top' ? chip.top - pane.top : pane.bottom - chip.bottom) / z;
  const along = (align === 'start' ? chip.left - pane.left : pane.right - chip.right) / z;
  // A chip that is not inside the pane (a layout this does not know): leave it be.
  if (!(out >= 0) || !(along >= 0) || out > FAR) return NEAR;
  return { sideOffset: Math.round(out) + GAP, alignOffset: -Math.round(along) };
}

export interface Placed extends Place {
  /** The side the menu opens on. */
  side: 'top' | 'bottom';
  /**
   * Whether the menu may move itself to stay in the window (Radix `avoidCollisions`). Off where
   * the side was decided here: a menu that flipped by itself kept the offsets of its first side
   * and landed across the pane.
   */
  avoid: boolean;
}

/** The window's own margin a menu keeps (the menus' `collisionPadding`). */
export const MARGIN = 10;

/** The room for a menu beyond the pane on one side, in CSS px: from the pane's edge to the window's, less the gap and the margin. */
export function roomBeyond(pane: Box, side: 'top' | 'bottom', viewHeight: number, zoom = 1): number {
  const z = zoom > 0 ? zoom : 1;
  return (side === 'top' ? pane.top : viewHeight - pane.bottom) / z - GAP - MARGIN;
}

/**
 * The side a menu opens on, and its place there, decided before the menu is drawn. It opens where
 * it is wanted (above the pane in a chat, below it on home) when the window has the room it needs
 * there, else on the pane's other side, standing off the pane in the same way. Where neither side
 * has the room (a very short window), or the pane is not one to stand off (a tall draft, a layout
 * this does not know), it hangs by its chip as menus do elsewhere and keeps itself in the window.
 * `need` is the height the menu must have: all of it for a plain menu, a few rows for one whose
 * list scrolls inside it.
 */
export function placeMenu(chip: Box, pane: Box, want: 'top' | 'bottom', align: 'start' | 'end', need: number, viewHeight: number, zoom = 1): Placed {
  const other = want === 'top' ? 'bottom' : 'top';
  for (const side of [want, other] as const) {
    if (roomBeyond(pane, side, viewHeight, zoom) < need) continue;
    const place = panePlace(chip, pane, side, align, zoom);
    if (place !== NEAR) return { side, avoid: false, ...place };
  }
  return { side: want, avoid: true, ...NEAR };
}
