import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import type { GitRunner } from '../git/GitRunner';
import { inspectRepository } from '../repositories/discoverRepositories';
import { parseBranchStatus, presentBranchStatus } from './branchStatus';

const REFRESH_DELAY_MS = 300;

/** IDE-style branch widget: `main ↑2 ↓3` for the repository of the active file; opens Branches. */
export class BranchStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    'gitLogWorkbench.branch',
    vscode.StatusBarAlignment.Right,
    100,
  );
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private root: string | undefined;

  constructor(
    private readonly runner: GitRunner,
    /** A path inside the repository to show (the active file's, or a workspace folder). */
    private readonly currentPath: () => { path: string; repositoryCount: number } | undefined,
  ) {
    this.item.name = 'IDE Git Branch';
    this.disposables.push(
      this.item,
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) this.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('gitLogWorkbench.statusBar.branch.enabled')) this.schedule();
      }),
    );
    this.schedule();
  }

  /** Call when repository state may have changed (checkout, commit, fetch …). */
  schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, REFRESH_DELAY_MS);
  }

  private async refresh(): Promise<void> {
    const generation = ++this.generation;
    if (!vscode.workspace.getConfiguration('gitLogWorkbench').get<boolean>('statusBar.branch.enabled', true)) {
      this.item.hide();
      return;
    }
    try {
      const target = this.currentPath();
      const repository = target ? await inspectRepository(target.path, this.runner) : undefined;
      if (generation !== this.generation) return;
      if (!target || !repository || repository.isBare) {
        this.item.hide();
        return;
      }
      const root = fileURLToPath(repository.rootUri);
      const result = await this.runner.run(
        ['status', '--porcelain=v2', '--branch', '--untracked-files=no', '--ignore-submodules'],
        { cwd: root, timeoutMs: 15_000 },
      );
      if (generation !== this.generation) return;
      const presentation = presentBranchStatus(parseBranchStatus(result.stdout.toString('utf8')), {
        repositoryName: repository.displayName,
        showRepositoryName: target.repositoryCount > 1,
        ...(repository.operationState ? { operationState: repository.operationState } : {}),
      });
      this.root = root;
      this.item.text = presentation.text;
      this.item.tooltip = presentation.tooltip;
      this.item.command = { title: 'Branches', command: 'gitLogWorkbench.branches', arguments: [this.root] };
      this.item.show();
    } catch {
      if (generation === this.generation) this.item.hide();
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}
