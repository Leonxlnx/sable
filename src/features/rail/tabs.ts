import type { IconName } from '@/icons';
import type { RailTab } from '@/state/store';

/**
 * The side panel's tabs, in the order of the row. The panel's header shows as many as fit, from the
 * first; the rest are in its More menu (`tab-row.ts` decides). Agents stands fifth: a chat that runs
 * helpers is watched there, so it has a seat in a panel of the default width. `key` is the tab's
 * shortcut (Alt+1 to Alt+8), which no tab ever changed: Agents kept Alt+7 when it moved up the row.
 * Kept free of the panel's own code, so the app shell and the palette can list them without loading it.
 */
export const RAIL_TABS: readonly { id: RailTab; label: string; icon: IconName; key: number }[] = [
  { id: 'changes', label: 'Changes', icon: 'diff', key: 1 },
  { id: 'files', label: 'Files', icon: 'folder', key: 2 },
  { id: 'browser', label: 'Browser', icon: 'globe', key: 3 },
  { id: 'terminal', label: 'Terminal', icon: 'terminal', key: 4 },
  { id: 'agents', label: 'Agents', icon: 'robot', key: 7 },
  { id: 'tasks', label: 'Tasks', icon: 'tasks', key: 5 },
  { id: 'context', label: 'Context', icon: 'context', key: 6 },
  { id: 'device', label: 'Device', icon: 'device', key: 8 },
];

/** The tab's shortcut, `alt+N`. */
export const railTabKeys = (id: RailTab): string => `alt+${RAIL_TABS.find((t) => t.id === id)?.key ?? 0}`;

/** The tab for Alt+`n` (1-based), if there is one. */
export const railTabAt = (n: number): RailTab | undefined => RAIL_TABS.find((t) => t.key === n)?.id;
