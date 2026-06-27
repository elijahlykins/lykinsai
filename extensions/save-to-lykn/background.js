// Save to LYKN — MV3 background service worker
//
// Strategy: the extension never holds auth tokens. It just opens
//   {LYKN_BASE}/share?url=<encoded URL>
// in a new tab. The user's existing logged-in session in the LYKN
// SPA does the actual save via /share -> saveLinkToVault().

const DEFAULT_BASE = "https://lykn.io";
const DEFAULT_BRIDGE_PORT = 38471;
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

async function getBridgeSettings() {
  const { lyknBridgePort, pageBridgeEnabled } = await chrome.storage.sync.get([
    "lyknBridgePort",
    "pageBridgeEnabled",
  ]);
  const port = Number(lyknBridgePort) || DEFAULT_BRIDGE_PORT;
  const enabled = pageBridgeEnabled !== false;
  return { port, enabled };
}

let lastBridgeSig = "";
let bridgePushInFlight = false;
let bridgePingTimer = null;

async function pingBridge() {
  const { port, enabled } = await getBridgeSettings();
  if (!enabled) return;
  try {
    await fetch(`http://127.0.0.1:${port}/ping`, { method: "POST" });
  } catch {
    /* desktop app not running */
  }
}

function startBridgePing() {
  if (bridgePingTimer) clearInterval(bridgePingTimer);
  bridgePingTimer = setInterval(() => void pingBridge(), 4000);
  void pingBridge();
}

async function pushPageSnapshot(snapshot) {
  if (!snapshot?.text || snapshot.text.length < 40) return;
  const { port, enabled } = await getBridgeSettings();
  if (!enabled) return;
  if (snapshot.sig && snapshot.sig === lastBridgeSig) return;
  if (bridgePushInFlight) return;
  bridgePushInFlight = true;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/page`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
    });
    if (res.ok) lastBridgeSig = snapshot.sig || "";
  } catch (e) {
    console.warn("[LYKN bridge] push failed:", e?.message || e);
  } finally {
    bridgePushInFlight = false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  startBridgePing();
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

chrome.runtime.onStartup.addListener(() => {
  startBridgePing();
});

// Re-inject / wake content script when user switches tabs (handles tabs open before install).
chrome.tabs.onActivated.addListener(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || tab.url.startsWith("chrome://")) return;
    await chrome.tabs.sendMessage(tab.id, { type: "wakeBridge" }).catch(async () => {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    });
  } catch {
    /* ignore */
  }
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
  if (msg?.type === "pageSnapshot") {
    pushPageSnapshot(msg.snapshot).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "pingBridge") {
    pingBridge().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "bridgeSettingsChanged") {
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (tab.id) chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
      }
    });
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === "testBridge") {
    (async () => {
      const { port } = await getBridgeSettings();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/status`);
        const data = await res.json();
        sendResponse({ ok: res.ok, ...data });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
  return false;
});

startBridgePing();
