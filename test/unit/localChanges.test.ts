import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalChangesService } from '../../src/commit/LocalChangesService';
import {
  addChangelist,
  changeKey,
  changelistFor,
  createDefaultChangelistState,
  moveToChangelist,
  normalizeChangelistState,
  removeChangelist,
  setActiveChangelist,
  syncAssignments,
} from '../../src/commit/changelists';
import { parseCommitWebviewMessage } from '../../src/commit/commitProtocol';
import { commitPathspecs, parseNumstat, parsePorcelainV2Status } from '../../src/commit/localChanges';
import { GitRunner } from '../../src/git/GitRunner';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Tester',
  GIT_AUTHOR_EMAIL: 'tester@example.com',
  GIT_COMMITTER_NAME: 'Tester',
  GIT_COMMITTER_EMAIL: 'tester@example.com',
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, env: gitEnv });
  return result.stdout.trim();
}

async function fixture(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'git-log-local-changes-'));
  temporaryDirectories.push(repository);
  await git(repository, 'init', '-b', 'main');
  await git(repository, 'config', 'user.name', 'Tester');
  await git(repository, 'config', 'user.email', 'tester@example.com');
  await mkdir(join(repository, 'src', 'deep'), { recursive: true });
  await writeFile(join(repository, 'src', 'deep', 'a.ts'), 'one\n');
  await writeFile(join(repository, 'keep.txt'), 'keep\n');
  await writeFile(join(repository, 'del.txt'), 'del\n');
  await writeFile(join(repository, 'old.txt'), 'rename me\nrename me\n');
  await git(repository, 'add', '-A');
  await git(repository, 'commit', '-m', 'init');
  return repository;
}

describe('parsePorcelainV2Status', () => {
  it('parses ordinary, renamed, unmerged, and untracked entries with branch headers', () => {
    const output = [
      '# branch.oid abc',
      '# branch.head feature/x',
      '# branch.upstream origin/feature/x',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 a a src/file with space.ts',
      '1 A. N... 000000 100644 100644 0 a new.ts',
      '1 .D N... 100644 100644 000000 a a gone.ts',
      '2 R. N... 100644 100644 100644 a a R100 renamed.ts',
      'original.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
      '? untracked dir/file.txt',
      '! ignored.log',
      '',
    ].join('\0');
    const status = parsePorcelainV2Status(output);
    expect(status.branch).toEqual({ branch: 'feature/x', upstream: 'origin/feature/x', ahead: 2, behind: 1 });
    expect(status.changes).toEqual([
      { path: 'src/file with space.ts', status: 'M', staged: false, unstaged: true },
      { path: 'new.ts', status: 'A', staged: true, unstaged: false },
      { path: 'gone.ts', status: 'D', staged: false, unstaged: true },
      { path: 'renamed.ts', oldPath: 'original.ts', status: 'R', staged: true, unstaged: false },
      { path: 'conflict.ts', status: 'U', staged: true, unstaged: true },
      { path: 'untracked dir/file.txt', status: '?', staged: false, unstaged: true },
    ]);
    expect(status.truncated).toBe(false);
  });

  it('truncates without desynchronising rename records', () => {
    const output = ['2 R. N... 1 1 1 a a R100 b.ts', 'a.ts', '2 R. N... 1 1 1 a a R100 d.ts', 'c.ts', '? e.ts', ''].join('\0');
    const status = parsePorcelainV2Status(output, 1);
    expect(status.changes.map((change) => change.path)).toEqual(['b.ts']);
    expect(status.truncated).toBe(true);
  });

  it('treats a detached head as having no branch', () => {
    expect(parsePorcelainV2Status('# branch.head (detached)\0').branch).toEqual({});
  });
});

describe('parseNumstat', () => {
  it('handles renames and binary files', () => {
    const stats = parseNumstat(['3\t1\tsrc/a.ts', '0\t0\t', 'old.ts', 'new.ts', '-\t-\timage.png', ''].join('\0'));
    expect(stats.get('src/a.ts')).toEqual({ path: 'src/a.ts', additions: 3, deletions: 1, binary: false });
    expect(stats.get('new.ts')).toEqual({ path: 'new.ts', additions: 0, deletions: 0, binary: false });
    expect(stats.get('image.png')).toEqual({ path: 'image.png', binary: true });
  });
});

describe('commitPathspecs', () => {
  it('includes both sides of a rename', () => {
    expect(
      commitPathspecs([
        { path: 'b.ts', oldPath: 'a.ts', status: 'R', staged: true, unstaged: false },
        { path: 'c.ts', status: 'M', staged: false, unstaged: true },
      ]),
    ).toEqual(['b.ts', 'a.ts', 'c.ts']);
  });
});

describe('changelists', () => {
  it('assigns new changes to the active list and keeps them there when the active list changes', () => {
    let state = addChangelist(createDefaultChangelistState(), 'Feature', 'feature');
    const first = changeKey('repo', 'a.ts');
    const second = changeKey('repo', 'b.ts');
    state = syncAssignments(state, [first]);
    state = setActiveChangelist(state, 'feature');
    state = syncAssignments(state, [first, second]);
    expect(changelistFor(state, first)).toBe('default');
    expect(changelistFor(state, second)).toBe('feature');
    state = syncAssignments(state, [second]);
    expect(state.assignments).toEqual({ [second]: 'feature' });
  });

  it('moves changes and reassigns them when a list is removed', () => {
    let state = addChangelist(createDefaultChangelistState(), 'Later', 'later');
    state = setActiveChangelist(moveToChangelist(state, ['k'], 'later'), 'later');
    state = removeChangelist(state, 'later');
    expect(state.activeId).toBe('default');
    expect(state.assignments).toEqual({ k: 'default' });
    expect(() => removeChangelist(state, 'default')).toThrow();
    expect(() => addChangelist(state, 'Changes', 'dup')).toThrow(/already exists/u);
  });

  it('repairs invalid persisted state', () => {
    const state = normalizeChangelistState({
      lists: [{ id: 'x', name: 'X' }, { id: 'x', name: 'dup' }, { id: 5 }],
      activeId: 'missing',
      assignments: { a: 'x', b: 'missing' },
    });
    expect(state.lists.map((list) => list.id)).toEqual(['default', 'x']);
    expect(state.activeId).toBe('default');
    expect(state.assignments).toEqual({ a: 'x' });
  });
});

describe('parseCommitWebviewMessage', () => {
  it('accepts valid messages and rejects malformed ones', () => {
    expect(
      parseCommitWebviewMessage({
        type: 'commit',
        message: 'fix',
        items: [{ repositoryId: 'r', path: 'a.ts' }],
        amend: false,
        signOff: true,
        push: false,
        checks: { reformat: true, optimizeImports: false, analyze: false, checkTodo: true, runTests: false, runHooks: false },
        author: 'Someone <someone@example.com>',
      }),
    ).toMatchObject({ type: 'commit', signOff: true, checks: { reformat: true, runHooks: false }, author: 'Someone <someone@example.com>' });
    expect(
      parseCommitWebviewMessage({ type: 'commit', message: 'x', items: [], amend: false, signOff: false, push: false }),
    ).toBeUndefined();
    expect(
      parseCommitWebviewMessage({
        type: 'commit',
        message: 'x',
        items: [{ repositoryId: 'r', path: 'a.ts', hunks: ['0123456789abcdef'], lines: { ffffffffffffffff: [1] } }],
        amend: false,
        signOff: false,
        push: false,
        checks: { reformat: false, optimizeImports: false, analyze: false, checkTodo: false, runTests: false, runHooks: true },
      }),
    ).toBeUndefined();
    expect(parseCommitWebviewMessage({ type: 'action', action: 'rm -rf', items: [] })).toBeUndefined();
    expect(parseCommitWebviewMessage({ type: 'commit', message: 'x', items: [{ path: 'a' }] })).toBeUndefined();
    expect(
      parseCommitWebviewMessage({
        type: 'updateLayout',
        layout: { groupByDirectory: true, showUnversioned: false, diffPreviewOnSelect: false, messageHeight: 9999 },
      }),
    ).toEqual({
      type: 'updateLayout',
      layout: { groupByDirectory: true, showUnversioned: false, diffPreviewOnSelect: false, messageHeight: 800 },
    });
  });
});

describe('LocalChangesService', () => {
  const service = new LocalChangesService(new GitRunner());

  it('reports local changes with line statistics', async () => {
    const repository = await fixture();
    await writeFile(join(repository, 'src', 'deep', 'a.ts'), 'one\ntwo\n');
    await unlink(join(repository, 'del.txt'));
    await writeFile(join(repository, 'new file.txt'), 'n\n');
    await git(repository, 'mv', 'old.txt', 'moved.txt');
    const status = await service.getStatus(repository);
    expect(status.branch.branch).toBe('main');
    expect(status.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/deep/a.ts', status: 'M', additions: 1, deletions: 0 }),
        expect.objectContaining({ path: 'del.txt', status: 'D', deletions: 1 }),
        expect.objectContaining({ path: 'moved.txt', oldPath: 'old.txt', status: 'R' }),
        expect.objectContaining({ path: 'new file.txt', status: '?' }),
      ]),
    );
  });

  it('commits only the selected working-tree content, ignoring what else is staged', async () => {
    const repository = await fixture();
    await writeFile(join(repository, 'keep.txt'), 'keep\nstaged\n');
    await git(repository, 'add', 'keep.txt');
    await writeFile(join(repository, 'src', 'deep', 'a.ts'), 'one\nselected\n');
    await unlink(join(repository, 'del.txt'));
    await writeFile(join(repository, '[literal]*.txt'), 'untracked\n');
    await git(repository, 'mv', 'old.txt', 'moved.txt');
    const { changes } = await service.getStatus(repository);
    const selected = changes.filter((change) => change.path !== 'keep.txt');
    await service.commit(repository, {
      message: 'Selected changes',
      changes: selected,
      amend: false,
      signOff: true,
      inProgressOperation: false,
    });
    const committed = await git(repository, 'show', '--name-status', '--format=%B', 'HEAD');
    expect(committed).toContain('Selected changes');
    expect(committed).toContain('Signed-off-by: Tester <tester@example.com>');
    expect(committed).toMatch(/D\tdel\.txt/u);
    expect(committed).toMatch(/R100\told\.txt\tmoved\.txt/u);
    expect(committed).toContain('[literal]*.txt');
    expect(committed).not.toContain('keep.txt');
    // The unselected staged change is still staged, not lost.
    expect(await git(repository, 'status', '--porcelain')).toBe('M  keep.txt');
  });

  it('amends the message without committing staged changes when nothing is selected', async () => {
    const repository = await fixture();
    await writeFile(join(repository, 'keep.txt'), 'keep\nstaged\n');
    await git(repository, 'add', 'keep.txt');
    await service.commit(repository, { message: 'reworded', changes: [], amend: true, signOff: false, inProgressOperation: false });
    expect(await git(repository, 'log', '--format=%s')).toBe('reworded');
    expect(await git(repository, 'status', '--porcelain')).toBe('M  keep.txt');
    expect(await service.getHeadMessage(repository)).toBe('reworded');
  });

  it('rolls back tracked changes and keeps added files as unversioned', async () => {
    const repository = await fixture();
    await writeFile(join(repository, 'keep.txt'), 'changed\n');
    await unlink(join(repository, 'del.txt'));
    await writeFile(join(repository, 'added.txt'), 'added\n');
    await git(repository, 'add', 'added.txt');
    await git(repository, 'mv', 'old.txt', 'moved.txt');
    const { changes } = await service.getStatus(repository);
    await service.rollback(repository, changes);
    expect(await readFile(join(repository, 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(await readFile(join(repository, 'del.txt'), 'utf8')).toBe('del\n');
    expect(await readFile(join(repository, 'old.txt'), 'utf8')).toContain('rename me');
    const status = (await git(repository, 'status', '--porcelain')).split('\n').sort();
    expect(status).toEqual(['?? added.txt', '?? moved.txt']);
  });

  it('shelves only the selected files, including untracked ones', async () => {
    const repository = await fixture();
    await writeFile(join(repository, 'keep.txt'), 'changed\n');
    await writeFile(join(repository, 'src', 'deep', 'a.ts'), 'changed\n');
    await writeFile(join(repository, 'scratch.txt'), 'scratch\n');
    const { changes } = await service.getStatus(repository);
    await service.shelve(
      repository,
      changes.filter((change) => change.path !== 'keep.txt'),
      'WIP shelf',
    );
    expect(await git(repository, 'status', '--porcelain')).toBe('M keep.txt');
    expect(await git(repository, 'stash', 'list')).toContain('WIP shelf');
  });

  it('shelves only the selected files even when other changes are staged', async () => {
    const repository = await fixture();
    await git(repository, 'rm', '-q', 'del.txt');
    await writeFile(join(repository, 'keep.txt'), 'staged change\n');
    await git(repository, 'add', 'keep.txt');
    await git(repository, 'mv', 'old.txt', 'moved.txt');
    const { changes } = await service.getStatus(repository);
    await service.shelve(
      repository,
      changes.filter((change) => change.path !== 'del.txt'),
      'Only selected',
    );
    expect(await git(repository, 'status', '--porcelain')).toBe('D  del.txt');
    expect(
      (await git(repository, 'stash', 'show', '--name-status', '--include-untracked', 'stash@{0}')).split('\n').sort(),
    ).toEqual(['M\tkeep.txt', 'R100\told.txt\tmoved.txt']);
  });

  it('adds anchored, escaped patterns to .gitignore once', async () => {
    const repository = await fixture();
    await writeFile(join(repository, '.gitignore'), 'node_modules');
    await service.ignore(repository, ['build/out[1].log', 'tmp/*']);
    await service.ignore(repository, ['tmp/*']);
    expect(await readFile(join(repository, '.gitignore'), 'utf8')).toBe(
      'node_modules\n/build/out\\[1\\].log\n/tmp/\\*\n',
    );
  });

  it('rejects paths that escape the repository', async () => {
    const repository = await fixture();
    await expect(service.add(repository, ['../outside'])).rejects.toThrow(/Invalid repository path/u);
  });
});

describe('partial commits', () => {
  const service = new LocalChangesService(new GitRunner());

  it('commits only the selected chunks and leaves the rest as local changes', async () => {
    const repository = await fixture();
    const lines = Array.from({ length: 30 }, (_, index) => `line ${String(index + 1)}`);
    await writeFile(join(repository, 'keep.txt'), `${lines.join('\n')}\n`);
    await git(repository, 'commit', '-am', 'thirty lines');
    const edited = [...lines];
    edited[2] = 'line three';
    edited[14] = 'line fifteen\nextra';
    edited.splice(26, 1);
    await writeFile(join(repository, 'keep.txt'), `${edited.join('\n')}\n`);
    await writeFile(join(repository, 'del.txt'), 'del\nmore\n');
    const patch = await service.getHunks(repository, 'keep.txt');
    expect(patch.hunks.map((hunk) => [hunk.newStart, hunk.removed, hunk.added])).toEqual([
      [3, ['line 3'], ['line three']],
      [15, ['line 15'], ['line fifteen', 'extra']],
      [27, ['line 27'], []],
    ]);
    const { changes } = await service.getStatus(repository);
    await service.commit(repository, {
      message: 'partial',
      changes: changes.filter((change) => ['keep.txt', 'del.txt'].includes(change.path)),
      amend: false,
      signOff: false,
      inProgressOperation: false,
      partial: new Map([['keep.txt', [patch.hunks[1]?.id ?? '', patch.hunks[2]?.id ?? '']]]),
    });
    const committed = await git(repository, 'show', 'HEAD:keep.txt');
    expect(committed).toContain('line fifteen\nextra');
    expect(committed).not.toContain('line 27');
    expect(committed).toContain('line 3\n');
    expect(await git(repository, 'show', 'HEAD:del.txt')).toBe('del\nmore');
    // The unselected chunk remains a local, unstaged change.
    expect(await git(repository, 'status', '--porcelain')).toBe('M keep.txt');
    expect(await git(repository, 'diff', '--unified=0', '--no-color', 'keep.txt')).toContain('+line three');
  });

  it('rejects a chunk selection that no longer matches the file', async () => {
    const repository = await fixture();
    await writeFile(join(repository, 'keep.txt'), 'changed\n');
    const { changes } = await service.getStatus(repository);
    await expect(
      service.commit(repository, {
        message: 'stale',
        changes: changes.filter((change) => change.path === 'keep.txt'),
        amend: false,
        signOff: false,
        inProgressOperation: false,
        partial: new Map([['keep.txt', ['0123456789abcdef']]]),
      }),
    ).rejects.toThrow(/changed since/u);
  });
});

describe('line-level commits, author, and hooks', () => {
  const service = new LocalChangesService(new GitRunner());

  it('commits only the selected lines of a chunk', async () => {
    const repository = await fixture();
    await writeFile(join(repository, 'keep.txt'), 'a\nb\nc\nd\n');
    await git(repository, 'commit', '-qam', 'four lines');
    await writeFile(join(repository, 'keep.txt'), 'a\nB1\nB2\nB3\nd\n');
    const patch = await service.getHunks(repository, 'keep.txt');
    const [hunk] = patch.hunks;
    expect(hunk?.body).toEqual(['-b', '-c', '+B1', '+B2', '+B3']);
    const { changes } = await service.getStatus(repository);
    await service.commit(repository, {
      message: 'some lines',
      changes: changes.filter((change) => change.path === 'keep.txt'),
      amend: false,
      signOff: false,
      inProgressOperation: false,
      // Remove "b", keep "c", add B1 and B3 but not B2.
      partial: new Map([['keep.txt', [{ id: hunk?.id ?? '', lines: [0, 2, 4] }]]]),
    });
    expect(await git(repository, 'show', 'HEAD:keep.txt')).toBe('a\nc\nB1\nB3\nd');
    expect(await readFile(join(repository, 'keep.txt'), 'utf8')).toBe('a\nB1\nB2\nB3\nd\n');
  });

  it('records a different author and can skip hooks', async () => {
    const repository = await fixture();
    const hook = join(repository, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\necho blocked >&2\nexit 1\n', { mode: 0o755 });
    await writeFile(join(repository, 'keep.txt'), 'changed\n');
    const { changes } = await service.getStatus(repository);
    const request = {
      message: 'by someone else',
      changes,
      amend: false,
      signOff: false,
      inProgressOperation: false,
      author: 'Other Person <other@example.com>',
    };
    await expect(service.commit(repository, request)).rejects.toThrow();
    await service.commit(repository, { ...request, noVerify: true });
    expect(await git(repository, 'log', '-1', '--format=%an <%ae>|%cn')).toBe('Other Person <other@example.com>|Tester');
    await expect(service.commit(repository, { ...request, author: 'no email' })).rejects.toThrow(/Name <email/u);
  });
});

describe('chunk changelists', () => {
  it('splits a file across changelists and merges it back when all chunks agree', async () => {
    const { moveHunksToChangelist, pruneHunkAssignments } = await import('../../src/commit/changelists');
    let state = addChangelist(createDefaultChangelistState(), 'Later', 'later');
    const key = changeKey('r', 'a.ts');
    state = syncAssignments(state, [key]);
    state = moveHunksToChangelist(state, key, ['h2'], ['h1', 'h2', 'h3'], 'later');
    expect(state.hunkAssignments[key]).toEqual({ h2: 'later' });
    expect(changelistFor(state, key)).toBe('default');
    state = pruneHunkAssignments(state, key, ['h1', 'h3']);
    expect(state.hunkAssignments[key]).toBeUndefined();
    state = moveHunksToChangelist(state, key, ['h1', 'h3'], ['h1', 'h3'], 'later');
    expect(changelistFor(state, key)).toBe('later');
    expect(state.hunkAssignments[key]).toBeUndefined();
    expect(normalizeChangelistState({ ...state, hunkAssignments: { [key]: { h1: 'missing', h2: 'later' } } }).hunkAssignments).toEqual({
      [key]: { h2: 'later' },
    });
  });
});

describe('commit message helpers', () => {
  it('checks and wraps commit messages', async () => {
    const { checkCommitMessage, wrapCommitMessage, findAddedTodos, templateText } = await import('../../src/commit/commitMessage');
    const rules = { subjectLength: 20, bodyLineLength: 30, blankLineAfterSubject: true };
    const message = 'A subject that is far too long\nbody starts right away and keeps going for quite a while';
    expect(checkCommitMessage(message, rules).map((issue) => issue.line)).toEqual([1, 2, 2]);
    const wrapped = wrapCommitMessage(message, 30);
    expect(wrapped.split('\n')[1]).toBe('');
    expect(checkCommitMessage(wrapped, { ...rules, subjectLength: 0 })).toEqual([]);
    expect(wrapCommitMessage('Subject\n\n- list item that is long enough to wrap but stays', 20)).toBe(
      'Subject\n\n- list item that is long enough to wrap but stays',
    );
    expect(templateText('# comment\nfeat: \n\n# more\nBody\n')).toBe('feat: \n\nBody');
    const patch = ['+++ b/src/a.ts', '@@ -1,0 +5,2 @@', '+const x = 1; // TODO remove', '+ok', '@@ -9 +11 @@', '-old', '+// FIXME later', ''].join('\n');
    expect(findAddedTodos(patch)).toEqual([
      { path: 'src/a.ts', line: 5, text: 'const x = 1; // TODO remove' },
      { path: 'src/a.ts', line: 11, text: '// FIXME later' },
    ]);
  });
});
