import React, { memo, useEffect, useMemo, useState } from "react";
import { ExternalLink, Globe } from "lucide-react";
import { extractYouTubeVideoId } from "@/lib/media/youtube";

export interface LinkPreviewProps {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
  authorName?: string;
  authorHandle?: string;
  oembedType?: string;
  /**
   * `vault` – fixed hero height (h-36) used in the vault grid tiles.
   * `canvas` – hero flexes to fill the remaining block height.
   */
  variant?: "vault" | "canvas";
  /** Optional click override. If omitted, component renders a plain <a/> that opens the URL in a new tab. */
  onOpen?: () => void;
  className?: string;
  draggable?: boolean;
}

// Minimum pixel size we'll accept before treating an image as a 1×1
// placeholder / blocked tracker pixel and falling through to the next
// candidate. Apple touch icons are typically 60–180px, Clearbit logos
// 128px, Google's `sz=256` favicons 256px, so 24px is a comfortable
// floor that excludes obvious junk without rejecting real (small) icons.
const MIN_USABLE_IMAGE_PX = 24;

// Map a bookmark host to its canonical app icon. Used as a fallback
// when the connector-supplied `attachment.favicon` is missing, broken,
// or — most importantly for Google products — points at an asset that
// returns the generic Google "G" logo instead of the per-app brand
// icon (Gmail's "M", Drive's triangle, Calendar's date tile, etc.).
//
// Without this override, Google's S2 favicon service for any
// `*.google.com` host returns the same Google "G", which makes a vault
// folder full of Gmail emails or Drive files visually indistinguishable
// from each other. The gstatic URLs below are the same brand assets
// the connector catalog (`src/lib/connectors/catalog.js`) uses for the
// app cards, so a Gmail email card's icon now matches the Gmail
// connector tile exactly.
//
// Keep keys lowercase + un-prefixed (no `www.`) — `safeHostname` already
// strips the `www.` prefix before we look up here.
const BRAND_ICON_BY_HOST: Record<string, string> = {
  "mail.google.com": "https://www.gstatic.com/images/branding/product/2x/gmail_2020q4_48dp.png",
  "calendar.google.com": "https://www.gstatic.com/images/branding/product/2x/calendar_2020q4_48dp.png",
  "drive.google.com": "https://www.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png",
  "docs.google.com": "https://www.gstatic.com/images/branding/product/2x/docs_2020q4_48dp.png",
  "sheets.google.com": "https://www.gstatic.com/images/branding/product/2x/sheets_2020q4_48dp.png",
  "slides.google.com": "https://www.gstatic.com/images/branding/product/2x/slides_2020q4_48dp.png",
  "keep.google.com": "https://www.gstatic.com/images/branding/product/2x/keep_2020q4_48dp.png",
  "youtube.com": "https://www.gstatic.com/images/branding/product/2x/youtube_48dp.png",
};

// `docs.google.com` covers Docs, Sheets, Slides via path. Override based
// on the path segment so e.g. a Sheet's card shows the Sheets icon.
//
// Calendar is the odd one out among Google products: `event.htmlLink`
// resolves to `https://www.google.com/calendar/event?eid=…`, so the
// hostname is `google.com` (after stripping `www.`) — not the
// `calendar.google.com` we'd otherwise key on. Without the path-based
// override below, every Calendar bookmark falls through the BRAND_ICON
// map and ends up with the generic Google "G" from Clearbit / S2.
function brandIconFor(url: string, host: string): string {
  if (host === "docs.google.com") {
    if (url.includes("/document/")) return BRAND_ICON_BY_HOST["docs.google.com"];
    if (url.includes("/spreadsheets/")) return BRAND_ICON_BY_HOST["sheets.google.com"];
    if (url.includes("/presentation/")) return BRAND_ICON_BY_HOST["slides.google.com"];
  }
  if (host === "google.com" && url.includes("/calendar/")) {
    return BRAND_ICON_BY_HOST["calendar.google.com"];
  }
  return BRAND_ICON_BY_HOST[host] || "";
}

function safeHostname(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    // Bare-hostname inputs (e.g. legacy records storing "youtube.com")
    // throw on `new URL` because they lack a scheme. Re-attempt with
    // an https:// prefix so the logo cascade still has a host to query.
    try {
      return new URL(`https://${String(raw || "").trim()}`).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }
}

/**
 * Normalize a URL for use as an `<a href>`. Any link card persisted
 * before the URL-normalization fix in the save-link flow can hold a
 * bare hostname like `"youtube.com"`, which the browser would resolve
 * relative to the current page (so a click would navigate to
 * `https://app.lykn.ai/youtube.com` instead of YouTube). Re-normalize
 * here as a safety net — it's a no-op for already-fully-qualified URLs.
 */
function normalizeHref(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return trimmed;
  if (/^[a-z][a-z0-9+\-.]*:/i.test(trimmed)) return trimmed;
  // Only upgrade to https:// when it actually looks like a host —
  // never blindly prepend a scheme to arbitrary text.
  if (
    trimmed.includes(".") ||
    /^localhost(:\d+)?(\/|$|\?|#)/i.test(trimmed) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?/.test(trimmed)
  ) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

function monogramFor(host: string, fallback: string): string {
  const cleaned = (host || fallback || "").replace(/^www\./, "");
  if (!cleaned) return "?";
  // For "github.com" → "G"; for "news.ycombinator.com" use the base site → "Y"
  const parts = cleaned.split(".").filter(Boolean);
  const base = parts.length >= 2 ? parts[parts.length - 2] : parts[0] || cleaned;
  return (base[0] || "?").toUpperCase();
}

/**
 * Neutral white backdrop used by both the monogram fallback and the
 * centered-logo fallback. Replaces the previous per-domain gradient
 * because the rainbow of card colors made the grid feel busy and
 * inconsistent — the user-facing requirement here is "just make the
 * background color white". The dark-mode variant uses a faint
 * translucent white so it picks up whatever surface sits behind it
 * without slamming a pure-white tile into a dark UI.
 */
function NeutralBackdrop({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      className="relative w-full h-full overflow-hidden flex items-center justify-center bg-white dark:bg-white/[0.04]"
      aria-hidden="true"
    >
      {children}
    </div>
  );
}

/**
 * The "last resort" fallback when there's no usable image OR logo.
 * A clean white tile with the domain monogram and an optional favicon
 * chip in the corner.
 */
function MonogramHero({
  host,
  favicon,
  compact,
}: {
  host: string;
  favicon?: string;
  compact?: boolean;
}) {
  const letter = useMemo(() => monogramFor(host, ""), [host]);
  const [faviconOk, setFaviconOk] = useState(Boolean(favicon));
  const googleFavicon = host
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`
    : "";
  const effectiveFavicon = favicon || googleFavicon;

  return (
    <NeutralBackdrop>
      <div
        // The letter is now muted instead of white-on-gradient — the
        // tile reads as "no preview available" placeholder rather than
        // a hero element. text-black/25 (and white/25 in dark mode)
        // sits comfortably on the new neutral backdrop without
        // demanding attention.
        className="relative font-semibold text-black/25 dark:text-white/25 select-none"
        style={{
          fontSize: compact ? "clamp(2.25rem, 28%, 4rem)" : "clamp(3rem, 38%, 7rem)",
          lineHeight: 1,
          letterSpacing: "-0.04em",
          fontFamily:
            '"Playfair Display", Georgia, "Iowan Old Style", "Times New Roman", serif',
        }}
      >
        {letter}
      </div>
      {effectiveFavicon && faviconOk && (
        <div className="absolute bottom-2.5 right-2.5 w-8 h-8 rounded-lg bg-white/90 dark:bg-white/15 backdrop-blur-sm flex items-center justify-center shadow-sm ring-1 ring-black/5 dark:ring-white/10">
          <img
            src={effectiveFavicon}
            alt=""
            className="w-5 h-5 rounded-sm"
            draggable={false}
            onError={() => setFaviconOk(false)}
          />
        </div>
      )}
    </NeutralBackdrop>
  );
}

/**
 * Mid-tier fallback used when we couldn't find a proper hero image but
 * we DID find a high-resolution logo (apple-touch-icon, Clearbit, etc.).
 * The previous version wrapped the logo in a white plate to protect it
 * from a colored gradient — now that the backdrop itself is white, the
 * plate is redundant, so the logo just sits centered on the clean tile.
 */
function LogoHero({
  src,
  onError,
}: {
  src: string;
  onError: () => void;
}) {
  return (
    <NeutralBackdrop>
      <img
        src={src}
        alt=""
        className="w-[55%] aspect-square max-w-[160px] object-contain"
        draggable={false}
        loading="lazy"
        onLoad={(e) => {
          const w = e.currentTarget.naturalWidth;
          const h = e.currentTarget.naturalHeight;
          if (w < MIN_USABLE_IMAGE_PX || h < MIN_USABLE_IMAGE_PX) onError();
        }}
        onError={onError}
      />
    </NeutralBackdrop>
  );
}

export const LinkPreview = memo(function LinkPreview({
  url,
  title,
  description,
  image,
  siteName,
  favicon,
  authorName,
  authorHandle,
  oembedType,
  variant = "vault",
  onOpen,
  className = "",
  draggable = false,
}: LinkPreviewProps) {
  const host = useMemo(() => safeHostname(url), [url]);
  const domain = (siteName && siteName.trim()) || host || "link";
  const trimmedTitle = String(title || "").trim();
  const trimmedDesc = String(description || "").slice(0, 280).trim();
  const hasImage = Boolean(String(image || "").trim());
  const displayTitle = trimmedTitle || domain || url;
  // For known connector hosts (Gmail, Drive, Calendar, etc.) prefer the
  // canonical gstatic brand icon over whatever favicon the bookmark
  // shipped with. This corrects two failure modes in one shot:
  //   • Connector adapters whose favicon URL has rotted (Gmail's old
  //     `google.com/gmail/about/...` asset, etc.).
  //   • The S2 favicon fallback returning the generic Google "G" for
  //     every `*.google.com` subdomain, which made every Gmail / Drive /
  //     Calendar card visually identical.
  const brandIcon = useMemo(() => brandIconFor(url, host), [url, host]);
  const effectiveFavicon = brandIcon || favicon;

  // Special-case: X / Twitter tweet with body text → render the tweet card.
  if (oembedType === "twitter" && trimmedDesc) {
    return (
      <Shell
        url={url}
        onOpen={onOpen}
        className={`block w-full h-full rounded-2xl overflow-hidden border border-white/40 dark:border-white/15 bg-white/30 dark:bg-white/5 backdrop-blur-md hover:bg-white/40 dark:hover:bg-white/10 transition-colors group/bm ${className}`}
        draggable={draggable}
      >
        <div className="p-4 flex flex-col gap-2.5 h-full">
          <div className="flex items-center gap-2">
            <svg
              viewBox="0 0 24 24"
              className="w-4 h-4 shrink-0 fill-current text-black/70 dark:text-white/70"
              aria-hidden="true"
            >
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
            <div className="min-w-0 flex-1">
              <span className="text-sm font-semibold text-black/85 dark:text-white/85 truncate block leading-tight">
                {authorName || displayTitle}
              </span>
              {authorHandle && (
                <span className="text-[0.625rem] text-black/45 dark:text-white/45 truncate block leading-tight">
                  {authorHandle}
                </span>
              )}
            </div>
            <ExternalLink className="w-3 h-3 opacity-0 group-hover/bm:opacity-60 transition-opacity shrink-0" />
          </div>
          <p className="text-[13px] text-black/75 dark:text-white/75 leading-relaxed whitespace-pre-line line-clamp-[10] flex-1 overflow-hidden">
            {trimmedDesc}
          </p>
          <div className="flex items-center gap-1.5 text-black/35 dark:text-white/35 pt-1.5 border-t border-black/8 dark:border-white/8">
            <span className="text-[0.6rem]">X (Twitter)</span>
          </div>
        </div>
      </Shell>
    );
  }

  const heroClass =
    variant === "canvas"
      ? "w-full flex-1 min-h-0 overflow-hidden bg-black/5"
      : "w-full h-36 overflow-hidden bg-black/5";

  return (
    <Shell
      url={url}
      onOpen={onOpen}
      className={`block w-full h-full rounded-2xl overflow-hidden border border-white/40 dark:border-white/15 bg-white/30 dark:bg-white/5 backdrop-blur-md hover:bg-white/40 dark:hover:bg-white/10 transition-colors group/bm flex flex-col ${className}`}
      draggable={draggable}
    >
      <div className={heroClass}>
        <SmartCover
          url={url}
          host={host}
          initialSrc={hasImage ? (image as string) : ""}
          favicon={effectiveFavicon}
          brandIcon={brandIcon}
          compact={variant === "canvas"}
        />
      </div>
      <div className="p-3.5 space-y-1.5 shrink-0">
        <div className="flex items-center gap-1.5 text-black/50 dark:text-white/50">
          <FaviconOrGlobe favicon={effectiveFavicon} host={host} />
          <span className="text-[0.625rem] font-medium truncate">{domain}</span>
          <ExternalLink className="w-2.5 h-2.5 ml-auto opacity-0 group-hover/bm:opacity-100 transition-opacity" />
        </div>
        <p className="text-sm font-semibold text-black/85 dark:text-white/85 leading-snug line-clamp-2">
          {displayTitle}
        </p>
        {trimmedDesc && (
          <p className="text-xs text-black/55 dark:text-white/55 leading-relaxed line-clamp-3">
            {trimmedDesc}
          </p>
        )}
      </div>
    </Shell>
  );
});

/**
 * "Dig harder" cover. Walks an ordered cascade of image candidates,
 * advancing on `onError` (and on suspiciously tiny `naturalWidth` /
 * `naturalHeight` for the hero phase, which catches 1×1 tracker pixels
 * and "image not available" placeholders). Falls through:
 *
 *   1. Hero phase  – full-bleed, `object-cover`. Tries:
 *        a. Provided OG image (best quality, hand-picked by site)
 *        b. YouTube `maxresdefault` (1280×720 — only for youtube URLs)
 *        c. YouTube `hqdefault`     (480×360 — exists for almost every
 *           video including ones without maxres)
 *
 *   2. Logo phase – centered logo plate on the brand gradient. Tries:
 *        a. `/apple-touch-icon.png` (180×180 spec, exists on most sites)
 *        b. `/apple-touch-icon-precomposed.png` (legacy iOS variant)
 *        c. Clearbit's logo CDN (`logo.clearbit.com`, 128px square)
 *        d. Google's S2 favicon service at sz=256
 *
 *   3. Monogram – the original gradient + letter, but now genuinely a
 *      last resort instead of the first fallback.
 *
 * Every candidate is a plain `<img>` load — no fetch, no CORS dance —
 * so the cost of a missed candidate is one HEAD-equivalent request and
 * one re-render. Candidates 2a-2d in particular cover the long tail of
 * sites that don't bother with og:image but DO ship a proper touch
 * icon (almost every modern marketing site).
 */
function SmartCover({
  url,
  host,
  initialSrc,
  favicon,
  brandIcon,
  compact,
}: {
  url: string;
  host: string;
  initialSrc: string;
  favicon?: string;
  brandIcon?: string;
  compact?: boolean;
}) {
  const heroCandidates = useMemo(() => {
    const list: string[] = [];
    if (initialSrc) list.push(initialSrc);
    const ytId = extractYouTubeVideoId(url);
    if (ytId) {
      list.push(`https://i.ytimg.com/vi/${ytId}/maxresdefault.jpg`);
      list.push(`https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`);
    }
    return list;
  }, [initialSrc, url]);

  const logoCandidates = useMemo(() => {
    if (!host) return [] as string[];
    // The brand icon (when known — Gmail, Drive, Calendar, etc.) is
    // tried FIRST so we never fall through to clearbit / S2 for hosts
    // we have a canonical asset for. Without this prepend, the cascade
    // would land on Google's S2 favicon for every `*.google.com`
    // subdomain and render the generic Google "G".
    const list: string[] = [];
    if (brandIcon) list.push(brandIcon);
    list.push(
      `https://${host}/apple-touch-icon.png`,
      `https://${host}/apple-touch-icon-precomposed.png`,
      `https://logo.clearbit.com/${host}`,
      `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=256`,
    );
    return list;
  }, [host, brandIcon]);

  type Phase = "hero" | "logo" | "monogram";
  const [phase, setPhase] = useState<Phase>(heroCandidates.length > 0 ? "hero" : "logo");
  const [heroIdx, setHeroIdx] = useState(0);
  const [logoIdx, setLogoIdx] = useState(0);

  // Reset the cascade when inputs change (e.g. card re-used for a
  // different URL after a search result).
  useEffect(() => {
    setHeroIdx(0);
    setLogoIdx(0);
    setPhase(heroCandidates.length > 0 ? "hero" : logoCandidates.length > 0 ? "logo" : "monogram");
  }, [heroCandidates, logoCandidates]);

  const advanceHero = () => {
    if (heroIdx + 1 < heroCandidates.length) {
      setHeroIdx(heroIdx + 1);
    } else if (logoCandidates.length > 0) {
      setPhase("logo");
    } else {
      setPhase("monogram");
    }
  };

  const advanceLogo = () => {
    if (logoIdx + 1 < logoCandidates.length) {
      setLogoIdx(logoIdx + 1);
    } else {
      setPhase("monogram");
    }
  };

  if (phase === "hero" && heroCandidates[heroIdx]) {
    const src = heroCandidates[heroIdx];
    return (
      <img
        // `key` ensures React remounts the <img> on src change, which
        // matters because some browsers fire `onError` for the previous
        // src on the same element when the new src is set rapidly.
        key={`hero-${heroIdx}-${src}`}
        src={src}
        alt=""
        className="w-full h-full object-cover group-hover/bm:scale-[1.03] transition-transform duration-300"
        loading="lazy"
        draggable={false}
        onLoad={(e) => {
          const w = e.currentTarget.naturalWidth;
          const h = e.currentTarget.naturalHeight;
          if (w < MIN_USABLE_IMAGE_PX || h < MIN_USABLE_IMAGE_PX) advanceHero();
        }}
        onError={advanceHero}
      />
    );
  }

  if (phase === "logo" && logoCandidates[logoIdx]) {
    const src = logoCandidates[logoIdx];
    return (
      <LogoHero key={`logo-${logoIdx}-${src}`} src={src} onError={advanceLogo} />
    );
  }

  return <MonogramHero host={host} favicon={favicon} compact={compact} />;
}

function FaviconOrGlobe({ favicon, host }: { favicon?: string; host: string }) {
  const [errored, setErrored] = useState(false);
  const googleFavicon = host
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`
    : "";
  const src = !errored ? favicon || googleFavicon : "";
  if (!src) return <Globe className="w-3.5 h-3.5" />;
  return (
    <img
      src={src}
      alt=""
      className="w-3.5 h-3.5 rounded-sm"
      onError={() => setErrored(true)}
    />
  );
}

/** If `onOpen` is supplied, render as a button; otherwise as an anchor. */
function Shell({
  url,
  onOpen,
  className,
  draggable,
  children,
}: {
  url: string;
  onOpen?: () => void;
  className?: string;
  draggable?: boolean;
  children: React.ReactNode;
}) {
  if (onOpen) {
    return (
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        className={`text-left ${className || ""}`}
        title={url}
      >
        {children}
      </button>
    );
  }
  // Re-normalize the href so legacy bare-hostname records ("youtube.com")
  // don't navigate to a relative path on the current origin.
  const safeHref = normalizeHref(url);
  return (
    <a
      href={safeHref}
      target="_blank"
      rel="noreferrer"
      className={className}
      draggable={draggable}
      title={safeHref}
    >
      {children}
    </a>
  );
}

export default LinkPreview;
