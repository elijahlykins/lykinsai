/* eslint-disable no-console */
/**
 * Client-side media compression to cut Supabase Storage footprint before
 * upload.
 *
 *   Images (JPEG / PNG / HEIC / WebP): downscaled + re-encoded via
 *     `browser-image-compression` (Canvas under the hood). Tiny library,
 *     no wasm required.
 *
 *   Videos (MOV / MP4 / WebM / MKV / AVI etc.): tried in two paths:
 *     1. **WebCodecs (hardware-accelerated)** – preferred on Chrome, Edge,
 *        and Safari 16.4+. 10–50× faster than the ffmpeg path because it
 *        uses the OS's hardware encoder (VideoToolbox / NVENC / QuickSync).
 *     2. **ffmpeg.wasm fallback** – single-threaded wasm transcode for
 *        Firefox and any browser missing WebCodecs H.264 encode. Slower
 *        but portable; we warn the user once per session when we hit it.
 *
 * Both functions are resilient: if compression fails, we return the
 * original File so the upload flow never breaks.
 */

import {
  isWebCodecsH264Supported,
  webCodecsCompressVideo,
} from "@/lib/vault/webCodecsCompressor";
import { useVaultUploadStore } from "@/store/vaultUploadStore";

/** Videos at or above this size get transcoded. */
export const VIDEO_COMPRESS_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50 MB

/** Images at or above this size get re-encoded. */
export const IMAGE_COMPRESS_THRESHOLD_BYTES = 3 * 1024 * 1024; // 3 MB

/**
 * File containers that commonly hold codecs browsers can't decode
 * (iPhone HEVC in .mov, ProRes / DNxHD from edit rigs, MKV with H.265,
 * etc.). We ALWAYS transcode these to H.264 MP4 regardless of size so
 * the Vault plays everywhere — otherwise the `<video>` tag errors out
 * with "codec your browser cannot decode" on non-Apple browsers.
 */
const ALWAYS_TRANSCODE_EXTS = new Set(["mov", "qt", "mkv", "avi", "wmv"]);
const ALWAYS_TRANSCODE_MIMES = new Set([
  "video/quicktime",
  "video/x-matroska",
  "video/x-msvideo",
  "video/x-ms-wmv",
]);

/**
 * True if the browser probably can't decode this video container's
 * common codecs (iPhone HEVC .mov is the usual culprit). Callers should
 * transcode to H.264 MP4 even if the file is under the size threshold.
 * Exported so `uploadPipeline.ts` can surface the "Compressing…" toast
 * stage for the same set of files the compressor will actually work on.
 */
export function needsTranscodeForCompatibility(file: File): boolean {
  const ext = (file.name || "").split(".").pop()?.toLowerCase() || "";
  const mime = (file.type || "").toLowerCase();
  return ALWAYS_TRANSCODE_EXTS.has(ext) || ALWAYS_TRANSCODE_MIMES.has(mime);
}

/**
 * Target video quality. Tuned for "don't make the user wait":
 *   - preset `ultrafast` cuts encode time ~3× vs `veryfast`
 *   - 720p is half the pixels of 1080p → another ~2× speedup and smaller files
 *   - CRF 28 + AAC 96k keeps vault-quality playback while shaving bitrate
 *
 * A 1-minute iPhone 4K clip lands in the ~8–15 MB range at this setting and
 * typically transcodes in well under a minute on a modern laptop.
 */
const VIDEO_CRF = "28";
const VIDEO_MAX_HEIGHT = 720;
const VIDEO_PRESET = "ultrafast";
const AUDIO_BITRATE = "96k";

const VIDEO_MIME_PREFIXES = ["video/"];
const VIDEO_EXTS = new Set([
  "mov",
  "mp4",
  "m4v",
  "webm",
  "mkv",
  "avi",
  "wmv",
  "mpeg",
  "mpg",
  "3gp",
  "qt",
]);
const IMAGE_MIME_PREFIXES = ["image/"];

function isVideoFile(file: File): boolean {
  if (VIDEO_MIME_PREFIXES.some((p) => (file.type || "").toLowerCase().startsWith(p))) {
    return true;
  }
  const ext = (file.name || "").split(".").pop()?.toLowerCase() || "";
  return VIDEO_EXTS.has(ext);
}

function isImageFile(file: File): boolean {
  return IMAGE_MIME_PREFIXES.some((p) => (file.type || "").toLowerCase().startsWith(p));
}

export interface CompressResult {
  /** The file to actually upload (compressed or original). */
  file: File;
  /** True if we produced a new, smaller file. */
  compressed: boolean;
  /** Original byte size of the file the user dropped. */
  originalSize: number;
  /** Byte size of the file we're returning. */
  finalSize: number;
}

export interface CompressProgress {
  /** 0–100. For video, mapped from ffmpeg's time vs duration. */
  percent: number;
  stage: "compressing-image" | "compressing-video" | "skipped";
}

/**
 * Returns a possibly-compressed version of the input file. Images above
 * 3 MB are downscaled; everything else is returned unchanged.
 */
export async function maybeCompressImage(
  file: File,
  onProgress?: (p: CompressProgress) => void,
): Promise<CompressResult> {
  const originalSize = file.size || 0;
  if (!isImageFile(file) || originalSize < IMAGE_COMPRESS_THRESHOLD_BYTES) {
    return { file, compressed: false, originalSize, finalSize: originalSize };
  }

  try {
    const mod = await import("browser-image-compression");
    const imageCompression = (mod as any).default ?? mod;
    onProgress?.({ percent: 0, stage: "compressing-image" });

    const compressedBlob: Blob = await imageCompression(file, {
      maxSizeMB: 2,
      maxWidthOrHeight: 2048,
      useWebWorker: true,
      initialQuality: 0.85,
      fileType: file.type?.includes("png") ? "image/png" : "image/jpeg",
      onProgress: (percent: number) => {
        onProgress?.({
          percent: Math.max(0, Math.min(99, Math.round(percent))),
          stage: "compressing-image",
        });
      },
    });

    // If compression actually made it larger (rare, but it happens on
    // already-optimized JPEGs), keep the original.
    if (compressedBlob.size >= originalSize) {
      return { file, compressed: false, originalSize, finalSize: originalSize };
    }

    const ext = (compressedBlob.type === "image/png" ? "png" : "jpg");
    const baseName = (file.name || "image").replace(/\.[^/.]+$/, "") || "image";
    const newFile = new File([compressedBlob], `${baseName}.${ext}`, {
      type: compressedBlob.type || "image/jpeg",
      lastModified: Date.now(),
    });
    onProgress?.({ percent: 100, stage: "compressing-image" });
    return { file: newFile, compressed: true, originalSize, finalSize: newFile.size };
  } catch (err) {
    if (import.meta.env.DEV) console.warn("[compressMedia] image compression failed:", err);
    return { file, compressed: false, originalSize, finalSize: originalSize };
  }
}

// ---------------------------------------------------------------------------
// Video compression
// ---------------------------------------------------------------------------

let ffmpegInstancePromise: Promise<any> | null = null;
/**
 * Set to true after a hard failure (load timeout, worker crash, etc.) so
 * subsequent videos in the same session skip the expensive retry and just
 * upload their original bytes. Cleared on page reload.
 */
let ffmpegDisabledThisSession = false;

/**
 * Idle-terminate window for the ffmpeg worker. After this many ms with
 * no compression activity we tear down the wasm worker so the ~30 MB
 * heap it pins can be reclaimed by the browser. The next compression
 * pays the load cost again (3-8 s), which is the right trade-off for
 * a feature most users hit a few times per session.
 */
const FFMPEG_IDLE_TERMINATE_MS = 5 * 60 * 1000;
let ffmpegIdleTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFfmpegIdleTerminate(): void {
  if (typeof window === "undefined") return;
  if (ffmpegIdleTimer) clearTimeout(ffmpegIdleTimer);
  ffmpegIdleTimer = setTimeout(() => {
    ffmpegIdleTimer = null;
    void terminateFfmpeg();
  }, FFMPEG_IDLE_TERMINATE_MS);
}

function cancelFfmpegIdleTerminate(): void {
  if (ffmpegIdleTimer) {
    clearTimeout(ffmpegIdleTimer);
    ffmpegIdleTimer = null;
  }
}

async function terminateFfmpeg(): Promise<void> {
  const promise = ffmpegInstancePromise;
  ffmpegInstancePromise = null;
  if (!promise) return;
  try {
    const ff = await promise;
    if (ff && typeof ff.terminate === "function") {
      ff.terminate();
    }
  } catch {
    /* worker may already be dead */
  }
}

if (typeof window !== "undefined") {
  // Best-effort: tear down the worker when the tab is being closed so
  // we don't leave a pinned wasm heap around in browser back-forward
  // cache slots.
  window.addEventListener("pagehide", () => {
    cancelFfmpegIdleTerminate();
    void terminateFfmpeg();
  });
}

/**
 * Serializes access to the shared FFmpeg instance. The singleton is not
 * re-entrant — if two callers fire `ffmpeg.exec()` at the same time they
 * clobber each other's in-memory file system and hang indefinitely. This
 * mutex gives each compression job exclusive access while it runs.
 */
let ffmpegMutex: Promise<void> = Promise.resolve();
async function withFfmpegLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = ffmpegMutex;
  let release: () => void = () => {};
  ffmpegMutex = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  // While we have the lock, postpone any pending idle teardown — we're
  // about to use the worker.
  cancelFfmpegIdleTerminate();
  try {
    return await fn();
  } finally {
    release();
    // Once we're done (and the next caller, if any, has had a chance
    // to grab the lock), arm the idle timer. Subsequent jobs will
    // cancel + re-arm it.
    scheduleFfmpegIdleTerminate();
  }
}

/**
 * Load the ffmpeg.wasm core + internal Web Worker from local files (served
 * by Vite from `node_modules/@ffmpeg/*`). This avoids a whole class of
 * "compression just hangs forever" problems that come from trying to load
 * the core from a CDN via `toBlobURL`:
 *
 *   - CDN CORS / network blocks
 *   - Classic-worker `importScripts` failing on cross-origin blob URLs
 *   - Vite's automatic worker URL resolution not finding a worker inside a
 *     node_modules dependency
 *
 * Using Vite's `?url` query makes the bundler emit these as static assets
 * and return their hashed URLs at runtime.
 */
async function getFfmpegInstance(): Promise<any> {
  if (ffmpegInstancePromise) return ffmpegInstancePromise;
  ffmpegInstancePromise = (async () => {
    const [
      { FFmpeg },
      coreURLMod,
      wasmURLMod,
      classWorkerURLMod,
    ] = await Promise.all([
      import("@ffmpeg/ffmpeg"),
      // `@ffmpeg/core` only exposes these two public subpaths via its
      // package `exports` map — any deeper path fails Vite's resolver.
      import("@ffmpeg/core?url") as Promise<{ default: string }>,
      import("@ffmpeg/core/wasm?url") as Promise<{ default: string }>,
      // The worker imports sibling ESM files (./const.js, ./errors.js), so
      // it must be bundled. `?worker&url` tells Vite to emit a single-file
      // bundled worker and hand us its URL, which is what FFmpeg expects
      // when we pass `classWorkerURL`. The `./worker` subpath is the
      // package's official public export.
      import("@ffmpeg/ffmpeg/worker?worker&url") as Promise<{ default: string }>,
    ]);

    const coreURL = coreURLMod.default as string;
    const wasmURL = wasmURLMod.default as string;
    const classWorkerURL = classWorkerURLMod.default as string;

    const ffmpeg = new FFmpeg();

    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      ffmpeg.on("log", ({ message }: { message: string }) => {
        // Show only the "frame=..." progress-style lines so the console
        // doesn't get flooded with verbose build info.
        if (/^frame=/.test(message) || /Conversion/.test(message)) {
          // eslint-disable-next-line no-console
          console.debug("[ffmpeg]", message);
        }
      });
    }

    // Hard cap on load so a misbehaving worker never leaves the UI spinning
    // indefinitely. 45 s is enough for even a slow first-time load of the
    // ~30 MB wasm core.
    await withTimeout(
      ffmpeg.load({ coreURL, wasmURL, classWorkerURL }),
      45_000,
      "ffmpeg.load timed out (worker never reported ready)",
    );
    return ffmpeg;
  })().catch((err) => {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.error("[compressMedia] ffmpeg core failed to load:", err);
    }
    ffmpegInstancePromise = null; // allow retry on next call
    throw err;
  });
  return ffmpegInstancePromise;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Fire-and-forget: kicks off loading the ffmpeg.wasm core in the background
 * so the first real compression doesn't pay the 3–8 s download cost.
 *
 * Safe to call many times — subsequent calls are no-ops while the singleton
 * promise is in flight or resolved. Respects the Data-Saver / slow-network
 * hints (users on 2G or Save-Data mode won't trigger the ~30 MB download
 * until they actually drop a video).
 */
export function preloadVideoCompressor(): void {
  if (typeof window === "undefined") return;
  if (ffmpegInstancePromise) return;

  try {
    const conn = (navigator as any)?.connection;
    if (conn?.saveData) return;
    const slowConnections = new Set(["slow-2g", "2g"]);
    if (conn?.effectiveType && slowConnections.has(conn.effectiveType)) return;
  } catch {
    // navigator.connection isn't supported everywhere; fall through.
  }

  // If WebCodecs H.264 is supported, we never hit the ffmpeg path in normal
  // operation – so don't waste ~30 MB of bandwidth pre-pulling the wasm
  // core. We still lazily load it on demand if the WebCodecs pipeline
  // fails for a specific file.
  void (async () => {
    try {
      const wcOk = await isWebCodecsH264Supported();
      if (wcOk) return;
    } catch {
      /* treat as unsupported → preload */
    }
    // Don't block the caller; swallow errors – a failed preload simply
    // means the first real compression will load it like before.
    getFfmpegInstance().catch(() => {
      /* will be retried on demand */
    });
  })();
}

/**
 * Returns a possibly-compressed version of the input file. Video files at
 * or above VIDEO_COMPRESS_THRESHOLD_BYTES are transcoded to H.264 MP4 at
 * 1080p / CRF 28; everything else is returned unchanged.
 *
 * Emits 0–100 progress via `onProgress` during the transcode.
 */
export async function maybeCompressVideo(
  file: File,
  onProgress?: (p: CompressProgress) => void,
): Promise<CompressResult> {
  const originalSize = file.size || 0;
  if (!isVideoFile(file)) {
    return { file, compressed: false, originalSize, finalSize: originalSize };
  }
  // Two reasons we transcode:
  //   1. Size — file is big enough that re-encoding as 720p H.264 is worth it.
  //   2. Compatibility — container is one we can't trust the browser to
  //      decode (.mov w/ HEVC from iPhones is the common case). In this
  //      mode we transcode regardless of size, and we keep the transcoded
  //      output even if it's slightly larger, because the whole point is
  //      universal playability.
  const isCompatForced = needsTranscodeForCompatibility(file);
  const isBigEnough = originalSize >= VIDEO_COMPRESS_THRESHOLD_BYTES;
  if (!isCompatForced && !isBigEnough) {
    return { file, compressed: false, originalSize, finalSize: originalSize };
  }

  // ── Fast path: WebCodecs (hardware-accelerated) ─────────────────────
  // We try this first on every video. If the browser supports AVC encode
  // AND the decode pipeline completes, we skip ffmpeg entirely. If it
  // fails (unsupported codec in input, HW encoder hiccup, etc.) we fall
  // through to the ffmpeg path below.
  try {
    if (await isWebCodecsH264Supported()) {
      onProgress?.({ percent: 0, stage: "compressing-video" });
      if (import.meta.env.DEV) {
        console.info(`[compressMedia] WebCodecs path start: ${file.name} (${originalSize} B)`);
      }
      const result = await webCodecsCompressVideo(file, (pct) => {
        onProgress?.({ percent: pct, stage: "compressing-video" });
      });
      // If the HW pipeline didn't meaningfully shrink the file we'd
      // normally prefer the original — EXCEPT when we were transcoding
      // for compatibility (e.g. HEVC .mov → H.264). In that case the
      // H.264 output is the goal regardless of size, because the original
      // isn't playable cross-browser.
      if (!isCompatForced && result.finalSize >= originalSize * 0.95) {
        if (import.meta.env.DEV) {
          console.info(
            `[compressMedia] WebCodecs output not meaningfully smaller (${originalSize} → ${result.finalSize}); keeping original`,
          );
        }
        return { file, compressed: false, originalSize, finalSize: originalSize };
      }
      onProgress?.({ percent: 100, stage: "compressing-video" });
      return {
        file: result.file,
        compressed: true,
        originalSize: result.originalSize,
        finalSize: result.finalSize,
      };
    } else {
      // Mark the slow encoder banner once per session.
      try {
        useVaultUploadStore.getState().markSlowEncoderUsed();
      } catch {
        /* store not ready yet; harmless */
      }
    }
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn("[compressMedia] WebCodecs path failed – falling back to ffmpeg:", err);
    }
    // Intentional fall-through to the ffmpeg path below.
  }

  if (ffmpegDisabledThisSession) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.info(
        "[compressMedia] skipping compression – ffmpeg is disabled for this session",
      );
    }
    return { file, compressed: false, originalSize, finalSize: originalSize };
  }

  try {
    onProgress?.({ percent: 0, stage: "compressing-video" });
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.info(`[compressMedia] video compress start: ${file.name} (${originalSize} B)`);
    }

    // Serialize access: the shared FFmpeg instance is not re-entrant. Without
    // this lock, dropping 6 videos at once would have 6 worker slots calling
    // into the same wasm instance concurrently and hanging forever.
    const blob = await withFfmpegLock(async () => {
      const ffmpeg = await getFfmpegInstance();
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.info("[compressMedia] ffmpeg core loaded, writing input…");
      }
      const { fetchFile } = await import("@ffmpeg/util");

      const inputExt = (file.name || "input").split(".").pop()?.toLowerCase() || "bin";
      const inputName = `input.${inputExt}`;
      const outputName = "output.mp4";

      await ffmpeg.writeFile(inputName, await fetchFile(file));
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.info("[compressMedia] input written, starting transcode…");
      }

      const progressHandler = ({ progress }: { progress: number }) => {
        if (typeof progress !== "number") return;
        const pct = Math.max(0, Math.min(99, Math.round(progress * 100)));
        onProgress?.({ percent: pct, stage: "compressing-video" });
      };
      ffmpeg.on("progress", progressHandler);

      // Inner try/finally guarantees we tear down both MEMFS files
      // even when ffmpeg.exec or readFile throws. Without this, a
      // failed transcode left megabytes of input/output sitting in
      // the wasm heap until the worker was torn down (or worse, the
      // page was reloaded), and a second compression attempt hit
      // out-of-memory.
      try {
        try {
          await withTimeout(
            ffmpeg.exec([
              "-i",
              inputName,
              // Downscale so the longest side stays within VIDEO_MAX_HEIGHT
              // and make the dimensions H.264-safe (even numbers).
              "-vf",
              `scale='min(iw,-2)':'min(${VIDEO_MAX_HEIGHT},ih)',scale=trunc(iw/2)*2:trunc(ih/2)*2`,
              "-c:v",
              "libx264",
              "-preset",
              VIDEO_PRESET,
              "-crf",
              VIDEO_CRF,
              "-pix_fmt",
              "yuv420p",
              "-movflags",
              "+faststart",
              "-c:a",
              "aac",
              "-b:a",
              AUDIO_BITRATE,
              "-ac",
              "2",
              outputName,
            ]),
            10 * 60 * 1000,
            "ffmpeg exec timed out",
          );
        } finally {
          ffmpeg.off("progress", progressHandler);
        }

        const data = (await ffmpeg.readFile(outputName)) as Uint8Array | string;
        const out = new Blob([data as unknown as BlobPart], { type: "video/mp4" });
        return out;
      } finally {
        try { await ffmpeg.deleteFile(inputName); } catch { /* ignore */ }
        try { await ffmpeg.deleteFile(outputName); } catch { /* ignore */ }
      }
    });

    // If transcoding somehow produced a LARGER file, prefer the original —
    // no point paying storage for a worse copy. Unless we're transcoding
    // for compatibility (e.g. HEVC .mov): then the H.264 output is the
    // whole goal, so we keep it regardless.
    if (!isCompatForced && blob.size >= originalSize * 0.95) {
      if (import.meta.env.DEV) {
        console.info(
          `[compressMedia] skip video – compressed not meaningfully smaller (${originalSize} → ${blob.size})`,
        );
      }
      return { file, compressed: false, originalSize, finalSize: originalSize };
    }

    const baseName = (file.name || "video").replace(/\.[^/.]+$/, "") || "video";
    const newFile = new File([blob], `${baseName}.mp4`, {
      type: "video/mp4",
      lastModified: Date.now(),
    });
    onProgress?.({ percent: 100, stage: "compressing-video" });
    return { file: newFile, compressed: true, originalSize, finalSize: newFile.size };
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn(
        "[compressMedia] video compression failed — falling back to original upload:",
        err,
      );
    }
    // Load-time failures (wasm/worker can't start) won't recover during
    // this session. Flag it so subsequent videos skip the wait entirely.
    const msg = String((err as Error)?.message || "").toLowerCase();
    if (msg.includes("timed out") || msg.includes("worker") || msg.includes("failed to fetch")) {
      ffmpegDisabledThisSession = true;
    }
    return { file, compressed: false, originalSize, finalSize: originalSize };
  }
}

/**
 * Convenience: pick the right compressor for a file.
 */
export async function maybeCompressMedia(
  file: File,
  onProgress?: (p: CompressProgress) => void,
): Promise<CompressResult> {
  if (isVideoFile(file)) return maybeCompressVideo(file, onProgress);
  if (isImageFile(file)) return maybeCompressImage(file, onProgress);
  return {
    file,
    compressed: false,
    originalSize: file.size || 0,
    finalSize: file.size || 0,
  };
}

export function formatBytes(n: number): string {
  if (!n || n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
