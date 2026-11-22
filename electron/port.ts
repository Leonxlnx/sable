/**
 * The port the desktop app serves its page on.
 *
 * A stable origin keeps the page's local storage and zoom between runs, so the installed Sable holds
 * one port. `SABLE_PORT` gives a test app a fixed origin of its own (on a free port each start it is
 * a new origin each start: it forgets the open chat and every window setting).
 *
 * Chromium refuses to load a page from some ports whatever listens there (ERR_UNSAFE_PORT, a blank
 * window): one of those, or anything that is not a user port, is not taken, and the app's own port
 * is used instead.
 */
export const DEFAULT_PORT = 47_317;

/** The ports above 1023 that Chromium refuses (its restricted list, net/base/port_util.cc). */
const UNSAFE = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

export function preferredPort(value: string | undefined): number {
  if (!value || !/^\d{4,5}$/.test(value.trim())) return DEFAULT_PORT;
  const p = Number(value.trim());
  return p >= 1024 && p <= 65_535 && !UNSAFE.has(p) ? p : DEFAULT_PORT;
}
