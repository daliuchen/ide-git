// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../webview/src/App';
import type { WebviewToExtensionMessage } from '../../src/protocol/messages';
import type { WorktreeInfo } from '../../src/shared/models';

const posted: WebviewToExtensionMessage[] = [];
beforeEach(() => {
  posted.length = 0;
  window.acquireVsCodeApi = () => ({
    postMessage(message) {
      posted.push(message);
    },
    getState: () => undefined,
    setState: () => undefined,
  });
});
afterEach(cleanup);

const head = 'a'.repeat(40);
const ref = (name: string, isCurrent = false) => ({
  fullName: `refs/heads/${name}`,
  shortName: name,
  kind: 'local' as const,
  target: head,
  ahead: 0,
  behind: 0,
  isCurrent,
});
const worktree = (path: string, branch: string | undefined, extra: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  path,
  displayPath: path.replace('/Users/me', '~'),
  ...(branch ? { branch } : {}),
  head,
  detached: !branch,
  bare: false,
  isMain: false,
  isCurrent: false,
  ...extra,
});

function show(worktrees: WorktreeInfo[]): void {
  render(<App />);
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'initialize',
          requestId: 'ready',
          repositories: [
            { id: 'repo', rootUri: 'file:///Users/me/app', gitDirUri: 'file:///Users/me/app/.git', displayName: 'app', isBare: false, currentBranch: 'main', head },
          ],
          selectedRepositoryId: 'repo',
          pageSize: 500,
          maxCachedCommits: 5000,
          layout: { refsWidth: 220, filesWidth: 320, detailsHeight: 156, filesViewMode: 'tree' },
        },
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'repositoryData',
          requestId: 'ready',
          repositoryId: 'repo',
          refs: [ref('main', true), ref('feat/x')],
          worktrees,
          commits: [],
          filters: { text: '', branches: [], authors: [], paths: [] },
          replace: true,
          hasMore: false,
        },
      }),
    );
  });
  posted.length = 0;
}

const commands = () =>
  posted.flatMap((message) => (message.type === 'workbenchCommand' ? [message.command] : []));

describe('Worktrees in the Log', () => {
  it('shows the current worktree in the toolbar, even when it is the only one', () => {
    show([worktree('/Users/me/app', 'main', { isMain: true, isCurrent: true })]);
    fireEvent.click(screen.getByRole('button', { name: 'Worktree: main' }));
    const popup = screen.getByRole('dialog', { name: 'Worktrees' });
    fireEvent.click(within(popup).getByRole('button', { name: /New Worktree/u }));
    expect(commands()).toEqual([{ kind: 'newWorktree' }]);
  });

  it('switches from the toolbar list and offers actions on right-click', () => {
    show([
      worktree('/Users/me/app', 'main', { isMain: true, isCurrent: true }),
      worktree('/Users/me/app-feat-x', 'feat/x'),
      worktree('/Users/me/gone', 'old', { prunable: 'gitdir file points to non-existent location' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Worktree: main' }));
    let popup = screen.getByRole('dialog', { name: 'Worktrees' });
    expect(within(popup).getByText('app-feat-x')).toBeInTheDocument();
    expect(within(popup).queryByRole('button', { name: 'Reset filters' })).not.toBeInTheDocument();
    // The current and the stale worktree do nothing on click.
    fireEvent.click(within(popup).getByText('main'));
    fireEvent.click(within(popup).getByText('old'));
    fireEvent.click(within(popup).getByText('feat/x'));
    expect(commands()).toEqual([{ kind: 'worktreeAction', path: '/Users/me/app-feat-x', action: 'switch' }]);
    expect(screen.queryByRole('dialog', { name: 'Worktrees' })).not.toBeInTheDocument();

    posted.length = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Worktree: main' }));
    popup = screen.getByRole('dialog', { name: 'Worktrees' });
    fireEvent.contextMenu(within(popup).getByText('feat/x'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove Worktree…' }));
    expect(commands()).toEqual([{ kind: 'worktreeAction', path: '/Users/me/app-feat-x', action: 'remove' }]);

    posted.length = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Worktree: main' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Worktrees' })).getByRole('button', { name: /Manage Worktrees/u }));
    expect(commands()).toEqual([{ kind: 'manageWorktrees' }]);
  });

  it('marks a branch used by another worktree and switches instead of checking out', () => {
    show([worktree('/Users/me/app', 'main', { isMain: true, isCurrent: true }), worktree('/Users/me/app-feat-x', 'feat/x')]);
    const branch = screen.getByTitle('refs/heads/feat/x — checked out in ~/app-feat-x');
    fireEvent.contextMenu(branch);
    expect(screen.queryByRole('menuitem', { name: 'Checkout' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Switch to Its Worktree' }));
    expect(commands()).toEqual([{ kind: 'worktreeAction', path: '/Users/me/app-feat-x', action: 'switch' }]);

    posted.length = 0;
    fireEvent.contextMenu(screen.getByTitle('refs/heads/main'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Worktree from Here…' }));
    expect(commands()).toEqual([{ kind: 'newWorktree', ref: 'main' }]);
  });
});
