import { useSyncExternalStore } from 'react';
import { WEB_METHODS } from '@shared/protocol';

/** The web build (mobile/vite.web.config.ts): Sable in a browser on a tablet, through the desktop's web access. */
export const WEB = !!import.meta.env.SABLE_WEB;

const allowed = new Set<string>(WEB_METHODS);

/**
 * Whether a control that calls `method` is offered here: always in the phone app; in a browser only what
 * the web allowlist admits (shared/protocol.ts `WEB_METHODS`: the desktop refuses every other method from a
 * browser, so a control for one would only ever fail). One rule for every screen.
 */
export const mayCall = (method: string, web = WEB): boolean => !web || allowed.has(method);

/**
 * The tablet layout (web/Split.tsx): a browser at least 820 px wide (an iPad in either orientation, a
 * laptop's window). Narrower, the phone's flow stays.
 */
export const SPLIT_MIN = 820;
const query = WEB && typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(`(min-width: ${SPLIT_MIN}px)`) : null;
const subscribe = (l: () => void) => {
  query?.addEventListener('change', l);
  return () => query?.removeEventListener('change', l);
};
export const isSplit = () => !!query?.matches;
export const useSplit = () => useSyncExternalStore(subscribe, isSplit);
