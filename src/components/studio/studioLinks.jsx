// Studio link plumbing — route URLs into the Studio browser (or the system
// browser as a fallback) and resolve site favicons for links shown in the
// shell (agent rail history, source-link rows).
import { useState } from "react";
import { Globe } from "lucide-react";

export function openStudioLink(url) {
  const u = String(url || "").trim();
  if (!u) return;
  try {
    if (window.lykn?.studioOpenUrl) {
      window.lykn.studioOpenUrl(u);
      return;
    }
  } catch {
    /* fall through */
  }
  if (window.lykn?.openExternal) window.lykn.openExternal(u);
  else window.open(u, "_blank", "noopener");
}

/** Product icons for Google hosts — S2 returns the same "G" for every *.google.com. */
const STUDIO_BRAND_ICON_BY_HOST = {
  "mail.google.com":
    "https://www.gstatic.com/images/branding/product/2x/gmail_2020q4_48dp.png",
  "calendar.google.com":
    "https://www.gstatic.com/images/branding/product/2x/calendar_2020q4_48dp.png",
  "drive.google.com":
    "https://www.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png",
  "docs.google.com":
    "https://www.gstatic.com/images/branding/product/2x/docs_2020q4_48dp.png",
  "sheets.google.com":
    "https://www.gstatic.com/images/branding/product/2x/sheets_2020q4_48dp.png",
  "slides.google.com":
    "https://www.gstatic.com/images/branding/product/2x/slides_2020q4_48dp.png",
  "keep.google.com":
    "https://www.gstatic.com/images/branding/product/2x/keep_2020q4_48dp.png",
  "youtube.com":
    "https://www.gstatic.com/images/branding/product/2x/youtube_48dp.png",
  "music.youtube.com":
    "https://www.gstatic.com/images/branding/product/2x/youtube_music_2020q4_48dp.png",
};

function studioBrandIconFor(url) {
  try {
    const raw = String(url || "");
    const host = new URL(raw).hostname.replace(/^www\./i, "");
    if (host === "docs.google.com") {
      if (raw.includes("/document/")) return STUDIO_BRAND_ICON_BY_HOST["docs.google.com"];
      if (raw.includes("/spreadsheets/")) return STUDIO_BRAND_ICON_BY_HOST["sheets.google.com"];
      if (raw.includes("/presentation/")) return STUDIO_BRAND_ICON_BY_HOST["slides.google.com"];
    }
    if (host === "google.com" && raw.includes("/calendar/")) {
      return STUDIO_BRAND_ICON_BY_HOST["calendar.google.com"];
    }
    return STUDIO_BRAND_ICON_BY_HOST[host] || "";
  } catch {
    return "";
  }
}

/** Site favicon URL. Google products use gstatic brand icons; others use S2. */
export function studioFaviconUrl(url) {
  const brand = studioBrandIconFor(url);
  if (brand) return brand;
  try {
    const host = new URL(String(url || "")).hostname.replace(/^www\./i, "");
    if (!host) return "";
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
  } catch {
    return "";
  }
}

/** Site favicon with Lucide fallback (browser tabs, search, agent rail, history). */
export function PageFavicon({ url, fallback: Fallback = Globe, className = "h-4 w-4" }) {
  const [failed, setFailed] = useState(false);
  const src = studioFaviconUrl(url);
  if (!src || failed) {
    return <Fallback className={`flex-none shrink-0 ${className}`} strokeWidth={1.75} />;
  }
  return (
    <img
      src={src}
      alt=""
      className={`flex-none shrink-0 rounded-[3px] object-contain ${className}`}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
