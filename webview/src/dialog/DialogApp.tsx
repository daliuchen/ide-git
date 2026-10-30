import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DialogCommit,
  DialogExtensionMessage,
  DialogInit,
  DialogWebviewMessage,
} from '../../../src/dialogs/dialogProtocol';
import type { RebaseAction, RebaseStep } from '../../../src/protocol/messages';
import type { ChangedFile } from '../../../src/shared/models';

interface DialogVsCodeApi {
  postMessage(message: DialogWebviewMessage): void;
}

const vscode: DialogVsCodeApi = (window.acquireVsCodeApi?.() as DialogVsCodeApi | undefined) ?? {
  postMessage() {},
};

function post(message: DialogWebviewMessage): void {
  vscode.postMessage(message);
}

const isMac = navigator.platform.toLowerCase().includes('mac');

function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function useFiles(): [Map<string, ChangedFile[]>, (hash: string) => void, (message: DialogExtensionMessage) => void] {
  const [files, setFiles] = useState(new Map<string, ChangedFile[]>());
  const requested = useRef(new Set<string>());
  const request = useCallback((hash: string) => {
    if (requested.current.has(hash)) return;
    requested.current.add(hash);
    post({ type: 'loadFiles', hash });
  }, []);
  const receive = useCallback((message: DialogExtensionMessage) => {
    if (message.type === 'filesLoaded') {
      setFiles((current) => new Map(current).set(message.hash, message.files));
    }
  }, []);
  return [files, request, receive];
}

function FileList({ hash, files }: { hash?: string; files?: ChangedFile[] }) {
  if (!hash) return <div className="empty">Select a commit to see its files.</div>;
  if (!files) return <div className="empty">Loading…</div>;
  if (!files.length) return <div className="empty">No changed files.</div>;
  return (
    <div className="file-list" role="list">
      {files.map((file) => {
        const slash = file.path.lastIndexOf('/');
        return (
          <div
            key={`${file.oldPath ?? ''}:${file.path}`}
            role="listitem"
            className="file-row"
            title={`${file.path}\nDouble-click to show the diff`}
            onDoubleClick={() => post({ type: 'openFileDiff', hash, path: file.path })}
          >
            <span className={`status status-${file.status}`}>{file.status}</span>
            <span className={`label status-${file.status}`}>{file.path.slice(slash + 1)}</span>
            {slash > 0 ? <span className="detail">{file.path.slice(0, slash)}</span> : null}
            <span className="stats">
              {file.additions ? <span className="added">+{file.additions}</span> : null}
              {file.deletions ? <span className="deleted">−{file.deletions}</span> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function PushDialog({ init, busy, error, files, requestFiles, commitsMessage }: {
  init: Extract<DialogInit, { dialog: 'push' }>;
  busy: boolean;
  error?: string;
  files: Map<string, ChangedFile[]>;
  requestFiles(hash: string): void;
  commitsMessage?: Extract<DialogExtensionMessage, { type: 'commitsLoaded' }>;
}) {
  const [remote, setRemote] = useState(init.remote);
  const [branch, setBranch] = useState(init.branch);
  const [setUpstream, setSetUpstream] = useState(init.setUpstream);
  const [pushTags, setPushTags] = useState(false);
  const [force, setForce] = useState(false);
  const [selected, setSelected] = useState<string>();

  useEffect(() => {
    if (!remote || !branch.trim()) return;
    const timer = setTimeout(() => post({ type: 'loadCommits', remote, branch: branch.trim() }), 250);
    return () => clearTimeout(timer);
  }, [remote, branch]);

  const commits =
    commitsMessage && commitsMessage.remote === remote && commitsMessage.branch === branch.trim()
      ? commitsMessage.commits
      : undefined;
  const isNew = commitsMessage?.remoteBranchExists === false;
  const selectedHash = selected && commits?.some((commit) => commit.hash === selected) ? selected : commits?.[0]?.hash;

  useEffect(() => {
    if (selectedHash) requestFiles(selectedHash);
  }, [selectedHash, requestFiles]);

  const push = () => {
    if (busy || !branch.trim()) return;
    post({ type: 'push', remote, branch: branch.trim(), setUpstream, forceWithLease: force, pushTags });
  };

  return (
    <form
      className="dialog"
      onSubmit={(event) => {
        event.preventDefault();
        push();
      }}
    >
      <header className="dialog-header">
        <i className="codicon codicon-repo-push" />
        <strong>{init.repositoryName}</strong>
        <span className="detail">{init.source === 'HEAD' ? (init.currentBranch ?? 'HEAD') : init.source.slice(0, 8)}</span>
        <span>→</span>
        <select aria-label="Remote" value={remote} onChange={(event) => setRemote(event.target.value)}>
          {init.remotes.map((candidate) => (
            <option key={candidate}>{candidate}</option>
          ))}
        </select>
        <span>:</span>
        <input aria-label="Target branch" value={branch} onChange={(event) => setBranch(event.target.value)} spellCheck={false} />
        {isNew ? <span className="badge">New</span> : null}
      </header>
      <div className="dialog-body split">
        <div className="pane">
          <div className="pane-title">
            {commits ? `${String(commits.length)} commit${commits.length === 1 ? '' : 's'} to push` : 'Loading commits…'}
          </div>
          <div className="commit-list" role="listbox" aria-label="Commits to push">
            {commits?.length === 0 ? <div className="empty">Everything is up to date.</div> : null}
            {commits?.map((commit) => (
              <div
                key={commit.hash}
                role="option"
                aria-selected={commit.hash === selectedHash}
                className={`commit-row${commit.hash === selectedHash ? ' selected' : ''}`}
                title={commit.message}
                onClick={() => setSelected(commit.hash)}
              >
                <span className="subject">{commit.subject}</span>
                <span className="detail">{commit.author}</span>
                <span className="detail">{formatDate(commit.date)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="pane">
          <div className="pane-title">Changed files</div>
          <FileList {...(selectedHash ? { hash: selectedHash } : {})} {...(selectedHash && files.get(selectedHash) ? { files: files.get(selectedHash) as ChangedFile[] } : {})} />
        </div>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      <footer className="dialog-footer">
        <label title="git push --set-upstream">
          <input type="checkbox" checked={setUpstream} disabled={init.source !== 'HEAD'} onChange={(event) => setSetUpstream(event.target.checked)} />
          Set upstream
        </label>
        <label title="git push --follow-tags">
          <input type="checkbox" checked={pushTags} onChange={(event) => setPushTags(event.target.checked)} />
          Push tags
        </label>
        <label title="git push --force-with-lease">
          <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
          Force push (with lease)
        </label>
        <span className="spacer" />
        <button type="button" onClick={() => post({ type: 'cancel' })}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy || !branch.trim() || commits?.length === 0 && !force}>
          {force ? 'Force Push' : 'Push'}
        </button>
      </footer>
    </form>
  );
}

const ACTIONS: { action: RebaseAction; label: string; key: string }[] = [
  { action: 'pick', label: 'Pick', key: 'P' },
  { action: 'reword', label: 'Reword', key: 'R' },
  { action: 'edit', label: 'Stop to Edit', key: 'E' },
  { action: 'squash', label: 'Squash', key: 'S' },
  { action: 'fixup', label: 'Fixup', key: 'F' },
  { action: 'drop', label: 'Drop', key: 'D' },
];

interface RebaseRow {
  commit: DialogCommit;
  action: RebaseAction;
  /** User-edited message for a reword or a squash group's first commit. */
  message?: string;
}

/** The commit a squash/fixup row folds into: the nearest earlier kept, non-folded row. */
function groupLeader(rows: readonly RebaseRow[], index: number): number | undefined {
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    const action = rows[candidate]?.action;
    if (action === 'pick' || action === 'reword' || action === 'edit') return candidate;
  }
  return undefined;
}

function squashedMessage(rows: readonly RebaseRow[], leader: number): string | undefined {
  const parts = [rows[leader]?.commit.message ?? ''];
  let squashed = false;
  for (let index = leader + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || row.action === 'drop') continue;
    if (row.action !== 'squash' && row.action !== 'fixup') break;
    if (row.action === 'squash') {
      squashed = true;
      parts.push(row.commit.message);
    }
  }
  return squashed ? parts.join('\n\n') : undefined;
}

function RebaseDialog({ init, busy, error, files, requestFiles }: {
  init: Extract<DialogInit, { dialog: 'rebase' }>;
  busy: boolean;
  error?: string;
  files: Map<string, ChangedFile[]>;
  requestFiles(hash: string): void;
}) {
  const initialRows = useMemo<RebaseRow[]>(
    () => init.commits.map((commit) => ({ commit, action: init.mode === 'reword' ? 'reword' : 'pick' })),
    [init],
  );
  const [rows, setRows] = useState(initialRows);
  const [selected, setSelected] = useState(init.mode === 'reword' ? 0 : init.commits.length - 1);
  const selectedRow = rows[selected];

  useEffect(() => {
    if (selectedRow) requestFiles(selectedRow.commit.hash);
  }, [selectedRow, requestFiles]);

  const leaderIndex = selectedRow && (selectedRow.action === 'squash' || selectedRow.action === 'fixup') ? groupLeader(rows, selected) : selected;
  const editingIndex = leaderIndex ?? selected;
  const editingRow = rows[editingIndex];
  const defaultMessage = editingRow
    ? (editingRow.action === 'reword' || editingRow.action === 'pick' || editingRow.action === 'edit'
      ? (squashedMessage(rows, editingIndex) ?? editingRow.commit.message)
      : editingRow.commit.message)
    : '';
  const showsMessage =
    editingRow &&
    (editingRow.action === 'reword' || squashedMessage(rows, editingIndex) !== undefined);

  const setAction = (action: RebaseAction) => {
    setRows((current) => current.map((row, index) => (index === selected ? { ...row, action } : row)));
  };
  const move = (delta: number) => {
    const target = selected + delta;
    if (target < 0 || target >= rows.length) return;
    setRows((current) => {
      const next = [...current];
      const [row] = next.splice(selected, 1);
      if (row) next.splice(target, 0, row);
      return next;
    });
    setSelected(target);
  };

  const firstKept = rows.find((row) => row.action !== 'drop');
  const invalid =
    init.mode === 'interactive' &&
    (!firstKept || firstKept.action === 'squash' || firstKept.action === 'fixup');
  const changed =
    init.mode === 'reword' ||
    rows.some((row, index) => row.action !== 'pick' || row.commit.hash !== initialRows[index]?.commit.hash);

  const submit = () => {
    if (busy || invalid || !changed) return;
    if (init.mode === 'reword') {
      const row = rows[0];
      if (!row) return;
      const message = row.message ?? row.commit.message;
      if (!message.trim()) return;
      post({ type: 'reword', hash: row.commit.hash, message });
      return;
    }
    const steps: RebaseStep[] = rows.map((row, index) => {
      const groupMessage = row.action === 'pick' || row.action === 'reword' || row.action === 'edit' ? squashedMessage(rows, index) : undefined;
      const message =
        row.action === 'reword' || groupMessage !== undefined
          ? (row.message ?? groupMessage ?? row.commit.message)
          : undefined;
      return { hash: row.commit.hash, action: row.action, ...(message !== undefined ? { message } : {}) };
    });
    post({ type: 'rebase', steps });
  };

  return (
    <form
      className="dialog"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (event.key === 'Enter' && (isMac ? event.metaKey : event.ctrlKey)) {
          event.preventDefault();
          submit();
          return;
        }
        if (init.mode !== 'interactive' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
        if (event.altKey && event.key === 'ArrowUp') move(-1);
        else if (event.altKey && event.key === 'ArrowDown') move(1);
        else if (event.key === 'ArrowUp') setSelected((index) => Math.max(0, index - 1));
        else if (event.key === 'ArrowDown') setSelected((index) => Math.min(rows.length - 1, index + 1));
        else {
          const action = ACTIONS.find((candidate) => candidate.key === event.key.toUpperCase() && !event.metaKey && !event.ctrlKey);
          if (!action) return;
          setAction(action.action);
        }
        event.preventDefault();
      }}
    >
      <header className="dialog-header">
        <i className={`codicon ${init.mode === 'reword' ? 'codicon-edit' : 'codicon-git-pull-request'}`} />
        <strong>{init.repositoryName}</strong>
        <span className="detail">
          {init.mode === 'reword'
            ? 'Edit the commit message; newer commits are recreated with identical content.'
            : `Rebasing ${init.branch ?? 'HEAD'} — oldest commit first. Alt+↑/↓ moves, P/R/E/S/F/D sets the action.`}
        </span>
      </header>
      {init.mode === 'interactive' ? (
        <div className="rebase-toolbar" role="toolbar">
          {ACTIONS.map((candidate) => (
            <button
              key={candidate.action}
              type="button"
              className={selectedRow?.action === candidate.action ? 'toggled' : ''}
              title={`${candidate.label} (${candidate.key})`}
              onClick={() => setAction(candidate.action)}
            >
              {candidate.label}
            </button>
          ))}
          <span className="toolbar-separator" />
          <button type="button" title="Move Up (Alt+↑)" disabled={selected === 0} onClick={() => move(-1)}>
            <i className="codicon codicon-arrow-up" />
          </button>
          <button type="button" title="Move Down (Alt+↓)" disabled={selected === rows.length - 1} onClick={() => move(1)}>
            <i className="codicon codicon-arrow-down" />
          </button>
          <button type="button" title="Reset" onClick={() => setRows(initialRows)}>
            <i className="codicon codicon-discard" />
          </button>
        </div>
      ) : null}
      <div className="dialog-body split">
        <div className="pane">
          {init.mode === 'interactive' ? (
            <div className="commit-list" role="listbox" aria-label="Commits to rebase" tabIndex={0}>
              {rows.map((row, index) => (
                <div
                  key={row.commit.hash}
                  role="option"
                  aria-selected={index === selected}
                  className={`commit-row action-${row.action}${index === selected ? ' selected' : ''}`}
                  title={row.commit.message}
                  onClick={() => setSelected(index)}
                >
                  <select
                    aria-label="Action"
                    value={row.action}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      setSelected(index);
                      setRows((current) =>
                        current.map((candidate, rowIndex) =>
                          rowIndex === index ? { ...candidate, action: event.target.value as RebaseAction } : candidate,
                        ),
                      );
                    }}
                  >
                    {ACTIONS.map((candidate) => (
                      <option key={candidate.action} value={candidate.action}>
                        {candidate.label}
                      </option>
                    ))}
                  </select>
                  <span className="hash">{row.commit.shortHash}</span>
                  <span className="subject">{row.message?.split('\n')[0] ?? row.commit.subject}</span>
                  <span className="detail">{row.commit.author}</span>
                </div>
              ))}
            </div>
          ) : null}
          {showsMessage || init.mode === 'reword' ? (
            <label className="message-editor">
              <span className="pane-title">
                {init.mode === 'reword'
                  ? 'Commit message'
                  : squashedMessage(rows, editingIndex) !== undefined
                    ? `Message for the squashed commit (${editingRow?.commit.shortHash ?? ''})`
                    : `New message for ${editingRow?.commit.shortHash ?? ''}`}
              </span>
              <textarea
                value={editingRow?.message ?? defaultMessage}
                spellCheck
                autoFocus={init.mode === 'reword'}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((row, index) => (index === editingIndex ? { ...row, message: event.target.value } : row)),
                  )
                }
              />
            </label>
          ) : null}
        </div>
        <div className="pane">
          <div className="pane-title">Changed files</div>
          <FileList
            {...(selectedRow ? { hash: selectedRow.commit.hash } : {})}
            {...(selectedRow && files.get(selectedRow.commit.hash) ? { files: files.get(selectedRow.commit.hash) as ChangedFile[] } : {})}
          />
        </div>
      </div>
      {invalid ? <div className="error-banner">The first kept commit cannot be squashed or fixed up.</div> : null}
      {error ? <div className="error-banner">{error}</div> : null}
      <footer className="dialog-footer">
        <span className="detail">
          {init.mode === 'interactive' ? 'Local changes are stashed automatically and restored afterwards.' : ''}
        </span>
        <span className="spacer" />
        <button type="button" onClick={() => post({ type: 'cancel' })}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy || invalid || !changed} title={`${isMac ? '⌘' : 'Ctrl+'}Enter`}>
          {init.mode === 'reword' ? 'OK' : 'Start Rebasing'}
        </button>
      </footer>
    </form>
  );
}

export function DialogApp() {
  const [init, setInit] = useState<DialogInit>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [commitsMessage, setCommitsMessage] = useState<Extract<DialogExtensionMessage, { type: 'commitsLoaded' }>>();
  const [files, requestFiles, receiveFiles] = useFiles();

  useEffect(() => {
    const onMessage = (event: MessageEvent<DialogExtensionMessage>) => {
      const message = event.data;
      if (message.type === 'init') setInit(message.init);
      else if (message.type === 'busy') setBusy(message.busy);
      else if (message.type === 'error') setError(message.message);
      else if (message.type === 'commitsLoaded') setCommitsMessage(message);
      else receiveFiles(message);
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, [receiveFiles]);

  if (!init) return <div className="empty">Loading…</div>;
  return init.dialog === 'push' ? (
    <PushDialog
      init={init}
      busy={busy}
      {...(error ? { error } : {})}
      files={files}
      requestFiles={requestFiles}
      {...(commitsMessage ? { commitsMessage } : {})}
    />
  ) : (
    <RebaseDialog init={init} busy={busy} {...(error ? { error } : {})} files={files} requestFiles={requestFiles} />
  );
}
