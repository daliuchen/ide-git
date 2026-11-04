// Regenerates the README screenshots in images/ from a demo project, so they can be refreshed
// whenever the UI changes:   pnpm run build && node test/e2e/readme-screenshots.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXTENSION_ROOT,
  enlargePanel,
  focusModifiedEditor,
  frameWith,
  git,
  initRepository,
  launch,
  openFile,
  runCommand,
  scratchDirectory,
  writeFiles,
} from './lib.mjs';

const IMAGES = join(EXTENSION_ROOT, 'images');
const WIDTH = 1400;

function commitAs(repo, author, message, files) {
  writeFiles(repo, files);
  git(repo, 'add', '-A');
  execFileSync('git', ['commit', '-q', '-m', message], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: `${author.toLowerCase()}@example.com`,
      GIT_COMMITTER_NAME: author,
      GIT_COMMITTER_EMAIL: `${author.toLowerCase()}@example.com`,
    },
  });
}

const cart = (discount, tax, extra = '') => `import type { Item } from './item';

export interface Cart {
  items: Item[];
  coupon?: string;
}

export function subtotal(cart: Cart): number {
  return cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

export function discount(cart: Cart): number {
  return ${discount};
}

export function tax(amount: number): number {
  return ${tax};
}

export function total(cart: Cart): number {
  const amount = subtotal(cart) - discount(cart);
  return amount + tax(amount);
}
${extra}`;

/** A small shop API with a few authors, a feature branch (one commit cherry-picked) and a remote. */
function demoProject(directory) {
  const remote = join(directory, 'shop-api.git');
  git(directory, 'init', '-q', '--bare', '-b', 'main', remote);
  const repo = initRepository(join(directory, 'shop-api'));
  commitAs(repo, 'Alice', 'feat: cart totals', {
    'src/item.ts': 'export interface Item {\n  sku: string;\n  price: number;\n  quantity: number;\n}\n',
    'src/cart.ts': cart('0', 'Math.round(amount * 0.08)'),
    'README.md': '# shop-api\n\nCart and checkout for the demo shop.\n',
  });
  commitAs(repo, 'Bob', 'feat: checkout endpoint', {
    'src/checkout.ts': "import { total, type Cart } from './cart';\n\nexport function checkout(cart: Cart) {\n  return { amount: total(cart), currency: 'EUR' };\n}\n",
  });
  commitAs(repo, 'Carol', 'fix: round tax per order, not per item', { 'src/cart.ts': cart('0', 'Math.round(amount * 0.08 * 100) / 100') });
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'switch', '-q', '-c', 'feature/discounts');
  commitAs(repo, 'Bob', 'feat: percentage coupons', {
    'src/coupon.ts': "export function percentOff(code: string | undefined): number {\n  return code === 'SAVE10' ? 0.1 : 0;\n}\n",
  });
  commitAs(repo, 'Bob', 'feat: apply coupons to the cart', {
    'src/checkout.ts': "import { total, type Cart } from './cart';\n\nexport function checkout(cart: Cart) {\n  return { amount: total(cart), coupon: cart.coupon ?? null, currency: 'EUR' };\n}\n",
    'src/cart.ts': cart("Math.round(subtotal(cart) * percentOff(cart.coupon) * 100) / 100", 'Math.round(amount * 0.08 * 100) / 100', "\nimport { percentOff } from './coupon';\n"),
  });
  commitAs(repo, 'Bob', 'docs: describe coupons', { 'README.md': '# shop-api\n\nCart and checkout for the demo shop.\n\nCoupons: `SAVE10` takes 10% off.\n' });
  git(repo, 'switch', '-q', 'main');
  // The docs commit was cherry-picked onto main, so the Log marks it as picked on the branch.
  execFileSync('git', ['cherry-pick', 'feature/discounts'], {
    cwd: repo,
    env: { ...process.env, GIT_COMMITTER_NAME: 'Alice', GIT_COMMITTER_EMAIL: 'alice@example.com' },
    stdio: 'ignore',
  });
  commitAs(repo, 'Alice', 'chore: log checkout totals', {
    'src/checkout.ts': "import { total, type Cart } from './cart';\n\nexport function checkout(cart: Cart) {\n  const amount = total(cart);\n  console.info('checkout', amount);\n  return { amount, currency: 'EUR' };\n}\n",
  });
  // Work in progress for the Commit window: two chunks in cart.ts, one edited and one new file.
  writeFiles(repo, {
    'src/cart.ts': cart('cart.coupon ? 5 : 0', 'Math.round(amount * 0.08 * 100) / 100', '\nexport const FREE_SHIPPING_FROM = 50;\n'),
    'src/shipping.ts': "import { FREE_SHIPPING_FROM } from './cart';\n\nexport function shipping(amount: number): number {\n  return amount >= FREE_SHIPPING_FROM ? 0 : 4.9;\n}\n",
    'README.md': '# shop-api\n\nCart, checkout and shipping for the demo shop.\n\nCoupons: `SAVE10` takes 10% off.\n',
  });
  return repo;
}

/** `rest` is where the mouse goes first (out of the way of tooltips), or null to leave it. */
async function save(page, name, rest = [4, 4]) {
  if (rest) {
    await page.mouse.move(rest[0], rest[1]);
    await page.waitForTimeout(400);
  }
  mkdirSync(IMAGES, { recursive: true });
  const png = join(IMAGES, `${name}.png`);
  await page.screenshot({ path: png });
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', String(WIDTH), png, '--out', join(IMAGES, `${name}.jpg`)], { stdio: 'ignore' });
  rmSync(png);
  console.log(`  images/${name}.jpg`);
}

const directory = scratchDirectory('readme');
const repo = demoProject(directory);
const { page, close } = await launch(repo);
const sleep = (ms) => page.waitForTimeout(ms);
try {
  // Commit window: one chunk of cart.ts and the new file selected, the rest left out.
  await runCommand(page, 'IDE Git: Commit…');
  const commit = await frameWith(page, '.commit-shell');
  await commit.waitForSelector('.tree-row', { timeout: 15000 });
  await sleep(1500);
  const row = (name) => commit.locator('.tree-row', { hasText: name }).first();
  const checkbox = (locator) => locator.locator('[role="checkbox"]').first();
  await checkbox(row('shipping.ts')).click();
  await checkbox(row('README.md')).click();
  await row('cart.ts').locator('.chunk-twistie').first().dispatchEvent('mousedown');
  await sleep(1500);
  const hunks = commit.locator('.hunk-row:not(.empty-hunks)');
  await checkbox(hunks.nth(1)).click();
  await commit.getByRole('textbox', { name: 'Commit message' }).fill('feat: flat coupon discount and free shipping');
  await sleep(500);
  // An empty spot inside the Commit view, so its own tooltip goes away.
  await save(page, 'commit-window', [180, 520]);
  // Line level: open the first chunk's lines and leave one out.
  await hunks.first().locator('.chunk-twistie').dispatchEvent('mousedown');
  await sleep(800);
  await checkbox(commit.locator('.line-row').first()).click();
  await sleep(500);
  await save(page, 'commit-lines', [180, 520]);

  // Log: another branch with commits the current one lacks (bold), has (dim) and picked.
  await runCommand(page, 'View: Toggle Primary Side Bar Visibility');
  await runCommand(page, 'IDE Git: Open Log');
  await sleep(3000);
  await runCommand(page, 'View: Toggle Maximized Panel');
  await sleep(1000);
  const log = await frameWith(page, '[aria-label="Commit log"]', 20000);
  await log.locator('.ref-item', { hasText: 'discounts' }).first().click();
  await sleep(2000);
  await log.locator('[role="row"]').filter({ hasText: 'apply coupons to the cart' }).first().click();
  await sleep(1500);
  await save(page, 'log-branch');

  // Diff from the Log: Changed Files marks the open file; F7 at the last change names the next one.
  await runCommand(page, 'View: Toggle Maximized Panel');
  await sleep(1000);
  await enlargePanel(page, 470);
  await log.locator('button.file-row').filter({ hasText: 'cart.ts' }).first().dblclick();
  await sleep(2500);
  await focusModifiedEditor(page);
  await page.keyboard.press('Meta+Home');
  for (let press = 0; press < 3; press += 1) {
    await page.keyboard.press('F7');
    await sleep(700);
  }
  await save(page, 'log-diff');
  await runCommand(page, 'View: Close All Editors');

  // Merge dialog for the feature branch.
  await log.locator('.ref-item', { hasText: 'discounts' }).first().click({ button: 'right' });
  await sleep(600);
  await log.getByRole('menuitem', { name: 'Merge…' }).first().click();
  let dialog = await frameWith(page, 'form.dialog', 20000);
  await runCommand(page, 'View: Close Panel');
  await sleep(1200);
  await dialog.getByRole('radio', { name: 'Create a merge commit' }).check();
  await dialog.getByRole('textbox', { name: 'Merge message' }).fill('Merge feature/discounts: coupons');
  await sleep(500);
  await save(page, 'merge-dialog');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await sleep(1000);

  // Interactive rebase of the last three commits on main.
  await runCommand(page, 'IDE Git: Open Log');
  await sleep(1500);
  await log.locator('.ref-item', { hasText: 'main' }).first().click();
  await sleep(1500);
  await log.locator('[role="row"]').filter({ hasText: 'checkout endpoint' }).first().click({ button: 'right' });
  await sleep(600);
  await log.getByRole('menuitem', { name: 'Interactively Rebase from Here…' }).click();
  dialog = await frameWith(page, 'form.dialog', 20000);
  await runCommand(page, 'View: Close Panel');
  await sleep(1200);
  const actions = dialog.getByRole('combobox', { name: 'Action' });
  await actions.nth(1).selectOption('squash');
  await actions.nth(3).selectOption('reword');
  await sleep(600);
  await save(page, 'rebase-dialog');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await sleep(1000);

  // Push dialog.
  await runCommand(page, 'IDE Git: Open Log');
  await sleep(1500);
  await log.getByRole('button', { name: 'Push…' }).click();
  dialog = await frameWith(page, 'form.dialog', 20000);
  await runCommand(page, 'View: Close Panel');
  await sleep(2000);
  await save(page, 'push-dialog');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await sleep(1000);

  // Annotate with the hover (Show in Git Log, Annotate Previous Revision).
  await runCommand(page, 'View: Close All Editors');
  await runCommand(page, 'View: Close Panel');
  await openFile(page, 'cart.ts');
  await runCommand(page, 'IDE Git: Annotate with Git Blame');
  await sleep(1500);
  await runCommand(page, 'View: Close Panel');
  await sleep(1000);
  // Carol's line: committed, with an earlier version to go back to.
  const target = await page.locator('.monaco-editor .view-line').nth(16).boundingBox();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.mouse.move(target.x + 300, target.y + target.height / 2);
    await sleep(300);
    await page.mouse.move(target.x + 40, target.y + target.height / 2);
    await sleep(1800);
    if (await page.locator('.monaco-hover:visible').count()) break;
  }
  await save(page, 'annotate', null);
} finally {
  await close();
  rmSync(directory, { recursive: true, force: true });
}
