export class DeadlineExceeded extends Error {}

/** The timer belongs to this wait and is released on either outcome. Callers fence late effects. */
export function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded(label + ' timed out.')), ms);
    timer.unref?.();
  })]).finally(() => clearTimeout(timer));
}
