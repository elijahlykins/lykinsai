// VaultCardPopovers renders the Vault's card-anchored popovers, each in a
// portal so it can escape the card's overflow clip: the "⋯" action menu
// (add-to-project / comment / tags / delete), the comment composer, and the
// tag picker. Extracted verbatim from src/pages/Vault.jsx (Vault decomposition
// phase, see docs/REFACTOR_LOG.md). All state stays in Vault.jsx — these
// popovers are positioned from rects captured at open time and share their
// dismissal effects with the page.
import { createPortal } from "react-dom";
import { Check, MessageCircle, Plus, Tag, Trash2, X } from "lucide-react";
import { parseAttachmentNotes } from "@/lib/vault/vaultCardHelpers";
import { removeWakeVaultPreviewQuickNote } from "@/lib/wake/wakeVaultPreviewQuickNotes";

export default function VaultCardPopovers({
  addAttachmentNote,
  addCardToProject,
  addQuickNoteComment,
  addWakePreviewCardComment,
  allTags,
  attachmentNoteDraft,
  blockWakePreviewVaultMutation,
  cardMenuRef,
  closeAttachmentNotes,
  confirmAndDeleteAttachment,
  createAndAssignTag,
  isCardActionBusy,
  isWakePreview,
  newTagInput,
  noteComposerRef,
  openAttachmentNotesCardId,
  openAttachmentNotesForAnchor,
  openAttachmentNotesRect,
  openCardMenuId,
  openCardMenuPlacement,
  openCardMenuRect,
  orderedVisibleCards,
  previewCard,
  projects,
  removeAttachmentNote,
  removeQuickNoteCard,
  removeQuickNoteComment,
  removeWakePreviewCardComment,
  setAttachmentNoteDraft,
  setNewTagInput,
  setOpenAttachmentNotesCardId,
  setOpenAttachmentNotesRect,
  setOpenCardMenuId,
  setTagPickerCardId,
  setTagPickerPosition,
  setWakePreviewQuickNotes,
  tagPickerCardId,
  tagPickerPosition,
  tagPickerRef,
  toggleCardTag,
  trapPopoverWheel,
  vaultCards,
  vaultPreviewRootRef,
}) {
  return (
    <>
      {openCardMenuId && openCardMenuRect && createPortal(
        (() => {
          const menuCard = orderedVisibleCards.find((c) => c.id === openCardMenuId);
          if (!menuCard) return null;
          const menuW = Math.min(224, window.innerWidth - 16);
          const pad = 8;
          let top, maxH;
          const previewRoot = isWakePreview ? vaultPreviewRootRef.current : null;
          const previewRootRect = previewRoot?.getBoundingClientRect?.() || null;
          if (openCardMenuPlacement === "up") {
            top = undefined;
            maxH = openCardMenuRect.top - pad - (previewRootRect?.top ?? 0);
          } else {
            top = openCardMenuRect.bottom + pad - (previewRootRect?.top ?? 0);
            maxH = (previewRootRect?.bottom ?? window.innerHeight) - openCardMenuRect.bottom - pad;
          }
          let left = openCardMenuRect.right - menuW - (previewRootRect?.left ?? 0);
          const maxLeft = (previewRootRect?.width ?? window.innerWidth) - menuW - pad;
          if (left < pad) left = pad;
          if (left > maxLeft) left = Math.max(pad, maxLeft);

          return (
            <div
              ref={cardMenuRef}
              data-vault-popover=""
              className="lg-menu p-1.5 flex flex-col overflow-hidden overscroll-contain"
              style={{
                position: previewRoot ? "absolute" : "fixed",
                width: menuW,
                left: previewRoot ? left : openCardMenuRect.right - menuW,
                ...(openCardMenuPlacement === "up"
                  ? previewRoot
                    ? { bottom: (previewRootRect?.bottom ?? 0) - openCardMenuRect.top + pad }
                    : { bottom: window.innerHeight - openCardMenuRect.top + pad }
                  : previewRoot
                    ? { top }
                    : { top: openCardMenuRect.bottom + pad }),
                maxHeight: maxH,
                // Above the card lightbox (z-9999) when opened from Expand view.
                zIndex: previewCard ? 10050 : 9999,
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onWheel={trapPopoverWheel}
            >
              {/*
                Tall cards (notably drag-dropped YouTube embeds) anchor the
                ⋯ menu near the bottom of the viewport. When the menu opens
                upward with a tight maxHeight, a single scroll container
                hid Delete below the fold — link-added YouTube stayed as
                shorter bookmark tiles so the bug only showed on drag-drop.
                Keep Delete pinned outside the scroll region.
              */}
              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
                <div className="px-2 py-1 text-[0.6875rem] font-medium text-black/60 dark:text-white/60">Add to project</div>
                <div className="space-y-1">
                  <div className="max-h-44 overflow-y-auto scrollbar-hide space-y-1">
                    {projects.length === 0 ? (
                      <div className="px-2 py-1.5 text-[0.6875rem] text-black/55 dark:text-white/55">No projects found.</div>
                    ) : (
                      projects.map((project) => (
                        <button
                          key={project.id}
                          type="button"
                          disabled={isCardActionBusy}
                          onClick={() => {
                            if (blockWakePreviewVaultMutation(menuCard)) return;
                            void addCardToProject(menuCard, project.id);
                          }}
                          className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/10 dark:hover:bg-white/10 disabled:opacity-60 truncate"
                          title={project.name}
                        >
                          {project.name}
                        </button>
                      ))
                    )}
                  </div>
                </div>
                {(menuCard.kind === "attachment" || menuCard.kind === "quick-note") && (
                  <>
                    <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
                    <button
                      type="button"
                      disabled={isCardActionBusy}
                      onClick={() => {
                        // Anchor the composer to the card itself rather
                        // than this menu item — the menu is closing as
                        // we click, so its rect would jump. The card
                        // wrapper carries `data-vault-card-id` and is
                        // always present in the DOM while the card is
                        // visible.
                        const anchor =
                          document.querySelector(`[data-vault-card-id="${menuCard.id}"]`) ||
                          cardMenuRef.current;
                        openAttachmentNotesForAnchor(menuCard.id, anchor);
                        setOpenCardMenuId(null);
                      }}
                      className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-60 flex items-center gap-2"
                    >
                      <MessageCircle className="w-3.5 h-3.5" />
                      Comment
                    </button>
                  </>
                )}
                {menuCard.noteId && (
                  <>
                    <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
                    <button
                      type="button"
                      onClick={() => {
                        const rect = openCardMenuRect;
                        setOpenAttachmentNotesCardId(null);
                        setOpenAttachmentNotesRect(null);
                        setAttachmentNoteDraft("");
                        setTagPickerCardId(menuCard.id);
                        setTagPickerPosition(
                          rect
                            ? { left: rect.left, top: rect.bottom + 8 }
                            : { left: 16, top: 16 },
                        );
                        setOpenCardMenuId(null);
                      }}
                      className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/5 flex items-center gap-2"
                    >
                      <Tag className="w-3.5 h-3.5" />
                      Tags
                    </button>
                  </>
                )}
              </div>
              <div className="shrink-0 pt-1 mt-1 border-t border-black/10 dark:border-white/10">
                <button
                  type="button"
                  disabled={isCardActionBusy}
                  onClick={() => {
                    if (isWakePreview && menuCard.isWakePreviewNote) {
                      const ok = window.confirm(`Are you sure you want to delete "${menuCard.title || "Quick Note"}"? This cannot be undone.`);
                      if (!ok) return;
                      removeWakeVaultPreviewQuickNote(menuCard.id);
                      setWakePreviewQuickNotes((prev) => prev.filter((note) => note.id !== menuCard.id));
                      setOpenCardMenuId(null);
                      return;
                    }
                    if (blockWakePreviewVaultMutation(menuCard)) return;
                    if (menuCard.kind === "attachment") {
                      confirmAndDeleteAttachment(menuCard);
                    } else {
                      const ok = window.confirm(`Are you sure you want to delete "${menuCard.title || "Quick Note"}"? This cannot be undone.`);
                      if (!ok) return;
                      void removeQuickNoteCard(menuCard);
                    }
                  }}
                  className="w-full text-left rounded-md px-2 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-60 flex items-center gap-2 text-red-600"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete
                </button>
              </div>
            </div>
          );
        })(),
        isWakePreview && vaultPreviewRootRef.current
          ? vaultPreviewRootRef.current
          : document.body
      )}
      {/*
        Comment composer popover. Rendered via portal (not inline inside
        the card) so it can escape the card's `overflow-hidden` clip —
        previously the composer would render INSIDE the card and get cut
        off in grid mode, which made it impossible to type into.

        Anchoring uses the viewport rect captured at open-time
        (`openAttachmentNotesRect`). We flip the placement up when there
        isn't room below, mirroring the `openCardMenuPlacement`
        behavior for the action menu.
      */}
      {openAttachmentNotesCardId && createPortal(
        (() => {
          const card =
            orderedVisibleCards.find((c) => c.id === openAttachmentNotesCardId) ||
            vaultCards.find((c) => c.id === openAttachmentNotesCardId) ||
            (previewCard && previewCard.id === openAttachmentNotesCardId ? previewCard : null);
          if (!card) return null;
          const isAttachment = card.kind === "attachment";
          const existingComments = isAttachment
            ? parseAttachmentNotes(card.attachment)
            : (card.comments || []);
          const onSave = isAttachment ? addAttachmentNote : addQuickNoteComment;
          const onDelete = isAttachment ? removeAttachmentNote : removeQuickNoteComment;
          const placeholder = isAttachment
            ? "Write a comment about this file…"
            : "Write a comment on this quick note…";
          const trySaveComment = () => {
            if (!attachmentNoteDraft.trim()) return;
            if (isWakePreview) {
              addWakePreviewCardComment(card, attachmentNoteDraft);
              closeAttachmentNotes();
              return;
            }
            if (blockWakePreviewVaultMutation(card)) return;
            void onSave(card, attachmentNoteDraft);
            closeAttachmentNotes();
          };
          const tryDeleteComment = (commentId) => {
            if (!commentId || isCardActionBusy) return;
            if (isWakePreview) {
              removeWakePreviewCardComment(card, commentId);
              return;
            }
            if (blockWakePreviewVaultMutation(card)) return;
            void onDelete(card, commentId);
          };

          const COMP_W = Math.min(288, window.innerWidth - 16);
          const COMP_H_EST = 240; // textarea + buttons + a few existing comments
          const pad = 8;
          const rect = openAttachmentNotesRect;
          const previewRoot = isWakePreview ? vaultPreviewRootRef.current : null;
          const previewRootRect = previewRoot?.getBoundingClientRect?.() || null;

          // Fall back to a centered overlay if we somehow opened without
          // an anchor rect (e.g. if the anchor scrolled out of frame).
          let positionStyle;
          if (rect) {
            const spaceBelow = (previewRootRect?.bottom ?? window.innerHeight) - rect.bottom;
            const spaceAbove = rect.top - (previewRootRect?.top ?? 0);
            const useUp = spaceBelow < COMP_H_EST && spaceAbove > spaceBelow;
            let left = rect.right - COMP_W - (previewRootRect?.left ?? 0);
            const maxLeft = (previewRootRect?.width ?? window.innerWidth) - COMP_W - pad;
            if (left < pad) left = pad;
            if (left > maxLeft) left = Math.max(pad, maxLeft);
            positionStyle = useUp
              ? previewRoot
                ? {
                    position: "absolute",
                    width: COMP_W,
                    left,
                    bottom: (previewRootRect?.bottom ?? 0) - rect.top + pad,
                    maxHeight: rect.top - (previewRootRect?.top ?? 0) - pad * 2,
                    zIndex: 9999,
                  }
                : {
                    position: "fixed",
                    width: COMP_W,
                    left: rect.right - COMP_W,
                    bottom: window.innerHeight - rect.top + pad,
                    maxHeight: rect.top - pad * 2,
                    zIndex: 9999,
                  }
              : previewRoot
                ? {
                    position: "absolute",
                    width: COMP_W,
                    left,
                    top: rect.bottom + pad - (previewRootRect?.top ?? 0),
                    maxHeight: (previewRootRect?.bottom ?? window.innerHeight) - rect.bottom - pad * 2,
                    zIndex: 9999,
                  }
                : {
                    position: "fixed",
                    width: COMP_W,
                    left: rect.right - COMP_W,
                    top: rect.bottom + pad,
                    maxHeight: window.innerHeight - rect.bottom - pad * 2,
                    zIndex: 9999,
                  };
          } else if (previewRoot && previewRootRect) {
            positionStyle = {
              position: "absolute",
              width: COMP_W,
              left: Math.max(pad, (previewRootRect.width - COMP_W) / 2),
              top: Math.max(pad, (previewRootRect.height - COMP_H_EST) / 2),
              maxHeight: previewRootRect.height - pad * 2,
              zIndex: 9999,
            };
          } else {
            positionStyle = {
              position: "fixed",
              width: COMP_W,
              left: Math.max(pad, (window.innerWidth - COMP_W) / 2),
              top: Math.max(pad, (window.innerHeight - COMP_H_EST) / 2),
              maxHeight: window.innerHeight - pad * 2,
              zIndex: 9999,
            };
          }
          // Sit above the pulled-up card lightbox when commenting from preview.
          if (positionStyle && previewCard) {
            positionStyle = { ...positionStyle, zIndex: 10050 };
          }

          return (
            <div
              ref={noteComposerRef}
              data-vault-popover=""
              className="rounded-2xl border border-white/30 dark:border-white/10 bg-panel backdrop-blur-md shadow-xl p-3 overflow-y-auto scrollbar-hide overscroll-contain"
              style={positionStyle}
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onWheel={trapPopoverWheel}
            >
              <div className="text-[0.6875rem] font-medium text-black/60 dark:text-white/60 mb-2">
                Add a comment
              </div>
              <textarea
                value={attachmentNoteDraft}
                onChange={(e) => setAttachmentNoteDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && attachmentNoteDraft.trim()) {
                    e.preventDefault();
                    trySaveComment();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    closeAttachmentNotes();
                  }
                }}
                placeholder={placeholder}
                className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-white/45 dark:bg-white/5 px-2.5 py-2 text-xs outline-none resize-none placeholder:text-black/40 dark:placeholder:text-white/40 text-black dark:text-white"
                rows={3}
                autoFocus
              />
              <div className="flex items-center justify-between mt-2">
                <button
                  type="button"
                  onClick={closeAttachmentNotes}
                  className="text-[0.6875rem] text-black/50 dark:text-white/50 hover:text-black/70 dark:hover:text-white/70"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={trySaveComment}
                  disabled={!attachmentNoteDraft.trim()}
                  className="rounded-lg bg-neutral-700 hover:bg-neutral-800 dark:bg-neutral-700 dark:hover:bg-neutral-600 text-white text-[0.6875rem] font-medium px-3 py-1 disabled:opacity-40 transition-colors"
                >
                  Save
                </button>
              </div>
              {existingComments.length > 0 && (
                <div className="mt-3 border-t border-black/10 dark:border-white/10 pt-2 max-h-40 overflow-y-auto scrollbar-hide space-y-1.5">
                  {existingComments.map((entry) => (
                    <div
                      key={entry.id}
                      className="group flex items-start gap-1.5 rounded-md bg-black/5 dark:bg-white/5 px-2 py-1.5"
                    >
                      <p className="flex-1 min-w-0 text-xs text-black/80 dark:text-white/80 whitespace-pre-wrap break-words">
                        {entry.text}
                      </p>
                      <button
                        type="button"
                        onClick={() => tryDeleteComment(entry.id)}
                        disabled={isCardActionBusy}
                        className="shrink-0 p-0.5 rounded text-black/35 dark:text-white/35 hover:text-red-600 dark:hover:text-red-400 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40 transition-colors"
                        title="Delete comment"
                        aria-label="Delete comment"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })(),
        isWakePreview && vaultPreviewRootRef.current
          ? vaultPreviewRootRef.current
          : document.body,
      )}
      {tagPickerCardId && tagPickerPosition && createPortal(
        (() => {
          const pickerCard = vaultCards.find((c) => c.id === tagPickerCardId);
          if (!pickerCard || !pickerCard.noteId) return null;
          const cardTags = pickerCard.tags || [];
          const menuW = Math.min(260, window.innerWidth - 16);
          const pad = 8;
          let left = tagPickerPosition.left;
          let top = tagPickerPosition.top;
          if (left + menuW > window.innerWidth - pad) left = window.innerWidth - pad - menuW;
          if (left < pad) left = pad;
          if (top + 320 > window.innerHeight) top = Math.max(pad, tagPickerPosition.top - 340);

          const filteredTags = newTagInput.trim()
            ? allTags.filter((t) => t.name.toLowerCase().includes(newTagInput.trim().toLowerCase()))
            : allTags;
          const exactMatch = allTags.some((t) => t.name.toLowerCase() === newTagInput.trim().toLowerCase());

          return (
            <div
              ref={tagPickerRef}
              data-vault-popover=""
              className="lg-menu p-1.5 overflow-hidden overscroll-contain"
              style={{ position: "fixed", width: menuW, left, top, zIndex: previewCard ? 10050 : 10000 }}
              onMouseDown={(e) => e.stopPropagation()}
              onWheel={trapPopoverWheel}
            >
              <div className="flex items-center gap-2 mb-2">
                <Tag className="w-3.5 h-3.5 text-black/50 dark:text-white/50" />
                <span className="text-xs font-medium text-black/70 dark:text-white/70">Tags</span>
              </div>
              <div className="relative mb-2">
                <input
                  type="text"
                  value={newTagInput}
                  onChange={(e) => setNewTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newTagInput.trim()) {
                      e.preventDefault();
                      void createAndAssignTag(pickerCard.noteId, newTagInput.trim());
                      setNewTagInput("");
                    }
                  }}
                  placeholder="Search or create tag..."
                  className="w-full h-8 rounded-lg border border-black/10 dark:border-white/10 bg-black/[0.04] dark:bg-white/[0.06] px-2.5 text-xs outline-none placeholder:text-black/35 dark:placeholder:text-white/35 focus:border-blue-400/50"
                  autoFocus
                />
              </div>
              {newTagInput.trim() && !exactMatch && (
                <button
                  type="button"
                  onClick={() => {
                    void createAndAssignTag(pickerCard.noteId, newTagInput.trim());
                    setNewTagInput("");
                  }}
                  className="w-full text-left rounded-md px-2 py-1.5 text-xs hover:bg-blue-500/10 text-blue-600 flex items-center gap-2 mb-1"
                >
                  <Plus className="w-3 h-3" />
                  Create "{newTagInput.trim()}"
                </button>
              )}
              <div className="max-h-48 overflow-y-auto scrollbar-hide space-y-0.5">
                {filteredTags.length === 0 && !newTagInput.trim() && (
                  <div className="px-2 py-2 text-[0.6875rem] text-black/45 dark:text-white/45">No tags yet. Type to create one.</div>
                )}
                {filteredTags.map((tag) => {
                  const isAssigned = cardTags.includes(tag.name);
                  return (
                    <button
                      key={tag.name}
                      type="button"
                      onClick={() => void toggleCardTag(pickerCard.noteId, tag.name)}
                      className={`w-full text-left rounded-md px-2 py-1.5 text-xs flex items-center justify-between gap-2 transition-colors ${
                        isAssigned ? "bg-blue-500/10 text-blue-700 dark:text-blue-400" : "hover:bg-black/5 dark:hover:bg-white/5 text-black/70 dark:text-white/70"
                      }`}
                    >
                      <span className="truncate">{tag.name}</span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[0.625rem] text-black/35 dark:text-white/35">{tag.count}</span>
                        {isAssigned && <Check className="w-3 h-3 text-blue-500" />}
                      </span>
                    </button>
                  );
                })}
              </div>
              {cardTags.length > 0 && (
                <div className="mt-2 pt-2 border-t border-black/8 dark:border-white/8 flex flex-wrap gap-1">
                  {cardTags.map((tag) => (
                    <span
                      key={tag}
                      className="vault-tag-pill inline-flex items-center gap-1 rounded-full bg-blue-500/15 text-blue-700 text-[10px] leading-none px-2 py-px font-medium"
                    >
                      {tag}
                      <button
                        type="button"
                        onClick={() => void toggleCardTag(pickerCard.noteId, tag)}
                        className="hover:text-red-500 transition-colors"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })(),
        document.body
      )}
    </>
  );
}
