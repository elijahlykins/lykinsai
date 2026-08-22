import type { FocusedChatAttachment } from "@/lib/ai/chatSendOrchestrator";

/**
 * Inlining image bytes that only this device can read.
 *
 * Local-first vault items and Finder files reach the renderer over Electron's
 * own `lykn-blob://` / `lykn-mac://` schemes (see
 * electron/localStore/blobProtocol.cjs and electron/macFileProtocol.cjs).
 * Those URLs are perfect for an `<img src>` and useless to anyone else: the
 * bytes never left the machine, so there is nothing for a model provider to
 * fetch.
 *
 * That distinction is easy to lose track of, because the attachment a user
 * drags out of the vault carries a `url` like any other. Handing one to a
 * provider does not degrade to "answered without the image" — OpenAI rejects
 * the request outright ("Failed to download file."), which fails the whole
 * turn and surfaces as the generic "That didn't work" copy.
 *
 * So device-local images are read here and re-encoded as compact data URLs,
 * the same shape the file picker and clipboard paste already produce, before
 * the request is built. Both custom schemes are registered with
 * `supportFetchAPI`, so `fetch()` reads them directly.
 */

const DEVICE_LOCAL_SCHEMES = ["lykn-blob://", "lykn-mac://"];

/** True for URLs served by this app's own protocol handlers. */
export function isDeviceLocalUrl(url: unknown): boolean {
  const trimmed = String(url || "").trim();
  return DEVICE_LOCAL_SCHEMES.some((scheme) => trimmed.startsWith(scheme));
}

function mimeFromDataUrl(dataUrl: string): string {
  const match = /^data:([^;,]+)/.exec(dataUrl);
  return match ? match[1] : "";
}

/**
 * Read one device-local image and re-encode it as a data URL.
 *
 * Returns null rather than throwing when the bytes cannot be read, because
 * every caller's fallback is "proceed without this image" — the alternative,
 * sending a URL only this machine can resolve, fails the whole request.
 */
export async function deviceLocalUrlToDataUrl(
  url: string,
  name?: string,
): Promise<{ dataUrl: string; mime: string; size: number } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`local_fetch_${res.status}`);
    const blob = await res.blob();
    const file = new File([blob], name || "image", { type: blob.type || "image/png" });
    const { fileToChatImageDataUrl } = await import("@/lib/heifToJpeg");
    const dataUrl = await fileToChatImageDataUrl(file);
    if (!dataUrl.startsWith("data:image/")) throw new Error("not_an_image");
    return { dataUrl, mime: mimeFromDataUrl(dataUrl), size: blob.size };
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn("[chat] could not read local image", name || url, err);
    }
    return null;
  }
}

/**
 * Replaces device-local image URLs with data URLs, in place.
 *
 * Best-effort per attachment: an image whose bytes can't be read has its url
 * cleared rather than left as-is, because sending it is what breaks the turn.
 * The reply then answers from the surrounding text instead of failing.
 */
export async function inlineDeviceLocalImages(
  attachments: FocusedChatAttachment[],
): Promise<void> {
  const targets = attachments.filter(
    (a) => (a.type || "").toLowerCase() === "image" && isDeviceLocalUrl(a.url),
  );
  if (!targets.length) return;

  for (const att of targets) {
    const read = await deviceLocalUrlToDataUrl(att.url, att.name);
    if (!read) {
      att.url = "";
      continue;
    }
    att.url = read.dataUrl;
    if (!att.mime) att.mime = read.mime;
    if (!att.size) att.size = read.size;
  }
}
