// Vault card renderers. The two create* exports are deliberately FACTORIES,
// not components: Vault.jsx calls them on every render to rebuild the same
// closures it used to define inline, so call sites
// (`renderAttachmentCard(card, tileHeightClass)`, `renderCollageCard(card)`)
// and reconciliation behavior are unchanged. Extracted verbatim from
// src/pages/Vault.jsx (Vault decomposition phase, see docs/REFACTOR_LOG.md).
// A future behavioral batch can turn them into real components.
import {
  CalendarDays,
  Check,
  Clock,
  FileText,
  Globe,
  ListTodo,
  Loader2,
  MessageCircle,
  Mic,
  Music,
  StickyNote,
  Table2,
  Video,
} from "lucide-react";
import { motion } from "framer-motion";
import { supabase } from "@/lib/supabase";
import LinkPreview from "@/components/LinkPreview";
import { SocialEmbedInline } from "@/components/media/SocialEmbedInline";
import SourceFolderTile from "@/components/vault/SourceFolderTile";
import { safeExternalUrl, safeAttachmentUrl, safeHtmlPreviewUrl } from "@/lib/safeExternalUrl";
import { extractYouTubeVideoId, getYouTubeEmbedUrl } from "@/lib/media/youtube";
import { looksLikeImageAttachment } from "@/lib/vault/attachmentType";
import {
  SIGNED_URL_TTL_SECONDS,
  writeCachedSignedUrl,
} from "@/lib/vault/signedUrlCache";
import {
  getAttachmentHeightClass,
  getYouTubeOffsetClass,
  isSupabaseStorageUrlText,
  isUniformVaultTileClass,
  isVoiceNoteCard,
  parseAttachmentNotes,
  parseStorageTarget,
  resolveStableTileHeight,
  sanitizeCardTitle,
  toNumber,
  vaultPdfEmbedUrl,
} from "@/lib/vault/vaultCardHelpers";

export function renderConnectorListCard(attachment, title, { expanded = false, compact = false } = {}) {
  const items = Array.isArray(attachment?.listItems) ? attachment.listItems : [];
  const siteLabel = attachment?.siteName || title || "Connected app";
  // Compact = grid / tags / type tiles: keep the list short so it fits a
  // square card instead of stretching the whole row.
  const maxItems = expanded ? items.length : compact ? 2 : 5;

  return (
    <div className={`rounded-2xl overflow-hidden glass-control h-full ${expanded ? "" : "cursor-pointer"}`}>
      <div className={`flex items-center gap-2 border-b border-black/8 dark:border-white/8 ${compact ? "px-2.5 py-1.5" : "px-3.5 py-2.5"}`}>
        {attachment?.favicon ? (
          <img
            src={attachment.favicon}
            alt=""
            className={`${compact ? "w-3.5 h-3.5" : "w-4 h-4"} shrink-0 object-contain`}
            draggable={false}
          />
        ) : (
          <Globe className={`${compact ? "w-3.5 h-3.5" : "w-4 h-4"} shrink-0 text-black/50 dark:text-white/50`} />
        )}
        <span className={`${compact ? "text-xs" : "text-sm"} font-medium text-black/80 dark:text-white/80 truncate`}>{siteLabel}</span>
        <span className={`ml-auto shrink-0 ${compact ? "text-[0.625rem]" : "text-[0.6875rem]"} text-black/45 dark:text-white/45`}>
          {items.length}
        </span>
      </div>
      <ul className={`divide-y divide-black/6 dark:divide-white/6 ${expanded ? "max-h-[70vh] overflow-y-auto scrollbar-hide" : "overflow-hidden"}`}>
        {items.slice(0, maxItems).map((item, index) => (
          <li key={`${item.label}-${index}`} className={compact ? "px-2.5 py-1" : "px-3.5 py-2.5"}>
            <div className={`${compact ? "text-[0.6875rem]" : "text-xs"} font-medium text-black/80 dark:text-white/80 truncate`}>{item.label}</div>
            {!compact && item.meta ? (
              <div className="text-[0.6875rem] text-black/50 dark:text-white/50 truncate mt-0.5">{item.meta}</div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function VaultPickerTapOverlay({ show }) {
  if (!show) return null;
  return (
    <div
      className="absolute inset-0 z-[130] cursor-pointer"
      aria-hidden
      data-vault-picker-overlay="true"
    />
  );
}

export function createRenderCollageCard(ctx) {
  const {
    addedCardIds,
    closeAttachmentNotes,
    draggedCardId,
    dropTargetCardId,
    handleCardDragStart,
    handleCardPress,
    initialCardIdsRef,
    isEmbeddedMode,
    isPickerMode,
    isSelectableCard,
    isVaultFirstPaintRef,
    isWakePreview,
    openAttachmentNotesCardId,
    openAttachmentNotesForAnchor,
    openCardMenuForAnchor,
    registerCardRef,
    renderAttachmentCard,
    selectedCardIds,
    vaultView,
    virtualizedCardStyle,
  } = ctx;

  // Single source of truth for a collage/grid card's JSX, so the masonry
  // columns and the grid/wake layouts render identical cards. Defined in
  // component scope (not module scope) so it closes over the drag handlers,
  // selection state, and render helpers it needs.
  const renderCollageCard = (card) => {
    const isSelected = selectedCardIds.has(card.id);
    const isAdded = isEmbeddedMode && !isPickerMode && addedCardIds.has(card.id);
    return (
                  <motion.article
                    initial={
                      isVaultFirstPaintRef.current || initialCardIdsRef.current?.has(card.id)
                        ? false
                        : { opacity: 0, scale: 0.97 }
                    }
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    key={card.id}
                    data-vault-card-id={card.id}
                    data-card-id={card.id}
                    ref={(el) => { if (card.kind === "attachment") registerCardRef(card.id, el); }}
                    draggable={false}
                    onDragStart={handleCardDragStart}
                    onClick={(e) => handleCardPress(e, card)}
                    // The card menu was previously reachable only from a ⋯
                    // button that no longer exists, so right-click is now how
                    // you get at project, tag, comment, and delete.
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openCardMenuForAnchor(card.id, e.currentTarget);
                    }}
                    // Browser-native off-screen culling for large vaults.
                    // While being dragged, opt OUT — `content-visibility:
                    // hidden` (which the browser applies under the hood
                    // for off-screen content) would clip the drag image
                    // mid-flight if we crossed the threshold during the
                    // drag. Currently-dragged card always paints.
                    style={
                      virtualizedCardStyle && draggedCardId !== card.id
                        ? virtualizedCardStyle
                        : undefined
                    }
                    className={`${vaultView === "grid" ? "" : "break-inside-avoid"} ${vaultView === "grid" ? "" : isEmbeddedMode ? "mb-2" : "mb-2"} rounded-2xl relative ${
                      card.kind === "chat-preview" ? "overflow-hidden" : vaultView === "grid" ? "overflow-hidden" : "overflow-visible"
                    } ${
                      card.kind === "attachment" || card.kind === "quick-note"
                        ? "bg-transparent border-0 shadow-none backdrop-blur-0"
                        : "glass-control"
                    } ${
                      draggedCardId === card.id
                        ? "opacity-30 cursor-grabbing ring-2 ring-blue-400/50"
                        : "cursor-pointer"
                    } ${dropTargetCardId === card.id && draggedCardId !== card.id ? "ring-2 ring-blue-400/40" : ""} ${
                      isSelected ? "ring-2 ring-blue-500 ring-offset-2 ring-offset-transparent" : ""
                    } ${
                      isAdded ? "ring-2 ring-emerald-500 ring-offset-2 ring-offset-transparent" : ""
                    } ${
                      card.kind === "attachment" && card.type === "youtube"
                        ? getYouTubeOffsetClass(card.id)
                        : ""
                    } ${
                      openAttachmentNotesCardId === card.id
                        ? "z-[310]"
                        : "z-0"
                    }`}
                  >
                    {isSelected && (
                      <span
                        data-no-preview="true"
                        className="absolute top-2 right-2 z-[120] w-5 h-5 rounded-full bg-blue-500 text-white flex items-center justify-center shadow-md pointer-events-none"
                      >
                        <Check className="w-3 h-3" strokeWidth={3} />
                      </span>
                    )}
                    {isAdded && !isSelected && (
                      <span
                        data-no-preview="true"
                        className="absolute top-2 right-2 z-[120] inline-flex items-center gap-1 rounded-full bg-emerald-500 text-white text-[0.625rem] font-semibold pl-1 pr-2 py-0.5 shadow-md pointer-events-none"
                      >
                        <Check className="w-3 h-3" strokeWidth={3} />
                        Added
                      </span>
                    )}
                    {card.isDemo && !isWakePreview && (
                      <span className="absolute top-2 left-2 z-[120] rounded-full bg-black/45 text-white/95 text-[0.625rem] font-medium px-2 py-0.5 backdrop-blur-sm pointer-events-none">
                        Sample
                      </span>
                    )}
                    {card.kind === "source-folder" ? (
                      <SourceFolderTile
                        card={card}
                        heightClass={vaultView === "grid" ? "aspect-square w-full" : "h-44"}
                      />
                    ) : card.kind === "attachment" ? (
                      <>
                        {renderAttachmentCard(
                          card,
                          vaultView === "grid" ? "aspect-square w-full" : getAttachmentHeightClass(card),
                        )}
                        {parseAttachmentNotes(card.attachment).length > 0 && (
                          <button
                            type="button"
                            data-vault-popover-trigger=""
                            data-no-drag="true"
                            draggable={false}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (openAttachmentNotesCardId === card.id) {
                                closeAttachmentNotes();
                              } else {
                                openAttachmentNotesForAnchor(card.id, e.currentTarget);
                              }
                            }}
                            className={`absolute top-2 ${
                              // Shift left when a selection check / "Added" pill
                              // occupies the top-right corner so both stay visible.
                              isAdded && !isSelected ? "right-20" : isSelected ? "right-9" : "right-2"
                            } h-6 min-w-6 px-1.5 rounded-full bg-white/45 backdrop-blur-sm border border-white/30 text-[0.6875rem] font-semibold text-black flex items-center justify-center gap-1 z-[125] shadow-sm`}
                            title="View comments"
                          >
                            <MessageCircle className="w-3 h-3 text-black" />
                            <span>{parseAttachmentNotes(card.attachment).length}</span>
                          </button>
                        )}
                      </>
                    ) : card.kind === "chat-preview" ? (
                      <div className={`p-4 space-y-3 ${vaultView === "grid" ? "aspect-square w-full overflow-hidden" : ""}`}>
                        <div className="flex items-center justify-between">
                          <h2 className="text-sm font-semibold text-black/90 dark:text-white/90 truncate">{card.title}</h2>
                          <span className="text-[0.6875rem] text-black/60 dark:text-white/60">{card.turnsCount} turns</span>
                        </div>
                        <div className="rounded-xl bg-white/40 border border-white/45 px-3 py-2">
                          <p className={`text-[0.75rem] text-black/80 dark:text-white/80 ${vaultView === "grid" ? "line-clamp-2" : "line-clamp-3"}`}>{card.question}</p>
                        </div>
                        {card.answer && vaultView !== "grid" && (
                          <div className="rounded-xl bg-black/10 border border-white/30 px-3 py-2">
                            <p className="text-[0.75rem] text-black/75 dark:text-white/75 line-clamp-4">{card.answer}</p>
                          </div>
                        )}
                        {vaultView !== "grid" && (
                        <div className="text-[0.6875rem] text-black/55 dark:text-white/55 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          <span>{card.dateLabel}</span>
                        </div>
                        )}
                      </div>
                    ) : (
                      <>
                        <div className={`glass-control rounded-2xl p-4 relative ${vaultView === "grid" ? "aspect-square w-full overflow-hidden" : ""}`}>
                          <div className="flex items-center gap-2 text-black/70 dark:text-white/70 mb-2">
                            {card.noteStyle === "meeting" ? (
                              <CalendarDays className="w-4 h-4" />
                            ) : card.noteStyle === "task" ? (
                              <ListTodo className="w-4 h-4" />
                            ) : (
                              <StickyNote className="w-4 h-4" />
                            )}
                            <span className="text-xs font-medium">{card.label || "Quick Note"}</span>
                          </div>
                          {card.title && card.noteStyle && card.noteStyle !== "quick" ? (
                            <p className="text-sm font-semibold text-black/80 dark:text-white/80 truncate mb-1.5">{card.title}</p>
                          ) : null}
                          <div className={vaultView === "grid" ? "overflow-hidden" : "max-h-56 overflow-y-auto scrollbar-hide"}>
                            <p className={`text-sm text-black/70 dark:text-white/70 whitespace-pre-wrap break-words ${vaultView === "grid" ? "line-clamp-5" : ""}`}>{card.excerpt}</p>
                          </div>
                          <div className="mt-3 text-[0.6875rem] text-black/55 dark:text-white/55 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            <span>{card.dateLabel}</span>
                          </div>
                          {(card.comments?.length || 0) > 0 && (
                            <button
                              type="button"
                              data-vault-popover-trigger=""
                              data-no-drag="true"
                              draggable={false}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (openAttachmentNotesCardId === card.id) {
                                  closeAttachmentNotes();
                                } else {
                                  openAttachmentNotesForAnchor(card.id, e.currentTarget);
                                }
                              }}
                              className="absolute top-2 right-2 h-6 min-w-6 px-1.5 rounded-full bg-white/45 backdrop-blur-sm border border-white/30 text-[0.6875rem] font-semibold text-black flex items-center justify-center gap-1 z-[125] shadow-sm"
                              title="View comments"
                            >
                              <MessageCircle className="w-3 h-3 text-black" />
                              <span>{card.comments.length}</span>
                            </button>
                          )}
                        </div>
                      </>
                    )}
                    <VaultPickerTapOverlay
                      show={isPickerMode && isSelectableCard(card)}
                    />
                  </motion.article>
    );
  };

  // ── Off-screen card culling (browser-native virtualization) ──
  //
  // Above ~80 cards on screen, paint/layout cost gets noticeable: every
  // card mounts framer-motion, runs the URL resolver IO, renders an
  // image/video, etc. Rather than swap the whole grid out for a
  // react-window/react-virtual rewrite — which would break drag-and-drop,
  // masonry/columns layout, and the existing ordering refs — we lean on
  // CSS `content-visibility: auto`. The browser then:
  //   * still places the element in layout (so masonry / grid math is
  //     correct, drag targets stay clickable, IntersectionObservers fire),
  //   * but skips painting + descendant rendering until the element
  //     enters the viewport.
  //
  // `contain-intrinsic-size` gives the browser a stable size estimate
  // before paint, so scrollbar height and scroll position stay sane.
  // The estimates differ per view mode:
  //   * grid: aspect-square cards at our typical column width (~200px),
  //     plus a small action footer → ~280–300px tall slot.
  //   * collage / masonry / tags: variable height, lean a little taller
  //     to avoid scroll jumps when off-screen cards repaint shorter than
  //     estimated. Browser corrects on first real layout.
  //
  // We deliberately gate on a count threshold so small vaults pay zero
  // cost — `content-visibility` adds layout containment which can change
  // a few subtle behaviors (printing, find-in-page focus order), and
  // there's no upside on a 12-card vault.
  // ── Off-screen card culling — currently DISABLED ──
  //
  // We previously gated `content-visibility: auto` +
  // `contain-intrinsic-size` on cards once the rendered count crossed
  // a threshold. In theory this gives free browser-native virtualization;
  // in practice the `contain-intrinsic-size` estimate is necessarily
  // a guess (cards are variable height in masonry/collage and even
  // grid mode varies with content), so the FIRST time each card was
  // revealed during scroll its real layout differed from the estimate
  // and shoved every other card up or down. The `auto` keyword in
  // `contain-intrinsic-size` only helps on subsequent reveals, not the
  // first one — and "first scroll-down through a vault" is exactly when
  // glitching is most visible to users.
  //
  // The aspect-ratio fix on the image wrapper (see `renderAttachmentCard`
  // image branch: `learnedImageDimsRef` + `aspectRatio` style) already
  // gives us the layout-stability win this was meant to enable, without
  // the per-reveal intrinsic-size mismatch problem. We can re-introduce
  // a real virtualization layer (react-virtual etc.) later if profiling

  return renderCollageCard;
}

export function createRenderAttachmentCard(ctx) {
  const {
    drainUrlResolveQueue,
    failedImageIds,
    imageRetryCountsRef,
    isEmbeddedMode,
    isMountedRef,
    isPickerMode,
    isVaultFirstPaintRef,
    isWakePreview,
    learnedImageDimsRef,
    preDecodedUrlsRef,
    queuePersistAttachmentDims,
    resolvedAttachmentUrls,
    resolvedVideoPosterUrls,
    setFailedImageIds,
    setResolvedAttachmentUrls,
    signedUrlCacheRef,
    urlResolveQueueRef,
    visibleCardIdsRef,
  } = ctx;

  const renderAttachmentCard = (card, tileHeightClass) => {
    const { attachment, title } = card;
    let type = card.type;
    if (type === "file" || type === "bookmark" || type === "link") {
      if (looksLikeImageAttachment(attachment || {})) type = "image";
    }
    // Never paint an expired/raw storage URL into an <img> — wait for a
    // freshly signed URL from the resolver instead.
    const rawAttUrl = String(attachment?.url || "");
    const resolvedUrl =
      resolvedAttachmentUrls[card.id] ||
      (isSupabaseStorageUrlText(rawAttUrl) ? "" : rawAttUrl);
    const wakeDemoCard = isWakePreview && card.isDemo;
    const stableTileHeight = resolveStableTileHeight(card, tileHeightClass);
    // Grid/tags/type views pass a single fixed / square class and expect
    // uniform tiles. The collage passes responsive bucketed classes.
    // When the tile is uniform, keep that size instead of switching to the
    // media's real aspect-ratio — otherwise a portrait image (or a long
    // connector bookmark card) stretches its whole grid row.
    const uniformTile = isUniformVaultTileClass(tileHeightClass);

    // Ghost cards represent uploads still in flight. We render the local
    // blob preview directly — no signed-URL resolver, no retry logic —
    // so the file is immediately usable as if it were already a normal
    // embedded video / image.
    //
    // Intentionally NO compression chrome in the grid: no progress bar,
    // no "Compressing…" label, no overlays. The only place the user sees
    // upload / compression state is the global upload toast. Once the
    // pipeline finishes, `onFileComplete` swaps this for the real
    // DB-backed card transparently.
    if (card.ghost) {
      if (type === "video") {
        return (
          <video
            className="w-full h-auto max-h-[42rem] rounded-2xl bg-black/10"
            autoPlay
            muted
            loop
            playsInline
            controls
            preload="auto"
            draggable={false}
            src={attachment.url}
          />
        );
      }
      return (
        <img
          src={attachment.url}
          alt={title}
          className="w-full h-auto max-h-[42rem] rounded-2xl"
          draggable={false}
        />
      );
    }

    if (type === "image") {
      const storageTarget = parseStorageTarget(attachment || {});
      const isStorageBacked = !!(storageTarget?.bucket && storageTarget?.path);
      const hasResolvedUrl = !!resolvedAttachmentUrls[card.id];
      const hasFailed = failedImageIds.has(card.id);

      // Compute the reserved aspect ratio BEFORE the skeleton/failed returns
      // so the placeholder, the loaded image, and the error state all occupy
      // the SAME height. Previously the skeleton used a fixed `stableTileHeight`
      // and the loaded image switched to its real `aspectRatio`, so every
      // async signed-URL resolve changed a card's height — and in the CSS
      // multi-column collage that rebalances all columns, throwing cards in
      // and out of order as they load (and again as more resolve on scroll).
      const learnedDims = resolvedUrl ? learnedImageDimsRef.current.get(resolvedUrl) : null;
      const metaW =
        toNumber(attachment.width) ??
        toNumber(attachment.imageWidth) ??
        toNumber(attachment.metadata?.width) ??
        toNumber(attachment.metadata?.imageWidth);
      const metaH =
        toNumber(attachment.height) ??
        toNumber(attachment.imageHeight) ??
        toNumber(attachment.metadata?.height) ??
        toNumber(attachment.metadata?.imageHeight);
      const reservedW = metaW || learnedDims?.w || null;
      const reservedH = metaH || learnedDims?.h || null;
      const hasReservedAspect = !!(reservedW && reservedH && reservedW > 0 && reservedH > 0);
      const reservedAspectStyle = hasReservedAspect && !uniformTile
        ? { aspectRatio: `${reservedW} / ${reservedH}` }
        : undefined;
      const reservedHeightClass = uniformTile
        ? tileHeightClass
        : hasReservedAspect
          ? ""
          : stableTileHeight;

      if (isStorageBacked && !hasResolvedUrl && !hasFailed) {
        return (
          <div
            className={`w-full ${reservedHeightClass} rounded-2xl bg-white/5 animate-pulse flex items-center justify-center`}
            style={reservedAspectStyle}
          >
            <Loader2 className="w-6 h-6 text-white/20 animate-spin" />
          </div>
        );
      }

      if (hasFailed) {
        const failedLabel = sanitizeCardTitle(title || attachment.name || "", "Image");
        const canRetry =
          isStorageBacked ||
          isSupabaseStorageUrlText(attachment.url || resolvedUrl || "");
        return (
          <div
            className={`w-full ${reservedHeightClass} rounded-2xl bg-black/5 dark:bg-white/5 flex flex-col items-center justify-center gap-2 px-3`}
            style={reservedAspectStyle}
          >
            <FileText className="w-8 h-8 text-black/20 dark:text-white/20" />
            <span className="text-xs text-black/40 dark:text-white/40 text-center truncate max-w-full">{failedLabel}</span>
            {canRetry && (
              <button
                type="button"
                className="text-[0.625rem] font-medium text-blue-500 hover:text-blue-600 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  imageRetryCountsRef.current.delete(card.id);
                  setFailedImageIds((prev) => { const next = new Set(prev); next.delete(card.id); return next; });
                  const retryTarget = parseStorageTarget(attachment || {}) || storageTarget;
                  if (retryTarget?.bucket && retryTarget?.path) {
                    signedUrlCacheRef.current.delete(`${retryTarget.bucket}:${retryTarget.path}`);
                  }
                  setResolvedAttachmentUrls((prev) => { const next = { ...prev }; delete next[card.id]; return next; });
                  visibleCardIdsRef.current.delete(card.id);
                  urlResolveQueueRef.current.push(card);
                  drainUrlResolveQueue();
                }}
              >
                Try again
              </button>
            )}
          </div>
        );
      }

      // Pre-decoded above-fold images skip the per-image opacity
      // fade-in. Their bitmap is already on the GPU thanks to the
      // preload step (see `preDecodedUrlsRef` above), so painting them
      // synchronously avoids the cascading "popcorn" reveal where each
      // card's fade kicks off on a different frame.
      //
      // For below-the-fold images we now use a *short* (150ms) fade
      // instead of the previous 300ms. The longer fade was the source
      // of the visible "scroll glitch" — when several cards scrolled
      // into view at roughly the same time, each one started its
      // 300ms opacity transition on a slightly different frame, which
      // looks staggered/jittery to the eye. 150ms is short enough to
      // read as "just appeared" while still hiding the brief frame
      // between mount and paint, and uses the standard Tailwind scale
      // so it doesn't trip the ambiguous-arbitrary-value warning.
      const isPreDecoded =
        wakeDemoCard || (!!resolvedUrl && preDecodedUrlsRef.current.has(resolvedUrl));
      const skipEntryFade = isVaultFirstPaintRef.current || isPreDecoded || wakeDemoCard;

      // Aspect-ratio reservation (`reservedW`/`reservedH`/`hasReservedAspect`)
      // is computed once at the top of the image branch so the skeleton,
      // loaded image, and error state share one reserved height. Setting the
      // `width` + `height` HTML attributes (modern browsers' "aspect ratio
      // mapping") tells the browser to reserve the correct slot BEFORE the
      // image loads, eliminating the layout shift that caused cards to "shift
      // and move and cut up and down" on first scroll.

      return (
        <div
          className={`w-full rounded-2xl bg-black/[0.02] dark:bg-white/[0.02] flex items-center justify-center overflow-hidden ${reservedHeightClass}`}
          style={reservedAspectStyle}
        >
        <img
          key={resolvedUrl}
          src={resolvedUrl}
          alt={title}
          // Width/height HTML attributes are critical here — even
          // though CSS overrides the visual size, the browser uses
          // the ratio of these two numbers to reserve aspect-ratio
          // space. This is the modern (Chrome 79+, Firefox 71+,
          // Safari 14+) "aspect ratio mapping" feature.
          {...(hasReservedAspect ? { width: reservedW, height: reservedH } : {})}
          className={
            skipEntryFade
              ? `${uniformTile ? "w-full h-full object-cover" : "max-w-full max-h-full w-auto h-auto object-contain"} rounded-2xl`
              : `${uniformTile ? "w-full h-full object-cover" : "max-w-full max-h-full w-auto h-auto object-contain"} rounded-2xl opacity-0 transition-opacity duration-150 ease-out`
          }
          loading={skipEntryFade ? "eager" : "lazy"}
          decoding={skipEntryFade ? "sync" : "async"}
          draggable={false}
          onLoad={(e) => {
            // Cache the actual natural dims so the next time this
            // URL renders (e.g. after content-visibility culls and
            // re-reveals on scroll-back), we can reserve the right
            // slot from the start. No-op if we already had metadata.
            const nw = e.currentTarget.naturalWidth;
            const nh = e.currentTarget.naturalHeight;
            if (resolvedUrl && nw > 0 && nh > 0 && !learnedImageDimsRef.current.has(resolvedUrl)) {
              learnedImageDimsRef.current.set(resolvedUrl, { w: nw, h: nh });
            }
            // Persist these dims back to the note so this (legacy, dim-less)
            // image reserves its true aspect on every future load — no more
            // column shift when it resolves. No-op for items that already
            // have stored dims.
            queuePersistAttachmentDims(card, nw, nh);
            // Reset the retry budget on success. Without this, a card
            // that briefly fails (expired URL → fresh URL → success)
            // permanently keeps a shrunken retry budget, so the next
            // failure days later has fewer attempts before giving up.
            imageRetryCountsRef.current.delete(card.id);
            e.currentTarget.style.opacity = "1";
            const wrapper = e.currentTarget.parentElement;
            if (wrapper) { wrapper.style.minHeight = "0"; wrapper.style.background = "transparent"; }
          }}
          onError={() => {
            const retryCount = imageRetryCountsRef.current.get(card.id) || 0;
            if (retryCount < 2) {
              imageRetryCountsRef.current.set(card.id, retryCount + 1);
              const target = parseStorageTarget(attachment || {});
              if (target?.bucket && target?.path) {
                const cacheKey = `${target.bucket}:${target.path}`;
                signedUrlCacheRef.current.delete(cacheKey);
                const delay = (retryCount + 1) * 800;
                setTimeout(async () => {
                  // Guard against the component unmounting between
                  // the failed image load and this retry tick — without
                  // it we'd setState on a torn-down tree and warm
                  // closures into the long-lived image cache.
                  if (!isMountedRef.current) return;
                  try {
                    const { data } = await supabase.storage
                      .from(target.bucket)
                      .createSignedUrl(target.path, SIGNED_URL_TTL_SECONDS);
                    if (data?.signedUrl) {
                      writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, data.signedUrl);
                      if (!isMountedRef.current) return;
                      setResolvedAttachmentUrls((prev) => ({ ...prev, [card.id]: data.signedUrl }));
                      return;
                    }
                  } catch { /* fall through to server fallback */ }
                  try {
                    const { API_BASE_URL } = await import("@/lib/api-config");
                    const session = (await supabase.auth.getSession())?.data?.session;
                    const token = session?.access_token;
                    if (token) {
                      const resp = await fetch(`${API_BASE_URL}/api/storage/signed-url`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                        body: JSON.stringify({ storagePath: target.path, bucket: target.bucket }),
                      });
                      if (resp.ok) {
                        const { signedUrl } = await resp.json();
                        if (signedUrl) {
                          writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, signedUrl);
                          setResolvedAttachmentUrls((prev) => ({ ...prev, [card.id]: signedUrl }));
                          return;
                        }
                      }
                    }
                  } catch { /* exhausted */ }
                  setFailedImageIds((prev) => new Set(prev).add(card.id));
                }, delay);
              } else {
                setFailedImageIds((prev) => new Set(prev).add(card.id));
              }
            } else {
              setFailedImageIds((prev) => new Set(prev).add(card.id));
            }
          }}
        />
        </div>
      );
    }

    if (type === "video") {
      const videoMime = attachment.mimeType || "video/mp4";
      const videoStorageTarget = parseStorageTarget(attachment || {});
      const videoIsStorageBacked = !!(videoStorageTarget?.bucket && videoStorageTarget?.path);

      // Reserve the video's aspect ratio (same approach as images) so the
      // tile is exactly as tall as the frame from the FIRST paint — the old
      // fixed-height box came from a coarse height bucket that rarely matched
      // the real shape, leaving dead letterbox space. Videos don't carry
      // stored dimensions, so when the real shape is unknown we reserve a
      // 16:9 slot (the overwhelming majority of uploads); `onLoadedMetadata`
      // only nudges the rare non-16:9 clip. Computed before the loading
      // skeleton so the skeleton and the loaded video share one slot and the
      // tile never jumps as the URL resolves / scrolls in.
      const learnedVideoDims = resolvedUrl ? learnedImageDimsRef.current.get(resolvedUrl) : null;
      const reservedVW =
        toNumber(attachment.videoWidth) ??
        toNumber(attachment.width) ??
        toNumber(attachment.metadata?.videoWidth) ??
        toNumber(attachment.metadata?.width) ??
        learnedVideoDims?.w ??
        null;
      const reservedVH =
        toNumber(attachment.videoHeight) ??
        toNumber(attachment.height) ??
        toNumber(attachment.metadata?.videoHeight) ??
        toNumber(attachment.metadata?.height) ??
        learnedVideoDims?.h ??
        null;
      const hasReservedVideoAspect = !!(reservedVW && reservedVH && reservedVW > 0 && reservedVH > 0);
      const videoAspect = hasReservedVideoAspect ? `${reservedVW} / ${reservedVH}` : "16 / 9";
      const videoPosterUrl = resolvedVideoPosterUrls[card.id] || undefined;
      const videoHasFailed = failedImageIds.has(card.id);

      // Don't skeleton-spin a card we've already given up on — fall through to
      // the failed state below. Without the `!videoHasFailed` guard a video
      // whose object is missing (re-sign returns 400, or the object 404s) sat
      // in this <Loader2> skeleton forever; the image branch has had a failed
      // state for ages, this mirrors it.
      if (videoIsStorageBacked && !resolvedAttachmentUrls[card.id] && !videoHasFailed) {
        return (
          <div
            className={`w-full ${uniformTile ? tileHeightClass : ""} rounded-2xl bg-black/10 animate-pulse flex items-center justify-center`}
            style={uniformTile ? undefined : { aspectRatio: videoAspect }}
          >
            <Loader2 className="w-6 h-6 text-white/20 animate-spin" />
          </div>
        );
      }

      // Failed state — mirrors the image branch (same visual + "Try again"
      // reset handler). Reserves the same aspect ratio so the tile doesn't jump
      // when it flips between skeleton / failed / loaded.
      if (videoHasFailed) {
        return (
          <div
            className={`w-full ${uniformTile ? tileHeightClass : ""} rounded-2xl bg-black/5 dark:bg-white/5 flex flex-col items-center justify-center gap-2 px-3`}
            style={uniformTile ? undefined : { aspectRatio: videoAspect }}
          >
            <FileText className="w-8 h-8 text-black/20 dark:text-white/20" />
            <span className="text-xs text-black/40 dark:text-white/40 text-center truncate max-w-full">{title}</span>
            {videoIsStorageBacked && (
              <button
                type="button"
                className="text-[0.625rem] font-medium text-blue-500 hover:text-blue-600 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  imageRetryCountsRef.current.delete(card.id);
                  setFailedImageIds((prev) => { const next = new Set(prev); next.delete(card.id); return next; });
                  signedUrlCacheRef.current.delete(`${videoStorageTarget?.bucket || "user-files"}:${videoStorageTarget?.path || ""}`);
                  setResolvedAttachmentUrls((prev) => { const next = { ...prev }; delete next[card.id]; return next; });
                  visibleCardIdsRef.current.delete(card.id);
                  urlResolveQueueRef.current.push(card);
                  drainUrlResolveQueue();
                }}
              >
                Try again
              </button>
            )}
          </div>
        );
      }

      // When we have a poster frame, paint immediately — the poster image is
      // already a real frame, so there's no black flash to hide behind a fade.
      const skipVideoFade = isVaultFirstPaintRef.current || wakeDemoCard || !!videoPosterUrl;

      return (
        <div
          className={`w-full ${uniformTile ? tileHeightClass : ""} rounded-2xl bg-black/[0.02] dark:bg-white/[0.02] pointer-events-none flex items-center justify-center overflow-hidden`}
          style={uniformTile ? undefined : { aspectRatio: videoAspect }}
        >
          <video
            key={resolvedUrl}
            className={`max-w-full max-h-full w-auto h-auto object-contain rounded-2xl bg-black/10 ${
              skipVideoFade ? "" : "opacity-0 transition-opacity duration-150 ease-out"
            }`}
            // No native controls on grid tiles: the wrapper is
            // pointer-events-none (click opens the preview modal), so the
            // controls rendered but never responded — reading as broken.
            playsInline
            preload="metadata"
            poster={videoPosterUrl}
            draggable={false}
            muted={isPickerMode}
            onLoadedMetadata={(e) => {
              // Videos often have no width/height stored at upload time, so
              // learn the real frame dims here and collapse the tile to the
              // exact aspect ratio right away (inline style beats the fixed
              // Tailwind height class, including its responsive variants).
              const vw = e.currentTarget.videoWidth;
              const vh = e.currentTarget.videoHeight;
              if (vw > 0 && vh > 0) {
                if (resolvedUrl && !learnedImageDimsRef.current.has(resolvedUrl)) {
                  learnedImageDimsRef.current.set(resolvedUrl, { w: vw, h: vh });
                }
                // Uniform tiles (grid/tags/type views) keep their fixed
                // height — resizing to the real aspect here would make the
                // row ragged again.
                const wrapper = e.currentTarget.parentElement;
                if (wrapper && !uniformTile) {
                  wrapper.style.aspectRatio = `${vw} / ${vh}`;
                  wrapper.style.height = "auto";
                }
                // Persist so this legacy video reserves its true aspect on
                // every future load instead of falling back to 16/9.
                queuePersistAttachmentDims(card, vw, vh);
              }
            }}
            onLoadedData={(e) => {
              // Reset the retry budget on success (parity with the image
              // branch) so a clip that briefly failed then recovered keeps a
              // full budget for any future failure.
              imageRetryCountsRef.current.delete(card.id);
              e.currentTarget.style.opacity = "1";
              const wrapper = e.currentTarget.parentElement;
              if (wrapper) { wrapper.style.minHeight = "0"; wrapper.style.background = "transparent"; }
            }}
            // A URL that resolves but then fails to LOAD (object deleted /
            // undecodable) used to leave an invisible opacity-0 box. Mirror the
            // image branch: re-sign + retry a couple of times, then flip the
            // card into the failed state so it shows the "Try again" tile.
            onError={() => {
              const retryCount = imageRetryCountsRef.current.get(card.id) || 0;
              if (retryCount < 2 && videoStorageTarget?.bucket && videoStorageTarget?.path) {
                imageRetryCountsRef.current.set(card.id, retryCount + 1);
                const cacheKey = `${videoStorageTarget.bucket}:${videoStorageTarget.path}`;
                signedUrlCacheRef.current.delete(cacheKey);
                const delay = (retryCount + 1) * 800;
                setTimeout(async () => {
                  if (!isMountedRef.current) return;
                  try {
                    const { data } = await supabase.storage
                      .from(videoStorageTarget.bucket)
                      .createSignedUrl(videoStorageTarget.path, SIGNED_URL_TTL_SECONDS);
                    if (data?.signedUrl) {
                      writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, data.signedUrl);
                      if (!isMountedRef.current) return;
                      setResolvedAttachmentUrls((prev) => ({ ...prev, [card.id]: data.signedUrl }));
                      return;
                    }
                  } catch { /* fall through to server fallback */ }
                  try {
                    const { API_BASE_URL } = await import("@/lib/api-config");
                    const session = (await supabase.auth.getSession())?.data?.session;
                    const token = session?.access_token;
                    if (token) {
                      const resp = await fetch(`${API_BASE_URL}/api/storage/signed-url`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                        body: JSON.stringify({ storagePath: videoStorageTarget.path, bucket: videoStorageTarget.bucket }),
                      });
                      if (resp.ok) {
                        const { signedUrl } = await resp.json();
                        if (signedUrl) {
                          writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, signedUrl);
                          if (!isMountedRef.current) return;
                          setResolvedAttachmentUrls((prev) => ({ ...prev, [card.id]: signedUrl }));
                          return;
                        }
                      }
                    }
                  } catch { /* exhausted */ }
                  if (!isMountedRef.current) return;
                  setFailedImageIds((prev) => new Set(prev).add(card.id));
                }, delay);
              } else {
                setFailedImageIds((prev) => new Set(prev).add(card.id));
              }
            }}
          >
            <source
              src={resolvedUrl}
              type={videoMime}
              onError={() => {
                // A failing <source> only bubbles to <video> error when ALL
                // sources fail; with a single source this is the reliable
                // signal, so flip straight to the failed state.
                setFailedImageIds((prev) => new Set(prev).add(card.id));
              }}
            />
          </video>
        </div>
      );
    }

    if (type === "audio") {
      const voiceNote = isVoiceNoteCard(card);
      return (
        <div className="p-3 space-y-3 rounded-2xl">
          <div className="flex items-center gap-2 text-black/80 dark:text-white/80">
            {voiceNote ? <Mic className="w-4 h-4" /> : <Music className="w-4 h-4" />}
            <span className="text-xs font-medium truncate">{title}</span>
          </div>
          {/* No native controls: the element is pointer-events-none (click
              opens the preview modal, which has a working player), so the
              controls rendered but never responded. */}
          <audio src={resolvedUrl} className="w-full h-10 pointer-events-none" preload="metadata" />
        </div>
      );
    }

    if (type === "pdf") {
      const fileName = attachment.name || title || "PDF";
      const embedUrl = vaultPdfEmbedUrl(resolvedUrl);
      return (
        <div className="rounded-2xl overflow-hidden glass-control cursor-pointer">
          <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-black/8 dark:border-white/8 pointer-events-none">
            <FileText className="w-4 h-4 text-red-500 shrink-0" />
            <span className="text-sm font-medium text-black/80 dark:text-white/80 truncate">{fileName}</span>
          </div>
          <div className={`w-full ${tileHeightClass} overflow-hidden bg-white dark:bg-[#f4f4f4]`}>
            <iframe
              src={embedUrl}
              title={title || "PDF preview"}
              className="w-full h-full border-0 opacity-0 transition-opacity duration-150 ease-out pointer-events-none"
              draggable={false}
              onLoad={(e) => { e.currentTarget.style.opacity = "1"; }}
            />
          </div>
        </div>
      );
    }

    if (type === "html") {
      const fileName = attachment.name || title || "Interactive artifact";
      // Prefer the freshly minted file-proxy URL; never paint a raw Supabase
      // storage URL into the iframe (wrong MIME / CSP → permanent blank).
      const storageTarget = parseStorageTarget(attachment || {});
      const isStorageBacked = !!(storageTarget?.bucket && storageTarget?.path);
      const candidate =
        resolvedAttachmentUrls[card.id] || (!isStorageBacked ? resolvedUrl : "");
      const htmlPreview = /supabase\.co\/storage\//i.test(candidate || "")
        ? null
        : safeHtmlPreviewUrl(candidate);
      const htmlFailed = failedImageIds.has(card.id);
      return (
        <div className="rounded-2xl overflow-hidden glass-control cursor-pointer">
          <div className={`w-full ${tileHeightClass} overflow-hidden bg-[#15130f]`}>
            {htmlPreview ? (
              <iframe
                src={htmlPreview.url}
                title={title || "Artifact preview"}
                className="w-full h-full border-0 pointer-events-none"
                sandbox={htmlPreview.sandbox}
                loading="lazy"
                referrerPolicy="no-referrer"
                draggable={false}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xs text-white/45">
                {htmlFailed ? "Preview unavailable" : "Loading preview…"}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 px-3.5 py-2.5 border-t border-black/8 dark:border-white/8 pointer-events-none">
            <FileText className="w-4 h-4 text-blue-500 shrink-0" />
            <div className="min-w-0">
              <span className="block text-sm font-medium text-black/80 dark:text-white/80 truncate">{fileName}</span>
              <span className="block text-[0.625rem] text-black/45 dark:text-white/45">Interactive preview</span>
            </div>
          </div>
        </div>
      );
    }

    if (type === "instagram" || type === "tiktok" || type === "facebook") {
      const socialOembedHtml = String(attachment.oembedHtml || "");
      const socialUrl = String(attachment.url || resolvedUrl || "");
      return (
        <div className={`w-full ${tileHeightClass} rounded-2xl overflow-hidden`} draggable={false}>
          <SocialEmbedInline
            platform={type}
            oembedHtml={socialOembedHtml}
            url={socialUrl}
            thumbnailUrl={attachment.image || attachment.thumbnail_url || ""}
            title={attachment.title || title || ""}
            authorName={attachment.authorName || ""}
            authorHandle={attachment.authorHandle || ""}
            compact={isEmbeddedMode || isPickerMode}
          />
        </div>
      );
    }

    if (type === "youtube") {
      const videoId = extractYouTubeVideoId(String(attachment.url || "")) || String(attachment.videoId || "").trim() || null;
      const embedUrl = videoId ? getYouTubeEmbedUrl(videoId) : "";
      const customThumb = String(attachment.image || attachment.thumbnail_url || "").trim();

      if ((isEmbeddedMode || isWakePreview || isPickerMode) && (customThumb || videoId)) {
        const thumbUrl = customThumb || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        return (
          <div className={`w-full ${tileHeightClass} rounded-2xl overflow-hidden bg-black relative`} draggable={false}>
            <img
              src={thumbUrl}
              alt={title || "YouTube Video"}
              className="w-full h-full object-cover"
              draggable={false}
            />
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-14 h-10 bg-red-600 rounded-xl flex items-center justify-center shadow-lg">
                <svg viewBox="0 0 24 24" fill="white" className="w-6 h-6 ml-0.5"><polygon points="8,5 20,12 8,19" /></svg>
              </div>
            </div>
          </div>
        );
      }

      if (!embedUrl) {
        const linkBody = (
          <div className="flex items-start gap-2 h-full">
            <Video className="w-4 h-4 mt-0.5" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-black/85 dark:text-white/85 truncate">{title}</p>
              <p className="text-[0.6875rem] text-black/55 dark:text-white/55 mt-1 truncate">YouTube video</p>
            </div>
          </div>
        );
        if (isPickerMode) {
          return (
            <div className={`block p-4 rounded-2xl ${tileHeightClass} pointer-events-none`} draggable={false}>
              {linkBody}
            </div>
          );
        }
        return (
          <a
            href={safeExternalUrl(attachment.url) || undefined}
            target="_blank"
            rel="noreferrer"
            className={`block p-4 hover:bg-black/5 transition rounded-2xl ${tileHeightClass}`}
            title="Open YouTube video"
            draggable={false}
          >
            {linkBody}
          </a>
        );
      }

      if (isPickerMode && videoId) {
        const thumbUrl = customThumb || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        return (
          <div className={`w-full ${tileHeightClass} rounded-2xl overflow-hidden bg-black relative pointer-events-none`} draggable={false}>
            <img
              src={thumbUrl}
              alt={title || "YouTube Video"}
              className="w-full h-full object-cover"
              draggable={false}
            />
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-14 h-10 bg-red-600 rounded-xl flex items-center justify-center shadow-lg">
                <svg viewBox="0 0 24 24" fill="white" className="w-6 h-6 ml-0.5"><polygon points="8,5 20,12 8,19" /></svg>
              </div>
            </div>
          </div>
        );
      }

      return (
        <div className={`w-full ${tileHeightClass} rounded-2xl overflow-hidden bg-black pointer-events-none`} draggable={false}>
          <iframe
            src={embedUrl}
            title={title || "YouTube video"}
            className="w-full h-full border-0 pointer-events-none"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        </div>
      );
    }

    if (type === "bookmark") {
      if (attachment.connectorList && Array.isArray(attachment.listItems)) {
        const listCard = renderConnectorListCard(attachment, title, {
          compact: isWakePreview || uniformTile,
        });
        if (uniformTile) {
          return (
            <div className={`w-full ${tileHeightClass} overflow-hidden rounded-2xl`}>
              {listCard}
            </div>
          );
        }
        return listCard;
      }
      const linkUrl = attachment.url || resolvedUrl || "";
      // Never paint a Supabase storage URL as a "link" card — that used to
      // dump the signed URL into the tile when an image lost its type.
      if (
        isSupabaseStorageUrlText(linkUrl) ||
        attachment.storagePath ||
        attachment.storage_path ||
        attachment.variantMediumPath ||
        looksLikeImageAttachment(attachment)
      ) {
        // Recover as an image tile when possible; otherwise a neutral file
        // label (never the raw URL).
        if (looksLikeImageAttachment(attachment) || /\.(jpe?g|png|gif|webp|heic|avif)$/i.test(String(attachment.variantMediumPath || attachment.storagePath || ""))) {
          const imageCard = { ...card, type: "image" };
          return renderAttachmentCard(imageCard, tileHeightClass);
        }
        const storageLabel = sanitizeCardTitle(attachment.name || title || "", "Image");
        return (
          <div className={`p-4 rounded-2xl ${tileHeightClass}`}>
            <div className="flex items-start gap-2 h-full">
              <FileText className="w-4 h-4 mt-0.5" />
              <div className="min-w-0">
                <p className="text-xs font-medium text-black/85 dark:text-white/85 truncate">{storageLabel}</p>
                <p className="text-[0.6875rem] text-black/55 dark:text-white/55 mt-1">Image</p>
              </div>
            </div>
          </div>
        );
      }
      const preview = (
        <div className={isPickerMode ? "pointer-events-none h-full" : "h-full"}>
          <LinkPreview
            url={linkUrl}
            title={sanitizeCardTitle(attachment.title || title || "")}
            description={String(attachment.description || "")}
            image={attachment.image || ""}
            siteName={attachment.siteName || ""}
            favicon={attachment.favicon || ""}
            authorName={attachment.authorName || ""}
            authorHandle={attachment.authorHandle || ""}
            oembedType={attachment.oembedType || ""}
            variant="vault"
          />
        </div>
      );
      if (uniformTile) {
        return (
          <div className={`w-full ${tileHeightClass} overflow-hidden rounded-2xl`}>
            {preview}
          </div>
        );
      }
      return preview;
    }

    if (type === "spreadsheet") {
      const cells = attachment.cells || {};
      const totalRows = Math.min(Number(attachment.rows) || 0, 8);
      const totalCols = Math.min(Number(attachment.cols) || 0, 6);
      const hasData = totalRows > 0 && totalCols > 0 && Object.keys(cells).length > 0;
      const fileName = attachment.name || title || "Spreadsheet";
      return (
        <div className={`rounded-2xl overflow-hidden glass-control ${uniformTile ? `w-full ${tileHeightClass}` : ""}`}>
          <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-black/8 dark:border-white/8">
            <Table2 className="w-4 h-4 text-green-600 shrink-0" />
            <span className="text-sm font-medium text-black/80 dark:text-white/80 truncate">{fileName}</span>
          </div>
          {hasData ? (
            <div className="overflow-hidden">
              <table className="w-full border-collapse text-[11px]">
                <tbody>
                  {Array.from({ length: totalRows }, (_, r) => (
                    <tr key={r} className={r === 0 ? "bg-black/5 font-semibold" : ""}>
                      {Array.from({ length: totalCols }, (_, c) => (
                        <td key={c} className="px-2 py-1 border-b border-r border-black/6 dark:border-white/6 text-black/70 dark:text-white/70 truncate max-w-[120px]">
                          {cells[`${r},${c}`] || ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {(Number(attachment.rows) > 8 || Number(attachment.cols) > 6) && (
                <div className="px-3 py-1.5 text-[0.6rem] text-black/35 dark:text-white/35 text-center">
                  {attachment.rows} rows × {attachment.cols} cols
                </div>
              )}
            </div>
          ) : (
            <div className="px-3.5 py-4 text-center text-xs text-black/40 dark:text-white/40">Spreadsheet file</div>
          )}
        </div>
      );
    }

    if (type === "doc" || type === "word") {
      const fileBody = (
        <div className="flex items-start gap-2 h-full">
          <FileText className="w-4 h-4 mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-black/85 dark:text-white/85 truncate">{title}</p>
            <p className="text-[0.6875rem] text-black/55 dark:text-white/55 mt-1">{type.toUpperCase()} file</p>
          </div>
        </div>
      );
      if (isPickerMode) {
        return (
          <div className={`block p-4 rounded-2xl ${tileHeightClass} pointer-events-none`} draggable={false}>
            {fileBody}
          </div>
        );
      }
      return (
        <a
          href={safeAttachmentUrl(resolvedUrl) || undefined}
          target="_blank"
          rel="noreferrer"
          className={`block p-4 hover:bg-black/5 transition rounded-2xl ${tileHeightClass}`}
          title={`Open ${type.toUpperCase()} file`}
          draggable={false}
        >
          {fileBody}
        </a>
      );
    }

    return (
      <div className={`p-4 rounded-2xl ${tileHeightClass}`}>
        <div className="flex items-start gap-2 h-full">
          {type === "youtube" ? <Video className="w-4 h-4 mt-0.5" /> : <FileText className="w-4 h-4 mt-0.5" />}
          <div className="min-w-0">
            <p className="text-xs font-medium text-black/85 dark:text-white/85 truncate">{title}</p>
            <p className="text-[0.6875rem] text-black/55 dark:text-white/55 mt-1">
              {type === "youtube" ? "YouTube video" : "File"}
            </p>
          </div>
        </div>
      </div>
    );
  };

  return renderAttachmentCard;
}
