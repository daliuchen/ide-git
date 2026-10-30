import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('feature surface', () => {
  it('keeps stash management and Amend HEAD alongside the IDE-style history rewrites', async () => {
    const [app, protocol] = await Promise.all([
      readFile('webview/src/App.tsx', 'utf8'),
      readFile('src/protocol/messages.ts', 'utf8'),
    ]);

    expect(app).toContain('Manage stashes');
    expect(app).toContain('Amend HEAD…');
    expect(protocol).toContain("kind: 'createStash'");
    expect(protocol).toContain("kind: 'amendCommit'");
    // This fork deliberately restores interactive rebase, which upstream had removed.
    expect(protocol).toContain("kind: 'interactiveRebase'");
  });
});
