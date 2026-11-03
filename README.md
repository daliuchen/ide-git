<p align="center"><img src="images/icon-256.png" width="128" alt="IDE Git"></p>

<h1 align="center">IDE Git</h1>

<p align="center">The IntelliJ-style Git tool for Cursor and VS Code: a real Commit window, a Log that shows how branches differ, and diffs you can edit.</p>

<p align="center">
  <a href="https://open-vsx.org/extension/EthanLiuChen/ide-git"><img src="https://img.shields.io/open-vsx/v/EthanLiuChen/ide-git?label=Open%20VSX" alt="Open VSX"></a>
  &nbsp;English | <a href="README.zh-CN.md">简体中文</a>
</p>

![Commit window](images/c1-commit-window.jpg)

## What it solves

- **Commit part of your changes**: by file, chunk or line, without touching the staging area.
- **Edit while reviewing a diff**: the right side is the real file, so language features keep working.
- **See how two branches differ**: which commits you already have, which were cherry-picked, which are missing.
- **Stay out of the terminal**: rebase, reword, undo, cherry-pick and push from the UI, and continue or abort when something stops halfway.

Built on [ascenx/vscode-git-log](https://github.com/ascenx/vscode-git-log) (MIT); the original commit graph, file history and blame are kept.

## Installation

Search for **IDE Git** in the Extensions view of Cursor, or download the `.vsix` from [Releases](https://github.com/daliuchen/ide-git/releases) and run *Extensions: Install from VSIX…*.

Uninstall the original **Git Log** (`ascenx.git-log`) first if you have it.

## Getting started

1. **Open the Commit window**: run `IDE Git: Commit…`, or in Cursor open the **⌄** at the end of the side bar's icon row and pick **Commit**.
2. **Commit**: check files, double-click to review the diff, write a message and press `⌘Enter`; `⌘⌥Enter` commits and pushes.
3. **Commit part of a file**: expand it to check chunks, expand a chunk to check lines.
4. **Browse history**: the **Git Log** tab in the bottom panel. Click a branch on the left: **bold** commits are missing from the current branch, dimmed ones are already there, and **picked** ones were cherry-picked.

## Common tasks

| I want to… | How |
| --- | --- |
| Fix the last commit | Check **Amend** and commit |
| Undo the last commit, keep the changes | Log → right-click → **Undo Commit** |
| Reword, squash or reorder | Log → right-click → **Edit Commit Message…** / **Interactively Rebase from Here…** |
| Rebase onto master | **Fetch**, then right-click `origin/master` → **Rebase Current onto** |
| See what master has that I don't | Right-click the branch → **Compare with Current**, or **←** / **→** in the **Branch** filter |
| Take a commit from another branch | Show that branch → right-click the commit → **Cherry-pick** |
| Resolve conflicts | Handle them in the Commit window, then **Continue** (or **Skip** / **Abort**) in the banner |
| See where my branch stands | The status bar on the right shows `main ↑2 ↓1`; click it for Branches |
| Switch branches with uncommitted work | Check out as usual; if your changes are in the way, pick **Smart Checkout** to carry them over |
| Push or pull | **Push…** / **Pull** on the Log toolbar |
| Put work aside | Right-click files → **Shelve Changes…**; find them under **Stashes** on the Log toolbar, with their branch and time |
| Review a commit file by file | Double-click a file in **Changed Files**, then **F7** / **Shift+F7**: after the last change, press again to open the next file (also in the Commit window); the list selects the file being shown |
| See who changed each line | Editor right-click → *IDE Git → Annotate with Git Blame*; hover a line → **Show in Git Log** to jump to its commit, or **Annotate Previous Revision** to see who wrote it before |

## Screenshots

![Line-level selection](images/n3-lines-and-options.jpg)

![Another branch in the Log](images/log-branch-marks.jpg)

![Editable diff](images/c5-diff-lsp.jpg)

![Interactive rebase](images/c18-rebase-dialog.jpg)

![Push dialog](images/c13-push-dialog.jpg)

## Open the Commit window with ⌘9

Add to *Preferences: Open Keyboard Shortcuts (JSON)* (press again to hide the side bar):

```json
[
  { "key": "cmd+9", "command": "gitLogWorkbench.commit.open", "when": "activeViewlet != 'workbench.view.extension.gitLogCommit'" },
  { "key": "cmd+9", "command": "workbench.action.toggleSidebarVisibility", "when": "activeViewlet == 'workbench.view.extension.gitLogCommit'" }
]
```

## F7 with a keymap extension

If another extension also binds F7 (for example an IDE keymap), it may win over IDE Git's binding. IDE Git notices this the first time you open a diff and offers **Add Shortcuts**, which adds the two lines below to your keyboard shortcuts (keeping a backup). To add them yourself, put them in *Preferences: Open Keyboard Shortcuts (JSON)*; they only apply in diffs opened from IDE Git:

```json
[
  { "key": "f7", "command": "gitLogWorkbench.diff.nextChange", "when": "gitLogWorkbench.diffNavigation && textCompareEditorVisible" },
  { "key": "shift+f7", "command": "gitLogWorkbench.diff.previousChange", "when": "gitLogWorkbench.diffNavigation && textCompareEditorVisible" }
]
```

## Development

Node via asdf, dependencies via pnpm: `pnpm install && pnpm run test:unit && pnpm run package`. End-to-end tests in a real VS Code: `pnpm run test:e2e` ([test/e2e](test/e2e/README.md)). Contribution rules: [AGENTS.md](AGENTS.md).

## How this was built

The code was written mostly by AI ([Claude Code](https://claude.com/claude-code)). The author decided what to build and how it should behave, and uses it day to day; every change passed type checks, lint, unit tests and VS Code integration tests, and the main flows were tried in a real editor. Issues are welcome.

## License

[MIT](LICENSE)
