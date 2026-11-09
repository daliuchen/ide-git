import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitOperationService, getOperationConfirmation } from '../../src/git/GitOperationService';
import { GitCommandError, GitRunner } from '../../src/git/GitRunner';
import { parseWebviewMessage } from '../../src/protocol/messages';
import type { RepositorySummary } from '../../src/shared/models';
import {
  defaultWorktreePath,
  displayWorktreePath,
  isDirtyWorktreeError,
  parseBranchInOtherWorktree,
  parseWorktreeList,
  worktreeLabel,
  worktreePathProblem,
} from '../../src/worktrees/worktrees';

const execFileAsync = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const identity = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  return (await execFileAsync('git', args, { cwd, env: { ...process.env, ...identity } })).stdout.trim();
}

const LIST = `worktree /Users/me/code/app
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /Users/me/code/app-feat-x
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feat/x

worktree /Users/me/tmp/review copy
HEAD 3333333333333333333333333333333333333333
detached
locked keep it

worktree /private/tmp/gone
HEAD 4444444444444444444444444444444444444444
branch refs/heads/old
prunable gitdir file points to non-existent location

`;

describe('worktree helpers', () => {
  it('parses git worktree list --porcelain', () => {
    const worktrees = parseWorktreeList(LIST, '/Users/me/code/app-feat-x', '/Users/me');
    expect(worktrees.map((worktree) => [worktreeLabel(worktree), worktree.displayPath, worktree.isMain, worktree.isCurrent])).toEqual([
      ['main', '~/code/app', true, false],
      ['feat/x', '~/code/app-feat-x', false, true],
      ['(detached 3333333)', '~/tmp/review copy', false, false],
      ['old', '/private/tmp/gone', false, false],
    ]);
    expect(worktrees[2]?.locked).toBe('keep it');
    expect(worktrees[3]?.prunable).toBe('gitdir file points to non-existent location');
    expect(parseWorktreeList('worktree /srv/repo.git\nbare\n')[0]).toMatchObject({ bare: true, isMain: true });
    expect(worktreeLabel({ path: '/srv/repo.git', displayPath: '/srv/repo.git', bare: true, detached: false, isMain: true, isCurrent: false })).toBe('(bare)');
    expect(parseWorktreeList('')).toEqual([]);
  });

  it('treats /tmp and /private/tmp as the same worktree', () => {
    expect(parseWorktreeList(LIST, '/tmp/gone')[3]?.isCurrent).toBe(true);
  });

  it('names a default folder next to the repository', () => {
    expect(defaultWorktreePath('/Users/me/code/app', 'feat/new thing')).toBe('/Users/me/code/app-feat-new-thing');
    expect(defaultWorktreePath('/Users/me/code/app', '///')).toBe('/Users/me/code/app-worktree');
    expect(displayWorktreePath('/Users/me', '/Users/me')).toBe('~');
    expect(displayWorktreePath('/Users/meow/x', '/Users/me')).toBe('/Users/meow/x');
  });

  it('validates paths and recognizes Git errors', () => {
    expect(worktreePathProblem('/Users/me/code/app 2')).toBeUndefined();
    expect(worktreePathProblem('relative/path')).toBeDefined();
    expect(worktreePathProblem('/a\n/b')).toBeDefined();
    expect(worktreePathProblem('  ')).toBeDefined();
    expect(parseBranchInOtherWorktree("fatal: 'feat/x' is already used by worktree at '/Users/me/my wt'\n")).toEqual({
      branch: 'feat/x',
      path: '/Users/me/my wt',
    });
    expect(parseBranchInOtherWorktree("fatal: 'main' is already checked out at '/srv/app'")).toEqual({ branch: 'main', path: '/srv/app' });
    expect(parseBranchInOtherWorktree('fatal: something else')).toBeUndefined();
    expect(isDirtyWorktreeError("fatal: '/x' contains modified or untracked files, use --force to delete it")).toBe(true);
  });
});

describe('worktree messages from the Log', () => {
  const command = (value: Record<string, unknown>) =>
    parseWebviewMessage({ type: 'workbenchCommand', requestId: 'c', repositoryId: 'r', command: value });

  it('accepts worktree commands and rejects bad input', () => {
    expect(command({ kind: 'manageWorktrees' })).toBeDefined();
    expect(command({ kind: 'newWorktree' })).toBeDefined();
    expect(command({ kind: 'newWorktree', ref: 'origin/feat' })).toBeDefined();
    expect(command({ kind: 'newWorktree', ref: '--orphan' })).toBeUndefined();
    expect(command({ kind: 'worktreeAction', path: '/Users/me/app 2', action: 'switch' })).toBeDefined();
    expect(command({ kind: 'worktreeAction', path: '/x', action: 'rm -rf' })).toBeUndefined();
    expect(command({ kind: 'worktreeAction', path: '/x\n/y', action: 'remove' })).toBeUndefined();
  });

  it('does not let the webview run worktree operations directly', () => {
    expect(
      parseWebviewMessage({ type: 'runOperation', requestId: 'o', repositoryId: 'r', operation: { kind: 'removeWorktree', path: '/x', force: true } }),
    ).toBeUndefined();
  });
});

describe('worktree operations in a real repository', () => {
  async function fixture() {
    const path = await realpath(await mkdtemp(join(tmpdir(), 'worktrees-')));
    directories.push(path);
    const remote = join(path, 'remote.git');
    const work = join(path, 'work');
    await git(path, 'init', '-q', '--bare', '-b', 'main', remote);
    await git(path, 'init', '-q', '-b', 'main', work);
    await writeFile(join(work, 'a.txt'), 'a\n');
    await git(work, 'add', '-A');
    await git(work, 'commit', '-q', '-m', 'base');
    await git(work, 'branch', 'feat/x');
    await git(work, 'remote', 'add', 'origin', remote);
    await git(work, 'push', '-q', 'origin', 'main:shared');
    await git(work, 'fetch', '-q', 'origin');
    const repository: RepositorySummary = {
      id: work,
      rootUri: pathToFileURL(work).toString(),
      gitDirUri: pathToFileURL(join(work, '.git')).toString(),
      displayName: 'work',
      isBare: false,
      currentBranch: 'main',
    };
    return { path, work, repository };
  }
  const service = (inspect?: (repository: RepositorySummary) => Promise<RepositorySummary>) =>
    new GitOperationService(new GitRunner(), { inspectRepository: inspect ?? ((repository) => Promise.resolve(repository)) });
  const list = async (work: string) => parseWorktreeList(await git(work, 'worktree', 'list', '--porcelain'), work);

  it('creates worktrees from a local branch, a new branch and a remote branch', async () => {
    const { path, work, repository } = await fixture();
    const operations = service();
    await operations.run(repository, { kind: 'addWorktree', path: join(path, 'with space'), ref: 'feat/x' });
    await operations.run(repository, { kind: 'addWorktree', path: join(path, '新分支'), ref: 'main', newBranch: 'feat/new' });
    await operations.run(repository, { kind: 'addWorktree', path: join(path, 'shared'), ref: 'origin/shared', newBranch: 'shared', track: true });
    const worktrees = await list(work);
    expect(worktrees.map((worktree) => [worktree.branch, worktree.path])).toEqual([
      ['main', work],
      ['shared', join(path, 'shared')],
      ['feat/x', join(path, 'with space')],
      ['feat/new', join(path, '新分支')],
    ]);
    expect(await git(work, 'config', 'branch.shared.remote')).toBe('origin');
  });

  it('hands a checkout of a branch used by another worktree to the resolver', async () => {
    const { path, repository } = await fixture();
    const operations = service();
    await operations.run(repository, { kind: 'addWorktree', path: join(path, 'x'), ref: 'feat/x' });
    const resolveBranchInOtherWorktree = vi.fn(() => Promise.resolve());
    const result = await operations.run(repository, { kind: 'checkout', ref: 'feat/x' }, { resolveBranchInOtherWorktree });
    expect(result.cancelled).toBe(true);
    expect(resolveBranchInOtherWorktree).toHaveBeenCalledWith('feat/x', join(path, 'x'));
    // Without a resolver the Git error is reported as before.
    await expect(operations.run(repository, { kind: 'checkout', ref: 'feat/x' })).rejects.toBeInstanceOf(GitCommandError);
  });

  it('removes a clean worktree, and needs force for one with changes', async () => {
    const { path, work, repository } = await fixture();
    const operations = service();
    const confirm = vi.fn(() => Promise.resolve(true));
    await operations.run(repository, { kind: 'addWorktree', path: join(path, 'clean'), ref: 'feat/x' });
    await operations.run(repository, { kind: 'removeWorktree', path: join(path, 'clean') }, { confirm });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect((await list(work)).length).toBe(1);

    await operations.run(repository, { kind: 'addWorktree', path: join(path, 'dirty'), ref: 'feat/x' });
    await writeFile(join(path, 'dirty', 'new.txt'), 'work in progress\n');
    const error = await operations.run(repository, { kind: 'removeWorktree', path: join(path, 'dirty') }, { confirm }).catch((caught: unknown) => caught);
    expect(error instanceof GitCommandError && isDirtyWorktreeError(error.stderr.toString('utf8'))).toBe(true);
    await operations.run(repository, { kind: 'removeWorktree', path: join(path, 'dirty'), force: true }, { confirm });
    expect((await list(work)).length).toBe(1);
    // The branch survives its worktree.
    expect(await git(work, 'branch', '--list', 'feat/x')).toContain('feat/x');
  });

  it('does nothing when the removal is not confirmed', async () => {
    const { path, work, repository } = await fixture();
    const operations = service();
    await operations.run(repository, { kind: 'addWorktree', path: join(path, 'keep'), ref: 'feat/x' });
    const result = await operations.run(repository, { kind: 'removeWorktree', path: join(path, 'keep') }, { confirm: () => Promise.resolve(false) });
    expect(result.cancelled).toBe(true);
    expect((await list(work)).length).toBe(2);
  });

  it('prunes a worktree whose folder was deleted', async () => {
    const { path, work, repository } = await fixture();
    const operations = service();
    await operations.run(repository, { kind: 'addWorktree', path: join(path, 'gone'), ref: 'feat/x' });
    await rm(join(path, 'gone'), { recursive: true, force: true });
    await operations.run(repository, { kind: 'pruneWorktrees' });
    expect((await list(work)).map((worktree) => worktree.path)).toEqual([work]);
  });

  it('rejects bad input before running Git and works during a rebase', async () => {
    const { path, work, repository } = await fixture();
    const operations = service();
    await expect(operations.run(repository, { kind: 'addWorktree', path: 'relative', ref: 'main' })).rejects.toThrow(/worktree path/u);
    await expect(operations.run(repository, { kind: 'addWorktree', path: join(path, 'x'), ref: '--orphan' })).rejects.toThrow(/revision/u);
    await expect(
      operations.run(repository, { kind: 'addWorktree', path: join(path, 'x'), ref: 'main', newBranch: '-b' }),
    ).rejects.toThrow(/branch name/u);
    expect(getOperationConfirmation(repository, { kind: 'removeWorktree', path: '/x' })?.confirmLabel).toBe('Remove Worktree');
    expect(getOperationConfirmation(repository, { kind: 'removeWorktree', path: '/x', force: true })?.confirmLabel).toBe('Delete Anyway');
    expect(getOperationConfirmation(repository, { kind: 'addWorktree', path: '/x', ref: 'main' })).toBeUndefined();

    await service((candidate) => Promise.resolve({ ...candidate, operationState: 'rebase' })).run(repository, {
      kind: 'addWorktree',
      path: join(path, 'during-rebase'),
      ref: 'feat/x',
    });
    expect((await list(work)).length).toBe(2);
  });
});
