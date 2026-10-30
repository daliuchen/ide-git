export type LocalChangeStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

export interface LocalChange {
  path: string;
  oldPath?: string;
  status: LocalChangeStatus;
  /** The index differs from HEAD for this path. */
  staged: boolean;
  /** The working tree differs from the index for this path. */
  unstaged: boolean;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export interface BranchStatus {
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

export interface LocalStatus {
  branch: BranchStatus;
  changes: LocalChange[];
  truncated: boolean;
}

function changeStatus(index: string, worktree: string): Exclude<LocalChangeStatus, '?' | 'U'> {
  if (index === 'A') return 'A';
  if (index === 'R') return 'R';
  if (index === 'C') return 'C';
  if (index === 'D' || worktree === 'D') return 'D';
  if (index === 'T' || worktree === 'T') return 'T';
  return 'M';
}

/** Splits a space-separated record whose final field (a path) may itself contain spaces. */
function splitFields(record: string, leadingFields: number): { fields: string[]; rest: string } | undefined {
  const fields: string[] = [];
  let offset = 0;
  for (let index = 0; index < leadingFields; index += 1) {
    const next = record.indexOf(' ', offset);
    if (next < 0) return undefined;
    fields.push(record.slice(offset, next));
    offset = next + 1;
  }
  return { fields, rest: record.slice(offset) };
}

/**
 * Parses `git status --porcelain=v2 -z --branch` output.
 * Ignored entries (`!`) are skipped; at most `limit` changes are returned.
 */
export function parsePorcelainV2Status(output: string, limit = Number.POSITIVE_INFINITY): LocalStatus {
  const branch: BranchStatus = {};
  const changes: LocalChange[] = [];
  let truncated = false;
  const records = output.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('# ')) {
      const header = splitFields(record, 2);
      if (!header) continue;
      const [, key] = header.fields;
      if (key === 'branch.head' && header.rest !== '(detached)') branch.branch = header.rest;
      if (key === 'branch.upstream') branch.upstream = header.rest;
      if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/u.exec(header.rest);
        if (match) {
          branch.ahead = Number(match[1]);
          branch.behind = Number(match[2]);
        }
      }
      continue;
    }
    if (changes.length >= limit) {
      truncated = true;
      if (record.startsWith('2 ')) index += 1;
      continue;
    }
    const kind = record[0];
    if (kind === '1') {
      const parsed = splitFields(record, 8);
      const xy = parsed?.fields[1];
      if (!parsed || !xy || !parsed.rest) continue;
      const [x = '.', y = '.'] = xy;
      changes.push({
        path: parsed.rest,
        status: changeStatus(x, y),
        staged: x !== '.',
        unstaged: y !== '.',
      });
    } else if (kind === '2') {
      const parsed = splitFields(record, 9);
      const xy = parsed?.fields[1];
      const oldPath = records[index + 1];
      index += 1;
      if (!parsed || !xy || !parsed.rest || !oldPath) continue;
      const [x = '.', y = '.'] = xy;
      changes.push({
        path: parsed.rest,
        oldPath,
        status: changeStatus(x, y),
        staged: x !== '.',
        unstaged: y !== '.',
      });
    } else if (kind === 'u') {
      const parsed = splitFields(record, 10);
      if (!parsed?.rest) continue;
      changes.push({ path: parsed.rest, status: 'U', staged: true, unstaged: true });
    } else if (kind === '?') {
      const path = record.slice(2);
      if (path) changes.push({ path, status: '?', staged: false, unstaged: true });
    }
  }
  return { branch, changes, truncated };
}

export interface NumstatEntry {
  path: string;
  additions?: number;
  deletions?: number;
  binary: boolean;
}

/** Parses `git diff --numstat -z` output, keyed by the new path. */
export function parseNumstat(output: string): Map<string, NumstatEntry> {
  const entries = new Map<string, NumstatEntry>();
  const records = output.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/su.exec(record);
    if (!match) continue;
    let path = match[3] ?? '';
    if (!path) {
      // Renames are emitted as "add\tdel\t\0old\0new".
      path = records[index + 2] ?? '';
      index += 2;
    }
    if (!path) continue;
    const binary = match[1] === '-' && match[2] === '-';
    entries.set(path, {
      path,
      binary,
      ...(binary ? {} : { additions: Number(match[1]), deletions: Number(match[2]) }),
    });
  }
  return entries;
}

export function applyNumstat(changes: LocalChange[], stats: ReadonlyMap<string, NumstatEntry>): LocalChange[] {
  return changes.map((change) => {
    const stat = stats.get(change.path);
    if (!stat) return change;
    return {
      ...change,
      ...(stat.binary ? { binary: true } : {}),
      ...(stat.additions === undefined ? {} : { additions: stat.additions }),
      ...(stat.deletions === undefined ? {} : { deletions: stat.deletions }),
    };
  });
}

/** Paths that must be passed to `git commit --only` so the commit records the whole change. */
export function commitPathspecs(changes: readonly LocalChange[]): string[] {
  const paths = new Set<string>();
  for (const change of changes) {
    paths.add(change.path);
    if (change.oldPath && change.status === 'R') paths.add(change.oldPath);
  }
  return [...paths];
}

export interface DiffHunk {
  /** Stable for identical hunk content, so a stale selection is detected at commit time. */
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  removed: string[];
  added: string[];
  /** The hunk's `-`, `+`, and `\` lines in patch order; line selections index into this. */
  body: string[];
  text: string;
}

/** A hunk to commit: all of it, or only the listed indexes of its `body` lines. */
export interface HunkSelection {
  id: string;
  lines?: readonly number[];
}

export interface FilePatch {
  header: string;
  hunks: DiffHunk[];
}

function hashText(text: string): string {
  // FNV-1a, 32-bit, twice with different seeds: identification only, not security.
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x811c9dc5) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

/** Parses a single-file `git diff -U0` patch into its header and change hunks. */
export function parseFilePatch(patch: string): FilePatch {
  const lines = patch.split('\n');
  const headerLines: string[] = [];
  const hunks: DiffHunk[] = [];
  let current: { header: string; lines: string[] } | undefined;
  const finish = (): void => {
    if (!current) return;
    const match = HUNK_HEADER.exec(current.header);
    if (match) {
      const body = current.lines.filter((line) => line !== '');
      const text = `${current.header}\n${body.join('\n')}\n`;
      hunks.push({
        id: hashText(text),
        header: current.header,
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        removed: body.filter((line) => line.startsWith('-')).map((line) => line.slice(1)),
        added: body.filter((line) => line.startsWith('+')).map((line) => line.slice(1)),
        body,
        text,
      });
    }
    current = undefined;
  };
  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      finish();
      current = { header: line, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else if (line) {
      headerLines.push(line);
    }
  }
  finish();
  return { header: headerLines.length ? `${headerLines.join('\n')}\n` : '', hunks };
}

/**
 * Rebuilds one hunk keeping only some of its changed lines: an unselected removal stays in the
 * file (becomes context) and an unselected addition is left out. Apply with `--recount`.
 */
export function partialHunkText(hunk: DiffHunk, lines: readonly number[]): string {
  const selected = new Set(lines);
  const output: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  let previousEmitted = false;
  hunk.body.forEach((line, index) => {
    if (line.startsWith('\\')) {
      // "\ No newline at end of file" belongs to the line before it.
      if (previousEmitted) output.push(line);
      return;
    }
    const keep = selected.has(index);
    if (line.startsWith('-')) {
      output.push(keep ? line : ` ${line.slice(1)}`);
      oldCount += 1;
      if (!keep) newCount += 1;
      previousEmitted = true;
    } else if (line.startsWith('+')) {
      if (keep) {
        output.push(line);
        newCount += 1;
      }
      previousEmitted = keep;
    }
  });
  return `@@ -${String(hunk.oldStart)},${String(oldCount)} +${String(hunk.newStart)},${String(newCount)} @@\n${output.join('\n')}\n`;
}

/** Rebuilds a patch containing only the selected hunks (or lines); throws when a selection is stale. */
export function selectHunks(patch: FilePatch, selections: readonly (string | HunkSelection)[]): string {
  const wanted = new Map<string, HunkSelection>();
  for (const selection of selections) {
    const normalized = typeof selection === 'string' ? { id: selection } : selection;
    wanted.set(normalized.id, normalized);
  }
  const chosen = patch.hunks.filter((hunk) => wanted.has(hunk.id));
  if (chosen.length !== wanted.size) {
    throw new Error('The file changed since its chunks were selected. Review the selection and commit again.');
  }
  const texts = chosen.map((hunk) => {
    const lines = wanted.get(hunk.id)?.lines;
    if (!lines) return hunk.text;
    if (lines.some((index) => index < 0 || index >= hunk.body.length)) {
      throw new Error('The file changed since its lines were selected. Review the selection and commit again.');
    }
    return partialHunkText(hunk, lines);
  });
  return `${patch.header}${texts.join('')}`;
}
