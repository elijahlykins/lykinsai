import { extractPdfText, extractTextFromFile } from "@/lib/extract-text";

/**
 * Imagine takes attachments two ways. Images are pixel references handed to
 * the image model, which caps how many it will look at. Everything else is
 * read for its words and folded into the prompt as context — a brand PDF or a
 * folder listing can steer a generation even though it has no pixels to copy.
 */
export type ImagineAttachment = {
  id: string;
  name: string;
  kind: "image" | "text";
  /** Images only — the base64 payload sent as a reference. */
  dataUrl?: string;
  /** Text-bearing attachments only — extracted document or listing text. */
  text?: string;
};

/** The image model only looks at a handful of references. */
export const MAX_IMAGE_ATTACHMENTS = 4;
/** Documents are cheap by comparison; this only stops runaway pastes. */
export const MAX_TEXT_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
/** Per-document budget, so one long PDF can't crowd out the actual prompt. */
const MAX_TEXT_CHARS = 6000;

/** Same set the chat page's hidden file input and the desktop + menu accept. */
export const IMAGINE_FILE_ACCEPT =
  "*/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.txt,.md,.json,.html,.csv,.rtf,.png,.jpg,.jpeg,.gif,.webp,.heic,.heif,.mp3,.wav,.ogg,.flac,.mp4,.mov,.avi,.webm,.m4a,.aac,.wma";

function newId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `ia-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

/**
 * Turn one dropped/picked file into an attachment, or null when there is
 * nothing usable in it. Files that are too large, and documents we can't read,
 * are skipped rather than attached empty — a chip with no content would just
 * mislead the user about what the model can see.
 */
export async function imagineAttachmentFromFile(
  file: File,
  apiBaseUrl: string,
): Promise<ImagineAttachment | null> {
  if (!file || file.size > MAX_ATTACHMENT_BYTES) return null;

  if (file.type.startsWith("image/")) {
    const dataUrl = await readDataUrl(file).catch(() => "");
    if (!dataUrl.startsWith("data:image/")) return null;
    return { id: newId(), name: file.name, kind: "image", dataUrl };
  }

  let text = "";
  try {
    if (isPdf(file)) {
      const pdf = await extractPdfText(file, 6);
      text = pdf?.text || "";
    } else {
      const doc = await extractTextFromFile(file, apiBaseUrl);
      text = doc?.text || "";
    }
  } catch {
    /* unreadable file — skipped below */
  }

  text = text.trim();
  if (!text) return null;
  return {
    id: newId(),
    name: file.name,
    kind: "text",
    text: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text,
  };
}

/**
 * Ingest a batch of files, respecting the per-kind caps against what is
 * already attached. Reading happens in parallel; the caps are applied after so
 * the order the user picked is preserved rather than the order they finished.
 */
export async function ingestImagineFiles(
  files: Iterable<File> | null | undefined,
  existing: ImagineAttachment[],
  apiBaseUrl: string,
): Promise<ImagineAttachment[]> {
  const list = Array.from(files || []);
  if (!list.length) return [];
  const settled = await Promise.all(
    list.map((f) => imagineAttachmentFromFile(f, apiBaseUrl).catch(() => null)),
  );

  let images = existing.filter((a) => a.kind === "image").length;
  let texts = existing.filter((a) => a.kind === "text").length;
  const taken = new Set(existing.map((a) => a.name));
  const added: ImagineAttachment[] = [];

  for (const att of settled) {
    if (!att || taken.has(att.name)) continue;
    if (att.kind === "image") {
      if (images >= MAX_IMAGE_ATTACHMENTS) continue;
      images += 1;
    } else {
      if (texts >= MAX_TEXT_ATTACHMENTS) continue;
      texts += 1;
    }
    taken.add(att.name);
    added.push(att);
  }
  return added;
}

/** A folder is attached as its listing — the model reads what is inside it. */
export function imagineAttachmentFromFolder(name: string, listing: string): ImagineAttachment {
  const body = String(listing || "").trim();
  return {
    id: newId(),
    name,
    kind: "text",
    text: body.length > MAX_TEXT_CHARS ? `${body.slice(0, MAX_TEXT_CHARS)}…` : body,
  };
}

/** A vault item picked into the bar, which arrives as text rather than a file. */
export function imagineAttachmentFromVault(name: string, content: string): ImagineAttachment {
  return imagineAttachmentFromFolder(name, content);
}

/**
 * Fold the attachments into the prompt actually sent. Images are named so the
 * model knows to treat them as the visual base; document text is appended as
 * clearly-labelled reference material rather than as instructions.
 */
export function buildImaginePrompt(text: string, attachments: ImagineAttachment[]): string {
  const base = String(text || "").trim();
  const images = attachments.filter((a) => a.kind === "image");
  const docs = attachments.filter((a) => a.kind === "text" && a.text);
  const parts = [base];

  if (images.length) {
    parts.push(
      `Use the attached reference image${images.length > 1 ? "s" : ""} as the visual base.`,
    );
  }
  for (const doc of docs) {
    parts.push(`Reference material from "${doc.name}":\n${doc.text}`);
  }
  return parts.filter(Boolean).join("\n\n");
}

/** The data urls handed to the image model as pixel references. */
export function imagineReferenceUrls(attachments: ImagineAttachment[]): string[] {
  return attachments
    .filter((a) => a.kind === "image" && a.dataUrl)
    .map((a) => String(a.dataUrl));
}
