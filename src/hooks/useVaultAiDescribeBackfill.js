// Background AI enrichment: describe undescribed vault attachments (vision
// for images/videos, text summaries otherwise) and persist the description
// into the attachment marker with a lost-update guard. Extracted from
// `src/pages/Vault.jsx`.
import { useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase";
import {
  findAttachmentsMarker,
  withAttachmentsMarker,
} from "@/lib/vault/attachmentsMarker";

/**
 * @param {object} params
 * @param {object|null} params.user
 * @param {boolean} params.isLoadingNotes
 * @param {Array} params.vaultCards
 * @param {object} params.resolvedAttachmentUrls from useVaultSignedUrls
 * @param {Set} params.failedImageIds from useVaultSignedUrls
 * @param {object} params.visibleCardIdsRef from useVaultSignedUrls
 * @param {object} params.vaultWrites
 * @param {Function} params.setNotes
 */
export function useVaultAiDescribeBackfill({
  user,
  isLoadingNotes,
  vaultCards,
  resolvedAttachmentUrls,
  failedImageIds,
  visibleCardIdsRef,
  vaultWrites,
  setNotes,
}) {
  const backfillDescribedRef = useRef(new Set());
  const backfillRunningRef = useRef(false);

  useEffect(() => {
    if (!user?.id || isLoadingNotes || backfillRunningRef.current) return;

    const undescribed = vaultCards.filter(
      (card) =>
        card.kind === "attachment" &&
        card.noteId &&
        !card.attachment?.aiDescription &&
        !backfillDescribedRef.current.has(card.id) &&
        !failedImageIds.has(card.id)
    );
    if (undescribed.length === 0) return;

    const pendingAttachments = vaultCards.filter(
      (c) => c.kind === "attachment" && !resolvedAttachmentUrls[c.id] && !failedImageIds.has(c.id) && visibleCardIdsRef.current.has(c.id)
    );
    if (pendingAttachments.length > 0) return;

    let cancelled = false;
    backfillRunningRef.current = true;

    (async () => {
      const { API_BASE_URL } = await import("@/lib/api-config");
      const batch = undescribed.slice(0, 5);

      for (const card of batch) {
        if (cancelled) break;
        backfillDescribedRef.current.add(card.id);

        const att = card.attachment || {};
        const isVisual = card.type === "image" || card.type === "video";
        const hasResolvedUrl = !!resolvedAttachmentUrls[card.id];
        if (isVisual && !hasResolvedUrl) continue;
        const rawUrl = resolvedAttachmentUrls[card.id] || att.url || "";
        const imageUrl = isVisual && rawUrl && !rawUrl.startsWith("data:") ? rawUrl : undefined;
        const textContent = att.extractedText || att.articleText || att.description || "";
        const fileName = att.name || card.title || "";

        if (!imageUrl && !textContent && !fileName) continue;

        try {
          const session = (await supabase.auth.getSession())?.data?.session;
          const token = session?.access_token;
          if (!token) continue;
          const res = await fetch(`${API_BASE_URL}/api/ai/describe-image`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              imageUrl,
              textContent: textContent ? textContent.slice(0, 5000) : undefined,
              fileType: card.type,
              fileName,
            }),
          });
          if (!res.ok) continue;
          const { description } = await res.json();
          if (!description || cancelled) continue;

          // Fetch with `updated_at` so we can guard against trampling user
          // edits made between the AI request and the persist below.
          const { data: note } = await vaultWrites.readForUpdate(card.noteId);
          if (!note?.content) continue;

          const span = findAttachmentsMarker(String(note.content));
          if (!span) continue;

          const attachments = span.attachments.slice();
          const attIdx = card.attachmentIndex ?? 0;
          if (!attachments[attIdx] || typeof attachments[attIdx] !== "object") continue;
          attachments[attIdx] = { ...attachments[attIdx], aiDescription: description };

          const updatedContent = withAttachmentsMarker(String(note.content), attachments);

          // Lost-update guard: only commit if the row hasn't been updated
          // since we read it.
          const { error: updateError } = await vaultWrites.updateIfUnchanged(
            card.noteId,
            { content: updatedContent },
            note.updated_at,
          );
          if (updateError) continue;

          if (!cancelled) {
            setNotes((prev) =>
              prev.map((n) => (String(n.id) === String(card.noteId) ? { ...n, content: updatedContent } : n))
            );
          }

          await new Promise((r) => setTimeout(r, 2000));
        } catch {
          // best-effort backfill
        }
      }

      backfillRunningRef.current = false;
    })();

    return () => { cancelled = true; backfillRunningRef.current = false; };
    // (react-hooks/exhaustive-deps intentionally not satisfied; see comment above.)
  }, [vaultCards, user?.id, isLoadingNotes, resolvedAttachmentUrls, failedImageIds]);
}
