// Worktrees: create one from Manage Worktrees, see it in the Log (group and branch mark), remove it
// from the Log, then switch this window to another worktree with a double-click.
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

    // 2. The Log shows a Worktrees group and marks feat/x as checked out elsewhere.
    await runCommand(page, 'IDE Git: Open Log');
    await sleep(3000);
    await enlargePanel(page);
    const log = await frameWith(page, '[aria-label="Commit log"]', 20000);
    const section = log.getByRole('region', { name: 'Worktrees' });
    await section.waitFor({ timeout: 10000 });
    check('the Log lists both worktrees', (await section.locator('.worktree-item').count()) === 2);
    check(
      'the group sits right above Tags',
      await (async () => {
        const headings = await log.locator('.ref-group-heading').allInnerTexts();
        const worktrees = headings.findIndex((text) => text.includes('Worktrees'));
        return worktrees >= 0 && headings[worktrees + 1]?.includes('Tags') === true;
      })(),
    );
    // A single click only shows that branch in the Log; the window stays.
    await section.locator('.worktree-item', { hasText: 'feat/x' }).click();
    await sleep(1500);
    check('a single click keeps this window', (await page.title()).includes('repo') && !(await page.title()).includes('repo-feat-x'));
    check('feat/x is marked as being in another worktree', (await log.locator('[title^="refs/heads/feat/x — checked out in"]').count()) === 1);
    await shot('log');
    await log.locator('[title^="refs/heads/feat/x"]').first().click({ button: 'right' });
    await sleep(500);
    check('its menu offers Switch instead of Checkout', (await log.getByRole('menuitem', { name: 'Switch to Its Worktree' }).count()) === 1 && (await log.getByRole('menuitem', { name: 'Checkout', exact: true }).count()) === 0);
    await page.keyboard.press('Escape');
    await sleep(300);

    // 3. Remove it from the Log after confirming.
    await section.locator('.worktree-item', { hasText: 'feat/x' }).click({ button: 'right' });
    await sleep(500);
    await log.getByRole('menuitem', { name: 'Remove Worktree…' }).click();
    await sleep(800);
    await page.locator('.monaco-dialog-box').getByRole('button', { name: 'Remove Worktree' }).click();
    await sleep(2500);
    check('removed after confirming', worktreePaths().length === 1 && git(workspace, 'branch', '--list', 'feat/x') !== '');
    check('the Log drops the removed worktree', (await section.count()) === 0);

    // 4. A worktree created in the terminal shows up; double-clicking it switches this window.
    const other = `${root}-feat-y`;
    git(workspace, 'worktree', 'add', '-q', other, 'feat/y');
    await runCommand(page, 'IDE Git: Open Log');
    await sleep(1500);
    await log.getByRole('button', { name: 'Refresh' }).first().click().catch(() => undefined);
    await sleep(2500);
    const row = section.locator('.worktree-item', { hasText: 'feat/y' });
    await row.waitFor({ timeout: 10000 });
    await row.dblclick();
    let title = '';
    for (let attempt = 0; attempt < 20 && !title.includes('repo-feat-y'); attempt += 1) {
      await sleep(1000);
      title = await page.title().catch(() => '');
    }
    check('double-click switched this window to the worktree', title.includes('repo-feat-y'), title);
  },
};
