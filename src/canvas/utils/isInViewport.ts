import type { BaseBlock, Camera } from "@/canvas/types";

export function isInViewport(
  block: BaseBlock,
  camera: Camera,
  viewport: { width: number; height: number },
  margin = 400
) {
  const left = (block.x - camera.x) * camera.zoom;
  const top = (block.y - camera.y) * camera.zoom;
  const right = left + block.width * camera.zoom;
  const bottom = top + block.height * camera.zoom;

  return (
    right > -margin &&
    left < viewport.width + margin &&
    bottom > -margin &&
    top < viewport.height + margin
  );
}

