// Compact "N sources" pill under a Glass answer. Clicking opens the
// existing Sources side-panel slot with that turn's citation list.

function faviconUrl(url) {
  try {
    const host = new URL(String(url || "")).hostname;
    if (!host) return "";
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  } catch {
    return "";
  }
}

function uniqueHostSources(sources, limit = 3) {
  const seen = new Set();
  const out = [];
  for (const src of sources || []) {
    let host = "";
    try {
      host = new URL(src.url).hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
      continue;
    }
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(src);
    if (out.length >= limit) break;
  }
  return out;
}

export function attachSourcesPill(host) {
  function openSourcesSlot(list) {
    const links = host.mergeSourceLinks ? host.mergeSourceLinks(list, []) : list;
    host.researchSources = links;
    host.sideContext = {
      pageSource:
        (host.currentPageSource && host.currentPageSource.url && host.currentPageSource) ||
        (host.sideContext && host.sideContext.pageSource) ||
        null,
      links,
      followups: (host.sideContext && host.sideContext.followups) || [],
    };
    host.syncSidePickerState?.();
    host.setSidePanelView?.("sources");
  }

  function renderAnswerSourcesPill(answerEl, sources) {
    const el = answerEl || host.currentAnswerEl;
    if (!el) return;
    const list = (sources || []).filter((s) => s && s.url);
    let pill = el.querySelector(":scope > .chat-sources-pill");
    if (!list.length) {
      if (pill) pill.remove();
      host.reportHeight?.();
      return;
    }
    if (!pill) {
      pill = document.createElement("button");
      pill.type = "button";
      pill.className = "chat-sources-pill";
      const actions = el.querySelector(":scope > .chat-a-actions");
      if (actions) el.insertBefore(pill, actions);
      else el.appendChild(pill);
      pill.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        let parsed = [];
        try {
          parsed = JSON.parse(pill.dataset.sources || "[]");
        } catch {
          parsed = [];
        }
        openSourcesSlot(Array.isArray(parsed) ? parsed : []);
      });
    }
    pill.dataset.sources = JSON.stringify(list.slice(0, 40));
    const n = list.length;
    const icons = uniqueHostSources(list, 3);
    const faces = icons
      .map((s, i) => {
        const src = faviconUrl(s.url);
        if (!src) return "";
        return `<img src="${src}" alt="" style="z-index:${icons.length - i}">`;
      })
      .join("");
    pill.innerHTML =
      `<span class="chat-sources-favicons">${faces}</span>` +
      `<span class="chat-sources-count">${n} source${n === 1 ? "" : "s"}</span>`;
    pill.hidden = false;
    host.reportHeight?.();
  }

  return { renderAnswerSourcesPill, openSourcesSlot };
}
