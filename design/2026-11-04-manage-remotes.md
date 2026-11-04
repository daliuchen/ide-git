# Manage Remotes：增删改远程

- 日期：2026-11-04
- 状态：已实现
- 相关：对照 IDE Git 功能列出的剩余项之一

## 背景与目标

现在只有在「没有任何远程」时，Push 对话框会提示添加一个（Define Remote）。改远程地址、加第二个远程（比如 fork 的 `upstream`）、改名、删除，都得去终端。

目标：一个 **Manage Remotes** 入口，列出所有远程（名字和地址），可以添加、改地址、改名、删除、复制地址、Fetch。

**不做的事**：
- 不分别设置 fetch 和 push 两个地址（`--push`）；改地址时两者一起改。
- 不处理认证、不保存任何凭据（地址里带的账号密码原样交给 Git，显示时打码）。

## 参照行为

IDE：Git → Manage Remotes，一个列表窗口，`+` 添加、`-` 删除、双击编辑名字和地址。照搬功能；有意不同：用编辑器自带的快速选择框（QuickPick）和输入框做，不单独开窗口——操作少、每次只改一项，快速选择框足够，也和 Branches 弹窗的风格一致。

## 方案

### 入口

- 命令面板：`IDE Git: Manage Remotes…`
- Log 左侧 Branches 里 **Remote** 分组标题的右键菜单。
- Branches 弹窗顶部的操作里加一项 **Manage Remotes…**。
- Push 对话框现有的 Define Remote 不变。

### 交互

```
Manage Remotes — ide-git
  $(add) Add Remote…
  origin     https://github.com/daliuchen/ide-git.git
  upstream   https://github.com/ascenx/vscode-git-log.git
```

- **Add Remote…**：输入名字（默认 `origin`，已存在则空）→ 输入地址 → 问一次「现在 Fetch 吗」（默认是）。
- 选中某个远程 → 操作列表：**Edit URL…**（输入框预填当前地址）、**Rename…**、**Fetch**、**Copy URL**、**Remove…**（模态确认，说明会一起删掉 `<名字>/*` 远程分支的本地记录，不影响服务器）。
- 每次操作完回到列表，方便连续改。

### Git 命令（写操作走 `GitOperationService` 的串行队列）

- 读：`git remote -v`（解析 fetch 地址；push 地址不同的在说明里标出）。
- 写：`git remote add <名字> <地址>`、`git remote set-url <名字> <地址>`、`git remote rename <旧> <新>`、`git remote remove <名字>`、`git fetch <名字>`。
- `GitOperationRequest` 新增 `addRemote` / `setRemoteUrl` / `renameRemote` / `removeRemote`。名字用 `validateToken` 加 `git check-ref-format refs/remotes/<名字>/x` 校验；地址不能为空、不能以 `-` 开头、不含换行和 NUL。`removeRemote` 需要确认（`getOperationConfirmation`）。
- 把 Push 对话框里现有的 `defineRemote`（直接调 `git remote add`）改成走同一个 `addRemote`，去掉重复代码。
- 显示地址时把 `https://user:token@host` 里的账号密码打码（复用 `redactGitDiagnostic`）。

## 边界情况

- 没有远程：列表只有 Add Remote…。
- 名字重复 / 非法：输入框里直接提示，不提交。
- 改名后：Git 会同时改远程分支和 `branch.*.remote` 配置；Log 刷新后分支名跟着变。
- 删除的远程是当前分支的上游：删除后状态栏不再显示 ↑↓，确认框里提示。
- 多仓库：先选仓库（当前文件所在仓库优先）。
- rebase / merge 进行中：远程操作不受影响，允许执行（`run()` 里对这几类放行，和 `fetch` 一样）。

## 风险

只改 `.git/config` 里的远程配置和本地的远程分支记录，不碰工作区和本地分支。删错了可以重新 Add 再 Fetch 恢复。

## 测试计划

- 单测：`git remote -v` 解析（fetch/push 不同、地址带空格、没有远程）；名字和地址校验；地址打码；确认文案。
- 真实临时仓库：add → set-url → rename（`branch.main.remote` 跟着改）→ remove（远程分支记录被删）；非法名字被拒绝；进行中的 rebase 不影响远程操作。
- e2e：命令面板打开 Manage Remotes → 添加一个指向本地 bare 仓库的远程 → Fetch → Log 里出现它的分支 → 改名 → 删除。

## 实际实现与偏差

- **Log 里的入口改成 ⚙ 按钮**：方案写的是 Remote 分组标题的右键菜单，但分组标题本身是个按钮（点击折叠），右键再弹一层菜单不好发现。改为标题右侧的 ⚙ 按钮（`Manage remotes`），一点就打开。
- **地址允许空格**：本地路径常带空格（`/Users/me/My Repos/x.git`），只拒绝换行和 NUL（会变成 `.git/config` 里的多个值）以及开头的 `-`。
- 名字校验用正则（字母数字和 `._-/`，不以 `-` 开头，不含 `..`、不以 `.lock` / `.` 结尾），没有再调用 `git check-ref-format`；Git 自己也会拒绝不合法的名字，报错会原样显示。
- `git remote` 的子命令都在参数前加了 `--`（Git 2.43 实测可用）。
- 删除远程的确认框说明了「服务器上不受影响、跟踪它的分支会失去上游」。
- 验证：解析/校验/打码单测；真实临时仓库（add → fetch → push -u → set-url → rename 后 `branch.main.remote` 和远程分支跟着改 → remove 需确认、远程分支记录被删；非法名字和以 `-` 开头的地址在执行前被拒；rebase 进行中也能改远程）；e2e `manage-remotes` 7 项（命令面板添加并 Fetch、改名、确认后删除、Log 里的 ⚙ 能打开）。
