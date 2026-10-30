/** Whether a failed push was rejected because the remote branch has commits the local one lacks. */
export function isPushRejected(text: string): boolean {
  return /\[rejected\]|non-fast-forward|fetch first|Updates were rejected/iu.test(text);
}
