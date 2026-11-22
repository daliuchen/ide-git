// ⌘⇧K opens the Push dialog for the repository of the active file, instead of deleting the line.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frameWith, git, initRepository, openFile, writeFiles } from '../lib.mjs';

export default {
  setup(directory) {
    const remote = join(directory, 'remote.git');
    git(directory, 'init', '-q', '--bare', remote);
    const repo = initRepository(join(directory, 'repo'));
    writeFiles(repo, { 'a.txt': 'a\n' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'remote', 'add', 'origin', remote);
    return repo;
  },
  async run({ page, check, workspace, shot }) {
    await openFile(page, 'a.txt');
    await page.waitForTimeout(1500);
    await page.keyboard.press('Meta+Shift+K');
    const dialog = await frameWith(page, 'form.dialog', 20000);
    await page.waitForTimeout(1000);
    check('⌘⇧K opened the Push dialog', (await dialog.getByRole('button', { name: 'Push' }).count()) === 1);
    check('the editor line was not deleted', readFileSync(join(workspace, 'a.txt'), 'utf8') === 'a\n');
    await shot('dialog');
  },
};
