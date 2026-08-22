/**
 * One way to put a file on screen: the Imagine-style preview pop.
 *
 * Chat, Vault, Files, and the AI tools all dispatch here so "pull that up"
 * always opens the same overlay, not a Finder window or a one-off lightbox.
 */

export const LYKN_MEDIA_POP_EVENT = "lykn-media-pop";

export type LyknMediaPopRequest =
  | { type: "file"; path: string; name?: string }
  | { type: "vault-note"; noteId: string; title?: string }
  | { type: "vault-payload"; payload: unknown }
  | {
      type: "url";
      url: string;
      title?: string;
      kind?: "image" | "video" | "audio" | "pdf" | "file";
    };

export function openLyknMediaPop(detail: LyknMediaPopRequest): boolean {
  if (typeof window === "undefined") return false;
  window.dispatchEvent(new CustomEvent(LYKN_MEDIA_POP_EVENT, { detail }));
  return true;
}

export function isPullUpAsk(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  return (
    /\b(pull\s*(?:(?:it|that|this|them|those)\s*)?up|bring\s*(?:(?:it|that|this|them|those)\s*)?up|open\s*(?:it|that|this|them|those|up))\b/i.test(
      t,
    ) ||
    /\b(show|display|view)\s+(?:me\s+)?(?:it|that|this|them|those|the)\b/i.test(t) ||
    /\b(?:full|whole|entire)\s+(?:thing|document|doc|note|file|image|picture|photo|artifact)\b/i.test(
      t,
    )
  );
}
