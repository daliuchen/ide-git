import { redactGitDiagnostic } from '../git/classifyGitError';

export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  /** Set only when pushes go to a different URL. */
  pushUrl?: string;
}

/** Parses `git remote -v` (one fetch and one push line per remote). */
export function parseRemotes(output: string): RemoteInfo[] {
  const remotes = new Map<string, { fetch?: string; push?: string }>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(\S+)\t(.*) \((fetch|push)\)$/u.exec(line);
    if (!match) continue;
    const [, name = '', url = '', kind] = match;
    const entry = remotes.get(name) ?? {};
    if (kind === 'fetch') entry.fetch = url;
    else entry.push = url;
    remotes.set(name, entry);
  }
  return [...remotes].map(([name, { fetch, push }]) => ({
    name,
    fetchUrl: fetch ?? push ?? '',
    ...(push && fetch && push !== fetch ? { pushUrl: push } : {}),
  }));
}

/** Hides a user name or token embedded in a URL before it is shown. */
export function displayRemoteUrl(url: string): string {
  return redactGitDiagnostic(url);
}

/** Why `name` cannot be a remote name, or undefined when it can. */
export function remoteNameProblem(name: string, existing: readonly string[] = []): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a remote name.';
  if (existing.includes(trimmed)) return `A remote named “${trimmed}” already exists.`;
  // The shape Git accepts for refs/remotes/<name>/…, without leading dashes that look like options.
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/u.test(trimmed) || /\.\.|\.lock(?:\/|$)|\.$/u.test(trimmed)) {
    return 'Use letters, digits, “.”, “_”, “-” and “/”, not starting with “-”.';
  }
  return undefined;
}

/** Why `url` cannot be a remote URL, or undefined when it can. */
export function remoteUrlProblem(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) return 'Enter the remote URL.';
  if (trimmed.startsWith('-')) return 'A URL cannot start with “-”.';
  // Spaces are fine (local paths); line breaks and NUL would end up as separate config values.
  if (/[\r\n\0]/u.test(trimmed)) return 'A URL cannot contain line breaks.';
  return undefined;
}
