import React, { useMemo, useState } from "react";
import { Link2 } from "lucide-react";

function hostnameFromUrl(raw: string): string {
  try {
    return new URL(String(raw || "")).hostname.replace(/^www\./i, "");
  } catch {
    try {
      return new URL(`https://${String(raw || "").trim()}`).hostname.replace(/^www\./i, "");
    } catch {
      return "";
    }
  }
}

/** Google S2 favicon for a page URL or bare hostname. */
export function siteFaviconUrl(urlOrHost: string, size = 64): string {
  const host = hostnameFromUrl(urlOrHost);
  if (!host) return "";
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${size}`;
}

/**
 * Real site favicon (Nike swoosh, etc.) with a link-icon fallback when the
 * image fails to load.
 */
export function SiteFavicon({
  url,
  className = "h-3.5 w-3.5",
  imgClassName,
}: {
  url: string;
  className?: string;
  imgClassName?: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = useMemo(() => siteFaviconUrl(url, 64), [url]);

  if (!src || failed) {
    return <Link2 className={`flex-shrink-0 opacity-40 ${className}`} aria-hidden />;
  }

  return (
    <img
      src={src}
      alt=""
      className={`flex-shrink-0 rounded-sm object-contain ${imgClassName || className}`}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

export default SiteFavicon;
