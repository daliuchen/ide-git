import { dirname, relative } from 'node:path';
import * as vscode from 'vscode';
import type { DiffManager } from '../diff/DiffManager';
import type { GitRunner } from '../git/GitRunner';
import type { RepositoryRegistry } from '../repositories/RepositoryRegistry';
import { inspectRepository } from '../repositories/discoverRepositories';
import { parseBlamePorcelain, type BlameLine } from '../git/parsers/parseBlamePorcelain';

const UNCOMMITTED = /^0+$/u;

function formatDate(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value.padEnd(length, '\u2002');
}

interface Annotation {
  root: string;
  repositoryId: string;
  path: string;
  lines: BlameLine[];
}

/**
 * "Annotate with Git Blame": author and date beside every line, shaded by age, with a hover
 * offering the commit's diff for this file.
 */
export class FileAnnotationController implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    before: { margin: '0 1.2em 0 0' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly annotated = new Map<string, Annotation>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly runner: GitRunner,
    private readonly registry: RepositoryRegistry,
    private readonly diffManager: DiffManager,
  ) {
    this.disposables.push(
      this.decoration,
      vscode.commands.registerCommand('gitLogWorkbench.editor.toggleAnnotate', (resource?: unknown) =>
        this.toggle(resource instanceof vscode.Uri ? resource : undefined),
      ),
      vscode.commands.registerCommand(
        'gitLogWorkbench.annotate.showDiff',
        (repositoryId: string, hash: string, path: string, previousHash?: string, previousPath?: string) =>
          this.showDiff(repositoryId, hash, path, previousHash, previousPath),
      ),
      vscode.commands.registerCommand('gitLogWorkbench.annotate.copyHash', (hash: string) =>
        vscode.env.clipboard.writeText(hash),
      ),
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderVisible()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        const key = event.document.uri.toString();
        if (!this.annotated.has(key)) return;
        const timer = this.timers.get(key);
        if (timer) clearTimeout(timer);
        this.timers.set(
          key,
          setTimeout(() => {
            this.timers.delete(key);
            void this.load(event.document).catch(() => undefined);
          }, 500),
        );
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.annotated.delete(document.uri.toString());
        this.updateContext();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
    );
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  private async toggle(resource?: vscode.Uri): Promise<void> {
    const document =
      resource && resource.scheme === 'file'
        ? (vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === resource.toString())
            ?.document ?? (await vscode.workspace.openTextDocument(resource)))
        : vscode.window.activeTextEditor?.document;
    if (document?.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('Annotate works on files in a Git repository.');
      return;
    }
    const key = document.uri.toString();
    if (this.annotated.delete(key)) {
      this.renderVisible();
      this.updateContext();
      return;
    }
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Git blame…' },
        () => this.load(document),
      );
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Unable to annotate: ${error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error)}`,
      );
    }
  }

  private async load(document: vscode.TextDocument): Promise<void> {
    const repository = await inspectRepository(dirname(document.uri.fsPath), this.runner);
    if (!repository) throw new Error('The file is not in a Git repository.');
    const root = vscode.Uri.parse(repository.rootUri).fsPath;
    const path = relative(root, document.uri.fsPath).split('\\').join('/');
    const result = await this.runner.run(
      ['blame', '--porcelain', '-w', '--contents', '-', '--', path],
      { cwd: root, timeoutMs: 60_000, input: document.getText(), maxStdoutBytes: 64 * 1024 * 1024 },
    );
    this.registry.upsert(repository);
    this.annotated.set(document.uri.toString(), {
      root,
      repositoryId: repository.id,
      path,
      lines: parseBlamePorcelain(result.stdout.toString('utf8')),
    });
    this.renderVisible();
    this.updateContext();
  }

  private updateContext(): void {
    const active = vscode.window.activeTextEditor?.document.uri.toString();
    void vscode.commands.executeCommand(
      'setContext',
      'gitLogWorkbench.annotated',
      active !== undefined && this.annotated.has(active),
    );
  }

  private renderVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const annotation = this.annotated.get(editor.document.uri.toString());
      if (!annotation) {
        editor.setDecorations(this.decoration, []);
        continue;
      }
      const committed = annotation.lines.filter((line) => !UNCOMMITTED.test(line.hash));
      const times = committed.map((line) => line.authorTime);
      const oldest = Math.min(...times);
      const newest = Math.max(...times);
      const authorWidth = Math.min(
        18,
        Math.max(6, ...annotation.lines.map((line) => (UNCOMMITTED.test(line.hash) ? 0 : line.author.length))),
      );
      const options: vscode.DecorationOptions[] = [];
      const lineCount = Math.min(annotation.lines.length, editor.document.lineCount);
      for (let index = 0; index < lineCount; index += 1) {
        const line = annotation.lines[index];
        if (!line) continue;
        const uncommitted = UNCOMMITTED.test(line.hash);
        const previous = annotation.lines[index - 1];
        const repeat = previous?.hash === line.hash;
        const age = newest > oldest ? (line.authorTime - oldest) / (newest - oldest) : 1;
        const text = uncommitted
          ? truncate('Not committed', authorWidth + 12)
          : repeat
            ? '\u2002'.repeat(authorWidth + 12)
            : `${formatDate(line.authorTime)}  ${truncate(line.author, authorWidth)}`;
        const hover = new vscode.MarkdownString(undefined, true);
        hover.isTrusted = {
          enabledCommands: ['gitLogWorkbench.annotate.showDiff', 'gitLogWorkbench.annotate.copyHash'],
        };
        if (uncommitted) {
          hover.appendMarkdown('**Not committed yet**');
        } else {
          const args = encodeURIComponent(
            JSON.stringify([
              annotation.repositoryId,
              line.hash,
              line.filename || annotation.path,
              line.previous?.hash,
              line.previous?.filename,
            ]),
          );
          hover.appendMarkdown(`$(git-commit) \`${line.hash.slice(0, 8)}\` · `);
          hover.appendText(`${line.author} · ${new Date(line.authorTime * 1000).toLocaleString()}`);
          hover.appendMarkdown('\n\n');
          hover.appendText(line.summary);
          hover.appendMarkdown(
            `\n\n[$(diff) Show Diff](command:gitLogWorkbench.annotate.showDiff?${args}) · [$(copy) Copy Hash](command:gitLogWorkbench.annotate.copyHash?${encodeURIComponent(JSON.stringify([line.hash]))})`,
          );
        }
        options.push({
          range: new vscode.Range(index, 0, index, 0),
          hoverMessage: hover,
          renderOptions: {
            before: {
              contentText: text,
              color: new vscode.ThemeColor(uncommitted ? 'gitDecoration.modifiedResourceForeground' : 'editorLineNumber.foreground'),
              backgroundColor: uncommitted
                ? 'rgba(80, 140, 255, 0.10)'
                : `rgba(255, 170, 60, ${(0.04 + age * 0.22).toFixed(3)})`,
              fontStyle: 'normal',
            },
          },
        });
      }
      editor.setDecorations(this.decoration, options);
    }
  }

  private async showDiff(
    repositoryId: string,
    hash: string,
    path: string,
    previousHash?: string,
    previousPath?: string,
  ): Promise<void> {
    await this.diffManager.open(repositoryId, {
      hash,
      ...(previousHash ? { parent: previousHash } : {}),
      path,
      ...(previousPath && previousPath !== path ? { oldPath: previousPath } : {}),
      status: previousHash ? (previousPath && previousPath !== path ? 'R' : 'M') : 'A',
    });
  }
}
