export interface CheckoutConflict {
  /** Tracked files whose local changes the checkout would overwrite. */
  modified: string[];
  /** Untracked files that the checkout would overwrite. */
  untracked: string[];
}

const MODIFIED_HEADER = /local changes to the following files would be overwritten by checkout:/u;
const UNTRACKED_HEADER = /untracked working tree files would be (?:overwritten|removed) by checkout:/u;

/** Undoes Git's C-style quoting of paths with special characters (`core.quotePath`). */
export function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
  const bytes: number[] = [];
  const body = value.slice(1, -1);
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11, '\\': 92, '"': 34 };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? '';
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const next = body[index + 1] ?? '';
    const octal = /^[0-7]{3}/u.exec(body.slice(index + 1, index + 4));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      index += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Recognises a checkout refused because of local changes and lists the files Git named. Returns
 * undefined for any other failure, so it can be reported as before.
 */
export function parseCheckoutConflict(stderr: string): CheckoutConflict | undefined {
  const conflict: CheckoutConflict = { modified: [], untracked: [] };
  let target: string[] | undefined;
  for (const line of stderr.split(/\r?\n/u)) {
    if (MODIFIED_HEADER.test(line)) target = conflict.modified;
    else if (UNTRACKED_HEADER.test(line)) target = conflict.untracked;
    else if (target && line.startsWith('\t')) target.push(unquoteGitPath(line.slice(1)));
    else target = undefined;
  }
  return conflict.modified.length || conflict.untracked.length ? conflict : undefined;
}

const LISTED_FILES = 10;

/** The file list for the confirmation dialog, cut off after a few names. */
export function describeCheckoutConflict(conflict: CheckoutConflict): string {
  const lines = [
    ...conflict.modified.map((path) => `${path} (modified)`),
    ...conflict.untracked.map((path) => `${path} (untracked)`),
  ];
  const shown = lines.slice(0, LISTED_FILES);
  if (lines.length > LISTED_FILES) shown.push(`…and ${String(lines.length - LISTED_FILES)} more`);
  return shown.join('\n');
}
