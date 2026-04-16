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
