import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { WorktreeInfo } from '../shared/models';

export { worktreeLabel } from './worktreeLabel';

/** Shortens a path under the home directory to `~/…`. */
export function displayWorktreePath(path: string, home: string = homedir()): string {
  if (home && (path === home || path.startsWith(`${home}${sep}`))) return `~${path.slice(home.length)}`;
  return path;
}

function samePath(left: string, right: string): boolean {
  // macOS reports /tmp as /private/tmp; compare without that prefix.
  const strip = (value: string) => resolve(value).replace(/^\/private(?=\/)/u, '');
  return strip(left) === strip(right);
}

/**
 * Parses `git worktree list --porcelain`. `currentRoot` marks the worktree being shown; `home`
 * shortens paths for display.
 */
export function parseWorktreeList(output: string, currentRoot?: string, home?: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  for (const block of output.split(/\r?\n\r?\n/u)) {
    let entry: WorktreeInfo | undefined;
    for (const line of block.split(/\r?\n/u)) {
      const space = line.indexOf(' ');
      const key = space === -1 ? line : line.slice(0, space);
      const value = space === -1 ? '' : line.slice(space + 1);
      if (key === 'worktree') {
        entry = {
          path: value,
          displayPath: displayWorktreePath(value, home),
          detached: false,
          bare: false,
          isMain: worktrees.length === 0,
          isCurrent: currentRoot !== undefined && samePath(value, currentRoot),
        };
        continue;
      }
      if (!entry) continue;
      if (key === 'HEAD') entry.head = value;
      else if (key === 'branch') entry.branch = value.replace(/^refs\/heads\//u, '');
      else if (key === 'detached') entry.detached = true;
      else if (key === 'bare') entry.bare = true;
      else if (key === 'locked') entry.locked = value;
      else if (key === 'prunable') entry.prunable = value || 'missing';
    }
    if (entry) worktrees.push(entry);
  }
  return worktrees;
}

/** A sibling of the repository named after the branch: `<parent>/<repo>-<branch>`. */
export function defaultWorktreePath(repositoryRoot: string, branch: string): string {
  const slug = branch.replace(/[\\/:*?"<>|\s]+/gu, '-').replace(/^-+|-+$/gu, '') || 'worktree';
  return join(dirname(repositoryRoot), `${basename(repositoryRoot)}-${slug}`);
}

export function worktreePathProblem(value: string): string | undefined {
  const path = value.trim();
  if (!path) return 'Enter a folder for the worktree.';
  if (/[\0\r\n]/u.test(path)) return 'The path cannot contain line breaks.';
  if (!isAbsolute(path)) return 'Use an absolute path.';
  return undefined;
}

/** The worktree path Git names when a checkout fails because the branch is used elsewhere. */
export function parseBranchInOtherWorktree(stderr: string): { branch: string; path: string } | undefined {
  const match = /'([^']+)' is already (?:checked out|used by worktree) at '([^']+)'/u.exec(stderr);
  return match?.[1] && match[2] ? { branch: match[1], path: match[2] } : undefined;
}

/** Git refuses to remove a worktree with changes until `--force` is given. */
export function isDirtyWorktreeError(stderr: string): boolean {
  return /contains modified or untracked files|use --force to delete it/u.test(stderr);
}
