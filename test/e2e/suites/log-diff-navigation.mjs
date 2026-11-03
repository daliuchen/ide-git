// Log: Changed Files highlights the open file; F7 / Shift+F7 continue into neighbouring files.
import { join } from 'node:path';
import { editorState, focusModifiedEditor, frameWith, git, initRepository, runCommand, statusBarText, writeFiles } from '../lib.mjs';

const lines = (prefix, count) => Array.from({ length: count }, (_, index) => `export const ${prefix}${String(index)} = ${String(index)};`).join('\n') + '\n';

export default {
  setup(directory) {
    const repo = initRepository(join(directory, 'repo'));
    writeFiles(repo, { 'a.ts': lines('a', 40), 'lib/b.ts': lines('b', 30), 'README.md': '# Nav\n\nhello\n' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    const a = lines('a', 40).split('\n');
    a[5] = 'export const a5 = 500;';
    a[30] = 'export const a30 = 3000;';
    const b = lines('b', 30).split('\n');
    b[0] = 'export const b0 = -1;';
    b[12] = 'export const b12 = 1200;';
    writeFiles(repo, { 'a.ts': a.join('\n'), 'lib/b.ts': b.join('\n'), 'README.md': '# Nav\n\nhello world\n' });
    git(repo, 'commit', '-q', '-am', 'change three files');
    return repo;
  },
  async run({ page, check, shot }) {
    const sleep = (ms) => page.waitForTimeout(ms);
    await runCommand(page, 'IDE Git: Open Log');
    await sleep(3000);
    // Give the bottom panel room so the file list is not clipped.
    const panel = await page.locator('.part.panel').boundingBox();
    await page.mouse.move(panel.x + 300, panel.y - 1);
    await page.mouse.down();
    await page.mouse.move(panel.x + 300, 330, { steps: 8 });
    await page.mouse.up();
    await sleep(800);
    const log = await frameWith(page, '[aria-label="Commit log"]', 20000);
    await log.locator('[role="row"]').filter({ hasText: 'change three files' }).first().click();
    await sleep(1500);
    const fileRow = (name) => log.locator('button.file-row').filter({ hasText: name }).first();
    await fileRow('a.ts').dblclick();
    await sleep(2500);
    check('the opened file is highlighted', (await fileRow('a.ts').getAttribute('aria-current')) === 'true');
    await focusModifiedEditor(page);
    await page.keyboard.press('Meta+Home');
    const press = async (key = 'F7') => {
      await page.keyboard.press(key);
      await sleep(700);
      return editorState(page);
    };
    await press();
    await press();
    await press();
    check('the status bar names the next file at the last change', /press again to open b\.ts/u.test(await statusBarText(page)));
    await press();
    await sleep(1500);
    const next = await editorState(page);
    check('a second F7 opens the next file', /b\.ts/u.test(next.tab), next.tab);
    check('…at its first change', /Ln 1,/u.test(next.position), next.position);
    check('the highlight follows', (await fileRow('b.ts').getAttribute('aria-current')) === 'true');
    await shot('next-file');
    await press('Shift+F7');
    const back = await press('Shift+F7');
    check('Shift+F7 twice goes back to the previous file', /a\.ts/u.test(back.tab), back.tab);
    check('…at its last change', /Ln 31,/u.test(back.position), back.position);
  },
};
