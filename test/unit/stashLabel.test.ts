import { describe, expect, it } from 'vitest';
import { parseStashSubject } from '../../webview/src/stashLabel';

describe('parseStashSubject', () => {
  it('splits branch and message', () => {
    expect(parseStashSubject('On main: 暂存起来')).toEqual({ branch: 'main', message: '暂存起来' });
    expect(parseStashSubject('WIP on feat/history: 1a2b3c4 feat: add history')).toEqual({
      branch: 'feat/history',
      message: '1a2b3c4 feat: add history',
    });
    expect(parseStashSubject('On main: note: with a colon')).toEqual({ branch: 'main', message: 'note: with a colon' });
  });

  it('handles detached HEAD and unexpected subjects', () => {
    expect(parseStashSubject('On (no branch): experiment')).toEqual({ message: 'experiment' });
    expect(parseStashSubject('something else')).toEqual({ message: 'something else' });
  });
});
