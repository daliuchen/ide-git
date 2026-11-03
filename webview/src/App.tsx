import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  layoutCommitGraph,
  type GraphContinuationState,
} from '../../src/graph/layoutCommitGraph';
import {
  MAX_DIFF_NAVIGATION_TARGETS,
  parseWebviewMessage,
  type ErrorRecoveryAction,
  type ExtensionToWebviewMessage,
  type GitOperationRequest,
  type LogCompare,
  type LogFilters,
  type WebviewToExtensionMessage,
  type WorkbenchCommand,
  type WorkbenchLayout,
} from '../../src/protocol/messages';
import type {
  ChangedFile,
  CommitDetails,
  CommitSummary,
  HistoryEntry,
  RefKind,
  RefLabel,
  RepositorySummary,
  StashEntry,
} from '../../src/shared/models';
import { getVsCodeApi } from './vscodeApi';
import { buildFileTree, flattenFileTree, type FileTreeNode } from './buildFileTree';
import { buildRefTree, type RefTreeNode } from './buildRefTree';
import { parseStashSubject } from './stashLabel';
import { advanceCommitWindow } from './commitWindow';
import { CommitList } from './CommitList';
import { formatCommitDate } from './formatCommitDate';

const refGroups: readonly { label: string; kind: RefKind }[] = [
  { label: 'Local', kind: 'local' },
  { label: 'Remote', kind: 'remote' },
  { label: 'Tags', kind: 'tag' },
];

const defaultLayout: WorkbenchLayout = {
  refsWidth: 220,
  filesWidth: 320,
  detailsHeight: 156,
  detailsPlacement: 'bottom',
  filesViewMode: 'tree',
  refsColumnWidth: 150,
  authorColumnWidth: 130,
  dateColumnWidth: 125,
};

const defaultFilters: LogFilters = {
  text: '',
  branches: [],
  authors: [],
  paths: [],
};

/** `a`, `a +2`, or '' — the value shown on a filter button. */
function summarizeFilterValues(values: readonly string[]): string {
  if (!values.length) return '';
  return values.length === 1 ? values[0] ?? '' : `${values[0] ?? ''} +${String(values.length - 1)}`;
}

function describeDateFilter(from?: number, to?: number): string {
  const format = (seconds: number): string => {
    const date = new Date(seconds * 1000);
    return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  if (from !== undefined && to !== undefined) {
    const last = format(to - 1);
    return format(from) === last ? format(from) : `${format(from)} – ${last}`;
  }
  if (from !== undefined) return `since ${format(from)}`;
  if (to !== undefined) return `until ${format(to - 1)}`;
  return '';
}

function filtersEqual(left: LogFilters, right: LogFilters): boolean {
  const sameItems = (leftItems: readonly string[], rightItems: readonly string[]): boolean =>
    leftItems.length === rightItems.length &&
    leftItems.every((item, index) => item === rightItems[index]);
  return (
    left.text === right.text &&
    left.dateFrom === right.dateFrom &&
    left.dateTo === right.dateTo &&
    Boolean(left.allBranches) === Boolean(right.allBranches) &&
    left.compare?.ref === right.compare?.ref &&
    left.compare?.direction === right.compare?.direction &&
    sameItems(left.branches, right.branches) &&
    sameItems(left.authors, right.authors) &&
    sameItems(left.paths, right.paths)
  );
}

function operationStateLabel(state: NonNullable<RepositorySummary['operationState']>): string {
  return { rebase: 'Rebasing', 'cherry-pick': 'Cherry-picking', revert: 'Reverting', merge: 'Merging' }[state];
}

/** States that stop between commits and can be continued, skipped, or aborted from the Log. */
function isSequencerState(state: RepositorySummary['operationState']): boolean {
  return state === 'rebase' || state === 'cherry-pick' || state === 'revert';
}

interface WorkbenchState {
  repositories: RepositorySummary[];
  selectedRepositoryId: string | undefined;
  refs: RefLabel[];
  commits: CommitSummary[];
  commitListRevision: number;
  selectedHash: string | undefined;
  details: CommitDetails | undefined;
  detailsRepositoryId: string | undefined;
  selectedParent: string | undefined;
  files: ChangedFile[];
  selectedFile: ChangedFile | undefined;
  hasMore: boolean;
  pageSize: number;
  maxCachedCommits: number;
  nextLogOffset: number;
  startLogOffset: number;
  startRowOffset: number;
  graphContinuation: GraphContinuationState | undefined;
  windowAnchorReady: boolean;
  operationRepositoryIds: ReadonlySet<string>;
  layout: WorkbenchLayout;
  filters: LogFilters;
  loading: Extract<ExtensionToWebviewMessage, { type: 'loading' }>['scope'] | undefined;
  error: string | undefined;
  errorRecovery: { repositoryId: string; action: ErrorRecoveryAction } | undefined;
  history:
    | {
        repositoryId: string;
        kind: 'line' | 'file';
        path: string;
        startLine?: number;
        endLine?: number;
        entries: HistoryEntry[];
        hasMore: boolean;
        notice?: string;
      }
    | undefined;
  folderHistory:
    | {
        repositoryId: string;
        path: string;
      }
    | undefined;
}

type WorkbenchRequestScope = 'repositories' | 'log' | 'selection' | 'operation' | 'pushHeadTargets';

function requestScopeForMessage(message: WebviewToExtensionMessage): WorkbenchRequestScope | undefined {
  switch (message.type) {
    case 'ready':
      return 'repositories';
    case 'selectRepository':
    case 'requestLogPage':
    case 'refresh':
    case 'updateFilters':
      return 'log';
    case 'selectCommit':
    case 'selectParent':
      return 'selection';
    case 'runOperation':
      return 'operation';
    case 'requestPushHeadTargets':
      return 'pushHeadTargets';
    default:
      return undefined;
  }
}

const initialState: WorkbenchState = {
  repositories: [],
  selectedRepositoryId: undefined,
  refs: [],
  commits: [],
  commitListRevision: 0,
  selectedHash: undefined,
  details: undefined,
  detailsRepositoryId: undefined,
  selectedParent: undefined,
  files: [],
  selectedFile: undefined,
  hasMore: false,
  pageSize: 500,
  maxCachedCommits: 5000,
  nextLogOffset: 0,
  startLogOffset: 0,
  startRowOffset: 0,
  graphContinuation: undefined,
  windowAnchorReady: false,
  operationRepositoryIds: new Set(),
  layout: defaultLayout,
  filters: defaultFilters,
  loading: undefined,
  error: undefined,
  errorRecovery: undefined,
  history: undefined,
  folderHistory: undefined,
};

function requestId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function contextMenuPosition(x: number, y: number): CSSProperties {
  const margin = 4;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const horizontal =
    x > viewportWidth / 2
      ? { right: Math.max(margin, viewportWidth - x) }
      : { left: Math.max(margin, x) };
  const vertical =
    y > viewportHeight / 2
      ? { bottom: Math.max(margin, viewportHeight - y) }
      : { top: Math.max(margin, y) };
  return { ...horizontal, ...vertical };
}

function changedFileStatusLabel(status: ChangedFile['status']): string {
  return (
    {
      A: 'Added',
      M: 'Modified',
      D: 'Deleted',
      R: 'Renamed',
      C: 'Copied',
      T: 'Type changed',
      U: 'Unmerged',
    } as const
  )[status];
}

function readScrollTopByRepository(value: unknown): Record<string, number> {
  if (
    value &&
    typeof value === 'object' &&
    'scrollTopByRepository' in value &&
    typeof value.scrollTopByRepository === 'object' &&
    value.scrollTopByRepository !== null
  ) {
    return { ...(value.scrollTopByRepository as Record<string, number>) };
  }
  return {};
}

interface FileRowHighlight {
  /** The file shown in the active editor tab. */
  activePath: string | undefined;
  selected: ChangedFile | undefined;
}

function sameChangedFile(left: ChangedFile | undefined, right: ChangedFile): boolean {
  return left?.path === right.path && left.oldPath === right.oldPath;
}

function ChangedFileRow({
  file,
  depth = 0,
  highlight,
  onOpen,
  onSelect,
  onContextMenu,
}: {
  file: ChangedFile;
  depth?: number;
  highlight: FileRowHighlight;
  onOpen(file: ChangedFile): void;
  onSelect(file: ChangedFile): void;
  onContextMenu(file: ChangedFile, x: number, y: number): void;
}) {
  const active = highlight.activePath === file.path;
  const selected = sameChangedFile(highlight.selected, file);
  const rowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const row = rowRef.current;
    if (!active || !row) return;
    for (let parent = row.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
    row.scrollIntoView?.({ block: 'nearest' });
  }, [active]);
  return (
    <button
      ref={rowRef}
      type="button"
      className={`file-row${active ? ' is-active-editor' : ''}${selected ? ' is-selected' : ''}`}
      {...(active ? { 'aria-current': 'true' as const } : {})}
      style={{ paddingLeft: 10 + depth * 14 }}
      title={file.binary ? `${file.path} is binary` : file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      onClick={() => onSelect(file)}
      onDoubleClick={() => onOpen(file)}
      onContextMenu={(event) => {
        event.preventDefault();
        onSelect(file);
        onContextMenu(file, event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen(file);
      }}
    >
      <span className={`file-status status-${file.status}`}>{file.status}</span>
      <span className="file-path">{file.path.split('/').at(-1)}</span>
      {file.additions !== undefined || file.deletions !== undefined ? (
        <span className="file-stats">
          {file.additions !== undefined ? (
            <span className="file-stat-additions">+{String(file.additions)}</span>
          ) : null}
          {file.deletions !== undefined ? (
            <span className="file-stat-deletions">−{String(file.deletions)}</span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

function FileTreeNodes({
  nodes,
  depth,
  highlight,
  onOpen,
  onSelect,
  onContextMenu,
}: {
  nodes: FileTreeNode[];
  depth: number;
  highlight: FileRowHighlight;
  onOpen(file: ChangedFile): void;
  onSelect(file: ChangedFile): void;
  onContextMenu(file: ChangedFile, x: number, y: number): void;
}) {
  return nodes.map((node) =>
    node.type === 'directory' ? (
      <details className="file-directory" open key={node.path}>
        <summary style={{ paddingLeft: 8 + depth * 14 }}>{node.name}</summary>
        <FileTreeNodes
          nodes={node.children}
          depth={depth + 1}
          highlight={highlight}
          onOpen={onOpen}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
        />
      </details>
    ) : (
      <ChangedFileRow
        file={node.file}
        depth={depth}
        highlight={highlight}
        onOpen={onOpen}
        onSelect={onSelect}
        onContextMenu={onContextMenu}
        key={node.path}
      />
    ),
  );
}

function RefTreeNodes({
  nodes,
  depth,
  group,
  folderKeyPrefix,
  collapsedFolders,
  forceExpanded,
  onToggleFolder,
  onSelect,
  onKeyDown,
  onContextMenu,
}: {
  nodes: RefTreeNode[];
  depth: number;
  group: (typeof refGroups)[number];
  folderKeyPrefix: string;
  collapsedFolders: ReadonlySet<string>;
  forceExpanded: boolean;
  onToggleFolder(key: string): void;
  onSelect(ref: RefLabel): void;
  onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, ref: RefLabel): void;
  onContextMenu(ref: RefLabel, x: number, y: number): void;
}) {
  return nodes.map((node) => {
    if (node.type === 'directory') {
      const folderKey = `${folderKeyPrefix}:${node.id}`;
      const collapsed = !forceExpanded && collapsedFolders.has(folderKey);
      return (
        <div
          className="ref-tree-directory"
          role="group"
          aria-label={
            group.kind === 'remote' && depth === 0
              ? `Remote ${node.name}`
              : `${group.label} folder ${node.path}`
          }
          key={node.id}
        >
          <button
            type="button"
            className="ref-folder-row"
            style={{ paddingLeft: 25 + depth * 14 }}
            aria-expanded={!collapsed}
            aria-label={
              forceExpanded
                ? `${group.label} folder ${node.path} (expanded while filtering)`
                : `${collapsed ? 'Expand' : 'Collapse'} ${group.label} folder ${node.path}`
            }
            disabled={forceExpanded}
            onClick={() => onToggleFolder(folderKey)}
          >
            <span className="ref-folder-chevron" aria-hidden="true">
              {collapsed ? '›' : '⌄'}
            </span>
            <span className="ref-folder-icon" aria-hidden="true" />
            <span className="ref-name">{node.name}</span>
          </button>
          {!collapsed ? (
            <RefTreeNodes
              nodes={node.children}
              depth={depth + 1}
              group={group}
              folderKeyPrefix={folderKeyPrefix}
              collapsedFolders={collapsedFolders}
              forceExpanded={forceExpanded}
              onToggleFolder={onToggleFolder}
              onSelect={onSelect}
              onKeyDown={onKeyDown}
              onContextMenu={onContextMenu}
            />
          ) : null}
        </div>
      );
    }

    const ref = node.ref;
    return (
      <button
        type="button"
        className={`ref-item${ref.isCurrent ? ' current-ref' : ''}`}
        style={{ paddingLeft: 25 + depth * 14 }}
        key={ref.fullName}
        title={ref.fullName}
        data-ref-item="true"
        onClick={() => onSelect(ref)}
        onKeyDown={(event) => onKeyDown(event, ref)}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu(ref, event.clientX, event.clientY);
        }}
      >
        <span className="ref-folder-chevron" aria-hidden="true" />
        <span className="ref-icon" aria-hidden="true">
          {ref.kind === 'tag' ? '◆' : '⌁'}
        </span>
        <span className="ref-name">{node.name}</span>
        {ref.ahead || ref.behind ? (
          <span className="tracking">
            {ref.ahead ? `↑${String(ref.ahead)}` : ''}
            {ref.behind ? ` ↓${String(ref.behind)}` : ''}
          </span>
        ) : null}
      </button>
    );
  });
}

export function App() {
  const vscode = useMemo(() => getVsCodeApi(), []);
  const [state, setState] = useState<WorkbenchState>(initialState);
  const [selectedCommitHashes, setSelectedCommitHashes] = useState<string[]>([]);
  const [refSearch, setRefSearch] = useState('');
  const [scrollTopByRepository, setScrollTopByRepository] = useState<Record<string, number>>(() =>
    readScrollTopByRepository(vscode.getState()),
  );
  const [filterPopup, setFilterPopup] = useState<'branch' | 'user' | 'date' | 'paths' | undefined>();
  const [filterSearch, setFilterSearch] = useState('');
  const [filterPopoverPosition, setFilterPopoverPosition] = useState<CSSProperties | undefined>();
  const [contextMenu, setContextMenu] = useState<
    | {
        kind: 'commit';
        repositoryId: string;
        commit: CommitSummary;
        commits: CommitSummary[];
        x: number;
        y: number;
      }
    | { kind: 'ref'; repositoryId: string; ref: RefLabel; x: number; y: number }
    | { kind: 'file'; repositoryId: string; file: ChangedFile; x: number; y: number }
    | { kind: 'head'; repositoryId: string; hash: string; x: number; y: number }
    | undefined
  >();
  const [measuredContextMenuPosition, setMeasuredContextMenuPosition] = useState<
    CSSProperties | undefined
  >();
  const [squashOperation, setSquashOperation] = useState<
    | {
        repositoryId: string;
        hashes: string[];
        requestId: string;
        message: string;
        loading: boolean;
      }
    | undefined
  >();
  const [namedOperation, setNamedOperation] = useState<
    | { kind: 'createBranch'; repositoryId: string; target: string; value: string }
    | { kind: 'createTag'; repositoryId: string; target: string; value: string }
    | { kind: 'renameBranch'; repositoryId: string; oldName: string; value: string }
    | { kind: 'checkoutRemote'; repositoryId: string; startPoint: string; value: string }
    | { kind: 'createAndCheckoutBranch'; repositoryId: string; value: string }
    | undefined
  >();
  const [pushHeadDialog, setPushHeadDialog] = useState<{
    repositoryId: string;
    requestId: string;
    remotes: string[];
    remote: string;
    branch: string;
    loading: boolean;
    error?: string;
  }>();
  const [historyParentPicker, setHistoryParentPicker] = useState<
    { repositoryId: string; commit: CommitSummary } | undefined
  >();
  const [stashDialog, setStashDialog] = useState<
    | {
        repositoryId: string;
        stashes: StashEntry[];
        loading: boolean;
        stashMessage: string;
        includeUntracked: boolean;
      }
    | undefined
  >();
  const [amendDialog, setAmendDialog] = useState<
    { repositoryId: string; message: string } | undefined
  >();
  const [customDateFrom, setCustomDateFrom] = useState('');
  const [customDateTo, setCustomDateTo] = useState('');
  const [detailsHashCopyState, setDetailsHashCopyState] = useState<
    'idle' | 'copying' | 'copied'
  >('idle');
  const [commitRevealTarget, setCommitRevealTarget] = useState<
    { repositoryId: string; hash: string; requestId: number } | undefined
  >();
  const commitRevealSequence = useRef(0);
  const [collapsedRefGroups, setCollapsedRefGroups] = useState<Set<string>>(new Set());
  const [collapsedRefFolders, setCollapsedRefFolders] = useState<Set<string>>(new Set());
  const filterTimer = useRef<number | undefined>(undefined);
  const detailsHashCopyRequest = useRef<string | undefined>(undefined);
  const detailsHashCopyTimer = useRef<number | undefined>(undefined);
  const pendingFiltersRef = useRef<
    | { repositoryId: string; filters: LogFilters; requestId?: string }
    | undefined
  >(undefined);
  const scrollPersistTimer = useRef<number | undefined>(undefined);
  const scrollTopByRepositoryRef = useRef(scrollTopByRepository);
  const pendingScrollPosition = useRef<
    { repositoryId: string; scrollTop: number } | undefined
  >(undefined);
  const previousWindowRowOffsetByRepository = useRef<Map<string, number>>(new Map());
  const lastWindowAnchorSignature = useRef<string | undefined>(undefined);
  const historyParentChoices = useRef<Map<string, string>>(new Map());
  const logWindowRef = useRef({
    startLogOffset: state.startLogOffset,
    graphContinuation: state.graphContinuation,
  });
  const searchRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLElement>(null);
  const logHeaderRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const syncLogHeaderScroll = useCallback((scrollLeft: number): void => {
    if (logHeaderRef.current) {
      logHeaderRef.current.style.transform = `translateX(${-scrollLeft}px)`;
    }
  }, []);
  const selectedRepositoryIdRef = useRef<string | undefined>(undefined);
  const latestRepositorySelectionRequest = useRef<string | undefined>(undefined);
  const latestRequestByScope = useRef<Partial<Record<WorkbenchRequestScope, string>>>({});
  const requestScopeById = useRef<Map<string, WorkbenchRequestScope>>(new Map());
  const activeOperationRequestByRepository = useRef<Map<string, string>>(new Map());
  const activeSelectionRequest = useRef<{
    requestId: string;
    repositoryId: string;
    hash: string;
  } | undefined>(undefined);
  const activeCommitMessagesRequest = useRef<string | undefined>(undefined);
  const stashDialogRepository = useRef<string | undefined>(undefined);
  const commitSelectionAnchor = useRef<string | undefined>(undefined);
  const selectedRepository = state.repositories.find(
    (repository) => repository.id === state.selectedRepositoryId,
  );
  const selectedBranchRefs = state.refs.filter((ref) =>
    state.filters.allBranches
      ? !state.filters.branches.includes(ref.fullName)
      : state.filters.branches.includes(ref.fullName),
  );
  const allBranchRefsSelected =
    state.refs.length > 0 && selectedBranchRefs.length === state.refs.length;
  const currentBranchLabel = selectedRepository?.currentBranch ?? 'HEAD';
  const compareRef = state.filters.compare
    ? state.refs.find((ref) => ref.fullName === state.filters.compare?.ref)
    : undefined;
  const compareRefName = compareRef?.shortName ?? state.filters.compare?.ref.replace(/^refs\/(heads|remotes|tags)\//u, '');
  const branchFilterValue = state.filters.compare
    ? state.filters.compare.direction === 'notInHead'
      ? `${currentBranchLabel}..${String(compareRefName)}`
      : `${String(compareRefName)}..${currentBranchLabel}`
    : state.filters.allBranches
      ? allBranchRefsSelected
        ? 'All'
        : `All except ${String(state.refs.length - selectedBranchRefs.length)}`
      : summarizeFilterValues(selectedBranchRefs.map((ref) => ref.shortName));
  const authorFilterValue = summarizeFilterValues(state.filters.authors);
  const dateFilterValue = describeDateFilter(state.filters.dateFrom, state.filters.dateTo);
  const pathFilterValue = summarizeFilterValues(state.filters.paths);
  const branchFilterQuery = filterPopup === 'branch' ? filterSearch.trim().toLocaleLowerCase() : '';
  const branchFilterRefs = branchFilterQuery
    ? state.refs.filter((ref) => ref.shortName.toLocaleLowerCase().includes(branchFilterQuery))
    : state.refs;
  const showBranchCommits = (ref: RefLabel, direction: LogCompare['direction']): void => {
    applyFilters({
      ...state.filters,
      allBranches: false,
      branches: [],
      compare: { ref: ref.fullName, direction },
    });
    setFilterPopup(undefined);
    setContextMenu(undefined);
  };
  const selectOnlyBranch = (ref: RefLabel): void => {
    applyFilters({ ...state.filters, allBranches: false, branches: [ref.fullName], compare: undefined });
    setFilterPopup(undefined);
  };
  const refSearchActive = Boolean(refSearch.trim());
  const visibleRefs = useMemo(() => {
    const query = refSearch.trim().toLocaleLowerCase();
    if (!query) return state.refs;
    return state.refs.filter((ref) =>
      [ref.shortName, ref.fullName, ref.remote]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(query)),
    );
  }, [refSearch, state.refs]);
  const refGroupTrees = useMemo(
    () =>
      refGroups.map((group) => {
        const refs = visibleRefs.filter((ref) => ref.kind === group.kind);
        return { group, refs, tree: buildRefTree(refs) };
      }),
    [visibleRefs],
  );
  const fileTree = useMemo(() => buildFileTree(state.files), [state.files]);
  const [activeEditorFile, setActiveEditorFile] = useState<
    { repositoryId: string; path: string } | undefined
  >();
  const fileRowHighlight = useMemo<FileRowHighlight>(
    () => ({
      activePath:
        activeEditorFile && activeEditorFile.repositoryId === state.detailsRepositoryId
          ? activeEditorFile.path
          : undefined,
      selected: state.selectedFile,
    }),
    [activeEditorFile, state.detailsRepositoryId, state.selectedFile],
  );
  const headMatchesRefSearch = useMemo(() => {
    const query = refSearch.trim().toLocaleLowerCase();
    if (!query) return true;
    return [selectedRepository?.currentBranch, selectedRepository?.head]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase().includes(query));
  }, [refSearch, selectedRepository?.currentBranch, selectedRepository?.head]);
  const authorFilterOptions = useMemo(() => {
    const userName = selectedRepository?.userName?.trim();
    const userEmail = selectedRepository?.userEmail?.trim();
    const configuredName = userName?.toLocaleLowerCase();
    const configuredEmail = userEmail?.toLocaleLowerCase();
    const authors = new Map<string, string>();
    for (const commit of state.commits) {
      const nameKey = commit.authorName.trim().toLocaleLowerCase();
      const isCurrentUser =
        (Boolean(configuredName) && nameKey === configuredName) ||
        (Boolean(configuredEmail) &&
          commit.authorEmail.trim().toLocaleLowerCase() === configuredEmail);
      if (!isCurrentUser && !authors.has(nameKey)) authors.set(nameKey, commit.authorName);
    }
    return [
      ...(userEmail || userName
        ? [
            {
              key: 'current-user',
              label: userName ? `Me (${userName})` : 'Me',
              value: userEmail ?? (userName as string),
            },
          ]
        : []),
      ...[...authors.entries()].map(([key, name]) => ({ key: `author-${key}`, label: name, value: name })),
    ];
  }, [selectedRepository?.userEmail, selectedRepository?.userName, state.commits]);
  const graphLayout = useMemo(() => {
    if (!state.history) return layoutCommitGraph(state.commits, state.graphContinuation);
    const visibleHashes = new Set(state.history.entries.map((entry) => entry.hash));
    return layoutCommitGraph(
      state.history.entries.map((entry) => ({
        hash: entry.hash,
        parents: entry.parents.filter((parent) => visibleHashes.has(parent)),
      })),
    );
  }, [state.commits, state.graphContinuation, state.history]);
  const selectedCommitHashSet = useMemo(
    () => new Set(selectedCommitHashes),
    [selectedCommitHashes],
  );
  const hasContiguousCommitRange =
    contextMenu?.kind === 'commit' &&
    contextMenu.commits.length >= 2 &&
    contextMenu.commits.every((commit, index) => {
      const firstIndex = state.commits.findIndex(
        (candidate) => candidate.hash === contextMenu.commits[0]?.hash,
      );
      return firstIndex >= 0 && state.commits[firstIndex + index]?.hash === commit.hash;
    });
  const selectedOperationInFlight = state.selectedRepositoryId
    ? state.operationRepositoryIds.has(state.selectedRepositoryId)
    : false;
  const pushHeadOperation: GitOperationRequest | undefined = pushHeadDialog
    ? { kind: 'pushHead', remote: pushHeadDialog.remote, branch: pushHeadDialog.branch.trim() }
    : undefined;
  const canPushHead = Boolean(
    pushHeadDialog && !pushHeadDialog.loading && !pushHeadDialog.error &&
    pushHeadDialog.remotes.includes(pushHeadDialog.remote) &&
    pushHeadDialog.repositoryId === state.selectedRepositoryId &&
    selectedRepository?.head && !selectedRepository.isBare && !selectedRepository.operationState &&
    !selectedOperationInFlight && parseWebviewMessage({
      type: 'runOperation', requestId: pushHeadDialog.requestId,
      repositoryId: pushHeadDialog.repositoryId, operation: pushHeadOperation,
    }),
  );
  const detailsPlacement = state.layout.detailsPlacement ?? 'bottom';
  const detailsInChanges = detailsPlacement === 'changes';
  useEffect(() => {
    if (!filterPopup) return;
    const updatePosition = (): void => {
      // Open under the filter button that was clicked, kept inside the viewport.
      const anchor = document
        .querySelector('.filter-chip > button[aria-expanded="true"]')
        ?.getBoundingClientRect();
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      if (!anchor || anchor.width <= 0 || viewportWidth <= 0) return;
      const width = Math.min(360, viewportWidth - 24);
      setFilterPopoverPosition({
        top: Math.max(0, anchor.bottom + 4),
        left: Math.max(8, Math.min(anchor.left, viewportWidth - width - 8)),
        right: 'auto',
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, [filterPopup, state.layout.filesWidth, state.layout.refsWidth]);
  useLayoutEffect(() => {
    const menu = contextMenuRef.current;
    if (!contextMenu || !menu) return;
    const updatePosition = (): void => {
      const bounds = menu.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const margin = 4;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const preferredLeft =
        contextMenu.x > viewportWidth / 2 ? contextMenu.x - bounds.width : contextMenu.x;
      const preferredTop =
        contextMenu.y > viewportHeight / 2 ? contextMenu.y - bounds.height : contextMenu.y;
      const left = Math.min(
        Math.max(margin, preferredLeft),
        Math.max(margin, viewportWidth - bounds.width - margin),
      );
      const top = Math.min(
        Math.max(margin, preferredTop),
        Math.max(margin, viewportHeight - bounds.height - margin),
      );
      setMeasuredContextMenuPosition({ left, top });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    if (typeof ResizeObserver === 'undefined') {
      return () => window.removeEventListener('resize', updatePosition);
    }
    const observer = new ResizeObserver(updatePosition);
    observer.observe(menu);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePosition);
    };
  }, [contextMenu]);
  useEffect(() => {
    const dismissOpenMenus = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest('.context-menu') ||
        target.closest('.filter-popover') ||
        target.closest('[data-popup-trigger="true"]')
      ) {
        return;
      }
      setContextMenu(undefined);
      setFilterPopup(undefined);
    };
    window.addEventListener('pointerdown', dismissOpenMenus);
    return () => window.removeEventListener('pointerdown', dismissOpenMenus);
  }, []);

  useEffect(() => {
    const pending = pendingScrollPosition.current;
    scrollTopByRepositoryRef.current = {
      ...scrollTopByRepository,
      ...(pending ? { [pending.repositoryId]: pending.scrollTop } : {}),
    };
  }, [scrollTopByRepository]);

  useEffect(() => {
    logWindowRef.current = {
      startLogOffset: state.startLogOffset,
      graphContinuation: state.graphContinuation,
    };
  }, [state.graphContinuation, state.startLogOffset]);

  useEffect(() => {
    if (!state.error) return;
    const error = state.error;
    const recovery = state.errorRecovery;
    const timer = window.setTimeout(() => {
      setState((current) =>
        current.error === error && current.errorRecovery === recovery
          ? { ...current, error: undefined, errorRecovery: undefined }
          : current,
      );
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [state.error, state.errorRecovery]);

  useEffect(() => {
    const repositoryId = state.selectedRepositoryId;
    if (!repositoryId || !state.windowAnchorReady) return;
    const signature = `${repositoryId}:${String(state.startLogOffset)}:${String(
      state.startRowOffset,
    )}:${JSON.stringify(state.graphContinuation ?? null)}`;
    if (lastWindowAnchorSignature.current === signature) return;
    lastWindowAnchorSignature.current = signature;
    if (scrollPersistTimer.current !== undefined) {
      window.clearTimeout(scrollPersistTimer.current);
      scrollPersistTimer.current = undefined;
    }
    const previousRowOffset = previousWindowRowOffsetByRepository.current.get(repositoryId);
    previousWindowRowOffsetByRepository.current.set(repositoryId, state.startRowOffset);
    let scrollTop = scrollTopByRepositoryRef.current[repositoryId] ?? 0;
    if (previousRowOffset !== undefined && state.startRowOffset > previousRowOffset) {
      scrollTop = Math.max(0, scrollTop - (state.startRowOffset - previousRowOffset) * 28);
      setScrollTopByRepository((current) => {
        const next = { ...current, [repositoryId]: scrollTop };
        scrollTopByRepositoryRef.current = next;
        pendingScrollPosition.current = undefined;
        vscode.setState({ scrollTopByRepository: next });
        return next;
      });
    }
    vscode.postMessage({
      type: 'updateScrollAnchor',
      requestId: requestId('window-anchor'),
      repositoryId,
      scrollTop,
      logOffset: state.startLogOffset,
      ...(state.graphContinuation ? { graphContinuation: state.graphContinuation } : {}),
    });
  }, [
    state.graphContinuation,
    state.selectedRepositoryId,
    state.startLogOffset,
    state.startRowOffset,
    state.windowAnchorReady,
    vscode,
  ]);

  useEffect(() => {
    const listener = (event: MessageEvent<ExtensionToWebviewMessage>): void => {
      const message = event.data;
      if (!message || typeof message !== 'object' || !('type' in message)) return;

      switch (message.type) {
        case 'activeEditorFile': {
          const { repositoryId, path } = message;
          setActiveEditorFile(repositoryId && path ? { repositoryId, path } : undefined);
          // Selection follows the editor, so stepping through files with F7 moves it along.
          setState((current) => {
            if (!repositoryId || repositoryId !== current.detailsRepositoryId) return current;
            const file = current.files.find((candidate) => candidate.path === path);
            return file && file !== current.selectedFile ? { ...current, selectedFile: file } : current;
          });
          break;
        }
        case 'initialize':
          if (
            requestScopeById.current.get(message.requestId) === 'repositories' &&
            latestRequestByScope.current.repositories !== message.requestId
          ) {
            requestScopeById.current.delete(message.requestId);
            break;
          }
          requestScopeById.current.delete(message.requestId);
          activeSelectionRequest.current = undefined;
          activeCommitMessagesRequest.current = undefined;
          commitSelectionAnchor.current = undefined;
          setSelectedCommitHashes([]);
          setSquashOperation(undefined);
          setStashDialog(undefined);
          setAmendDialog(undefined);
          setPushHeadDialog(undefined);
          stashDialogRepository.current = undefined;
          pendingFiltersRef.current = undefined;
          lastWindowAnchorSignature.current = undefined;
          selectedRepositoryIdRef.current = message.selectedRepositoryId;
          setState((current) => ({
            ...current,
            repositories: message.repositories,
            selectedRepositoryId: message.selectedRepositoryId,
            pageSize: message.pageSize,
            maxCachedCommits: message.maxCachedCommits ?? 5000,
            nextLogOffset: 0,
            startLogOffset: 0,
            startRowOffset: 0,
            graphContinuation: undefined,
            windowAnchorReady: false,
            operationRepositoryIds: new Set(activeOperationRequestByRepository.current.keys()),
            layout: message.layout,
            filters: defaultFilters,
            refs: [],
            commits: [],
            commitListRevision: current.commitListRevision + 1,
            details: undefined,
            detailsRepositoryId: undefined,
            selectedParent: undefined,
            files: [],
            selectedFile: undefined,
            error: undefined,
            errorRecovery: undefined,
            folderHistory: undefined,
          }));
          break;
        case 'commitMessagesLoaded':
          if (activeCommitMessagesRequest.current !== message.requestId) break;
          activeCommitMessagesRequest.current = undefined;
          setSquashOperation((current) =>
            current &&
            current.requestId === message.requestId &&
            current.repositoryId === message.repositoryId
              ? {
                  ...current,
                  loading: false,
                  message: message.messages
                    .map((entry) => entry.message.replace(/\r?\n$/u, ''))
                    .join('\n\n'),
                }
              : current,
          );
          break;
        case 'pushHeadTargetsLoaded':
          requestScopeById.current.delete(message.requestId);
          setPushHeadDialog((current) =>
            current && current.requestId === message.requestId &&
            current.repositoryId === message.repositoryId &&
            selectedRepositoryIdRef.current === message.repositoryId
              ? {
                  ...current, loading: false, remotes: message.remotes,
                  remote: message.remotes.includes('origin') ? 'origin' : (message.remotes[0] ?? ''),
                }
              : current,
          );
          break;
        case 'stashStateLoaded':
          setStashDialog((current) =>
            current && current.repositoryId === message.repositoryId
              ? { ...current, stashes: message.stashes, loading: false }
              : current,
          );
          break;
        case 'repositoryData': {
          if (selectedRepositoryIdRef.current !== message.repositoryId) {
            requestScopeById.current.delete(message.requestId);
            break;
          }
          if (message.revealHash) {
            commitRevealSequence.current += 1;
            setCommitRevealTarget({
              repositoryId: message.repositoryId,
              hash: message.revealHash,
              requestId: commitRevealSequence.current,
            });
          }
          if (
            requestScopeById.current.get(message.requestId) === 'log' &&
            latestRequestByScope.current.log !== message.requestId
          ) {
            requestScopeById.current.delete(message.requestId);
            break;
          }
          requestScopeById.current.delete(message.requestId);
          const pendingFilters = pendingFiltersRef.current;
          const resolvesPendingFilters =
            pendingFilters?.repositoryId === message.repositoryId &&
            (pendingFilters.requestId === message.requestId ||
              filtersEqual(pendingFilters.filters, message.filters));
          const preservesPendingFilters =
            pendingFilters?.repositoryId === message.repositoryId && !resolvesPendingFilters;
          if (resolvesPendingFilters) pendingFiltersRef.current = undefined;
          if (message.replace && message.scrollTop !== undefined) {
            setScrollTopByRepository((current) => {
              const next = { ...current, [message.repositoryId]: message.scrollTop ?? 0 };
              scrollTopByRepositoryRef.current = next;
              if (pendingScrollPosition.current?.repositoryId === message.repositoryId) {
                pendingScrollPosition.current = undefined;
              }
              vscode.setState({ scrollTopByRepository: next });
              return next;
            });
          }
          if (message.selectedHash) {
            const selectedHash = message.selectedHash;
            activeSelectionRequest.current = {
              requestId: message.requestId,
              repositoryId: message.repositoryId,
              hash: selectedHash,
            };
            if (message.selectedHashes) {
              commitSelectionAnchor.current = selectedHash;
              setSelectedCommitHashes(message.selectedHashes);
            } else {
              setSelectedCommitHashes((current) => {
                const selectedIndexes = current.map((hash) =>
                  message.commits.findIndex((commit) => commit.hash === hash),
                );
                const keepsSelection =
                  current.length > 1 &&
                  current.includes(selectedHash) &&
                  selectedIndexes.every((index) => index >= 0);
                if (keepsSelection) return current;
                commitSelectionAnchor.current = selectedHash;
                return [selectedHash];
              });
            }
          }
          setState((current) => {
            if (current.selectedRepositoryId !== message.repositoryId) return current;
            const commitWindow = advanceCommitWindow(
              {
                commits: current.commits,
                graphContinuation: current.graphContinuation,
                nextLogOffset: current.nextLogOffset,
                startLogOffset: current.startLogOffset,
                startRowOffset: current.startRowOffset,
              },
              message.commits,
              current.maxCachedCommits,
              message.replace,
              message.startLogOffset ?? (message.replace ? 0 : current.nextLogOffset),
              message.graphContinuation,
            );
            const keepsSelection =
              message.selectedHash !== undefined ||
              !message.replace ||
              (current.selectedHash !== undefined &&
                commitWindow.commits.some((commit) => commit.hash === current.selectedHash));
            return {
              ...current,
              selectedRepositoryId: message.repositoryId,
              refs: message.refs,
              filters: preservesPendingFilters ? current.filters : message.filters,
              commits: commitWindow.commits,
              commitListRevision: message.replace
                ? current.commitListRevision + 1
                : current.commitListRevision,
              nextLogOffset: commitWindow.nextLogOffset,
              startLogOffset: commitWindow.startLogOffset,
              startRowOffset: commitWindow.startRowOffset,
              graphContinuation: commitWindow.graphContinuation,
              windowAnchorReady: true,
              ...(message.selectedHash ? { selectedHash: message.selectedHash } : {}),
              hasMore: message.hasMore,
              loading: undefined,
              error: undefined,
              errorRecovery: undefined,
              ...(message.replace && !keepsSelection
                ? {
                    selectedHash: undefined,
                    details: undefined,
                    detailsRepositoryId: undefined,
                    selectedParent: undefined,
                    files: [],
                    selectedFile: undefined,
                  }
                : {}),
            };
          });
          break;
        }
        case 'repositoriesUpdated':
          if (
            message.selectedRepositoryId &&
            message.selectedRepositoryId !== selectedRepositoryIdRef.current &&
            latestRepositorySelectionRequest.current !== message.requestId
          ) {
            break;
          }
          if (message.selectedRepositoryId && message.selectedRepositoryId !== selectedRepositoryIdRef.current) {
            setPushHeadDialog(undefined);
          }
          setState((current) => {
            const selectedRepositoryId = message.selectedRepositoryId ?? current.selectedRepositoryId;
            selectedRepositoryIdRef.current = selectedRepositoryId;
            if (selectedRepositoryId !== current.selectedRepositoryId) {
              activeSelectionRequest.current = undefined;
              lastWindowAnchorSignature.current = undefined;
              return {
                ...current,
                repositories: message.repositories,
                selectedRepositoryId,
                refs: [],
                commits: [],
                commitListRevision: current.commitListRevision + 1,
                nextLogOffset: 0,
                startLogOffset: 0,
                startRowOffset: 0,
                graphContinuation: undefined,
                windowAnchorReady: false,
                selectedHash: undefined,
                details: undefined,
                detailsRepositoryId: undefined,
                selectedParent: undefined,
                files: [],
                selectedFile: undefined,
              };
            }
            return { ...current, repositories: message.repositories };
          });
          break;
        case 'selectionDetailsLoaded':
          requestScopeById.current.delete(message.requestId);
          setState((current) => {
            const activeRequest = activeSelectionRequest.current;
            if (
              !activeRequest ||
              activeRequest.requestId !== message.requestId ||
              activeRequest.repositoryId !== message.repositoryId ||
              activeRequest.hash !== message.details.hash ||
              current.selectedRepositoryId !== message.repositoryId ||
              current.selectedHash !== message.details.hash
            ) {
              return current;
            }
            return {
              ...current,
              details: message.details,
              detailsRepositoryId: message.repositoryId,
              selectedParent: message.selectedParent ?? message.details.parents[0],
              files: message.files,
              selectedFile: undefined,
              loading: undefined,
              error: undefined,
              errorRecovery: undefined,
            };
          });
          break;
        case 'historyOpened':
          if (message.replace) historyParentChoices.current.clear();
          setHistoryParentPicker(undefined);
          setState((current) => ({
            ...current,
            history: {
              repositoryId: message.repositoryId,
              kind: message.kind,
              path: message.path,
              ...(message.startLine !== undefined ? { startLine: message.startLine } : {}),
              ...(message.endLine !== undefined ? { endLine: message.endLine } : {}),
              entries: message.replace
                ? message.entries
                : [...(current.history?.entries ?? []), ...message.entries],
              hasMore: message.hasMore,
              ...(message.notice ? { notice: message.notice } : {}),
            },
            loading: undefined,
            error: undefined,
            errorRecovery: undefined,
          }));
          break;
        case 'historyClosed':
          historyParentChoices.current.clear();
          setHistoryParentPicker(undefined);
          setState((current) =>
            current.history?.repositoryId === message.repositoryId
              ? {
                  ...current,
                  history: undefined,
                  ...(message.reason
                    ? { error: message.reason, errorRecovery: undefined }
                    : {}),
                }
              : current,
          );
          break;
        case 'folderHistoryOpened':
          selectedRepositoryIdRef.current = message.repositoryId;
          historyParentChoices.current.clear();
          setHistoryParentPicker(undefined);
          setState((current) => {
            const repositories = current.repositories.some(
              (repository) => repository.id === message.repository.id,
            )
              ? current.repositories.map((repository) =>
                  repository.id === message.repository.id ? message.repository : repository,
                )
              : [...current.repositories, message.repository];
            return {
              ...current,
              repositories,
              selectedRepositoryId: message.repositoryId,
              refs: [],
              commits: [],
              commitListRevision: current.commitListRevision + 1,
              selectedHash: undefined,
              details: undefined,
              detailsRepositoryId: undefined,
              selectedParent: undefined,
              files: [],
              selectedFile: undefined,
              history: undefined,
              folderHistory: {
                repositoryId: message.repositoryId,
                path: message.path,
              },
              error: undefined,
              errorRecovery: undefined,
            };
          });
          break;
        case 'folderHistoryClosed':
          if (message.selectedRepositoryId) {
            selectedRepositoryIdRef.current = message.selectedRepositoryId;
          }
          activeSelectionRequest.current = undefined;
          commitSelectionAnchor.current = undefined;
          setSelectedCommitHashes([]);
          setState((current) =>
            current.folderHistory?.repositoryId === message.repositoryId
              ? {
                  ...current,
                  folderHistory: undefined,
                  selectedHash: undefined,
                  details: undefined,
                  detailsRepositoryId: undefined,
                  selectedParent: undefined,
                  files: [],
                  selectedFile: undefined,
                  ...(message.selectedRepositoryId &&
                  message.selectedRepositoryId !== current.selectedRepositoryId
                    ? {
                        selectedRepositoryId: message.selectedRepositoryId,
                        refs: [],
                        commits: [],
                        commitListRevision: current.commitListRevision + 1,
                      }
                    : {}),
                }
              : current,
          );
          break;
        case 'loading':
          if (message.scope === 'operation' && message.repositoryId) {
            const repositoryId = message.repositoryId;
            const activeRequest = activeOperationRequestByRepository.current.get(repositoryId);
            if (activeRequest && activeRequest !== message.requestId) break;
            activeOperationRequestByRepository.current.set(repositoryId, message.requestId);
            setState((current) => ({
              ...current,
              operationRepositoryIds: new Set(current.operationRepositoryIds).add(repositoryId),
              error: undefined,
              errorRecovery: undefined,
            }));
            break;
          }
          if (
            requestScopeById.current.get(message.requestId) === message.scope &&
            latestRequestByScope.current[message.scope] !== message.requestId
          ) {
            break;
          }
          latestRequestByScope.current[message.scope] = message.requestId;
          setState((current) => {
            if (message.repositoryId && current.selectedRepositoryId !== message.repositoryId) {
              return current;
            }
            return {
              ...current,
              loading: message.scope,
              error: undefined,
              errorRecovery: undefined,
            };
          });
          break;
        case 'clipboardCopied':
          if (detailsHashCopyRequest.current !== message.requestId) break;
          detailsHashCopyRequest.current = undefined;
          setDetailsHashCopyState('copied');
          if (detailsHashCopyTimer.current !== undefined) {
            window.clearTimeout(detailsHashCopyTimer.current);
          }
          detailsHashCopyTimer.current = window.setTimeout(() => {
            detailsHashCopyTimer.current = undefined;
            setDetailsHashCopyState('idle');
          }, 1_500);
          break;
        case 'error':
          {
            if (detailsHashCopyRequest.current === message.requestId) {
              detailsHashCopyRequest.current = undefined;
              setDetailsHashCopyState('idle');
            }
            if (activeCommitMessagesRequest.current === message.requestId) {
              activeCommitMessagesRequest.current = undefined;
              setSquashOperation(undefined);
            }
            if (pendingFiltersRef.current?.requestId === message.requestId) {
              pendingFiltersRef.current = undefined;
            }
            const scope = requestScopeById.current.get(message.requestId);
            if (scope === 'pushHeadTargets') {
              requestScopeById.current.delete(message.requestId);
              setPushHeadDialog((current) =>
                current?.requestId === message.requestId
                  ? { ...current, loading: false, error: message.message }
                  : current,
              );
              break;
            }
            if (scope === 'operation' && message.repositoryId) {
              const repositoryId = message.repositoryId;
              if (
                activeOperationRequestByRepository.current.get(repositoryId) !== message.requestId
              ) {
                requestScopeById.current.delete(message.requestId);
                break;
              }
              activeOperationRequestByRepository.current.delete(repositoryId);
              requestScopeById.current.delete(message.requestId);
              setState((current) => {
                const operationRepositoryIds = new Set(current.operationRepositoryIds);
                operationRepositoryIds.delete(repositoryId);
                return {
                  ...current,
                  operationRepositoryIds,
                  ...(current.selectedRepositoryId === repositoryId
                    ? {
                        error: message.message,
                        errorRecovery: message.recovery
                          ? { repositoryId, action: message.recovery }
                          : undefined,
                      }
                    : {}),
                };
              });
              break;
            }
            if (scope && latestRequestByScope.current[scope] !== message.requestId) {
              requestScopeById.current.delete(message.requestId);
              break;
            }
          }
          requestScopeById.current.delete(message.requestId);
          setState((current) => {
            if (
              message.repositoryId &&
              current.selectedRepositoryId !== message.repositoryId &&
              current.history?.repositoryId !== message.repositoryId
            ) {
              return current;
            }
            return {
              ...current,
              loading: undefined,
              error: message.message,
              errorRecovery:
                message.recovery && message.repositoryId
                  ? { repositoryId: message.repositoryId, action: message.recovery }
                  : undefined,
            };
          });
          break;
        case 'operationCompleted':
          if (
            activeOperationRequestByRepository.current.get(message.repositoryId) !==
            message.requestId
          ) {
            requestScopeById.current.delete(message.requestId);
            break;
          }
          activeOperationRequestByRepository.current.delete(message.repositoryId);
          requestScopeById.current.delete(message.requestId);
          setState((current) => {
            const operationRepositoryIds = new Set(current.operationRepositoryIds);
            operationRepositoryIds.delete(message.repositoryId);
            return {
              ...current,
              operationRepositoryIds,
              ...(current.selectedRepositoryId === message.repositoryId
                ? { error: undefined, errorRecovery: undefined }
                : {}),
            };
          });
          if (stashDialogRepository.current === message.repositoryId) {
            vscode.postMessage({
              type: 'requestStashState',
              requestId: requestId('stash-state-refresh'),
              repositoryId: message.repositoryId,
            });
          }
          break;
        case 'operationCancelled':
          if (
            activeOperationRequestByRepository.current.get(message.repositoryId) !==
            message.requestId
          ) {
            requestScopeById.current.delete(message.requestId);
            break;
          }
          activeOperationRequestByRepository.current.delete(message.repositoryId);
          requestScopeById.current.delete(message.requestId);
          setState((current) => {
            const operationRepositoryIds = new Set(current.operationRepositoryIds);
            operationRepositoryIds.delete(message.repositoryId);
            return {
              ...current,
              operationRepositoryIds,
              ...(current.selectedRepositoryId === message.repositoryId
                ? { error: undefined, errorRecovery: undefined }
                : {}),
            };
          });
          break;
      }
    };

    window.addEventListener('message', listener);
    vscode.postMessage({ type: 'ready', requestId: requestId('ready') });
    return () => {
      window.removeEventListener('message', listener);
      if (filterTimer.current !== undefined) window.clearTimeout(filterTimer.current);
      if (scrollPersistTimer.current !== undefined) window.clearTimeout(scrollPersistTimer.current);
      if (detailsHashCopyTimer.current !== undefined) {
        window.clearTimeout(detailsHashCopyTimer.current);
      }
    };
  }, [vscode]);

  const send = (message: WebviewToExtensionMessage): void => {
    const scope = requestScopeForMessage(message);
    if (scope) {
      requestScopeById.current.set(message.requestId, scope);
      latestRequestByScope.current[scope] = message.requestId;
    }
    vscode.postMessage(message);
  };

  const handleCommitScrollTopChange = useCallback(
    (scrollTop: number): void => {
      if (state.history || !state.selectedRepositoryId) return;
      const repositoryId = state.selectedRepositoryId;
      scrollTopByRepositoryRef.current = {
        ...scrollTopByRepositoryRef.current,
        [repositoryId]: scrollTop,
      };
      pendingScrollPosition.current = { repositoryId, scrollTop };
      if (scrollPersistTimer.current !== undefined) {
        window.clearTimeout(scrollPersistTimer.current);
      }
      scrollPersistTimer.current = window.setTimeout(() => {
        scrollPersistTimer.current = undefined;
        const next = scrollTopByRepositoryRef.current;
        pendingScrollPosition.current = undefined;
        setScrollTopByRepository(next);
        vscode.setState({ scrollTopByRepository: next });
        const logWindow = logWindowRef.current;
        vscode.postMessage({
          type: 'updateScrollAnchor',
          requestId: requestId('scroll'),
          repositoryId,
          scrollTop,
          logOffset: logWindow.startLogOffset,
          ...(logWindow.graphContinuation
            ? { graphContinuation: logWindow.graphContinuation }
            : {}),
        });
      }, 200);
    },
    [state.history, state.selectedRepositoryId, vscode],
  );

  const applyFilters = (filters: LogFilters, debounce = false): void => {
    setState((current) => ({ ...current, filters }));
    if (filterTimer.current !== undefined) {
      window.clearTimeout(filterTimer.current);
      filterTimer.current = undefined;
    }
    if (!state.selectedRepositoryId) return;
    const repositoryId = state.selectedRepositoryId;
    pendingFiltersRef.current = { repositoryId, filters };
    setScrollTopByRepository((current) => {
      const next = { ...current, [repositoryId]: 0 };
      scrollTopByRepositoryRef.current = next;
      pendingScrollPosition.current = undefined;
      vscode.setState({ scrollTopByRepository: next });
      return next;
    });
    const post = (): void => {
      filterTimer.current = undefined;
      if (scrollPersistTimer.current !== undefined) {
        window.clearTimeout(scrollPersistTimer.current);
        scrollPersistTimer.current = undefined;
      }
      setState((current) => ({
        ...current,
        startLogOffset: 0,
        nextLogOffset: 0,
        startRowOffset: 0,
        graphContinuation: undefined,
        windowAnchorReady: true,
      }));
      const filterRequestId = requestId('filters');
      pendingFiltersRef.current = { repositoryId, filters, requestId: filterRequestId };
      send({
        type: 'updateFilters',
        requestId: filterRequestId,
        repositoryId,
        filters,
      });
    };
    if (debounce) filterTimer.current = window.setTimeout(post, 200);
    else post();
  };

  const applyDateRange = (dateFrom?: number, dateTo?: number): void => {
    const filters = { ...state.filters };
    delete filters.dateFrom;
    delete filters.dateTo;
    applyFilters({
      ...filters,
      ...(dateFrom !== undefined ? { dateFrom } : {}),
      ...(dateTo !== undefined ? { dateTo } : {}),
    });
    setFilterPopup(undefined);
  };

  const selectRepository = (repositoryId: string): void => {
    if (filterTimer.current !== undefined) {
      window.clearTimeout(filterTimer.current);
      filterTimer.current = undefined;
    }
    pendingFiltersRef.current = undefined;
    if (scrollPersistTimer.current !== undefined) {
      window.clearTimeout(scrollPersistTimer.current);
      scrollPersistTimer.current = undefined;
    }
    pendingScrollPosition.current = undefined;
    setContextMenu(undefined);
    setNamedOperation(undefined);
    setPushHeadDialog(undefined);
    setFilterPopup(undefined);
    setRefSearch('');
    activeSelectionRequest.current = undefined;
    activeCommitMessagesRequest.current = undefined;
    commitSelectionAnchor.current = undefined;
    setSelectedCommitHashes([]);
    setSquashOperation(undefined);
    setStashDialog(undefined);
    setAmendDialog(undefined);
    stashDialogRepository.current = undefined;
    lastWindowAnchorSignature.current = undefined;
    selectedRepositoryIdRef.current = repositoryId;
    setState((current) => ({
      ...current,
      selectedRepositoryId: repositoryId,
      refs: [],
      commits: [],
      commitListRevision: current.commitListRevision + 1,
      nextLogOffset: 0,
      startLogOffset: 0,
      startRowOffset: 0,
      graphContinuation: undefined,
      windowAnchorReady: false,
      selectedHash: undefined,
      details: undefined,
      detailsRepositoryId: undefined,
      selectedParent: undefined,
      files: [],
      selectedFile: undefined,
      loading: 'log',
      error: undefined,
      errorRecovery: undefined,
    }));
    const selectionRequestId = requestId('repository');
    latestRepositorySelectionRequest.current = selectionRequestId;
    send({ type: 'selectRepository', requestId: selectionRequestId, repositoryId });
  };

  const selectCommit = (commit: CommitSummary, extend = false, toggle = false): void => {
    if (state.history) {
      const rememberedParent = historyParentChoices.current.get(commit.hash);
      if (commit.parents.length > 1 && !rememberedParent) {
        setHistoryParentPicker({
          repositoryId: state.history.repositoryId,
          commit,
        });
        return;
      }
      send({
        type: 'openHistoryDiff',
        requestId: requestId('history-diff'),
        repositoryId: state.history.repositoryId,
        hash: commit.hash,
        ...(rememberedParent ?? commit.parents[0]
          ? { parent: rememberedParent ?? commit.parents[0] }
          : {}),
      });
      return;
    }
    if (!state.selectedRepositoryId) return;
    let nextSelectedCommitHashes: string[];
    let focusedCommit = commit;
    if (toggle) {
      const nextSelection = new Set(selectedCommitHashes);
      if (nextSelection.has(commit.hash)) {
        if (nextSelection.size === 1) return;
        nextSelection.delete(commit.hash);
        nextSelectedCommitHashes = state.commits
          .filter((candidate) => nextSelection.has(candidate.hash))
          .map((candidate) => candidate.hash);
        const focusedHash =
          state.selectedHash && nextSelection.has(state.selectedHash)
            ? state.selectedHash
            : nextSelectedCommitHashes[0];
        focusedCommit =
          state.commits.find((candidate) => candidate.hash === focusedHash) ?? commit;
      } else {
        nextSelection.add(commit.hash);
        nextSelectedCommitHashes = state.commits
          .filter((candidate) => nextSelection.has(candidate.hash))
          .map((candidate) => candidate.hash);
      }
      commitSelectionAnchor.current = focusedCommit.hash;
    } else if (extend && commitSelectionAnchor.current) {
      const anchorIndex = state.commits.findIndex(
        (candidate) => candidate.hash === commitSelectionAnchor.current,
      );
      const targetIndex = state.commits.findIndex((candidate) => candidate.hash === commit.hash);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const start = Math.min(anchorIndex, targetIndex);
        const end = Math.max(anchorIndex, targetIndex);
        nextSelectedCommitHashes = state.commits
          .slice(start, end + 1)
          .map((candidate) => candidate.hash);
      } else {
        commitSelectionAnchor.current = commit.hash;
        nextSelectedCommitHashes = [commit.hash];
      }
    } else {
      commitSelectionAnchor.current = commit.hash;
      nextSelectedCommitHashes = [commit.hash];
    }
    setSelectedCommitHashes(nextSelectedCommitHashes);
    const selectionRequestId = requestId('selection');
    activeSelectionRequest.current = {
      requestId: selectionRequestId,
      repositoryId: state.selectedRepositoryId,
      hash: focusedCommit.hash,
    };
    setState((current) => ({
      ...current,
      selectedHash: focusedCommit.hash,
      details: undefined,
      detailsRepositoryId: undefined,
      selectedParent: undefined,
      files: [],
      selectedFile: undefined,
    }));
    send({
      type: 'selectCommit',
      requestId: selectionRequestId,
      repositoryId: state.selectedRepositoryId,
      hash: focusedCommit.hash,
      hashes: nextSelectedCommitHashes,
    });
  };

  const selectHash = (hash: string, prefix = 'selection'): void => {
    if (!state.selectedRepositoryId) return;
    const commit = state.commits.find((candidate) => candidate.hash === hash);
    if (commit) {
      selectCommit(commit);
      return;
    }
    commitSelectionAnchor.current = hash;
    setSelectedCommitHashes([hash]);
    setState((current) => ({
      ...current,
      selectedHash: hash,
      details: undefined,
      detailsRepositoryId: undefined,
      selectedParent: undefined,
      files: [],
      selectedFile: undefined,
    }));
    const selectionRequestId = requestId(prefix);
    activeSelectionRequest.current = {
      requestId: selectionRequestId,
      repositoryId: state.selectedRepositoryId,
      hash,
    };
    send({
      type: 'selectCommit',
      requestId: selectionRequestId,
      repositoryId: state.selectedRepositoryId,
      hash,
    });
  };

  const selectRef = (ref: RefLabel): void => {
    const commit = state.commits.find((candidate) => candidate.hash === ref.target);
    const branchFilter = ref.fullName === 'HEAD' ? [] : [ref.fullName];
    if (
      (ref.fullName === 'HEAD' || ref.kind === 'local' || ref.kind === 'remote') &&
      (state.filters.allBranches || state.filters.branches.length !== branchFilter.length ||
        state.filters.branches.some((branch, index) => branch !== branchFilter[index]))
    ) {
      applyFilters({
        ...state.filters,
        ...(state.filters.allBranches ? { allBranches: false } : {}),
        branches: branchFilter,
      });
    }
    selectHash(ref.target, 'ref');
    if (commit) document.querySelector<HTMLElement>(`[data-commit-hash="${commit.hash}"]`)?.focus();
  };

  const toggleRefGroup = (group: string): void => {
    setCollapsedRefGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const toggleRefFolder = (folder: string): void => {
    setCollapsedRefFolders((current) => {
      const next = new Set(current);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  };

  const handleRefKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    ref: RefLabel,
  ): void => {
    const items = [...document.querySelectorAll<HTMLButtonElement>('[data-ref-item="true"]')];
    const index = items.indexOf(event.currentTarget);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      items[Math.min(items.length - 1, Math.max(0, index + direction))]?.focus();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      selectRef(ref);
    }
  };

  const openCommitComparison = (
    hash: string,
    mode: 'parent' | 'current',
    parent?: string,
  ): void => {
    if (!state.selectedRepositoryId) return;
    send({
      type: 'openCommitComparison',
      requestId: requestId('compare'),
      repositoryId: state.selectedRepositoryId,
      hash,
      mode,
      ...(parent ? { parent } : {}),
    });
    setContextMenu(undefined);
  };

  const loadMore = (): void => {
    if (state.history) {
      if (!state.history.hasMore) return;
      send({
        type: 'requestHistoryPage',
        requestId: requestId('history-page'),
        repositoryId: state.history.repositoryId,
        skip: state.history.entries.length,
      });
      return;
    }
    if (!state.selectedRepositoryId || !state.hasMore || state.loading === 'log') return;
    send({
      type: 'requestLogPage',
      requestId: requestId('page'),
      repositoryId: state.selectedRepositoryId,
      skip: state.nextLogOffset,
    });
  };

  const updateFilesViewMode = (filesViewMode: WorkbenchLayout['filesViewMode']): void => {
    const layout = { ...state.layout, filesViewMode };
    setState((current) => ({ ...current, layout }));
    send({ type: 'updateLayout', requestId: requestId('layout'), layout });
  };

  const persistLayout = (layout: WorkbenchLayout): void => {
    setState((current) => ({ ...current, layout }));
    send({ type: 'updateLayout', requestId: requestId('layout'), layout });
  };

  const toggleDetailsPlacement = (): void => {
    const nextPlacement = detailsInChanges ? 'bottom' : 'changes';
    persistLayout({ ...state.layout, detailsPlacement: nextPlacement });
  };

  const resizeLayout = (
    key: 'refsWidth' | 'filesWidth' | 'detailsHeight',
    delta: number,
  ): void => {
    const min = key === 'refsWidth' ? 160 : key === 'filesWidth' ? 220 : 100;
    const max =
      key === 'detailsHeight'
        ? Math.max(min, window.innerHeight - 180)
        : Math.max(min, window.innerWidth - (key === 'refsWidth' ? 560 : 520));
    persistLayout({
      ...state.layout,
      [key]: Math.min(max, Math.max(min, state.layout[key] + delta)),
    });
  };

  const beginResize = (
    key: 'refsWidth' | 'filesWidth' | 'detailsHeight',
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    event.preventDefault();
    const start = key === 'detailsHeight' ? event.clientY : event.clientX;
    const initialLayout = state.layout;
    let nextLayout = initialLayout;
    const move = (pointerEvent: PointerEvent): void => {
      const current = key === 'detailsHeight' ? pointerEvent.clientY : pointerEvent.clientX;
      const rawDelta = current - start;
      const delta = key === 'filesWidth' || key === 'detailsHeight' ? -rawDelta : rawDelta;
      const min = key === 'refsWidth' ? 160 : key === 'filesWidth' ? 220 : 100;
      const max =
        key === 'detailsHeight'
          ? Math.max(min, window.innerHeight - 180)
          : Math.max(min, window.innerWidth - (key === 'refsWidth' ? 560 : 520));
      nextLayout = {
        ...initialLayout,
        [key]: Math.min(max, Math.max(min, initialLayout[key] + delta)),
      };
      setState((currentState) => ({ ...currentState, layout: nextLayout }));
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      send({ type: 'updateLayout', requestId: requestId('layout'), layout: nextLayout });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  const resizeColumn = (
    key: 'commitColumnWidth' | 'refsColumnWidth' | 'authorColumnWidth' | 'dateColumnWidth',
    delta: number,
    measuredWidth?: number,
  ): void => {
    const fallback =
      key === 'commitColumnWidth'
        ? measuredWidth && measuredWidth >= 160
          ? measuredWidth
          : 360
        : key === 'refsColumnWidth'
          ? 150
          : key === 'authorColumnWidth'
            ? 130
            : 125;
    const min = key === 'commitColumnWidth' ? 160 : key === 'dateColumnWidth' ? 90 : 100;
    const max = key === 'commitColumnWidth' ? 2000 : 320;
    persistLayout({
      ...state.layout,
      [key]: Math.min(max, Math.max(min, (state.layout[key] ?? fallback) + delta)),
    });
  };

  const beginColumnResize = (
    key: 'commitColumnWidth' | 'refsColumnWidth' | 'authorColumnWidth' | 'dateColumnWidth',
    event: ReactPointerEvent<HTMLDivElement>,
    measuredWidth?: number,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    const start = event.clientX;
    const fallback =
      key === 'commitColumnWidth'
        ? measuredWidth && measuredWidth >= 160
          ? measuredWidth
          : 360
        : key === 'refsColumnWidth'
          ? 150
          : key === 'authorColumnWidth'
            ? 130
            : 125;
    const initial = state.layout[key] ?? fallback;
    const min = key === 'commitColumnWidth' ? 160 : key === 'dateColumnWidth' ? 90 : 100;
    const max = key === 'commitColumnWidth' ? 2000 : 320;
    let nextLayout = state.layout;
    const move = (pointerEvent: PointerEvent): void => {
      nextLayout = {
        ...state.layout,
        [key]: Math.min(max, Math.max(min, initial + pointerEvent.clientX - start)),
      };
      setState((current) => ({ ...current, layout: nextLayout }));
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      send({ type: 'updateLayout', requestId: requestId('layout'), layout: nextLayout });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  const openDiff = (file: ChangedFile): void => {
    if (
      !state.detailsRepositoryId ||
      state.detailsRepositoryId !== state.selectedRepositoryId ||
      !state.details
    ) {
      return;
    }
    if (file.binary) {
      setState((current) => ({
        ...current,
        error: `Binary diff is not available for ${file.path}.`,
        errorRecovery: undefined,
      }));
      return;
    }
    const details = state.details;
    const target = (changed: ChangedFile) => {
      const parent = changed.parentHash ?? state.selectedParent;
      return {
        hash: changed.commitHash ?? details.hash,
        ...(parent ? { parent } : {}),
        path: changed.path,
        ...(changed.oldPath ? { oldPath: changed.oldPath } : {}),
        status: changed.status,
      };
    };
    const ordered = state.layout.filesViewMode === 'tree' ? flattenFileTree(fileTree) : state.files;
    send({
      type: 'openDiff',
      requestId: requestId('diff'),
      repositoryId: state.detailsRepositoryId,
      ...target(file),
      navigation: ordered
        .filter((changed) => !changed.binary)
        .slice(0, MAX_DIFF_NAVIGATION_TARGETS)
        .map(target),
    });
  };

  const runWorkbenchCommand = (
    command: WorkbenchCommand,
    repositoryId = state.selectedRepositoryId,
  ): void => {
    setContextMenu(undefined);
    if (!repositoryId) return;
    const message = parseWebviewMessage({
      type: 'workbenchCommand',
      requestId: requestId(`command-${command.kind}`),
      repositoryId,
      command,
    });
    if (!message) {
      setState((current) => ({ ...current, error: 'Invalid Git Log action.', errorRecovery: undefined }));
      return;
    }
    send(message);
  };

  /** The commit (and parent) a changed file belongs to, including in multi-commit selections. */
  const fileRevision = (file: ChangedFile): { hash?: string; parent?: string } => {
    const hash = file.commitHash ?? state.details?.hash;
    const parent = file.parentHash ?? state.selectedParent;
    return { ...(hash ? { hash } : {}), ...(parent ? { parent } : {}) };
  };

  const openFile = (file: ChangedFile, mode: 'revision' | 'current'): void => {
    if (
      !state.detailsRepositoryId ||
      state.detailsRepositoryId !== state.selectedRepositoryId ||
      !state.details
    ) {
      return;
    }
    const parent = file.parentHash ?? state.selectedParent;
    send({
      type: 'openFile',
      requestId: requestId(`open-file-${mode}`),
      repositoryId: state.detailsRepositoryId,
      hash: file.commitHash ?? state.details.hash,
      ...(parent ? { parent } : {}),
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      status: file.status,
      mode,
    });
    setContextMenu(undefined);
  };

  const runOperation = (operation: GitOperationRequest, repositoryId = state.selectedRepositoryId): void => {
    if (!repositoryId || activeOperationRequestByRepository.current.has(repositoryId)) return;
    const operationRequestId = requestId('operation');
    const validatedMessage = parseWebviewMessage({
      type: 'runOperation',
      requestId: operationRequestId,
      repositoryId,
      operation,
    });
    if (!validatedMessage || validatedMessage.type !== 'runOperation') {
      setState((current) => ({
        ...current,
        error: 'Invalid Git operation parameters.',
        errorRecovery: undefined,
      }));
      return;
    }
    activeOperationRequestByRepository.current.set(repositoryId, operationRequestId);
    setState((current) => ({
      ...current,
      operationRepositoryIds: new Set(current.operationRepositoryIds).add(repositoryId),
      error: undefined,
      errorRecovery: undefined,
    }));
    send(validatedMessage);
    setContextMenu(undefined);
  };

  const openPushHead = (repositoryId: string): void => {
    const targetsRequestId = requestId('push-head-targets');
    setPushHeadDialog({
      repositoryId, requestId: targetsRequestId, remotes: [],
      remote: '', branch: '', loading: true,
    });
    send({ type: 'requestPushHeadTargets', requestId: targetsRequestId, repositoryId });
    setContextMenu(undefined);
  };

  const submitNamedOperation = (): void => {
    if (!namedOperation?.value.trim()) return;
    const value = namedOperation.value.trim();
    if (namedOperation.kind === 'createBranch') {
      runOperation(
        { kind: 'createBranch', name: value, startPoint: namedOperation.target },
        namedOperation.repositoryId,
      );
    } else if (namedOperation.kind === 'createAndCheckoutBranch') {
      runOperation(
        { kind: 'createAndCheckoutBranch', name: value },
        namedOperation.repositoryId,
      );
    } else if (namedOperation.kind === 'createTag') {
      runOperation(
        { kind: 'createTag', name: value, target: namedOperation.target },
        namedOperation.repositoryId,
      );
    } else if (namedOperation.kind === 'renameBranch') {
      runOperation(
        { kind: 'renameBranch', oldName: namedOperation.oldName, newName: value },
        namedOperation.repositoryId,
      );
    } else {
      runOperation(
        { kind: 'checkoutRemote', name: value, startPoint: namedOperation.startPoint },
        namedOperation.repositoryId,
      );
    }
    setNamedOperation(undefined);
  };

  const logContentWidth =
    (state.layout.commitColumnWidth ?? 260) +
    (state.layout.authorColumnWidth ?? 130) +
    (state.layout.dateColumnWidth ?? 125) +
    (state.layout.refsColumnWidth ?? 150);

  const handleWorkbenchKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      searchRef.current?.focus();
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      logRef.current?.focus();
    } else if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === 'c' &&
      state.selectedHash &&
      !(event.target instanceof HTMLInputElement) &&
      !(event.target instanceof HTMLTextAreaElement) &&
      !(event.target instanceof HTMLSelectElement)
    ) {
      event.preventDefault();
      send({
        type: 'copyToClipboard',
        requestId: requestId('copy-hash'),
        text: state.selectedHash,
      });
    } else if (event.key === 'Escape') {
      setContextMenu(undefined);
      setNamedOperation(undefined);
      setPushHeadDialog(undefined);
      setFilterPopup(undefined);
      setHistoryParentPicker(undefined);
    }
  };

  const commitToolbar = (
      <header
        className={`filter-bar${state.history || state.folderHistory ? ' history-active' : ''}`}
        role="toolbar"
        aria-label="Git log filters"
      >
        {state.history ? (
          <div className="history-toolbar">
            <strong>
              {state.history.kind === 'file' ? 'File History' : 'Line History'} · {state.history.path}
              {state.history.startLine !== undefined
                ? ` : ${String(state.history.startLine)}–${String(state.history.endLine ?? state.history.startLine)}`
                : ''}
            </strong>
            {state.history.notice && state.history.entries.length ? (
              <span className="history-notice">{state.history.notice}</span>
            ) : null}
            {state.history.kind === 'line' ? (
              <button
                type="button"
                aria-label="Show file history"
                title="Show complete file history"
                onClick={() =>
                  send({
                    type: 'switchHistoryToFile',
                    requestId: requestId('history-file'),
                    repositoryId: state.history?.repositoryId ?? '',
                  })
                }
              >
                File History
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Back to log"
              title="Return to the Git log"
              onClick={() =>
                send({
                  type: 'closeHistory',
                  requestId: requestId('history-back'),
                  repositoryId: state.history?.repositoryId ?? '',
                })
              }
            >
              Back
            </button>
            <button
              type="button"
              aria-label="Close history"
              title="Close history and return to the Git log"
              onClick={() =>
                send({
                  type: 'closeHistory',
                  requestId: requestId('history-close'),
                  repositoryId: state.history?.repositoryId ?? '',
                })
              }
            >
              Close
            </button>
          </div>
        ) : null}
        {state.folderHistory ? (
          <div className="history-toolbar">
            <strong>
              Folder History ·{' '}
              {state.folderHistory.path === '.' ? 'Repository Root' : state.folderHistory.path}
            </strong>
            <button
              className="history-toolbar-close"
              type="button"
              aria-label="Close folder history"
              title="Restore the previous Git log filters"
              onClick={() =>
                send({
                  type: 'closeFolderHistory',
                  requestId: requestId('folder-history-back'),
                  repositoryId: state.folderHistory?.repositoryId ?? '',
                })
              }
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        ) : null}
        {state.repositories.length > 1 ? (
          <div className="field repository-field">
            <select
              aria-label="Repository"
              value={state.selectedRepositoryId ?? ''}
              onChange={(event) => selectRepository(event.target.value)}
            >
              <option value="" disabled>
                Select repository
              </option>
              {state.repositories.map((repository) => (
                <option value={repository.id} key={repository.id}>
                  {repository.displayName}
                  {repository.operationState
                    ? ` · ${operationStateLabel(repository.operationState)}`
                    : ''}
                </option>
              ))}
            </select>
            {selectedRepository?.operationState &&
            !isSequencerState(selectedRepository.operationState) ? (
              <button
                className="operation-badge"
                type="button"
                aria-label="Open Source Control"
                title="Open Source Control"
                onClick={() =>
                  send({
                    type: 'openSourceControl',
                    requestId: requestId('source-control'),
                  })
                }
              >
                {operationStateLabel(selectedRepository.operationState)}
              </button>
            ) : null}
          </div>
        ) : selectedRepository?.operationState &&
          !isSequencerState(selectedRepository.operationState) ? (
          <button
            className="operation-badge"
            type="button"
            aria-label="Open Source Control"
            title="Open Source Control"
            onClick={() =>
              send({
                type: 'openSourceControl',
                requestId: requestId('source-control'),
              })
            }
          >
            {operationStateLabel(selectedRepository.operationState)}
          </button>
        ) : null}
        <label className="field search-field">
          <span className="search-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            ref={searchRef}
            type="search"
            aria-label="Text or hash"
            placeholder="Text or hash"
            value={state.filters.text}
            onChange={(event) => applyFilters({ ...state.filters, text: event.target.value }, true)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.stopPropagation();
              if (state.filters.text) {
                applyFilters({ ...state.filters, text: '' });
              } else {
                logRef.current?.focus();
              }
            }}
          />
        </label>
        {(
          [
            {
              kind: 'branch',
              name: 'Branch',
              value: branchFilterValue,
              clear: (filters) => ({ ...filters, allBranches: false, branches: [], compare: undefined }),
            },
            { kind: 'user', name: 'User', value: authorFilterValue, clear: (filters) => ({ ...filters, authors: [] }) },
            {
              kind: 'date',
              name: 'Date',
              value: dateFilterValue,
              clear: (filters) => {
                const next = { ...filters };
                delete next.dateFrom;
                delete next.dateTo;
                return next;
              },
            },
            { kind: 'paths', name: 'Paths', value: pathFilterValue, clear: (filters) => ({ ...filters, paths: [] }) },
          ] satisfies {
            kind: NonNullable<typeof filterPopup>;
            name: string;
            value: string;
            clear: (filters: LogFilters) => LogFilters;
          }[]
        ).map((filter) => (
          <span className={`filter-chip${filter.value ? ' filter-active' : ''}`} key={filter.kind}>
            <button
              type="button"
              data-popup-trigger="true"
              aria-label={filter.value ? `${filter.name}: ${filter.value}` : filter.name}
              aria-expanded={filterPopup === filter.kind}
              title={filter.value ? `${filter.name}: ${filter.value}` : `Filter by ${filter.name.toLowerCase()}`}
              onClick={() => {
                setContextMenu(undefined);
                setFilterSearch('');
                setFilterPopup((current) => (current === filter.kind ? undefined : filter.kind));
              }}
            >
              {filter.name}
              {filter.value ? (
                <>
                  : <strong className="filter-chip-value">{filter.value}</strong>
                </>
              ) : null}
              <span className="filter-chip-chevron" aria-hidden="true">
                ▾
              </span>
            </button>
            {filter.kind === 'branch' && state.filters.compare ? (
              <button
                type="button"
                className="filter-chip-action"
                aria-label="Swap comparison direction"
                title="Swap: show the commits on the other side"
                onClick={() => {
                  const compare = state.filters.compare;
                  if (!compare) return;
                  applyFilters({
                    ...state.filters,
                    compare: { ...compare, direction: compare.direction === 'notInHead' ? 'onlyInHead' : 'notInHead' },
                  });
                }}
              >
                ⇄
              </button>
            ) : null}
            {filter.value ? (
              <button
                type="button"
                className="filter-chip-action"
                aria-label={`Clear ${filter.name.toLowerCase()} filter`}
                title={`Clear ${filter.name.toLowerCase()} filter`}
                onClick={() => {
                  applyFilters(filter.clear(state.filters));
                  if (filterPopup === filter.kind) setFilterPopup(undefined);
                }}
              >
                ×
              </button>
            ) : null}
          </span>
        ))}
        {filterPopup ? (
          <div
            className={`filter-popover filter-${filterPopup}`}
            role="dialog"
            aria-label={`${filterPopup} filter`}
            style={filterPopoverPosition}
          >
            {filterPopup === 'branch' ? (
              <>
                <input
                  className="filter-search"
                  type="search"
                  aria-label="Search branches"
                  placeholder="Search branches"
                  autoFocus
                  value={filterSearch}
                  onChange={(event) => setFilterSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && branchFilterRefs[0]) {
                      event.preventDefault();
                      selectOnlyBranch(branchFilterRefs[0]);
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      event.stopPropagation();
                      if (filterSearch) setFilterSearch('');
                      else setFilterPopup(undefined);
                    }
                  }}
                />
                {branchFilterQuery ? null : (
                  <>
                    <label className="filter-option">
                      <input
                        type="checkbox"
                        checked={allBranchRefsSelected && !state.filters.compare}
                        disabled={!state.refs.length}
                        onChange={() => {
                          applyFilters({
                            ...state.filters,
                            allBranches: !allBranchRefsSelected || Boolean(state.filters.compare),
                            branches: [],
                            compare: undefined,
                          });
                        }}
                      />
                      <span>All</span>
                    </label>
                    <label className="filter-option">
                      <input
                        type="checkbox"
                        checked={!state.filters.allBranches && !state.filters.branches.length && !state.filters.compare}
                        disabled={!selectedRepository?.head}
                        onChange={() =>
                          applyFilters({ ...state.filters, allBranches: false, branches: [], compare: undefined })
                        }
                      />
                      <span>HEAD (local)</span>
                    </label>
                  </>
                )}
                {refGroups.map(({ label, kind }) => {
                  const refs = branchFilterRefs.filter((ref) => ref.kind === kind);
                  if (!refs.length) return null;
                  return (
                    <div className="filter-group" key={kind} role="group" aria-label={label}>
                      <div className="filter-popover-title">{label}</div>
                      {refs.map((ref) => {
                        const checked = state.filters.compare
                          ? false
                          : state.filters.allBranches
                            ? !state.filters.branches.includes(ref.fullName)
                            : state.filters.branches.includes(ref.fullName);
                        return (
                          <div
                            className={`filter-option branch-filter-option${state.filters.compare?.ref === ref.fullName ? ' compared' : ''}`}
                            key={ref.fullName}
                          >
                            <input
                              type="checkbox"
                              aria-label={ref.shortName}
                              title="Add to the selection"
                              checked={checked}
                              onChange={() => {
                                const base = state.filters.compare ? [] : state.filters.branches;
                                const branches = base.includes(ref.fullName)
                                  ? base.filter((branch) => branch !== ref.fullName)
                                  : [...base, ref.fullName];
                                const allBranches = Boolean(
                                  !state.filters.compare &&
                                    state.filters.allBranches &&
                                    branches.length < state.refs.length,
                                );
                                applyFilters({
                                  ...state.filters,
                                  allBranches,
                                  branches: state.filters.allBranches && !allBranches ? [] : branches,
                                  compare: undefined,
                                });
                              }}
                            />
                            <button
                              type="button"
                              className="branch-filter-name"
                              title={`Show only ${ref.shortName}`}
                              onClick={() => selectOnlyBranch(ref)}
                            >
                              {ref.isCurrent ? <span className="branch-filter-current">● </span> : null}
                              {ref.shortName}
                            </button>
                            {ref.isCurrent || ref.target === selectedRepository?.head ? null : (
                              <span className="branch-filter-compare">
                                <button
                                  type="button"
                                  title={`Commits in ${ref.shortName} that are not in ${currentBranchLabel} (${currentBranchLabel}..${ref.shortName})`}
                                  aria-label={`Commits in ${ref.shortName} not in ${currentBranchLabel}`}
                                  onClick={() => showBranchCommits(ref, 'notInHead')}
                                >
                                  ←
                                </button>
                                <button
                                  type="button"
                                  title={`Commits in ${currentBranchLabel} that are not in ${ref.shortName} (${ref.shortName}..${currentBranchLabel})`}
                                  aria-label={`Commits in ${currentBranchLabel} not in ${ref.shortName}`}
                                  onClick={() => showBranchCommits(ref, 'onlyInHead')}
                                >
                                  →
                                </button>
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
                {state.refs.length && !branchFilterRefs.length ? (
                  <span className="filter-empty">No matching branches</span>
                ) : null}
                {state.refs.length ? null : <span className="filter-empty">No refs loaded</span>}
                {branchFilterQuery ? null : (
                  <div className="filter-hint">
                    Click a name to show only that branch, tick boxes to combine several. ← / → compare with{' '}
                    {currentBranchLabel}.
                  </div>
                )}
              </>
            ) : null}
            {filterPopup === 'user' ? (
              <>
                <input
                  className="filter-search"
                  type="search"
                  aria-label="Search authors"
                  placeholder="Search authors"
                  autoFocus
                  value={filterSearch}
                  onChange={(event) => setFilterSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Escape') return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (filterSearch) setFilterSearch('');
                    else setFilterPopup(undefined);
                  }}
                />
                <div className="filter-popover-title">Authors</div>
                {authorFilterOptions
                  .filter((author) => author.label.toLocaleLowerCase().includes(filterSearch.trim().toLocaleLowerCase()))
                  .map((author) => (
                  <label className="filter-option" key={author.key}>
                    <input
                      type="checkbox"
                      checked={state.filters.authors.includes(author.value)}
                      onChange={() => {
                        const authors = state.filters.authors.includes(author.value)
                          ? state.filters.authors.filter((candidate) => candidate !== author.value)
                          : [...state.filters.authors, author.value];
                        applyFilters({ ...state.filters, authors });
                      }}
                    />
                    <span>{author.label}</span>
                  </label>
                ))}
              </>
            ) : null}
            {filterPopup === 'date' ? (
              <div className="date-options">
                {[
                  { label: 'All time', kind: 'all' },
                  { label: 'Today', kind: 'today' },
                  { label: 'Yesterday', kind: 'yesterday' },
                  { label: 'Last 7 days', kind: 'days', days: 7 },
                  { label: 'Last 30 days', kind: 'days', days: 30 },
                ].map((option) => (
                  <button
                    type="button"
                    key={option.label}
                    onClick={() => {
                      const now = new Date();
                      const today = new Date(
                        now.getFullYear(),
                        now.getMonth(),
                        now.getDate(),
                      ).getTime() / 1000;
                      if (option.kind === 'all') applyDateRange();
                      else if (option.kind === 'today') applyDateRange(today, today + 24 * 60 * 60);
                      else if (option.kind === 'yesterday') {
                        applyDateRange(today - 24 * 60 * 60, today);
                      } else {
                        applyDateRange(
                          Math.floor(Date.now() / 1000) - (option.days ?? 0) * 24 * 60 * 60,
                        );
                      }
                    }}
                  >
                    {option.label}
                  </button>
                ))}
                <div className="custom-date-range">
                  <label>
                    <span>From</span>
                    <input
                      type="date"
                      aria-label="Custom date from"
                      value={customDateFrom}
                      onChange={(event) => setCustomDateFrom(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>To</span>
                    <input
                      type="date"
                      aria-label="Custom date to"
                      value={customDateTo}
                      onChange={(event) => setCustomDateTo(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!customDateFrom && !customDateTo}
                    onClick={() =>
                      applyDateRange(
                        customDateFrom
                          ? Math.floor(new Date(`${customDateFrom}T00:00:00`).getTime() / 1000)
                          : undefined,
                        customDateTo
                          ? Math.floor(new Date(`${customDateTo}T23:59:59`).getTime() / 1000)
                          : undefined,
                      )
                    }
                  >
                    Apply custom range
                  </button>
                </div>
              </div>
            ) : null}
            {filterPopup === 'paths' ? (
              <label className="path-filter-field">
                <span>Git path</span>
                <input
                  aria-label="Git path filter"
                  value={state.filters.paths[0] ?? ''}
                  placeholder="src/ or src/app.ts"
                  onChange={(event) =>
                    applyFilters(
                      {
                        ...state.filters,
                        paths: event.target.value ? [event.target.value] : [],
                      },
                      true,
                    )
                  }
                />
              </label>
            ) : null}
            <button
              type="button"
              className="reset-filters"
              onClick={() => {
                applyFilters(defaultFilters);
                setFilterPopup(undefined);
              }}
            >
              Reset filters
            </button>
          </div>
        ) : null}
      </header>
  );

  const fileMenu = (() => {
    if (contextMenu?.kind !== 'file' || selectedRepository?.isBare) return undefined;
    const file = contextMenu.file;
    const revision = fileRevision(file);
    if (!revision.hash) return undefined;
    return {
      file,
      hash: revision.hash,
      ...(revision.parent ? { parent: revision.parent } : {}),
      paths: file.oldPath && file.oldPath !== file.path ? [file.path, file.oldPath] : [file.path],
      busy: selectedOperationInFlight || Boolean(selectedRepository?.operationState),
    };
  })();
  const refUpstream = (() => {
    if (contextMenu?.kind !== 'ref' || !contextMenu.ref.upstream) return undefined;
    const upstream = contextMenu.ref.upstream.replace(/^refs\/remotes\//u, '');
    const remote = (contextMenu.ref.remote && upstream.startsWith(`${contextMenu.ref.remote}/`))
      ? contextMenu.ref.remote
      : upstream.slice(0, Math.max(0, upstream.indexOf('/')));
    if (!remote) return undefined;
    return { remote, branch: upstream.slice(remote.length + 1) };
  })();

  const globalToolbar = (
    <header className="global-toolbar" role="toolbar" aria-label="Global Git actions">
        <button
          type="button"
          aria-label="Refresh log"
          title="Refresh local repository state"
          onClick={() =>
            send({
              type: 'refresh',
              requestId: requestId('refresh'),
              ...(state.selectedRepositoryId ? { repositoryId: state.selectedRepositoryId } : {}),
            })
          }
        >
          <i className="codicon codicon-refresh" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Fetch remotes"
          title="Fetch from remotes"
          disabled={!state.selectedRepositoryId || selectedRepository?.isBare || selectedOperationInFlight}
          onClick={() => runOperation({ kind: 'fetch' })}
        >
          <i className="codicon codicon-repo-fetch" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Pull"
          title="Pull into the current branch"
          disabled={
            !selectedRepository?.currentBranch ||
            selectedRepository.isBare ||
            Boolean(selectedRepository.operationState) ||
            selectedOperationInFlight
          }
          onClick={() => runOperation({ kind: 'pull' })}
        >
          <i className="codicon codicon-repo-pull" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Push…"
          title="Push… (review outgoing commits and choose the target branch)"
          disabled={
            !selectedRepository?.currentBranch ||
            selectedRepository.isBare ||
            Boolean(selectedRepository.operationState)
          }
          onClick={() => runWorkbenchCommand({ kind: 'openPushDialog' })}
        >
          <i className="codicon codicon-repo-push" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Manage stashes"
          title="Create, inspect, apply, pop, or drop stashes"
          disabled={!state.selectedRepositoryId || selectedRepository?.isBare}
          onClick={() => {
            const repositoryId = state.selectedRepositoryId;
            if (!repositoryId) return;
            setStashDialog({
              repositoryId,
              stashes: [],
              loading: true,
              stashMessage: '',
              includeUntracked: false,
            });
            stashDialogRepository.current = repositoryId;
            send({
              type: 'requestStashState',
              requestId: requestId('stash-state'),
              repositoryId,
            });
          }}
        >
          <i className="codicon codicon-archive" aria-hidden="true" />
        </button>
    </header>
  );

  const detailsPlacementLabel = detailsInChanges
    ? 'Move commit details to bottom'
    : 'Move commit details below changed files';
  const detailsPlacementButton = (
    <button
      type="button"
      className="details-placement-button"
      aria-label={detailsPlacementLabel}
      title={detailsPlacementLabel}
      onClick={toggleDetailsPlacement}
    >
      <span
        className={`details-placement-icon${detailsInChanges ? ' to-bottom' : ''}`}
        aria-hidden="true"
      >
        ⇥
      </span>
    </button>
  );
  const commitDetailsResizer = (
    <div
      className="pane-resizer horizontal details-resizer"
      style={detailsInChanges ? { gridRow: 5 } : undefined}
      role="separator"
      aria-label="Resize commit details pane"
      aria-orientation="horizontal"
      aria-valuemin={100}
      aria-valuenow={state.layout.detailsHeight}
      tabIndex={0}
      onPointerDown={(event) => beginResize('detailsHeight', event)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp') resizeLayout('detailsHeight', 10);
        if (event.key === 'ArrowDown') resizeLayout('detailsHeight', -10);
      }}
    />
  );
  const commitDetailsPane = (
    <section
      className="details-pane pane"
      style={detailsInChanges ? { gridRow: 6 } : undefined}
      role="region"
      aria-label="Commit details"
      tabIndex={-1}
    >
      {state.details ? (
        <div className="details-content">
          <div className="details-heading-row">
            <div className="details-message">{state.details.subject}</div>
            <div className="details-actions" role="toolbar" aria-label="Commit actions">
              {detailsPlacementButton}
              <button
                type="button"
                aria-label="Cherry-pick selected commit"
                disabled={
                  selectedRepository?.isBare ||
                  Boolean(selectedRepository?.operationState) ||
                  selectedOperationInFlight
                }
                onClick={() =>
                  runOperation(
                    { kind: 'cherryPick', hash: state.details?.hash ?? '' },
                    state.detailsRepositoryId,
                  )
                }
              >
                Cherry-pick
              </button>
              <button
                type="button"
                aria-label="Revert selected commit"
                disabled={
                  selectedRepository?.isBare ||
                  Boolean(selectedRepository?.operationState) ||
                  selectedOperationInFlight
                }
                onClick={() =>
                  runOperation(
                    { kind: 'revert', hash: state.details?.hash ?? '' },
                    state.detailsRepositoryId,
                  )
                }
              >
                Revert
              </button>
            </div>
          </div>
          <div className="details-meta">
            <span>Author: {state.details.authorName} &lt;{state.details.authorEmail}&gt;</span>
            <span>Authored: {formatCommitDate(state.details.authorTime)}</span>
            <span>
              Committer: {state.details.committerName} &lt;{state.details.committerEmail}&gt;
            </span>
            <span>Committed: {formatCommitDate(state.details.commitTime)}</span>
            <span className="details-hash">
              <code>{state.details.hash}</code>
              <button
                type="button"
                aria-label="Copy full commit hash"
                disabled={detailsHashCopyState === 'copying'}
                onClick={() => {
                  const copyRequestId = requestId('copy-hash');
                  detailsHashCopyRequest.current = copyRequestId;
                  if (detailsHashCopyTimer.current !== undefined) {
                    window.clearTimeout(detailsHashCopyTimer.current);
                    detailsHashCopyTimer.current = undefined;
                  }
                  setDetailsHashCopyState('copying');
                  send({
                    type: 'copyToClipboard',
                    requestId: copyRequestId,
                    text: state.details?.hash ?? '',
                  });
                }}
              >
                {detailsHashCopyState === 'copying'
                  ? 'Copying…'
                  : detailsHashCopyState === 'copied'
                    ? 'Copied'
                    : 'Copy'}
              </button>
            </span>
            {state.details.parents.length ? (
              <span className="details-parents">
                Parents:{' '}
                {state.details.parents.map((parent) => (
                  <button
                    type="button"
                    aria-label={`Parent ${parent}`}
                    title={parent}
                    key={parent}
                    onClick={() => selectHash(parent, 'parent')}
                  >
                    {parent.slice(0, 8)}
                  </button>
                ))}
              </span>
            ) : (
              <span>Parents: root commit</span>
            )}
            {state.details.refs.length ? (
              <span className="details-refs">
                Refs: {state.details.refs.map((ref) => <span key={ref.fullName}>{ref.shortName}</span>)}
              </span>
            ) : null}
            <span>Signature: {state.details.signature}</span>
          </div>
          <div className="details-body">
            {state.details.body
              .split(/\r?\n/u)
              .filter((line, index) => index > 0 && line.length > 0)
              .map((line, index) => (
                <p key={`${String(index)}:${line}`}>{line}</p>
              ))}
          </div>
        </div>
      ) : (
        <>
          <div className="details-heading-row">
            <div className="details-message">Commit Details</div>
            <div className="details-actions" role="toolbar" aria-label="Commit actions">
              {detailsPlacementButton}
            </div>
          </div>
          <div className="details-placeholder">Select a commit to view its message and metadata.</div>
        </>
      )}
    </section>
  );

  return (
    <main
      className={`workbench-shell${detailsInChanges ? ' details-in-changes' : ''}`}
      style={{
        gridTemplateRows: detailsInChanges
          ? 'minmax(0, 1fr)'
          : `minmax(0, 1fr) 4px ${state.layout.detailsHeight}px`,
      }}
      onKeyDown={handleWorkbenchKeyDown}
      onWheelCapture={(event) => {
        const target = event.target;
        if (
          !contextMenu ||
          (target instanceof Element && target.closest('.context-menu'))
        ) {
          return;
        }
        setContextMenu(undefined);
      }}
      onScrollCapture={(event) => {
        const target = event.target;
        if (
          !contextMenu ||
          (target instanceof Element && target.closest('.context-menu'))
        ) {
          return;
        }
        setContextMenu(undefined);
      }}
    >
      {globalToolbar}
      {state.error ? (
        <div className="error-banner" role="alert">
          <span>{state.error}</span>
          <span className="error-actions">
            {state.errorRecovery?.action.kind === 'forceDeleteBranch' ? (
              <button
                type="button"
                className="warning-action"
                aria-label={`Force delete branch ${state.errorRecovery.action.branch}`}
                title="Delete this branch even though it contains unmerged commits"
                onClick={() =>
                  runOperation(
                    {
                      kind: 'deleteBranch',
                      name: state.errorRecovery?.action.branch ?? '',
                      force: true,
                    },
                    state.errorRecovery?.repositoryId,
                  )
                }
              >
                Force Delete
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Retry Git query"
              onClick={() =>
                send({
                  type: 'refresh',
                  requestId: requestId('retry'),
                  ...(state.selectedRepositoryId ? { repositoryId: state.selectedRepositoryId } : {}),
                })
              }
            >
              Retry
            </button>
            <button
              type="button"
              aria-label="Show Git output"
              onClick={() => send({ type: 'showOutput', requestId: requestId('output') })}
            >
              Show Output
            </button>
            <button
              type="button"
              aria-label="Copy diagnostic"
              onClick={() =>
                send({ type: 'copyToClipboard', requestId: requestId('diagnostic'), text: state.error ?? '' })
              }
            >
              Copy
            </button>
          </span>
        </div>
      ) : null}

      <section
        className="workspace-grid"
        style={{
          // The side panes are always shown; in a narrow panel they shrink instead of hiding.
          gridTemplateColumns: `min(${String(state.layout.refsWidth)}px, 26%) 1px minmax(240px, 1fr) 1px min(${String(
            state.layout.filesWidth,
          )}px, 32%)`,
        }}
      >
        <nav
          className="refs-pane pane"
          aria-label="Git references"
        >
          <div className="refs-toolbar">
            <label className="refs-search-bar field">
              <span className="search-icon" aria-hidden="true">
                ⌕
              </span>
              <input
                type="search"
                aria-label="Filter branches"
                placeholder="Filter branches"
                value={refSearch}
                onChange={(event) => setRefSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape' || !refSearch) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setRefSearch('');
                }}
              />
            </label>
          </div>
          <div className="pane-heading">Branches</div>
          <div className="refs-scroll">
            <section className="ref-group">
              <button
                type="button"
                className="ref-group-heading"
                aria-expanded={refSearchActive || !collapsedRefGroups.has('head')}
                disabled={refSearchActive}
                onClick={() => toggleRefGroup('head')}
              >
                <span aria-hidden="true">
                  {!refSearchActive && collapsedRefGroups.has('head') ? '›' : '⌄'}
                </span>
                <span>HEAD</span>
              </button>
              {selectedRepository?.head &&
              headMatchesRefSearch &&
              (refSearchActive || !collapsedRefGroups.has('head')) ? (
                <button
                  type="button"
                  className="ref-item current-ref"
                  title={selectedRepository.head}
                  data-ref-item="true"
                  onClick={() => {
                    const headRef: RefLabel = {
                      fullName: 'HEAD',
                      shortName: selectedRepository.currentBranch ?? selectedRepository.head?.slice(0, 8) ?? 'HEAD',
                      kind: 'local',
                      target: selectedRepository.head ?? '',
                      ahead: 0,
                      behind: 0,
                      isCurrent: true,
                    };
                    selectRef(headRef);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (!state.selectedRepositoryId || !selectedRepository.head) return;
                    setContextMenu({
                      kind: 'head',
                      repositoryId: state.selectedRepositoryId,
                      hash: selectedRepository.head,
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                >
                  <span className="ref-icon" aria-hidden="true">
                    ●
                  </span>
                  <span>{selectedRepository.currentBranch ?? selectedRepository.head.slice(0, 8)}</span>
                </button>
              ) : null}
            </section>
            {refGroupTrees.map(({ group, refs, tree }) => {
              const collapsed = !refSearchActive && collapsedRefGroups.has(group.kind);
              return (
                <section className="ref-group" key={group.kind}>
                  <button
                    type="button"
                    className="ref-group-heading"
                    aria-expanded={!collapsed}
                    disabled={refSearchActive}
                    onClick={() => toggleRefGroup(group.kind)}
                  >
                    <span aria-hidden="true">{collapsed ? '›' : '⌄'}</span>
                    <span>{group.label}</span>
                    <span className="ref-count">{refs.length}</span>
                  </button>
                  {!collapsed ? (
                    <RefTreeNodes
                      nodes={tree}
                      depth={0}
                      group={group}
                      folderKeyPrefix={`${state.selectedRepositoryId ?? ''}:${group.kind}`}
                      collapsedFolders={collapsedRefFolders}
                      forceExpanded={refSearchActive}
                      onToggleFolder={toggleRefFolder}
                      onSelect={selectRef}
                      onKeyDown={handleRefKeyDown}
                      onContextMenu={(ref, x, y) => {
                        if (!state.selectedRepositoryId) return;
                        setContextMenu({
                          kind: 'ref',
                          repositoryId: state.selectedRepositoryId,
                          ref,
                          x,
                          y,
                        });
                      }}
                    />
                  ) : null}
                </section>
              );
            })}
          </div>
        </nav>

        <div
          className="pane-resizer vertical refs-resizer"
          role="separator"
          aria-label="Resize references pane"
          aria-orientation="vertical"
          aria-valuemin={160}
          aria-valuenow={state.layout.refsWidth}
          tabIndex={0}
          onPointerDown={(event) => beginResize('refsWidth', event)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') resizeLayout('refsWidth', -10);
            if (event.key === 'ArrowRight') resizeLayout('refsWidth', 10);
          }}
        />

        <section
          ref={logRef}
          className={`log-pane pane${
            selectedRepository?.operationState === 'rebase' ? ' rebase-active' : ''
          }`}
          role="grid"
          aria-label="Commit log"
          tabIndex={0}
          style={
            {
              '--refs-column-width': `${String(state.layout.refsColumnWidth ?? 150)}px`,
              '--author-column-width': `${String(state.layout.authorColumnWidth ?? 130)}px`,
              '--date-column-width': `${String(state.layout.dateColumnWidth ?? 125)}px`,
              '--log-content-width': `${String(logContentWidth)}px`,
              userSelect: 'none',
              '--log-grid-columns': `${
                state.layout.commitColumnWidth
                  ? `${String(state.layout.commitColumnWidth)}px`
                  : 'minmax(260px, 1fr)'
              } ${String(state.layout.authorColumnWidth ?? 130)}px ${String(
                state.layout.dateColumnWidth ?? 125,
              )}px ${String(state.layout.refsColumnWidth ?? 150)}px`,
            } as CSSProperties
          }
        >
          {commitToolbar}
          {selectedRepository?.operationState && isSequencerState(selectedRepository.operationState) ? (
            <div
              className="rebase-status-row"
              role="toolbar"
              aria-label={`${selectedRepository.operationState === 'rebase' ? 'Rebase' : selectedRepository.operationState === 'revert' ? 'Revert' : 'Cherry-pick'} in progress`}
            >
              <button
                className="operation-badge"
                type="button"
                aria-label="Open Source Control"
                title="Open Source Control"
                onClick={() =>
                  send({
                    type: 'openSourceControl',
                    requestId: requestId('source-control'),
                  })
                }
              >
                {operationStateLabel(selectedRepository.operationState)}
              </button>
              <div className="rebase-actions" role="group" aria-label="Rebase actions">
                <button
                  className="rebase-action-button rebase-continue-button"
                  type="button"
                  disabled={
                    selectedOperationInFlight ||
                    Boolean(selectedRepository.hasUnresolvedConflicts)
                  }
                  title={
                    selectedRepository.hasUnresolvedConflicts
                      ? `Resolve all conflicts before continuing the ${selectedRepository.operationState}`
                      : `Continue ${selectedRepository.operationState}`
                  }
                  onClick={() => runOperation({ kind: 'rebaseContinue' })}
                >
                  Continue
                </button>
                <button
                  className="rebase-action-button"
                  type="button"
                  disabled={selectedOperationInFlight}
                  onClick={() => runOperation({ kind: 'rebaseSkip' })}
                >
                  Skip
                </button>
                <button
                  className="rebase-action-button"
                  type="button"
                  disabled={selectedOperationInFlight}
                  onClick={() => runOperation({ kind: 'rebaseAbort' })}
                >
                  Abort
                </button>
              </div>
            </div>
          ) : null}
          <div className="log-header-viewport">
            <div className="log-header" role="row" ref={logHeaderRef}>
              <span className="column-header" role="columnheader">
                Commit
                <div
                  className="column-resizer"
                  role="separator"
                  aria-label="Resize commit column"
                  aria-orientation="vertical"
                  aria-valuemin={160}
                  aria-valuenow={state.layout.commitColumnWidth}
                  aria-valuetext={
                    state.layout.commitColumnWidth === undefined ? 'Auto width' : undefined
                  }
                  tabIndex={0}
                  onPointerDown={(event) =>
                    beginColumnResize(
                      'commitColumnWidth',
                      event,
                      event.currentTarget.parentElement?.getBoundingClientRect().width,
                    )
                  }
                  onKeyDown={(event) => {
                    const measuredWidth =
                      event.currentTarget.parentElement?.getBoundingClientRect().width;
                    if (event.key === 'ArrowLeft') {
                      resizeColumn('commitColumnWidth', -10, measuredWidth);
                    }
                    if (event.key === 'ArrowRight') {
                      resizeColumn('commitColumnWidth', 10, measuredWidth);
                    }
                  }}
                />
              </span>
              <span className="column-header" role="columnheader">
                Author
                <div
                  className="column-resizer"
                  role="separator"
                  aria-label="Resize author column"
                  aria-orientation="vertical"
                  aria-valuenow={state.layout.authorColumnWidth ?? 130}
                  tabIndex={0}
                  onPointerDown={(event) => beginColumnResize('authorColumnWidth', event)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowLeft') resizeColumn('authorColumnWidth', -10);
                    if (event.key === 'ArrowRight') resizeColumn('authorColumnWidth', 10);
                  }}
                />
              </span>
              <span className="column-header" role="columnheader">
                Date
                <div
                  className="column-resizer"
                  role="separator"
                  aria-label="Resize date column"
                  aria-orientation="vertical"
                  aria-valuenow={state.layout.dateColumnWidth ?? 125}
                  tabIndex={0}
                  onPointerDown={(event) => beginColumnResize('dateColumnWidth', event)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowLeft') resizeColumn('dateColumnWidth', -10);
                    if (event.key === 'ArrowRight') resizeColumn('dateColumnWidth', 10);
                  }}
                />
              </span>
              <span className="column-header" role="columnheader">
                Refs
                <div
                  className="column-resizer"
                  role="separator"
                  aria-label="Resize refs column"
                  aria-orientation="vertical"
                  aria-valuenow={state.layout.refsColumnWidth ?? 150}
                  tabIndex={0}
                  onPointerDown={(event) => beginColumnResize('refsColumnWidth', event)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowLeft') resizeColumn('refsColumnWidth', -10);
                    if (event.key === 'ArrowRight') resizeColumn('refsColumnWidth', 10);
                  }}
                />
              </span>
            </div>
          </div>
          {(state.history?.entries ?? state.commits).length ? (
            <CommitList
              horizontalScrollResetKey={
                state.history
                  ? `history:${state.history.repositoryId}:${state.history.path}`
                  : `log:${state.selectedRepositoryId ?? ''}`
              }
              commits={state.history?.entries ?? state.commits}
              graphLayout={graphLayout}
              selectedHashes={selectedCommitHashSet}
              headHash={selectedRepository?.head}
              hasMore={state.history?.hasMore ?? state.hasMore}
              loading={state.loading === 'log'}
              initialScrollTop={
                state.history
                  ? 0
                  : state.selectedRepositoryId
                  ? (scrollTopByRepository[state.selectedRepositoryId] ?? 0)
                  : 0
              }
              scrollAnchorKey={
                state.history
                  ? `history:${state.history.repositoryId}:${state.history.path}`
                  : `log:${state.selectedRepositoryId ?? ''}:${String(state.startLogOffset)}`
              }
              {...(!state.history && commitRevealTarget && commitRevealTarget.repositoryId === state.selectedRepositoryId
                ? {
                    revealTarget: {
                      hash: commitRevealTarget.hash,
                      requestId: commitRevealTarget.requestId,
                      listRevision: state.commitListRevision,
                      minimumListRevision: 0,
                    },
                  }
                : {})}
              onScrollTopChange={handleCommitScrollTopChange}
              onHorizontalScroll={syncLogHeaderScroll}
              onSelect={selectCommit}
              onContextMenu={(commit, x, y) => {
                if (state.history) return;
                if (!state.selectedRepositoryId) return;
                const commits = selectedCommitHashSet.has(commit.hash)
                  ? state.commits.filter((candidate) => selectedCommitHashSet.has(candidate.hash))
                  : [commit];
                if (!selectedCommitHashSet.has(commit.hash)) selectCommit(commit);
                setContextMenu({
                  kind: 'commit',
                  repositoryId: state.selectedRepositoryId,
                  commit,
                  commits,
                  x,
                  y,
                });
              }}
              onLoadMore={loadMore}
            />
          ) : state.loading === 'repositories' || state.loading === 'log' ? (
            <div className="skeleton-list" role="status" aria-label="Loading Git history">
              {Array.from({ length: 10 }, (_, index) => (
                <div className="commit-skeleton-row" data-testid="commit-skeleton-row" key={index}>
                  <span className="skeleton-graph" />
                  <span className="skeleton-subject" />
                  <span className="skeleton-author" />
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-log" role="row">
              <div>
                <strong>
                  {state.history
                    ? state.history.notice ?? 'No history found'
                    : state.repositories.length
                      ? 'No commits found'
                      : 'No repository selected'}
                </strong>
                <span>
                  {state.history
                    ? 'Try another line, selection, or file.'
                    : state.repositories.length
                      ? 'This repository has no commits or the current filters returned no results.'
                      : 'Open a workspace containing a Git repository.'}
                </span>
              </div>
            </div>
          )}
        </section>

        <div
          className="pane-resizer vertical files-resizer"
          role="separator"
          aria-label="Resize changed files pane"
          aria-orientation="vertical"
          aria-valuemin={220}
          aria-valuenow={state.layout.filesWidth}
          tabIndex={0}
          onPointerDown={(event) => beginResize('filesWidth', event)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') resizeLayout('filesWidth', 10);
            if (event.key === 'ArrowRight') resizeLayout('filesWidth', -10);
          }}
        />

        <section
          className={`files-pane pane${detailsInChanges ? ' with-details' : ''}`}
          role="region"
          aria-label="Changed files"
          style={
            detailsInChanges
              ? {
                  gridTemplateRows: `38px 30px minmax(0, 1fr) auto 4px ${state.layout.detailsHeight}px`,
                }
              : undefined
          }
        >
          <div className="global-toolbar-spacer" aria-hidden="true" />
          <div className="pane-heading files-heading">
            <span>Changed Files</span>
            {state.details && state.details.parents.length > 1 ? (
              <select
                className="parent-selector"
                aria-label="Diff parent"
                value={state.selectedParent ?? ''}
                onChange={(event) => {
                  const parent = event.target.value;
                  setState((current) => ({ ...current, selectedParent: parent }));
                  if (state.detailsRepositoryId && state.details) {
                    const parentRequestId = requestId('parent');
                    activeSelectionRequest.current = {
                      requestId: parentRequestId,
                      repositoryId: state.detailsRepositoryId,
                      hash: state.details.hash,
                    };
                    send({
                      type: 'selectParent',
                      requestId: parentRequestId,
                      repositoryId: state.detailsRepositoryId,
                      hash: state.details.hash,
                      parent,
                    });
                  }
                }}
              >
                {state.details.parents.map((parent, index) => (
                  <option value={parent} key={parent}>
                    Parent {String(index + 1)} · {parent.slice(0, 8)}
                  </option>
                ))}
              </select>
            ) : null}
            <span className="segmented-control" aria-label="Changed files display mode">
              <button
                type="button"
                aria-pressed={state.layout.filesViewMode === 'tree'}
                title="Tree view"
                onClick={() => updateFilesViewMode('tree')}
              >
                Tree
              </button>
              <button
                type="button"
                aria-pressed={state.layout.filesViewMode === 'list'}
                title="List view"
                onClick={() => updateFilesViewMode('list')}
              >
                List
              </button>
            </span>
          </div>
          {state.files.length ? (
            <div className="file-list">
              <div className="file-list-content">
                {state.layout.filesViewMode === 'tree' ? (
                  <FileTreeNodes
                    nodes={fileTree}
                    depth={0}
                    highlight={fileRowHighlight}
                    onOpen={openDiff}
                    onSelect={(file) => setState((current) => ({ ...current, selectedFile: file }))}
                    onContextMenu={(file, x, y) => {
                      if (!state.detailsRepositoryId) return;
                      setContextMenu({
                        kind: 'file',
                        repositoryId: state.detailsRepositoryId,
                        file,
                        x,
                        y,
                      });
                    }}
                  />
                ) : (
                  state.files.map((file) => (
                    <ChangedFileRow
                      file={file}
                      highlight={fileRowHighlight}
                      onOpen={openDiff}
                      onSelect={(selectedFile) =>
                        setState((current) => ({ ...current, selectedFile }))
                      }
                      onContextMenu={(selectedFile, x, y) => {
                        if (!state.detailsRepositoryId) return;
                        setContextMenu({
                          kind: 'file',
                          repositoryId: state.detailsRepositoryId,
                          file: selectedFile,
                          x,
                          y,
                        });
                      }}
                      key={`${file.oldPath ?? ''}:${file.path}`}
                    />
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className="empty-pane">
              {state.loading === 'selection' ? 'Loading changed files…' : 'Select a commit to inspect its files.'}
            </div>
          )}
          {state.selectedFile ? (
            <div className="file-preview" role="status" aria-label="Changed file preview">
              <span>{state.selectedFile.path}</span>
              <span> · {changedFileStatusLabel(state.selectedFile.status)}</span>
              {state.selectedFile.additions !== undefined ? (
                <span className="file-stat-additions">
                  {' '}· +{String(state.selectedFile.additions)}
                </span>
              ) : null}
              {state.selectedFile.deletions !== undefined ? (
                <span className="file-stat-deletions">
                  {' '}−{String(state.selectedFile.deletions)}
                </span>
              ) : null}
            </div>
          ) : null}
          {detailsInChanges ? commitDetailsResizer : null}
          {detailsInChanges ? commitDetailsPane : null}
        </section>
      </section>

      {selectedOperationInFlight ? (
        <div className="operation-status" role="status" aria-live="polite">
          Running Git operation…
        </div>
      ) : null}

      {!detailsInChanges ? commitDetailsResizer : null}
      {!detailsInChanges ? commitDetailsPane : null}

      {contextMenu ? (
        <div
          ref={contextMenuRef}
          className="context-menu"
          role="menu"
          aria-label={`${contextMenu.kind} actions`}
          style={
            measuredContextMenuPosition ?? contextMenuPosition(contextMenu.x, contextMenu.y)
          }
          onClick={(event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            const menuItem = target.closest<HTMLButtonElement>('button[role="menuitem"]');
            if (menuItem && !menuItem.disabled) setContextMenu(undefined);
          }}
        >
          {contextMenu.kind === 'commit' ? (
            <>
              {hasContiguousCommitRange &&
              !selectedRepository?.isBare &&
              !selectedRepository?.operationState ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={
                      !selectedRepository?.currentBranch ||
                      selectedOperationInFlight ||
                      contextMenu.commits.length > 100
                    }
                    title={
                      contextMenu.commits.length > 100
                        ? 'Select no more than 100 commits'
                        : undefined
                    }
                    onClick={() =>
                      runOperation(
                        {
                          kind: 'dropCommits',
                          hashes: contextMenu.commits.map((commit) => commit.hash),
                        },
                        contextMenu.repositoryId,
                      )
                    }
                  >
                    Drop commits…
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={
                      !selectedRepository?.currentBranch ||
                      selectedOperationInFlight ||
                      contextMenu.commits.length > 100
                    }
                    title={
                      contextMenu.commits.length > 100
                        ? 'Select no more than 100 commits'
                        : undefined
                    }
                    onClick={() => {
                      const hashes = contextMenu.commits.map((commit) => commit.hash);
                      const messageRequestId = requestId('commit-messages');
                      activeCommitMessagesRequest.current = messageRequestId;
                      setSquashOperation({
                        repositoryId: contextMenu.repositoryId,
                        hashes,
                        requestId: messageRequestId,
                        message: '',
                        loading: true,
                      });
                      send({
                        type: 'requestCommitMessages',
                        requestId: messageRequestId,
                        repositoryId: contextMenu.repositoryId,
                        hashes,
                      });
                      setContextMenu(undefined);
                    }}
                  >
                    Squash commits…
                  </button>
                </>
              ) : null}
              <button
                type="button"
                role="menuitem"
                disabled={!contextMenu.commit.parents[0]}
                title={contextMenu.commit.parents[0] ? 'Open all changed text files' : 'Root commit has no parent'}
                onClick={() =>
                  openCommitComparison(
                    contextMenu.commit.hash,
                    'parent',
                    contextMenu.commit.parents[0],
                  )
                }
              >
                Compare with Parent
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!selectedRepository?.head || selectedRepository.head === contextMenu.commit.hash}
                title="Compare this commit with the current HEAD"
                onClick={() => openCommitComparison(contextMenu.commit.hash, 'current')}
              >
                Compare with Current
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={selectedRepository?.isBare}
                title="Compare this commit with the working tree; the local side is editable"
                onClick={() =>
                  runWorkbenchCommand({ kind: 'compareWithLocal', hash: contextMenu.commit.hash }, contextMenu.repositoryId)
                }
              >
                Compare with Local
              </button>
              <button
                type="button"
                role="menuitem"
                title="Save or copy the selected commits as a patch (git format-patch)"
                onClick={() =>
                  runWorkbenchCommand(
                    { kind: 'createPatch', hashes: contextMenu.commits.map((commit) => commit.hash) },
                    contextMenu.repositoryId,
                  )
                }
              >
                Create Patch…
              </button>
              {contextMenu.commits.length === 1 && !selectedRepository?.isBare && !selectedRepository?.operationState ? (
                <>
                  <div className="context-menu-separator" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    disabled={selectedOperationInFlight || contextMenu.commit.parents.length > 1}
                    title="Change the message of this commit and recreate newer commits"
                    onClick={() =>
                      runWorkbenchCommand(
                        { kind: 'openRebaseDialog', hash: contextMenu.commit.hash, mode: 'reword' },
                        contextMenu.repositoryId,
                      )
                    }
                  >
                    Edit Commit Message…
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    title="Prepare a fixup! commit for this commit in the Commit view"
                    onClick={() =>
                      runWorkbenchCommand({ kind: 'prepareFixup', hash: contextMenu.commit.hash, squash: false }, contextMenu.repositoryId)
                    }
                  >
                    Fixup…
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    title="Prepare a squash! commit for this commit in the Commit view"
                    onClick={() =>
                      runWorkbenchCommand({ kind: 'prepareFixup', hash: contextMenu.commit.hash, squash: true }, contextMenu.repositoryId)
                    }
                  >
                    Squash Into…
                  </button>
                  {selectedRepository?.head === contextMenu.commit.hash && contextMenu.commit.parents.length === 1 ? (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={selectedOperationInFlight}
                      title="Remove this commit and keep its changes staged, with its message in the Commit view"
                      onClick={() =>
                        runOperation({ kind: 'undoCommit', hash: contextMenu.commit.hash }, contextMenu.repositoryId)
                      }
                    >
                      Undo Commit
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    disabled={selectedOperationInFlight}
                    title="Reorder, reword, squash, fixup, edit, or drop this commit and newer ones"
                    onClick={() =>
                      runWorkbenchCommand(
                        { kind: 'openRebaseDialog', hash: contextMenu.commit.hash, mode: 'interactive' },
                        contextMenu.repositoryId,
                      )
                    }
                  >
                    Interactively Rebase from Here…
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={selectedOperationInFlight}
                    title="Push this commit and its ancestors without pushing newer commits"
                    onClick={() =>
                      runWorkbenchCommand({ kind: 'openPushDialog', source: contextMenu.commit.hash }, contextMenu.repositoryId)
                    }
                  >
                    Push All up to Here…
                  </button>
                  <div className="context-menu-separator" role="separator" />
                </>
              ) : null}
              {!selectedRepository?.isBare && !selectedRepository?.operationState ? (
                <>
              {contextMenu.commits.length === 1 ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={selectedOperationInFlight}
                    title="Check out this commit in detached HEAD state"
                    onClick={() =>
                      runOperation(
                        { kind: 'checkout', ref: contextMenu.commit.hash },
                        contextMenu.repositoryId,
                      )
                    }
                  >
                    Checkout Revision
                  </button>
                  {selectedRepository?.head === contextMenu.commit.hash &&
                  selectedRepository.currentBranch ? (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={selectedOperationInFlight}
                      onClick={() => {
                        setAmendDialog({
                          repositoryId: contextMenu.repositoryId,
                          message: contextMenu.commit.subject,
                        });
                        setContextMenu(undefined);
                      }}
                    >
                      Amend HEAD…
                    </button>
                  ) : null}
                </>
              ) : null}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setNamedOperation({
                    kind: 'createBranch',
                    repositoryId: contextMenu.repositoryId,
                    target: contextMenu.commit.hash,
                    value: '',
                  });
                  setContextMenu(undefined);
                }}
              >
                New Branch…
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setNamedOperation({
                    kind: 'createTag',
                    repositoryId: contextMenu.repositoryId,
                    target: contextMenu.commit.hash,
                    value: '',
                  });
                  setContextMenu(undefined);
                }}
              >
                New Tag…
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  runOperation(
                    { kind: 'cherryPick', hash: contextMenu.commit.hash },
                    contextMenu.repositoryId,
                  )
                }
              >
                Cherry-pick
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  runOperation(
                    { kind: 'revert', hash: contextMenu.commit.hash },
                    contextMenu.repositoryId,
                  )
                }
              >
                Revert
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={
                  !selectedRepository?.currentBranch ||
                  selectedRepository.head === contextMenu.commit.hash
                }
                onClick={() =>
                  runOperation(
                    { kind: 'merge', ref: contextMenu.commit.hash },
                    contextMenu.repositoryId,
                  )
                }
              >
                Merge into Current
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={
                  !selectedRepository?.currentBranch ||
                  selectedRepository.head === contextMenu.commit.hash
                }
                onClick={() =>
                  runOperation(
                    { kind: 'rebase', ref: contextMenu.commit.hash },
                    contextMenu.repositoryId,
                  )
                }
              >
                Rebase Current onto This
              </button>
              {selectedRepository?.currentBranch
                ? (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() =>
                        runOperation(
                          { kind: 'reset', mode: 'soft', hash: contextMenu.commit.hash },
                          contextMenu.repositoryId,
                        )
                      }
                    >
                      Soft Reset
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() =>
                        runOperation(
                          { kind: 'reset', mode: 'mixed', hash: contextMenu.commit.hash },
                          contextMenu.repositoryId,
                        )
                      }
                    >
                      Mixed Reset
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() =>
                        runOperation(
                          { kind: 'reset', mode: 'hard', hash: contextMenu.commit.hash },
                          contextMenu.repositoryId,
                        )
                      }
                    >
                      Hard Reset…
                    </button>
                  </>
                )
                : null}
                </>
              ) : null}
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  send({
                    type: 'copyToClipboard',
                    requestId: requestId('copy-hash'),
                    text: contextMenu.commit.hash,
                  })
                }
              >
                Copy Hash
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  send({
                    type: 'copyToClipboard',
                    requestId: requestId('copy-subject'),
                    text: contextMenu.commit.subject,
                  })
                }
              >
                Copy Subject
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={state.details?.hash !== contextMenu.commit.hash}
                title={
                  state.details?.hash === contextMenu.commit.hash
                    ? 'Copy the complete commit message'
                    : 'Select the commit first to load the full message'
                }
                onClick={() =>
                  send({
                    type: 'copyToClipboard',
                    requestId: requestId('copy-message'),
                    text: state.details?.body ?? '',
                  })
                }
              >
                Copy Full Message
              </button>
            </>
          ) : null}
          {contextMenu.kind === 'file' ? (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={contextMenu.file.binary}
                title={contextMenu.file.binary ? 'Binary files cannot be opened in the text diff editor' : undefined}
                onClick={() => {
                  openDiff(contextMenu.file);
                  setContextMenu(undefined);
                }}
              >
                Show Diff
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={
                  contextMenu.file.binary ||
                  (contextMenu.file.status === 'D' && !state.selectedParent)
                }
                title={
                  contextMenu.file.binary
                    ? 'Binary files cannot be opened in the text editor'
                    : contextMenu.file.status === 'D' && !state.selectedParent
                      ? 'The deleted file has no available parent revision'
                      : undefined
                }
                onClick={() => openFile(contextMenu.file, 'revision')}
              >
                Open File at Revision
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => openFile(contextMenu.file, 'current')}
              >
                Open Current File
              </button>
              {fileMenu ? (
                <>
                  <div className="context-menu-separator" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    disabled={fileMenu.file.binary}
                    title="Compare this revision with the working-tree file, which stays editable"
                    onClick={() =>
                      runWorkbenchCommand({ kind: 'compareWithLocal', hash: fileMenu.hash, path: fileMenu.file.path, status: fileMenu.file.status })
                    }
                  >
                    Compare with Local
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    title="Open the working-tree file (F4)"
                    disabled={fileMenu.file.status === 'D'}
                    onClick={() => runWorkbenchCommand({ kind: 'jumpToSource', path: fileMenu.file.path })}
                  >
                    Jump to Source
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => runWorkbenchCommand({ kind: 'showFileHistory', path: fileMenu.file.status === 'D' ? (fileMenu.file.oldPath ?? fileMenu.file.path) : fileMenu.file.path })}
                  >
                    Show History for File
                  </button>
                  <div className="context-menu-separator" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    disabled={fileMenu.busy}
                    title="Apply the reverse of this file's change to the working tree"
                    onClick={() =>
                      runOperation({
                        kind: 'applyFileChanges',
                        hash: fileMenu.hash,
                        ...(fileMenu.parent ? { parent: fileMenu.parent } : {}),
                        paths: fileMenu.paths,
                        reverse: true,
                      })
                    }
                  >
                    Revert Selected Changes
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={fileMenu.busy}
                    title="Apply this file's change to the working tree"
                    onClick={() =>
                      runOperation({
                        kind: 'applyFileChanges',
                        hash: fileMenu.hash,
                        ...(fileMenu.parent ? { parent: fileMenu.parent } : {}),
                        paths: fileMenu.paths,
                        reverse: false,
                      })
                    }
                  >
                    Cherry-Pick Selected Changes
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={fileMenu.busy}
                    title="Replace the local file with this revision's version"
                    onClick={() => runOperation({ kind: 'getFromRevision', hash: fileMenu.hash, paths: [fileMenu.file.path] })}
                  >
                    Get from Revision
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={fileMenu.busy || !selectedRepository?.currentBranch}
                    title="Remove this file's change from the commit and rewrite newer commits"
                    onClick={() => runOperation({ kind: 'dropFileChanges', hash: fileMenu.hash, paths: fileMenu.paths })}
                  >
                    Drop Selected Changes…
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => runWorkbenchCommand({ kind: 'createPatch', hashes: [fileMenu.hash], paths: fileMenu.paths })}
                  >
                    Create Patch…
                  </button>
                </>
              ) : null}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  send({
                    type: 'copyToClipboard',
                    requestId: requestId('copy-path'),
                    text: contextMenu.file.path,
                  });
                  setContextMenu(undefined);
                }}
              >
                Copy Path
              </button>
            </>
          ) : null}
          {contextMenu.kind === 'ref' ? (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={!selectedRepository?.head || contextMenu.ref.isCurrent}
                title={`List the commits in ${contextMenu.ref.shortName} that ${currentBranchLabel} does not have; swap from the Branch filter`}
                onClick={() => showBranchCommits(contextMenu.ref, 'notInHead')}
              >
                Compare with Current
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!selectedRepository?.head || selectedRepository.head === contextMenu.ref.target}
                title={`Files that differ between ${contextMenu.ref.shortName} and ${currentBranchLabel}`}
                onClick={() => openCommitComparison(contextMenu.ref.target, 'current')}
              >
                Show Diff with Current
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={selectedRepository?.isBare}
                title="Compare this branch with the working tree"
                onClick={() => runWorkbenchCommand({ kind: 'compareWithLocal', hash: contextMenu.ref.target })}
              >
                Show Diff with Working Tree
              </button>
              {!selectedRepository?.isBare && !selectedRepository?.operationState ? (
                <>
                  {contextMenu.ref.kind === 'local' && !contextMenu.ref.isCurrent && selectedRepository?.currentBranch ? (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={selectedOperationInFlight}
                      title={`git rebase ${selectedRepository.currentBranch} ${contextMenu.ref.shortName}`}
                      onClick={() => runOperation({ kind: 'checkoutAndRebase', branch: contextMenu.ref.shortName })}
                    >
                      Checkout and Rebase onto Current
                    </button>
                  ) : null}
                  {contextMenu.ref.kind === 'remote' && contextMenu.ref.remote && selectedRepository?.currentBranch ? (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={selectedOperationInFlight}
                        onClick={() =>
                          runOperation({
                            kind: 'pullFrom',
                            remote: contextMenu.ref.remote ?? '',
                            branch: contextMenu.ref.shortName.slice((contextMenu.ref.remote ?? '').length + 1),
                            rebase: true,
                          })
                        }
                      >
                        Pull into Current Using Rebase
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={selectedOperationInFlight}
                        onClick={() =>
                          runOperation({
                            kind: 'pullFrom',
                            remote: contextMenu.ref.remote ?? '',
                            branch: contextMenu.ref.shortName.slice((contextMenu.ref.remote ?? '').length + 1),
                            rebase: false,
                          })
                        }
                      >
                        Pull into Current Using Merge
                      </button>
                    </>
                  ) : null}
                  {contextMenu.ref.kind === 'local' && !contextMenu.ref.isCurrent ? (
                    refUpstream ? (
                        <button
                          type="button"
                          role="menuitem"
                          disabled={selectedOperationInFlight}
                          title={`Fast-forward ${contextMenu.ref.shortName} to ${refUpstream.remote}/${refUpstream.branch} without checking it out`}
                          onClick={() =>
                            runOperation({
                              kind: 'updateBranch',
                              remote: refUpstream.remote,
                              remoteBranch: refUpstream.branch,
                              localBranch: contextMenu.ref.shortName,
                            })
                          }
                        >
                          Update
                        </button>
                    ) : null
                  ) : null}
                </>
              ) : null}
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  send({
                    type: 'copyToClipboard',
                    requestId: requestId('copy-ref'),
                    text: contextMenu.ref.shortName,
                  })
                }
              >
                Copy Name
              </button>
              {!selectedRepository?.isBare && !selectedRepository?.operationState ? (
                <>
                  {contextMenu.ref.kind === 'local' ? (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={contextMenu.ref.isCurrent}
                      onClick={() =>
                        runOperation(
                          { kind: 'checkout', ref: contextMenu.ref.shortName },
                          contextMenu.repositoryId,
                        )
                      }
                    >
                      Checkout
                    </button>
                  ) : null}
                  {contextMenu.ref.kind === 'remote' &&
                  contextMenu.ref.remote &&
                  !contextMenu.ref.shortName.endsWith('/HEAD') ? (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          const remote = contextMenu.ref.remote;
                          if (!remote) return;
                          const branch = contextMenu.ref.shortName.slice(remote.length + 1);
                          setNamedOperation({
                            kind: 'checkoutRemote',
                            repositoryId: contextMenu.repositoryId,
                            startPoint: contextMenu.ref.shortName,
                            value: branch,
                          });
                          setContextMenu(undefined);
                        }}
                      >
                        Checkout as New Local…
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={selectedOperationInFlight}
                        title="Check out this remote branch in detached HEAD state without creating a local branch"
                        onClick={() =>
                          runOperation(
                            { kind: 'checkoutDetached', ref: contextMenu.ref.fullName },
                            contextMenu.repositoryId,
                          )
                        }
                      >
                        Checkout (Detached HEAD)
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          const remote = contextMenu.ref.remote;
                          if (!remote) return;
                          runOperation(
                            { kind: 'fetch', remote },
                            contextMenu.repositoryId,
                          )
                        }}
                      >
                        Fetch
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          const remote = contextMenu.ref.remote;
                          if (!remote) return;
                          const branch = contextMenu.ref.shortName.slice(remote.length + 1);
                          runOperation(
                            { kind: 'deleteRemoteBranch', remote, branch },
                            contextMenu.repositoryId,
                          );
                        }}
                      >
                        Delete Remote Branch…
                      </button>
                    </>
                  ) : null}
                  {contextMenu.ref.kind === 'tag' ? (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() =>
                          runOperation(
                            { kind: 'checkout', ref: contextMenu.ref.fullName },
                            contextMenu.repositoryId,
                          )
                        }
                      >
                        Checkout
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() =>
                          runOperation(
                            { kind: 'deleteTag', name: contextMenu.ref.shortName },
                            contextMenu.repositoryId,
                          )
                        }
                      >
                        Delete Local Tag…
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setNamedOperation({
                        kind: 'createBranch',
                        repositoryId: contextMenu.repositoryId,
                        target: contextMenu.ref.fullName,
                        value: '',
                      });
                      setContextMenu(undefined);
                    }}
                  >
                    New Branch from…
                  </button>
                  {contextMenu.ref.kind === 'local' || contextMenu.ref.kind === 'remote' ? (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={!selectedRepository?.currentBranch || contextMenu.ref.isCurrent}
                        onClick={() =>
                          runOperation(
                            { kind: 'merge', ref: contextMenu.ref.shortName },
                            contextMenu.repositoryId,
                          )
                        }
                      >
                        Merge into Current
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={!selectedRepository?.currentBranch || contextMenu.ref.isCurrent}
                        onClick={() =>
                          runOperation(
                            { kind: 'rebase', ref: contextMenu.ref.shortName },
                            contextMenu.repositoryId,
                          )
                        }
                      >
                        Rebase Current onto
                      </button>
                    </>
                  ) : null}
                  {contextMenu.ref.kind === 'local' ? (
                    <>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!contextMenu.ref.isCurrent}
                    title={contextMenu.ref.isCurrent ? 'Push the current branch' : 'Checkout this branch before pushing it'}
                    onClick={() => runOperation({ kind: 'push' }, contextMenu.repositoryId)}
                  >
                    Push
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setNamedOperation({
                        kind: 'renameBranch',
                        repositoryId: contextMenu.repositoryId,
                        oldName: contextMenu.ref.shortName,
                        value: contextMenu.ref.shortName,
                      });
                      setContextMenu(undefined);
                    }}
                  >
                    Rename…
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={contextMenu.ref.isCurrent}
                    onClick={() =>
                      runOperation(
                        { kind: 'deleteBranch', name: contextMenu.ref.shortName, force: false },
                        contextMenu.repositoryId,
                      )
                    }
                  >
                    Delete…
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={contextMenu.ref.isCurrent}
                    title="Delete this branch even if it is not fully merged"
                    onClick={() =>
                      runOperation(
                        { kind: 'deleteBranch', name: contextMenu.ref.shortName, force: true },
                        contextMenu.repositoryId,
                      )
                    }
                  >
                    Force Delete…
                  </button>
                    </>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
          {contextMenu.kind === 'head' ? (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  send({
                    type: 'copyToClipboard',
                    requestId: requestId('copy-head'),
                    text: contextMenu.hash,
                  });
                  setContextMenu(undefined);
                }}
              >
                Copy Revision
              </button>
              {!selectedRepository?.isBare && !selectedRepository?.operationState ? (
                <>
                  {!selectedRepository?.currentBranch ? (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={selectedOperationInFlight}
                        title="Push the current HEAD to a remote branch"
                        onClick={() => openPushHead(contextMenu.repositoryId)}
                      >
                        Push HEAD…
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={selectedOperationInFlight}
                        title="Switch to the previous checkout (git switch -)"
                        onClick={() => runOperation({ kind: 'switchPrevious' }, contextMenu.repositoryId)}
                      >
                        Switch Back
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={selectedOperationInFlight}
                        title="Create a new branch at the current HEAD and switch to it"
                        onClick={() => {
                          setNamedOperation({
                            kind: 'createAndCheckoutBranch',
                            repositoryId: contextMenu.repositoryId,
                            value: '',
                          });
                          setContextMenu(undefined);
                        }}
                      >
                        Create Branch and Checkout…
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setNamedOperation({
                        kind: 'createBranch',
                        repositoryId: contextMenu.repositoryId,
                        target: contextMenu.hash,
                        value: '',
                      });
                      setContextMenu(undefined);
                    }}
                  >
                    Create Branch…
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setNamedOperation({
                        kind: 'createTag',
                        repositoryId: contextMenu.repositoryId,
                        target: contextMenu.hash,
                        value: '',
                      });
                      setContextMenu(undefined);
                    }}
                  >
                    Create Tag…
                  </button>
                  {selectedRepository?.currentBranch
                    ? (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() =>
                            runOperation(
                              { kind: 'reset', mode: 'soft', hash: contextMenu.hash },
                              contextMenu.repositoryId,
                            )
                          }
                        >
                          Reset Current Branch (soft)
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() =>
                            runOperation(
                              { kind: 'reset', mode: 'mixed', hash: contextMenu.hash },
                              contextMenu.repositoryId,
                            )
                          }
                        >
                          Reset Current Branch (mixed)
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() =>
                            runOperation(
                              { kind: 'reset', mode: 'hard', hash: contextMenu.hash },
                              contextMenu.repositoryId,
                            )
                          }
                        >
                          Reset Current Branch (hard)…
                        </button>
                      </>
                    )
                    : null}
                </>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {stashDialog ? (
        <div className="operation-dialog-backdrop">
          <div
            className="operation-dialog stash-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Stash management"
          >
            <button
              className="stash-dialog-close"
              type="button"
              aria-label="Close stash manager"
              title="Close"
              onClick={() => {
                stashDialogRepository.current = undefined;
                setStashDialog(undefined);
              }}
            >
              <span aria-hidden="true">×</span>
            </button>
            <strong>Stashes</strong>
            <section className="stash-tool-section">
              <span>Stash changes</span>
              <input
                className="stash-message-input"
                aria-label="Stash message"
                placeholder="Optional stash message"
                value={stashDialog.stashMessage}
                disabled={Boolean(selectedRepository?.operationState)}
                onChange={(event) =>
                  setStashDialog((current) =>
                    current ? { ...current, stashMessage: event.target.value } : current,
                  )
                }
              />
              <div className="stash-create-actions">
                <label className="stash-checkbox">
                  <input
                    type="checkbox"
                    checked={stashDialog.includeUntracked}
                    disabled={Boolean(selectedRepository?.operationState)}
                    onChange={(event) =>
                      setStashDialog((current) =>
                        current ? { ...current, includeUntracked: event.target.checked } : current,
                      )
                    }
                  />
                  <span>Include untracked files</span>
                </label>
                <button
                  className="stash-submit-button"
                  type="button"
                  disabled={Boolean(selectedRepository?.operationState) || selectedOperationInFlight}
                  onClick={() =>
                    runOperation(
                      {
                        kind: 'createStash',
                        message: stashDialog.stashMessage,
                        includeUntracked: stashDialog.includeUntracked,
                      },
                      stashDialog.repositoryId,
                    )
                  }
                >
                  Stash
                </button>
              </div>
              {stashDialog.loading ? <span>Loading…</span> : null}
              {stashDialog.stashes.map((stash) => {
                const label = parseStashSubject(stash.subject);
                return (
                <div className="stash-tool-row" key={stash.ref}>
                  <span className="stash-message" title={stash.subject}>
                    {label.message || stash.ref}
                  </span>
                  <span
                    className="stash-meta"
                    title={`${stash.ref} · ${new Date(stash.timestamp * 1000).toLocaleString()}`}
                  >
                    <span className="stash-branch">{label.branch ?? 'detached HEAD'}</span>
                    <span className="stash-time">{formatCommitDate(stash.timestamp)}</span>
                  </span>
                  <button
                    type="button"
                    aria-label={`Show changes for ${stash.ref}`}
                    onClick={() =>
                      send({
                        type: 'openStashComparison',
                        requestId: requestId('stash-diff'),
                        repositoryId: stashDialog.repositoryId,
                        hash: stash.hash,
                      })
                    }
                  >
                    Show Changes
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(selectedRepository?.operationState) || selectedOperationInFlight}
                    onClick={() =>
                      runOperation(
                        { kind: 'applyStash', stash: stash.ref },
                        stashDialog.repositoryId,
                      )
                    }
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(selectedRepository?.operationState) || selectedOperationInFlight}
                    onClick={() =>
                      runOperation(
                        { kind: 'popStash', stash: stash.ref },
                        stashDialog.repositoryId,
                      )
                    }
                  >
                    Pop
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(selectedRepository?.operationState) || selectedOperationInFlight}
                    onClick={() =>
                      runOperation(
                        { kind: 'dropStash', stash: stash.ref },
                        stashDialog.repositoryId,
                      )
                    }
                  >
                    Drop…
                  </button>
                </div>
                );
              })}
            </section>
          </div>
        </div>
      ) : null}

      {amendDialog ? (
        <div className="operation-dialog-backdrop">
          <div className="operation-dialog" role="dialog" aria-modal="true" aria-label="Amend HEAD">
            <strong>Amend HEAD</strong>
            <span>Currently staged changes will be included in the amended commit.</span>
            <textarea
              aria-label="Amend commit message"
              value={amendDialog.message}
              onChange={(event) =>
                setAmendDialog((current) =>
                  current ? { ...current, message: event.target.value } : current,
                )
              }
            />
            <div className="operation-dialog-actions">
              <button type="button" onClick={() => setAmendDialog(undefined)}>
                Cancel
              </button>
              <button
                type="button"
                aria-label="Amend Commit"
                disabled={!amendDialog.message.trim()}
                onClick={() => {
                  runOperation(
                    { kind: 'amendCommit', message: amendDialog.message },
                    amendDialog.repositoryId,
                  );
                  setAmendDialog(undefined);
                }}
              >
                Amend
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {historyParentPicker ? (
        <div className="operation-dialog-backdrop">
          <div
            className="operation-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Select history parent"
          >
            <strong>Select a parent for this merge commit</strong>
            <span>{historyParentPicker.commit.subject}</span>
            <div className="history-parent-options">
              {historyParentPicker.commit.parents.map((parent, index) => (
                <button
                  type="button"
                  aria-label={`Compare with parent ${parent.slice(0, 8)}`}
                  title={parent}
                  key={parent}
                  onClick={() => {
                    historyParentChoices.current.set(historyParentPicker.commit.hash, parent);
                    send({
                      type: 'openHistoryDiff',
                      requestId: requestId('history-diff'),
                      repositoryId: historyParentPicker.repositoryId,
                      hash: historyParentPicker.commit.hash,
                      parent,
                    });
                    setHistoryParentPicker(undefined);
                  }}
                >
                  Parent {String(index + 1)} · {parent.slice(0, 8)}
                </button>
              ))}
            </div>
            <div className="operation-dialog-actions">
              <button type="button" onClick={() => setHistoryParentPicker(undefined)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {squashOperation ? (
        <div className="operation-dialog-backdrop">
          <form
            className="operation-dialog squash-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Squash Commits"
            onSubmit={(event) => {
              event.preventDefault();
              if (squashOperation.loading || !squashOperation.message.trim()) return;
              runOperation(
                {
                  kind: 'squashCommits',
                  hashes: squashOperation.hashes,
                  message: squashOperation.message,
                },
                squashOperation.repositoryId,
              );
              setSquashOperation(undefined);
            }}
          >
            <label>
              <span>Commit message</span>
              <textarea
                autoFocus
                aria-label="Squash commit message"
                disabled={squashOperation.loading}
                value={squashOperation.message}
                onChange={(event) =>
                  setSquashOperation((current) =>
                    current ? { ...current, message: event.target.value } : current,
                  )
                }
              />
            </label>
            <div className="operation-dialog-actions">
              <button
                type="button"
                onClick={() => {
                  activeCommitMessagesRequest.current = undefined;
                  setSquashOperation(undefined);
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={squashOperation.loading || !squashOperation.message.trim()}
              >
                Squash Commits
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {pushHeadDialog ? (
        <div className="operation-dialog-backdrop">
          <form
            className="operation-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Push HEAD"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canPushHead || !pushHeadOperation) return;
              runOperation(pushHeadOperation, pushHeadDialog.repositoryId);
              setPushHeadDialog(undefined);
            }}
          >
            <strong>Push HEAD</strong>
            <label>
              <span>Remote</span>
              <select
                aria-label="Remote"
                value={pushHeadDialog.remote}
                disabled={pushHeadDialog.loading || selectedOperationInFlight}
                onChange={(event) => setPushHeadDialog({ ...pushHeadDialog, remote: event.target.value })}
              >
                {pushHeadDialog.remotes.map((remote) => <option key={remote} value={remote}>{remote}</option>)}
              </select>
            </label>
            <label>
              <span>Target branch</span>
              <input
                autoFocus
                aria-label="Target branch"
                value={pushHeadDialog.branch}
                disabled={selectedOperationInFlight}
                onChange={(event) => setPushHeadDialog({ ...pushHeadDialog, branch: event.target.value })}
              />
            </label>
            {pushHeadDialog.loading ? <span>Loading remotes…</span> : null}
            {pushHeadDialog.error ? <span role="alert">{pushHeadDialog.error}</span> : null}
            {!pushHeadDialog.loading && !pushHeadDialog.error && !pushHeadDialog.remotes.length
              ? <span>No remotes configured.</span> : null}
            {pushHeadDialog.remote && pushHeadDialog.branch.trim()
              ? <span>HEAD → {pushHeadDialog.remote}/{pushHeadDialog.branch.trim()}</span> : null}
            <div className="operation-dialog-actions">
              <button type="button" onClick={() => setPushHeadDialog(undefined)}>Cancel</button>
              <button type="submit" disabled={!canPushHead}>Push</button>
            </div>
          </form>
        </div>
      ) : null}

      {namedOperation ? (
        <div className="operation-dialog-backdrop">
          <form
            className="operation-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={
              namedOperation.kind === 'createBranch'
                ? 'Create Branch'
                : namedOperation.kind === 'createAndCheckoutBranch'
                  ? 'Create Branch and Checkout'
                  : namedOperation.kind === 'createTag'
                    ? 'Create Tag'
                    : namedOperation.kind === 'checkoutRemote'
                      ? 'Checkout Remote Branch'
                      : 'Rename Branch'
            }
            onSubmit={(event) => {
              event.preventDefault();
              submitNamedOperation();
            }}
          >
            <label>
              <span>
                {namedOperation.kind === 'createBranch' || namedOperation.kind === 'createAndCheckoutBranch'
                  ? 'Branch name'
                  : namedOperation.kind === 'createTag'
                    ? 'Tag name'
                    : namedOperation.kind === 'checkoutRemote'
                      ? 'Local branch name'
                      : 'New branch name'}
              </span>
              <input
                autoFocus
                aria-label={
                  namedOperation.kind === 'createBranch' || namedOperation.kind === 'createAndCheckoutBranch'
                    ? 'Branch name'
                    : namedOperation.kind === 'createTag'
                      ? 'Tag name'
                      : namedOperation.kind === 'checkoutRemote'
                        ? 'Local branch name'
                        : 'New branch name'
                }
                value={namedOperation.value}
                onChange={(event) =>
                  setNamedOperation((current) =>
                    current ? { ...current, value: event.target.value } : current,
                  )
                }
              />
            </label>
            <div className="operation-dialog-actions">
              <button type="button" onClick={() => setNamedOperation(undefined)}>
                Cancel
              </button>
              <button type="submit" disabled={!namedOperation.value.trim()}>
                {namedOperation.kind === 'createBranch'
                  ? 'Create Branch'
                  : namedOperation.kind === 'createAndCheckoutBranch'
                    ? 'Create and Checkout'
                    : namedOperation.kind === 'createTag'
                      ? 'Create Tag'
                      : namedOperation.kind === 'checkoutRemote'
                        ? 'Checkout'
                        : 'Rename Branch'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}
