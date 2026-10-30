import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitOperationService, buildRebaseTodo } from '../../src/git/GitOperationService';
import { GitRunner } from '../../src/git/GitRunner';
import type { GitOperationRequest } from '../../src/protocol/messages';
import { parseWebviewMessage } from '../../src/protocol/messages';
import { inspectRepository } from '../../src/repositories/discoverRepositories';
import type { RepositorySummary } from '../../src/shared/models';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Original Author',
      GIT_AUTHOR_EMAIL: 'author@example.com',
      GIT_COMMITTER_NAME: 'Tester',
      GIT_COMMITTER_EMAIL: 'tester@example.com',
    },
  });
  return result.stdout.trim();
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** Creates a repository with commits c1..c4, each adding a line to its own file. */
async function fixture(): Promise<{ cwd: string; hashes: string[]; repository: RepositorySummary }> {
  const cwd = await temporaryDirectory('git-log-advanced-');
  await git(cwd, 'init', '-b', 'main');
  await git(cwd, 'config', 'user.name', 'Tester');
  await git(cwd, 'config', 'user.email', 'tester@example.com');
  const hashes: string[] = [];
  for (const index of [1, 2, 3, 4]) {
    await writeFile(join(cwd, `f${String(index)}.txt`), `line ${String(index)}\n`);
    await git(cwd, 'add', '-A');
    await git(cwd, 'commit', '-m', `c${String(index)}`, '-m', `body ${String(index)}`);
    hashes.push(await git(cwd, 'rev-parse', 'HEAD'));
  }
  const repository = await inspectRepository(cwd, new GitRunner());
  if (!repository) throw new Error('fixture repository not found');
  return { cwd, hashes, repository };
}

async function subjects(cwd: string): Promise<string[]> {
  return (await git(cwd, 'log', '--format=%s')).split('\n');
}

describe('advanced Git operations', () => {
  it('rewords an older commit without touching the index, working tree, or authorship', async () => {
    const { cwd, hashes, repository } = await fixture();
    await writeFile(join(cwd, 'f4.txt'), 'dirty\n');
    await writeFile(join(cwd, 'f1.txt'), 'staged\n');
    await git(cwd, 'add', 'f1.txt');
    const service = new GitOperationService(new GitRunner());
    await service.run(repository, { kind: 'rewordCommit', hash: hashes[1] ?? '', message: 'second, reworded\n\nnew body' });
    expect(await subjects(cwd)).toEqual(['c4', 'c3', 'second, reworded', 'c1']);
    expect(await git(cwd, 'log', '-1', '--skip=2', '--format=%B')).toBe('second, reworded\n\nnew body');
    expect(await git(cwd, 'log', '--format=%an')).toBe(Array(4).fill('Original Author').join('\n'));
    expect(await git(cwd, 'rev-parse', 'HEAD^{tree}')).toBe(await git(cwd, 'rev-parse', `${hashes[3] ?? ''}^{tree}`));
    expect((await git(cwd, 'status', '--porcelain')).split('\n').sort()).toEqual([' M f4.txt', 'M  f1.txt']);
  });

  it('rewords HEAD by amending only its message', async () => {
    const { cwd, hashes, repository } = await fixture();
    const service = new GitOperationService(new GitRunner());
    await service.run(repository, { kind: 'rewordCommit', hash: hashes[3] ?? '', message: 'latest' });
    expect(await subjects(cwd)).toEqual(['latest', 'c3', 'c2', 'c1']);
  });

  it('undoes HEAD into the working tree and reports its message', async () => {
    const { cwd, hashes, repository } = await fixture();
    const onCommitUndone = vi.fn();
    const service = new GitOperationService(new GitRunner(), { onCommitUndone });
    await service.run(repository, { kind: 'undoCommit', hash: hashes[3] ?? '' });
    expect(await subjects(cwd)).toEqual(['c3', 'c2', 'c1']);
    expect(await git(cwd, 'status', '--porcelain')).toBe('A  f4.txt');
    expect(onCommitUndone).toHaveBeenCalledWith(repository, 'c4\n\nbody 4');
    await expect(service.run(repository, { kind: 'undoCommit', hash: hashes[1] ?? '' })).rejects.toThrow(/HEAD/u);
  });

  it('runs an interactive rebase that reorders, squashes, rewords, and drops commits', async () => {
    const { cwd, hashes, repository } = await fixture();
    await writeFile(join(cwd, 'f1.txt'), 'dirty but unrelated\n');
    const service = new GitOperationService(new GitRunner());
    const [c1, c2, c3, c4] = hashes as [string, string, string, string];
    await service.run(repository, {
      kind: 'interactiveRebase',
      base: c1,
      steps: [
        { hash: c3, action: 'reword', message: 'third first' },
        { hash: c2, action: 'pick', message: 'second + fourth' },
        { hash: c4, action: 'squash' },
      ],
    });
    expect(await subjects(cwd)).toEqual(['second + fourth', 'third first', 'c1']);
    expect(await git(cwd, 'show', '--name-only', '--format=', 'HEAD')).toBe('f2.txt\nf4.txt');
    expect(await readFile(join(cwd, 'f1.txt'), 'utf8')).toBe('dirty but unrelated\n');

    const [, third] = (await git(cwd, 'rev-list', 'HEAD')).split('\n');
    const repositoryAfter = (await inspectRepository(cwd, new GitRunner())) as RepositorySummary;
    await service.run(repositoryAfter, {
      kind: 'interactiveRebase',
      base: c1,
      steps: [
        { hash: third ?? '', action: 'drop' },
        { hash: await git(cwd, 'rev-parse', 'HEAD'), action: 'pick' },
      ],
    });
    expect(await subjects(cwd)).toEqual(['second + fourth', 'c1']);
  });

  it('rejects a stale rebase plan', async () => {
    const { hashes, repository } = await fixture();
    const service = new GitOperationService(new GitRunner());
    await expect(
      service.run(repository, {
        kind: 'interactiveRebase',
        base: hashes[1] ?? '',
        steps: [{ hash: hashes[2] ?? '', action: 'pick' }],
      }),
    ).rejects.toThrow(/changed/u);
  });

  it('reverts and cherry-picks the changes of single files from a commit', async () => {
    const { cwd, hashes, repository } = await fixture();
    await writeFile(join(cwd, 'f2.txt'), 'line 2\nmore\n');
    await git(cwd, 'commit', '-am', 'c5');
    const service = new GitOperationService(new GitRunner());
    const head = await git(cwd, 'rev-parse', 'HEAD');
    await service.run(repository, { kind: 'applyFileChanges', hash: head, paths: ['f2.txt'], reverse: true });
    expect(await readFile(join(cwd, 'f2.txt'), 'utf8')).toBe('line 2\n');
    await service.run(repository, { kind: 'applyFileChanges', hash: head, paths: ['f2.txt'], reverse: false });
    expect(await readFile(join(cwd, 'f2.txt'), 'utf8')).toBe('line 2\nmore\n');
    await service.run(
      repository,
      { kind: 'getFromRevision', hash: hashes[0] ?? '', paths: ['f1.txt', 'f3.txt'] },
      { confirm: () => Promise.resolve(true) },
    );
    await expect(readFile(join(cwd, 'f3.txt'), 'utf8')).rejects.toThrow();
    expect(await git(cwd, 'status', '--porcelain', '--', 'f3.txt')).toBe('D  f3.txt');
  });

  it('pushes up to a chosen commit and sets the upstream for a new branch', async () => {
    const { cwd, hashes, repository } = await fixture();
    const remote = await temporaryDirectory('git-log-remote-');
    await git(remote, 'init', '--bare', '-b', 'main');
    await git(cwd, 'remote', 'add', 'origin', remote);
    const service = new GitOperationService(new GitRunner());
    const push = (operation: Partial<Extract<GitOperationRequest, { kind: 'pushTo' }>>) =>
      service.run(repository, {
        kind: 'pushTo',
        remote: 'origin',
        source: 'HEAD',
        branch: 'main',
        setUpstream: false,
        forceWithLease: false,
        pushTags: false,
        ...operation,
      });
    await push({ source: hashes[1] ?? '' });
    expect(await git(remote, 'rev-parse', 'main')).toBe(hashes[1]);
    await push({ setUpstream: true });
    expect(await git(cwd, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/main');
    expect(await git(remote, 'rev-parse', 'main')).toBe(hashes[3]);
  });

  it('checks out a branch and rebases it onto the current branch', async () => {
    const { cwd, hashes, repository } = await fixture();
    await git(cwd, 'branch', 'feature', hashes[1] ?? '');
    await git(cwd, 'checkout', '-q', 'feature');
    await writeFile(join(cwd, 'feature.txt'), 'feature\n');
    await git(cwd, 'add', '-A');
    await git(cwd, 'commit', '-m', 'feature work');
    await git(cwd, 'checkout', '-q', 'main');
    const service = new GitOperationService(new GitRunner());
    await service.run(repository, { kind: 'checkoutAndRebase', branch: 'feature' });
    expect(await git(cwd, 'branch', '--show-current')).toBe('feature');
    expect(await subjects(cwd)).toEqual(['feature work', 'c4', 'c3', 'c2', 'c1']);
  });
});

describe('buildRebaseTodo', () => {
  it('emits amend exec lines after reword and squash groups', () => {
    const todo = buildRebaseTodo(
      [
        { hash: 'aaaa', action: 'reword', message: 'x' },
        { hash: 'bbbb', action: 'pick', message: 'combined' },
        { hash: 'cccc', action: 'fixup' },
        { hash: 'dddd', action: 'squash' },
        { hash: 'eeee', action: 'edit' },
        { hash: 'ffff', action: 'drop' },
      ],
      (index) => `/tmp/it's/${String(index)}`,
    );
    expect(todo.split('\n')).toEqual([
      'pick aaaa',
      "exec git commit --amend --only --no-verify --allow-empty -F '/tmp/it'\\''s/0'",
      'pick bbbb',
      'fixup cccc',
      'fixup dddd',
      "exec git commit --amend --only --no-verify --allow-empty -F '/tmp/it'\\''s/1'",
      'edit eeee',
      'drop ffff',
      '',
    ]);
  });

  it('rejects plans that start with a squash or drop everything', () => {
    expect(() => buildRebaseTodo([{ hash: 'aaaa', action: 'fixup' }], () => '')).toThrow();
    expect(() => buildRebaseTodo([{ hash: 'aaaa', action: 'drop' }], () => '')).toThrow();
  });
});

describe('protocol validation for new messages', () => {
  it('accepts workbench commands and rejects unsafe operations', () => {
    expect(
      parseWebviewMessage({
        type: 'workbenchCommand',
        requestId: '1',
        repositoryId: 'r',
        command: { kind: 'compareWithLocal', hash: 'abcd', path: 'src/a.ts', status: 'M' },
      }),
    ).toBeDefined();
    expect(
      parseWebviewMessage({
        type: 'workbenchCommand',
        requestId: '1',
        repositoryId: 'r',
        command: { kind: 'jumpToSource', path: '../etc/passwd' },
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: 'runOperation',
        requestId: '1',
        repositoryId: 'r',
        operation: {
          kind: 'pushTo',
          remote: '--upload-pack=x',
          source: 'HEAD',
          branch: 'main',
          setUpstream: false,
          forceWithLease: false,
          pushTags: false,
        },
      }),
    ).toBeUndefined();
    expect(
      parseWebviewMessage({
        type: 'runOperation',
        requestId: '1',
        repositoryId: 'r',
        operation: { kind: 'interactiveRebase', steps: [{ hash: 'abcd', action: 'exec' }] },
      }),
    ).toBeUndefined();
  });
});

describe('parseBlamePorcelain', () => {
  it('reuses commit metadata for repeated hashes and keeps previous revisions', async () => {
    const { parseBlamePorcelain } = await import('../../src/git/parsers/parseBlamePorcelain');
    const a = 'a'.repeat(40);
    const zero = '0'.repeat(40);
    const output = [
      `${a} 1 1 2`,
      'author Alice',
      'author-time 1700000000',
      'summary first commit',
      `previous ${'b'.repeat(40)} old name.ts`,
      'filename src/new.ts',
      '\tline one',
      `${a} 2 2`,
      '\tline two',
      `${zero} 3 3 1`,
      'author Not Committed Yet',
      'author-time 1800000000',
      'summary Version of src/new.ts from src/new.ts',
      'filename src/new.ts',
      '\tline three',
      '',
    ].join('\n');
    const lines = parseBlamePorcelain(output);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatchObject({ hash: a, author: 'Alice', summary: 'first commit', previous: { filename: 'old name.ts' } });
    expect(lines[2]?.hash).toBe(zero);
  });
});

describe('parseBranchRefs', () => {
  it('separates local and remote branches and skips remote HEAD', async () => {
    const { parseBranchRefs } = await import('../../src/branches/branchRefs');
    const line = (...fields: string[]) => `${fields.join('\x1f')}\x1f`;
    const branches = parseBranchRefs(
      [
        line('refs/heads/main', 'main', 'abc1234', 'origin/main', 'ahead 2', '*'),
        line('refs/heads/feature/x', 'feature/x', 'def5678', '', '', ' '),
        line('refs/remotes/origin/HEAD', 'origin', 'abc1234', '', '', ' '),
        line('refs/remotes/origin/main', 'origin/main', 'abc1234', '', '', ' '),
      ].join('\n'),
    );
    expect(branches).toEqual([
      { kind: 'local', name: 'main', target: 'abc1234', upstream: 'origin/main', track: 'ahead 2', current: true },
      { kind: 'local', name: 'feature/x', target: 'def5678', current: false },
      { kind: 'remote', name: 'origin/main', target: 'abc1234', current: false, remote: 'origin' },
    ]);
  });
});

describe('drop selected changes and push rejection', () => {
  it('removes one file’s change from an older commit and keeps newer commits', async () => {
    const { cwd, hashes, repository } = await fixture();
    // c2 touches f2.txt; also change f1.txt in c2 so the commit keeps its other change.
    await git(cwd, 'checkout', '-q', '-b', 'work');
    const service = new GitOperationService(new GitRunner());
    const repositoryOnBranch = (await inspectRepository(cwd, new GitRunner())) as RepositorySummary;
    await service.run(
      repositoryOnBranch,
      { kind: 'dropFileChanges', hash: hashes[1] ?? '', paths: ['f2.txt'] },
      { confirm: () => Promise.resolve(true) },
    );
    expect(await subjects(cwd)).toEqual(['c4', 'c3', 'c2', 'c1']);
    expect(await git(cwd, 'show', '--name-only', '--format=', 'HEAD~2')).toBe('');
    await expect(readFile(join(cwd, 'f2.txt'), 'utf8')).rejects.toThrow();
    expect(await readFile(join(cwd, 'f4.txt'), 'utf8')).toBe('line 4\n');
    void repository;
  });

  it('recognises rejected pushes', async () => {
    const { isPushRejected } = await import('../../src/dialogs/pushRejection');
    expect(isPushRejected(' ! [rejected]        main -> main (fetch first)')).toBe(true);
    expect(isPushRejected('Updates were rejected because the tip of your current branch is behind')).toBe(true);
    expect(isPushRejected('fatal: Authentication failed')).toBe(false);
  });
});
