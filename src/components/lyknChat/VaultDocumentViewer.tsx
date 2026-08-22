import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, ChevronDown, Info, Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import VaultAttachment from "@/components/synthesis/VaultAttachment";
import LyknMediaPop, { MEDIA_POP_PANEL } from "@/components/lyknChat/LyknMediaPop";
import { parseVaultContent } from "@/lib/vaultContent";
import { CHAT_REMARK_PLUGINS, CHAT_REHYPE_PLUGINS } from "@/lib/chat/chatMarkdown";
import { flushAndNavigate } from "@/lib/chat/flushAndNavigate";
import { supabase } from "@/lib/supabase";
import type { ChatNeuronVaultPayload } from "@/components/lyknChat/ChatNeuronCard";

// ============================================================================
// VaultDocumentViewer — pull-up through the Imagine media pop
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

  // Always re-fetch on open. loadNeuron may truncate mid-[ATTACHMENTS_JSON]
  // (or omit storage fields), which leaves Pull-up with a title and no
  // renderable iframe. Fresh row content restores the attachment marker.
  useEffect(() => {
    if (!open || !noteId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const { data } = await supabase
          .from("vault_items")
          .select("content")
          .eq("id", noteId)
          .maybeSingle();
        if (!cancelled && data?.content) setFullContent(String(data.content));
      } catch {
        /* fall back to the card content */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, noteId]);

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

  const openInVault = useCallback(() => {
    if (!noteId) return;
    onClose();
    flushAndNavigate(navigate, `/vault?note=${encodeURIComponent(noteId)}`);
  }, [navigate, noteId, onClose]);

  const title = String(note?.title || "Untitled note").trim() || "Untitled note";
  const hasAttachments = parsed.attachments.length > 0;
  const bodyMarkdown = parsed.body ? (
    <div className="text-[0.9rem] leading-relaxed text-black/85 dark:text-white/85 break-words [&_p]:my-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-4 [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_a]:text-[#c2603f] [&_a]:underline [&_code]:rounded [&_code]:bg-black/[0.06] dark:[&_code]:bg-white/[0.08] [&_code]:px-1 [&_code]:py-0.5 [&_blockquote]:border-l-2 [&_blockquote]:border-black/15 dark:[&_blockquote]:border-white/20 [&_blockquote]:pl-3 [&_blockquote]:text-black/65 dark:[&_blockquote]:text-white/65">
      <ReactMarkdown remarkPlugins={CHAT_REMARK_PLUGINS} rehypePlugins={CHAT_REHYPE_PLUGINS}>
        {parsed.body}
      </ReactMarkdown>
    </div>
  ) : null;
  const hasTags = Array.isArray(note?.tags) && note.tags.length > 0;
  const hasDetails = !!noteId || hasTags || (hasAttachments && !!parsed.body);

  return (
    <LyknMediaPop
      open={open && !!note}
      onClose={onClose}
      title={title}
      hint={
        hasDetails ? (
          <button
            type="button"
            onClick={() => setDetailsOpen((v) => !v)}
            aria-expanded={detailsOpen}
            className="flex items-center gap-1.5 text-[11px] font-medium"
          >
            <Info size={13} />
            <span className="max-w-[14rem] truncate">{title}</span>
            <ChevronDown size={13} className={`transition-transform ${detailsOpen ? "rotate-180" : ""}`} />
          </button>
        ) : undefined
      }
      footer={
        detailsOpen && hasDetails ? (
          <div className={`space-y-3 rounded-2xl px-4 py-3.5 ${MEDIA_POP_PANEL}`}>
            {noteId ? (
              <button
                type="button"
                onClick={openInVault}
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.72rem] font-medium opacity-70 hover:bg-black/[0.04] hover:opacity-100 dark:hover:bg-white/[0.06]"
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
                    className="rounded bg-black/[0.04] px-2 py-0.5 text-[0.6rem] uppercase tracking-[0.12em] opacity-50 dark:bg-white/[0.05]"
                  >
                    {t}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null
      }
    >
      <div className="max-h-[min(68vh,720px)] w-[min(92vw,920px)] overflow-y-auto">
        {loading ? (
          <div className={`mb-3 flex items-center gap-2 rounded-2xl px-4 py-3 text-[0.78rem] ${MEDIA_POP_PANEL}`}>
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
          <div className={`rounded-2xl px-5 py-5 sm:px-6 ${MEDIA_POP_PANEL}`}>{bodyMarkdown}</div>
        ) : !loading ? (
          <p className="px-1 text-[0.85rem] italic opacity-60">This item has no content.</p>
        ) : null}
      </div>
    </LyknMediaPop>
  );
}

export default VaultDocumentViewer;
