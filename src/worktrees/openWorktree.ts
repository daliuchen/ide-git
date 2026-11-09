import * as vscode from 'vscode';

export type WorktreeOpenMode = 'switch' | 'newWindow' | 'addToWorkspace';

/** Switches this window to the worktree, opens it in a new window, or adds it to the workspace. */
export async function openWorktree(path: string, mode: WorktreeOpenMode): Promise<void> {
  const uri = vscode.Uri.file(path);
  if (mode === 'addToWorkspace') {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.some((folder) => folder.uri.fsPath === uri.fsPath)) {
      vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri });
    }
    return;
  }
  await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: mode === 'newWindow' });
}
