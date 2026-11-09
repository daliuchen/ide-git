// Worktrees: create one from Manage Worktrees, see it in the Log (group and branch mark), remove it
// from the Log, then switch this window to another worktree from the toolbar list.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { enlargePanel, frameWith, git, initRepository, runCommand, writeFiles } from '../lib.mjs';

export default {
  setup(directory) {
    const repo = initRepository(join(directory, 'repo'));
    writeFiles(repo, { 'a.txt': 'a\n' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'branch', 'feat/x');
    git(repo, 'branch', 'feat/y');
    return repo;
  },
  async run({ page, check, workspace, shot }) {
    const sleep = (ms) => page.waitForTimeout(ms);
    const root = realpathSync(workspace);
    const worktreePaths = () =>
      git(workspace, 'worktree', 'list', '--porcelain')
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length));
    const quickInput = page.locator('.quick-input-widget');
    const pick = async (text) => {
      await page.keyboard.type(text);
      await sleep(500);
      await page.keyboard.press('Enter');
      await sleep(800);
    };

    // 1. Manage Worktrees → New Worktree → feat/x, keeping the suggested folder.
    await runCommand(page, 'IDE Git: Manage Worktrees');
    await sleep(800);
    check('lists the main worktree', (await quickInput.innerText()).includes('main'));
    await pick('New Worktree');
    await pick('feat/x');
    const suggested = await quickInput.locator('input').inputValue();
    check('suggests a folder next to the repository', suggested === `${root}-feat-x`, suggested);
    await page.keyboard.press('Enter');
    await sleep(2500);
    check('created the worktree for feat/x', worktreePaths().includes(`${root}-feat-x`), worktreePaths().join(', '));
    await shot('created');
    const toast = page.locator('.notification-toast');
    check('offers to switch, open or add it', /Switch[\s\S]*New Window[\s\S]*Add to Workspace/u.test(await toast.innerText().catch(() => '')));
    await page.keyboard.press('Escape');
    await sleep(500);

    // 2. The Log's toolbar lists the worktrees and the branch list marks feat/x as checked out elsewhere.
    await runCommand(page, 'IDE Git: Open Log');
    await sleep(3000);
    await enlargePanel(page);
    const log = await frameWith(page, '[aria-label="Commit log"]', 20000);
    const toolbarButton = log.getByRole('button', { name: 'Worktree: main' });
    const popup = log.getByRole('dialog', { name: 'Worktrees' });
    const openList = async () => {
      if (!(await popup.count())) await toolbarButton.click();
      await popup.waitFor({ timeout: 10000 });
      await sleep(300);
    };
    await toolbarButton.waitFor({ timeout: 10000 });
    await openList();
    check('the toolbar lists both worktrees', (await popup.locator('.worktree-option[title^="/"]').count()) === 2);
    await shot('toolbar');
    await page.keyboard.press('Escape');
    await log.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await sleep(300);
    check('feat/x is marked as being in another worktree', (await log.locator('[title^="refs/heads/feat/x — checked out in"]').count()) === 1);
    await shot('log');
    await log.locator('[title^="refs/heads/feat/x"]').first().click({ button: 'right' });
    await sleep(500);
    check('its menu offers Switch instead of Checkout', (await log.getByRole('menuitem', { name: 'Switch to Its Worktree' }).count()) === 1 && (await log.getByRole('menuitem', { name: 'Checkout', exact: true }).count()) === 0);
    await page.keyboard.press('Escape');
    await sleep(300);

    // 3. Remove it from the Log after confirming.
    await openList();
    await popup.locator('.worktree-option', { hasText: 'feat/x' }).click({ button: 'right' });
    await sleep(500);
    await log.getByRole('menuitem', { name: 'Remove Worktree…' }).click();
    await sleep(800);
    await page.locator('.monaco-dialog-box').getByRole('button', { name: 'Remove Worktree' }).click();
    await sleep(2500);
    check('removed after confirming', worktreePaths().length === 1 && git(workspace, 'branch', '--list', 'feat/x') !== '');
    await openList();
    check('the Log drops the removed worktree', (await popup.locator('.worktree-option[title^="/"]').count()) === 1);
    await page.keyboard.press('Escape');

    // 4. A worktree created in the terminal shows up; picking it switches this window.
    const other = `${root}-feat-y`;
    git(workspace, 'worktree', 'add', '-q', other, 'feat/y');
    await runCommand(page, 'IDE Git: Open Log');
    await sleep(1500);
    await log.getByRole('button', { name: 'Refresh' }).first().click().catch(() => undefined);
    await sleep(2500);
    await openList();
    const row = popup.locator('.worktree-option', { hasText: 'feat/y' });
    await row.waitFor({ timeout: 10000 });
    await row.click();
    let title = '';
    for (let attempt = 0; attempt < 20 && !title.includes('repo-feat-y'); attempt += 1) {
      await sleep(1000);
      title = await page.title().catch(() => '');
    }
    check('clicking it switched this window to the worktree', title.includes('repo-feat-y'), title);
  },
};
