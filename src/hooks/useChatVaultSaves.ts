// useChatVaultSaves owns every save-to-vault path from the chat page: AI
// image saves (Imagine / side rail), YouTube and link bookmark notes, chat
// file attachments (bytes copied into user storage), the research report
// save, and the AI-built artifact save with its per-chat lineage map that
// upserts the same vault note across refinements. Extracted verbatim from
// src/pages/LyknChat.tsx (LyknChat decomposition phase, see
// docs/REFACTOR_LOG.md). Sign-in gating and vault-cap checks stay in the
// page (shared with other actions) and are passed in.
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { toast } from "@/components/ui/use-toast";
import { notifyVaultCapIfApplicable } from "@/lib/vault/vaultCapError";
import { afterVaultNoteSaved } from "@/lib/vault/afterVaultSave";
import { saveFileToVault, saveGeneratedImageToVault } from "@/lib/saveToVault";
import { createVaultWrites } from "@/lib/vault/repository";
import { insertWithSchemaFallback } from "@/lib/vault/insertWithSchemaFallback";
import {
  chatAttachmentFileType,
  chatAttachmentFilename,
  chatAttachmentKind,
  chatAttachmentText,
  fetchChatAttachmentBlob,
} from "@/lib/chat/chatAttachmentFile";
import type { ChatArtifact } from "@/lib/ai/chatArtifacts";
import type { FocusedChatAttachment } from "@/lib/lyknChat/chatTurnTypes";

export function useChatVaultSaves({
  user,
  chatId,
  routeChatId,
  requireSignIn,
  checkVaultLimit,
  incrementVaultCount,
  latestResearch,
}: {
  user: { id?: string } | null;
  chatId: string | null;
  routeChatId: string | null | undefined;
  requireSignIn: (what?: string) => void;
  checkVaultLimit: () => Promise<boolean>;
  incrementVaultCount: () => void;
  latestResearch: {
    topic: string;
    report: string;
    sources: { title: string; url: string }[];
  } | null;
}) {
  const saveAiImageToMedia = useCallback(async (
    imageUrl: string,
    promptText?: string,
    meta?: { storagePath?: string; mimeType?: string },
  ): Promise<boolean> => {
    if (!imageUrl) return false;
    if (!user?.id) { requireSignIn("save to the vault"); return false; }
    if (!(await checkVaultLimit())) return false;

    const result = await saveGeneratedImageToVault({
      userId: user.id,
      imageUrl,
      storagePath: meta?.storagePath,
      mimeType: meta?.mimeType,
      promptText,
      source: "studio_imagine",
      folder: "Generated",
    });

    if (!result.ok) {
      if (result.reason === "duplicate") {
        // Already in vault — treat as success so the UI shows Saved.
        return true;
      }
      if (result.reason !== "cap" && result.reason !== "rate") {
        toast({
          title: "Couldn't save to vault",
          description: result.message || "Please try again.",
        });
      }
      return false;
    }

    incrementVaultCount();
    if (import.meta.env.DEV) console.log("[LYKN] AI image saved to media", result.id);
    try {
      const { queryClientInstance } = await import("@/lib/query-client");
      void queryClientInstance.invalidateQueries({ queryKey: ["vault-notes", user.id] });
    } catch { /* vault will refresh on next visit */ }
    return true;
  }, [user?.id, requireSignIn, checkVaultLimit, incrementVaultCount]);

  const saveYouTubeToMedia = useCallback(async (videoId: string, url: string) => {
    if (!videoId) return;
    if (!user?.id) { requireSignIn("save to the vault"); return; }
    if (!(await checkVaultLimit())) return;
    const title = `YouTube Video: ${videoId}`;
    const watchUrl = url || `https://www.youtube.com/watch?v=${videoId}`;
    const thumbnail = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
    try {
      const attachment = [{
        type: "youtube",
        url: watchUrl,
        videoId,
        name: title,
        thumbnail,
      }];
      const noteContent = `${title}\n\n[Watch on YouTube](${watchUrl})\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachment)}]`;
      const { data: ins, error } = await supabase
        .from("vault_items")
        .insert({
          user_id: user.id,
          title,
          content: noteContent,
        })
        .select("id")
        .single();
      if (error) {
        notifyVaultCapIfApplicable(error);
        if (import.meta.env.DEV) console.warn("[LYKN] Failed to save YouTube note:", error.message);
      } else if (ins?.id) {
        afterVaultNoteSaved(user.id, ins.id, { title, content: noteContent }, {
          excludeChatId: routeChatId || chatId || undefined,
        });
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[LYKN] Error saving YouTube to media:", err);
    }
  }, [user?.id, routeChatId, chatId, requireSignIn]);

  const saveLinkToMedia = useCallback(async (linkUrl: string) => {
    if (!linkUrl) return;
    if (!user?.id) { requireSignIn("save to the vault"); return; }
    if (!(await checkVaultLimit())) return;
    try {
      const { API_BASE_URL } = await import("@/lib/api-config");
      const res = await fetch(`${API_BASE_URL}/api/unfurl?url=${encodeURIComponent(linkUrl)}`);
      const meta = res.ok ? await res.json() : { url: linkUrl, title: linkUrl, description: "", image: "", siteName: "", favicon: "", articleText: "" };
      const attachment = [{
        type: "bookmark",
        url: meta.url || linkUrl,
        name: meta.title || linkUrl,
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
      const noteContent = `${meta.title || linkUrl}\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachment)}]`;
      const { data: ins, error } = await supabase
        .from("vault_items")
        .insert({
          user_id: user.id,
          title: meta.title || linkUrl,
          content: noteContent,
        })
        .select("id")
        .single();
      if (error) {
        notifyVaultCapIfApplicable(error);
        if (import.meta.env.DEV) console.warn("[LYKN] Failed to save link note:", error.message);
      } else {
        if (import.meta.env.DEV) console.log("[LYKN] Link saved to media");
        if (ins?.id) {
          afterVaultNoteSaved(user.id, ins.id, {
            title: meta.title || linkUrl,
            content: noteContent,
          }, { excludeChatId: routeChatId || chatId || undefined });
        }
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[LYKN] Error saving link to media:", err);
    }
  }, [user?.id, routeChatId, chatId, requireSignIn]);

  const [researchReportSaving, setResearchReportSaving] = useState(false);
  const handleSaveResearchReport = useCallback(async () => {
    if (researchReportSaving) return;
    const research = latestResearch;
    if (!research?.report) return;
    if (!user?.id) { requireSignIn("save the report"); return; }
    if (!(await checkVaultLimit())) return;
    setResearchReportSaving(true);
    try {
      const topic = research.topic.replace(/\s+/g, " ").slice(0, 80);
      const title = topic ? `Research report — ${topic}` : "Research report";
      const sourcesBlock = research.sources.length
        ? `\n\nSources:\n${research.sources.map((s) => `- [${s.title}](${s.url})`).join("\n")}`
        : "";
      const content = `${research.report}${sourcesBlock}`;
      let noteId: string | null = null;
      const { data: ins, error } = await supabase
        .from("vault_items")
        .insert({ user_id: user.id, title, content, source: "research_report" })
        .select("id")
        .single();
      if (error) {
        if (notifyVaultCapIfApplicable(error)) return;
        // Older schema without a `source` column — retry plain.
        const { data: ins2, error: err2 } = await supabase
          .from("vault_items")
          .insert({ user_id: user.id, title, content })
          .select("id")
          .single();
        if (err2) {
          if (!notifyVaultCapIfApplicable(err2)) {
            toast({ title: "Couldn't save report", description: "Please try again." });
          }
          return;
        }
        noteId = ins2?.id ?? null;
      } else {
        noteId = ins?.id ?? null;
      }
      if (noteId) {
        afterVaultNoteSaved(user.id, noteId, { title, content }, {
          excludeChatId: routeChatId || chatId || undefined,
        });
      }
      toast({ title: "Report saved to vault", description: title });
    } catch {
      toast({ title: "Couldn't save report", description: "Please try again." });
    } finally {
      setResearchReportSaving(false);
    }
  }, [researchReportSaving, latestResearch, user?.id, requireSignIn, checkVaultLimit, routeChatId, chatId]);

  /**
   * Save a file the user attached to a chat turn into the vault as its own
   * downloaded copy: pull the bytes from wherever they currently live (data
   * URL, signed URL, device blob, or the original File still in memory), write
   * them to a fresh `{userId}/{fileId}/original.{ext}` object, and hand the
   * result to the shared upload path so the card looks and behaves like any
   * other file in the vault — right type, tags, extracted text, embedding.
   *
   * The chat attachment keeps pointing at its own copy, so deleting the vault
   * card can never blank an image out of the transcript.
   */
  const saveAttachmentToMedia = useCallback(async (
    att: FocusedChatAttachment,
    opts?: { source?: string; quiet?: boolean },
  ) => {
    if (!att) return false;
    if (!user?.id) { requireSignIn("save to the vault"); return false; }
    if (!(await checkVaultLimit())) return false;
    // Background saves (voice paste) report nothing — the user didn't ask for
    // this one and a toast per pasted file would bury the conversation.
    const say = opts?.quiet
      ? () => {}
      : (title: string, description?: string) => toast({ title, description });

    const kind = chatAttachmentKind(att);
    if (kind === "link") {
      const linkUrl = String(att.url || "").trim();
      if (!linkUrl) return false;
      await saveLinkToMedia(linkUrl);
      return true;
    }

    const filename = chatAttachmentFilename(att);
    const blob = await fetchChatAttachmentBlob(att);
    if (!blob) {
      say("Couldn't save to vault", "This file's contents are no longer available.");
      return false;
    }

    const mimeType = blob.type || String(att.mime || "") || "application/octet-stream";
    const ext =
      filename.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase() ||
      mimeType.split("/")[1]?.replace("jpeg", "jpg") ||
      "bin";
    const storagePath = `${user.id}/${crypto.randomUUID()}/original.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from("user-files")
      .upload(storagePath, blob, { cacheControl: "3600", upsert: false, contentType: mimeType });
    if (uploadError) {
      notifyVaultCapIfApplicable(uploadError);
      say("Couldn't save to vault", "The upload didn't finish. Please try again.");
      return false;
    }
    const { data: signedData } = await supabase.storage
      .from("user-files")
      .createSignedUrl(storagePath, 60 * 60 * 24 * 7);

    const fileType = chatAttachmentFileType(att);
    const result = await saveFileToVault({
      userId: user.id,
      filename,
      fileType,
      fileUrl: signedData?.signedUrl || "",
      storagePath,
      storageBucket: "user-files",
      fileSize: blob.size,
      mimeType,
      extractedText: chatAttachmentText(att),
      source: opts?.source || "chat_attachment",
      tags: [fileType, "uploaded"],
    });

    if (!result.ok) {
      if (result.reason === "duplicate") return true;
      if (result.reason !== "cap" && result.reason !== "rate") {
        say("Couldn't save to vault", result.message || "Please try again.");
      }
      return false;
    }

    incrementVaultCount();
    say("Saved to vault", filename);
    try {
      const { queryClientInstance } = await import("@/lib/query-client");
      void queryClientInstance.invalidateQueries({ queryKey: ["vault-notes", user.id] });
    } catch { /* vault will refresh on next visit */ }
    return true;
  }, [user?.id, requireSignIn, checkVaultLimit, incrementVaultCount, saveLinkToMedia]);

  // Save an AI-built artifact (deck / document / chart / file) from the side
  // panel into the vault. Documents & decks save the human-friendly PDF when
  // one exists; charts/images save the image; websites / React artifacts prefer
  // the in-memory srcDoc (avoids cross-origin fetch failures on branded /f/
  // proxy URLs that still work as <a download> navigations). The bytes are
  // copied into the user's own storage so the vault note keeps a permanent,
  // re-signable copy instead of a 7-day proxy link.
  //
  // Called only on explicit user intent (Save button). Refines and code edits
  // upsert the same vault note (keyed by chat + tool + title) so only the
  // latest version is kept instead of stacking every intermediate edit.
  type SavedArtifactVault = {
    noteId: string;
    fileId: string;
    storagePath: string;
    ext: string;
    contentKey: string;
  };
  const savedArtifactVaultRef = useRef<Map<string, SavedArtifactVault>>(new Map());
  const artifactVaultChatKeyRef = useRef<string>("");
  useEffect(() => {
    const key = chatId || routeChatId || "";
    if (artifactVaultChatKeyRef.current === key) return;
    artifactVaultChatKeyRef.current = key;
    savedArtifactVaultRef.current.clear();
  }, [chatId, routeChatId]);

  const saveArtifactToVault = useCallback(async (
    artifact: ChatArtifact,
    opts?: { auto?: boolean },
  ): Promise<boolean> => {
    if (!artifact) return false;
    if (!user?.id) {
      if (!opts?.auto) requireSignIn("save to the vault");
      return false;
    }

    const title = (artifact.title || "Artifact").trim() || "Artifact";
    const chatScope = chatId || routeChatId || "local";
    const lineageKey = `${chatScope}:${artifact.toolName || "artifact"}:${title.toLowerCase()}`;
    const existing = savedArtifactVaultRef.current.get(lineageKey);

    // Cap check only for new inserts — updates replace an existing card.
    if (!existing && !(await checkVaultLimit())) return false;

    // Generated images already live in user-files — reuse the path so Vault
    // gets a durable card without re-downloading the proxy URL.
    if (artifact.kind === "image" && !existing) {
      const imageUrl = artifact.previewUrl || artifact.downloadUrl || "";
      const path = typeof artifact.storagePath === "string" ? artifact.storagePath.trim() : "";
      if (imageUrl || path) {
        const result = await saveGeneratedImageToVault({
          userId: user.id,
          imageUrl: imageUrl || path,
          storagePath: path || undefined,
          promptText: title,
          source: "ai_artifact",
          folder: "Generated",
        });
        if (result.ok) {
          incrementVaultCount();
          savedArtifactVaultRef.current.set(lineageKey, {
            noteId: result.id,
            fileId: path.split("/")[1] || result.id,
            storagePath: path || "",
            ext: (artifact.format || "png").toLowerCase(),
            contentKey: `image|${path || imageUrl}`,
          });
          try {
            const { queryClientInstance } = await import("@/lib/query-client");
            void queryClientInstance.invalidateQueries({ queryKey: ["vault-notes", user.id] });
          } catch { /* vault will refresh on next visit */ }
          if (!opts?.auto) {
            toast({ title: "Saved to vault", description: title });
          }
          return true;
        }
        if (result.reason === "duplicate") {
          if (!opts?.auto) toast({ title: "Already in vault", description: title });
          return true;
        }
        if (!opts?.auto && result.reason !== "cap" && result.reason !== "rate") {
          toast({ title: "Couldn't save", description: result.message || "Please try again." });
        }
        return false;
      }
    }

    const downloads = artifact.downloads || [];
    const pdf = downloads.find((d) => String(d.format).toLowerCase() === "pdf");
    const htmlDownload = downloads.find((d) => String(d.format).toLowerCase() === "html");

    let blob: Blob | null = null;
    let filename = "";
    let mimeType = "";

    const useSrcDoc = () => {
      if (!artifact.srcDoc) return false;
      blob = new Blob([artifact.srcDoc], { type: "text/html;charset=utf-8" });
      filename = artifact.filename || `${title}.html`;
      if (!/\.html?$/i.test(filename)) filename = `${filename}.html`;
      mimeType = "text/html;charset=utf-8";
      return true;
    };

    try {
      if (artifact.kind !== "image" && pdf) {
        const res = await fetch(pdf.url);
        if (res.ok) blob = await res.blob();
        filename = pdf.filename || `${title}.pdf`;
        mimeType = "application/pdf";
      }
      // Prefer inline HTML for website / deck / React artifacts — no network,
      // immune to CORS on the API file proxy. Only skip when we already have a PDF.
      if (!blob && artifact.kind === "html" && artifact.srcDoc) {
        useSrcDoc();
      }
      if (!blob) {
        const url =
          artifact.previewUrl ||
          artifact.downloadUrl ||
          htmlDownload?.url ||
          downloads[0]?.url ||
          "";
        if (url) {
          try {
            const res = await fetch(url);
            if (res.ok) blob = await res.blob();
          } catch { /* CORS / network — fall through to srcDoc */ }
          if (blob?.size) {
            const fmt = String(
              artifact.format || htmlDownload?.format || downloads[0]?.format || "",
            ).toLowerCase();
            const ext = fmt || (blob.type?.split("/")[1]) || "bin";
            filename =
              artifact.filename ||
              htmlDownload?.filename ||
              downloads[0]?.filename ||
              `${title}.${ext}`;
            mimeType = blob.type || "";
          }
        }
      }
      // URL fetch failed or missing — still have the live preview markup.
      if (!blob?.size) useSrcDoc();
      // React artifacts: last resort save the component source.
      if (!blob?.size && typeof artifact.code === "string" && artifact.code.trim()) {
        const base = (artifact.filename || title).replace(/\.[a-z0-9]+$/i, "");
        blob = new Blob([artifact.code], { type: "text/plain;charset=utf-8" });
        filename = `${base}.jsx`;
        mimeType = "text/plain;charset=utf-8";
      }
    } catch { /* network/CORS — handled below */ }

    if (!blob || !blob.size) {
      if (!opts?.auto) {
        toast({ title: "Couldn't save", description: "Try the Download button instead." });
      }
      return false;
    }
    if (!mimeType) mimeType = blob.type || "application/octet-stream";

    // Skip no-op re-saves of the exact same bytes (e.g. StrictMode double-mount).
    const contentKey = [
      blob.size,
      mimeType,
      filename,
      (artifact.srcDoc || artifact.code || "").length,
      artifact.previewUrl || artifact.downloadUrl || "",
      artifact.toolCallId || artifact.id || "",
    ].join("|");
    if (existing && existing.contentKey === contentKey) return true;

    // Classify the attachment so the vault renders the right card.
    // HTML/React artifacts must be "html" (iframe preview), not generic "file".
    const m = mimeType.toLowerCase().split(";")[0].trim();
    const ext = (filename.split(".").pop() || "").toLowerCase();
    const isHtmlArtifact =
      (["html", "htm"].includes(ext) || m === "text/html") &&
      !["jsx", "tsx", "js", "ts"].includes(ext);
    const fileType = isHtmlArtifact
      ? "html"
      : m.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)
        ? "image"
        : m === "application/pdf" || ext === "pdf"
          ? "pdf"
          : m.includes("spreadsheetml") || m === "text/csv" || ["xlsx", "csv", "xls"].includes(ext)
            ? "spreadsheet"
            : "file";

    try {
      const safeExt = ext || "bin";
      const fileId = existing && existing.ext === safeExt ? existing.fileId : crypto.randomUUID();
      const storagePath =
        existing && existing.ext === safeExt
          ? existing.storagePath
          : `${user.id}/${fileId}/artifact.${safeExt}`;
      const { error: uploadError } = await supabase.storage
        .from("user-files")
        .upload(storagePath, blob, {
          cacheControl: "3600",
          upsert: Boolean(existing && existing.ext === safeExt),
          contentType: mimeType,
        });
      if (uploadError) {
        notifyVaultCapIfApplicable(uploadError);
        if (!opts?.auto) toast({ title: "Couldn't save", description: "Please try again." });
        return false;
      }
      const { data: signedData } = await supabase.storage
        .from("user-files")
        .createSignedUrl(storagePath, 60 * 60 * 24 * 7);
      let fileUrl = signedData?.signedUrl || "";
      // HTML artifacts preview in a sandboxed iframe — mint a branded
      // file-proxy URL so Content-Type / frame-ancestors are correct
      // (raw Supabase signed URLs often blank the vault preview).
      if (fileType === "html") {
        try {
          const { API_BASE_URL } = await import("@/lib/api-config");
          const session = (await supabase.auth.getSession())?.data?.session;
          const token = session?.access_token;
          if (token) {
            const resp = await fetch(`${API_BASE_URL}/api/storage/file-proxy-url`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                storagePath,
                bucket: "user-files",
                filename,
              }),
            });
            if (resp.ok) {
              const { url } = await resp.json();
              if (url) fileUrl = url;
            }
          }
        } catch {
          /* keep Supabase signed URL fallback */
        }
      }

      const attachment = [{
        type: fileType,
        url: fileUrl,
        name: filename,
        fileId,
        storagePath,
        storageBucket: "user-files",
        size: blob.size,
        mimeType,
      }];
      const noteContent = `${title}\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachment)}]`;

      // Through the repository rather than straight at Supabase: an artifact
      // written past it lands somewhere AI Drive never reads once the user has
      // moved their vault onto this device.
      const writes = createVaultWrites(user.id);
      // `folder` and `source` are re-stamped on update as well as insert, so
      // an artifact saved over a row that predates them gets filed properly
      // the first time it changes.
      const filing = {
        source: "ai_artifact",
        folder: "Generated",
        tags: [fileType, "generated"],
      };

      let noteId = existing?.noteId || "";
      if (existing?.noteId) {
        const { error } = await writes.update(existing.noteId, {
          title,
          content: noteContent,
          ...filing,
          updated_at: new Date().toISOString(),
        });
        if (error) {
          if (notifyVaultCapIfApplicable(error)) return false;
          if (!opts?.auto) toast({ title: "Couldn't save", description: "Please try again." });
          return false;
        }
      } else {
        const { data: ins, error } = await insertWithSchemaFallback(
          (row) => writes.insert(row),
          { title, content: noteContent, ...filing },
          ["title", "content"],
        );
        if (error) {
          if (notifyVaultCapIfApplicable(error)) return false;
          if (!opts?.auto) toast({ title: "Couldn't save", description: "Please try again." });
          return false;
        }
        noteId = ins?.id || "";
      }

      if (noteId) {
        savedArtifactVaultRef.current.set(lineageKey, {
          noteId,
          fileId,
          storagePath,
          ext: safeExt,
          contentKey,
        });
        afterVaultNoteSaved(user.id, noteId, { title, content: noteContent }, {
          excludeChatId: routeChatId || chatId || undefined,
        });
      }
      if (!opts?.auto) {
        toast({
          title: existing ? "Updated in vault" : "Saved to vault",
          description: title,
        });
      }
      return true;
    } catch {
      if (!opts?.auto) toast({ title: "Couldn't save", description: "Please try again." });
      return false;
    }
  }, [user?.id, routeChatId, chatId, requireSignIn, checkVaultLimit, incrementVaultCount]);

  return {
    saveAiImageToMedia,
    saveYouTubeToMedia,
    saveLinkToMedia,
    researchReportSaving,
    handleSaveResearchReport,
    saveAttachmentToMedia,
    saveArtifactToVault,
  };
}
