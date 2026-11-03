import { realpathSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import * as vscode from 'vscode';
import type { DiffManager } from '../diff/DiffManager';
import type { GitRunner } from '../git/GitRunner';
import type { RepositoryRegistry } from '../repositories/RepositoryRegistry';
import { inspectRepository } from '../repositories/discoverRepositories';
import { parseBlamePorcelain, type BlameLine } from '../git/parsers/parseBlamePorcelain';
import { mapLineToOldSide } from '../git/worktreeLineMapping';
import { encodeRevisionQuery, parseRevisionQuery } from '../diff/diffModel';
import { REVISION_SCHEME } from '../diff/RevisionContentProvider';

const UNCOMMITTED = /^0+$/u;

function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function formatDate(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function tint(uncommitted: boolean, age: number): string {
  return uncommitted ? 'rgba(80, 140, 255, 0.12)' : `rgba(255, 170, 60, ${(0.05 + age * 0.22).toFixed(3)})`;
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
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires when a file is annotated or the annotation is removed. */
  readonly onDidChange = this.changeEmitter.event;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly runner: GitRunner,
    private readonly registry: RepositoryRegistry,
    private readonly diffManager: DiffManager,
  ) {
    this.disposables.push(
      this.decoration,
      this.changeEmitter,
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
      vscode.commands.registerCommand(
        'gitLogWorkbench.annotate.previousRevision',
        (repositoryId: string, previousHash: string, previousPath: string, hash: string, path: string, sourceLine: number) =>
          this.annotatePreviousRevision(repositoryId, previousHash, previousPath, hash, path, sourceLine),
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

  /**
   * The commit that last changed `line` of the document: from the annotation when the file is
   * annotated, otherwise from a one-line blame of the editor's current text.
   */
  async commitAt(
    document: vscode.TextDocument,
    line: number,
  ): Promise<{ root: string; hash: string } | 'uncommitted' | undefined> {
    const annotated = this.annotated.get(document.uri.toString());
    const known = annotated?.lines[line];
    if (annotated && known) {
      return UNCOMMITTED.test(known.hash) ? 'uncommitted' : { root: annotated.root, hash: known.hash };
    }
    const repository = await inspectRepository(dirname(document.uri.fsPath), this.runner);
    if (!repository) return undefined;
    const root = realPath(vscode.Uri.parse(repository.rootUri).fsPath);
    const path = relative(root, realPath(document.uri.fsPath)).split('\\').join('/');
    const result = await this.runner.run(
      ['blame', '--porcelain', '-L', `${String(line + 1)},${String(line + 1)}`, '--contents', '-', '--', path],
      { cwd: root, timeoutMs: 60_000, input: document.getText() },
    );
    const [blamed] = parseBlamePorcelain(result.stdout.toString('utf8'));
    if (!blamed) return undefined;
    return UNCOMMITTED.test(blamed.hash) ? 'uncommitted' : { root, hash: blamed.hash };
  }

  isAnnotated(uri: vscode.Uri): boolean {
    return this.annotated.has(uri.toString());
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  private async toggle(resource?: vscode.Uri): Promise<void> {
    const document =
      resource && (resource.scheme === 'file' || resource.scheme === REVISION_SCHEME)
        ? (vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === resource.toString())
            ?.document ?? (await vscode.workspace.openTextDocument(resource)))
        : vscode.window.activeTextEditor?.document;
    if (document?.uri.scheme !== 'file' && !(document && this.revisionOf(document))) {
      void vscode.window.showInformationMessage('Annotate works on files in a Git repository.');
      return;
    }
    const key = document.uri.toString();
    if (this.annotated.delete(key)) {
      this.renderVisible();
      this.updateContext();
      this.changeEmitter.fire();
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

  /** The commit and path a read-only revision document shows, when its repository is known. */
  private revisionOf(
    document: vscode.TextDocument,
  ): { repositoryId: string; root: string; revision: string; path: string } | undefined {
    if (document.uri.scheme !== REVISION_SCHEME) return undefined;
    const query = parseRevisionQuery(document.uri.query);
    const root = query ? this.registry.getRoot(query.repositoryId) : undefined;
    if (!query || query.empty || !query.revision || !root) return undefined;
    return { repositoryId: query.repositoryId, root, revision: query.revision, path: query.path };
  }

  private async load(document: vscode.TextDocument): Promise<void> {
    const revision = this.revisionOf(document);
    if (revision) {
      // A committed version: blame that commit directly instead of the editor's text.
      const result = await this.runner.run(
        ['blame', '--porcelain', '-w', revision.revision, '--', revision.path],
        { cwd: revision.root, timeoutMs: 60_000, maxStdoutBytes: 64 * 1024 * 1024, env: { GIT_LITERAL_PATHSPECS: '1' } },
      );
      this.annotated.set(document.uri.toString(), {
        root: revision.root,
        repositoryId: revision.repositoryId,
        path: revision.path,
        lines: parseBlamePorcelain(result.stdout.toString('utf8')),
      });
      this.renderVisible();
      this.updateContext();
      this.changeEmitter.fire();
      return;
    }
    const repository = await inspectRepository(dirname(document.uri.fsPath), this.runner);
    if (!repository) throw new Error('The file is not in a Git repository.');
    // Resolve symlinks on both sides (e.g. /tmp → /private/tmp on macOS) so the relative path is right.
    const root = realPath(vscode.Uri.parse(repository.rootUri).fsPath);
    const path = relative(root, realPath(document.uri.fsPath)).split('\\').join('/');
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
    this.changeEmitter.fire();
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
        const age = newest > oldest ? (line.authorTime - oldest) / (newest - oldest) : 1;
        // Every line is labelled, as in the IDE's annotate gutter.
        const text = uncommitted
          ? 'Not committed'
          : `${formatDate(line.authorTime)}  ${truncate(line.author, authorWidth)}`;
        const hover = new vscode.MarkdownString(undefined, true);
        hover.isTrusted = {
          enabledCommands: [
            'gitLogWorkbench.showCommitInLog',
            'gitLogWorkbench.annotate.showDiff',
            'gitLogWorkbench.annotate.copyHash',
            'gitLogWorkbench.annotate.previousRevision',
          ],
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
          const previous = line.previous
            ? ` · [$(history) Annotate Previous Revision](command:gitLogWorkbench.annotate.previousRevision?${encodeURIComponent(
                JSON.stringify([
                  annotation.repositoryId,
                  line.previous.hash,
                  line.previous.filename,
                  line.hash,
                  line.filename || annotation.path,
                  line.sourceLine,
                ]),
              )})`
            : '';
          hover.appendMarkdown(
            `\n\n[$(git-commit) Show in Git Log](command:gitLogWorkbench.showCommitInLog?${encodeURIComponent(JSON.stringify([annotation.root, line.hash]))}) · [$(diff) Show Diff](command:gitLogWorkbench.annotate.showDiff?${args}) · [$(copy) Copy Hash](command:gitLogWorkbench.annotate.copyHash?${encodeURIComponent(JSON.stringify([line.hash]))})${previous}`,
          );
        }
        options.push({
          range: new vscode.Range(index, 0, index, 0),
          hoverMessage: hover,
          renderOptions: {
            before: {
              contentText: text,
              // One width for every line (in characters of the editor font), so the column is even.
              width: `${String(authorWidth + 13)}ch`,
              color: new vscode.ThemeColor(uncommitted ? 'gitDecoration.modifiedResourceForeground' : 'editorLineNumber.foreground'),
              // The age tint sits on the editor background so indent guides do not show through.
              textDecoration: `none; background: linear-gradient(${tint(uncommitted, age)}, ${tint(uncommitted, age)}), var(--vscode-editor-background); white-space: pre; overflow: hidden; vertical-align: top`,
              fontStyle: 'normal',
            },
          },
        });
      }
      editor.setDecorations(this.decoration, options);
    }
  }

  /**
   * Opens the file as it was before `hash` changed this line, annotated too, with the cursor on
   * the line it came from, so blame can be followed further back.
   */
  private async annotatePreviousRevision(
    repositoryId: string,
    previousHash: string,
    previousPath: string,
    hash: string,
    path: string,
    sourceLine: number,
  ): Promise<void> {
    const isHash = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{40,64}$/u.test(value);
    const isPath = (value: unknown) => typeof value === 'string' && value.length > 0 && !value.includes('\0');
    if (!isHash(previousHash) || !isHash(hash) || !isPath(previousPath) || !isPath(path) || !Number.isSafeInteger(sourceLine)) {
      return;
    }
    const root = this.registry.getRoot(repositoryId);
    if (!root) {
      void vscode.window.showErrorMessage('The repository for this annotation is no longer available.');
      return;
    }
    let line = sourceLine;
    try {
      const diff = await this.runner.run(
        ['diff', '-U0', '--no-color', `${previousHash}:${previousPath}`, `${hash}:${path}`],
        { cwd: root, timeoutMs: 30_000 },
      );
      line = mapLineToOldSide(diff.stdout, sourceLine);
    } catch {
      // Keep the same line number.
    }
    // The short hash in the path tells the tabs apart; the content comes from the query.
    const uri = vscode.Uri.from({
      scheme: REVISION_SCHEME,
      path: `/${previousHash.slice(0, 8)}/${previousPath}`,
      query: encodeRevisionQuery({ repositoryId, revision: previousHash, path: previousPath, empty: false }),
    });
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const position = new vscode.Position(Math.min(Math.max(0, line - 1), Math.max(0, document.lineCount - 1)), 0);
      await vscode.window.showTextDocument(document, {
        preview: false,
        selection: new vscode.Range(position, position),
      });
      vscode.window.activeTextEditor?.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenter,
      );
      if (!this.annotated.has(uri.toString())) {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: 'Git blame…' },
          () => this.load(document),
        );
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Unable to annotate the previous revision: ${error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error)}`,
      );
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
