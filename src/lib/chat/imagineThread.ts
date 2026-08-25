/**
 * Shared Imagine → chat-turn helpers.
 *
 * A batch used to become a transcript turn only after every slot settled,
 * which hid the prompt bubble and left prior 4-ups expanded. These helpers
 * upsert the same turn from the first send through each slot pop-in.
 */

export const IMAGINE_BATCH_SIZE = 4;

export type ImagineThreadSlotStatus = "loading" | "done" | "error";

export type ImagineThreadImage = {
  url: string;
  storagePath?: string;
  status?: ImagineThreadSlotStatus;
  error?: string;
};

export type ImagineThreadCommit = {
  id: string;
  prompt: string;
  concept?: string;
  kind?: "generate" | "refine" | "variations";
  aspectRatio?: string;
  images: { url: string; storagePath?: string }[];
  pending?: boolean;
  slots?: Array<{
    status: ImagineThreadSlotStatus;
    url?: string;
    storagePath?: string;
    error?: string;
  }>;
  referenceUrls?: string[];
};

export function imagesFromImagineCommit(
  commit: ImagineThreadCommit,
  batchSize = IMAGINE_BATCH_SIZE,
): ImagineThreadImage[] {
  if (commit.slots?.length) {
    return commit.slots.map((s) => ({
      url: s.url || "",
      storagePath: s.storagePath,
      status: s.status,
      error: s.error,
    }));
  }
  if (commit.images.length) {
    return commit.images.map((img) => ({
      ...img,
      status: "done" as const,
    }));
  }
  if (commit.pending) {
    return Array.from({ length: batchSize }, () => ({
      url: "",
      status: "loading" as const,
    }));
  }
  return [];
}

export function findImagineTurnIndex(
  messages: Array<{ imagine?: { batchId?: string } }>,
  batchId: string,
): number {
  const id = String(batchId || "").trim();
  if (!id) return -1;
  return messages.findIndex((m) => m.imagine?.batchId === id);
}

export function imagineTurnNote(commit: ImagineThreadCommit): string {
  if (commit.pending) return "Generating images.";
  const count = commit.images.filter((i) => i?.url).length;
  const verb =
    commit.kind === "refine" ? "Refined" : commit.kind === "variations" ? "Varied" : "Generated";
  return `${verb} ${count} image${count === 1 ? "" : "s"}.`;
}

export function imagineReferenceAttachments(
  commit: ImagineThreadCommit,
): Array<{
  id: string;
  type: "image";
  url: string;
  name: string;
  mime: string;
  size: number;
}> {
  return (commit.referenceUrls || []).filter(Boolean).map((url, i) => ({
    id: `imagine-ref-${commit.id}-${i}`,
    type: "image" as const,
    url,
    name: `Reference ${i + 1}`,
    mime: "image/png",
    size: 0,
  }));
}

/** Drop in-flight loading tiles so a mid-generate save cannot reload as stuck shimmers. */
export function sanitizeImagineTurnForPersist<T extends {
  aiImages?: ImagineThreadImage[];
  aiResponse?: string;
  imagine?: { pending?: boolean; [key: string]: unknown };
}>(msg: T): T {
  if (!msg?.imagine?.pending) return msg;
  const imgs = Array.isArray(msg.aiImages) ? msg.aiImages.filter((i) => i?.url) : [];
  const { pending: _pending, ...imagineRest } = msg.imagine;
  const next = { ...msg, imagine: imagineRest };
  if (imgs.length) {
    next.aiImages = imgs;
    if (!next.aiResponse || next.aiResponse === "Generating images.") {
      next.aiResponse = `Generated ${imgs.length} image${imgs.length === 1 ? "" : "s"}.`;
    }
  } else {
    delete next.aiImages;
    delete next.aiResponse;
  }
  return next;
}

/** True when the in-memory turn already matches this commit (skip setState). */
export function imagineTurnUnchanged(
  msg: {
    content?: string;
    aiResponse?: string;
    aiImages?: ImagineThreadImage[];
    attachments?: Array<{ url?: string }>;
    imagine?: { pending?: boolean };
  },
  commit: ImagineThreadCommit,
): boolean {
  if (String(msg.content || "") !== String(commit.prompt || "")) return false;
  if (String(msg.aiResponse || "") !== imagineTurnNote(commit)) return false;
  if (!!msg.imagine?.pending !== !!commit.pending) return false;
  const nextImages = imagesFromImagineCommit(commit);
  const prevImages = Array.isArray(msg.aiImages) ? msg.aiImages : [];
  if (prevImages.length !== nextImages.length) return false;
  for (let i = 0; i < nextImages.length; i += 1) {
    const a = prevImages[i];
    const b = nextImages[i];
    if ((a?.url || "") !== (b?.url || "")) return false;
    if ((a?.storagePath || "") !== (b?.storagePath || "")) return false;
    if ((a?.status || "") !== (b?.status || "")) return false;
    if ((a?.error || "") !== (b?.error || "")) return false;
  }
  return true;
}
