export interface WebviewHtmlOptions {
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  nonce: string;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function createWebviewHtml(options: WebviewHtmlOptions): string {
  const cspSource = escapeAttribute(options.cspSource);
  const scriptUri = escapeAttribute(options.scriptUri);
  const styleUri = escapeAttribute(options.styleUri);
  const nonce = escapeAttribute(options.nonce);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'nonce-${nonce}'; font-src ${cspSource}; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <style nonce="${nonce}">
      /* Replaced by the app once it renders; only shows up if the script never runs. */
      .webview-fallback {
        padding: 12px;
        color: var(--vscode-descriptionForeground);
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        opacity: 0;
        animation: webview-fallback-show 0s linear 8s forwards;
      }
      @keyframes webview-fallback-show {
        to {
          opacity: 1;
        }
      }
    </style>
    <title>IDE Git</title>
  </head>
  <body>
    <div id="root"><p class="webview-fallback">IDE Git did not load. Run “Developer: Reload Window” to try again.</p></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}
