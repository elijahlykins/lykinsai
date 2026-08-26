// Split View geometry — pure helpers over the split state shape
// ({ layout, cells, span, vRatio, hRatio, focus }) that Studio keeps while
// two or four apps are tiled macOS-style.

export function splitCells(split) {
  if (!split) return [];
  if (Array.isArray(split.cells) && split.cells.length) return split.cells;
  return [split.left || null, split.right || null];
}

export function splitHasApp(split, id) {
  return !!id && splitCells(split).includes(id);
}

export function splitSpan(split) {
  return split?.span === "left" || split?.span === "right" ? split.span : null;
}

export function splitColumnOf(index) {
  return index % 2 === 0 ? "left" : "right";
}

export function splitSibling(index) {
  return index ^ 2;
}

export function splitSpanIndex(cells, side) {
  if (side === "left") return cells[0] ? 0 : cells[2] ? 2 : 0;
  return cells[1] ? 1 : cells[3] ? 3 : 1;
}

export function visibleSplitIndexes(split) {
  const cells = splitCells(split);
  if ((split?.layout || 2) !== 4) return cells.map((_, i) => i);
  const span = splitSpan(split);
  if (span === "left") return [splitSpanIndex(cells, "left"), 1, 3];
  if (span === "right") return [splitSpanIndex(cells, "right"), 0, 2];
  return [0, 1, 2, 3];
}

export function hiddenSplitIndex(split) {
  const cells = splitCells(split);
  const span = splitSpan(split);
  if (span === "left") return cells[0] ? 2 : 0;
  if (span === "right") return cells[1] ? 3 : 1;
  return -1;
}
