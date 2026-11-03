import * as vscode from 'vscode';
import { describeCheckoutConflict, type CheckoutConflict } from './checkoutConflicts';

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
