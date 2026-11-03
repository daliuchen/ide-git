// With an IDE keymap extension that also binds F7, IDE Git offers to add its own F7 shortcuts.
// Uses the keymap extension installed in Cursor or VS Code on this machine; skipped without one.
import { join } from 'node:path';
import { editorState, focusModifiedEditor, frameWith, git, initRepository, installedExtension, runCommand, writeFiles } from '../lib.mjs';

const KEYMAP = 'k--kato.intellij-idea-keybindings';
const lines = (prefix, count) => Array.from({ length: count }, (_, index) => `export const ${prefix}${String(index)} = ${String(index)};`).join('\n') + '\n';

export default {
  skip() {
    return installedExtension(KEYMAP) ? undefined : `needs ${KEYMAP} installed in Cursor or VS Code`;
  },
  launch() {
    return { extraExtensions: [installedExtension(KEYMAP)] };
  },
  setup(directory) {
    const repo = initRepository(join(directory, 'repo'));
    writeFiles(repo, { 'a.ts': lines('a', 40), 'b.ts': lines('b', 20) });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    const a = lines('a', 40).split('\n');
    a[5] = 'export const a5 = 500;';
    const b = lines('b', 20).split('\n');
    b[3] = 'export const b3 = 300;';
    writeFiles(repo, { 'a.ts': a.join('\n'), 'b.ts': b.join('\n') });
    git(repo, 'commit', '-q', '-am', 'change two files');
    return repo;
  },
  async run({ page, check, shot, userKeybindings }) {
    const sleep = (ms) => page.waitForTimeout(ms);
    await runCommand(page, 'IDE Git: Open Log');
    await sleep(3000);
    const panel = await page.locator('.part.panel').boundingBox();
    await page.mouse.move(panel.x + 300, panel.y - 1);
    await page.mouse.down();
    await page.mouse.move(panel.x + 300, 330, { steps: 8 });
    await page.mouse.up();
    await sleep(800);
    const log = await frameWith(page, '[aria-label="Commit log"]', 20000);
    await log.locator('[role="row"]').filter({ hasText: 'change two files' }).first().click();
    await sleep(1500);
    const openA = async () => {
      await log.locator('button.file-row').filter({ hasText: 'a.ts' }).first().dblclick();
      await sleep(2500);
    };
    await openA();
    const toast = page.locator('.notification-toast').filter({ hasText: 'also uses F7' }).first();
    const text = await toast.innerText().catch(() => '');
    check('the notice names the keymap extension', /IntelliJ IDEA Keybindings also uses F7/u.test(text), JSON.stringify(text.slice(0, 120)));
    await toast.getByRole('button', { name: 'Add Shortcuts' }).click();
    await sleep(2500);
    const file = userKeybindings();
    check('both shortcuts are in keybindings.json', file.includes('gitLogWorkbench.diff.nextChange') && file.includes('gitLogWorkbench.diff.previousChange'));
    check('the file is opened', /keybindings\.json/u.test((await editorState(page)).tab));
    await shot('shortcuts-added');
    await openA();
    await focusModifiedEditor(page);
    await page.keyboard.press('Meta+Home');
    // The only change, then the hint, then the next file.
    for (let press = 0; press < 3; press += 1) {
      await page.keyboard.press('F7');
      await sleep(800);
    }
    await sleep(1500);
    const state = await editorState(page);
    check('F7 now continues into the next file', /b\.ts/u.test(state.tab), state.tab);
    check('the notice is not shown again', (await page.locator('.notification-toast').filter({ hasText: 'also uses F7' }).count()) === 0);
  },
};
