export function snapToGrid(value: number, gridSize: number) {
  const g = Math.max(1, gridSize || 1);
  return Math.round(value / g) * g;
}

/**
 * Size-aware snap. For top-left coordinates that should align such that the
 * block's far edge also falls on a grid line, snap the start position with
 * floor and the size with ceil. Callers that don't care about edge alignment
 * should keep using `snapToGrid`.
 */
export function snapTopLeftWithSize(start: number, size: number, gridSize: number) {
  const g = Math.max(1, gridSize || 1);
  const snappedStart = Math.floor((start || 0) / g) * g;
  const end = Math.max(snappedStart + g, snappedStart + (size || g));
  const snappedEnd = Math.ceil(end / g) * g;
  return { start: snappedStart, size: Math.max(g, snappedEnd - snappedStart) };
}

