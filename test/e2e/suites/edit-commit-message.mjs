// Edit Commit Message… on an older commit rewrites only that message; files stay the same.
import { join } from 'node:path';
import { enlargePanel, frameWith, git, initRepository, runCommand, writeFiles } from '../lib.mjs';

export default {
  setup(directory) {
    const repo = initRepository(join(directory, 'repo'));
    for (const [file, message] of [['a.txt', 'first'], ['b.txt', 'secnod with a typo'], ['c.txt', 'third']]) {
      writeFiles(repo, { [file]: `${file}\n` });
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', message);
    }
    return repo;
  },
  async run({ page, check, workspace, shot }) {
    const sleep = (ms) => page.waitForTimeout(ms);
    const treeBefore = git(workspace, 'rev-parse', 'HEAD^{tree}');
    await runCommand(page, 'IDE Git: Open Log');
    await sleep(3000);
    await enlargePanel(page);
    const log = await frameWith(page, '[aria-label="Commit log"]', 20000);
    await log.locator('[role="row"]').filter({ hasText: 'secnod with a typo' }).first().click({ button: 'right' });
    await sleep(600);
    await log.getByRole('menuitem', { name: 'Edit Commit Message…' }).click();
    const dialog = await frameWith(page, 'form.dialog', 20000);
    await sleep(1000);
    const editor = dialog.getByRole('textbox', { name: /Commit message/u });
    check('the dialog shows the current message', (await editor.inputValue()) === 'secnod with a typo', await editor.inputValue());
    await editor.fill('second');
    await shot('reword');
    await dialog.getByRole('button', { name: 'OK' }).click();
    await sleep(3000);
    check('the message was rewritten', git(workspace, 'log', '--format=%s').split('\n').join(',') === 'third,second,first');
    check('the files did not change', git(workspace, 'rev-parse', 'HEAD^{tree}') === treeBefore && git(workspace, 'status', '--porcelain') === '');
  },
};
