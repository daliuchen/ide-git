import type { WorktreeInfo } from '../shared/models';

/** What a worktree row shows: its branch, or the short commit when detached. */
export function worktreeLabel(worktree: WorktreeInfo): string {
  if (worktree.bare) return '(bare)';
  if (worktree.branch) return worktree.branch;
  return `(detached ${worktree.head?.slice(0, 7) ?? 'HEAD'})`;
}
