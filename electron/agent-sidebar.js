if (window.lyknAgentSidebar?.platform && window.lyknAgentSidebar.platform !== "darwin") {
  document.documentElement.classList.add("no-vibrancy");
}

const listEl = document.getElementById("list");
const newChatBtn = document.getElementById("new-chat-btn");
const newBtn = document.getElementById("new-btn");
const closeBtn = document.getElementById("close");

let state = { agents: [], activeAgentId: null };

function escapeHtml(s) {
  return String(s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

// Browser-window marks for worker agents (not the LYKN app icon).
const ICON_BROWSER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18"/><circle cx="6.2" cy="6.75" r="0.7" fill="currentColor" stroke="none"/><circle cx="8.6" cy="6.75" r="0.7" fill="currentColor" stroke="none"/><circle cx="11" cy="6.75" r="0.7" fill="currentColor" stroke="none"/></svg>`;
const ICON_BROWSER_RUN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18"/><circle cx="6.2" cy="6.75" r="0.7" fill="currentColor" stroke="none"/><circle cx="8.6" cy="6.75" r="0.7" fill="currentColor" stroke="none"/><circle cx="11" cy="6.75" r="0.7" fill="currentColor" stroke="none"/><path d="M12 12.2v3.2l2.2 1.3"/></svg>`;
const ICON_BROWSER_ERR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18"/><circle cx="6.2" cy="6.75" r="0.7" fill="currentColor" stroke="none"/><circle cx="8.6" cy="6.75" r="0.7" fill="currentColor" stroke="none"/><circle cx="11" cy="6.75" r="0.7" fill="currentColor" stroke="none"/><path d="M12 12.2v2.6M12 17.2h.01"/></svg>`;
const ICON_MAIN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 19 8v8l-7 4.5L5 16V8l7-4.5Z"/><path d="M12 12v8.5M12 12 19 8M12 12 5 8"/></svg>`;

function statusClass(status) {
  if (status === "running") return "running";
  if (status === "error") return "error";
  return "";
}

function statusIcon(status, isMain) {
  if (isMain) return ICON_MAIN;
  if (status === "running") return ICON_BROWSER_RUN;
  if (status === "error") return ICON_BROWSER_ERR;
  return ICON_BROWSER;
}

function formatSub(a) {
  if (a.role === "main" || a.pinned) {
    const step = String(a.step || "orchestrator").trim();
    return `<span class="hi">main</span> · ${escapeHtml(step)}`;
  }
  const skill = String(a.skill || "").trim();
  const step = String(a.step || a.status || "idle").trim();
  const parts = [];
  if (skill) parts.push(`<span class="hi">${escapeHtml(skill)}</span>`);
  if (step && step !== skill) parts.push(escapeHtml(step));
  return parts.join(" · ") || "idle";
}

function render() {
  const agents = Array.isArray(state.agents) ? state.agents : [];
  if (!agents.length) {
    listEl.innerHTML =
      '<div class="empty">No agents yet.<br/>Click + New or send a goal from Glass.</div>';
    return;
  }
  listEl.innerHTML = agents
    .map((a) => {
      const active = a.id === state.activeAgentId ? " active" : "";
      const st = statusClass(a.status);
      const isMain = a.role === "main" || a.pinned;
      const closeBtn = isMain
        ? ""
        : `<button type="button" class="x" data-act="close" title="Delete agent" aria-label="Delete agent">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>`;
      return `<div class="agent${active}${st ? ` ${st}` : ""}${isMain ? " main" : ""}" data-id="${escapeHtml(a.id)}">
        <span class="icon" aria-hidden="true">${statusIcon(a.status, isMain)}</span>
        <div class="meta">
          <div class="name">${escapeHtml(a.title || "Agent")}</div>
          <div class="sub">${formatSub(a)}</div>
        </div>
        ${isMain ? `<span class="pin" title="Pinned orchestrator">pin</span>` : ""}
        ${closeBtn}
      </div>`;
    })
    .join("");
}

listEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  const row = e.target.closest(".agent");
  if (!row) return;
  const id = row.getAttribute("data-id");
  if (btn) {
    e.stopPropagation();
    if (btn.getAttribute("data-act") === "close") void window.lyknAgentSidebar.close(id);
    return;
  }
  void window.lyknAgentSidebar.switch(id);
});

newChatBtn.addEventListener("click", () => {
  // No Main orchestrator anymore — "new chat" is just a fresh agent + tab.
  void window.lyknAgentSidebar.create({ title: "New agent" });
});
newBtn.addEventListener("click", () => {
  void window.lyknAgentSidebar.create({ title: "New agent" });
});
closeBtn.addEventListener("click", () => window.lyknAgentSidebar.hide());

window.lyknAgentSidebar.onList((p) => {
  state = {
    agents: Array.isArray(p.agents) ? p.agents : [],
    activeAgentId: p.activeAgentId || null,
  };
  render();
});

window.lyknAgentSidebar.onProgress((p) => {
  if (!p?.agentId) return;
  const idx = state.agents.findIndex((a) => a.id === p.agentId);
  if (idx >= 0) {
    state.agents[idx] = { ...state.agents[idx], ...p };
    render();
  }
});

void window.lyknAgentSidebar.list().then((p) => {
  if (p) {
    state = {
      agents: Array.isArray(p.agents) ? p.agents : [],
      activeAgentId: p.activeAgentId || null,
    };
    render();
  }
});
