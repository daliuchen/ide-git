# Annotate Previous Revision：沿着一行往前追 blame

- 日期：2026-11-03
- 状态：已实现
- 相关：对照 IDE 的 Git 功能后挑出的三项之一

## 背景与目标

Annotate 只显示每行**最后一次**改动。经常要问的是「这一行在被改之前是谁写的、为什么」——比如最后一次提交只是格式化或改名。现在只能复制 hash 去命令行 `git blame <hash>^`。

目标：在 Annotate 的悬停卡片里加 **Annotate Previous Revision**：打开该提交**之前**的文件版本（只读），并且这个版本也带 Annotate，光标停在对应的那一行。可以一直往前点下去。

**不做的事**：
- 不做 IDE 的「Annotate Revision」（打开该提交本身的版本）——它和当前文件在这一行上内容相同，用处不大。
- 不改现有的 Show Diff / Show in Git Log / Copy Hash。

## 参照行为

IDE：Annotate 栏右键 → Annotate Previous Revision，打开 `<commit>^` 时的文件并带注释，光标在对应行；新打开的文件里可以继续往前追。照搬。

## 方案

- **入口**：悬停卡片的链接行加一项 `$(history) Annotate Previous Revision`，仅在这一行有上一个版本时显示（`git blame --porcelain` 的 `previous <hash> <path>` 头，已经解析到 `BlameLine.previous`；新加的文件没有）。
- **命令**：`gitLogWorkbench.annotate.previousRevision(repositoryId, previousHash, previousPath, hash, sourceLine)`，内部命令，不进命令面板。
- **打开的文档**：复用 Diff 用的只读 revision 文档（`git-log-workbench:` scheme，`sideUri(repositoryId, { kind: 'revision', revision: previousHash, path: previousPath })`），标签标题是 `文件名 (previous 短hash)`。
- **让 revision 文档也能 Annotate**：`FileAnnotationController.load()` 现在只处理 `file:` 文档。对 revision 文档改为 `git blame --porcelain -w <revision> -- <path>`（不带 `--contents`，文档只读）。已有的手动开关（编辑器右键 Annotate）也对 revision 文档生效。
- **定位到对应的行**：
  - `parseBlamePorcelain` 额外记下每行在**被 blame 的那个提交**里的行号 `sourceLine`（porcelain 每组第一行是 `<hash> <源行号> <结果行号>`）。
  - 这一行在 `hash` 中位于 `sourceLine`；在父版本 `previousHash` 中的位置用 `git diff -U0 <previousHash> <hash> -- <previousPath> <path>` 的块头换算：落在块之前按偏移平移，落在被改的块里就停在该块在旧版本里的起始行。换算逻辑写成纯函数（和 F4 Jump to Source 用的行号映射思路相同，那里已有 `diff -U0` 解析，可抽出来共用）。
  - 打开后光标放到换算出的行并居中。
- **继续往前**：新打开的文档也带 Annotate，悬停卡片里同样有 Annotate Previous Revision。
- 不新增 webview 协议消息。

### Git 命令

- `git blame --porcelain -w <revision> -- <path>`（只读）
- `git diff -U0 --no-color <previous> <hash> -- <previousPath> <path>`（只读，带改名时两个路径都传）

## 边界情况

- 这一行在该提交里是新增的、文件也是新增的：没有 `previous`，不显示入口。
- 改名：`previous` 头里给的是旧路径，按旧路径打开和 blame。
- 合并提交：`previous` 只给第一个父提交，跟 `git blame` 一致。
- 二进制、超大文件：blame 失败时提示错误，不打开空文档。
- 未提交的行：已经没有这些链接（显示 "Not committed yet"）。
- 多仓库：按 `repositoryId` 找仓库根。

## 风险

全部是只读命令，不碰工作区。最坏情况是行号换算偏几行（打开的文件和注释本身是对的）。

## 测试计划

- 单测：`sourceLine` 解析；行号换算（块前、块后、块内、纯新增块、纯删除块）。
- 真实临时仓库：三次提交改同一行（A 写 → B 改 → C 格式化），在当前文件上 previous → 落在 B 版本、该行注释为 B；再 previous → A 版本、注释为 A；改名后的文件也能追到改名前。
- 手动（Cursor）：在一个历史较长的文件上连续点三次 Annotate Previous Revision，每次光标都停在同一行代码的对应位置。

## 实际实现与偏差

- **行号换算用两个 blob 直接 diff**：`git diff -U0 <previous>:<旧路径> <hash>:<路径>`，而不是按路径限定的提交间 diff。后者在改名时可能显示成「删一个、加一个」，块头会对不上。换算函数 `mapLineToOldSide` 放在 F4 用的 `worktreeLineMapping.ts` 里，共用块头解析。
- **标签标题**：文本文档的标签只能显示文件名，没法写成「文件名 (previous 短hash)」。在 URI 路径前加了短 hash 目录（`/<短hash>/<路径>`），同名文件打开多个版本时，标签旁的说明能区分开；内容仍按 query 读取。
- 编辑器右键（行号区）的 Annotate 开关也对这些只读版本生效，可以手动关掉。
- 实测发现：改名和修改在同一个提交里、且文件很小时，Git 自己的 blame 不会跟到改名前（相似度不够），这一行会被算在改名的提交上、没有上一个版本。这是 Git 的行为，不处理。
- 验证：`mapLineToOldSide` 单测；真实临时仓库（A 写 → B 改 → 改名 → C 格式化），`-w` 跳过格式化落在 B、往前一步到 A 的第 2 行；VS Code 1.144 e2e 5 项（悬停显示 B、打开改名前的 old.rb、光标在第 2 行、新文档也有注释、最早的提交不再显示该链接）。
