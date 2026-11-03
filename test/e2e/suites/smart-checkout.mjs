// Smart Checkout from the Branches popup carries local changes to the other branch.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, initRepository, runCommand, writeFiles } from '../lib.mjs';

export default {
  setup(directory) {
    const repo = initRepository(join(directory, 'repo'));
    writeFiles(repo, { 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'b\n' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'switch', '-q', '-c', 'feature');
    writeFiles(repo, { 'a.txt': 'ONE\ntwo\nthree\n' });
    git(repo, 'commit', '-q', '-am', 'feature edits a');
    git(repo, 'switch', '-q', 'main');
    // A change that blocks the checkout but merges cleanly afterwards.
    writeFiles(repo, { 'a.txt': 'one\ntwo\nthree local\n', 'b.txt': 'b local\n' });
    return repo;
  },
  async run({ page, check, workspace, shot }) {
    const sleep = (ms) => page.waitForTimeout(ms);
    await runCommand(page, 'IDE Git: Branches');
    await sleep(800);
    await page.keyboard.type('feature');
    await sleep(600);
    await page.keyboard.press('Enter');
    await sleep(1000);
    await page.keyboard.type('Checkout');
    await sleep(400);
    await page.keyboard.press('Enter');
    await sleep(2500);
    const dialog = page.locator('.monaco-dialog-box');
    const text = await dialog.innerText().catch(() => '');
    check('the dialog lists the blocking file', /a\.txt \(modified\)/u.test(text), JSON.stringify(text.slice(0, 120)));
    await shot('dialog');
    await dialog.getByRole('button', { name: 'Smart Checkout' }).click();
    await sleep(3000);
    check('checked out feature', git(workspace, 'branch', '--show-current') === 'feature');
    check('the local edit was merged into feature’s version', readFileSync(join(workspace, 'a.txt'), 'utf8') === 'ONE\ntwo\nthree local\n');
    check('the other local change is kept', readFileSync(join(workspace, 'b.txt'), 'utf8') === 'b local\n');
    check('no stash is left behind', git(workspace, 'stash', 'list') === '');
    check('the user is told the changes were restored', /restored/u.test(await page.locator('.notifications-toasts').innerText().catch(() => '')));
  },
};
