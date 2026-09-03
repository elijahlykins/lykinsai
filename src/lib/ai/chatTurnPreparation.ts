// Turn-preparation stage of the chat send pipeline: turn the raw turn inputs
// (attachments, rolling aiThread, persisted chat messages) into the prompt-
// ready context strings/arrays the request builder consumes. Extracted
// VERBATIM from chatSendOrchestrator.ts (C3B decomposition, see
// docs/REFACTOR_LOG.md) — string budgets and truncation ordering are
// UI/prompt-visible contracts, keep them exactly as-is.
import type { FocusedChatAttachment, PromptMessage } from "@/lib/lyknChat/chatTurnTypes";

const FOLDER_PATH_RE = /^Path:\s+(\/[^\n]+)$/m;

export function isDesktopFolderAttachment(a: FocusedChatAttachment | undefined | null): boolean {
  if (!a) return false;
  const t = (a.type || "").toLowerCase();
  if (t === "folder") return true;
  const listing = String(a.vaultContent || a.extractedText || "");
  return t === "vault" && /Attached folder "|Path: \//.test(listing);
}

export function folderPathFromAttachment(a: FocusedChatAttachment): string {
  const stored = String(a.localPath || "").trim();
  if (stored) return stored;
  const listing = String(a.vaultContent || a.extractedText || "");
  const m = listing.match(FOLDER_PATH_RE);
  return m ? m[1].trim() : "";
}

/** Folders already on this thread (plus any on the send) so a follow-up
 *  like "what's in agents.md" still has the path to call local_read_file. */
export function collectThreadFolderAttachments(
  chatMessages: PromptMessage[],
  sentAttachments: FocusedChatAttachment[],
): FocusedChatAttachment[] {
  const seen = new Set<string>();
  const out: FocusedChatAttachment[] = [];
  const consider = (a: FocusedChatAttachment) => {
    if (!isDesktopFolderAttachment(a)) return;
    const key = folderPathFromAttachment(a) || a.vaultContent || a.name;
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(a);
  };
  for (const a of sentAttachments) consider(a);
  for (const m of chatMessages) {
    const atts = Array.isArray(m.attachments) ? m.attachments : [];
    for (const a of atts) consider(a);
  }
  return out;
}

export function attachmentsForPrompt(
  sentAttachments: FocusedChatAttachment[],
  chatMessages: PromptMessage[],
): FocusedChatAttachment[] {
  if (sentAttachments.some(isDesktopFolderAttachment)) return sentAttachments;
  const prior = collectThreadFolderAttachments(chatMessages, []);
  return prior.length ? [...sentAttachments, ...prior] : sentAttachments;
}

export function buildAttachmentContext(sentAttachments: FocusedChatAttachment[]): string {
  if (!sentAttachments.length) return "";
  return "\n\n[Attached content]\n" + sentAttachments.map((a) => {
    const t = (a.type || "").toLowerCase();
    const label = a.name || a.vaultTitle || "Untitled";
    const parts: string[] = [];
    if (a.vaultContent) parts.push(String(a.vaultContent).slice(0, 1500));
    if (a.pdfText) parts.push(String(a.pdfText).slice(0, 1500));
    if (a.extractedText) parts.push(String(a.extractedText).slice(0, 1500));
    if (a.transcript) parts.push(String(a.transcript).slice(0, 8000));
    // A data URL is bytes, not a location: nothing can fetch it and spelling
    // one out costs thousands of tokens of base64.
    const safeUrl = a.url && !a.url.startsWith("data:") ? a.url : "";
    if (t === "folder") {
      const listing = String(a.vaultContent || a.extractedText || "").slice(0, 8000);
      return (
        `Desktop folder "${label}" — the user attached THIS folder from their Mac. ` +
        `Answer from this listing only. If you need more detail, call local_list_dir or local_read_file ` +
        `on this exact path — not other folders, the rest of the disk, or the vault. ` +
        `You may offer to read a specific file inside this folder. ` +
        `Do not hand this off to another model or bot — summarize it yourself.\n` +
        (listing || "(empty listing)")
      );
    }
    if (t === "vault" || t === "note") {
      return `${t === "note" ? "Note" : "Vault"} "${label}": ${parts.join("\n") || "(empty)"}`;
    }
    if (t === "pdf") {
      // No text means no text layer — a scan or an export of images. Say so,
      // because the alternative is the model inventing contents.
      const body =
        parts.join("\n") ||
        (safeUrl
          ? `(PDF at ${safeUrl})`
          : "(no text could be extracted — this PDF has no text layer, likely a scan. Say so rather than guessing at its contents.)");
      return `PDF "${label}": ${body}`;
    }
    if (t === "document") return `Document "${label}": ${parts.join("\n") || "(could not extract text)"}`;
    if (t === "youtube") {
      const ctx = parts.length ? parts.join("\n") : "";
      return `YouTube video "${label}"${a.videoId ? ` (${a.videoId})` : ""}${safeUrl ? ` — ${safeUrl}` : ""}${ctx ? `\nTranscript: ${ctx}` : ""}`;
    }
    if (t === "video" || t === "audio") {
      return `${t === "video" ? "Video" : "Audio"} "${label}"${parts.length ? `\nTranscript: ${parts.join("\n")}` : " (no transcript available)"}`;
    }
    if (t === "image") {
      const desc = a.aiDescription ? `\nWhat the image shows: ${String(a.aiDescription).slice(0, 1200)}` : "";
      const ocr = a.ocrText ? `\nText extracted from this image (OCR — may contain errors): ${String(a.ocrText).slice(0, 1500)}` : "";
      return `Image "${label}"${safeUrl ? ` — ${safeUrl}` : ""}${desc}${ocr}`;
    }
    if (t === "link") return `Link "${label}"${safeUrl ? ` — ${safeUrl}` : ""}${parts.length ? `\nContent: ${parts.join("\n")}` : ""}`;
    if (t === "artifact") {
      const art = a.artifact as { toolName?: string; title?: string } | undefined;
      const kind = String(art?.toolName || "build").replace(/^lykn_/, "").replace(/_/g, " ");
      return `Attached artifact "${label}" (${kind}). The user included this build with their prompt.`;
    }
    if (parts.length) return `${label}: ${parts.join("\n")}`;
    if (safeUrl) return `${t || "File"} "${label}" — ${safeUrl}`;
    return `${t || "File"}: ${label}`;
  }).join("\n\n");
}

/** Flatten the rolling model thread into the `Conversation so far:` prompt
 *  block — last 16 turns, each capped at 1,200 chars. */
export function buildThreadHistory(
  aiThread: Array<{ role: "user" | "assistant"; content: string }>,
): string {
  return aiThread
    .slice(-16)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.length > 1200 ? m.content.slice(0, 1200) + "…" : m.content}`)
    .join("\n");
}

/** Rebuild the role-tagged conversation array the server expects from the
 *  persisted chat messages, appending the message being sent now. */
export function buildConversationArray(
  chatMessages: PromptMessage[],
  cappedText: string,
): Array<{ role: string; content: string; model?: string; at?: string }> {
  const conversationArray: Array<{ role: string; content: string; model?: string; at?: string }> = [];
  for (const cm of chatMessages) {
    if (cm.role === "user" && cm.content) {
      conversationArray.push({ role: "user", content: cm.content, at: cm.createdAt });
      if (cm.aiResponse) {
        conversationArray.push({
          role: "assistant",
          content: cm.aiResponse,
          model: cm.aiModel,
          at: cm.aiCompletedAt || cm.createdAt,
        });
      }
    } else if (cm.role !== "user" && cm.content) {
      conversationArray.push({ role: "assistant", content: cm.content, model: cm.aiModel, at: cm.aiCompletedAt });
    }
  }
  conversationArray.push({ role: "user", content: cappedText, at: new Date().toISOString() });
  return conversationArray;
}
