export const WAKE_VAULT_PREVIEW_QUICK_NOTES_KEY = "lykn_wake_vault_preview_quick_notes";

/** @typedef {{ id: string; content: string; createdAt: string }} WakeVaultPreviewQuickNote */

/** @returns {WakeVaultPreviewQuickNote[]} */
export function readWakeVaultPreviewQuickNotes() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(WAKE_VAULT_PREVIEW_QUICK_NOTES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.content === "string" &&
        item.content.trim(),
    );
  } catch {
    return [];
  }
}

/** @param {WakeVaultPreviewQuickNote[]} notes */
function writeWakeVaultPreviewQuickNotes(notes) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      WAKE_VAULT_PREVIEW_QUICK_NOTES_KEY,
      JSON.stringify(notes),
    );
  } catch {
    /* ignore quota / private mode */
  }
}

/** @param {string} content @returns {WakeVaultPreviewQuickNote} */
export function appendWakeVaultPreviewQuickNote(content) {
  const trimmed = String(content || "").trim();
  const note = {
    id: `wake-preview-qnote-${crypto.randomUUID()}`,
    content: trimmed,
    createdAt: new Date().toISOString(),
  };
  const next = [note, ...readWakeVaultPreviewQuickNotes()];
  writeWakeVaultPreviewQuickNotes(next);
  return note;
}

/** @param {WakeVaultPreviewQuickNote} note */
export function buildWakePreviewUserQuickNoteCard(note) {
  return {
    id: note.id,
    kind: "quick-note",
    isDemo: false,
    isWakePreviewNote: true,
    title: "Quick Note",
    excerpt: note.content,
    dateLabel: "Just now",
    tags: [],
    comments: [],
    source: "quick_note",
    lastTouchedMs: Date.parse(note.createdAt) || Date.now(),
  };
}

/** @param {WakeVaultPreviewQuickNote[]} notes */
export function buildWakePreviewUserQuickNoteCards(notes) {
  return (notes || []).map(buildWakePreviewUserQuickNoteCard);
}

/** @param {string} noteId */
export function removeWakeVaultPreviewQuickNote(noteId) {
  const id = String(noteId || "");
  if (!id) return;
  const next = readWakeVaultPreviewQuickNotes().filter((note) => note.id !== id);
  writeWakeVaultPreviewQuickNotes(next);
}
