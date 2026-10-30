import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import type { DiffManager } from '../diff/DiffManager';
import { classifyGitError } from '../git/classifyGitError';
import { GitCommandError, type GitRunner } from '../git/GitRunner';
import { discoverRepositories, inspectRepository } from '../repositories/discoverRepositories';
import type { RepositoryRegistry } from '../repositories/RepositoryRegistry';
import type { RepositorySummary } from '../shared/models';
import { createWebviewHtml } from '../webview/createWebviewHtml';
import {
  addChangelist,
  changeKey,
  changelistFor,
  editChangelist,
  moveHunksToChangelist,
  normalizeChangelistState,
  pruneHunkAssignments,
  removeChangelist,
  setActiveChangelist,
  syncAssignments,
  moveToChangelist,
  type ChangelistState,
} from './changelists';
import { CommitCancelled, CommitChecksRunner, type CheckedRepository } from './CommitChecksRunner';
import { templateText } from './commitMessage';
import {
  DEFAULT_COMMIT_CHECKS,
  DEFAULT_COMMIT_VIEW_LAYOUT,
  type CommitChecks,
  parseCommitWebviewMessage,
  type ChangeRef,
  type CommitAction,
  type CommitExtensionMessage,
  type CommitViewChange,
  type CommitViewLayout,
  type CommitViewRepository,
  type CommitWebviewMessage,
} from './commitProtocol';
import type { LocalChange, LocalStatus } from './localChanges';
import type { LocalChangesService } from './LocalChangesService';

const CHANGELIST_KEY = 'commit.changelists';
const LAYOUT_KEY = 'commit.layout';
const DRAFT_KEY = 'commit.draft';
const HISTORY_KEY = 'commit.messageHistory';
const CHECKS_KEY = 'commit.checks';
const AUTHORS_KEY = 'commit.recentAuthors';
const MAX_HISTORY = 30;

/** Resolves symlinks so editor paths and Git's repository paths compare equal (e.g. /tmp on macOS). */
function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

interface RepositorySnapshot {
  repository: RepositorySummary;
  status: LocalStatus;
}

export interface CommitViewHooks {
  /** Pushes after "Commit and Push"; resolves when the push dialog or push has finished. */
  push(repository: RepositorySummary): Promise<void>;
  onDidCommit?(repository: RepositorySummary): void;
}

export class CommitViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private viewDisposables: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private repositories: RepositorySummary[] = [];
  private snapshots = new Map<string, RepositorySnapshot>();
  private discovery: Promise<void> | undefined;
  private refreshing: Promise<void> | undefined;
  private refreshQueued = false;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private stale = true;
  private changelists: ChangelistState;
  private busy = 0;
  private templates = new Map<string, string>();
  private readonly checksRunner: CommitChecksRunner;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly runner: GitRunner,
    private readonly changes: LocalChangesService,
    private readonly registry: RepositoryRegistry,
    private readonly diffManager: DiffManager,
    private readonly hooks: CommitViewHooks,
  ) {
    this.changelists = normalizeChangelistState(context.workspaceState.get(CHANGELIST_KEY));
    this.checksRunner = new CommitChecksRunner(runner, output);
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(
      watcher,
      // File-system events arrive in bursts during builds; saves and Git state changes refresh sooner.
      watcher.onDidChange(() => this.scheduleRefresh(1_000)),
      watcher.onDidCreate(() => this.scheduleRefresh(1_000)),
      watcher.onDidDelete(() => this.scheduleRefresh(1_000)),
      vscode.workspace.onDidSaveTextDocument(() => this.scheduleRefresh(100)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.discovery = undefined;
        this.scheduleRefresh(0);
      }),
    );
    void this.subscribeToGitExtension();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    for (const disposable of this.viewDisposables.splice(0)) disposable.dispose();
    this.view = view;
    const extensionUri = this.context.extensionUri;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
    };
    view.webview.html = createWebviewHtml({
      cspSource: view.webview.cspSource,
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'commit.js')).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'commit.css')).toString(),
      nonce: randomBytes(18).toString('base64url'),
    });
    this.viewDisposables.push(
      view.webview.onDidReceiveMessage((raw: unknown) => {
        const message = parseCommitWebviewMessage(raw);
        if (!message) {
          this.output.appendLine('[commit] Ignored an invalid webview message.');
          return;
        }
        void this.handle(message).catch((error: unknown) => this.reportError(error));
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible && this.stale) this.scheduleRefresh(0);
      }),
      view.onDidDispose(() => {
        if (this.view === view) this.view = undefined;
        for (const disposable of this.viewDisposables.splice(0)) disposable.dispose();
      }),
    );
  }

  /** Focuses the Commit view, optionally prefilling the message (used by Undo Commit). */
  async focus(message?: string): Promise<void> {
    await vscode.commands.executeCommand('gitLogWorkbench.commit.focus');
    if (message !== undefined) {
      await this.context.workspaceState.update(DRAFT_KEY, message);
      await this.post({ type: 'setMessage', message });
    }
  }

  scheduleRefresh(delayMs = 400): void {
    this.stale = true;
    if (!this.view?.visible) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh().catch((error: unknown) => this.reportError(error));
    }, delayMs);
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const disposable of [...this.viewDisposables.splice(0), ...this.disposables.splice(0)]) {
      disposable.dispose();
    }
  }

  private async subscribeToGitExtension(): Promise<void> {
    interface GitApi {
      repositories: readonly { state: { onDidChange(listener: () => void): vscode.Disposable } }[];
      onDidOpenRepository(
        listener: (repository: { state: { onDidChange(listener: () => void): vscode.Disposable } }) => void,
      ): vscode.Disposable;
    }
    try {
      const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
      if (!extension) return;
      const api = (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
      for (const repository of api.repositories) {
        this.disposables.push(repository.state.onDidChange(() => this.scheduleRefresh(150)));
      }
      this.disposables.push(
        api.onDidOpenRepository((repository) => {
          this.disposables.push(repository.state.onDidChange(() => this.scheduleRefresh(150)));
          this.discovery = undefined;
          this.scheduleRefresh(0);
        }),
      );
    } catch (error) {
      this.output.appendLine(`[commit] unable to subscribe to Git changes: ${String(error)}`);
    }
  }

  private async discover(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('gitLogWorkbench');
    const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const discovered = await discoverRepositories(roots, this.runner, {
      scanDepth: configuration.get<number>('repositories.scanDepth', 2),
      excludePatterns: configuration.get<string[]>('repositories.exclude', ['**/node_modules/**', '**/.worktrees/**']),
    });
    this.repositories = discovered.filter((repository) => !repository.isBare);
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.refreshQueued = false;
        this.stale = false;
        this.discovery ??= this.discover();
        await this.discovery;
        const snapshots = new Map<string, RepositorySnapshot>();
        await Promise.all(
          this.repositories.map(async (known) => {
            const cwd = fileURLToPath(known.rootUri);
            const repository = (await inspectRepository(cwd, this.runner)) ?? known;
            this.registry.upsert(repository);
            const status = await this.changes.getStatus(cwd);
            snapshots.set(repository.id, { repository, status });
          }),
        );
        this.snapshots = snapshots;
        await this.loadTemplates();
        const keys: string[] = [];
        for (const { repository, status } of snapshots.values()) {
          for (const change of status.changes) {
            if (change.status !== '?' && change.status !== 'U') keys.push(changeKey(repository.id, change.path));
          }
        }
        // Load the chunks of split files first, then apply everything to the latest changelist
        // state in one synchronous step, so a change made meanwhile (say, a new active
        // changelist) is not overwritten by a stale copy.
        const currentHunks = new Map<string, string[]>();
        for (const key of Object.keys(this.changelists.hunkAssignments)) {
          const [repositoryId = '', path = ''] = key.split('\0');
          const snapshot = snapshots.get(repositoryId);
          if (!snapshot) continue;
          const patch = await this.changes.getHunks(fileURLToPath(snapshot.repository.rootUri), path);
          currentHunks.set(key, patch.hunks.map((hunk) => hunk.id));
        }
        let state = syncAssignments(this.changelists, keys);
        for (const [key, ids] of currentHunks) state = pruneHunkAssignments(state, key, ids);
        await this.saveChangelists(state);
        await this.postState();
      } while (this.refreshQueued);
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async postState(): Promise<void> {
    const repositories: CommitViewRepository[] = [];
    const changes: CommitViewChange[] = [];
    for (const { repository, status } of this.snapshots.values()) {
      repositories.push({
        id: repository.id,
        name: repository.displayName,
        root: fileURLToPath(repository.rootUri),
        ...(status.branch.branch ? { branch: status.branch.branch } : {}),
        ...(status.branch.upstream ? { upstream: status.branch.upstream } : {}),
        ...(status.branch.ahead === undefined ? {} : { ahead: status.branch.ahead }),
        ...(status.branch.behind === undefined ? {} : { behind: status.branch.behind }),
        ...(repository.operationState ? { operationState: repository.operationState } : {}),
        truncated: status.truncated,
      });
      for (const change of status.changes) {
        const inChangelist = change.status !== '?' && change.status !== 'U';
        const hunkChangelists = inChangelist
          ? this.changelists.hunkAssignments[changeKey(repository.id, change.path)]
          : undefined;
        changes.push({
          ...change,
          repositoryId: repository.id,
          ...(inChangelist
            ? { changelistId: changelistFor(this.changelists, changeKey(repository.id, change.path)) }
            : {}),
          ...(hunkChangelists ? { hunkChangelists } : {}),
        });
      }
    }
    repositories.sort((left, right) => left.root.localeCompare(right.root));
    const draft = this.context.workspaceState.get<string>(DRAFT_KEY);
    const template = this.template();
    await this.post({
      type: 'state',
      repositories,
      changes,
      changelists: this.changelists.lists,
      activeChangelistId: this.changelists.activeId,
      messageHistory: this.context.globalState.get<string[]>(HISTORY_KEY, []),
      layout: { ...DEFAULT_COMMIT_VIEW_LAYOUT, ...this.context.workspaceState.get<CommitViewLayout>(LAYOUT_KEY) },
      ...(draft ? { draft } : {}),
      ...(template ? { template } : {}),
      checks: this.checks(),
      recentAuthors: this.context.globalState.get<string[]>(AUTHORS_KEY, []),
      messageRules: {
        subjectLength: vscode.workspace.getConfiguration('gitLogWorkbench').get<number>('commit.subjectLength', 72),
        bodyLineLength: vscode.workspace.getConfiguration('gitLogWorkbench').get<number>('commit.bodyLineLength', 72),
        blankLineAfterSubject: vscode.workspace
          .getConfiguration('gitLogWorkbench')
          .get<boolean>('commit.blankLineAfterSubject', true),
      },
    });
  }

  private checks(): CommitChecks {
    return { ...DEFAULT_COMMIT_CHECKS, ...this.context.workspaceState.get<Partial<CommitChecks>>(CHECKS_KEY) };
  }

  /** The `commit.template` of the only repository, or of the first repository that has one. */
  private template(): string | undefined {
    for (const snapshot of this.snapshots.values()) {
      const template = this.templates.get(snapshot.repository.id);
      if (template) return template;
    }
    return undefined;
  }

  private async loadTemplates(): Promise<void> {
    const templates = new Map<string, string>();
    for (const { repository } of this.snapshots.values()) {
      const cwd = fileURLToPath(repository.rootUri);
      try {
        const configured = await this.runner.run(['config', '--path', '--get', 'commit.template'], { cwd, timeoutMs: 10_000 });
        const path = configured.stdout.toString('utf8').trim();
        if (!path) continue;
        const text = templateText(await readFile(path.startsWith('/') ? path : join(cwd, path), 'utf8'));
        if (text) templates.set(repository.id, text);
      } catch {
        // No template configured, or it cannot be read.
      }
    }
    this.templates = templates;
  }

  private async handle(message: CommitWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.stale = true;
        if (this.snapshots.size) await this.postState();
        await this.refresh();
        return;
      case 'refresh':
        this.discovery = undefined;
        await this.refresh();
        return;
      case 'updateLayout':
        await this.context.workspaceState.update(LAYOUT_KEY, message.layout);
        return;
      case 'saveDraft':
        await this.context.workspaceState.update(DRAFT_KEY, message.message || undefined);
        return;
      case 'requestAmendMessage': {
        const repository = this.amendRepository(message.repositoryId);
        const amendMessage = repository?.head
          ? await this.changes.getHeadMessage(fileURLToPath(repository.rootUri))
          : '';
        await this.post({ type: 'amendMessage', message: amendMessage });
        return;
      }
      case 'commit':
        await this.commit(message);
        return;
      case 'requestHunks': {
        const snapshot = this.snapshots.get(message.item.repositoryId);
        const patch = snapshot
          ? await this.changes.getHunks(fileURLToPath(snapshot.repository.rootUri), message.item.path)
          : { header: '', hunks: [] };
        await this.post({
          type: 'hunks',
          repositoryId: message.item.repositoryId,
          path: message.item.path,
          hunks: patch.hunks.map((hunk) => ({
            id: hunk.id,
            header: hunk.header,
            newStart: hunk.newStart,
            removed: hunk.removed.slice(0, 50),
            added: hunk.added.slice(0, 50),
            removedCount: hunk.removed.length,
            addedCount: hunk.added.length,
            ...(hunk.body.length > 2_000
              ? { lines: [], linesTruncated: true }
              : { lines: hunk.body }),
          })),
        });
        return;
      }
      case 'shelve':
        await this.withBusy('Shelving…', async () => {
          for (const [snapshot, changes] of this.resolve(message.items)) {
            await this.changes.shelve(fileURLToPath(snapshot.repository.rootUri), changes, message.message);
          }
        });
        void vscode.window.showInformationMessage('Changes shelved. Use Stashes in the Git Log to unshelve them.');
        await this.refresh();
        return;
      case 'newChangelist': {
        const name = await vscode.window.showInputBox({ prompt: 'New changelist name', placeHolder: 'Changelist name' });
        if (!name) return;
        const comment = await vscode.window.showInputBox({
          prompt: `Description for “${name}” (optional; prefills the commit message)`,
          placeHolder: 'Description',
        });
        if (comment === undefined) return;
        const id = randomBytes(8).toString('hex');
        let state = addChangelist(this.changelists, name, id, comment);
        if (message.items.length) {
          state = moveToChangelist(state, message.items.map((item) => changeKey(item.repositoryId, item.path)), id);
        }
        await this.saveChangelists(state);
        await this.postState();
        return;
      }
      case 'renameChangelist': {
        const current = this.changelists.lists.find((list) => list.id === message.id);
        if (!current) return;
        const name = await vscode.window.showInputBox({ prompt: 'Changelist name', value: current.name });
        if (!name) return;
        const comment = await vscode.window.showInputBox({
          prompt: `Description for “${name}” (optional; prefills the commit message)`,
          value: current.comment ?? '',
        });
        if (comment === undefined) return;
        await this.saveChangelists(editChangelist(this.changelists, message.id, name, comment));
        await this.postState();
        return;
      }
      case 'deleteChangelist': {
        const current = this.changelists.lists.find((list) => list.id === message.id);
        if (!current) return;
        const confirmed = await vscode.window.showWarningMessage(
          `Delete changelist “${current.name}”?`,
          { modal: true, detail: 'Its changes move to the default changelist. Files are not modified.' },
          'Delete',
        );
        if (confirmed !== 'Delete') return;
        await this.saveChangelists(removeChangelist(this.changelists, message.id));
        await this.postState();
        return;
      }
      case 'setActiveChangelist':
        await this.saveChangelists(setActiveChangelist(this.changelists, message.id));
        await this.postState();
        return;
      case 'action':
        await this.runAction(message.action, message.items, message.preview === true, message.changelistId);
        return;
      case 'updateChecks':
        await this.context.workspaceState.update(CHECKS_KEY, message.checks);
        return;
      case 'moveHunks': {
        const snapshot = this.snapshots.get(message.item.repositoryId);
        if (!snapshot) return;
        const listId = message.changelistId ?? (await this.pickChangelist());
        if (!listId) return;
        const patch = await this.changes.getHunks(fileURLToPath(snapshot.repository.rootUri), message.item.path);
        const all = patch.hunks.map((hunk) => hunk.id);
        if (!message.hunkIds.every((id) => all.includes(id))) {
          throw new Error('The file changed since its chunks were listed. Try again.');
        }
        await this.saveChangelists(
          moveHunksToChangelist(this.changelists, changeKey(message.item.repositoryId, message.item.path), message.hunkIds, all, listId),
        );
        await this.postState();
        return;
      }
    }
  }

  private amendRepository(repositoryId?: string): RepositorySummary | undefined {
    if (repositoryId) return this.snapshots.get(repositoryId)?.repository;
    const snapshots = [...this.snapshots.values()];
    if (snapshots.length === 1) return snapshots[0]?.repository;
    const active = vscode.window.activeTextEditor?.document.uri;
    return snapshots.find(
      (snapshot) => active?.scheme === 'file' && active.fsPath.startsWith(fileURLToPath(snapshot.repository.rootUri)),
    )?.repository ?? snapshots.find((snapshot) => snapshot.status.changes.length > 0)?.repository;
  }

  private async commit(message: Extract<CommitWebviewMessage, { type: 'commit' }>): Promise<void> {
    let groups = this.resolve(message.items);
    if (!groups.length && message.amend) {
      const repository = this.amendRepository();
      const snapshot = repository ? this.snapshots.get(repository.id) : undefined;
      if (snapshot) groups = [[snapshot, []]];
    }
    if (!groups.length) throw new Error('Select at least one change to commit.');
    if (message.amend && groups.length > 1) {
      throw new Error('Amend works on one repository at a time; select changes from a single repository.');
    }
    const template = this.template();
    if (template && message.message.trim() === template.trim()) {
      throw new Error('Edit the commit message template before committing.');
    }
    // Like an IDE commit, unsaved edits to the selected files are saved first so they are included.
    const selectedPaths = new Set(
      groups.flatMap(([snapshot, changes]) => changes.map((change) => realPath(this.uriFor(snapshot, change.path).fsPath))),
    );
    for (const document of vscode.workspace.textDocuments) {
      if (document.isDirty && document.uri.scheme === 'file' && selectedPaths.has(realPath(document.uri.fsPath))) {
        if (!(await document.save())) throw new Error(`Unable to save ${document.uri.fsPath} before committing.`);
      }
    }
    await this.context.workspaceState.update(CHECKS_KEY, message.checks);
    const partialPaths = new Set(
      message.items.filter((item) => item.hunks).map((item) => `${item.repositoryId}\0${item.path}`),
    );
    const checked: CheckedRepository[] = groups.map(([snapshot, changes]) => ({
      root: fileURLToPath(snapshot.repository.rootUri),
      files: changes.map((change) => ({
        uri: this.uriFor(snapshot, change.path),
        change,
        partial: partialPaths.has(`${snapshot.repository.id}\0${change.path}`),
      })),
    }));
    let notes: string[];
    try {
      notes = await this.withBusy('Running commit checks…', () => this.checksRunner.run(checked, message.checks));
    } catch (error) {
      if (error instanceof CommitCancelled) {
        await this.post({ type: 'busy' });
        await this.post({ type: 'error', message: error.message });
        return;
      }
      throw error;
    }
    if (message.author) await this.rememberAuthor(message.author);
    const committed: { repository: RepositorySummary; hash: string }[] = [];
    await this.withBusy(message.amend ? 'Amending…' : 'Committing…', async () => {
      for (const [snapshot, changes] of groups) {
        const partial = new Map<string, (string | { id: string; lines: number[] })[]>();
        for (const item of message.items) {
          if (item.repositoryId !== snapshot.repository.id || !item.hunks) continue;
          partial.set(
            item.path,
            item.hunks.map((id) => (item.lines?.[id] ? { id, lines: item.lines[id] } : id)),
          );
        }
        const hash = await this.changes.commit(fileURLToPath(snapshot.repository.rootUri), {
          message: message.message,
          changes,
          ...(partial.size ? { partial } : {}),
          amend: message.amend,
          signOff: message.signOff,
          ...(message.author ? { author: message.author } : {}),
          ...(message.checks.runHooks ? {} : { noVerify: true }),
          inProgressOperation: Boolean(
            snapshot.repository.operationState && snapshot.repository.operationState !== 'rebase',
          ),
        });
        committed.push({ repository: snapshot.repository, hash });
        this.hooks.onDidCommit?.(snapshot.repository);
      }
    });
    await this.rememberMessage(message.message);
    await this.context.workspaceState.update(DRAFT_KEY, undefined);
    const fileCount = groups.reduce((total, [, changes]) => total + changes.length, 0);
    await this.post({
      type: 'committed',
      summary: `${message.amend ? 'Amended' : 'Committed'} ${String(fileCount)} file${fileCount === 1 ? '' : 's'} (${committed
        .map((entry) => `${entry.repository.displayName}@${entry.hash}`)
        .join(', ')})${notes.length ? `. ${notes.join(' ')}` : ''}`,
      keepMessage: false,
    });
    await this.refresh();
    if (message.push) {
      for (const { repository } of committed) await this.hooks.push(repository);
    }
  }

  private async rememberAuthor(author: string): Promise<void> {
    const authors = this.context.globalState.get<string[]>(AUTHORS_KEY, []).filter((entry) => entry !== author);
    await this.context.globalState.update(AUTHORS_KEY, [author, ...authors].slice(0, 10));
  }

  private async pickChangelist(): Promise<string | undefined> {
    const picked = await vscode.window.showQuickPick(
      [
        ...this.changelists.lists.map((list) => ({
          label: list.name,
          description: list.id === this.changelists.activeId ? 'active' : (list.comment ?? ''),
          id: list.id,
        })),
        { label: '$(add) New Changelist…', description: '', id: '' },
      ],
      { placeHolder: 'Move to changelist' },
    );
    if (!picked) return undefined;
    if (picked.id) return picked.id;
    const name = await vscode.window.showInputBox({ prompt: 'New changelist name' });
    if (!name) return undefined;
    const id = randomBytes(8).toString('hex');
    await this.saveChangelists(addChangelist(this.changelists, name, id));
    return id;
  }

  /**
   * Commits only the change (hunk) under the cursor in the active editor, like committing a single
   * change from the editor gutter.
   */
  async commitChangeAtCursor(amend: boolean): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('Open a file in a Git repository first.');
      return;
    }
    if (editor.document.isDirty && !(await editor.document.save())) return;
    this.discovery ??= this.discover();
    await this.discovery;
    const filePath = realPath(editor.document.uri.fsPath);
    const repository = this.repositories
      .filter((candidate) => filePath.startsWith(`${realPath(fileURLToPath(candidate.rootUri))}/`))
      .sort((left, right) => right.rootUri.length - left.rootUri.length)[0];
    if (!repository) {
      void vscode.window.showInformationMessage('This file is not in a Git repository of the workspace.');
      return;
    }
    const cwd = fileURLToPath(repository.rootUri);
    const path = filePath.slice(realPath(cwd).length + 1).split('\\').join('/');
    const line = editor.selection.active.line + 1;
    const patch = await this.changes.getHunks(cwd, path);
    const hunk = patch.hunks.find((candidate) =>
      candidate.newLines === 0
        ? line === candidate.newStart || line === candidate.newStart + 1
        : line >= candidate.newStart && line < candidate.newStart + candidate.newLines,
    );
    if (!hunk) {
      void vscode.window.showInformationMessage('There is no uncommitted change at the cursor.');
      return;
    }
    const status = await this.changes.getStatus(cwd);
    const change = status.changes.find((candidate) => candidate.path === path);
    if (!change) return;
    const summary = `L${String(hunk.newStart)}: +${String(hunk.added.length)} −${String(hunk.removed.length)}`;
    let message: string;
    if (amend) {
      message = await this.changes.getHeadMessage(cwd);
    } else {
      message =
        (await vscode.window.showInputBox({
          title: `Commit This Change (${path} ${summary})`,
          prompt: 'Commit message',
          value: this.templates.get(repository.id) ?? '',
          validateInput: (value) => (value.trim() ? undefined : 'Enter a commit message.'),
        })) ?? '';
      if (!message) return;
    }
    const hash = await this.changes.commit(cwd, {
      message,
      changes: [change],
      amend,
      signOff: false,
      inProgressOperation: false,
      partial: new Map([[path, [hunk.id]]]),
      // Follows the Commit view's "Run Git hooks" option.
      ...(this.checks().runHooks ? {} : { noVerify: true }),
    });
    if (!amend) await this.rememberMessage(message);
    vscode.window.setStatusBarMessage(`$(check) ${amend ? 'Amended' : 'Committed'} ${path} ${summary} (${hash})`, 5_000);
    this.scheduleRefresh(0);
  }

  private async rememberMessage(message: string): Promise<void> {
    const trimmed = message.trim();
    const history = this.context.globalState.get<string[]>(HISTORY_KEY, []).filter((entry) => entry !== trimmed);
    await this.context.globalState.update(HISTORY_KEY, [trimmed, ...history].slice(0, MAX_HISTORY));
  }

  private resolve(items: readonly ChangeRef[]): [RepositorySnapshot, LocalChange[]][] {
    const groups = new Map<string, [RepositorySnapshot, LocalChange[]]>();
    for (const item of items) {
      const snapshot = this.snapshots.get(item.repositoryId);
      const change = snapshot?.status.changes.find((candidate) => candidate.path === item.path);
      if (!snapshot || !change) continue;
      const group = groups.get(item.repositoryId) ?? [snapshot, []];
      group[1].push(change);
      groups.set(item.repositoryId, group);
    }
    return [...groups.values()];
  }

  private uriFor(snapshot: RepositorySnapshot, path: string): vscode.Uri {
    return vscode.Uri.file(join(fileURLToPath(snapshot.repository.rootUri), path));
  }

  private async runAction(
    action: CommitAction,
    items: readonly ChangeRef[],
    preview: boolean,
    targetChangelistId?: string,
  ): Promise<void> {
    const groups = this.resolve(items);
    const all = groups.flatMap(([snapshot, changes]) => changes.map((change) => ({ snapshot, change })));
    if (!all.length) return;
    switch (action) {
      case 'showDiff':
        for (const { snapshot, change } of all.slice(0, 20)) {
          if (change.status === 'U') {
            await this.openMerge(this.uriFor(snapshot, change.path));
            continue;
          }
          await this.diffManager.openLocalChange(snapshot.repository.id, vscode.Uri.parse(snapshot.repository.rootUri), {
            ...(snapshot.repository.head ? { head: snapshot.repository.head } : {}),
            path: change.path,
            ...(change.oldPath ? { oldPath: change.oldPath } : {}),
            status: change.status,
            preview: preview || all.length === 1,
            preserveFocus: preview,
          });
        }
        return;
      case 'openSource':
        for (const { snapshot, change } of all.slice(0, 20)) {
          if (change.status === 'D') continue;
          await vscode.window.showTextDocument(this.uriFor(snapshot, change.path), { preview: false });
        }
        return;
      case 'openMerge':
        for (const { snapshot, change } of all) await this.openMerge(this.uriFor(snapshot, change.path));
        return;
      case 'showHistory': {
        const first = all[0];
        if (first) {
          await vscode.commands.executeCommand(
            'gitLogWorkbench.editor.showFileHistory',
            this.uriFor(first.snapshot, first.change.oldPath && first.change.status === 'D' ? first.change.oldPath : first.change.path),
          );
        }
        return;
      }
      case 'copyPath':
        await vscode.env.clipboard.writeText(all.map(({ change }) => change.path).join('\n'));
        return;
      case 'copyAbsolutePath':
        await vscode.env.clipboard.writeText(all.map(({ snapshot, change }) => this.uriFor(snapshot, change.path).fsPath).join('\n'));
        return;
      case 'revealInExplorer': {
        const first = all[0];
        if (first) await vscode.commands.executeCommand('revealInExplorer', this.uriFor(first.snapshot, first.change.path));
        return;
      }
      case 'rollback': {
        const tracked = all.filter(({ change }) => change.status !== '?' && change.status !== 'U');
        if (!tracked.length) return;
        // Files that would only become unversioned: added, copied, or the new side of a rename.
        const added = tracked.filter(({ change }) => change.status === 'A' || change.status === 'C' || change.status === 'R');
        const deleteLabel = 'Rollback and Delete Added Files';
        const confirmed = await vscode.window.showWarningMessage(
          `Rollback ${String(tracked.length)} change${tracked.length === 1 ? '' : 's'}?`,
          {
            modal: true,
            detail: `${tracked
              .slice(0, 10)
              .map(({ change }) => change.path)
              .join('\n')}${tracked.length > 10 ? `\n… and ${String(tracked.length - 10)} more` : ''}\n\nLocal modifications will be lost.${
              added.length
                ? ` ${String(added.length)} added file${added.length === 1 ? '' : 's'} can be kept as unversioned files or deleted (moved to the trash).`
                : ''
            }`,
          },
          ...(added.length ? ['Rollback', deleteLabel] : ['Rollback']),
        );
        if (confirmed !== 'Rollback' && confirmed !== deleteLabel) return;
        await this.withBusy('Rolling back…', async () => {
          for (const [snapshot, changes] of groups) {
            await this.changes.rollback(
              fileURLToPath(snapshot.repository.rootUri),
              changes.filter((change) => change.status !== '?' && change.status !== 'U'),
            );
          }
          if (confirmed === deleteLabel) {
            for (const { snapshot, change } of added) {
              await vscode.workspace.fs
                .delete(this.uriFor(snapshot, change.path), { useTrash: true, recursive: false })
                .then(undefined, () => undefined);
            }
          }
        });
        break;
      }
      case 'delete': {
        const files = all.filter(({ change }) => change.status === '?');
        if (!files.length) return;
        const confirmed = await vscode.window.showWarningMessage(
          `Delete ${String(files.length)} unversioned file${files.length === 1 ? '' : 's'}?`,
          { modal: true, detail: 'Files are moved to the trash when possible.' },
          'Delete',
        );
        if (confirmed !== 'Delete') return;
        for (const { snapshot, change } of files) {
          await vscode.workspace.fs.delete(this.uriFor(snapshot, change.path), { useTrash: true, recursive: false });
        }
        break;
      }
      case 'addToVcs':
        for (const [snapshot, changes] of groups) {
          await this.changes.add(
            fileURLToPath(snapshot.repository.rootUri),
            changes.filter((change) => change.status === '?').map((change) => change.path),
          );
        }
        break;
      case 'ignore':
        for (const [snapshot, changes] of groups) {
          await this.changes.ignore(
            fileURLToPath(snapshot.repository.rootUri),
            changes.filter((change) => change.status === '?').map((change) => change.path),
          );
        }
        break;
      case 'acceptOurs':
      case 'acceptTheirs':
        for (const { snapshot, change } of all) {
          if (change.status !== 'U') continue;
          await this.changes.resolveConflict(
            fileURLToPath(snapshot.repository.rootUri),
            change.path,
            action === 'acceptOurs' ? 'ours' : 'theirs',
          );
        }
        break;
      case 'markResolved':
        for (const [snapshot, changes] of groups) {
          await this.changes.markResolved(
            fileURLToPath(snapshot.repository.rootUri),
            changes.filter((change) => change.status === 'U').map((change) => change.path),
          );
        }
        break;
      case 'moveToChangelist': {
        const keys = all
          .filter(({ change }) => change.status !== '?' && change.status !== 'U')
          .map(({ snapshot, change }) => changeKey(snapshot.repository.id, change.path));
        if (!keys.length) return;
        const listId =
          targetChangelistId && this.changelists.lists.some((list) => list.id === targetChangelistId)
            ? targetChangelistId
            : await this.pickChangelist();
        if (!listId) return;
        await this.saveChangelists(moveToChangelist(this.changelists, keys, listId));
        await this.postState();
        return;
      }
    }
    await this.refresh();
  }

  private async openMerge(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.commands.executeCommand('git.openMergeEditor', uri);
    } catch {
      await vscode.window.showTextDocument(uri, { preview: false });
    }
  }

  private async saveChangelists(state: ChangelistState): Promise<void> {
    this.changelists = state;
    await this.context.workspaceState.update(CHANGELIST_KEY, state);
  }

  private async withBusy<T>(label: string, task: () => Promise<T>): Promise<T> {
    this.busy += 1;
    await this.post({ type: 'busy', label });
    try {
      return await task();
    } finally {
      this.busy -= 1;
      if (this.busy === 0) await this.post({ type: 'busy' });
    }
  }

  private async reportError(error: unknown): Promise<void> {
    let message: string;
    if (error instanceof GitCommandError) {
      const classified = classifyGitError(error);
      message = classified.detail ? `${classified.message}\n${classified.detail}` : classified.message;
    } else {
      message = error instanceof Error ? error.message : String(error);
    }
    this.output.appendLine(`[commit] ${message}`);
    await this.post({ type: 'error', message });
    void this.refresh().catch(() => undefined);
  }

  private async post(message: CommitExtensionMessage): Promise<void> {
    await this.view?.webview.postMessage(message);
  }
}
