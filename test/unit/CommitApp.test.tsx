// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommitExtensionMessage, CommitWebviewMessage } from '../../src/commit/commitProtocol';
import { DEFAULT_COMMIT_VIEW_LAYOUT } from '../../src/commit/commitProtocol';

const posted: CommitWebviewMessage[] = [];
window.acquireVsCodeApi = () => ({
  postMessage(message: unknown) {
    posted.push(message as CommitWebviewMessage);
  },
  getState: () => undefined,
  setState: () => undefined,
});
Element.prototype.scrollIntoView = () => undefined;
const { CommitApp } = await import('../../webview/src/commit/CommitApp');

afterEach(cleanup);

function dispatch(data: CommitExtensionMessage): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data }));
  });
}

function state(): CommitExtensionMessage {
  const change = (path: string) => ({ path, status: 'M' as const, staged: false, unstaged: true, repositoryId: 'r' });
  return {
    type: 'state',
    repositories: [{ id: 'r', name: 'repo', root: '/repo', truncated: false }],
    changes: [change('app/a.rb'), change('db/mongodb_indexing.rb'), change('spec/a_spec.rb')],
    messageHistory: [],
    layout: DEFAULT_COMMIT_VIEW_LAYOUT,
    checks: { runHooks: true },
    recentAuthors: [],
  };
}

const row = (name: string) => screen.getByText(name).closest('[role="treeitem"]') as HTMLElement;

describe('Commit window follows the active editor', () => {
  it('selects the file open in the editor, once per file change', () => {
    render(<CommitApp />);
    // The active file can arrive before the first state.
    dispatch({ type: 'activeEditorFile', repositoryId: 'r', path: 'app/a.rb' });
    dispatch(state());
    expect(row('a.rb')).toHaveAttribute('aria-selected', 'true');
    expect(row('a.rb')).toHaveAttribute('aria-current', 'true');

    dispatch({ type: 'activeEditorFile', repositoryId: 'r', path: 'db/mongodb_indexing.rb' });
    expect(row('mongodb_indexing.rb')).toHaveAttribute('aria-selected', 'true');
    expect(row('mongodb_indexing.rb')).toHaveAttribute('aria-current', 'true');
    expect(row('a.rb')).toHaveAttribute('aria-selected', 'false');
    expect(row('a.rb')).not.toHaveAttribute('aria-current');

    // A refresh does not take the selection back from the user.
    fireEvent.mouseDown(row('a_spec.rb'), { button: 0 });
    dispatch(state());
    expect(row('a_spec.rb')).toHaveAttribute('aria-selected', 'true');
    expect(row('mongodb_indexing.rb')).toHaveAttribute('aria-selected', 'false');

    dispatch({ type: 'activeEditorFile', repositoryId: 'other', path: 'x.rb' });
    expect(row('a_spec.rb')).toHaveAttribute('aria-selected', 'true');
    expect(posted[0]).toEqual({ type: 'ready' });
  });
});
