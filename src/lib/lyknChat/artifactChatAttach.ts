import type { ChatArtifact } from "@/lib/ai/chatArtifacts";
import type { FocusedChatAttachment } from "@/lib/lyknChat/chatTurnTypes";
import { makeAttId } from "@/lib/lyknChat/chatAttachmentInput";

export function isChatArtifact(value: unknown): value is ChatArtifact {
  if (!value || typeof value !== "object") return false;
  const row = value as ChatArtifact;
  if (typeof row.title !== "string") return false;
  return typeof row.toolName === "string" || typeof row.id === "string";
}

export function artifactFromAttachment(
  att: FocusedChatAttachment | null | undefined,
): ChatArtifact | null {
  if (!att) return null;
  if (isChatArtifact(att.artifact)) return att.artifact;
  return null;
}

export function focusedAttachmentFromArtifact(
  artifact: ChatArtifact,
): FocusedChatAttachment {
  const url = String(artifact.previewUrl || artifact.downloadUrl || "").trim();
  return {
    id: makeAttId(),
    type: "artifact",
    url,
    name: String(artifact.title || "Artifact").trim() || "Artifact",
    mime: artifact.kind === "image" ? "image/png" : artifact.kind === "video" ? "video/mp4" : "text/html",
    size: 0,
    vaultTitle: String(artifact.title || "").trim() || undefined,
    artifact,
  };
}

/**
 * Explicit take-to-chat attachments always belong to this send, even when
 * the build originally came from another board. The open preview panel
 * keeps its existing sourceChatId tagging.
 */
export function pickEditArtifact(opts: {
  attached: ChatArtifact | null | undefined;
  panel: ChatArtifact | null | undefined;
  chatId: string;
}): ChatArtifact | null {
  const bid = String(opts.chatId || "").trim();
  if (opts.attached) {
    return bid ? { ...opts.attached, sourceChatId: bid } : opts.attached;
  }
  return opts.panel || null;
}
