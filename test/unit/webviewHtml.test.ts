import { describe, expect, it, vi } from 'vitest';

describe('createWebviewHtml', () => {
  it('creates a nonce-protected standalone workbench document', async () => {
    const htmlModule = await import('../../src/webview/createWebviewHtml').catch(() => undefined);

    expect(htmlModule, 'the webview HTML module must exist').toBeDefined();
    if (!htmlModule) return;

    const html = htmlModule.createWebviewHtml({
      cspSource: 'vscode-webview://test',
      scriptUri: 'vscode-webview://test/dist/webview.js',
      styleUri: 'vscode-webview://test/dist/webview.css',
      nonce: 'fixed-nonce',
    });

    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-fixed-nonce'");
    expect(html).toContain('nonce="fixed-nonce"');
    expect(html).toContain('id="root"');
    expect(html).toContain('dist/webview.js');
    expect(html).toContain('dist/webview.css');
    // Shown only when the script never renders the app.
    expect(html).toContain('class="webview-fallback"');
    expect(html).toContain("style-src vscode-webview://test 'nonce-fixed-nonce'");
  });

  it('reloads a webview whose script never reports back, and stops once it does', async () => {
    vi.useFakeTimers();
    try {
      const { loadWebview } = await import('../../src/webview/loadWebview');
      let listener: (() => void) | undefined;
      const webview = {
        html: '',
        onDidReceiveMessage(callback: () => void) {
          listener = callback;
          return { dispose() {} };
        },
      };
      let renders = 0;
      const loader = loadWebview(webview as never, () => `html ${String(++renders)}`);
      expect(webview.html).toBe('html 1');
      vi.advanceTimersByTime(3_000);
      expect(webview.html).toBe('html 2');
      listener?.();
      vi.advanceTimersByTime(30_000);
      expect(webview.html).toBe('html 2');
      loader.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
