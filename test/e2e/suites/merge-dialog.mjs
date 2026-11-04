// Merge… from a branch in the Log: create a merge commit with a custom message.
import { join } from 'node:path';
import { frameWith, git, initRepository, runCommand, writeFiles } from '../lib.mjs';

export default {
  setup(directory) {
    const repo = initRepository(join(directory, 'repo'));
    writeFiles(repo, { 'base.txt': 'base\n' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'switch', '-q', '-c', 'feature');
    for (const name of ['one', 'two']) {
      writeFiles(repo, { [`${name}.txt`]: `${name}\n` });
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', `feature ${name}`);
    }
    git(repo, 'switch', '-q', 'main');
    return repo;
  },
  async run({ page, check, workspace, shot }) {
    const sleep = (ms) => page.waitForTimeout(ms);
    await runCommand(page, 'IDE Git: Open Log');
    await sleep(3000);
    const log = await frameWith(page, '[aria-label="Commit log"]', 20000);
    await log.locator('.ref-item', { hasText: 'feature' }).first().click({ button: 'right' });
    await sleep(600);
    await log.getByRole('menuitem', { name: 'Merge…' }).first().click();
    const dialog = await frameWith(page, 'form.dialog', 20000);
    await sleep(1000);
    const listed = await dialog.locator('.commit-row .subject').allInnerTexts();
    check('lists the commits to merge', listed.join(',') === 'feature two,feature one', JSON.stringify(listed));
    const message = dialog.getByRole('textbox', { name: 'Merge message' });
    check('no message while it would only fast-forward', await message.isDisabled());
    await dialog.getByRole('radio', { name: 'Create a merge commit' }).check();
    await message.fill('Bring in feature');
    await shot('dialog');
    await dialog.getByRole('button', { name: 'Merge' }).click();
    await sleep(3000);
    const head = git(workspace, 'log', '-1', '--format=%s|%P');
    const [subject = '', parents = ''] = head.split('|');
    check('created a merge commit with the message', subject === 'Bring in feature' && parents.split(' ').length === 2, head);
    check('the working tree is clean', git(workspace, 'status', '--porcelain') === '');
  },
};
