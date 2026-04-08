import type { Editor } from "@tiptap/core";
import { extractYouTubeVideoId, isYouTubeUrl } from "@/canvas/utils/youtube";
import { supabase } from "@/lib/supabase";

const DOCUMENT_EXTS = new Set([
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "txt", "md", "markdown", "json", "html", "htm", "csv", "rtf",
]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "ogg", "aac", "flac", "wma"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "webm", "mkv", "wmv"]);

function getUrlExtension(url: string): string {
  try {
    const parsed = new URL(url);
    const fileName = decodeURIComponent(parsed.pathname.split("/").pop() || "");
    return fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() || "" : "";
  } catch {
    return "";
  }
}

function inferUrlType(url: string): string {
  const trimmed = String(url || "").trim();
  if (!trimmed) return "link";
  if (isYouTubeUrl(trimmed)) return "youtube";
  const ext = getUrlExtension(trimmed);
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "heif"].includes(ext)) return "image";
  if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "ogg", "aac", "flac"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (DOCUMENT_EXTS.has(ext)) return "document";
  return "link";
}

export function getNotesDropPosition(editor: Editor, e: DragEvent): number {
  const coords = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
  return coords?.pos ?? editor.state.selection.anchor;
}

/** dragover — only types (getData is unreliable here) */
export function hasNotesDropHintTypes(e: DragEvent): boolean {
  const types = new Set([...e.dataTransfer.types]);
  if (types.has("application/x-grid-file")) return true;
  if (types.has("application/x-omnia-vault")) return true;
  if (types.has("application/x-omnia-chat-response")) return true;
  if (types.has("text/uri-list")) return true;
  for (const t of types) {
    if (/files/i.test(t) && (e.dataTransfer.files?.length ?? 0) > 0) return true;
  }
  return types.has("text/plain");
}

/** drop — includes text/plain / files */
export function hasExternalNotesDropPayload(e: DragEvent): boolean {
  const dt = e.dataTransfer;
  const types = new Set([...dt.types]);
  if (types.has("application/x-grid-file")) return true;
  if (types.has("application/x-omnia-vault")) return true;
  if (types.has("application/x-omnia-chat-response")) return true;
  if (types.has("text/uri-list")) return true;
  if ((dt.files?.length ?? 0) > 0) return true;
  const plain = (dt.getData("text/plain") || "").trim();
  return plain.length > 0;
}

function linkParagraph(label: string, href: string): Record<string, unknown> {
  return {
    type: "paragraph",
    content: [
      {
        type: "text",
        text: label,
        marks: [{ type: "link", attrs: { href, target: "_blank", rel: "noopener noreferrer" } }],
      },
    ],
  };
}

/** TipTap `youtube` node — `src` is a normal watch/share URL */
function youtubeNodeFromWatchUrl(watchUrl: string): Record<string, unknown> {
  return { type: "youtube", attrs: { src: watchUrl } };
}

function webEmbedNode(url: string, title?: string): Record<string, unknown> | null {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) return null;
  return { type: "webEmbed", attrs: { src: u, title: title || null } };
}

/** YouTube embed, image node, or generic iframe embed (http/https only). */
function urlToEmbeddedNodes(url: string, label?: string): Record<string, unknown>[] {
  const u = String(url || "").trim();
  if (!u) return [];
  if (isYouTubeUrl(u)) {
    const vid = extractYouTubeVideoId(u) || "";
    const href = vid ? `https://www.youtube.com/watch?v=${vid}` : u;
    return [youtubeNodeFromWatchUrl(href)];
  }
  if (inferUrlType(u) === "image") {
    return [{ type: "image", attrs: { src: u, alt: label || "Image" } }];
  }
  const embed = webEmbedNode(u, label);
  return embed ? [embed] : [linkParagraph(label || u, u)];
}

function plaintextToParagraphNodes(text: string): Record<string, unknown>[] {
  const raw = String(text || "");
  if (!raw.trim()) return [];
  return raw.split(/\n\n+/).map((block) => {
    const lines = block.split("\n");
    const content: Record<string, unknown>[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) content.push({ type: "hardBreak" });
      content.push({ type: "text", text: lines[i] });
    }
    return { type: "paragraph", content };
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function resolveVaultAttachmentUrl(att: Record<string, unknown>): Promise<string> {
  const attType = String(att?.type || "").toLowerCase();
  let url = String(att?.url || "").trim();
  let videoId = String(att?.videoId || "").trim();
  if (!videoId && attType === "youtube") videoId = extractYouTubeVideoId(url) || "";
  if (!url && videoId) url = `https://www.youtube.com/watch?v=${videoId}`;

  const pathOnly = String(att?.storagePath || "").trim();
  if (!url || (!url.startsWith("http") && !url.startsWith("data:") && attType !== "youtube")) {
    try {
      const path = pathOnly || url;
      if (path) {
        const bucket = String(att?.storageBucket || "user-files");
        const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60 * 24 * 7);
        if (data?.signedUrl) url = data.signedUrl;
      }
    } catch {
      /* ignore */
    }
  }
  return String(url || "").trim();
}

function gridItemToNodes(item: Record<string, unknown>): Record<string, unknown>[] {
  const type = String(item.type || "link").toLowerCase();
  const url = String(item.url || "").trim();
  const name = String(item.name || "Grid item").trim();
  let content = String(item.content || "");
  content = content.replace(/\[ATTACHMENTS_JSON:[\s\S]*$/, "").trim();

  if (type === "note") {
    const nodes: Record<string, unknown>[] = [
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: name || "Note" }] },
    ];
    if (content) nodes.push(...plaintextToParagraphNodes(content));
    return nodes;
  }

  if (type === "document" && content) {
    const nodes: Record<string, unknown>[] = [{ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: name || "Document" }] }];
    const excerpt = content.length > 12000 ? `${content.slice(0, 12000)}\n\n…` : content;
    nodes.push({
      type: "codeBlock",
      attrs: { language: "plaintext" },
      content: [{ type: "text", text: excerpt }],
    });
    return nodes;
  }

  if (type === "youtube" || (url && isYouTubeUrl(url))) {
    const vid = String(item.videoId || extractYouTubeVideoId(url) || "");
    const href = vid ? `https://www.youtube.com/watch?v=${vid}` : url;
    return [youtubeNodeFromWatchUrl(href)];
  }

  if (type === "image" && url) {
    return [{ type: "image", attrs: { src: url, alt: name } }];
  }

  if ((type === "video" || type === "audio" || type === "pdf" || type === "file" || type === "link") && url) {
    const cap =
      type === "pdf" ? "PDF" : type === "video" ? "Video" : type === "audio" ? "Audio" : type === "file" ? "File" : "Link";
    return urlToEmbeddedNodes(url, `${cap}: ${name}`);
  }

  if (type === "pdf" && content && !url) {
    return [
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: name || "PDF text" }] },
      ...plaintextToParagraphNodes(content),
    ];
  }

  if (url) return urlToEmbeddedNodes(url, name || url);
  return plaintextToParagraphNodes(content || name);
}

async function vaultPayloadToNodes(payload: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const title = String(payload.title || "").trim();
  const body = String(payload.content || "").trim();
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const out: Record<string, unknown>[] = [];

  if (title) {
    out.push({ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: title }] });
  }

  if (attachments.length > 0) {
    for (const raw of attachments) {
      const att = raw as Record<string, unknown>;
      const attType = String(att.type || "").toLowerCase();
      const name = String(att.name || att.title || title || "Attachment").trim();
      const pdfText = String(att.pdfText || att.extractedText || "").trim();
      const url = await resolveVaultAttachmentUrl(att);
      if (!url && pdfText) {
        out.push({ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: name || "PDF" }] });
        out.push({
          type: "codeBlock",
          attrs: { language: "plaintext" },
          content: [{ type: "text", text: pdfText.length > 12000 ? `${pdfText.slice(0, 12000)}\n\n…` : pdfText }],
        });
        continue;
      }
      if (!url) continue;
      const videoId = String(att.videoId || (attType === "youtube" ? extractYouTubeVideoId(url) : "") || "");

      if (attType === "youtube" || isYouTubeUrl(url)) {
        const href = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
        out.push(youtubeNodeFromWatchUrl(href));
        continue;
      }
      if (attType === "image" || inferUrlType(url) === "image") {
        out.push({ type: "image", attrs: { src: url, alt: name } });
        continue;
      }
      if (attType === "pdf" || inferUrlType(url) === "pdf") {
        const pdfEmbed = webEmbedNode(url, `PDF: ${name}`);
        if (pdfEmbed) out.push(pdfEmbed);
        else out.push(linkParagraph(`PDF: ${name}`, url));
        if (pdfText) {
          out.push({
            type: "codeBlock",
            attrs: { language: "plaintext" },
            content: [{ type: "text", text: pdfText.length > 12000 ? `${pdfText.slice(0, 12000)}\n\n…` : pdfText }],
          });
        }
        continue;
      }
      out.push(...urlToEmbeddedNodes(url, name));
    }
  }

  if (body) {
    out.push(...plaintextToParagraphNodes(body));
  }

  return out.length > 0 ? out : plaintextToParagraphNodes(title || "Vault item");
}

async function filesToNodes(files: File[]): Promise<Record<string, unknown>[]> {
  const nodes: Record<string, unknown>[] = [];
  const { extractTextFromFile } = await import("@/lib/extract-text");
  const { API_BASE_URL } = await import("@/lib/api-config");

  for (const file of files) {
    const mime = file.type || "";
    const ext = (file.name || "").split(".").pop()?.toLowerCase() || "";

    if (mime.startsWith("image/")) {
      const src = await readFileAsDataUrl(file);
      nodes.push({ type: "image", attrs: { src, alt: file.name } });
      continue;
    }

    if (DOCUMENT_EXTS.has(ext) || mime === "application/pdf" || ext === "pdf") {
      try {
        const result = await extractTextFromFile(file, API_BASE_URL);
        const text = String(result?.text || "").trim();
        nodes.push({ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: file.name }] });
        if (text) {
          nodes.push({
            type: "codeBlock",
            attrs: { language: ext === "md" || ext === "markdown" ? "markdown" : "plaintext" },
            content: [{ type: "text", text: text.length > 16000 ? `${text.slice(0, 16000)}\n\n…` : text }],
          });
        } else {
          nodes.push(linkParagraph(`Open file: ${file.name}`, URL.createObjectURL(file)));
        }
      } catch {
        nodes.push(linkParagraph(`File: ${file.name}`, URL.createObjectURL(file)));
      }
      continue;
    }

    if (mime.startsWith("audio/") || AUDIO_EXTS.has(ext)) {
      const href = URL.createObjectURL(file);
      nodes.push(linkParagraph(`Audio: ${file.name}`, href));
      continue;
    }
    if (mime.startsWith("video/") || VIDEO_EXTS.has(ext)) {
      const href = URL.createObjectURL(file);
      nodes.push(linkParagraph(`Video: ${file.name}`, href));
      continue;
    }

    const href = URL.createObjectURL(file);
    nodes.push(linkParagraph(`File: ${file.name}`, href));
  }

  return nodes;
}

/**
 * Inserts dropped content at the cursor position under the drop (or current selection).
 * Returns true if a known payload was handled.
 */
export async function insertNotesDropContent(editor: Editor, e: DragEvent): Promise<boolean> {
  const pos = getNotesDropPosition(editor, e);

  const gridRaw = e.dataTransfer.getData("application/x-grid-file");
  if (gridRaw) {
    try {
      const item = JSON.parse(gridRaw) as Record<string, unknown>;
      const nodes = gridItemToNodes(item);
      if (nodes.length) {
        editor.chain().focus().insertContentAt(pos, nodes).run();
        return true;
      }
    } catch {
      /* fall through */
    }
  }

  const vaultRaw = e.dataTransfer.getData("application/x-omnia-vault");
  if (vaultRaw) {
    try {
      const payload = JSON.parse(vaultRaw) as Record<string, unknown>;
      const nodes = await vaultPayloadToNodes(payload);
      if (nodes.length) {
        editor.chain().focus().insertContentAt(pos, nodes).run();
        return true;
      }
    } catch {
      /* fall through */
    }
  }

  const chatRaw = e.dataTransfer.getData("application/x-omnia-chat-response");
  if (chatRaw) {
    const nodes = plaintextToParagraphNodes(chatRaw);
    if (nodes.length) {
      editor.chain().focus().insertContentAt(pos, nodes).run();
      return true;
    }
  }

  const files = Array.from(e.dataTransfer.files || []);
  if (files.length > 0) {
    const nodes = await filesToNodes(files);
    if (nodes.length) {
      editor.chain().focus().insertContentAt(pos, nodes).run();
      return true;
    }
  }

  const text = (
    e.dataTransfer.getData("text/uri-list") ||
    e.dataTransfer.getData("text/plain") ||
    e.dataTransfer.getData("text") ||
    ""
  ).trim();

  if (text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const urlLines = lines.filter((l) => /^https?:\/\//i.test(l));
    if (urlLines.length > 0) {
      const nodes = urlLines.flatMap((u) => urlToEmbeddedNodes(u, u));
      editor.chain().focus().insertContentAt(pos, nodes).run();
      return true;
    }
    const nodes = plaintextToParagraphNodes(text);
    if (nodes.length) {
      editor.chain().focus().insertContentAt(pos, nodes).run();
      return true;
    }
  }

  return false;
}

/** Used when the vault iframe drag is completed on the parent overlay (no dataTransfer MIME on parent). */
export async function insertVaultPayloadIntoNotes(
  editor: Editor,
  payload: Record<string, unknown>,
  opts?: { clientX?: number; clientY?: number }
): Promise<boolean> {
  let pos = editor.state.selection.anchor;
  if (opts?.clientX != null && opts?.clientY != null) {
    const coords = editor.view.posAtCoords({ left: opts.clientX, top: opts.clientY });
    if (coords != null) pos = coords.pos;
  }
  const nodes = await vaultPayloadToNodes(payload);
  if (!nodes.length) return false;
  editor.chain().focus().insertContentAt(pos, nodes).run();
  return true;
}
