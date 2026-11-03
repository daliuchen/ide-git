import type { GitOperationState } from '../shared/models';

export interface BranchStatus {
  /** Undefined when HEAD is detached. */
  branch?: string;
  /** Undefined in a repository without commits. */
  head?: string;
  upstream?: string;
  ahead: number;
  behind: number;
}

/** Reads the `# branch.*` header of `git status --porcelain=v2 --branch`. */
export function parseBranchStatus(output: string): BranchStatus {
  const status: BranchStatus = { ahead: 0, behind: 0 };
  for (const line of output.split('\n')) {
    if (!line.startsWith('# branch.')) continue;
    const [key, ...rest] = line.slice('# branch.'.length).split(' ');
    const value = rest.join(' ');
    if (key === 'oid' && value !== '(initial)') status.head = value;
    else if (key === 'head' && value !== '(detached)') status.branch = value;
    else if (key === 'upstream') status.upstream = value;
    else if (key === 'ab') {
      const match = /^\+(\d+) -(\d+)$/u.exec(value);
      if (match) {
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
      }
    }
  }
  return status;
}

const OPERATION_LABEL: Record<GitOperationState, string> = {
  merge: 'merging',
  rebase: 'rebasing',
  'cherry-pick': 'cherry-picking',
  revert: 'reverting',
};

export interface BranchPresentation {
  text: string;
  tooltip: string;
}

export function presentBranchStatus(
  status: BranchStatus,
  options: { repositoryName: string; showRepositoryName: boolean; operationState?: GitOperationState },
): BranchPresentation {
  const name = status.branch ?? status.head?.slice(0, 8) ?? 'HEAD';
  const icon = status.branch ? '$(git-branch)' : '$(git-commit)';
  const counts = [
    status.ahead ? `↑${String(status.ahead)}` : '',
    status.behind ? `↓${String(status.behind)}` : '',
  ].filter(Boolean);
  const operation = options.operationState ? ` (${OPERATION_LABEL[options.operationState]})` : '';
  const prefix = options.showRepositoryName ? `${options.repositoryName}: ` : '';
  const text = `${icon} ${prefix}${name}${operation}${counts.length ? ` ${counts.join(' ')}` : ''}`;
  const tooltip = [
    options.repositoryName,
    status.branch ? `Branch ${status.branch}` : `Detached HEAD at ${name}`,
    ...(status.upstream
      ? [`Upstream ${status.upstream} · ${String(status.ahead)} ahead, ${String(status.behind)} behind`]
      : status.branch
        ? ['No upstream branch']
        : []),
    ...(options.operationState ? [`A ${options.operationState} is in progress`] : []),
    'Click to open Branches',
  ].join('\n');
  return { text, tooltip };
}
