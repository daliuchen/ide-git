import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { GitRunner } from '../git/GitRunner';
import { findAddedTodos, findTodosInText, type TodoHit } from './commitMessage';
import type { CommitChecks } from './commitProtocol';
import type { LocalChange } from './localChanges';

export interface CheckedFile {
  uri: vscode.Uri;
  change: LocalChange;
  /** Only some chunks are committed; rewriting the file would invalidate the selection. */
  partial: boolean;
}

export interface CheckedRepository {
  root: string;
  files: CheckedFile[];
}

export class CommitCancelled extends Error {
  override readonly name = 'CommitCancelled';
}

const TEST_COMMAND_KEY = 'commit.testCommand';

/** Commit checks in the spirit of an IDE: reformat, optimize imports, analyze, TODOs, tests. */
export class CommitChecksRunner {
  constructor(
    private readonly runner: GitRunner,
    private readonly output: vscode.OutputChannel,
  ) {}

  /** Runs the enabled checks; throws CommitCancelled when the user stops to review. */
  async run(repositories: readonly CheckedRepository[], checks: CommitChecks): Promise<string[]> {
    const notes: string[] = [];
    const editable = repositories.flatMap((repository) =>
      repository.files.filter((file) => file.change.status !== 'D' && !file.partial),
    );
    if (checks.reformat || checks.optimizeImports) {
      const skipped = repositories.flatMap((repository) => repository.files.filter((file) => file.partial)).length;
      if (skipped) notes.push(`${String(skipped)} partially committed file(s) were not reformatted.`);
      for (const file of editable) await this.rewrite(file.uri, checks);
    }
    if (checks.analyze) await this.analyze(repositories.flatMap((repository) => repository.files));
    if (checks.checkTodo) await this.checkTodos(repositories);
    if (checks.runTests) {
      for (const repository of repositories) await this.runTests(repository.root);
    }
    return notes;
  }

  private async rewrite(uri: vscode.Uri, checks: CommitChecks): Promise<void> {
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      return; // Binary or unreadable files are not reformatted.
    }
    if (checks.optimizeImports) {
      const range = new vscode.Range(0, 0, document.lineCount, 0);
      const actions =
        (await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>(
          'vscode.executeCodeActionProvider',
          uri,
          range,
          vscode.CodeActionKind.SourceOrganizeImports.value,
        )) ?? [];
      const action = actions.find((candidate): candidate is vscode.CodeAction => typeof candidate.command !== 'string');
      if (action?.edit) await vscode.workspace.applyEdit(action.edit);
      if (action?.command) await vscode.commands.executeCommand(action.command.command, ...(action.command.arguments ?? []));
    }
    if (checks.reformat) {
      const configuration = vscode.workspace.getConfiguration('editor', document);
      const edits =
        (await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', uri, {
          tabSize: configuration.get<number>('tabSize', 2),
          insertSpaces: configuration.get<boolean>('insertSpaces', true),
        })) ?? [];
      if (edits.length) {
        const edit = new vscode.WorkspaceEdit();
        edit.set(uri, edits);
        await vscode.workspace.applyEdit(edit);
      }
    }
    if (document.isDirty) await document.save();
  }

  private async analyze(files: readonly CheckedFile[]): Promise<void> {
    const uris = files.filter((file) => file.change.status !== 'D').map((file) => file.uri);
    // Language servers such as TypeScript only check files that are open in editor tabs, so open
    // the others in the background for the duration of the check and close them afterwards.
    const tabbed = (): vscode.Tab[] => vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    const inTabs = new Set(
      tabbed().flatMap((tab) => (tab.input instanceof vscode.TabInputText ? [tab.input.uri.toString()] : [])),
    );
    const opened: string[] = [];
    for (const uri of uris.slice(0, 30)) {
      if (inTabs.has(uri.toString())) continue;
      try {
        await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: true });
        opened.push(uri.toString());
      } catch {
        // Binary or unreadable files are skipped.
      }
    }
    const closeOpened = async (): Promise<void> => {
      const toClose = tabbed().filter(
        (tab) => tab.input instanceof vscode.TabInputText && opened.includes(tab.input.uri.toString()) && !tab.isDirty,
      );
      if (toClose.length) await vscode.window.tabGroups.close(toClose, true);
    };
    let review = false;
    try {
      await this.waitForDiagnostics(uris, opened.length ? 4_000 : 800);
      review = !(await this.reportDiagnostics(uris));
    } finally {
      // Closing a tab clears its diagnostics, so files stay open when the user wants to review them.
      if (!review) await closeOpened();
    }
    if (review) throw new CommitCancelled('Commit cancelled to review code analysis results.');
  }

  /** Waits until the diagnostics stop changing; a server that is still starting reports nothing at first. */
  private async waitForDiagnostics(uris: readonly vscode.Uri[], minimumMs: number): Promise<void> {
    const started = Date.now();
    let previous = -1;
    let stableSince = Date.now();
    while (Date.now() - started < 15_000) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const count = uris.reduce((total, uri) => total + vscode.languages.getDiagnostics(uri).length, 0);
      if (count !== previous) {
        previous = count;
        stableSince = Date.now();
      }
      if (Date.now() - started >= minimumMs && Date.now() - stableSince >= 1_200) break;
    }
  }

  /** Returns true to go ahead with the commit. */
  private async reportDiagnostics(uris: readonly vscode.Uri[]): Promise<boolean> {
    let errors = 0;
    let warnings = 0;
    const affected = new Set<string>();
    for (const uri of uris) {
      for (const diagnostic of vscode.languages.getDiagnostics(uri)) {
        if (diagnostic.severity === vscode.DiagnosticSeverity.Error) errors += 1;
        else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) warnings += 1;
        else continue;
        affected.add(vscode.workspace.asRelativePath(uri));
      }
    }
    if (!errors && !warnings) return true;
    const choice = await vscode.window.showWarningMessage(
      `Code analysis found ${String(errors)} error${errors === 1 ? '' : 's'} and ${String(warnings)} warning${warnings === 1 ? '' : 's'}.`,
      { modal: true, detail: [...affected].slice(0, 10).join('\n') },
      'Commit Anyway',
      'Review',
    );
    if (choice === 'Commit Anyway') return true;
    if (choice === 'Review') await vscode.commands.executeCommand('workbench.actions.view.problems');
    return false;
  }

  private async checkTodos(repositories: readonly CheckedRepository[]): Promise<void> {
    const hits: (TodoHit & { root: string })[] = [];
    for (const repository of repositories) {
      const tracked = repository.files.filter((file) => file.change.status !== '?' && file.change.status !== 'D');
      if (tracked.length) {
        try {
          const diff = await this.runner.run(
            ['diff', 'HEAD', '-U0', '--no-color', '--no-ext-diff', '--', ...tracked.map((file) => file.change.path)],
            { cwd: repository.root, timeoutMs: 60_000, env: { GIT_LITERAL_PATHSPECS: '1' } },
          );
          hits.push(...findAddedTodos(diff.stdout.toString('utf8')).map((hit) => ({ ...hit, root: repository.root })));
        } catch {
          // A repository without commits has no HEAD to diff against; its files are new.
          for (const file of tracked) {
            const text = await readFile(file.uri.fsPath, 'utf8').catch(() => '');
            hits.push(...findTodosInText(file.change.path, text).map((hit) => ({ ...hit, root: repository.root })));
          }
        }
      }
      for (const file of repository.files.filter((candidate) => candidate.change.status === '?')) {
        const text = await readFile(file.uri.fsPath, 'utf8').catch(() => '');
        if (!text.includes('\0')) {
          hits.push(...findTodosInText(file.change.path, text).map((hit) => ({ ...hit, root: repository.root })));
        }
      }
    }
    if (!hits.length) return;
    const choice = await vscode.window.showWarningMessage(
      `The changes add ${String(hits.length)} TODO${hits.length === 1 ? '' : 's'}.`,
      {
        modal: true,
        detail: hits
          .slice(0, 10)
          .map((hit) => `${hit.path}:${String(hit.line)}  ${hit.text}`)
          .join('\n'),
      },
      'Commit Anyway',
      'Review',
    );
    if (choice === 'Commit Anyway') return;
    const first = hits[0];
    if (choice === 'Review' && first) {
      const position = new vscode.Position(Math.max(0, first.line - 1), 0);
      await vscode.window.showTextDocument(vscode.Uri.joinPath(vscode.Uri.file(first.root), first.path), {
        selection: new vscode.Range(position, position),
      });
    }
    throw new CommitCancelled('Commit cancelled to review TODOs.');
  }

  private async runTests(root: string): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('gitLogWorkbench', vscode.Uri.file(root));
    let command = configuration.get<string>(TEST_COMMAND_KEY, '').trim();
    if (!command) {
      command =
        (await vscode.window.showInputBox({
          prompt: 'Command that runs the tests before committing (saved to workspace settings)',
          placeHolder: 'pnpm test',
        }))?.trim() ?? '';
      if (!command) throw new CommitCancelled('Commit cancelled: no test command configured.');
      await configuration.update(TEST_COMMAND_KEY, command, vscode.ConfigurationTarget.Workspace);
    }
    this.output.appendLine(`[commit] running tests in ${root}: ${command}`);
    const exitCode = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Running tests: ${command}`, cancellable: true },
      (_progress, token) =>
        new Promise<number | null>((resolve) => {
          // The command is the user's own setting, run like a terminal command.
          const child = spawn(command, { cwd: root, shell: true, env: { ...process.env, CI: process.env.CI ?? '1' } });
          child.stdout.on('data', (chunk: Buffer) => this.output.append(chunk.toString('utf8')));
          child.stderr.on('data', (chunk: Buffer) => this.output.append(chunk.toString('utf8')));
          child.on('error', (error) => {
            this.output.appendLine(String(error));
            resolve(-1);
          });
          child.on('close', (code) => resolve(code));
          token.onCancellationRequested(() => child.kill('SIGTERM'));
        }),
    );
    if (exitCode === 0) return;
    const choice = await vscode.window.showWarningMessage(
      `Tests failed (${exitCode === null ? 'cancelled' : `exit code ${String(exitCode)}`}).`,
      { modal: true, detail: command },
      'Commit Anyway',
      'Show Output',
    );
    if (choice === 'Commit Anyway') return;
    if (choice === 'Show Output') this.output.show(true);
    throw new CommitCancelled('Commit cancelled because the tests failed.');
  }
}
