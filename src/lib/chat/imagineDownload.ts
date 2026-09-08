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

function mimeOfBlob(blob: Blob): string {
  return String(blob.type || "")
    .toLowerCase()
    .split(";")[0]
    .trim();
}

export function formatFromMime(mime: string | null | undefined): ImagineDownloadFormat | null {
  const m = String(mime || "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  if (m === "image/jpeg" || m === "image/jpg") return "jpeg";
  if (m === "image/webp") return "webp";
  if (m === "image/png") return "png";
  return null;
}

function mimeAlreadyMatches(srcMime: string, opt: ImagineDownloadOption): boolean {
  if (!srcMime) return false;
  if (srcMime === opt.mime) return true;
  return opt.id === "jpeg" && (srcMime === "image/jpg" || srcMime === "image/jpeg");
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
    // blob: and data: are same-origin. Setting crossOrigin on them can make
    // Chromium reject the load, which used to fail PNG downloads after a
    // successful fetch.
    if (!src.startsWith("blob:") && !src.startsWith("data:")) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode"));
    img.src = src;
  });
}

async function rasterizeToFormat(
  source: CanvasImageSource,
  w: number,
  h: number,
  opt: ImagineDownloadOption,
): Promise<Blob> {
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
  ctx.drawImage(source, 0, 0, w, h);
  const quality = opt.id === "jpeg" ? JPEG_QUALITY : opt.id === "webp" ? WEBP_QUALITY : undefined;
  return canvasToBlob(canvas, opt.mime, quality);
}

/** Re-encode pixels as PNG / JPEG / WebP. JPEG flattens transparency on white. */
export async function encodeImageToFormat(
  source: Blob,
  format: ImagineDownloadFormat,
): Promise<Blob> {
  const opt = imagineDownloadOption(format);
  const srcMime = mimeOfBlob(source);
  if (mimeAlreadyMatches(srcMime, opt)) {
    return srcMime === opt.mime ? source : new Blob([source], { type: opt.mime });
  }

  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(source);
      try {
        return await rasterizeToFormat(bitmap, bitmap.width, bitmap.height, opt);
      } finally {
        bitmap.close();
      }
    } catch {
      /* Image() fallback */
    }
  }

  const objectUrl = URL.createObjectURL(source);
  try {
    const img = await loadImage(objectUrl);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    return await rasterizeToFormat(img, w, h, opt);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** Bytes behind an Imagine tile - local `lykn-blob://` or a hosted proxy URL. */
export async function fetchImagineSourceBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`fetch_${res.status}`);
  const blob = await res.blob();
  if (!blob.size) throw new Error("empty");
  return blob;
}

export type PreparedImagineDownload = {
  blob: Blob;
  filename: string;
  mime: string;
  filters: ReturnType<typeof imagineDownloadFilters>;
};

/**
 * Fetch the generated image and encode it to the picked type.
 *
 * Encoding is skipped when the bytes are already that type. If conversion
 * fails, the original pixels are kept rather than failing the download.
 */
export async function prepareImagineDownload(opts: {
  url: string;
  format: ImagineDownloadFormat;
  label: string;
}): Promise<PreparedImagineDownload> {
  const picked = imagineDownloadOption(opts.format).id;
  const source = await fetchImagineSourceBlob(opts.url);
  let blob: Blob;
  let format = picked;
  try {
    blob = await encodeImageToFormat(source, picked);
  } catch {
    format = formatFromMime(source.type) || picked;
    const fallbackMime = mimeOfBlob(source) || imagineDownloadOption(format).mime;
    blob = mimeOfBlob(source) ? source : new Blob([source], { type: fallbackMime });
  }
  const opt = imagineDownloadOption(format);
  return {
    blob,
    filename: imagineDownloadFilename(opts.label, format),
    mime: blob.type || opt.mime,
    filters: imagineDownloadFilters(format),
  };
}
