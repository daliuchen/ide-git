import { describe, expect, it } from 'vitest';
import type { CommitViewChange, CommitViewRepository } from '../../src/commit/commitProtocol';
import { buildChangeTree, flattenVisible, orderedFileChanges } from '../../webview/src/commit/buildChangeTree';
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

function change(path: string, status: CommitViewChange['status'] = 'M'): CommitViewChange {
  return { path, status, staged: false, unstaged: true, repositoryId: 'r' };
}

describe('buildChangeTree', () => {
  it('groups conflicts, changes, and unversioned files and compacts single-child directory chains', () => {
    const tree = buildChangeTree({
      changes: [
        change('src/commit/a.ts'),
        change('src/commit/b.ts'),
        change('src/webview/c.ts'),
        change('README.md'),
        change('docs/guide/intro.md'),
        change('scratch.txt', '?'),
        change('conflict.ts', 'U'),
      ],
      repositories,
      groupByDirectory: true,
      showUnversioned: true,
    });
    expect(tree.map((node) => node.label)).toEqual(['Merge Conflicts', 'Changes', 'Unversioned Files']);
    const changes = tree[1];
    expect(changes?.children.map((node) => `${node.kind}:${node.label}`)).toEqual([
      'directory:docs/guide',
      'directory:src',
      'file:README.md',
    ]);
    expect(changes?.children[1]?.children.map((node) => node.label)).toEqual(['commit', 'webview']);
    expect(changes?.children[1]?.changes).toHaveLength(3);
  });

  it('lists every file in display order, including collapsed ones', () => {
    const tree = buildChangeTree({
      changes: [change('src/b.ts'), change('README.md'), change('src/a.ts'), change('new.txt', '?'), change('c.ts', 'U')],
      repositories,
      groupByDirectory: true,
      showUnversioned: true,
    });
    expect(orderedFileChanges(tree).map((item) => item.path)).toEqual([
      'c.ts',
      'src/a.ts',
      'src/b.ts',
      'README.md',
      'new.txt',
    ]);
  });

  it('lists files flat with their directory as detail', () => {
    const tree = buildChangeTree({
      changes: [change('src/b.ts'), change('a.ts')],
      repositories,
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

  it('includes tracked changes by default and honours explicit file choices', () => {
    const context: SelectionContext = { hunks: new Map() };
    const tracked = change('a.ts');
    const unversioned = change('c.ts', '?');
    const conflict = change('d.ts', 'U');
    expect([tracked, unversioned, conflict].map((item) => fileIncluded(item, EMPTY_SELECTION))).toEqual([true, false, false]);
    const toggled = setFilesIncluded([tracked, unversioned], false, EMPTY_SELECTION);
    expect(nodeState([tracked, unversioned], toggled, context)).toBe('unchecked');
    const mixed = setFilesIncluded([unversioned], true, toggled);
    expect(nodeState([tracked, unversioned], mixed, context)).toBe('mixed');
  });

  it('selects chunks and individual lines', () => {
    const file = change('a.ts');
    const context: SelectionContext = { hunks: new Map([[`r\0a.ts`, [a, b]]]) };
    expect(commitSelection(file, EMPTY_SELECTION, context)).toEqual({});
    let state = toggleHunk(file, a, EMPTY_SELECTION, context);
    expect(fileState(file, state, context)).toBe('mixed');
    expect(commitSelection(file, state, context)).toEqual({ hunks: [b.id] });
    state = toggleLine(file, b, 1, state, context);
    expect(hunkState(file, b, state)).toBe('mixed');
    expect(commitSelection(file, state, context)).toEqual({ hunks: [b.id], lines: { [b.id]: [0, 2] } });
    expect(commitStats(file, state, context)).toEqual({ additions: 2, deletions: 0 });
    // Unchecking the remaining lines unchecks the chunk, and then nothing is committed.
    state = toggleLine(file, b, 0, toggleLine(file, b, 2, state, context), context);
    expect(commitSelection(file, state, context)).toBeUndefined();
  });

  it('checking one line of an unchecked file selects only that line', () => {
    const file = change('b.ts');
    const context: SelectionContext = { hunks: new Map([[`r\0b.ts`, [a, b]]]) };
    const unchecked = setFilesIncluded([file], false, EMPTY_SELECTION);
    const state = toggleLine(file, b, 2, unchecked, context);
    expect(commitSelection(file, state, context)).toEqual({ hunks: [b.id], lines: { [b.id]: [2] } });
  });

  it('keeps new chunks of a partially selected file unchecked after a reload', () => {
    const file = change('a.ts');
    const context: SelectionContext = { hunks: new Map([[`r\0a.ts`, [a, b]]]) };
    const state = toggleHunk(file, a, EMPTY_SELECTION, context);
    const c = hunk('c'.repeat(16), ['+c']);
    const reloaded = onHunksReloaded(file, [a, b], [b, c], state);
    const nextContext: SelectionContext = { hunks: new Map([[`r\0a.ts`, [b, c]]]) };
    expect(commitSelection(file, reloaded, nextContext)).toEqual({ hunks: [b.id] });
  });
});

describe('findChangeTrail', () => {
  it('returns the group, directories and file node of a change', async () => {
    const { findChangeTrail } = await import('../../webview/src/commit/buildChangeTree');
    const tree = buildChangeTree({
      changes: [change('src/commit/a.ts'), change('src/b.ts'), change('README.md')],
      repositories,
      groupByDirectory: true,
      showUnversioned: true,
    });
    expect(findChangeTrail(tree, { repositoryId: 'r', path: 'src/commit/a.ts' })?.map((node) => node.label)).toEqual([
      'Changes',
      'src',
      'commit',
      'a.ts',
    ]);
    expect(findChangeTrail(tree, { repositoryId: 'r', path: 'missing.ts' })).toBeUndefined();
  });
});
