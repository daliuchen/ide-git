import { basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ChangedFile, ChangedFileStatus } from '../shared/models';
import {
  buildDiffSides,
  buildRevisionFileTarget,
  encodeRevisionQuery,
  type DiffSide,
} from './diffModel';
import { REVISION_SCHEME } from './RevisionContentProvider';
import { createComparisonHtml } from './createComparisonHtml';

export interface OpenDiffRequest {
  hash: string;
  parent?: string;
  path: string;
  oldPath?: string;
  status: ChangedFileStatus;
  revealLine?: number;
  /**
   * The working-tree file whose content matches the right side. When present it replaces the
   * read-only revision document, so the diff is editable and language features work.
   */
  workingFileUri?: vscode.Uri;
  onWillOpen?: (originalUri: vscode.Uri, modifiedUri: vscode.Uri) => void;
}

export interface OpenLocalChangeRequest {
  /** HEAD commit hash, or undefined for a repository without commits. */
  head?: string;
  path: string;
  oldPath?: string;
  status: 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';
  preview: boolean;
  preserveFocus?: boolean;
}

export interface OpenWorkingFileComparisonRequest {
  revision: string;
  revisionLabel: string;
  path: string;
  workingFileUri: vscode.Uri;
  revisionExists: boolean;
  forceInline?: boolean;
  isCurrent?: () => boolean;
  onWillOpen?: (originalUri: vscode.Uri) => void;
}

function sideUri(repositoryId: string, side: DiffSide): vscode.Uri {
  const query = encodeRevisionQuery({
    repositoryId,
    revision: side.kind === 'revision' ? side.revision : '',
    path: side.path,
    empty: side.kind === 'empty',
  });
  return vscode.Uri.from({
    scheme: REVISION_SCHEME,
    path: `/${side.path}`,
    query,
  });
}

function comparisonResources(
  repositoryId: string,
  request: { hash: string; parent: string },
  files: readonly ChangedFile[],
): readonly (readonly [vscode.Uri, vscode.Uri, vscode.Uri])[] {
  return files.flatMap((file) => {
    if (file.binary) return [];
    const sides = buildDiffSides({
      hash: request.hash,
      parent: request.parent,
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      status: file.status,
    });
    const original = sideUri(repositoryId, sides.left);
    const modified = sideUri(repositoryId, sides.right);
    return [[modified, original, modified] as const];
  });
}

export interface DiffManagerOptions {
  /**
   * Returns the working-tree file when it is identical to `path` at `revision`. Diffs then show
   * the real file on that side, so it can be edited and language features (LSP) work.
   */
  findIdenticalWorkingFile?(
    repositoryId: string,
    revision: string,
    path: string,
  ): Promise<vscode.Uri | undefined>;
}

export class DiffManager {
  private comparisonPanel: vscode.WebviewPanel | undefined;

  constructor(private readonly options: DiffManagerOptions = {}) {}

  private async workingFileFor(
    repositoryId: string,
    side: DiffSide,
  ): Promise<vscode.Uri | undefined> {
    if (side.kind !== 'revision' || !this.options.findIdenticalWorkingFile) return undefined;
    try {
      return await this.options.findIdenticalWorkingFile(repositoryId, side.revision, side.path);
    } catch {
      return undefined;
    }
  }

  async open(
    repositoryId: string,
    request: OpenDiffRequest,
    viewColumn?: vscode.ViewColumn,
  ): Promise<void> {
    const sides = buildDiffSides(request);
    const title = `${basename(request.path)} (${request.parent?.slice(0, 8) ?? 'empty'} ↔ ${request.hash.slice(0, 8)})`;
    const left = sideUri(repositoryId, sides.left);
    const workingFile =
      sides.right.kind === 'revision'
        ? (request.workingFileUri ?? (await this.workingFileFor(repositoryId, sides.right)))
        : undefined;
    const right = workingFile ?? sideUri(repositoryId, sides.right);
    request.onWillOpen?.(left, right);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      title,
      { preview: true, ...(viewColumn === undefined ? {} : { viewColumn }) },
    );
    if (request.revealLine !== undefined && request.revealLine > 0) {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const line = Math.min(request.revealLine - 1, Math.max(0, editor.document.lineCount - 1));
        editor.revealRange(
          new vscode.Range(line, 0, line, 0),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
      }
    }
  }

  /** Opens HEAD ↔ working tree with the real file on the right, like an IDE commit-dialog diff. */
  async openLocalChange(
    repositoryId: string,
    repositoryRoot: vscode.Uri,
    request: OpenLocalChangeRequest,
  ): Promise<void> {
    const workingUri = vscode.Uri.joinPath(repositoryRoot, request.path);
    const basePath = request.oldPath ?? request.path;
    const left =
      request.head && request.status !== 'A' && request.status !== '?' && request.status !== 'C'
        ? sideUri(repositoryId, { kind: 'revision', revision: request.head, path: basePath })
        : sideUri(repositoryId, { kind: 'empty', path: basePath });
    const right =
      request.status === 'D' ? sideUri(repositoryId, { kind: 'empty', path: request.path }) : workingUri;
    const label = request.status === 'R' && request.oldPath
      ? `${basename(request.oldPath)} → ${basename(request.path)}`
      : basename(request.path);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${label} (HEAD ↔ Local)`,
      { preview: request.preview, preserveFocus: request.preserveFocus ?? false },
    );
  }

  /** Lists every file that differs between `revision` and the working tree, like "Compare with Local". */
  async openLocalComparison(
    repositoryId: string,
    repositoryRoot: vscode.Uri,
    revision: string,
    files: readonly ChangedFile[],
  ): Promise<void> {
    if (!files.length) {
      void vscode.window.showInformationMessage(`The working tree matches ${revision.slice(0, 8)}.`);
      return;
    }
    this.comparisonPanel?.dispose();
    const title = `Git Changes (${revision.slice(0, 8)} ↔ Local)`;
    const panel = vscode.window.createWebviewPanel('gitLog.compare', title, vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.comparisonPanel = panel;
    panel.webview.html = createComparisonHtml({
      title,
      files,
      nonce: randomBytes(18).toString('base64url'),
    });
    const sides = (file: ChangedFile): [vscode.Uri, vscode.Uri] => {
      const basePath = file.oldPath ?? file.path;
      const original =
        file.status === 'A'
          ? sideUri(repositoryId, { kind: 'empty', path: basePath })
          : sideUri(repositoryId, { kind: 'revision', revision, path: basePath });
      const modified =
        file.status === 'D'
          ? sideUri(repositoryId, { kind: 'empty', path: file.path })
          : vscode.Uri.joinPath(repositoryRoot, file.path);
      return [original, modified];
    };
    const messageSubscription = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (typeof message !== 'object' || message === null || !('type' in message)) return;
      if (message.type === 'openAllComparisonFiles') {
        const resources = files
          .filter((file) => !file.binary)
          .map((file) => {
            const [original, modified] = sides(file);
            return [modified, original, modified] as const;
          });
        if (!resources.length) return;
        await vscode.commands.executeCommand(
          vscode.window.tabGroups.all.length < 2
            ? 'workbench.action.newGroupRight'
            : 'workbench.action.focusSecondEditorGroup',
        );
        await vscode.commands.executeCommand('vscode.changes', title, resources);
        return;
      }
      if (message.type !== 'openComparisonFile' || !('index' in message) || !Number.isInteger(message.index)) {
        return;
      }
      const file = files[message.index as number];
      if (!file || file.binary) return;
      const [original, modified] = sides(file);
      await vscode.commands.executeCommand(
        'vscode.diff',
        original,
        modified,
        `${basename(file.path)} (${revision.slice(0, 8)} ↔ Local)`,
        { preview: true, viewColumn: vscode.ViewColumn.Two },
      );
    });
    panel.onDidDispose(() => {
      messageSubscription.dispose();
      if (this.comparisonPanel === panel) this.comparisonPanel = undefined;
    });
  }

  async openFile(
    repositoryId: string,
    repositoryRoot: vscode.Uri,
    request: OpenDiffRequest & { mode: 'revision' | 'current' },
  ): Promise<void> {
    if (request.mode === 'current') {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(repositoryRoot, request.path), {
        preview: true,
      });
      return;
    }
    const target = buildRevisionFileTarget(request);
    if (!target) throw new Error('This file does not exist at the selected revision.');
    await vscode.commands.executeCommand(
      'vscode.open',
      sideUri(repositoryId, { kind: 'revision', revision: target.revision, path: target.path }),
      { preview: true },
    );
  }

  async openWorkingFileAgainstRevision(
    repositoryId: string,
    request: OpenWorkingFileComparisonRequest,
  ): Promise<void> {
    const left = request.revisionExists
      ? sideUri(repositoryId, {
          kind: 'revision',
          revision: request.revision,
          path: request.path,
        })
      : sideUri(repositoryId, { kind: 'empty', path: request.path });
    request.onWillOpen?.(left);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      request.workingFileUri,
      `Compare: ${basename(request.path)} (${request.revisionLabel} ↔ Working Tree)`,
      { preview: true },
    );
    if (request.isCurrent && !request.isCurrent()) return;
    if (
      request.forceInline === true &&
      vscode.workspace
        .getConfiguration('diffEditor', request.workingFileUri)
        .get<boolean>('renderSideBySide', true)
    ) {
      await vscode.commands.executeCommand(
        'toggle.diff.renderSideBySide',
        request.workingFileUri,
      );
    }
  }

  async openCommit(
    repositoryId: string,
    request: { hash: string; parent: string },
    files: readonly ChangedFile[],
  ): Promise<void> {
    if (!files.length) throw new Error('This comparison has no changed files.');
    this.comparisonPanel?.dispose();
    const title = `Git Changes (${request.parent.slice(0, 8)} ↔ ${request.hash.slice(0, 8)})`;
    const panel = vscode.window.createWebviewPanel('gitLog.compare', title, vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.comparisonPanel = panel;
    panel.webview.html = createComparisonHtml({
      title,
      files,
      nonce: randomBytes(18).toString('base64url'),
    });
    let allChangesTab: vscode.Tab | undefined;
    let waitingForAllChangesTab = false;
    const tabChangeSubscription = vscode.window.tabGroups.onDidChangeTabs((event) => {
      if (waitingForAllChangesTab) {
        const matchingTab = [...event.opened, ...event.changed].find((tab) => tab.label === title);
        if (matchingTab) {
          allChangesTab = matchingTab;
          waitingForAllChangesTab = false;
        }
      }
      if (!allChangesTab || !event.closed.includes(allChangesTab)) return;
      allChangesTab = undefined;
      void panel.webview.postMessage({ type: 'comparisonAllClosed' });
    });
    const messageSubscription = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (
        typeof message !== 'object' ||
        message === null ||
        !('type' in message)
      ) {
        return;
      }
      if (message.type === 'openAllComparisonFiles') {
        const resources = await Promise.all(
          comparisonResources(repositoryId, request, files).map(async ([resource, original, modified]) => {
            const query = new URLSearchParams(modified.query);
            const revision = query.get('revision');
            const path = query.get('path');
            const working =
              revision && path && query.get('empty') !== '1'
                ? await this.workingFileFor(repositoryId, { kind: 'revision', revision, path })
                : undefined;
            return working ? ([working, original, working] as const) : ([resource, original, modified] as const);
          }),
        );
        if (!resources.length) return;
        await vscode.commands.executeCommand(
          vscode.window.tabGroups.all.length < 2
            ? 'workbench.action.newGroupRight'
            : 'workbench.action.focusSecondEditorGroup',
        );
        waitingForAllChangesTab = true;
        await vscode.commands.executeCommand('vscode.changes', title, resources);
        return;
      }
      if (
        message.type !== 'openComparisonFile' ||
        !('index' in message) ||
        !Number.isInteger(message.index)
      ) {
        return;
      }
      const file = files[message.index as number];
      if (!file || file.binary) return;
      await this.open(
        repositoryId,
        {
          hash: request.hash,
          parent: request.parent,
          path: file.path,
          ...(file.oldPath ? { oldPath: file.oldPath } : {}),
          status: file.status,
        },
        vscode.ViewColumn.Two,
      );
    });
    panel.onDidDispose(() => {
      tabChangeSubscription.dispose();
      messageSubscription.dispose();
      if (this.comparisonPanel === panel) this.comparisonPanel = undefined;
    });
  }
}
