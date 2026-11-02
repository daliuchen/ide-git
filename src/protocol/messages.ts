import type {
  ChangedFile,
  CommitDetails,
  CommitSummary,
  EditorHistoryKind,
  HistoryEntry,
  RefLabel,
  RepositorySummary,
  StashEntry,
} from '../shared/models';
import type { GraphContinuationState } from '../graph/layoutCommitGraph';

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_FILTER_TEXT_LENGTH = 2000;
const MAX_FILTER_ITEMS = 100;
const MAX_FILTER_ITEM_LENGTH = 4096;
const MAX_LOG_OFFSET = 10_000_000;
const MAX_UNIX_SECONDS = 253_402_300_799;
const MAX_COMMIT_RANGE = 100;
const MAX_COMMIT_MESSAGE_LENGTH = 100_000;

export interface LogFilters {
  text: string;
  /** When true, branches contains exclusions from all local, remote, and tag refs. */
  allBranches?: boolean;
  branches: string[];
  /**
   * Compare a ref with HEAD: `notInHead` lists commits reachable from `ref` but not from HEAD
   * (`HEAD..ref`), `onlyInHead` the reverse (`ref..HEAD`). Takes precedence over `branches`.
   */
  compare?: LogCompare | undefined;
  authors: string[];
  dateFrom?: number;
  dateTo?: number;
  paths: string[];
}

export interface LogCompare {
  ref: string;
  direction: 'notInHead' | 'onlyInHead';
}

export interface WorkbenchLayout {
  refsWidth: number;
  filesWidth: number;
  detailsHeight: number;
  detailsPlacement?: 'bottom' | 'changes';
  filesViewMode: 'tree' | 'list';
  commitColumnWidth?: number;
  refsColumnWidth?: number;
  authorColumnWidth?: number;
  dateColumnWidth?: number;
  refsCollapsed?: boolean;
  filesCollapsed?: boolean;
  hiddenColumns?: Array<'refs' | 'author' | 'date'>;
}

export interface PersistedWorkbenchState {
  selectedRepositoryId?: string;
  repositories: Record<
    string,
    {
      filters: LogFilters;
      selectedHash?: string;
      scrollTop?: number;
      logOffset?: number;
      graphContinuation?: GraphContinuationState;
    }
  >;
}

export type WebviewToExtensionMessage =
  | { type: 'ready'; requestId: string }
  | { type: 'selectRepository'; requestId: string; repositoryId: string }
  | {
      type: 'selectCommit';
      requestId: string;
      repositoryId: string;
      hash: string;
      hashes?: string[];
    }
  | {
      type: 'requestCommitMessages';
      requestId: string;
      repositoryId: string;
      hashes: string[];
    }
  | {
      type: 'selectParent';
      requestId: string;
      repositoryId: string;
      hash: string;
      parent: string;
    }
  | { type: 'requestLogPage'; requestId: string; repositoryId: string; skip: number }
  | { type: 'requestHistoryPage'; requestId: string; repositoryId: string; skip: number }
  | { type: 'switchHistoryToFile'; requestId: string; repositoryId: string }
  | {
      type: 'openHistoryDiff';
      requestId: string;
      repositoryId: string;
      hash: string;
      parent?: string;
    }
  | { type: 'closeHistory'; requestId: string; repositoryId: string }
  | { type: 'closeFolderHistory'; requestId: string; repositoryId: string }
  | { type: 'requestStashState'; requestId: string; repositoryId: string }
  | { type: 'requestPushHeadTargets'; requestId: string; repositoryId: string }
  | { type: 'openStashComparison'; requestId: string; repositoryId: string; hash: string }
  | { type: 'refresh'; requestId: string; repositoryId?: string }
  | { type: 'showOutput'; requestId: string }
  | { type: 'openSourceControl'; requestId: string }
  | { type: 'copyToClipboard'; requestId: string; text: string }
  | {
      type: 'updateScrollAnchor';
      requestId: string;
      repositoryId: string;
      scrollTop: number;
      logOffset?: number;
      graphContinuation?: GraphContinuationState;
    }
  | { type: 'updateFilters'; requestId: string; repositoryId: string; filters: LogFilters }
  | {
      type: 'openDiff';
      requestId: string;
      repositoryId: string;
      hash: string;
      parent?: string;
      path: string;
      oldPath?: string;
      status: ChangedFile['status'];
      /** Every file of the list in display order, so F7 can continue into the next one. */
      navigation?: DiffNavigationTarget[];
    }
  | {
      type: 'openFile';
      requestId: string;
      repositoryId: string;
      hash: string;
      parent?: string;
      path: string;
      oldPath?: string;
      status: ChangedFile['status'];
      mode: 'revision' | 'current';
    }
  | {
      type: 'openCommitComparison';
      requestId: string;
      repositoryId: string;
      hash: string;
      mode: 'parent' | 'current';
      parent?: string;
    }
  | { type: 'updateLayout'; requestId: string; layout: WorkbenchLayout }
  | { type: 'runOperation'; requestId: string; repositoryId: string; operation: GitOperationRequest }
  | { type: 'workbenchCommand'; requestId: string; repositoryId: string; command: WorkbenchCommand };

export type GitOperationRequest =
  | { kind: 'checkout'; ref: string }
  | { kind: 'checkoutDetached'; ref: string }
  | { kind: 'switchPrevious' }
  | { kind: 'createAndCheckoutBranch'; name: string }
  | { kind: 'createBranch'; name: string; startPoint: string }
  | { kind: 'createTag'; name: string; target: string }
  | { kind: 'deleteTag'; name: string }
  | { kind: 'checkoutRemote'; name: string; startPoint: string }
  | { kind: 'deleteRemoteBranch'; remote: string; branch: string }
  | { kind: 'fetch'; remote?: string }
  | { kind: 'pull' }
  | { kind: 'push'; forceWithLease?: boolean; remote?: string; targetRef?: string }
  | { kind: 'pushHead'; remote: string; branch: string }
  | { kind: 'cherryPick'; hash: string }
  | { kind: 'revert'; hash: string }
  | { kind: 'merge'; ref: string }
  | { kind: 'rebase'; ref: string }
  | { kind: 'rebaseContinue' }
  | { kind: 'rebaseSkip' }
  | { kind: 'rebaseAbort' }
  | { kind: 'reset'; hash: string; mode: 'soft' | 'mixed' | 'hard' }
  | { kind: 'renameBranch'; oldName: string; newName: string }
  | { kind: 'deleteBranch'; name: string; force: boolean }
  | { kind: 'createStash'; message: string; includeUntracked: boolean }
  | { kind: 'applyStash'; stash: string }
  | { kind: 'popStash'; stash: string }
  | { kind: 'dropStash'; stash: string }
  | { kind: 'amendCommit'; message: string }
  | { kind: 'dropCommits'; hashes: string[] }
  | { kind: 'squashCommits'; hashes: string[]; message: string }
  | { kind: 'rewordCommit'; hash: string; message: string }
  | { kind: 'undoCommit'; hash: string }
  | { kind: 'interactiveRebase'; base?: string; steps: RebaseStep[] }
  | { kind: 'checkoutAndRebase'; branch: string }
  | { kind: 'pullFrom'; remote: string; branch: string; rebase: boolean }
  | { kind: 'updateBranch'; remote: string; remoteBranch: string; localBranch: string }
  | { kind: 'updateProject'; rebase: boolean }
  | {
      kind: 'pushTo';
      remote: string;
      /** `HEAD` or a commit hash ("Push All up to Here"). */
      source: string;
      branch: string;
      setUpstream: boolean;
      forceWithLease: boolean;
      pushTags: boolean;
    }
  | { kind: 'applyFileChanges'; hash: string; parent?: string; paths: string[]; reverse: boolean }
  | { kind: 'getFromRevision'; hash: string; paths: string[] }
  | { kind: 'dropFileChanges'; hash: string; paths: string[] };

export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export interface RebaseStep {
  hash: string;
  action: RebaseAction;
  /** Final message for a reword, or for the first commit of a squash group. */
  message?: string;
}

/** Editor-side actions requested from the Git Log that do not change repository state directly. */
export type WorkbenchCommand =
  | { kind: 'compareWithLocal'; hash: string; path?: string; status?: ChangedFile['status'] }
  | { kind: 'jumpToSource'; path: string }
  | { kind: 'showFileHistory'; path: string }
  | { kind: 'createPatch'; hashes: string[]; paths?: string[] }
  | { kind: 'prepareFixup'; hash: string; squash: boolean }
  | { kind: 'openRebaseDialog'; hash: string; mode: 'interactive' | 'reword' }
  | { kind: 'openPushDialog'; source?: string }
  | { kind: 'openCommitPanel' };

export type ErrorRecoveryAction = { kind: 'forceDeleteBranch'; branch: string };

export interface DiffNavigationTarget {
  hash: string;
  parent?: string;
  path: string;
  oldPath?: string;
  status: ChangedFile['status'];
}

export const MAX_DIFF_NAVIGATION_TARGETS = 5_000;

export type ExtensionToWebviewMessage =
  | {
      /** The file shown in the active editor tab, if it belongs to a known repository. */
      type: 'activeEditorFile';
      requestId: string;
      repositoryId?: string;
      path?: string;
    }
  | {
      type: 'initialize';
      requestId: string;
      repositories: RepositorySummary[];
      selectedRepositoryId?: string;
      pageSize: number;
      maxCachedCommits: number;
      layout: WorkbenchLayout;
    }
  | {
      type: 'repositoryData';
      requestId: string;
      repositoryId: string;
      refs: RefLabel[];
      commits: CommitSummary[];
      filters: LogFilters;
      selectedHash?: string;
      selectedHashes?: string[];
      scrollTop?: number;
      startLogOffset?: number;
      graphContinuation?: GraphContinuationState;
      /** Scroll this commit into view once the rows are shown (Show in Git Log). */
      revealHash?: string;
      replace: boolean;
      hasMore: boolean;
    }
  | {
      type: 'repositoriesUpdated';
      requestId: string;
      repositories: RepositorySummary[];
      selectedRepositoryId?: string;
    }
  | {
      type: 'selectionDetailsLoaded';
      requestId: string;
      repositoryId: string;
      details: CommitDetails;
      files: ChangedFile[];
      selectedParent?: string;
    }
  | {
      type: 'commitMessagesLoaded';
      requestId: string;
      repositoryId: string;
      messages: Array<{ hash: string; message: string }>;
    }
  | {
      type: 'historyOpened';
      requestId: string;
      repositoryId: string;
      kind: EditorHistoryKind;
      path: string;
      startLine?: number;
      endLine?: number;
      entries: HistoryEntry[];
      replace: boolean;
      hasMore: boolean;
      notice?: string;
    }
  | { type: 'historyClosed'; requestId: string; repositoryId: string; reason?: string }
  | {
      type: 'folderHistoryOpened';
      requestId: string;
      repository: RepositorySummary;
      repositoryId: string;
      path: string;
    }
  | {
      type: 'folderHistoryClosed';
      requestId: string;
      repositoryId: string;
      selectedRepositoryId?: string;
    }
  | {
      type: 'loading';
      requestId: string;
      repositoryId?: string;
      scope: 'repositories' | 'log' | 'selection' | 'operation';
    }
  | { type: 'operationCompleted'; requestId: string; repositoryId: string; message: string }
  | { type: 'operationCancelled'; requestId: string; repositoryId: string }
  | { type: 'clipboardCopied'; requestId: string }
  | { type: 'pushHeadTargetsLoaded'; requestId: string; repositoryId: string; remotes: string[] }
  | {
      type: 'stashStateLoaded';
      requestId: string;
      repositoryId: string;
      stashes: StashEntry[];
    }
  | {
      type: 'error';
      requestId: string;
      repositoryId?: string;
      message: string;
      detail?: string;
      recovery?: ErrorRecoveryAction;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasBase(value: Record<string, unknown>): value is Record<string, unknown> & {
  type: string;
  requestId: string;
} {
  return (
    typeof value.type === 'string' &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0 &&
    value.requestId.length <= MAX_IDENTIFIER_LENGTH &&
    !/[\0\r\n]/u.test(value.requestId)
  );
}

function hasRepository(value: Record<string, unknown>): value is Record<string, unknown> & {
  repositoryId: string;
} {
  return (
    typeof value.repositoryId === 'string' &&
    value.repositoryId.length > 0 &&
    value.repositoryId.length <= MAX_IDENTIFIER_LENGTH &&
    !/[\0\r\n]/u.test(value.repositoryId)
  );
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{4,64}$/iu.test(value);
}

function isCommitRange(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.length <= MAX_COMMIT_RANGE &&
    value.every(isHash) &&
    new Set(value).size === value.length
  );
}

function isCommitSelection(value: unknown, selectedHash: string): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= MAX_COMMIT_RANGE &&
    value.every(isHash) &&
    new Set(value).size === value.length &&
    value.includes(selectedHash)
  );
}

function isLayout(value: unknown): value is WorkbenchLayout {
  if (!isRecord(value)) return false;
  const inRange = (candidate: unknown, minimum: number, maximum: number): candidate is number =>
    typeof candidate === 'number' &&
    Number.isFinite(candidate) &&
    candidate >= minimum &&
    candidate <= maximum;
  return (
    inRange(value.refsWidth, 120, 2000) &&
    inRange(value.filesWidth, 160, 3000) &&
    inRange(value.detailsHeight, 80, 2000) &&
    (value.detailsPlacement === undefined ||
      value.detailsPlacement === 'bottom' ||
      value.detailsPlacement === 'changes') &&
    (value.filesViewMode === 'tree' || value.filesViewMode === 'list') &&
    (value.commitColumnWidth === undefined || inRange(value.commitColumnWidth, 160, 2000)) &&
    (value.refsColumnWidth === undefined || inRange(value.refsColumnWidth, 40, 2000)) &&
    (value.authorColumnWidth === undefined || inRange(value.authorColumnWidth, 40, 2000)) &&
    (value.dateColumnWidth === undefined || inRange(value.dateColumnWidth, 40, 2000)) &&
    (value.refsCollapsed === undefined || typeof value.refsCollapsed === 'boolean') &&
    (value.filesCollapsed === undefined || typeof value.filesCollapsed === 'boolean') &&
    (value.hiddenColumns === undefined ||
      (Array.isArray(value.hiddenColumns) &&
        value.hiddenColumns.length <= 3 &&
        new Set(value.hiddenColumns).size === value.hiddenColumns.length &&
        value.hiddenColumns.every((column) => ['refs', 'author', 'date'].includes(String(column)))))
  );
}

function isFilters(value: unknown): value is LogFilters {
  if (!isRecord(value)) return false;
  const isFilterText = (item: unknown, maximumLength: number): item is string =>
    typeof item === 'string' &&
    item.length <= maximumLength &&
    !/[\0\r\n]/u.test(item);
  const isFilterArray = (
    candidate: unknown,
    predicate: (item: unknown) => boolean,
  ): candidate is string[] =>
    Array.isArray(candidate) &&
    candidate.length <= MAX_FILTER_ITEMS &&
    candidate.every(predicate);
  const isDate = (candidate: unknown): candidate is number =>
    typeof candidate === 'number' &&
    Number.isSafeInteger(candidate) &&
    candidate >= 0 &&
    candidate <= MAX_UNIX_SECONDS;
  const dateFrom = value.dateFrom;
  const dateTo = value.dateTo;
  return (
    isFilterText(value.text, MAX_FILTER_TEXT_LENGTH) &&
    (value.allBranches === undefined || typeof value.allBranches === 'boolean') &&
    isFilterArray(
      value.branches,
      (item) =>
        isFilterText(item, MAX_FILTER_ITEM_LENGTH) &&
        /^refs\/(heads|remotes|tags)\//u.test(item) &&
        !item.startsWith('-'),
    ) &&
    (value.compare === undefined ||
      (isRecord(value.compare) &&
        isFilterText(value.compare.ref, MAX_FILTER_ITEM_LENGTH) &&
        /^refs\/(heads|remotes|tags)\//u.test(value.compare.ref) &&
        (value.compare.direction === 'notInHead' || value.compare.direction === 'onlyInHead'))) &&
    isFilterArray(value.authors, (item) => isFilterText(item, MAX_FILTER_ITEM_LENGTH)) &&
    isFilterArray(
      value.paths,
      (item) => isFilterText(item, MAX_FILTER_ITEM_LENGTH) && item.length > 0,
    ) &&
    (dateFrom === undefined || isDate(dateFrom)) &&
    (dateTo === undefined || isDate(dateTo)) &&
    (dateFrom === undefined || dateTo === undefined || dateFrom <= dateTo)
  );
}

function isRepositoryPath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_FILTER_ITEM_LENGTH ||
    /[\0\r\n]/u.test(value)
  ) {
    return false;
  }
  const portablePath = value.replace(/\\/gu, '/');
  return (
    !portablePath.startsWith('/') &&
    !/^[a-z]:\//iu.test(portablePath) &&
    !portablePath.split('/').includes('..')
  );
}

function isChangedFileStatus(value: unknown): value is ChangedFile['status'] {
  return typeof value === 'string' && ['A', 'M', 'D', 'R', 'C', 'T', 'U'].includes(value);
}

function parseDiffNavigationTarget(value: Record<string, unknown>): DiffNavigationTarget | undefined {
  if (
    !isHash(value.hash) ||
    !isRepositoryPath(value.path) ||
    !isChangedFileStatus(value.status) ||
    (value.parent !== undefined && !isHash(value.parent)) ||
    (value.oldPath !== undefined && !isRepositoryPath(value.oldPath))
  ) {
    return undefined;
  }
  return {
    hash: value.hash,
    path: value.path,
    status: value.status,
    ...(typeof value.parent === 'string' ? { parent: value.parent } : {}),
    ...(typeof value.oldPath === 'string' ? { oldPath: value.oldPath } : {}),
  };
}

function parseDiffNavigationTargets(value: unknown): DiffNavigationTarget[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_DIFF_NAVIGATION_TARGETS) return undefined;
  const targets: DiffNavigationTarget[] = [];
  for (const item of value) {
    const target = isRecord(item) ? parseDiffNavigationTarget(item) : undefined;
    if (!target) return undefined;
    targets.push(target);
  }
  return targets;
}

function isSafeGitToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_FILTER_ITEM_LENGTH &&
    !value.startsWith('-') &&
    !/[\0\r\n]/u.test(value)
  );
}

function isGitRefName(value: unknown): value is string {
  if (!isSafeGitToken(value) || value === '@' || value.startsWith('/') || value.endsWith('/')) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  if (
    value.endsWith('.') ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    value.includes('[') ||
    /[~^:?*\\]/u.test(value)
  ) {
    return false;
  }
  return value.split('/').every((component) => component && !component.startsWith('.') && !component.endsWith('.lock'));
}

function isGraphContinuation(value: unknown): value is GraphContinuationState {
  if (!isRecord(value) || !Array.isArray(value.lanes) || value.lanes.length > 4096) return false;
  const isCounter = (candidate: unknown): candidate is number =>
    typeof candidate === 'number' &&
    Number.isSafeInteger(candidate) &&
    candidate >= 0 &&
    candidate <= 1_000_000_000;
  if (!isCounter(value.nextLaneId) || !isCounter(value.nextColorIndex)) return false;
  const ids = new Set<number>();
  return value.lanes.every((lane) => {
    if (
      !isRecord(lane) ||
      !isCounter(lane.id) ||
      !isCounter(lane.colorIndex) ||
      !isHash(lane.target) ||
      (lane.collapsed !== undefined && typeof lane.collapsed !== 'boolean') ||
      ids.has(lane.id)
    ) {
      return false;
    }
    ids.add(lane.id);
    return true;
  });
}

function isRemoteBranchName(value: unknown): value is string {
  return (
    isGitRefName(value) &&
    !value.startsWith('refs/') &&
    !value.includes(':') &&
    !value.includes('..') &&
    !value.includes('@{')
  );
}

function isStashRef(value: unknown): value is string {
  return typeof value === 'string' && /^stash@\{\d+\}$/u.test(value);
}

const MAX_REBASE_STEPS = 500;
const REBASE_ACTIONS: readonly RebaseAction[] = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];

function isCommitMessage(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_COMMIT_MESSAGE_LENGTH &&
    !value.includes('\0')
  );
}

function isRebaseStep(value: unknown): value is RebaseStep {
  return (
    isRecord(value) &&
    isHash(value.hash) &&
    REBASE_ACTIONS.includes(value.action as RebaseAction) &&
    (value.message === undefined || isCommitMessage(value.message))
  );
}

function isPathList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 10_000 &&
    value.every(isRepositoryPath)
  );
}

function isWorkbenchCommand(value: unknown): value is WorkbenchCommand {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'compareWithLocal':
      return (
        isHash(value.hash) &&
        (value.path === undefined || isRepositoryPath(value.path)) &&
        (value.status === undefined || isChangedFileStatus(value.status))
      );
    case 'jumpToSource':
    case 'showFileHistory':
      return isRepositoryPath(value.path);
    case 'createPatch':
      return (
        Array.isArray(value.hashes) &&
        value.hashes.length > 0 &&
        value.hashes.length <= MAX_COMMIT_RANGE &&
        value.hashes.every(isHash) &&
        (value.paths === undefined || isPathList(value.paths))
      );
    case 'prepareFixup':
      return isHash(value.hash) && typeof value.squash === 'boolean';
    case 'openRebaseDialog':
      return isHash(value.hash) && (value.mode === 'interactive' || value.mode === 'reword');
    case 'openPushDialog':
      return value.source === undefined || isHash(value.source);
    case 'openCommitPanel':
      return true;
    default:
      return false;
  }
}

function isGitOperationRequest(value: unknown): value is GitOperationRequest {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'checkout':
    case 'checkoutDetached':
      return isSafeGitToken(value.ref);
    case 'switchPrevious':
      return true;
    case 'createAndCheckoutBranch':
      return isGitRefName(value.name);
    case 'createBranch':
      return isGitRefName(value.name) && isSafeGitToken(value.startPoint);
    case 'createTag':
      return isGitRefName(value.name) && isSafeGitToken(value.target);
    case 'deleteTag':
      return isGitRefName(value.name);
    case 'checkoutRemote':
      return isGitRefName(value.name) && isSafeGitToken(value.startPoint);
    case 'deleteRemoteBranch':
      return isSafeGitToken(value.remote) && isRemoteBranchName(value.branch);
    case 'fetch':
      return value.remote === undefined || isSafeGitToken(value.remote);
    case 'pull':
      return true;
    case 'pushHead':
      return isSafeGitToken(value.remote) && isRemoteBranchName(value.branch);
    case 'push':
      return (
        (value.forceWithLease === undefined || typeof value.forceWithLease === 'boolean') &&
        (value.remote === undefined || isSafeGitToken(value.remote)) &&
        (value.targetRef === undefined || isSafeGitToken(value.targetRef))
      );
    case 'cherryPick':
    case 'revert':
      return isHash(value.hash);
    case 'merge':
    case 'rebase':
      return isSafeGitToken(value.ref);
    case 'rebaseContinue':
    case 'rebaseSkip':
    case 'rebaseAbort':
      return true;
    case 'reset':
      return isHash(value.hash) && ['soft', 'mixed', 'hard'].includes(String(value.mode));
    case 'renameBranch':
      return isGitRefName(value.oldName) && isGitRefName(value.newName);
    case 'deleteBranch':
      return isGitRefName(value.name) && typeof value.force === 'boolean';
    case 'createStash':
      return (
        typeof value.message === 'string' &&
        value.message.length <= 10_000 &&
        !value.message.includes('\0') &&
        typeof value.includeUntracked === 'boolean'
      );
    case 'applyStash':
    case 'popStash':
    case 'dropStash':
      return isStashRef(value.stash);
    case 'amendCommit':
      return (
        typeof value.message === 'string' &&
        value.message.trim().length > 0 &&
        value.message.length <= MAX_COMMIT_MESSAGE_LENGTH &&
        !value.message.includes('\0')
      );
    case 'dropCommits':
      return isCommitRange(value.hashes);
    case 'rewordCommit':
      return isHash(value.hash) && isCommitMessage(value.message);
    case 'undoCommit':
      return isHash(value.hash);
    case 'interactiveRebase':
      return (
        (value.base === undefined || isHash(value.base)) &&
        Array.isArray(value.steps) &&
        value.steps.length > 0 &&
        value.steps.length <= MAX_REBASE_STEPS &&
        value.steps.every(isRebaseStep) &&
        new Set(value.steps.map((step) => (step as RebaseStep).hash)).size === value.steps.length
      );
    case 'checkoutAndRebase':
      return isGitRefName(value.branch);
    case 'pullFrom':
      return isSafeGitToken(value.remote) && isRemoteBranchName(value.branch) && typeof value.rebase === 'boolean';
    case 'updateBranch':
      return (
        isSafeGitToken(value.remote) &&
        isRemoteBranchName(value.remoteBranch) &&
        isGitRefName(value.localBranch)
      );
    case 'updateProject':
      return typeof value.rebase === 'boolean';
    case 'pushTo':
      return (
        isSafeGitToken(value.remote) &&
        (value.source === 'HEAD' || isHash(value.source)) &&
        isRemoteBranchName(value.branch) &&
        typeof value.setUpstream === 'boolean' &&
        typeof value.forceWithLease === 'boolean' &&
        typeof value.pushTags === 'boolean'
      );
    case 'applyFileChanges':
      return (
        isHash(value.hash) &&
        (value.parent === undefined || isHash(value.parent)) &&
        isPathList(value.paths) &&
        typeof value.reverse === 'boolean'
      );
    case 'getFromRevision':
    case 'dropFileChanges':
      return isHash(value.hash) && isPathList(value.paths);
    case 'squashCommits':
      return (
        isCommitRange(value.hashes) &&
        typeof value.message === 'string' &&
        value.message.trim().length > 0 &&
        value.message.length <= MAX_COMMIT_MESSAGE_LENGTH &&
        !value.message.includes('\0')
      );
    default:
      return false;
  }
}

export function parseWebviewMessage(value: unknown): WebviewToExtensionMessage | undefined {
  if (!isRecord(value) || !hasBase(value)) return undefined;

  switch (value.type) {
    case 'ready':
      return { type: value.type, requestId: value.requestId };
    case 'selectRepository':
      return hasRepository(value)
        ? { type: value.type, requestId: value.requestId, repositoryId: value.repositoryId }
        : undefined;
    case 'selectCommit':
      return hasRepository(value) &&
        isHash(value.hash) &&
        (value.hashes === undefined || isCommitSelection(value.hashes, value.hash))
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            hash: value.hash,
            ...(Array.isArray(value.hashes) ? { hashes: value.hashes } : {}),
          }
        : undefined;
    case 'requestCommitMessages':
      return hasRepository(value) && isCommitRange(value.hashes)
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            hashes: value.hashes,
          }
        : undefined;
    case 'selectParent':
      return hasRepository(value) && isHash(value.hash) && isHash(value.parent)
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            hash: value.hash,
            parent: value.parent,
          }
        : undefined;
    case 'requestLogPage':
      return hasRepository(value) &&
        Number.isSafeInteger(value.skip) &&
        Number(value.skip) >= 0 &&
        Number(value.skip) <= MAX_LOG_OFFSET
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            skip: Number(value.skip),
          }
        : undefined;
    case 'requestHistoryPage':
      return hasRepository(value) &&
        Number.isSafeInteger(value.skip) &&
        Number(value.skip) >= 0 &&
        Number(value.skip) <= MAX_LOG_OFFSET
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            skip: Number(value.skip),
          }
        : undefined;
    case 'switchHistoryToFile':
      return hasRepository(value)
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
          }
        : undefined;
    case 'openHistoryDiff':
      return hasRepository(value) &&
        isHash(value.hash) &&
        (value.parent === undefined || isHash(value.parent))
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            hash: value.hash,
            ...(typeof value.parent === 'string' ? { parent: value.parent } : {}),
          }
        : undefined;
    case 'closeHistory':
    case 'closeFolderHistory':
      return hasRepository(value)
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
          }
        : undefined;
    case 'requestStashState':
    case 'requestPushHeadTargets':
      return hasRepository(value)
        ? { type: value.type, requestId: value.requestId, repositoryId: value.repositoryId }
        : undefined;
    case 'openStashComparison':
      return hasRepository(value) && isHash(value.hash)
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            hash: value.hash,
          }
        : undefined;
    case 'refresh':
      if (
        value.repositoryId !== undefined &&
        !(
          typeof value.repositoryId === 'string' &&
          value.repositoryId.length > 0 &&
          value.repositoryId.length <= MAX_IDENTIFIER_LENGTH &&
          !/[\0\r\n]/u.test(value.repositoryId)
        )
      ) {
        return undefined;
      }
      return {
        type: value.type,
        requestId: value.requestId,
        ...(typeof value.repositoryId === 'string' ? { repositoryId: value.repositoryId } : {}),
      };
    case 'showOutput':
    case 'openSourceControl':
      return { type: value.type, requestId: value.requestId };
    case 'copyToClipboard':
      return typeof value.text === 'string' && value.text.length <= 100_000
        ? { type: value.type, requestId: value.requestId, text: value.text }
        : undefined;
    case 'updateScrollAnchor':
      return hasRepository(value) &&
        typeof value.scrollTop === 'number' &&
        Number.isFinite(value.scrollTop) &&
        value.scrollTop >= 0 &&
        value.scrollTop <= 1_000_000_000 &&
        (value.logOffset === undefined ||
          (typeof value.logOffset === 'number' &&
            Number.isSafeInteger(value.logOffset) &&
            value.logOffset >= 0 &&
            value.logOffset <= MAX_LOG_OFFSET)) &&
        (value.graphContinuation === undefined || isGraphContinuation(value.graphContinuation))
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            scrollTop: value.scrollTop,
            ...(typeof value.logOffset === 'number' ? { logOffset: value.logOffset } : {}),
            ...(isGraphContinuation(value.graphContinuation)
              ? { graphContinuation: value.graphContinuation }
              : {}),
          }
        : undefined;
    case 'updateFilters':
      return hasRepository(value) && isFilters(value.filters)
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            filters: value.filters,
          }
        : undefined;
    case 'updateLayout':
      return isLayout(value.layout)
        ? { type: value.type, requestId: value.requestId, layout: value.layout }
        : undefined;
    case 'openDiff': {
      const target = parseDiffNavigationTarget(value);
      const navigation =
        value.navigation === undefined ? undefined : parseDiffNavigationTargets(value.navigation);
      if (!hasRepository(value) || !target || (value.navigation !== undefined && !navigation)) {
        return undefined;
      }
      return {
        type: value.type,
        requestId: value.requestId,
        repositoryId: value.repositoryId,
        ...target,
        ...(navigation ? { navigation } : {}),
      };
    }
    case 'openFile':
      if (
        !hasRepository(value) ||
        !isHash(value.hash) ||
        !isRepositoryPath(value.path) ||
        !isChangedFileStatus(value.status) ||
        (value.parent !== undefined && !isHash(value.parent)) ||
        (value.oldPath !== undefined && !isRepositoryPath(value.oldPath)) ||
        (value.mode !== 'revision' && value.mode !== 'current')
      ) {
        return undefined;
      }
      return {
        type: value.type,
        requestId: value.requestId,
        repositoryId: value.repositoryId,
        hash: value.hash,
        path: value.path,
        status: value.status,
        mode: value.mode,
        ...(typeof value.parent === 'string' ? { parent: value.parent } : {}),
        ...(typeof value.oldPath === 'string' ? { oldPath: value.oldPath } : {}),
      };
    case 'openCommitComparison':
      return hasRepository(value) &&
        isHash(value.hash) &&
        (value.mode === 'parent' || value.mode === 'current') &&
        (value.parent === undefined || isHash(value.parent))
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            hash: value.hash,
            mode: value.mode,
            ...(typeof value.parent === 'string' ? { parent: value.parent } : {}),
          }
        : undefined;
    case 'workbenchCommand':
      return hasRepository(value) && isWorkbenchCommand(value.command)
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            command: value.command,
          }
        : undefined;
    case 'runOperation':
      return hasRepository(value) && isGitOperationRequest(value.operation)
        ? {
            type: value.type,
            requestId: value.requestId,
            repositoryId: value.repositoryId,
            operation: value.operation,
          }
        : undefined;
    default:
      return undefined;
  }
}
