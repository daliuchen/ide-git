<p align="center"><img src="images/icon-256.png" width="128" alt="Git Log Plus"></p>

<h1 align="center">Git Log Plus</h1>

<p align="center">在 Cursor / VS Code 里用上 IDE 级的 Git：真正的 Commit 窗口、能看清分支差别的 Log、可编辑的 Diff。</p>

<p align="center">
  <a href="https://open-vsx.org/extension/daliuchen/git-log-plus"><img src="https://img.shields.io/open-vsx/v/daliuchen/git-log-plus?label=Open%20VSX" alt="Open VSX"></a>
  &nbsp;简体中文 | <a href="README.en.md">English</a>
</p>

![Commit 窗口](images/c1-commit-window.jpg)

## 它解决什么问题

编辑器自带的「源代码管理」只适合 `git add` + `git commit`。日常开发里更常见的是下面这些需求，它做不到或者很别扭：

- **只提交一部分改动**：一个文件里改了三处，只想提交其中一处，甚至某几行；而且不想碰暂存区。
- **看 Diff 时能直接改代码**：Diff 右侧就是真实文件，跳转定义、重命名、报错提示照常可用。
- **看清楚两个分支差在哪**：另一个分支上哪些提交我已经有了、哪些已经 cherry-pick 过、哪些还没有。
- **常用 Git 操作不用切终端**：rebase、改提交信息、撤销提交、cherry-pick、推送都在菜单和对话框里完成，中途卡住也能在界面里继续或放弃。

Git Log Plus 基于 [ascenx/vscode-git-log](https://github.com/ascenx/vscode-git-log)（MIT）改造，原版的提交图谱、文件历史、行历史、Blame 等功能全部保留。

## 安装

**从扩展市场安装**：在 Cursor（或 VS Code、VSCodium）的扩展面板搜索 **Git Log Plus**，安装 `daliuchen.git-log-plus`。

**用安装包安装**：从 [GitHub Releases](https://github.com/daliuchen/git-log-plus/releases) 下载 `.vsix`，执行命令 *Extensions: Install from VSIX…*，或者：

```bash
cursor --install-extension git-log-plus-0.3.0.vsix   # VS Code 用 code --install-extension
```

> 如果装过原版 **Git Log**（`ascenx.git-log`），请先卸载：两者注册了同样的视图和命令。

要求 VS Code 1.85 及以上（当前各版本 Cursor 都满足）、Git 2.27 及以上。安装后执行一次 *Developer: Reload Window*。

## 五分钟上手

### 1. 打开 Commit 窗口

- **Cursor**：活动栏横在侧边栏顶部。看不到 Commit 图标时，点图标那一排最右边的 **⌄**，选 **Commit**。
- **VS Code**：点左侧活动栏的 **Commit** 图标。
- **任何地方**：命令面板 → `Git Log: Commit…`。
- **快捷键**：推荐把 ⌘9 绑定到它，见下文[快捷键](#快捷键)。

### 2. 提交

1. 勾选要提交的文件或目录。已跟踪文件的改动默认都勾上，未跟踪的新文件默认不勾。
2. 双击文件（或 `⌘D`）看 Diff。右侧就是真实文件，发现问题直接改。
3. 写好提交信息，`⌘Enter` 提交；`⌘⌥Enter` 是 **Commit and Push…**。

提交的是**勾选内容在工作区里的样子**，和暂存区无关（等同于 `git commit --only`）。

### 3. 只提交一部分

展开修改过的文件，每个改动块都有自己的勾选框；再展开改动块，可以逐行勾选。没勾的块和行留在本地，不会被提交。

![按块、按行勾选](images/n3-lines-and-options.jpg)

### 4. 看历史、比分支

底部面板的 **Git Log** 标签（`Git Log: Open Log`）。点左侧的分支查看它的提交；提交、文件、分支上右键有各种操作。

![查看另一个分支](images/log-branch-marks.jpg)

查看别的分支时，每个提交都会标出当前分支有没有它：**加粗**的是当前分支还没有的；**变灰**的是当前分支已经有的；**变灰并标 picked** 的是已经 cherry-pick 过来的（提交号不同，但改动内容一样）。

## 常见操作

| 我想… | 怎么做 |
| --- | --- |
| 提交几个文件 | Commit 窗口里勾上 → 写信息 → `⌘Enter` |
| 只提交文件里的某几块、某几行 | Commit 窗口里展开文件（再展开改动块），只勾需要的 |
| 只提交光标处这一处改动 | 编辑器右键 → *Git Log → Commit This Change…* |
| 修改上一个提交 | 勾 **Amend**（自动带出上次的提交信息）再提交；或编辑器右键 → *Git Log → Amend This Change into Last Commit* |
| 撤销上一个提交、保留改动 | Log 里右键该提交 → **Undo Commit**，提交信息会回到 Commit 窗口 |
| 改某个旧提交的信息 | Log 里右键该提交 → **Edit Commit Message…**，不会动工作区 |
| squash、调整顺序、删除提交 | Log 里右键要改的最早那个提交 → **Interactively Rebase from Here…** |
| 把我的分支 rebase 到 master | 先点工具栏的 Fetch，再在左侧分支列表右键 `origin/master` → **Rebase Current onto**；或者右键 → **Pull into Current Using Rebase**，一步完成 fetch + rebase |
| 看 master 有、我没有的提交（或反过来） | 左侧分支列表右键该分支 → **Compare with Current**；或在 **Branch** 筛选里把鼠标移到分支上，点 **←**（它有我没有）或 **→**（我有它没有）。筛选按钮上的 **⇄** 切换方向。已经 cherry-pick 过的提交不会再出现 |
| 看两个分支的文件差异 | 分支右键 → **Show Diff with Current** |
| 把别的分支的某个提交拿过来 | 查看那个分支 → 右键提交 → **Cherry-pick**。改动已经存在时会直接提示「已应用」，不会卡住 |
| 只拿某个提交里的几个文件 | 选中提交 → 在 Changed Files 里右键文件 → **Cherry-Pick Selected Changes** / **Get from Revision** |
| 解决 rebase / cherry-pick / merge 冲突 | 冲突文件在 Commit 窗口单独成组：*Merge…*、*Accept Yours*、*Accept Theirs*、*Mark as Resolved*；然后点 Commit 窗口或 Log 顶部提示条的 **Continue**（或 **Skip** / **Abort**） |
| 推送 | 工具栏 **Push…** 或 Commit 窗口的 **Commit and Push…**。仓库还没有远程时会让你先定义一个；被拒绝时可以选 **Rebase and Push** / **Merge and Push**；rebase 过的分支要勾 *Force push (with lease)* |
| 拉取 | 工具栏 **Pull**；只想更新远程分支信息、不动本地分支就点 **Fetch** |
| 把改动先收起来 | 文件右键 → **Shelve Changes…**，只收选中的文件；在 Log 工具栏的 Stashes 里取回 |
| 丢弃本地改动 | 右键 → **Rollback…**（`⌘⌥Z`），新增的文件可以顺便删掉 |
| 从只读的历史版本跳到真实文件 | 按 **F4**（或 Diff 工具栏上的按钮） |
| 看每行是谁改的 | 编辑器右键 → *Git Log → Annotate with Git Blame* |
| 切换、新建、删除分支 | `Git Log: Branches…` |

## 功能详解

### Commit 窗口

- 改动按**目录树**显示，单个子目录的链会合并（例如 `src/commit`），也可以切换成平铺；多个仓库时按仓库分组。
- 分三组：**Changes**（已跟踪文件的改动）、**Merge Conflicts**、**Unversioned Files**（可隐藏）。
- 分组、目录、文件、改动块、行都有**三态勾选框**。
- 提交信息带**历史记录**，草稿按工作区保存；支持 **Amend**、**Sign-off**。
- 齿轮里是**提交选项**：指定 Author、是否运行 Git hooks（不勾就是 `--no-verify`）。
- 文件右键：Show Diff（`⌘D`）、Jump to Source（F4）、Commit File…、Rollback…（`⌘⌥Z`）、Shelve Changes…、Add to VCS、Add to .gitignore、Delete、Show History、Copy Path；冲突文件还有 Merge…、Accept Yours、Accept Theirs、Mark as Resolved。
- rebase、cherry-pick、revert 进行中时，顶部提示条会说明当前状态和下一步，并带 **Continue / Skip / Abort**；merge 时带 Abort。

### 能编辑的 Diff

- Commit 窗口里打开的 Diff 是 HEAD ↔ **真实文件**：右侧可以直接编辑，跳转定义、重命名、报错提示都能用。
- Log 里打开的 Diff，只要该文件在提交里的版本和工作区一致，右侧也用真实文件。
- 任何只读的历史版本都可以 **Jump to Source**（F4），打开本地文件并定位到对应行。

![可编辑的 Diff](images/c5-diff-lsp.jpg)

### Log

- **工具栏**：刷新、Fetch、Pull、Push…、Stashes。
- **筛选**：文本或 hash、Branch、User、Date、Paths。每个筛选按钮直接显示当前的值（例如 `Branch: feature/x`），点 × 清除。
- **Branch 筛选**：可以搜索，按本地 / 远程 / 标签分组；点分支名只看这一个分支，勾选框可以同时选多个；鼠标移到分支上出现 **← / →**，用来和当前分支对比。
- **分支对比**：只列出一边有、另一边没有的提交，已经 cherry-pick 过的会排除；查看单个其他分支时，当前分支已有的提交变灰，已摘过的标 picked。
- **提交右键**：Edit Commit Message…、Fixup… / Squash Into…（在 Commit 窗口预填 `fixup!` / `squash!`）、Undo Commit、Interactively Rebase from Here…、Push All up to Here…、Cherry-pick、Revert、Create Patch…、Compare with Local。
- **文件右键**：Compare with Local、Jump to Source、Show History for File、Revert / Cherry-Pick Selected Changes、Get from Revision、Drop Selected Changes…（把这个文件的改动从该提交里去掉）、Create Patch…。
- **分支右键**：Checkout、Checkout and Rebase onto Current、Rebase Current onto、Merge into Current、Pull into Current Using Rebase/Merge、Update（不切换分支直接快进）、Compare with Current、Show Diff with Current、Show Diff with Working Tree。

![Log 右键菜单](images/c15-log-menu.jpg)

### 对话框

- **交互式 Rebase**：pick / reword / edit / squash / fixup / drop，`⌥↑/↓` 调整顺序，快捷键 P/R/E/S/F/D；squash 组的提交信息合并后可编辑；本地改动自动 stash。
- **Push**：列出待推送的提交和文件；可以改远程和目标分支（不存在时标 New）；Set upstream、Push tags、Force push with lease；仓库没有远程时先定义远程；被拒绝时可选 Rebase and Push / Merge and Push。
- **Branches 弹窗**（`Git Log: Branches…`）：Checkout、New Branch from…、Checkout and Rebase、Compare with Current、Rebase、Merge、Update、Push、Rename、Delete、Pull Using Rebase/Merge。

![交互式 Rebase](images/c18-rebase-dialog.jpg)

![Push 对话框](images/c13-push-dialog.jpg)

![Branches 弹窗](images/x-branch-actions.jpg)

### Annotate with Git Blame

编辑器（或行号区）右键 → *Git Log → Annotate with Git Blame*：每行旁边显示作者和日期，按新旧着色，未提交的行也会标出；鼠标悬停可以看提交信息、Show Diff、Copy Hash。

![Annotate](images/c14-annotate.jpg)

## 命令

| 命令 | 作用 |
| --- | --- |
| `Git Log: Commit…` | 打开 Commit 窗口 |
| `Git Log: Open Log` | 打开 Git Log 标签 |
| `Git Log: Branches…` | 分支弹窗 |
| `Git Log: Push…` | Push 对话框 |
| `Git Log: Update Project…` | 以 rebase 或 merge 方式 pull，自动 stash 本地改动 |

## 快捷键

| 按键 | 位置 | 作用 |
| --- | --- | --- |
| `⌘Enter` | 提交信息框 | 提交 |
| `⌘⌥Enter` | 提交信息框 | Commit and Push… |
| `⌘D` | Commit 窗口 | Show Diff |
| `⌘⌥Z` | Commit 窗口 | Rollback… |
| `F4` | 只读 Diff / Commit 窗口 | Jump to Source |
| `P R E S F D`、`⌥↑/↓` | Rebase 对话框 | 改动作、调整顺序 |

推荐自己加上 ⌘9 打开 Commit 窗口（再按一次收起侧边栏）。打开命令 *Preferences: Open Keyboard Shortcuts (JSON)*，加入：

```json
[
  { "key": "cmd+9", "command": "gitLogWorkbench.commit.open", "when": "activeViewlet != 'workbench.view.extension.gitLogCommit'" },
  { "key": "cmd+9", "command": "workbench.action.toggleSidebarVisibility", "when": "activeViewlet == 'workbench.view.extension.gitLogCommit'" }
]
```

用户快捷键的优先级高于其他扩展，所以就算装了把 ⌘9 绑到「源代码管理」的快捷键扩展，这两条也会生效。Windows / Linux 把 `cmd` 换成 `alt`。

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `gitLogWorkbench.git.path` | `"git"` | Git 可执行文件路径 |
| `gitLogWorkbench.currentLineBlame.enabled` | `true` | 在光标所在行后显示 blame |
| `gitLogWorkbench.lineHistory.contextLines` | `3` | 行历史里改动上下各显示几行 |
| `gitLogWorkbench.repositories.scanDepth` | `2` | 查找嵌套仓库的目录深度 |
| `gitLogWorkbench.log.pageSize` | `500` | Log 每页加载的提交数 |

## 实现方式

- 所有操作都通过 Git 命令行完成：不经过 shell，不保存任何凭据，认证交给 Git 自己（credential helper / SSH agent）。
- 部分提交用一个临时索引（`GIT_INDEX_FILE`）：从 HEAD 建出来，只应用选中的块和行，用它提交，再把真实索引里这些路径同步过来。暂存区不会被当作提交内容。
- 交互式 rebase 用生成好的 todo 列表执行 `git rebase -i`；reword 和 squash 的信息通过 `git commit --amend` 步骤写入。
- 分支对比用 `git log --cherry-pick --left-only/--right-only HEAD...分支`；判断「已经摘过」用 `git rev-list --cherry-mark`（按改动内容比较）。

## 本地开发

```bash
asdf install        # 按 .tool-versions 安装 Node
pnpm install
pnpm run typecheck
pnpm run lint
pnpm run test:unit
pnpm run test:integration   # 下载 VS Code 1.85.2 跑集成测试
pnpm run package            # 生成 git-log-plus-<版本>.vsix
```

开发规范（提 PR、做需求前写技术方案、代码风格）见 [AGENTS.md](AGENTS.md)。

## 关于开发方式

本项目的代码主要由 AI（[Claude Code](https://claude.com/claude-code)）编写。需求、交互设计的取舍和日常试用由作者负责；每次改动都通过了类型检查、lint、单元测试和 VS Code 集成测试，主要流程在真实编辑器里实际操作验证过。遇到问题欢迎提 issue。

## 许可证

[MIT](LICENSE)，与原版相同。
