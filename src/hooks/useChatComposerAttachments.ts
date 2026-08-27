// Composer attachment ingress + state for the chat engine. ONE owner for the
// "attachments staged on the next send" list (`focusedChatAttachments`) and
// every path that feeds it: clipboard paste (files + structured text),
// vault drag/drop payloads, and programmatic adds (file picker, links, Mac
// paths — the page-level ingress calls addFocusedAttachment). Extracted
// VERBATIM from useChatEngine.ts (C3B decomposition, see
// docs/REFACTOR_LOG.md); useChatEngine composes this hook and re-exposes its
// API unchanged.
import React, { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { supabase } from "@/lib/supabase";
import { extractYouTubeVideoId } from "@/lib/media/youtube";
import { getStructuredPasteFromEvent } from "@/lib/pasteFromClipboard";
import { ingestChatFiles } from "@/lib/chat/ingestChatFiles";
import { resizeChatInputEl } from "@/lib/chat/resizeChatInput";
import { isDeviceLocalUrl } from "@/lib/chat/deviceLocalImages";
import { inferUrlAttachmentType, makeAttId } from "@/lib/lyknChat/chatAttachmentInput";
import type { FocusedChatAttachment } from "@/lib/lyknChat/chatTurnTypes";

export interface UseChatComposerAttachmentsDeps {
  userId: string | undefined;
  /** Composer draft ref + has-text setter — paste splices text into the draft. */
  chatInputRef: React.MutableRefObject<string>;
  setChatInputHasText: (has: boolean) => void;
  /** Composer textarea, refocused after a vault drop lands. */
  chatPanelInputRef: React.MutableRefObject<HTMLTextAreaElement | null>;
}

export interface UseChatComposerAttachmentsReturn {
  focusedChatAttachments: FocusedChatAttachment[];
  setFocusedChatAttachments: Dispatch<SetStateAction<FocusedChatAttachment[]>>;
  addFocusedAttachment: (att: FocusedChatAttachment) => void;
  removeFocusedAttachment: (id: string) => void;
  updateFocusedAttachment: (id: string, patch: Record<string, unknown>) => void;
  handleChatPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  applyVaultDropToChat: (payload: any) => Promise<void>;
}

export function useChatComposerAttachments(
  deps: UseChatComposerAttachmentsDeps,
): UseChatComposerAttachmentsReturn {
  const { userId, chatInputRef, setChatInputHasText, chatPanelInputRef } = deps;

  const [focusedChatAttachments, setFocusedChatAttachments] = useState<FocusedChatAttachment[]>([]);

  const removeFocusedAttachment = useCallback((id: string) => {
    setFocusedChatAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const addFocusedAttachment = useCallback((att: FocusedChatAttachment) => {
    setFocusedChatAttachments((prev) => {
      const isDup = prev.some((ex) => {
        if (att.url && ex.url && att.url === ex.url) return true;
        if (att.videoId && ex.videoId && att.videoId === ex.videoId) return true;
        if (att.type === "vault" && ex.type === "vault" && att.vaultContent && ex.vaultContent && att.vaultContent === ex.vaultContent) return true;
        if (att.type === "note" && ex.type === "note" && att.vaultContent && ex.vaultContent && att.vaultContent === ex.vaultContent) return true;
        if (att.type === "folder" && ex.type === "folder" && att.vaultContent && ex.vaultContent && att.vaultContent === ex.vaultContent) return true;
        return false;
      });
      return isDup ? prev : [...prev, att];
    });
  }, []);

  // Patch an existing composer attachment in place (e.g. to backfill a durable
  // storagePath once a background upload lands). Keyed by attachment id.
  const updateFocusedAttachment = useCallback((id: string, patch: Record<string, unknown>) => {
    setFocusedChatAttachments((prev) =>
      prev.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    );
  }, []);

  const handleChatPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // Branch on HTML, a file payload (pasted screenshots / copied files), or
    // neither. When only plain text is present we let the browser paste it
    // natively — that path also preserves default textarea behaviour (undo,
    // IME, etc).
    const ta = e.currentTarget;
    const html = e.clipboardData.getData("text/html");
    // Materialize the FileList synchronously: it is tied to the event and
    // becomes unusable once the handler returns (the File objects survive).
    const pastedFiles = e.clipboardData.files ? Array.from(e.clipboardData.files) : [];
    const hasFiles = pastedFiles.length > 0;
    if (!html.trim() && !hasFiles) return;

    // Pasted files (screenshots, copied images, file copies) become chat
    // attachments via the same pipeline as the composer file picker.
    if (hasFiles) {
      e.preventDefault();
      void ingestChatFiles(pastedFiles, addFocusedAttachment, {
        userId,
        updateAttachment: updateFocusedAttachment,
      });
    }

    const text = getStructuredPasteFromEvent(e);
    // Image-only pastes have no text/html or text/plain → nothing to insert.
    if (!text) {
      if (hasFiles) setTimeout(() => ta?.focus?.(), 0);
      return;
    }

    e.preventDefault();
    const start = ta.selectionStart; const end = ta.selectionEnd;
    const prev = chatInputRef.current;
    const newVal = prev.slice(0, start) + text + prev.slice(end);
    chatInputRef.current = newVal;
    ta.value = newVal;
    setChatInputHasText(!!newVal.trim());
    resizeChatInputEl(ta);
    const nc = start + text.length;
    setTimeout(() => { ta.selectionStart = ta.selectionEnd = nc; ta.focus(); }, 0);
  }, [addFocusedAttachment, updateFocusedAttachment, userId, chatInputRef, setChatInputHasText]);

  const applyVaultDropToChat = useCallback(async (payload: any) => {
    if (!payload) return;
    const title2 = String(payload.title || "Vault item").trim();
    const content = String(payload.content || "").trim();
    const payloadAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    if (payloadAttachments.length > 0) {
      for (const att of payloadAttachments) {
        const attType = String(att?.type || "").toLowerCase();
        let url = String(att?.url || "").trim();
        let videoId = String(att?.videoId || "").trim();
        if (!videoId && attType === "youtube") videoId = extractYouTubeVideoId(url) || "";
        if (!url && videoId) url = `https://www.youtube.com/watch?v=${videoId}`;
        const pathOnly = String(att?.storagePath || "").trim();
        const bucket = String(att?.storageBucket || "user-files").trim() || "user-files";
        // Bytes already on this device have no bucket to sign against — their
        // `lykn-blob://` url is already loadable, and the send path swaps it
        // for inline bytes so the model can see it too.
        if (!isDeviceLocalUrl(url) && (!url || (!url.startsWith("http") && !url.startsWith("data:") && attType !== "youtube"))) {
          try { const path = pathOnly || url; if (path) { const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60 * 24 * 7); if (data?.signedUrl) url = data.signedUrl; } } catch {}
        }
        // Carry the durable storagePath onto the chat attachment. The signed
        // `url` above is stripped when the chat is persisted (signed URLs are
        // short-lived); keeping storagePath lets reSignChatAttachments mint a
        // fresh URL on reload so the image doesn't break after leaving/returning.
        const storageMeta = pathOnly ? { storagePath: pathOnly, storageBucket: bucket } : {};
        const transcript = String(att?.transcript || "").trim();
        const pdfText = String(att?.pdfText || att?.extractedText || "").trim();
        if (!url && pdfText) { addFocusedAttachment({ id: makeAttId(), type: "pdf", url: "", name: String(att?.name || att?.title || title2 || "PDF").trim(), mime: String(att?.mime || "application/pdf"), size: Number(att?.size || 0), vaultTitle: title2, pdfText, ...storageMeta }); continue; }
        if (!url) continue;
        addFocusedAttachment({ id: makeAttId(), type: attType || inferUrlAttachmentType(url), url, name: String(att?.name || att?.title || title2 || url).trim(), mime: String(att?.mime || att?.mimeType || ""), size: Number(att?.size || 0), vaultTitle: title2, ...(videoId ? { videoId } : {}), ...(transcript ? { transcript } : {}), ...(pdfText ? { pdfText } : {}), ...storageMeta });
      }
    } else if (content) {
      addFocusedAttachment({ id: makeAttId(), type: "vault", url: "", name: title2 || "Vault item", mime: "", size: 0, vaultTitle: title2, vaultContent: content });
    }
    window.setTimeout(() => chatPanelInputRef.current?.focus(), 0);
  }, [addFocusedAttachment, chatPanelInputRef]);

  return {
    focusedChatAttachments,
    setFocusedChatAttachments,
    addFocusedAttachment,
    removeFocusedAttachment,
    updateFocusedAttachment,
    handleChatPaste,
    applyVaultDropToChat,
  };
}
