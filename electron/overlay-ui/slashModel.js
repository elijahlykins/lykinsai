import { replaceSlashPathToken } from "./slashPathQuery.js";
import { findSlashModelToken, modelLabLogoUrl, rankSlashModelOptions } from "./slashModelQuery.js";
import { overlayModelOptions } from "./slashModelCatalog.js";

const CHAT_KEY = "lykn_overlay_model";
const IMAGE_KEY = "lykn_overlay_imagine_model";

function storageKey(mode) {
  return mode === "image" ? IMAGE_KEY : CHAT_KEY;
}

function readStored(mode) {
  try {
    const raw = String(localStorage.getItem(storageKey(mode)) || "").trim();
    if (raw) return raw;
  } catch {
    /* private mode */
  }
  return mode === "image" ? "auto" : "lykn";
}

function writeStored(mode, value) {
  try {
    localStorage.setItem(storageKey(mode), value);
  } catch {
    /* private mode */
  }
}

export function attachSlashModel(host) {
  const askEl = host.askEl;
  const menuEl = document.getElementById("slash-model-menu");
  if (!askEl || !menuEl) {
    return {
      handleKeyDown: () => false,
      close: () => false,
      isOpen: () => false,
      selectedModel: () => "lykn",
    };
  }

  let items = [];
  let index = 0;
  let token = null;
  let open = false;

  function composerMode() {
    return host.getComposerMode?.() || "chat";
  }

  function selectedModel() {
    const id = readStored(composerMode());
    return id === "auto" ? "lykn" : id;
  }

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
      empty.textContent = menuEl.dataset.hint || "Type to search models";
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
      const logoUrl = modelLabLogoUrl(item);
      if (logoUrl) {
        const img = document.createElement("img");
        img.src = logoUrl;
        img.alt = "";
        img.width = 14;
        img.height = 14;
        ico.appendChild(img);
      } else {
        ico.textContent = "L";
      }
      const label = document.createElement("span");
      label.className = "slash-path-label";
      const name = document.createElement("span");
      name.className = "slash-path-name";
      name.textContent = item.label;
      label.appendChild(name);
      const subText = [item.hint, item.group].filter(Boolean).join(" · ");
      if (subText) {
        const sub = document.createElement("span");
        sub.className = "slash-path-sub";
        sub.textContent = subText;
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
    items = rankSlashModelOptions(overlayModelOptions(composerMode()), query);
    if (items.length) index = Math.min(index, items.length - 1);
    else index = 0;
    open = true;
    menuEl.dataset.hint = items.length ? "" : "No matching models.";
    render();
  }

  function onInput() {
    const next = findSlashModelToken(askEl.value, askEl.selectionStart ?? askEl.value.length);
    if (!next) {
      close();
      return;
    }
    token = next;
    showQuery(next.kind === "picker" ? "" : next.query);
  }

  function pick(item) {
    if (!token || !item) return;
    writeStored(composerMode(), item.value);
    const next = replaceSlashPathToken(askEl.value, token, "");
    askEl.value = next;
    askEl.setSelectionRange(Math.min(token.start, next.length), Math.min(token.start, next.length));
    host.autoGrowAsk?.();
    close();
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

  askEl.addEventListener("input", onInput);
  askEl.addEventListener("click", onInput);
  document.addEventListener("pointerdown", (event) => {
    if (!open) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (askEl.contains(target) || menuEl.contains(target)) return;
    close();
  });

  return { handleKeyDown, close, isOpen, selectedModel };
}
