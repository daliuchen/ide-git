import * as vscode from 'vscode';
import {
  findCompetingF7Bindings,
  hasIdeGitF7Bindings,
  IDE_GIT_F7_BINDINGS,
  insertIdeGitF7Bindings,
} from './f7Conflict';

const DISMISSED_KEY = 'f7Conflict.dismissed';
const ADD = 'Add Shortcuts';
const NEVER = "Don't Ask Again";

/**
 * Another extension binding F7 (an IDE keymap, typically) can win over IDE Git's binding, and an
 * extension cannot change that order. Offer, once, to add IDE Git's bindings to the user's
 * keybindings.json, which takes precedence over every extension.
 */
export class F7ConflictAdvisor {
  private checked = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Call when a diff is opened from a file list; only the first call in a window does anything. */
  async check(): Promise<void> {
    if (this.checked) return;
    this.checked = true;
    if (this.context.globalState.get<boolean>(DISMISSED_KEY)) return;
    const competing = findCompetingF7Bindings(vscode.extensions.all, this.context.extension.id, process.platform);
    if (!competing.length) return;
    if (hasIdeGitF7Bindings(await this.readKeybindings())) return;
    const choice = await vscode.window.showInformationMessage(
      `IDE Git: ${competing.join(', ')} also ${competing.length === 1 ? 'uses' : 'use'} F7, so F7 in diffs may not continue into the next file. Add IDE Git's F7 shortcuts to your keyboard shortcuts?`,
      ADD,
      NEVER,
    );
    if (choice === NEVER) await this.context.globalState.update(DISMISSED_KEY, true);
    if (choice === ADD) await this.addShortcuts();
  }

  /** The user keybindings.json sits next to the globalStorage folder of the default profile. */
  private get keybindingsUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, '..', '..', 'keybindings.json');
  }

  private async readKeybindings(): Promise<string> {
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(this.keybindingsUri));
    } catch {
      return '';
    }
  }

  private async addShortcuts(): Promise<void> {
    const uri = this.keybindingsUri;
    const original = await this.readKeybindings();
    if (!hasIdeGitF7Bindings(original)) {
      const updated = insertIdeGitF7Bindings(original);
      if (updated === undefined) {
        await this.pasteManually();
        return;
      }
      try {
        if (original) {
          await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(uri, '..', 'keybindings.json.ide-git-backup'),
            new TextEncoder().encode(original),
          );
        }
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(updated));
      } catch {
        await this.pasteManually();
        return;
      }
    }
    await vscode.window.showTextDocument(uri, { preview: false });
    void vscode.window.showInformationMessage('IDE Git: F7 / Shift+F7 shortcuts added.');
  }

  private async pasteManually(): Promise<void> {
    await vscode.env.clipboard.writeText(
      IDE_GIT_F7_BINDINGS.map((binding) => JSON.stringify(binding)).join(',\n'),
    );
    await vscode.commands.executeCommand('workbench.action.openGlobalKeybindingsFile');
    void vscode.window.showInformationMessage(
      'IDE Git could not edit this file automatically. The two F7 shortcuts are on the clipboard: paste them inside the [ ] list and save.',
    );
  }
}
