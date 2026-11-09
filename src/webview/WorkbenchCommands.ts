import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import type { DiffManager } from '../diff/DiffManager';
import type { GitRunner } from '../git/GitRunner';
import type { GitService } from '../git/GitService';
import type { WorkbenchCommand } from '../protocol/messages';
import type { RepositoryRegistry } from '../repositories/RepositoryRegistry';
import type { RepositorySummary } from '../shared/models';

export interface WorkbenchCommandHost {
  runner: GitRunner;
  gitService: GitService;
  diffManager: DiffManager;
  repositories: RepositoryRegistry;
  focusCommitPanel(message?: string): Promise<void>;
  openRebaseDialog(repository: RepositorySummary, hash: string, mode: 'interactive' | 'reword'): Promise<void>;
  openMergeDialog(repository: RepositorySummary, ref: string): Promise<void>;
}

/** Runs Git Log actions that open editors, dialogs, or other views rather than changing the repository. */
export async function runWorkbenchCommand(
  host: WorkbenchCommandHost,
  repository: RepositorySummary,
  command: WorkbenchCommand,
): Promise<void> {
  const cwd = fileURLToPath(repository.rootUri);
  const root = vscode.Uri.file(cwd);
  host.repositories.upsert(repository);
  switch (command.kind) {
    case 'compareWithLocal': {
      if (command.path) {
        await host.diffManager.openWorkingFileAgainstRevision(repository.id, {
          revision: command.hash,
          revisionLabel: command.hash.slice(0, 8),
          path: command.path,
          workingFileUri: vscode.Uri.file(join(cwd, command.path)),
          revisionExists: command.status !== 'D',
        });
        return;
      }
      const files = await host.gitService.getWorkingTreeChanges(cwd, command.hash);
      await host.diffManager.openLocalComparison(repository.id, root, command.hash, files);
      return;
    }
    case 'jumpToSource': {
      const uri = vscode.Uri.file(join(cwd, command.path));
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        void vscode.window.showWarningMessage(`${command.path} does not exist in the working tree.`);
        return;
      }
      await vscode.window.showTextDocument(uri, { preview: false });
      return;
    }
    case 'showFileHistory':
      await vscode.commands.executeCommand(
        'gitLogWorkbench.editor.showFileHistory',
        vscode.Uri.file(join(cwd, command.path)),
      );
      return;
    case 'createPatch': {
      const patches: string[] = [];
      // Oldest first, so the patch series applies in order with `git am`.
      const ordered = await host.runner.run(
        ['rev-list', '--no-walk=sorted', '--reverse', ...command.hashes],
        { cwd, timeoutMs: 30_000 },
      );
      for (const hash of ordered.stdout.toString('utf8').trim().split(/\r?\n/u).filter(Boolean)) {
        const result = await host.runner.run(
          ['format-patch', '-1', '--stdout', '--no-color', hash, ...(command.paths ? ['--', ...command.paths] : [])],
          { cwd, timeoutMs: 60_000, env: { GIT_LITERAL_PATHSPECS: '1' } },
        );
        patches.push(result.stdout.toString('utf8'));
      }
      const patch = patches.join('');
      const choice = await vscode.window.showQuickPick(['Save to File…', 'Copy to Clipboard'], {
        placeHolder: `Create patch from ${String(command.hashes.length)} commit${command.hashes.length === 1 ? '' : 's'}`,
      });
      if (choice === 'Copy to Clipboard') {
        await vscode.env.clipboard.writeText(patch);
        void vscode.window.showInformationMessage('Patch copied to the clipboard.');
      } else if (choice) {
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(join(cwd, `${command.hashes[0]?.slice(0, 8) ?? 'changes'}.patch`)),
          filters: { Patch: ['patch', 'diff'] },
        });
        if (target) await vscode.workspace.fs.writeFile(target, Buffer.from(patch, 'utf8'));
      }
      return;
    }
    case 'prepareFixup': {
      const subject = await host.runner.run(['log', '-1', '--format=%s', command.hash, '--'], {
        cwd,
        timeoutMs: 30_000,
      });
      await host.focusCommitPanel(`${command.squash ? 'squash' : 'fixup'}! ${subject.stdout.toString('utf8').trim()}`);
      return;
    }
    case 'openRebaseDialog':
      await host.openRebaseDialog(repository, command.hash, command.mode);
      return;
    case 'openPushDialog':
      await vscode.commands.executeCommand('gitLogWorkbench.push', repository.rootUri, command.source);
      return;
    case 'openMergeDialog':
      await host.openMergeDialog(repository, command.ref);
      return;
    case 'openCommitPanel':
      await host.focusCommitPanel();
      return;
    case 'manageRemotes':
      await vscode.commands.executeCommand('gitLogWorkbench.manageRemotes', repository.rootUri);
      return;
    case 'manageWorktrees':
      await vscode.commands.executeCommand('gitLogWorkbench.manageWorktrees', repository.rootUri);
      return;
    case 'newWorktree':
      await vscode.commands.executeCommand('gitLogWorkbench.newWorktree', repository.rootUri, command.ref);
      return;
    case 'worktreeAction':
      await vscode.commands.executeCommand('gitLogWorkbench.worktreeAction', repository.rootUri, command.path, command.action);
      return;
  }
}
