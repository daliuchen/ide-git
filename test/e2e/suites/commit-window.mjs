// The Commit window's core flows, one after another on the same repository: commit one chunk,
// amend the rest in, commit an unversioned file and push, undo the commit from the Log, and roll
// a file back. Every step is checked with the git CLI.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { enlargePanel, frameWith, git, initRepository, runCommand, writeFiles } from '../lib.mjs';

const lines = Array.from({ length: 40 }, (_, index) => `export const value${String(index)} = ${String(index)};`);

export default {
  setup(directory) {
    const remote = join(directory, 'server.git');
    git(directory, 'init', '-q', '--bare', '-b', 'main', remote);
    const repo = initRepository(join(directory, 'repo'));
    writeFiles(repo, { 'src/app.ts': `${lines.join('\n')}\n`, 'notes.md': '# Notes\n' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    const changed = [...lines];
    changed[2] = 'export const value2 = 200;';
    changed[30] = 'export const value30 = 3000;';
    writeFiles(repo, { 'src/app.ts': `${changed.join('\n')}\n`, 'new.txt': 'new file\n', 'notes.md': '# Notes\n\nedited\n' });
    return repo;
  },
  async run({ page, check, workspace, shot }) {
    const sleep = (ms) => page.waitForTimeout(ms);
    const sh = (...args) => git(workspace, ...args);
    await runCommand(page, 'IDE Git: Commit…');
    const commit = await frameWith(page, '.commit-shell');
    await commit.waitForSelector('.tree-row', { timeout: 15000 });
    await sleep(1500);
    const row = (name) => commit.locator('.tree-row', { hasText: name }).first();
    const checkbox = (locator) => locator.locator('[role="checkbox"]').first();
    const message = commit.getByRole('textbox', { name: 'Commit message' });
    const confirmModal = async () => {
      const dialog = page.locator('.monaco-dialog-box');
      if (await dialog.count()) {
        await dialog.locator('.monaco-button').last().click();
        await sleep(1500);
      }
    };

    // Defaults: changes are included, unversioned files are not.
    check(
      'changed files are included and unversioned ones are not',
      (await checkbox(row('app.ts')).getAttribute('aria-checked')) === 'true' &&
        (await checkbox(row('new.txt')).getAttribute('aria-checked')) === 'false',
    );

    // 1. Commit only the first chunk of app.ts (and nothing else).
    await checkbox(row('notes.md')).click();
    await checkbox(row('app.ts')).click();
    await row('app.ts').locator('.chunk-twistie').first().dispatchEvent('mousedown');
    await sleep(1500);
    const hunks = commit.locator('.hunk-row:not(.empty-hunks)');
    check('app.ts shows its two chunks', (await hunks.count()) === 2, String(await hunks.count()));
    await checkbox(hunks.first()).click();
    await message.fill('first chunk only');
    await shot('one-chunk');
    await commit.getByRole('button', { name: 'Commit', exact: true }).click();
    await sleep(2500);
    const committed = sh('show', '--format=', '-U0', 'HEAD', '--', 'src/app.ts');
    check(
      'only the first chunk was committed',
      sh('log', '-1', '--format=%s') === 'first chunk only' && /value2 = 200/u.test(committed) && !/value30 = 3000/u.test(committed),
    );
    check('the other chunk and file stay modified', /value30 = 3000/u.test(sh('diff', '--', 'src/app.ts')) && sh('diff', '--name-only', '--', 'notes.md') === 'notes.md');

    // 2. Amend the rest of app.ts into that commit with a new message.
    await commit.getByRole('checkbox', { name: 'Amend' }).check();
    await sleep(1200);
    check('Amend loads the last commit message', (await message.inputValue()) === 'first chunk only', await message.inputValue());
    if ((await checkbox(row('app.ts')).getAttribute('aria-checked')) !== 'true') await checkbox(row('app.ts')).click();
    if ((await checkbox(row('notes.md')).getAttribute('aria-checked')) === 'true') await checkbox(row('notes.md')).click();
    await message.fill('both chunks');
    await commit.getByRole('button', { name: 'Amend Commit', exact: true }).click();
    await sleep(2500);
    check(
      'amended in place: still two commits, app.ts fully committed',
      sh('rev-list', '--count', 'HEAD') === '2' && sh('log', '-1', '--format=%s') === 'both chunks' && sh('diff', '--name-only', '--', 'src/app.ts') === '',
    );

    // 3. Commit the unversioned file and push.
    await checkbox(row('new.txt')).click();
    if ((await checkbox(row('notes.md')).getAttribute('aria-checked')) === 'true') await checkbox(row('notes.md')).click();
    await message.fill('add new file');
    await commit.getByRole('button', { name: 'Commit and Push…' }).click();
    const push = await frameWith(page, 'form.dialog', 20000);
    await sleep(1500);
    await shot('push-dialog');
    await push.getByRole('button', { name: 'Push', exact: true }).click();
    await sleep(4000);
    check('the new file was committed and pushed', sh('ls-tree', '--name-only', 'origin/main', 'new.txt') === 'new.txt' && sh('rev-parse', 'HEAD') === sh('rev-parse', 'origin/main'));

    // 4. Undo Commit from the Log puts the message back into the Commit window.
    await runCommand(page, 'IDE Git: Open Log');
    await sleep(3000);
    await enlargePanel(page);
    const log = await frameWith(page, '[aria-label="Commit log"]', 20000);
    await log.locator('[role="row"]').filter({ hasText: 'add new file' }).first().click({ button: 'right' });
    await sleep(600);
    await log.getByRole('menuitem', { name: 'Undo Commit' }).click();
    await sleep(1500);
    await confirmModal();
    await sleep(1500);
    check('Undo Commit moved HEAD back and kept the file', sh('log', '-1', '--format=%s') === 'both chunks' && readFileSync(join(workspace, 'new.txt'), 'utf8') === 'new file\n');
    const restored = await frameWith(page, '.commit-shell');
    check('…and put its message back', (await restored.getByRole('textbox', { name: 'Commit message' }).inputValue()) === 'add new file');

    // 5. Rollback notes.md.
    // Focus the Commit view first; coming back from the Log the first click only focuses it.
    const notes = restored.locator('.tree-row', { hasText: 'notes.md' }).first();
    await notes.click();
    await sleep(400);
    await notes.click({ button: 'right' });
    await sleep(600);
    await restored.getByRole('menuitem', { name: /^Rollback/u }).first().click();
    await sleep(1000);
    await page.locator('.monaco-dialog-box').getByRole('button', { name: 'Rollback', exact: true }).click();
    await sleep(2000);
    check('Rollback restored notes.md', sh('status', '--porcelain', '--', 'notes.md') === '' && readFileSync(join(workspace, 'notes.md'), 'utf8') === '# Notes\n');
  },
};
