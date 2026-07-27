export const WAKE_VAULT_PREVIEW_COMMENTS_KEY = "lykn_wake_vault_preview_comments";
export const WAKE_VAULT_PREVIEW_DELETED_COMMENTS_KEY = "lykn_wake_vault_preview_deleted_comments";

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

/** @returns {Record<string, string[]>} */
export function readWakeVaultPreviewDeletedComments() {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(WAKE_VAULT_PREVIEW_DELETED_COMMENTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    /** @type {Record<string, string[]>} */
    const out = {};
    for (const [cardId, items] of Object.entries(parsed)) {
      if (!Array.isArray(items)) continue;
      const ids = items.filter((id) => typeof id === "string" && id);
      if (ids.length > 0) out[cardId] = ids;
    }
    return out;
  } catch {
    return {};
  }
}

/** @param {Record<string, string[]>} map */
function writeWakeVaultPreviewDeletedComments(map) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      WAKE_VAULT_PREVIEW_DELETED_COMMENTS_KEY,
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

/** @param {string} cardId @param {string} commentId @returns {boolean} */
export function removeWakeVaultPreviewComment(cardId, commentId) {
  if (!cardId || !commentId) return false;
  const all = readWakeVaultPreviewComments();
  const existing = all[cardId] || [];
  const nextForCard = existing.filter((c) => c.id !== commentId);
  if (nextForCard.length === 0) {
    const next = { ...all };
    delete next[cardId];
    writeWakeVaultPreviewComments(next);
  } else {
    writeWakeVaultPreviewComments({ ...all, [cardId]: nextForCard });
  }

  // Also record the id so baked-in demo comments disappear for this session.
  const deleted = readWakeVaultPreviewDeletedComments();
  const nextDeleted = Array.from(new Set([...(deleted[cardId] || []), commentId]));
  writeWakeVaultPreviewDeletedComments({ ...deleted, [cardId]: nextDeleted });
  return true;
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

/**
 * @param {Record<string, WakeVaultPreviewComment[]>} previewCommentsByCardId
 * @param {Record<string, string[]>} [deletedCommentIdsByCardId]
 */
export function applyWakePreviewCommentsToCard(
  card,
  previewCommentsByCardId,
  deletedCommentIdsByCardId = {},
) {
  if (!card?.id) return card;
  const added = previewCommentsByCardId?.[card.id];
  const deleted = new Set(deletedCommentIdsByCardId?.[card.id] || []);
  const hasAdded = Array.isArray(added) && added.length > 0;
  if (!hasAdded && deleted.size === 0) return card;

  if (card.kind === "attachment") {
    const existing = parseAttachmentNotes(card.attachment);
    const notes = [...existing, ...(hasAdded ? added : [])].filter(
      (entry) => !deleted.has(entry.id),
    );
    return {
      ...card,
      attachment: {
        ...card.attachment,
        notes,
      },
    };
  }

  if (card.kind === "quick-note") {
    const existing = parseQuickNoteCardComments(card.comments);
    const comments = [...existing, ...(hasAdded ? added : [])].filter(
      (entry) => !deleted.has(entry.id),
    );
    return {
      ...card,
      comments,
    };
  }

  return card;
}
