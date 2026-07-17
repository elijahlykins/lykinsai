// Detached side-panel content card. Renders section snapshots pushed from the
// overlay renderer (which owns the data) and forwards user actions back.
// See panel-preload.cjs for the bridge and main.cjs for window management.

const titleEl = document.getElementById("title");
const bodyEl = document.getElementById("body");
const closeEl = document.getElementById("close");

const LINK_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

// Snapshots arrive as innerHTML, so inline listeners from the overlay DOM are
// gone — favicon load failures are caught here (capture phase) instead.
bodyEl.addEventListener(
  "error",
  (e) => {
    const img = e.target;
    if (!img || !img.classList || !img.classList.contains("suggest-fav-img")) return;
    const fav = img.closest(".suggest-fav");
    if (fav) {
      fav.classList.add("fallback");
      fav.innerHTML = LINK_ICON_SVG;
    }
  },
  true,
);

// Size the window to the rendered content (card chrome + head + body).
function reportSize() {
  requestAnimationFrame(() => {
    const card = document.getElementById("card");
    const chrome = card.offsetHeight - bodyEl.clientHeight;
    const h = Math.ceil(bodyEl.scrollHeight + chrome + 2);
    window.lyknPanel.resize(h);
  });
}

window.lyknPanel.onState((state) => {
  titleEl.textContent = state.title || "Panel";
  if (typeof state.html === "string") bodyEl.innerHTML = state.html;
  if (state.scrollBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
  reportSize();
});

closeEl.addEventListener("click", () => window.lyknPanel.cmd("close"));

// All interactions are delegated: the pushed markup carries data attributes
// instead of live event listeners.
bodyEl.addEventListener("click", (e) => {
  const link = e.target.closest(".suggest-link");
  if (link && link.dataset.url) {
    window.lyknPanel.cmd("url", link.dataset.url);
    return;
  }
  if (e.target.closest(".watch-install-btn")) {
    window.lyknPanel.cmd("install");
    return;
  }
  const chip = e.target.closest(".suggest-chip");
  if (chip) {
    const text = (chip.querySelector("span")?.textContent || "").trim();
    if (text) window.lyknPanel.cmd("ask", text);
  }
});
