import type * as vscode from 'vscode';

const RETRY_DELAY_MS = 3_000;
const MAX_RETRIES = 3;

/**
 * Sets a webview's HTML and reloads it when its script never reports back. While the extension is
 * being installed or updated, the bundled scripts can be missing for a moment; a webview that
 * loaded then stays blank until the window is reloaded, so it is given a few more tries.
 */
export function loadWebview(webview: vscode.Webview, render: () => string): vscode.Disposable {
  let loaded = false;
  let retries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    timer = setTimeout(() => {
      timer = undefined;
      if (loaded || retries >= MAX_RETRIES) return;
      retries += 1;
      webview.html = render();
      schedule();
    }, RETRY_DELAY_MS);
  };
  // Any message means the script is running.
  const listener = webview.onDidReceiveMessage(() => {
    loaded = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  });
  webview.html = render();
  schedule();
  return {
    dispose() {
      if (timer) clearTimeout(timer);
      listener.dispose();
    },
  };
}
