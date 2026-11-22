# 多选 Cherry-pick / Revert

- 日期：2026-11-21
- 状态：已实现（0.14.0）
- 相关：用户提出「不能批量选中来做 cherry-pick 和 revert」

## 背景与目标

Log 里可以用 ⌘ / Shift 多选提交，但右键菜单里 Cherry-pick 和 Revert 只有选中一个提交时才出现。想把另一个分支上的几个提交搬过来、或者撤掉几个提交，只能一个一个点。

目标：多选提交后，右键菜单里可以直接 **Cherry-pick** 和 **Revert**，一次操作完成。

**不做的事**：
- Revert 不合并成一个提交，每个被撤的提交各生成一个 revert 提交（用户确认）。
- Drop / Squash 不支持跳着选（用户确认不需要），保持只支持连续的几个提交。
- 不支持合并提交（要指定 `-m` 父提交）。

## 参照行为

IDE 的 Log 里多选后 Cherry-Pick：按提交的先后顺序，从旧到新逐个应用；冲突时停下，解决后继续。多选 Revert：从新到旧逐个撤，每个生成一个 revert 提交。照搬这一行为。

## 方案

### 界面（`webview/src/App.tsx`）

- 右键菜单里的 **Cherry-pick** / **Revert** 从「只在单选时出现」挪到单选、多选都出现的位置。多选时文字改为 `Cherry-pick 3 Commits` / `Revert 3 Commits`。
- 以下情况置灰，悬停时说明原因：
  - 选中的提交里有合并提交：`Merge commits can't be cherry-picked/reverted here`；
  - 超过 100 个：`Select no more than 100 commits`（和 Drop / Squash 一样）；
  - 有 Git 操作正在执行。
- 单选时行为不变；单选合并提交也按上面置灰（现在点了会直接报 Git 的原始错误）。
- 提交详情面板里已有的单个 Cherry-pick / Revert 按钮不动。

### 顺序

Log 列表来自 `git log --date-order`，子提交一定排在父提交前面。webview 按列表里的顺序（新 → 旧）把 hash 发给扩展端：
- Cherry-pick：扩展端反过来，从旧到新：`git cherry-pick <最旧> … <最新>`
- Revert：保持从新到旧：`git revert --no-edit <最新> … <最旧>`

选中的提交可以来自不同分支，也可以中间隔着别的提交，都按列表顺序处理。

### 协议（`src/protocol/messages.ts`）

`GitOperationRequest` 新增两种：
- `{ kind: 'cherryPickCommits'; hashes: string[] }`
- `{ kind: 'revertCommits'; hashes: string[] }`

校验：1～100 个、每个都是合法 hash、不重复。原来单个的 `cherryPick` / `revert` 保留，单选仍走它们。

### 扩展端（`src/git/GitOperationService.ts`）

- 执行前确认（多选才弹）：
  - `Cherry-pick 3 commits onto main?`，按钮 **Cherry-pick**；
  - `Revert 3 commits on main?`，说明「每个提交会生成一个 revert 提交」，按钮 **Revert**。
- 一条 Git 命令交给 Git 的 sequencer 逐个执行。
- **冲突**：Git 停下，仓库进入 cherry-pick / revert 状态，Log 和 Commit 窗口出现现有的 Continue / Skip / Abort 横幅。Continue 会接着执行剩下的提交；Abort 会回到操作前的 HEAD（整批撤销）。
- **改动已经存在（变成空提交）**：单个 cherry-pick 现在会自动 `--skip` 并提示。多个时 Git 会在空的那一个停下，扩展端循环处理：只要停下的原因是「没有冲突、没有可提交的内容」，就记下这个提交，`git cherry-pick --skip` 继续；遇到冲突就停下交给用户。全部完成后提示「已跳过 N 个改动已存在的提交：abc1234, …」。Revert 同样处理（`REVERT_HEAD`、`git revert --skip`）。`--skip` 在 Git 2.23 起可用，满足最低 2.27。
- 和其他写操作一样，走串行队列，执行前重新检查仓库状态；rebase / merge / cherry-pick 进行中时菜单里本来就不出现这两项。

## 边界情况

- **工作区有未提交改动**：会被覆盖时 Git 拒绝执行，原样显示 Git 的错误，仓库不变。
- **detached HEAD**：Git 允许，照常执行；确认框里写 `onto HEAD`。
- **选中的提交已经在当前分支上**：cherry-pick 结果为空，按上面自动跳过并提示。
- **revert 一个当前分支上没有的提交**：Git 会尝试反向应用，可能冲突，走冲突流程。
- **多仓库**：只作用于右键所在的仓库。
- **超大仓库**：最多 100 个提交，超过就置灰。

## 风险

- cherry-pick / revert 只会在当前分支上新增提交，不改写已有历史。
- 中途冲突时仓库停在 sequencer 状态，横幅可以 Continue / Skip / Abort；Abort 回到操作前。
- 自动跳过只在「没有冲突、暂存区为空」时发生，不会丢掉用户的改动。

## 测试计划

- 单测：协议校验（空数组、超过 100 个、重复、非法 hash）；Git 参数顺序（cherry-pick 从旧到新、revert 从新到旧）；菜单在多选时出现、文字带数量、含合并提交时置灰。
- 真实临时仓库：
  - 从另一个分支 cherry-pick 3 个不连续的提交，顺序正确；
  - 其中一个改动已存在 → 自动跳过、其余成功，提示里列出跳过的提交；
  - 中间一个冲突 → 停在 cherry-pick 状态；解决后 continue 完成剩下的；abort 回到原 HEAD；
  - revert 3 个提交 → 生成 3 个 revert 提交，顺序从新到旧，工作区内容正确；
  - 有未提交改动挡路时报错、仓库不变。
- e2e：Log 里切到另一个分支，⌘ 点选 2 个提交 → 右键 `Cherry-pick 2 Commits` → 确认 → `git log` 里出现这两个提交；再多选两个 → `Revert 2 Commits` → 出现两个 revert 提交。
- 手动：打包装进 Cursor，走一遍多选 cherry-pick、冲突后 Continue。

## 实际实现与偏差

- **空的 revert 不写 `REVERT_HEAD`**：cherry-pick 变空时 Git 留下 `CHERRY_PICK_HEAD`，revert 变空时却没有，只输出「nothing to commit」。所以判断「停在一个空提交上」改为：有 `CHERRY_PICK_HEAD` / `REVERT_HEAD`，或者 Git 输出含「nothing to commit」时取 `.git/sequencer/todo` 第一行的提交。被本地改动挡住时 Git 的输出不同，不会被误判成空提交而跳过。
- 单个 Cherry-pick 也改走同一段逻辑（`runSequence`），行为不变；单个 Revert 仍按原来直接执行。
- 合并提交置灰：单选、多选都生效。
- 多选时菜单里原有的 New Branch / Merge / Reset / Copy Hash 等仍只作用于右键点的那个提交，这是原来就有的行为，本次未改。
- 验证：单测（协议校验、参数顺序、菜单数量与置灰）；真实临时仓库（不连续 cherry-pick 顺序、带中文文件名、取消确认不动仓库、跳过已存在的改动、冲突后 Continue 完成剩余 / Abort 回到原 HEAD、revert 各生成一个提交、跳过已撤销的提交、本地改动挡路时仓库不变）；e2e `multi-cherry-pick` 4 项；集成测试通过。
