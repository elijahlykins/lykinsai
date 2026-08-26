// useVaultSignedUrls owns the Vault's signed-URL / media-resolution
// subsystem: the visibility-driven resolve queue (IntersectionObserver ->
// queue -> batched drain), the signed-URL cache, video poster signing, AI
// Drive artifact markup, image dimension learning + DB backfill, and the
// tab-refocus recovery pass. Extracted verbatim from src/pages/Vault.jsx
// (Vault decomposition phase, see docs/REFACTOR_LOG.md).
//
// Deliberately NOT owned here (they stay in Vault.jsx by design):
//   - the first-paint eager preload gate (drives vaultReady/LoadingScreen);
//     it feeds this hook's queue via the exposed refs;
//   - the AI describe backfill effect (mutates the notes cache);
//   - the preview lightbox full-res signing (writes back via the exposed
//     setters -- see docs/VAULT_STATE_MAP.md "surprising couplings").
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { isLocalTarget, localBlobUrl } from "@/lib/vault/repository";
import { lazyBackfillCardVariants } from "@/lib/vault/lazyVariantBackfill";
import { resolveRenderType } from "@/lib/vault/attachmentType";
import {
  findAttachmentsMarker,
  withAttachmentsMarker,
} from "@/lib/vault/attachmentsMarker";
import {
  parseStorageTarget,
  resolveAttachmentAspectRatio,
} from "@/lib/vault/vaultCardHelpers";
import {
  SIGNED_URL_TTL_SECONDS,
  readCachedSignedUrl,
  writeCachedSignedUrl,
} from "@/lib/vault/signedUrlCache";

const resolveAttachmentType = resolveRenderType;

// Ceiling on markup we'll inline into a preview frame. A generated page is tens
// of kilobytes; anything past this is a data blob, and its thumbnail isn't worth
// holding in memory.
const ARTIFACT_MARKUP_LIMIT = 2_000_000;

export function useVaultSignedUrls({
  user,
  vaultCards,
  studioSurface,
  previewCard,
  vaultWrites,
}) {
  const [resolvedAttachmentUrls, setResolvedAttachmentUrls] = useState({});
  // Signed URLs for video poster frames (the generated thumb/medium JPEG).
  // Used as the <video poster> so grid cards show a real frame instead of a
  // black box while the video itself only preloads metadata.
  const [resolvedVideoPosterUrls, setResolvedVideoPosterUrls] = useState({});
  // AI Drive previews artifacts from their own markup (cardId → HTML source)
  // rather than by framing the file proxy. See `resolveDriveMarkupForCard`.
  const [driveMarkup, setDriveMarkup] = useState({});
  const driveMarkupTriedRef = useRef(new Set());
  const [failedImageIds, setFailedImageIds] = useState(new Set());
  const imageRetryCountsRef = useRef(new Map());
  const signedUrlCacheRef = useRef(new Map());

  const visibleCardIdsRef = useRef(new Set());
  const urlResolveObserverRef = useRef(null);

  // For image-type attachments, pre-load the image with `new Image()`
  // (HEAD-style) before triggering the React state update that mounts
  // the real <img>. This:
  //   1. captures naturalWidth/Height into `learnedImageDimsRef`, so
  //      the wrapper can reserve correct aspect-ratio from first paint
  //      (eliminates the "card grows from skeleton size to real size"
  //      jump that caused the visible scroll glitch);
  //   2. seeds the browser HTTP cache, so the real <img> paints
  //      instantly when it mounts.
  //
  // We give it a budget — if dims don't come back within 600ms we
  // setState anyway. Better to risk a small first-load shift on a slow
  // image than to leave the user staring at a skeleton.
  const resolveImageDimsAndCommit = useCallback((cardId, signedUrl) => {
    const PROBE_BUDGET_MS = 1200;
    const learned = learnedImageDimsRef.current.get(signedUrl);
    if (learned) {
      // Already know dims (preload covered it, or we've seen this URL).
      // Commit immediately — the wrapper will reserve correctly.
      setResolvedAttachmentUrls((prev) => {
        if (prev[cardId]) return prev;
        return { ...prev, [cardId]: signedUrl };
      });
      return;
    }
    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      setResolvedAttachmentUrls((prev) => {
        if (prev[cardId]) return prev;
        return { ...prev, [cardId]: signedUrl };
      });
    };
    const probe = new window.Image();
    probe.crossOrigin = "anonymous";
    const budgetTimer = setTimeout(commit, PROBE_BUDGET_MS);
    probe.onload = () => {
      clearTimeout(budgetTimer);
      const nw = probe.naturalWidth;
      const nh = probe.naturalHeight;
      if (nw > 0 && nh > 0 && !learnedImageDimsRef.current.has(signedUrl)) {
        learnedImageDimsRef.current.set(signedUrl, { w: nw, h: nh });
      }
      commit();
    };
    probe.onerror = () => {
      // Network/CORS fail on the probe — let the real <img> retry path
      // handle it. Commit the URL so the user at least sees the
      // skeleton replaced with the real <img> (which will trigger its
      // own retry-with-fresh-signed-URL flow on error).
      clearTimeout(budgetTimer);
      commit();
    };
    probe.src = signedUrl;
  }, []);

  const resolveSignedUrlForCard = useCallback(async (card) => {
    if (!card || card.kind !== "attachment") return;
    // Grid cards prefer the medium variant for images (sharp on retina tiles);
    // thumb is reserved for video posters. Video keeps the original playable
    // file (its variant is a poster JPEG, not a playable file).
    const cardType = resolveAttachmentType(card.attachment || {});
    const isImage = cardType === "image";
    // Existing images without variants: backfill them in the background on
    // first view so future loads use the medium / thumb renditions.
    if (isImage && user?.id && card.noteId) {
      lazyBackfillCardVariants({ userId: user.id, noteId: card.noteId, attachment: card.attachment || {} });
    }

    // Video poster: sign the generated thumb/medium JPEG (if any) so the grid
    // <video> can show a real frame instead of a black box. Best-effort and
    // independent of the playable-original resolution below.
    if (cardType === "video") {
      const posterTarget = parseStorageTarget(card.attachment || {}, "thumb");
      const originalTarget = parseStorageTarget(card.attachment || {});
      // parseStorageTarget falls back to the original when no variant exists;
      // only treat it as a poster when it's actually a distinct variant path.
      const hasPosterVariant =
        posterTarget?.path &&
        posterTarget?.bucket &&
        posterTarget.path !== originalTarget?.path;
      if (hasPosterVariant) {
        const posterKey = `${posterTarget.bucket}:${posterTarget.path}`;
        const cachedPoster = readCachedSignedUrl(signedUrlCacheRef.current, posterKey);
        if (cachedPoster) {
          setResolvedVideoPosterUrls((prev) => (prev[card.id] ? prev : { ...prev, [card.id]: cachedPoster }));
        } else {
          supabase.storage
            .from(posterTarget.bucket)
            .createSignedUrl(posterTarget.path, SIGNED_URL_TTL_SECONDS)
            .then(({ data }) => {
              if (data?.signedUrl) {
                writeCachedSignedUrl(signedUrlCacheRef.current, posterKey, data.signedUrl);
                setResolvedVideoPosterUrls((prev) => (prev[card.id] ? prev : { ...prev, [card.id]: data.signedUrl }));
              }
            })
            .catch(() => {});
        }
      } else if (user?.id && card.noteId) {
        // Legacy video with no poster yet: generate one on first view, store
        // it, and show it live so the card stops being a black box.
        lazyBackfillCardVariants({
          userId: user.id,
          noteId: card.noteId,
          attachment: card.attachment || {},
          onPosterReady: ({ bucket, variantThumbPath, variantMediumPath }) => {
            const path = String(variantThumbPath || variantMediumPath || "").trim();
            if (!path) return;
            const posterKey = `${bucket}:${path}`;
            const cached = readCachedSignedUrl(signedUrlCacheRef.current, posterKey);
            if (cached) {
              setResolvedVideoPosterUrls((prev) => (prev[card.id] ? prev : { ...prev, [card.id]: cached }));
              return;
            }
            supabase.storage
              .from(bucket)
              .createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
              .then(({ data }) => {
                if (data?.signedUrl) {
                  writeCachedSignedUrl(signedUrlCacheRef.current, posterKey, data.signedUrl);
                  setResolvedVideoPosterUrls((prev) => (prev[card.id] ? prev : { ...prev, [card.id]: data.signedUrl }));
                }
              })
              .catch(() => {});
          },
        });
      }
    }
    const isHtml = cardType === "html";
    const target = parseStorageTarget(card.attachment || {}, isImage ? "medium" : null);
    if (!target?.path || !target?.bucket) {
      const rawUrl = String(card.attachment?.url || "").trim();
      if (rawUrl && (rawUrl.startsWith("data:") || rawUrl.startsWith("blob:") || !rawUrl.includes("supabase.co/storage/"))) {
        return;
      }
      setFailedImageIds((prev) => new Set(prev).add(card.id));
      return;
    }
    // HTML previews MUST use the branded file proxy (correct MIME +
    // frame-ancestors + permissive script CSP for React/Babel runners).
    // Raw Supabase signed URLs blank the iframe (text/plain / frame deny),
    // so never cache a storage URL under the file-proxy key — that poisoned
    // both the grid tile and the click-to-open view mode permanently.
    const cacheKey = isHtml
      ? `file-proxy:${target.bucket}:${target.path}`
      : `${target.bucket}:${target.path}`;
    const isSupabaseStorageUrl = (u) => /supabase\.co\/storage\//i.test(String(u || ""));
    const commitUrl = (signedUrl, { force = false } = {}) => {
      if (isImage) {
        // Image path: probe dims first so the slot reserves correctly,
        // then setState. See `resolveImageDimsAndCommit` for the full
        // budget/fallback story.
        resolveImageDimsAndCommit(card.id, signedUrl);
      } else {
        setResolvedAttachmentUrls((prev) => {
          if (!force && prev[card.id] && !isSupabaseStorageUrl(prev[card.id])) return prev;
          return { ...prev, [card.id]: signedUrl };
        });
      }
    };
    // Bytes already on this device need no signing, no cache and no expiry —
    // the protocol handler in the main process serves them straight off disk.
    // Checked before the cache so a local card never takes an entry that
    // exists only to track a TTL it does not have.
    if (isLocalTarget(target)) {
      const blobUrl = localBlobUrl(target.path);
      if (blobUrl) {
        commitUrl(blobUrl, { force: true });
        return;
      }
    }

    const cachedFresh = readCachedSignedUrl(signedUrlCacheRef.current, cacheKey);
    // Ignore a poisoned cache entry that somehow stored a storage URL as
    // a "file-proxy" result from an older build.
    if (cachedFresh && !(isHtml && isSupabaseStorageUrl(cachedFresh))) {
      commitUrl(cachedFresh);
      return;
    }

    if (isHtml) {
      try {
        const { API_BASE_URL } = await import("@/lib/api-config");
        const session = (await supabase.auth.getSession())?.data?.session;
        const token = session?.access_token;
        if (token) {
          const resp = await fetch(`${API_BASE_URL}/api/storage/file-proxy-url`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              storagePath: target.path,
              bucket: target.bucket,
              filename: String(card.attachment?.name || "artifact.html"),
            }),
          });
          if (resp.ok) {
            const { url } = await resp.json();
            if (url && !isSupabaseStorageUrl(url)) {
              writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, url);
              commitUrl(url, { force: true });
              return;
            }
          }
        }
      } catch (err) {
        if (import.meta.env.DEV) console.warn("[Vault] File-proxy URL mint failed:", err);
      }
      // Do NOT fall back to a raw Supabase signed URL for HTML — it paints a
      // permanent white blank in the iframe. Surface "unavailable" instead.
      imageRetryCountsRef.current.set(card.id, 99);
      setFailedImageIds((prev) => new Set(prev).add(card.id));
      visibleCardIdsRef.current.delete(card.id);
      return;
    }

    let objectNotFound = false;
    try {
      const { data, error } = await supabase.storage
        .from(target.bucket)
        .createSignedUrl(target.path, SIGNED_URL_TTL_SECONDS);
      if (data?.signedUrl) {
        writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, data.signedUrl);
        commitUrl(data.signedUrl);
        return;
      }
      if (error) {
        objectNotFound = /not found/i.test(error.message || "");
        if (!objectNotFound && import.meta.env.DEV) console.warn("[Vault] Signed URL error for", target.path, error.message);
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[Vault] Signed URL exception for", target.path, err);
    }
    if (!objectNotFound) {
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
              commitUrl(signedUrl);
              return;
            }
          }
        }
      } catch (err) {
        if (import.meta.env.DEV) console.warn("[Vault] Server-side signed URL fallback failed:", err);
      }
    }
    imageRetryCountsRef.current.set(card.id, 99);
    setFailedImageIds((prev) => new Set(prev).add(card.id));
    visibleCardIdsRef.current.delete(card.id);
  }, [resolveImageDimsAndCommit, user?.id]);

  /**
   * Reads an artifact's markup so AI Drive can render it itself.
   *
   * The obvious way to preview an artifact is to frame the file proxy, which is
   * what the Vault grid does — but the proxy names the origins allowed to embed
   * it in `frame-ancestors`, and the desktop shell isn't one of them, so the
   * frame is refused and paints nothing. Fetching the markup and handing it to
   * a `srcDoc` frame has no such header to satisfy: the document is inlined by
   * this app, not loaded from the proxy.
   *
   * Storage is signed directly (rather than proxied) because only storage
   * answers a cross-origin fetch. Local-first vaults read straight off disk.
   */
  const resolveDriveMarkupForCard = useCallback(async (card) => {
    if (!studioSurface || card?.kind !== "attachment") return;
    if (resolveAttachmentType(card.attachment || {}) !== "html") return;
    if (driveMarkupTriedRef.current.has(card.id)) return;
    driveMarkupTriedRef.current.add(card.id);

    const target = parseStorageTarget(card.attachment || {});
    if (!target?.path || !target?.bucket) {
      driveMarkupTriedRef.current.delete(card.id);
      return;
    }

    let url = "";
    if (isLocalTarget(target)) {
      url = localBlobUrl(target.path) || "";
    } else {
      const cacheKey = `${target.bucket}:${target.path}`;
      url = readCachedSignedUrl(signedUrlCacheRef.current, cacheKey) || "";
      if (!url) {
        try {
          const { data } = await supabase.storage
            .from(target.bucket)
            .createSignedUrl(target.path, SIGNED_URL_TTL_SECONDS);
          url = data?.signedUrl || "";
          if (url) writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, url);
        } catch {
          driveMarkupTriedRef.current.delete(card.id);
          return;
        }
      }
    }
    if (!url) {
      driveMarkupTriedRef.current.delete(card.id);
      return;
    }

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        driveMarkupTriedRef.current.delete(card.id);
        return;
      }
      const size = Number(resp.headers.get("content-length") || 0);
      if (size > ARTIFACT_MARKUP_LIMIT) {
        driveMarkupTriedRef.current.delete(card.id);
        return;
      }
      const markup = await resp.text();
      if (!markup.trim()) {
        driveMarkupTriedRef.current.delete(card.id);
        return;
      }
      setDriveMarkup((prev) => (prev[card.id] ? prev : { ...prev, [card.id]: markup.slice(0, ARTIFACT_MARKUP_LIMIT) }));
    } catch {
      // Offline, most likely — worth another go when it scrolls back into view.
      // The cover stands in for it meanwhile.
      driveMarkupTriedRef.current.delete(card.id);
    }
  }, [studioSurface]);

  // Opening the viewport must not wait on artifact I/O. Once it is mounted,
  // resolve any missing markup and let the portal re-render with srcDoc.
  useEffect(() => {
    const card = previewCard;
    if (!studioSurface || card?.kind !== "attachment") return;
    if (resolveAttachmentType(card.attachment || {}) !== "html") return;
    if (driveMarkup[card.id]) return;
    driveMarkupTriedRef.current.delete(card.id);
    void resolveDriveMarkupForCard(card);
  }, [previewCard, studioSurface, driveMarkup, resolveDriveMarkupForCard]);

  const cardElementsRef = useRef(new Map());

  const registerCardRef = useCallback((cardId, element) => {
    if (element) {
      cardElementsRef.current.set(cardId, element);
      urlResolveObserverRef.current?.observe(element);
    } else {
      const prev = cardElementsRef.current.get(cardId);
      if (prev) urlResolveObserverRef.current?.unobserve(prev);
      cardElementsRef.current.delete(cardId);
    }
  }, []);

  const urlResolveQueueRef = useRef([]);
  const urlResolveDrainingRef = useRef(false);

  const drainPromiseRef = useRef(null);
  const drainUrlResolveQueue = useCallback(async () => {
    if (urlResolveDrainingRef.current) return drainPromiseRef.current;
    urlResolveDrainingRef.current = true;
    drainPromiseRef.current = (async () => {
      while (urlResolveQueueRef.current.length > 0) {
        const batch = urlResolveQueueRef.current.splice(0, 20);
        // Artifact markup is read alongside the signing pass, not after it: the
        // proxy URL it would otherwise wait on is the thing AI Drive can't use.
        for (const card of batch) void resolveDriveMarkupForCard(card);
        await Promise.allSettled(batch.map((card) => resolveSignedUrlForCard(card)));
      }
      urlResolveDrainingRef.current = false;
    })();
    return drainPromiseRef.current;
  }, [resolveSignedUrlForCard, resolveDriveMarkupForCard]);

  useEffect(() => {
    if (!user?.id) return;
    const cardLookup = new Map(vaultCards.map((c) => [c.id, c]));
    visibleCardIdsRef.current.clear();

    urlResolveObserverRef.current = new IntersectionObserver(
      (entries) => {
        let queued = false;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const cardId = entry.target.dataset?.cardId;
          if (!cardId || visibleCardIdsRef.current.has(cardId)) continue;
          visibleCardIdsRef.current.add(cardId);
          const card = cardLookup.get(cardId);
          if (card) {
            urlResolveQueueRef.current.push(card);
            queued = true;
          }
        }
        if (queued) drainUrlResolveQueue();
      },
      // 1200px lead time: this needs to cover (signed-URL fetch time)
      // + (image probe download time) + (decode) so that by the time
      // the card actually enters the viewport, we already have its
      // dimensions in `learnedImageDimsRef` and the image bytes in
      // the HTTP cache. ~3-4 rows ahead at typical row heights.
      // Trade-off: too aggressive wastes bandwidth on cards the user
      // never reaches; too conservative leaves visible layout shifts
      // on first scroll. 1200px is the sweet spot for typical scroll
      // velocity on a feed-style grid.
      { rootMargin: "1200px" }
    );

    for (const [, el] of cardElementsRef.current) {
      urlResolveObserverRef.current.observe(el);
    }

    return () => {
      urlResolveObserverRef.current?.disconnect();
      urlResolveObserverRef.current = null;
    };
  }, [vaultCards, user?.id, resolveSignedUrlForCard, drainUrlResolveQueue]);

  // Caches the natural width/height of every image we've loaded at
  // least once, keyed by URL. Used by the image render path to set the
  // `<img>`'s `width` + `height` HTML attributes on subsequent renders
  // so the browser can reserve the correct aspect-ratio slot BEFORE
  // the image loads. Without this, scrolling new cards into view caused
  // the card to grow/shrink from the placeholder height to the real
  // image height, which cascaded into "cards shifting up and down"
  // jitter for the rest of the visible row.
  //
  // We use a ref (not state) on purpose — we only want this data to
  // influence the next render of the same component instance, not
  // trigger a global re-render every time an image loads.
  const learnedImageDimsRef = useRef(new Map());

  // Tracks image URLs we've already pre-DECODED (not just downloaded).
  // The render path uses this to skip the per-image opacity fade-in for
  // first-viewport images so they reveal atomically instead of popping
  // in one at a time. See `renderAttachmentCard` below for the
  // consumer side.
  //
  // `image.decode()` (vs plain `new Image().onload`) is the key: onload
  // fires when bytes arrive, but the GPU bitmap isn't ready yet. The
  // first paint then triggers a synchronous decode, and because each
  // image's decode finishes on a different frame, every card's
  // `transition-opacity` starts at a slightly different moment — which
  // is exactly the "popcorn" / "glitching" effect users see on first
  // load.
  const preDecodedUrlsRef = useRef(new Set());

  // ── Dimension backfill (self-heal the existing vault) ──────────────────
  // New uploads now store intrinsic width/height (see uploadPipeline.ts), so
  // the masonry estimate + skeleton + image all reserve the SAME aspect from
  // first paint — zero layout shift. Items uploaded before that change have
  // no stored dims, so they still shift their column once when the image
  // resolves. This persister closes that gap: the first time we learn an
  // image's real natural dimensions (from the <img> onLoad / preload probe),
  // we write them back into the note's attachment marker. From then on the
  // card reserves its true aspect on every load — the vault converges to a
  // totally shift-free feed as the user browses it once.
  const persistDimsAttemptedRef = useRef(new Set());
  const persistDimsQueueRef = useRef([]);
  const persistDimsDrainingRef = useRef(false);
  const drainPersistDimsQueue = useCallback(async () => {
    if (persistDimsDrainingRef.current) return;
    persistDimsDrainingRef.current = true;
    try {
      while (persistDimsQueueRef.current.length > 0) {
        const job = persistDimsQueueRef.current.shift();
        if (!job?.noteId || !user?.id) continue;
        try {
          const { data: note } = await vaultWrites.readForUpdate(job.noteId);
          if (!note?.content) continue;
          const span = findAttachmentsMarker(String(note.content));
          if (!span) continue;
          const attachments = span.attachments.slice();
          const idx = job.attachmentIndex ?? 0;
          const current = attachments[idx];
          if (!current || typeof current !== "object") continue;
          // Someone (a newer upload path, a concurrent backfill) may have
          // filled dims since we queued — don't trample.
          if (resolveAttachmentAspectRatio(current)) continue;
          attachments[idx] = { ...current, width: job.w, height: job.h };
          const updatedContent = withAttachmentsMarker(String(note.content), attachments);
          // Lost-update guard: only commit if the row hasn't changed since
          // we read it, so we never clobber a concurrent edit / description
          // backfill writing the same row.
          const { error } = await vaultWrites.updateIfUnchanged(
            job.noteId,
            { content: updatedContent },
            note.updated_at,
          );
          if (error) continue;
          // Intentionally NOT updating the in-memory notes here. Feeding the
          // freshly-learned dims back into the live card would change its
          // masonry height estimate and could re-bucket it into a different
          // column WHILE the user is looking — the exact jump we're killing.
          // The DB now has the dims; the NEXT cold load reserves the true
          // aspect from first paint. Within this session the already-resolved
          // image is shift-free via learnedImageDimsRef.
          // Gentle pacing so a freshly-opened vault full of legacy images
          // doesn't fire dozens of writes in the same tick.
          await new Promise((r) => setTimeout(r, 400));
        } catch {
          // best-effort — a failed backfill just leaves the old behaviour
          // for that one card; we'll retry next session.
        }
      }
    } finally {
      persistDimsDrainingRef.current = false;
    }
  }, [user?.id]);

  const queuePersistAttachmentDims = useCallback(
    (card, w, h) => {
      if (!card?.noteId || card.kind !== "attachment") return;
      if (!(w > 0) || !(h > 0)) return;
      // Skip connector-synced / demo / ghost cards and anything that already
      // carries usable dimensions.
      if (card.ghost || card.isDemo) return;
      if (resolveAttachmentAspectRatio(card.attachment)) return;
      if (persistDimsAttemptedRef.current.has(card.id)) return;
      persistDimsAttemptedRef.current.add(card.id);
      persistDimsQueueRef.current.push({
        noteId: card.noteId,
        attachmentIndex: card.attachmentIndex ?? 0,
        w: Math.round(w),
        h: Math.round(h),
      });
      void drainPersistDimsQueue();
    },
    [drainPersistDimsQueue]
  );

  // Tab-refocus recovery -------------------------------------------------
  // If the user leaves a vault tab open for hours/days and comes back,
  // every cached signed URL is likely either expired or about to expire.
  // The on-demand `readCachedSignedUrl` expiry check covers most reads,
  // but cards already mounted with their (now-stale) URL won't refetch
  // on their own — they only retry on a 4xx, and even then they burn
  // through their bounded retry budget. This effect makes refocus
  // recovery deterministic: if the tab was hidden for >2 minutes we
  // wipe the URL cache + retry counts and force currently-visible
  // attachment cards back through `resolveSignedUrlForCard` so they
  // pick up fresh URLs immediately.
  useEffect(() => {
    if (!user?.id) return;
    let hiddenAt = null;
    const STALE_AFTER_MS = 2 * 60 * 1000;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      if (document.visibilityState !== "visible" || hiddenAt === null) return;
      const wasHiddenFor = Date.now() - hiddenAt;
      hiddenAt = null;
      if (wasHiddenFor < STALE_AFTER_MS) return;
      // Drop every cached signed URL — most are stale and the cost of
      // re-signing the still-fresh ones is negligible compared to the
      // UX cost of showing broken/expired images.
      signedUrlCacheRef.current.clear();
      // Forgive the retry budget so users get a clean slate after
      // returning to the tab.
      imageRetryCountsRef.current.clear();
      const failedIdsToRequeue = Array.from(failedImageIds);
      if (failedIdsToRequeue.length > 0) {
        setFailedImageIds(new Set());
      }
      // Re-queue every currently-visible attachment card so the new
      // signed URLs land before the user notices anything is wrong.
      const cardsByIdLocal = new Map(vaultCards.map((c) => [c.id, c]));
      const visibleIds = new Set([...visibleCardIdsRef.current, ...failedIdsToRequeue]);
      let queued = false;
      for (const id of visibleIds) {
        const card = cardsByIdLocal.get(id);
        if (!card || card.kind !== "attachment") continue;
        // Drop any stale resolved URL so the next render either shows
        // the spinner (briefly) or, more often, the image just swaps
        // to the fresh URL the moment `setResolvedAttachmentUrls`
        // fires — no broken-image flash in between.
        setResolvedAttachmentUrls((prev) => {
          if (!(card.id in prev)) return prev;
          const next = { ...prev };
          delete next[card.id];
          return next;
        });
        visibleCardIdsRef.current.delete(card.id);
        visibleCardIdsRef.current.add(card.id);
        urlResolveQueueRef.current.push(card);
        queued = true;
      }
      if (queued) drainUrlResolveQueue();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
    // (react-hooks/exhaustive-deps is intentionally not satisfied here; the
    // rule is not configured for src/hooks, so no disable directive needed.)
  }, [user?.id, vaultCards, drainUrlResolveQueue, failedImageIds]);

  return {
    // resolved values consumed by the render paths
    resolvedAttachmentUrls,
    setResolvedAttachmentUrls,
    resolvedVideoPosterUrls,
    setResolvedVideoPosterUrls,
    driveMarkup,
    failedImageIds,
    setFailedImageIds,
    // caches / bookkeeping shared with the page's retry, eager-preload and
    // backfill paths (identity preserved -- these are the same refs)
    signedUrlCacheRef,
    imageRetryCountsRef,
    visibleCardIdsRef,
    urlResolveQueueRef,
    learnedImageDimsRef,
    preDecodedUrlsRef,
    cardElementsRef,
    // behavior
    registerCardRef,
    resolveSignedUrlForCard,
    resolveDriveMarkupForCard,
    drainUrlResolveQueue,
    queuePersistAttachmentDims,
  };
}
