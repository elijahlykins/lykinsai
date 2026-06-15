import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Instagram, Play, Facebook } from "lucide-react";
import { loadAndProcessEmbed } from "@/lib/embedScripts";
import { getSocialEmbedLabel, isVerticalSocialContent } from "@/lib/media/socialEmbed";
import { sanitizeEmbedHtml } from "@/lib/sanitizeEmbedHtml";

/* ------------------------------------------------------------------ */
/*  Inline social embed renderer — used by the Vault preview surface  */
/* ------------------------------------------------------------------ */

interface SocialEmbedInlineProps {
  platform: string;
  oembedHtml: string;
  url: string;
  thumbnailUrl?: string;
  title?: string;
  authorName?: string;
  authorHandle?: string;
  className?: string;
  /** When true, shows a compact thumbnail-only preview instead of the full embed */
  compact?: boolean;
}

/**
 * Renders an inline social media embed (Instagram / TikTok / Facebook).
 * Loads the platform's embed SDK lazily and activates it after mount.
 */
export const SocialEmbedInline = memo(function SocialEmbedInline({
  platform,
  oembedHtml,
  url,
  thumbnailUrl,
  title,
  authorName,
  authorHandle,
  className,
  compact,
}: SocialEmbedInlineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [showEmbed, setShowEmbed] = useState(!compact);

  // Sanitize once per html change. The oEmbed payload comes from `/api/unfurl`
  // and is stored verbatim in the DB, so stripping scripts / inline event
  // handlers here is defense-in-depth against poisoned upstream responses.
  const safeOembedHtml = useMemo(() => sanitizeEmbedHtml(oembedHtml), [oembedHtml]);

  useEffect(() => {
    if (!showEmbed || !safeOembedHtml || !containerRef.current) return;
    let cancelled = false;

    loadAndProcessEmbed(platform, containerRef.current).then(() => {
      if (!cancelled) setLoaded(true);
    });

    return () => { cancelled = true; };
  }, [platform, safeOembedHtml, showEmbed]);

  // Re-process if the embed HTML changes (e.g. navigating between cards)
  useEffect(() => {
    if (!loaded || !containerRef.current) return;
    const timer = setTimeout(() => {
      loadAndProcessEmbed(platform, containerRef.current);
    }, 100);
    return () => clearTimeout(timer);
  }, [loaded, safeOembedHtml, platform]);

  const openUrl = useCallback(() => {
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }, [url]);

  const label = getSocialEmbedLabel(platform);
  const isVertical = isVerticalSocialContent(url);
  const PlatformIcon = platform === "instagram" ? Instagram
    : platform === "facebook" ? Facebook
    : Play; // TikTok has no lucide icon; use Play

  // Compact mode: show thumbnail with play overlay (used in embedded vault sidebar)
  if (compact && safeOembedHtml) {
    return (
      <button
        type="button"
        className={`w-full h-full flex flex-col text-left overflow-hidden group/social ${className || ""}`}
        onClick={(e) => {
          e.stopPropagation();
          setShowEmbed(true);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        title={url}
      >
        {thumbnailUrl ? (
          <div className="w-full flex-1 min-h-0 overflow-hidden bg-black/5 relative">
            <img
              src={thumbnailUrl}
              alt=""
              className="w-full h-full object-cover group-hover/social:scale-[1.03] transition-transform duration-300"
              draggable={false}
              onError={(e) => { (e.currentTarget as HTMLElement).style.display = "none"; }}
            />
            <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 group-hover/social:opacity-100 transition-opacity">
              <div className="w-12 h-12 rounded-full bg-white/90 flex items-center justify-center shadow-lg">
                <Play className="w-5 h-5 text-gray-800 ml-0.5" />
              </div>
            </div>
          </div>
        ) : (
          <div className="w-full flex-1 min-h-0 flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-800 dark:to-gray-900">
            <PlatformIcon className="w-10 h-10 text-gray-400" />
          </div>
        )}
        <div className="p-3 space-y-1 shrink-0">
          <div className="flex items-center gap-1.5 text-gray-500 dark:text-gray-400">
            <PlatformIcon className="w-3.5 h-3.5" />
            <span className="text-[0.625rem] font-medium truncate">{label}</span>
          </div>
          {(title || authorName) && (
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 leading-snug line-clamp-2">
              {title || authorName}
            </p>
          )}
        </div>
      </button>
    );
  }

  // No oEmbed HTML available — show a rich preview card with OG data
  if (!safeOembedHtml) {
    return (
      <div
        className={`w-full h-full flex flex-col text-left overflow-hidden group/social ${className || ""}`}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {thumbnailUrl ? (
          <div className="w-full flex-1 min-h-0 overflow-hidden bg-black/5 relative">
            <img
              src={thumbnailUrl}
              alt=""
              className="w-full h-full object-cover"
              draggable={false}
              onError={(e) => { (e.currentTarget as HTMLElement).style.display = "none"; }}
            />
          </div>
        ) : (
          <div className="w-full flex-1 min-h-0 flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-800 dark:to-gray-900">
            <PlatformIcon className="w-10 h-10 text-gray-400" />
          </div>
        )}
        <div className="p-3 space-y-1.5 shrink-0">
          <div className="flex items-center gap-1.5 text-gray-500 dark:text-gray-400">
            <PlatformIcon className="w-3.5 h-3.5" />
            <span className="text-[0.625rem] font-medium truncate">{label}</span>
          </div>
          {(title || authorName) && (
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 leading-snug line-clamp-2">
              {title || authorName}
            </p>
          )}
          {authorHandle && (
            <p className="text-xs text-gray-600/80 dark:text-gray-300/70 truncate">{authorHandle}</p>
          )}
          <button
            type="button"
            className="mt-1 flex items-center gap-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
            onClick={(e) => { e.stopPropagation(); openUrl(); }}
          >
            <ExternalLink className="w-3 h-3" />
            Open on {label}
          </button>
        </div>
      </div>
    );
  }

  // Full embed mode
  return (
    <div
      className={`w-full h-full overflow-auto relative ${className || ""}`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-50 dark:bg-gray-900 z-10">
          <div className="flex flex-col items-center gap-2">
            <div className="w-8 h-8 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
            <span className="text-xs text-gray-500">Loading {label}...</span>
          </div>
        </div>
      )}
      <div
        ref={containerRef}
        className="w-full flex items-start justify-center"
        dangerouslySetInnerHTML={{ __html: safeOembedHtml }}
      />
      <button
        type="button"
        className="absolute top-2 right-2 p-1.5 rounded-lg bg-white/80 dark:bg-black/60 backdrop-blur-sm opacity-0 hover:opacity-100 transition-opacity z-20"
        onClick={(e) => { e.stopPropagation(); openUrl(); }}
        title={`Open on ${label}`}
      >
        <ExternalLink className="w-3.5 h-3.5" />
      </button>
    </div>
  );
});
