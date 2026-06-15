export function extractYouTubeVideoId(inputUrl: string): string | null {
  const s = String(inputUrl || "").trim();
  if (!s) return null;
  let url: URL | null = null;
  try {
    url = new URL(s);
  } catch {
    // allow bare IDs
    if (/^[a-zA-Z0-9_-]{6,}$/.test(s)) return s;
    return null;
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0] || "";
    return id || null;
  }
  if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
    const v = url.searchParams.get("v");
    if (v) return v;
    const parts = url.pathname.split("/").filter(Boolean);
    const iEmbed = parts.indexOf("embed");
    if (iEmbed >= 0 && parts[iEmbed + 1]) return parts[iEmbed + 1];
    const iShorts = parts.indexOf("shorts");
    if (iShorts >= 0 && parts[iShorts + 1]) return parts[iShorts + 1];
    const iLive = parts.indexOf("live");
    if (iLive >= 0 && parts[iLive + 1]) return parts[iLive + 1];
  }
  return null;
}

export function isYouTubeUrl(inputUrl: string): boolean {
  return extractYouTubeVideoId(inputUrl) != null;
}

export function getYouTubeEmbedUrl(videoId: string): string {
  const id = encodeURIComponent(String(videoId || ""));
  return `https://www.youtube-nocookie.com/embed/${id}`;
}
