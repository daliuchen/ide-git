// Several selected commits: cherry-pick two non-adjacent commits from another branch, then revert both.
import { join } from 'node:path';
import { enlargePanel, frameWith, git, initRepository, runCommand, writeFiles } from '../lib.mjs';

export default {
  setup(directory) {
    const repo = initRepository(join(directory, 'repo'));
    writeFiles(repo, { 'base.txt': 'base\n' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'switch', '-q', '-c', 'feature');
    for (const [file, message] of [['one.txt', 'feat one'], ['two.txt', 'feat two'], ['three.txt', 'feat three']]) {
      writeFiles(repo, { [file]: `${file}\n` });
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', message);
    }
    git(repo, 'switch', '-q', 'main');
    return repo;
  },
  async run({ page, check, workspace, shot }) {
    const sleep = (ms) => page.waitForTimeout(ms);
    const subjects = () => git(workspace, 'log', '--format=%s').split('\n');
    const confirm = async (label) => {
      await sleep(800);
      await page.locator('.monaco-dialog-box').getByRole('button', { name: label }).click();
      await sleep(3000);
    };
    await runCommand(page, 'IDE Git: Open Log');
    await sleep(3000);
    await enlargePanel(page);
    const log = await frameWith(page, '[aria-label="Commit log"]', 20000);
    const row = (subject) => log.locator('[role="row"]').filter({ hasText: subject }).first();

    // 1. Show the feature branch, pick "feat one" and "feat three" (skipping "feat two").
    await log.locator('[title^="refs/heads/feature"]').first().click();
    await sleep(2000);
    await row('feat one').click();
    await row('feat three').click({ modifiers: ['Meta'] });
    await row('feat three').click({ button: 'right' });
    await sleep(500);
    const pick = log.getByRole('menuitem', { name: 'Cherry-pick 2 Commits' });
    check('the menu offers Cherry-pick 2 Commits', (await pick.count()) === 1);
    check(
      'single-commit actions are hidden for a multi-selection',
      (await log.getByRole('menuitem', { name: 'New Branch…' }).count()) === 0 &&
        (await log.getByRole('menuitem', { name: 'Copy Hash' }).count()) === 0,
    );
    await shot('menu');
    await pick.click();
    await confirm('Cherry-pick');
    check(
      'both commits landed on main, oldest first',
      subjects().join(',') === 'feat three,feat one,base',
      subjects().join(','),
    );

    // 2. Back on main, revert both picked commits.
    await log.getByRole('button', { name: 'Back to current branch' }).click();
    await sleep(2000);
    await row('feat three').click();
    await row('feat one').click({ modifiers: ['Shift'] });
    await row('feat one').click({ button: 'right' });
    await sleep(500);
    await log.getByRole('menuitem', { name: 'Revert 2 Commits' }).click();
    await confirm('Revert');
    check(
      'one revert commit each, newest first',
      subjects().slice(0, 2).join(',') === 'Revert "feat one",Revert "feat three"',
      subjects().join(','),
    );
    check('the work tree is back to base', git(workspace, 'ls-files').split('\n').join(',') === 'base.txt');
  },
};
