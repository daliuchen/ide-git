import * as vscode from 'vscode';
import { describeCheckoutConflict, type CheckoutConflict } from './checkoutConflicts';
import { displayWorktreePath } from '../worktrees/worktrees';
import { openWorktree } from '../worktrees/openWorktree';

const SMART = 'Smart Checkout';
const FORCE = 'Force Checkout';

/** The IDE's "Git Checkout Problem" dialog: stash and restore, discard, or don't check out. */
export async function promptCheckoutConflict(conflict: CheckoutConflict): Promise<'smart' | 'force' | undefined> {
  const choice = await vscode.window.showWarningMessage(
    'Your local changes would be overwritten by checkout',
    {
      modal: true,
      detail: `${describeCheckoutConflict(conflict)}\n\nSmart Checkout stashes your changes, checks out, and restores them.\nForce Checkout discards your local changes to these files.`,
    },
    SMART,
    FORCE,
  );
  return choice === SMART ? 'smart' : choice === FORCE ? 'force' : undefined;
}

const SWITCH = 'Switch to Worktree';
const NEW_WINDOW = 'Open in New Window';

/** A branch can be checked out in one worktree only; offer to go to the one that has it. */
export async function promptBranchInOtherWorktree(branch: string, path: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `'${branch}' is checked out in another worktree`,
    { modal: true, detail: `${displayWorktreePath(path)}\n\nA branch can be checked out in one worktree at a time. Switch this window to that worktree, or open it in a new window.` },
    SWITCH,
    NEW_WINDOW,
  );
  if (choice === SWITCH) await openWorktree(path, 'switch');
  else if (choice === NEW_WINDOW) await openWorktree(path, 'newWindow');
}
