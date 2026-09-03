"use strict";

/**
 * AI Drive for Bot agents: list / search what LYKN has made, and open the
 * Finder window or one item. Reads the on-device vault store - the same
 * items the Vault window shows under AI Drive.
 */

const AI_DRIVE_FOLDER = "Generated";
const AI_GENERATED_SOURCES = new Set(["ai_artifact", "studio_imagine"]);
const GENERATED_IMAGE_CAPTION = /^ai-generated image\b/i;

function isAiDriveItem(item) {
  if (!item || item.deleted_at) return false;
  const folder = String(item.folder || "").trim();
  if (folder === AI_DRIVE_FOLDER) return true;
  if (folder) return false;
  if (AI_GENERATED_SOURCES.has(String(item.source || ""))) return true;
  const tags = Array.isArray(item.tags) ? item.tags : [];
  if (tags.some((t) => /^(ai-generated|generated)$/i.test(String(t)))) return true;
  return GENERATED_IMAGE_CAPTION.test(String(item.content || "").trimStart());
}

function hasDocumentTag(item) {
  return (Array.isArray(item?.tags) ? item.tags : []).some(
    (t) => String(t).toLowerCase() === "document",
  );
}

function driveFolderOf(item) {
  const att = String(item.att_type || item.mime_type || "").toLowerCase();
  if (att.startsWith("image/") || /\b(image|png|jpe?g|webp|gif)\b/.test(att)) {
    return "images";
  }
  if (String(item.source || "") === "studio_imagine") return "images";
  if (hasDocumentTag(item)) return "docs";
  return "artifacts";
}

function matchesQuery(item, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const hay = `${item.title || ""} ${item.content || ""} ${(item.tags || []).join(" ")}`.toLowerCase();
  return hay.includes(q);
}

function collectListing(query = "") {
  let store;
  try {
    store = require("../localStore").store;
  } catch {
    return { items: [], artifacts: 0, docs: 0, images: 0, complete: false };
  }
  if (typeof store?.listItems !== "function") {
    return { items: [], artifacts: 0, docs: 0, images: 0, complete: false };
  }
  const items = [];
  let artifacts = 0;
  let docs = 0;
  let images = 0;
  let after;
  let complete = false;
  for (let page = 0; page < 8; page += 1) {
    const rows = store.listItems({ limit: 80, after }) || [];
    if (!rows.length) {
      complete = true;
      break;
    }
    for (const row of rows) {
      if (!isAiDriveItem(row)) continue;
      const folder = driveFolderOf(row);
      if (folder === "images") images += 1;
      else if (folder === "docs") docs += 1;
      else artifacts += 1;
      if (matchesQuery(row, query) && items.length < 40) {
        items.push({
          id: String(row.id || ""),
          name: String(row.title || "Untitled").trim() || "Untitled",
          folder,
        });
      }
    }
    const last = rows[rows.length - 1];
    after = last?.created_at && last?.id ? { created_at: last.created_at, id: last.id } : null;
    if (!after) {
      complete = true;
      break;
    }
  }
  return { items, artifacts, docs, images, complete };
}

function formatListing(listing, query) {
  const lines = [
    query
      ? `AI Drive matches for "${query}":`
      : "AI Drive (things LYKN has built - docs, artifacts, and generated images):",
    `Totals: ${listing.docs || 0} doc(s), ${listing.artifacts} artifact(s), ${listing.images} image(s)${listing.complete ? "" : " (scan incomplete)"}.`,
  ];
  if (!listing.items.length) {
    lines.push(query ? "Nothing in AI Drive matched that." : "AI Drive is empty on this machine.");
    return lines.join("\n");
  }
  const docs = listing.items.filter((i) => i.folder === "docs");
  const artifacts = listing.items.filter((i) => i.folder === "artifacts");
  const images = listing.items.filter((i) => i.folder === "images");
  if (docs.length) {
    lines.push("", "Docs:");
    for (const item of docs) lines.push(`- ${item.name} (id: ${item.id})`);
  }
  if (artifacts.length) {
    lines.push("", "Artifacts:");
    for (const item of artifacts) lines.push(`- ${item.name} (id: ${item.id})`);
  }
  if (images.length) {
    lines.push("", "Image Gen:");
    for (const item of images) lines.push(`- ${item.name} (id: ${item.id})`);
  }
  return lines.join("\n");
}

function openDrive({ id = "", folder = "", name = "" } = {}) {
  let broadcastToAllWindows = () => {};
  try {
    ({ broadcastToAllWindows } = require("../services/initializeElectronServices.cjs"));
  } catch {
    /* tests / non-Electron host */
  }
  const noteId = String(id || "").trim();
  if (noteId) {
    broadcastToAllWindows("lykn:open-ai-drive-item", {
      noteId,
      title: String(name || "").trim(),
      folder: folder === "images" ? "images" : folder === "docs" ? "docs" : "artifacts",
    });
    return `Opened "${name || "that item"}" from AI Drive.`;
  }
  const src =
    folder === "images"
      ? "/vault?pane=drive&folder=images"
      : folder === "docs"
        ? "/vault?pane=drive&folder=docs"
        : folder === "artifacts"
          ? "/vault?pane=drive&folder=artifacts"
          : "/vault?pane=drive";
  broadcastToAllWindows("lykn:open-ai-drive", { src });
  return folder ? `Opened AI Drive / ${folder}.` : "Opened AI Drive.";
}

function parseInstruction(instruction) {
  const text = String(instruction || "").trim();
  const open = text.match(/\bopen\b[\s\S]{0,80}/i);
  const id = text.match(/\bid:\s*([0-9a-f-]{8,})/i);
  const named = text.match(/\bopen\s+(?:the\s+)?["“]?([^"”\n]{2,80})["”]?/i);
  const search = text.match(/\b(?:search|find|look\s+for)\s+(.+)$/i);
  const images = /\bimages?\b|\bimage gen\b/i.test(text);
  const docs = /\bdocs?\b|\bdocuments?\b/i.test(text);
  const artifacts = /\bartifacts?\b/i.test(text);
  let name = named ? named[1].replace(/\s+(from|in|on)\s+ai drive\b/i, "").trim() : "";
  if (/^ai drive\b/i.test(name)) name = "";
  let query = "";
  if (search) {
    query = search[1]
      .replace(/^(?:in\s+)?ai drive\s+(?:for\s+)?/i, "")
      .replace(/\s+(?:in|from|on)\s+ai drive\b/i, "")
      .trim();
  }
  return {
    open: !!open || !!id,
    id: id ? id[1] : "",
    name,
    query,
    folder: images ? "images" : docs ? "docs" : artifacts ? "artifacts" : "",
  };
}

async function runAiDriveTool({ instruction } = {}) {
  const parsed = parseInstruction(instruction);
  const listing = collectListing(parsed.query || parsed.name);
  if (parsed.open) {
    let target = listing.items.find((i) => i.id && i.id === parsed.id);
    if (!target && parsed.name) {
      const want = parsed.name.toLowerCase();
      target =
        listing.items.find((i) => i.name.toLowerCase() === want) ||
        listing.items.find((i) => i.name.toLowerCase().includes(want));
    }
    const opened = openDrive({
      id: target?.id || parsed.id,
      folder: target?.folder || parsed.folder,
      name: target?.name || parsed.name,
    });
    const scan = formatListing(listing, parsed.query || parsed.name);
    return { ok: true, output: `${opened}\n\n${scan}`, summary: opened };
  }
  const output = formatListing(listing, parsed.query);
  return { ok: true, output, summary: output.slice(0, 500) };
}

module.exports = {
  AI_DRIVE_FOLDER,
  isAiDriveItem,
  collectListing,
  formatListing,
  parseInstruction,
  runAiDriveTool,
};
