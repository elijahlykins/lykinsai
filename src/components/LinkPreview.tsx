import React, { memo, useMemo, useState } from "react";
import { ExternalLink, Globe } from "lucide-react";

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

/**
 * A deliberately curated palette of two-stop gradients. Picked to be vibrant
 * but not clown-y — they read well under the translucent "glass" UI on both
 * light and dark backgrounds.
 */
const GRADIENTS: Array<[string, string]> = [
  ["#6366f1", "#a855f7"],
  ["#0ea5e9", "#22d3ee"],
  ["#f472b6", "#f97316"],
  ["#10b981", "#0ea5e9"],
  ["#8b5cf6", "#ec4899"],
  ["#f59e0b", "#ef4444"],
  ["#06b6d4", "#3b82f6"],
  ["#84cc16", "#14b8a6"],
  ["#d946ef", "#7c3aed"],
  ["#0891b2", "#4f46e5"],
  ["#be185d", "#7c3aed"],
  ["#059669", "#65a30d"],
  ["#f43f5e", "#8b5cf6"],
  ["#2dd4bf", "#6366f1"],
];

/** Fast, stable FNV-1a hash. Same hostname always produces the same gradient. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function safeHostname(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function monogramFor(host: string, fallback: string): string {
  const cleaned = (host || fallback || "").replace(/^www\./, "");
  if (!cleaned) return "?";
  // For "github.com" → "G"; for "news.ycombinator.com" use the base site → "Y"
  const parts = cleaned.split(".").filter(Boolean);
  const base = parts.length >= 2 ? parts[parts.length - 2] : parts[0] || cleaned;
  return (base[0] || "?").toUpperCase();
}

function gradientFor(seed: string): { from: string; to: string; css: string } {
  const idx = hashString(seed || "x") % GRADIENTS.length;
  const [from, to] = GRADIENTS[idx];
  // Slight angle variance per seed so adjacent tiles don't all mirror.
  const angle = 115 + (hashString(seed + "angle") % 50); // 115° – 165°
  return { from, to, css: `linear-gradient(${angle}deg, ${from}, ${to})` };
}

/**
 * The fallback hero used when there's no real OG image.
 * A seeded gradient with a large domain monogram, plus an optional favicon chip.
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
  const grad = useMemo(() => gradientFor(host), [host]);
  const letter = useMemo(() => monogramFor(host, ""), [host]);
  const [faviconOk, setFaviconOk] = useState(Boolean(favicon));
  // Google's S2 favicon service is a reliable fallback even when a site doesn't
  // expose an icon in its HTML. 128px renders crisp on retina.
  const googleFavicon = host
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`
    : "";
  const effectiveFavicon = favicon || googleFavicon;

  return (
    <div
      className="relative w-full h-full overflow-hidden flex items-center justify-center"
      style={{ background: grad.css }}
      aria-hidden="true"
    >
      {/* Soft radial sheen for depth */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(120% 80% at 20% 15%, rgba(255,255,255,0.28), transparent 55%), radial-gradient(100% 70% at 85% 90%, rgba(0,0,0,0.22), transparent 60%)",
        }}
      />
      {/* Subtle grid texture, very faint */}
      <div
        className="absolute inset-0 opacity-[0.08] pointer-events-none"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />
      <div
        className="relative font-semibold text-white select-none"
        style={{
          fontSize: compact ? "clamp(2.25rem, 28%, 4rem)" : "clamp(3rem, 38%, 7rem)",
          lineHeight: 1,
          letterSpacing: "-0.04em",
          textShadow: "0 2px 20px rgba(0,0,0,0.18)",
          fontFamily:
            '"Playfair Display", Georgia, "Iowan Old Style", "Times New Roman", serif',
        }}
      >
        {letter}
      </div>
      {effectiveFavicon && faviconOk && (
        <div
          className="absolute bottom-2.5 right-2.5 w-8 h-8 rounded-lg bg-white/90 backdrop-blur-sm flex items-center justify-center shadow-md ring-1 ring-black/5"
        >
          <img
            src={effectiveFavicon}
            alt=""
            className="w-5 h-5 rounded-sm"
            draggable={false}
            onError={() => setFaviconOk(false)}
          />
        </div>
      )}
    </div>
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
      {hasImage ? (
        <div className={heroClass}>
          <HeroImage src={image as string} host={host} favicon={favicon} />
        </div>
      ) : (
        <div className={heroClass}>
          <MonogramHero host={host} favicon={favicon} compact={variant === "canvas"} />
        </div>
      )}
      <div className="p-3.5 space-y-1.5 shrink-0">
        <div className="flex items-center gap-1.5 text-black/50 dark:text-white/50">
          <FaviconOrGlobe favicon={favicon} host={host} />
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

function HeroImage({
  src,
  host,
  favicon,
}: {
  src: string;
  host: string;
  favicon?: string;
}) {
  const [errored, setErrored] = useState(false);
  if (errored) {
    return <MonogramHero host={host} favicon={favicon} />;
  }
  return (
    <img
      src={src}
      alt=""
      className="w-full h-full object-cover group-hover/bm:scale-[1.03] transition-transform duration-300"
      loading="lazy"
      draggable={false}
      onError={() => setErrored(true)}
    />
  );
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
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={className}
      draggable={draggable}
      title={url}
    >
      {children}
    </a>
  );
}

export default LinkPreview;
