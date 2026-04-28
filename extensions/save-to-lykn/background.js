// Save to LYKN — MV3 background service worker
//
// Strategy: the extension never holds auth tokens. It just opens
//   {LYKN_BASE}/share?url=<encoded URL>
// in a new tab. The user's existing logged-in session in the LYKN
// SPA does the actual save via /share -> saveLinkToVault().

const DEFAULT_BASE = "https://lykn.io";
const CONTEXT_MENU_PAGE_ID = "lykn-save-page";
const CONTEXT_MENU_LINK_ID = "lykn-save-link";
const CONTEXT_MENU_IMAGE_ID = "lykn-save-image";
const CONTEXT_MENU_VIDEO_ID = "lykn-save-video";

async function getBaseUrl() {
  const { lyknBaseUrl } = await chrome.storage.sync.get(["lyknBaseUrl"]);
  const raw = (lyknBaseUrl || DEFAULT_BASE).trim().replace(/\/+$/, "");
  return raw;
}

function buildShareUrl(base, targetUrl, title) {
  const params = new URLSearchParams();
  params.set("url", targetUrl);
  if (title) params.set("title", title);
  return `${base}/share?${params.toString()}`;
}

async function openShare(targetUrl, title) {
  if (!targetUrl) return;
  const base = await getBaseUrl();
  const shareUrl = buildShareUrl(base, targetUrl, title || "");
  await chrome.tabs.create({ url: shareUrl, active: true });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_PAGE_ID,
    title: "Save this page to LYKN",
    contexts: ["page"],
  });
  chrome.contextMenus.create({
    id: CONTEXT_MENU_LINK_ID,
    title: "Save link to LYKN",
    contexts: ["link"],
  });
  chrome.contextMenus.create({
    id: CONTEXT_MENU_IMAGE_ID,
    title: "Save image to LYKN",
    contexts: ["image"],
  });
  chrome.contextMenus.create({
    id: CONTEXT_MENU_VIDEO_ID,
    title: "Save video to LYKN",
    contexts: ["video"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let target = "";
  let title = "";

  switch (info.menuItemId) {
    case CONTEXT_MENU_LINK_ID:
      target = info.linkUrl || "";
      title = info.selectionText || "";
      break;
    case CONTEXT_MENU_IMAGE_ID:
      target = info.srcUrl || info.linkUrl || "";
      break;
    case CONTEXT_MENU_VIDEO_ID:
      target = info.srcUrl || info.linkUrl || tab?.url || "";
      break;
    case CONTEXT_MENU_PAGE_ID:
    default:
      target = info.pageUrl || tab?.url || "";
      title = tab?.title || "";
      break;
  }

  if (!target) return;
  await openShare(target, title);
});

// Toolbar click fallback (if popup ever fails to open).
chrome.action.onClicked?.addListener?.(async (tab) => {
  const target = tab?.url || "";
  if (!target) return;
  await openShare(target, tab?.title || "");
});

// Allow popup.js / options.js to ask for the current base URL or save.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "getBaseUrl") {
    getBaseUrl().then((base) => sendResponse({ base }));
    return true;
  }
  if (msg?.type === "saveCurrentTab") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) {
        sendResponse({ ok: false, error: "No active tab" });
        return;
      }
      await openShare(tab.url, tab.title || "");
      sendResponse({ ok: true });
    })();
    return true;
  }
  return false;
});
