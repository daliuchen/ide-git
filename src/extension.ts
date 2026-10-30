import { join } from 'node:path';
import * as vscode from 'vscode';
import { DiffManager } from './diff/DiffManager';
import { jumpToSource } from './diff/jumpToSource';
import { releaseNativeDiffResourcesIfUnused } from './diff/NativeDiffResources';
import { RevisionContentLoader } from './diff/RevisionContentLoader';
import { REVISION_SCHEME, RevisionContentProvider } from './diff/RevisionContentProvider';
import {
  WORKING_SNAPSHOT_SCHEME,
  WorkingSnapshotContentProvider,
} from './diff/WorkingSnapshotContentProvider';
import { EditorFileComparisonCommand } from './editor/EditorFileComparisonCommand';
import {
  CURRENT_LINE_BLAME_CONFIGURATION_KEYS,
  CurrentLineBlameController,
  shouldUseCustomLineBlame,
  type CurrentLineBlamePresentation,
  type CurrentLineEditorSnapshot,
} from './editor/CurrentLineBlameController';
import { FileAnnotationController } from './editor/FileAnnotationController';
import { FileComparisonEditor } from './editor/FileComparisonEditor';
import { FileHistoryEditor } from './editor/FileHistoryEditor';
import { HistoryNativeDiffOpener } from './editor/HistoryNativeDiffOpener';
import { HistoryPatchSyntaxHighlighter } from './editor/HistoryPatchSyntaxHighlighter';
import { LineHistoryEditor } from './editor/LineHistoryEditor';
import {
  LineEditTimeTracker,
  type SerializedLineEditTimeTracker,
} from './editor/LineEditTimeTracker';
import { ShikiHistoryCodeTokenizer } from './editor/ShikiHistoryCodeTokenizer';
import { EditorGitContextService } from './editor/EditorGitContextService';
import { EditorHistoryCommands } from './editor/EditorHistoryCommands';
import { FileHistoryService } from './git/FileHistoryService';
import { GitRunner } from './git/GitRunner';
import { GitService } from './git/GitService';
import { GitOperationService } from './git/GitOperationService';
import { LineBlameService } from './git/LineBlameService';
import { registerExtension } from './registerExtension';
import { RepositoryRegistry } from './repositories/RepositoryRegistry';
import { WorkbenchViewProvider } from './webview/WorkbenchPanel';
import { CommitViewProvider } from './commit/CommitViewProvider';
import { BranchesPopup } from './branches/BranchesPopup';
import { GitDialogs } from './dialogs/GitDialogs';
import { discoverRepositories, inspectRepository } from './repositories/discoverRepositories';
import type { RepositorySummary } from './shared/models';
import { runWorkbenchCommand } from './webview/WorkbenchCommands';
import { LocalChangesService } from './commit/LocalChangesService';

const MAX_DIRTY_BLAME_CHARACTERS = 2 * 1024 * 1024;
const MAX_EDIT_TIME_DOCUMENTS = 50;
const MAX_EDIT_TIME_LINES_PER_DOCUMENT = 500;
const LINE_EDIT_TIME_STORAGE_KEY = 'gitLogWorkbench.currentLineBlame.editTimes';

interface GitRepository {
  readonly state: {
    onDidChange(listener: () => void): vscode.Disposable;
  };
}

interface GitApi {
  readonly repositories: readonly GitRepository[];
  onDidOpenRepository(listener: (repository: GitRepository) => void): vscode.Disposable;
  onDidCloseRepository(listener: (repository: GitRepository) => void): vscode.Disposable;
}

interface GitExtension {
  getAPI(version: 1): GitApi;
}

let flushLineEditTimesOnDeactivate: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Git Log');
  const configuration = vscode.workspace.getConfiguration('gitLogWorkbench');
  const runner = new GitRunner({
    executable: configuration.get<string>('git.path', 'git'),
    logLevel: configuration.get<'off' | 'error' | 'debug'>('debug.logLevel', 'off'),
    onDiagnostic: (line) => output.appendLine(line),
  });
  const gitService = new GitService(runner);
  const lineBlameService = new LineBlameService(runner);
  const fileHistoryService = new FileHistoryService(runner);
  const commitPanel: { focus?: (message?: string) => Promise<void> } = {};
  const operationService = new GitOperationService(runner, {
    onCommitUndone: (_repository, message) => {
      void commitPanel.focus?.(message);
    },
  });
  const repositories = new RepositoryRegistry();
  const maximumDiffFileBytes = configuration.get<number>(
    'performance.maxDiffFileBytes',
    5 * 1024 * 1024,
  );
  const contentLoader = new RevisionContentLoader(
    repositories,
    gitService,
    maximumDiffFileBytes,
  );
  const diffManager = new DiffManager({
    findIdenticalWorkingFile: async (repositoryId, revision, path) => {
      const root = repositories.getRoot(repositoryId);
      if (!root) return undefined;
      try {
        // Exit code 0 means the working-tree file equals the revision's version.
        await runner.run(['diff', '--quiet', revision, '--', path], {
          cwd: root,
          timeoutMs: 10_000,
          env: { GIT_LITERAL_PATHSPECS: '1' },
        });
      } catch {
        return undefined;
      }
      return vscode.Uri.file(join(root, path));
    },
  });
  const editorContexts = new EditorGitContextService(runner);
  const customLineBlameEnabled = (resource?: vscode.Uri): boolean =>
    shouldUseCustomLineBlame(
      vscode.workspace
        .getConfiguration('gitLogWorkbench', resource)
        .get<boolean>('currentLineBlame.enabled', true),
      vscode.workspace
        .getConfiguration('git', resource)
        .get<boolean>('blame.editorDecoration.enabled', false),
    );
  const lineBlameDecoration = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    after: {
      color: new vscode.ThemeColor('editorGhostText.foreground'),
      margin: '0 0 0 3em',
    },
  });
  const lineEditTimes = new LineEditTimeTracker(
    {
      maximumDocuments: MAX_EDIT_TIME_DOCUMENTS,
      maximumLines: MAX_EDIT_TIME_LINES_PER_DOCUMENT,
      maximumLineCharacters: 16 * 1024,
    },
    context.workspaceState.get<SerializedLineEditTimeTracker>(LINE_EDIT_TIME_STORAGE_KEY),
  );
  let persistLineEditTimesTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingLineEditTimesWrite = Promise.resolve();
  const writeLineEditTimes = (): Promise<void> => {
    const state = lineEditTimes.serialize();
    pendingLineEditTimesWrite = pendingLineEditTimesWrite
      .catch(() => undefined)
      .then(() => Promise.resolve(context.workspaceState.update(LINE_EDIT_TIME_STORAGE_KEY, state)));
    return pendingLineEditTimesWrite;
  };
  const flushLineEditTimes = async (): Promise<void> => {
    if (persistLineEditTimesTimer) clearTimeout(persistLineEditTimesTimer);
    persistLineEditTimesTimer = undefined;
    await writeLineEditTimes();
  };
  flushLineEditTimesOnDeactivate = flushLineEditTimes;
  const persistLineEditTimes = (): void => {
    if (persistLineEditTimesTimer) clearTimeout(persistLineEditTimesTimer);
    persistLineEditTimesTimer = setTimeout(() => {
      persistLineEditTimesTimer = undefined;
      void writeLineEditTimes().catch((error: unknown) => {
        output.appendLine(
          `[line-blame] unable to persist edit times: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, 1_000);
  };
  const editorKey = (editor: vscode.TextEditor): string => {
    const line = editor.selection.active.line;
    return `${editor.document.uri.toString()}:${String(editor.viewColumn ?? 0)}:${String(editor.document.version)}:${String(line)}`;
  };
  const editorSnapshot = (): CurrentLineEditorSnapshot | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (
      editor?.document.uri.scheme !== 'file' ||
      !customLineBlameEnabled(editor.document.uri)
    ) {
      return undefined;
    }
    if (editor.document.isDirty) {
      const finalLine = editor.document.lineAt(editor.document.lineCount - 1);
      if (
        editor.document.offsetAt(finalLine.rangeIncludingLineBreak.end) > MAX_DIRTY_BLAME_CHARACTERS
      ) {
        return undefined;
      }
    }
    const line = editor.selection.active.line;
    const lineText = editor.document.lineAt(line).text;
    const editTime = lineEditTimes.get(editor.document.uri.toString(), line, lineText);
    return {
      key: editorKey(editor),
      fsPath: editor.document.uri.fsPath,
      line,
      ...(editor.document.isDirty ? { workingContent: editor.document.getText() } : {}),
      ...(editTime !== undefined ? { editTime } : {}),
    };
  };
  const createBlameHover = (presentation: CurrentLineBlamePresentation): vscode.MarkdownString => {
    const hover = new vscode.MarkdownString();
    hover.isTrusted = false;
    hover.appendMarkdown('**Author:** ');
    hover.appendText(
      presentation.authorEmail
        ? `${presentation.authorName} <${presentation.authorEmail}>`
        : presentation.authorName,
    );
    hover.appendMarkdown('\n\n**Time:** ');
    hover.appendText(`${presentation.authoredAt} (${presentation.relativeTime})`);
    if (presentation.committed) {
      hover.appendMarkdown('\n\n**Commit:** `');
      hover.appendText(presentation.hash);
      hover.appendMarkdown('`\n\n---\n\n');
      hover.appendText(presentation.message);
    } else {
      hover.appendMarkdown('\n\n---\n\n');
      hover.appendText(presentation.message);
    }
    return hover;
  };
  const clearLineBlame = (): void => {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(lineBlameDecoration, []);
    }
  };
  const currentLineBlame = new CurrentLineBlameController(
    editorContexts,
    lineBlameService,
    gitService,
    {
      getActiveEditor: editorSnapshot,
      render: (snapshot, presentation) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editorKey(editor) !== snapshot.key) return;
        const line = editor.document.lineAt(snapshot.line);
        const position = line.range.end;
        editor.setDecorations(lineBlameDecoration, [
          {
            range: new vscode.Range(position, position),
            hoverMessage: createBlameHover(presentation),
            renderOptions: { after: { contentText: presentation.contentText } },
          },
        ]);
      },
      clear: clearLineBlame,
      onError: (error) => {
        output.appendLine(
          `[line-blame] ${error instanceof Error ? error.message : String(error)}`,
        );
      },
      locale: vscode.env.language,
      now: () => Date.now(),
    },
  );
  let lineBlameTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleLineBlame = (delayMs = 150): void => {
    if (lineBlameTimer) clearTimeout(lineBlameTimer);
    lineBlameTimer = setTimeout(() => {
      lineBlameTimer = undefined;
      void currentLineBlame.refresh();
    }, delayMs);
  };
  const gitRepositorySubscriptions = new Map<GitRepository, vscode.Disposable>();
  const gitApiSubscriptions: vscode.Disposable[] = [];
  let gitStateDisposed = false;
  let gitStateInitialization: Promise<void> | undefined;
  const disposeGitStateSubscriptions = new vscode.Disposable(() => {
    gitStateDisposed = true;
    for (const disposable of gitApiSubscriptions.splice(0)) disposable.dispose();
    for (const disposable of gitRepositorySubscriptions.values()) disposable.dispose();
    gitRepositorySubscriptions.clear();
  });
  const attachGitRepository = (repository: GitRepository): void => {
    if (gitStateDisposed || gitRepositorySubscriptions.has(repository)) return;
    gitRepositorySubscriptions.set(
      repository,
      repository.state.onDidChange(() => {
        lineBlameService.invalidate();
        currentLineBlame.invalidate();
        scheduleLineBlame(0);
      }),
    );
  };
  const ensureGitStateSubscriptions = (): void => {
    if (gitStateDisposed || gitStateInitialization) return;
    gitStateInitialization = (async () => {
      const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
      if (!extension) return;
      const exports = extension.isActive ? extension.exports : await extension.activate();
      if (gitStateDisposed) return;
      const api = exports.getAPI(1);
      for (const repository of api.repositories) attachGitRepository(repository);
      gitApiSubscriptions.push(
        api.onDidOpenRepository((repository) => {
          attachGitRepository(repository);
          lineBlameService.invalidate();
          currentLineBlame.invalidate();
          scheduleLineBlame(0);
        }),
        api.onDidCloseRepository((repository) => {
          gitRepositorySubscriptions.get(repository)?.dispose();
          gitRepositorySubscriptions.delete(repository);
          lineBlameService.invalidate();
          currentLineBlame.invalidate();
          scheduleLineBlame(0);
        }),
      );
    })().catch((error: unknown) => {
      gitStateInitialization = undefined;
      output.appendLine(
        `[git] unable to subscribe to repository changes: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };
  if (customLineBlameEnabled()) {
    ensureGitStateSubscriptions();
  }
  const workingSnapshots = new WorkingSnapshotContentProvider(
    maximumDiffFileBytes,
    maximumDiffFileBytes * 8,
  );
  const fileComparisonEditor = new FileComparisonEditor(
    gitService,
    diffManager,
    workingSnapshots,
    repositories,
  );
  const shikiTokenizer = new ShikiHistoryCodeTokenizer();
  const syntaxHighlighter = new HistoryPatchSyntaxHighlighter(shikiTokenizer);
  const nativeDiffOpener = new HistoryNativeDiffOpener(gitService, diffManager, repositories);
  const fileHistoryEditor = new FileHistoryEditor(fileHistoryService, gitService, {
    initialPageSize: 100,
    pageSize: 100,
    syntaxHighlighter,
    nativeDiffOpener,
  });
  const lineHistoryEditor = new LineHistoryEditor(fileHistoryService, gitService, {
    syntaxHighlighter,
    nativeDiffOpener,
    getContextLines: () =>
      vscode.workspace
        .getConfiguration('gitLogWorkbench')
        .get<number>('lineHistory.contextLines', 3),
  });
  const compareFileCommand = new EditorFileComparisonCommand(
    editorContexts,
    gitService,
    fileComparisonEditor,
    {
      getActiveFile: () => {
        const editor = vscode.window.activeTextEditor;
        return editor?.document.uri.scheme === 'file'
          ? {
              fsPath: editor.document.uri.fsPath,
              ...(editor.document.isDirty ? { workingContent: editor.document.getText() } : {}),
            }
          : undefined;
      },
      pickRef: async (groups) => {
        const items = groups.flatMap((group) => [
          { label: group.label, kind: vscode.QuickPickItemKind.Separator },
          ...group.items,
        ]);
        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select a branch or tag to compare with the current file',
          matchOnDescription: true,
          matchOnDetail: true,
        });
        return selected && 'ref' in selected ? selected.ref : undefined;
      },
      showErrorMessage: (message) => {
        void vscode.window.showErrorMessage(message);
      },
    },
  );
  const workbenchProvider = new WorkbenchViewProvider(
    context,
    output,
    runner,
    gitService,
    fileHistoryService,
    operationService,
    repositories,
    diffManager,
    (repository, command) => runWorkbenchCommand(commandHost, repository, command),
  );
  const workbenchViewRegistration = vscode.window.registerWebviewViewProvider(
    'gitLogWorkbench.log',
    workbenchProvider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );
  const commitViewProvider = new CommitViewProvider(
    context,
    output,
    runner,
    new LocalChangesService(runner),
    repositories,
    diffManager,
    {
      push: async (repository) => {
        await vscode.commands.executeCommand('gitLogWorkbench.push', repository.rootUri);
      },
    },
  );
  commitPanel.focus = (message) => commitViewProvider.focus(message);
  const dialogs = new GitDialogs(
    context.extensionUri,
    runner,
    gitService,
    operationService,
    repositories,
    diffManager,
    output,
  );
  const resolveRepository = async (resource: unknown): Promise<RepositorySummary | undefined> => {
    let fsPath: string | undefined;
    if (resource instanceof vscode.Uri) fsPath = resource.fsPath;
    else if (typeof resource === 'string') fsPath = resource.startsWith('file:') ? vscode.Uri.parse(resource).fsPath : resource;
    if (!fsPath) {
      const configuration = vscode.workspace.getConfiguration('gitLogWorkbench');
      const found = (
        await discoverRepositories(
          (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
          runner,
          {
            scanDepth: configuration.get<number>('repositories.scanDepth', 2),
            excludePatterns: configuration.get<string[]>('repositories.exclude', []),
          },
        )
      ).filter((repository) => !repository.isBare);
      const active = vscode.window.activeTextEditor?.document.uri;
      const preferred =
        found.length === 1
          ? found[0]
          : found.find((repository) => active?.scheme === 'file' && active.fsPath.startsWith(vscode.Uri.parse(repository.rootUri).fsPath));
      if (preferred) return preferred;
      const picked = await vscode.window.showQuickPick(
        found.map((repository) => ({ label: repository.displayName, description: repository.currentBranch ?? '', repository })),
        { placeHolder: 'Select a repository' },
      );
      return picked?.repository;
    }
    const repository = await inspectRepository(fsPath, runner);
    if (!repository) void vscode.window.showErrorMessage('No Git repository found.');
    return repository;
  };
  const pushCommand = vscode.commands.registerCommand(
    'gitLogWorkbench.push',
    async (resource?: unknown, source?: unknown) => {
      const repository = await resolveRepository(resource);
      if (!repository) return;
      await dialogs.openPush(repository, typeof source === 'string' && source ? source : 'HEAD');
    },
  );
  const updateProjectCommand = vscode.commands.registerCommand(
    'gitLogWorkbench.updateProject',
    async (resource?: unknown) => {
      const repository = await resolveRepository(resource);
      if (!repository) return;
      const previous = context.globalState.get<'rebase' | 'merge'>('updateProject.mode', 'rebase');
      const options = [
        { label: 'Rebase', description: 'git pull --rebase --autostash', mode: 'rebase' as const },
        { label: 'Merge', description: 'git pull --no-rebase --autostash', mode: 'merge' as const },
      ];
      // The last used strategy is offered first, so Enter repeats it.
      if (previous === 'merge') options.reverse();
      const picked = await vscode.window.showQuickPick(options, {
        placeHolder: `Update ${repository.displayName}${repository.currentBranch ? ` (${repository.currentBranch})` : ''} from its upstream`,
      });
      if (!picked) return;
      await context.globalState.update('updateProject.mode', picked.mode);
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Updating ${repository.displayName}…` },
          () => operationService.run(repository, { kind: 'updateProject', rebase: picked.mode === 'rebase' }),
        );
        void vscode.window.showInformationMessage(`${repository.displayName} is up to date.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[update] ${message}`);
        void vscode.window.showErrorMessage(`Update failed: ${message}`);
      }
    },
  );
  const commandHost = {
    runner,
    gitService,
    diffManager,
    repositories,
    focusCommitPanel: (message?: string) => commitViewProvider.focus(message),
    openRebaseDialog: (target: RepositorySummary, hash: string, mode: 'interactive' | 'reword') =>
      dialogs.openRebase(target, hash, mode),
  };
  const branchesPopup = new BranchesPopup(
    runner,
    operationService,
    (repository) => dialogs.openPush(repository),
    (repository, ref) => workbenchProvider.showBranchComparison(repository.id, ref),
  );
  const branchesCommand = vscode.commands.registerCommand('gitLogWorkbench.branches', async (resource?: unknown) => {
    const repository = await resolveRepository(resource);
    if (repository) await branchesPopup.show(repository);
  });
  const compareWithLocalCommand = vscode.commands.registerCommand(
    'gitLogWorkbench.compareWithLocal',
    async (resource?: unknown, revision?: unknown) => {
      const repository = await resolveRepository(resource);
      if (!repository || typeof revision !== 'string') return;
      await runWorkbenchCommand(commandHost, repository, { kind: 'compareWithLocal', hash: revision });
    },
  );
  const vcsOperationsCommand = vscode.commands.registerCommand('gitLogWorkbench.vcsOperations', async () => {
    const operations: (vscode.QuickPickItem & { command: string })[] = [
      { label: '$(check) Commit…', command: 'gitLogWorkbench.commit.open' },
      { label: '$(repo-push) Push…', command: 'gitLogWorkbench.push' },
      { label: '$(repo-pull) Update Project…', command: 'gitLogWorkbench.updateProject' },
      { label: '$(git-branch) Branches…', command: 'gitLogWorkbench.branches' },
      { label: '$(git-commit) Show Git Log', command: 'gitLogWorkbench.openLog' },
      { label: '$(person) Annotate with Git Blame', command: 'gitLogWorkbench.editor.toggleAnnotate' },
      { label: '$(history) Show File History', command: 'gitLogWorkbench.editor.showFileHistory' },
      { label: '$(history) Show History for Selection', command: 'gitLogWorkbench.editor.showSelectionHistory' },
      { label: '$(diff) Compare File with Branch or Tag…', command: 'gitLogWorkbench.editor.compareFileWithRef' },
    ];
    const picked = await vscode.window.showQuickPick(operations, { placeHolder: 'VCS Operations' });
    if (picked) await vscode.commands.executeCommand(picked.command);
  });
  const commitViewRegistration = vscode.window.registerWebviewViewProvider(
    'gitLogWorkbench.commit',
    commitViewProvider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );
  const commitCommand = vscode.commands.registerCommand('gitLogWorkbench.commit.open', () =>
    commitViewProvider.focus(),
  );
  const commitChangeCommand = vscode.commands.registerCommand('gitLogWorkbench.editor.commitChange', () =>
    commitViewProvider.commitChangeAtCursor(false).catch((error: unknown) => {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }),
  );
  const amendChangeCommand = vscode.commands.registerCommand('gitLogWorkbench.editor.amendChange', () =>
    commitViewProvider.commitChangeAtCursor(true).catch((error: unknown) => {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }),
  );
  const editorHistoryCommands = new EditorHistoryCommands(editorContexts, repositories, {
    getActiveEditor: () => {
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.uri.scheme !== 'file') return undefined;
      return {
        fsPath: editor.document.uri.fsPath,
        selection: {
          startLine: editor.selection.start.line,
          startCharacter: editor.selection.start.character,
          endLine: editor.selection.end.line,
          endCharacter: editor.selection.end.character,
        },
        ...(editor.document.isDirty ? { workingContent: editor.document.getText() } : {}),
      };
    },
    openHistory: (request) => workbenchProvider.openEditorHistory(request),
    openFileHistory: (request) => fileHistoryEditor.open(request),
    openFolderHistory: (request) => workbenchProvider.openFolderHistory(request),
    openLineHistory: (request) => lineHistoryEditor.open(request),
    showErrorMessage: (message) => {
      void vscode.window.showErrorMessage(message);
    },
  });
  const registrations = registerExtension({
    registerCommand: (command, handler) => vscode.commands.registerCommand(command, handler),
    openWorkbench: () => {
      void vscode.commands.executeCommand('gitLogWorkbench.log.focus');
    },
    showLineHistory: () => editorHistoryCommands.showLineHistory(),
    showSelectionHistory: () => editorHistoryCommands.showSelectionHistory(),
    showFileHistory: (resource) =>
      editorHistoryCommands.showFileHistory(
        resource instanceof vscode.Uri && resource.scheme === 'file'
          ? resource.fsPath
          : undefined,
      ),
    showFolderHistory: (resource) =>
      editorHistoryCommands.showFolderHistory(
        resource instanceof vscode.Uri && resource.scheme === 'file'
          ? resource.fsPath
          : undefined,
      ),
    compareFileWithRef: () => {
      void compareFileCommand.run();
    },
  });

  context.subscriptions.push(
    output,
    disposeGitStateSubscriptions,
    new vscode.Disposable(() => {
      if (lineBlameTimer) clearTimeout(lineBlameTimer);
    }),
    new vscode.Disposable(() => {
      if (persistLineEditTimesTimer) clearTimeout(persistLineEditTimesTimer);
      persistLineEditTimesTimer = undefined;
    }),
    currentLineBlame,
    lineBlameDecoration,
    fileComparisonEditor,
    workingSnapshots,
    shikiTokenizer,
    nativeDiffOpener,
    fileHistoryEditor,
    lineHistoryEditor,
    workbenchProvider,
    workbenchViewRegistration,
    commitViewProvider,
    commitViewRegistration,
    commitCommand,
    commitChangeCommand,
    amendChangeCommand,
    new FileAnnotationController(runner, repositories, diffManager),
    dialogs,
    branchesCommand,
    compareWithLocalCommand,
    vcsOperationsCommand,
    pushCommand,
    updateProjectCommand,
    vscode.commands.registerCommand('gitLogWorkbench.diff.jumpToSource', (resource?: unknown) =>
      jumpToSource(runner, repositories, resource instanceof vscode.Uri ? resource : undefined),
    ),
    ...registrations,
    vscode.workspace.registerTextDocumentContentProvider(
      REVISION_SCHEME,
      new RevisionContentProvider(contentLoader),
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      WORKING_SNAPSHOT_SCHEME,
      workingSnapshots,
    ),
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      const closedTabs = new Set(event.closed);
      const openDiffInputs: vscode.TabInputTextDiff[] = [];
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (closedTabs.has(tab)) continue;
          if (tab.input instanceof vscode.TabInputTextDiff) {
            openDiffInputs.push(tab.input);
          }
        }
      }
      for (const tab of event.closed) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          releaseNativeDiffResourcesIfUnused(
            tab.input,
            openDiffInputs,
            repositories,
            workingSnapshots,
          );
        }
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => scheduleLineBlame()),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor === vscode.window.activeTextEditor) scheduleLineBlame();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (
        event.document.uri.scheme === 'file' &&
        customLineBlameEnabled(event.document.uri)
      ) {
        const finalLine = event.document.lineAt(event.document.lineCount - 1);
        if (
          event.document.offsetAt(finalLine.rangeIncludingLineBreak.end) >
          MAX_DIRTY_BLAME_CHARACTERS
        ) {
          if (event.document === vscode.window.activeTextEditor?.document) scheduleLineBlame(0);
          return;
        }
        const documentKey = event.document.uri.toString();
        const editTime = Date.now();
        lineEditTimes.record({
          documentKey,
          lineCount: event.document.lineCount,
          lineText: (line) => event.document.lineAt(line).text,
          changes: event.contentChanges,
          editTime,
          ...(event.document === vscode.window.activeTextEditor?.document
            ? { activeLine: vscode.window.activeTextEditor.selection.active.line }
            : {}),
        });
        persistLineEditTimes();
        if (event.document === vscode.window.activeTextEditor?.document) scheduleLineBlame(300);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        CURRENT_LINE_BLAME_CONFIGURATION_KEYS.some((key) =>
          event.affectsConfiguration(key),
        )
      ) {
        if (customLineBlameEnabled()) {
          ensureGitStateSubscriptions();
        }
        scheduleLineBlame(0);
      }
    }),
  );
  scheduleLineBlame(0);
}

export async function deactivate(): Promise<void> {
  const flushLineEditTimes = flushLineEditTimesOnDeactivate;
  flushLineEditTimesOnDeactivate = undefined;
  await flushLineEditTimes?.();
}
