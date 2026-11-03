export interface BlameLine {
  hash: string;
  author: string;
  authorTime: number;
  summary: string;
  /** Path of the file in that commit (it may have been renamed since). */
  filename: string;
  previous?: { hash: string; filename: string };
  /** 1-based line number of this line in the blamed commit's version of the file. */
  sourceLine: number;
}

/** Parses `git blame --porcelain` into one entry per final line. */
export function parseBlamePorcelain(output: string): BlameLine[] {
  const commits = new Map<string, Omit<BlameLine, 'hash' | 'sourceLine'>>();
  const lines: BlameLine[] = [];
  const records = output.split('\n');
  let index = 0;
  while (index < records.length) {
    const header = records[index] ?? '';
    const match = /^([0-9a-f]{40,64}) (\d+) (\d+)/u.exec(header);
    index += 1;
    if (!match) continue;
    const hash = match[1] ?? '';
    const sourceLine = Number(match[2]);
    const info: Partial<Omit<BlameLine, 'hash' | 'sourceLine'>> = { ...commits.get(hash) };
    while (index < records.length && !(records[index] ?? '').startsWith('\t')) {
      const line = records[index] ?? '';
      const space = line.indexOf(' ');
      const key = space < 0 ? line : line.slice(0, space);
      const value = space < 0 ? '' : line.slice(space + 1);
      if (key === 'author') info.author = value;
      else if (key === 'author-time') info.authorTime = Number(value);
      else if (key === 'summary') info.summary = value;
      else if (key === 'filename') info.filename = value;
      else if (key === 'previous') {
        const separator = value.indexOf(' ');
        if (separator > 0) info.previous = { hash: value.slice(0, separator), filename: value.slice(separator + 1) };
      }
      index += 1;
    }
    index += 1; // the content line
    const complete: Omit<BlameLine, 'hash' | 'sourceLine'> = {
      author: info.author ?? '',
      authorTime: info.authorTime ?? 0,
      summary: info.summary ?? '',
      filename: info.filename ?? '',
      ...(info.previous ? { previous: info.previous } : {}),
    };
    commits.set(hash, complete);
    lines.push({ hash, ...complete, sourceLine });
  }
  return lines;
}
