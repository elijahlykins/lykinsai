// useVaultMasonry owns the collage view's fixed-column JS masonry: the
// responsive column count, the per-card frozen height estimate, and the
// greedy shortest-column bucket assignment that keeps already-placed cards
// from ever moving. Extracted verbatim from src/pages/Vault.jsx (Vault
// decomposition phase, see docs/REFACTOR_LOG.md).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { estimateCardHeightUnit } from "@/lib/vault/vaultCardHelpers";

export function useVaultMasonry({
  isEmbeddedMode,
  isWakePreview,
  vaultView,
  collageGridCards,
}) {
  // ── Fixed-column JS masonry (collage view) ──
  //
  // The collage previously used CSS multi-column (`columns-*`). CSS columns
  // re-balance ALL columns whenever total content height changes — i.e. every
  // time an image resolves or a new page appends on scroll — which visually
  // threw cards in and out of order. Instead we assign each card to a fixed
  // column with a greedy "shortest column" pass over a DETERMINISTIC height
  // estimate (see `estimateCardHeightUnit`). Because the estimate never changes
  // as content loads and the greedy pass is order-preserving, a card's column
  // and position are stable across loads and pagination — nothing already on
  // screen ever moves. Grid view (CSS grid, row-major) and the wake marketing
  // preview keep their own layouts and don't use this.
  const computeCollageColumns = useCallback(() => {
    if (typeof window === "undefined") return isEmbeddedMode ? 3 : 3;
    const w = window.innerWidth;
    if (isEmbeddedMode) {
      // The embedded vault renders inside a centered modal iframe whose width
      // can be ~1100px, so scale the column count with the available width to
      // keep cards from blowing up huge.
      if (w >= 1000) return 4;
      if (w >= 720) return 3;
      if (w >= 480) return 2;
      return 1;
    }
    if (w >= 1536) return 5; // 2xl
    if (w >= 1280) return 4; // xl
    if (w >= 768) return 3; // md
    if (w >= 640) return 2; // sm
    return 1;
  }, [isEmbeddedMode]);

  const [collageColumns, setCollageColumns] = useState(computeCollageColumns);
  useEffect(() => {
    const onResize = () => setCollageColumns(computeCollageColumns());
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [computeCollageColumns]);

  const useMasonryLayout = !isWakePreview && vaultView !== "grid";

  // Freeze each card's masonry height estimate the first time we see it, keyed
  // by card id. The estimate drives column assignment; if it changed after
  // mount (e.g. a dimension backfill or a background react-query refetch fed
  // real dims into a previously dim-less card) the greedy packer could move an
  // already-placed card to a different column WHILE the user is looking — a
  // visible reshuffle. Locking the estimate per id for the component's
  // lifetime guarantees the design's invariant: nothing already on screen ever
  // moves. New cards (uploads/pagination) compute fresh — with their real dims
  // if present — and a remount (route change) recomputes everything against
  // whatever dims are now persisted, so balance still improves over time.
  const heightEstimateCacheRef = useRef(new Map());
  const stableHeightEstimate = useCallback((card) => {
    const cache = heightEstimateCacheRef.current;
    const cached = cache.get(card.id);
    if (cached !== undefined) return cached;
    const value = estimateCardHeightUnit(card);
    cache.set(card.id, value);
    return value;
  }, []);

  const collageColumnBuckets = useMemo(() => {
    const count = Math.max(1, collageColumns);
    const buckets = Array.from({ length: count }, () => []);
    if (!useMasonryLayout) return buckets;
    const heights = new Array(count).fill(0);
    for (const card of collageGridCards) {
      let min = 0;
      for (let i = 1; i < count; i += 1) {
        if (heights[i] < heights[min]) min = i;
      }
      buckets[min].push(card);
      heights[min] += stableHeightEstimate(card);
    }
    return buckets;
  }, [collageGridCards, collageColumns, useMasonryLayout, stableHeightEstimate]);

  return { collageColumns, useMasonryLayout, collageColumnBuckets };
}
