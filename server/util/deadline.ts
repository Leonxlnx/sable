export class DeadlineExceeded extends Error {
  /** The work that missed this deadline. It goes on: a caller may attach to its real end. */
  declare readonly work?: Promise<unknown>;
}

/** The timer belongs to this wait and is released on either outcome. Callers fence late effects. */
export function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.defineProperty(new DeadlineExceeded(label + ' timed out.'), 'work', { value: work })), ms);
    timer.unref?.();
  })]).finally(() => clearTimeout(timer));
}

/** The real end of work that missed its deadline, through nested deadlines. Any other error is itself again. */
export function lateEnd(err: unknown): Promise<void> {
  if (!(err instanceof DeadlineExceeded) || !err.work) return Promise.reject(err);
  return err.work.then(() => {}, lateEnd);
}
