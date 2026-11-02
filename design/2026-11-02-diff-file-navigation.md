# Changed Files 高亮当前文件 + F7 跨文件翻 Diff

- 日期：2026-11-02
- 状态：已实现
- 相关：用户反馈（截图：Log 里双击打开 `offline_recharge_voucher_uploader.rb` 的 Diff 后，右侧 Changed Files 里看不出是哪一个；F7 翻到最后一处改动后不会进入下一个文件）

## 背景与目标

1. **找不到当前文件**：Log 右侧 Changed Files 里，正在编辑器里看的那个文件没有任何标记；单击选中的行也没有高亮（只有 hover 色）。文件一多就要逐行找。
2. **F7 不跨文件**：F7 现在是编辑器自带的「下一处改动」，只在当前 Diff 里循环。看一个提交的改动时，要回到列表双击下一个文件，打断节奏。

目标：

- Changed Files 里**高亮编辑器当前打开的文件**（Diff 或普通编辑器都算），必要时滚动到可见位置；单击选中的行也有选中色。
- 在从 Log 打开的 Diff 里，F7 到最后一处改动后**再按一次 F7 打开下一个文件的 Diff**，并停在它的第一处改动；Shift+F7 反方向。

**不做的事**：

- 不改双击打开 Diff 的方式，不新增「一次打开所有文件」的视图。

## 参照行为

IDE 里在提交的 Diff 中：F7 走到最后一处差异时，编辑器顶部提示「Press F7 again to go to the next file」，再按才切到下一个文件；Shift+F7 同理到上一个文件。文件顺序和 Changed Files 列表一致。Changed Files 里当前查看的文件会被选中。

照搬：「到末尾先提示、再按一次才切文件」——避免一路按 F7 时不知不觉换了文件。
有意不同：提示用状态栏消息（VS Code 扩展不能在 Diff 编辑器里画浮层）。

## 方案

### 一、高亮当前文件

- 扩展端（`src/extension.ts` / `WorkbenchViewProvider`）监听 `window.onDidChangeActiveTextEditor` 和 `tabGroups.onDidChangeTabs`，算出当前活动标签对应的「仓库 + 仓库内路径」：
  - 普通文件：`file:` URI → 找所属仓库 → 相对路径（用 realpath，处理 /tmp 软链）；
  - Diff 标签：取右侧（modified）；右侧是本扩展的 revision 文档时，从 query 里取路径。
- 新增扩展 → webview 消息 `activeEditorFile { repositoryId?: string; path?: string }`（没有相关文件时两个字段都不带）。webview 打开时也补发一次当前值。
- webview（`App.tsx`）：`ChangedFileRow` 增加 `active`（=当前编辑器文件）和 `selected`（=单击选中）两种状态：
  - 选中：`--vscode-list-inactiveSelectionBackground`；
  - 当前编辑器文件：行左侧 2px 竖条 `--vscode-list-focusOutline` + 文件名加粗。两者可同时出现。
  - 当前编辑器文件变化且在列表里时，`scrollIntoView({ block: 'nearest' })`；树视图里所在目录折叠着就展开。
- 换提交后，如果当前编辑器文件也在新提交的改动里，照样高亮。

### 二、F7 / Shift+F7 跨文件

**导航会话**：从 Log 打开 Diff 时（`openDiff` 消息），webview 额外带上当前列表**显示顺序**的文件路径 `navigationPaths: string[]`（树视图按树的顺序，列表视图按列表顺序；二进制文件排除）。扩展端记下：

```
DiffNavigationSession { repositoryId, hash, parent, files: ChangedFile[]（按显示顺序）, index, leftUri, rightUri }
```

只保留最近一次；对应的 Diff 标签被关掉或用户切到别的提交后，会话失效。

**命令**：新增 `gitLogWorkbench.diff.nextChange` / `gitLogWorkbench.diff.previousChange`，并设一个上下文键 `gitLogWorkbench.diffNavigation`——活动编辑器是会话里的 Diff 时为 true。

```
F7 → 命令 nextChange
   1. 记下 modified 编辑器光标行 before
   2. 执行编辑器自带 workbench.action.compareEditor.nextChange
   3. 读光标行 after：after > before → 正常前进，结束
   4. 否则（已在最后一处，编辑器绕回第一处）：
        把光标放回 before；
        第一次：状态栏提示「Press F7 again to open next file: <文件名>」（3 秒）；
        3 秒内再按：打开 files[index+1] 的 Diff（复用 DiffManager.open，同一个预览标签被替换），
                    光标放到第一处改动；Log 的选中和高亮跟着变到这个文件。
   最后一个文件的最后一处：提示「Last change in the last file」，不绕回。
```

Shift+F7 对称（判断 after < before，否则去上一个文件，停在最后一处改动）。

- 「是否在最后一处」不自己算 diff，靠编辑器自带命令是否绕回来判断——和编辑器显示的改动块完全一致，不会出现我们算的块和编辑器画的块对不上。
- 打开下一个文件后要等 Diff 计算完才能跳到第一处：等 `onDidChangeVisibleTextEditors` 后执行一次 `compareEditor.nextChange`（光标在第 1 行时它就跳到第一处）。新文件（左侧为空）只有一块，直接停在第 1 行。

**快捷键**：`package.json` 贡献 `f7` / `shift+f7`，`when: gitLogWorkbench.diffNavigation`。

- 注意：IntelliJ 快捷键插件也把 F7 绑到 `compareEditor.nextChange`。两个扩展都贡献同一个键时谁生效看加载顺序，不可靠。所以：
  - 我们的命令在会话外的 Diff 里退化成原生 nextChange，绑上也不影响别处；
  - README 写明：装了这类快捷键插件时，把下面两条加进用户 keybindings.json（用户级优先于所有扩展）；
  - 你本机的 Cursor 我直接加进 `keybindings.json`（像 ⌘9 那次一样，先备份）。

### 协议变更

- webview → 扩展：`openDiff` 增加可选 `navigationPaths: string[]`（`parse…` 校验：字符串数组、长度上限 5000、每个都要在当前提交的改动里才采用）。
- 扩展 → webview：新增 `activeEditorFile`。

### Git 命令

不新增。下一个文件的 Diff 复用已有的 `DiffManager.open`（读取 revision 内容，只读）。

## 边界情况

- 合并提交：会话按当前选中的 parent；切 parent 后会话失效（重新双击一次即可）。
- 文件改名：按新路径高亮；Diff 右侧为空（删除的文件）时按 `path` 匹配。
- 二进制文件：不在导航顺序里，F7 直接跳过。
- 多仓库：高亮只在 `repositoryId` 等于 Log 当前仓库时生效。
- 用户在 Diff 里点进右侧的真实文件做了编辑：仍算同一个 Diff，F7 照常。
- Diff 设为 inline 模式：编辑器自带命令同样可用，判断方式不变。
- 面板很窄：竖条和加粗不占额外宽度。

## 风险

只读功能，不碰仓库。最坏情况：判断「绕回」出错导致提前切到下一个文件——用户再按 Shift+F7 回来即可。快捷键冲突时最多是 F7 保持原来的行为。

## 测试计划

- 单测：
  - 导航会话的纯函数：下一个/上一个文件、首尾边界、跳过二进制、`navigationPaths` 与提交文件不一致时回退到原顺序；
  - 「是否绕回」判断（before/after 行号）与「再按一次」的 3 秒窗口；
  - 活动标签 → 仓库内路径（file、Diff、revision scheme、软链路径）；
  - `openDiff` 的 `navigationPaths` 校验；webview 的高亮/选中（Testing Library 按 `aria-current` / `aria-selected` 找）。
- 集成测试（VS Code 1.85.2）：打开一个 3 文件提交的 Diff，执行 nextChange 到末尾 → 两次后活动 Diff 变成第 2 个文件。
- 手动验证（Cursor，开着 IntelliJ 快捷键插件）：
  1. Log 选提交 → 双击第一个文件 → 列表里该行高亮；
  2. 一路 F7：文件内逐块前进 → 末尾出现提示 → 再按打开第 2 个文件、停在第一处改动、列表高亮跟过去；
  3. Shift+F7 能回到上一个文件的最后一处；
  4. 在资源管理器里打开一个属于该提交的普通文件 → 列表同样高亮；
  5. 树视图、列表视图各走一遍。

## 确认结果

- 用户选择「按方案做」，并要求 **Commit 窗口一起做**。

## 实际实现与偏差

- **Commit 窗口也支持**：`action` 消息（`showDiff`，单个文件时）带上 `navigation: ChangeRef[]`，顺序 = 树里的显示顺序（目录在前，包括折叠的节点，跳过冲突文件）。扩展端 `CommitViewHooks.openDiffSequence` 交给同一个 `DiffNavigator`。第一次打开沿用原来的 preview / preserveFocus，之后 F7 打开的都抢焦点。
- **`navigation` 直接带完整目标**（hash、parent、path、oldPath、status），而不是只带路径：Log 里比较分支范围时每个文件的 hash/parent 可能不同，扩展端不用再查。
- **选中跟随编辑器**：方案只写了「高亮」。实测发现单击过的行有背景色、而真正打开的文件只有竖条，前者反而更像「当前」。改为编辑器切换到列表里的文件时，选中也跟过去（IDE 同样如此）。
- **快捷键冲突确认存在**：e2e 里同时加载 IntelliJ 快捷键插件时，F7 走的是插件绑定的原生命令；不加载插件、或在用户 keybindings.json 里加两条绑定后全部通过。README 写了这两条；扩展本身不改用户的快捷键文件。
- **集成测试改为单测 + e2e**：「绕回」判断需要真实的 Diff 计算，VS Code 1.85 集成测试里不好驱动键盘，改用模拟编辑器的单测（`test/unit/DiffNavigator.test.ts`）覆盖逻辑，用 VS Code 1.144 + Playwright 走真实键盘：Log 7 项、Commit 窗口 5 项检查全过。
- 打开下一个文件后先把光标放到文件另一头，再执行一次编辑器自带的上/下一处改动命令（它会绕回到第一/最后一处）；Diff 是异步算出来的，所以每 100ms 重试一次，最多 2 秒。这样第一行就是改动的文件也不会被跳过。

