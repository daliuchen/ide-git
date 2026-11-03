import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeCheckoutConflict,
  parseCheckoutConflict,
  unquoteGitPath,
} from '../../src/git/checkoutConflicts';
import { GitOperationService, forcedCheckoutArguments } from '../../src/git/GitOperationService';
import { GitCommandError, GitRunner } from '../../src/git/GitRunner';
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

/** main and other both have a.txt (different contents); other also adds new.txt. */
async function fixture(): Promise<{ path: string; repository: RepositorySummary }> {
  const path = await mkdtemp(join(tmpdir(), 'smart-checkout-'));
  directories.push(path);
  await git(path, 'init', '-q', '-b', 'main');
  await git(path, 'config', 'user.name', 'T');
  await git(path, 'config', 'user.email', 't@example.com');
  await writeFile(join(path, 'a.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(path, 'b.txt'), 'b\n');
  await git(path, 'add', '.');
  await git(path, 'commit', '-q', '-m', 'base');
  await git(path, 'switch', '-q', '-c', 'other');
  await writeFile(join(path, 'a.txt'), 'ONE\ntwo\nthree\n');
  await writeFile(join(path, 'new.txt'), 'theirs\n');
  await git(path, 'add', '.');
  await git(path, 'commit', '-q', '-m', 'other');
  await git(path, 'switch', '-q', 'main');
  return {
    path,
    repository: {
      id: path,
      rootUri: pathToFileURL(path).toString(),
      gitDirUri: pathToFileURL(join(path, '.git')).toString(),
      displayName: 'fixture',
      isBare: false,
    },
  };
}

const service = () =>
  new GitOperationService(new GitRunner(), { inspectRepository: (repository) => Promise.resolve(repository) });
const branch = (path: string) => git(path, 'branch', '--show-current');
const stashCount = async (path: string) => (await git(path, 'stash', 'list')).split('\n').filter(Boolean).length;

describe('checkout conflict parsing', () => {
  it('lists modified and untracked files from Git’s message', () => {
    const stderr = [
      'error: Your local changes to the following files would be overwritten by checkout:',
      '\ta.txt',
      '\t"\\344\\270\\255.txt"',
      'Please commit your changes or stash them before you switch branches.',
      'error: The following untracked working tree files would be overwritten by checkout:',
      '\tnew.txt',
      'Please move or remove them before you switch branches.',
      'Aborting',
    ].join('\n');
    expect(parseCheckoutConflict(stderr)).toEqual({ modified: ['a.txt', '中.txt'], untracked: ['new.txt'] });
    expect(parseCheckoutConflict("error: pathspec 'x' did not match")).toBeUndefined();
    expect(unquoteGitPath('"a\\tb"')).toBe('a\tb');
    expect(unquoteGitPath('plain name.txt')).toBe('plain name.txt');
  });

  it('cuts the file list off for the dialog', () => {
    const many = { modified: Array.from({ length: 12 }, (_, index) => `f${String(index)}`), untracked: [] };
    const text = describeCheckoutConflict(many);
    expect(text.split('\n')).toHaveLength(11);
    expect(text).toContain('…and 2 more');
  });

  it('forces checkout and switch differently', () => {
    expect(forcedCheckoutArguments(['checkout', 'other', '--'])).toEqual(['checkout', '-f', 'other', '--']);
    expect(forcedCheckoutArguments(['switch', '-'])).toEqual(['switch', '--discard-changes', '-']);
  });
});

describe('Smart Checkout', () => {
  it('stashes, checks out and restores local changes', async () => {
    const { path, repository } = await fixture();
    await writeFile(join(path, 'b.txt'), 'b local\n');
    await writeFile(join(path, 'a.txt'), 'one\ntwo\nthree local\n');
    const resolve = vi.fn(() => Promise.resolve('smart' as const));
    const result = await service().run(repository, { kind: 'checkout', ref: 'other' }, { resolveCheckoutConflict: resolve });
    expect(resolve).toHaveBeenCalledWith({ modified: ['a.txt'], untracked: [] });
    expect(result.notice).toContain('restored');
    expect(await branch(path)).toBe('other');
    // Git merged the local edit into other's version of a.txt.
    expect(await readFile(join(path, 'a.txt'), 'utf8')).toBe('ONE\ntwo\nthree local\n');
    expect(await readFile(join(path, 'b.txt'), 'utf8')).toBe('b local\n');
    expect(await stashCount(path)).toBe(0);
  });

  it('keeps the stash and reports conflicts when the changes do not apply cleanly', async () => {
    const { path, repository } = await fixture();
    await writeFile(join(path, 'a.txt'), 'uno\ntwo\nthree\n');
    const result = await service().run(
      repository,
      { kind: 'checkout', ref: 'other' },
      { resolveCheckoutConflict: () => Promise.resolve('smart') },
    );
    expect(result.notice).toContain('conflicts');
    expect(await branch(path)).toBe('other');
    expect(await readFile(join(path, 'a.txt'), 'utf8')).toContain('<<<<<<<');
    expect(await stashCount(path)).toBe(1);
  });

  it('moves untracked files out of the way and brings them back', async () => {
    const { path, repository } = await fixture();
    await writeFile(join(path, 'new.txt'), 'mine\n');
    const resolve = vi.fn(() => Promise.resolve('smart' as const));
    const result = await service().run(repository, { kind: 'checkout', ref: 'other' }, { resolveCheckoutConflict: resolve });
    expect(resolve).toHaveBeenCalledWith({ modified: [], untracked: ['new.txt'] });
    expect(result.notice).toContain('could not be restored');
    expect(await branch(path)).toBe('other');
    // The untracked copy cannot replace other's tracked file, so it stays in the stash.
    expect(await readFile(join(path, 'new.txt'), 'utf8')).toBe('theirs\n');
    expect(await stashCount(path)).toBe(1);
  });

  it('Force Checkout discards modified and untracked files in the way', async () => {
    const { path, repository } = await fixture();
    await writeFile(join(path, 'a.txt'), 'uno\n');
    await writeFile(join(path, 'new.txt'), 'mine\n');
    const result = await service().run(
      repository,
      { kind: 'checkout', ref: 'other' },
      { resolveCheckoutConflict: () => Promise.resolve('force') },
    );
    expect(result.notice).toContain('discarded');
    expect(await branch(path)).toBe('other');
    expect(await readFile(join(path, 'a.txt'), 'utf8')).toBe('ONE\ntwo\nthree\n');
    expect(await readFile(join(path, 'new.txt'), 'utf8')).toBe('theirs\n');
    expect(await git(path, 'status', '--porcelain')).toBe('');
  });

  it('cancelling leaves the branch and the changes alone', async () => {
    const { path, repository } = await fixture();
    await writeFile(join(path, 'a.txt'), 'uno\n');
    const result = await service().run(
      repository,
      { kind: 'checkout', ref: 'other' },
      { resolveCheckoutConflict: () => Promise.resolve(undefined) },
    );
    expect(result.cancelled).toBe(true);
    expect(await branch(path)).toBe('main');
    expect(await readFile(join(path, 'a.txt'), 'utf8')).toBe('uno\n');
  });

  it('reports the Git error as before without a resolver', async () => {
    const { path, repository } = await fixture();
    await writeFile(join(path, 'a.txt'), 'uno\n');
    await expect(service().run(repository, { kind: 'checkout', ref: 'other' })).rejects.toBeInstanceOf(GitCommandError);
    expect(await branch(path)).toBe('main');
  });
});
