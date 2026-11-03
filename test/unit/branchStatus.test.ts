import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBranchStatus, presentBranchStatus } from '../../src/statusBar/branchStatus';

const execFileAsync = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const identity = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  return (await execFileAsync('git', args, { cwd, env: { ...process.env, ...identity } })).stdout;
}

async function commit(cwd: string, name: string): Promise<void> {
  await writeFile(join(cwd, name), `${name}\n`);
  await git(cwd, 'add', name);
  await git(cwd, 'commit', '-q', '-m', name);
}

describe('parseBranchStatus', () => {
  it('reads branch, upstream and ahead/behind', () => {
    expect(
      parseBranchStatus('# branch.oid abc123\n# branch.head feature/x\n# branch.upstream origin/feature/x\n# branch.ab +2 -3\n1 .M N... x\n'),
    ).toEqual({ head: 'abc123', branch: 'feature/x', upstream: 'origin/feature/x', ahead: 2, behind: 3 });
    expect(parseBranchStatus('# branch.oid abc123\n# branch.head (detached)\n')).toEqual({ head: 'abc123', ahead: 0, behind: 0 });
    expect(parseBranchStatus('# branch.oid (initial)\n# branch.head main\n')).toEqual({ branch: 'main', ahead: 0, behind: 0 });
  });

  it('reads the counts from a real repository with a remote', async () => {
    const remote = await mkdtemp(join(tmpdir(), 'branch-status-remote-'));
    const work = await mkdtemp(join(tmpdir(), 'branch-status-work-'));
    const other = await mkdtemp(join(tmpdir(), 'branch-status-other-'));
    directories.push(remote, work, other);
    await git(remote, 'init', '-q', '--bare', '-b', 'main');
    await git(work, 'init', '-q', '-b', 'main');
    await commit(work, 'base');
    await git(work, 'remote', 'add', 'origin', remote);
    await git(work, 'push', '-q', '-u', 'origin', 'main');
    await git(other, 'clone', '-q', remote, '.');
    await commit(other, 'theirs');
    await git(other, 'push', '-q');
    await commit(work, 'mine-1');
    await commit(work, 'mine-2');
    await git(work, 'fetch', '-q');
    const status = parseBranchStatus(await git(work, 'status', '--porcelain=v2', '--branch', '--untracked-files=no'));
    expect(status).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 });
  });
});

describe('presentBranchStatus', () => {
  const options = { repositoryName: 'repo', showRepositoryName: false };
  it('formats the status bar text', () => {
    expect(presentBranchStatus({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 0 }, options).text).toBe('$(git-branch) main ↑2');
    expect(presentBranchStatus({ branch: 'main', ahead: 0, behind: 0 }, options).text).toBe('$(git-branch) main');
    expect(presentBranchStatus({ head: 'abcdef1234', ahead: 0, behind: 0 }, options).text).toBe('$(git-commit) abcdef12');
    expect(
      presentBranchStatus({ branch: 'main', upstream: 'origin/main', ahead: 1, behind: 4 }, { ...options, showRepositoryName: true, operationState: 'rebase' }).text,
    ).toBe('$(git-branch) repo: main (rebasing) ↑1 ↓4');
  });

  it('explains the counts and the click in the tooltip', () => {
    const { tooltip } = presentBranchStatus({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 3 }, options);
    expect(tooltip).toContain('Upstream origin/main · 2 ahead, 3 behind');
    expect(tooltip).toContain('Click to open Branches');
    expect(presentBranchStatus({ branch: 'main', ahead: 0, behind: 0 }, options).tooltip).toContain('No upstream branch');
  });
});
