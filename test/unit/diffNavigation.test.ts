import { describe, expect, it } from 'vitest';
import { movedInDirection, neighborIndex, SecondPressGate } from '../../src/diff/diffNavigation';

describe('diff navigation', () => {
  it('treats a cursor that did not move forward as the last change', () => {
    expect(movedInDirection('next', 10, 20)).toBe(true);
    expect(movedInDirection('next', 20, 3)).toBe(false);
    expect(movedInDirection('next', 20, 20)).toBe(false);
    expect(movedInDirection('previous', 20, 10)).toBe(true);
    expect(movedInDirection('previous', 3, 40)).toBe(false);
  });

  it('finds the neighbouring file and stops at both ends', () => {
    expect(neighborIndex(3, 0, 'next')).toBe(1);
    expect(neighborIndex(3, 2, 'next')).toBeUndefined();
    expect(neighborIndex(3, 2, 'previous')).toBe(1);
    expect(neighborIndex(3, 0, 'previous')).toBeUndefined();
  });

  it('needs a second press with the same key inside the window', () => {
    let now = 0;
    const gate = new SecondPressGate(3_000, () => now);
    expect(gate.press('next:a')).toBe(false);
    now = 1_000;
    expect(gate.press('next:a')).toBe(true);
    // Confirming consumes the gate.
    expect(gate.press('next:a')).toBe(false);
    now = 5_000;
    expect(gate.press('next:a')).toBe(false);
    now = 9_000;
    expect(gate.press('previous:a')).toBe(false);
    expect(gate.press('next:a')).toBe(false);
    gate.reset();
    expect(gate.press('next:a')).toBe(false);
  });
});
