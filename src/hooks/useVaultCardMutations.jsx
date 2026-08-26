// useVaultCardMutations owns every per-card write path in the Vault: delete
// (single, confirmed, and bulk with the undo grace window), project
// membership add/remove, attachment notes and quick-note comments (add /
// edit / remove), the "why I saved this" field, and the wake-preview local
// comment equivalents. Extracted verbatim from src/pages/Vault.jsx (Vault
// decomposition phase, see docs/REFACTOR_LOG.md). All writes go through
// vaultWrites and mirror into the notes cache via setNotes.
import { useCallback, useState } from "react";
import { supabase } from "@/lib/supabase";
import { AI_DRIVE_FOLDER, clearAiDriveCache } from "@/lib/vault/aiDriveContents";
import { isLocalTarget } from "@/lib/vault/repository";
import { toast } from "@/components/ui/use-toast";
import { ToastAction } from "@/components/ui/toast";
import {
  addNeuronsToProject,
  listUserProjects,
  removeNeuronFromProject,
} from "@/lib/userProjects";
import { notifyVaultCapIfApplicable } from "@/lib/vault/vaultCapError";
import { purgeVaultNoteEmbeddings } from "@/lib/synthesis/queueReindex";
import { parseAttachmentsFromNote } from "@/lib/vault/attachmentsMarker";
import {
  parseAttachmentNotes,
  parseQuickNoteComments,
  parseStorageTarget,
  withAttachmentJsonMarker,
} from "@/lib/vault/vaultCardHelpers";
import {
  appendWakeVaultPreviewComment,
  removeWakeVaultPreviewComment,
} from "@/lib/wake/wakeVaultPreviewComments";

export function useVaultCardMutations({
  user,
  notes,
  setNotes,
  vaultWrites,
  vaultQueryClient,
  projects,
  invalidateVaultProjects,
  selectedCardIds,
  vaultCardsRef,
  isSelectableCard,
  clearSelection,
  pendingDeleteCardIds,
  setPendingDeleteCardIds,
  pendingDeleteTimersRef,
  TRASH_UNDO_GRACE_MS,
  setOpenCardMenuId,
  setPreviewProjectDropdownOpen,
  setWakePreviewCardComments,
  setWakePreviewDeletedComments,
}) {
  // True while a card write is in flight; drives the busy state on card
  // menus and the preview overlay actions.
  const [isCardActionBusy, setIsCardActionBusy] = useState(false);

  const vaultMemberFromCard = useCallback((card) => {
    const noteId = card?.noteId;
    if (!noteId) return null;
    return {
      nodeId: `vault_${noteId}`,
      label: String(card.title || (card.kind === "quick-note" ? "Quick Note" : "Vault item")).trim() || "Vault item",
      kind: "vault",
    };
  }, []);

  const removeCardFromProjects = useCallback(async (card) => {
    const member = vaultMemberFromCard(card);
    if (!member) return;
    const userId = user?.id || null;
    const list = Array.isArray(projects) && projects.length > 0
      ? projects
      : await listUserProjects(userId);
    const containing = list.filter(
      (p) => Array.isArray(p.members) && p.members.some((m) => m.nodeId === member.nodeId)
    );
    if (containing.length === 0) return;
    await Promise.all(
      containing.map((p) => removeNeuronFromProject(userId, p.id, member.nodeId))
    );
    invalidateVaultProjects();
  }, [invalidateVaultProjects, projects, user?.id, vaultMemberFromCard]);

  const removeAttachmentFromNote = useCallback(async (card) => {
    if (!user?.id || !card?.noteId) return;
    setIsCardActionBusy(true);
    try {
      const note = notes.find((n) => String(n?.id) === String(card.noteId));
      if (!note) return;
      const attachments = parseAttachmentsFromNote(note);
      const idx = Number(card.attachmentIndex);

      // Synthetic tiles built from URLs in note text (e.g. a YouTube link
      // pasted into a quick note) carry `syntheticType` and no real
      // `attachmentIndex`. Previously this fell through to the "delete the
      // whole note" branch via NaN — wiping notes that legitimately still
      // held other content. Strip just the URL from the note content
      // instead and bail before touching storage.
      if (card.syntheticType === "youtube-link") {
        const url = String(card.syntheticUrl || card.attachment?.url || "").trim();
        if (!url) return;
        const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const stripped = String(note.content || "").replace(new RegExp(escaped, "g"), "").replace(/\n{3,}/g, "\n\n").trim();
        const { error: stripError } = await vaultWrites.update(card.noteId, {
          content: stripped,
          updated_at: new Date().toISOString(),
        });
        if (stripError) {
          notifyVaultCapIfApplicable(stripError);
          if (import.meta.env.DEV) console.error("[Vault] strip youtube link failed:", stripError);
          return;
        }
        setNotes((prev) =>
          prev.map((n) =>
            String(n?.id) === String(card.noteId)
              ? { ...n, content: stripped, updated_at: new Date().toISOString() }
              : n
          )
        );
        removeCardFromProjects(card);
        return;
      }

      let storageRemovalAllowed = false;
      if (!Number.isFinite(idx) || idx < 0 || idx >= attachments.length || attachments.length <= 1) {
        const { error: deleteError } = await vaultWrites.remove(card.noteId);
        if (deleteError) {
          notifyVaultCapIfApplicable(deleteError);
          if (import.meta.env.DEV) console.error("[Vault] delete note failed:", deleteError);
          return;
        }
        purgeVaultNoteEmbeddings(card.noteId);
        setNotes((prev) => prev.filter((n) => String(n?.id) !== String(card.noteId)));
        // Bust the cached Vault query so
        // the deleted vault note disappears from the brain on the
        // user's next visit without waiting for the realtime
        // postgres_changes event (which usually arrives ~100-300ms
        // later and won't fire at all if the project hasn't enabled
        // realtime on the `notes` table yet).
        vaultQueryClient.invalidateQueries({ queryKey: ["mindmap_vault_graph"] });
        storageRemovalAllowed = true;
      } else {
        const nextAttachments = attachments.filter((_, i) => i !== idx);
        const nextContent = withAttachmentJsonMarker(note.content || "", nextAttachments);
        let updateError = null;
        ({ error: updateError } = await vaultWrites.update(card.noteId, {
          content: nextContent,
          updated_at: new Date().toISOString(),
        }));
        if (updateError) {
          // Bail without touching storage — otherwise the file disappears
          // while the DB row still references it.
          notifyVaultCapIfApplicable(updateError);
          if (import.meta.env.DEV) console.error("[Vault] partial attachment removal failed:", updateError);
          return;
        }
        setNotes((prev) =>
          prev.map((n) =>
            String(n?.id) === String(card.noteId)
              ? { ...n, content: nextContent, updated_at: new Date().toISOString() }
              : n
          )
        );
        storageRemovalAllowed = true;
      }

      removeCardFromProjects(card);

      if (storageRemovalAllowed) {
        const storageTarget = parseStorageTarget(card.attachment || {});
        // Local files are already gone: deleting the row takes its whole blob
        // directory with it, so there is nothing left to clean up here.
        if (storageTarget?.bucket && storageTarget?.path && !isLocalTarget(storageTarget)) {
          const { error: storageError } = await supabase.storage
            .from(storageTarget.bucket)
            .remove([storageTarget.path]);
          if (storageError && import.meta.env.DEV) {
            console.warn("[Vault] storage cleanup failed:", storageError);
          }
        }
      }
    } finally {
      setOpenCardMenuId(null);
      setIsCardActionBusy(false);
    }
  }, [notes, user?.id, removeCardFromProjects]);

  const removeQuickNoteCard = useCallback(async (card) => {
    if (!user?.id || !card?.noteId) return;
    setIsCardActionBusy(true);
    try {
      // Check the delete actually succeeded before optimistically
      // dropping the card. If RLS or the network rejected, we used to
      // silently remove the row from local state and leak it on the
      // server until the next refetch — which made deleted-then-
      // reappearing cards a user-visible mystery.
      const { error: deleteError } = await vaultWrites.remove(card.noteId);
      if (deleteError) {
        notifyVaultCapIfApplicable(deleteError);
        if (import.meta.env.DEV) console.error("[Vault] delete quick note failed:", deleteError);
        return;
      }
      purgeVaultNoteEmbeddings(card.noteId);
      setNotes((prev) => prev.filter((n) => String(n?.id) !== String(card.noteId)));
      // Mirror the attachment-delete path above: bust the synthesis-
      // layer cache so the quick-note neuron disappears from the brain
      // without waiting on the postgres_changes realtime round-trip.
      vaultQueryClient.invalidateQueries({ queryKey: ["mindmap_vault_graph"] });
      removeCardFromProjects(card);
      setOpenCardMenuId(null);
    } finally {
      setIsCardActionBusy(false);
    }
  }, [user?.id, removeCardFromProjects, vaultQueryClient]);

  const addCardToProject = useCallback(async (card, projectId) => {
    if (!card || !projectId) return;
    const member = vaultMemberFromCard(card);
    if (!member) {
      toast({
        title: "Couldn't add to project",
        description: "This item isn't linked to a vault note yet.",
        variant: "destructive",
      });
      return;
    }
    setIsCardActionBusy(true);
    try {
      const project = projects.find((p) => String(p.id) === String(projectId));
      if (!project) return;
      await addNeuronsToProject(user?.id || null, projectId, [member]);
      invalidateVaultProjects();
      setOpenCardMenuId(null);
      setPreviewProjectDropdownOpen(false);
      toast({
        title: "Added to project",
        description: project.name,
      });
    } catch (err) {
      if (import.meta.env.DEV) console.error("[Vault] add to project failed:", err);
      toast({
        title: "Couldn't add to project",
        description: "Something went wrong. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsCardActionBusy(false);
    }
  }, [invalidateVaultProjects, projects, user?.id, vaultMemberFromCard]);

  const addAttachmentNote = useCallback(async (card, textInput) => {
    if (!user?.id || !card?.noteId) return false;
    const text = String(textInput || "").trim();
    if (!text) return false;
    setIsCardActionBusy(true);
    try {
      const note = notes.find((n) => String(n?.id) === String(card.noteId));
      if (!note) return false;
      const attachments = parseAttachmentsFromNote(note);
      const idx = Number(card.attachmentIndex);
      if (!Number.isFinite(idx) || idx < 0 || idx >= attachments.length) return false;

      const target = attachments[idx] || {};
      const existingNotes = parseAttachmentNotes(target);
      const newNote = { id: crypto.randomUUID(), text, created_at: new Date().toISOString() };
      const nextAttachmentNotes = [...existingNotes, newNote];
      const nextAttachments = attachments.slice();
      nextAttachments[idx] = { ...target, notes: nextAttachmentNotes };
      const nextContent = withAttachmentJsonMarker(note.content || "", nextAttachments);

      const { error: updateError } = await vaultWrites.update(card.noteId, {
        content: nextContent,
        updated_at: new Date().toISOString(),
      });

      if (!updateError) {
        setNotes((prev) =>
          prev.map((n) =>
            String(n?.id) === String(card.noteId)
              ? { ...n, content: nextContent, updated_at: new Date().toISOString() }
              : n
          )
        );
        return true;
      }
      return false;
    } finally {
      setIsCardActionBusy(false);
    }
  }, [notes, user?.id]);

  const addQuickNoteComment = useCallback(async (card, textInput) => {
    if (!user?.id || !card?.noteId) return false;
    const text = String(textInput || "").trim();
    if (!text) return false;
    setIsCardActionBusy(true);
    try {
      const note = notes.find((n) => String(n?.id) === String(card.noteId));
      if (!note) return false;
      const existing = parseQuickNoteComments(note);
      const newComment = { id: crypto.randomUUID(), text, created_at: new Date().toISOString() };
      const nextComments = [...existing, newComment];

      const { error: updateError } = await vaultWrites.update(card.noteId, {
        comments: nextComments,
        updated_at: new Date().toISOString(),
      });

      if (updateError) {
        // Column not deployed yet — surface a clear error rather than
        // silently dropping the comment.
        if (updateError.code === "PGRST204" || updateError.message?.toLowerCase().includes("does not exist")) {
          console.warn("notes.comments column missing — run migration 041_notes_comments_column.sql", updateError);
        }
        return false;
      }

      setNotes((prev) =>
        prev.map((n) =>
          String(n?.id) === String(card.noteId)
            ? { ...n, comments: nextComments, updated_at: new Date().toISOString() }
            : n
        )
      );
      return true;
    } finally {
      setIsCardActionBusy(false);
    }
  }, [notes, user?.id]);

  // Phase 4: the single "why" field — one scalar reason per vault item,
  // distinct from the comments thread. Persisted to notes.why (utf8).
  const saveCardWhy = useCallback(async (card, textInput) => {
    if (!user?.id || !card?.noteId) return false;
    const why = String(textInput || "").trim().slice(0, 2000);
    setIsCardActionBusy(true);
    try {
      const { error: updateError } = await vaultWrites.update(card.noteId, {
        why,
        updated_at: new Date().toISOString(),
      });

      if (updateError) {
        if (updateError.code === "PGRST204" || updateError.message?.toLowerCase().includes("does not exist")) {
          console.warn("notes.why column missing — run migration 105_vault_why_column.sql", updateError);
        }
        return false;
      }

      setNotes((prev) =>
        prev.map((n) =>
          String(n?.id) === String(card.noteId)
            ? { ...n, why, updated_at: new Date().toISOString() }
            : n
        )
      );
      return true;
    } finally {
      setIsCardActionBusy(false);
    }
  }, [user?.id]);

  const addWakePreviewCardComment = useCallback((card, textInput) => {
    const text = String(textInput || "").trim();
    if (!text || !card?.id) return false;
    const saved = appendWakeVaultPreviewComment(card.id, text);
    setWakePreviewCardComments((prev) => ({
      ...prev,
      [card.id]: [...(prev[card.id] || []), saved],
    }));
    return true;
  }, []);

  const removeAttachmentNote = useCallback(async (card, commentId) => {
    if (!user?.id || !card?.noteId || !commentId) return false;
    setIsCardActionBusy(true);
    try {
      const note = notes.find((n) => String(n?.id) === String(card.noteId));
      if (!note) return false;
      const attachments = parseAttachmentsFromNote(note);
      const idx = Number(card.attachmentIndex);
      if (!Number.isFinite(idx) || idx < 0 || idx >= attachments.length) return false;

      const target = attachments[idx] || {};
      const existingNotes = parseAttachmentNotes(target);
      const nextAttachmentNotes = existingNotes.filter((entry) => entry.id !== commentId);
      if (nextAttachmentNotes.length === existingNotes.length) return false;
      const nextAttachments = attachments.slice();
      nextAttachments[idx] = { ...target, notes: nextAttachmentNotes };
      const nextContent = withAttachmentJsonMarker(note.content || "", nextAttachments);

      const { error: updateError } = await vaultWrites.update(card.noteId, {
        content: nextContent,
        updated_at: new Date().toISOString(),
      });

      if (!updateError) {
        setNotes((prev) =>
          prev.map((n) =>
            String(n?.id) === String(card.noteId)
              ? { ...n, content: nextContent, updated_at: new Date().toISOString() }
              : n
          )
        );
        return true;
      }
      return false;
    } finally {
      setIsCardActionBusy(false);
    }
  }, [notes, user?.id]);

  const removeQuickNoteComment = useCallback(async (card, commentId) => {
    if (!user?.id || !card?.noteId || !commentId) return false;
    setIsCardActionBusy(true);
    try {
      const note = notes.find((n) => String(n?.id) === String(card.noteId));
      if (!note) return false;
      const existing = parseQuickNoteComments(note);
      const nextComments = existing.filter((entry) => entry.id !== commentId);
      if (nextComments.length === existing.length) return false;

      const { error: updateError } = await vaultWrites.update(card.noteId, {
        comments: nextComments,
        updated_at: new Date().toISOString(),
      });

      if (updateError) {
        if (updateError.code === "PGRST204" || updateError.message?.toLowerCase().includes("does not exist")) {
          console.warn("notes.comments column missing — run migration 041_notes_comments_column.sql", updateError);
        }
        return false;
      }

      setNotes((prev) =>
        prev.map((n) =>
          String(n?.id) === String(card.noteId)
            ? { ...n, comments: nextComments, updated_at: new Date().toISOString() }
            : n
        )
      );
      return true;
    } finally {
      setIsCardActionBusy(false);
    }
  }, [notes, user?.id]);

  const updateAttachmentNote = useCallback(async (card, commentId, textInput) => {
    if (!user?.id || !card?.noteId || !commentId) return false;
    const text = String(textInput || "").trim();
    if (!text) return false;
    setIsCardActionBusy(true);
    try {
      const note = notes.find((n) => String(n?.id) === String(card.noteId));
      if (!note) return false;
      const attachments = parseAttachmentsFromNote(note);
      const idx = Number(card.attachmentIndex);
      if (!Number.isFinite(idx) || idx < 0 || idx >= attachments.length) return false;

      const target = attachments[idx] || {};
      const existingNotes = parseAttachmentNotes(target);
      let changed = false;
      const nextAttachmentNotes = existingNotes.map((entry) => {
        if (entry.id !== commentId) return entry;
        changed = true;
        return { ...entry, text };
      });
      if (!changed) return false;
      const nextAttachments = attachments.slice();
      nextAttachments[idx] = { ...target, notes: nextAttachmentNotes };
      const nextContent = withAttachmentJsonMarker(note.content || "", nextAttachments);

      const { error: updateError } = await vaultWrites.update(card.noteId, {
        content: nextContent,
        updated_at: new Date().toISOString(),
      });

      if (!updateError) {
        setNotes((prev) =>
          prev.map((n) =>
            String(n?.id) === String(card.noteId)
              ? { ...n, content: nextContent, updated_at: new Date().toISOString() }
              : n
          )
        );
        return true;
      }
      return false;
    } finally {
      setIsCardActionBusy(false);
    }
  }, [notes, user?.id]);

  const updateQuickNoteComment = useCallback(async (card, commentId, textInput) => {
    if (!user?.id || !card?.noteId || !commentId) return false;
    const text = String(textInput || "").trim();
    if (!text) return false;
    setIsCardActionBusy(true);
    try {
      const note = notes.find((n) => String(n?.id) === String(card.noteId));
      if (!note) return false;
      const existing = parseQuickNoteComments(note);
      let changed = false;
      const nextComments = existing.map((entry) => {
        if (entry.id !== commentId) return entry;
        changed = true;
        return { ...entry, text };
      });
      if (!changed) return false;

      const { error: updateError } = await vaultWrites.update(card.noteId, {
        comments: nextComments,
        updated_at: new Date().toISOString(),
      });

      if (updateError) {
        if (updateError.code === "PGRST204" || updateError.message?.toLowerCase().includes("does not exist")) {
          console.warn("notes.comments column missing — run migration 041_notes_comments_column.sql", updateError);
        }
        return false;
      }

      setNotes((prev) =>
        prev.map((n) =>
          String(n?.id) === String(card.noteId)
            ? { ...n, comments: nextComments, updated_at: new Date().toISOString() }
            : n
        )
      );
      return true;
    } finally {
      setIsCardActionBusy(false);
    }
  }, [notes, user?.id]);

  const updateWakePreviewCardComment = useCallback((card, commentId, textInput) => {
    const text = String(textInput || "").trim();
    if (!text || !card?.id || !commentId) return false;
    setWakePreviewCardComments((prev) => {
      const list = prev[card.id] || [];
      const nextForCard = list.map((entry) =>
        entry.id === commentId ? { ...entry, text } : entry,
      );
      return { ...prev, [card.id]: nextForCard };
    });
    return true;
  }, []);

  const removeWakePreviewCardComment = useCallback((card, commentId) => {
    if (!card?.id || !commentId) return false;
    removeWakeVaultPreviewComment(card.id, commentId);
    setWakePreviewCardComments((prev) => {
      const nextForCard = (prev[card.id] || []).filter((entry) => entry.id !== commentId);
      if (nextForCard.length === 0) {
        const next = { ...prev };
        delete next[card.id];
        return next;
      }
      return { ...prev, [card.id]: nextForCard };
    });
    setWakePreviewDeletedComments((prev) => ({
      ...prev,
      [card.id]: Array.from(new Set([...(prev[card.id] || []), commentId])),
    }));
    return true;
  }, []);

  const confirmAndDeleteAttachment = useCallback((card) => {
    if (!card) return;
    const label = String(card?.title || "this file");
    const ok = window.confirm(`Are you sure you want to delete "${label}"? This cannot be undone.`);
    if (!ok) return;
    void removeAttachmentFromNote(card);
  }, [removeAttachmentFromNote]);

  // Bulk delete with the same 6-second undo grace window as drag-to-trash.
  // Each card is hidden optimistically, then committed individually once the
  // timer fires. Undo restores everything that hasn't been committed yet.
  const deleteSelectedCards = useCallback(() => {
    const ids = Array.from(selectedCardIds);
    if (ids.length === 0) return;
    const allCards = vaultCardsRef.current || [];
    const cards = ids
      .map((id) => allCards.find((c) => c.id === id))
      .filter((c) => isSelectableCard(c) && !pendingDeleteCardIds.has(c.id));
    if (cards.length === 0) {
      clearSelection();
      return;
    }
    const label = cards.length === 1
      ? `"${String(cards[0].title || "this item").slice(0, 60)}"`
      : `${cards.length} items`;
    const ok = window.confirm(
      `Delete ${label}? This cannot be undone after the undo window.`
    );
    if (!ok) return;

    setPendingDeleteCardIds((prev) => {
      const next = new Set(prev);
      for (const c of cards) next.add(c.id);
      return next;
    });

    const snapshots = cards.slice();
    for (const card of snapshots) {
      const commitDelete = () => {
        pendingDeleteTimersRef.current.delete(card.id);
        setPendingDeleteCardIds((prev) => {
          if (!prev.has(card.id)) return prev;
          const next = new Set(prev);
          next.delete(card.id);
          return next;
        });
        if (card.kind === "attachment") {
          void removeAttachmentFromNote(card);
        } else if (card.kind === "quick-note") {
          void removeQuickNoteCard(card);
        }
      };
      const timerId = setTimeout(commitDelete, TRASH_UNDO_GRACE_MS);
      pendingDeleteTimersRef.current.set(card.id, timerId);
    }

    const t = toast({
      title: snapshots.length === 1 ? "Moved to trash" : `${snapshots.length} items moved to trash`,
      description: snapshots.length === 1
        ? `"${String(snapshots[0].title || "Item").slice(0, 60)}" will be deleted.`
        : "Items will be deleted shortly.",
      duration: TRASH_UNDO_GRACE_MS,
      action: (
        <ToastAction
          altText="Undo delete"
          onClick={() => {
            for (const card of snapshots) {
              const pending = pendingDeleteTimersRef.current.get(card.id);
              if (pending) {
                clearTimeout(pending);
                pendingDeleteTimersRef.current.delete(card.id);
              }
            }
            setPendingDeleteCardIds((prev) => {
              const next = new Set(prev);
              for (const card of snapshots) next.delete(card.id);
              return next;
            });
            t.dismiss();
          }}
        >
          Undo
        </ToastAction>
      ),
    });

    clearSelection();
  }, [
    selectedCardIds,
    pendingDeleteCardIds,
    isSelectableCard,
    clearSelection,
    removeAttachmentFromNote,
    removeQuickNoteCard,
  ]);
  const moveCardToFolder = useCallback(async (card, folder) => {
    if (!card?.noteId) {
      toast({
        title: "Couldn't move this",
        description: "This item isn't linked to a vault note yet.",
        variant: "destructive",
      });
      return;
    }
    const next = String(folder || "").trim();
    const updatedAt = new Date().toISOString();
    setIsCardActionBusy(true);
    try {
      const { error } = await vaultWrites.update(card.noteId, {
        folder: next,
        updated_at: updatedAt,
      });
      if (error) {
        notifyVaultCapIfApplicable(error);
        if (import.meta.env.DEV) console.error("[Vault] move to folder failed:", error);
        toast({
          title: "Couldn't move this",
          description: "Something went wrong. Please try again.",
          variant: "destructive",
        });
        return;
      }
      setNotes((prev) =>
        prev.map((n) =>
          String(n?.id) === String(card.noteId) ? { ...n, folder: next, updated_at: updatedAt } : n,
        ),
      );
      // What the model is told the drive holds is cached; this just changed it.
      clearAiDriveCache();
      toast({
        title: "Moved",
        description: next === AI_DRIVE_FOLDER ? "AI Drive" : next,
      });
    } finally {
      setIsCardActionBusy(false);
    }
  }, []);

  return {
    isCardActionBusy,
    vaultMemberFromCard,
    removeCardFromProjects,
    removeAttachmentFromNote,
    removeQuickNoteCard,
    addCardToProject,
    addAttachmentNote,
    addQuickNoteComment,
    saveCardWhy,
    addWakePreviewCardComment,
    removeAttachmentNote,
    removeQuickNoteComment,
    updateAttachmentNote,
    updateQuickNoteComment,
    updateWakePreviewCardComment,
    removeWakePreviewCardComment,
    confirmAndDeleteAttachment,
    deleteSelectedCards,
    moveCardToFolder,
  };
}
