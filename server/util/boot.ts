/**
 * Start-up marks for the bridge and the desktop shell: when each stage of a start was reached, as
 * wall-clock milliseconds (`performance.timeOrigin + performance.now()`, comparable with the page's
 * own marks). Printed as `[boot] <name> <epoch ms>` when SABLE_BOOT_TRACE=1 (measuring runs); else
 * only kept, a few numbers.
 */
const marks = new Map<string, number>();

export function bootMark(name: string, at = performance.timeOrigin + performance.now()) {
  if (marks.has(name)) return;
  marks.set(name, at);
  if (process.env.SABLE_BOOT_TRACE === '1') console.log(`[boot] ${name} ${at.toFixed(1)}`);
}

export function bootMarks(): Record<string, number> {
  return Object.fromEntries(marks);
}
