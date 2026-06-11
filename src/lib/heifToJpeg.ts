/**
 * Converts an image file to a browser-displayable data URL.
 * HEIF/HEIC files are converted to JPEG since most browsers can't render them natively.
 */
const HEIF_EXTS = new Set(["heic", "heif"]);
const HEIF_MIMES = ["image/heic", "image/heif"];

function isHeifFile(file: File): boolean {
  const ext = (file.name || "").split(".").pop()?.toLowerCase() || "";
  if (HEIF_EXTS.has(ext)) return true;
  const mime = (file.type || "").toLowerCase();
  return HEIF_MIMES.some((m) => mime.startsWith(m));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read blob"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(blob);
  });
}

export async function fileToDisplayableDataUrl(file: File): Promise<string> {
  if (!isHeifFile(file)) {
    return blobToDataUrl(file);
  }
  try {
    const mod = await import("heic2any");
    const heic2any = (mod as any).default ?? mod;
    if (typeof heic2any !== "function") throw new Error("heic2any not available");
    const result = await heic2any({
      blob: file,
      toType: "image/jpeg",
      quality: 0.9,
    });
    const blob = Array.isArray(result) ? result[0] : result;
    if (!blob) throw new Error("HEIF conversion produced no output");
    return blobToDataUrl(blob);
  } catch (err) {
    if (import.meta.env.DEV) console.warn("[heifToJpeg] Conversion failed, falling back to raw:", err);
    return blobToDataUrl(file);
  }
}

/**
 * Returns a displayable image File (converts HEIF to JPEG for upload/storage).
 * Use before uploading images so stored files render in all browsers.
 */
export async function fileToDisplayableFile(file: File): Promise<File> {
  if (!isHeifFile(file)) return file;
  try {
    const mod = await import("heic2any");
    const heic2any = (mod as any).default ?? mod;
    if (typeof heic2any !== "function") throw new Error("heic2any not available");
    const result = await heic2any({
      blob: file,
      toType: "image/jpeg",
      quality: 0.9,
    });
    const blob = Array.isArray(result) ? result[0] : result;
    if (!blob) throw new Error("HEIF conversion produced no output");
    const baseName = (file.name || "image").replace(/\.(heic|heif)$/i, "") || "image";
    return new File([blob], `${baseName}.jpg`, { type: "image/jpeg" });
  } catch (err) {
    if (import.meta.env.DEV) console.warn("[heifToJpeg] Conversion failed, using original:", err);
    return file;
  }
}

// Longest-edge cap for chat-attached images. Vision models gain nothing from
// resolution beyond ~1568px on the long edge, and a phone camera shot (4032px,
// 3-8MB, often HEIC) read raw as a base64 data URL easily blows past the
// server's JSON body limit — which surfaces to the user as a repeated
// "trouble connecting" error. Downscaling here keeps the payload small.
const CHAT_IMAGE_MAX_EDGE = 1568;
const CHAT_IMAGE_JPEG_QUALITY = 0.82;

function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image_decode_failed"));
    img.src = dataUrl;
  });
}

/**
 * Returns a compact, browser-displayable image data URL suitable for sending
 * to the chat/vision endpoint: HEIF is converted to JPEG, and anything larger
 * than CHAT_IMAGE_MAX_EDGE (or otherwise heavy) is downscaled and re-encoded
 * as JPEG. Degrade-safe — any failure falls back to the raw data URL so a
 * weird image never blocks the send.
 */
export async function fileToChatImageDataUrl(file: File): Promise<string> {
  // Convert HEIC/HEIF first so the canvas can actually decode it.
  const displayable = await fileToDisplayableFile(file);
  let dataUrl: string;
  try {
    dataUrl = await blobToDataUrl(displayable);
  } catch {
    dataUrl = await fileToDisplayableDataUrl(file);
  }

  try {
    const img = await loadImageElement(dataUrl);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return dataUrl;

    const longest = Math.max(w, h);
    const scale = longest > CHAT_IMAGE_MAX_EDGE ? CHAT_IMAGE_MAX_EDGE / longest : 1;
    // Skip re-encoding only when the source is already small AND modestly sized
    // on disk; otherwise re-encode to JPEG to shrink large PNG screenshots too.
    if (scale === 1 && displayable.size <= 700 * 1024) return dataUrl;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    // White matte so transparent PNGs don't render as black under JPEG.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = canvas.toDataURL("image/jpeg", CHAT_IMAGE_JPEG_QUALITY);
    // Guard against pathological cases where JPEG ends up larger.
    return out && out.length < dataUrl.length ? out : dataUrl;
  } catch (err) {
    if (import.meta.env.DEV) console.warn("[heifToJpeg] Downscale failed, using raw:", err);
    return dataUrl;
  }
}
