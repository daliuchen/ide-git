# F7 被其他扩展占用时提示并一键写入快捷键

- 日期：2026-11-03
- 状态：已实现
- 相关：0.5.0 的 F7 跨文件（design/2026-11-02-diff-file-navigation.md）；装了 IDE 快捷键插件（如 IntelliJ IDEA Keybindings）时 F7 被插件抢走

## 背景与目标

0.5.0 的 F7 跨文件依赖 IDE Git 自己绑定的 F7。其他扩展也绑定 F7 时，谁生效取决于扩展加载顺序，实测 IntelliJ 快捷键插件会赢，F7 只在当前文件里循环。现在只能看 README，把两条绑定手动加进用户快捷键文件。

目标：第一次从 IDE Git 打开 Diff 时，如果发现别的扩展也绑定了 F7 / Shift+F7，而用户快捷键文件里还没有 IDE Git 的绑定，弹一次提示，带「Add Shortcuts」按钮，点了就把两条绑定写进用户的 `keybindings.json`。

**不做的事**：
- 不在用户没点按钮时改任何文件。
- 不处理 F7 以外的快捷键冲突。

## 参照行为

IDE 本身没有这个问题（快捷键方案是统一的）。照 VS Code 扩展的常见做法：通知 + 按钮，「Don't Ask Again」后不再出现。

## 方案

- 新文件 `src/diff/f7Conflict.ts`（纯函数）：
  - `findCompetingF7Bindings(extensions)`：遍历 `vscode.extensions.all` 的 `packageJSON.contributes.keybindings`，找出除本扩展外绑定 `f7` / `shift+f7`（看 `mac` 或 `key`，按当前平台）的扩展名单。调试相关的绑定（`when` 只含 `debugState` / `inDebugMode`）不算，它们和 Diff 不冲突。
  - `hasIdeGitF7Bindings(text)`：用户快捷键文件里是否已有 `gitLogWorkbench.diff.nextChange`。
  - `insertIdeGitF7Bindings(text)`：在 JSON 数组最后一个 `]` 前插入两条绑定（带一行注释说明），处理空数组、结尾逗号、注释；文件不是数组形式时返回 undefined。
- **何时检查**：`DiffNavigator.open()` 第一次被调用时（即第一次从 Log / Commit 窗口打开 Diff），每个窗口最多检查一次。
- **用户快捷键文件的位置**：由 `context.globalStorageUri` 往上两级得到 `User/` 目录，取 `User/keybindings.json`。使用非默认配置（profile）时文件在别处，读不到就退回「打开快捷键 JSON 并复制两条绑定到剪贴板」。
- **提示**：`IDE Git: <扩展名> also uses F7, so F7 in diffs may not continue into the next file. Add IDE Git's F7 shortcuts to your keyboard shortcuts?`，按钮 **Add Shortcuts** / **Don't Ask Again**；不点就下次窗口再问。
- **Add Shortcuts**：读文件 → 插入 → 写回 → 打开该文件让用户看到；写之前在同目录留备份 `keybindings.json.ide-git-backup`。插入失败（格式认不出）时，改为打开 *Preferences: Open Keyboard Shortcuts (JSON)* 并把两条绑定复制到剪贴板，提示粘贴。
- 「Don't Ask Again」存在 `globalState`。
- 不新增 webview 协议消息，不新增 Git 命令。

## 边界情况

- 没有其他扩展绑定 F7：不提示。
- 用户已经手动加过：不提示。
- 文件不存在：新建，内容为只含两条绑定的数组。
- 文件带注释、结尾逗号（JSONC）：只做文本插入，不重新格式化原内容。
- 多个窗口同时打开：各自最多提示一次；写入前重新读文件，已存在就不重复写。

## 风险

会改用户的快捷键文件，所以：只在用户点按钮后写；写前留备份；只追加两条带 `when` 条件（`gitLogWorkbench.diffNavigation && textCompareEditorVisible`）的绑定，不影响 IDE Git 的 Diff 以外的任何地方。出问题删掉这两条或用备份恢复即可。

## 测试计划

- 单测：`findCompetingF7Bindings`（mac/key、调试绑定排除、本扩展排除）；`hasIdeGitF7Bindings`；`insertIdeGitF7Bindings`（空数组、有内容、结尾逗号、末尾注释、非数组返回 undefined）。
- e2e：加载 IntelliJ 快捷键插件启动 → 从 Log 打开 Diff → 出现提示 → 点 Add Shortcuts → 快捷键文件里有两条绑定 → F7 跨文件生效。
- 手动（Cursor）：你本机已经加过，确认不会再提示。

## 实际实现与偏差

- 检查挂在 `DiffNavigator` 的构造参数 `onOpen` 上：每次从列表打开 Diff 都调用，`F7ConflictAdvisor` 自己保证每个窗口只检查一次。
- 用户快捷键文件位置按「默认配置」推算（`globalStorageUri` 上两级）。使用了其他配置（profile）时会写到默认配置的文件里，在那种配置下不生效——扩展拿不到当前 profile 的路径，这次不处理；手动加的办法仍写在 README 里。
- 单测抓到一个 bug：最后一条绑定后面跟着注释（`} // mine`）时，插入会把注释吞掉，已改为保留最后一条与 `]` 之间的内容。
- 验证：单测 4 个（找冲突扩展：排除自己、排除只在调试时生效的绑定、mac/key 区分；插入：已有列表、空文件、空数组、结尾逗号、注释和字符串里的括号、非数组）；VS Code 1.144 + IntelliJ 快捷键插件实测 5 项：提示点名该插件、点 Add Shortcuts 后文件里有两条、文件被打开、之后 F7 能跨到 b.ts、不再重复提示。e2e 场景 `test/e2e/suites/f7-keybinding-conflict.mjs`（5 项）。它用本机已安装在 Cursor / VS Code 里的 IntelliJ 快捷键插件，没有安装时跳过——原本想让测试从 Open VSX 下载该插件，但运行时下载并执行第三方扩展被本机的自动权限检查拦下，改为只用本机已有的副本。顺带：e2e 的 runner 支持 `skip()`、函数形式的 `launch()`、`userKeybindings()`；Annotate 场景在冷启动时悬停卡片出现得慢，改成重试。
