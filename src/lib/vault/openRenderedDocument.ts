/**
 * Show a written HTML document as a page the user can read.
 *
 * The LYKN browser is the default (same path artifacts use). Safari / Chrome
 * never get the file. If the desktop bridge is missing, the in-app file
 * window frames the page instead of dumping the source.
 */

import { openFileWindow } from "@/lib/files/fileWindows";
import { openArtifactInStudioBrowser, studioOpenChatOpts } from "@/lib/lyknChat/openInStudioBrowser";

export function openRenderedDocument(opts: {
  title?: string | null;
  html?: string | null;
  url?: string | null;
  chatId?: string | null;
}): boolean {
  const title = String(opts.title || "Document").trim() || "Document";
  const html = typeof opts.html === "string" ? opts.html : "";
  const url = String(opts.url || "").trim();
  const hosted = /^https?:\/\//i.test(url) ? url : "";

  if (openArtifactInStudioBrowser({
    srcDoc: html || undefined,
    previewUrl: hosted || undefined,
    title,
    kind: "document",
  }, studioOpenChatOpts(opts.chatId))) {
    return true;
  }

  if (html) {
    const blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    openFileWindow({
      name: title,
      url: blobUrl,
      mime: "text/html",
      media: "html",
    });
    return true;
  }

  return false;
}
