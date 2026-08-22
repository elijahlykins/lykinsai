/**
 * Writing files into the on-device blob store from the renderer.
 *
 * The renderer holds a `File` or `Blob` and has no filesystem access, so bytes
 * have to cross IPC. They go in chunks rather than one message: a single
 * message means the buffer is live twice at once — serialized on this side,
 * deserialized on the other — and phone video is routinely large enough for
 * that to be the difference between a smooth upload and a stalled window.
 *
 * A failed write aborts rather than leaving a partial file, because the row
 * that references it is written separately, and a half-written image that the
 * database swears is complete is worse than an upload that visibly failed.
 */

import { localBlobUrl } from "./mediaUrl";

/** Big enough to keep IPC round trips cheap, small enough to stay off the heap. */
const CHUNK_BYTES = 4 * 1024 * 1024;

interface BlobBridge {
  beginBlobWrite: (
    itemId: string,
    opts: { filename?: string; mimeType?: string; variant?: string },
  ) => Promise<any>;
  appendBlobWrite: (token: string, data: Uint8Array) => Promise<any>;
  finishBlobWrite: (token: string) => Promise<any>;
  abortBlobWrite: (token: string) => Promise<any>;
}

function bridge(): BlobBridge {
  const store = (globalThis as any)?.window?.lykn?.store;
  if (!store?.beginBlobWrite) throw new Error("local blob bridge is unavailable");
  return store as BlobBridge;
}

function unwrap<T>(response: any): T {
  if (!response) throw new Error("local store call failed");
  if (response.ok === false) throw new Error(response.error || "local store call failed");
  return response.data as T;
}

export interface WrittenBlob {
  /** Store-relative path, e.g. `item-1/original.png`. */
  path: string;
  bytes: number;
  /** Ready to drop straight into an `<img src>`. */
  url: string;
}

export interface WriteBlobOptions {
  filename?: string;
  mimeType?: string;
  /** "original" (default), "medium", "thumb", or `att<N>` for extra files. */
  variant?: string;
  onProgress?: (bytesWritten: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

/**
 * Stream a Blob into the local store and return where it landed.
 */
export async function writeLocalBlob(
  itemId: string,
  blob: Blob,
  options: WriteBlobOptions = {},
): Promise<WrittenBlob> {
  const { filename, mimeType, variant = "original", onProgress, signal } = options;

  const begun = unwrap<{ token: string; path: string }>(
    await bridge().beginBlobWrite(itemId, {
      filename: filename || (blob as File).name,
      mimeType: mimeType || blob.type,
      variant,
    }),
  );

  const total = blob.size;
  let written = 0;

  try {
    for (let offset = 0; offset < total; offset += CHUNK_BYTES) {
      if (signal?.aborted) throw new Error("cancelled");
      const slice = blob.slice(offset, Math.min(offset + CHUNK_BYTES, total));
      const chunk = new Uint8Array(await slice.arrayBuffer());
      unwrap(await bridge().appendBlobWrite(begun.token, chunk));
      written += chunk.byteLength;
      onProgress?.(written, total);
    }

    // A zero-byte file still needs finishing: begin created the `.part`.
    const done = unwrap<{ path: string; bytes: number }>(
      await bridge().finishBlobWrite(begun.token),
    );
    return { path: done.path, bytes: done.bytes, url: localBlobUrl(done.path) || "" };
  } catch (err) {
    // Leave nothing half-written for a row to point at.
    try {
      await bridge().abortBlobWrite(begun.token);
    } catch {
      /* the write is already lost; nothing more to do */
    }
    throw err;
  }
}

/**
 * Variant names for an attachment at a given position in a note.
 *
 * The first attachment keeps the plain names so it lines up with the
 * normalized columns (`blob_path`, `variant_med`, `variant_thumb`); later ones
 * are namespaced so two images in the same note cannot collide on disk. This
 * mirrors the naming the Supabase importer uses, so a migrated note and a
 * freshly uploaded one look identical on disk.
 */
export function variantNames(index = 0) {
  const base = index === 0 ? "" : `att${index}`;
  return {
    original: index === 0 ? "original" : `${base}-original`,
    medium: index === 0 ? "medium" : `${base}-medium`,
    thumb: index === 0 ? "thumb" : `${base}-thumb`,
  };
}
