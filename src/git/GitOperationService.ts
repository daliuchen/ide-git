import { fileURLToPath } from 'node:url';
import { normalize } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitOperationRequest, RebaseStep } from '../protocol/messages';
import type { RepositorySummary } from '../shared/models';
import { inspectRepository } from '../repositories/discoverRepositories';
import { GitCommandError, type GitRunner } from './GitRunner';
import { parseCheckoutConflict, type CheckoutConflict } from './checkoutConflicts';
import { remoteNameProblem, remoteUrlProblem } from '../remotes/remotes';

export interface GitOperationResult {
  message: string;
  cancelled?: boolean;
  /** Something the user should be told, e.g. that a cherry-pick had nothing left to apply. */
  notice?: string;
}

/** The commands whose stop can be continued, skipped or aborted (`git <command> --continue`). */
const SEQUENCER_COMMANDS = { rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' } as const;

/** Arguments for Continue/Skip/Abort of whatever rebase, cherry-pick or revert is in progress. */
export function sequencerArguments(
  state: RepositorySummary['operationState'],
  kind: 'rebaseContinue' | 'rebaseSkip' | 'rebaseAbort',
): string[] {
  const command = state && state in SEQUENCER_COMMANDS ? SEQUENCER_COMMANDS[state as keyof typeof SEQUENCER_COMMANDS] : 'rebase';
  return [command, kind === 'rebaseContinue' ? '--continue' : kind === 'rebaseSkip' ? '--skip' : '--abort'];
}

export interface GitOperationRunOptions {
  confirm?(confirmation: OperationConfirmation): Promise<boolean>;
  /**
   * Asked when local changes stop a checkout: stash them and bring them back afterwards
   * ('smart'), discard them ('force'), or keep the error (undefined). Without it the Git error is
   * reported as is.
   */
  resolveCheckoutConflict?(conflict: CheckoutConflict): Promise<'smart' | 'force' | undefined>;
}

type CheckoutOperation = Extract<
  GitOperationRequest,
  { kind: 'checkout' | 'checkoutRemote' | 'checkoutDetached' | 'switchPrevious' }
>;

function isCheckoutOperation(operation: GitOperationRequest): operation is CheckoutOperation {
  return (
    operation.kind === 'checkout' ||
    operation.kind === 'checkoutRemote' ||
    operation.kind === 'checkoutDetached' ||
    operation.kind === 'switchPrevious'
  );
}

/** The same checkout, discarding local changes that would be overwritten. */
export function forcedCheckoutArguments(args: readonly string[]): string[] {
  const [command, ...rest] = args;
  return command === 'switch' ? ['switch', '--discard-changes', ...rest] : ['checkout', '-f', ...rest];
}

export interface GitOperationServiceOptions {
  inspectRepository?(repository: RepositorySummary): Promise<RepositorySummary | undefined>;
  /** Called after Undo Commit with the undone commit's message, so it can be committed again. */
  onCommitUndone?(repository: RepositorySummary, message: string): void;
}

export interface OperationConfirmation {
  title: string;
  detail: string;
  confirmLabel: string;
  destructive: true;
}

function validateToken(value: string, label: string): string {
  if (!value || value.startsWith('-') || /[\0\r\n]/u.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

function validateHash(value: string): string {
  if (!/^[0-9a-f]{4,64}$/iu.test(value)) throw new Error(`Invalid commit hash: ${value}`);
  return value;
}

function validateStashRef(value: string): string {
  if (!/^stash@\{\d+\}$/u.test(value)) throw new Error(`Invalid stash reference: ${value}`);
  return value;
}

export function mergeArguments(operation: Extract<GitOperationRequest, { kind: 'merge' }>): string[] {
  const ref = validateToken(operation.ref, 'merge ref');
  const mode = operation.mode ?? 'default';
  const message = operation.message?.trim();
  // A fast-forward cannot be stopped with --no-commit (git-merge docs), so stopping implies --no-ff.
  const stop = operation.noCommit === true && (mode === 'default' || mode === 'no-ff');
  return [
    'merge',
    ...(mode === 'no-ff' || stop ? ['--no-ff'] : mode === 'ff-only' ? ['--ff-only'] : mode === 'squash' ? ['--squash'] : []),
    ...(stop ? ['--no-commit'] : []),
    // A squash never creates the commit itself, so Git ignores any message.
    ...(mode !== 'squash' && message ? ['-m', validateCommitMessage(message, 'merge message')] : mode !== 'squash' ? ['--no-edit'] : []),
    ref,
  ];
}

function validRemoteName(name: string): string {
  const problem = remoteNameProblem(name);
  if (problem) throw new Error(`Invalid remote name: ${problem}`);
  return name.trim();
}

function validRemoteUrl(url: string): string {
  const problem = remoteUrlProblem(url);
  if (problem) throw new Error(`Invalid remote URL: ${problem}`);
  return url.trim();
}

const REMOTE_OPERATIONS = new Set<GitOperationRequest['kind']>(['fetch', 'addRemote', 'setRemoteUrl', 'renameRemote', 'removeRemote']);

function validateCommitMessage(value: string, label: string): string {
  if (!value.trim() || value.length > 100_000 || value.includes('\0')) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function isRebaseControlOperation(operation: GitOperationRequest): boolean {
  return (
    operation.kind === 'rebaseContinue' ||
    operation.kind === 'rebaseSkip' ||
    operation.kind === 'rebaseAbort'
  );
}

export function buildOperationArguments(
  operation: GitOperationRequest,
  forceSourceHash?: string,
): string[] {
  switch (operation.kind) {
    case 'checkout':
      return ['checkout', validateToken(operation.ref, 'revision'), '--'];
    case 'checkoutDetached':
      return ['switch', '--detach', validateToken(operation.ref, 'revision')];
    case 'switchPrevious':
      return ['switch', '-'];
    case 'createAndCheckoutBranch':
      return ['switch', '-c', validateToken(operation.name, 'branch name')];
    case 'createBranch':
      return [
        'branch',
        '--',
        validateToken(operation.name, 'branch name'),
        validateToken(operation.startPoint, 'start point'),
      ];
    case 'createTag':
      return [
        'tag',
        '--',
        validateToken(operation.name, 'tag name'),
        validateToken(operation.target, 'tag target'),
      ];
    case 'deleteTag':
      return ['tag', '-d', '--', validateToken(operation.name, 'tag name')];
    case 'checkoutRemote':
      return [
        'checkout',
        '-b',
        validateToken(operation.name, 'branch name'),
        '--track',
        validateToken(operation.startPoint, 'remote branch'),
      ];
    case 'deleteRemoteBranch':
      return [
        'push',
        validateToken(operation.remote, 'remote'),
        '--delete',
        `refs/heads/${validateToken(operation.branch, 'remote branch')}`,
      ];
    case 'addRemote':
      return ['remote', 'add', '--', validRemoteName(operation.name), validRemoteUrl(operation.url)];
    case 'setRemoteUrl':
      return ['remote', 'set-url', '--', validRemoteName(operation.name), validRemoteUrl(operation.url)];
    case 'renameRemote':
      return ['remote', 'rename', '--', validRemoteName(operation.oldName), validRemoteName(operation.newName)];
    case 'removeRemote':
      return ['remote', 'remove', '--', validRemoteName(operation.name)];
    case 'fetch':
      return operation.remote
        ? ['fetch', validateToken(operation.remote, 'remote')]
        : ['fetch', '--all', '--prune'];
    case 'pull':
      return ['pull'];
    case 'pushHead':
      return [
        'push',
        '--no-follow-tags',
        validateToken(operation.remote, 'push remote'),
        `HEAD:refs/heads/${validateToken(operation.branch, 'push branch')}`,
      ];
    case 'push':
      if (operation.forceWithLease) {
        if (!operation.remote || !operation.targetRef || !forceSourceHash) {
          throw new Error('Force push target must be resolved before execution.');
        }
        return [
          'push',
          `--force-with-lease=${validateToken(operation.targetRef, 'push target')}`,
          validateToken(operation.remote, 'push remote'),
          `${validateHash(forceSourceHash)}:${validateToken(operation.targetRef, 'push target')}`,
        ];
      }
      return ['push'];
    case 'cherryPick':
      return ['cherry-pick', validateHash(operation.hash)];
    case 'revert':
      return ['revert', '--no-edit', validateHash(operation.hash)];
    case 'merge':
      return mergeArguments(operation);
    case 'rebase':
      return ['rebase', validateToken(operation.ref, 'rebase ref')];
    case 'rebaseContinue':
      return ['rebase', '--continue'];
    case 'rebaseSkip':
      return ['rebase', '--skip'];
    case 'rebaseAbort':
      return ['rebase', '--abort'];
    case 'reset':
      return ['reset', `--${operation.mode}`, validateHash(operation.hash), '--'];
    case 'renameBranch':
      return [
        'branch',
        '-m',
        '--',
        validateToken(operation.oldName, 'branch name'),
        validateToken(operation.newName, 'branch name'),
      ];
    case 'deleteBranch':
      return [
        'branch',
        operation.force ? '-D' : '-d',
        '--',
        validateToken(operation.name, 'branch name'),
      ];
    case 'createStash': {
      const message = operation.message.trim() || 'Git Log stash';
      if (message.length > 10_000 || message.includes('\0')) {
        throw new Error('Invalid stash message.');
      }
      return [
        'stash',
        'push',
        ...(operation.includeUntracked ? ['--include-untracked'] : []),
        '-m',
        message,
      ];
    }
    case 'applyStash':
      return ['stash', 'apply', validateStashRef(operation.stash)];
    case 'popStash':
      return ['stash', 'pop', validateStashRef(operation.stash)];
    case 'dropStash':
      return ['stash', 'drop', validateStashRef(operation.stash)];
    case 'amendCommit':
      return ['commit', '--amend', '-m', validateCommitMessage(operation.message, 'amend message')];
    case 'dropCommits':
    case 'squashCommits':
      throw new Error(`${operation.kind} requires a validated history rewrite plan.`);
    case 'pullFrom':
      return [
        'pull',
        operation.rebase ? '--rebase' : '--no-rebase',
        '--autostash',
        validateToken(operation.remote, 'remote'),
        validateToken(operation.branch, 'remote branch'),
      ];
    case 'updateBranch':
      return [
        'fetch',
        validateToken(operation.remote, 'remote'),
        `refs/heads/${validateToken(operation.remoteBranch, 'remote branch')}:refs/heads/${validateToken(operation.localBranch, 'branch name')}`,
      ];
    case 'updateProject':
      return ['pull', '--autostash', operation.rebase ? '--rebase' : '--no-rebase'];
    case 'pushTo':
      return [
        'push',
        ...(operation.setUpstream && operation.source === 'HEAD' ? ['--set-upstream'] : []),
        ...(operation.forceWithLease ? ['--force-with-lease'] : []),
        ...(operation.pushTags ? ['--follow-tags'] : []),
        validateToken(operation.remote, 'push remote'),
        `${operation.source === 'HEAD' ? 'HEAD' : validateHash(operation.source)}:refs/heads/${validateToken(operation.branch, 'push branch')}`,
      ];
    case 'rewordCommit':
    case 'undoCommit':
    case 'interactiveRebase':
    case 'checkoutAndRebase':
    case 'applyFileChanges':
    case 'getFromRevision':
    case 'dropFileChanges':
      throw new Error(`${operation.kind} requires repository inspection before execution.`);
  }
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Quotes a value for the POSIX shell that runs `exec` lines of a rebase todo list. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Builds a `git rebase -i` todo list; reword and squash messages are applied by `exec` amend lines. */
export function buildRebaseTodo(
  steps: readonly RebaseStep[],
  messageFile: (index: number) => string,
): string {
  if (!steps.length) throw new Error('The rebase has no commits.');
  if (steps.every((step) => step.action === 'drop')) {
    throw new Error('Keep at least one commit, or use Reset to remove all of them.');
  }
  const first = steps.find((step) => step.action !== 'drop');
  if (first && (first.action === 'squash' || first.action === 'fixup')) {
    throw new Error('The first kept commit cannot be squashed or fixed up into a previous commit.');
  }
  const quote = shellQuote;
  const lines: string[] = [];
  let pendingMessage: { index: number; message: string } | undefined;
  const flush = (): void => {
    if (!pendingMessage) return;
    lines.push(
      `exec git commit --amend --only --no-verify --allow-empty -F ${quote(messageFile(pendingMessage.index))}`,
    );
    pendingMessage = undefined;
  };
  steps.forEach((step, index) => {
    const hash = validateHash(step.hash);
    if (step.action === 'squash' || step.action === 'fixup') {
      lines.push(`fixup ${hash}`);
      if (step.action === 'squash' && !pendingMessage) {
        throw new Error('A squashed commit needs a message on the commit it is squashed into.');
      }
      return;
    }
    flush();
    if (step.action === 'drop') {
      lines.push(`drop ${hash}`);
      return;
    }
    lines.push(`${step.action === 'edit' ? 'edit' : 'pick'} ${hash}`);
    if (step.message !== undefined) {
      validateCommitMessage(step.message, 'commit message');
      pendingMessage = { index, message: step.message };
    }
  });
  flush();
  return `${lines.join('\n')}\n`;
}

interface RawCommit {
  tree: string;
  parents: string[];
  author: { name: string; email: string; date: string };
  message: string;
}

function parseRawCommit(raw: string): RawCommit {
  const separator = raw.indexOf('\n\n');
  const headers = (separator >= 0 ? raw.slice(0, separator) : raw).split('\n');
  const message = separator >= 0 ? raw.slice(separator + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author: RawCommit['author'] | undefined;
  for (const header of headers) {
    if (header.startsWith('tree ')) tree = header.slice(5);
    else if (header.startsWith('parent ')) parents.push(header.slice(7));
    else if (header.startsWith('author ')) {
      const match = /^author (.*) <(.*)> (\d+ [+-]\d{4})$/u.exec(header);
      if (match) author = { name: match[1] ?? '', email: match[2] ?? '', date: `@${match[3] ?? ''}` };
    }
  }
  if (!tree || !author) throw new Error('Unable to read commit metadata.');
  return { tree: validateHash(tree), parents: parents.map(validateHash), author, message };
}

export function getOperationConfirmation(
  repository: RepositorySummary,
  operation: GitOperationRequest,
): OperationConfirmation | undefined {
  if (operation.kind === 'reset' && operation.mode === 'hard') {
    return {
      title: 'Hard reset current branch?',
      detail: `Repository “${repository.displayName}” will be hard reset to ${operation.hash}. Uncommitted changes can be lost.`,
      confirmLabel: 'Hard Reset',
      destructive: true,
    };
  }
  if (operation.kind === 'deleteBranch') {
    return {
      title: `Delete branch “${operation.name}”?`,
      detail: `Repository “${repository.displayName}” will delete local branch “${operation.name}”${operation.force ? ' even if it is not merged' : ''}.`,
      confirmLabel: operation.force ? 'Force Delete Branch' : 'Delete Branch',
      destructive: true,
    };
  }
  if (operation.kind === 'deleteRemoteBranch') {
    return {
      title: `Delete remote branch “${operation.remote}/${operation.branch}”?`,
      detail: `Repository “${repository.displayName}” will delete remote branch “${operation.remote}/${operation.branch}”. Other users may depend on it.`,
      confirmLabel: 'Delete Remote Branch',
      destructive: true,
    };
  }
  if (operation.kind === 'deleteTag') {
    return {
      title: `Delete tag “${operation.name}”?`,
      detail: `Repository “${repository.displayName}” will delete local tag “${operation.name}”.`,
      confirmLabel: 'Delete Tag',
      destructive: true,
    };
  }
  if (operation.kind === 'removeRemote') {
    return {
      title: `Remove remote “${operation.name}”?`,
      detail: `Repository “${repository.displayName}” will forget remote “${operation.name}” and its remote-tracking branches (${operation.name}/…). Nothing changes on the server; branches that track it lose their upstream.`,
      confirmLabel: 'Remove Remote',
      destructive: true,
    };
  }
  if (operation.kind === 'dropStash') {
    return {
      title: `Drop ${operation.stash}?`,
      detail: `Repository “${repository.displayName}” will permanently remove ${operation.stash}.`,
      confirmLabel: 'Drop Stash',
      destructive: true,
    };
  }
  if (operation.kind === 'rebaseSkip') {
    const state = repository.operationState ?? 'rebase';
    return {
      title: 'Skip the current commit?',
      detail: `Repository “${repository.displayName}” will omit the current commit and continue the ${state}.`,
      confirmLabel: 'Skip Commit',
      destructive: true,
    };
  }
  if (operation.kind === 'rebaseAbort') {
    const state = repository.operationState ?? 'rebase';
    return {
      title: `Abort the current ${state}?`,
      detail: `Repository “${repository.displayName}” will stop the ${state} and restore the branch to its state before it started.`,
      confirmLabel: state === 'rebase' ? 'Abort Rebase' : 'Abort',
      destructive: true,
    };
  }
  if (operation.kind === 'push' && operation.forceWithLease) {
    const target =
      operation.remote && operation.targetRef
        ? `${operation.remote}/${operation.targetRef}`
        : 'an unresolved remote branch';
    return {
      title: 'Force push with lease?',
      detail: `Repository “${repository.displayName}” will rewrite ${target} if its lease still matches.`,
      confirmLabel: 'Force Push with Lease',
      destructive: true,
    };
  }
  if (operation.kind === 'dropCommits' || operation.kind === 'squashCommits') {
    const count = operation.hashes.length;
    return {
      title: operation.kind === 'dropCommits' ? `Drop ${String(count)} commits?` : `Squash ${String(count)} commits?`,
      detail:
        operation.kind === 'dropCommits'
          ? `Repository “${repository.displayName}” will remove ${String(count)} commits from the current branch and rewrite newer commits.`
          : `Repository “${repository.displayName}” will combine ${String(count)} commits and rewrite newer commits.`,
      confirmLabel: operation.kind === 'dropCommits' ? 'Drop Commits' : 'Squash Commits',
      destructive: true,
    };
  }
  if (operation.kind === 'pushTo' && operation.forceWithLease) {
    return {
      title: 'Force push with lease?',
      detail: `Repository “${repository.displayName}” will overwrite ${operation.remote}/${operation.branch} if its lease still matches.`,
      confirmLabel: 'Force Push with Lease',
      destructive: true,
    };
  }
  if (operation.kind === 'dropFileChanges') {
    return {
      title: `Drop the changes to ${String(operation.paths.length)} file${operation.paths.length === 1 ? '' : 's'} from commit ${operation.hash.slice(0, 8)}?`,
      detail: `${operation.paths.slice(0, 10).join('\n')}${operation.paths.length > 10 ? '\n…' : ''}\n\nThe commit and every newer commit on the current branch are rewritten. Local changes are stashed and restored.`,
      confirmLabel: 'Drop Changes',
      destructive: true,
    };
  }
  if (operation.kind === 'getFromRevision') {
    return {
      title: `Replace ${String(operation.paths.length)} local file${operation.paths.length === 1 ? '' : 's'} with revision ${operation.hash.slice(0, 8)}?`,
      detail: `${operation.paths.slice(0, 10).join('\n')}${operation.paths.length > 10 ? '\n…' : ''}\n\nLocal changes to these files will be lost.`,
      confirmLabel: 'Get from Revision',
      destructive: true,
    };
  }
  if (operation.kind === 'amendCommit') {
    return {
      title: 'Amend the current HEAD commit?',
      detail: `Repository “${repository.displayName}” will replace the current HEAD commit and include staged changes.`,
      confirmLabel: 'Amend Commit',
      destructive: true,
    };
  }
  return undefined;
}

interface CommitRangeRewritePlan {
  cwd: string;
  branch: string;
  expectedHead: string;
  newest: string;
  oldest: string;
  baseParent: string;
}

export class GitOperationService {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly inspect: (
    repository: RepositorySummary,
  ) => Promise<RepositorySummary | undefined>;

  private readonly onCommitUndone: GitOperationServiceOptions['onCommitUndone'];

  constructor(
    private readonly runner: GitRunner,
    options: GitOperationServiceOptions = {},
  ) {
    this.onCommitUndone = options.onCommitUndone;
    this.inspect =
      options.inspectRepository ??
      ((repository) => inspectRepository(fileURLToPath(repository.rootUri), this.runner));
  }

  async resolvePushTarget(
    repository: RepositorySummary,
  ): Promise<{ remote: string; targetRef: string }> {
    const plan = await this.resolvePushPlan(repository);
    return { remote: plan.remote, targetRef: plan.targetRef };
  }

  private async resolvePushPlan(
    repository: RepositorySummary,
  ): Promise<{ remote: string; targetRef: string; sourceRef: string }> {
    if (repository.isBare) throw new Error(`Bare repository “${repository.displayName}” is read-only.`);
    const cwd = fileURLToPath(repository.rootUri);
    const branch = repository.currentBranch;
    if (!branch) throw new Error('Force push is unavailable while HEAD is detached.');
    const readConfig = async (key: string): Promise<string | undefined> => {
      try {
        const result = await this.runner.run(['config', '--get', key], { cwd, timeoutMs: 30_000 });
        return result.stdout.toString('utf8').trim() || undefined;
      } catch (error) {
        if (error instanceof GitCommandError && error.exitCode === 1 && !error.cancelled) {
          return undefined;
        }
        throw error;
      }
    };
    const readAllConfig = async (key: string): Promise<string[]> => {
      try {
        const result = await this.runner.run(['config', '--get-all', key], {
          cwd,
          timeoutMs: 30_000,
        });
        return result.stdout.toString('utf8').split(/\r?\n/u).filter(Boolean);
      } catch (error) {
        if (error instanceof GitCommandError && error.exitCode === 1 && !error.cancelled) return [];
        throw error;
      }
    };
    const pushRemote = await readConfig(`branch.${branch}.pushRemote`);
    const defaultRemote = await readConfig('remote.pushDefault');
    const upstreamRemote = await readConfig(`branch.${branch}.remote`);
    let remote = pushRemote ?? defaultRemote ?? upstreamRemote;
    if (!remote) {
      const remotesResult = await this.runner.run(['remote'], { cwd, timeoutMs: 30_000 });
      const remotes = remotesResult.stdout.toString('utf8').split(/\r?\n/u).filter(Boolean);
      remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined;
    }
    if (!remote) throw new Error('Git could not resolve a unique push remote.');
    if (remote === '.') throw new Error('Force push to the local repository is not supported.');
    if ((await readConfig(`remote.${remote}.mirror`)) === 'true') {
      throw new Error(`Force push is unavailable because remote “${remote}” is configured as a mirror.`);
    }

    const configuredRefspecs = await readAllConfig(`remote.${remote}.push`);
    if (configuredRefspecs.length > 1) {
      throw new Error(`Force push is unavailable because remote “${remote}” has multiple push refspecs.`);
    }
    if (configuredRefspecs[0]) {
      return this.parseConfiguredPushRefspec(remote, configuredRefspecs[0]);
    }

    const pushDefault = (await readConfig('push.default')) ?? 'simple';
    const upstreamRef = await readConfig(`branch.${branch}.merge`);
    const autoSetupRemote = (await readConfig('push.autoSetupRemote')) === 'true';
    let targetRef: string;
    switch (pushDefault) {
      case 'nothing':
        throw new Error('push.default is set to nothing.');
      case 'matching':
        throw new Error('Force push target is ambiguous when push.default is matching.');
      case 'current':
        targetRef = `refs/heads/${branch}`;
        break;
      case 'upstream':
      case 'tracking':
        if (!upstreamRemote || !upstreamRef) {
          throw new Error(`Branch “${branch}” has no upstream push target.`);
        }
        if (remote !== upstreamRemote) {
          throw new Error(
            `${pushDefault} push is unavailable because push remote “${remote}” differs from upstream remote “${upstreamRemote}”.`,
          );
        }
        targetRef = upstreamRef;
        break;
      case 'simple':
        if (!upstreamRemote || !upstreamRef) {
          if (!autoSetupRemote) throw new Error(`Branch “${branch}” has no upstream push target.`);
          targetRef = `refs/heads/${branch}`;
          break;
        }
        if (remote !== upstreamRemote) {
          targetRef = `refs/heads/${branch}`;
          break;
        }
        if (upstreamRef !== `refs/heads/${branch}`) {
          throw new Error(
            `Simple push is blocked because local branch “${branch}” differs from upstream “${upstreamRef.replace(/^refs\/heads\//u, '')}”.`,
          );
        }
        targetRef = upstreamRef;
        break;
      default:
        throw new Error(`Unsupported push.default mode: ${pushDefault}`);
    }
    return {
      remote: validateToken(remote, 'push remote'),
      targetRef: validateToken(targetRef, 'push target'),
      sourceRef: 'HEAD',
    };
  }

  run(
    repository: RepositorySummary,
    operation: GitOperationRequest,
    options: GitOperationRunOptions = {},
  ): Promise<GitOperationResult> {
    if (repository.isBare) {
      return Promise.reject(new Error(`Bare repository “${repository.displayName}” is read-only.`));
    }
    const queueKey = this.getQueueKey(repository);
    const previous = this.queues.get(queueKey) ?? Promise.resolve();
    const execution = previous
      .catch(() => undefined)
      .then(async () => {
        const freshRepository = await this.inspect(repository);
        if (!freshRepository) throw new Error(`Repository “${repository.displayName}” is unavailable.`);
        const isRebaseControl = isRebaseControlOperation(operation);
        if (
          freshRepository.operationState &&
          // Remote settings and fetches do not touch the work in progress.
          !REMOTE_OPERATIONS.has(operation.kind) &&
          !(freshRepository.operationState in SEQUENCER_COMMANDS && isRebaseControl)
        ) {
          throw new Error(
            `A Git ${freshRepository.operationState} is in progress; finish or abort it first.`,
          );
        }
        if (!freshRepository.operationState && isRebaseControl) {
          throw new Error('No Git rebase, cherry-pick or revert is in progress.');
        }
        if (operation.kind === 'rebaseContinue' && freshRepository.hasUnresolvedConflicts) {
          throw new Error(`Resolve all conflicts before continuing the ${freshRepository.operationState ?? 'rebase'}.`);
        }
        if (operation.kind === 'deleteRemoteBranch') {
          await this.validateRemoteBranchDeletion(freshRepository, operation.remote, operation.branch);
        }
        if (operation.kind === 'pushHead') {
          const cwd = fileURLToPath(freshRepository.rootUri);
          const remote = validateToken(operation.remote, 'push remote');
          const branch = validateToken(operation.branch, 'push branch');
          const configured = await this.runner.run(['remote'], { cwd, timeoutMs: 30_000 });
          if (!configured.stdout.toString('utf8').split(/\r?\n/u).includes(remote)) {
            throw new Error(`Remote “${remote}” is not a configured remote.`);
          }
          if (branch.startsWith('refs/')) throw new Error('Enter a branch name without the refs/ prefix.');
          await this.runner.run(['check-ref-format', `refs/heads/${branch}`], { cwd, timeoutMs: 30_000 });
        }
        let rewritePlan: CommitRangeRewritePlan | undefined;
        if (operation.kind === 'dropCommits' || operation.kind === 'squashCommits') {
          rewritePlan = await this.planCommitRangeRewrite(freshRepository, operation.hashes);
        }
        let preparedOperation = operation;
        let forceSourceHash: string | undefined;
        if (operation.kind === 'push' && operation.forceWithLease) {
          const plan = await this.resolvePushPlan(freshRepository);
          preparedOperation = {
            ...operation,
            remote: plan.remote,
            targetRef: plan.targetRef,
          };
          // validateToken rejects option-like sources; rev-parse gained --end-of-options in Git 2.30.
          const source = await this.runner.run(
            ['rev-parse', '--verify', `${plan.sourceRef}^{commit}`],
            { cwd: fileURLToPath(freshRepository.rootUri), timeoutMs: 30_000 },
          );
          forceSourceHash = source.stdout.toString('utf8').trim();
        }
        const confirmation = getOperationConfirmation(freshRepository, preparedOperation);
        if (confirmation) {
          if (!options.confirm) {
            throw new Error('This destructive Git operation requires confirmation.');
          }
          if (!(await options.confirm(confirmation))) return { message: '', cancelled: true };
        }
        if (rewritePlan) {
          if (operation.kind !== 'dropCommits' && operation.kind !== 'squashCommits') {
            throw new Error('Invalid commit history rewrite operation.');
          }
          await this.assertRewritePlanStillCurrent(rewritePlan);
          const revalidatedPlan = await this.planCommitRangeRewrite(
            freshRepository,
            operation.hashes,
          );
          if (
            revalidatedPlan.branch !== rewritePlan.branch ||
            revalidatedPlan.expectedHead !== rewritePlan.expectedHead ||
            revalidatedPlan.baseParent !== rewritePlan.baseParent
          ) {
            throw new Error(
              'The current branch or HEAD changed during confirmation; select the commits again.',
            );
          }
          rewritePlan = revalidatedPlan;
        }
        if (rewritePlan && preparedOperation.kind === 'dropCommits') {
          await this.rebaseCommitRange(rewritePlan, rewritePlan.baseParent);
        } else if (rewritePlan && preparedOperation.kind === 'squashCommits') {
          const squashedHash = await this.createSquashedCommit(
            rewritePlan,
            preparedOperation.message,
          );
          await this.rebaseCommitRange(rewritePlan, squashedHash);
        } else if (preparedOperation.kind === 'rewordCommit') {
          await this.rewordCommit(freshRepository, preparedOperation.hash, preparedOperation.message);
        } else if (preparedOperation.kind === 'undoCommit') {
          await this.undoCommit(freshRepository, preparedOperation.hash);
        } else if (preparedOperation.kind === 'interactiveRebase') {
          await this.interactiveRebase(freshRepository, preparedOperation.base, preparedOperation.steps);
        } else if (preparedOperation.kind === 'checkoutAndRebase') {
          const cwd = fileURLToPath(freshRepository.rootUri);
          const current = await this.runner.run(['branch', '--show-current'], { cwd, timeoutMs: 30_000 });
          const onto = current.stdout.toString('utf8').trim() || (await this.revParse(cwd, 'HEAD'));
          await this.runner.run(
            ['rebase', validateToken(onto, 'rebase target'), validateToken(preparedOperation.branch, 'branch name')],
            { cwd, timeoutMs: 10 * 60_000, env: { GIT_EDITOR: 'true' } },
          );
        } else if (preparedOperation.kind === 'applyFileChanges') {
          await this.applyFileChanges(freshRepository, preparedOperation);
        } else if (preparedOperation.kind === 'dropFileChanges') {
          await this.dropFileChanges(freshRepository, preparedOperation.hash, preparedOperation.paths);
        } else if (preparedOperation.kind === 'getFromRevision') {
          await this.getFromRevision(freshRepository, preparedOperation.hash, preparedOperation.paths);
        } else if (preparedOperation.kind === 'cherryPick') {
          return this.cherryPick(freshRepository, preparedOperation.hash);
        } else if (isCheckoutOperation(preparedOperation)) {
          return this.checkout(freshRepository, preparedOperation, options);
        } else {
          const args =
            preparedOperation.kind === 'rebaseContinue' ||
            preparedOperation.kind === 'rebaseSkip' ||
            preparedOperation.kind === 'rebaseAbort'
              ? sequencerArguments(freshRepository.operationState, preparedOperation.kind)
              : buildOperationArguments(preparedOperation, forceSourceHash);
          await this.runner.run(args, {
            cwd: fileURLToPath(freshRepository.rootUri),
            timeoutMs: 10 * 60_000,
            ...(preparedOperation.kind === 'rebaseContinue'
              ? { env: { GIT_EDITOR: 'true' } }
              : {}),
          });
        }
        return { message: `${operation.kind} completed.` };
      });
    const tail = execution.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(queueKey, tail);
    void tail.finally(() => {
      if (this.queues.get(queueKey) === tail) this.queues.delete(queueKey);
    });
    return execution;
  }

  private async revParse(cwd: string, revision: string): Promise<string> {
    const result = await this.runner.run(['rev-parse', '--verify', `${revision}^{commit}`], {
      cwd,
      timeoutMs: 30_000,
    });
    return validateHash(result.stdout.toString('utf8').trim());
  }

  private async readCommit(cwd: string, hash: string): Promise<RawCommit> {
    const result = await this.runner.run(['cat-file', 'commit', validateHash(hash)], { cwd, timeoutMs: 30_000 });
    return parseRawCommit(result.stdout.toString('utf8'));
  }

  /**
   * Returns the first-parent commits from `hash` (inclusive) to HEAD, oldest first, rejecting
   * merges because their history cannot be replayed linearly.
   */
  async listLinearCommitsToHead(
    cwd: string,
    hash: string,
  ): Promise<{ hashes: string[]; base?: string; head: string; branch?: string }> {
    const target = await this.revParse(cwd, hash);
    const head = await this.revParse(cwd, 'HEAD');
    const history = await this.runner.run(['rev-list', '--first-parent', '--parents', 'HEAD'], {
      cwd,
      timeoutMs: 60_000,
    });
    const lines = history.stdout.toString('utf8').trim().split(/\r?\n/u).filter(Boolean).map((line) => line.split(' '));
    const index = lines.findIndex(([candidate]) => candidate === target);
    if (index < 0) throw new Error('The selected commit is not in the current branch’s first-parent history.');
    if (index >= 500) throw new Error('Select a commit among the 500 most recent commits of the current branch.');
    const range = lines.slice(0, index + 1);
    if (range.some((line) => line.length > 2)) {
      throw new Error('Rewriting history across merge commits is not supported; choose a commit after the latest merge.');
    }
    const branchResult = await this.runner.run(['branch', '--show-current'], { cwd, timeoutMs: 30_000 });
    const branch = branchResult.stdout.toString('utf8').trim();
    const base = range.at(-1)?.[1];
    return {
      hashes: range.map(([candidate]) => candidate ?? '').reverse(),
      ...(base ? { base } : {}),
      head,
      ...(branch ? { branch } : {}),
    };
  }

  private async rewordCommit(repository: RepositorySummary, hash: string, message: string): Promise<void> {
    const cwd = fileURLToPath(repository.rootUri);
    const text = validateCommitMessage(message, 'commit message');
    const plan = await this.listLinearCommitsToHead(cwd, hash);
    const input = text.endsWith('\n') ? text : `${text}\n`;
    if (plan.hashes.length === 1) {
      // Rewording HEAD: amend only the message, leaving staged changes alone.
      await this.runner.run(['commit', '--amend', '--only', '--allow-empty', '--no-verify', '-F', '-'], {
        cwd,
        timeoutMs: 60_000,
        input,
      });
      return;
    }
    // Recreate the commits with identical trees, so the index and working tree stay untouched.
    let parent = plan.base;
    for (const [index, current] of plan.hashes.entries()) {
      const commit = await this.readCommit(cwd, current);
      const created = await this.runner.run(
        ['commit-tree', commit.tree, ...(parent ? ['-p', parent] : [])],
        {
          cwd,
          timeoutMs: 30_000,
          input: index === 0 ? input : commit.message,
          env: {
            GIT_AUTHOR_NAME: commit.author.name,
            GIT_AUTHOR_EMAIL: commit.author.email,
            GIT_AUTHOR_DATE: commit.author.date,
          },
        },
      );
      parent = validateHash(created.stdout.toString('utf8').trim());
    }
    if (!parent) throw new Error('Unable to rewrite the commit message.');
    await this.runner.run(
      plan.branch
        ? ['update-ref', '-m', 'git-log: reword', `refs/heads/${plan.branch}`, parent, plan.head]
        : ['update-ref', '--no-deref', '-m', 'git-log: reword', 'HEAD', parent, plan.head],
      { cwd, timeoutMs: 30_000 },
    );
  }

  private async undoCommit(repository: RepositorySummary, hash: string): Promise<void> {
    const cwd = fileURLToPath(repository.rootUri);
    const head = await this.revParse(cwd, 'HEAD');
    if (head !== (await this.revParse(cwd, hash))) throw new Error('Only the current HEAD commit can be undone.');
    const commit = await this.readCommit(cwd, head);
    if (commit.parents.length !== 1) {
      throw new Error(commit.parents.length ? 'A merge commit cannot be undone this way.' : 'The root commit cannot be undone.');
    }
    await this.runner.run(['reset', '--soft', commit.parents[0] ?? '', '--'], { cwd, timeoutMs: 60_000 });
    this.onCommitUndone?.(repository, commit.message.replace(/\s+$/u, ''));
  }

  private async interactiveRebase(
    repository: RepositorySummary,
    base: string | undefined,
    steps: readonly RebaseStep[],
  ): Promise<void> {
    const cwd = fileURLToPath(repository.rootUri);
    // The steps must be exactly the linear first-parent commits after `base`, in any order.
    const expected = await this.listCommitsAfter(cwd, base);
    const oldest = expected[0];
    if (!oldest) throw new Error('There are no commits to rebase.');
    const plan = await this.listLinearCommitsToHead(cwd, oldest);
    if ((plan.base ?? '') !== (base ?? '')) throw new Error('The rebase base is not the parent of the oldest commit.');
    const resolved = await Promise.all(steps.map((step) => this.revParse(cwd, step.hash)));
    if (expected.length !== resolved.length || [...expected].sort().join() !== [...resolved].sort().join()) {
      throw new Error('The branch changed since the rebase plan was prepared; reopen the dialog.');
    }
    const directory = join(fileURLToPath(repository.gitDirUri), 'git-log-rebase');
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const messageFile = (index: number): string => join(directory, `message-${String(index)}.txt`);
    const todo = buildRebaseTodo(
      steps.map((step, index) => ({ ...step, hash: resolved[index] ?? step.hash })),
      messageFile,
    );
    await Promise.all(
      steps.map((step, index) =>
        step.message === undefined ? Promise.resolve() : writeFile(messageFile(index), step.message, 'utf8'),
      ),
    );
    const todoFile = join(directory, 'todo.txt');
    await writeFile(todoFile, todo, 'utf8');
    await this.runner.run(
      [
        '-c',
        'rebase.updateRefs=false',
        '-c',
        'rebase.instructionFormat=%s',
        'rebase',
        '-i',
        '--autostash',
        '--no-autosquash',
        ...(base ? [validateHash(base)] : ['--root']),
      ],
      {
        cwd,
        timeoutMs: 10 * 60_000,
        env: {
          GIT_SEQUENCE_EDITOR: `cp '${todoFile.replaceAll("'", "'\\''")}'`,
          GIT_EDITOR: 'true',
        },
      },
    );
  }

  /** Removes the selected files' changes from one commit and replays the newer commits on top. */
  private async dropFileChanges(repository: RepositorySummary, hash: string, paths: readonly string[]): Promise<void> {
    const cwd = fileURLToPath(repository.rootUri);
    const plan = await this.listLinearCommitsToHead(cwd, hash);
    const [target] = plan.hashes;
    if (!target || !plan.base) throw new Error('Changes cannot be dropped from the root commit.');
    const base = plan.base;
    const restore: string[] = [];
    for (const path of paths) {
      try {
        await this.runner.run(['cat-file', '-e', `${base}:${path}`], { cwd, timeoutMs: 30_000 });
        restore.push(`git checkout ${base} -- ${shellQuote(path)}`);
      } catch (error) {
        if (!(error instanceof GitCommandError) || error.cancelled) throw error;
        // The file did not exist before this commit, so dropping its change removes it.
        restore.push(`git rm -q -f --ignore-unmatch -- ${shellQuote(path)}`);
      }
    }
    // One exec line: Git stops the rebase when an exec step leaves the index dirty.
    const amend = `exec ${[...restore, 'git commit --amend --no-edit --allow-empty --no-verify'].join(' && ')}`;
    const lines = plan.hashes.flatMap((commit) => (commit === target ? [`pick ${commit}`, amend] : [`pick ${commit}`]));
    const directory = join(fileURLToPath(repository.gitDirUri), 'git-log-rebase');
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const todoFile = join(directory, 'todo.txt');
    await writeFile(todoFile, `${lines.join('\n')}\n`, 'utf8');
    await this.runner.run(
      ['-c', 'rebase.updateRefs=false', 'rebase', '-i', '--autostash', '--no-autosquash', validateHash(base)],
      {
        cwd,
        timeoutMs: 10 * 60_000,
        env: {
          GIT_SEQUENCE_EDITOR: `cp ${shellQuote(todoFile)}`,
          GIT_EDITOR: 'true',
          GIT_LITERAL_PATHSPECS: '1',
        },
      },
    );
  }

  private async listCommitsAfter(cwd: string, base: string | undefined): Promise<string[]> {
    const result = await this.runner.run(
      ['rev-list', '--first-parent', '--reverse', base ? `${validateHash(base)}..HEAD` : 'HEAD'],
      { cwd, timeoutMs: 60_000 },
    );
    return result.stdout.toString('utf8').trim().split(/\r?\n/u).filter(Boolean);
  }

  private async applyFileChanges(
    repository: RepositorySummary,
    operation: Extract<GitOperationRequest, { kind: 'applyFileChanges' }>,
  ): Promise<void> {
    const cwd = fileURLToPath(repository.rootUri);
    const hash = validateHash(operation.hash);
    const commit = await this.readCommit(cwd, hash);
    const parent = operation.parent ? validateHash(operation.parent) : (commit.parents[0] ?? EMPTY_TREE);
    const patch = await this.runner.run(
      ['diff', '--binary', '--no-color', '--no-ext-diff', parent, hash, '--', ...operation.paths],
      { cwd, timeoutMs: 60_000, env: { GIT_LITERAL_PATHSPECS: '1' } },
    );
    if (!patch.stdout.length) throw new Error('The selected files have no changes in this commit.');
    await this.runner.run(['apply', '--3way', ...(operation.reverse ? ['--reverse'] : []), '-'], {
      cwd,
      timeoutMs: 60_000,
      input: patch.stdout,
    });
  }

  /**
   * Cherry-picks one commit. When its change is already in the branch, Git stops with nothing to
   * commit; that stop is skipped right away and reported, instead of leaving a pick in progress.
   */
  private async checkout(
    repository: RepositorySummary,
    operation: CheckoutOperation,
    options: GitOperationRunOptions,
  ): Promise<GitOperationResult> {
    const cwd = fileURLToPath(repository.rootUri);
    const args = buildOperationArguments(operation);
    const run = (checkoutArgs: readonly string[]) =>
      this.runner.run(checkoutArgs, { cwd, timeoutMs: 10 * 60_000 });
    try {
      await run(args);
      return { message: `${operation.kind} completed.` };
    } catch (error) {
      const conflict =
        error instanceof GitCommandError ? parseCheckoutConflict(error.stderr.toString('utf8')) : undefined;
      if (!conflict || !options.resolveCheckoutConflict) throw error;
      const choice = await options.resolveCheckoutConflict(conflict);
      if (!choice) return { message: '', cancelled: true };
      if (choice === 'force') {
        await this.removeUntrackedFiles(cwd, conflict.untracked);
        await run(forcedCheckoutArguments(args));
        return { message: `${operation.kind} completed.`, notice: 'Checked out; local changes to the listed files were discarded.' };
      }
      return this.smartCheckout(cwd, args, run);
    }
  }

  /** Stash, check out, and bring the changes back, as the IDE's Smart Checkout does. */
  private async smartCheckout(
    cwd: string,
    args: readonly string[],
    run: (checkoutArgs: readonly string[]) => Promise<unknown>,
  ): Promise<GitOperationResult> {
    const stashTip = async () =>
      (await this.runner.run(['rev-parse', '-q', '--verify', 'refs/stash'], { cwd, timeoutMs: 30_000 }).catch(() => undefined))
        ?.stdout.toString('utf8')
        .trim();
    const before = await stashTip();
    const from = (await this.runner.run(['branch', '--show-current'], { cwd, timeoutMs: 30_000 })).stdout.toString('utf8').trim();
    await this.runner.run(
      ['stash', 'push', '--include-untracked', '-m', `IDE Git smart checkout from ${from || 'detached HEAD'}`],
      { cwd, timeoutMs: 10 * 60_000 },
    );
    const stashed = (await stashTip()) !== before;
    try {
      await run(args);
    } catch (error) {
      // Put everything back where it was before reporting the failure.
      if (stashed) {
        const pop = (popArgs: string[]) => this.runner.run(popArgs, { cwd, timeoutMs: 10 * 60_000 });
        await pop(['stash', 'pop', '--index']).catch(() => pop(['stash', 'pop'])).catch(() => undefined);
      }
      throw error;
    }
    if (!stashed) return { message: 'checkout completed.' };
    try {
      await this.runner.run(['stash', 'pop'], { cwd, timeoutMs: 10 * 60_000 });
    } catch {
      // Git keeps the stash when it cannot apply it cleanly, so nothing is lost.
      const unmerged = await this.runner.run(['diff', '--name-only', '--diff-filter=U'], { cwd, timeoutMs: 30_000 });
      return {
        message: 'checkout completed.',
        notice: unmerged.stdout.toString('utf8').trim()
          ? 'Checked out, but restoring your local changes caused conflicts. Resolve them in the Commit window; the changes are also kept in stash@{0} until you drop it.'
          : 'Checked out, but some local changes could not be restored because files with the same names now exist. They are kept in stash@{0}; unstash them from Stashes in the Git Log when ready.',
      };
    }
    return { message: 'checkout completed.', notice: 'Checked out; your local changes were restored.' };
  }

  /** Deletes untracked files that block a forced checkout, after checking each one really is. */
  private async removeUntrackedFiles(cwd: string, paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      const target = normalize(join(cwd, path));
      if (!target.startsWith(normalize(cwd + '/'))) throw new Error(`Refusing to delete ${path}: outside the repository.`);
      const listed = await this.runner.run(['ls-files', '--others', '-z', '--', path], {
        cwd,
        timeoutMs: 30_000,
        env: { GIT_LITERAL_PATHSPECS: '1' },
      });
      if (!listed.stdout.toString('utf8').split('\0').includes(path)) {
        throw new Error(`Refusing to delete ${path}: it is not an untracked file.`);
      }
      await rm(target, { force: true });
    }
  }

  private async cherryPick(repository: RepositorySummary, hash: string): Promise<GitOperationResult> {
    const cwd = fileURLToPath(repository.rootUri);
    try {
      await this.runner.run(['cherry-pick', validateHash(hash)], { cwd, timeoutMs: 10 * 60_000 });
      return { message: 'cherryPick completed.' };
    } catch (error) {
      if (!(error instanceof GitCommandError) || error.cancelled) throw error;
      const stillPicking = await this.runner
        .run(['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'], { cwd, timeoutMs: 30_000 })
        .then(() => true, () => false);
      const conflicted = await this.runner
        .run(['diff', '--name-only', '--diff-filter=U'], { cwd, timeoutMs: 30_000 })
        .then((result) => result.stdout.toString('utf8').trim() !== '');
      const nothingStaged = await this.runner
        .run(['diff', '--cached', '--quiet'], { cwd, timeoutMs: 30_000 })
        .then(() => true, () => false);
      if (!stillPicking || conflicted || !nothingStaged) throw error;
      await this.runner.run(['cherry-pick', '--skip'], { cwd, timeoutMs: 60_000 });
      return {
        message: 'cherryPick completed.',
        notice: `Nothing to cherry-pick: the changes of ${hash.slice(0, 8)} are already in the current branch.`,
      };
    }
  }

  private async getFromRevision(repository: RepositorySummary, hash: string, paths: readonly string[]): Promise<void> {
    const cwd = fileURLToPath(repository.rootUri);
    const revision = validateHash(hash);
    const existing: string[] = [];
    const missing: string[] = [];
    for (const path of paths) {
      try {
        await this.runner.run(['cat-file', '-e', `${revision}:${path}`], { cwd, timeoutMs: 30_000 });
        existing.push(path);
      } catch (error) {
        if (error instanceof GitCommandError && !error.cancelled) missing.push(path);
        else throw error;
      }
    }
    if (existing.length) {
      await this.runner.run(['checkout', revision, '--', ...existing], {
        cwd,
        timeoutMs: 60_000,
        env: { GIT_LITERAL_PATHSPECS: '1' },
      });
    }
    if (missing.length) {
      // The file does not exist at that revision, so getting it means deleting the local copy.
      await this.runner.run(['rm', '-f', '--ignore-unmatch', '--quiet', '--', ...missing], {
        cwd,
        timeoutMs: 60_000,
        env: { GIT_LITERAL_PATHSPECS: '1' },
      });
    }
  }

  private getQueueKey(repository: RepositorySummary): string {
    const path = normalize(fileURLToPath(repository.commonGitDirUri ?? repository.gitDirUri));
    return process.platform === 'win32' ? path.toLowerCase() : path;
  }

  private async planCommitRangeRewrite(
    repository: RepositorySummary,
    requestedHashes: readonly string[],
  ): Promise<CommitRangeRewritePlan> {
    const cwd = fileURLToPath(repository.rootUri);
    const branchResult = await this.runner.run(['branch', '--show-current'], {
      cwd,
      timeoutMs: 30_000,
    });
    const branch = branchResult.stdout.toString('utf8').trim();
    if (!branch) throw new Error('Commit history rewriting is unavailable while HEAD is detached.');
    const hashes = requestedHashes.map(validateHash);
    if (hashes.length < 2 || hashes.length > 100 || new Set(hashes).size !== hashes.length) {
      throw new Error('Select between 2 and 100 unique commits.');
    }
    const newest = hashes[0];
    const oldest = hashes.at(-1);
    if (!newest || !oldest) throw new Error('Select between 2 and 100 unique commits.');
    const status = await this.runner.run(['status', '--porcelain=v1', '-z'], {
      cwd,
      timeoutMs: 30_000,
    });
    if (status.stdout.length > 0) {
      throw new Error('Drop and squash require a clean worktree. Commit or stash changes first.');
    }
    const historyResult = await this.runner.run(['rev-list', '--first-parent', '--parents', 'HEAD'], {
      cwd,
      timeoutMs: 30_000,
    });
    const historyLines = historyResult.stdout
      .toString('utf8')
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => line.split(/\s+/u));
    const history = historyLines.map(([hash]) => hash).filter((hash): hash is string => Boolean(hash));
    const expectedHead = history[0];
    if (!expectedHead) throw new Error('The current branch has no commits to rewrite.');
    const newestIndex = history.indexOf(newest);
    if (
      newestIndex < 0 ||
      hashes.some((hash, index) => history[newestIndex + index] !== hash)
    ) {
      throw new Error('Selected commits must be contiguous on the current branch first-parent history.');
    }
    const oldestIndex = newestIndex + hashes.length - 1;
    if (oldestIndex >= history.length - 1) {
      throw new Error('The root commit cannot be dropped or squashed.');
    }
    const baseParent = history[oldestIndex + 1];
    if (!baseParent) throw new Error('The root commit cannot be dropped or squashed.');
    if (historyLines.slice(0, oldestIndex + 1).some((line) => line.length !== 2)) {
      throw new Error('Commit history rewriting is unavailable across merge commits.');
    }
    return {
      cwd,
      branch: validateToken(branch, 'branch name'),
      expectedHead,
      newest,
      oldest,
      baseParent,
    };
  }

  private async assertRewritePlanStillCurrent(plan: CommitRangeRewritePlan): Promise<void> {
    const [branchResult, headResult, statusResult] = await Promise.all([
      this.runner.run(['branch', '--show-current'], { cwd: plan.cwd, timeoutMs: 30_000 }),
      this.runner.run(['rev-parse', '--verify', 'HEAD'], { cwd: plan.cwd, timeoutMs: 30_000 }),
      this.runner.run(['status', '--porcelain=v1', '-z'], {
        cwd: plan.cwd,
        timeoutMs: 30_000,
      }),
    ]);
    const branch = branchResult.stdout.toString('utf8').trim();
    const head = headResult.stdout.toString('utf8').trim();
    if (branch !== plan.branch || head !== plan.expectedHead) {
      throw new Error('The current branch or HEAD changed during confirmation; select the commits again.');
    }
    if (statusResult.stdout.length > 0) {
      throw new Error('The worktree changed during confirmation; commit or stash changes first.');
    }
  }

  private async createSquashedCommit(
    plan: CommitRangeRewritePlan,
    message: string,
  ): Promise<string> {
    if (!message.trim() || message.length > 100_000 || message.includes('\0')) {
      throw new Error('The squash commit message is invalid.');
    }
    const treeResult = await this.runner.run(['rev-parse', `${plan.newest}^{tree}`], {
      cwd: plan.cwd,
      timeoutMs: 30_000,
    });
    const authorResult = await this.runner.run(
      ['show', '-s', '--format=%an%x00%ae%x00%aI', plan.oldest, '--'],
      { cwd: plan.cwd, timeoutMs: 30_000 },
    );
    const [authorName, authorEmail, authorDate] = authorResult.stdout
      .toString('utf8')
      .replace(/\r?\n$/u, '')
      .split('\0');
    const commitResult = await this.runner.run(
      ['commit-tree', treeResult.stdout.toString('utf8').trim(), '-p', plan.baseParent],
      {
        cwd: plan.cwd,
        timeoutMs: 30_000,
        input: message.endsWith('\n') ? message : `${message}\n`,
        env: {
          GIT_AUTHOR_NAME: authorName,
          GIT_AUTHOR_EMAIL: authorEmail,
          GIT_AUTHOR_DATE: authorDate,
        },
      },
    );
    return validateHash(commitResult.stdout.toString('utf8').trim());
  }

  private async rebaseCommitRange(
    plan: CommitRangeRewritePlan,
    newBase: string,
  ): Promise<void> {
    await this.assertRewritePlanStillCurrent(plan);
    await this.runner.run(
      [
        '-c',
        'rebase.updateRefs=false',
        '-c',
        'rebase.autoStash=false',
        'rebase',
        '--onto',
        validateHash(newBase),
        plan.newest,
      ],
      { cwd: plan.cwd, timeoutMs: 10 * 60_000 },
    );
  }

  private async validateRemoteBranchDeletion(
    repository: RepositorySummary,
    remote: string,
    branch: string,
  ): Promise<void> {
    const cwd = fileURLToPath(repository.rootUri);
    const validatedRemote = validateToken(remote, 'remote');
    const validatedBranch = validateToken(branch, 'remote branch');
    const remotesResult = await this.runner.run(['remote'], { cwd, timeoutMs: 30_000 });
    const remotes = remotesResult.stdout.toString('utf8').split(/\r?\n/u).filter(Boolean);
    if (!remotes.includes(validatedRemote)) {
      throw new Error(`Remote “${validatedRemote}” is not a configured remote.`);
    }
    await this.runner.run(['check-ref-format', '--branch', validatedBranch], {
      cwd,
      timeoutMs: 30_000,
      maxStdoutBytes: 4096,
    });
    try {
      await this.runner.run(
        ['show-ref', '--verify', '--quiet', `refs/remotes/${validatedRemote}/${validatedBranch}`],
        { cwd, timeoutMs: 30_000, maxStdoutBytes: 4096 },
      );
    } catch (error) {
      if (error instanceof GitCommandError && error.exitCode === 1 && !error.cancelled) {
        throw new Error(
          `Remote branch “${validatedRemote}/${validatedBranch}” is not tracked locally.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private parseConfiguredPushRefspec(
    remote: string,
    configuredRefspec: string,
  ): { remote: string; targetRef: string; sourceRef: string } {
    const refspec = configuredRefspec.startsWith('+')
      ? configuredRefspec.slice(1)
      : configuredRefspec;
    if (!refspec || refspec.startsWith('^') || refspec.includes('*')) {
      throw new Error(`Force push does not support push refspec “${configuredRefspec}”.`);
    }
    const separator = refspec.indexOf(':');
    if (separator <= 0 || separator !== refspec.lastIndexOf(':')) {
      throw new Error(
        `Force push requires a fully qualified destination in push refspec “${configuredRefspec}”.`,
      );
    }
    const source = separator >= 0 ? refspec.slice(0, separator) : refspec;
    const destination = separator >= 0 ? refspec.slice(separator + 1) : refspec;
    if (!source || !destination || destination.includes(':')) {
      throw new Error(`Force push does not support push refspec “${configuredRefspec}”.`);
    }
    if (!destination.startsWith('refs/')) {
      throw new Error(
        `Force push requires a fully qualified destination in push refspec “${configuredRefspec}”.`,
      );
    }
    const targetRef = destination;
    if (!targetRef.startsWith('refs/heads/')) {
      throw new Error(`Force push only supports branch destinations, not “${targetRef}”.`);
    }
    return {
      remote: validateToken(remote, 'push remote'),
      targetRef: validateToken(targetRef, 'push target'),
      sourceRef: validateToken(source, 'push source'),
    };
  }
}
