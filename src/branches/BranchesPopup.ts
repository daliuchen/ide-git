import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import { classifyGitError } from '../git/classifyGitError';
import type { GitOperationService } from '../git/GitOperationService';
import { GitCommandError, type GitRunner } from '../git/GitRunner';
import type { GitOperationRequest } from '../protocol/messages';
import type { RepositorySummary } from '../shared/models';
import { parseBranchRefs, type BranchRef } from './branchRefs';

type Action = vscode.QuickPickItem & { run?: () => Promise<void> };

/** A branches popup modelled on an IDE branch widget: pick a branch, then an action. */
export class BranchesPopup {
  constructor(
    private readonly runner: GitRunner,
    private readonly operations: GitOperationService,
    private readonly openPush: (repository: RepositorySummary) => Promise<void>,
    private readonly compareWithCurrent: (repository: RepositorySummary, ref: string) => Promise<void>,
  ) {}

  async show(repository: RepositorySummary): Promise<void> {
    const cwd = fileURLToPath(repository.rootUri);
    const result = await this.runner.run(
      [
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(HEAD)%1f',
        'refs/heads',
        'refs/remotes',
      ],
      { cwd, timeoutMs: 30_000 },
    );
    const branches = parseBranchRefs(result.stdout.toString('utf8'));
    const current = branches.find((branch) => branch.current);
    const toItem = (branch: BranchRef): Action & { branch: BranchRef } => ({
      label: `${branch.current ? '$(check)' : branch.kind === 'local' ? '$(git-branch)' : '$(cloud)'} ${branch.name}`,
      description: [branch.track ? `${branch.track.replace('ahead ', '↑').replace('behind ', '↓')}` : '', branch.upstream ? `→ ${branch.upstream}` : '']
        .filter(Boolean)
        .join('  '),
      branch,
    });
    const items: (Action & { branch?: BranchRef })[] = [
      { label: '$(add) New Branch…', run: () => this.newBranch(repository, 'HEAD') },
      { label: '$(git-commit) Checkout Tag or Revision…', run: () => this.checkoutRevision(repository) },
      { label: '$(repo-pull) Update Project…', run: async () => { await vscode.commands.executeCommand('gitLogWorkbench.updateProject', repository.rootUri); } },
      { label: '$(repo-push) Push…', run: () => this.openPush(repository) },
      { label: 'Local', kind: vscode.QuickPickItemKind.Separator },
      ...branches.filter((branch) => branch.kind === 'local').map(toItem),
      { label: 'Remote', kind: vscode.QuickPickItemKind.Separator },
      ...branches.filter((branch) => branch.kind === 'remote').map(toItem),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Branches in ${repository.displayName}${current ? ` (on ${current.name})` : ' (detached HEAD)'}`,
      matchOnDescription: true,
    });
    if (!picked) return;
    if (picked.run) {
      await picked.run();
      return;
    }
    if (picked.branch) await this.showBranchActions(repository, picked.branch, current);
  }

  private async showBranchActions(repository: RepositorySummary, branch: BranchRef, current?: BranchRef): Promise<void> {
    const run = (operation: GitOperationRequest) => () => this.run(repository, operation);
    const currentName = current?.name ?? 'HEAD';
    const actions: Action[] = [];
    if (branch.kind === 'local') {
      if (!branch.current) {
        actions.push({ label: 'Checkout', run: run({ kind: 'checkout', ref: branch.name }) });
      }
      actions.push({ label: `New Branch from '${branch.name}'…`, run: () => this.newBranch(repository, branch.name) });
      if (!branch.current) {
        actions.push(
          { label: `Checkout and Rebase onto '${currentName}'`, run: run({ kind: 'checkoutAndRebase', branch: branch.name }) },
          {
            label: `Compare with '${currentName}'`,
            description: `commits in '${branch.name}' missing from '${currentName}'`,
            run: () => this.compareWithCurrent(repository, `refs/heads/${branch.name}`),
          },
          { label: `Show Diff with Working Tree`, run: () => this.compare(repository, branch.target) },
          { label: `Rebase '${currentName}' onto '${branch.name}'`, run: run({ kind: 'rebase', ref: branch.name }) },
          { label: `Merge '${branch.name}' into '${currentName}'`, run: run({ kind: 'merge', ref: branch.name }) },
        );
        if (branch.upstream) {
          const slash = branch.upstream.indexOf('/');
          if (slash > 0) {
            actions.push({
              label: 'Update',
              description: `fast-forward from ${branch.upstream}`,
              run: run({
                kind: 'updateBranch',
                remote: branch.upstream.slice(0, slash),
                remoteBranch: branch.upstream.slice(slash + 1),
                localBranch: branch.name,
              }),
            });
          }
        }
      } else {
        actions.push({ label: 'Push…', run: () => this.openPush(repository) });
      }
      actions.push({ label: 'Rename…', run: () => this.rename(repository, branch.name) });
      if (!branch.current) {
        actions.push({ label: 'Delete', run: run({ kind: 'deleteBranch', name: branch.name, force: false }) });
      }
    } else {
      const remote = branch.remote ?? '';
      const remoteBranch = branch.name.slice(remote.length + 1);
      actions.push(
        {
          label: 'Checkout',
          description: `as new local branch '${remoteBranch}'`,
          run: run({ kind: 'checkoutRemote', name: remoteBranch, startPoint: branch.name }),
        },
        { label: `New Branch from '${branch.name}'…`, run: () => this.newBranch(repository, branch.name) },
        {
          label: `Compare with '${currentName}'`,
          description: `commits in '${branch.name}' missing from '${currentName}'`,
          run: () => this.compareWithCurrent(repository, `refs/remotes/${branch.name}`),
        },
        { label: `Show Diff with Working Tree`, run: () => this.compare(repository, branch.target) },
        { label: `Rebase '${currentName}' onto '${branch.name}'`, run: run({ kind: 'rebase', ref: branch.name }) },
        { label: `Merge '${branch.name}' into '${currentName}'`, run: run({ kind: 'merge', ref: branch.name }) },
        { label: `Pull into '${currentName}' Using Rebase`, run: run({ kind: 'pullFrom', remote, branch: remoteBranch, rebase: true }) },
        { label: `Pull into '${currentName}' Using Merge`, run: run({ kind: 'pullFrom', remote, branch: remoteBranch, rebase: false }) },
        { label: 'Delete', description: 'on the remote', run: run({ kind: 'deleteRemoteBranch', remote, branch: remoteBranch }) },
      );
    }
    const picked = await vscode.window.showQuickPick(actions, { placeHolder: branch.name });
    await picked?.run?.();
  }

  private async compare(repository: RepositorySummary, target: string): Promise<void> {
    const cwd = fileURLToPath(repository.rootUri);
    const full = await this.runner.run(['rev-parse', '--verify', `${target}^{commit}`], { cwd, timeoutMs: 30_000 });
    await vscode.commands.executeCommand(
      'gitLogWorkbench.compareWithLocal',
      repository.rootUri,
      full.stdout.toString('utf8').trim(),
    );
  }

  private async newBranch(repository: RepositorySummary, startPoint: string): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: `New branch from ${startPoint}`,
      placeHolder: 'Branch name',
      validateInput: (value) => (/^\s*$|\s|\.\.|[~^:?*[\\]/u.test(value) || value.startsWith('-') ? 'Enter a valid branch name.' : undefined),
    });
    if (!name) return;
    const checkout = await vscode.window.showQuickPick(['Create and Checkout', 'Create Only'], { placeHolder: name });
    if (!checkout) return;
    await this.run(repository, { kind: 'createBranch', name, startPoint });
    if (checkout === 'Create and Checkout') await this.run(repository, { kind: 'checkout', ref: name });
  }

  private async checkoutRevision(repository: RepositorySummary): Promise<void> {
    const revision = await vscode.window.showInputBox({ prompt: 'Tag, commit hash, or revision to check out (detached HEAD)' });
    if (!revision?.trim()) return;
    await this.run(repository, { kind: 'checkoutDetached', ref: revision.trim() });
  }

  private async rename(repository: RepositorySummary, oldName: string): Promise<void> {
    const newName = await vscode.window.showInputBox({ prompt: `Rename '${oldName}'`, value: oldName });
    if (!newName || newName === oldName) return;
    await this.run(repository, { kind: 'renameBranch', oldName, newName });
  }

  private async run(repository: RepositorySummary, operation: GitOperationRequest): Promise<void> {
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Git: ${operation.kind}` },
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
      if (!result.cancelled) vscode.window.setStatusBarMessage(`$(check) ${operation.kind} completed`, 4_000);
    } catch (error) {
      const message =
        error instanceof GitCommandError
          ? (({ message: summary, detail }) => (detail ? `${summary}\n${detail}` : summary))(classifyGitError(error))
          : error instanceof Error
            ? error.message
            : String(error);
      void vscode.window.showErrorMessage(message.split('\n')[0] ?? message, { detail: message, modal: false });
    }
  }
}
