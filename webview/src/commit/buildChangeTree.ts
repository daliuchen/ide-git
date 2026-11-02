import type {
  CommitViewChange,
  CommitViewRepository,
} from '../../../src/commit/commitProtocol';

export type ChangeGroupKind = 'changes' | 'unversioned' | 'conflicts';

export interface ChangeTreeNode {
  id: string;
  kind: 'group' | 'repository' | 'directory' | 'file';
  label: string;
  /** Secondary text, such as the directory of a file in flat mode. */
  detail?: string;
  depth: number;
  children: ChangeTreeNode[];
  /** Every change at or below this node. */
  changes: CommitViewChange[];
  change?: CommitViewChange;
  groupKind?: ChangeGroupKind;
  repositoryId?: string;
}

export function changeId(change: Pick<CommitViewChange, 'repositoryId' | 'path'>): string {
  return `${change.repositoryId}\0${change.path}`;
}

function sortNodes(nodes: ChangeTreeNode[]): void {
  nodes.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : right.kind === 'directory' ? 1 : 0;
    return left.label.localeCompare(right.label, undefined, { sensitivity: 'base', numeric: true });
  });
  for (const node of nodes) sortNodes(node.children);
}

/** Merges chains of single-child directories into one node (`src/commit`). */
function compact(nodes: ChangeTreeNode[]): ChangeTreeNode[] {
  return nodes.map((node) => {
    let current = node;
    while (
      current.kind === 'directory' &&
      current.children.length === 1 &&
      current.children[0]?.kind === 'directory'
    ) {
      const child = current.children[0];
      current = { ...child, label: `${current.label}/${child.label}` };
    }
    return { ...current, children: compact(current.children) };
  });
}

function setDepth(nodes: ChangeTreeNode[], depth: number): void {
  for (const node of nodes) {
    node.depth = depth;
    setDepth(node.children, depth + 1);
  }
}

function buildFiles(
  changes: readonly CommitViewChange[],
  prefix: string,
  groupByDirectory: boolean,
): ChangeTreeNode[] {
  if (!groupByDirectory) {
    const files = changes.map<ChangeTreeNode>((change) => {
      const slash = change.path.lastIndexOf('/');
      return {
        id: `${prefix}|f|${changeId(change)}`,
        kind: 'file',
        label: change.path.slice(slash + 1),
        ...(slash > 0 ? { detail: change.path.slice(0, slash) } : {}),
        depth: 0,
        children: [],
        changes: [change],
        change,
      };
    });
    sortNodes(files);
    return files;
  }
  const root: ChangeTreeNode[] = [];
  const directories = new Map<string, ChangeTreeNode>();
  for (const change of changes) {
    const parts = change.path.split('/');
    const name = parts.pop() ?? change.path;
    let siblings = root;
    let parentPath = '';
    const ancestors: ChangeTreeNode[] = [];
    for (const part of parts) {
      const path = parentPath ? `${parentPath}/${part}` : part;
      let directory = directories.get(path);
      if (!directory) {
        directory = {
          id: `${prefix}|d|${change.repositoryId}\0${path}`,
          kind: 'directory',
          label: part,
          detail: path,
          depth: 0,
          children: [],
          changes: [],
        };
        directories.set(path, directory);
        siblings.push(directory);
      }
      ancestors.push(directory);
      siblings = directory.children;
      parentPath = path;
    }
    for (const ancestor of ancestors) ancestor.changes.push(change);
    siblings.push({
      id: `${prefix}|f|${changeId(change)}`,
      kind: 'file',
      label: name,
      depth: 0,
      children: [],
      changes: [change],
      change,
    });
  }
  sortNodes(root);
  return compact(root);
}

function buildGroupChildren(
  prefix: string,
  changes: readonly CommitViewChange[],
  repositories: readonly CommitViewRepository[],
  groupByDirectory: boolean,
): ChangeTreeNode[] {
  if (repositories.length <= 1) return buildFiles(changes, prefix, groupByDirectory);
  return repositories.flatMap((repository) => {
    const repositoryChanges = changes.filter((change) => change.repositoryId === repository.id);
    if (!repositoryChanges.length) return [];
    const id = `${prefix}|r|${repository.id}`;
    return [
      {
        id,
        kind: 'repository' as const,
        label: repository.name,
        ...(repository.branch ? { detail: repository.branch } : {}),
        depth: 0,
        children: buildFiles(repositoryChanges, id, groupByDirectory),
        changes: repositoryChanges,
        repositoryId: repository.id,
      },
    ];
  });
}

export interface BuildChangeTreeOptions {
  changes: readonly CommitViewChange[];
  repositories: readonly CommitViewRepository[];
  groupByDirectory: boolean;
  showUnversioned: boolean;
}

export function buildChangeTree(options: BuildChangeTreeOptions): ChangeTreeNode[] {
  const { changes, repositories, groupByDirectory } = options;
  const groups: ChangeTreeNode[] = [];
  const conflicts = changes.filter((change) => change.status === 'U');
  if (conflicts.length) {
    groups.push({
      id: 'g|conflicts',
      kind: 'group',
      groupKind: 'conflicts',
      label: 'Merge Conflicts',
      depth: 0,
      children: buildGroupChildren('g|conflicts', conflicts, repositories, groupByDirectory),
      changes: conflicts,
    });
  }
  const tracked = changes.filter((change) => change.status !== 'U' && change.status !== '?');
  // Stays visible when empty so the view never looks broken.
  groups.push({
    id: 'g|changes',
    kind: 'group',
    groupKind: 'changes',
    label: 'Changes',
    depth: 0,
    children: buildGroupChildren('g|changes', tracked, repositories, groupByDirectory),
    changes: tracked,
  });
  const unversioned = changes.filter((change) => change.status === '?');
  if (options.showUnversioned && unversioned.length) {
    groups.push({
      id: 'g|unversioned',
      kind: 'group',
      groupKind: 'unversioned',
      label: 'Unversioned Files',
      depth: 0,
      children: buildGroupChildren('g|unversioned', unversioned, repositories, groupByDirectory),
      changes: unversioned,
    });
  }
  setDepth(groups, 0);
  return groups;
}

export function flattenVisible(nodes: readonly ChangeTreeNode[], collapsed: ReadonlySet<string>): ChangeTreeNode[] {
  const rows: ChangeTreeNode[] = [];
  const visit = (list: readonly ChangeTreeNode[]): void => {
    for (const node of list) {
      rows.push(node);
      if (node.children.length && !collapsed.has(node.id)) visit(node.children);
    }
  };
  visit(nodes);
  return rows;
}

export function collectNodeIds(nodes: readonly ChangeTreeNode[]): string[] {
  const ids: string[] = [];
  const visit = (list: readonly ChangeTreeNode[]): void => {
    for (const node of list) {
      if (node.children.length) ids.push(node.id);
      visit(node.children);
    }
  };
  visit(nodes);
  return ids;
}

/** Every file of the tree in display order, including those inside collapsed nodes. */
export function orderedFileChanges(nodes: readonly ChangeTreeNode[]): CommitViewChange[] {
  return nodes.flatMap((node) =>
    node.kind === 'file' && node.change ? [node.change] : orderedFileChanges(node.children),
  );
}
