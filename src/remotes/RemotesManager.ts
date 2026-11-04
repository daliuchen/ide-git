import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import { classifyGitError } from '../git/classifyGitError';
import type { GitOperationService } from '../git/GitOperationService';
import { GitCommandError, type GitRunner } from '../git/GitRunner';
import type { GitOperationRequest } from '../protocol/messages';
import type { RepositorySummary } from '../shared/models';
import {
  displayRemoteUrl,
  parseRemotes,
  remoteNameProblem,
  remoteUrlProblem,
  type RemoteInfo,
} from './remotes';

interface Choice extends vscode.QuickPickItem {
  run?: () => Promise<void>;
}

function errorText(error: unknown): string {
  if (error instanceof GitCommandError) {
    const classified = classifyGitError(error);
    return classified.detail ? `${classified.message}\n${classified.detail}` : classified.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** IDE-style Manage Remotes: list, add, edit, rename, fetch and remove remotes. */
export class RemotesManager {
  constructor(
    private readonly runner: GitRunner,
    private readonly operations: GitOperationService,
  ) {}

  async show(repository: RepositorySummary): Promise<void> {
    // Each action comes back to the list, so several changes can be made in a row.
    for (;;) {
      const remotes = await this.list(repository);
      const items: Choice[] = [
        {
          label: '$(add) Add Remote…',
          run: async () => {
            await this.add(repository, remotes);
          },
        },
        ...(remotes.length ? [{ label: 'Remotes', kind: vscode.QuickPickItemKind.Separator }] : []),
        ...remotes.map((remote) => ({
          label: remote.name,
          description: displayRemoteUrl(remote.fetchUrl),
          ...(remote.pushUrl ? { detail: `push: ${displayRemoteUrl(remote.pushUrl)}` } : {}),
          run: () => this.actions(repository, remote, remotes),
        })),
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: `Manage Remotes — ${repository.displayName}`,
        placeHolder: remotes.length ? 'Pick a remote to change it, or add one' : 'This repository has no remotes yet',
        matchOnDescription: true,
      });
      if (!picked?.run) return;
      await picked.run();
    }
  }

  /** Adds a remote; returns whether one was added. */
  async add(repository: RepositorySummary, remotes?: readonly RemoteInfo[]): Promise<boolean> {
    const existing = (remotes ?? (await this.list(repository))).map((remote) => remote.name);
    const name = await vscode.window.showInputBox({
      title: 'Add Remote',
      prompt: 'Remote name',
      value: existing.includes('origin') ? '' : 'origin',
      ignoreFocusOut: true,
      validateInput: (value) => remoteNameProblem(value, existing),
    });
    if (!name) return false;
    const url = await vscode.window.showInputBox({
      title: `Add Remote “${name.trim()}”`,
      prompt: 'Remote URL',
      placeHolder: 'https://github.com/you/repo.git or git@github.com:you/repo.git',
      ignoreFocusOut: true,
      validateInput: remoteUrlProblem,
    });
    if (!url) return false;
    if (!(await this.run(repository, { kind: 'addRemote', name: name.trim(), url: url.trim() }, 'Adding remote…'))) {
      return false;
    }
    const fetch = await vscode.window.showInformationMessage(`Remote “${name.trim()}” added. Fetch it now?`, 'Fetch', 'Later');
    if (fetch === 'Fetch') await this.run(repository, { kind: 'fetch', remote: name.trim() }, `Fetching ${name.trim()}…`);
    return true;
  }

  private async actions(repository: RepositorySummary, remote: RemoteInfo, remotes: readonly RemoteInfo[]): Promise<void> {
    const others = remotes.filter((candidate) => candidate.name !== remote.name).map((candidate) => candidate.name);
    const choices: Choice[] = [
      {
        label: '$(edit) Edit URL…',
        run: async () => {
          const url = await vscode.window.showInputBox({
            title: `Edit URL of “${remote.name}”`,
            prompt: remote.pushUrl ? 'Remote URL (replaces both the fetch and the push URL)' : 'Remote URL',
            value: remote.fetchUrl,
            ignoreFocusOut: true,
            validateInput: remoteUrlProblem,
          });
          if (url && url.trim() !== remote.fetchUrl) {
            await this.run(repository, { kind: 'setRemoteUrl', name: remote.name, url: url.trim() }, 'Updating remote…');
          }
        },
      },
      {
        label: '$(symbol-text) Rename…',
        run: async () => {
          const name = await vscode.window.showInputBox({
            title: `Rename “${remote.name}”`,
            prompt: 'New remote name',
            value: remote.name,
            ignoreFocusOut: true,
            validateInput: (value) => (value.trim() === remote.name ? undefined : remoteNameProblem(value, others)),
          });
          if (name && name.trim() !== remote.name) {
            await this.run(repository, { kind: 'renameRemote', oldName: remote.name, newName: name.trim() }, 'Renaming remote…');
          }
        },
      },
      {
        label: '$(repo-fetch) Fetch',
        run: async () => {
          await this.run(repository, { kind: 'fetch', remote: remote.name }, `Fetching ${remote.name}…`);
        },
      },
      {
        label: '$(copy) Copy URL',
        run: async () => {
          await vscode.env.clipboard.writeText(remote.fetchUrl);
          vscode.window.setStatusBarMessage(`$(check) Copied the URL of ${remote.name}`, 3_000);
        },
      },
      {
        label: '$(trash) Remove…',
        run: async () => {
          await this.run(repository, { kind: 'removeRemote', name: remote.name }, 'Removing remote…');
        },
      },
    ];
    const picked = await vscode.window.showQuickPick(choices, {
      title: `${remote.name} — ${displayRemoteUrl(remote.fetchUrl)}`,
      placeHolder: 'What do you want to do with this remote?',
    });
    await picked?.run?.();
  }

  private async list(repository: RepositorySummary): Promise<RemoteInfo[]> {
    const result = await this.runner.run(['remote', '-v'], { cwd: fileURLToPath(repository.rootUri), timeoutMs: 30_000 });
    return parseRemotes(result.stdout.toString('utf8'));
  }

  /** Runs a remote operation with progress; returns false after reporting a failure or a cancel. */
  private async run(repository: RepositorySummary, operation: GitOperationRequest, title: string): Promise<boolean> {
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: false },
        () =>
          this.operations.run(repository, operation, {
            confirm: async (confirmation) =>
              (await vscode.window.showWarningMessage(
                confirmation.title,
                { modal: true, detail: confirmation.detail },
                confirmation.confirmLabel,
              )) === confirmation.confirmLabel,
          }),
      );
      return !result.cancelled;
    } catch (error) {
      const text = errorText(error);
      void vscode.window.showErrorMessage(text.split('\n')[0] ?? text, { detail: text, modal: false });
      return false;
    }
  }
}
