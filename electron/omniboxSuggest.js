"use strict";

/**
 * Omnibox suggestion engine shared by the browser chrome (agent-stage.js)
 * and the new-tab page (agent-browser-home.html), so both search boxes pull
 * up the same dropdown. Pure functions only — callers supply tabs/history.
 * Exposed as window.lyknOmniboxSuggest (plain script, no bundler).
 */
(function () {
  const COMMON_SITES = [
    { name: "Google", url: "https://www.google.com/" },
    { name: "YouTube", url: "https://www.youtube.com/" },
    { name: "Gmail", url: "https://mail.google.com/" },
    { name: "Google Docs", url: "https://docs.google.com/" },
    { name: "Google Drive", url: "https://drive.google.com/" },
    { name: "Wikipedia", url: "https://www.wikipedia.org/" },
    { name: "GitHub", url: "https://github.com/" },
    { name: "X", url: "https://x.com/" },
    { name: "Reddit", url: "https://www.reddit.com/" },
    { name: "LinkedIn", url: "https://www.linkedin.com/" },
  ];

  function hostLabel(url) {
    try {
      return new URL(url).hostname.replace(/^www\./i, "");
    } catch {
      return "";
    }
  }

  /** Product icons for Google hosts — S2 returns the same "G" for every *.google.com. */
  const BRAND_ICON_BY_HOST = {
    "mail.google.com":
      "https://www.gstatic.com/images/branding/product/2x/gmail_2020q4_48dp.png",
    "calendar.google.com":
      "https://www.gstatic.com/images/branding/product/2x/calendar_2020q4_48dp.png",
    "drive.google.com":
      "https://www.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png",
    "docs.google.com":
      "https://www.gstatic.com/images/branding/product/2x/docs_2020q4_48dp.png",
    "sheets.google.com":
      "https://www.gstatic.com/images/branding/product/2x/sheets_2020q4_48dp.png",
    "slides.google.com":
      "https://www.gstatic.com/images/branding/product/2x/slides_2020q4_48dp.png",
    "keep.google.com":
      "https://www.gstatic.com/images/branding/product/2x/keep_2020q4_48dp.png",
    "youtube.com":
      "https://www.gstatic.com/images/branding/product/2x/youtube_48dp.png",
    "music.youtube.com":
      "https://www.gstatic.com/images/branding/product/2x/youtube_music_2020q4_48dp.png",
  };

  function brandIconFor(url) {
    const u = String(url || "");
    const host = hostLabel(u);
    if (!host) return "";
    if (host === "docs.google.com") {
      if (u.includes("/document/")) return BRAND_ICON_BY_HOST["docs.google.com"];
      if (u.includes("/spreadsheets/")) return BRAND_ICON_BY_HOST["sheets.google.com"];
      if (u.includes("/presentation/")) return BRAND_ICON_BY_HOST["slides.google.com"];
    }
    if (host === "google.com" && u.includes("/calendar/")) {
      return BRAND_ICON_BY_HOST["calendar.google.com"];
    }
    return BRAND_ICON_BY_HOST[host] || "";
  }

  function faviconUrlFor(url, explicit) {
    // Brand icons win over page/S2 favicons — otherwise Gmail/Docs/Drive all show the Google G.
    const brand = brandIconFor(url);
    if (brand) return brand;
    if (typeof explicit === "string" && explicit) return explicit;
    const host = hostLabel(url);
    if (!host) return "";
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
  }

  /** Bare brand/host token? e.g. "nike" — not a search phrase, not already a URL. */
  function isDomainTyped(query) {
    const q = String(query || "").trim();
    if (!q || /\s/.test(q)) return false;
    if (/^https?:\/\//i.test(q)) return false;
    // "nike", "nike.", "nike.c", "nike.com", "nike.com/shoes"
    return /^[a-z0-9][a-z0-9.-]*$/i.test(q);
  }

  function stripUrlDecor(url) {
    return String(url || "")
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .replace(/\/$/, "");
  }

  /**
   * Google-style inline completion target for what the user typed.
   * Prefers a known host/path from history; otherwise guesses `{token}.com`.
   */
  function bestLinkCompletion(query, candidates) {
    const raw = String(query || "");
    const q = raw.trim();
    if (!q || !isDomainTyped(q)) return null;
    const ql = q.toLowerCase();

    // 1) Known links whose host/path starts with the typed prefix.
    let best = null;
    for (const it of candidates || []) {
      const completes = [it.complete, stripUrlDecor(it.url), hostLabel(it.url)].filter(Boolean);
      for (const c of completes) {
        const cl = String(c).toLowerCase();
        if (!cl.startsWith(ql) || cl.length <= ql.length) continue;
        const score = cl.length + (it.kind === "Recent" ? 0 : 2);
        if (!best || score < best.score) {
          best = {
            score,
            complete: q + String(c).slice(q.length),
            url: it.url || `https://${String(c).replace(/^www\./i, "")}`,
            name: it.name || hostLabel(it.url) || c,
            kind: it.kind || "Link",
          };
        }
      }
    }
    if (best) {
      return {
        name: best.name,
        url: /^https?:\/\//i.test(best.url) ? best.url : `https://${best.url}`,
        kind: best.kind,
        complete: best.complete,
      };
    }

    // 2) No history hit — guess the .com (Chrome does this constantly).
    if (/^[a-z0-9-]+$/i.test(q)) {
      const host = `${q}.com`;
      return {
        name: host,
        url: `https://${host.toLowerCase().replace(/^www\./, "")}/`,
        kind: "Link",
        complete: `${q}.com`,
      };
    }
    // Typed "nike." / "nike.c" → finish ".com"
    const m = q.match(/^([a-z0-9-]+)\.(com?)?$/i);
    if (m && (!m[2] || m[2].toLowerCase() !== "com")) {
      const base = m[1];
      return {
        name: `${base}.com`,
        url: `https://${base.toLowerCase()}.com/`,
        kind: "Link",
        complete: `${base}.com`,
      };
    }
    return null;
  }

  /**
   * Build the dropdown for a query. Sources, in rank order: open tabs,
   * history (visits + closed tabs), common sites, then a Google search row.
   */
  function buildUrlSuggestions(query, { tabs = [], history = [] } = {}) {
    const raw = String(query || "");
    const q = raw.trim().toLowerCase();
    const out = [];
    const seen = new Set();
    const push = (item) => {
      const url = String(item.url || "").trim();
      if (!url || !/^https?:\/\//i.test(url)) return;
      const key = url.replace(/\/$/, "").toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const host = hostLabel(url);
      out.push({
        name: item.name || item.title || host || url,
        url,
        kind: item.kind || "Link",
        // Prefer bare host for inline fill ("nike" → "nike.com")
        complete: item.complete || host || stripUrlDecor(url),
        favicon: item.favicon || "",
      });
    };

    for (const t of tabs) {
      if (t.url) {
        push({
          name: t.pageTitle || t.title || hostLabel(t.url),
          url: t.url,
          kind: "Tab",
          favicon: t.favicon || "",
        });
      }
    }
    for (const h of history) {
      if (h.url) {
        push({
          name: h.pageTitle || h.title || hostLabel(h.url),
          url: h.url,
          kind: "Recent",
          favicon: h.favicon || "",
        });
      }
    }
    for (const c of COMMON_SITES) {
      push({
        name: c.name,
        url: c.url,
        kind: "Popular",
        complete: hostLabel(c.url) || stripUrlDecor(c.url),
      });
    }

    if (!q) return out.slice(0, 8);

    const filtered = out.filter((it) => {
      const host = hostLabel(it.url).toLowerCase();
      const hay = `${it.name} ${it.url} ${it.complete} ${host}`.toLowerCase();
      return (
        host.startsWith(q) ||
        String(it.complete || "").toLowerCase().startsWith(q) ||
        hay.includes(q)
      );
    });

    // Prefer link completions in the list (e.g. nike → nike.com).
    const linkGuess = bestLinkCompletion(raw, out);
    if (linkGuess) {
      const key = linkGuess.url.replace(/\/$/, "").toLowerCase();
      if (!seen.has(key)) {
        filtered.unshift(linkGuess);
        seen.add(key);
      } else {
        const idx = filtered.findIndex(
          (it) => it.url.replace(/\/$/, "").toLowerCase() === key,
        );
        if (idx > 0) {
          const [hit] = filtered.splice(idx, 1);
          hit.complete = linkGuess.complete;
          filtered.unshift(hit);
        } else if (idx === 0) {
          filtered[0].complete = linkGuess.complete;
        }
      }
    }

    // Search row after link guesses.
    if (q && !/^[a-z0-9.-]+\.[a-z]{2,}/i.test(q) && !/^https?:\/\//i.test(q)) {
      filtered.push({
        name: `Search Google for “${raw.trim()}”`,
        url: `https://www.google.com/search?q=${encodeURIComponent(raw.trim())}`,
        kind: "Search",
        complete: raw.trim(),
      });
    }
    return filtered.slice(0, 8);
  }

  window.lyknOmniboxSuggest = {
    COMMON_SITES,
    hostLabel,
    brandIconFor,
    faviconUrlFor,
    isDomainTyped,
    stripUrlDecor,
    bestLinkCompletion,
    buildUrlSuggestions,
  };
})();
