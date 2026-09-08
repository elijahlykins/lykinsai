import { replaceSlashPathToken } from "./slashPathQuery.js";
import {
  findSlashAppToken,
  mergeSlashAppOptions,
  rankSlashAppOptions,
  slashAppFromMac,
  slashAppFromManaged,
  slashAppFromMcp,
} from "./slashAppQuery.js";

export function attachSlashApp(host) {
  const askEl = host.askEl;
  const menuEl = document.getElementById("slash-app-menu");
  if (!askEl || !menuEl) {
    return {
      handleKeyDown: () => false,
      close: () => false,
      isOpen: () => false,
    };
  }

  let items = [];
  let index = 0;
  let token = null;
  let open = false;
  let catalog = [];
  let loading = false;

  function isOpen() {
    return open;
  }

  function close() {
    open = false;
    token = null;
    items = [];
    index = 0;
    menuEl.hidden = true;
    menuEl.innerHTML = "";
    host.reportHeight?.();
    return true;
  }

  function paintActive() {
    const rows = menuEl.querySelectorAll(".slash-path-row");
    rows.forEach((row, i) => {
      const on = i === index;
      row.classList.toggle("active", on);
      row.setAttribute("aria-selected", on ? "true" : "false");
      if (on) row.scrollIntoView({ block: "nearest" });
    });
  }

  function render() {
    menuEl.innerHTML = "";
    if (!open) {
      menuEl.hidden = true;
      host.reportHeight?.();
      return;
    }
    menuEl.hidden = false;
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "slash-path-hint";
      empty.textContent = menuEl.dataset.hint || "Type /gmail or /spotify";
      menuEl.appendChild(empty);
      host.reportHeight?.();
      return;
    }
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "slash-path-row" + (i === index ? " active" : "");
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", i === index ? "true" : "false");
      const ico = document.createElement("span");
      ico.className = "slash-path-ico";
      if (item.logoUrl) {
        const img = document.createElement("img");
        img.src = item.logoUrl;
        img.alt = "";
        img.width = 14;
        img.height = 14;
        ico.appendChild(img);
      } else {
        ico.textContent = item.source === "mac" ? "⌘" : "◈";
      }
      const label = document.createElement("span");
      label.className = "slash-path-label";
      const name = document.createElement("span");
      name.className = "slash-path-name";
      name.textContent = item.name;
      label.appendChild(name);
      if (item.subtitle) {
        const sub = document.createElement("span");
        sub.className = "slash-path-sub";
        sub.textContent = item.subtitle;
        label.appendChild(sub);
      }
      btn.appendChild(ico);
      btn.appendChild(label);
      btn.addEventListener("mouseenter", () => {
        index = i;
        paintActive();
      });
      btn.addEventListener("mousedown", (event) => event.preventDefault());
      btn.addEventListener("click", () => pick(item));
      menuEl.appendChild(btn);
    }
    host.reportHeight?.();
    const active = menuEl.querySelector(".slash-path-row.active");
    if (active instanceof HTMLElement) active.scrollIntoView({ block: "nearest" });
  }

  function showQuery(query) {
    items = rankSlashAppOptions(catalog, query);
    if (items.length) index = Math.min(index, items.length - 1);
    else index = 0;
    open = true;
    menuEl.dataset.hint = items.length
      ? ""
      : catalog.length
        ? "No matching apps."
        : "Connect an app in Settings, or pick a Mac app with /app.";
    render();
  }

  async function ensureCatalog() {
    if (catalog.length || loading) return;
    const overlay = typeof window !== "undefined" ? window.lyknOverlay : null;
    if (!overlay) return;
    loading = true;
    try {
      const [mac, remote] = await Promise.all([
        typeof overlay.macAppsList === "function"
          ? overlay.macAppsList().catch(() => ({ apps: [] }))
          : { apps: [] },
        typeof overlay.connectedApps === "function"
          ? overlay.connectedApps().catch(() => ({ connections: [], managed: [] }))
          : { connections: [], managed: [] },
      ]);
      catalog = mergeSlashAppOptions(
        (remote.connections || []).map(slashAppFromMcp).filter(Boolean),
        (remote.managed || []).map(slashAppFromManaged).filter(Boolean),
        (mac.apps || []).map(slashAppFromMac).filter(Boolean),
      );
    } catch {
      catalog = [];
    } finally {
      loading = false;
    }
  }

  async function onInput() {
    const next = findSlashAppToken(askEl.value, askEl.selectionStart ?? askEl.value.length);
    if (!next) {
      close();
      return;
    }
    token = next;
    open = true;
    if (!catalog.length) {
      menuEl.hidden = false;
      menuEl.dataset.hint = "Looking up apps…";
      items = [];
      render();
      await ensureCatalog();
      if (!token) return;
    }
    showQuery(next.query);
  }

  function pick(item) {
    if (!token || !item) return;
    const next = replaceSlashPathToken(askEl.value, token, "");
    askEl.value = next;
    askEl.setSelectionRange(Math.min(token.start, next.length), Math.min(token.start, next.length));
    host.autoGrowAsk?.();
    close();
    host.addAttachmentObjects?.([
      {
        kind: "app",
        name: item.name,
        source: item.source,
        appId: item.id,
        path: item.path || "",
        catalogId: item.catalogId || "",
        logoUrl: item.source === "connected" ? item.logoUrl || "" : "",
      },
    ]);
    askEl.focus();
  }

  function handleKeyDown(event) {
    if (!open) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return true;
    }
    if (event.key === "ArrowDown") {
      if (!items.length) return false;
      event.preventDefault();
      index = (index + 1) % items.length;
      paintActive();
      return true;
    }
    if (event.key === "ArrowUp") {
      if (!items.length) return false;
      event.preventDefault();
      index = (index - 1 + items.length) % items.length;
      paintActive();
      return true;
    }
    if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
      const item = items[index];
      if (!item) return false;
      event.preventDefault();
      pick(item);
      return true;
    }
    return false;
  }

  askEl.addEventListener("input", () => void onInput());
  askEl.addEventListener("click", () => void onInput());
  document.addEventListener("pointerdown", (event) => {
    if (!open) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (askEl.contains(target) || menuEl.contains(target)) return;
    close();
  });

  return { handleKeyDown, close, isOpen };
}
