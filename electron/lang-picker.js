// Detached language picker — lists languages, reports pick back to overlay.

if (window.lyknLangPicker?.platform && window.lyknLangPicker.platform !== "darwin") {
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
  window.lyknLangPicker.resize(Math.min(180, optionsEl.scrollHeight + 10));
}

function render(state) {
  optionsEl.innerHTML = "";
  const langs = (state && state.languages) || [];
  const active = (state && state.active) || "";
  for (const lang of langs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lang-item" + (lang === active ? " active" : "");
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", lang === active ? "true" : "false");
    btn.textContent = lang;
    btn.addEventListener("click", () => {
      window.lyknLangPicker.select(lang);
      window.lyknLangPicker.close();
    });
    optionsEl.appendChild(btn);
  }
  reportSize();
}

async function refresh() {
  let state = null;
  try {
    state = await window.lyknLangPicker.getState();
  } catch (_) {}
  render(state || {});
}

window.lyknLangPicker.onShown(() => void refresh());
void refresh();
