"use strict";

/**
 * Host seam for passive browser observation. Not a runtime — it resolves a
 * durable Routine target onto a live WebContents (or reports that none
 * matches) and returns a compact AXI-style observation. No model call, no
 * click, no generation-ref persistence.
 */

const { buildSnapshot } = require("../browser-agent/browser/snapshot.cjs");
const { createBrowserSession } = require("../browser-agent/browser/session.cjs");
const {
  compactObservation,
  urlsMatch,
  looksLoggedOut,
  originOf,
} = require("./browserObservation.cjs");

/**
 * @param {object} deps
 * @param {() => Array<{ url: string, title?: string, wc?: object, appName?: string, id?: string }>} deps.listTabs
 * @param {(wc: object) => Promise<{ok?: boolean, items?: object[], url?: string, viewport?: object}>} deps.getDOMCatalog
 * @param {(wc: object) => Promise<{ok?: boolean, url?: string, title?: string, text?: string}>} deps.getPageContext
 */
function createBrowserObserveHost({ listTabs, getDOMCatalog, getPageContext } = {}) {
  if (typeof listTabs !== "function") throw new TypeError("browser observe host requires listTabs");

  async function snapshotOf(tab) {
    const wc = tab.wc;
    if (!wc || wc.isDestroyed?.()) {
      return { ok: false, status: "target_unavailable" };
    }
    const session = createBrowserSession({ taskId: "monitor" });
    let catalogRes = { items: [] };
    let contextRes = { url: tab.url || "", title: tab.title || "", text: "" };
    try {
      if (typeof getDOMCatalog === "function") catalogRes = await getDOMCatalog(wc);
    } catch {
      catalogRes = { ok: false, items: [] };
    }
    try {
      if (typeof getPageContext === "function") contextRes = await getPageContext(wc);
    } catch {
      /* keep tab url/title */
    }
    const snapshot = buildSnapshot({
      url: contextRes?.url || catalogRes?.url || tab.url || wc.getURL?.() || "",
      title: contextRes?.title || tab.title || wc.getTitle?.() || "",
      catalog: Array.isArray(catalogRes?.items) ? catalogRes.items : [],
      text: contextRes?.text || "",
      generation: session.beginGeneration(),
    });
    return { snapshot, session, wc };
  }

  function pickTab(target) {
    const tabs = (listTabs() || []).filter((t) => t && (t.url || t.wc));
    if (!tabs.length) return { status: "target_unavailable", tab: null };
    const exact = tabs.filter((t) => urlsMatch(t.url || t.wc?.getURL?.(), target.url, target.origin));
    if (exact.length === 1) return { status: "ok", tab: exact[0] };
    if (exact.length > 1) {
      // Prefer the hinted tab when several match the same origin, never a
      // random extra tab that merely shares a host.
      const hinted = exact.find((t) => target.tabIdHint && t.id === target.tabIdHint);
      return { status: "ok", tab: hinted || exact[0] };
    }
    if (target.tabIdHint) {
      const hinted = tabs.find((t) => t.id === target.tabIdHint);
      if (hinted) return { status: "navigated_away", tab: hinted };
    }
    return { status: "target_unavailable", tab: null };
  }

  async function observe({ target, query } = {}) {
    const spec = target && typeof target === "object" ? target : {};
    const picked = pickTab(spec);
    if (!picked.tab) {
      return { ok: false, status: picked.status || "target_unavailable" };
    }
    const liveUrl = picked.tab.url || picked.tab.wc?.getURL?.() || "";
    const liveTitle = picked.tab.title || picked.tab.wc?.getTitle?.() || "";
    if (picked.status === "navigated_away") {
      const loggedOut = looksLoggedOut(liveUrl, liveTitle, spec.origin || originOf(spec.url));
      return {
        ok: false,
        status: loggedOut ? "needs_attention" : "navigated_away",
        url: liveUrl,
        title: liveTitle,
      };
    }
    const shot = await snapshotOf(picked.tab);
    if (!shot.snapshot) return { ok: false, status: shot.status || "target_unavailable" };
    const compact = compactObservation(shot.snapshot, { target: spec.target || query?.target || spec });
    compact.appName = picked.tab.appName || spec.appName || "";
    compact.tabId = picked.tab.id || "";
    return compact;
  }

  function subscribe(target, onEvent) {
    const picked = pickTab(target && typeof target === "object" ? target : {});
    const wc = picked.tab?.wc;
    if (!wc || typeof wc.on !== "function") return { close: () => {} };
    const handler = () => {
      try {
        onEvent();
      } catch {
        /* observer only */
      }
    };
    wc.on("did-navigate", handler);
    wc.on("did-navigate-in-page", handler);
    wc.on("page-title-updated", handler);
    return {
      close: () => {
        try {
          wc.off?.("did-navigate", handler);
          wc.off?.("did-navigate-in-page", handler);
          wc.off?.("page-title-updated", handler);
        } catch {
          /* gone */
        }
      },
    };
  }

  return { observe, subscribe };
}

module.exports = { createBrowserObserveHost };
