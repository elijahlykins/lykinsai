/** Shared query-param helpers for iframe-embedded app surfaces. */

// Embedded surfaces live in dedicated Studio iframes, but in-app navigation
// (e.g. chat opening /chat/<id>) drops the query params. Once a document
// boots embedded/glass it stays that way for its whole lifetime, so the old
// app chrome never leaks into the Studio.
let stickyEmbedded = false;
let stickyGlass = false;

export function readEmbeddedPreviewParams(search: string): {
  isEmbedded: boolean;
  /** `glass=1` — the surface is inside LYKN Studio and should wear the
   *  translucent glass skin (see html.lykn-glass-embed in index.css). */
  isGlass: boolean;
} {
  const params = new URLSearchParams(search);
  if (params.get("embedded") === "1") stickyEmbedded = true;
  if (params.get("glass") === "1") stickyGlass = true;
  return {
    isEmbedded: stickyEmbedded || params.get("embedded") === "1",
    isGlass: stickyGlass || params.get("glass") === "1",
  };
}

/** Append `glass=1` to an embed URL so the page mounts in its glass skin. */
export function withGlassParam(src: string): string {
  if (!src || /[?&]glass=1(&|$)/.test(src)) return src;
  return `${src}${src.includes("?") ? "&" : "?"}glass=1`;
}

export function isEmbeddedSurfacePath(pathname: string): boolean {
  return (
    pathname === "/vault" ||
    pathname === "/app" ||
    // LYKN Studio embeds the real product surfaces inside its glass shell.
    pathname === "/projects" ||
    pathname.startsWith("/projects/") ||
    pathname === "/calendar" ||
    pathname === "/settings" ||
    pathname.startsWith("/chat/")
  );
}
