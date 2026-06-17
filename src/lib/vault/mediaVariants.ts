/**
 * Multi-size media variants for the Vault (Phase 3 of the Vault Normalization
 * Program).
 *
 * On upload of an image or video we keep the compressed original AND derive two
 * smaller renditions:
 *   - `medium` — web thumbnail / mobile expanded view (longest side ≤ 1280)
 *   - `thumb`  — mobile grid thumbnail (longest side ≤ 400)
 *
 * Both are JPEG (small, universally decodable). The grid/list can load the tiny
 * `thumb` instead of a multi-MB original, and the expanded view loads `medium`
 * — big bandwidth/latency wins, especially on mobile.
 *
 * For video we capture a single poster frame and downscale that. All work is
 * best-effort: any decode/encode failure returns null for that variant and the
 * caller simply falls back to the original.
 */

export interface MediaVariantBlobs {
  medium: Blob | null;
  thumb: Blob | null;
  /** Intrinsic dimensions of the source frame, when known. */
  width: number | null;
  height: number | null;
}

const MEDIUM_MAX_DIM = 1280;
const THUMB_MAX_DIM = 400;
const MEDIUM_QUALITY = 0.82;
const THUMB_QUALITY = 0.7;

/** Scales (w,h) so its longest side is at most maxDim. Never upscales. */
function fitWithin(width: number, height: number, maxDim: number): { w: number; h: number } {
  if (width <= maxDim && height <= maxDim) return { w: width, h: height };
  const scale = maxDim / Math.max(width, height);
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}

async function canvasToJpegBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  quality: number,
): Promise<Blob | null> {
  try {
    if ("convertToBlob" in canvas) {
      return await (canvas as OffscreenCanvas).convertToBlob({ type: "image/jpeg", quality });
    }
    return await new Promise<Blob | null>((resolve) => {
      (canvas as HTMLCanvasElement).toBlob((b) => resolve(b), "image/jpeg", quality);
    });
  } catch {
    return null;
  }
}

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement | null {
  try {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  } catch {
    /* fall through */
  }
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
  return null;
}

async function renderToJpeg(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  maxDim: number,
  quality: number,
): Promise<Blob | null> {
  const { w, h } = fitWithin(srcW, srcH, maxDim);
  const canvas = makeCanvas(w, h);
  if (!canvas) return null;
  const ctx = (canvas as HTMLCanvasElement).getContext("2d", { alpha: false }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) return null;
  try {
    ctx.drawImage(source, 0, 0, w, h);
  } catch {
    return null;
  }
  return canvasToJpegBlob(canvas, quality);
}

async function decodeImageBitmap(file: Blob): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    return await createImageBitmap(file);
  } catch {
    return null;
  }
}

async function captureVideoFrame(
  file: Blob,
): Promise<{ bitmap: ImageBitmap | null; width: number; height: number } | null> {
  if (typeof document === "undefined") return null;
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        /* noop */
      }
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    };
    const grab = async () => {
      if (settled) return;
      settled = true;
      const width = video.videoWidth;
      const height = video.videoHeight;
      let bitmap: ImageBitmap | null = null;
      try {
        if (typeof createImageBitmap === "function" && width > 0 && height > 0) {
          bitmap = await createImageBitmap(video);
        }
      } catch {
        bitmap = null;
      }
      cleanup();
      resolve({ bitmap, width, height });
    };
    video.preload = "metadata";
    video.muted = true;
    (video as HTMLVideoElement).playsInline = true;
    video.onloadedmetadata = () => {
      // Seek a touch past the start to skip black intro frames.
      const target = Math.min(1, (video.duration || 0) * 0.1);
      try {
        video.currentTime = Number.isFinite(target) && target > 0 ? target : 0;
      } catch {
        grab();
      }
    };
    video.onseeked = () => void grab();
    video.onerror = fail;
    // Safety timeout so a stuck decode doesn't hang the pipeline.
    setTimeout(fail, 8000);
    video.src = url;
  });
}

/**
 * Generates medium + thumb JPEG renditions for an image or video file.
 * Returns nulls for any rendition that couldn't be produced (caller falls back
 * to the original).
 */
export async function generateMediaVariants(
  file: File,
  fileType: string,
): Promise<MediaVariantBlobs> {
  const empty: MediaVariantBlobs = { medium: null, thumb: null, width: null, height: null };

  let source: CanvasImageSource | null = null;
  let width = 0;
  let height = 0;
  let bitmapToClose: ImageBitmap | null = null;

  try {
    if (fileType === "image") {
      const bitmap = await decodeImageBitmap(file);
      if (!bitmap) return empty;
      bitmapToClose = bitmap;
      source = bitmap;
      width = bitmap.width;
      height = bitmap.height;
    } else if (fileType === "video") {
      const frame = await captureVideoFrame(file);
      if (!frame || !frame.bitmap) return empty;
      bitmapToClose = frame.bitmap;
      source = frame.bitmap;
      width = frame.width || frame.bitmap.width;
      height = frame.height || frame.bitmap.height;
    } else {
      return empty;
    }

    if (!source || width <= 0 || height <= 0) return empty;

    const [medium, thumb] = await Promise.all([
      renderToJpeg(source, width, height, MEDIUM_MAX_DIM, MEDIUM_QUALITY),
      renderToJpeg(source, width, height, THUMB_MAX_DIM, THUMB_QUALITY),
    ]);
    return { medium, thumb, width, height };
  } catch {
    return empty;
  } finally {
    bitmapToClose?.close?.();
  }
}
