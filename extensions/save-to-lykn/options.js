const DEFAULT_BASE = "https://lykn.io";

const baseInput = document.getElementById("baseUrl");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");

async function load() {
  const { lyknBaseUrl } = await chrome.storage.sync.get(["lyknBaseUrl"]);
  baseInput.value = lyknBaseUrl || DEFAULT_BASE;
}

saveBtn.addEventListener("click", async () => {
  const raw = (baseInput.value || "").trim().replace(/\/+$/, "");
  if (!raw || !/^https?:\/\//i.test(raw)) {
    statusEl.classList.add("error");
    statusEl.textContent = "Please enter a full URL starting with http(s)://";
    return;
  }
  statusEl.classList.remove("error");
  await chrome.storage.sync.set({ lyknBaseUrl: raw });
  statusEl.textContent = "Saved";
  setTimeout(() => (statusEl.textContent = ""), 1500);
});

load();
