import { join } from 'node:path';
import * as vscode from 'vscode';
import type { GitRunner } from '../git/GitRunner';
import { mapWorktreeLineRange } from '../git/worktreeLineMapping';
import type { RepositoryRegistry } from '../repositories/RepositoryRegistry';
import { parseRevisionQuery } from './diffModel';
import { REVISION_SCHEME } from './RevisionContentProvider';

/**
 * Opens the working-tree file for a read-only revision document at the corresponding line,
 * like an IDE "Jump to Source" (F4) from a commit diff.
 */
export async function jumpToSource(
  runner: GitRunner,
  repositories: RepositoryRegistry,
  resource?: vscode.Uri,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const uri = resource ?? editor?.document.uri;
  if (uri?.scheme !== REVISION_SCHEME) {
    if (uri?.scheme === 'file') await vscode.window.showTextDocument(uri, { preview: false });
    return;
  }
  const query = parseRevisionQuery(uri.query);
  const root = query ? repositories.getRoot(query.repositoryId) : undefined;
  if (!query || !root) {
    void vscode.window.showErrorMessage('The repository for this revision is no longer available.');
    return;
  }
  const target = vscode.Uri.file(join(root, query.path));
  try {
    await vscode.workspace.fs.stat(target);
  } catch {
    void vscode.window.showWarningMessage(`${query.path} does not exist in the working tree.`);
    return;
  }
  const sourceLine =
    editor && editor.document.uri.toString() === uri.toString() ? editor.selection.active.line + 1 : 1;
  let line = sourceLine;
  if (!query.empty && query.revision) {
    try {
      // Reversed so the "new" side is the revision and the mapping yields working-tree lines.
      const diff = await runner.run(['diff', '-R', '-U0', '--no-color', query.revision, '--', query.path], {
        cwd: root,
        timeoutMs: 30_000,
        env: { GIT_LITERAL_PATHSPECS: '1' },
      });
      const mapped = mapWorktreeLineRange(diff.stdout, sourceLine, sourceLine);
      if (mapped.status === 'mapped') line = mapped.startLine;
    } catch {
      // Fall back to the same line number.
    }
  }
  const document = await vscode.workspace.openTextDocument(target);
  const position = new vscode.Position(Math.min(Math.max(0, line - 1), Math.max(0, document.lineCount - 1)), 0);
  await vscode.window.showTextDocument(document, {
    preview: false,
    selection: new vscode.Range(position, position),
  });
}
