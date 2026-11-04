import type { MergeMode } from '../../../src/protocol/messages';

/** Whether the merge would create a merge commit right away, which is when a message applies. */
export function mergeCreatesCommit(mode: MergeMode, noCommit: boolean, canFastForward: boolean): boolean {
  if (mode === 'ff-only' || mode === 'squash' || noCommit) return false;
  return mode === 'no-ff' || !canFastForward;
}
