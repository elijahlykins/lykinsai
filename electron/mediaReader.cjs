/**
 * Local image and recording vision for local_read_file.
 *
 * PNG/JPEG and friends used to hit the binary sniff and come back as
 * "looks like a binary file". Agents then asked the user to describe the
 * screenshot. This module turns those files into a text description the same
 * way documentReader turns a PDF into text: look at the pixels, return words.
 *
 * Vision goes through POST /api/desktop/agent-model (stage=describe) so the
 * Electron process holds no API keys. Frames are compressed first so a
 * retina PNG does not blow the request body.
 */

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif)$/i;
const VIDEO_RE = /\.(mp4|mov|m4v|webm)$/i;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
const PREVIEW_MAX_WIDTH = 1280;
const JPEG_QUALITY = 72;
const CACHE_MAX = 12;

const DESCRIBE_SCHEMA = {
  type: "object",
  properties: {
    description: {
      type: "string",
      description: "What is on screen: UI, people, diagrams, layout, and purpose.",
    },
    visibleText: {
      type: "string",
      description: "Readable text in the frame, quoted verbatim. Empty if none.",
    },
  },
  required: ["description"],
  additionalProperties: false,
};

const DESCRIBE_SYSTEM =
  "You are looking at a file from the user's Mac. Describe what is actually " +
  "visible so another assistant can answer the user without seeing the pixels. " +
  "Be precise. Quote on-screen text. Do not invent contents.";

const mediaCache = new Map();

function isReadableImagePath(filePath) {
  return IMAGE_RE.test(String(filePath || ""));
}

function isReadableVideoPath(filePath) {
  return VIDEO_RE.test(String(filePath || ""));
}

function isReadableMediaPath(filePath) {
  return isReadableImagePath(filePath) || isReadableVideoPath(filePath);
}

function mediaKind(filePath) {
  if (isReadableVideoPath(filePath)) return "video";
  if (isReadableImagePath(filePath)) return "image";
  return "";
}

function mimeForPath(filePath) {
  const ext = path.extname(String(filePath || "")).slice(1).toLowerCase();
  const map = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    avif: "image/avif",
    heic: "image/heic",
    heif: "image/heif",
    mp4: "video/mp4",
    mov: "video/quicktime",
    m4v: "video/x-m4v",
    webm: "video/webm",
  };
  return map[ext] || "application/octet-stream";
}

function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function tryNativeImage() {
  try {
    return require("electron").nativeImage;
  } catch {
    return null;
  }
}

function dataUrlFromNative(image) {
  if (!image || image.isEmpty()) return null;
  const size = image.getSize();
  let out = image;
  if (size.width > PREVIEW_MAX_WIDTH) {
    out = image.resize({ width: PREVIEW_MAX_WIDTH, quality: "good" });
  }
  const jpeg = out.toJPEG(JPEG_QUALITY);
  if (!jpeg || !jpeg.length) return null;
  return `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`;
}

async function previewFromFile(filePath) {
  const nativeImage = tryNativeImage();
  if (!nativeImage) return null;
  try {
    const fromFile = nativeImage.createFromPath(filePath);
    const url = dataUrlFromNative(fromFile);
    if (url) return url;
  } catch {
    /* HEIC / video won't decode this way */
  }
  try {
    const thumb = await nativeImage.createThumbnailFromPath(filePath, {
      width: PREVIEW_MAX_WIDTH,
      height: Math.round(PREVIEW_MAX_WIDTH * 0.7),
    });
    const url = dataUrlFromNative(thumb);
    if (url) return url;
  } catch {
    /* no generator for this type */
  }
  return null;
}

async function previewViaSips(filePath) {
  if (process.platform !== "darwin") return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lykn-media-"));
  const dest = path.join(dir, "preview.jpg");
  try {
    await execFileAsync(
      "sips",
      ["-s", "format", "jpeg", "-s", "formatOptions", String(JPEG_QUALITY), "-Z", String(PREVIEW_MAX_WIDTH), filePath, "--out", dest],
      { timeout: 12000 },
    );
    const buf = await fs.readFile(dest);
    if (!buf.length) return null;
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function previewViaQlmanage(filePath) {
  if (process.platform !== "darwin") return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lykn-ql-"));
  try {
    await execFileAsync("qlmanage", ["-t", "-s", String(PREVIEW_MAX_WIDTH), "-o", dir, filePath], {
      timeout: 10000,
    });
    const names = await fs.readdir(dir);
    const file = names.find((name) => /\.(png|jpe?g)$/i.test(name));
    if (!file) return null;
    const nativeImage = tryNativeImage();
    if (nativeImage) {
      const url = dataUrlFromNative(nativeImage.createFromPath(path.join(dir, file)));
      if (url) return url;
    }
    const buf = await fs.readFile(path.join(dir, file));
    if (!buf.length) return null;
    const mime = /\.png$/i.test(file) ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function previewViaFfmpeg(filePath) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lykn-ff-"));
  const dest = path.join(dir, "frame.jpg");
  try {
    await execFileAsync(
      "ffmpeg",
      ["-y", "-ss", "0.4", "-i", filePath, "-frames:v", "1", "-q:v", "4", dest],
      { timeout: 15000 },
    );
    const buf = await fs.readFile(dest);
    if (!buf.length) return null;
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function previewFromRaw(filePath, mime) {
  if (!/^image\/(png|jpeg|gif|webp)$/i.test(mime)) return null;
  try {
    const buf = await fs.readFile(filePath);
    if (!buf.length || buf.length > 1.5 * 1024 * 1024) return null;
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

async function buildPreview(filePath, kind) {
  const fromNative = await previewFromFile(filePath);
  if (fromNative) return fromNative;
  if (kind === "image") {
    const fromSips = await previewViaSips(filePath);
    if (fromSips) return fromSips;
  }
  const fromQl = await previewViaQlmanage(filePath);
  if (fromQl) return fromQl;
  if (kind === "video") {
    const fromFf = await previewViaFfmpeg(filePath);
    if (fromFf) return fromFf;
  }
  if (kind === "image") return previewFromRaw(filePath, mimeForPath(filePath));
  return null;
}

async function readVideoMeta(filePath) {
  if (process.platform !== "darwin") return {};
  try {
    const { stdout } = await execFileAsync(
      "mdls",
      [
        "-name", "kMDItemDurationSeconds",
        "-name", "kMDItemPixelWidth",
        "-name", "kMDItemPixelHeight",
        "-name", "kMDItemKind",
        filePath,
      ],
      { timeout: 2500 },
    );
    const duration = Number(/kMDItemDurationSeconds\s*=\s*([0-9.]+)/.exec(stdout)?.[1]);
    const width = Number(/kMDItemPixelWidth\s*=\s*(\d+)/.exec(stdout)?.[1]);
    const height = Number(/kMDItemPixelHeight\s*=\s*(\d+)/.exec(stdout)?.[1]);
    const kind = /kMDItemKind\s*=\s*"([^"]+)"/.exec(stdout)?.[1] || "";
    return {
      ...(Number.isFinite(duration) && duration > 0 ? { durationSec: duration } : {}),
      ...(width > 0 ? { width } : {}),
      ...(height > 0 ? { height } : {}),
      ...(kind ? { spotlightKind: kind } : {}),
    };
  } catch {
    return {};
  }
}

function formatMetaLine({ filePath, size, kind, mime, meta }) {
  const bits = [`${kind === "video" ? "Local recording" : "Local image"}: ${path.basename(filePath)}`];
  bits.push(formatBytes(size));
  if (meta?.width && meta?.height) bits.push(`${meta.width}×${meta.height}`);
  if (meta?.durationSec) bits.push(`${Math.round(meta.durationSec)}s`);
  if (mime) bits.push(mime);
  return bits.join(", ");
}

function formatDescription(header, json) {
  const description = String(json?.description || "").trim();
  const visibleText = String(json?.visibleText || "").trim();
  const parts = [header];
  if (visibleText) parts.push("", "Visible text:", visibleText);
  if (description) parts.push("", description);
  return parts.join("\n").trim();
}

async function describePreview(imageUrl, { apiBase, token, fetchImpl, fileName, kind }) {
  if (typeof fetchImpl === "function" && !apiBase) {
    /* tests inject a fetch that already knows the URL */
  }
  if (!imageUrl || !String(imageUrl).startsWith("data:image/")) {
    return { ok: false, error: "no_preview" };
  }
  if (!token) return { ok: false, error: "not_signed_in" };
  const doFetch = fetchImpl || fetch;
  const target = apiBase ? `${String(apiBase).replace(/\/$/, "")}/api/desktop/agent-model` : "/api/desktop/agent-model";
  const what = kind === "video" ? "screen recording frame" : "screenshot or image";
  const res = await doFetch(target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      stage: "describe",
      system: DESCRIBE_SYSTEM,
      user: `This is a ${what} named "${fileName}". Describe what is on screen.`,
      imageUrl,
      schema: DESCRIBE_SCHEMA,
      maxTokens: 1200,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `vision_failed_${res.status}`, detail: text.slice(0, 160) };
  }
  const data = await res.json().catch(() => ({}));
  if (!data || data.ok === false || !data.json) {
    return { ok: false, error: String(data?.error || "vision_empty") };
  }
  return { ok: true, json: data.json, model: data.model || "" };
}

async function describeUncached(filePath, opts = {}) {
  let st;
  try {
    st = await fs.stat(filePath);
  } catch {
    return { ok: false, error: "not_found" };
  }

  const kind = mediaKind(filePath);
  if (!kind) return { ok: false, error: "not_media" };
  const maxBytes = kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (st.size > maxBytes) {
    return {
      ok: false,
      error: "file_too_large",
      detail: `${path.basename(filePath)} is ${formatBytes(st.size)} (cap ${formatBytes(maxBytes)})`,
    };
  }

  const mime = mimeForPath(filePath);
  const meta = kind === "video" ? await readVideoMeta(filePath) : {};
  const header = formatMetaLine({ filePath, size: st.size, kind, mime, meta });
  const preview = await buildPreview(filePath, kind);
  if (!preview) {
    return {
      ok: false,
      error: "no_preview",
      detail: `${header}. Could not decode a still frame from this file.`,
    };
  }

  const described = await describePreview(preview, {
    apiBase: opts.apiBase,
    token: opts.token,
    fetchImpl: opts.fetchImpl,
    fileName: path.basename(filePath),
    kind,
  });

  if (!described.ok) {
    const why =
      described.error === "not_signed_in"
        ? "Not signed in, so the pixels could not be sent to vision."
        : `Vision could not read this file (${described.error}).`;
    return {
      ok: true,
      path: filePath,
      kind,
      mime,
      size: st.size,
      format: path.extname(filePath).slice(1).toLowerCase(),
      content: `${header}\n\n${why} The file is on disk and can still be pulled into chat if the user wants it there.`,
      imageDataUrl: preview,
      vision: false,
    };
  }

  return {
    ok: true,
    path: filePath,
    kind,
    mime,
    size: st.size,
    format: path.extname(filePath).slice(1).toLowerCase(),
    content: formatDescription(header, described.json),
    imageDataUrl: preview,
    vision: true,
    model: described.model || undefined,
    durationSec: meta.durationSec,
    width: meta.width,
    height: meta.height,
  };
}

async function describeMediaFile(filePath, opts = {}) {
  let st;
  try {
    st = await fs.stat(filePath);
  } catch {
    return { ok: false, error: "not_found" };
  }
  const key = `${filePath}|${st.mtimeMs}|${st.size}`;
  const cached = mediaCache.get(key);
  if (cached) return cached;

  const result = await describeUncached(filePath, opts);
  if (result.ok && result.vision) {
    mediaCache.set(key, result);
    if (mediaCache.size > CACHE_MAX) mediaCache.delete(mediaCache.keys().next().value);
  }
  return result;
}

function clearMediaCache() {
  mediaCache.clear();
}

module.exports = {
  IMAGE_RE,
  VIDEO_RE,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  DESCRIBE_SCHEMA,
  isReadableImagePath,
  isReadableVideoPath,
  isReadableMediaPath,
  mimeForPath,
  describeMediaFile,
  clearMediaCache,
};
