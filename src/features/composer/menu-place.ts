/**
 * Where a menu the bar opens stands: by its own chip, as every menu does. 8 px off the chip and
 * aligned with the chip's edge (the left one for the attach and mode menus, the right one for
 * model and effort), above it in a chat and below it on home. It may lie over the pane: the
 * pointer's way from the chip to the first row is what counts. (0.2.21 stood the menus clear of
 * the pane instead, flush with its side; with a draft of a few lines the model menu then opened
 * some 150 px above the chip that was clicked.)
 *
 * The side is decided here, before the menu is drawn, and Radix never flips it (the menus'
 * `avoidCollisions={false}`): the mode menu turns its rows so the mode in use is the one nearest
 * the chip, and a menu Radix flipped kept the order of the side it left. It stays inside the
 * window by the room it is given: a side is taken only with the room the menu needs, and a menu
 * whose list scrolls is held to the room there (Radix's available height, `.mm-pop`). Pure:
 * Controls.tsx measures and passes the chip's box.
 */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Placed {
  /** The side the menu opens on. */
  side: 'top' | 'bottom';
  /** Radix `sideOffset`: from the chip's edge to the menu, in CSS px. */
  sideOffset: number;
  /** Radix `alignOffset`: the menu's edge on the chip's. */
  alignOffset: number;
}

/** The gap between a menu and its chip. */
export const GAP = 8;

/** The window's own margin a menu keeps (the menus' `collisionPadding`). */
export const MARGIN = 10;

/** The room for a menu on one side of its chip, in CSS px: to the window's edge, less the gap and the margin. */
export function roomBeside(chip: Box, side: 'top' | 'bottom', viewHeight: number, zoom = 1): number {
  const z = zoom > 0 ? zoom : 1;
  return (side === 'top' ? chip.top : viewHeight - chip.bottom) / z - GAP - MARGIN;
}

/**
 * The side a menu opens on, and its place there. It opens where it is wanted (above the chip in a
 * chat, below it on home) when the window has the room it needs there, else on the side with more
 * room. `need` is the height the menu must have: all of it for a plain menu, a few rows for one
 * whose list scrolls inside it.
 */
export function placeMenu(chip: Box, want: 'top' | 'bottom', need: number, viewHeight: number, zoom = 1): Placed {
  const other = want === 'top' ? 'bottom' : 'top';
  const here = roomBeside(chip, want, viewHeight, zoom);
  const side = here >= need || here >= roomBeside(chip, other, viewHeight, zoom) ? want : other;
  return { side, sideOffset: GAP, alignOffset: 0 };
}
