# Annotate：从注释跳到 Git Log 里的对应提交

- 日期：2026-11-02
- 状态：已实现
- 相关：用户反馈「开启 blame 后，希望点击直接打开 Git Log 并定位到对应的 commit」

## 背景与目标

开启 Annotate 后，想看某一行是哪个提交改的、那个提交前后还改了什么，现在只能复制 hash 再去 Log 里搜。目标：从这一行**一步**跳到 Git Log，选中对应提交，右侧显示它改的文件。

**不做的事**：
- 不做「点击注释本身」：VS Code 的行内注释（decoration）没有点击事件，扩展拿不到点击（GitLens 也是靠悬停卡片里的链接）。
- 不改变 Log 里已有的分页和加载方式。

## 参照行为

IDE 里在注释栏上点击会弹出提交详情，再选「Show in Git Log」跳到日志并选中该提交。这里用悬停卡片代替弹出卡片，效果相同。

## 方案

### 入口（三个）

1. **悬停卡片**：在现有的 `Show Diff · Copy Hash` 前面加 **Show in Git Log**。
2. **编辑器右键菜单** → *IDE Git → Show Commit in Git Log*：针对光标所在行，不需要先开 Annotate。
3. **命令** `IDE Git: Show Commit in Git Log`，可以自己绑快捷键。

### 流程

```
入口 → 命令 gitLogWorkbench.showCommitInLog(仓库, hash)
     → WorkbenchViewProvider.revealCommit()：先聚焦 Git Log 面板，等 webview 就绪
     → WorkbenchController.revealCommit(repositoryId, hash)
         1. 筛选条件重置为默认（当前分支，无文本、作者、日期、路径筛选），保证提交一定在列表里
         2. git rev-list --date-order HEAD 找到该提交在列表中的位置 index
         3. 从 max(0, index - 20) 开始加载一页，记住选中 hash，滚动到该行
         4. 复用现有的 repositoryData（replace + startLogOffset + scrollTop + selectedHash）把结果发给界面
```

- 入口 2 和 3 需要知道光标行属于哪个提交：已开 Annotate 时直接用已有的 blame 结果；没开时执行 `git blame --porcelain -L <行>,<行> --contents - -- <路径>`（带上编辑器里未保存的内容）。
- **webview ↔ 扩展的协议不新增消息**，复用 `repositoryData`。新增的是扩展内部的方法和一个命令。

### 执行的 Git 命令

- `git rev-list --date-order HEAD`：只读，用来找位置。
- `git blame --porcelain -L n,n --contents - -- <路径>`：只读。

## 边界情况

- **这一行还没提交**：不跳转，提示「这一行还没有提交」。
- **提交不在当前分支的历史里**（比如文件是从别的分支 checkout 出来的工作区内容）：rev-list 找不到时，改用 hash 作为文本筛选，只显示这一个提交，并提示。
- **超大仓库**：rev-list 输出几十万行时读取需要一两秒，加进度提示；只读取到找到为止，找到后立刻停止。
- **跳到很靠后的位置**：从中间开始加载时，最上面几行的分支连线可能不完整（和现在恢复深分页滚动位置时一样）。
- **用户正在 Log 里用筛选**：筛选会被重置，筛选按钮恢复成默认状态。这样做是为了保证一定能看到目标提交。
- **多仓库工作区**：按文件所在的仓库切换 Log 的当前仓库。

## 风险

全部是只读的 Git 命令，不会改动仓库。最坏情况是定位失败，Log 停留在原来的位置并弹出提示。

## 测试计划

- 单测：
  - `revealCommit` 计算的偏移量和滚动位置（使用真实临时仓库，提交数量超过一页，目标在第一页之外）
  - 找不到提交时退回 hash 筛选
  - 光标行 blame 的解析（已提交、未提交两种情况）
- 手动验证（在 Cursor 里）：
  1. 对一个有很多历史的文件开启 Annotate，悬停一行较老的代码 → Show in Git Log → Log 打开，目标提交被选中并在可见区域，右侧显示它改的文件。
  2. 不开 Annotate，右键 → Show Commit in Git Log，结果同上。
  3. 在未提交的行上操作 → 显示提示，不跳转。

## 实际实现与偏差

- **协议加了一个可选字段**：方案里写「不新增消息」，实际给已有的 `repositoryData` 加了可选的 `revealHash`。原因：只靠恢复滚动位置时，如果新的加载起点和原来一样，列表不会重新滚动；`revealHash` 让列表在数据到达后滚到目标提交（复用列表已有的滚动到提交的逻辑）。
- 目标提交上方保留 5 行（`REVEAL_CONTEXT_ROWS`），往上滚就能看到更新的提交；列表本身把目标滚到可见区域顶部。
- 找位置时一次读完 `rev-list` 的输出，没有做「找到就停」。几十万个提交也只有十几 MB，读取在一两秒内；以后真遇到慢再改成流式读取。
- 没开 Annotate 时，按光标行执行一次 `git blame -L`，带上编辑器里未保存的内容。
- 顺带修了 Annotate 遇到软链接路径（macOS 的 /tmp）会报错的问题（PR #2）。
