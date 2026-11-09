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
  it('is hidden while the repository has a single worktree', () => {
    show([worktree('/Users/me/app', 'main', { isMain: true, isCurrent: true })]);
    expect(screen.queryByRole('region', { name: 'Worktrees' })).not.toBeInTheDocument();
  });

  it('lists worktrees, switches on double-click and offers actions on right-click', () => {
    show([
      worktree('/Users/me/app', 'main', { isMain: true, isCurrent: true }),
      worktree('/Users/me/app-feat-x', 'feat/x'),
      worktree('/Users/me/gone', 'old', { prunable: 'gitdir file points to non-existent location' }),
    ]);
    const section = screen.getByRole('region', { name: 'Worktrees' });
    expect(within(section).getByText('app-feat-x')).toBeInTheDocument();

    fireEvent.doubleClick(within(section).getByText('feat/x'));
    // The current worktree does nothing on double-click.
    fireEvent.doubleClick(within(section).getByText('main'));
    expect(commands()).toEqual([{ kind: 'worktreeAction', path: '/Users/me/app-feat-x', action: 'switch' }]);

    posted.length = 0;
    fireEvent.contextMenu(within(section).getByText('feat/x'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove Worktree…' }));
    expect(commands()).toEqual([{ kind: 'worktreeAction', path: '/Users/me/app-feat-x', action: 'remove' }]);

    fireEvent.contextMenu(within(section).getByText('main'));
    expect(screen.queryByRole('menuitem', { name: 'Remove Worktree…' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Switch to This Worktree' })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });

    posted.length = 0;
    fireEvent.click(within(section).getByRole('button', { name: 'Manage worktrees' }));
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
