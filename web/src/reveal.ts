/** How far to scroll a widget body so a row sits just under the fixed head: positive scrolls down. Rows already at or above that line do not move the body backwards past `scrollTop`. */
export function revealDelta(rowTop: number, headBottom: number): number {
  return Math.round(rowTop - headBottom);
}

/** Index of the first row the "+N" button revealed: the rows that were visible stay above it. */
export function firstRevealed(total: number, hiddenBefore: number): number {
  return Math.max(0, Math.min(total - 1, total - hiddenBefore));
}
