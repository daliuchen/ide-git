import type { MessageRules } from './commitProtocol';

export interface MessageIssue {
  /** 1-based line in the message. */
  line: number;
  text: string;
}

/** Commit message conventions: subject length, a blank second line, and body line length. */
export function checkCommitMessage(message: string, rules: MessageRules): MessageIssue[] {
  const lines = message.replace(/\s+$/u, '').split('\n');
  const issues: MessageIssue[] = [];
  const subject = lines[0] ?? '';
  if (rules.subjectLength > 0 && subject.length > rules.subjectLength) {
    issues.push({ line: 1, text: `Subject is ${String(subject.length)} characters; keep it within ${String(rules.subjectLength)}.` });
  }
  if (rules.blankLineAfterSubject && lines.length > 1 && lines[1]?.trim() !== '') {
    issues.push({ line: 2, text: 'Separate the subject from the body with a blank line.' });
  }
  if (rules.bodyLineLength > 0) {
    lines.forEach((line, index) => {
      if (index > 0 && line.length > rules.bodyLineLength && !/^\s*\S+:\/\/\S+$/u.test(line)) {
        issues.push({ line: index + 1, text: `Line ${String(index + 1)} is longer than ${String(rules.bodyLineLength)} characters.` });
      }
    });
  }
  return issues;
}

/**
 * Inserts the blank line after the subject and wraps body paragraphs at `width`, leaving lists,
 * indented blocks, and long URLs unwrapped.
 */
export function wrapCommitMessage(message: string, width: number): string {
  const lines = message.replace(/\s+$/u, '').split('\n');
  const [subject = '', ...rest] = lines;
  if (!rest.length) return subject;
  if (rest[0]?.trim() !== '') rest.unshift('');
  const output: string[] = [subject];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (!paragraph.length) return;
    let current = '';
    for (const word of paragraph.join(' ').split(/\s+/u).filter(Boolean)) {
      if (current && current.length + 1 + word.length > width) {
        output.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) output.push(current);
    paragraph = [];
  };
  for (const line of rest) {
    if (!line.trim() || /^\s*([-*+]|\d+[.)])\s/u.test(line) || /^\s{2,}/u.test(line) || /^[\w-]+: /u.test(line)) {
      flush();
      output.push(line);
    } else {
      paragraph.push(line.trim());
    }
  }
  flush();
  return output.join('\n');
}

/** A `commit.template` file without its `#` comment lines. */
export function templateText(raw: string): string {
  return raw
    .split(/\r?\n/u)
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .replace(/\s+$/u, '');
}

export interface TodoHit {
  path: string;
  line: number;
  text: string;
}

const TODO_PATTERN = /\b(TODO|FIXME)\b/u;

/** TODO/FIXME comments on lines added by a `git diff -U0` patch (one or more files). */
export function findAddedTodos(patch: string): TodoHit[] {
  const hits: TodoHit[] = [];
  let path = '';
  let line = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('+++ ')) {
      path = raw.slice(4).replace(/^b\//u, '');
      continue;
    }
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(raw);
    if (header) {
      line = Number(header[1]);
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      if (TODO_PATTERN.test(raw)) hits.push({ path, line, text: raw.slice(1).trim() });
      line += 1;
    }
  }
  return hits;
}

/** TODO/FIXME lines of a new (unversioned) file. */
export function findTodosInText(path: string, text: string): TodoHit[] {
  return text
    .split('\n')
    .flatMap((content, index) => (TODO_PATTERN.test(content) ? [{ path, line: index + 1, text: content.trim() }] : []));
}
