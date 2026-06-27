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

/**
 * Average luminance of a frame, sampled at low res. Used to reject all-black
 * poster frames (fade-ins, leader frames) so we can retry at a later
 * timestamp. Returns a high number (treated as "not black") on any failure so
 * a sampling error never blocks an otherwise-fine frame.
 */
function frameLuminance(source: CanvasImageSource): number {
  try {
    const w = 32;
    const h = 32;
    const canvas = makeCanvas(w, h);
    if (!canvas) return 255;
    const ctx = (canvas as HTMLCanvasElement).getContext("2d", { alpha: false }) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) return 255;
    ctx.drawImage(source, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return sum / (data.length / 4);
  } catch {
    return 255;
  }
}

// A frame this dark (0–255 luma) is treated as a black/leader frame and we
// retry at a later timestamp before settling for it.
const BLACK_FRAME_LUMA_THRESHOLD = 12;

async function captureVideoFrame(
  file: Blob,
): Promise<{ bitmap: ImageBitmap | null; width: number; height: number } | null> {
  if (typeof document === "undefined") return null;
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    let targets: number[] = [];
    let attempt = 0;

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
    const succeed = (bitmap: ImageBitmap | null, width: number, height: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ bitmap, width, height });
    };

    // Captures the frame at the current position. If it's essentially black
    // and we have more candidate timestamps, advance and try again; otherwise
    // settle for whatever we got (a dim frame beats no thumbnail).
    const grab = async () => {
      if (settled) return;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!(width > 0 && height > 0) || typeof createImageBitmap !== "function") {
        succeed(null, width, height);
        return;
      }
      let bitmap: ImageBitmap | null = null;
      try {
        bitmap = await createImageBitmap(video);
      } catch {
        bitmap = null;
      }
      if (!bitmap) {
        succeed(null, width, height);
        return;
      }
      attempt += 1;
      const isBlack = frameLuminance(bitmap) < BLACK_FRAME_LUMA_THRESHOLD;
      if (isBlack && attempt < targets.length) {
        bitmap.close?.();
        seekTo(targets[attempt]);
        return;
      }
      succeed(bitmap, width, height);
    };

    // Wait for the seeked frame to actually be presented before reading it —
    // `seeked` alone can fire before the decoded frame is paintable, which is
    // the classic "black thumbnail" cause. `requestVideoFrameCallback` is the
    // reliable signal; fall back to a short timer where it's unavailable.
    const seekTo = (time: number) => {
      const onSeeked = () => {
        const rvfc = (video as any).requestVideoFrameCallback;
        if (typeof rvfc === "function") {
          let done = false;
          const fire = () => {
            if (done) return;
            done = true;
            void grab();
          };
          try {
            rvfc.call(video, () => fire());
          } catch {
            fire();
            return;
          }
          // Safety net: some browsers won't fire rVFC for a paused element.
          setTimeout(fire, 200);
        } else {
          setTimeout(() => void grab(), 80);
        }
      };
      video.addEventListener("seeked", onSeeked, { once: true });
      try {
        video.currentTime = time;
      } catch {
        video.removeEventListener("seeked", onSeeked);
        void grab();
      }
    };

    // `auto` (not `metadata`) so the browser actually buffers frame data —
    // seeking a metadata-only element commonly returns an undecoded black
    // frame.
    video.preload = "auto";
    video.muted = true;
    (video as HTMLVideoElement).playsInline = true;
    // `loadeddata` guarantees the first frame is decoded; `loadedmetadata`
    // only guarantees dimensions/duration.
    video.onloadeddata = () => {
      const dur = Number(video.duration);
      const base = Number.isFinite(dur) && dur > 0 ? dur : 0;
      if (base > 0) {
        // Try a few representative offsets, in order, until one isn't black.
        const cap = (t: number) => Math.max(0, Math.min(t, base - 0.05));
        targets = [cap(base * 0.1), cap(base * 0.25), cap(base * 0.5), 0];
      } else {
        targets = [0];
      }
      seekTo(targets[0]);
    };
    video.onerror = fail;
    // Safety timeout so a stuck decode doesn't hang the pipeline. Bumped to
    // 10s to accommodate the extra buffering from preload="auto".
    setTimeout(fail, 10000);
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
