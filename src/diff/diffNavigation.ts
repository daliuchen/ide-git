export type NavigationDirection = 'next' | 'previous';

/** How long a second F7 at the last change still counts as "go to the next file". */
export const SECOND_PRESS_WINDOW_MS = 3_000;

/**
 * The editor's own next/previous change command wraps around at the ends instead of failing.
 * A cursor that did not move forward (or backward) therefore means it was already at the last
 * (or first) change of the file.
 */
export function movedInDirection(direction: NavigationDirection, before: number, after: number): boolean {
  return direction === 'next' ? after > before : after < before;
}

export function neighborIndex(
  length: number,
  index: number,
  direction: NavigationDirection,
): number | undefined {
  const target = direction === 'next' ? index + 1 : index - 1;
  return target >= 0 && target < length ? target : undefined;
}

/** Requires the same key twice within the window, like the IDE's "press again to go to the next file". */
export class SecondPressGate {
  private pending: { key: string; at: number } | undefined;

  constructor(
    private readonly windowMs = SECOND_PRESS_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when this press confirms an earlier one with the same key; otherwise arms the gate. */
  press(key: string): boolean {
    const time = this.now();
    const confirmed =
      this.pending !== undefined && this.pending.key === key && time - this.pending.at <= this.windowMs;
    this.pending = confirmed ? undefined : { key, at: time };
    return confirmed;
  }

  reset(): void {
    this.pending = undefined;
  }
}
