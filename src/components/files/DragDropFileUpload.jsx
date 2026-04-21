import { useCallback, useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { afterVaultNoteSaved } from "@/lib/vault/afterVaultSave";
import { describeVaultItemInBackground } from "@/lib/vault/describeVaultItem";
import { preloadVideoCompressor } from "@/lib/vault/compressMedia";
import { startVaultUploads } from "@/lib/vault/uploadPipeline";
import { useUserPlan } from "@/lib/useUserPlan";

/**
 * DragDropFileUpload
 *
 * Captures drag-and-drop and "Add media" button clicks from the vault page
 * and hands the resulting files off to `startVaultUploads`. All the heavy
 * lifting (compression, TUS uploads, post-processing, progress state) lives
 * in the global upload pipeline + Zustand store so it survives route changes
 * — the user can start uploading on /vault and keep browsing while the
 * background workers finish.
 */
export default function DragDropFileUpload({ onUploadComplete, onFileComplete, triggerRef, beforeUpload }) {
  const { user } = useAuth();
  const { planId } = useUserPlan();
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);
  const addMediaInputRef = useRef(null);
  const dragHideTimeoutRef = useRef(null);
  const internalCollageDragRef = useRef(false);

  const processFileList = useCallback(async (fileList) => {
    const files = [];
    for (const file of fileList) {
      if (file.webkitRelativePath) {
        files.push({
          file,
          folderPath: file.webkitRelativePath.split("/").slice(0, -1).join("/"),
          filename: file.name,
        });
      } else {
        files.push({ file, folderPath: null, filename: file.name });
      }
    }
    return files;
  }, []);

  const isYouTubeUrl = (url = "") =>
    /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(String(url).trim());

  const extractFirstUrl = (text = "") => {
    const match = String(text).match(/https?:\/\/[^\s<>"')]+/i);
    return match ? match[0] : "";
  };

  const createDroppedLinkNote = useCallback(
    async (url) => {
      if (!user?.id || !url) return false;
      if (beforeUpload && !(await beforeUpload())) return false;

      const trimmedUrl = String(url).trim();
      const youtube = isYouTubeUrl(trimmedUrl);

      let attachmentPayload;
      let noteTitle;
      let noteContent;

      if (youtube) {
        attachmentPayload = [{ type: "youtube", url: trimmedUrl, name: "YouTube Video" }];
        noteTitle = "YouTube Video";
        noteContent = `Link saved: ${trimmedUrl}\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachmentPayload)}]`;
      } else {
        let meta = { url: trimmedUrl, title: trimmedUrl, description: "", image: "", favicon: "", siteName: "", articleText: "" };
        try {
          const { API_BASE_URL } = await import("@/lib/api-config");
          const res = await fetch(`${API_BASE_URL}/api/unfurl?url=${encodeURIComponent(trimmedUrl)}`);
          if (res.ok) meta = await res.json();
        } catch {
          /* use defaults */
        }
        attachmentPayload = [{
          type: "bookmark",
          url: meta.url || trimmedUrl,
          name: meta.title || trimmedUrl,
          title: meta.title || "",
          description: meta.description || "",
          image: meta.image || "",
          favicon: meta.favicon || "",
          siteName: meta.siteName || "",
          articleText: meta.articleText || "",
          oembedType: meta.oembedType || "",
          oembedHtml: meta.oembedHtml || "",
          authorName: meta.authorName || "",
          authorHandle: meta.authorHandle || "",
        }];
        noteTitle = meta.title || trimmedUrl;
        noteContent = `${noteTitle}\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachmentPayload)}]`;
      }

      const richInsert = {
        user_id: user.id,
        title: noteTitle,
        content: noteContent,
        source: youtube ? "youtube_drop" : "link_drop",
        tags: youtube ? ["youtube", "uploaded"] : ["link", "uploaded"],
      };

      let noteError = null;
      let insertedNote = null;
      ({ data: insertedNote, error: noteError } = await supabase
        .from("notes")
        .insert(richInsert)
        .select("id, title, content, tags, created_at, updated_at")
        .single());

      const missingColumnError =
        noteError &&
        (
          noteError.code === "PGRST204" ||
          noteError.message?.includes("Could not find") ||
          noteError.message?.toLowerCase().includes("does not exist")
        );

      if (missingColumnError) {
        ({ data: insertedNote, error: noteError } = await supabase
          .from("notes")
          .insert({ user_id: user.id, title: noteTitle, content: noteContent })
          .select("id, title, content, created_at, updated_at")
          .single());
      }

      if (noteError) {
        if (import.meta.env.DEV) console.error("Error creating dropped link note:", noteError);
        return null;
      }

      if (insertedNote?.id) {
        const att = attachmentPayload[0] || {};
        const linkText = [att.title, att.description, att.articleText].filter(Boolean).join("\n").slice(0, 5000);
        describeVaultItemInBackground(insertedNote.id, {
          imageUrl: youtube ? undefined : att.image || undefined,
          textContent: linkText || undefined,
          fileType: youtube ? "youtube" : "bookmark",
          fileName: att.title || att.name || trimmedUrl,
        });
        afterVaultNoteSaved(user.id, insertedNote.id, {
          title: insertedNote.title || noteTitle,
          content: insertedNote.content || noteContent,
          extraPlain: linkText || undefined,
        });
      }

      return insertedNote || null;
    },
    [user?.id, beforeUpload],
  );

  const handleFileUpload = useCallback(
    async (acceptedFiles) => {
      if (!user?.id) {
        alert("Please sign in to upload files");
        return;
      }
      if (beforeUpload && !(await beforeUpload())) return;

      const filesToUpload = await processFileList(acceptedFiles);
      if (filesToUpload.length === 0) return;

      // Fire-and-forget: the global pipeline pushes all progress into the
      // Zustand store, so this component returns immediately and the user
      // can navigate away while uploads continue.
      startVaultUploads({
        userId: user.id,
        planId,
        files: filesToUpload,
        onAllComplete: onUploadComplete,
        onFileComplete,
      });
    },
    [user?.id, planId, beforeUpload, processFileList, onUploadComplete, onFileComplete],
  );

  const onDrop = useCallback(
    async (acceptedFiles) => {
      await handleFileUpload(acceptedFiles);
    },
    [handleFileUpload],
  );

  useEffect(() => {
    const handleFileSelect = async (e) => {
      const files = Array.from(e.detail?.files || []);
      if (files.length > 0) await handleFileUpload(files);
    };
    window.addEventListener("fileUploadTrigger", handleFileSelect);
    return () => window.removeEventListener("fileUploadTrigger", handleFileSelect);
  }, [handleFileUpload]);

  useEffect(() => {
    if (triggerRef) {
      triggerRef.current = () => {
        // User is about to open the picker – warm up the video compressor
        // so the first big .mov doesn't pay the ffmpeg.wasm cold-start cost.
        preloadVideoCompressor();
        addMediaInputRef.current?.click();
      };
    }
  }, [triggerRef]);

  useEffect(() => {
    const onInternalDragStart = () => {
      internalCollageDragRef.current = true;
      setIsDragging(false);
      if (dragHideTimeoutRef.current) {
        window.clearTimeout(dragHideTimeoutRef.current);
        dragHideTimeoutRef.current = null;
      }
    };
    const onInternalDragEnd = () => {
      internalCollageDragRef.current = false;
    };
    window.addEventListener("vault_collage_reorder_drag_start", onInternalDragStart);
    window.addEventListener("vault_collage_reorder_drag_end", onInternalDragEnd);
    return () => {
      window.removeEventListener("vault_collage_reorder_drag_start", onInternalDragStart);
      window.removeEventListener("vault_collage_reorder_drag_end", onInternalDragEnd);
    };
  }, []);

  useEffect(() => {
    const hasSupportedDropData = (event) => {
      if (internalCollageDragRef.current) return false;
      const types = event?.dataTransfer?.types;
      if (!types) return false;
      const allTypes = Array.from(types);
      if (allTypes.includes("application/x-omnia-chat-response")) return false;
      return (
        allTypes.includes("Files") ||
        allTypes.includes("text/uri-list") ||
        allTypes.includes("text/plain")
      );
    };

    const getDroppedUrl = (event) => {
      const uriList = event?.dataTransfer?.getData("text/uri-list") || "";
      const plain = event?.dataTransfer?.getData("text/plain") || "";
      const fromUri = extractFirstUrl(uriList);
      if (fromUri) return fromUri;
      return extractFirstUrl(plain);
    };

    const onWindowDragEnter = (event) => {
      if (internalCollageDragRef.current) return;
      if (!hasSupportedDropData(event)) return;
      event.preventDefault();
      if (dragHideTimeoutRef.current) {
        window.clearTimeout(dragHideTimeoutRef.current);
        dragHideTimeoutRef.current = null;
      }
      setIsDragging(true);
      preloadVideoCompressor();
    };

    const onWindowDragOver = (event) => {
      if (internalCollageDragRef.current) return;
      if (!hasSupportedDropData(event)) return;
      event.preventDefault();
      if (dragHideTimeoutRef.current) {
        window.clearTimeout(dragHideTimeoutRef.current);
        dragHideTimeoutRef.current = null;
      }
      setIsDragging(true);
    };

    const onWindowDragLeave = (event) => {
      if (internalCollageDragRef.current) return;
      if (!hasSupportedDropData(event)) return;
      event.preventDefault();
      if (dragHideTimeoutRef.current) {
        window.clearTimeout(dragHideTimeoutRef.current);
      }
      dragHideTimeoutRef.current = window.setTimeout(() => {
        setIsDragging(false);
      }, 80);
    };

    const onWindowDrop = async (event) => {
      if (internalCollageDragRef.current) return;
      if (!hasSupportedDropData(event)) return;
      event.preventDefault();
      if (dragHideTimeoutRef.current) {
        window.clearTimeout(dragHideTimeoutRef.current);
        dragHideTimeoutRef.current = null;
      }
      setIsDragging(false);
      const files = Array.from(event.dataTransfer.files || []);
      if (files.length > 0) {
        await onDrop(files);
        return;
      }
      const droppedUrl = getDroppedUrl(event);
      if (droppedUrl) {
        const createdNote = await createDroppedLinkNote(droppedUrl);
        if (createdNote?.id && onUploadComplete) onUploadComplete({ createdNotes: [createdNote] });
      }
    };

    window.addEventListener("dragenter", onWindowDragEnter);
    window.addEventListener("dragover", onWindowDragOver);
    window.addEventListener("dragleave", onWindowDragLeave);
    window.addEventListener("drop", onWindowDrop);

    return () => {
      window.removeEventListener("dragenter", onWindowDragEnter);
      window.removeEventListener("dragover", onWindowDragOver);
      window.removeEventListener("dragleave", onWindowDragLeave);
      window.removeEventListener("drop", onWindowDrop);
      if (dragHideTimeoutRef.current) {
        window.clearTimeout(dragHideTimeoutRef.current);
        dragHideTimeoutRef.current = null;
      }
    };
  }, [createDroppedLinkNote, onDrop, onUploadComplete]);

  const handleFileInput = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) onDrop(files);
  };

  return (
    <>
      <div
        className={`
          fixed inset-0
          ${isDragging
            ? "pointer-events-none bg-blue-500/20 dark:bg-blue-900/30 border-4 border-dashed border-blue-500 z-[9999]"
            : "pointer-events-none"
          }
          transition-all duration-200
        `}
      >
        {isDragging && (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <div className="p-6 rounded-full bg-blue-100 dark:bg-blue-900/30">
              <Upload className="w-12 h-12 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-black dark:text-white mb-2">
                Drop files or folders here
              </p>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Supports folders, PDFs, images, videos, documents
              </p>
            </div>
          </div>
        )}
      </div>

      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileInput}
        multiple
        webkitdirectory=""
        style={{ display: "none" }}
      />
      <input
        type="file"
        ref={addMediaInputRef}
        onChange={handleFileInput}
        multiple
        accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.txt,.md,.json,.html,.csv,.rtf,.png,.jpg,.jpeg,.gif,.webp,.heic,.heif,.mp3,.wav,.ogg,.flac,.mp4,.mov,.avi,.webm"
        style={{ display: "none" }}
      />
    </>
  );
}
