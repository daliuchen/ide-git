// Annotate Previous Revision follows a line back across a reformat and a rename.
import { join } from 'node:path';
import { editorState, git, initRepository, openFile, runCommand, writeFiles } from '../lib.mjs';

export default {
  setup(directory) {
    const repo = initRepository(join(directory, 'repo'));
    const commit = (author, message) => {
      git(repo, 'add', '-A');
      git(repo, '-c', `user.name=${author}`, 'commit', '-q', `--author=${author} <${author.toLowerCase()}@example.com>`, '-m', message);
    };
    writeFiles(repo, { 'old.rb': 'header\nvalue = compute(1)\nfooter\n' });
    commit('Alice', 'A writes it');
    writeFiles(repo, { 'old.rb': 'header\nextra\nvalue = compute(2)\nfooter\n' });
    commit('Bob', 'B changes it');
    git(repo, 'mv', 'old.rb', 'new.rb');
    commit('Bob', 'rename');
    writeFiles(repo, { 'new.rb': 'header\nextra\nvalue = compute( 2 )\nfooter\n' });
    commit('Carol', 'C reformats');
    return repo;
  },
  async run({ page, check, shot }) {
    const sleep = (ms) => page.waitForTimeout(ms);
    // The rendered hover uses non-breaking spaces.
    const words = (text) => new RegExp(text.split(' ').join('\\s+'), 'u');
    // The annotation and its hover can take a while on a cold start, so keep trying for a bit.
    const hover = async (lineNumber) => {
      const widget = page.locator('.monaco-hover:visible').first();
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const box = await page.locator('.monaco-editor .view-line').nth(lineNumber - 1).boundingBox();
        await page.mouse.move(box.x + 300, box.y + box.height / 2);
        await sleep(300);
        await page.mouse.move(box.x + 40, box.y + box.height / 2);
        await sleep(1800);
        const text = await widget.innerText().catch(() => '');
        if (/Show\s+Diff/u.test(text)) return { widget, text };
      }
      return { widget, text: await widget.innerText().catch(() => '') };
    };
    await openFile(page, 'new.rb');
    await runCommand(page, 'IDE Git: Annotate with Git Blame');
    await sleep(2000);
    const first = await hover(3);
    check('the hover skips the reformat (-w) and names B', words('B changes it').test(first.text));
    await first.widget.getByText('Annotate Previous Revision').first().click();
    await sleep(2500);
    const opened = await editorState(page);
    check('opens the file before the rename', /old\.rb/u.test(opened.tab), opened.tab);
    check('…with the cursor on the line it came from', /Ln 2,/u.test(opened.position), opened.position);
    await shot('previous');
    const second = await hover(2);
    check('that version is annotated too (A wrote the line)', words('A writes it').test(second.text));
    check('no older version is offered for the first commit', !words('Annotate Previous Revision').test(second.text));
  },
};
