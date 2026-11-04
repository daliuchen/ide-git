// In a short editor area, dialog parts must not overlap: the dialog scrolls instead.
import { join } from 'node:path';
import { enlargePanel, frameWith, git, initRepository, runCommand, writeFiles } from '../lib.mjs';

export default {
  setup(directory) {
    const repo = initRepository(join(directory, 'repo'));
    writeFiles(repo, { 'a.txt': 'a\n' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'switch', '-q', '-c', 'feature');
    for (const name of ['one', 'two', 'three']) {
      writeFiles(repo, { [`${name}.txt`]: `${name}\n` });
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', `feature ${name}`);
    }
    git(repo, 'switch', '-q', 'main');
    return repo;
  },
  async run({ page, check }) {
    await runCommand(page, 'IDE Git: Open Log');
    await page.waitForTimeout(3000);
    // A tall panel leaves the dialog little room above it.
    await enlargePanel(page, 330);
    const log = await frameWith(page, '[aria-label="Commit log"]', 20000);
    await log.locator('.ref-item', { hasText: 'feature' }).first().click({ button: 'right' });
    await page.waitForTimeout(600);
    await log.getByRole('menuitem', { name: 'Merge…' }).first().click();
    const dialog = await frameWith(page, 'form.dialog', 20000);
    await page.waitForTimeout(1200);
    const list = await dialog.locator('.commit-list').boundingBox();
    const options = await dialog.locator('.merge-modes').boundingBox();
    check('the commit list ends above the options', list.y + list.height <= options.y + 1, JSON.stringify({ listBottom: list.y + list.height, optionsTop: options.y }));
    await dialog.getByRole('button', { name: 'Merge' }).scrollIntoViewIfNeeded();
    check('the Merge button is reachable by scrolling', await dialog.getByRole('button', { name: 'Merge' }).isVisible());
  },
};
