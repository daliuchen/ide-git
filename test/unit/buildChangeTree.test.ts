import { describe, expect, it } from 'vitest';
import type { CommitViewChange, CommitViewRepository } from '../../src/commit/commitProtocol';
import { buildChangeTree, flattenVisible } from '../../webview/src/commit/buildChangeTree';
import type { CommitViewHunk } from '../../src/commit/commitProtocol';
import {
  EMPTY_SELECTION,
  commitSelection,
  commitStats,
  fileIncluded,
  fileState,
  hunkState,
  nodeState,
  onHunksReloaded,
  setFilesIncluded,
  toggleHunk,
  toggleLine,
  type SelectionContext,
} from '../../webview/src/commit/selectionModel';

const repositories: CommitViewRepository[] = [{ id: 'r', name: 'repo', root: '/repo', truncated: false }];

function change(path: string, status: CommitViewChange['status'] = 'M', changelistId = 'default'): CommitViewChange {
  return {
    path,
    status,
    staged: false,
    unstaged: true,
    repositoryId: 'r',
    ...(status === '?' || status === 'U' ? {} : { changelistId }),
  };
}

const changelists = [
  { id: 'default', name: 'Changes' },
  { id: 'later', name: 'Later' },
];

describe('buildChangeTree', () => {
  it('groups by changelist and compacts single-child directory chains', () => {
    const tree = buildChangeTree({
      changes: [
        change('src/commit/a.ts'),
        change('src/commit/b.ts'),
        change('src/webview/c.ts'),
        change('README.md'),
        change('docs/guide/intro.md', 'M', 'later'),
        change('scratch.txt', '?'),
        change('conflict.ts', 'U'),
      ],
      repositories,
      changelists,
      activeChangelistId: 'later',
      groupByDirectory: true,
      showUnversioned: true,
    });
    expect(tree.map((node) => node.label)).toEqual(['Merge Conflicts', 'Later', 'Changes', 'Unversioned Files']);
    const later = tree[1];
    expect(later?.children.map((node) => node.label)).toEqual(['docs/guide']);
    const changes = tree[2];
    expect(changes?.children.map((node) => `${node.kind}:${node.label}`)).toEqual(['directory:src', 'file:README.md']);
    expect(changes?.children[0]?.children.map((node) => node.label)).toEqual(['commit', 'webview']);
    expect(changes?.children[0]?.changes).toHaveLength(3);
  });

  it('lists files flat with their directory as detail', () => {
    const tree = buildChangeTree({
      changes: [change('src/b.ts'), change('a.ts')],
      repositories,
      changelists,
      activeChangelistId: 'default',
      groupByDirectory: false,
      showUnversioned: false,
    });
    expect(tree[0]?.children.map((node) => [node.label, node.detail])).toEqual([
      ['a.ts', undefined],
      ['b.ts', 'src'],
    ]);
  });

  it('adds repository nodes when several repositories have changes', () => {
    const tree = buildChangeTree({
      changes: [change('a.ts'), { ...change('b.ts'), repositoryId: 's' }],
      repositories: [...repositories, { id: 's', name: 'second', root: '/second', branch: 'dev', truncated: false }],
      changelists: changelists.slice(0, 1),
      activeChangelistId: 'default',
      groupByDirectory: true,
      showUnversioned: true,
    });
    expect(tree[0]?.children.map((node) => [node.kind, node.label, node.detail])).toEqual([
      ['repository', 'repo', undefined],
      ['repository', 'second', 'dev'],
    ]);
  });

  it('hides collapsed subtrees', () => {
    const tree = buildChangeTree({
      changes: [change('src/a.ts')],
      repositories,
      changelists: changelists.slice(0, 1),
      activeChangelistId: 'default',
      groupByDirectory: true,
      showUnversioned: true,
    });
    expect(flattenVisible(tree, new Set()).map((node) => node.label)).toEqual(['Changes', 'src', 'a.ts']);
    expect(flattenVisible(tree, new Set([tree[0]?.id ?? '']))).toHaveLength(1);
  });
});

function hunk(id: string, lines: string[]): CommitViewHunk {
  return {
    id,
    header: '@@',
    newStart: 1,
    removed: lines.filter((line) => line.startsWith('-')).map((line) => line.slice(1)),
    added: lines.filter((line) => line.startsWith('+')).map((line) => line.slice(1)),
    removedCount: lines.filter((line) => line.startsWith('-')).length,
    addedCount: lines.filter((line) => line.startsWith('+')).length,
    lines,
  };
}

describe('selection model', () => {
  const a = hunk('a'.repeat(16), ['-old a', '+new a']);
  const b = hunk('b'.repeat(16), ['+b1', '+b2', '+b3']);

  it('includes the active changelist by default and honours explicit file choices', () => {
    const context: SelectionContext = { activeChangelistId: 'default', hunks: new Map() };
    const active = change('a.ts');
    const other = change('b.ts', 'M', 'later');
    const unversioned = change('c.ts', '?');
    expect([active, other, unversioned].map((item) => fileIncluded(item, EMPTY_SELECTION, context))).toEqual([true, false, false]);
    const toggled = setFilesIncluded([active, unversioned], undefined, false, EMPTY_SELECTION, context);
    expect(nodeState([active, unversioned], undefined, toggled, context)).toBe('unchecked');
    const mixed = setFilesIncluded([unversioned], undefined, true, toggled, context);
    expect(nodeState([active, unversioned], undefined, mixed, context)).toBe('mixed');
  });

  it('selects chunks and individual lines', () => {
    const file = change('a.ts');
    const context: SelectionContext = { activeChangelistId: 'default', hunks: new Map([[`r\0a.ts`, [a, b]]]) };
    expect(commitSelection(file, EMPTY_SELECTION, context)).toEqual({});
    let state = toggleHunk(file, a, EMPTY_SELECTION, context);
    expect(fileState(file, undefined, state, context)).toBe('mixed');
    expect(commitSelection(file, state, context)).toEqual({ hunks: [b.id] });
    state = toggleLine(file, b, 1, state, context);
    expect(hunkState(file, b, state, context)).toBe('mixed');
    expect(commitSelection(file, state, context)).toEqual({ hunks: [b.id], lines: { [b.id]: [0, 2] } });
    expect(commitStats(file, state, context)).toEqual({ additions: 2, deletions: 0 });
    // Unchecking the remaining lines unchecks the chunk, and then nothing is committed.
    state = toggleLine(file, b, 0, toggleLine(file, b, 2, state, context), context);
    expect(commitSelection(file, state, context)).toBeUndefined();
  });

  it('checking one line of an unchecked file selects only that line', () => {
    const file = change('b.ts', 'M', 'later');
    const context: SelectionContext = { activeChangelistId: 'default', hunks: new Map([[`r\0b.ts`, [a, b]]]) };
    const state = toggleLine(file, b, 2, EMPTY_SELECTION, context);
    expect(commitSelection(file, state, context)).toEqual({ hunks: [b.id], lines: { [b.id]: [2] } });
  });

  it('starts only the active changelist’s chunks of a split file and toggles per group', () => {
    const file = { ...change('split.ts'), hunkChangelists: { [b.id]: 'later' } };
    const context: SelectionContext = { activeChangelistId: 'default', hunks: new Map([[`r\0split.ts`, [a, b]]]) };
    expect(commitSelection(file, EMPTY_SELECTION, context)).toEqual({ hunks: [a.id] });
    expect(fileState(file, 'default', EMPTY_SELECTION, context)).toBe('checked');
    expect(fileState(file, 'later', EMPTY_SELECTION, context)).toBe('unchecked');
    const state = setFilesIncluded([file], 'later', true, EMPTY_SELECTION, context);
    expect(commitSelection(file, state, context)).toEqual({});
  });

  it('keeps new chunks of a partially selected file unchecked after a reload', () => {
    const file = change('a.ts');
    const context: SelectionContext = { activeChangelistId: 'default', hunks: new Map([[`r\0a.ts`, [a, b]]]) };
    const state = toggleHunk(file, a, EMPTY_SELECTION, context);
    const c = hunk('c'.repeat(16), ['+c']);
    const reloaded = onHunksReloaded(file, [a, b], [b, c], state);
    const nextContext: SelectionContext = { ...context, hunks: new Map([[`r\0a.ts`, [b, c]]]) };
    expect(commitSelection(file, reloaded, nextContext)).toEqual({ hunks: [b.id] });
  });
});
