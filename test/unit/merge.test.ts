import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDialogMessage } from '../../src/dialogs/dialogProtocol';
import { GitOperationService, mergeArguments } from '../../src/git/GitOperationService';
import { GitRunner } from '../../src/git/GitRunner';
import { parseWebviewMessage } from '../../src/protocol/messages';
import type { RepositorySummary } from '../../src/shared/models';
import { mergeCreatesCommit } from '../../webview/src/dialog/mergeOptions';

const execFileAsync = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const identity = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  return (await execFileAsync('git', args, { cwd, env: { ...process.env, ...identity } })).stdout.trim();
}

/** main has one commit; feature adds two on top. With `diverge`, main also gets its own commit. */
async function fixture(diverge: boolean): Promise<{ path: string; repository: RepositorySummary }> {
  const path = await mkdtemp(join(tmpdir(), 'merge-'));
  directories.push(path);
  await git(path, 'init', '-q', '-b', 'main');
  await git(path, 'config', 'user.name', 'T');
  await git(path, 'config', 'user.email', 't@example.com');
  const commit = async (file: string, message: string) => {
    await writeFile(join(path, file), `${message}\n`);
    await git(path, 'add', '-A');
    await git(path, 'commit', '-q', '-m', message);
  };
  await commit('base.txt', 'base');
  await git(path, 'switch', '-q', '-c', 'feature');
  await commit('f1.txt', 'feature one');
  await commit('f2.txt', 'feature two');
  await git(path, 'switch', '-q', 'main');
  if (diverge) await commit('main.txt', 'main work');
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

const service = () => new GitOperationService(new GitRunner(), { inspectRepository: (repository) => Promise.resolve(repository) });
const exists = (path: string) => access(path).then(() => true, () => false);

describe('mergeArguments', () => {
  it('keeps the plain merge unchanged and adds the chosen options', () => {
    expect(mergeArguments({ kind: 'merge', ref: 'feature' })).toEqual(['merge', '--no-edit', 'feature']);
    expect(mergeArguments({ kind: 'merge', ref: 'feature', mode: 'no-ff', message: '  Merge it  ' })).toEqual(['merge', '--no-ff', '-m', 'Merge it', 'feature']);
    expect(mergeArguments({ kind: 'merge', ref: 'feature', mode: 'ff-only', noCommit: true })).toEqual(['merge', '--ff-only', '--no-edit', 'feature']);
    expect(mergeArguments({ kind: 'merge', ref: 'feature', mode: 'squash', message: 'ignored' })).toEqual(['merge', '--squash', 'feature']);
    // --no-commit cannot stop a fast-forward, so it brings --no-ff with it.
    expect(mergeArguments({ kind: 'merge', ref: 'feature', noCommit: true })).toEqual(['merge', '--no-ff', '--no-commit', '--no-edit', 'feature']);
    expect(() => mergeArguments({ kind: 'merge', ref: '--all' })).toThrow();
  });

  it('knows when a merge message applies', () => {
    expect(mergeCreatesCommit('default', false, true)).toBe(false);
    expect(mergeCreatesCommit('default', false, false)).toBe(true);
    expect(mergeCreatesCommit('no-ff', false, true)).toBe(true);
    expect(mergeCreatesCommit('no-ff', true, false)).toBe(false);
    expect(mergeCreatesCommit('squash', false, false)).toBe(false);
    expect(mergeCreatesCommit('ff-only', false, false)).toBe(false);
  });
});

describe('merge protocol', () => {
  it('validates the new operation fields and the dialog message', () => {
    const operation = (extra: Record<string, unknown>) =>
      parseWebviewMessage({ type: 'runOperation', requestId: 'm', repositoryId: 'r', operation: { kind: 'merge', ref: 'feature', ...extra } });
    expect(operation({ mode: 'no-ff', noCommit: true, message: 'x' })).toMatchObject({ operation: { mode: 'no-ff', noCommit: true, message: 'x' } });
    expect(operation({ mode: 'octopus' })).toBeUndefined();
    expect(operation({ message: 'a\0b' })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'workbenchCommand', requestId: 'c', repositoryId: 'r', command: { kind: 'openMergeDialog', ref: 'origin/x' } })).toBeDefined();
    expect(parseWebviewMessage({ type: 'workbenchCommand', requestId: 'c', repositoryId: 'r', command: { kind: 'openMergeDialog', ref: '-x' } })).toBeUndefined();
    expect(parseDialogMessage({ type: 'merge', mode: 'squash', noCommit: false, message: '' })).toEqual({ type: 'merge', mode: 'squash', noCommit: false, message: '' });
    expect(parseDialogMessage({ type: 'merge', mode: 'squash', noCommit: 'no', message: '' })).toBeUndefined();
  });
});

describe('merge modes in a real repository', () => {
  it('no-ff creates a merge commit with the given message even when it could fast-forward', async () => {
    const { path, repository } = await fixture(false);
    await service().run(repository, { kind: 'merge', ref: 'feature', mode: 'no-ff', message: 'Bring in feature' });
    expect(await git(path, 'log', '-1', '--format=%s %P')).toMatch(/^Bring in feature \S+ \S+$/u);
  });

  it('ff-only refuses diverged branches and leaves main alone', async () => {
    const { path, repository } = await fixture(true);
    const before = await git(path, 'rev-parse', 'HEAD');
    await expect(service().run(repository, { kind: 'merge', ref: 'feature', mode: 'ff-only' })).rejects.toThrow();
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('squash stages the changes without committing and writes SQUASH_MSG', async () => {
    const { path, repository } = await fixture(true);
    const before = await git(path, 'rev-parse', 'HEAD');
    await service().run(repository, { kind: 'merge', ref: 'feature', mode: 'squash' });
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(before);
    expect((await git(path, 'diff', '--cached', '--name-only')).split('\n').sort()).toEqual(['f1.txt', 'f2.txt']);
    expect(await readFile(join(path, '.git', 'SQUASH_MSG'), 'utf8')).toContain('feature two');
  });

  it("don't commit stops in the middle of the merge, even when it could fast-forward", async () => {
    const { path, repository } = await fixture(false);
    const before = await git(path, 'rev-parse', 'HEAD');
    await service().run(repository, { kind: 'merge', ref: 'feature', noCommit: true });
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(before);
    expect(await exists(join(path, '.git', 'MERGE_HEAD'))).toBe(true);
  });

  it('the plain merge still fast-forwards', async () => {
    const { path, repository } = await fixture(false);
    await service().run(repository, { kind: 'merge', ref: 'feature' });
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(await git(path, 'rev-parse', 'feature'));
  });
});
