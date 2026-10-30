export interface BranchRef {
  kind: 'local' | 'remote';
  name: string;
  target: string;
  upstream?: string;
  track?: string;
  current: boolean;
  remote?: string;
}

export function parseBranchRefs(output: string): BranchRef[] {
  const branches: BranchRef[] = [];
  for (const line of output.split('\n')) {
    const [refname = '', short = '', target = '', upstream = '', track = '', head = '', remote = ''] = line.split('\x1f');
    if (refname.startsWith('refs/heads/')) {
      branches.push({
        kind: 'local',
        name: short,
        target,
        ...(upstream ? { upstream } : {}),
        ...(track ? { track } : {}),
        current: head === '*',
      });
    } else if (refname.startsWith('refs/remotes/') && !refname.endsWith('/HEAD')) {
      const remoteName = remote || short.slice(0, short.indexOf('/'));
      branches.push({ kind: 'remote', name: short, target, current: false, ...(remoteName ? { remote: remoteName } : {}) });
    }
  }
  return branches;
}
