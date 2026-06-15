import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, ChevronDown, Info, Loader2, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import VaultAttachment from "@/components/synthesis/VaultAttachment";
import { parseVaultContent } from "@/lib/vaultContent";
import { CHAT_REMARK_PLUGINS, CHAT_REHYPE_PLUGINS } from "@/lib/chat/chatMarkdown";
import { flushAndNavigate } from "@/lib/chat/flushAndNavigate";
import { supabase } from "@/lib/supabase";
import type { ChatNeuronVaultPayload } from "@/components/omnia/ChatNeuronCard";

// ============================================================================
// VaultDocumentViewer — the "pull it up" window
// ============================================================================
// When the AI surfaces a vault item and the user wants to actually SEE the
// whole thing ("bring that up", "pull that document up", or the AI offers
// and the user says yes), the compact ChatNeuronCard expands into this
// full-screen embedded reader. It shows the complete note body (rendered
// markdown) plus every attachment at full size — no line-clamp, no
// navigating away to /vault.
//
// The ChatNeuronCard payload caps note content (loadNeuron truncates long
// bodies), so on open we re-fetch the full row straight from the `notes`
// table by id. If that fails or the note is short, we fall back to whatever
// content rode along on the card payload.

function useEscClose(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);
}

export type VaultDocumentViewerProps = {
  payload: ChatNeuronVaultPayload;
  open: boolean;
  onClose: () => void;
};

export function VaultDocumentViewer({ payload, open, onClose }: VaultDocumentViewerProps) {
  const navigate = useNavigate();
  const note = payload.note;
  const noteId = note?.id || "";

  // Full, untruncated content. Seeded with whatever the card carried so the
  // reader paints instantly, then upgraded with the complete row once the
  // fetch lands (only needed when the card payload was truncated).
  const [fullContent, setFullContent] = useState<string>(String(note?.content || ""));
  const [loading, setLoading] = useState(false);
  // Everything tied to the item (the writeup/"comments", tags, source, dates,
  // open-in-vault) lives behind this one dropdown so the item itself reads as
  // the screen — "just what it is" — with nothing crowding it.
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    setFullContent(String(note?.content || ""));
  }, [note?.content]);

  useEffect(() => {
    if (!open || !noteId || !note?.truncated) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const { data } = await supabase
          .from("notes")
          .select("content")
          .eq("id", noteId)
          .maybeSingle();
        if (!cancelled && data?.content) setFullContent(String(data.content));
      } catch {
        /* fall back to the truncated card content */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, noteId, note?.truncated]);

  const parsed = useMemo(() => parseVaultContent(fullContent), [fullContent]);

  // Lock body scroll while the reader is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEscClose(open, onClose);

  const openInVault = useCallback(() => {
    if (!noteId) return;
    onClose();
    flushAndNavigate(navigate, `/vault?note=${encodeURIComponent(noteId)}`);
  }, [navigate, noteId, onClose]);

  if (!open || !note) return null;

  const title = String(note.title || "Untitled note").trim() || "Untitled note";

  // The item itself is the screen. When the note carries attachments (an image,
  // PDF, video, link…), those ARE the item and show plainly; the written body
  // becomes part of the "details". A pure text note shows its body as the item.
  const hasAttachments = parsed.attachments.length > 0;
  const bodyMarkdown = parsed.body ? (
    <div className="text-[0.9rem] leading-relaxed text-black/85 dark:text-white/85 break-words [&_p]:my-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-4 [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_a]:text-[#c2603f] [&_a]:underline [&_code]:rounded [&_code]:bg-black/[0.06] dark:[&_code]:bg-white/[0.08] [&_code]:px-1 [&_code]:py-0.5 [&_blockquote]:border-l-2 [&_blockquote]:border-black/15 dark:[&_blockquote]:border-white/20 [&_blockquote]:pl-3 [&_blockquote]:text-black/65 dark:[&_blockquote]:text-white/65">
      <ReactMarkdown remarkPlugins={CHAT_REMARK_PLUGINS} rehypePlugins={CHAT_REHYPE_PLUGINS}>
        {parsed.body}
      </ReactMarkdown>
    </div>
  ) : null;
  const hasTags = Array.isArray(note.tags) && note.tags.length > 0;
  // Is there anything tucked behind the "Details" dropdown?
  const hasDetails = !!noteId || hasTags || (hasAttachments && !!parsed.body);

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-start justify-center p-4 sm:p-6 md:p-10"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* Scrim */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/45 backdrop-blur-sm cursor-default"
      />

      <div className="relative z-[1] w-full max-w-3xl max-h-[90vh] flex flex-col">
        {/* Minimal floating controls: a single Details dropdown + a little X. */}
        <div className="flex items-center justify-between gap-2 mb-2">
          {hasDetails ? (
            <button
              type="button"
              onClick={() => setDetailsOpen((v) => !v)}
              aria-expanded={detailsOpen}
              className="inline-flex items-center gap-1.5 pl-3 pr-2.5 py-1.5 rounded-full bg-white/90 dark:bg-white/10 backdrop-blur border border-black/10 dark:border-white/15 text-[0.75rem] font-medium text-black/65 dark:text-white/75 hover:bg-white dark:hover:bg-white/15 shadow-sm transition-colors"
            >
              <Info size={13} />
              <span className="max-w-[14rem] truncate">{title}</span>
              <ChevronDown size={13} className={`transition-transform ${detailsOpen ? "rotate-180" : ""}`} />
            </button>
          ) : (
            <span className="text-[0.78rem] font-medium text-white/80 px-1 max-w-[16rem] truncate drop-shadow">{title}</span>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/90 dark:bg-white/10 backdrop-blur border border-black/10 dark:border-white/15 text-black/60 dark:text-white/70 hover:bg-white dark:hover:bg-white/15 shadow-sm transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Details dropdown — everything tied to the item lives here. */}
        {detailsOpen && hasDetails ? (
          <div className="mb-2 rounded-2xl border border-black/10 dark:border-white/12 bg-white/95 dark:bg-[#15161a]/95 backdrop-blur-xl shadow-[0_16px_50px_rgba(0,0,0,0.3)] px-4 py-3.5 max-h-[42vh] overflow-y-auto space-y-3">
            {noteId ? (
              <button
                type="button"
                onClick={openInVault}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-black/10 dark:border-white/12 text-[0.72rem] font-medium text-black/60 dark:text-white/65 hover:text-black/90 dark:hover:text-white/95 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
              >
                Open in vault
                <ArrowUpRight size={13} />
              </button>
            ) : null}
            {hasAttachments && bodyMarkdown ? bodyMarkdown : null}
            {hasTags ? (
              <div className="flex flex-wrap gap-1.5">
                {note.tags!.map((t) => (
                  <span
                    key={t}
                    className="text-[0.6rem] uppercase tracking-[0.12em] text-black/45 dark:text-white/45 px-2 py-0.5 rounded bg-black/[0.04] dark:bg-white/[0.05]"
                  >
                    {t}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* The item — shown plainly as what it is. */}
        <div className="flex-1 min-h-0 overflow-y-auto rounded-2xl">
          {loading ? (
            <div className="flex items-center gap-2 text-[0.78rem] text-white/70 px-1 pb-3">
              <Loader2 size={13} className="animate-spin" />
              Loading…
            </div>
          ) : null}

          {hasAttachments ? (
            <div className="space-y-3">
              {parsed.attachments.map((att, i) => (
                <VaultAttachment key={i} att={att} full />
              ))}
            </div>
          ) : bodyMarkdown ? (
            <div className="rounded-2xl border border-black/10 dark:border-white/12 bg-white/95 dark:bg-[#15161a]/95 backdrop-blur-xl shadow-[0_24px_80px_rgba(0,0,0,0.35)] px-5 sm:px-6 py-5">
              {bodyMarkdown}
            </div>
          ) : !loading ? (
            <p className="text-[0.85rem] italic text-white/60 px-1">This item has no content.</p>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default VaultDocumentViewer;
