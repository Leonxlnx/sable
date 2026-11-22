/**
 * The palette runs one action per opening: the first run takes it, and anything after it while the
 * palette leaves (a second Enter, a click on a row) is refused. Reset when the palette opens.
 */
export function takeRun(ran: { current: boolean }): boolean {
  if (ran.current) return false;
  ran.current = true;
  return true;
}
