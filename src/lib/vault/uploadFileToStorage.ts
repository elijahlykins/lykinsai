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
    onProgress?.(5);
    const { error } = await supabase.storage.from(bucket).upload(storagePath, file, {
      cacheControl,
      upsert,
      contentType: resolvedContentType,
    });
    if (error) throw error;
    onProgress?.(100);
  }

  return finalizeUrls({ storagePath, bucket });
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

  try {
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(storagePath, 60 * 60 * 24 * 7);
    if (!error && data?.signedUrl) signedUrl = data.signedUrl;
  } catch {
    // fall through to public URL
  }

  try {
    const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);
    publicUrl = data?.publicUrl || null;
  } catch {
    // ignore
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

  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData?.session?.access_token || anonKey;

  await new Promise<void>((resolve, reject) => {
    const upload = new Upload(file as File, {
      endpoint,
      retryDelays: [0, 1000, 3000, 5000, 10000, 20000],
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-upsert": upsert ? "true" : "false",
        apikey: anonKey,
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
