import type { LocalChange } from './localChanges';

const MAX_ITEMS = 10_000;
const MAX_TEXT = 100_000;

export interface ChangeRef {
  repositoryId: string;
  path: string;
  /** Commit only these hunks of the file (ids from a `hunks` message). */
  hunks?: string[];
  /** For hunks listed in `hunks`, commit only these indexes of their `lines`. */
  lines?: Record<string, number[]>;
}

/** Commit options kept between commits. */
export interface CommitChecks {
  /** Run the repository's Git hooks (off = `--no-verify`). */
  runHooks: boolean;
}

export const DEFAULT_COMMIT_CHECKS: CommitChecks = {
  runHooks: true,
};

export interface CommitViewHunk {
  id: string;
  header: string;
  newStart: number;
  /** Preview lines (truncated); the counts are exact. */
  removed: string[];
  added: string[];
  removedCount: number;
  addedCount: number;
  /** The hunk's `-`/`+`/`\\` lines; line selections index into this. */
  lines: string[];
  /** Too large to select individual lines. */
  linesTruncated?: boolean;
}

export interface CommitViewChange extends LocalChange {
  repositoryId: string;
}

export interface CommitViewRepository {
  id: string;
  name: string;
  root: string;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  operationState?: string;
  truncated: boolean;
}

export interface CommitViewLayout {
  groupByDirectory: boolean;
  messageHeight: number;
  showUnversioned: boolean;
  diffPreviewOnSelect: boolean;
}

export const DEFAULT_COMMIT_VIEW_LAYOUT: CommitViewLayout = {
  groupByDirectory: true,
  messageHeight: 120,
  showUnversioned: true,
  diffPreviewOnSelect: false,
};

export type CommitAction =
  | 'showDiff'
  | 'openSource'
  | 'rollback'
  | 'delete'
  | 'addToVcs'
  | 'ignore'
  | 'showHistory'
  | 'copyPath'
  | 'copyAbsolutePath'
  | 'revealInExplorer'
  | 'acceptOurs'
  | 'acceptTheirs'
  | 'openMerge'
  | 'markResolved';

export type CommitWebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | {
      type: 'action';
      action: CommitAction;
      items: ChangeRef[];
      preview?: boolean;
      /** Every file of the list in display order, so F7 in the diff can continue into the next one. */
      navigation?: ChangeRef[];
    }
  | {
      type: 'commit';
      message: string;
      items: ChangeRef[];
      amend: boolean;
      signOff: boolean;
      push: boolean;
      author?: string;
      checks: CommitChecks;
    }
  | { type: 'shelve'; items: ChangeRef[]; message: string }
  | { type: 'requestAmendMessage'; repositoryId?: string }
  | { type: 'updateChecks'; checks: CommitChecks }
  | { type: 'operationControl'; repositoryId: string; action: 'continue' | 'skip' | 'abort' }
  | { type: 'requestHunks'; item: ChangeRef }
  | { type: 'updateLayout'; layout: CommitViewLayout }
  | { type: 'saveDraft'; message: string };

export type CommitExtensionMessage =
  | {
      type: 'state';
      repositories: CommitViewRepository[];
      changes: CommitViewChange[];
      messageHistory: string[];
      layout: CommitViewLayout;
      draft?: string;
      checks: CommitChecks;
      recentAuthors: string[];
    }
  | { type: 'amendMessage'; message: string }
  | { type: 'committed'; summary: string; keepMessage: boolean }
  | { type: 'busy'; label?: string }
  | { type: 'error'; message: string }
  | { type: 'setMessage'; message: string }
  | { type: 'hunks'; repositoryId: string; path: string; hunks: CommitViewHunk[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0');
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');
}

function parseItems(value: unknown): ChangeRef[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return undefined;
  const items: ChangeRef[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isId(item.repositoryId) || !isText(item.path, 4096) || !item.path) {
      return undefined;
    }
    if (
      item.hunks !== undefined &&
      !(Array.isArray(item.hunks) && item.hunks.length <= 10_000 && item.hunks.every((id) => typeof id === 'string' && /^[0-9a-f]{16}$/u.test(id)))
    ) {
      return undefined;
    }
    let lines: Record<string, number[]> | undefined;
    if (item.lines !== undefined) {
      if (!isRecord(item.lines) || !Array.isArray(item.hunks)) return undefined;
      lines = {};
      for (const [id, indexes] of Object.entries(item.lines)) {
        if (
          !(item.hunks as string[]).includes(id) ||
          !Array.isArray(indexes) ||
          indexes.length > 100_000 ||
          !indexes.every((index) => Number.isSafeInteger(index) && (index as number) >= 0)
        ) {
          return undefined;
        }
        lines[id] = indexes as number[];
      }
    }
    items.push({
      repositoryId: item.repositoryId,
      path: item.path,
      ...(Array.isArray(item.hunks) ? { hunks: item.hunks as string[] } : {}),
      ...(lines ? { lines } : {}),
    });
  }
  return items;
}

const ACTIONS = new Set<CommitAction>([
  'showDiff',
  'openSource',
  'rollback',
  'delete',
  'addToVcs',
  'ignore',
  'showHistory',
  'copyPath',
  'copyAbsolutePath',
  'revealInExplorer',
  'acceptOurs',
  'acceptTheirs',
  'openMerge',
  'markResolved',
]);

function parseLayout(value: unknown): CommitViewLayout | undefined {
  if (!isRecord(value)) return undefined;
  const { groupByDirectory, messageHeight, showUnversioned, diffPreviewOnSelect } = value;
  if (
    typeof groupByDirectory !== 'boolean' ||
    typeof showUnversioned !== 'boolean' ||
    typeof diffPreviewOnSelect !== 'boolean' ||
    typeof messageHeight !== 'number' ||
    !Number.isFinite(messageHeight)
  ) {
    return undefined;
  }
  return {
    groupByDirectory,
    showUnversioned,
    diffPreviewOnSelect,
    messageHeight: Math.min(800, Math.max(48, Math.round(messageHeight))),
  };
}

function parseChecks(value: unknown): CommitChecks | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(DEFAULT_COMMIT_CHECKS) as (keyof CommitChecks)[];
  if (!keys.every((key) => typeof value[key] === 'boolean')) return undefined;
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as unknown as CommitChecks;
}

export function parseCommitWebviewMessage(value: unknown): CommitWebviewMessage | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  switch (value.type) {
    case 'ready':
    case 'refresh':
      return { type: value.type };
    case 'action': {
      const items = parseItems(value.items);
      const navigation = value.navigation === undefined ? undefined : parseItems(value.navigation);
      if (
        !items ||
        (value.navigation !== undefined && !navigation) ||
        typeof value.action !== 'string' ||
        !ACTIONS.has(value.action as CommitAction)
      ) {
        return undefined;
      }
      return {
        type: 'action',
        action: value.action as CommitAction,
        items,
        ...(value.preview === true ? { preview: true } : {}),
        ...(navigation ? { navigation } : {}),
      };
    }
    case 'updateChecks': {
      const checks = parseChecks(value.checks);
      return checks ? { type: 'updateChecks', checks } : undefined;
    }
    case 'commit': {
      const items = parseItems(value.items);
      const checks = parseChecks(value.checks);
      if (
        !items ||
        !checks ||
        !isText(value.message) ||
        typeof value.amend !== 'boolean' ||
        typeof value.signOff !== 'boolean' ||
        typeof value.push !== 'boolean' ||
        (value.author !== undefined && !isText(value.author, 500))
      ) {
        return undefined;
      }
      return {
        type: 'commit',
        message: value.message,
        items,
        amend: value.amend,
        signOff: value.signOff,
        push: value.push,
        checks,
        ...(typeof value.author === 'string' && value.author.trim() ? { author: value.author.trim() } : {}),
      };
    }
    case 'shelve': {
      const items = parseItems(value.items);
      return items && isText(value.message, 10_000)
        ? { type: 'shelve', items, message: value.message }
        : undefined;
    }
    case 'requestAmendMessage':
      return value.repositoryId === undefined
        ? { type: 'requestAmendMessage' }
        : isId(value.repositoryId)
          ? { type: 'requestAmendMessage', repositoryId: value.repositoryId }
          : undefined;
    case 'operationControl':
      return isId(value.repositoryId) && (value.action === 'continue' || value.action === 'skip' || value.action === 'abort')
        ? { type: 'operationControl', repositoryId: value.repositoryId, action: value.action }
        : undefined;
    case 'requestHunks': {
      const [item] = parseItems([value.item]) ?? [];
      return item ? { type: 'requestHunks', item } : undefined;
    }
    case 'updateLayout': {
      const layout = parseLayout(value.layout);
      return layout ? { type: 'updateLayout', layout } : undefined;
    }
    case 'saveDraft':
      return isText(value.message) ? { type: 'saveDraft', message: value.message } : undefined;
    default:
      return undefined;
  }
}
