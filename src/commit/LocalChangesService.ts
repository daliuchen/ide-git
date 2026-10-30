import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitCommandError, type GitRunner } from '../git/GitRunner';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  applyNumstat,
  commitPathspecs,
  parseFilePatch,
  parseNumstat,
  parsePorcelainV2Status,
  selectHunks,
  type FilePatch,
  type HunkSelection,
  type LocalChange,
  type LocalStatus,
} from './localChanges';

const MAX_LOCAL_CHANGES = 5_000;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const LITERAL_PATHSPECS = { GIT_LITERAL_PATHSPECS: '1' } as const;

export interface CommitRequest {
  message: string;
  changes: readonly LocalChange[];
  amend: boolean;
  signOff: boolean;
  /** A merge, cherry-pick, or revert is in progress, so Git refuses partial commits. */
  inProgressOperation: boolean;
  /** Paths committed only partially, mapped to their selected hunks (optionally only some lines). */
  partial?: ReadonlyMap<string, readonly (string | HunkSelection)[]>;
  /** `Name <email>` to record as the author. */
  author?: string;
  /** Skip pre-commit and commit-msg hooks (`--no-verify`). */
  noVerify?: boolean;
}

function validateMessage(message: string): string {
  if (!message.trim() || message.length > 100_000 || message.includes('\0')) {
    throw new Error('Enter a commit message.');
  }
  return message.endsWith('\n') ? message : `${message}\n`;
}

function validatePaths(paths: readonly string[]): string[] {
  for (const path of paths) {
    if (!path || path.includes('\0') || path.startsWith('/') || path.split('/').includes('..')) {
      throw new Error(`Invalid repository path: ${path}`);
    }
  }
  return [...paths];
}

/**
 * Local changes and commit actions modelled on a full IDE commit tool window:
 * the checked files' working-tree content is committed regardless of what is staged.
 */
export class LocalChangesService {
  constructor(private readonly runner: GitRunner) {}

  async getStatus(cwd: string, signal?: AbortSignal): Promise<LocalStatus> {
    const statusResult = await this.runner.run(
      ['-c', 'core.quotePath=false', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--find-renames'],
      { cwd, timeoutMs: 60_000, ...(signal ? { signal } : {}) },
    );
    const status = parsePorcelainV2Status(statusResult.stdout.toString('utf8'), MAX_LOCAL_CHANGES);
    if (!status.changes.some((change) => change.status !== '?')) return status;
    const hasHead = await this.hasHead(cwd, signal);
    try {
      const numstat = await this.runner.run(
        ['-c', 'core.quotePath=false', 'diff', hasHead ? 'HEAD' : EMPTY_TREE, '--numstat', '-z', '-M', '--'],
        { cwd, timeoutMs: 60_000, maxStdoutBytes: 16 * 1024 * 1024, ...(signal ? { signal } : {}) },
      );
      return { ...status, changes: applyNumstat(status.changes, parseNumstat(numstat.stdout.toString('utf8'))) };
    } catch (error) {
      if (error instanceof GitCommandError && error.cancelled) throw error;
      return status;
    }
  }

  async getHeadMessage(cwd: string): Promise<string> {
    const result = await this.runner.run(['log', '-1', '--format=%B', 'HEAD', '--'], {
      cwd,
      timeoutMs: 30_000,
    });
    return result.stdout.toString('utf8').replace(/\s+$/u, '');
  }

  async commit(cwd: string, request: CommitRequest): Promise<string> {
    const message = validateMessage(request.message);
    const changes = request.changes;
    if (!changes.length && !request.amend) throw new Error('Select at least one change to commit.');
    if (changes.some((change) => change.status === 'U')) {
      throw new Error('Resolve merge conflicts before committing.');
    }
    const untracked = validatePaths(changes.filter((change) => change.status === '?').map((change) => change.path));
    if (untracked.length) await this.add(cwd, untracked);
    const pathspecs = validatePaths(commitPathspecs(changes));
    const author = request.author?.trim();
    if (author && !/^[^<>\n]+ <[^<>\n]*>$/u.test(author)) {
      throw new Error('Enter the author as “Name <email@example.com>”.');
    }
    const options = [
      ...(request.amend ? ['--amend'] : []),
      ...(request.signOff ? ['--signoff'] : []),
      ...(author ? [`--author=${author}`] : []),
      ...(request.noVerify ? ['--no-verify'] : []),
    ];
    if (request.partial?.size) {
      if (request.inProgressOperation) {
        throw new Error('Committing selected chunks is not possible while a merge is in progress.');
      }
      await this.commitWithTemporaryIndex(cwd, message, changes, request.partial, options);
    } else if (request.inProgressOperation) {
      // Git rejects `--only` while concluding a merge; commit the index after staging the selection.
      if (pathspecs.length) {
        await this.runner.run(['add', '--all', '--', ...pathspecs], {
          cwd,
          timeoutMs: 60_000,
          env: LITERAL_PATHSPECS,
        });
      }
      await this.runner.run(['commit', ...options, '-F', '-'], { cwd, timeoutMs: 10 * 60_000, input: message });
    } else {
      await this.runner.run(
        ['commit', '--only', ...options, '-F', '-', ...(pathspecs.length ? ['--', ...pathspecs] : [])],
        { cwd, timeoutMs: 10 * 60_000, input: message, env: LITERAL_PATHSPECS },
      );
    }
    const head = await this.runner.run(['rev-parse', '--short', 'HEAD'], { cwd, timeoutMs: 30_000 });
    return head.stdout.toString('utf8').trim();
  }

  /** Change hunks between HEAD and the working tree, one per contiguous change block. */
  async getHunks(cwd: string, path: string): Promise<FilePatch> {
    const [validated] = validatePaths([path]);
    if (!validated || !(await this.hasHead(cwd))) return { header: '', hunks: [] };
    const result = await this.runner.run(
      ['diff', 'HEAD', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--', validated],
      { cwd, timeoutMs: 60_000, maxStdoutBytes: 16 * 1024 * 1024, env: LITERAL_PATHSPECS },
    );
    const patch = result.stdout.toString('utf8');
    if (/^Binary files /mu.test(patch)) return { header: '', hunks: [] };
    return parseFilePatch(patch);
  }

  /**
   * Builds the commit in a private index (HEAD + selected files + selected hunks), so unselected
   * chunks stay as local changes, then resynchronises the real index for the committed paths.
   */
  private async commitWithTemporaryIndex(
    cwd: string,
    message: string,
    changes: readonly LocalChange[],
    partial: ReadonlyMap<string, readonly (string | HunkSelection)[]>,
    options: readonly string[],
  ): Promise<void> {
    const patches = new Map<string, string>();
    for (const [path, ids] of partial) {
      patches.set(path, selectHunks(await this.getHunks(cwd, path), ids));
    }
    const directory = await mkdtemp(join(tmpdir(), 'git-log-commit-'));
    const env = { ...LITERAL_PATHSPECS, GIT_INDEX_FILE: join(directory, 'index') };
    try {
      await this.runner.run(['read-tree', 'HEAD'], { cwd, timeoutMs: 60_000, env });
      const full = commitPathspecs(changes.filter((change) => !partial.has(change.path)));
      if (full.length) {
        await this.runner.run(['add', '--all', '--', ...validatePaths(full)], { cwd, timeoutMs: 60_000, env });
      }
      for (const patch of patches.values()) {
        await this.runner.run(['apply', '--cached', '--unidiff-zero', '--recount', '--whitespace=nowarn', '-'], {
          cwd,
          timeoutMs: 60_000,
          env,
          input: patch,
        });
      }
      await this.runner.run(['commit', ...options, '-F', '-'], { cwd, timeoutMs: 10 * 60_000, env, input: message });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    await this.runner.run(['reset', '-q', 'HEAD', '--', ...validatePaths(commitPathspecs(changes))], {
      cwd,
      timeoutMs: 60_000,
      env: LITERAL_PATHSPECS,
    });
  }

  async add(cwd: string, paths: readonly string[]): Promise<void> {
    if (!paths.length) return;
    await this.runner.run(['add', '--', ...validatePaths(paths)], {
      cwd,
      timeoutMs: 60_000,
      env: LITERAL_PATHSPECS,
    });
  }

  /** Restores tracked changes to HEAD; added files become unversioned instead of being deleted. */
  async rollback(cwd: string, changes: readonly LocalChange[]): Promise<void> {
    const hasHead = await this.hasHead(cwd);
    const restore = new Set<string>();
    const unstageOnly = new Set<string>();
    for (const change of changes) {
      if (change.status === '?') continue;
      if (change.status === 'A' || change.status === 'C' || !hasHead) {
        unstageOnly.add(change.path);
      } else if (change.status === 'R') {
        unstageOnly.add(change.path);
        if (change.oldPath) restore.add(change.oldPath);
      } else {
        restore.add(change.path);
      }
    }
    if (unstageOnly.size) {
      await this.runner.run(['rm', '--cached', '--quiet', '-r', '--', ...validatePaths([...unstageOnly])], {
        cwd,
        timeoutMs: 60_000,
        env: LITERAL_PATHSPECS,
      });
    }
    if (restore.size) {
      await this.runner.run(
        ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...validatePaths([...restore])],
        { cwd, timeoutMs: 60_000, env: LITERAL_PATHSPECS },
      );
    }
  }

  /**
   * Stashes only the selected files. A plain `git stash push -- <paths>` records the whole index,
   * so unrelated staged changes would be shelved (and re-applied on unshelve) too; stashing against
   * a private index built from HEAD records just the selected files relative to HEAD.
   */
  async shelve(cwd: string, changes: readonly LocalChange[], message: string): Promise<void> {
    if (!changes.length) throw new Error('Select at least one change to shelve.');
    const label = message.trim() || 'Shelved changes';
    if (label.length > 10_000 || label.includes('\0')) throw new Error('Invalid shelf message.');
    if (!(await this.hasHead(cwd))) throw new Error('Commit at least once before shelving changes.');
    const paths = validatePaths(commitPathspecs(changes));
    const directory = await mkdtemp(join(tmpdir(), 'git-log-shelve-'));
    try {
      const env = { ...LITERAL_PATHSPECS, GIT_INDEX_FILE: join(directory, 'index') };
      await this.runner.run(['read-tree', 'HEAD'], { cwd, timeoutMs: 60_000, env });
      await this.runner.run(['stash', 'push', '--include-untracked', '-m', label, '--', ...paths], {
        cwd,
        timeoutMs: 60_000,
        env,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    // The shelved files now match HEAD in the working tree; drop their staged state as well.
    await this.runner.run(['reset', '-q', 'HEAD', '--', ...paths], { cwd, timeoutMs: 60_000, env: LITERAL_PATHSPECS });
  }

  async resolveConflict(cwd: string, path: string, side: 'ours' | 'theirs'): Promise<void> {
    const [validated] = validatePaths([path]);
    if (!validated) return;
    await this.runner.run(['checkout', `--${side}`, '--', validated], {
      cwd,
      timeoutMs: 60_000,
      env: LITERAL_PATHSPECS,
    });
    await this.add(cwd, [validated]);
  }

  async markResolved(cwd: string, paths: readonly string[]): Promise<void> {
    await this.add(cwd, paths);
  }

  /** Appends root-anchored patterns to the repository's top-level .gitignore. */
  async ignore(cwd: string, paths: readonly string[]): Promise<void> {
    const gitignore = join(cwd, '.gitignore');
    const existing = await readFile(gitignore, 'utf8').catch(() => '');
    const lines = new Set(existing.split(/\r?\n/u));
    const escaped = validatePaths(paths)
      // The leading slash anchors the pattern and already neutralises a leading `#` or `!`.
      .map((path) => `/${path.replace(/[\\*?[\]]/gu, '\\$&').replace(/ $/u, '\\ ')}`)
      .filter((pattern) => !lines.has(pattern));
    if (!escaped.length) return;
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    await appendFile(gitignore, `${prefix}${escaped.join('\n')}\n`, 'utf8');
  }

  private async hasHead(cwd: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.runner.run(['rev-parse', '--verify', '--quiet', 'HEAD'], {
        cwd,
        timeoutMs: 30_000,
        ...(signal ? { signal } : {}),
      });
      return true;
    } catch (error) {
      if (error instanceof GitCommandError && !error.cancelled && error.exitCode === 1) return false;
      throw error;
    }
  }
}
