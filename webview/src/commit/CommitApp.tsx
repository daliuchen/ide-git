import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type {
  ChangeRef,
  CommitAction,
  CommitChecks,
  CommitExtensionMessage,
  CommitViewChange,
  CommitViewHunk,
  CommitViewLayout,
  CommitViewRepository,
  CommitWebviewMessage,
  MessageRules,
} from '../../../src/commit/commitProtocol';
import { DEFAULT_COMMIT_CHECKS, DEFAULT_COMMIT_VIEW_LAYOUT } from '../../../src/commit/commitProtocol';
import type { Changelist } from '../../../src/commit/changelists';
import { checkCommitMessage, wrapCommitMessage } from '../../../src/commit/commitMessage';
import {
  buildChangeTree,
  changeId,
  collectNodeIds,
  flattenVisible,
  type ChangeTreeNode,
} from './buildChangeTree';
import {
  EMPTY_SELECTION,
  commitSelection,
  commitStats,
  groupHunks,
  hunkChangelist,
  hunkState,
  isSplit,
  lineIncluded,
  nodeState,
  onHunksReloaded,
  pruneSelection,
  selectableLines,
  setFilesIncluded,
  toggleHunk,
  toggleLine,
  type CheckState,
  type SelectionContext,
  type SelectionState,
} from './selectionModel';

interface CommitVsCodeApi {
  postMessage(message: CommitWebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

const vscode: CommitVsCodeApi = (window.acquireVsCodeApi?.() as CommitVsCodeApi | undefined) ?? {
  postMessage() {},
  getState: () => undefined,
  setState() {},
};

interface PersistedViewState {
  selection?: Record<keyof SelectionState, string[]>;
  collapsed?: string[];
  amend?: boolean;
  signOff?: boolean;
  author?: string;
}

const persisted = (vscode.getState() ?? {}) as PersistedViewState;

function restoreSelection(saved: PersistedViewState['selection']): SelectionState {
  if (!saved) return EMPTY_SELECTION;
  return {
    included: new Set(saved.included ?? []),
    excluded: new Set(saved.excluded ?? []),
    includedHunks: new Set(saved.includedHunks ?? []),
    excludedHunks: new Set(saved.excludedHunks ?? []),
    excludedLines: new Set(saved.excludedLines ?? []),
  };
}

interface ViewData {
  repositories: CommitViewRepository[];
  changes: CommitViewChange[];
  changelists: Changelist[];
  activeChangelistId: string;
  messageHistory: string[];
  recentAuthors: string[];
  messageRules: MessageRules;
  template?: string;
  loaded: boolean;
}

type MenuState =
  | { x: number; y: number; kind: 'node'; node: ChangeTreeNode }
  | { x: number; y: number; kind: 'hunk'; change: CommitViewChange; hunk: CommitViewHunk };

const STATUS_LABEL: Record<CommitViewChange['status'], string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Conflict',
  '?': 'Unversioned',
};

const CHECK_LABELS: { key: keyof CommitChecks; label: string; title: string }[] = [
  { key: 'reformat', label: 'Reformat code', title: 'Format the committed files with the editor formatter first' },
  { key: 'optimizeImports', label: 'Optimize imports', title: 'Run “Organize Imports” on the committed files first' },
  { key: 'analyze', label: 'Analyze code', title: 'Stop when the committed files have errors or warnings' },
  { key: 'checkTodo', label: 'Check TODO', title: 'Stop when the changes add TODO or FIXME comments' },
  { key: 'runTests', label: 'Run tests', title: 'Run the configured test command (gitLogWorkbench.commit.testCommand)' },
  { key: 'runHooks', label: 'Run Git hooks', title: 'Clear to commit with --no-verify' },
];

const isMac = navigator.platform.toLowerCase().includes('mac');
const modKey = isMac ? '⌘' : 'Ctrl+';
const DRAG_TYPE = 'application/x-git-log-changes';

function post(message: CommitWebviewMessage): void {
  vscode.postMessage(message);
}

function refs(changes: readonly CommitViewChange[]): ChangeRef[] {
  return changes.map((change) => ({ repositoryId: change.repositoryId, path: change.path }));
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function Checkbox({ state, disabled, onToggle }: { state: CheckState; disabled?: boolean; onToggle(): void }) {
  return (
    <span
      role="checkbox"
      aria-checked={state === 'mixed' ? 'mixed' : state === 'checked'}
      aria-disabled={disabled}
      className={`tree-checkbox ${state}${disabled ? ' disabled' : ''}`}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) onToggle();
      }}
    >
      {state === 'checked' ? <i className="codicon codicon-check" /> : state === 'mixed' ? <i className="codicon codicon-dash" /> : null}
    </span>
  );
}

function MenuItem({ label, shortcut, disabled, onSelect }: { label: string; shortcut?: string; disabled?: boolean; onSelect(): void }) {
  return (
    <button type="button" role="menuitem" className="menu-item" disabled={disabled} onClick={onSelect}>
      <span>{label}</span>
      {shortcut ? <span className="menu-shortcut">{shortcut}</span> : null}
    </button>
  );
}

export function CommitApp() {
  const [data, setData] = useState<ViewData>({
    repositories: [],
    changes: [],
    changelists: [],
    activeChangelistId: 'default',
    messageHistory: [],
    recentAuthors: [],
    messageRules: { subjectLength: 72, bodyLineLength: 72, blankLineAfterSubject: true },
    loaded: false,
  });
  const [layout, setLayout] = useState<CommitViewLayout>(DEFAULT_COMMIT_VIEW_LAYOUT);
  const [selection, setSelection] = useState<SelectionState>(() => restoreSelection(persisted.selection));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(persisted.collapsed ?? []));
  /** Files whose chunks are expanded, chunks whose lines are expanded, and the loaded chunks. */
  const [openHunks, setOpenHunks] = useState<Set<string>>(new Set());
  const [openLines, setOpenLines] = useState<Set<string>>(new Set());
  const [hunks, setHunks] = useState<Map<string, CommitViewHunk[]>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string>();
  const [anchorId, setAnchorId] = useState<string>();
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(persisted.amend ?? false);
  const [signOff, setSignOff] = useState(persisted.signOff ?? false);
  const [author, setAuthor] = useState(persisted.author ?? '');
  const [checks, setChecks] = useState<CommitChecks>(DEFAULT_COMMIT_CHECKS);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [amendMessage, setAmendMessage] = useState<string>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [menu, setMenu] = useState<MenuState>();
  const [menuPosition, setMenuPosition] = useState<CSSProperties>();
  const [dropTarget, setDropTarget] = useState<string>();
  const treeRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const amendRef = useRef(amend);
  const hunksRef = useRef(hunks);
  const messageValueRef = useRef(message);
  const previousStateRef = useRef<{ activeId: string; changelists: Changelist[] }>(undefined);
  /** Files whose chunks are reloaded after a refresh: expanded, partially selected, or split. */
  const hunkFilesRef = useRef(new Set<string>());
  useEffect(() => {
    amendRef.current = amend;
    hunksRef.current = hunks;
    messageValueRef.current = message;
    hunkFilesRef.current = new Set([
      ...openHunks,
      ...[...selection.excludedHunks, ...selection.includedHunks, ...selection.excludedLines].map((key) =>
        key.split('\0').slice(0, 2).join('\0'),
      ),
    ]);
  }, [amend, hunks, message, openHunks, selection]);

  useEffect(() => {
    vscode.setState({
      selection: {
        included: [...selection.included],
        excluded: [...selection.excluded],
        includedHunks: [...selection.includedHunks],
        excludedHunks: [...selection.excludedHunks],
        excludedLines: [...selection.excludedLines],
      },
      collapsed: [...collapsed],
      amend,
      signOff,
      author,
    } satisfies PersistedViewState);
  }, [selection, collapsed, amend, signOff, author]);

  const requestHunks = (change: Pick<CommitViewChange, 'repositoryId' | 'path'>): void => {
    post({ type: 'requestHunks', item: { repositoryId: change.repositoryId, path: change.path } });
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent<CommitExtensionMessage>) => {
      const incoming = event.data;
      switch (incoming.type) {
        case 'state': {
          setData({
            repositories: incoming.repositories,
            changes: incoming.changes,
            changelists: incoming.changelists,
            activeChangelistId: incoming.activeChangelistId,
            messageHistory: incoming.messageHistory,
            recentAuthors: incoming.recentAuthors,
            messageRules: incoming.messageRules,
            ...(incoming.template ? { template: incoming.template } : {}),
            loaded: true,
          });
          setLayout(incoming.layout);
          setChecks(incoming.checks);
          setSelection((current) => pruneSelection(incoming.changes, current));
          // Chunks can shift after any change on disk. Reload the ones in use; a selection that no
          // longer matches is rejected at commit time instead of silently committing the whole file.
          for (const change of incoming.changes) {
            if (hunkFilesRef.current.has(changeId(change)) || isSplit(change)) requestHunks(change);
          }
          const active = incoming.changelists.find((list) => list.id === incoming.activeChangelistId);
          const previous = previousStateRef.current;
          previousStateRef.current = { activeId: incoming.activeChangelistId, changelists: incoming.changelists };
          if (!previous) {
            const initial = messageValueRef.current || (incoming.draft ?? active?.comment ?? incoming.template ?? '');
            if (initial) setMessage(initial);
          } else if (previous.activeId !== incoming.activeChangelistId) {
            // Switching the active changelist starts from its defaults, like opening an IDE commit
            // dialog for it: its changes are selected and its description becomes the message.
            setSelection(EMPTY_SELECTION);
            const previousComment = previous.changelists.find((list) => list.id === previous.activeId)?.comment;
            const current = messageValueRef.current.trim();
            if (!current || current === previousComment?.trim() || current === incoming.template?.trim()) {
              setMessage(active?.comment ?? incoming.template ?? '');
            }
          }
          break;
        }
        case 'amendMessage':
          setAmendMessage(incoming.message);
          if (amendRef.current) setMessage((current) => (current.trim() ? current : incoming.message));
          break;
        case 'hunks': {
          const id = changeId({ repositoryId: incoming.repositoryId, path: incoming.path });
          const previous = hunksRef.current.get(id);
          setHunks((current) => new Map(current).set(id, incoming.hunks));
          setSelection((current) => {
            const change = { repositoryId: incoming.repositoryId, path: incoming.path } as CommitViewChange;
            return onHunksReloaded(change, previous, incoming.hunks, current);
          });
          break;
        }
        case 'committed':
          setNotice(incoming.summary);
          setError(undefined);
          if (!incoming.keepMessage) setMessage('');
          setAmend(false);
          setAmendMessage(undefined);
          setSelection(EMPTY_SELECTION);
          break;
        case 'busy':
          setBusy(incoming.label);
          break;
        case 'error':
          setError(incoming.message);
          setBusy(undefined);
          break;
        case 'setMessage':
          setMessage(incoming.message);
          messageRef.current?.focus();
          break;
      }
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 6_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const updateMessage = (value: string): void => {
    setMessage(value);
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => post({ type: 'saveDraft', message: value }), 500);
  };

  const updateLayout = (next: Partial<CommitViewLayout>): void => {
    setLayout((current) => {
      const merged = { ...current, ...next };
      post({ type: 'updateLayout', layout: merged });
      return merged;
    });
  };

  const updateChecks = (next: Partial<CommitChecks>): void => {
    setChecks((current) => {
      const merged = { ...current, ...next };
      post({ type: 'updateChecks', checks: merged });
      return merged;
    });
  };

  const context: SelectionContext = useMemo(
    () => ({ activeChangelistId: data.activeChangelistId, hunks }),
    [data.activeChangelistId, hunks],
  );

  const tree = useMemo(
    () =>
      buildChangeTree({
        changes: data.changes,
        repositories: data.repositories,
        changelists: data.changelists,
        activeChangelistId: data.activeChangelistId,
        groupByDirectory: layout.groupByDirectory,
        showUnversioned: layout.showUnversioned,
      }),
    [data, layout.groupByDirectory, layout.showUnversioned],
  );
  const rows = useMemo(() => flattenVisible(tree, collapsed), [tree, collapsed]);
  const rowIndex = useMemo(() => new Map(rows.map((row, index) => [row.id, index])), [rows]);

  const selectedNodes = useMemo(() => rows.filter((row) => selected.has(row.id)), [rows, selected]);
  const selectedChanges = useMemo(() => {
    const unique = new Map<string, CommitViewChange>();
    for (const node of selectedNodes) for (const change of node.changes) unique.set(changeId(change), change);
    return [...unique.values()];
  }, [selectedNodes]);

  const commitItems = useMemo(
    () =>
      data.changes.flatMap((change): ChangeRef[] => {
        const chosen = commitSelection(change, selection, context);
        if (!chosen) return [];
        return [
          {
            repositoryId: change.repositoryId,
            path: change.path,
            ...(chosen.hunks ? { hunks: chosen.hunks } : {}),
            ...(chosen.lines ? { lines: chosen.lines } : {}),
          },
        ];
      }),
    [data.changes, selection, context],
  );
  const stats = useMemo(
    () =>
      data.changes.reduce(
        (total, change) => {
          const next = commitStats(change, selection, context);
          return { additions: total.additions + next.additions, deletions: total.deletions + next.deletions };
        },
        { additions: 0, deletions: 0 },
      ),
    [data.changes, selection, context],
  );
  const messageIssues = useMemo(() => checkCommitMessage(message, data.messageRules), [message, data.messageRules]);
  const conflicts = data.changes.filter((change) => change.status === 'U').length;
  const operationRepository = data.repositories.find((repository) => repository.operationState);

  const runAction = useCallback(
    (action: CommitAction, changes: readonly CommitViewChange[], preview = false, changelistId?: string) => {
      if (!changes.length) return;
      setMenu(undefined);
      post({
        type: 'action',
        action,
        items: refs(changes),
        ...(preview ? { preview: true } : {}),
        ...(changelistId ? { changelistId } : {}),
      });
    },
    [],
  );

  const toggleNode = (node: ChangeTreeNode): void => {
    const state = nodeState(node.changes, node.listId, selection, context);
    setSelection((current) => setFilesIncluded(node.changes, node.listId, state !== 'checked', current, context));
  };

  const toggleHunksOpen = (change: CommitViewChange): void => {
    const id = changeId(change);
    const next = new Set(openHunks);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
      requestHunks(change);
    }
    setOpenHunks(next);
  };

  const toggleSelection = (): void => {
    if (!selectedNodes.length) return;
    const listId = selectedNodes[0]?.listId;
    const state = nodeState(selectedChanges, listId, selection, context);
    setSelection((current) => setFilesIncluded(selectedChanges, listId, state !== 'checked', current, context));
  };

  const select = (node: ChangeTreeNode, event?: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): void => {
    const toggle = event && (isMac ? event.metaKey : event.ctrlKey);
    if (event?.shiftKey && anchorId !== undefined) {
      const from = rowIndex.get(anchorId) ?? 0;
      const to = rowIndex.get(node.id) ?? 0;
      const [start, end] = from < to ? [from, to] : [to, from];
      setSelected(new Set(rows.slice(start, end + 1).map((row) => row.id)));
    } else if (toggle) {
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        return next;
      });
      setAnchorId(node.id);
    } else {
      setSelected(new Set([node.id]));
      setAnchorId(node.id);
      if (layout.diffPreviewOnSelect && node.change) runAction('showDiff', [node.change], true);
    }
    setFocusedId(node.id);
  };

  useLayoutEffect(() => {
    if (!focusedId) return;
    treeRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(focusedId)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [focusedId]);

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) {
      setMenuPosition(undefined);
      return;
    }
    const rect = menuRef.current.getBoundingClientRect();
    setMenuPosition({
      left: Math.max(4, Math.min(menu.x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(menu.y, window.innerHeight - rect.height - 4)),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu && !historyOpen && !optionsOpen) return;
    const close = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      if ((event.target as HTMLElement).closest('.history-popup, .history-button, .options-popup, .options-button')) return;
      setMenu(undefined);
      setHistoryOpen(false);
      setOptionsOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenu(undefined);
        setHistoryOpen(false);
        setOptionsOpen(false);
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', escape);
    window.addEventListener('blur', () => setMenu(undefined), { once: true });
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', escape);
    };
  }, [menu, historyOpen, optionsOpen]);

  const toggleCollapsed = (node: ChangeTreeNode, expand?: boolean): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      const shouldExpand = expand ?? next.has(node.id);
      if (shouldExpand) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  };

  const commit = (push: boolean): void => {
    if (busy) return;
    if (!message.trim()) {
      setError('Enter a commit message.');
      messageRef.current?.focus();
      return;
    }
    if (data.template && message.trim() === data.template.trim()) {
      setError('Edit the commit message template before committing.');
      messageRef.current?.focus();
      return;
    }
    if (!commitItems.length && !amend) {
      setError('Select at least one change to commit.');
      return;
    }
    setError(undefined);
    post({
      type: 'commit',
      message,
      items: commitItems,
      amend,
      signOff,
      push,
      checks,
      ...(author.trim() ? { author: author.trim() } : {}),
    });
  };

  const onTreeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const index = focusedId === undefined ? -1 : (rowIndex.get(focusedId) ?? -1);
    const focused = index >= 0 ? rows[index] : undefined;
    const mod = isMac ? event.metaKey : event.ctrlKey;
    const move = (target: number) => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, target))];
      if (row) select(row, { shiftKey: event.shiftKey, metaKey: false, ctrlKey: false });
    };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index < 0 ? 0 : index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(rows.length - 1);
    else if (event.key === 'PageDown') move(index + 15);
    else if (event.key === 'PageUp') move(index - 15);
    else if (event.key === 'ArrowRight' && focused?.children.length) {
      if (collapsed.has(focused.id)) toggleCollapsed(focused, true);
      else move(index + 1);
    } else if (event.key === 'ArrowLeft' && focused) {
      if (focused.children.length && !collapsed.has(focused.id)) toggleCollapsed(focused, false);
      else {
        for (let parent = index - 1; parent >= 0; parent -= 1) {
          const candidate = rows[parent];
          if (candidate && candidate.depth < focused.depth) {
            move(parent);
            break;
          }
        }
      }
    } else if (event.key === ' ' && event.ctrlKey && focused?.changelistId) {
      post({ type: 'setActiveChangelist', id: focused.changelistId });
    } else if (event.key === ' ') toggleSelection();
    else if (event.key === 'Enter' || (mod && event.key.toLowerCase() === 'd')) {
      if (focused?.children.length && event.key === 'Enter') toggleCollapsed(focused);
      else runAction('showDiff', selectedChanges);
    } else if (event.key === 'F4') runAction('openSource', selectedChanges);
    else if (event.key === 'F2' && focused?.changelistId) post({ type: 'renameChangelist', id: focused.changelistId });
    else if ((event.key === 'Delete' || (isMac && event.key === 'Backspace' && event.metaKey)) && selectedChanges.length) {
      if (selectedChanges.every((change) => change.status === '?')) runAction('delete', selectedChanges);
      else runAction('rollback', selectedChanges);
    } else if (event.altKey && mod && event.key.toLowerCase() === 'z') runAction('rollback', selectedChanges);
    else if (event.altKey && event.shiftKey && event.code === 'KeyM') runAction('moveToChangelist', selectedChanges);
    else if (mod && event.key.toLowerCase() === 'a') {
      setSelected(new Set(rows.map((row) => row.id)));
    } else if (mod && event.key.toLowerCase() === 'c') {
      runAction('copyPath', selectedChanges);
    } else return;
    event.preventDefault();
  };

  const startMessageResize = (event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = layout.messageHeight;
    let latest = startHeight;
    const onMove = (moveEvent: MouseEvent) => {
      latest = Math.min(window.innerHeight - 120, Math.max(48, startHeight + startY - moveEvent.clientY));
      setLayout((current) => ({ ...current, messageHeight: latest }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      updateLayout({ messageHeight: latest });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  /** Dragging files onto a changelist moves them there. */
  const onDragStart = (event: ReactDragEvent<HTMLDivElement>, node: ChangeTreeNode): void => {
    const movable = (selected.has(node.id) ? selectedChanges : node.changes).filter(
      (change) => change.status !== '?' && change.status !== 'U',
    );
    if (!movable.length) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(refs(movable)));
    event.dataTransfer.effectAllowed = 'move';
  };
  const onDrop = (event: ReactDragEvent<HTMLDivElement>, node: ChangeTreeNode): void => {
    setDropTarget(undefined);
    const raw = event.dataTransfer.getData(DRAG_TYPE);
    if (!raw || !node.changelistId) return;
    event.preventDefault();
    const items = JSON.parse(raw) as ChangeRef[];
    post({ type: 'action', action: 'moveToChangelist', items, changelistId: node.changelistId });
  };

  const indent = (depth: number): CSSProperties => ({ paddingLeft: 22 + depth * 14 });

  const renderLines = (change: CommitViewChange, hunk: CommitViewHunk, depth: number) =>
    selectableLines(hunk).map((index) => {
      const line = hunk.lines[index] ?? '';
      const included = lineIncluded(change, hunk, index, selection, context);
      return (
        <div
          key={`${hunk.id}:${String(index)}`}
          className={`line-row ${line.startsWith('+') ? 'line-added' : 'line-removed'}`}
          style={indent(depth)}
          onDoubleClick={() => runAction('showDiff', [change])}
        >
          <Checkbox
            state={included ? 'checked' : 'unchecked'}
            onToggle={() => setSelection((current) => toggleLine(change, hunk, index, current, context))}
          />
          <span className="line-sign">{line[0]}</span>
          <span className="line-text">{line.slice(1) || ' '}</span>
        </div>
      );
    });

  const renderHunks = (node: ChangeTreeNode, change: CommitViewChange) => {
    const loaded = groupHunks(change, node.listId, context);
    if (loaded === undefined) return <div className="hunk-row empty-hunks" style={indent(node.depth + 1)}>Loading changes…</div>;
    if (!loaded.length) return <div className="hunk-row empty-hunks" style={indent(node.depth + 1)}>No text changes.</div>;
    return loaded.map((hunk) => {
      const preview = hunk.added[0] ?? hunk.removed[0] ?? '';
      const lineKey = `${changeId(change)}\0${hunk.id}`;
      const linesOpen = openLines.has(lineKey);
      const otherList = isSplit(change) && !node.listId ? hunkChangelist(change, hunk) : undefined;
      return (
        <Fragment key={hunk.id}>
          <div
            className="hunk-row"
            style={indent(node.depth + 1)}
            title={`${[...hunk.removed.map((line) => `- ${line}`), ...hunk.added.map((line) => `+ ${line}`)].join('\n')}\n\nExpand to select individual lines; right-click to move to another changelist.`}
            onDoubleClick={() => runAction('showDiff', [change])}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, kind: 'hunk', change, hunk });
            }}
          >
            <span
              className={`twistie codicon ${hunk.linesTruncated ? '' : linesOpen ? 'codicon-chevron-down' : 'codicon-chevron-right'} chunk-twistie`}
              title={hunk.linesTruncated ? 'This chunk is too large to select lines' : 'Select individual lines'}
              onMouseDown={(event) => {
                event.stopPropagation();
                if (hunk.linesTruncated) return;
                setOpenLines((current) => {
                  const next = new Set(current);
                  if (next.has(lineKey)) next.delete(lineKey);
                  else next.add(lineKey);
                  return next;
                });
              }}
            />
            <Checkbox
              state={hunkState(change, hunk, selection, context)}
              onToggle={() => setSelection((current) => toggleHunk(change, hunk, current, context))}
            />
            <span className="hunk-line">L{hunk.newStart}</span>
            {hunk.removedCount ? <span className="deleted">−{hunk.removedCount}</span> : null}
            {hunk.addedCount ? <span className="added">+{hunk.addedCount}</span> : null}
            <span className="hunk-preview">{preview.trim()}</span>
            {otherList ? <span className="detail">{data.changelists.find((list) => list.id === otherList)?.name}</span> : null}
          </div>
          {linesOpen ? renderLines(change, hunk, node.depth + 2) : null}
        </Fragment>
      );
    });
  };

  const renderRow = (node: ChangeTreeNode) => {
    const change = node.change;
    const state = nodeState(node.changes, node.listId, selection, context);
    const isConflictOnly = node.changes.length > 0 && node.changes.every((candidate) => candidate.status === 'U');
    const list = node.kind === 'group' ? data.changelists.find((candidate) => candidate.id === node.changelistId) : undefined;
    const isActiveList = node.changelistId === data.activeChangelistId;
    const expandable = node.children.length > 0 || node.kind === 'group';
    const chunkable = Boolean(change && (change.status === 'M' || change.status === 'T') && !change.binary);
    const chunksOpen = Boolean(change && openHunks.has(changeId(change)));
    const draggable = node.kind !== 'group' && node.changes.some((candidate) => candidate.status !== '?' && candidate.status !== 'U');
    return (
      <Fragment key={node.id}>
        <div
          data-row-id={node.id}
          role="treeitem"
          aria-level={node.depth + 1}
          aria-selected={selected.has(node.id)}
          aria-expanded={expandable ? !collapsed.has(node.id) : undefined}
          className={`tree-row kind-${node.kind}${selected.has(node.id) ? ' selected' : ''}${focusedId === node.id ? ' focused' : ''}${dropTarget === node.id ? ' drop-target' : ''}`}
          style={{ paddingLeft: 4 + node.depth * 14 }}
          title={
            change
              ? `${change.oldPath ? `${change.oldPath} → ` : ''}${change.path}\n${STATUS_LABEL[change.status]}${isSplit(change) ? '\nSplit across changelists' : ''}`
              : (list?.comment ?? node.detail)
          }
          draggable={draggable}
          onDragStart={(event) => onDragStart(event, node)}
          onDragOver={(event) => {
            if (node.kind !== 'group' || !node.changelistId || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setDropTarget(node.id);
          }}
          onDragLeave={() => setDropTarget((current) => (current === node.id ? undefined : current))}
          onDrop={(event) => onDrop(event, node)}
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            select(node, event);
          }}
          onDoubleClick={() => {
            if (change) runAction(change.status === 'U' ? 'openMerge' : 'showDiff', [change]);
            else toggleCollapsed(node);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            if (!selected.has(node.id)) {
              setSelected(new Set([node.id]));
              setAnchorId(node.id);
            }
            setFocusedId(node.id);
            setMenu({ x: event.clientX, y: event.clientY, kind: 'node', node });
          }}
        >
          <span
            className={`twistie codicon ${expandable ? (collapsed.has(node.id) ? 'codicon-chevron-right' : 'codicon-chevron-down') : chunkable ? (chunksOpen ? 'codicon-chevron-down chunk-twistie' : 'codicon-chevron-right chunk-twistie') : ''}`}
            title={chunkable ? 'Select individual changes in this file' : undefined}
            onMouseDown={(event) => {
              if (expandable) {
                event.stopPropagation();
                toggleCollapsed(node);
              } else if (chunkable && change) {
                event.stopPropagation();
                toggleHunksOpen(change);
              }
            }}
          />
          <Checkbox state={state} disabled={isConflictOnly || node.changes.length === 0} onToggle={() => toggleNode(node)} />
          {node.kind === 'directory' ? <i className="codicon codicon-folder node-icon" /> : null}
          {node.kind === 'repository' ? <i className="codicon codicon-repo node-icon" /> : null}
          {node.kind === 'file' && change ? (
            <i
              className={`codicon codicon-${change.status === 'D' ? 'diff-removed' : change.status === '?' ? 'question' : change.status === 'U' ? 'warning' : isSplit(change) ? 'split-horizontal' : 'file'} node-icon`}
            />
          ) : null}
          <span className={`label${change ? ` status-${change.status === '?' ? 'unversioned' : change.status}` : ''}${isActiveList ? ' active-list' : ''}`}>
            {node.label}
          </span>
          {node.kind === 'file' && change?.oldPath && change.status === 'R' ? <span className="detail">← {change.oldPath}</span> : null}
          {node.kind === 'file' && node.detail ? <span className="detail">{node.detail}</span> : null}
          {node.kind === 'repository' && node.detail ? <span className="detail">{node.detail}</span> : null}
          {node.kind === 'group' ? (
            <span className="detail">
              {node.changes.length ? plural(node.changes.length, 'file') : 'no files'}
              {isActiveList && data.changelists.length > 1 ? ' · active' : ''}
              {list?.comment ? ` · ${list.comment.split('\n')[0] ?? ''}` : ''}
            </span>
          ) : null}
          {node.kind === 'directory' ? <span className="detail">{plural(node.changes.length, 'file')}</span> : null}
          {change && (change.additions || change.deletions) ? (
            <span className="stats">
              {change.additions ? <span className="added">+{change.additions}</span> : null}
              {change.deletions ? <span className="deleted">−{change.deletions}</span> : null}
            </span>
          ) : null}
        </div>
        {change && chunksOpen ? renderHunks(node, change) : null}
      </Fragment>
    );
  };

  const menuChanges = menu?.kind === 'node' ? selectedChanges : [];
  const menuHasTracked = menuChanges.some((change) => change.status !== '?' && change.status !== 'U');
  const menuHasUnversioned = menuChanges.some((change) => change.status === '?');
  const menuHasConflicts = menuChanges.some((change) => change.status === 'U');
  const menuChangelistId = menu?.kind === 'node' && menu.node.kind === 'group' ? menu.node.changelistId : undefined;
  const singleRepository = data.repositories.length === 1 ? data.repositories[0] : undefined;
  const enabledChecks = CHECK_LABELS.filter(({ key }) => key !== 'runHooks' && checks[key]).length + (checks.runHooks ? 0 : 1);

  return (
    <div className="commit-shell" style={{ gridTemplateRows: `auto auto minmax(60px, 1fr) 4px ${String(layout.messageHeight + 70 + Math.min(messageIssues.length, 3) * 18)}px` }}>
      <header className="commit-toolbar" role="toolbar" aria-label="Local changes actions">
        <button type="button" title="Refresh" onClick={() => post({ type: 'refresh' })}>
          <i className="codicon codicon-refresh" />
        </button>
        <button
          type="button"
          title={`Rollback… (${modKey}${isMac ? '⌥' : 'Alt+'}Z)`}
          disabled={!selectedChanges.some((change) => change.status !== '?' && change.status !== 'U')}
          onClick={() => runAction('rollback', selectedChanges)}
        >
          <i className="codicon codicon-discard" />
        </button>
        <button type="button" title={`Show Diff (${modKey}D)`} disabled={!selectedChanges.length} onClick={() => runAction('showDiff', selectedChanges)}>
          <i className="codicon codicon-diff" />
        </button>
        <button
          type="button"
          title="Shelve Changes (stash the selected files)"
          disabled={!selectedChanges.some((change) => change.status !== 'U')}
          onClick={() => post({ type: 'shelve', items: refs(selectedChanges.filter((change) => change.status !== 'U')), message: message.split('\n')[0] ?? '' })}
        >
          <i className="codicon codicon-archive" />
        </button>
        <button
          type="button"
          title="New Changelist…"
          onClick={() => post({ type: 'newChangelist', items: refs(selectedChanges.filter((change) => change.status !== '?' && change.status !== 'U')) })}
        >
          <i className="codicon codicon-new-folder" />
        </button>
        <span className="toolbar-separator" />
        <button
          type="button"
          title="Group by Directory"
          aria-pressed={layout.groupByDirectory}
          className={layout.groupByDirectory ? 'toggled' : ''}
          onClick={() => updateLayout({ groupByDirectory: !layout.groupByDirectory })}
        >
          <i className="codicon codicon-list-tree" />
        </button>
        <button
          type="button"
          title="Show Unversioned Files"
          aria-pressed={layout.showUnversioned}
          className={layout.showUnversioned ? 'toggled' : ''}
          onClick={() => updateLayout({ showUnversioned: !layout.showUnversioned })}
        >
          <i className="codicon codicon-question" />
        </button>
        <button
          type="button"
          title="Preview Diff on Selection"
          aria-pressed={layout.diffPreviewOnSelect}
          className={layout.diffPreviewOnSelect ? 'toggled' : ''}
          onClick={() => updateLayout({ diffPreviewOnSelect: !layout.diffPreviewOnSelect })}
        >
          <i className="codicon codicon-preview" />
        </button>
        <button type="button" title="Expand All" onClick={() => setCollapsed(new Set())}>
          <i className="codicon codicon-expand-all" />
        </button>
        <button type="button" title="Collapse All" onClick={() => setCollapsed(new Set(collectNodeIds(tree).filter((id) => !id.startsWith('g|'))))}>
          <i className="codicon codicon-collapse-all" />
        </button>
        {singleRepository?.branch ? (
          <span className="branch-info" title={singleRepository.upstream ? `Tracking ${singleRepository.upstream}` : 'No upstream branch'}>
            <i className="codicon codicon-git-branch" /> {singleRepository.branch}
            {singleRepository.ahead ? <span title="Outgoing commits"> ↑{singleRepository.ahead}</span> : null}
            {singleRepository.behind ? <span title="Incoming commits"> ↓{singleRepository.behind}</span> : null}
          </span>
        ) : null}
      </header>
      <div className="banners">
        {operationRepository ? (
          <div className="operation-banner">
            <i className="codicon codicon-info" />
            {operationRepository.operationState === 'rebase'
              ? `Rebasing ${operationRepository.name} — resolve conflicts, then continue the rebase from the Git Log.`
              : `${operationRepository.operationState ?? ''} in progress in ${operationRepository.name}${conflicts ? ` — ${plural(conflicts, 'conflict')} to resolve` : ' — commit to conclude it'}.`}
          </div>
        ) : null}
        {data.repositories.some((repository) => repository.truncated) ? <div className="operation-banner">Only the first 5000 changes are shown.</div> : null}
        {error ? (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button type="button" title="Dismiss" onClick={() => setError(undefined)}>
              <i className="codicon codicon-close" />
            </button>
          </div>
        ) : null}
        {notice ? <div className="notice-banner" role="status">{notice}</div> : null}
      </div>
      <div
        ref={treeRef}
        className="change-tree"
        role="tree"
        aria-multiselectable="true"
        aria-label="Local changes"
        tabIndex={0}
        onKeyDown={onTreeKeyDown}
        onFocus={() => {
          if (!focusedId && rows[0]) setFocusedId(rows[0].id);
        }}
      >
        {!data.loaded ? <div className="empty">Loading local changes…</div> : null}
        {data.loaded && !data.repositories.length ? <div className="empty">No Git repository found in this workspace.</div> : null}
        {rows.map(renderRow)}
        {data.loaded && data.repositories.length > 0 && !data.changes.length ? <div className="empty">No local changes.</div> : null}
      </div>
      <div className="message-splitter" role="separator" aria-orientation="horizontal" onMouseDown={startMessageResize} />
      <section className="commit-form" aria-label="Commit message">
        <div className="commit-options">
          <label title="Replace the last commit (git commit --amend)">
            <input
              type="checkbox"
              checked={amend}
              onChange={(event) => {
                const checked = event.target.checked;
                setAmend(checked);
                if (checked) post({ type: 'requestAmendMessage' });
                else if (amendMessage !== undefined && message === amendMessage) updateMessage('');
              }}
            />
            Amend
          </label>
          <label title="Add a Signed-off-by trailer (git commit --signoff)">
            <input type="checkbox" checked={signOff} onChange={(event) => setSignOff(event.target.checked)} />
            Sign-off
          </label>
          <span className="spacer" />
          <button
            type="button"
            className={`options-button${enabledChecks || author ? ' has-options' : ''}`}
            title="Commit options: author and commit checks"
            onClick={() => setOptionsOpen((open) => !open)}
          >
            <i className="codicon codicon-gear" />
            {enabledChecks || author ? <span className="options-count">{enabledChecks + (author ? 1 : 0)}</span> : null}
          </button>
          <button type="button" className="history-button" title="Commit Message History" disabled={!data.messageHistory.length} onClick={() => setHistoryOpen((open) => !open)}>
            <i className="codicon codicon-history" />
          </button>
          {historyOpen ? (
            <div className="history-popup" role="listbox" aria-label="Recent commit messages">
              {data.messageHistory.map((entry) => (
                <button
                  key={entry}
                  type="button"
                  role="option"
                  aria-selected={false}
                  title={entry}
                  onClick={() => {
                    updateMessage(entry);
                    setHistoryOpen(false);
                    messageRef.current?.focus();
                  }}
                >
                  {entry.split('\n')[0]}
                </button>
              ))}
            </div>
          ) : null}
          {optionsOpen ? (
            <div className="options-popup" role="dialog" aria-label="Commit options">
              <label className="author-field">
                <span>Author</span>
                <input
                  id="commit-author"
                  list="commit-authors"
                  value={author}
                  placeholder="Name <email@example.com> (default: Git config)"
                  onChange={(event) => setAuthor(event.target.value)}
                />
                <datalist id="commit-authors">
                  {data.recentAuthors.map((entry) => (
                    <option key={entry} value={entry} />
                  ))}
                </datalist>
              </label>
              <div className="options-title">Before commit</div>
              {CHECK_LABELS.map(({ key, label, title }) => (
                <label key={key} title={title}>
                  <input type="checkbox" checked={checks[key]} onChange={(event) => updateChecks({ [key]: event.target.checked })} />
                  {label}
                </label>
              ))}
            </div>
          ) : null}
        </div>
        <textarea
          ref={messageRef}
          className="commit-message"
          aria-label="Commit message"
          placeholder={`Commit message (${modKey}Enter to commit)`}
          value={message}
          spellCheck
          onChange={(event) => updateMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (isMac ? event.metaKey : event.ctrlKey)) {
              event.preventDefault();
              commit(event.altKey || event.shiftKey);
            }
          }}
        />
        {messageIssues.length ? (
          <div className="message-issues" role="status">
            {messageIssues.slice(0, 3).map((issue) => (
              <div key={`${String(issue.line)}:${issue.text}`}>
                <i className="codicon codicon-warning" /> {issue.text}
              </div>
            ))}
            <button type="button" className="link-button" onClick={() => updateMessage(wrapCommitMessage(message, data.messageRules.bodyLineLength || 72))}>
              Wrap and fix blank line
            </button>
          </div>
        ) : null}
        <div className="commit-actions">
          <button type="button" className="primary" disabled={Boolean(busy)} onClick={() => commit(false)} title={`${modKey}Enter`}>
            {amend ? 'Amend Commit' : 'Commit'}
          </button>
          <button type="button" disabled={Boolean(busy)} onClick={() => commit(true)} title={`${modKey}${isMac ? '⌥' : 'Alt+'}Enter`}>
            {amend ? 'Amend Commit and Push…' : 'Commit and Push…'}
          </button>
          <span className="commit-summary">
            {busy ? (
              <>
                <i className="codicon codicon-loading codicon-modifier-spin" /> {busy}
              </>
            ) : (
              <>
                {commitItems.length ? `${plural(commitItems.length, 'file')} selected` : amend ? 'Message only' : 'Nothing selected'}
                {stats.additions ? <span className="added"> +{stats.additions}</span> : null}
                {stats.deletions ? <span className="deleted"> −{stats.deletions}</span> : null}
                {author ? <span title="Commit author"> · {author.replace(/ <.*$/u, '')}</span> : null}
              </>
            )}
          </span>
        </div>
      </section>
      {menu ? (
        <div ref={menuRef} className="context-menu" role="menu" style={menuPosition ?? { left: menu.x, top: menu.y, visibility: 'hidden' }}>
          {menu.kind === 'hunk' ? (
            <>
              <MenuItem
                label="Move to Another Changelist…"
                onSelect={() => {
                  setMenu(undefined);
                  post({ type: 'moveHunks', item: { repositoryId: menu.change.repositoryId, path: menu.change.path }, hunkIds: [menu.hunk.id] });
                }}
              />
              <MenuItem label="Show Diff" onSelect={() => runAction('showDiff', [menu.change])} />
              <MenuItem label="Jump to Source" onSelect={() => runAction('openSource', [menu.change])} />
            </>
          ) : (
            <>
              {menuChangelistId ? (
                <>
                  <MenuItem
                    label="Set Active Changelist"
                    shortcut="Ctrl+Space"
                    disabled={menuChangelistId === data.activeChangelistId}
                    onSelect={() => {
                      setMenu(undefined);
                      post({ type: 'setActiveChangelist', id: menuChangelistId });
                    }}
                  />
                  <MenuItem
                    label="Edit Changelist…"
                    shortcut="F2"
                    onSelect={() => {
                      setMenu(undefined);
                      post({ type: 'renameChangelist', id: menuChangelistId });
                    }}
                  />
                  <MenuItem
                    label="Delete Changelist…"
                    disabled={menuChangelistId === 'default'}
                    onSelect={() => {
                      setMenu(undefined);
                      post({ type: 'deleteChangelist', id: menuChangelistId });
                    }}
                  />
                  <div className="menu-separator" />
                </>
              ) : null}
              {menuHasConflicts ? (
                <>
                  <MenuItem label="Merge…" onSelect={() => runAction('openMerge', menuChanges.filter((change) => change.status === 'U'))} />
                  <MenuItem label="Accept Yours" onSelect={() => runAction('acceptOurs', menuChanges)} />
                  <MenuItem label="Accept Theirs" onSelect={() => runAction('acceptTheirs', menuChanges)} />
                  <MenuItem label="Mark as Resolved" onSelect={() => runAction('markResolved', menuChanges)} />
                  <div className="menu-separator" />
                </>
              ) : null}
              <MenuItem label="Show Diff" shortcut={`${modKey}D`} disabled={!menuChanges.length} onSelect={() => runAction('showDiff', menuChanges)} />
              <MenuItem label="Jump to Source" shortcut="F4" disabled={!menuChanges.some((change) => change.status !== 'D')} onSelect={() => runAction('openSource', menuChanges)} />
              <div className="menu-separator" />
              <MenuItem
                label="Commit File…"
                disabled={!menuChanges.some((change) => change.status !== 'U')}
                onSelect={() => {
                  setMenu(undefined);
                  setSelection((current) =>
                    setFilesIncluded(menuChanges, undefined, true, setFilesIncluded(data.changes, undefined, false, current, context), context),
                  );
                  messageRef.current?.focus();
                }}
              />
              <MenuItem label="Rollback…" shortcut={`${modKey}${isMac ? '⌥' : 'Alt+'}Z`} disabled={!menuHasTracked} onSelect={() => runAction('rollback', menuChanges)} />
              <MenuItem label="Move to Another Changelist…" shortcut={isMac ? '⌥⇧M' : 'Alt+Shift+M'} disabled={!menuHasTracked} onSelect={() => runAction('moveToChangelist', menuChanges)} />
              <MenuItem
                label="New Changelist…"
                onSelect={() => {
                  setMenu(undefined);
                  post({ type: 'newChangelist', items: refs(menuChanges.filter((change) => change.status !== '?' && change.status !== 'U')) });
                }}
              />
              <MenuItem
                label="Shelve Changes…"
                disabled={!menuChanges.some((change) => change.status !== 'U')}
                onSelect={() => {
                  setMenu(undefined);
                  post({ type: 'shelve', items: refs(menuChanges.filter((change) => change.status !== 'U')), message: message.split('\n')[0] ?? '' });
                }}
              />
              {menuHasUnversioned ? (
                <>
                  <div className="menu-separator" />
                  <MenuItem label="Add to VCS" onSelect={() => runAction('addToVcs', menuChanges)} />
                  <MenuItem label="Add to .gitignore" onSelect={() => runAction('ignore', menuChanges)} />
                  <MenuItem label="Delete…" onSelect={() => runAction('delete', menuChanges)} />
                </>
              ) : null}
              <div className="menu-separator" />
              <MenuItem label="Show History" disabled={menuChanges.length !== 1 || menuChanges[0]?.status === '?'} onSelect={() => runAction('showHistory', menuChanges)} />
              <MenuItem label="Copy Path" shortcut={`${modKey}C`} disabled={!menuChanges.length} onSelect={() => runAction('copyPath', menuChanges)} />
              <MenuItem label="Copy Absolute Path" disabled={!menuChanges.length} onSelect={() => runAction('copyAbsolutePath', menuChanges)} />
              <MenuItem label="Reveal in Explorer" disabled={!menuChanges.length} onSelect={() => runAction('revealInExplorer', menuChanges)} />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

