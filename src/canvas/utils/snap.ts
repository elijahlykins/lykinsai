export function snapToGrid(value: number, gridSize: number) {
  const g = Math.max(1, gridSize || 1);
  return Math.round(value / g) * g;
}

