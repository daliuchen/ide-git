import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import type { DiffManager } from '../diff/DiffManager';
import { classifyGitError } from '../git/classifyGitError';
import type { GitOperationService } from '../git/GitOperationService';
import { GitCommandError, type GitRunner } from '../git/GitRunner';
import type { GitService } from '../git/GitService';
import type { GitOperationRequest } from '../protocol/messages';
import type { RepositoryRegistry } from '../repositories/RepositoryRegistry';
import type { RepositorySummary } from '../shared/models';
import { createWebviewHtml } from '../webview/createWebviewHtml';
import { loadWebview } from '../webview/loadWebview';
import { isPushRejected } from './pushRejection';
import {
  parseDialogMessage,
  type DialogCommit,
  type DialogExtensionMessage,
  type DialogInit,
  type DialogWebviewMessage,
} from './dialogProtocol';

const COMMIT_FORMAT = '%H%x1f%h%x1f%an%x1f%at%x1f%B%x1e';

function parseCommits(output: string): DialogCommit[] {
  return output
    .split('\x1e')
    .map((record) => record.replace(/^\s+/u, ''))
    .filter(Boolean)
    .map((record) => {
      const [hash = '', shortHash = '', author = '', date = '0', message = ''] = record.split('\x1f');
      const trimmed = message.replace(/\s+$/u, '');
      return {
        hash,
        shortHash,
        author,
        date: Number(date),
        message: trimmed,
        subject: trimmed.split('\n')[0] ?? '',
      };
    });
}

function errorText(error: unknown): string {
  if (error instanceof GitCommandError) {
    const classified = classifyGitError(error);
    return classified.detail ? `${classified.message}\n${classified.detail}` : classified.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** IDE-style modal dialogs (Push, Interactive Rebase, Edit Commit Message) shown as editor panels. */
export class GitDialogs implements vscode.Disposable {
  private readonly panels = new Set<vscode.WebviewPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly runner: GitRunner,
    private readonly gitService: GitService,
    private readonly operations: GitOperationService,
    private readonly registry: RepositoryRegistry,
    private readonly diffManager: DiffManager,
    private readonly output: vscode.OutputChannel,
  ) {}

  dispose(): void {
    for (const panel of [...this.panels]) panel.dispose();
  }

  /** Asks for a remote when the repository has none, like an IDE's “Define remote”. */
  private async defineRemote(repository: RepositorySummary): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      `Repository “${repository.displayName}” has no remote to push to.`,
      { modal: true, detail: 'Define a remote (for example origin → https://github.com/you/repo.git), then push.' },
      'Define Remote…',
    );
    if (choice !== 'Define Remote…') return false;
    const url = await vscode.window.showInputBox({
      title: 'Define Remote',
      prompt: 'Remote URL',
      placeHolder: 'https://github.com/you/repo.git or git@github.com:you/repo.git',
      ignoreFocusOut: true,
      validateInput: (value) =>
        !value.trim() ? 'Enter the remote URL.' : /^-|\s/u.test(value.trim()) ? 'Not a valid URL.' : undefined,
    });
    if (!url) return false;
    const name = await vscode.window.showInputBox({
      title: 'Define Remote',
      prompt: 'Remote name',
      value: 'origin',
      ignoreFocusOut: true,
      validateInput: (value) => (/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value.trim()) ? undefined : 'Not a valid remote name.'),
    });
    if (!name) return false;
    await this.runner.run(['remote', 'add', name.trim(), url.trim()], {
      cwd: fileURLToPath(repository.rootUri),
      timeoutMs: 30_000,
    });
    return true;
  }

  async openPush(repository: RepositorySummary, source = 'HEAD'): Promise<void> {
    const cwd = fileURLToPath(repository.rootUri);
    const [remotesResult, branchResult, upstream] = await Promise.all([
      this.runner.run(['remote'], { cwd, timeoutMs: 30_000 }),
      this.runner.run(['branch', '--show-current'], { cwd, timeoutMs: 30_000 }),
      this.runner
        .run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd, timeoutMs: 30_000 })
        .then((result) => result.stdout.toString('utf8').trim())
        .catch(() => ''),
    ]);
    const remotes = remotesResult.stdout.toString('utf8').split(/\r?\n/u).filter(Boolean);
    if (!remotes.length) {
      if (await this.defineRemote(repository)) await this.openPush(repository, source);
      return;
    }
    const currentBranch = branchResult.stdout.toString('utf8').trim();
    const upstreamRemote = remotes.find((remote) => upstream.startsWith(`${remote}/`));
    const remote = upstreamRemote ?? (remotes.includes('origin') ? 'origin' : (remotes[0] ?? ''));
    const branch = upstreamRemote ? upstream.slice(upstreamRemote.length + 1) : currentBranch;
    const init: DialogInit = {
      dialog: 'push',
      repositoryName: repository.displayName,
      remotes,
      remote,
      branch,
      ...(currentBranch ? { currentBranch } : {}),
      ...(upstream ? { upstream } : {}),
      source,
      setUpstream: !upstream && source === 'HEAD' && Boolean(currentBranch),
    };
    const title = source === 'HEAD' ? `Push Commits — ${repository.displayName}` : `Push up to ${source.slice(0, 8)}`;
    this.open(title, init, async (message, panel, post) => {
      switch (message.type) {
        case 'loadCommits': {
          const remoteRef = `refs/remotes/${message.remote}/${message.branch}`;
          const exists = await this.runner
            .run(['show-ref', '--verify', '--quiet', remoteRef], { cwd, timeoutMs: 30_000 })
            .then(() => true)
            .catch(() => false);
          const range = exists
            ? [`${remoteRef}..${source}`]
            : [source, '--not', `--remotes=${message.remote}`];
          const log = await this.runner.run(['log', `--format=${COMMIT_FORMAT}`, '-n', '500', ...range, '--'], {
            cwd,
            timeoutMs: 60_000,
          });
          await post({
            type: 'commitsLoaded',
            remote: message.remote,
            branch: message.branch,
            commits: parseCommits(log.stdout.toString('utf8')),
            remoteBranchExists: exists,
          });
          return;
        }
        case 'loadFiles':
          await post({ type: 'filesLoaded', hash: message.hash, files: await this.gitService.getChangedFiles(cwd, message.hash) });
          return;
        case 'openFileDiff':
          await this.openCommitFileDiff(repository, message.hash, message.path);
          return;
        case 'push': {
          const operation: GitOperationRequest = {
            kind: 'pushTo',
            remote: message.remote,
            source,
            branch: message.branch,
            setUpstream: message.setUpstream,
            forceWithLease: message.forceWithLease,
            pushTags: message.pushTags,
          };
          const target = `${message.remote}/${message.branch}`;
          let result = await this.tryOperation(repository, operation, `Pushing to ${target}…`);
          if (result.error && !message.forceWithLease && isPushRejected(result.error)) {
            // Like an IDE: offer to update from the remote branch, then push again.
            const choice = await vscode.window.showWarningMessage(
              `Push to ${target} was rejected because it has commits that you do not have locally.`,
              { modal: true, detail: 'Update your branch from the remote, then push again. Local changes are stashed and restored.' },
              'Rebase and Push',
              'Merge and Push',
            );
            if (!choice) return;
            const update = await this.tryOperation(
              repository,
              { kind: 'pullFrom', remote: message.remote, branch: message.branch, rebase: choice === 'Rebase and Push' },
              `Updating from ${target}…`,
            );
            if (update.error) {
              this.reportFailure(update.error);
              return;
            }
            result = await this.tryOperation(repository, operation, `Pushing to ${target}…`);
          }
          if (result.ok) {
            panel.dispose();
            void vscode.window.showInformationMessage(`Pushed to ${target}.`);
          } else if (result.error) {
            this.reportFailure(result.error);
          }
          return;
        }
        default:
          return;
      }
    });
  }

  async openRebase(repository: RepositorySummary, hash: string, mode: 'interactive' | 'reword'): Promise<void> {
    const cwd = fileURLToPath(repository.rootUri);
    let hashes: string[];
    let branch: string | undefined;
    let base: string | undefined;
    if (mode === 'reword') {
      hashes = [hash];
    } else {
      const plan = await this.operations.listLinearCommitsToHead(cwd, hash);
      hashes = plan.hashes;
      branch = plan.branch;
      base = plan.base;
    }
    const log = await this.runner.run(['log', '--no-walk=unsorted', `--format=${COMMIT_FORMAT}`, ...hashes, '--'], {
      cwd,
      timeoutMs: 60_000,
    });
    const commits = parseCommits(log.stdout.toString('utf8'));
    const init: DialogInit = {
      dialog: 'rebase',
      mode,
      repositoryName: repository.displayName,
      ...(branch ? { branch } : {}),
      commits,
    };
    const title =
      mode === 'reword'
        ? `Edit Commit Message — ${commits[0]?.shortHash ?? hash.slice(0, 8)}`
        : `Interactively Rebase ${branch ?? 'HEAD'} from ${commits[0]?.shortHash ?? ''}`;
    this.open(title, init, async (message, panel, post) => {
      switch (message.type) {
        case 'loadFiles':
          await post({ type: 'filesLoaded', hash: message.hash, files: await this.gitService.getChangedFiles(cwd, message.hash) });
          return;
        case 'openFileDiff':
          await this.openCommitFileDiff(repository, message.hash, message.path);
          return;
        case 'reword': {
          const done = await this.runOperation(
            repository,
            { kind: 'rewordCommit', hash: message.hash, message: message.message },
            'Editing commit message…',
          );
          if (done) panel.dispose();
          return;
        }
        case 'rebase': {
          // Close even on failure: a stopped rebase continues from the Git Log's rebase status row.
          await this.runOperation(
            repository,
            { kind: 'interactiveRebase', ...(base ? { base } : {}), steps: message.steps },
            'Rebasing…',
          );
          panel.dispose();
          return;
        }
        default:
          return;
      }
    });
  }

  private async openCommitFileDiff(repository: RepositorySummary, hash: string, path: string): Promise<void> {
    const cwd = fileURLToPath(repository.rootUri);
    const files = await this.gitService.getChangedFiles(cwd, hash);
    const file = files.find((candidate) => candidate.path === path);
    if (!file) return;
    const details = await this.gitService.getCommitDetails(cwd, hash, []);
    this.registry.upsert(repository);
    await this.diffManager.open(repository.id, {
      hash,
      ...(details.parents[0] ? { parent: details.parents[0] } : {}),
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      status: file.status,
    });
  }

  /** Runs an operation with progress; returns false (after reporting) when it fails or is cancelled. */
  private async runOperation(repository: RepositorySummary, operation: GitOperationRequest, title: string): Promise<boolean> {
    const result = await this.tryOperation(repository, operation, title);
    if (result.error) this.reportFailure(result.error);
    return result.ok;
  }

  private reportFailure(text: string): void {
    this.output.appendLine(`[dialog] ${text}`);
    const stopped = /could not apply|conflict|stopped at|You can amend/iu.test(text);
    void (stopped
      ? vscode.window.showWarningMessage(
          'Git stopped for conflicts or an edit. Resolve or amend, then use Continue in the Git Log.',
        )
      : vscode.window.showErrorMessage(text.split('\n')[0] ?? text, { detail: text, modal: false }));
  }

  private async tryOperation(
    repository: RepositorySummary,
    operation: GitOperationRequest,
    title: string,
  ): Promise<{ ok: boolean; error?: string }> {
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
      return { ok: !result.cancelled };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  private open(
    title: string,
    init: DialogInit,
    handle: (
      message: DialogWebviewMessage,
      panel: vscode.WebviewPanel,
      post: (message: DialogExtensionMessage) => Promise<void>,
    ) => Promise<void>,
  ): void {
    const panel = vscode.window.createWebviewPanel('gitLog.dialog', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    });
    this.panels.add(panel);
    const webviewLoad = loadWebview(panel.webview, () =>
      createWebviewHtml({
        cspSource: panel.webview.cspSource,
        scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'dialog.js')).toString(),
        styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'dialog.css')).toString(),
        nonce: randomBytes(18).toString('base64url'),
      }),
    );
    panel.onDidDispose(() => webviewLoad.dispose());
    const post = async (message: DialogExtensionMessage): Promise<void> => {
      await panel.webview.postMessage(message);
    };
    const subscription = panel.webview.onDidReceiveMessage(async (raw: unknown) => {
      const message = parseDialogMessage(raw);
      if (!message) return;
      if (message.type === 'ready') {
        await post({ type: 'init', init });
        return;
      }
      if (message.type === 'cancel') {
        panel.dispose();
        return;
      }
      await post({ type: 'busy', busy: true });
      try {
        await handle(message, panel, post);
      } catch (error) {
        await post({ type: 'error', message: errorText(error) });
      } finally {
        await post({ type: 'busy', busy: false }).catch(() => undefined);
      }
    });
    panel.onDidDispose(() => {
      subscription.dispose();
      this.panels.delete(panel);
    });
  }
}
