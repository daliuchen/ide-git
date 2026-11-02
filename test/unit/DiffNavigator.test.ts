import { beforeEach, describe, expect, it, vi } from 'vitest';

const editorState = vi.hoisted(() => ({
  /** Change start lines of the diff in the active editor. */
  changes: [] as number[],
  line: 0,
  lineCount: 100,
  activeInput: undefined as unknown,
  statusMessages: [] as string[],
  contexts: [] as boolean[],
}));

const vscodeMock = vi.hoisted(() => {
  class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  }
  class Selection {
    readonly active: Position;
    constructor(_anchor: Position, active: Position) {
      this.active = active;
    }
  }
  class Range {
    constructor(
      readonly start: Position,
      readonly end: Position,
    ) {}
  }
  class TabInputTextDiff {
    constructor(
      readonly original: { toString(): string },
      readonly modified: { toString(): string },
    ) {}
  }
  const editor = {
    get selection() {
      return new Selection(new Position(editorState.line, 0), new Position(editorState.line, 0));
    },
    set selection(value: Selection) {
      editorState.line = value.active.line;
    },
    get document() {
      return { lineCount: editorState.lineCount };
    },
    revealRange: () => undefined,
  };
  // Mirrors the editor's own command: the next change after the cursor, wrapping around.
  const nativeNext = () => {
    const next = editorState.changes.find((line) => line > editorState.line) ?? editorState.changes[0];
    if (next !== undefined) editorState.line = next;
  };
  const nativePrevious = () => {
    const previous =
      [...editorState.changes].reverse().find((line) => line < editorState.line) ?? editorState.changes.at(-1);
    if (previous !== undefined) editorState.line = previous;
  };
  return {
    Position,
    Selection,
    Range,
    TabInputTextDiff,
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    window: {
      get activeTextEditor() {
        return editor;
      },
      tabGroups: {
        get activeTabGroup() {
          return { activeTab: { input: editorState.activeInput } };
        },
        onDidChangeTabs: () => ({ dispose: () => undefined }),
      },
      onDidChangeActiveTextEditor: () => ({ dispose: () => undefined }),
      setStatusBarMessage: (message: string) => {
        editorState.statusMessages.push(message);
        return { dispose: () => undefined };
      },
    },
    commands: {
      executeCommand: vi.fn((command: string, ...args: unknown[]) => {
        if (command === 'workbench.action.compareEditor.nextChange') nativeNext();
        if (command === 'workbench.action.compareEditor.previousChange') nativePrevious();
        if (command === 'setContext') editorState.contexts.push(args[1] === true);
        return Promise.resolve(undefined);
      }),
    },
  };
});

vi.mock('vscode', () => vscodeMock);

const { DiffNavigator } = await import('../../src/diff/DiffNavigator');

const FILES: Record<string, number[]> = { 'a.ts': [5, 30], 'b.ts': [0, 12, 50], 'c.ts': [8] };

function item(name: string) {
  return {
    label: name,
    open: vi.fn(() => {
      editorState.activeInput = new vscodeMock.TabInputTextDiff(`left:${name}`, `right:${name}`);
      editorState.changes = FILES[name] ?? [];
      editorState.line = 0;
      return Promise.resolve();
    }),
  };
}

describe('DiffNavigator', () => {
  beforeEach(() => {
    editorState.statusMessages.length = 0;
    editorState.contexts.length = 0;
    vscodeMock.commands.executeCommand.mockClear();
  });

  it('steps through changes, then asks for a second press before opening the next file', async () => {
    const navigator = new DiffNavigator();
    const items = [item('a.ts'), item('b.ts'), item('c.ts')];
    await navigator.open(items, 0);
    expect(editorState.contexts.at(-1)).toBe(true);

    await navigator.navigate('next');
    expect(editorState.line).toBe(5);
    await navigator.navigate('next');
    expect(editorState.line).toBe(30);

    await navigator.navigate('next');
    expect(editorState.line).toBe(30);
    expect(editorState.statusMessages.at(-1)).toContain('press again to open b.ts');
    expect(items[1]?.open).not.toHaveBeenCalled();

    await navigator.navigate('next');
    expect(items[1]?.open).toHaveBeenCalledTimes(1);
    // b.ts starts with a change on its first line; it must not be skipped.
    expect(editorState.line).toBe(0);
  });

  it('goes back to the last change of the previous file and stops at the ends', async () => {
    const navigator = new DiffNavigator();
    const items = [item('a.ts'), item('b.ts')];
    await navigator.open(items, 1);
    await navigator.navigate('previous');
    await navigator.navigate('previous');
    expect(items[0]?.open).toHaveBeenCalledTimes(1);
    expect(editorState.line).toBe(30);

    await navigator.navigate('previous');
    await navigator.navigate('previous');
    await navigator.navigate('previous');
    expect(editorState.statusMessages.at(-1)).toContain('first change of the first file');
    expect(editorState.line).toBe(5);
  });

  it('falls back to the editor command in diffs it did not open', async () => {
    const navigator = new DiffNavigator();
    await navigator.open([item('a.ts'), item('b.ts')], 0);
    editorState.activeInput = new vscodeMock.TabInputTextDiff('left:other', 'right:other');
    editorState.changes = [3];
    editorState.line = 10;
    await navigator.navigate('next');
    await navigator.navigate('next');
    expect(editorState.line).toBe(3);
    expect(editorState.statusMessages).toEqual([]);
  });
});
