// LYKN page bridge — streams visible DOM text to the desktop app (localhost).
// Runs on every page; pushes debounced snapshots when content changes.

(function () {
  const HEARTBEAT_MS = 2000;
  const DEBOUNCE_MS = 400;

  function pageRoot() {
    return (
      document.querySelector('[role="main"]') ||
      document.querySelector("main") ||
      document.querySelector("article") ||
      document.body
    );
  }

  function extractSnapshot() {
    const root = pageRoot();
    const raw = (root?.innerText || "").replace(/\s+/g, " ").trim();
    const text = raw.slice(0, 12000);
    const url = location.href;
    const title = document.title || "";
    const sig = `${url}|${text.length}|${text.slice(0, 240)}|${text.slice(-120)}`;
    return { url, title, text, charCount: text.length, sig, at: Date.now() };
  }

  let lastSig = "";
  let debounceTimer = null;
  let heartbeatTimer = null;

  function pushSnapshot(force = false) {
    const snap = extractSnapshot();
    if (!snap.text || snap.text.length < 40) return;
    if (!force && snap.sig === lastSig) return;
    lastSig = snap.sig;
    chrome.runtime.sendMessage({ type: "pageSnapshot", snapshot: snap }).catch(() => {});
  }

  function schedulePush() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => pushSnapshot(false), DEBOUNCE_MS);
  }

  function startObserver() {
    const root = pageRoot();
    if (!root) return;
    const obs = new MutationObserver(() => schedulePush());
    obs.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "title", "value"],
    });
  }

  chrome.storage.sync.get(["pageBridgeEnabled"], (data) => {
    if (data.pageBridgeEnabled === false) return;
    pushSnapshot(true);
    startObserver();
    heartbeatTimer = setInterval(() => pushSnapshot(false), HEARTBEAT_MS);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "bridgeSettingsChanged") {
      if (msg.pageBridgeEnabled === false) {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      } else if (!heartbeatTimer) {
        pushSnapshot(true);
        startObserver();
        heartbeatTimer = setInterval(() => pushSnapshot(false), HEARTBEAT_MS);
      }
    }
    if (msg?.type === "wakeBridge") {
      pushSnapshot(true);
    }
  });
})();
