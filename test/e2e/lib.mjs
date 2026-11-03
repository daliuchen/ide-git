// Drives a real VS Code with the extension under development, through the Chrome DevTools
// protocol. See test/e2e/README.md.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { chromium } from 'playwright-core';

export const EXTENSION_ROOT = resolve(import.meta.dirname, '..', '..');
export const SHOTS = join(EXTENSION_ROOT, '.vscode-test', 'e2e-shots');
const VERSION = process.env.IDE_GIT_E2E_VSCODE ?? '1.144.0';
const PORT = Number(process.env.IDE_GIT_E2E_PORT ?? 9339);

/**
 * A fresh scratch directory. On macOS it lives directly under /tmp: VS Code's IPC socket sits in
 * the user-data directory and Unix socket paths may not exceed 104 characters.
 */
export function scratchDirectory(prefix) {
  const base = process.platform === 'darwin' ? '/tmp' : join(EXTENSION_ROOT, '.vscode-test');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `ide-git-e2e-${prefix}-`));
}

/** Runs git with a fixed identity; returns trimmed stdout. */
export function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'E2E',
      GIT_AUTHOR_EMAIL: 'e2e@example.com',
      GIT_COMMITTER_NAME: 'E2E',
      GIT_COMMITTER_EMAIL: 'e2e@example.com',
    },
  }).trim();
}

/** Creates a repository with `main` checked out and the e2e identity configured. */
export function initRepository(path) {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'config', 'user.name', 'E2E');
  git(path, 'config', 'user.email', 'e2e@example.com');
  return path;
}

export function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** Launches VS Code on `workspace` and returns the workbench page. */
export async function launch(workspace, { keybindings, extraExtensions = [] } = {}) {
  const executable = await downloadAndUnzipVSCode({ version: VERSION, cachePath: join(EXTENSION_ROOT, '.vscode-test') });
  const profile = scratchDirectory('profile');
  mkdirSync(join(profile, 'User'), { recursive: true });
  writeFileSync(
    join(profile, 'User', 'settings.json'),
    JSON.stringify({
      'workbench.startupEditor': 'none',
      'security.workspace.trust.enabled': false,
      'window.restoreWindows': 'none',
      'update.mode': 'none',
      'telemetry.telemetryLevel': 'off',
      'workbench.colorTheme': 'Default Dark Modern',
      'git.blame.editorDecoration.enabled': false,
      'window.dialogStyle': 'custom',
      'chat.disableAIFeatures': true,
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'files.autoSave': 'off',
      'git.openRepositoryInParentFolders': 'never',
    }),
  );
  if (keybindings) writeFileSync(join(profile, 'User', 'keybindings.json'), JSON.stringify(keybindings));
  const child = spawn(
    executable,
    [
      workspace,
      `--user-data-dir=${profile}`,
      `--extensions-dir=${join(profile, 'extensions')}`,
      `--extensionDevelopmentPath=${EXTENSION_ROOT}`,
      ...extraExtensions.map((path) => `--extensionDevelopmentPath=${path}`),
      '--new-window',
      '--skip-release-notes',
      '--disable-workspace-trust',
      `--remote-debugging-port=${String(PORT)}`,
    ],
    { stdio: 'ignore', detached: true },
  );
  let browser;
  for (let attempt = 0; attempt < 60 && !browser; attempt += 1) {
    await new Promise((done) => setTimeout(done, 1000));
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(PORT)}`).catch(() => undefined);
  }
  if (!browser) throw new Error('Could not connect to VS Code.');
  let page;
  for (let attempt = 0; attempt < 30 && !page; attempt += 1) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes('workbench'));
    if (!page) await new Promise((done) => setTimeout(done, 1000));
  }
  if (!page) throw new Error('VS Code opened no workbench window.');
  await page.waitForTimeout(6000);
  // A first-run sign-in prompt may cover the window.
  const skip = page.getByText('Continue without Signing In');
  if (await skip.count()) await skip.first().click();
  await page.keyboard.press('Escape');
  const close = async () => {
    await browser.close().catch(() => undefined);
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
    // Helpers such as the crash reporter leave the process group; find them by the profile path.
    try {
      execFileSync('pkill', ['-9', '-f', profile]);
    } catch {
      // Nothing left.
    }
    await new Promise((done) => setTimeout(done, 1500));
    rmSync(profile, { recursive: true, force: true });
  };
  return { page, close };
}

export async function shot(page, name) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

export async function runCommand(page, label) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P');
  await page.waitForTimeout(400);
  await page.keyboard.type(label, { delay: 10 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
}

export async function openFile(page, name) {
  await runCommand(page, 'Go to File...');
  await page.keyboard.type(name);
  await page.waitForTimeout(600);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
}

/** The frame whose document contains `selector` (webviews are nested iframes). */
export async function frameWith(page, selector, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        if (await frame.$(selector)) return frame;
      } catch {
        // Detached while looking.
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`No frame contains ${selector}.`);
}

/** The active editor tab's label and the cursor position shown in the status bar. */
export async function editorState(page) {
  return {
    tab: (await page.locator('.tabs-container .tab.active').first().getAttribute('aria-label').catch(() => '')) ?? '',
    position: (await page.locator('#status\\.editor\\.selection').first().textContent().catch(() => '')) ?? '',
  };
}

/** Clicks into the modified (right) side of the active diff editor. */
export async function focusModifiedEditor(page) {
  const box = await page.locator('.monaco-diff-editor .editor.modified').first().boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + 40);
}

export async function statusBarText(page) {
  return (await page.locator('.statusbar').innerText().catch(() => '')) ?? '';
}
