// The Stashes dialog shows each stash's message, the branch it was made on, and when.
import { join } from 'node:path';
import { frameWith, git, initRepository, runCommand, writeFiles } from '../lib.mjs';

export default {
  setup(directory) {
    const repo = initRepository(join(directory, 'repo'));
    writeFiles(repo, { 'a.txt': 'a\n' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    writeFiles(repo, { 'a.txt': 'on main\n' });
    git(repo, 'stash', 'push', '-q', '-m', '暂存起来');
    git(repo, 'switch', '-q', '-c', 'feat/history');
    writeFiles(repo, { 'a.txt': 'on feature\n' });
    git(repo, 'stash', 'push', '-q');
    return repo;
  },
  async run({ page, check, shot }) {
    await runCommand(page, 'IDE Git: Open Log');
    await page.waitForTimeout(3000);
    const log = await frameWith(page, '[aria-label="Commit log"]', 20000);
    await log.getByRole('button', { name: 'Manage stashes' }).click();
    await page.waitForTimeout(1500);
    const rows = await log.locator('.stash-tool-row').allInnerTexts();
    const newest = rows.find((row) => row.includes('feat/history')) ?? '';
    const older = rows.find((row) => row.includes('暂存起来')) ?? '';
    check('a stash without a message shows its branch and commit', /feat\/history/u.test(newest) && /base/u.test(newest), JSON.stringify(newest));
    check('a named stash shows its message and branch, without the "On main:" prefix', /main/u.test(older) && !/On main:/u.test(older), JSON.stringify(older));
    check('each row shows when it was made', rows.every((row) => /\d{1,2}:\d{2}/u.test(row)), JSON.stringify(rows));
    await shot('stashes');
  },
};
