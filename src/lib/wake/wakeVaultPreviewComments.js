export const WAKE_VAULT_PREVIEW_COMMENTS_KEY = "lykn_wake_vault_preview_comments";

/** @typedef {{ id: string; text: string; created_at: string }} WakeVaultPreviewComment */

/** @returns {Record<string, WakeVaultPreviewComment[]>} */
export function readWakeVaultPreviewComments() {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(WAKE_VAULT_PREVIEW_COMMENTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    /** @type {Record<string, WakeVaultPreviewComment[]>} */
    const out = {};
    for (const [cardId, items] of Object.entries(parsed)) {
      if (!Array.isArray(items)) continue;
      const comments = items
        .filter(
          (item) =>
            item &&
            typeof item.id === "string" &&
            typeof item.text === "string" &&
            item.text.trim(),
        )
        .map((item) => ({
          id: item.id,
          text: item.text.trim(),
          created_at: item.created_at || new Date().toISOString(),
        }));
      if (comments.length > 0) out[cardId] = comments;
    }
    return out;
  } catch {
    return {};
  }
}

/** @param {Record<string, WakeVaultPreviewComment[]>} map */
function writeWakeVaultPreviewComments(map) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      WAKE_VAULT_PREVIEW_COMMENTS_KEY,
      JSON.stringify(map),
    );
  } catch {
    /* ignore quota / private mode */
  }
}

/** @param {string} cardId @param {string} text @returns {WakeVaultPreviewComment} */
export function appendWakeVaultPreviewComment(cardId, text) {
  const trimmed = String(text || "").trim();
  const comment = {
    id: `wake-preview-comment-${crypto.randomUUID()}`,
    text: trimmed,
    created_at: new Date().toISOString(),
  };
  const all = readWakeVaultPreviewComments();
  const nextForCard = [...(all[cardId] || []), comment];
  writeWakeVaultPreviewComments({ ...all, [cardId]: nextForCard });
  return comment;
}

function parseAttachmentNotes(attachment = {}) {
  const raw = Array.isArray(attachment?.notes) ? attachment.notes : [];
  return raw
    .map((item, idx) => {
      const noteText = String(item?.text || "").trim();
      if (!noteText) return null;
      return {
        id: String(item?.id || `note-${idx}`),
        text: noteText,
        created_at: item?.created_at || null,
      };
    })
    .filter(Boolean);
}

function parseQuickNoteCardComments(comments = []) {
  if (!Array.isArray(comments)) return [];
  return comments
    .map((item, idx) => {
      const noteText = String(item?.text || "").trim();
      if (!noteText) return null;
      return {
        id: String(item?.id || `comment-${idx}`),
        text: noteText,
        created_at: item?.created_at || null,
      };
    })
    .filter(Boolean);
}

/** @param {Record<string, WakeVaultPreviewComment[]>} previewCommentsByCardId */
export function applyWakePreviewCommentsToCard(card, previewCommentsByCardId) {
  const added = previewCommentsByCardId?.[card?.id];
  if (!card?.id || !Array.isArray(added) || added.length === 0) return card;

  if (card.kind === "attachment") {
    const existing = parseAttachmentNotes(card.attachment);
    return {
      ...card,
      attachment: {
        ...card.attachment,
        notes: [...existing, ...added],
      },
    };
  }

  if (card.kind === "quick-note") {
    const existing = parseQuickNoteCardComments(card.comments);
    return {
      ...card,
      comments: [...existing, ...added],
    };
  }

  return card;
}
