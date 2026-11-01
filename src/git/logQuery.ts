import type { LogCompare, LogFilters } from '../protocol/messages';

export const EMPTY_LOG_FILTERS: LogFilters = {
  text: '',
  branches: [],
  authors: [],
  paths: [],
};

export interface BuildLogArgumentsOptions {
  limit: number;
  skip: number;
  format: string;
  filters: LogFilters;
  textMode?: 'none' | 'message' | 'author';
}

function escapeExtendedRegexp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** The side a compare filter lists (`include`) and the side it is compared against (`exclude`). */
export function compareRange(compare: LogCompare): { include: string; exclude: string } {
  const [include, exclude] = compare.direction === 'notInHead' ? [compare.ref, 'HEAD'] : ['HEAD', compare.ref];
  return { include, exclude };
}

export function buildLogArguments(options: BuildLogArgumentsOptions): string[] {
  const args = [
    ...(options.filters.paths.length ? ['--literal-pathspecs'] : []),
    'log',
    '--date-order',
    '--no-color',
    `--format=${options.format}`,
    `--max-count=${String(options.limit)}`,
    `--skip=${String(options.skip)}`,
  ];

  const text = options.filters.text.trim();
  if (text && options.textMode === 'author') {
    const escapedText = escapeExtendedRegexp(text);
    const authorPattern = options.filters.authors.length
      ? options.filters.authors
          .map((author) => {
            const escapedAuthor = escapeExtendedRegexp(author);
            return `((${escapedAuthor}).*(${escapedText})|(${escapedText}).*(${escapedAuthor}))`;
          })
          .join('|')
      : escapedText;
    args.push('--regexp-ignore-case', '--extended-regexp', `--author=${authorPattern}`);
  } else {
    if (options.filters.authors.length) args.push('--regexp-ignore-case', '--extended-regexp');
    for (const author of options.filters.authors) {
      args.push(`--author=${escapeExtendedRegexp(author)}`);
    }
  }

  if (text && options.textMode === 'message') {
    args.push('--regexp-ignore-case', '--fixed-strings', `--grep=${text}`);
  }

  if (options.filters.dateFrom !== undefined) {
    args.push(`--since=@${String(Math.trunc(options.filters.dateFrom))}`);
  }
  if (options.filters.dateTo !== undefined) {
    args.push(`--until=@${String(Math.trunc(options.filters.dateTo))}`);
  }

  if (options.filters.compare) {
    // `HEAD...ref` with one side kept, so commits whose change the other side already has
    // (cherry-picked under another hash) drop out: the list is what is really left to bring over.
    const side = options.filters.compare.direction === 'notInHead' ? '--right-only' : '--left-only';
    args.push('--cherry-pick', side, '--end-of-options', `HEAD...${options.filters.compare.ref}`);
  }
  else if (options.filters.branches.length) args.push('--end-of-options', ...options.filters.branches);
  else args.push('--end-of-options', 'HEAD');

  if (options.filters.paths.length) args.push('--', ...options.filters.paths);
  return args;
}
