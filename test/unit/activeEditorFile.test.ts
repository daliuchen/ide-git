import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeRevisionQuery } from '../../src/diff/diffModel';
import { REVISION_SCHEME } from '../../src/diff/RevisionContentProvider';
import { resolveActiveEditorFile } from '../../src/editor/activeEditorFile';

describe('resolveActiveEditorFile', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'active-editor-file-'));
    await mkdir(join(directory, 'repo', 'app', 'models'), { recursive: true });
    await mkdir(join(directory, 'repo', 'vendor', 'nested', 'lib'), { recursive: true });
    await writeFile(join(directory, 'repo', 'app', 'models', 'user 名.rb'), '');
    await writeFile(join(directory, 'repo', 'vendor', 'nested', 'lib', 'a.rb'), '');
    await symlink(join(directory, 'repo'), join(directory, 'link'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const file = (path: string) => ({ scheme: 'file', fsPath: path, query: '' });

  it('maps a working-tree file to its repository path, through symlinks', async () => {
    const roots = [['repo-1', join(directory, 'link')]] as const;
    await expect(
      resolveActiveEditorFile(file(join(directory, 'repo', 'app', 'models', 'user 名.rb')), roots),
    ).resolves.toEqual({ repositoryId: 'repo-1', path: 'app/models/user 名.rb' });
  });

  it('prefers the innermost repository and ignores files outside every root', async () => {
    const roots = [
      ['outer', join(directory, 'repo')],
      ['inner', join(directory, 'repo', 'vendor', 'nested')],
    ] as const;
    await expect(
      resolveActiveEditorFile(file(join(directory, 'repo', 'vendor', 'nested', 'lib', 'a.rb')), roots),
    ).resolves.toEqual({ repositoryId: 'inner', path: 'lib/a.rb' });
    await expect(resolveActiveEditorFile(file(join(directory, 'elsewhere.rb')), roots)).resolves.toBeUndefined();
    await expect(resolveActiveEditorFile(file(join(directory, 'repo')), roots)).resolves.toBeUndefined();
  });

  it('reads revision documents from their query', async () => {
    const query = encodeRevisionQuery({ repositoryId: 'repo-1', revision: 'a'.repeat(40), path: 'lib/x.ts', empty: false });
    await expect(
      resolveActiveEditorFile({ scheme: REVISION_SCHEME, fsPath: '/lib/x.ts', query }, []),
    ).resolves.toEqual({ repositoryId: 'repo-1', path: 'lib/x.ts' });
    await expect(
      resolveActiveEditorFile({ scheme: 'untitled', fsPath: 'Untitled-1', query: '' }, []),
    ).resolves.toBeUndefined();
  });
});
