import type { FocusedChatAttachment } from "@/lib/ai/chatSendOrchestrator";

/* ------------------------------------------------------------------ */
/*  Client-side OCR fallback for image attachments                     */
/*                                                                     */
/*  The model's NATIVE vision still does the real "reading"; this is a */
/*  belt-and-suspenders pass so dense / small / low-contrast text      */
/*  survives even when (a) the turn lands on a weak-vision model,      */
/*  (b) the image gets silently dropped server-side (fetch/scheme),    */
/*  or (c) a provider's vision flakes. The recovered text is injected  */
/*  into the prompt as a hint — it never replaces the image.           */
/*                                                                     */
/*  Tesseract.js is lazily imported so its (~MB) worker + wasm only    */
/*  load on turns that actually carry an image. Every failure path     */
/*  degrades silently — OCR is additive, never blocking.               */
/* ------------------------------------------------------------------ */

const MAX_OCR_IMAGES = 4;
const OCR_TIMEOUT_MS = 10000;
const MIN_USEFUL_CHARS = 8;
const MAX_OCR_TEXT = 4000;

function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ocr_timeout")), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("ocr_aborted"));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
    p.then(
      (v) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Runs OCR over image attachments (in place), setting `att.ocrText` when
 * meaningful text is recovered. Best-effort and degrade-safe: any error,
 * timeout, or abort simply leaves the attachment untouched.
 */
export async function ocrImageAttachments(
  sentAttachments: FocusedChatAttachment[],
  signal: AbortSignal,
  onStatus: (s: string) => void,
): Promise<void> {
  const images = sentAttachments.filter((a) => {
    if ((a.type || "").toLowerCase() !== "image") return false;
    if (a.ocrText) return false; // already done
    const url = a.url || "";
    return url.startsWith("data:image/") || url.startsWith("http") || url.startsWith("blob:");
  });
  if (!images.length) return;

  let Tesseract: typeof import("tesseract.js");
  try {
    Tesseract = await import("tesseract.js");
  } catch {
    return; // OCR engine unavailable — silently skip
  }

  const targets = images.slice(0, MAX_OCR_IMAGES);
  for (let i = 0; i < targets.length; i++) {
    if (signal.aborted) return;
    const att = targets[i];
    try {
      onStatus(targets.length > 1 ? `Reading text in image ${i + 1}/${targets.length}…` : "Reading text in image…");
      const result = await withTimeout(
        Tesseract.recognize(att.url, "eng"),
        OCR_TIMEOUT_MS,
        signal,
      );
      const text = String(result?.data?.text || "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const meaningful = text.replace(/\s/g, "");
      if (meaningful.length >= MIN_USEFUL_CHARS) {
        att.ocrText = text.length > MAX_OCR_TEXT ? text.slice(0, MAX_OCR_TEXT) + "…" : text;
      }
    } catch {
      /* timeout / abort / decode error — skip this image */
    }
  }
  onStatus("");
}
