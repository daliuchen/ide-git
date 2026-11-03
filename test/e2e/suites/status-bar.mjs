// The status bar shows the branch with ahead/behind counts and opens Branches.
import { join } from 'node:path';
import { git, initRepository, openFile, writeFiles } from '../lib.mjs';

export default {
  setup(directory) {
    const remote = join(directory, 'remote.git');
    git(directory, 'init', '-q', '--bare', '-b', 'main', remote);
    const repo = initRepository(join(directory, 'repo'));
    writeFiles(repo, { 'a.txt': 'a\n' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    git(repo, 'branch', 'feature');
    const other = join(directory, 'other');
    git(directory, 'clone', '-q', remote, other);
    writeFiles(other, { 'b.txt': 'b\n' });
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'theirs');
    git(other, 'push', '-q');
    for (const name of ['c.txt', 'd.txt']) {
      writeFiles(repo, { [name]: `${name}\n` });
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', name);
    }
    git(repo, 'fetch', '-q');
    return repo;
  },
  async run({ page, check, workspace, shot }) {
    const sleep = (ms) => page.waitForTimeout(ms);
    const item = page.locator('.statusbar-item[id$="gitLogWorkbench.branch"]').first();
    await openFile(page, 'a.txt');
    await sleep(2000);
    let text = (await item.innerText().catch(() => '')).trim();
    check('shows the branch with ahead/behind', /main\s*↑2\s*↓1/u.test(text), JSON.stringify(text));
    git(workspace, 'checkout', '-q', 'feature');
    await sleep(4000);
    text = (await item.innerText().catch(() => '')).trim();
    check('updates after a checkout outside the editor', /feature/u.test(text) && !/↑/u.test(text), JSON.stringify(text));
    await item.click();
    await sleep(1500);
    check('a click opens Branches', await page.locator('.quick-input-widget').isVisible());
    await shot('branches');
  },
};
