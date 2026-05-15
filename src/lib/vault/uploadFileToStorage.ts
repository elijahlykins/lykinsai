import { supabase } from "@/lib/supabase";

/**
 * Files this size or larger use the TUS (resumable) upload protocol, which
 * streams the file to Supabase in 6 MiB chunks with automatic retries.
 * Smaller files use the standard single-request upload, which is faster for
 * tiny payloads.
 *
 * 6 MiB matches Supabase's recommended threshold for resumable uploads.
 */
const TUS_THRESHOLD_BYTES = 6 * 1024 * 1024;

/**
 * Chunk size for TUS uploads. Supabase REQUIRES exactly 6 MiB for every
 * chunk except the final one; any other size causes the upload to be
 * rejected with an "invalid chunk size" error.
 */
const TUS_CHUNK_SIZE = 6 * 1024 * 1024;

/**
 * Maps file extensions to MIME types when the browser fails to provide one.
 * Safari in particular often serves `.mov` files with an empty `file.type`,
 * which then gets rejected by Supabase buckets that have MIME filtering.
 */
const EXT_TO_MIME: Record<string, string> = {
  mov: "video/quicktime",
  qt: "video/quicktime",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  wmv: "video/x-ms-wmv",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  "3gp": "video/3gpp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  aac: "audio/aac",
  heic: "image/heic",
  heif: "image/heif",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

function inferContentType(file: File | Blob, explicit?: string): string {
  if (explicit) return explicit;
  const type = (file as File).type;
  if (type) return type;
  const name = (file as File).name || "";
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return EXT_TO_MIME[ext] || "application/octet-stream";
}

export interface UploadFileResult {
  storagePath: string;
  signedUrl: string | null;
  publicUrl: string | null;
  bucket: string;
}

export interface UploadFileOptions {
  file: File | Blob;
  userId: string;
  storagePath: string;
  bucket?: string;
  contentType?: string;
  cacheControl?: string;
  upsert?: boolean;
  /** Called with a 0–100 integer whenever upload progress changes. */
  onProgress?: (percent: number) => void;
  /** Signal to abort an in-flight upload (cooperative). */
  signal?: AbortSignal;
}

/**
 * Uploads a file to Supabase Storage using the optimal strategy:
 *   - small files  (< 6 MiB): single-request upload via `supabase.storage`
 *   - large files  (≥ 6 MiB): TUS resumable upload streamed in 6 MiB chunks,
 *     with automatic retries on network errors and resumable from the last
 *     completed chunk.
 *
 * In both cases we also mint a 7-day signed URL so the file can be previewed
 * from private buckets immediately.
 */
export async function uploadFileToStorage(
  opts: UploadFileOptions,
): Promise<UploadFileResult> {
  const {
    file,
    storagePath,
    bucket = "user-files",
    contentType,
    cacheControl = "3600",
    upsert = false,
    onProgress,
    signal,
  } = opts;

  const fileSize = (file as File).size ?? 0;
  const resolvedContentType = inferContentType(file, contentType);

  if (fileSize >= TUS_THRESHOLD_BYTES) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.info(
        `[uploadFileToStorage] TUS upload start: ${storagePath}`,
        `size=${fileSize}`,
        `type=${resolvedContentType}`,
      );
    }
    await uploadViaTus({
      file,
      storagePath,
      bucket,
      contentType: resolvedContentType,
      cacheControl,
      upsert,
      onProgress,
      signal,
    });
  } else {
    await uploadSingleShot({
      file,
      storagePath,
      bucket,
      contentType: resolvedContentType,
      cacheControl,
      upsert,
      onProgress,
      signal,
    });
  }

  return finalizeUrls({ storagePath, bucket });
}

// ---------------------------------------------------------------------------
// Single-shot upload with bounded retry
// ---------------------------------------------------------------------------
//
// Sub-6 MiB files used to be a single, retry-less `supabase.storage.upload`
// call. The TUS path retries automatically (`retryDelays` in `uploadViaTus`),
// so large files were paradoxically MORE reliable than small ones — a
// transient 5xx or network blip would fail an entire small-file upload while
// a 100 MB video would just resume.
//
// We retry up to 3 times with jittered exponential backoff. We intentionally
// only retry network / 5xx / rate-limit errors; permanent failures (RLS,
// missing bucket, MIME mismatch, payload too large, AbortError) bail
// immediately so the user sees the right toast right away.
const SMALL_UPLOAD_MAX_ATTEMPTS = 3;

function isRetriableUploadError(err: any): boolean {
  if (!err) return false;
  const status = err.statusCode ?? err.status ?? err.originalError?.statusCode;
  if (typeof status === "number") {
    if (status === 408 || status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }
  const msg = String(err.message || err.error || "").toLowerCase();
  // No status code usually means the request never reached Supabase: DNS,
  // CORS preflight, offline, TLS handshake failure. Worth a retry.
  return (
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("failed to fetch") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up")
  );
}

async function uploadSingleShot(args: {
  file: File | Blob;
  storagePath: string;
  bucket: string;
  contentType: string;
  cacheControl: string;
  upsert: boolean;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { file, storagePath, bucket, contentType, cacheControl, upsert, onProgress, signal } =
    args;

  let lastError: any = null;
  for (let attempt = 1; attempt <= SMALL_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    onProgress?.(5);
    const { error } = await supabase.storage.from(bucket).upload(storagePath, file, {
      cacheControl,
      upsert,
      contentType,
    });
    if (!error) {
      onProgress?.(100);
      return;
    }
    lastError = error;
    if (!isRetriableUploadError(error) || attempt === SMALL_UPLOAD_MAX_ATTEMPTS) {
      throw error;
    }
    // Jittered exponential backoff: 500ms, 1.5s, 3.5s (caps at attempt 3).
    const baseDelay = 500 * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * 250);
    const delay = baseDelay + jitter;
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn(
        `[uploadFileToStorage] single-shot retry ${attempt}/${SMALL_UPLOAD_MAX_ATTEMPTS} in ${delay}ms`,
        error,
      );
    }
    try {
      await sleepWithAbort(delay, signal);
    } catch (abortErr) {
      throw abortErr;
    }
  }
  throw lastError;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function finalizeUrls({
  storagePath,
  bucket,
}: {
  storagePath: string;
  bucket: string;
}): Promise<UploadFileResult> {
  let signedUrl: string | null = null;
  let publicUrl: string | null = null;
  let lastSignedError: unknown = null;

  // Two attempts so a single transient signing blip doesn't poison the
  // whole upload. The bytes are already in storage at this point.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(storagePath, 60 * 60 * 24 * 7);
      if (!error && data?.signedUrl) {
        signedUrl = data.signedUrl;
        break;
      }
      lastSignedError = error;
    } catch (err) {
      lastSignedError = err;
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
  }

  try {
    const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);
    publicUrl = data?.publicUrl || null;
  } catch {
    /* no public URL — relying on signed URL */
  }

  // Hard-fail when we can produce neither URL. Without this the pipeline
  // would happily insert a vault note with `fileUrl: null`, which renders
  // as `[View File]()` and an unopenable attachment chip — silent data
  // loss from the user's POV. Throwing here lets `processOne` clean up
  // the freshly-uploaded storage object and surface a real error.
  if (!signedUrl && !publicUrl) {
    const detail =
      lastSignedError && typeof lastSignedError === "object" && "message" in lastSignedError
        ? String((lastSignedError as { message: unknown }).message || "")
        : "";
    throw new Error(
      detail
        ? `upload_finalize_failed: could not mint URL for stored file (${detail})`
        : "upload_finalize_failed: could not mint URL for stored file",
    );
  }

  return { storagePath, bucket, signedUrl, publicUrl };
}

async function uploadViaTus(args: {
  file: File | Blob;
  storagePath: string;
  bucket: string;
  contentType?: string;
  cacheControl: string;
  upsert: boolean;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { file, storagePath, bucket, contentType, cacheControl, upsert, onProgress, signal } =
    args;

  const { Upload } = await import("tus-js-client");

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!supabaseUrl || !anonKey) {
    throw new Error("Supabase env vars are missing; cannot use resumable upload");
  }

  const endpoint = `${supabaseUrl.replace(/\/$/, "")}/storage/v1/upload/resumable`;

  // Capture an access token now AND on every retry. tus-js-client's
  // `onShouldRetry` runs after a transient error before the retry,
  // and `onBeforeRequest` runs before every chunk request — re-pulling
  // the latest session there means a long-running upload survives
  // a token refresh mid-flight without the request getting 401-ed.
  const initialSession = await supabase.auth.getSession();
  let accessToken = initialSession?.data?.session?.access_token || anonKey;

  await new Promise<void>((resolve, reject) => {
    const upload = new Upload(file as File, {
      endpoint,
      retryDelays: [0, 1000, 3000, 5000, 10000, 20000],
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-upsert": upsert ? "true" : "false",
        apikey: anonKey,
      },
      // Refresh the token on each request hop so multi-hour video
      // uploads don't die when the access token rotates.
      onBeforeRequest: async (req: any) => {
        try {
          const { data } = await supabase.auth.getSession();
          const fresh = data?.session?.access_token;
          if (fresh && fresh !== accessToken) {
            accessToken = fresh;
          }
          if (req && typeof req.setHeader === "function") {
            req.setHeader("authorization", `Bearer ${accessToken}`);
          }
        } catch {
          /* keep prior token */
        }
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      // Supabase REQUIRES sequential 6 MiB chunks. `parallelUploads` must not
      // be set here — it triggers the TUS-Concat flow which Supabase's
      // storage server does not implement, causing uploads (especially large
      // video files like .mov) to fail outright.
      chunkSize: TUS_CHUNK_SIZE,
      metadata: {
        bucketName: bucket,
        objectName: storagePath,
        contentType: contentType || "application/octet-stream",
        cacheControl,
      },
      onError: (err: unknown) => {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.error("[uploadFileToStorage] TUS error", {
            storagePath,
            contentType,
            err,
          });
        }
        reject(err as Error);
      },
      onProgress: (bytesUploaded, bytesTotal) => {
        if (!onProgress || !bytesTotal) return;
        const pct = Math.max(0, Math.min(99, Math.round((bytesUploaded / bytesTotal) * 100)));
        onProgress(pct);
      },
      onSuccess: () => {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.info("[uploadFileToStorage] TUS upload success:", storagePath);
        }
        onProgress?.(100);
        resolve();
      },
    });

    if (signal) {
      if (signal.aborted) {
        upload.abort();
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          upload.abort();
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    }

    upload.findPreviousUploads().then(
      (previous) => {
        if (previous && previous.length > 0) {
          upload.resumeFromPreviousUpload(previous[0]);
        }
        upload.start();
      },
      () => {
        upload.start();
      },
    );
  });
}
