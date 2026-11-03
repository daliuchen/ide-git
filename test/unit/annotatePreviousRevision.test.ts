import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBlamePorcelain } from '../../src/git/parsers/parseBlamePorcelain';
import { mapLineToOldSide } from '../../src/git/worktreeLineMapping';

const execFileAsync = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const identity = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  return (await execFileAsync('git', args, { cwd, env: { ...process.env, ...identity }, maxBuffer: 1 << 24 })).stdout;
}

describe('mapLineToOldSide', () => {
  const diff = (...hunks: string[]) => hunks.map((hunk) => `${hunk}\n`).join('');
  it('shifts lines outside changed blocks and lands on the start of a changed block', () => {
    // Line 3 replaced by two lines (3-4); two lines inserted after old line 10 (new 12-13).
    const hunks = diff('@@ -3 +3,2 @@', '@@ -10,0 +12,2 @@');
    expect(mapLineToOldSide(hunks, 1)).toBe(1);
    expect(mapLineToOldSide(hunks, 3)).toBe(3);
    expect(mapLineToOldSide(hunks, 4)).toBe(3);
    expect(mapLineToOldSide(hunks, 8)).toBe(7);
    expect(mapLineToOldSide(hunks, 12)).toBe(11);
    expect(mapLineToOldSide(hunks, 15)).toBe(12);
    expect(mapLineToOldSide('', 5)).toBe(5);
  });
});

describe('following blame back through revisions', () => {
  it('walks a line from its last change to where it was first written, across a rename', async () => {
    const path = await mkdtemp(join(tmpdir(), 'annotate-previous-'));
    directories.push(path);
    await git(path, 'init', '-q', '-b', 'main');
    const commit = async (file: string, content: string, message: string) => {
      await writeFile(join(path, file), content);
      await git(path, 'add', '-A');
      await git(path, 'commit', '-q', '-m', message);
      return (await git(path, 'rev-parse', 'HEAD')).trim();
    };
    const a = await commit('old.rb', 'header\nvalue = compute(1)\nfooter\n', 'A writes it');
    const b = await commit('old.rb', 'header\nextra\nvalue = compute(2)\nfooter\n', 'B changes it');
    await git(path, 'mv', 'old.rb', 'new.rb');
    await git(path, 'commit', '-q', '-m', 'rename');
    const c = await commit('new.rb', 'header\nextra\nvalue = compute( 2 )\nfooter\n', 'C reformats');

    const blame = async (revision: string, file: string) =>
      parseBlamePorcelain(await git(path, 'blame', '--porcelain', '-w', revision, '--', file));
    const step = async (revision: string, file: string, line: number) => {
      const blamed = (await blame(revision, file))[line - 1];
      if (!blamed?.previous) return undefined;
      const diff = await git(path, 'diff', '-U0', '--no-color', `${blamed.previous.hash}:${blamed.previous.filename}`, `${blamed.hash}:${blamed.filename}`);
      return { hash: blamed.hash, previous: blamed.previous, line: mapLineToOldSide(diff, blamed.sourceLine) };
    };

    // Plain blame without -w would stop at C; with -w the reformat is skipped and B is shown.
    const first = await step(c, 'new.rb', 3);
    expect(first?.hash).toBe(b);
    expect(first?.previous).toEqual({ hash: a, filename: 'old.rb' });
    expect(first?.line).toBe(2);
    const [, atLine] = await blame(a, 'old.rb');
    expect(atLine?.hash).toBe(a);
    expect(await step(a, 'old.rb', 2)).toBeUndefined();
  });
});
