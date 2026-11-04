// Manage Remotes: add a remote and fetch it, rename it, then remove it.
import { join } from 'node:path';
import { enlargePanel, frameWith, git, initRepository, runCommand, writeFiles } from '../lib.mjs';

export default {
  setup(directory) {
    const remote = join(directory, 'server.git');
    git(directory, 'init', '-q', '--bare', '-b', 'main', remote);
    const other = initRepository(join(directory, 'other'));
    writeFiles(other, { 'shared.txt': 'shared\n' });
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'on the server');
    git(other, 'push', '-q', remote, 'main');
    const repo = initRepository(join(directory, 'repo'));
    writeFiles(repo, { 'a.txt': 'a\n' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    return repo;
  },
  async run({ page, check, workspace, shot }) {
    const sleep = (ms) => page.waitForTimeout(ms);
    const remote = join(workspace, '..', 'server.git');
    const quickInput = page.locator('.quick-input-widget');
    const pick = async (text) => {
      await page.keyboard.type(text);
      await sleep(500);
      await page.keyboard.press('Enter');
      await sleep(800);
    };
    await runCommand(page, 'IDE Git: Manage Remotes');
    await sleep(800);
    check('lists Add Remote for a repository without remotes', /Add Remote/u.test(await quickInput.innerText()));
    await pick('Add Remote');
    // The name box is prefilled with "origin".
    await page.keyboard.press('Enter');
    await sleep(600);
    await page.keyboard.type(remote);
    await page.keyboard.press('Enter');
    await sleep(2000);
    await page.locator('.notification-toast').getByRole('button', { name: 'Fetch' }).click();
    await sleep(2500);
    check('added origin with the URL', git(workspace, 'remote', 'get-url', 'origin') === remote);
    check('fetched its branches', git(workspace, 'branch', '-r') === 'origin/main');
    await shot('after-add');
    // The list comes back after each action.
    check('the list shows origin', /origin/u.test(await quickInput.innerText().catch(() => '')));
    await pick('origin');
    await pick('Rename');
    await page.keyboard.press('Meta+A');
    await page.keyboard.type('upstream');
    await page.keyboard.press('Enter');
    await sleep(2000);
    check('renamed to upstream', git(workspace, 'remote') === 'upstream' && git(workspace, 'branch', '-r') === 'upstream/main');
    await pick('upstream');
    await pick('Remove');
    await page.locator('.monaco-dialog-box').getByRole('button', { name: 'Remove Remote' }).click();
    await sleep(2000);
    check('removed after confirming', git(workspace, 'remote') === '' && git(workspace, 'branch', '-r') === '');
    await page.keyboard.press('Escape');
    await sleep(500);
    // The gear next to "Remote" in the Log's branch list opens the same list.
    await runCommand(page, 'IDE Git: Open Log');
    await sleep(3000);
    await enlargePanel(page);
    const log = await frameWith(page, '[aria-label="Commit log"]', 20000);
    await shot('log-gear');
    await log.getByRole('button', { name: 'Manage remotes' }).click();
    await sleep(1200);
    check('the gear in the Log opens Manage Remotes', /Manage Remotes/u.test(await quickInput.innerText().catch(() => '')));
    await page.keyboard.press('Escape');
  },
};
