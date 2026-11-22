import { useStore } from '@/state/store';

/**
 * A window too narrow for three columns (about 1060 CSS px) keeps two: while the side panel is open there,
 * the sidebar steps aside without forgetting that it was open, and comes back when the panel closes.
 */
export const NARROW_PX = 1060;

/** Narrower than three columns need, in CSS pixels (the Interface size zooms the page). */
export const isNarrow = () => window.innerWidth / (useStore.getState().settings.fontScale || 1) < NARROW_PX;
