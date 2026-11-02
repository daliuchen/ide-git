import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { parseRevisionQuery } from '../diff/diffModel';
import { REVISION_SCHEME } from '../diff/RevisionContentProvider';

export interface ActiveEditorFile {
  repositoryId: string;
  /** Repository-relative path with `/` separators. */
  path: string;
}

export interface EditorResource {
  scheme: string;
  fsPath: string;
  query: string;
}

async function canonical(path: string, resolvePath: (path: string) => Promise<string>): Promise<string> {
  try {
    return await resolvePath(path);
  } catch {
    // Deleted files and unsaved renames have no real path; compare them as they are.
    return path;
  }
}

/**
 * Maps an editor resource to the repository file it shows: revision documents carry the path in
 * their query, real files are matched against the repository roots (after resolving symlinks such
 * as macOS's /tmp → /private/tmp). The innermost root wins for nested repositories.
 */
export async function resolveActiveEditorFile(
  resource: EditorResource,
  roots: Iterable<readonly [repositoryId: string, root: string]>,
  resolvePath: (path: string) => Promise<string> = realpath,
): Promise<ActiveEditorFile | undefined> {
  if (resource.scheme === REVISION_SCHEME) {
    const query = parseRevisionQuery(resource.query);
    return query ? { repositoryId: query.repositoryId, path: query.path } : undefined;
  }
  if (resource.scheme !== 'file') return undefined;
  const file = await canonical(resource.fsPath, resolvePath);
  let match: (ActiveEditorFile & { depth: number }) | undefined;
  for (const [repositoryId, root] of roots) {
    const canonicalRoot = await canonical(root, resolvePath);
    const path = relative(canonicalRoot, file);
    if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) continue;
    const depth = canonicalRoot.length;
    if (!match || depth > match.depth) {
      match = { repositoryId, path: path.split(sep).join('/'), depth };
    }
  }
  return match ? { repositoryId: match.repositoryId, path: match.path } : undefined;
}
