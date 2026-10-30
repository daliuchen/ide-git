# Git Log Plus

[English](README.md) | [简体中文](README.zh-CN.md)

[![Open VSX Version](https://img.shields.io/open-vsx/v/daliuchen/git-log-plus?label=Open%20VSX)](https://open-vsx.org/extension/daliuchen/git-log-plus)

给 **Cursor** 和 **VS Code** 用的 IDE 级 Git 工作流：真正的 Commit 工具窗口（changelist、按块/按行提交）、提交图谱 Log、交互式 rebase、Push 对话框、Annotate，以及右侧可编辑、语言功能完整的 Diff。

基于 [ascenx/vscode-git-log](https://github.com/ascenx/vscode-git-log)（MIT）改造，原版 Git Log 的功能全部保留，见 [Git Log（原版功能）](#git-log原版功能)。

![Commit 工具窗口](images/c1-commit-window.jpg)

## 为什么做这个

编辑器自带的「源代码管理」做 `git add` + `git commit` 够用，但下面这些就做不到或很别扭：

- 只提交文件的**一部分**（某几个改动块、某几行），而且不碰暂存区。
- 用 **changelist** 把不相关的改动分开，各自提交。
- 看 Diff 时右侧就是**真实文件**，跳转定义、重命名、诊断照常能用；从 Diff 打开的不再是只读文件。
- rebase、改提交信息、squash、撤销提交、推送，都在菜单和对话框里完成，不用切终端。

## 安装

**从扩展市场装（Cursor / VS Code / VSCodium）**：打开扩展视图，搜索 **Git Log Plus**，安装 `daliuchen.git-log-plus`。

**用 `.vsix` 文件装**：从 [GitHub Releases](https://github.com/daliuchen/git-log-plus/releases) 下载（或自己构建，见[本地开发](#本地开发)），然后执行命令 *Extensions: Install from VSIX…*，或者：

```bash
cursor --install-extension git-log-plus-0.3.0.vsix   # VS Code 用 code --install-extension …
```

> 如果装过原版 **Git Log**（`ascenx.git-log`），先卸载它——两者注册了相同的视图和命令。

要求 VS Code 1.85+（当前的 Cursor 都满足）和 Git 2.27+。装好后执行一次 *Developer: Reload Window*。

## 快速上手

### 1. 打开 Commit 窗口

- **VS Code**：点活动栏里的 **Commit** 图标。
- **Cursor**：活动栏是横着的，在侧边栏顶部。看不到 Commit 图标时，点图标那一排最右边的 **⌄**，选 **Commit**。
- 任何地方：命令面板 → `Git Log: Commit…`。

小技巧：把 Commit 视图拖到右侧的辅助侧边栏，可以一直开着、和编辑器并排。

### 2. 提交

1. 勾选要提交的文件（或目录、整个 changelist）。新改动默认是勾上的。
2. 双击文件（或 `Cmd/Ctrl+D`）看 Diff。右侧就是真实文件，发现问题直接改。
3. 写提交信息，`Cmd/Ctrl+Enter` 提交；`Cmd/Ctrl+Alt+Enter` 是 **Commit and Push…**。

提交的是**勾选项在工作区里的内容**，与暂存区无关（`git commit --only`）。

### 3. 只提交文件的一部分

展开修改过的文件，每个改动块都有自己的勾选框；再展开改动块，可以逐行勾选。没勾的块和行留在本地，不会被提交。

![按行提交](images/n3-lines-and-options.jpg)

### 4. 看历史

打开底部面板的 **Git Log** 标签（`Git Log: Open Log`）。提交、文件、分支上右键就有各种操作，见下面的[常见操作](#常见操作)。

![Log 右键菜单](images/c15-log-menu.jpg)

## 常见操作

| 我想… | 怎么做 |
| --- | --- |
| 提交几个文件 | Commit 窗口里勾上 → 写信息 → `Cmd/Ctrl+Enter` |
| 只提交文件里的某几块 / 某几行 | Commit 窗口里展开文件（再展开改动块），只勾要的 |
| 把两件事的改动分开 | 工具栏 **New Changelist…**，把文件拖过去（或改动块右键 → *Move to Another Changelist…*），各个 changelist 分别提交 |
| 修改上一个提交 | 勾 **Amend**（自动带出上次的信息）再提交；或编辑器右键 → *Git Log → Amend This Change into Last Commit* |
| 只提交光标处的这处改动 | 编辑器右键 → *Git Log → Commit This Change…* |
| 撤销上一个提交、保留改动 | Log 里右键该提交 → **Undo Commit**（提交信息回到 Commit 窗口） |
| 改某个旧提交的信息 | Log 里右键该提交 → **Edit Commit Message…**（不动工作区） |
| squash / 调整顺序 / 删除提交 | Log 里右键要改的最早那个提交 → **Interactively Rebase from Here…** |
| 把我的分支 rebase 到 `master` | 先 Fetch，再 `Git Log: Branches…` → 选 `origin/master` → **Rebase '当前分支' onto 'origin/master'**；或 Log 里右键 `origin/master` → **Rebase Current onto**；或选 `origin/master` → **Pull into '当前分支' Using Rebase**，一步完成 fetch + rebase。注意先提交或 Shelve 掉未提交的改动 |
| 解决 rebase / merge 冲突 | 冲突文件在 Commit 窗口单独成组：*Merge…*、*Accept Yours*、*Accept Theirs*、*Mark as Resolved*；然后点 Log 顶部 rebase 提示条的 **Continue** |
| 推送 | `Git Log: Push…` 或 **Commit and Push…**。被拒时选 **Rebase and Push** 或 **Merge and Push**；rebase 过的分支要勾 *Force push (with lease)* |
| 把改动先收起来 | 文件右键 → **Shelve Changes…**（只收选中的文件） |
| 丢弃本地改动 | 右键 → **Rollback…**（`Cmd/Ctrl+Alt+Z`）；新增的文件可以顺便删掉 |
| 从别的提交 / 分支拿某个文件 | Log 里选中提交 → 文件右键 → **Get from Revision** / **Cherry-Pick Selected Changes** / **Revert Selected Changes** |
| 从只读的旧版本跳到真实文件 | 按 **F4**（或 Diff 工具栏的按钮） |
| 看每行是谁改的 | 编辑器右键 → *Git Log → Annotate with Git Blame* |
| 切换 / 新建 / 删除分支 | `Git Log: Branches…` |
| 按分支筛选 Log | Log → **Branch** 筛选 → 输入搜索，点分支名只看这个分支 |
| 看某分支有、我当前分支没有的提交（或反过来） | Log 左侧分支列表右键该分支 → **Compare with Current**，或 `Git Log: Branches…` → 选分支 → **Compare with '当前分支'**。Branch 筛选会显示成 `当前分支..该分支`，点 **⇄** 切换方向。想看文件差异用 *Show Diff with Current* |

## 功能

### Commit 工具窗口

- 改动按**目录树**展示（单子目录链合并，如 `src/commit`），可切换平铺；按 changelist 分组，多仓库时再按仓库分组；冲突文件、未跟踪文件各自成组。
- changelist、目录、文件、改动块、行都有**三态勾选框**。
- **Changelist**：新建、重命名、删除、设为活动、写描述（会预填提交信息）、在 changelist 之间移动文件或单个改动块（拆开的文件会同时出现在两边）、拖拽。新改动进入活动 changelist。
- 提交信息带**历史**、**Amend**、**Sign-off**，草稿按工作区保存；支持 `commit.template`；检查首行长度、正文行长、首行后空行，可一键折行。
- **提交选项**（齿轮按钮）：Author、Run Git hooks，以及提交前检查——Reformat code、Optimize imports、Analyze code（有错误/警告会停下，可以去看或者坚持提交）、Check TODO、Run tests（`gitLogWorkbench.commit.testCommand`）。
- 右键：Show Diff（`Cmd/Ctrl+D`）、Jump to Source（F4）、Commit File…、Rollback…（`Cmd/Ctrl+Alt+Z`）、Move to Another Changelist…（`Alt+Shift+M`）、New Changelist…、Shelve Changes…、Add to VCS、Add to .gitignore、Delete、Show History、Copy Path；冲突文件有 Merge…、Accept Yours、Accept Theirs、Mark as Resolved。

![改动块分到不同 changelist](images/n9-split-chunks.jpg)

![提交信息检查](images/n2-message-checks.jpg)

### 可编辑、有语言功能的 Diff

- Commit 窗口里的 Diff 是 HEAD ↔ **真实文件**：右侧可编辑，跳转定义、重命名、诊断都能用。
- Log 里打开的 Diff，只要文件在该提交里的版本和工作区一致，右侧也用真实文件。
- **Jump to Source**（F4）：从任何只读的历史版本打开本地文件，并定位到对应行。
- 文件、提交、分支都可以 **Compare with Local**（分支上叫 *Show Diff with Working Tree*）。

![可编辑 Diff + LSP](images/c5-diff-lsp.jpg)

### Log 操作

- 提交：Edit Commit Message…、Fixup… / Squash Into…（在 Commit 窗口预填 `fixup!` / `squash!`）、Undo Commit、Interactively Rebase from Here…、Push All up to Here…、Create Patch…、Compare with Local。
- 变更文件：Compare with Local、Jump to Source、Show History for File、Revert / Cherry-Pick Selected Changes、Get from Revision、Drop Selected Changes…（把这个文件的改动从该提交里去掉）、Create Patch…。
- 分支：Checkout and Rebase onto Current、Rebase Current onto、Merge into Current、Pull into Current Using Rebase/Merge、Update（不切换分支直接快进）、Show Diff with Working Tree。
- 工具栏：Push…、Update Project（Rebase/Merge）、Commit…。

### 对话框与弹出菜单

- **交互式 Rebase**：pick / reword / edit / squash / fixup / drop，`Alt+↑/↓` 调整顺序，快捷键 P/R/E/S/F/D，squash 组的提交信息合并后可编辑；本地改动自动 stash。
- **Push**：待推送的提交及其文件，可改远程和目标分支（不存在时标 *New*），Set upstream、Push tags、Force push with lease；推送被拒时可选 Rebase and Push / Merge and Push。
- **Branches** 弹窗（`Git Log: Branches…`）：Checkout、New Branch from…、Checkout and Rebase、Rebase、Merge、Update、Push、Rename、Delete、Pull Using Rebase/Merge。
- `Git Log: VCS Operations…`、`Git Log: Update Project…`、`Git Log: Push…`。

![交互式 Rebase 对话框](images/c18-rebase-dialog.jpg)

![Push 对话框](images/c13-push-dialog.jpg)

![Branches 弹窗](images/x-branch-actions.jpg)

### Annotate with Git Blame

编辑器（或行号区）右键 → *Git Log → Annotate with Git Blame*：每行旁边显示作者和日期，按新旧着色，未提交的行也会标出；悬停可看提交信息、Show Diff、Copy Hash。

![Annotate](images/c14-annotate.jpg)

## 命令

| 命令 | 作用 |
| --- | --- |
| `Git Log: Commit…` | 打开 Commit 窗口 |
| `Git Log: Open Log` | 打开 Git Log 标签 |
| `Git Log: Branches…` | 分支弹窗 |
| `Git Log: Push…` | Push 对话框 |
| `Git Log: Update Project…` | `git pull --rebase` 或 `--no-rebase`，带 autostash |
| `Git Log: VCS Operations…` | 以上操作的快捷菜单 |

## 快捷键

| 按键 | 位置 | 作用 |
| --- | --- | --- |
| `Cmd/Ctrl+Enter` | 提交信息框 | 提交 |
| `Cmd/Ctrl+Alt+Enter` | 提交信息框 | Commit and Push… |
| `Cmd/Ctrl+D` | Commit 窗口 | Show Diff |
| `Cmd/Ctrl+Alt+Z` | Commit 窗口 | Rollback… |
| `Alt+Shift+M` | Commit 窗口 | Move to Another Changelist… |
| `F4` | 只读 Diff / Commit 窗口 | Jump to Source |
| `P R E S F D`、`Alt+↑/↓` | Rebase 对话框 | 改动作、调整顺序 |

可选的全局快捷键（默认不绑定，因为会和编辑器自带的冲突），需要的话加到 `keybindings.json`：

```json
[
  { "key": "cmd+k cmd+c", "command": "gitLogWorkbench.commit.open" },
  { "key": "cmd+shift+k", "command": "gitLogWorkbench.push", "when": "!editorTextFocus" },
  { "key": "cmd+t", "command": "gitLogWorkbench.updateProject", "when": "!editorTextFocus" },
  { "key": "ctrl+v", "command": "gitLogWorkbench.vcsOperations", "when": "!editorTextFocus" }
]
```

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `gitLogWorkbench.commit.testCommand` | `""` | *Run tests* 检查执行的命令，在仓库根目录运行（如 `pnpm test`） |
| `gitLogWorkbench.commit.subjectLength` | `72` | 首行超过这个长度就提醒（0 关闭） |
| `gitLogWorkbench.commit.bodyLineLength` | `72` | 正文某行超过这个长度就提醒（0 关闭） |
| `gitLogWorkbench.commit.blankLineAfterSubject` | `true` | 首行后没有空行时提醒 |
| `gitLogWorkbench.git.path` | `"git"` | Git 可执行文件 |
| `gitLogWorkbench.currentLineBlame.enabled` | `true` | 光标所在行后显示 blame |

其余 `gitLogWorkbench.*` 设置来自原版（Log 分页大小、仓库扫描深度等）。

## 实现方式

- 所有操作都通过 Git 命令行完成——不走 shell，不保存任何凭据，认证交给 Git（credential helper / SSH agent）。
- 部分提交用临时索引（`GIT_INDEX_FILE`）：从 HEAD 建出来，只应用选中的块/行，用它提交，再把真实索引里这些路径同步过来。暂存区从不作为提交的输入。
- 交互式 rebase 用生成好的 todo 列表执行 `git rebase -i`；reword 和 squash 的信息通过 `git commit --amend` 步骤写入。

## 许可证

[MIT](LICENSE)，与原版相同。

---

# Git Log（原版功能）

以下是原版 Git Log 扩展的说明，这些功能全部保留。

## Log 截图

### Git Log 主界面

![Git Log 主界面](https://raw.githubusercontent.com/ascenx/vscode-git-log/main/images/git_log_workbench.png)

### 当前行 Blame 与编辑器菜单

![当前行 Blame 与编辑器菜单](https://raw.githubusercontent.com/ascenx/vscode-git-log/main/images/git_blame_and_menu.png)

### 文件历史

![文件历史](https://raw.githubusercontent.com/ascenx/vscode-git-log/main/images/file_history.png)

### 行历史

![行历史](https://raw.githubusercontent.com/ascenx/vscode-git-log/main/images/line_history.png)

### 与分支或标签比较

![与分支或标签比较](https://raw.githubusercontent.com/ascenx/vscode-git-log/main/images/branch_compare.png)

## 核心原则

1. 优先提供高信息密度、清晰且高效的 Git 日志操作路径。
2. Git CLI 是仓库数据和操作的最终事实来源。
3. 编辑、Diff 和合并尽量复用 VS Code 原生能力。
4. 大仓库必须采用分页、缓存和虚拟滚动，不能一次读取完整历史。
5. 所有破坏性操作都必须展示明确目标、影响范围和确认步骤。
6. 每个实施阶段都必须有自动化测试和可执行验收命令。

## 已实现的 Git Log 功能

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Ref filter │ Text/hash │ Branch │ User │ Date │ Paths │ Actions   │
├─────────────┬───────────────────────────────────┬───────────────────┤
│ HEAD        │ Commit graph                      │ Changed files     │
│ Local       │ ● fix: ...        main   Alice   │ src/              │
│   main      │ │\                                │   extension.ts    │
│   feature   │ │ ● feat: ...     feature Bob    │ package.json      │
│ Remote      │ ●─┘ refactor: ...                 │                   │
│ Tags        │                                   │                   │
├─────────────┴───────────────────────────────────┴───────────────────┤
│ Commit message │ hash │ author │ date │ parents │ action toolbar    │
└─────────────────────────────────────────────────────────────────────┘
```

当前版本已经覆盖实施路线的 Milestone 0–6，以及 Milestone 7 中的编辑器历史专项：

- 多根工作区仓库发现，支持普通仓库、bare repository、linked worktree 和 detached HEAD。刷新仓库时会复用未变化的 Git 元数据监听器，包括 linked worktree 之间的共享监听器。
- 远程分支菜单提供 `Checkout (Detached HEAD)`，无需创建本地分支即可检出。游离 HEAD 菜单支持 `Switch Back`（`git switch -`）和 `Create Branch and Checkout…`（`git switch -c <新分支名>`）；这些操作会清空 Branch 筛选、保留其他筛选，并定位 HEAD，以便显示后续本地提交。
- 游离 HEAD 菜单和顶部更多操作提供 `Push HEAD…`，可选择已配置的 Remote 和已有或新目标分支，以 `HEAD:refs/heads/<分支名>` 推送，无需创建本地分支；非快进更新由 Git 拒绝（[#5](https://github.com/ascenx/vscode-git-log/issues/5)）。
- Refs / Commit Graph / Changed Files / Commit Details 四区联动。
- Branch 筛选提供 `All` 和 `HEAD (local)` 快捷选项：`All` 可一起选中 Local、Remote、Tag 引用，支持超过 100 个引用，并可逐项取消选择；`HEAD (local)` 显示当前 HEAD 的历史，包括游离 HEAD，同时保留其他日志筛选。
- Branch 区域提供独立搜索，并将名称中带 `/` 的 Local、Remote、Tag 引用递归分组为可展开/收起的文件夹；本身包含 `/` 的 Remote 名称仍作为独立的顶层文件夹。
- Git Log 作为 VS Code 底部 Panel 的独立 Tab 展示，与问题、输出、终端等工具窗口并列；点击 `Open Log` 会直接聚焦该 Tab，不再打开编辑器页或经过中间欢迎页。
- 分页日志、有界滑动窗口、自定义 DAG lane、跨窗口 graph continuation、固定行高虚拟滚动和大列表性能基准；深分页的全局 offset、选择和相对滚动位置可恢复。`Go to HEAD` 会在当前筛选后的 Commit 列表中定位已 Checkout 的 HEAD，并将其对齐到首个可见行，不会切换当前 Branch 筛选。
- Text/Hash、Branch、User、Date、Path 组合过滤，旧查询取消和过期响应拒绝；仓库状态刷新不会覆盖正在编辑的搜索草稿；文本查询按 canonical `git log --date-order` 顺序扫描完整正文、作者姓名与邮箱，并且只返回匹配的 Commit。隐藏提交的祖先关系会直接投影到匹配结果上，使分支线保持连续，同时不插入无关 Merge Commit 或多余 Lane。
- Root、Merge、Rename、Copy、Binary 等 changed-files 场景及 VS Code 原生 Diff；多选 Commit 时会合并展示所有选中 Commit 的变更文件，并为每个文件保留正确的 Commit 与 Parent 上下文。详情查询最多并发处理 4 个选中 Commit，并通过有界缓存复用成功结果；刷新仓库时清除缓存，同时保留选择顺序和最新引用标签。
- Checkout、Checkout Revision、Branch、Tag、Fetch、Pull、Push、Cherry-pick、Revert、Merge、Rebase、Reset、Rename/Delete Branch，以及 Commit/Local/Remote/Tag/HEAD 对应的上下文菜单。Rebase 进行中会显示独立状态行及 `Continue`、`Skip`、`Abort` 操作；所有冲突标记解决后才会启用 `Continue`。
- 提供完整 Stash 管理：可选择是否包含未跟踪文件，并支持查看 Stash 变更、Apply、Pop 和确认后 Drop。
- 单击或双击分支只会选择该分支并展示对应 Commit，不会自动 Checkout；Checkout 保留在 Ref 右键菜单中，必须显式执行。
- 支持使用 Shift+单击或 Shift+方向键连续多选 Commit，也可使用 Ctrl/Cmd+单击逐个切换非连续选区；Changed Files 会合并所有选中 Commit，`Drop commits…` 和 `Squash commits…` 仍仅对连续选区开放。Squash 输入框会按界面从上到下预填所有选中 Commit 的完整消息。历史改写要求工作区干净并二次确认，同时拒绝 Root Commit、Merge Commit、过期选区，以及确认期间发生的当前分支或 HEAD 变化。
- 非当前 Local Branch 的右键菜单提供需要二次确认的 `Force Delete…`；普通删除因分支未合并而失败时，也会提供警告色的强制删除恢复按钮。错误提示固定展示五秒后自动关闭。
- 同 common Git dir 写操作串行、按仓库维护 Webview in-flight 锁、危险操作模态确认、Git 错误分类、脱敏 Output Channel 和完成后重新读取 Git 状态。工作区重新扫描期间会保留进行中的操作锁，操作后刷新被取消也不会让右键菜单操作一直锁定。
- Pane/Column 拖动、Pane 折叠与 workspace 宽高持久化；Commit Details 可在全宽底部和 Changed Files 底部之间切换，位置会跨面板会话保留；Commit、Author、Date、Refs 四列固定展示，深分页选择和滚动位置可在重开面板后恢复。
- Commit 与 Refs 等表格列的分隔线可直接拖动并持久化宽度；Changed Files 支持深路径横向滚动，增删行数分别使用绿色和红色。
- Changed Files 单击预览、Tree/List、Show Diff、Open File at Revision、Open Current File、Copy Path，以及 Commit/Ref/File 上下文菜单；菜单支持外部点击和执行后自动关闭。
- Compare with Current 打开独立文件列表，展示文件状态及绿色新增/红色删除行数；可选择单个文件打开 VS Code 原生 Diff，也可通过 `All Changes` 在同一个多文件 Diff 中查看全部非二进制文件。
- 编辑器右键提供 `Git Log` 子菜单：可查看当前行/选区历史、查看完整文件历史，或将当前工作区文件与 Local Branch、Remote Branch、Tag 中的同路径文件比较。
- Explorer 右键提供 `Git Log` 子菜单：文件可打开现有 File History 独立 Tab，文件夹则在底部 Git Log 中按目录递归过滤 Commit；关闭 Folder History 后会恢复之前的日志筛选和位置。
- 当前行 Blame 使用适配主题的淡色文字展示作者、相对时间和 Commit 主题；鼠标悬停后展示作者邮箱、精确时间、Commit Hash 和完整消息。未提交内容的编辑时间会自动更新并保存在工作区状态中；启用 VS Code 内置的 `git.blame.editorDecoration.enabled` 后，插件装饰会自动停用以避免重复展示。
- 行历史会先把工作区行号映射到 `HEAD`；未保存内容使用 Extension Host 内存快照参与映射且不会触发保存，纯未提交新增行显示明确空状态，部分未提交或不连续选区不会错误归属 Commit；文件历史支持 rename、分页、按 HEAD 缓存和绿色/红色增删统计。
- Current Line、Selection 和 File History 均打开独立编辑器 Tab，左侧列出相关 Commit 和绿色/红色增删统计；左右区域的分隔线可拖动并记忆宽度。
- History 右侧保留聚焦范围或完整文件的 Inline Diff，并由独立 Worker 使用按实际文件类型延迟加载 grammar 的 Shiki 生成语法高亮；右上角 `VS Code Diff` 可将当前 Commit 的文件变化打开到原生 Diff Editor，继承 minimap、搜索、语法能力和标准快捷键。切换 Commit 会终止旧高亮任务，超时、超大 patch、超长单行或过高 token 预算会自动退回纯文本预览，不阻塞 Extension Host。
- 完整键盘导航、搜索框双层 `Escape`、`Ctrl/Cmd+C` 复制 Hash，以及浅色、深色和高对比主题支持。
- 当前分支顶端的 Commit 支持 Amend HEAD，可编辑提交信息并包含已暂存变更。

## 本地开发

```text
asdf install        # 按 .tool-versions 装 Node
pnpm install
pnpm run typecheck
pnpm run lint
pnpm run test:unit
pnpm run test:integration
pnpm run build
```

在 VS Code 中选择 `Run Extension` 启动 Extension Development Host，然后执行命令 `Git Log: Open Log`；也可以直接点击底部 Panel 的 `Git Log` Tab。

生成本地 VSIX：

```text
pnpm run package
```


## 使用提示

- 单击或双击 Local/Remote Branch 只展示该分支的 Commit 历史，不会 Checkout；需要切换分支时请使用 Local Branch 的右键菜单。
- 使用 `Go to HEAD` 可在当前正在查看的 Commit 列表中定位仓库已 Checkout 的 HEAD，不会切换当前 Branch 筛选。
- 在 `Branch` 筛选中，使用 `All` 一起选中 Local、Remote、Tag 引用，或使用 `HEAD (local)` 返回当前 HEAD 的历史，包括游离 HEAD。全选后仍可逐项切换引用；文本、作者、日期和路径筛选会保留。
- 仅在确认需要删除尚未完全合并的非当前 Local Branch 时使用 `Force Delete…`；执行前 Git Log 会显示模态二次确认。
- 使用 Branch 区域搜索框可在本地过滤引用；名称中带 `/` 的引用会按文件夹分组，各层级可独立展开或收起。
- 文本搜索只列出真正匹配的 Commit；隐藏提交会折叠为可见匹配项之间的紧凑连接，不再插入无关 Merge Commit 或留下长距离的多余分支线。
- Rebase 进行中可点击 `Rebasing` 打开 VS Code Source Control，并在状态行执行 `Continue`、`Skip` 或 `Abort`。全部冲突解决并暂存后才可 `Continue`；`Skip` 和 `Abort` 执行前需要确认。
- 按住 Shift 单击另一个 Commit，或使用 Shift+上/下方向键扩展连续选区；Windows/Linux 使用 Ctrl+单击、macOS 使用 Cmd+单击可逐个切换非连续 Commit。Changed Files 会合并所有选中 Commit，`Drop commits…` 和 `Squash commits…` 仅在选区连续时显示。
- 右键单个 Commit 可执行 `Checkout Revision`，以 detached HEAD 状态查看该版本；后续提交也可通过 HEAD 菜单中的 `Create Branch and Checkout…` 保存到新分支。
- 右键远程分支选择 `Checkout (Detached HEAD)`，可直接检出其当前提交而不创建本地分支。进入游离 HEAD 后，右键左侧 HEAD 条目可用 `Switch Back` 返回上一次检出（`git switch -`），或用 `Create Branch and Checkout…` 从当前 HEAD 创建并切换到新分支（`git switch -c <新分支名>`）。这些操作成功后，Branch 筛选会切回跟随 HEAD，以显示后续本地提交。
- 游离 HEAD 时，HEAD 右键菜单和顶部更多操作提供 `Push HEAD…`。选择已配置的 Remote，填写目标分支（已有或新分支），点击 `Push` 即可将 HEAD 推到该远程分支，例如 `origin` / `feature` 对应 `git push origin HEAD:refs/heads/feature`。此操作不创建本地分支，非快进更新由 Git 拒绝。
- 单击 Changed File 查看路径、状态和增删摘要；双击或右键 `Show Diff` 使用 VS Code 原生 Diff Editor。
- 在 Commit Comparison 中使用 `All Changes` 可集中查看全部文本文件变化；二进制文件仍会列出，但不会进入多文件 Diff。
- 使用 Commit Details 中的箭头按钮，可将详情移动到 Changed Files 底部或切回全宽底部；所选位置会按 workspace 保存。
- 在普通本地文件编辑器中右键打开 `Git Log`：无选区时查看当前行历史，有选区时查看选区历史，也可在独立 Tab 打开完整 File History；Branch/Tag 比较使用 VS Code 原生 Diff，因此自动继承 minimap、语法高亮、搜索和 Diff 快捷键。
- 当前行历史默认在每处修改上下各展示 3 行弱化的逻辑上下文；格式化变更中的新旧上下文会按相对位置对齐，Commit 列表也会过滤只修改了 Git 扩张追踪范围内其他行的提交。可通过 `gitLogWorkbench.lineHistory.contextLines` 在 `0` 到 `20` 之间调整，设为 `0` 时仅展示目标行变更。
- 在 Explorer 中右键本地文件或文件夹并打开 `Git Log`：文件使用独立 File History Tab，文件夹会把底部 Git Log 过滤为曾修改该目录的 Commit；点击 `Back` 可恢复之前的筛选和位置。Git 不把文件夹作为独立对象保存，因此 Folder History 不会自动跟踪目录重命名。
- 当前行 Blame 默认启用，可以通过 `gitLogWorkbench.currentLineBlame.enabled` 关闭。
- `Ctrl/Cmd+F` 聚焦搜索，`Ctrl/Cmd+L` 聚焦 Commit Log，`Ctrl/Cmd+C` 复制选中 Commit 的完整 Hash；方向键、PageUp/PageDown、Home/End 可浏览提交。
- 搜索框第一次按 `Escape` 清空搜索，搜索为空时再次按 `Escape` 返回 Commit Graph。
- Pane 和 Commit 列可鼠标拖动，也可聚焦分隔条后使用方向键调整；工具栏可折叠 Refs/Changed Files，Commit、Author、Date、Refs 始终全部展示。
- User 筛选会根据仓库的 `git config user.name/user.email` 始终置顶 `Me（当前 Git 用户）`，并优先使用邮箱过滤；顶部工具按钮均提供悬停说明。
- Refresh 只读取本地状态；Fetch、Pull、Push 会访问用户现有 remote，并复用系统 credential helper/SSH Agent。
- 顶部 `Stashes` 用于创建、查看、Apply、Pop 或 Drop 暂存工作。

## 安全与隐私

- 所有 Git 命令使用 `spawn` 参数数组且不开 shell。
- 扩展不保存密码、Token 或 SSH 私钥；remote 认证完全交给 Git。
- Output Channel 会脱敏 URL userinfo，不记录文件内容或完整环境变量。
- Hard Reset、Force Push with Lease、Branch Delete、Force Delete 等危险操作会显示仓库和实际目标并要求确认。
- Force Push 的目标解析、确认与执行都在同一 common Git dir 队列锁内完成，固定 source object ID，并拒绝隐式或非完整目标 refspec。
- 文本历史扫描单次 stdout 上限为 64 MiB，rolling match cache 有界，Webview commit window 受 `maxCachedCommits` 限制。
- 默认不采集遥测。
