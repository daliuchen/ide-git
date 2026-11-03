export const NEXT_CHANGE_COMMAND = 'gitLogWorkbench.diff.nextChange';
export const PREVIOUS_CHANGE_COMMAND = 'gitLogWorkbench.diff.previousChange';
const WHEN = 'gitLogWorkbench.diffNavigation && textCompareEditorVisible';

export const IDE_GIT_F7_BINDINGS = [
  { key: 'f7', command: NEXT_CHANGE_COMMAND, when: WHEN },
  { key: 'shift+f7', command: PREVIOUS_CHANGE_COMMAND, when: WHEN },
];

export interface ExtensionLike {
  id: string;
  packageJSON: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** Keybindings that only apply while debugging never compete with F7 in a diff. */
function isDebugOnly(when: unknown): boolean {
  return typeof when === 'string' && /\b(?:debugState|inDebugMode)\b/u.test(when) && !/textCompareEditor|diff/iu.test(when);
}

/** Display names of other extensions that bind F7 or Shift+F7 outside debugging. */
export function findCompetingF7Bindings(
  extensions: readonly ExtensionLike[],
  ownId: string,
  platform: NodeJS.Platform,
): string[] {
  const names: string[] = [];
  for (const extension of extensions) {
    if (extension.id.toLowerCase() === ownId.toLowerCase()) continue;
    const manifest = record(extension.packageJSON);
    const keybindings = record(manifest?.contributes)?.keybindings;
    const list = Array.isArray(keybindings) ? keybindings : keybindings ? [keybindings] : [];
    const competes = list.some((entry) => {
      const binding = record(entry);
      if (!binding) return false;
      const key = (platform === 'darwin' && typeof binding.mac === 'string' ? binding.mac : binding.key) as unknown;
      return typeof key === 'string' && /^(?:shift\+)?f7$/iu.test(key.trim()) && !isDebugOnly(binding.when);
    });
    if (competes) {
      const name = manifest?.displayName ?? manifest?.name;
      names.push(typeof name === 'string' && name && !name.startsWith('%') ? name : extension.id);
    }
  }
  return names;
}

export function hasIdeGitF7Bindings(keybindingsText: string): boolean {
  return keybindingsText.includes(NEXT_CHANGE_COMMAND);
}

/** Index of the last character before `end` that is neither whitespace nor inside a comment. */
function lastCodeIndexBefore(text: string, end: number): number {
  // Comments are blanked out (keeping offsets) so that brackets and commas inside them are ignored.
  const code = text
    .slice(0, end)
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, (match) =>
      match.startsWith('"') ? match : ' '.repeat(match.length),
    );
  let index = code.length - 1;
  while (index >= 0 && /\s/u.test(code[index] ?? '')) index -= 1;
  return index;
}

/**
 * Adds IDE Git's F7 bindings to the end of a keybindings.json (JSON with comments), leaving the
 * rest of the text as it is. Returns undefined when the text is not a JSON array.
 */
export function insertIdeGitF7Bindings(keybindingsText: string): string | undefined {
  const block = [
    '  // IDE Git: F7 / Shift+F7 in its diffs continue into the next / previous file.',
    IDE_GIT_F7_BINDINGS.map(
      (binding) => `  { "key": "${binding.key}", "command": "${binding.command}", "when": "${binding.when}" }`,
    ).join(',\n'),
  ].join('\n');
  if (!keybindingsText.trim()) return `[\n${block}\n]\n`;
  const close = lastCodeIndexBefore(keybindingsText, keybindingsText.length);
  if (keybindingsText[close] !== ']') return undefined;
  const beforeClose = lastCodeIndexBefore(keybindingsText, close);
  if (beforeClose < 0) return undefined;
  const previous = keybindingsText[beforeClose];
  const separator = previous === '[' || previous === ',' ? '' : ',';
  // Keep anything between the last entry and `]`, such as a trailing comment.
  const between = keybindingsText.slice(beforeClose + 1, close).replace(/\s+$/u, '');
  return `${keybindingsText.slice(0, beforeClose + 1)}${separator}${between}\n${block}\n${keybindingsText.slice(close)}`;
}
