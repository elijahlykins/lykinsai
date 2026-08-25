/**
 * Attachments for Bot sends.
 *
 * A turn addressed to a Bot skips the chat model's pipeline and goes straight
 * to the agent runtime, which speaks a small attachment dialect: images as
 * data URLs, everything else as extracted text. This module converts the chat
 * bar's attachment chips (files, folders, vault items) into that shape, and
 * parks the result while the send hops from the bar to the chat surface.
 *
 * Parked in module state rather than sessionStorage because File bytes and
 * multi-MB image data URLs don't fit there — the desktop and the chat surface
 * share one JS context (tab swap, no reload), the same trick homeChatFiles
 * uses for regular sends.
 */
import { snapshotMacFolders } from "@/lib/homeChatFiles";

/**
 * @typedef {{ kind: "image" | "text", name: string, dataUrl?: string, text?: string }} BotRuntimeAttachment
 */

// Files we can read as plain text directly in the renderer without the
// document-extraction pass (source/code/config files the extractor skips).
const TEXTLIKE_EXT =
  /\.(txt|md|markdown|json|csv|tsv|html?|xml|yml|yaml|log|js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|css|scss|sh|zsh|sql|toml|ini|env|conf)$/i;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif)$/i;

// Per-file text cap. The runtime clips again on its side; this just keeps a
// huge log file from ballooning the payload crossing surfaces.
const TEXT_CAP = 60000;

/** @returns {Promise<BotRuntimeAttachment>} */
async function fromFile(file) {
  const name = file.name || "file";
  const mime = file.type || "";
  try {
    if (mime.startsWith("image/") || IMAGE_EXT.test(name)) {
      // Same downscale/convert pass chat uses, so HEIC phone photos work and
      // multi-MB originals don't blow past the server body limit.
      const { fileToChatImageDataUrl } = await import("@/lib/heifToJpeg");
      return { kind: "image", name, dataUrl: await fileToChatImageDataUrl(file) };
    }
    if (mime === "application/pdf" || /\.pdf$/i.test(name)) {
      const { extractPdfText } = await import("@/lib/extract-text");
      const { text } = await extractPdfText(file, 12);
      return {
        kind: "text",
        name,
        text: text?.trim()
          ? text.slice(0, TEXT_CAP)
          : "(PDF attached, but no text layer could be read.)",
      };
    }
    const { isDocumentFile, extractTextFromFile } = await import("@/lib/extract-text");
    if (isDocumentFile(file)) {
      const { API_BASE_URL } = await import("@/lib/api-config");
      const result = await extractTextFromFile(file, API_BASE_URL);
      const text = String(result?.text || "").trim();
      if (text) return { kind: "text", name, text: text.slice(0, TEXT_CAP) };
    }
    if (TEXTLIKE_EXT.test(name) || mime.startsWith("text/")) {
      const text = (await file.text()).trim();
      if (text) return { kind: "text", name, text: text.slice(0, TEXT_CAP) };
    }
  } catch {
    /* fall through to the name-only note */
  }
  return {
    kind: "text",
    name,
    text: `(The user attached "${name}"${mime ? ` (${mime})` : ""}, but its contents couldn't be read in this mode — work from the name, or ask them to paste the relevant part.)`,
  };
}

/** @returns {BotRuntimeAttachment} */
function fromVaultPayload(chip) {
  const p = chip.vaultPayload || {};
  const name = String(chip.name || p.title || "Vault item");
  const body = [p.vaultContent, p.content, p.text].find(
    (s) => typeof s === "string" && s.trim(),
  );
  const url = String(p?.source?.url || p?.url || "").trim();
  return {
    kind: "text",
    name,
    text: body
      ? String(body).slice(0, TEXT_CAP)
      : `Vault item "${name}"${url ? ` — ${url}` : ""} (contents not inlined; work from the name/link).`,
  };
}

/**
 * Convert the home chat bar's attachment chips into runtime attachments a
 * Bot's worker agent understands. Folders become their listing (the same
 * snapshot regular chat attaches); unreadable files degrade to a named note
 * rather than silently vanishing.
 *
 * @param {Array<{ kind: string, name: string, file: File | null, path: string, vaultPayload?: object }>} chips
 * @returns {Promise<BotRuntimeAttachment[]>}
 */
export async function botAttachmentsFromChips(chips) {
  /** @type {BotRuntimeAttachment[]} */
  const out = [];
  const folderPaths = [];
  for (const chip of chips || []) {
    if (!chip) continue;
    if (chip.kind === "folder" && chip.path) {
      folderPaths.push(chip.path);
    } else if (chip.file) {
      out.push(await fromFile(chip.file));
    } else if (chip.vaultPayload) {
      out.push(fromVaultPayload(chip));
    }
  }
  if (folderPaths.length) {
    const snaps = await snapshotMacFolders(folderPaths).catch(() => []);
    for (const snap of snaps) {
      out.push({ kind: "text", name: snap.name, text: snap.listing });
    }
  }
  return out;
}

/* ── Parked hand-off (bar → chat surface), one consumer like homeChatFiles ── */

/** @type {BotRuntimeAttachment[]} */
let pendingBotAttachments = [];

export function setPendingBotChatAttachments(list) {
  pendingBotAttachments = Array.isArray(list) ? list : [];
}

/** Claim the parked attachments — one consumer, so later sends start clean. */
export function takePendingBotChatAttachments() {
  const claimed = pendingBotAttachments;
  pendingBotAttachments = [];
  return claimed;
}
