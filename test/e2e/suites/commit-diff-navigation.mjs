// Commit window: F7 continues into the next file and the list selection follows the editor.
import { join } from 'node:path';
import { editorState, focusModifiedEditor, frameWith, git, initRepository, runCommand, statusBarText, writeFiles } from '../lib.mjs';

const lines = (prefix, count) => Array.from({ length: count }, (_, index) => `export const ${prefix}${String(index)} = ${String(index)};`).join('\n') + '\n';

export default {
  setup(directory) {
    const repo = initRepository(join(directory, 'repo'));
    writeFiles(repo, { 'a.ts': lines('a', 40), 'lib/b.ts': lines('b', 30) });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    const a = lines('a', 40).split('\n');
    a[2] = 'export const a2 = 22;';
    a[20] = 'export const a20 = 2020;';
    const b = lines('b', 30).split('\n');
    b[25] = 'export const b25 = 2525;';
    writeFiles(repo, { 'a.ts': a.join('\n'), 'lib/b.ts': b.join('\n') });
    return repo;
  },
  async run({ page, check, shot }) {
    const sleep = (ms) => page.waitForTimeout(ms);
    await runCommand(page, 'IDE Git: Commit…');
    const commit = await frameWith(page, '.commit-shell');
    await sleep(1500);
    const row = (name) => commit.locator('.tree-row', { hasText: name }).first();
    // Directories come first, so lib/b.ts is listed before a.ts.
    await row('b.ts').dblclick();
    await sleep(2500);
    await focusModifiedEditor(page);
    await page.keyboard.press('Meta+Home');
    const press = async () => {
      await page.keyboard.press('F7');
      await sleep(700);
      return editorState(page);
    };
    const first = await press();
    check('F7 moves to the change in b.ts', /Ln 26,/u.test(first.position), first.position);
    await press();
    check('the status bar names the next file', /press again to open a\.ts/u.test(await statusBarText(page)));
    await press();
    await sleep(1500);
    const next = await editorState(page);
    check('a second F7 opens a.ts (HEAD ↔ Local)', /a\.ts \(HEAD ↔ Local\)/u.test(next.tab), next.tab);
    check('…at its first change', /Ln 3,/u.test(next.position), next.position);
    check('the Commit window selects a.ts', (await row('a.ts').getAttribute('aria-selected')) === 'true' && (await row('b.ts').getAttribute('aria-selected')) === 'false');
    await shot('next-file');
    await press();
    await press();
    await press();
    check('the last file reports its end', /last change of the last file/u.test(await statusBarText(page)));
  },
};
