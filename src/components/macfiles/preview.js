/**
 * Showing a file's actual contents inside LYKN, rather than handing it to
 * whichever app macOS would launch.
 *
 * Bytes arrive over the `lykn-mac://` scheme the main process serves, so an
 * ordinary <img>/<video>/<iframe> src works and video seeking gets real range
 * requests. The main process re-checks Local Mode and the sync allowlist on
 * every request, so composing a URL here grants nothing on its own.
 */

const SCHEME = "lykn-mac";
const HOST = "file";

/** Mirrors urlFor() in electron/macFileProtocol.cjs. */
export function macFileUrl(absolutePath) {
  const clean = String(absolutePath || "").replace(/^\/+/, "");
  if (!clean) return null;
  return `${SCHEME}://${HOST}/${clean.split("/").map(encodeURIComponent).join("/")}`;
}

const PREVIEW_KINDS = [
  { kind: "image", re: /^(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/ },
  { kind: "video", re: /^(mp4|mov|m4v|webm)$/ },
  { kind: "audio", re: /^(mp3|m4a|wav|aac|flac|ogg)$/ },
  { kind: "pdf", re: /^pdf$/ },
  { kind: "html", re: /^html?$/ },
  {
    kind: "text",
    re: /^(txt|md|markdown|log|json|csv|tsv|yaml|yml|toml|xml|css|scss|js|jsx|ts|tsx|py|rb|go|rs|java|c|h|cpp|cs|swift|kt|php|sh|zsh|sql|env|gitignore)$/,
  },
];

/**
 * The file browser's listing labels every entry with `ext`, but the shell's
 * plain directory listing behind `macFsList` — what the Home desktop reads —
 * carries only a name. Falling back to the name keeps both callers honest;
 * without it every icon on Home reported "no preview".
 *
 * A leading dot is a hidden file, not an extension, matching path.extname.
 */
function extOf(entry) {
  const labelled = String(entry.ext || "").toLowerCase();
  if (labelled) return labelled;
  const name = String(entry.name || "");
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * What LYKN can render for this entry, or null if it can't.
 *
 * HEIC is deliberately absent: Chromium won't decode it, so claiming a preview
 * would show a broken image where "Open in Preview" is the honest answer.
 */
export function previewKind(entry) {
  if (!entry || entry.type === "dir" || entry.package) return null;
  const ext = extOf(entry);
  for (const rule of PREVIEW_KINDS) {
    if (rule.re.test(ext)) return rule.kind;
  }
  return null;
}

// Decoding a 60-megapixel photo down to a 44px tile is a real cost when a
// folder holds hundreds of them, and the payoff is a thumbnail nobody can
// study. Past this the tile keeps its kind icon.
const THUMBNAIL_SIZE_CAP = 12 * 1024 * 1024;

export function canThumbnail(entry) {
  return (
    previewKind(entry) === "image" &&
    extOf(entry) !== "svg" &&
    (entry.size == null || entry.size <= THUMBNAIL_SIZE_CAP)
  );
}

/** Text previews are for reading, not for loading a gigabyte log into memory. */
export const TEXT_PREVIEW_CAP = 512 * 1024;
