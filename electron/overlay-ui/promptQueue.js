const MAX_QUEUED = 20;

function newId() {
  return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function previewText(item) {
  const text = String(item?.q || "").trim();
  if (text) return text.length > 48 ? `${text.slice(0, 47)}…` : text;
  const n = Array.isArray(item?.attachments) ? item.attachments.length : 0;
  if (n === 1) return item.attachments[0]?.name || "1 attachment";
  if (n > 1) return `${n} attachments`;
  return "Queued prompt";
}

export function attachPromptQueue(host) {
  const el = document.getElementById("prompt-queue");
  const items = [];

  function render() {
    if (!el) return;
    el.innerHTML = "";
    if (!items.length) {
      el.hidden = true;
      host.reportHeight?.();
      return;
    }
    el.hidden = false;
    const label = document.createElement("span");
    label.className = "prompt-queue-label";
    label.textContent = "Up next";
    el.appendChild(label);
    const row = document.createElement("div");
    row.className = "prompt-queue-row";
    items.forEach((item, index) => {
      const chip = document.createElement("span");
      chip.className = "prompt-queue-chip";
      chip.title = String(item.q || previewText(item));
      const text = document.createElement("span");
      text.textContent = `${index + 1}. ${previewText(item)}`;
      chip.appendChild(text);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "prompt-queue-x";
      btn.title = "Remove from queue";
      btn.setAttribute("aria-label", `Remove queued prompt: ${previewText(item)}`);
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>';
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const i = items.findIndex((it) => it.id === item.id);
        if (i >= 0) items.splice(i, 1);
        render();
      });
      chip.appendChild(btn);
      row.appendChild(chip);
    });
    el.appendChild(row);
    if (items.length > 1) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "prompt-queue-clear";
      clear.textContent = "Clear";
      clear.addEventListener("click", (e) => {
        e.preventDefault();
        items.length = 0;
        render();
      });
      el.appendChild(clear);
    }
    host.reportHeight?.();
  }

  function enqueue(item) {
    const q = String(item?.q || "").trim();
    const attachments = Array.isArray(item?.attachments) ? item.attachments.slice() : [];
    if (!q && !attachments.length) return false;
    if (items.length >= MAX_QUEUED) return false;
    const last = items[items.length - 1];
    if (last && last.q === q && last.attachments.length === attachments.length) return true;
    items.push({
      id: newId(),
      q,
      attachments,
      askOpts: item.askOpts || undefined,
      agent: !!item.agent,
      label: item.label || q || (attachments.length ? `Sent ${attachments.length} attachment(s)` : ""),
      buildAsk: !!item.buildAsk,
    });
    render();
    return true;
  }

  function takeNext() {
    if (!items.length) return null;
    const next = items.shift();
    render();
    return next;
  }

  function drain() {
    if (host.busy) return;
    const next = takeNext();
    if (!next) return;
    host.submitQueued?.(next);
  }

  return { enqueue, takeNext, drain, render, get length() { return items.length; } };
}
