import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import { classifyGitError } from '../git/classifyGitError';
import type { GitOperationService } from '../git/GitOperationService';
import { GitCommandError, type GitRunner } from '../git/GitRunner';
import type { GitOperationRequest } from '../protocol/messages';
import type { RepositorySummary, WorktreeInfo } from '../shared/models';
import { openWorktree, type WorktreeOpenMode } from './openWorktree';
import {
  defaultWorktreePath,
  isDirtyWorktreeError,
  parseWorktreeList,
  worktreeLabel,
  worktreePathProblem,
} from './worktrees';

interface Choice extends vscode.QuickPickItem {
  run?: () => Promise<void>;
}

export type WorktreeAction = WorktreeOpenMode | 'reveal' | 'copyPath' | 'remove';

const WORKTREE_ACTIONS: readonly string[] = ['switch', 'newWindow', 'addToWorkspace', 'reveal', 'copyPath', 'remove'];

export function isWorktreeAction(value: unknown): value is WorktreeAction {
  return typeof value === 'string' && WORKTREE_ACTIONS.includes(value);
}

function errorText(error: unknown): string {
  if (error instanceof GitCommandError) {
    const classified = classifyGitError(error);
    return classified.detail ? `${classified.message}\n${classified.detail}` : classified.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function showError(error: unknown): void {
  const text = errorText(error);
  void vscode.window.showErrorMessage(text.split('\n')[0] ?? text, { detail: text, modal: false });
}

const OPEN_CHOICES: readonly { mode: WorktreeOpenMode; label: string; detail: string }[] = [
  { mode: 'switch', label: '$(arrow-swap) Switch to This Worktree', detail: 'Reopen this window in the worktree' },
  { mode: 'newWindow', label: '$(empty-window) Open in New Window', detail: 'Keep this window as it is' },
  { mode: 'addToWorkspace', label: '$(root-folder) Add to Workspace', detail: 'See it next to this repository in the Log and the Commit window' },
];

/** IDE-style worktree management: list, create, open, remove and prune worktrees. */
export class WorktreesManager {
  constructor(
    private readonly runner: GitRunner,
    private readonly operations: GitOperationService,
  ) {}

  async list(repository: RepositorySummary): Promise<WorktreeInfo[]> {
    const root = fileURLToPath(repository.rootUri);
    const result = await this.runner.run(['worktree', 'list', '--porcelain'], { cwd: root, timeoutMs: 30_000 });
    // Git before 2.31 does not report prunable entries; a missing folder is the same thing.
    return parseWorktreeList(result.stdout.toString('utf8'), root).map((worktree) =>
      worktree.prunable || worktree.bare || existsSync(worktree.path) ? worktree : { ...worktree, prunable: 'folder is missing' },
    );
  }

  async show(repository: RepositorySummary): Promise<void> {
    for (;;) {
      const worktrees = await this.list(repository);
      const stale = worktrees.filter((worktree) => worktree.prunable);
      const items: (Choice & { worktree?: WorktreeInfo })[] = [
        { label: '$(add) New Worktree…', run: () => this.create(repository) },
        ...(stale.length
          ? [{ label: '$(trash) Prune Stale Worktrees', description: `${String(stale.length)} missing`, run: () => this.prune(repository) }]
          : []),
        { label: 'Worktrees', kind: vscode.QuickPickItemKind.Separator },
        ...worktrees.map((worktree) => ({
          label: `${worktree.isCurrent ? '$(check)' : worktree.prunable ? '$(warning)' : '$(folder)'} ${worktreeLabel(worktree)}`,
          description: worktree.displayPath,
          detail: [
            worktree.isCurrent ? 'this window' : '',
            worktree.isMain ? 'main worktree' : '',
            worktree.locked !== undefined ? `locked${worktree.locked ? `: ${worktree.locked}` : ''}` : '',
            worktree.prunable ? `stale: ${worktree.prunable}` : '',
          ]
            .filter(Boolean)
            .join(' · '),
          worktree,
        })),
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: `Worktrees — ${repository.displayName}`,
        placeHolder: 'Pick a worktree to switch to it, or create one',
        matchOnDescription: true,
      });
      if (!picked) return;
      if (picked.run) {
        await picked.run();
        continue;
      }
      if (picked.worktree && (await this.actions(repository, picked.worktree)) === 'left') return;
    }
  }

  /** Runs one action on a worktree picked in the Log; the path must be one of this repository's. */
  async runAction(repository: RepositorySummary, path: string, action: WorktreeAction): Promise<void> {
    const worktree = (await this.list(repository)).find((candidate) => candidate.path === path);
    if (!worktree) {
      void vscode.window.showWarningMessage(`${path} is no longer a worktree of ${repository.displayName}.`);
      return;
    }
    await this.perform(repository, worktree, action);
  }

  /** Shows what can be done with a worktree; 'left' when this window is about to switch away. */
  private async actions(repository: RepositorySummary, worktree: WorktreeInfo): Promise<'left' | 'stay'> {
    const choices: (Choice & { action: WorktreeAction })[] = [
      ...(worktree.isCurrent || worktree.bare || worktree.prunable
        ? []
        : OPEN_CHOICES.map(({ mode, label, detail }) => ({ action: mode, label, detail }))),
      ...(worktree.prunable ? [] : [{ action: 'reveal' as const, label: '$(folder-opened) Reveal in File Manager' }]),
      { action: 'copyPath', label: '$(copy) Copy Path' },
      ...(worktree.isMain || worktree.isCurrent || worktree.bare ? [] : [{ action: 'remove' as const, label: '$(trash) Remove…' }]),
    ];
    const picked = await vscode.window.showQuickPick(choices, {
      title: `${worktreeLabel(worktree)} — ${worktree.displayPath}`,
      placeHolder: 'What do you want to do with this worktree?',
    });
    if (!picked) return 'stay';
    await this.perform(repository, worktree, picked.action);
    return picked.action === 'switch' ? 'left' : 'stay';
  }

  private async perform(repository: RepositorySummary, worktree: WorktreeInfo, action: WorktreeAction): Promise<void> {
    switch (action) {
      case 'switch':
      case 'newWindow':
      case 'addToWorkspace':
        if (worktree.isCurrent || worktree.bare) return;
        await openWorktree(worktree.path, action);
        return;
      case 'reveal':
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(worktree.path));
        return;
      case 'copyPath':
        await vscode.env.clipboard.writeText(worktree.path);
        vscode.window.setStatusBarMessage('$(check) Copied the worktree path', 3_000);
        return;
      case 'remove':
        if (worktree.isMain || worktree.isCurrent || worktree.bare) return;
        await this.remove(repository, worktree);
        return;
    }
  }

  /** Creates a worktree for a branch (an existing one, a remote one, or a new one). */
  async create(repository: RepositorySummary, startPoint?: string): Promise<void> {
    const root = fileURLToPath(repository.rootUri);
    const target = await this.pickBranch(repository, startPoint);
    if (!target) return;
    const path = await vscode.window.showInputBox({
      title: `New Worktree for “${target.branch}”`,
      prompt: 'Folder for the worktree (created by Git; it must not exist or must be empty)',
      value: defaultWorktreePath(root, target.branch),
      ignoreFocusOut: true,
      validateInput: (value) => worktreePathProblem(value) ?? (existsSync(value.trim()) ? 'This folder already exists. Git needs a new or empty one.' : undefined),
    });
    if (!path) return;
    const operation: GitOperationRequest = {
      kind: 'addWorktree',
      path: path.trim(),
      ref: target.ref,
      ...(target.newBranch ? { newBranch: target.newBranch } : {}),
      ...(target.track ? { track: true } : {}),
    };
    if (!(await this.run(repository, operation, 'Creating worktree…'))) return;
    // Short labels: notification buttons are cut off after a few words.
    const buttons = { Switch: 'switch', 'New Window': 'newWindow', 'Add to Workspace': 'addToWorkspace' } as const;
    const choice = await vscode.window.showInformationMessage(
      `Worktree for “${target.branch}” created. Switch this window to it?`,
      { detail: path.trim() },
      ...(Object.keys(buttons) as (keyof typeof buttons)[]),
    );
    const mode = choice ? buttons[choice] : undefined;
    if (mode) await openWorktree(path.trim(), mode);
  }

  private async pickBranch(
    repository: RepositorySummary,
    startPoint?: string,
  ): Promise<{ branch: string; ref: string; newBranch?: string; track?: boolean } | undefined> {
    const root = fileURLToPath(repository.rootUri);
    const [refs, worktrees] = await Promise.all([
      this.runner.run(['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes'], { cwd: root, timeoutMs: 30_000 }),
      this.list(repository),
    ]);
    const used = new Map(worktrees.filter((worktree) => worktree.branch).map((worktree) => [worktree.branch ?? '', worktree]));
    const names = refs.stdout.toString('utf8').split(/\r?\n/u).filter(Boolean);
    const local = names.filter((name) => name.startsWith('refs/heads/')).map((name) => name.slice('refs/heads/'.length));
    const remote = names
      .filter((name) => name.startsWith('refs/remotes/') && !name.endsWith('/HEAD'))
      .map((name) => name.slice('refs/remotes/'.length));
    type Pick = vscode.QuickPickItem & { value?: { branch: string; ref: string; newBranch?: string; track?: boolean }; newBranch?: true };
    const newBranchFrom = startPoint ?? 'HEAD';
    const items: Pick[] = [
      { label: '$(add) New Branch…', description: `from ${newBranchFrom}`, newBranch: true },
      { label: 'Local', kind: vscode.QuickPickItemKind.Separator },
      ...local
        .filter((branch) => !used.has(branch))
        .map((branch) => ({ label: `$(git-branch) ${branch}`, value: { branch, ref: branch } })),
      ...local
        .filter((branch) => used.has(branch))
        .map((branch) => ({
          label: `$(lock) ${branch}`,
          description: `in ${used.get(branch)?.displayPath ?? ''}`,
          detail: 'Already checked out in a worktree',
        })),
      { label: 'Remote', kind: vscode.QuickPickItemKind.Separator },
      ...remote.map((name) => {
        const branch = name.slice(name.indexOf('/') + 1);
        return {
          label: `$(cloud) ${name}`,
          ...(local.includes(branch) ? { description: `uses local ${branch}` } : {}),
          value: local.includes(branch) ? { branch, ref: branch } : { branch, ref: name, newBranch: branch, track: true },
        };
      }),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'New Worktree',
      placeHolder: 'Branch to check out in the new worktree',
      matchOnDescription: true,
    });
    if (!picked) return undefined;
    if (picked.newBranch) {
      const name = await vscode.window.showInputBox({
        title: `New Branch from ${newBranchFrom}`,
        prompt: 'Name of the branch the worktree starts on',
        ignoreFocusOut: true,
        validateInput: async (value) => {
          const trimmed = value.trim();
          if (!trimmed) return 'Enter a branch name.';
          if (local.includes(trimmed)) return `A branch named “${trimmed}” already exists.`;
          try {
            await this.runner.run(['check-ref-format', '--branch', trimmed], { cwd: root, timeoutMs: 10_000 });
            return undefined;
          } catch {
            return 'This is not a valid branch name.';
          }
        },
      });
      if (!name) return undefined;
      return { branch: name.trim(), ref: newBranchFrom, newBranch: name.trim() };
    }
    if (!picked.value) {
      const owner = used.get(picked.label.replace(/^\$\(lock\) /u, ''));
      if (owner) {
        void vscode.window.showInformationMessage(`That branch is already checked out in ${owner.displayPath}.`);
      }
      return undefined;
    }
    return picked.value;
  }

  private async remove(repository: RepositorySummary, worktree: WorktreeInfo): Promise<void> {
    try {
      await this.runOrThrow(repository, { kind: 'removeWorktree', path: worktree.path }, 'Removing worktree…');
    } catch (error) {
      if (!(error instanceof GitCommandError && isDirtyWorktreeError(error.stderr.toString('utf8')))) {
        showError(error);
        return;
      }
      // Git refused because of uncommitted work; ask once more before deleting it.
      await this.run(repository, { kind: 'removeWorktree', path: worktree.path, force: true }, 'Removing worktree…');
    }
  }

  private async prune(repository: RepositorySummary): Promise<void> {
    await this.run(repository, { kind: 'pruneWorktrees' }, 'Pruning worktrees…');
  }

  private runOrThrow(repository: RepositorySummary, operation: GitOperationRequest, title: string) {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, () =>
      this.operations.run(repository, operation, {
        confirm: async (confirmation) =>
          (await vscode.window.showWarningMessage(
            confirmation.title,
            { modal: true, detail: confirmation.detail },
            confirmation.confirmLabel,
          )) === confirmation.confirmLabel,
      }),
    );
  }

  /** Runs an operation with progress; false after reporting a failure or a cancel. */
  private async run(repository: RepositorySummary, operation: GitOperationRequest, title: string): Promise<boolean> {
    try {
      return !(await this.runOrThrow(repository, operation, title)).cancelled;
    } catch (error) {
      showError(error);
      return false;
    }
  }
}
