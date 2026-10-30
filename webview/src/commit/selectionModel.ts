import type { CommitViewChange, CommitViewHunk } from '../../../src/commit/commitProtocol';
import { changeId } from './buildChangeTree';

/**
 * What the next commit includes, at file, chunk, and line level. Explicit choices are recorded;
 * everything else follows the defaults: tracked changes are included, unversioned files and
 * conflicts are not.
 */
export interface SelectionState {
  included: ReadonlySet<string>;
  excluded: ReadonlySet<string>;
  /** `fileId\0hunkId` */
  includedHunks: ReadonlySet<string>;
  excludedHunks: ReadonlySet<string>;
  /** `fileId\0hunkId\0lineIndex` */
  excludedLines: ReadonlySet<string>;
}

export interface SelectionContext {
  hunks: ReadonlyMap<string, readonly CommitViewHunk[]>;
}

export type CheckState = 'checked' | 'unchecked' | 'mixed';

export const EMPTY_SELECTION: SelectionState = {
  included: new Set(),
  excluded: new Set(),
  includedHunks: new Set(),
  excludedHunks: new Set(),
  excludedLines: new Set(),
};

const hunkKey = (file: string, hunk: string): string => `${file}\0${hunk}`;
const lineKey = (file: string, hunk: string, index: number): string => `${file}\0${hunk}\0${String(index)}`;

/** Indexes of a hunk's `-`/`+` lines, the ones that can be selected individually. */
export function selectableLines(hunk: CommitViewHunk): number[] {
  if (hunk.linesTruncated) return [];
  const indexes: number[] = [];
  hunk.lines.forEach((line, index) => {
    if (line.startsWith('-') || line.startsWith('+')) indexes.push(index);
  });
  return indexes;
}

export function fileIncluded(change: CommitViewChange, state: SelectionState): boolean {
  if (change.status === 'U') return false;
  const id = changeId(change);
  if (state.excluded.has(id)) return false;
  if (state.included.has(id)) return true;
  return change.status !== '?';
}

export function hunkIncluded(
  change: CommitViewChange,
  hunk: CommitViewHunk,
  state: SelectionState,
): boolean {
  if (!fileIncluded(change, state)) return false;
  return !state.excludedHunks.has(hunkKey(changeId(change), hunk.id));
}

export function lineIncluded(
  change: CommitViewChange,
  hunk: CommitViewHunk,
  index: number,
  state: SelectionState,
): boolean {
  return hunkIncluded(change, hunk, state) && !state.excludedLines.has(lineKey(changeId(change), hunk.id, index));
}

export function hunkState(
  change: CommitViewChange,
  hunk: CommitViewHunk,
  state: SelectionState,
): CheckState {
  if (!hunkIncluded(change, hunk, state)) return 'unchecked';
  const file = changeId(change);
  return selectableLines(hunk).some((index) => state.excludedLines.has(lineKey(file, hunk.id, index)))
    ? 'mixed'
    : 'checked';
}

function combine(states: readonly CheckState[]): CheckState {
  if (!states.length) return 'unchecked';
  if (states.every((state) => state === 'checked')) return 'checked';
  if (states.every((state) => state === 'unchecked')) return 'unchecked';
  return 'mixed';
}

export function fileState(change: CommitViewChange, state: SelectionState, context: SelectionContext): CheckState {
  const hunks = context.hunks.get(changeId(change));
  if (!hunks?.length) return fileIncluded(change, state) ? 'checked' : 'unchecked';
  return combine(hunks.map((hunk) => hunkState(change, hunk, state)));
}

export function nodeState(
  changes: readonly CommitViewChange[],
  state: SelectionState,
  context: SelectionContext,
): CheckState {
  return combine(changes.map((change) => fileState(change, state, context)));
}

interface Mutable {
  included: Set<string>;
  excluded: Set<string>;
  includedHunks: Set<string>;
  excludedHunks: Set<string>;
  excludedLines: Set<string>;
}

function clone(state: SelectionState): Mutable {
  return {
    included: new Set(state.included),
    excluded: new Set(state.excluded),
    includedHunks: new Set(state.includedHunks),
    excludedHunks: new Set(state.excludedHunks),
    excludedLines: new Set(state.excludedLines),
  };
}

function clearDetail(next: Mutable, file: string, hunk?: string): void {
  const prefix = hunk ? `${hunkKey(file, hunk)}\0` : `${file}\0`;
  for (const set of [next.includedHunks, next.excludedHunks, next.excludedLines]) {
    for (const key of [...set]) {
      if (key.startsWith(prefix) || (hunk && set !== next.excludedLines && key === hunkKey(file, hunk))) set.delete(key);
    }
  }
}

function includeFile(next: Mutable, file: string, include: boolean): void {
  if (include) {
    next.included.add(file);
    next.excluded.delete(file);
  } else {
    next.excluded.add(file);
    next.included.delete(file);
  }
}

/** Checks or unchecks whole files. */
export function setFilesIncluded(
  changes: readonly CommitViewChange[],
  include: boolean,
  state: SelectionState,
): SelectionState {
  const next = clone(state);
  for (const change of changes) {
    if (change.status === 'U') continue;
    const file = changeId(change);
    includeFile(next, file, include);
    clearDetail(next, file);
  }
  return next;
}

export function toggleHunk(
  change: CommitViewChange,
  hunk: CommitViewHunk,
  state: SelectionState,
  context: SelectionContext,
): SelectionState {
  const next = clone(state);
  const file = changeId(change);
  const key = hunkKey(file, hunk.id);
  const wasFileIncluded = fileIncluded(change, state);
  const include = !hunkIncluded(change, hunk, state);
  clearDetail(next, file, hunk.id);
  if (include) {
    if (!wasFileIncluded) {
      // Checking one chunk of an unchecked file selects only that chunk.
      includeFile(next, file, true);
      for (const other of context.hunks.get(file) ?? []) {
        if (other.id !== hunk.id) next.excludedHunks.add(hunkKey(file, other.id));
      }
    }
    next.includedHunks.add(key);
  } else {
    next.excludedHunks.add(key);
  }
  return next;
}

export function toggleLine(
  change: CommitViewChange,
  hunk: CommitViewHunk,
  index: number,
  state: SelectionState,
  context: SelectionContext,
): SelectionState {
  const file = changeId(change);
  const lines = selectableLines(hunk);
  if (!hunkIncluded(change, hunk, state)) {
    // Checking one line of an unchecked chunk selects only that line.
    const next = clone(toggleHunk(change, hunk, state, context));
    for (const other of lines) if (other !== index) next.excludedLines.add(lineKey(file, hunk.id, other));
    return next;
  }
  const next = clone(state);
  const key = lineKey(file, hunk.id, index);
  if (next.excludedLines.has(key)) next.excludedLines.delete(key);
  else next.excludedLines.add(key);
  if (lines.every((other) => next.excludedLines.has(lineKey(file, hunk.id, other)))) {
    // Unchecking the last line unchecks the chunk.
    for (const other of lines) next.excludedLines.delete(lineKey(file, hunk.id, other));
    next.includedHunks.delete(hunkKey(file, hunk.id));
    next.excludedHunks.add(hunkKey(file, hunk.id));
  }
  return next;
}

export interface FileCommitSelection {
  /** Undefined commits the whole file. */
  hunks?: string[];
  lines?: Record<string, number[]>;
}

/** What to send for an included file, or undefined when nothing of it is selected. */
export function commitSelection(
  change: CommitViewChange,
  state: SelectionState,
  context: SelectionContext,
): FileCommitSelection | undefined {
  if (!fileIncluded(change, state)) return undefined;
  const loaded = context.hunks.get(changeId(change));
  if (!loaded?.length) return {};
  const file = changeId(change);
  const hunks: string[] = [];
  const lines: Record<string, number[]> = {};
  let whole = true;
  for (const hunk of loaded) {
    if (!hunkIncluded(change, hunk, state)) {
      whole = false;
      continue;
    }
    hunks.push(hunk.id);
    const selectable = selectableLines(hunk);
    const chosen = selectable.filter((index) => !state.excludedLines.has(lineKey(file, hunk.id, index)));
    if (chosen.length !== selectable.length) {
      whole = false;
      lines[hunk.id] = chosen;
    }
  }
  if (!hunks.length) return undefined;
  if (whole) return {};
  return { hunks, ...(Object.keys(lines).length ? { lines } : {}) };
}

/** Added and removed line counts of what will actually be committed. */
export function commitStats(
  change: CommitViewChange,
  state: SelectionState,
  context: SelectionContext,
): { additions: number; deletions: number } {
  const selection = commitSelection(change, state, context);
  if (!selection) return { additions: 0, deletions: 0 };
  if (!selection.hunks) return { additions: change.additions ?? 0, deletions: change.deletions ?? 0 };
  let additions = 0;
  let deletions = 0;
  for (const hunk of context.hunks.get(changeId(change)) ?? []) {
    if (!selection.hunks.includes(hunk.id)) continue;
    const chosen = selection.lines?.[hunk.id];
    if (!chosen) {
      additions += hunk.addedCount;
      deletions += hunk.removedCount;
      continue;
    }
    for (const index of chosen) {
      if (hunk.lines[index]?.startsWith('+')) additions += 1;
      else if (hunk.lines[index]?.startsWith('-')) deletions += 1;
    }
  }
  return { additions, deletions };
}

/**
 * Keeps explicit choices consistent after a file's chunks are reloaded: choices for chunks that no
 * longer exist are dropped, and in a partially selected file new chunks start unchecked.
 */
export function onHunksReloaded(
  change: CommitViewChange,
  previous: readonly CommitViewHunk[] | undefined,
  current: readonly CommitViewHunk[],
  state: SelectionState,
): SelectionState {
  const file = changeId(change);
  const prefix = `${file}\0`;
  const valid = new Set(current.map((hunk) => hunk.id));
  const hunkOf = (key: string): string => key.slice(prefix.length).split('\0')[0] ?? '';
  const next = clone(state);
  const partial = [...state.excludedHunks, ...state.excludedLines].some((key) => key.startsWith(prefix));
  for (const set of [next.includedHunks, next.excludedHunks, next.excludedLines]) {
    for (const key of [...set]) if (key.startsWith(prefix) && !valid.has(hunkOf(key))) set.delete(key);
  }
  if (partial && previous) {
    const known = new Set(previous.map((hunk) => hunk.id));
    for (const hunk of current) if (!known.has(hunk.id)) next.excludedHunks.add(hunkKey(file, hunk.id));
  }
  return next;
}

/** Drops choices for files that no longer have changes. */
export function pruneSelection(changes: readonly CommitViewChange[], state: SelectionState): SelectionState {
  const ids = new Set(changes.map(changeId));
  const keep = (key: string): boolean => ids.has(key.split('\0').slice(0, 2).join('\0'));
  return {
    included: new Set([...state.included].filter((id) => ids.has(id))),
    excluded: new Set([...state.excluded].filter((id) => ids.has(id))),
    includedHunks: new Set([...state.includedHunks].filter(keep)),
    excludedHunks: new Set([...state.excludedHunks].filter(keep)),
    excludedLines: new Set([...state.excludedLines].filter(keep)),
  };
}
