import type { BaseBlock, Camera } from "@/canvas/types";

export function isInViewport(
  block: BaseBlock,
  camera: Camera,
  viewport: { width: number; height: number },
  margin = 400
) {
  const zoom = Number.isFinite(camera.zoom) ? Math.max(camera.zoom, 0.01) : 1;
  const cx = Number.isFinite(camera.x) ? camera.x : 0;
  const cy = Number.isFinite(camera.y) ? camera.y : 0;
  const effectiveMargin = margin / Math.max(zoom, 0.1);
  const left = (block.x - cx) * zoom;
  const top = (block.y - cy) * zoom;
  const right = left + block.width * zoom;
  const bottom = top + block.height * zoom;

  return (
    right > -effectiveMargin &&
    left < viewport.width + effectiveMargin &&
    bottom > -effectiveMargin &&
    top < viewport.height + effectiveMargin
  );
}

