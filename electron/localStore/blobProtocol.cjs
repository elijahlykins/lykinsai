/**
 * `lykn-blob://` — how locally stored media reaches the renderer.
 *
 * The vault UI renders attachments with ordinary `<img>`, `<video>` and
 * `<iframe>` tags whose src is, today, an https signed URL from Supabase
 * Storage. Once the bytes live on this device there is no URL to sign, and the
 * window loads a remote origin (https://lykn.io) so it cannot read `file://`.
 * A custom scheme is the seam: the renderer keeps using `src`, and the main
 * process serves the bytes.
 *
 * URLs look like:
 *     lykn-blob://blob/<item-id>/<variant>.<ext>
 *
 * The fixed `blob` host exists because a registered "standard" scheme lowercases
 * its hostname. Item ids would survive that today, but putting the stored path
 * entirely in the pathname means nothing depends on that staying true.
 *
 * Range requests are handled properly rather than serving whole files, because
 * `<video>` will not scrub without them: Chromium asks for a byte range, and a
 * 200 with the full body makes the timeline unseekable and forces the entire
 * file through memory to play a few seconds.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { Readable } = require("node:stream");

const blobs = require("./blobs.cjs");

const SCHEME = "lykn-blob";
const HOST = "blob";

/** Registered before app-ready; see registerScheme(). */
const PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
  stream: true,
};

const MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  heic: "image/heic",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4v: "video/x-m4v",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  // Served with a real HTML type so artifact previews can render in an iframe
  // without the branded file-proxy the cloud path needs.
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  json: "application/json",
  csv: "text/csv; charset=utf-8",
};

function contentType(relativePath) {
  const ext = String(relativePath).split(".").pop()?.toLowerCase() || "";
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

/** Build the URL for a stored blob path. Mirrors the renderer's helper. */
function urlFor(relativePath) {
  const clean = String(relativePath || "").replace(/^\/+/, "");
  if (!clean) return null;
  return `${SCHEME}://${HOST}/${clean.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Pull the stored relative path back out of a request URL.
 * Returns null for anything that does not look like one of ours.
 */
function pathFromUrl(requestUrl) {
  let parsed;
  try {
    parsed = new URL(String(requestUrl));
  } catch {
    return null;
  }
  if (parsed.protocol !== `${SCHEME}:`) return null;

  const decoded = parsed.pathname
    .replace(/^\/+/, "")
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");

  return decoded || null;
}

/** Parse `Range: bytes=start-end`. Only the single-range form browsers send. */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  let start;
  let end;

  if (rawStart === "") {
    // Suffix form: the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Serve one request. Exported separately from the Electron wiring so it can be
 * driven directly by tests with a plain Request.
 *
 * @param {{url: string, headers?: Headers|Map|object}} request
 * @returns {Promise<Response>}
 */
async function handleRequest(request) {
  const relativePath = pathFromUrl(request?.url);
  if (!relativePath) return new Response("Bad blob URL", { status: 400 });

  // absolutePath() refuses anything that climbs out of the blobs directory.
  // The path arrives from the renderer, which loads a remote origin, so this
  // is the boundary that keeps a crafted URL from reading the filesystem.
  const absolute = blobs.absolutePath(relativePath);
  if (!absolute) return new Response("Forbidden", { status: 403 });

  let info;
  try {
    info = await fsp.stat(absolute);
    if (!info.isFile()) return new Response("Not found", { status: 404 });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const type = contentType(relativePath);
  const headers = {
    "Content-Type": type,
    // Bytes on disk never change under a given path — variants are written to
    // new names — so the renderer can cache hard and skip re-fetching media
    // every time a card scrolls back into view.
    "Cache-Control": "private, max-age=31536000, immutable",
    "Accept-Ranges": "bytes",
  };

  const rangeHeader =
    typeof request?.headers?.get === "function" ? request.headers.get("range") : null;
  const range = rangeHeader ? parseRange(rangeHeader, info.size) : null;

  if (rangeHeader && !range) {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${info.size}` },
    });
  }

  if (range) {
    const stream = fs.createReadStream(absolute, { start: range.start, end: range.end });
    return new Response(Readable.toWeb(stream), {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${info.size}`,
        "Content-Length": String(range.end - range.start + 1),
      },
    });
  }

  const stream = fs.createReadStream(absolute);
  return new Response(Readable.toWeb(stream), {
    status: 200,
    headers: { ...headers, "Content-Length": String(info.size) },
  });
}

/**
 * Register the scheme's privileges. Must run before app-ready, alongside the
 * other registerSchemesAsPrivileged call in main.cjs.
 */
function schemeRegistration() {
  return { scheme: SCHEME, privileges: PRIVILEGES };
}

/**
 * Bind the handler to a session. Safe to call repeatedly — sessions are marked
 * so a second call for the same partition is a no-op.
 */
function bind(session) {
  if (!session || session.__lyknBlobProtocolBound) return false;
  try {
    session.protocol.handle(SCHEME, handleRequest);
    session.__lyknBlobProtocolBound = true;
    return true;
  } catch (err) {
    console.warn("[LYKN] lykn-blob protocol bind failed:", err?.message);
    return false;
  }
}

module.exports = {
  SCHEME,
  HOST,
  PRIVILEGES,
  urlFor,
  pathFromUrl,
  parseRange,
  contentType,
  handleRequest,
  schemeRegistration,
  bind,
};
