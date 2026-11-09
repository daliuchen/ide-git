# Changelog

All notable changes to IDE Git are documented in this file.

## 0.13.0

- Worktrees: `IDE Git: Manage Worktrees…` lists the repository's worktrees and creates one for a local, remote or new branch (in a folder next to the repository by default), switches this window to it, opens it in a new window, adds it to the workspace, reveals it or removes it. A worktree with uncommitted changes is only deleted after a second confirmation; stale entries can be pruned.
- The Log's branch list has a **Worktrees** group above Tags: click a worktree to show its branch in the Log, double-click to switch this window to it, right-click for the other actions; **New Worktree from Here…** on any branch.
- While the Log shows another branch, the Branch filter's clear button is now **↩ Back to <current branch>**: one click returns to this worktree's history.
- A branch checked out in another worktree is marked in the Log and in Branches; instead of Git's error, Checkout offers to switch to that worktree.

## 0.12.1

- Dialogs (Merge, Push, rebase) in a short editor area no longer draw the commit list over the options below it; the dialog scrolls instead.

## 0.12.0

- Manage Remotes: list the repository's remotes with their URLs (credentials hidden) and add, edit the URL of, rename, fetch, copy or remove one. Open it with `IDE Git: Manage Remotes…`, the ⚙ next to **Remote** in the Log's branch list, or from Branches. Removing asks first.

## 0.11.0

- Merge dialog: **Merge…** (next to Merge into Current in the Log's branch and commit menus, in Branches, and as `IDE Git: Merge…`) lists the commits that will come in and lets you choose how: the default, always create a merge commit (`--no-ff`), fast-forward only (`--ff-only`) or squash (`--squash`, then commit it in the Commit window), optionally stopping before the commit, with your own merge message. Merge into Current still merges right away.

## 0.10.0

- Stashes: each stash shows the branch it was made on and when, next to its message (Git's "On main:" prefix is no longer repeated in the message). Hover for the stash ref and the full date.

## 0.9.0

- When another extension (an IDE keymap, for example) also binds F7, IDE Git says so the first time you open a diff and offers **Add Shortcuts**: it adds its two F7 / Shift+F7 shortcuts to your keyboard shortcuts file (keeping a backup) so F7 continues into the next file. **Don't Ask Again** turns the notice off.

## 0.8.0

- Annotate Previous Revision: the Annotate hover has a new link that opens the file as it was before that commit changed the line, annotated as well and with the cursor on the line it came from, so you can keep following a line back through its history (renames included). Annotate can also be turned on and off on these read-only revisions.

## 0.7.0

- Smart Checkout: when local changes stop a checkout (from the Log, Branches or a dialog), a dialog lists the files and offers **Smart Checkout** (stash, check out, restore the changes), **Force Checkout** (discard the changes to those files) or Cancel. If restoring causes conflicts, they show up in the Commit window and the changes stay in the stash until you drop it.

## 0.6.0

- Status bar: the current branch of the active file's repository, with commits ahead of (↑) and behind (↓) its upstream, on the right of the status bar. A detached HEAD shows the commit, and a rebase, merge or cherry-pick in progress is named. Click it to open Branches. Turn it off with `gitLogWorkbench.statusBar.branch.enabled`.

## 0.5.1

- The Commit window also selects and marks the file shown in the active editor, so its selection follows along while you step through files with F7 (it stayed on the file you first opened).

## 0.5.0

- F7 / Shift+F7 in a diff opened from the Git Log or the Commit window steps through the changes and then continues into the next (or previous) file of the list: at the last change the status bar says which file comes next, and pressing again opens it at its first change.
- Changed Files in the Git Log highlights the file shown in the active editor (a bar and bold name) and selects it, so it is easy to find and follows along while you step through files; a clicked file stays selected.

## 0.4.1

- The Commit window, Git Log and dialogs no longer stay blank when they open while the extension is being installed or updated (the bundled script can be missing for a moment): the view reloads itself a few times, and if it still cannot start it says to run *Developer: Reload Window* instead of showing nothing.

## 0.4.0

- Show in Git Log: from the Annotate hover, the editor context menu (*IDE Git → Show Commit in Git Log*) or the command palette, open the Log with the commit of the current line selected and scrolled into view, even far back in history. Log filters go back to the default; a commit outside the current branch is shown on its own.
- Annotate: every line shows its date and author in an even-width column, the age tint no longer lets indent guides show through, the column lines up with the code, and the end-of-line blame is hidden while a file is annotated.
- Annotate works for files reached through a symlinked path (for example under /tmp on macOS).

## 0.3.0

- Renamed to **IDE Git** (`EthanLiuChen.ide-git`); commands are now under “IDE Git:”, and the editor and Explorer submenus are “IDE Git”. Uninstall `daliuchen.git-log-plus` when upgrading.
- Removed to keep the Commit window simple: changelists (including chunk-level changelists and drag & drop), the checks before commit (reformat code, optimize imports, analyze code, check TODO, run tests), commit message checks and `commit.template` prefill, and the `Git Log: VCS Operations…` menu. The Commit window now shows one Changes group plus Merge Conflicts and Unversioned Files; the gear keeps Author and Run Git hooks.
- Log filter bar: each filter shows its value (`Branch: feature/x`, `User: Alice`, `Date: since …`) with a × to clear it.
- Branch filter: search box, grouped Local / Remote / Tags, click a name to show only that branch (checkboxes still combine several).
- Compare with Current (branch context menu in the Log, and the Branches popup) lists the commits in that branch missing from the current one (`HEAD..branch`); ⇄ on the Branch filter swaps to `branch..HEAD`. The same comparison is on the ← / → buttons next to each branch in the Branch filter. The old file comparison is now *Show Diff with Current*.
- User filter search box.
- Filter popups open under the button that was clicked instead of at the right edge.
- Log toolbar: Pull and Push… buttons next to Fetch, all with editor icons. The ⋮ menu is gone (its items are on the toolbar, in the Commit window, in the Push dialog, or in the Command Palette), and the branch list and Changed Files panes can no longer be hidden; in a narrow panel they shrink instead.
- Cherry-pick: when the commit's changes are already in the branch, the pick ends right away with a notice instead of stopping with nothing to commit. A rebase, cherry-pick or revert in progress shows Continue / Skip / Abort both in the Log and in the Commit window (a merge shows Abort).
- Remote branches get Rebase Current onto and Merge into Current, so rebasing onto `origin/master` is one right-click.
- New icon. README rewritten and shortened: English in README.md, Chinese in README.zh-CN.md.
- AGENTS.md (and CLAUDE.md) with the rules for pull requests, technical designs in `design/`, and code style.
- Push with no remote offers Define Remote… (URL and name), then opens the Push dialog.
- The Commit window's options and message-history popups no longer open on top of each other.
- Comparing with the current branch (← / →, Compare with Current) leaves out commits whose changes the other side already has, so a cherry-picked commit no longer shows up as missing.
- While another branch is shown, commits the current branch already has are dimmed, cherry-picked ones (same patch) are dimmed and tagged “picked”, and missing ones are bold.
- Removed the Go to HEAD toolbar button; the current commit is at the top of the default (HEAD) view.
- Hover tooltips for toolbar buttons and other controls in the Commit window, Log and dialogs (native tooltips do not show inside webviews in Cursor).
- Line-level partial commits: expand a chunk and choose individual added or removed lines.
- Chunk-level changelists: move a chunk to another changelist; a split file appears in each one.
- Drag files onto a changelist; changelist descriptions prefill the commit message.
- Commit options: author, Run Git hooks, and checks before commit (reformat code, optimize imports, analyze code, check TODO, run tests).
- `commit.template` support and commit message checks with one-click wrapping.
- Rollback can delete the local copies of added files.
- Commit This Change / Amend This Change from the editor for the change at the cursor.
- Push dialog: a rejected push offers Rebase and Push or Merge and Push.
- Log: Drop Selected Changes removes a file's change from a commit.
- Fixed: switching the active changelist could be undone by a concurrent refresh; paths behind symlinks are matched correctly.

## 0.2.1

- Commit view saves unsaved editors of the selected files before committing, so their edits are included.
- Shelve records only the selected files; other staged changes are no longer captured in the stash.
- The commit summary counts only the selected chunks of partially committed files.

## 0.2.0 — Git Log Plus

First release of the fork (`daliuchen.git-log-plus`).

- Commit tool window: directory tree of local changes, changelists, tri-state checkboxes, partial (chunk) commits, amend, sign-off, message history, Commit and Push, rollback, shelve, conflict actions.
- Editable diffs: the working-tree file is used whenever it matches, Jump to Source (F4) from any revision, Compare with Local for files, commits, and branches.
- Log: Edit Commit Message, Fixup / Squash Into, Undo Commit, Interactively Rebase from Here, Push All up to Here, Create Patch, file-level Revert / Cherry-Pick Selected Changes and Get from Revision, Checkout and Rebase onto Current, Pull into Current, Update branch, Update Project.
- Push dialog, interactive rebase dialog, Branches popup, VCS Operations menu, Annotate with Git Blame.

## 0.1.3

### Added

- Added `All` to the Branch filter to select Local, Remote, and Tag references together, and `HEAD (local)` to show the current HEAD's history, including detached HEAD ([#6](https://github.com/ascenx/vscode-git-log/issues/6)). Other log filters are preserved.

### Fixed

- Kept `All` filter requests valid for repositories with more than 100 references, including after deselecting an individual reference.
- Cleared `All` mode when selecting HEAD or a specific branch, checking out detached HEAD, switching back, or creating and checking out a branch, so the log follows the requested history.

## 0.1.2

### Added

- Added `Checkout (Detached HEAD)` to remote branch menus to check out a remote ref without creating a local branch.
- Added `Switch Back` (`git switch -`) and `Create Branch and Checkout…` (`git switch -c <name>`) to the detached HEAD menu.
- Added `Push HEAD…` to the detached HEAD menu and toolbar's More actions. Choose a configured remote and an existing or new destination branch to push `HEAD:refs/heads/<branch>` without creating a local branch; non-fast-forward updates are rejected ([#5](https://github.com/ascenx/vscode-git-log/issues/5)).

### Changed

- Detached checkout, switching back, and creating a branch from HEAD now clear the Branch filter while preserving other filters and return the log selection to HEAD, including when its commit hash is unchanged. Subsequent detached HEAD commits remain visible after refresh.

## 0.1.1

### Changed

- Commit Details and Changed Files reuse successful query results in bounded caches that are invalidated on repository refresh; branch and tag labels still reflect the latest ref snapshot.
- Multi-commit selections load up to four commits concurrently while preserving selection order, cancellation, and error reporting.
- Repository refreshes reuse unchanged Git metadata watchers, including shared watchers for linked worktrees, instead of recreating them.

### Fixed

- Fixed context-menu actions such as branch deletion remaining unresponsive after a completed Git operation when a newer query cancelled its post-operation refresh.
- Preserved active operation locks during workspace rescans so write actions cannot be re-enabled prematurely.
- Prevented older commit or parent selections from cancelling newer detail queries after asynchronous state persistence.
- Cancelled pending change notifications for removed repositories and updated shared watcher recipients when worktrees are removed.

## 0.1.0

### Added

- Added a dedicated `Rebasing` status row with `Continue`, `Skip`, and `Abort` actions. The status opens VS Code Source Control, `Continue` stays disabled until all conflicts are marked resolved, and destructive rebase actions require confirmation.

### Changed

- Text filtering now returns only commits that match the query instead of inserting unrelated merge commits as structural rows.

### Fixed

- Collapsed ancestry through hidden commits directly onto visible search matches, preserving continuous split-and-rejoin topology while eliminating excessive and disconnected graph lanes ([#4](https://github.com/ascenx/vscode-git-log/issues/4)).

## 0.0.9

### Added

- Added an Explorer `Git Log` submenu. Files can open the existing dedicated File History tab, while folders open the bottom Git Log with a temporary recursive path filter.

### Changed

- Folder History restores the repository's previous filters, selection, and scroll position when returning to the normal log.
- Current-line history now shows configurable, visually subdued logical context lines around each tracked change without broadening the requested Git history range beyond the selected line.

### Fixed

- Suppressed the extension's current-line blame annotation while VS Code's built-in `git.blame.editorDecoration.enabled` decoration is active, preventing duplicate blame text.
- Refined current-line history across formatting and large replacement commits by tracking the matching logical line, pairing old and new context, honoring zero-context mode, and filtering commits that only changed another line in Git's expanded `-L` range.

## 0.0.8

### Added

- Added an `All Changes` action to commit comparisons that opens every non-binary file in a single VS Code multi-file diff while retaining per-file diff selection.
- Added a persisted Commit Details placement control for switching between the full-width bottom area and the bottom of Changed Files.

### Fixed

- Cleared the `All Changes` active state after its multi-file diff is closed.
- Kept Commit Details visible below Changed Files when no file preview is selected and when the persisted placement is restored at narrow panel widths.

## 0.0.7

### Added

- Added a confirmed `Force Delete…` action directly to non-current Local Branch context menus.

### Changed

- `Go to HEAD` now locates the checked-out HEAD inside the currently displayed branch or filtered commit list, aligns it as the first visible row, and does not switch the active commit list.
- Improved large-repository responsiveness with isolated virtual commit rendering, frame-coalesced scrolling, debounced scroll persistence, indexed ref attachment, cached date formatting, concurrent repository discovery, and incremental file-history paging.
- Minified production Extension Host, Webview, and syntax-worker bundles.

### Fixed

- Preserved HEAD positioning across asynchronous filter replacements without snapping back when later commit pages are appended.
- Kept automatic commit pagination working when the final commits are aligned at the top of the viewport.
- Bounded Git command output, terminated cancelled command process groups more reliably, limited expensive copy detection on large changes, and reported background Webview errors without leaving unhandled rejections.

### Safety

- Force Delete uses `git branch -D` only after a modal confirmation that names the repository and exact branch and warns that the branch may be unmerged.

## 0.0.6

### Added

- Added theme-aware current-line blame annotations with author, relative time, and commit subject, plus full author, timestamp, hash, and message details on hover.
- Added edit-age tracking for uncommitted lines, retained across editor tab switches and extension restarts.
- Added complete stash management with optional untracked files, stash listing, change previews, apply, pop, and confirmed drop.
- Added HEAD amend with commit-message editing and staged-change inclusion.

### Fixed

- Improved current-line blame for unsaved and unstaged changes, modified renames, case-only renames, large edits, and Git stdin failures.
- Prevented commit and reference context menus from extending beyond the visible viewport.

### Safety

- Dropping a stash and amending HEAD require explicit confirmation.

## 0.0.5

### Changed

- Lowered the minimum supported Git version from 2.30 to 2.27 while preserving exact hash search and force-push target resolution.
- Simplified the Branch pane by hiding upstream branch names while retaining ahead and behind indicators.

## 0.0.4

### Added

- Added Ctrl/Cmd+click for non-contiguous commit selection while keeping Shift+click and Shift+Arrow keys for contiguous ranges.
- Added `Checkout Revision` to the single-commit context menu for checking out a commit in detached HEAD state.

### Changed

- Changed Files now combines the changed files from every selected commit and opens each file against the commit and parent that produced it.
- `Drop commits…` and `Squash commits…` remain available only for contiguous multi-commit selections, while `Checkout Revision` remains a single-commit action.
- Removed the redundant `Show Details` commit-menu action because selecting a commit already loads its details.

### Fixed

- Preserved valid contiguous and non-contiguous commit selections across repository refreshes.

## 0.0.3

### Added

- Added a dedicated Branch pane search that filters Local, Remote, and Tag references without querying the commit log.
- Added recursive, collapsible folders for slash-delimited references, including remote names that contain `/`.

### Changed

- Moved commit-specific Text/Hash, Branch, User, Date, and Path filters into the Commit pane and placed global Git actions in the upper-right toolbar.
- Unified pane toolbar and heading backgrounds, reduced outer spacing, and refined pane dividers while preserving wider resize hit targets.
- Kept the Commit header aligned with its rows throughout horizontal scrolling.

### Fixed

- Hex-like text that does not resolve to a commit now falls back to full commit-message and author search instead of returning no results.
- Fixed Changed Files transparency and overlap issues, and kept Branch, Commit, and Changed Files panes in their correct grid columns when sibling panes are collapsed.

## 0.0.2

### Added

- Added contiguous multi-commit selection with Shift+click and Shift+Up/Down.
- Added confirmed `Drop commits…` and `Squash commits…` actions for the current branch's linear first-parent history.
- Added an editable squash message dialog prefilled with the selected commits' complete messages in visible top-to-bottom order.
- Added a warning-colored Force Delete recovery action when a local branch cannot be deleted because it is not fully merged.
- Added Tag-triggered GitHub Actions packaging and GitHub Release publishing for VSIX files.

### Changed

- Lowered the minimum supported VS Code version to 1.85.2 and aligned Extension Host bundles with its Node 18 runtime.
- Clicking or double-clicking a branch now selects and displays its commit history without checking it out; checkout is available explicitly from the Ref context menu.
- Commit Log text is no longer natively selectable, preventing browser text highlighting from overlapping multi-row commit selection.
- Error notices remain visible for five seconds before being dismissed automatically.

### Fixed

- Fixed line-history path parsing for quoted Unicode and emoji filenames emitted by Git on Linux.
- Editor-history commands now return their asynchronous work so callers and CI wait until the requested tab is open.

### Safety

- Drop and Squash require a clean worktree and destructive confirmation.
- History rewriting is limited to a contiguous range on the checked-out branch's first-parent chain and rejects root commits, merge commits, stale plans, and branch or HEAD changes during confirmation.
- Rebase execution disables automatic stashing and reference updates so unrelated local branches are not rewritten.

## 0.0.1

- Initial public release of the Git Log workbench, commit graph, changed-file browser, repository operations, and editor line/file history tools.
