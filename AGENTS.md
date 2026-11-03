# IDE Git 开发规范

给在这个仓库里工作的人和 AI agent（Claude Code、Cursor、Codex 等）看。`CLAUDE.md` 只是引用本文件，规则以这里为准。

## 项目速览

- Cursor / VS Code 扩展，fork 自 [ascenx/vscode-git-log](https://github.com/ascenx/vscode-git-log)。扩展 ID `EthanLiuChen.ide-git`（Open VSX 命名空间 `EthanLiuChen`）。
- `src/`：扩展端（Node）。`src/git/` 封装 Git 命令，`src/commit/` 是 Commit 窗口，`src/dialogs/` 是 Push / Rebase 对话框，`src/protocol/` 是 webview 消息协议。
- `webview/src/`：React 写的界面。`App.tsx` 是 Log，`commit/` 是 Commit 窗口，`dialog/` 是对话框。
- `test/unit/`：vitest 单测；`test/integration/`：在 VS Code 1.85.2 里跑的集成测试；`test/e2e/`：用 Playwright 驱动真实 VS Code 的端到端测试（见 `test/e2e/README.md`）。
- `design/`：技术方案（见规则二）。

### 环境

- Node 用 **asdf** 管理（`.tool-versions`），依赖用 **pnpm** 装。不要用 npm/yarn 装依赖，不要改全局 Node。
- 需要 Python 时用 **conda** 建专用环境，不要往系统里装包。

### 常用命令

```bash
pnpm run typecheck          # tsc --noEmit
pnpm run lint               # eslint
pnpm run test:unit          # vitest
pnpm run test:integration   # VS Code 1.85.2 集成测试
pnpm run test:e2e           # 真实 VS Code 1.144 端到端测试（macOS，几分钟）
pnpm run package            # 打出 .vsix
cursor --install-extension ide-git-<版本>.vsix --force   # 装到本机 Cursor 试用
```

---

## 规则一：创建 PR

### 什么时候提

- 一个 PR 只做一件事：一个需求、一个修复或一次重构。顺手发现的问题另开 PR。
- **agent 不主动推送或开 PR**：只有用户明确说「提 PR」「推上去」时才做。默认只在本地提交。

### 分支

- 从最新的 `main` 拉分支：`git switch main && git pull --rebase && git switch -c <type>/<简短描述>`。
- 分支名：`feat/branch-compare`、`fix/cherry-pick-empty`、`refactor/commit-window`、`docs/readme-zh`、`chore/deps`。全小写，用 `-` 连接。
- 不直接往 `main` 提交，不对 `main` 做 force push。

### 提交

- 提交信息用 Conventional Commits，英文，祈使语气：`type(scope): summary`，首行不超过 72 个字符。
  - `type`：`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf`。
  - `scope` 可选：`log`、`commit`、`push`、`cherry-pick` 等。
- 正文写**为什么**改、行为有什么变化，不要复述代码。
- 用仓库级的个人邮箱 `chen.liu386@gmail.com` 提交，不要改全局 git 配置。
- 不提交 `.vsix`、`dist/`、`node_modules/`、`.vscode-test/`。

### 提 PR 之前必须全部通过

1. `pnpm run typecheck`、`pnpm run lint`、`pnpm run test:unit` 全绿。
2. 改了 Git 行为、扩展激活、命令注册时，还要跑 `pnpm run test:integration`。
3. 改了界面或交互时，跑 `pnpm run test:e2e`，并给新功能在 `test/e2e/suites/` 里加一个场景；再用 `pnpm run package` 打包装进 Cursor，亲手走一遍改动涉及的流程，并截图。
4. 用户能感知到的变化：更新 `CHANGELOG.md` 顶部版本段落，并**同时**更新 `README.md`（英文）和 `README.zh-CN.md`（中文）。
5. 有技术方案的需求，方案文档（`design/…`）要随 PR 一起提交，并补上「实际实现与偏差」一节。

### 发版

- 合并到 `main` 后，`.github/workflows/release.yml` 会检查 `package.json` 的版本号：没有对应的 `v<版本>` tag 时，自动测试、打包、打 tag、建 GitHub Release（说明取自 CHANGELOG 对应段落），并发布到 Open VSX；版本号没变就什么都不做。
- 要发新版本：在 PR 里把 `package.json` 的 `version` 按语义化版本升一级（修复升 patch，新功能升 minor），并在 `CHANGELOG.md` 顶部写好这一版的 `## <版本>` 段落。缺这一段，发版会失败。
- Open VSX 用受信任发布（OIDC），仓库里不存 token。
- 几个都升了版本的 PR 要**逐个合并**：合一个，等它的发版跑完，再把下一个 rebase 到最新 `main`（会在版本号和 CHANGELOG 顶部冲突）后合并。发版 workflow 在同一个并发组里排队，排进第三个时会取消还在等待的那个，连续合并可能漏发版本。

### PR 标题和描述

- 标题和提交信息同一格式，例如 `feat(log): mark commits already cherry-picked`。
- 用 `gh pr create --base main` 创建；检查没跑完前先开成 Draft。
- 描述按下面的模板写：

```markdown
## 背景
为什么要做（用户遇到的问题、截图或复现步骤）。技术方案：design/2026-11-01-xxx.md

## 改了什么
- 用户能看到的变化
- 关键实现点（涉及的模块、新的协议消息、调用了哪些 Git 命令）

## 怎么验证的
- [ ] typecheck / lint / unit 通过
- [ ] integration 通过（如涉及）
- [ ] 在 Cursor 里手动验证：步骤 1 → 2 → 3，结果……
- 截图 / 录屏

## 风险与回滚
可能影响到的其他功能；出问题时怎么回退。
```

- review 意见用新的提交修改，不要 force push 覆盖别人已经看过的提交；合并时用 squash merge。

---

## 规则二：实现一个需求

### 先判断要不要写技术方案

**可以直接做**（不用写方案）：改文案、改样式、修一个原因明确的小 bug、改动只涉及一两个文件且不改变已有行为。

**必须先写技术方案**，满足任一条：
- 新功能，或改变已有功能的行为；
- 新增或修改 webview ↔ 扩展的协议消息；
- 新增会改写仓库状态的 Git 操作（提交、rebase、reset、push、stash 等）；
- 删除功能；
- 预计改动超过约 150 行，或跨 `src/` 和 `webview/` 两端。

### 方案放在哪

- 目录：`design/`（注意 `docs/` 被 `.gitignore` 忽略了，不要放那里）。
- 文件名：`design/YYYY-MM-DD-<英文短描述>.md`，例如 `design/2026-11-01-branch-compare.md`。
- 从 `design/_template.md` 复制开始写。
- 方案写好后**先给用户确认**，确认后再写代码；需求有歧义时先问清楚，不要猜。

### 方案里要写清楚

1. **背景与目标**：用户遇到什么问题，要达到什么效果；明确不做什么。
2. **参照行为**：IDE 里同类功能是怎么做的，哪些照搬、哪些有意不同。
3. **方案**：涉及哪些文件和模块；数据怎么流动；新增或修改了哪些协议消息；具体执行哪些 Git 命令和参数。
4. **边界情况**：没有远程、detached HEAD、合并/rebase 进行中、有冲突、多仓库、超大仓库、路径带空格或中文、窗口很窄。
5. **风险**：会不会改坏用户的仓库；出错时仓库停在什么状态、怎么恢复。
6. **测试计划**：要加哪些单测；改 Git 行为必须有用真实临时仓库的测试；手动验证步骤。

### 做完以后

- 按方案里的测试计划全部跑过；改 Git 行为时，用 `git status` / `git log` 核对仓库最终状态。
- 在方案文档末尾补「实际实现与偏差」：和方案不一样的地方及原因。
- 按规则一更新 CHANGELOG 和两份 README。

---

## 规则三：代码风格

### 通用

- TypeScript 严格模式（`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`），不要用 `any`，也不要用 `as` 绕过类型检查；可选字段要显式写 `| undefined` 时才能赋 `undefined`。
- 只引入类型时用 `import type`（eslint 强制）。
- 格式和现有代码一致：2 空格缩进、单引号、语句结尾加分号、多行时末尾加逗号。
- 命名：函数、变量用 camelCase，类型和组件用 PascalCase，常量用 UPPER_SNAKE_CASE；名字要表达用途，不要用缩写。
- 代码、注释、界面文字都用英文。注释写**为什么**，不写代码在做什么；改代码时注释保持和现有密度一致，不要堆注释。
- 不要在源码、README、测试里出现其他 IDE 厂商的品牌名（有测试会拦），写「IDE-style」。
- 新增依赖要有充分理由，用 `pnpm add` 安装。

### 调用 Git

- 只能通过 `GitRunner.run(args数组, options)` 调用 Git，**不允许拼 shell 命令字符串**。
- 来自 webview 或用户输入的值，传给 Git 前必须校验：hash 用 `validateHash`，分支名、远程名等用 `validateToken`；路径前加 `--`；修订版本前尽量加 `--end-of-options`（`rev-parse` 在 Git 2.30 前不支持，用已知的完整 ref 名代替）。
- 会改写仓库的操作走 `GitOperationService`：有串行队列，执行前重新检查仓库状态，破坏性操作要有确认对话框。
- 最低支持 Git 2.27，用到新参数时先确认版本。
- 不保存任何凭据，认证交给 Git 自己。

### 扩展端 ↔ webview

- 消息类型定义在 `src/protocol/messages.ts`、`src/commit/commitProtocol.ts`、`src/dialogs/dialogProtocol.ts`。
- 扩展端收到的每条消息都要先经过对应的 `parse…` 函数校验；新增消息时同时补上校验和测试。

### 界面（webview）

- 用 React 函数组件和 hooks。复杂的状态逻辑抽成纯函数模块单独测试（参考 `webview/src/commit/selectionModel.ts`）。
- 颜色只用 VS Code 主题变量（`var(--vscode-…)`），浅色、深色、高对比主题都要能看清。
- 图标用 codicons（`<i className="codicon codicon-…">`）。
- 鼠标悬停提示用 `title` 属性：`webview/src/tooltip.ts` 会把它画出来，因为 Cursor 的 webview 不显示原生提示。
- 面板变窄时要能正常使用，不能出现横向滚动条，也不能让内容被挤没。
- 同一时间只显示一个弹出层（菜单、弹窗、下拉）。

### 测试

- 单测放在 `test/unit/`，用 vitest。
- Git 行为用 `mkdtemp` 建真实的临时仓库测试，测完删除；不要只用 mock 验证 Git 命令的效果。
- 界面测试用 Testing Library 按角色和可访问名称查找元素（`getByRole('button', { name: … })`），不要依赖 class 名。
- 修 bug 时先写一个能复现问题的测试。
