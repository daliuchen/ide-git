// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DialogExtensionMessage, DialogInit, DialogWebviewMessage } from '../../src/dialogs/dialogProtocol';

const posted: DialogWebviewMessage[] = [];
window.acquireVsCodeApi = () => ({
  postMessage(message: unknown) {
    posted.push(message as DialogWebviewMessage);
  },
  getState: () => undefined,
  setState: () => undefined,
});
const { DialogApp } = await import('../../webview/src/dialog/DialogApp');

afterEach(() => {
  cleanup();
  posted.length = 0;
});

const commit = { hash: 'a'.repeat(40), shortHash: 'aaaaaaa', subject: 'feature one', message: 'feature one', author: 'T', date: 1 };
function open(init: Partial<Extract<DialogInit, { dialog: 'merge' }>> = {}): void {
  render(<DialogApp />);
  const data: DialogExtensionMessage = {
    type: 'init',
    init: {
      dialog: 'merge',
      repositoryName: 'repo',
      ref: 'feature',
      currentBranch: 'main',
      commits: [commit],
      truncated: false,
      canFastForward: true,
      defaultMessage: "Merge branch 'feature' into main",
      ...init,
    },
  };
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data }));
  });
}

describe('Merge dialog', () => {
  it('enables the message only when a merge commit will be created', () => {
    open();
    const message = screen.getByRole('textbox', { name: 'Merge message' });
    expect(screen.getByText('Merge feature into main')).toBeInTheDocument();
    expect(message).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Create a merge commit' }));
    expect(message).toBeEnabled();
    fireEvent.change(message, { target: { value: 'Bring in feature' } });
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    expect(posted.at(-1)).toEqual({ type: 'merge', mode: 'no-ff', noCommit: false, message: 'Bring in feature' });
  });

  it("disables Don't commit for fast-forward only and squash", () => {
    open({ canFastForward: false });
    const stop = screen.getByRole('checkbox', { name: "Don't commit" });
    expect(stop).toBeEnabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Fast-forward only' }));
    expect(stop).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Squash' }));
    expect(stop).toBeDisabled();
    expect(screen.getByText(/review and commit them in the Commit window/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    expect(posted.at(-1)).toEqual({ type: 'merge', mode: 'squash', noCommit: false, message: '' });
  });

  it('cannot merge when everything is already merged', () => {
    open({ commits: [] });
    expect(screen.getByText('Already up to date')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled();
  });
});
