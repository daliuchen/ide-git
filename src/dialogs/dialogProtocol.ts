import type { RebaseAction, RebaseStep } from '../protocol/messages';
import type { ChangedFile } from '../shared/models';

export interface DialogCommit {
  hash: string;
  shortHash: string;
  subject: string;
  message: string;
  author: string;
  date: number;
}

export type DialogInit =
  | {
      dialog: 'push';
      repositoryName: string;
      remotes: string[];
      remote: string;
      branch: string;
      currentBranch?: string;
      upstream?: string;
      source: string;
      setUpstream: boolean;
    }
  | {
      dialog: 'rebase';
      mode: 'interactive' | 'reword';
      repositoryName: string;
      branch?: string;
      commits: DialogCommit[];
    };

export type DialogExtensionMessage =
  | { type: 'init'; init: DialogInit }
  | { type: 'commitsLoaded'; remote: string; branch: string; commits: DialogCommit[]; remoteBranchExists: boolean }
  | { type: 'filesLoaded'; hash: string; files: ChangedFile[] }
  | { type: 'busy'; busy: boolean }
  | { type: 'error'; message: string };

export type DialogWebviewMessage =
  | { type: 'ready' }
  | { type: 'loadCommits'; remote: string; branch: string }
  | { type: 'loadFiles'; hash: string }
  | { type: 'openFileDiff'; hash: string; path: string }
  | {
      type: 'push';
      remote: string;
      branch: string;
      setUpstream: boolean;
      forceWithLease: boolean;
      pushTags: boolean;
    }
  | { type: 'rebase'; steps: RebaseStep[] }
  | { type: 'reword'; hash: string; message: string }
  | { type: 'cancel' };

const ACTIONS: readonly RebaseAction[] = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max = 4096): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0');
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{4,64}$/iu.test(value);
}

export function parseDialogMessage(value: unknown): DialogWebviewMessage | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.type) {
    case 'ready':
    case 'cancel':
      return { type: value.type };
    case 'loadCommits':
      return isText(value.remote) && isText(value.branch)
        ? { type: 'loadCommits', remote: value.remote, branch: value.branch }
        : undefined;
    case 'loadFiles':
      return isHash(value.hash) ? { type: 'loadFiles', hash: value.hash } : undefined;
    case 'openFileDiff':
      return isHash(value.hash) && isText(value.path) && value.path
        ? { type: 'openFileDiff', hash: value.hash, path: value.path }
        : undefined;
    case 'push':
      return isText(value.remote) &&
        isText(value.branch) &&
        typeof value.setUpstream === 'boolean' &&
        typeof value.forceWithLease === 'boolean' &&
        typeof value.pushTags === 'boolean'
        ? {
            type: 'push',
            remote: value.remote,
            branch: value.branch,
            setUpstream: value.setUpstream,
            forceWithLease: value.forceWithLease,
            pushTags: value.pushTags,
          }
        : undefined;
    case 'rebase': {
      if (!Array.isArray(value.steps) || value.steps.length > 500) return undefined;
      const steps: RebaseStep[] = [];
      for (const step of value.steps) {
        if (
          !isRecord(step) ||
          !isHash(step.hash) ||
          !ACTIONS.includes(step.action as RebaseAction) ||
          (step.message !== undefined && !isText(step.message, 100_000))
        ) {
          return undefined;
        }
        steps.push({
          hash: step.hash,
          action: step.action as RebaseAction,
          ...(typeof step.message === 'string' ? { message: step.message } : {}),
        });
      }
      return { type: 'rebase', steps };
    }
    case 'reword':
      return isHash(value.hash) && isText(value.message, 100_000)
        ? { type: 'reword', hash: value.hash, message: value.message }
        : undefined;
    default:
      return undefined;
  }
}
