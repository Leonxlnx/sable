/**
 * Errors of the connection itself, told apart from the desktop's own answers: a call that never went
 * (`unsent`), one whose socket went away before the answer (`lost`), one the desktop did not answer
 * in time (`timeout`). After `lost` or `timeout` the desktop may have done what was asked: whoever
 * asked looks again rather than taking it as a no. Pure, so it can be tested.
 */
export type TransportKind = 'unsent' | 'lost' | 'timeout';

export type TransportError = Error & { transport: TransportKind };

export const transportError = (text: string, kind: TransportKind): TransportError => Object.assign(new Error(text), { transport: kind });

/** The connection failed this call (not the desktop): it is worth asking again once connected. */
export const isTransport = (err: unknown): err is TransportError => !!err && typeof (err as { transport?: unknown }).transport === 'string';

/** The call may have been done on the desktop (its answer never came). */
export const isUncertain = (err: unknown) => isTransport(err) && err.transport !== 'unsent';
