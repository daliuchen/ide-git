import { describe, expect, it } from 'vitest';
import {
  findCompetingF7Bindings,
  hasIdeGitF7Bindings,
  insertIdeGitF7Bindings,
} from '../../src/diff/f7Conflict';

const parseJsonc = (text: string): unknown =>
  JSON.parse(text.replace(/\/\/[^\n]*/gu, '').replace(/,(\s*\])/gu, '$1')) as unknown;

describe('findCompetingF7Bindings', () => {
  const extension = (id: string, keybindings: unknown, displayName?: string) => ({
    id,
    packageJSON: { name: id.split('.')[1], ...(displayName ? { displayName } : {}), contributes: { keybindings } },
  });
  const all = [
    extension('ethanliuchen.ide-git', [{ key: 'f7', command: 'gitLogWorkbench.diff.nextChange' }]),
    extension('k--kato.intellij-idea-keybindings', [
      { key: 'f7', mac: 'f7', command: 'workbench.action.debug.stepInto', when: "debugState != 'inactive'" },
      { key: 'f7', mac: 'f7', command: 'workbench.action.compareEditor.nextChange', when: 'textCompareEditorVisible' },
    ], 'IntelliJ IDEA Keybindings'),
    extension('ms-python.debugger', [{ key: 'f7', command: 'stepInto', when: 'inDebugMode' }]),
    extension('some.mac-only', [{ key: 'ctrl+f7', mac: 'shift+f7', command: 'x' }]),
    extension('no.keys', undefined),
  ];

  it('lists other extensions that bind F7 outside debugging', () => {
    expect(findCompetingF7Bindings(all, 'EthanLiuChen.ide-git', 'darwin')).toEqual(['IntelliJ IDEA Keybindings', 'mac-only']);
    expect(findCompetingF7Bindings(all, 'EthanLiuChen.ide-git', 'linux')).toEqual(['IntelliJ IDEA Keybindings']);
  });
});

describe('insertIdeGitF7Bindings', () => {
  it('appends to an existing list, keeping comments and other entries', () => {
    const original = '// Place your key bindings in this file\n[\n  { "key": "cmd+9", "command": "a" } // mine\n]\n';
    const updated = insertIdeGitF7Bindings(original) ?? '';
    expect(updated.startsWith('// Place your key bindings in this file\n[\n  { "key": "cmd+9", "command": "a" },')).toBe(true);
    expect(updated).toContain('// mine');
    expect(parseJsonc(updated)).toEqual([
      { key: 'cmd+9', command: 'a' },
      { key: 'f7', command: 'gitLogWorkbench.diff.nextChange', when: 'gitLogWorkbench.diffNavigation && textCompareEditorVisible' },
      { key: 'shift+f7', command: 'gitLogWorkbench.diff.previousChange', when: 'gitLogWorkbench.diffNavigation && textCompareEditorVisible' },
    ]);
    expect(hasIdeGitF7Bindings(updated)).toBe(true);
  });

  it('handles an empty file, an empty list and a trailing comma', () => {
    expect(parseJsonc(insertIdeGitF7Bindings('') ?? '')).toHaveLength(2);
    expect(parseJsonc(insertIdeGitF7Bindings('[]') ?? '')).toHaveLength(2);
    const trailing = insertIdeGitF7Bindings('[\n  { "key": "a", "command": "b" },\n]') ?? '';
    expect(trailing).not.toContain(',,');
    expect(parseJsonc(trailing)).toHaveLength(3);
  });

  it('ignores brackets in comments and strings, and refuses non-arrays', () => {
    const tricky = '[\n  { "key": "a", "command": "]" }\n  /* ] */\n]';
    expect(parseJsonc((insertIdeGitF7Bindings(tricky) ?? '').replace(/\/\*[^*]*\*\//gu, ''))).toHaveLength(3);
    expect(insertIdeGitF7Bindings('{ "not": "a list" }')).toBeUndefined();
    expect(hasIdeGitF7Bindings('[]')).toBe(false);
  });
});
