# Merge 对话框：选择合并方式

- 日期：2026-11-04
- 状态：已实现
- 相关：对照 IDE Git 功能列出的剩余项之一

## 背景与目标

现在 Log 右键 / Branches 弹窗里的 **Merge into Current** 固定执行 `git merge --no-edit <ref>`：能快进就快进，不能就生成默认信息的合并提交。想要「一定生成合并提交」「只允许快进」「压成一个提交」或改合并信息时，只能去终端。

目标：加一个 **Merge…** 对话框，可以选合并方式、看将要合进来的提交、改合并信息。

**不做的事**：
- 不改现有的 **Merge into Current**（保持一键直接合并，和 IDE 分支弹窗一致）。
- 不做一次合并多个分支（octopus）、不做合并策略（`-s ours` 等）和 `--allow-unrelated-histories`。

## 参照行为

IDE 的 Merge 对话框：选要合并的分支，选项有 `--no-ff`、`--ff-only`、`--squash`、`--no-commit`、编辑提交信息（`-m`）。照搬这几项；有意不同：只合并一个分支，打开时已经带上右键选中的分支或提交。

## 方案

### 入口

- Log：分支右键、提交右键，在 **Merge into Current** 下面加 **Merge…**。
- Branches 弹窗：分支的操作列表里加 **Merge…**。
- 命令面板：`IDE Git: Merge…`，先选分支（本地 + 远程，当前分支除外）。

### 对话框（复用 Push / Rebase 用的对话框面板 `src/dialogs/`）

```
Merge feature/x into main
  将要合进来的提交（git log HEAD..feature/x，最多 200 条；0 条时提示 "Already up to date"）

  方式  ○ Default（能快进就快进，否则生成合并提交）
        ○ Create a merge commit（--no-ff）
        ○ Fast-forward only（--ff-only）
        ○ Squash（--squash：改动放进暂存区，到 Commit 窗口里提交）
  □ Don't commit（--no-commit，合并后停下来，到 Commit 窗口检查后再提交）
  合并信息  [Merge branch 'feature/x' into main]   （只在会生成合并提交的方式下可编辑）

                                         [Cancel] [Merge]
```

- 只能快进时，Default 和 Fast-forward only 都不会生成提交，合并信息框置灰并说明。
- **Squash** 完成后，打开 Commit 窗口并预填信息：`Squashed commit of 'feature/x'` + 各提交标题列表（取自 `.git/SQUASH_MSG`）。
- **Don't commit** 完成后，Log 和 Commit 窗口显示「合并进行中」的 Continue / Abort（已有）。

### 协议与 Git 命令

- `GitOperationRequest` 的 `merge` 增加可选字段：`mode?: 'default' | 'no-ff' | 'ff-only' | 'squash'`、`noCommit?: boolean`、`message?: string`；不带这些字段时行为和现在完全一样（`--no-edit`）。`parse…` 里校验枚举、信息长度（≤ 10 000，不含 NUL）。
- 对话框协议新增 `DialogInit` 的 `merge` 类型和 `merge` 消息（`parseDialogMessage` 校验）。
- 执行（走 `GitOperationService`，串行队列 + 执行前检查状态）：
  - `git merge [--no-ff | --ff-only | --squash] [--no-commit] (-m <信息> | --no-edit) <ref>`
  - squash 模式不带 `-m`（Git 不用它）。
  - 只读：`git log --format=… --max-count=200 HEAD..<ref>`、`git merge-base --is-ancestor HEAD <ref>`（判断能否快进）。
- 合并冲突：沿用现有处理——Git 停在合并中，Commit 窗口列出冲突文件，横幅有 Continue / Abort。

## 边界情况

- detached HEAD：Merge… 禁用（和 Merge into Current 一致）。
- rebase / cherry-pick 进行中：`run()` 已拒绝。
- 工作区有改动挡住合并：显示 Git 的报错（不做 Smart Merge）。
- 0 个新提交：对话框直接提示 "Already up to date"，Merge 按钮禁用。
- 远程分支：可以合并 `origin/x`，标题显示完整名字。
- 合并信息为空：退回默认信息。

## 风险

会改写仓库（新提交 / 移动分支）。和现在的 Merge into Current 风险相同；失败时 Git 停在合并中，用 Abort 回到合并前。Squash / Don't commit 不生成提交，可以直接 Rollback 撤销。

## 测试计划

- 单测：参数拼接（四种方式 × no-commit × 有无信息）；协议校验；对话框界面（选方式后信息框是否可编辑、0 条时禁用）。
- 真实临时仓库：
  1. no-ff：能快进的情况下也生成合并提交，信息为自定义内容；
  2. ff-only：不能快进时失败，分支不动；
  3. squash：HEAD 不动、改动在暂存区、`.git/SQUASH_MSG` 存在；
  4. no-commit：停在合并中（`MERGE_HEAD` 存在）；
  5. 不带新字段：结果和现在一样。
- e2e：从 Log 分支右键打开 Merge…，选 Create a merge commit、改信息、合并 → `git log` 里有这条合并提交。

## 实际实现与偏差

- **合并信息框默认留空**，把 Git 的默认信息作为占位文字：留空时执行 `--no-edit`，由 Git 生成默认信息（它会按 `merge.suppressDest` 等配置决定是否带 `into main`），比我们自己拼一条更准确。
- **Don't commit 自动带上 `--no-ff`**：git-merge 文档说明快进无法被 `--no-commit` 停下，所以勾选后一定会停在合并中；Fast-forward only 和 Squash 下这个选项禁用。
- 打开对话框前先 `git rev-parse --verify <ref>^{commit}`，不是提交的输入在这一步就被拒绝，后面的 `log` / `merge-base` 只收到解析出的 hash。
- squash 完成后用 `.git/SQUASH_MSG` 预填 Commit 窗口；Don't commit 完成后打开 Commit 窗口（合并进行中的横幅本来就有）。
- 验证：参数拼接和协议单测；真实临时仓库 5 个场景（no-ff 带信息、ff-only 在分叉时失败且分支不动、squash 只暂存并写 SQUASH_MSG、Don't commit 停在合并中、不带新字段仍是快进）；对话框界面测试 3 个；e2e `merge-dialog` 4 项（列出提交、只快进时信息框禁用、生成带信息的合并提交、工作区干净）。
