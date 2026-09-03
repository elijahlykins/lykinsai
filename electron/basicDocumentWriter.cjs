"use strict";

/**
 * Persist a basic document the AI just wrote: HTML on disk (Downloads).
 * AI Drive / Docs is filed by the renderer - that is the vault the UI reads.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { assembleDocument, parseDocumentInstruction, uniquePathInDir } =
  require("../lib/basicDocument.cjs");

function defaultDeps() {
  let app = null;
  let broadcastToAllWindows = () => {};
  try {
    ({ app } = require("electron"));
  } catch {
    /* tests */
  }
  try {
    ({ broadcastToAllWindows } = require("./services/initializeElectronServices.cjs"));
  } catch {
    /* tests */
  }
  return { app, broadcastToAllWindows, fs: fsp, fsSync: fs, path };
}

/**
 * Open the rendered page in LYKN - never Safari / Chrome. The renderer also
 * files the HTML into AI Drive / Docs from this payload.
 */
function openDocument(title, html, filename, deps) {
  if (typeof deps.broadcastToAllWindows !== "function") return;
  deps.broadcastToAllWindows("lykn:open-ai-drive-item", {
    noteId: "",
    title,
    folder: "docs",
    filename: String(filename || ""),
    html: String(html || ""),
  });
}

/**
 * Write a basic document to Downloads and AI Drive.
 *
 * @param {{ title?: string, content?: string, format?: string, instruction?: string, open?: boolean }} input
 * @param {object} [deps]
 */
async function writeBasicDocument(input = {}, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const parsed = input.content
    ? { title: input.title, content: input.content }
    : parseDocumentInstruction(input.instruction);
  const doc = assembleDocument({
    title: input.title || parsed.title,
    content: input.content || parsed.content,
    format: input.format,
  });
  if (!doc.ok) {
    return { ok: false, error: doc.error || "empty_document" };
  }

  let diskPath = "";
  const downloadsDir =
    (typeof d.downloadsDir === "string" && d.downloadsDir) ||
    (d.app && typeof d.app.getPath === "function" ? d.app.getPath("downloads") : "");
  if (downloadsDir) {
    const exists = (p) => (d.fsSync || fs).existsSync(p);
    diskPath = uniquePathInDir(downloadsDir, doc.filename, exists);
    const write = d.fs?.writeFile || fsp.writeFile;
    await write(diskPath, doc.html, "utf8");
  }

  if (input.open !== false) {
    openDocument(doc.title, doc.html, path.basename(diskPath || doc.filename), d);
  }

  const where = [
    diskPath ? `Downloads as ${path.basename(diskPath)}` : "",
    "AI Drive / Docs",
  ]
    .filter(Boolean)
    .join(" and ");
  const summary = diskPath
    ? `Saved "${doc.title}" to ${where} and opened it in the LYKN browser.`
    : `Wrote "${doc.title}" but could not save it to this machine.`;

  return {
    ok: true,
    title: doc.title,
    filename: diskPath ? path.basename(diskPath) : doc.filename,
    path: diskPath || null,
    noteId: null,
    html: doc.html,
    markdown: doc.markdown,
    summary,
  };
}

module.exports = {
  writeBasicDocument,
};
