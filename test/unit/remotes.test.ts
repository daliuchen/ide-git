import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitOperationService, getOperationConfirmation } from '../../src/git/GitOperationService';
import { GitRunner } from '../../src/git/GitRunner';
import { displayRemoteUrl, parseRemotes, remoteNameProblem, remoteUrlProblem } from '../../src/remotes/remotes';
import type { RepositorySummary } from '../../src/shared/models';

const execFileAsync = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const identity = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  return (await execFileAsync('git', args, { cwd, env: { ...process.env, ...identity } })).stdout.trim();
}

describe('remote helpers', () => {
  it('parses git remote -v, keeping a different push URL', () => {
    expect(
      parseRemotes(
        'origin\thttps://github.com/me/repo.git (fetch)\norigin\thttps://github.com/me/repo.git (push)\n' +
          'upstream\t/Users/me/My Repos/up.git (fetch)\nupstream\tno_push (push)\n',
      ),
    ).toEqual([
      { name: 'origin', fetchUrl: 'https://github.com/me/repo.git' },
      { name: 'upstream', fetchUrl: '/Users/me/My Repos/up.git', pushUrl: 'no_push' },
    ]);
    expect(parseRemotes('')).toEqual([]);
  });

  it('validates names and URLs and hides credentials', () => {
    expect(remoteNameProblem('upstream')).toBeUndefined();
    expect(remoteNameProblem('team/fork')).toBeUndefined();
    expect(remoteNameProblem('origin', ['origin'])).toContain('already exists');
    for (const bad of ['', '-x', 'a b', 'a..b', 'x.lock', 'x.']) expect(remoteNameProblem(bad), bad).toBeDefined();
    expect(remoteUrlProblem('/Users/me/My Repos/up.git')).toBeUndefined();
    expect(remoteUrlProblem('--upload-pack=evil')).toBeDefined();
    expect(remoteUrlProblem('https://x\nhttps://y')).toBeDefined();
    expect(displayRemoteUrl('https://me:token@github.com/me/repo.git')).toBe('https://***@github.com/me/repo.git');
  });
});

describe('remote operations in a real repository', () => {
  async function fixture() {
    const path = await mkdtemp(join(tmpdir(), 'remotes-'));
    directories.push(path);
    const remote = join(path, 'remote.git');
    const work = join(path, 'work');
    await git(path, 'init', '-q', '--bare', '-b', 'main', remote);
    await git(path, 'init', '-q', '-b', 'main', work);
    await writeFile(join(work, 'a.txt'), 'a\n');
    await git(work, 'add', '-A');
    await git(work, 'commit', '-q', '-m', 'base');
    const repository: RepositorySummary = {
      id: work,
      rootUri: pathToFileURL(work).toString(),
      gitDirUri: pathToFileURL(join(work, '.git')).toString(),
      displayName: 'work',
      isBare: false,
    };
    return { remote, work, repository };
  }
  const service = (inspect?: (repository: RepositorySummary) => Promise<RepositorySummary>) =>
    new GitOperationService(new GitRunner(), { inspectRepository: inspect ?? ((repository) => Promise.resolve(repository)) });

  it('adds, edits, renames and removes a remote', async () => {
    const { remote, work, repository } = await fixture();
    const operations = service();
    await operations.run(repository, { kind: 'addRemote', name: 'origin', url: remote });
    await operations.run(repository, { kind: 'fetch', remote: 'origin' });
    await git(work, 'push', '-q', '-u', 'origin', 'main');
    await operations.run(repository, { kind: 'setRemoteUrl', name: 'origin', url: `${remote}/` });
    expect(await git(work, 'remote', 'get-url', 'origin')).toBe(`${remote}/`);
    await operations.run(repository, { kind: 'renameRemote', oldName: 'origin', newName: 'upstream' });
    expect(await git(work, 'config', 'branch.main.remote')).toBe('upstream');
    expect(await git(work, 'branch', '-r')).toBe('upstream/main');
    const confirm = vi.fn(() => Promise.resolve(true));
    await operations.run(repository, { kind: 'removeRemote', name: 'upstream' }, { confirm });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await git(work, 'remote')).toBe('');
    expect(await git(work, 'branch', '-r')).toBe('');
  });

  it('rejects bad names and URLs before running Git, and asks before removing', async () => {
    const { repository } = await fixture();
    const operations = service();
    await expect(operations.run(repository, { kind: 'addRemote', name: '-bad', url: '/tmp/x' })).rejects.toThrow(/remote name/u);
    await expect(operations.run(repository, { kind: 'addRemote', name: 'ok', url: '--upload-pack=x' })).rejects.toThrow(/remote URL/u);
    expect(getOperationConfirmation(repository, { kind: 'removeRemote', name: 'origin' })?.confirmLabel).toBe('Remove Remote');
    expect(getOperationConfirmation(repository, { kind: 'addRemote', name: 'origin', url: '/x' })).toBeUndefined();
  });

  it('works while a rebase is in progress', async () => {
    const { remote, work, repository } = await fixture();
    await service((candidate) => Promise.resolve({ ...candidate, operationState: 'rebase' })).run(repository, {
      kind: 'addRemote',
      name: 'origin',
      url: remote,
    });
    expect(await git(work, 'remote')).toBe('origin');
  });
});
