# End-to-end tests

These drive a real VS Code (1.144 by default) with the extension under development and check the
result in the UI and with the git CLI. They complement the unit and integration tests for things
only a real editor shows: diffs, hovers, the status bar, dialogs and webviews.

```bash
pnpm run test:e2e                      # build, then run every suite
node test/e2e/run.mjs status-bar       # one or more suites by name (after pnpm run build)
```

- Each suite in `suites/` builds its own fixture repositories in a scratch directory, launches VS
  Code on it with a fresh profile, and removes everything afterwards.
- VS Code is downloaded once into `.vscode-test/` (set `IDE_GIT_E2E_VSCODE` for another version).
  It is driven through the DevTools protocol on port 9339 (`IDE_GIT_E2E_PORT`), so close other
  instances started by these tests first.
- Screenshots go to `.vscode-test/e2e-shots/`; on failure the suite saves `<suite>-error.png`.
- Written for macOS (⌘ shortcuts, `/tmp` scratch directories because socket paths are limited to
  104 characters). They are not run in CI.

## Writing a suite

Export `{ setup(directory), run({ page, check, workspace, shot }), launch? }` from
`suites/<name>.mjs`:

- `setup` creates the repository and returns the folder to open (use `initRepository`,
  `writeFiles` and `git` from `lib.mjs`).
- `run` uses Playwright's `page` and records results with `check(label, ok, detail)`.
- `launch` (an object, or a function returning one) can pass `keybindings` or `extraExtensions`
  (other extension folders to load). `installedExtension(id)` finds one already installed in
  Cursor or VS Code on this machine; nothing is downloaded.
- `skip()` may return a reason to skip the suite, e.g. when such an extension is not installed.
- `run` also gets `userKeybindings()`, the test profile's keybindings.json.
