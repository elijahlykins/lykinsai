/**
 * `lykn-mac://` — how files on this Mac reach the renderer so LYKN can show
 * them instead of handing them to another app.
 *
 * Same problem the vault's `lykn-blob://` solves, different source: the window
 * loads a remote origin (https://lykn.io) and so cannot read `file://`. The
 * browser wants ordinary `<img>`, `<video>` and `<iframe>` tags, so the main
 * process serves the bytes behind a scheme those tags accept.
 *
 * URLs look like:
 *     lykn-mac://file/Users/me/Pictures/holiday.jpg
 *
 * The absolute path lives in the pathname, per-segment encoded, because a
 * registered standard scheme lowercases its hostname and paths are
 * case-sensitive on some volumes.
 *
 * The security boundary is macFiles.canRead: Local Mode has to be on and the
 * path has to be inside the folders the user shared. Without that check this
 * scheme would be an open door to the whole disk from a remote origin, since
 * the renderer is the one composing the URL.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");

const blobProtocol = require("./localStore/blobProtocol.cjs");
const macFiles = require("./macFiles.cjs");

const SCHEME = "lykn-mac";
const HOST = "file";

const PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
  stream: true,
};

/** Build the URL for an absolute path. Mirrors the renderer's helper. */
function urlFor(absolutePath) {
  const clean = String(absolutePath || "").replace(/^\/+/, "");
  if (!clean) return null;
  return `${SCHEME}://${HOST}/${clean.split("/").map(encodeURIComponent).join("/")}`;
}

/** Pull the absolute path back out of a request URL, or null if it isn't ours. */
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

  if (!decoded) return null;
  // Normalise before the allowlist check so "a/../../etc" can't slip past it.
  return path.resolve(`/${decoded}`);
}

async function handleRequest(request) {
  const absolute = pathFromUrl(request?.url);
  if (!absolute) return new Response("Bad file URL", { status: 400 });
  if (!macFiles.canRead(absolute)) return new Response("Forbidden", { status: 403 });

  let info;
  try {
    info = await fsp.stat(absolute);
    if (!info.isFile()) return new Response("Not found", { status: 404 });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const headers = {
    "Content-Type": blobProtocol.contentType(absolute),
    // Unlike vault blobs, a path on the user's disk can be overwritten in
    // place, so this must revalidate rather than cache forever.
    "Cache-Control": "no-cache",
    "Accept-Ranges": "bytes",
  };

  const rangeHeader =
    typeof request?.headers?.get === "function" ? request.headers.get("range") : null;
  const range = rangeHeader ? blobProtocol.parseRange(rangeHeader, info.size) : null;

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

function schemeRegistration() {
  return { scheme: SCHEME, privileges: PRIVILEGES };
}

function bind(session) {
  if (!session || session.__lyknMacFileProtocolBound) return false;
  try {
    session.protocol.handle(SCHEME, handleRequest);
    session.__lyknMacFileProtocolBound = true;
    return true;
  } catch (err) {
    console.warn("[LYKN] lykn-mac protocol bind failed:", err?.message);
    return false;
  }
}

module.exports = {
  SCHEME,
  HOST,
  PRIVILEGES,
  urlFor,
  pathFromUrl,
  handleRequest,
  schemeRegistration,
  bind,
};
