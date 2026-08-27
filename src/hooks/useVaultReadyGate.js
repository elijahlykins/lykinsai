// Vault loading gate: keeps the LoadingScreen up until the first batch of
// grid images is resolved + pre-decoded, so the initial paint doesn't
// visibly reflow ("pile in" / skeleton-to-image jumps). Extracted from
// `src/pages/Vault.jsx`.
import { useCallback, useEffect, useRef, useState } from "react";
import { parseStorageTarget } from "@/lib/vault/vaultCardHelpers";
import { readCachedSignedUrl } from "@/lib/vault/signedUrlCache";
import { resolveAttachmentType } from "@/lib/vault/vaultCardModel";

// Tracks whether the vault has completed its initial image-preload gating at
// least once during this SPA session. Persists across route remounts so
// navigating away from /vault and back does not re-show the LoadingScreen
// while the browser's image cache is already warm.
let sessionVaultReady = false;

/**
 * @param {object} params
 * @param {object|null} params.user
 * @param {boolean} params.isLoadingNotes
 * @param {boolean} params.isWakePreview
 * @param {Array} params.vaultCards current cards (for the first-paint id snapshot)
 * @param {object} params.vaultCardsRef live ref of the cards (preload snapshots
 *   from the ref so ghost/note identity churn doesn't cancel mid-flight)
 * @param {object} params.visibleCardIdsRef from useVaultSignedUrls
 * @param {object} params.urlResolveQueueRef from useVaultSignedUrls
 * @param {Function} params.drainUrlResolveQueue from useVaultSignedUrls
 * @param {object} params.signedUrlCacheRef from useVaultSignedUrls
 * @param {object} params.learnedImageDimsRef from useVaultSignedUrls
 * @param {object} params.preDecodedUrlsRef from useVaultSignedUrls
 * @param {object} params.resetLoadGateRef page-owned ref; this hook installs
 *   the reset function refreshNotes calls before invalidating the query.
 */
export function useVaultReadyGate({
  user,
  isLoadingNotes,
  isWakePreview,
  vaultCards,
  vaultCardsRef,
  visibleCardIdsRef,
  urlResolveQueueRef,
  drainUrlResolveQueue,
  signedUrlCacheRef,
  learnedImageDimsRef,
  preDecodedUrlsRef,
  resetLoadGateRef,
}) {
  const [vaultReady, setVaultReadyRaw] = useState(() => sessionVaultReady);
  const markVaultReady = useCallback(() => {
    sessionVaultReady = true;
    setVaultReadyRaw(true);
  }, []);
  const setVaultReady = useCallback((value) => {
    if (value === true) {
      markVaultReady();
    } else if (typeof value === "function") {
      setVaultReadyRaw((prev) => {
        const next = value(prev);
        if (next === true) sessionVaultReady = true;
        return next;
      });
    } else {
      setVaultReadyRaw(value);
    }
  }, [markVaultReady]);

  useEffect(() => {
    if (!isWakePreview) return;
    setVaultReady(true);
  }, [isWakePreview, setVaultReady]);

  const eagerResolveRunRef = useRef(false);
  const initialCardIdsRef = useRef(null);
  if (vaultReady && initialCardIdsRef.current === null) {
    initialCardIdsRef.current = new Set(vaultCards.map((c) => c.id));
  }

  // refreshNotes resets the gate so a manual refresh re-runs the eager
  // preload against the fresh rows.
  useEffect(() => {
    resetLoadGateRef.current = () => {
      eagerResolveRunRef.current = false;
      initialCardIdsRef.current = null;
    };
    return () => {
      resetLoadGateRef.current = null;
    };
  }, [resetLoadGateRef]);

  // Suppress per-card entry motion + image fade-ins on the first paint
  // after the loading gate lifts. Without this, masonry columns reflow
  // while each card's opacity transition starts on a different frame —
  // the "pile in" / "click downward" effect users see on cold load.
  const isVaultFirstPaintRef = useRef(true);
  useEffect(() => {
    if (!vaultReady) return;
    let outer = 0;
    let inner = 0;
    outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        isVaultFirstPaintRef.current = false;
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [vaultReady]);

  // Gate the LoadingScreen on a one-shot image preload. Snapshot cards from
  // the ref (not vaultCards in the dep list) so ghost/note identity churn
  // doesn't cancel mid-flight. A cancelled run used to leave
  // eagerResolveRunRef=true forever, which stuck first visit on LoadingScreen
  // until a remount (navigate away → back) reset the ref.
  useEffect(() => {
    if (isWakePreview) return;
    if (!user?.id || isLoadingNotes) return;
    if (sessionVaultReady || eagerResolveRunRef.current) return;

    const cards = vaultCardsRef.current;
    if (cards.length === 0) {
      setVaultReady(true);
      return;
    }

    const attachmentCards = cards.filter((c) => c.kind === "attachment");
    if (attachmentCards.length === 0) {
      setVaultReady(true);
      return;
    }

    eagerResolveRunRef.current = true;
    for (const card of attachmentCards) {
      visibleCardIdsRef.current.add(card.id);
      urlResolveQueueRef.current.push(card);
    }
    let cancelled = false;
    const safetyTimer = setTimeout(() => {
      if (!cancelled) setVaultReady(true);
    }, 10000);
    let preloadTimeout = null;
    drainUrlResolveQueue().then(() => {
      if (cancelled) return;
      const imageCards = attachmentCards.filter((c) => {
        const t = resolveAttachmentType(c.attachment || {});
        return t === "image";
      });
      const urlsToPreload = imageCards
        .slice(0, 24)
        .map((c) => {
          const t = parseStorageTarget(c.attachment || {});
          const key = `${t?.bucket || "user-files"}:${t?.path || ""}`;
          return readCachedSignedUrl(signedUrlCacheRef.current, key) || c.attachment?.url;
        })
        .filter((u) => u && !String(u).startsWith("data:"));
      if (urlsToPreload.length === 0) {
        clearTimeout(safetyTimer);
        setVaultReady(true);
        return;
      }
      let settled = 0;
      const preloadDone = () => {
        settled += 1;
        if (settled >= urlsToPreload.length && !cancelled) {
          clearTimeout(safetyTimer);
          if (preloadTimeout) clearTimeout(preloadTimeout);
          setVaultReady(true);
        }
      };
      preloadTimeout = setTimeout(() => {
        if (cancelled) return;
        clearTimeout(safetyTimer);
        setVaultReady(true);
      }, 4000);
      for (const url of urlsToPreload) {
        const img = new window.Image();
        // Some browsers won't pre-decode cross-origin images without
        // the CORS hint. Signed Supabase URLs serve the right headers,
        // so this is safe to set unconditionally; if it fails, the
        // catch path falls back to a plain onload signal so we still
        // unblock vaultReady.
        img.crossOrigin = "anonymous";
        // Capture natural dims as early as possible. We do this here,
        // BEFORE the real <img> in the grid mounts, so the wrapper can
        // reserve the correct aspect-ratio slot from the very first
        // paint — eliminating the "card grows from skeleton size to
        // real image size" jump that caused the visible scroll glitch
        // for old images without stored metadata.
        const captureDims = () => {
          if (cancelled) return;
          const nw = img.naturalWidth;
          const nh = img.naturalHeight;
          if (nw > 0 && nh > 0 && !learnedImageDimsRef.current.has(url)) {
            learnedImageDimsRef.current.set(url, { w: nw, h: nh });
          }
        };
        const markDecoded = () => {
          if (cancelled) return;
          captureDims();
          preDecodedUrlsRef.current.add(url);
          preloadDone();
        };
        const fallbackOnLoad = () => {
          if (cancelled) return;
          // We still consider the URL "ready enough" — the browser has
          // it in HTTP cache so the real <img> will paint quickly.
          // We just don't add it to the no-fade set, so the existing
          // fade-in still runs as a graceful safety net. Dims still
          // get captured so the wrapper can reserve correct space.
          captureDims();
          preloadDone();
        };
        img.onload = () => {
          if (cancelled) return;
          if (typeof img.decode === "function") {
            img.decode().then(markDecoded).catch(fallbackOnLoad);
          } else {
            // Old browser without HTMLImageElement.decode — treat as
            // pre-decoded (good enough; the visible-fade fallback
            // still works if it isn't).
            markDecoded();
          }
        };
        img.onerror = () => { if (!cancelled) preloadDone(); };
        img.src = url;
      }
    });
    return () => {
      cancelled = true;
      clearTimeout(safetyTimer);
      if (preloadTimeout) clearTimeout(preloadTimeout);
      // If we aborted before marking ready, allow the next effect pass to
      // retry. Leaving the ref true here permanently stuck first visit.
      if (!sessionVaultReady) {
        eagerResolveRunRef.current = false;
      }
    };
    // (react-hooks/exhaustive-deps intentionally not satisfied; see comment above.)
  }, [user?.id, isLoadingNotes, drainUrlResolveQueue, setVaultReady, isWakePreview]);

  return {
    vaultReady,
    setVaultReady,
    initialCardIdsRef,
    isVaultFirstPaintRef,
  };
}
