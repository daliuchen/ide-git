<p align="center"><img src="images/icon-256.png" width="128" alt="IDE Git"></p>

<h1 align="center">IDE Git</h1>

<p align="center">把 IntelliJ 那套 Git 工具搬进 Cursor / VS Code：真正的 Commit 窗口、能看清分支差别的 Log、可编辑的 Diff。</p>

<p align="center">
  <a href="https://open-vsx.org/extension/EthanLiuChen/ide-git"><img src="https://img.shields.io/open-vsx/v/EthanLiuChen/ide-git?label=Open%20VSX" alt="Open VSX"></a>
  &nbsp;<a href="README.md">English</a> | 简体中文
</p>

![Commit 窗口](images/c1-commit-window.jpg)

## 它解决什么问题

- **只提交一部分改动**：按文件、按改动块、甚至按行勾选，不碰暂存区。
- **看 Diff 时直接改代码**：右侧就是真实文件，跳转定义、重命名、报错提示照常可用。
- **看清两个分支差在哪**：哪些提交我已经有、哪些已经 cherry-pick 过、哪些还没有。
- **不用切终端**：rebase、改提交信息、撤销提交、cherry-pick、推送都在界面里完成，中途卡住也能继续或放弃。

基于 [ascenx/vscode-git-log](https://github.com/ascenx/vscode-git-log)（MIT）改造，原版的提交图谱、文件历史、Blame 等功能都保留。

## 安装

在 Cursor 的扩展面板搜索 **IDE Git** 安装；或者从 [Releases](https://github.com/daliuchen/ide-git/releases) 下载 `.vsix`，执行 *Extensions: Install from VSIX…*。

如果装过原版 **Git Log**（`ascenx.git-log`），先卸载它。

## 上手

1. **打开 Commit 窗口**：命令面板 `IDE Git: Commit…`。Cursor 里也可以点侧边栏顶部图标那一排最右边的 **⌄**，选 **Commit**。
2. **提交**：勾选文件，双击看 Diff，写信息后 `⌘Enter`；`⌘⌥Enter` 是提交并推送。
3. **只提交一部分**：展开文件勾选改动块，再展开改动块可以逐行勾选。
4. **看历史**：底部面板的 **Git Log** 标签。点左侧的分支查看它的提交：**加粗**的是当前分支还没有的，**变灰**的是已经有的，标 **picked** 的是已经 cherry-pick 过的。

## 常见操作

| 我想… | 怎么做 |
| --- | --- |
| 修改上一个提交 | 勾 **Amend** 再提交 |
| 撤销上一个提交、保留改动 | Log 里右键提交 → **Undo Commit** |
| 改旧提交的信息、squash、调整顺序 | Log 里右键 → **Edit Commit Message…** / **Interactively Rebase from Here…** |
| rebase 到 master | 工具栏 **Fetch**，然后右键 `origin/master` → **Rebase Current onto** |
| 看 master 有、我没有的提交 | 右键分支 → **Compare with Current**；或在 **Branch** 筛选里点分支旁的 **←** / **→** |
| 带选项地合并 | 右键分支 → **Merge…**：一定生成合并提交、只允许快进、压成一个提交，或者合并后先不提交 |
| 把别的分支的提交拿过来 | 查看那个分支 → 右键提交 → **Cherry-pick** |
| 解决冲突 | Commit 窗口里处理冲突文件，然后点提示条上的 **Continue**（或 **Skip** / **Abort**） |
| 看当前分支领先/落后多少 | 状态栏右下角显示 `main ↑2 ↓1`，点它打开 Branches |
| 带着未提交的改动切分支 | 正常 checkout；被本地改动挡住时选 **Smart Checkout**，改动会被带过去 |
| 推送、拉取 | Log 工具栏的 **Push…** / **Pull** |
| 先把改动收起来 | 文件右键 → **Shelve Changes…**；在 Log 工具栏的 **Stashes** 里能看到，带所在分支和时间 |
| 逐个文件看一个提交的改动 | 在 **Changed Files** 里双击文件，然后按 **F7** / **Shift+F7**：到最后一处改动后再按一次就打开下一个文件（Commit 窗口里同样可用）；列表会跟着选中当前显示的文件 |
| 看每行是谁改的 | 编辑器右键 → *IDE Git → Annotate with Git Blame*；鼠标悬停某行 → **Show in Git Log** 跳到对应提交，或 **Annotate Previous Revision** 看这一行之前是谁写的 |

## 截图

![按块、按行提交](images/n3-lines-and-options.jpg)

![查看其他分支](images/log-branch-marks.jpg)

![可编辑的 Diff](images/c5-diff-lsp.jpg)

![交互式 Rebase](images/c18-rebase-dialog.jpg)

![Push 对话框](images/c13-push-dialog.jpg)

## 用 ⌘9 打开 Commit 窗口

在 *Preferences: Open Keyboard Shortcuts (JSON)* 里加入（再按一次收起侧边栏）：

```json
[
  { "key": "cmd+9", "command": "gitLogWorkbench.commit.open", "when": "activeViewlet != 'workbench.view.extension.gitLogCommit'" },
  { "key": "cmd+9", "command": "workbench.action.toggleSidebarVisibility", "when": "activeViewlet == 'workbench.view.extension.gitLogCommit'" }
]
```

## 装了其他快捷键插件时的 F7

如果别的扩展也绑定了 F7（比如 IDE 快捷键插件），可能会盖过 IDE Git 的绑定。第一次打开 Diff 时 IDE Git 会发现这种情况并提示，点 **Add Shortcuts** 就会把下面两条写进你的快捷键文件（会先留备份）。也可以自己在 *Preferences: Open Keyboard Shortcuts (JSON)* 里加入这两条，它们只在 IDE Git 打开的 Diff 里生效：

```json
[
  { "key": "f7", "command": "gitLogWorkbench.diff.nextChange", "when": "gitLogWorkbench.diffNavigation && textCompareEditorVisible" },
  { "key": "shift+f7", "command": "gitLogWorkbench.diff.previousChange", "when": "gitLogWorkbench.diffNavigation && textCompareEditorVisible" }
]
```

## 开发

用 asdf 管 Node、pnpm 装依赖：`pnpm install && pnpm run test:unit && pnpm run package`。在真实 VS Code 里跑端到端测试：`pnpm run test:e2e`（见 [test/e2e](test/e2e/README.md)）。开发规范见 [AGENTS.md](AGENTS.md)。

## 关于开发方式

本项目的代码主要由 AI（[Claude Code](https://claude.com/claude-code)）编写。需求、交互设计的取舍和日常试用由作者负责；每次改动都通过了类型检查、lint、单元测试和 VS Code 集成测试，主要流程在真实编辑器里实际操作验证过。遇到问题欢迎提 issue。

## 许可证

[MIT](LICENSE)
