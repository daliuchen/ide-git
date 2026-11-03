export interface StashLabel {
  /** The branch the stash was made on; undefined when it was made on a detached HEAD. */
  branch?: string;
  message: string;
}

/**
 * Splits Git's stash subject into branch and message: `On main: my message` for stashes with a
 * message, `WIP on main: 1a2b3c4 last commit subject` for those without.
 */
export function parseStashSubject(subject: string): StashLabel {
  const match = /^(?:WIP on|On) (.+?): (.*)$/su.exec(subject);
  if (!match) return { message: subject };
  const branch = match[1] ?? '';
  const message = match[2] ?? '';
  return branch === '(no branch)' ? { message } : { branch, message };
}
