const DEFAULT_BASE = "https://lykn.io";
const DEFAULT_BRIDGE_PORT = 38471;

const baseInput = document.getElementById("baseUrl");
const bridgePortInput = document.getElementById("bridgePort");
const pageBridgeEnabledInput = document.getElementById("pageBridgeEnabled");
const saveBtn = document.getElementById("save");
const testBridgeBtn = document.getElementById("testBridge");
const statusEl = document.getElementById("status");

async function load() {
  const { lyknBaseUrl, lyknBridgePort, pageBridgeEnabled } = await chrome.storage.sync.get([
    "lyknBaseUrl",
    "lyknBridgePort",
    "pageBridgeEnabled",
  ]);
  baseInput.value = lyknBaseUrl || DEFAULT_BASE;
  bridgePortInput.value = lyknBridgePort || DEFAULT_BRIDGE_PORT;
  pageBridgeEnabledInput.checked = pageBridgeEnabled !== false;
}

async function saveSettings() {
  const raw = (baseInput.value || "").trim().replace(/\/+$/, "");
  if (!raw || !/^https?:\/\//i.test(raw)) {
    statusEl.classList.add("error");
    statusEl.textContent = "Please enter a full URL starting with http(s)://";
    return false;
  }
  const port = Number(bridgePortInput.value) || DEFAULT_BRIDGE_PORT;
  if (port < 1024 || port > 65535) {
    statusEl.classList.add("error");
    statusEl.textContent = "Bridge port must be between 1024 and 65535";
    return false;
  }
  statusEl.classList.remove("error");
  await chrome.storage.sync.set({
    lyknBaseUrl: raw,
    lyknBridgePort: port,
    pageBridgeEnabled: pageBridgeEnabledInput.checked,
  });
  chrome.runtime.sendMessage({
    type: "bridgeSettingsChanged",
    pageBridgeEnabled: pageBridgeEnabledInput.checked,
  }).catch(() => {});
  statusEl.textContent = "Saved";
  setTimeout(() => (statusEl.textContent = ""), 1500);
  return true;
}

saveBtn.addEventListener("click", saveSettings);

testBridgeBtn.addEventListener("click", async () => {
  await saveSettings();
  statusEl.classList.remove("error");
  statusEl.textContent = "Testing…";
  chrome.runtime.sendMessage({ type: "testBridge" }, (resp) => {
    if (chrome.runtime.lastError) {
      statusEl.classList.add("error");
      statusEl.textContent = chrome.runtime.lastError.message || "Test failed";
      return;
    }
    if (resp?.ok) {
      statusEl.textContent = "Connected to LYKN desktop ✓";
    } else {
      statusEl.classList.add("error");
      statusEl.textContent =
        resp?.error || "Could not reach LYKN desktop. Is the app running?";
    }
    setTimeout(() => (statusEl.textContent = ""), 3000);
  });
});

load();
