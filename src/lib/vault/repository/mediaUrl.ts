/**
 * Turning a stored attachment into something an `<img>` or `<video>` can load.
 *
 * In the cloud this means minting a signed URL: a network round trip, a TTL, a
 * cache, and a re-sign every time a card scrolls back into view. Locally none
 * of that applies — the bytes are already on disk — so a local target resolves
 * synchronously to a `lykn-blob://` URL that the Electron main process serves
 * (see electron/localStore/blobProtocol.cjs).
 *
 * Keeping this in one module means the vault UI asks "what URL should I use"
 * rather than "am I local or not", and the two answers can differ in cost by
 * three orders of magnitude without the call sites knowing.
 */

import { LOCAL_BUCKET } from "./types";

export const BLOB_SCHEME = "lykn-blob";
const BLOB_HOST = "blob";

export interface StorageTarget {
  bucket?: string | null;
  path?: string | null;
}

/** True when these bytes live on this device rather than in a bucket. */
export function isLocalTarget(target: StorageTarget | null | undefined): boolean {
  return Boolean(target?.bucket === LOCAL_BUCKET && target?.path);
}

/**
 * Build the URL for a stored blob path. Mirrors `urlFor()` in
 * electron/localStore/blobProtocol.cjs — the two must agree.
 */
export function localBlobUrl(relativePath: string | null | undefined): string | null {
  const clean = String(relativePath || "").replace(/^\/+/, "");
  if (!clean) return null;
  return `${BLOB_SCHEME}://${BLOB_HOST}/${clean.split("/").map(encodeURIComponent).join("/")}`;
}

/** True for URLs this module produced. */
export function isLocalBlobUrl(url: unknown): boolean {
  return typeof url === "string" && url.startsWith(`${BLOB_SCHEME}://`);
}

/**
 * The inverse of `localBlobUrl`: recover the stored path and the id of the row
 * that owns it. Blob directories are named for their row, so the first segment
 * is the item id — which is what lets a saved generation reuse the bytes that
 * are already on disk instead of downloading itself back out of its own store.
 */
export function parseLocalBlobUrl(
  url: unknown,
): { path: string; itemId: string } | null {
  if (!isLocalBlobUrl(url)) return null;
  let pathname: string;
  try {
    pathname = new URL(String(url)).pathname;
  } catch {
    return null;
  }
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  if (segments.length < 2) return null;
  return { path: segments.join("/"), itemId: segments[0] };
}

/**
 * Resolve a target to a displayable URL.
 *
 * Local targets resolve immediately. Anything else is handed to `signCloudUrl`,
 * which the caller supplies — the signing logic, its cache and its fallbacks
 * stay where they already live rather than being duplicated here.
 */
export async function resolveVaultMediaUrl(
  target: StorageTarget | null | undefined,
  signCloudUrl: (target: StorageTarget) => Promise<string | null>,
): Promise<string | null> {
  if (!target?.path) return null;
  if (isLocalTarget(target)) return localBlobUrl(target.path);
  return signCloudUrl(target);
}
