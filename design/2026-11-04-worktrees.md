# Manage Worktrees：多工作树管理

- 日期：2026-11-04
- 状态：已实现（0.13.0）
- 相关：对照 IDE Git 功能列出的剩余项之一

## 背景与目标

同时改好几个分支时（比如一个分支交给 agent 跑、自己在另一个分支修 bug），来回 stash / checkout 很麻烦，`git worktree` 能让每个分支各有一个目录。但现在只能去终端敲命令；而且一个分支已经在别的工作树里 checkout 时，我们的 Checkout 只会报 Git 的原始错误。

目标：
1. 一个 **Manage Worktrees** 入口：列出所有工作树，可以新建、在新窗口打开、删除、清理失效记录。
2. 分支已在别的工作树里时，Branches 弹窗和 Log 能看出来；Checkout 它时提示「打开那个工作树」，而不是报错。

**不做的事**：
- 不做 lock / unlock、move（用得少，终端里做）。
- 不在一个窗口里同时显示多个工作树的 Log——每个工作树在自己的窗口里就是一个普通仓库，现有功能照常用。
- 不自动拷贝 `.env`、`node_modules` 之类未跟踪文件。

## 参照行为

IDE：Git → Worktrees 工具窗口（列表 + 新建/打开/删除），分支弹窗里对已被其他工作树占用的分支标图标，Checkout 时提示切到那个工作树。照搬功能；有意不同：和 Manage Remotes 一样用快速选择框做，不单独开窗口。

## 方案

### 入口

- 命令面板：`IDE Git: Manage Worktrees…`
- Branches 弹窗顶部加 **Manage Worktrees…**。
- Branches 弹窗和 Log 左侧的本地分支右键：**New Worktree from '<分支>'…**。

### 列表

```
Manage Worktrees — ide-git
  $(add) New Worktree…
  $(trash) Prune Stale Worktrees          （只在有失效记录时出现）
  ── Worktrees ──
  $(check) main            ~/skunkworks/git-log                    （当前窗口）
  $(folder) feat/patch     ~/skunkworks/git-log-feat-patch
  $(folder) (detached a1b2c3d)  ~/tmp/review        locked
  $(warning) fix/old       ~/gone/path               prunable：目录不存在
```

选中某个工作树 → 操作（用户确认的顺序）：
1. **Switch to This Worktree**（默认）：当前窗口重新打开为那个目录（`vscode.openFolder`，不开新窗口），之后 Log、Commit 窗口、文件树、终端都在那个 worktree 里。窗口会重新加载，未保存的文件 Cursor 会先问，终端里在跑的东西会停。
2. **Open in New Window**：两个分支同时开着改。
3. **Add to Workspace**：留在当前窗口，扩展把它当成另一个仓库（Log 里切仓库、Commit 窗口里单独一组）。
4. **Reveal in File Manager**、**Copy Path**、**Remove…**。当前窗口那个和主工作树不出现 Remove。

### Log 工具栏的 Worktree 下拉（用户追加）

Log 顶部筛选栏 Branch / User / Date / Paths 后面加 **Worktree: <当前分支> ▾**（多于一个时带数量），一直显示，方便发现。点开列出全部 worktree（分支 + 目录名，悬停看完整路径），**单击就把窗口切过去**；右键或行尾 `⋯` 在下拉里原地换成这个 worktree 的操作（顶部写着分支和完整路径，← 返回列表）；底部 New Worktree… 和 Manage Worktrees…。

### New Worktree…

1. 选分支：列出本地分支（已被占用的放后面并标 `in <路径>`，不可选）+ 远程分支 + 顶部 **$(add) New Branch…**。
   - 选远程分支 `origin/x`：本地没有 `x` 就建同名跟踪分支（`worktree add --track -b x <路径> origin/x`），有就用本地的。
   - New Branch…：输入名字，起点默认当前 HEAD（从 Log 右键进来时是那个分支/提交）。
2. 目录：输入框预填 `<仓库父目录>/<仓库名>-<分支名，/ 换成 ->`，可改；已存在且非空时直接在输入框里提示。
3. 建好后问：**Switch** / **New Window** / **Add to Workspace** / 关闭。

### Checkout 被占用的分支

本地分支 Checkout 前先查 `worktreepath`：在别的工作树里就弹框「'x' 已在 <路径> 里 checkout」→ **Open Worktree**（新窗口）/ Cancel，不再执行 checkout。

### Git 命令（写操作走 `GitOperationService`）

- 读：`git worktree list --porcelain`（解析 `worktree` / `HEAD` / `branch` / `detached` / `bare` / `locked` / `prunable`；Git 2.31 前没有 `prunable`，就自己检查目录是否存在）。
- 分支占用：`for-each-ref` 加 `%(worktreepath)`（Git 2.23 起有，满足最低 2.27）。Branches 弹窗和 Log 的分支列表都用它。
- 写（`GitOperationRequest` 新增）：
  - `addWorktree`：`git worktree add [--track] [-b <新分支>] -- <路径> <分支或起点>`
  - `removeWorktree`：`git worktree remove [--force] -- <路径>`。先确认；工作树有未提交改动或未跟踪文件时 Git 会拒绝，这时再弹第二次确认「这些改动会丢失」，用户同意才加 `--force`。
  - `pruneWorktrees`：`git worktree prune`。
- 分支名用 `validateToken` + 现有的分支名校验；路径必须是绝对路径、不含换行和 NUL。
- 这三个操作不碰当前工作树的文件，rebase / merge 进行中也允许（和远程操作一样放行）。

## 边界情况

- 只有一个工作树：列表只有主工作树 + New Worktree…。
- 当前窗口打开的是子工作树：照样能列出、管理全部（`worktree list` 在哪个工作树里跑结果都一样）；主工作树标 `main worktree`，不能删。
- 裸仓库：主条目是 `bare`，不能打开、不能删；其他工作树正常。
- detached HEAD 的工作树：显示短 hash。
- 路径带空格或中文：参数数组传，不拼 shell；显示时把家目录缩成 `~`。
- 删除的工作树正开在另一个窗口：Git 照样能删，那个窗口的文件会消失——确认框里提醒。
- 子模块：带子模块的工作树 Git 要求 `--force` 才能删，走上面第二次确认。
- 多仓库：先选仓库（当前文件所在仓库优先）。

## 风险

- 新建只会多一个目录和一条 `.git/worktrees/<名>` 记录，不影响现有工作区。
- 删除会删掉那个目录；有改动时必须用户二次确认才 `--force`，默认不会丢东西。删错了的分支本身还在，可以再建。
- prune 只清目录已不存在的记录。

## 测试计划

- 单测：`worktree list --porcelain` 解析（主/子/detached/bare/locked/prunable、路径带空格和中文、旧版 Git 没有 prunable 字段）；默认目录名生成；输入校验；确认文案。
- 真实临时仓库：从已有分支、新分支、远程分支建工作树；被占用的分支 Checkout 被拦下；删除干净的工作树；有改动时第一次被拒、加 force 成功；手动删目录后 prune 清掉记录；rebase 进行中仍能新建。
- e2e：命令面板打开 Manage Worktrees → 从一个分支新建 → `git worktree list` 里出现 → Branches 弹窗里该分支标 `in <路径>` → 在 Log 里 Checkout 它弹出提示 → 删除。
- 手动：在 Cursor 里新建后选 Open in New Window，新窗口里 Log、Commit 窗口正常。

## 实际实现与偏差

- **默认操作改成 Switch to This Worktree**：方案确认时用户追加，上面已写进方案。
- **Log 里的位置**：第一版放在左侧分支列表最底下的 Worktrees 分组（双击切换），用户试用后觉得太靠下不好找，改成工具栏 Paths 旁边的 Worktree 下拉，分组去掉。
- **删除后 Log 不刷新（试用时发现）**：Git 删除 worktree 是整个删掉 `.git/worktrees/<名>/`，里面文件的删除事件不一定报上来，Log 一直显示已删的那行。修法：监听再加 `worktrees/*` 目录本身；Manage Worktrees 每次新建、删除、清理成功后直接通知 Log 刷新（`WorkbenchViewProvider.notifyRepositoryChanged`），不只靠监听。e2e 加了「删除后 Log 里消失」这一项。
- **右键时下拉消失（试用时发现）**：第一版右键会先关掉下拉、再弹一个独立的右键菜单，看不出右键的是哪个 worktree；而界面规范要求同一时间只显示一个弹出层。改为在下拉里原地显示这个 worktree 的操作（`WorktreePopup` 组件），行尾加 `⋯` 按钮做同样的事。
- **分支占用不靠 `%(worktreepath)`**：Log 和 Branches 都直接用 `git worktree list --porcelain` 的结果（Log 每次完整加载时随 `repositoryData.worktrees` 一起发），一个来源，不用改 `parseRefs` 的字段。
- **Checkout 被占用的分支**：不在 checkout 前预先查询，而是在 Git 报 `is already used by worktree at` / `is already checked out at`（两种版本的措辞）时交给 `GitOperationRunOptions.resolveBranchInOtherWorktree`，弹框 Switch to Worktree / Open in New Window。Log 和 Branches 里被占用的分支本来就不显示 Checkout，改为 **Switch to Its Worktree**。
- **webview 不能直接删 worktree**：Log 只发 `worktreeAction { path, action }`，扩展端重新列一遍、确认路径确实是这个仓库的 worktree 才执行；`addWorktree` / `removeWorktree` / `pruneWorktrees` 不在 webview 的 `runOperation` 白名单里。
- **自动刷新**：监听公共 git 目录的 `worktrees/*` 和 `worktrees/*/HEAD`（新建、删除、别的 worktree 切分支），在终端里建的 worktree 也会出现在 Log 里。
- **新建后的通知按钮用短文字**（Switch / New Window / Add to Workspace），长文字在通知里会被截断。
- 目录不存在但 Git 版本太旧不报 `prunable` 时，Manage Worktrees 自己检查目录是否存在。
- 验证：单测（解析、路径、错误识别、协议校验、Log 工具栏下拉的单击切换/右键/新建/管理和分支标记）；真实临时仓库（从本地/新/远程分支建，路径带空格和中文；被占用分支 checkout 交给回调；干净的直接删、有改动的第一次被拒、force 成功、分支保留；不确认不删；prune；非法输入在执行前拒绝；rebase 进行中能建）；e2e `worktrees` 11 项（命令面板新建 → 工具栏下拉和分支标记 → 分支右键菜单 → 下拉里右键保持打开并显示操作 → 确认后删除、Log 里随即消失 → 终端新建的出现 → 在下拉里点它把窗口切过去）。
