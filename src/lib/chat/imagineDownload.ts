/**
 * Imagine download: pick a file type, then write a real file.
 *
 * The editor used to dump whatever blob the generator handed back into
 * Downloads. Callers encode through these helpers, then the Mac save sheet
 * (or a browser download) puts the file where the user pointed.
 */

export type ImagineDownloadFormat = "png" | "jpeg" | "webp";

export type ImagineDownloadOption = {
  id: ImagineDownloadFormat;
  label: string;
  mime: string;
  ext: string;
  hint: string;
};

export const IMAGINE_DOWNLOAD_FORMATS: ImagineDownloadOption[] = [
  { id: "png", label: "PNG", mime: "image/png", ext: "png", hint: "Lossless" },
  { id: "jpeg", label: "JPEG", mime: "image/jpeg", ext: "jpg", hint: "Smaller file" },
  { id: "webp", label: "WebP", mime: "image/webp", ext: "webp", hint: "Small, sharp" },
];

export const IMAGINE_DOWNLOAD_FORMAT_KEY = "lykn:imagine:downloadFormat";

const JPEG_QUALITY = 0.92;
const WEBP_QUALITY = 0.92;

export function imagineDownloadOption(id: string | null | undefined): ImagineDownloadOption {
  return IMAGINE_DOWNLOAD_FORMATS.find((o) => o.id === id) || IMAGINE_DOWNLOAD_FORMATS[0];
}

export function loadImagineDownloadFormat(storage?: Storage): ImagineDownloadFormat {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    const raw = store?.getItem(IMAGINE_DOWNLOAD_FORMAT_KEY);
    return imagineDownloadOption(raw).id;
  } catch {
    return "png";
  }
}

export function saveImagineDownloadFormat(
  id: ImagineDownloadFormat,
  storage?: Storage,
): ImagineDownloadFormat {
  const next = imagineDownloadOption(id).id;
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    store?.setItem(IMAGINE_DOWNLOAD_FORMAT_KEY, next);
  } catch {
    /* private mode */
  }
  return next;
}

/** A filename the save sheet can show, built from the batch's concept. */
export function imagineDownloadFilename(label: string, format: ImagineDownloadFormat): string {
  const opt = imagineDownloadOption(format);
  const stem =
    String(label || "")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\.(png|jpe?g|webp|gif)$/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "lykn-image";
  return `${stem}.${opt.ext}`;
}

export function imagineDownloadFilters(format?: ImagineDownloadFormat): {
  name: string;
  extensions: string[];
}[] {
  if (format) {
    const opt = imagineDownloadOption(format);
    return [{ name: opt.label, extensions: opt.id === "jpeg" ? ["jpg", "jpeg"] : [opt.ext] }];
  }
  return IMAGINE_DOWNLOAD_FORMATS.map((opt) => ({
    name: opt.label,
    extensions: opt.id === "jpeg" ? ["jpg", "jpeg"] : [opt.ext],
  }));
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("encode"));
          return;
        }
        resolve(blob);
      },
      mime,
      quality,
    );
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode"));
    img.src = src;
  });
}

/** Re-encode pixels as PNG / JPEG / WebP. JPEG flattens transparency on white. */
export async function encodeImageToFormat(
  source: Blob,
  format: ImagineDownloadFormat,
): Promise<Blob> {
  const opt = imagineDownloadOption(format);
  const objectUrl = URL.createObjectURL(source);
  try {
    const img = await loadImage(objectUrl);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w < 1 || h < 1) throw new Error("empty");
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    if (opt.id === "jpeg") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(img, 0, 0, w, h);
    const quality = opt.id === "jpeg" ? JPEG_QUALITY : opt.id === "webp" ? WEBP_QUALITY : undefined;
    return await canvasToBlob(canvas, opt.mime, quality);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
