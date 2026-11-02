import * as vscode from 'vscode';
import {
  movedInDirection,
  neighborIndex,
  SecondPressGate,
  SECOND_PRESS_WINDOW_MS,
  type NavigationDirection,
} from './diffNavigation';

/** True while the active editor is a diff that belongs to a file list (Log or Commit window). */
export const DIFF_NAVIGATION_CONTEXT = 'gitLogWorkbench.diffNavigation';

const NATIVE_COMMANDS: Record<NavigationDirection, string> = {
  next: 'workbench.action.compareEditor.nextChange',
  previous: 'workbench.action.compareEditor.previousChange',
};

/** How long to wait for a newly opened diff to finish computing its changes. */
const FIRST_CHANGE_TIMEOUT_MS = 2_000;
const FIRST_CHANGE_POLL_MS = 100;

export interface NavigableDiff {
  /** Shown in the "press again" hint. */
  label: string;
  open(): Promise<void>;
}

interface NavigationSession {
  items: readonly NavigableDiff[];
  index: number;
  original: string;
  modified: string;
}

function activeDiffInput(): vscode.TabInputTextDiff | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputTextDiff ? input : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function moveCursor(editor: vscode.TextEditor, position: vscode.Position): void {
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(
    new vscode.Range(position, position),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport,
  );
}

/**
 * IDE-style F7 / Shift+F7: step through the changes of a diff and, at either end, continue into
 * the next or previous file of the list the diff was opened from.
 */
export class DiffNavigator implements vscode.Disposable {
  private session: NavigationSession | undefined;
  private readonly gate = new SecondPressGate();
  private contextValue = false;
  private readonly disposables: vscode.Disposable[];

  constructor() {
    this.disposables = [
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.updateContext()),
    ];
  }

  /**
   * Opens `items[index]` and remembers the list, so F7 can move on to its neighbours. `openFirst`
   * replaces the item's own opener for this call only, e.g. to keep focus in the file list.
   */
  async open(
    items: readonly NavigableDiff[],
    index: number,
    openFirst?: () => Promise<void>,
  ): Promise<void> {
    const item = items[index];
    if (!item) return;
    this.gate.reset();
    await (openFirst ?? item.open)();
    const input = activeDiffInput();
    this.session = input
      ? { items, index, original: input.original.toString(), modified: input.modified.toString() }
      : undefined;
    this.updateContext();
  }

  async navigate(direction: NavigationDirection): Promise<void> {
    const session = this.activeSession();
    const editor = vscode.window.activeTextEditor;
    if (!session || !editor) {
      await vscode.commands.executeCommand(NATIVE_COMMANDS[direction]);
      return;
    }
    const before = editor.selection.active;
    await vscode.commands.executeCommand(NATIVE_COMMANDS[direction]);
    const current = vscode.window.activeTextEditor ?? editor;
    if (movedInDirection(direction, before.line, current.selection.active.line)) {
      this.gate.reset();
      return;
    }
    // The editor wrapped around to the other end; undo that and offer the neighbouring file.
    moveCursor(current, before);
    const target = neighborIndex(session.items.length, session.index, direction);
    const item = target === undefined ? undefined : session.items[target];
    if (target === undefined || !item) {
      vscode.window.setStatusBarMessage(
        direction === 'next' ? 'IDE Git: last change of the last file' : 'IDE Git: first change of the first file',
        SECOND_PRESS_WINDOW_MS,
      );
      return;
    }
    if (!this.gate.press(`${direction}\0${session.modified}`)) {
      vscode.window.setStatusBarMessage(
        `IDE Git: ${direction === 'next' ? 'last' : 'first'} change — press again to open ${item.label}`,
        SECOND_PRESS_WINDOW_MS,
      );
      return;
    }
    await this.open(session.items, target);
    await this.revealEdgeChange(direction);
  }

  private activeSession(): NavigationSession | undefined {
    const session = this.session;
    const input = activeDiffInput();
    if (
      !session ||
      !input ||
      input.original.toString() !== session.original ||
      input.modified.toString() !== session.modified
    ) {
      return undefined;
    }
    return session;
  }

  /**
   * Moves to the first change (or the last one, when going backwards). Starting from the opposite
   * end makes the editor's own command wrap onto it. The diff is computed asynchronously, so keep
   * trying until the cursor moves.
   */
  private async revealEdgeChange(direction: NavigationDirection): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const start =
      direction === 'next'
        ? new vscode.Position(Math.max(0, editor.document.lineCount - 1), 0)
        : new vscode.Position(0, 0);
    moveCursor(editor, start);
    const deadline = Date.now() + FIRST_CHANGE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (vscode.window.activeTextEditor !== editor) return;
      await vscode.commands.executeCommand(NATIVE_COMMANDS[direction]);
      if (editor.selection.active.line !== start.line) return;
      await delay(FIRST_CHANGE_POLL_MS);
    }
    if (vscode.window.activeTextEditor === editor) moveCursor(editor, new vscode.Position(0, 0));
  }

  private updateContext(): void {
    const value = this.activeSession() !== undefined;
    if (value === this.contextValue) return;
    this.contextValue = value;
    void vscode.commands.executeCommand('setContext', DIFF_NAVIGATION_CONTEXT, value);
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
  }
}
