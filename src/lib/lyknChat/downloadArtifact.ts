/**
 * Save chat artifacts to the user's computer.
 *
 * Remote `download` attributes often fail (cross-origin + Content-Disposition:
 * inline on the file proxy), so we always materialize a Blob and hand the bytes
 * to `downloadToComputer`. HTML is saved as octet-stream so Chromium / Electron
 * actually writes a file instead of opening (or printing) the page.
 */

import JSZip from "jszip";
import { jsPDF } from "jspdf";
import type { ChatArtifact } from "@/lib/ai/chatArtifacts";
import { safeAttachmentUrl } from "@/lib/safeExternalUrl";
import { downloadToComputer } from "@/lib/files/downloadToComputer";

export type ArtifactDownloadOption = {
  id: string;
  /** Short menu label, e.g. "HTML", "Source (.jsx)", "PPTX". */
  label: string;
  format: string;
  run: () => Promise<void>;
};

function basenameFromArtifact(artifact: ChatArtifact): string {
  const raw = String(artifact.filename || artifact.title || "artifact")
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/[^\w\-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return raw || "artifact";
}

/**
 * Write a Blob or a string to the user's Downloads folder.
 *
 * Kept synchronous because every caller treats a download as fire-and-forget;
 * anything that needs the path on disk should await `downloadToComputer`.
 */
export function triggerBlobDownload(
  data: Blob | string,
  filename: string,
  mime = "application/octet-stream",
): void {
  void downloadToComputer(data, filename, mime);
}

async function fetchAsBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return res.blob();
}

async function downloadRemoteUrl(
  url: string,
  filename: string,
  fallbackMime?: string,
): Promise<void> {
  const blob = await fetchAsBlob(url);
  const lower = filename.toLowerCase();
  // Force a file save for HTML — text/html blobs open in a window instead.
  if (lower.endsWith(".html") || lower.endsWith(".htm") || fallbackMime?.includes("text/html")) {
    triggerBlobDownload(await blob.text(), filename, "application/octet-stream");
    return;
  }
  const typed =
    blob.type && blob.type !== "application/octet-stream"
      ? blob
      : new Blob([blob], {
          type: fallbackMime || blob.type || "application/octet-stream",
        });
  triggerBlobDownload(typed, filename, typed.type);
}

function mimeForFormat(format: string): string {
  const f = format.toLowerCase();
  if (f === "html" || f === "htm") return "application/octet-stream";
  if (f === "jsx" || f === "tsx" || f === "js" || f === "ts") return "text/plain;charset=utf-8";
  if (f === "json") return "application/json;charset=utf-8";
  if (f === "md" || f === "markdown") return "text/markdown;charset=utf-8";
  if (f === "pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (f === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (f === "csv") return "text/csv;charset=utf-8";
  if (f === "pdf") return "application/pdf";
  if (f === "png") return "image/png";
  if (f === "jpg" || f === "jpeg") return "image/jpeg";
  if (f === "webp") return "image/webp";
  if (f === "mp4") return "video/mp4";
  if (f === "zip") return "application/zip";
  return "application/octet-stream";
}

async function downloadHtmlPreview(artifact: ChatArtifact): Promise<void> {
  const name = `${basenameFromArtifact(artifact)}.html`;
  const saveHtml = (html: string) =>
    triggerBlobDownload(html, name, "application/octet-stream");
  if (typeof artifact.srcDoc === "string" && artifact.srcDoc.trim()) {
    saveHtml(artifact.srcDoc);
    return;
  }
  const url =
    safeAttachmentUrl(artifact.previewUrl) ||
    safeAttachmentUrl(artifact.downloadUrl);
  if (!url) throw new Error("No HTML preview available to download");
  const blob = await fetchAsBlob(url);
  saveHtml(await blob.text());
}

async function downloadReactSource(artifact: ChatArtifact): Promise<void> {
  const base = basenameFromArtifact(artifact);
  const files = Array.isArray(artifact.files) ? artifact.files : null;
  if (files && files.length > 1) {
    const zip = new JSZip();
    for (const f of files) {
      const path = String(f.path || "").replace(/^\/+/, "") || "file.jsx";
      zip.file(path, String(f.content ?? ""));
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerBlobDownload(blob, `${base}-source.zip`, "application/zip");
    return;
  }
  const single =
    (files && files.length === 1 && String(files[0].content ?? "")) ||
    (typeof artifact.code === "string" ? artifact.code : "");
  if (!single.trim()) throw new Error("No source code to download");
  const pathExt =
    files?.[0]?.path && /\.[a-z0-9]+$/i.test(files[0].path)
      ? files[0].path.replace(/^.*\./, ".")
      : ".jsx";
  triggerBlobDownload(single, `${base}${pathExt}`, "text/plain;charset=utf-8");
}

async function downloadImageAsPdf(artifact: ChatArtifact): Promise<void> {
  const url =
    safeAttachmentUrl(artifact.previewUrl) ||
    safeAttachmentUrl(artifact.downloadUrl) ||
    safeAttachmentUrl(artifact.downloads?.[0]?.url);
  if (!url) throw new Error("No image to export as PDF");

  const blob = await fetchAsBlob(url);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Could not load image for PDF"));
      el.src = objectUrl;
    });
    const w = img.naturalWidth || img.width || 1;
    const h = img.naturalHeight || img.height || 1;
    const landscape = w > h;
    const pdf = new jsPDF({
      orientation: landscape ? "landscape" : "portrait",
      unit: "pt",
      format: "a4",
      compress: true,
    });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 24;
    const maxW = pageW - margin * 2;
    const maxH = pageH - margin * 2;
    const scale = Math.min(maxW / w, maxH / h);
    const drawW = w * scale;
    const drawH = h * scale;
    const x = (pageW - drawW) / 2;
    const y = (pageH - drawH) / 2;
    const fmt = blob.type.includes("jpeg") || blob.type.includes("jpg") ? "JPEG" : "PNG";
    pdf.addImage(img, fmt, x, y, drawW, drawH);
    const out = pdf.output("blob");
    triggerBlobDownload(
      out,
      `${basenameFromArtifact(artifact)}.pdf`,
      "application/pdf",
    );
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function remotePdfLink(artifact: ChatArtifact) {
  return (artifact.downloads || []).find(
    (d) => String(d.format || "").toLowerCase() === "pdf" && safeAttachmentUrl(d.url),
  );
}

function canDownloadRealPdf(artifact: ChatArtifact): boolean {
  return Boolean(remotePdfLink(artifact) || artifact.kind === "image");
}

/** PDF export: a real .pdf file only (remote link or image→PDF). Never print. */
export async function downloadArtifactAsPdf(
  artifact: ChatArtifact,
): Promise<void> {
  const remotePdf = remotePdfLink(artifact);
  if (remotePdf) {
    const href = safeAttachmentUrl(remotePdf.url)!;
    await downloadRemoteUrl(
      href,
      remotePdf.filename || `${basenameFromArtifact(artifact)}.pdf`,
      "application/pdf",
    );
    return;
  }

  if (artifact.kind === "image") {
    await downloadImageAsPdf(artifact);
    return;
  }

  throw new Error("No PDF file available to download");
}

/**
 * Build the download menu for an artifact. Always prefers formats the user
 * can open offline (HTML preview, images, office files, source).
 */
export function listArtifactDownloadOptions(
  artifact: ChatArtifact,
): ArtifactDownloadOption[] {
  const options: ArtifactDownloadOption[] = [];
  const seen = new Set<string>();
  const add = (opt: ArtifactDownloadOption) => {
    if (seen.has(opt.id)) return;
    seen.add(opt.id);
    options.push(opt);
  };

  const isReact = artifact.toolName === "lykn_build_react_artifact";
  const hasHtml =
    artifact.kind === "html" ||
    (typeof artifact.srcDoc === "string" && !!artifact.srcDoc.trim()) ||
    !!safeAttachmentUrl(artifact.previewUrl);

  if (hasHtml) {
    add({
      id: "html",
      label: isReact ? "App (.html)" : "HTML",
      format: "html",
      run: () => downloadHtmlPreview(artifact),
    });
  }

  // Real PDF files only — never the system print dialog.
  if (canDownloadRealPdf(artifact)) {
    add({
      id: "pdf",
      label: "PDF",
      format: "pdf",
      run: () => downloadArtifactAsPdf(artifact),
    });
  }

  if (
    isReact &&
    ((typeof artifact.code === "string" && artifact.code.trim()) ||
      (Array.isArray(artifact.files) && artifact.files.length > 0))
  ) {
    const multi = Array.isArray(artifact.files) && artifact.files.length > 1;
    add({
      id: "source",
      label: multi ? "Source (.zip)" : "Source (.jsx)",
      format: multi ? "zip" : "jsx",
      run: () => downloadReactSource(artifact),
    });
  }

  if (artifact.kind === "image") {
    const url =
      safeAttachmentUrl(artifact.previewUrl) ||
      safeAttachmentUrl(artifact.downloadUrl) ||
      safeAttachmentUrl(artifact.downloads?.[0]?.url);
    if (url) {
      const fmt = (artifact.format || "png").toLowerCase();
      add({
        id: "image",
        label: fmt.toUpperCase(),
        format: fmt,
        run: () =>
          downloadRemoteUrl(
            url,
            artifact.filename || `${basenameFromArtifact(artifact)}.${fmt}`,
            mimeForFormat(fmt),
          ),
      });
    }
  }

  if (artifact.kind === "video") {
    const url =
      safeAttachmentUrl(artifact.previewUrl) ||
      safeAttachmentUrl(artifact.downloadUrl) ||
      safeAttachmentUrl(artifact.downloads?.[0]?.url);
    if (url) {
      add({
        id: "video",
        label: "MP4",
        format: "mp4",
        run: () =>
          downloadRemoteUrl(
            url,
            artifact.filename || `${basenameFromArtifact(artifact)}.mp4`,
            "video/mp4",
          ),
      });
    }
  }

  const remoteLinks =
    artifact.downloads && artifact.downloads.length
      ? artifact.downloads
      : artifact.downloadUrl
        ? [
            {
              format: artifact.format || "file",
              url: artifact.downloadUrl,
              filename: artifact.filename,
            },
          ]
        : [];

  for (const d of remoteLinks) {
    const href = safeAttachmentUrl(d.url);
    if (!href) continue;
    const fmt = String(d.format || "file").toLowerCase();
    // Skip formats we already offer as first-class local options.
    if ((fmt === "html" || fmt === "htm") && hasHtml) continue;
    if ((fmt === "jsx" || fmt === "tsx") && isReact) continue;
    if (fmt === "pdf" && canDownloadRealPdf(artifact)) continue;
    const id = `remote:${fmt}:${href.slice(-24)}`;
    const ext = fmt.replace(/[^a-z0-9]+/gi, "") || "file";
    const filename =
      d.filename ||
      `${basenameFromArtifact(artifact)}.${ext === "file" ? "bin" : ext}`;
    add({
      id,
      label: fmt.toUpperCase(),
      format: fmt,
      run: () => downloadRemoteUrl(href, filename, mimeForFormat(fmt)),
    });
  }

  return options;
}

/** Download the primary (first) option, or a specific option by id. */
export async function downloadArtifactToComputer(
  artifact: ChatArtifact,
  optionId?: string,
): Promise<void> {
  const options = listArtifactDownloadOptions(artifact);
  if (!options.length) throw new Error("Nothing to download");
  const pick =
    (optionId && options.find((o) => o.id === optionId)) || options[0];
  await pick.run();
}
