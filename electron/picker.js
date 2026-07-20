// Renderer for the detached side-panel picker window. A thin remote control:
// the overlay renderer owns the side-panel views and their counts; this page
// only renders the option list and forwards the pick.

if (window.lyknPicker?.platform && window.lyknPicker.platform !== "darwin") {
  document.documentElement.classList.add("no-vibrancy");
}

const optionsEl = document.getElementById("options");

function escapeHtml(s) {
  return String(s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function reportSize() {
  // Card padding (6 top + 6 bottom) + 2px border around the content.
  window.lyknPicker.resize(optionsEl.scrollHeight + 14);
}

function renderOptions(state) {
  optionsEl.innerHTML = "";
  const options = (state && state.options) || [];
  const active = state ? state.active : "";
  for (const opt of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "picker-item" +
      (opt.id === active ? " active" : "") +
      (opt.id && !opt.count ? " empty" : "");
    btn.setAttribute("role", "option");
    btn.innerHTML =
      `<span>${escapeHtml(opt.label)}</span>` +
      (opt.id && opt.id !== "all" ? `<span class="count">${opt.count || "—"}</span>` : "");
    btn.addEventListener("click", () => {
      window.lyknPicker.select(opt.id);
      window.lyknPicker.close();
    });
    optionsEl.appendChild(btn);
  }
  reportSize();
}

async function refresh() {
  let state = null;
  try {
    state = await window.lyknPicker.getState();
  } catch (_) {}
  renderOptions(state);
}

// Every time main shows the window, re-pull fresh options/counts so the card
// never reopens with stale badges.
window.lyknPicker.onShown(() => void refresh());

void refresh();
