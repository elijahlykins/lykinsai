// useVaultQuickCapture owns the Vault's lightweight capture surfaces: the
// quick-note composer (open/draft/save/close/discard), the new-note chooser,
// and the save-link dialog. Extracted verbatim from src/pages/Vault.jsx
// (Vault decomposition phase, see docs/REFACTOR_LOG.md). Sign-in gating
// (requireSignInForAction) and the wake-preview walkthrough gate stay in
// Vault.jsx and are passed in, because they are shared with unrelated
// actions (add media, card mutations).
import { useCallback, useState } from "react";
import { toast } from "@/components/ui/use-toast";
import { afterVaultNoteSaved } from "@/lib/vault/afterVaultSave";
import { describeVaultItemInBackground } from "@/lib/vault/describeVaultItem";
import { notifyVaultCapIfApplicable } from "@/lib/vault/vaultCapError";
import { normalizeUrl } from "@/lib/vault/attachmentType";
import { appendWakeVaultPreviewQuickNote } from "@/lib/wake/wakeVaultPreviewQuickNotes";

export function useVaultQuickCapture({
  user,
  isWakePreview,
  vaultWrites,
  setNotes,
  checkVaultLimit,
  incrementVaultCount,
  requireSignInForAction,
  setShowSignInBlocker,
  setWakePreviewQuickNotes,
}) {
  const [showQuickNote, setShowQuickNote] = useState(false);
  const [showNewNoteChooser, setShowNewNoteChooser] = useState(false);
  const [quickNoteContent, setQuickNoteContent] = useState("");
  const [isQuickNoteSaving, setIsQuickNoteSaving] = useState(false);
  const [showSaveLink, setShowSaveLink] = useState(false);
  const [isSaveLinkSaving, setIsSaveLinkSaving] = useState(false);

  const handleRequestSaveLink = useCallback(() => {
    if (requireSignInForAction()) return;
    setShowSaveLink(true);
  }, [requireSignInForAction]);
  const handleToggleQuickNote = useCallback(() => {
    if (isWakePreview) {
      setShowQuickNote((v) => !v);
      return;
    }
    if (requireSignInForAction()) return;
    if (showQuickNote) {
      setShowQuickNote(false);
      return;
    }
    setShowNewNoteChooser(true);
  }, [requireSignInForAction, isWakePreview, showQuickNote]);

  const handleChooseWrittenNote = useCallback(() => {
    setShowNewNoteChooser(false);
    setShowQuickNote(true);
  }, []);

  const handleSaveQuickNote = async () => {
    if (isQuickNoteSaving) return;
    const content = quickNoteContent.trim();
    if (!content) return;

    if (isWakePreview) {
      setIsQuickNoteSaving(true);
      try {
        const saved = appendWakeVaultPreviewQuickNote(content);
        setWakePreviewQuickNotes((prev) => [saved, ...prev]);
        setQuickNoteContent("");
        setShowQuickNote(false);
      } finally {
        setIsQuickNoteSaving(false);
      }
      return;
    }

    if (!user?.id) { setShowSignInBlocker(true); return; }
    if (!(await checkVaultLimit())) return;

    setIsQuickNoteSaving(true);
    try {
      let insertedNote = null;
      let noteError = null;

      ({ data: insertedNote, error: noteError } = await vaultWrites.insert({
        title: "Quick Note",
        content,
        source: "quick_note",
        tags: ["note"],
      }));

      const missingColumnError =
        noteError &&
        (
          noteError.code === "PGRST204" ||
          noteError.message?.includes("Could not find") ||
          String(noteError.message || "").toLowerCase().includes("does not exist")
        );

      // Older cloud databases lack `source` / `tags`; retry with the columns
      // every deployment is guaranteed to have.
      if (missingColumnError) {
        ({ data: insertedNote, error: noteError } = await vaultWrites.insert({
          title: "Quick Note",
          content,
        }));
      }

      if (noteError || !insertedNote?.id) {
        throw noteError || new Error("Unable to save quick note.");
      }

      afterVaultNoteSaved(user.id, insertedNote.id, {
        title: insertedNote.title || "Quick Note",
        content,
      });

      setQuickNoteContent("");
      setShowQuickNote(false);
      setNotes((prev) => [insertedNote, ...prev]);
      incrementVaultCount();
    } catch (error) {
      if (!notifyVaultCapIfApplicable(error)) {
        toast({
          title: "Couldn't save note",
          description: "Please try again.",
          variant: "destructive",
        });
      }
    } finally {
      setIsQuickNoteSaving(false);
    }
  };

  const handleCloseQuickNote = useCallback(async () => {
    if (isQuickNoteSaving) return;
    const hasContent = Boolean(String(quickNoteContent || "").trim());
    if (!hasContent) {
      setShowQuickNote(false);
      setQuickNoteContent("");
      return;
    }
    await handleSaveQuickNote();
  }, [handleSaveQuickNote, isQuickNoteSaving, quickNoteContent]);

  // Explicit discard: throw away the draft without saving. Distinct
  // from `handleCloseQuickNote` which auto-saves any non-empty draft
  // (close = "minimize and persist"; discard = "throw it away").
  // Wired to the trash button in `DraggableQuickNote`.
  const handleDiscardQuickNote = useCallback(() => {
    if (isQuickNoteSaving) return;
    setShowQuickNote(false);
    setQuickNoteContent("");
  }, [isQuickNoteSaving]);

  const handleSaveLink = useCallback(async (saveLinkPreview) => {
    if (!user?.id) { setShowSignInBlocker(true); return; }
    if (isSaveLinkSaving || !saveLinkPreview) return;
    if (!(await checkVaultLimit())) return;
    setIsSaveLinkSaving(true);
    try {
      // Defense in depth: AddLinkDialog normalizes on the way in, but
      // force a final pass before persistence in case the server echo
      // re-introduces a bare hostname.
      const safeUrl = normalizeUrl(saveLinkPreview.url) || saveLinkPreview.url;
      const attachment = [{
        type: "bookmark",
        url: safeUrl,
        name: saveLinkPreview.title || saveLinkPreview.url || "Saved Link",
        title: saveLinkPreview.title || "",
        description: saveLinkPreview.description || "",
        image: saveLinkPreview.image || "",
        favicon: saveLinkPreview.favicon || "",
        siteName: saveLinkPreview.siteName || "",
        articleText: saveLinkPreview.articleText || "",
        oembedType: saveLinkPreview.oembedType || "",
        oembedHtml: saveLinkPreview.oembedHtml || "",
        authorName: saveLinkPreview.authorName || "",
        authorHandle: saveLinkPreview.authorHandle || "",
      }];
      const noteContent = `${saveLinkPreview.title || safeUrl}\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachment)}]`;
      const { data: insertedNote, error } = await vaultWrites.insert({
        title: saveLinkPreview.title || safeUrl,
        content: noteContent,
      });
      if (error) throw error;
      if (insertedNote) {
        setNotes((prev) => [insertedNote, ...prev]);
        incrementVaultCount();
        // Index into Vault retrieval the same way quick notes and
        // dropped links do — without this, dialog-saved links never
        // appear in the brain map until some other reindex pass runs.
        const linkText = [
          saveLinkPreview.title,
          saveLinkPreview.description,
          saveLinkPreview.articleText,
        ].filter(Boolean).join("\n").slice(0, 5000);
        describeVaultItemInBackground(insertedNote.id, {
          imageUrl: saveLinkPreview.image || undefined,
          textContent: linkText || undefined,
          fileType: "bookmark",
          fileName: saveLinkPreview.title || safeUrl,
        });
        afterVaultNoteSaved(user.id, insertedNote.id, {
          title: insertedNote.title || saveLinkPreview.title || safeUrl,
          content: insertedNote.content || noteContent,
          extraPlain: linkText || undefined,
        });
      }
      setShowSaveLink(false);
    } catch (err) {
      if (!notifyVaultCapIfApplicable(err)) {
        toast({
          title: "Couldn't save link",
          description: "Please try again.",
          variant: "destructive",
        });
      }
    } finally {
      setIsSaveLinkSaving(false);
    }
  }, [user?.id, isSaveLinkSaving, checkVaultLimit, incrementVaultCount]);

  return {
    showQuickNote,
    setShowQuickNote,
    showNewNoteChooser,
    setShowNewNoteChooser,
    quickNoteContent,
    setQuickNoteContent,
    isQuickNoteSaving,
    showSaveLink,
    setShowSaveLink,
    isSaveLinkSaving,
    handleRequestSaveLink,
    handleToggleQuickNote,
    handleChooseWrittenNote,
    handleSaveQuickNote,
    handleCloseQuickNote,
    handleDiscardQuickNote,
    handleSaveLink,
  };
}
