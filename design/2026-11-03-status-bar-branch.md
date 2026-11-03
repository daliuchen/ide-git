# 状态栏显示当前分支

- 日期：2026-11-03
- 状态：已实现
- 相关：对照 IDE 的 Git 功能后挑出的三项之一

## 背景与目标

IDE 右下角一直显示当前分支和与上游的差距（`main ↑2 ↓3`），点一下就是分支弹窗。现在 IDE Git 要打开 Branches 弹窗只能走命令面板或 Log 面板；领先/落后要去 Log 里看。

目标：状态栏右侧显示 `$(git-branch) 分支名 ↑领先 ↓落后`，点击打开 IDE Git 的 Branches 弹窗。

**不做的事**：
- 不在状态栏里放 fetch / sync 按钮（编辑器自带的 Git 状态栏已有）。
- 不显示未提交文件数。

## 参照行为

IDE：状态栏（新界面在标题栏）显示仓库与分支；有上游时显示领先/落后的箭头和数字；detached HEAD 显示提交短 hash；rebase 中显示「Rebasing main」；点击打开分支弹窗。
照搬以上；有意不同：放在状态栏右侧（左侧已有编辑器自带的分支项，避免挤在一起），可在设置里关掉。

## 方案

- 新文件 `src/statusBar/BranchStatusBar.ts`：一个 `StatusBarItem`（右侧，`name: 'IDE Git Branch'`）。
- **显示哪个仓库**：当前编辑器文件所在的仓库（复用 0.5.0 的 `resolveActiveEditorFile`）；没有活动文件时用工作区里第一个仓库；多仓库时文字前加仓库名（`repo: main ↑2`）。
- **读状态**：`git status --porcelain=v2 --branch --untracked-files=no` 只读头部几行：
  - `# branch.head main`（detached 时是 `(detached)`，再用 `# branch.oid` 取短 hash）
  - `# branch.upstream origin/main`、`# branch.ab +2 -3`（没有上游就没有这两行）
  - 进行中的操作复用已有的 `inspectRepository` 结果（`operationState`）。
- **文字**：
  - `$(git-branch) main ↑2 ↓3`；为 0 的箭头不显示；没有上游时只显示分支名。
  - detached：`$(git-commit) a1b2c3d4`
  - 进行中：`$(git-branch) main (rebasing)`
- **提示**：`仓库名 · 分支 · 上游 origin/main · 领先 2 / 落后 3 · Click to open Branches`。
- **点击**：执行 `gitLogWorkbench.branches`，参数为仓库根路径。
- **何时刷新**：活动编辑器切换；编辑器自带 Git 扩展的仓库状态变化（`extension.ts` 里已订阅的 `repository.state.onDidChange`）；窗口重新获得焦点；IDE Git 自己的操作完成后。合并 300ms 内的多次触发，只跑一次命令。
- **设置**：`gitLogWorkbench.statusBar.branch.enabled`，默认 `true`。
- 不新增 webview 协议消息。

### Git 命令

- `git status --porcelain=v2 --branch --untracked-files=no`（只读，最低 Git 2.11 支持 `--porcelain=v2`）。

## 边界情况

- 没有提交的新仓库：`branch.oid (initial)`，显示分支名，不显示箭头。
- 没有上游：只显示分支名。
- detached HEAD / rebase、merge、cherry-pick 进行中：见上。
- 多仓库：显示当前文件所在仓库，并带仓库名。
- 工作区没有仓库：隐藏。
- 超大仓库：`--untracked-files=no` 避免扫未跟踪文件；只读头部几行。

## 风险

只读，不改仓库。最坏情况是数字过时（没有收到变化通知），窗口重新获得焦点时会更新。

## 测试计划

- 单测：`git status --porcelain=v2 --branch` 头部解析（普通、无上游、detached、初始提交）；文字和提示的拼接（含多仓库、进行中）。
- 真实临时仓库：建 bare 远程 + 克隆，提交 2 个、远程多 1 个，读到 `↑2 ↓1`。
- 手动（Cursor）：切换不同仓库的文件，状态栏跟着变；在 Log 里 checkout 别的分支，状态栏更新；点击打开 Branches 弹窗。

## 实际实现与偏差

- 用户确认放在**右侧**。
- 刷新依赖编辑器自带 Git 扩展的仓库变化通知。原来只在开启行尾 blame 时才订阅，现在无条件订阅（状态栏也要用）。
- `git status` 加了 `--ignore-submodules`，避免大仓库里扫子模块。
- 多仓库时的「仓库数」取已知仓库数（Log / Commit 窗口发现的），还没发现时按 1 个算，不显示仓库名前缀。
- 验证：单测（解析、文字、提示）+ 真实临时仓库（bare 远程 + 两个克隆，读到 ↑2 ↓1）；VS Code 1.144 e2e 3 项：显示 `main ↑2 ↓1`、在终端 checkout 后变为 `feature`、点击打开 Branches。
