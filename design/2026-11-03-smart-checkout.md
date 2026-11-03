# Smart Checkout：本地改动挡住 checkout 时自动 stash

- 日期：2026-11-03
- 状态：已实现
- 相关：对照 IDE 的 Git 功能后挑出的三项之一

## 背景与目标

切分支时，如果本地改动会被覆盖，Git 拒绝 checkout，现在 IDE Git 直接弹出 Git 的报错，用户只能自己去 stash、切换、再恢复。

目标：checkout 被本地改动挡住时，弹出对话框列出冲突的文件，提供三个选择：
- **Smart Checkout**：stash 本地改动 → checkout → 恢复改动；
- **Force Checkout**：丢弃这些文件的本地改动后 checkout；
- **Cancel**。

**不做的事**：
- 不处理「切换后恢复 stash 时产生冲突」之外的自动合并策略；冲突留给用户在 Commit 窗口解决。
- 不改 pull / merge / rebase 被本地改动挡住的情况（这次只做 checkout 类操作）。

## 参照行为

IDE：checkout 失败时弹出「Git Checkout Problem」，列出会被覆盖的文件，按钮 Smart Checkout / Force Checkout / Don't Checkout。Smart Checkout 会先 shelve/stash，切换后再恢复；恢复有冲突时打开冲突解决。
照搬三按钮与流程；有意不同：文件列表放在模态对话框的详情文字里（最多列 10 个，其余写「and N more」），不做单独窗口。

## 方案

- 适用的操作：`checkout`、`checkoutRemote`、`checkoutDetached`、`switchPrevious`、`checkoutAndRebase`（Log 右键、Branches 弹窗、对话框里发起的都走 `GitOperationService.run`，所以只改这一处）。
- `GitOperationRunOptions` 新增可选回调 `resolveCheckoutConflict(files): Promise<'smart' | 'force' | undefined>`。三个调用处（`WorkbenchController`、`BranchesPopup`、`GitDialogs`）都传同一个实现 `src/git/checkoutConflictPrompt.ts`（`showWarningMessage` 模态，详情里列文件，按钮 Smart Checkout / Force Checkout）。没传回调时行为不变（直接报错）。
- 新文件 `src/git/checkoutConflicts.ts`（纯函数）：从 Git 的报错里识别两种情况并取出文件列表：
  - `Your local changes to the following files would be overwritten by checkout:`
  - `The following untracked working tree files would be overwritten by checkout:`
  文件是这两行之后、`Please commit your changes…` / `Please move or remove them…` 之前以 Tab 开头的行。
- 流程（在操作队列内执行，期间不会插入别的操作）：

```
checkout 失败，且是上述报错 → resolveCheckoutConflict(files)
  Cancel → 返回 cancelled
  Smart →
    git stash push --include-untracked -m "IDE Git smart checkout: <from> → <to>"
    重新执行 checkout
      失败 → git stash pop（放回原样）→ 抛出 checkout 的错误
    git stash pop
      成功 → 完成，提示 "Checked out <to>; local changes restored."
      有冲突 → 完成，提示 "Checked out <to>. Restoring local changes caused conflicts: resolve them in the Commit window. The changes are kept in stash@{0} until you drop it."（Git 冲突时不会删除 stash）
  Force →
    已跟踪文件被覆盖：git checkout -f <同样的参数>
    未跟踪文件被覆盖：先删除列出的这些未跟踪文件（只删列出的，路径校验在仓库内），再 checkout
```

- 只有用户点了按钮才会改动工作区；Force 的对话框明确写 "Force Checkout discards your local changes to these files."。
- 不新增 webview 协议消息（对话框在扩展端弹出）。

### Git 命令

- `git stash push --include-untracked -m <message>`
- 原 checkout 命令；Force 时加 `-f`（`checkout -f` / `switch --discard-changes`，Git 2.23+；最低支持 2.27，可用）
- `git stash pop`

## 边界情况

- 没有当前分支（detached）：消息里的 `<from>` 用短 hash。
- merge / rebase 进行中：`run()` 已经拒绝 checkout，不会走到这里。
- 子模块改动：`stash` 不处理子模块内容；报错里出现子模块路径时，Smart 失败后已放回原样并显示 Git 报错。
- 路径带空格或中文：Git 报错里路径可能被加引号（`core.quotePath`），解析时去引号并按 C 风格转义还原；Force 删除未跟踪文件前校验路径在仓库内且确实未跟踪。
- 多仓库：按操作所属仓库执行。

## 风险

- Smart：最坏情况是恢复时有冲突，改动仍完整保存在 stash 里，提示里写明。checkout 失败时先把 stash 放回，仓库回到操作前状态。
- Force：会丢弃改动，只在用户在模态框中明确点击后执行。

## 测试计划

- 单测：两种报错文本的解析（含带引号的中文路径、超过 10 个文件的截断文字）。
- 真实临时仓库（`GitOperationService`）：
  1. 两个分支对同一文件有不同内容，本地改了该文件 → Smart → 切过去，改动恢复，stash 列表为空；
  2. 恢复时冲突 → 切过去，文件有冲突标记，stash 仍在；
  3. Force → 切过去，本地改动消失；
  4. 未跟踪文件挡路 → Smart 与 Force 各一次；
  5. Cancel → 仍在原分支，改动原样；
  6. 不传回调 → 行为与现在一致（抛出 Git 错误）。
- 手动（Cursor）：Branches 弹窗、Log 右键各走一次 Smart Checkout。

## 实际实现与偏差

- **不含 `checkoutAndRebase`**：它跑的是 `git rebase <onto> <branch>`，被本地改动挡住时 Git 报的是「cannot rebase: You have unstaged changes」，不是 checkout 的报错，这次不处理。
- 恢复失败时分两种提示：有冲突文件（`git diff --diff-filter=U`）就让用户去 Commit 窗口解决；没有冲突、只是同名文件已存在（未跟踪文件挡路的情况）就说明改动留在 stash 里，去 Stashes 里恢复。两种情况 stash 都保留。
- checkout 失败后放回 stash 时先试 `stash pop --index`（保留暂存状态），失败再退到普通 `stash pop`。
- Branches 弹窗和对话框原来不显示操作返回的 notice，这次补上（Log 本来就显示）。
- 验证：解析单测 3 个；真实临时仓库 6 个场景（恢复成功、恢复冲突、未跟踪文件、Force、Cancel、不传回调）；VS Code 1.144 e2e：Branches 弹窗 checkout → 对话框列出文件 → Smart Checkout → 已切换、改动保留、有提示。
