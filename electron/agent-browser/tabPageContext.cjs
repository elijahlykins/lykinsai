"use strict";

const PAGE_TEXT_CAP = 12000;

function resolveOwnedTabWebContents(tabId, views) {
  const id = String(tabId || "").trim();
  if (!id) return { ok: false, error: "missing_tab" };
  if (!views || typeof views.get !== "function") {
    return { ok: false, error: "unknown_tab", tabId: id };
  }
  const view = views.get(id);
  const wc = view?.webContents;
  if (!wc || (typeof wc.isDestroyed === "function" && wc.isDestroyed())) {
    return { ok: false, error: "unknown_tab", tabId: id };
  }
  return { ok: true, tabId: id, webContents: wc };
}

function boundPage(page, wc) {
  const url = String(
    page?.url || (typeof wc?.getURL === "function" ? wc.getURL() : "") || "",
  ).slice(0, 2000);
  const title = String(
    page?.title || (typeof wc?.getTitle === "function" ? wc.getTitle() : "") || "",
  ).slice(0, 500);
  const text = String(page?.text || "").slice(0, PAGE_TEXT_CAP);
  return { url, title, text };
}

async function extractOwnedTabPageContext({ tabId, views, getPageContext }) {
  const resolved = resolveOwnedTabWebContents(tabId, views);
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.error,
      tabId: resolved.tabId || String(tabId || "").trim(),
    };
  }
  const { webContents, tabId: id } = resolved;
  try {
    const page = typeof getPageContext === "function" ? await getPageContext(webContents) : null;
    return { ok: true, tabId: id, ...boundPage(page || {}, webContents) };
  } catch (err) {
    return {
      ok: true,
      tabId: id,
      ...boundPage({}, webContents),
      error: err?.message || String(err),
    };
  }
}

module.exports = {
  resolveOwnedTabWebContents,
  extractOwnedTabPageContext,
  PAGE_TEXT_CAP,
};
