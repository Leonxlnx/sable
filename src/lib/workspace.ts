import { bridge } from '@/lib/bridge';
import type { GitWorktree } from '../../shared/protocol';

/**
 * Read-only workspace lookups used by the composer (file mentions, branch chip).
 * No action exists for these yet; they never change state, so they live here.
 */

export type FileHit = { path: string; rel: string; dir: boolean };

export const searchFiles = (cwd: string, query: string, limit = 40): Promise<FileHit[]> => bridge.call('fs.search', { cwd, query, limit });

/** The checked-out branch (the refs only, not a full status); undefined outside a repo or when detached. */
export const currentBranch = (cwd: string): Promise<string | undefined> => bridge.call('git.branches', { cwd }).then((b) => b.current);

/** The repository's working trees, main checkout first; [] outside a repo. */
export const worktrees = (cwd: string): Promise<GitWorktree[]> => bridge.call('git.worktrees', { cwd });
