// useChatAttachmentIngress owns page-level attachment ingress beyond
// useChatComposerAttachments (which already owns focusedChatAttachments +
// paste + vault-drop core). Board import, Mac-path drops, vault picker
// events, link add, overlay drop, and attach-adjacent quick note live here.
// Extracted from src/pages/LyknChat.tsx (LyknChat decomposition).
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import { notifyVaultCapIfApplicable } from "@/lib/vault/vaultCapError";
import { supabase } from "@/lib/supabase";
import { extractYouTubeVideoId } from "@/lib/media/youtube";
import { ingestChatFiles } from "@/lib/chat/ingestChatFiles";
import { useDropZone } from "@/lib/drag/dragEngine";
import {
  fileNameFromPath,
  filesFromMacPaths,
  homeChatArtifactKey,
  listStagedHomeChatArtifacts,
  onHomeChatArtifactsQueued,
  onHomeChatFilesQueued,
  snapshotMacFolders,
  takeQueuedHomeChatFiles,
  unstageHomeChatArtifact,
} from "@/lib/homeChatFiles";
import {
  VAULT_PICK_ITEMS_EVENT,
  VAULT_PICK_PATHS_EVENT,
  openVaultPicker,
} from "@/lib/vault/vaultPicker";
import { stripAttachmentsMarker } from "@/lib/vault/attachmentsMarker";
import type { AddLinkPreview } from "@/components/AddLinkDialog";
import {
  CHAT_TO_BOARD_IMPORT_KEY,
  type FocusedChatAttachment,
  type ImportedChatBoardPayload,
  type PromptMessage,
} from "@/lib/lyknChat/chatTurnTypes";
import {
  inferUrlAttachmentType,
  makeAttId,
} from "@/lib/lyknChat/chatAttachmentInput";
import {
  focusedAttachmentFromArtifact,
  isChatArtifact,
} from "@/lib/lyknChat/artifactChatAttach";
import FocusedAttachmentPreview from "@/components/lyknChat/FocusedAttachmentPreview";

export function useChatAttachmentIngress({
  addFocusedAttachment,
  removeFocusedAttachment,
  updateFocusedAttachment,
  applyVaultDropToChat,
  setFocusedChatAttachments,
  chatPanelInputRef,
  userId,
  chatId,
  setChatMessages,
  aiThreadRef,
  requireSignIn,
  checkVaultLimit,
  selectedMediaIds,
  setSelectedMediaIds,
  setShowMediaSuggestion,
  setMediaSuggestions,
}: {
  addFocusedAttachment: (att: FocusedChatAttachment) => void;
  removeFocusedAttachment: (id: string) => void;
  updateFocusedAttachment: (id: string, patch: Record<string, unknown>) => void;
  applyVaultDropToChat: (payload: any) => Promise<void>;
  setFocusedChatAttachments: Dispatch<SetStateAction<FocusedChatAttachment[]>>;
  chatPanelInputRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  userId: string | undefined;
  chatId: string | null;
  setChatMessages: Dispatch<SetStateAction<PromptMessage[]>>;
  aiThreadRef: React.MutableRefObject<Array<{ role: "user" | "assistant"; content: string }>>;
  requireSignIn: (what?: string) => void;
  checkVaultLimit: () => Promise<boolean>;
  selectedMediaIds: Set<string>;
  setSelectedMediaIds: Dispatch<SetStateAction<Set<string>>>;
  setShowMediaSuggestion: Dispatch<SetStateAction<boolean>>;
  setMediaSuggestions: Dispatch<SetStateAction<Array<{ title: string; reason: string; noteId: string }>>>;
}) {
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showAddLinkDialog, setShowAddLinkDialog] = useState(false);
  const [vaultDragActive, setVaultDragActive] = useState(false);
  const [showQuickNote, setShowQuickNote] = useState(false);
  const [quickNoteContent, setQuickNoteContent] = useState("");
  const [isQuickNoteSaving, setIsQuickNoteSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const chatImportAppliedRef = useRef<string | null>(null);
  const [importingMedia, setImportingMedia] = useState(false);

  useEffect(() => {
    if (!chatId || !userId) return;
    if (chatImportAppliedRef.current === chatId) return;

    let raw = "";
    try {
      raw = String(localStorage.getItem(CHAT_TO_BOARD_IMPORT_KEY) || "");
    } catch {
      return;
    }
    if (!raw) return;

    let payload: ImportedChatBoardPayload | null = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      try {
        localStorage.removeItem(CHAT_TO_BOARD_IMPORT_KEY);
      } catch {
        // ignore
      }
      return;
    }

    if (!payload || String(payload.chatId || "") !== String(chatId)) return;

    const createdAt = Number(payload.createdAt || 0);
    if (createdAt > 0 && Date.now() - createdAt > 30 * 60 * 1000) {
      try {
        localStorage.removeItem(CHAT_TO_BOARD_IMPORT_KEY);
      } catch {
        // ignore
      }
      return;
    }

    const importedPrompts = (Array.isArray(payload.prompts) ? payload.prompts : [])
      .map((p, idx) => {
        const content = String(p?.content || "").trim();
        if (!content) return null;
        const aiResponse = String(p?.aiResponse || "").trim();
        return {
          id: String(p?.id || `import-prompt-${idx + 1}`),
          role: "user" as const,
          content,
          kind: "prompt" as const,
          aiResponse: aiResponse || undefined,
        };
      })
      .filter(Boolean) as PromptMessage[];

    try {
      localStorage.removeItem(CHAT_TO_BOARD_IMPORT_KEY);
    } catch {
      // ignore
    }
    chatImportAppliedRef.current = String(chatId);

    if (importedPrompts.length) {
      setChatMessages(importedPrompts);
      aiThreadRef.current = importedPrompts.flatMap((p) =>
        p.aiResponse
          ? [
              { role: "user" as const, content: p.content },
              { role: "assistant" as const, content: p.aiResponse },
            ]
          : [{ role: "user" as const, content: p.content }]
      );
    }

    const importedAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    for (const att of importedAttachments) {
      const url = String(att.url || "").trim();
      const attType = String(att.type || "").toLowerCase();
      const videoId = att.videoId || (attType === "youtube" ? (extractYouTubeVideoId(url) || "") : "");
      if (attType === "vault" && att.vaultContent) {
        addFocusedAttachment({
          id: makeAttId(),
          type: "vault",
          url: "",
          name: String(att.vaultTitle || att.name || "Vault item"),
          mime: "",
          size: 0,
          vaultTitle: String(att.vaultTitle || ""),
          vaultContent: String(att.vaultContent),
        });
        continue;
      }
      if (!url && !att.pdfText && !att.extractedText) continue;
      addFocusedAttachment({
        id: makeAttId(),
        type: attType || inferUrlAttachmentType(url),
        url,
        name: String(att.name || att.vaultTitle || url || "Attachment"),
        mime: String(att.mime || ""),
        size: 0,
        ...(videoId ? { videoId } : {}),
        ...(att.pdfText ? { pdfText: String(att.pdfText) } : {}),
        ...(att.extractedText ? { extractedText: String(att.extractedText) } : {}),
        ...(att.transcript ? { transcript: String(att.transcript) } : {}),
      });
    }
  }, [addFocusedAttachment, chatId, userId]);

  const handleSaveQuickNote = useCallback(async () => {
    if (isQuickNoteSaving) return;
    if (!userId) { requireSignIn("save notes"); return; }
    const content = quickNoteContent.trim();
    if (!content) return;
    if (!(await checkVaultLimit())) return;
    setIsQuickNoteSaving(true);
    try {
      const { error } = await supabase
        .from("vault_items")
        .insert({ user_id: userId, title: "Quick Note", content, source: "quick_note" })
        .select("id")
        .single();
      if (error) {
        if (notifyVaultCapIfApplicable(error)) {
          return;
        }
        const { error: fallbackError } = await supabase
          .from("vault_items")
          .insert({ user_id: userId, title: "Quick Note", content })
          .select("id")
          .single();
        if (fallbackError && notifyVaultCapIfApplicable(fallbackError)) {
          return;
        }
      }
      setQuickNoteContent("");
      setShowQuickNote(false);
    } catch { /* ignore */ } finally {
      setIsQuickNoteSaving(false);
    }
  }, [userId, isQuickNoteSaving, quickNoteContent, requireSignIn]);

  const handleCloseQuickNote = useCallback(async () => {
    if (isQuickNoteSaving) return;
    if (!quickNoteContent.trim()) {
      setShowQuickNote(false);
      setQuickNoteContent("");
      return;
    }
    await handleSaveQuickNote();
  }, [handleSaveQuickNote, isQuickNoteSaving, quickNoteContent]);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      // The embedded vault sidebar is same-origin; reject cross-origin
      // messages so an external page (e.g. one that window.open()'d us) can't
      // inject attachments into the composer or drive storage-signing calls.
      if (e.origin !== window.location.origin) return;
      if (!e.data || typeof e.data !== "object") return;
      if (e.data.type === "lykn-chat-vault-drag-start" && e.data.data) {
        if (import.meta.env.DEV) console.log("[VAULT-DRAG] drag-start received");
        (window as any).__lyknchat_pending_vault = { ...e.data.data, timestamp: Date.now() };
        setVaultDragActive(true);
      }
      if (e.data.type === "lykn-chat-vault-drag-end") {
        if (import.meta.env.DEV) console.log("[VAULT-DRAG] drag-end received");
        setVaultDragActive(false);
      }
      // Click-to-add from the embedded vault sidebar: the iframe posts the
      // same payload it would send on drag, and we run the exact drop-to-chat
      // logic so a single click attaches the item to the chat composer.
      if (e.data.type === "lykn-chat-vault-add" && e.data.data) {
        void applyVaultDropToChat({ ...e.data.data, timestamp: Date.now() });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [applyVaultDropToChat]);

  // Files and folders that live on the Mac, attached by absolute path —
  // vault-window picks and desktop-icon drags both land here. Files get the
  // full ingest pipeline; folders have no bytes to read, so they come in as
  // a listing the model can answer "what's in this" from.
  const ingestMacPathsToChat = useCallback(
    async (picked: string[]) => {
      if (!Array.isArray(picked) || !picked.length) return;
      const files = await filesFromMacPaths(picked);
      if (files.length) {
        await ingestChatFiles(files, addFocusedAttachment, {
          userId,
          updateAttachment: updateFocusedAttachment,
        });
      }
      const folders = await snapshotMacFolders(
        picked.filter((p: string) => !files.some((f) => f.name === fileNameFromPath(p))),
      );
      for (const folder of folders) {
        addFocusedAttachment({
          id: makeAttId(),
          type: "folder",
          url: "",
          name: folder.name,
          mime: "",
          size: 0,
          vaultTitle: folder.name,
          vaultContent: folder.listing,
          localPath: folder.path,
        });
      }
    },
    [addFocusedAttachment, updateFocusedAttachment, userId],
  );
  const ingestMacPathsRef = useRef(ingestMacPathsToChat);
  ingestMacPathsRef.current = ingestMacPathsToChat;

  // Files stay take-once: the home bar claims them when it is on screen.
  // Artifacts are staged for every composer — Home hides this shell, and a
  // Chat window has its own bar, so skipping here left the chip on a bar
  // the user could not see.
  useEffect(() => {
    const homeBarUp = () => !!document.querySelector(".lykn-home-chat-bar");
    const claimFiles = () => {
      if (homeBarUp()) return;
      const files = takeQueuedHomeChatFiles();
      if (!files.length) return;
      void ingestChatFiles(files, addFocusedAttachment, {
        userId,
        updateAttachment: updateFocusedAttachment,
      });
      chatPanelInputRef.current?.focus();
    };
    const syncArtifacts = (event?: Event) => {
      const detail = event && "detail" in event ? (event as CustomEvent).detail : null;
      const arts = Array.isArray(detail?.artifacts)
        ? detail.artifacts
        : listStagedHomeChatArtifacts();
      setFocusedChatAttachments((prev) => {
        const others = prev.filter((row) => row.type !== "artifact");
        const existing = prev.filter((row) => row.type === "artifact");
        const nextArts = [];
        for (const artifact of arts) {
          if (!isChatArtifact(artifact)) continue;
          const id = String(artifact.id || "");
          const found = id
            ? existing.find(
                (row) =>
                  String((row.artifact as { id?: string } | undefined)?.id || "") === id,
              )
            : null;
          nextArts.push(found || focusedAttachmentFromArtifact(artifact));
        }
        return [...others, ...nextArts];
      });
      if (arts.length) chatPanelInputRef.current?.focus();
    };
    claimFiles();
    syncArtifacts();
    const unsubFiles = onHomeChatFilesQueued(claimFiles);
    const unsubArts = onHomeChatArtifactsQueued(syncArtifacts);
    return () => {
      unsubFiles();
      unsubArts();
    };
  }, [
    addFocusedAttachment,
    chatPanelInputRef,
    setFocusedChatAttachments,
    updateFocusedAttachment,
    userId,
  ]);

  // Desktop icons dragged onto the open chat. They carry paths, not File
  // objects (the drag engine is pointer-based, not HTML5), so they can't ride
  // the dataTransfer drop above — this zone catches them anywhere on the
  // surface and attaches them to the composer.
  const macPathDrop = useDropZone({
    // Attaching leaves the original on the desktop, so the drag wears the
    // green "+" — the same badge macOS shows for a copy.
    copies: true,
    accept: (payload: { paths: string[] }) => payload.paths.length > 0,
    onDrop: (payload: { paths: string[] }) => void ingestMacPathsRef.current(payload.paths),
  });

  // A pick from the vault window. That window is a real Finder now rather than
  // an iframe inside this page, so the choice arrives as an event instead of a
  // postMessage — as AI Drive items, or as paths when the pick came from a
  // folder on the Mac. Imagine shares the chat composer, so picks land here
  // in every mode.
  useEffect(() => {
    const onItems = (e: Event) => {
      const detail = (e as CustomEvent).detail as Record<string, unknown> | null;
      if (!detail || typeof detail !== "object") return;
      void applyVaultDropToChat({ ...detail, timestamp: Date.now() });
    };

    const onPaths = (e: Event) => {
      const picked = (e as CustomEvent).detail?.paths;
      if (!Array.isArray(picked) || !picked.length) return;
      void ingestMacPathsRef.current(picked);
    };

    window.addEventListener(VAULT_PICK_ITEMS_EVENT, onItems);
    window.addEventListener(VAULT_PICK_PATHS_EVENT, onPaths);
    return () => {
      window.removeEventListener(VAULT_PICK_ITEMS_EVENT, onItems);
      window.removeEventListener(VAULT_PICK_PATHS_EVENT, onPaths);
    };
  }, [applyVaultDropToChat]);

  // Vault page "Chat" on a pulled-up card: stash payload, navigate here, then
  // attach it with the same path as embedded click-to-add.
  useEffect(() => {
    let raw = "";
    try {
      raw = sessionStorage.getItem("lykn_pending_vault_chat_add") || "";
      if (raw) sessionStorage.removeItem("lykn_pending_vault_chat_add");
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        void applyVaultDropToChat({ ...data, timestamp: Date.now() });
      }
    } catch {
      /* ignore bad payload */
    }
  }, [applyVaultDropToChat]);

  // Add a URL as a focused chat attachment. Shows the chip instantly, then
  // unfurls Open Graph metadata in the background (unless the Add Link
  // dialog already provided a preview) so the sent message renders the
  // same rich LinkPreview card the Vault shows.
  const addLinkToChat = useCallback((rawUrl: string, preview?: AddLinkPreview | null) => {
    const trimmedUrl = String(rawUrl || preview?.url || "").trim();
    if (!trimmedUrl) return;
    const urlType = inferUrlAttachmentType(trimmedUrl);
    const videoId = urlType === "youtube" ? (extractYouTubeVideoId(trimmedUrl) || "") : "";
    const attId = makeAttId();
    const hasPreviewMeta = Boolean(
      preview && (preview.title || preview.description || preview.image || preview.siteName),
    );
    addFocusedAttachment({
      id: attId,
      type: urlType,
      url: trimmedUrl,
      name: preview?.title || trimmedUrl,
      mime: "",
      size: 0,
      ...(videoId ? { videoId } : {}),
      ...(hasPreviewMeta
        ? {
            linkTitle: preview?.title || "",
            linkDescription: preview?.description || "",
            linkImage: preview?.image || "",
            linkSiteName: preview?.siteName || "",
            linkFavicon: preview?.favicon || "",
            oembedType: preview?.oembedType || "",
            authorName: preview?.authorName || "",
            authorHandle: preview?.authorHandle || "",
          }
        : {}),
    });
    window.setTimeout(() => chatPanelInputRef.current?.focus(), 0);
    if (urlType === "link" && !hasPreviewMeta) {
      void (async () => {
        try {
          const { API_BASE_URL } = await import("@/lib/api-config");
          const res = await fetch(`${API_BASE_URL}/api/unfurl?url=${encodeURIComponent(trimmedUrl)}`);
          if (!res.ok) return;
          const meta = await res.json();
          setFocusedChatAttachments((prev) =>
            prev.map((a) =>
              a.id === attId
                ? {
                    ...a,
                    name: meta?.title || a.name,
                    linkTitle: meta?.title || "",
                    linkDescription: meta?.description || "",
                    linkImage: meta?.image || "",
                    linkSiteName: meta?.siteName || "",
                    linkFavicon: meta?.favicon || "",
                    oembedType: meta?.oembedType || "",
                    authorName: meta?.authorName || "",
                    authorHandle: meta?.authorHandle || "",
                  }
                : a
            )
          );
        } catch { /* unfurl is best-effort; the URL-only card still renders */ }
      })();
    }
  }, [addFocusedAttachment, inferUrlAttachmentType, setFocusedChatAttachments]);

  // --- Chat-bar "+" menu handlers ---------------------------------------
  const handlePickFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleAddLinkClick = useCallback(() => {
    // Same panel as Vault → Add link. Electron blocks window.prompt().
    setShowAddLinkDialog(true);
  }, []);

  const handleConfirmAddLink = useCallback((preview: AddLinkPreview) => {
    const url = String(preview?.url || "").trim();
    if (!url) return;
    addLinkToChat(url, preview);
    setShowAddLinkDialog(false);
  }, [addLinkToChat]);

  // The vault is the Finder window, so picking from it opens that rather than
  // an embedded copy of the old Vault page. "thread" is what brings the choice
  // back to this chat instead of pushing it at the desktop bar.
  const handlePullFromVault = useCallback(() => {
    openVaultPicker("thread");
  }, []);

  useEffect(() => {
    const openSidebar = () => openVaultPicker("thread");
    window.addEventListener("lyknchat_open_vault_sidebar", openSidebar);
    return () => window.removeEventListener("lyknchat_open_vault_sidebar", openSidebar);
  }, []);

  const renderFocusedAttachmentPreview = useCallback((att: FocusedChatAttachment): React.ReactNode => (
    <FocusedAttachmentPreview
      att={att}
      onRemove={(id) => {
        // A staged build's chip is mirrored on the Home pill from the shared
        // staged list — unstage it too, or the sync would put it right back.
        if (att.type === "artifact") {
          unstageHomeChatArtifact(homeChatArtifactKey(att.artifact));
        }
        removeFocusedAttachment(id);
      }}
      chatId={chatId}
    />
  ), [removeFocusedAttachment, chatId]);

  const handleFocusedChatDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleFocusedChatDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const vaultRaw = e.dataTransfer.getData("application/x-lykn-chat-vault");
    if (vaultRaw) {
      try {
        const payload = JSON.parse(vaultRaw) as Record<string, unknown>;
        (window as any).__lyknchat_pending_vault = null;
        void applyVaultDropToChat(payload);
        return;
      } catch { /* fall through */ }
    }

    const text = (e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("text") || "").trim();
    if (text) {
      const urls = text.split(/\r?\n/).filter((u: string) => /^https?:\/\//i.test(u.trim()));
      if (urls.length > 0) {
        for (const u of urls) {
          const trimmedUrl = u.trim();
          const urlType = inferUrlAttachmentType(trimmedUrl);
          const videoId = urlType === "youtube" ? (extractYouTubeVideoId(trimmedUrl) || "") : "";
          addFocusedAttachment({
            id: makeAttId(),
            type: urlType,
            url: trimmedUrl,
            name: trimmedUrl,
            mime: "",
            size: 0,
            ...(videoId ? { videoId } : {}),
          });
        }
      } else {
        addFocusedAttachment({ id: makeAttId(), type: "vault", url: "", name: "Dropped text", mime: "", size: 0, vaultTitle: "Dropped text", vaultContent: text });
      }
    }
    // Materialized synchronously: the FileList dies with the event.
    const files = Array.from(e.dataTransfer.files);
    if (files.length) {
      void ingestChatFiles(files, addFocusedAttachment, {
        userId,
        updateAttachment: updateFocusedAttachment,
      });
    }
    window.setTimeout(() => chatPanelInputRef.current?.focus(), 0);
  }, [addFocusedAttachment, applyVaultDropToChat, updateFocusedAttachment, userId]);

  const handleVaultOverlayDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setVaultDragActive(false);
    window.dispatchEvent(new CustomEvent("lyknchat_interact"));
    const pending = (window as any).__lyknchat_pending_vault;
    if (import.meta.env.DEV) console.log("[VAULT-DROP] overlay onDrop fired");
    if (!pending || typeof pending !== "object") { if (import.meta.env.DEV) console.log("[VAULT-DROP] no pending data"); return; }
    (window as any).__lyknchat_pending_vault = null;

    void applyVaultDropToChat(pending);
  }, [applyVaultDropToChat]);

  const handleImportMedia = useCallback(async () => {
    if (selectedMediaIds.size === 0) return;
    setImportingMedia(true);
    try {
      const noteIds = [...selectedMediaIds];
      const { data: notes } = await supabase
        .from("vault_items")
        .select("id, title, content")
        .in("id", noteIds);
      if (!notes || notes.length === 0) return;

      const parseNoteAtts = (content: string): any[] => {
        const marker = "[ATTACHMENTS_JSON:";
        const start = (content || "").indexOf(marker);
        if (start === -1) return [];
        const jsonStart = start + marker.length;
        let bc = 0, jsonEnd = jsonStart;
        for (let i = jsonStart; i < content.length; i++) {
          if (content[i] === "[") bc++;
          if (content[i] === "]") { bc--; if (bc === 0) { jsonEnd = i + 1; break; } }
        }
        if (jsonEnd <= jsonStart) return [];
        try { return Array.isArray(JSON.parse(content.slice(jsonStart, jsonEnd))) ? JSON.parse(content.slice(jsonStart, jsonEnd)) : []; }
        catch { return []; }
      };
      const resolveType = (att: any): string => {
        const url = String(att?.url || "");
        const name = String(att?.name || "");
        if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
        const explicit = att?.type;
        if (explicit && explicit !== "file") return explicit;
        const extMatch = (url.split("/").pop() || name).match(/\.([^.]+)$/);
        const ext = extMatch ? extMatch[1].toLowerCase() : "";
        if (["jpg","jpeg","png","gif","webp","svg","heic","heif"].includes(ext)) return "image";
        if (["mp4","mov","webm"].includes(ext)) return "video";
        if (["mp3","wav","ogg","m4a"].includes(ext)) return "audio";
        if (ext === "pdf") return "pdf";
        return url ? "link" : "text";
      };

      for (const note of notes) {
        const atts = parseNoteAtts(note.content || "");
        if (atts.length === 0) {
          const ytMatch = (note.content || "").match(/https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
          if (ytMatch) {
            addFocusedAttachment({
              id: makeAttId(),
              type: "youtube",
              url: ytMatch[0],
              name: note.title || "YouTube",
              mime: "",
              size: 0,
              videoId: ytMatch[1],
            });
          } else {
            addFocusedAttachment({
              id: makeAttId(),
              type: "vault",
              url: "",
              name: note.title || "Vault item",
              mime: "",
              size: 0,
              vaultTitle: note.title || "",
              vaultContent: stripAttachmentsMarker(note.content || ""),
            });
          }
          continue;
        }
        for (const att of atts) {
          const url = String(att.url || "").trim();
          if (!url) continue;
          const type = resolveType(att);
          const vid = type === "youtube"
            ? (att.videoId || (url.match(/(?:v=|youtu\.be\/)([\w-]{11})/) || [])[1] || "")
            : "";
          addFocusedAttachment({
            id: makeAttId(),
            type,
            url,
            name: att.name || note.title || "File",
            mime: String(att.mime || ""),
            size: Number(att.size || 0),
            ...(vid ? { videoId: vid } : {}),
          });
        }
      }
    } catch { /* ignore */ }
    finally {
      setImportingMedia(false);
      setShowMediaSuggestion(false);
      setMediaSuggestions([]);
    }
  }, [addFocusedAttachment, selectedMediaIds]);

  const handleToggleMedia = useCallback((noteId: string) => {
    setSelectedMediaIds((prev) => {
      const next = new Set(prev);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  }, []);

  const handleDismissMedia = useCallback(() => {
    setShowMediaSuggestion(false);
    setMediaSuggestions([]);
  }, []);

  return {
    fileInputRef,
    showAttachMenu,
    setShowAttachMenu,
    showAddLinkDialog,
    setShowAddLinkDialog,
    vaultDragActive,
    setVaultDragActive,
    showQuickNote,
    setShowQuickNote,
    quickNoteContent,
    setQuickNoteContent,
    isQuickNoteSaving,
    importingMedia,
    macPathDrop,
    addLinkToChat,
    handlePickFiles,
    handleAddLinkClick,
    handleConfirmAddLink,
    handlePullFromVault,
    handleSaveQuickNote,
    handleCloseQuickNote,
    handleFocusedChatDragOver,
    handleFocusedChatDrop,
    handleVaultOverlayDrop,
    handleImportMedia,
    handleToggleMedia,
    handleDismissMedia,
    renderFocusedAttachmentPreview,
  };
}

export type UseChatAttachmentIngressReturn = ReturnType<typeof useChatAttachmentIngress>;
