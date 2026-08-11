// Renderer for the detached live meeting notes window. A thin remote view:
// the overlay renderer owns the audio streams, transcript, and notes state,
// and pushes render snapshots here; every user action is forwarded back.

if (window.lyknLive?.platform && window.lyknLive.platform !== "darwin") {
  document.documentElement.classList.add("no-vibrancy");
}

const dotEl = document.getElementById("live-dot");
const titleEl = document.getElementById("live-title");
const toastEl = document.getElementById("live-saved-toast");
const saveBtn = document.getElementById("live-save");
const panes = {
  notes: document.getElementById("pane-notes"),
  ask: document.getElementById("pane-ask"),
  transcript: document.getElementById("pane-transcript"),
};
const tabs = {
  notes: document.getElementById("tab-notes"),
  ask: document.getElementById("tab-ask"),
  transcript: document.getElementById("tab-transcript"),
};

let activePane = "notes";

function applyState(state) {
  dotEl.classList.toggle("live", !!state.listening);
  titleEl.textContent = state.title || "Meeting notes";

  activePane = state.pane || "notes";
  for (const key of Object.keys(panes)) {
    tabs[key].classList.toggle("active", key === activePane);
    panes[key].hidden = key !== activePane;
  }

  if (typeof state.notesHtml === "string") panes.notes.innerHTML = state.notesHtml;
  if (typeof state.askHtml === "string") panes.ask.innerHTML = state.askHtml;
  if (typeof state.transcriptHtml === "string") {
    // Keep the transcript pinned to the newest line unless the user has
    // scrolled up to read something earlier.
    const el = panes.transcript;
    const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.innerHTML = state.transcriptHtml;
    if (stick) el.scrollTop = el.scrollHeight;
  }

  saveBtn.classList.toggle("saved", !!state.saveSaved);
  saveBtn.disabled = !!state.saveDisabled;
  toastEl.hidden = !state.toastText;
  toastEl.textContent = state.toastText || "Open in Vault →";
}

window.lyknLive.onState(applyState);

for (const [pane, tab] of Object.entries(tabs)) {
  tab.addEventListener("click", () => window.lyknLive.cmd("pane", pane));
}
document.getElementById("live-close").addEventListener("click", () => window.lyknLive.cmd("close"));
document.getElementById("live-copy").addEventListener("click", () => window.lyknLive.cmd("copy"));
saveBtn.addEventListener("click", () => window.lyknLive.cmd("save"));
toastEl.addEventListener("click", () => window.lyknLive.cmd("vault"));

// Buttons in the Suggestions pane arrive via innerHTML snapshots, so their
// click handlers can't travel with them — delegate. "Questions to ask" send
// the question text back; assist-card source chips open in the browser via
// the overlay, which owns the safe URL-opening path.
panes.ask.addEventListener("click", (e) => {
  const src = e.target.closest(".assist-src");
  if (src && src.dataset.url) {
    window.lyknLive.cmd("url", {
      url: src.dataset.url,
      title: src.dataset.title || undefined,
    });
    return;
  }
  const btn = e.target.closest(".meeting-question");
  if (!btn) return;
  const text = (btn.textContent || "").trim();
  if (text) window.lyknLive.cmd("ask", text);
});
