// useVaultReveal owns the Vault feed's progressive reveal window: cards are
// shown in groups of REVEAL_BATCH, each next group gated on its media being
// resolved/decoded (or a 6s safety valve), driven by a bottom sentinel, a
// scroll fallback that works in the collage masonry, and an auto-fill pass
// for short pages. Also owns plain infinite scroll for the non-feed
// (Tags/Type) views. Extracted verbatim from src/pages/Vault.jsx (Vault
// decomposition phase, see docs/REFACTOR_LOG.md).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveRenderType } from "@/lib/vault/attachmentType";
import { parseStorageTarget } from "@/lib/vault/vaultCardHelpers";

const resolveAttachmentType = resolveRenderType;

export function useVaultReveal({
  user,
  loading,
  isWakePreview,
  vaultView,
  collageGridCardsAll,
  hasMoreNotes,
  isLoadingMoreNotes,
  loadMoreNotes,
  loadMoreRef,
  embeddedSearch,
  selectedFilterTags,
  conceptResultIds,
  resolvedAttachmentUrls,
  failedImageIds,
  visibleCardIdsRef,
  urlResolveQueueRef,
  drainUrlResolveQueue,
}) {
  useEffect(() => {
    if (!loadMoreRef.current || loading || !user?.id) return;
    const target = loadMoreRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        setSentinelInView(!!entries[0]?.isIntersecting);
      },
      { rootMargin: "320px 0px 320px 0px" }
    );
    observer.observe(target);
    return () => {
      observer.disconnect();
      setSentinelInView(false);
    };
    // `vaultView` is included so the observer re-attaches to the sentinel that
    // the freshly-rendered view branch mounts (each view renders its own).
  }, [loading, user?.id, vaultView]);

  // ── Batched reveal (feed views) ────────────────────────────────────────
  // Collage (masonry) and Grid are "feed" views: instead of dumping every
  // fetched card on screen at once, they reveal in groups of REVEAL_BATCH.
  // When the user scrolls to the bottom we show that many skeletons and gate
  // the next group on its media actually resolving/decoding — so the user
  // never scrolls into a wall of empty placeholders, and the page only grows
  // once the next batch is genuinely ready. Tags/Type are grouped views and
  // always render their full set.
  const REVEAL_BATCH = 7;
  const isFeedView = !isWakePreview && (vaultView === "collage" || vaultView === "grid");
  const [revealCount, setRevealCount] = useState(REVEAL_BATCH);
  const [sentinelInView, setSentinelInView] = useState(false);
  const [batchPreparing, setBatchPreparing] = useState(false);
  const batchPreparingRef = useRef(false);

  // `collageGridCardsAll` (wake split applied) is computed by the page and
  // passed in as a param.
  const collageGridCards = useMemo(
    () => (isFeedView ? collageGridCardsAll.slice(0, revealCount) : collageGridCardsAll),
    [collageGridCardsAll, isFeedView, revealCount],
  );

  const hasMoreLocalToReveal = isFeedView && revealCount < collageGridCardsAll.length;
  const canRevealMore = isFeedView && (hasMoreLocalToReveal || hasMoreNotes);

  // How many skeletons to show under the revealed cards: the size of the next
  // group still waiting to come in.
  const pendingRevealCount = (() => {
    if (!isFeedView) return 0;
    const localRemaining = collageGridCardsAll.length - revealCount;
    if (localRemaining > 0) return Math.min(REVEAL_BATCH, localRemaining);
    if (hasMoreNotes) return REVEAL_BATCH;
    return 0;
  })();

  // A card is "ready" once anything it needs to paint is in hand. Notes/links
  // render from text immediately; image/video attachments backed by storage
  // need their signed URL resolved (the resolve path also probes/decodes the
  // image), so we wait on `resolvedAttachmentUrls` (or a definitive failure).
  const isCardMediaReady = useCallback(
    (card) => {
      if (!card || card.kind !== "attachment") return true;
      const t = resolveAttachmentType(card.attachment || {});
      if (t !== "image" && t !== "video") return true;
      const target = parseStorageTarget(card.attachment || {});
      const isStorageBacked = !!(target?.bucket && target?.path);
      if (!isStorageBacked) return true;
      return !!resolvedAttachmentUrls[card.id] || failedImageIds.has(card.id);
    },
    [resolvedAttachmentUrls, failedImageIds],
  );

  const prepareNextBatch = useCallback(() => {
    if (!isFeedView || batchPreparingRef.current) return;
    if (!hasMoreLocalToReveal) {
      // Nothing left in the local cache to reveal — pull the next server page.
      // The trigger effect re-runs once those rows land and the cache grows.
      if (hasMoreNotes) void loadMoreNotes();
      return;
    }
    const next = collageGridCardsAll.slice(revealCount, revealCount + REVEAL_BATCH);
    for (const card of next) {
      if (card.kind === "attachment") {
        visibleCardIdsRef.current.add(card.id);
        urlResolveQueueRef.current.push(card);
      }
    }
    void drainUrlResolveQueue();
    batchPreparingRef.current = true;
    setBatchPreparing(true);
  }, [
    isFeedView,
    hasMoreLocalToReveal,
    hasMoreNotes,
    loadMoreNotes,
    collageGridCardsAll,
    revealCount,
    drainUrlResolveQueue,
  ]);

  // Kick off the next batch when the bottom sentinel scrolls into view.
  useEffect(() => {
    if (!sentinelInView || !isFeedView || batchPreparing || !canRevealMore) return;
    prepareNextBatch();
  }, [sentinelInView, isFeedView, batchPreparing, canRevealMore, prepareNextBatch]);

  // Forward-progress safety net for the reveal window. The bottom sentinel's
  // IntersectionObserver fires reliably in the grid layout but NOT in the
  // collage masonry (the sentinel sits after a flex container that never
  // reports as intersecting), which left collage frozen on the first group of
  // REVEAL_BATCH items. Independently of the sentinel: whenever there's more to
  // reveal and the page isn't tall enough to scroll, advance directly. This
  // re-runs on every revealCount change and loops until the content overflows
  // the viewport, after which scroll-driven reveal takes over. The
  // `batchPreparing` gate (and the media-ready/6s safety valve that clears it)
  // throttles this to one batch at a time, so it can't runaway-reveal.
  useEffect(() => {
    if (!isFeedView || batchPreparing || !canRevealMore) return;
    if (typeof window === "undefined") return;
    const id = window.requestAnimationFrame(() => {
      const doc = document.scrollingElement || document.documentElement;
      const pageScrollable = doc && doc.scrollHeight > window.innerHeight + 200;
      if (!pageScrollable) prepareNextBatch();
    });
    return () => window.cancelAnimationFrame(id);
  }, [isFeedView, batchPreparing, canRevealMore, revealCount, collageGridCardsAll.length, prepareNextBatch]);

  // Scroll-driven reveal/pagination that works in EVERY view (collage, grid,
  // tags, type). The bottom sentinel's IntersectionObserver fires in the grid
  // layout but NOT in the collage masonry, and the non-feed views (tags/type)
  // also leaned on it to fetch the next page — so anything but grid could stall
  // once scrollable. Drive everything directly off scroll position instead:
  // whenever the sentinel is within ~700px of the viewport, advance the reveal
  // window (feed views) or load the next server page (non-feed views).
  // Capture-phase listening catches scroll from a nested scroll container too;
  // batchPreparingRef / isLoadingMoreNotes gate to one step at a time.
  useEffect(() => {
    if (isWakePreview) return;
    const maybeReveal = () => {
      const el = loadMoreRef.current;
      if (!el) return;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      if (el.getBoundingClientRect().top > vh + 700) return;
      if (isFeedView) {
        if (!batchPreparingRef.current && canRevealMore) prepareNextBatch();
      } else if (hasMoreNotes && !isLoadingMoreNotes) {
        void loadMoreNotes();
      }
    };
    maybeReveal();
    window.addEventListener("scroll", maybeReveal, true);
    window.addEventListener("resize", maybeReveal);
    return () => {
      window.removeEventListener("scroll", maybeReveal, true);
      window.removeEventListener("resize", maybeReveal);
    };
  }, [isWakePreview, isFeedView, canRevealMore, prepareNextBatch, hasMoreNotes, isLoadingMoreNotes, loadMoreNotes]);

  // Once every card in the preparing batch has its media ready, reveal them.
  useEffect(() => {
    if (!batchPreparing) return;
    const next = collageGridCardsAll.slice(revealCount, revealCount + REVEAL_BATCH);
    if (next.length === 0) {
      batchPreparingRef.current = false;
      setBatchPreparing(false);
      return;
    }
    if (next.every((card) => isCardMediaReady(card))) {
      batchPreparingRef.current = false;
      setBatchPreparing(false);
      setRevealCount((c) => c + REVEAL_BATCH);
    }
  }, [batchPreparing, collageGridCardsAll, revealCount, isCardMediaReady]);

  // Safety valve: never trap the user behind a batch that won't resolve (a
  // dead signed URL, a stalled network). Reveal anyway after a grace period.
  useEffect(() => {
    if (!batchPreparing) return;
    const t = setTimeout(() => {
      batchPreparingRef.current = false;
      setBatchPreparing(false);
      setRevealCount((c) => c + REVEAL_BATCH);
    }, 6000);
    return () => clearTimeout(t);
  }, [batchPreparing]);

  // Reset the reveal window whenever the feed itself changes (search, tag
  // filter, concept results, or switching views) so a new result set starts
  // from the first group again instead of inheriting a stale large window.
  useEffect(() => {
    setRevealCount(REVEAL_BATCH);
    batchPreparingRef.current = false;
    setBatchPreparing(false);
  }, [embeddedSearch, selectedFilterTags, conceptResultIds, vaultView, isFeedView]);

  // Non-feed views (Tags/Type) keep plain infinite scroll.
  useEffect(() => {
    if (isFeedView) return;
    if (sentinelInView && hasMoreNotes && !isLoadingMoreNotes) void loadMoreNotes();
  }, [isFeedView, sentinelInView, hasMoreNotes, isLoadingMoreNotes, loadMoreNotes]);

  return { isFeedView, collageGridCards, pendingRevealCount };
}
