const urlEl = document.getElementById("currentUrl");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");
const optionsLink = document.getElementById("openOptions");

let activeTab = null;

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  urlEl.textContent = tab?.url || "No active tab";
  if (!tab?.url || /^chrome:\/\//i.test(tab.url) || /^edge:\/\//i.test(tab.url)) {
    saveBtn.disabled = true;
    statusEl.classList.add("error");
    statusEl.textContent = "This page can't be saved.";
  }
}

saveBtn.addEventListener("click", async () => {
  if (!activeTab?.url) return;
  saveBtn.disabled = true;
  statusEl.classList.remove("error");
  statusEl.textContent = "Opening LYKN…";
  chrome.runtime.sendMessage({ type: "saveCurrentTab" }, (resp) => {
    if (resp?.ok) {
      statusEl.textContent = "Sent to LYKN";
      setTimeout(() => window.close(), 600);
    } else {
      statusEl.classList.add("error");
      statusEl.textContent = resp?.error || "Could not open LYKN.";
      saveBtn.disabled = false;
    }
  });
});

optionsLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage?.();
});

init();
