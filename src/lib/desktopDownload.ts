import { API_BASE_URL } from "@/lib/api-config";

export type DesktopDownloadPlatform = "mac" | "win";
export type DesktopDownloadSource = "website" | "email" | "windows" | "other";

/** Counted installer URL. Hits our API, which logs the request then 302s
    to the GitHub release asset. */
export function desktopDownloadUrl(
  platform: DesktopDownloadPlatform,
  source: DesktopDownloadSource = "website",
) {
  const src = encodeURIComponent(source);
  return `${API_BASE_URL}/api/download/${platform}?src=${src}`;
}
