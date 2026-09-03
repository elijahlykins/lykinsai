// Vault preview controller: the open preview card and its sub-surfaces
// (details, share menu, project dropdown, inline comment composer), the
// lightbox full-resolution re-sign, Escape handling, external open/expand
// (including the branded HTML-artifact proxy), share actions, and the
// "chat about this" handoff. Extracted from `src/pages/Vault.jsx`; the
// preview UI itself stays in VaultPreviewOverlay.
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { safeExternalUrl, safeAttachmentUrl } from "@/lib/safeExternalUrl";
import { parseStorageTarget } from "@/lib/vault/vaultCardHelpers";
import { looksLikeImageAttachment } from "@/lib/vault/attachmentType";
import {
  SIGNED_URL_TTL_SECONDS,
  readCachedSignedUrl,
  writeCachedSignedUrl,
} from "@/lib/vault/signedUrlCache";
import { resolveAttachmentType, buildEmbeddedVaultPayload } from "@/lib/vault/vaultCardModel";
import { toast } from "@/components/ui/use-toast";

/**
 * @param {object} params
 * @param {object|null} params.previewCard page-owned: useVaultSignedUrls and
 *   useVaultDriveWindow also read the open preview card, so the state lives
 *   in the page and this controller owns everything around it.
 * @param {Function} params.setPreviewCard
 * @param {boolean} params.isEmbeddedMode
 * @param {string} params.embeddedTargetOrigin
 * @param {boolean} params.studioSurface
 * @param {Function} params.nav react-router navigate
 * @param {Array} params.notes for the share-text "Why I saved this" lookup
 * @param {object} params.resolvedAttachmentUrls from useVaultSignedUrls
 * @param {Function} params.setResolvedAttachmentUrls
 * @param {object} params.signedUrlCacheRef
 * @param {object} params.urlResolveQueueRef
 * @param {Function} params.drainUrlResolveQueue
 * @param {Function} params.setFailedImageIds
 */
export function useVaultPreview({
  previewCard,
  setPreviewCard,
  isEmbeddedMode,
  embeddedTargetOrigin,
  studioSurface,
  nav,
  notes,
  resolvedAttachmentUrls,
  setResolvedAttachmentUrls,
  signedUrlCacheRef,
  urlResolveQueueRef,
  drainUrlResolveQueue,
  setFailedImageIds,
}) {
  const [previewDetailsOpen, setPreviewDetailsOpen] = useState(false);
  // Share sheet anchored to the preview modal's Share button.
  const [previewShareMenuRect, setPreviewShareMenuRect] = useState(null);
  const [previewProjectDropdownOpen, setPreviewProjectDropdownOpen] = useState(false);
  // Inline comment composer under "Why I saved this" in the pulled-up card.
  const [previewCommentComposerOpen, setPreviewCommentComposerOpen] = useState(false);
  const [previewCommentDraft, setPreviewCommentDraft] = useState("");
  const [previewEditingCommentId, setPreviewEditingCommentId] = useState(null);
  // Full-res signed URL for the open lightbox (original storage object).
  // Grid tiles use the medium variant; opening an image upgrades to original
  // so expanded viewing stays sharp on retina.
  const [previewFullUrl, setPreviewFullUrl] = useState(null);
  // DOM anchors for the share menu and project dropdown, so the page's
  // click-away handler can tell inside-clicks from dismissals.
  const previewShareMenuRef = useRef(null);
  const previewProjectDropdownRef = useRef(null);

  useEffect(() => {
    if (!previewCard) {
      setPreviewShareMenuRect(null);
      setPreviewProjectDropdownOpen(false);
      setPreviewCommentComposerOpen(false);
      setPreviewCommentDraft("");
      setPreviewEditingCommentId(null);
      return;
    }
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (previewShareMenuRect) {
        setPreviewShareMenuRect(null);
        return;
      }
      if (previewProjectDropdownOpen) {
        setPreviewProjectDropdownOpen(false);
        return;
      }
      if (previewCommentComposerOpen || previewEditingCommentId) {
        setPreviewCommentComposerOpen(false);
        setPreviewCommentDraft("");
        setPreviewEditingCommentId(null);
        return;
      }
      setPreviewCard(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewCard, previewShareMenuRect, previewProjectDropdownOpen, previewCommentComposerOpen, previewEditingCommentId]);

  // Lightbox: re-sign storage images whenever preview opens. Never rely on a
  // stale `attachment.url` (expired signed URL) as the <img> src — that path
  // is what left users staring at a supabase link / blank "Image" tile.
  useEffect(() => {
    if (!previewCard || previewCard.kind !== "attachment") {
      setPreviewFullUrl(null);
      return undefined;
    }
    const att = previewCard.attachment || {};
    const isImage =
      resolveAttachmentType(att) === "image" || looksLikeImageAttachment(att);
    if (!isImage) {
      setPreviewFullUrl(null);
      return undefined;
    }

    // Clear a prior failure so opening the card always retries.
    setFailedImageIds((prev) => {
      if (!prev.has(previewCard.id)) return prev;
      const next = new Set(prev);
      next.delete(previewCard.id);
      return next;
    });

    const original = parseStorageTarget(att);
    const medium = parseStorageTarget(att, "medium");
    const targets = [original, medium].filter(
      (t, i, arr) => t?.bucket && t?.path && arr.findIndex((x) => x.path === t.path) === i,
    );
    if (targets.length === 0) {
      setPreviewFullUrl(null);
      // Still try the grid resolver — it may recover from url parsing.
      urlResolveQueueRef.current.push(previewCard);
      drainUrlResolveQueue();
      return undefined;
    }

    let cancelled = false;
    setPreviewFullUrl(null);

    (async () => {
      for (const target of targets) {
        if (cancelled) return;
        const cacheKey = `full:${target.bucket}:${target.path}`;
        const cached = readCachedSignedUrl(signedUrlCacheRef.current, cacheKey);
        if (cached) {
          setPreviewFullUrl(cached);
          setResolvedAttachmentUrls((prev) =>
            prev[previewCard.id] ? prev : { ...prev, [previewCard.id]: cached },
          );
          return;
        }
        try {
          const { data, error } = await supabase.storage
            .from(target.bucket)
            .createSignedUrl(target.path, SIGNED_URL_TTL_SECONDS);
          if (!error && data?.signedUrl) {
            writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, data.signedUrl);
            if (cancelled) return;
            setPreviewFullUrl(data.signedUrl);
            setResolvedAttachmentUrls((prev) => ({
              ...prev,
              [previewCard.id]: data.signedUrl,
            }));
            return;
          }
        } catch {
          /* try next target */
        }
      }
      if (!cancelled) {
        // Last resort: grid resolve pipeline (medium prefer + server fallback).
        urlResolveQueueRef.current.push({ ...previewCard, attachment: att });
        drainUrlResolveQueue();
      }
    })();

    return () => {
      cancelled = true;
    };
    // (react-hooks/exhaustive-deps intentionally not satisfied; see comment above.)
  }, [previewCard, drainUrlResolveQueue]);

  // ─── Open / expand externally ────────────────────────────────────────

  const openUrlInSystemBrowser = useCallback((url) => {
    const safe = safeAttachmentUrl(url) || safeExternalUrl(url);
    if (!safe || !/^https?:\/\//i.test(safe)) return false;
    try {
      if (typeof window.lykn?.openExternal === "function") {
        window.lykn.openExternal(safe);
        return true;
      }
    } catch {
      /* fall through to window.open */
    }
    const win = window.open(safe, "_blank", "noopener,noreferrer");
    return !!win;
  }, []);

  // Mint (or reuse) a branded file-proxy URL so HTML artifacts render with the
  // right MIME/CSP in an external browser tab — not a blank Supabase storage URL.
  const resolveHtmlArtifactOpenUrl = useCallback(async (card) => {
    if (!card || card.kind !== "attachment") return "";
    const existing = resolvedAttachmentUrls[card.id];
    if (existing && !/supabase\.co\/storage\//i.test(existing)) return existing;

    const target = parseStorageTarget(card.attachment || {});
    if (!target?.path || !target?.bucket) {
      const raw = String(card.attachment?.url || "").trim();
      if (raw && !/supabase\.co\/storage\//i.test(raw)) return raw;
      return "";
    }

    const cacheKey = `file-proxy:${target.bucket}:${target.path}`;
    const cachedFresh = readCachedSignedUrl(signedUrlCacheRef.current, cacheKey);
    if (cachedFresh && !/supabase\.co\/storage\//i.test(cachedFresh)) {
      setResolvedAttachmentUrls((prev) => (
        prev[card.id] === cachedFresh ? prev : { ...prev, [card.id]: cachedFresh }
      ));
      return cachedFresh;
    }

    try {
      const { API_BASE_URL } = await import("@/lib/api-config");
      const session = (await supabase.auth.getSession())?.data?.session;
      const token = session?.access_token;
      if (!token) return "";
      const resp = await fetch(`${API_BASE_URL}/api/storage/file-proxy-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          storagePath: target.path,
          bucket: target.bucket,
          filename: String(card.attachment?.name || "artifact.html"),
        }),
      });
      if (!resp.ok) return "";
      const { url } = await resp.json();
      if (!url || /supabase\.co\/storage\//i.test(url)) return "";
      writeCachedSignedUrl(signedUrlCacheRef.current, cacheKey, url);
      setResolvedAttachmentUrls((prev) => ({ ...prev, [card.id]: url }));
      return url;
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[Vault] Artifact browser URL mint failed:", err);
      return "";
    }
    // (react-hooks/exhaustive-deps intentionally not satisfied; see comment above.)
  }, [resolvedAttachmentUrls]);

  const openVaultArtifactInBrowser = useCallback(async (card) => {
    const url = await resolveHtmlArtifactOpenUrl(card);
    if (!url || !openUrlInSystemBrowser(url)) {
      toast({
        title: "Couldn't open artifact",
        description: "Try again in a moment.",
      });
      return false;
    }
    return true;
  }, [resolveHtmlArtifactOpenUrl, openUrlInSystemBrowser]);

  // Preview "Expand" — open the full item in a separate browser/system window.
  // Card click stays in the in-app view mode for every type (including HTML).
  const openCardFullyInBrowser = useCallback(async (card) => {
    if (!card) return false;
    if (card.kind === "attachment") {
      const att = card.attachment || {};
      const t = resolveAttachmentType(att) || card.type;
      if (t === "html") return openVaultArtifactInBrowser(card);
      if (t === "youtube" || t === "bookmark" || t === "link") {
        const url = String(att.url || "").trim();
        if (!url || !openUrlInSystemBrowser(url)) {
          toast({ title: "Couldn't open", description: "No link available for this item." });
          return false;
        }
        return true;
      }
      const target = parseStorageTarget(att);
      let url = "";
      if (target?.bucket && target?.path) {
        try {
          const { data } = await supabase.storage
            .from(target.bucket)
            .createSignedUrl(target.path, SIGNED_URL_TTL_SECONDS);
          url = data?.signedUrl || "";
        } catch {
          /* fall through */
        }
      }
      if (!url) url = resolvedAttachmentUrls[card.id] || String(att.url || "").trim();
      if (!url || !openUrlInSystemBrowser(url)) {
        toast({ title: "Couldn't open", description: "Try again in a moment." });
        return false;
      }
      return true;
    }
    toast({
      title: "Already open",
      description: "This item is shown in the preview. There's no separate page to expand.",
    });
    return false;
  }, [openVaultArtifactInBrowser, openUrlInSystemBrowser, resolvedAttachmentUrls]);

  // "Chat about this" — hand the preview card to whichever chat surface
  // opened the vault (embedded sidebar, Studio home bar, or the /app page).
  const chatAboutPreviewCard = useCallback((card) => {
    const payload = buildEmbeddedVaultPayload(card, resolvedAttachmentUrls);
    if (!payload) {
      toast({ title: "Couldn't open chat", description: "This item can't be added to chat." });
      return;
    }
    if (isEmbeddedMode) {
      try {
        window.parent.postMessage({ type: "lykn-chat-vault-add", data: payload }, embeddedTargetOrigin);
      } catch {
        /* ignore */
      }
      setPreviewCard(null);
      return;
    }
    setPreviewCard(null);
    if (studioSurface) {
      // The Studio-owned Home bar receives and visibly holds this payload; it
      // hands it to the real chat surface only when the user sends.
      window.dispatchEvent(
        new CustomEvent("lykn-studio-open-chat", {
          detail: {
            src: `/app?vault=${Date.now()}`,
            dismissApp: "vault",
            forceHome: true,
            vaultPayload: payload,
          },
        }),
      );
      return;
    }
    try {
      sessionStorage.setItem("lykn_pending_vault_chat_add", JSON.stringify({ ...payload, timestamp: Date.now() }));
    } catch {
      /* ignore */
    }
    nav("/app");
  }, [resolvedAttachmentUrls, isEmbeddedMode, embeddedTargetOrigin, nav, studioSurface]);

  // ─── Share actions ───────────────────────────────────────────────────

  const resolvePreviewShareUrl = useCallback((card, urlHint = "") => {
    const url = String(urlHint || card?.attachment?.url || "").trim();
    return safeAttachmentUrl(url) || safeExternalUrl(url) || "";
  }, []);

  const resolvePreviewShareText = useCallback((card) => {
    const title = String(card?.title || card?.label || "").trim();
    const body = String(card?.body || card?.excerpt || card?.question || "").trim();
    const whyNote = card?.noteId
      ? notes.find((n) => String(n?.id) === String(card.noteId))
      : null;
    const why = String(whyNote?.why || "").trim();
    const parts = [title, body, why ? `Why I saved this:\n${why}` : ""].filter(Boolean);
    return parts.join("\n\n").trim();
  }, [notes]);

  const sharePreviewNative = useCallback(async (card, urlHint = "") => {
    const title = String(card?.title || "LYKN vault item");
    const safe = resolvePreviewShareUrl(card, urlHint);
    const text = resolvePreviewShareText(card);
    try {
      if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
        await navigator.share({
          title,
          ...(safe ? { url: safe } : {}),
          ...(text ? { text } : !safe ? { text: title } : {}),
        });
        setPreviewShareMenuRect(null);
        return;
      }
    } catch (err) {
      if (err?.name === "AbortError") return;
    }
    toast({ title: "Share unavailable", description: "Use Copy link or Download instead." });
  }, [resolvePreviewShareUrl, resolvePreviewShareText]);

  const sharePreviewCopyLink = useCallback(async (card, urlHint = "") => {
    const safe = resolvePreviewShareUrl(card, urlHint);
    if (!safe) {
      toast({ title: "No link", description: "This item doesn't have a shareable link." });
      return;
    }
    try {
      await navigator.clipboard.writeText(safe);
      toast({ title: "Link copied" });
      setPreviewShareMenuRect(null);
    } catch {
      toast({ title: "Couldn't copy", description: "Copy the link manually instead." });
    }
  }, [resolvePreviewShareUrl]);

  const sharePreviewCopyText = useCallback(async (card) => {
    const text = resolvePreviewShareText(card);
    if (!text) {
      toast({ title: "Nothing to copy", description: "This item has no text to copy." });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Text copied" });
      setPreviewShareMenuRect(null);
    } catch {
      toast({ title: "Couldn't copy" });
    }
  }, [resolvePreviewShareText]);

  const sharePreviewOpenLink = useCallback((card, urlHint = "") => {
    const safe = resolvePreviewShareUrl(card, urlHint);
    if (!safe) {
      toast({ title: "No link", description: "This item doesn't have a link to open." });
      return;
    }
    openUrlInSystemBrowser(safe);
    setPreviewShareMenuRect(null);
  }, [resolvePreviewShareUrl, openUrlInSystemBrowser]);

  const sharePreviewDownload = useCallback(async (card, urlHint = "") => {
    const safe = resolvePreviewShareUrl(card, urlHint);
    const filename = String(card?.attachment?.name || card?.title || "lykn-download")
      .replace(/[^\w.\- ()[\]]+/g, "_")
      .slice(0, 120);
    if (!safe) {
      toast({ title: "Can't download", description: "This item doesn't have a downloadable file." });
      return;
    }
    try {
      const res = await fetch(safe);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename || "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
      toast({ title: "Download started" });
      setPreviewShareMenuRect(null);
    } catch {
      openUrlInSystemBrowser(safe);
      setPreviewShareMenuRect(null);
    }
  }, [resolvePreviewShareUrl, openUrlInSystemBrowser]);

  return {
    previewDetailsOpen,
    setPreviewDetailsOpen,
    previewShareMenuRect,
    setPreviewShareMenuRect,
    previewProjectDropdownOpen,
    setPreviewProjectDropdownOpen,
    previewCommentComposerOpen,
    setPreviewCommentComposerOpen,
    previewCommentDraft,
    setPreviewCommentDraft,
    previewEditingCommentId,
    setPreviewEditingCommentId,
    previewFullUrl,
    setPreviewFullUrl,
    previewShareMenuRef,
    previewProjectDropdownRef,
    openUrlInSystemBrowser,
    resolveHtmlArtifactOpenUrl,
    openVaultArtifactInBrowser,
    openCardFullyInBrowser,
    chatAboutPreviewCard,
    resolvePreviewShareUrl,
    resolvePreviewShareText,
    sharePreviewNative,
    sharePreviewCopyLink,
    sharePreviewCopyText,
    sharePreviewOpenLink,
    sharePreviewDownload,
  };
}
