export const DEFAULT_CHANGELIST_ID = 'default';
const MAX_CHANGELISTS = 50;
const MAX_NAME_LENGTH = 200;

export interface Changelist {
  id: string;
  name: string;
  /** Description; it prefills the commit message when the changelist is committed. */
  comment?: string;
}

export interface ChangelistState {
  lists: Changelist[];
  activeId: string;
  /** Change key (`repositoryId\0path`) to changelist id. Unassigned changes belong to the active list. */
  assignments: Record<string, string>;
  /** Per-file chunk overrides: change key → hunk id → changelist id. */
  hunkAssignments: Record<string, Record<string, string>>;
}

export function changeKey(repositoryId: string, path: string): string {
  return `${repositoryId}\0${path}`;
}

export function createDefaultChangelistState(): ChangelistState {
  return {
    lists: [{ id: DEFAULT_CHANGELIST_ID, name: 'Changes' }],
    activeId: DEFAULT_CHANGELIST_ID,
    assignments: {},
    hunkAssignments: {},
  };
}

/** Repairs persisted state so the default list exists and every reference points at a known list. */
export function normalizeChangelistState(value: unknown): ChangelistState {
  const fallback = createDefaultChangelistState();
  if (typeof value !== 'object' || value === null) return fallback;
  const candidate = value as Partial<ChangelistState>;
  const lists: Changelist[] = [];
  const seen = new Set<string>();
  for (const list of Array.isArray(candidate.lists) ? candidate.lists : []) {
    if (
      typeof list !== 'object' ||
      list === null ||
      typeof list.id !== 'string' ||
      typeof list.name !== 'string' ||
      !list.id ||
      !list.name.trim() ||
      seen.has(list.id)
    ) {
      continue;
    }
    seen.add(list.id);
    lists.push({
      id: list.id,
      name: list.name.slice(0, MAX_NAME_LENGTH),
      ...(typeof list.comment === 'string' && list.comment.trim() ? { comment: list.comment.slice(0, 10_000) } : {}),
    });
  }
  if (!seen.has(DEFAULT_CHANGELIST_ID)) lists.unshift(fallback.lists[0] as Changelist);
  const ids = new Set(lists.map((list) => list.id));
  const assignments: Record<string, string> = {};
  if (typeof candidate.assignments === 'object' && candidate.assignments !== null) {
    for (const [key, id] of Object.entries(candidate.assignments)) {
      if (typeof id === 'string' && ids.has(id)) assignments[key] = id;
    }
  }
  const activeId =
    typeof candidate.activeId === 'string' && ids.has(candidate.activeId)
      ? candidate.activeId
      : DEFAULT_CHANGELIST_ID;
  const hunkAssignments: Record<string, Record<string, string>> = {};
  if (typeof candidate.hunkAssignments === 'object' && candidate.hunkAssignments !== null) {
    for (const [key, hunks] of Object.entries(candidate.hunkAssignments)) {
      if (typeof hunks !== 'object' || hunks === null) continue;
      const valid = Object.fromEntries(
        Object.entries(hunks).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && ids.has(entry[1])),
      );
      if (Object.keys(valid).length) hunkAssignments[key] = valid;
    }
  }
  return { lists: lists.slice(0, MAX_CHANGELISTS), activeId, assignments, hunkAssignments };
}

export function changelistFor(state: ChangelistState, key: string): string {
  return state.assignments[key] ?? state.activeId;
}

/**
 * Pins every current change to a list and forgets changes that disappeared, so a change keeps
 * its list when the active list changes later, and a file changed again starts in the active list.
 */
export function syncAssignments(state: ChangelistState, currentKeys: Iterable<string>): ChangelistState {
  const assignments: Record<string, string> = {};
  const hunkAssignments: Record<string, Record<string, string>> = {};
  for (const key of currentKeys) {
    assignments[key] = changelistFor(state, key);
    const hunks = state.hunkAssignments[key];
    if (hunks) hunkAssignments[key] = hunks;
  }
  return { ...state, assignments, hunkAssignments };
}

/** Forgets chunk assignments whose chunks no longer exist in the file. */
export function pruneHunkAssignments(state: ChangelistState, key: string, currentHunkIds: Iterable<string>): ChangelistState {
  const hunks = state.hunkAssignments[key];
  if (!hunks) return state;
  const current = new Set(currentHunkIds);
  const kept = Object.fromEntries(Object.entries(hunks).filter(([id]) => current.has(id)));
  const hunkAssignments = { ...state.hunkAssignments };
  if (Object.keys(kept).length) hunkAssignments[key] = kept;
  else delete hunkAssignments[key];
  return { ...state, hunkAssignments };
}

/**
 * Moves some chunks of a file to another changelist. When every chunk ends up in one list the
 * file simply moves there, so a file is only split while its chunks really differ.
 */
export function moveHunksToChangelist(
  state: ChangelistState,
  key: string,
  hunkIds: readonly string[],
  allHunkIds: readonly string[],
  listId: string,
): ChangelistState {
  if (!state.lists.some((list) => list.id === listId)) throw new Error('Unknown changelist.');
  const fileList = changelistFor(state, key);
  const hunks = { ...(state.hunkAssignments[key] ?? {}) };
  for (const id of hunkIds) hunks[id] = listId;
  const listsInUse = new Set(allHunkIds.map((id) => hunks[id] ?? fileList));
  const hunkAssignments = { ...state.hunkAssignments };
  const assignments = { ...state.assignments };
  if (listsInUse.size === 1) {
    assignments[key] = [...listsInUse][0] ?? fileList;
    delete hunkAssignments[key];
  } else {
    // Only record chunks that differ from the file's own list.
    hunkAssignments[key] = Object.fromEntries(Object.entries(hunks).filter(([, id]) => id !== fileList));
  }
  return { ...state, assignments, hunkAssignments };
}

export function moveToChangelist(state: ChangelistState, keys: Iterable<string>, listId: string): ChangelistState {
  if (!state.lists.some((list) => list.id === listId)) throw new Error('Unknown changelist.');
  const assignments = { ...state.assignments };
  const hunkAssignments = { ...state.hunkAssignments };
  for (const key of keys) {
    assignments[key] = listId;
    delete hunkAssignments[key];
  }
  return { ...state, assignments, hunkAssignments };
}

function validateName(state: ChangelistState, name: string, exceptId?: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) throw new Error('Enter a changelist name.');
  if (state.lists.some((list) => list.id !== exceptId && list.name === trimmed)) {
    throw new Error(`A changelist named “${trimmed}” already exists.`);
  }
  return trimmed;
}

export function addChangelist(state: ChangelistState, name: string, id: string, comment?: string): ChangelistState {
  if (state.lists.length >= MAX_CHANGELISTS) throw new Error('Too many changelists.');
  const description = comment?.trim();
  return {
    ...state,
    lists: [...state.lists, { id, name: validateName(state, name), ...(description ? { comment: description } : {}) }],
  };
}

export function editChangelist(state: ChangelistState, id: string, name: string, comment: string): ChangelistState {
  const validated = validateName(state, name, id);
  const description = comment.trim();
  return {
    ...state,
    lists: state.lists.map((list) => {
      if (list.id !== id) return list;
      const { comment: _previous, ...rest } = list;
      void _previous;
      return { ...rest, name: validated, ...(description ? { comment: description } : {}) };
    }),
  };
}

export function renameChangelist(state: ChangelistState, id: string, name: string): ChangelistState {
  const validated = validateName(state, name, id);
  return {
    ...state,
    lists: state.lists.map((list) => (list.id === id ? { ...list, name: validated } : list)),
  };
}

/** Removes a list; its changes move to the default list. The default list cannot be removed. */
export function removeChangelist(state: ChangelistState, id: string): ChangelistState {
  if (id === DEFAULT_CHANGELIST_ID) throw new Error('The default changelist cannot be deleted.');
  const assignments: Record<string, string> = {};
  for (const [key, listId] of Object.entries(state.assignments)) {
    assignments[key] = listId === id ? DEFAULT_CHANGELIST_ID : listId;
  }
  const hunkAssignments: Record<string, Record<string, string>> = {};
  for (const [key, hunks] of Object.entries(state.hunkAssignments)) {
    hunkAssignments[key] = Object.fromEntries(
      Object.entries(hunks).map(([hunk, listId]) => [hunk, listId === id ? DEFAULT_CHANGELIST_ID : listId]),
    );
  }
  return {
    lists: state.lists.filter((list) => list.id !== id),
    activeId: state.activeId === id ? DEFAULT_CHANGELIST_ID : state.activeId,
    assignments,
    hunkAssignments,
  };
}

export function setActiveChangelist(state: ChangelistState, id: string): ChangelistState {
  if (!state.lists.some((list) => list.id === id)) throw new Error('Unknown changelist.');
  return { ...state, activeId: id };
}
