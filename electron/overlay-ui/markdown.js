// Overlay Markdown → HTML. Model output is escaped first; only a small
// set of block/inline tags is rebuilt. Untrusted content never becomes script.

export const SPINNER_PATH =
  "M167.39,60.26l-.86-.39c-9.83-4.41-17.7-12.28-22.12-22.12l-.39-.86c-1.77-3.94-7.36-3.94-9.13,0l-.39.86c-4.41,9.83-12.28,17.71-22.12,22.12l-.86.39c-3.94,1.77-3.94,7.36,0,9.13l.86.39c9.83,4.41,17.7,12.28,22.12,22.12l.39.86c1.77,3.94,7.36,3.94,9.13,0l.39-.86c4.41-9.83,12.28-17.7,22.12-22.12l.86-.39c3.94-1.77,3.94-7.36,0-9.13ZM134.87,116.05c-14.73,2.8-17.97,18.72-32.73,18.72-8.11,0-12.75-4.81-17.72-9.61-1.8-1.73-3.56-3.5-5.29-5.29-4.8-4.98-9.62-9.61-9.62-17.73,0-14.76,15.93-18,18.72-32.73,2.66-14.03-7.74-27.55-21.99-28.38-13.8-.8-25.24,10.16-25.24,23.79,0,18.8,19.14,21.14,19.14,37.32s-19.14,18.52-19.14,37.32c0,13.16,10.67,23.83,23.83,23.83,18.8,0,21.14-19.14,37.32-19.14s18.52,19.14,37.32,19.14c13.63,0,24.58-11.44,23.78-25.24-.82-14.25-14.35-24.66-28.38-21.99Z";

// ── Minimal, safe Markdown → HTML for answers ──────────────────────────────
// The model replies in Markdown (## headers, **bold**, - bullets, 1. lists,
// `code`). We escape first so model output can't inject HTML, then build a small
// set of block/inline elements. Good enough for chat answers without a library.
export function escapeHtml(s) {
  // Escape quotes too — this output is also interpolated into an href="…"
  // attribute by renderInline, so an unescaped quote could break out of the
  // attribute. Belt-and-suspenders alongside the http(s)-only link regex.
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Encode a URL for use inside a double-quoted HTML attribute. */
export function escapeAttr(s) {
  return escapeHtml(s);
}

/** Undo escapeHtml so media URLs with &query= params stay valid in src/href. */
export function unescapeHtml(s) {
  return String(s || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Only allow https artifact/image hosts we mint, plus chart/diagram previews. */
export function isAllowedMediaUrl(url) {
  try {
    const u = new URL(unescapeHtml(String(url || "")));
    // Vault HTML served from Electron main memory (dev-safe artifact preview).
    if (u.protocol === "lykn-artifact:") return true;
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    // Dev: localhost API file proxy.
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;
    const host = u.hostname.toLowerCase();
    return (
      host === "artifacts.lykn.io" ||
      host === "api.lykn.io" ||
      host === "lykn-ideation.onrender.com" ||
      host.endsWith(".supabase.co") ||
      host === "lykn.io" ||
      host === "www.lykn.io" ||
      // Standalone chart / diagram tools (not Build mode).
      host === "quickchart.io" ||
      host === "www.quickchart.io" ||
      host === "kroki.io" ||
      host.endsWith(".kroki.io")
    );
  } catch {
    return false;
  }
}

export function renderInline(s) {
  return s
    .replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    // Only http(s) links, no whitespace/quotes in the URL (the &quot;/&#39;
    // entities from escapeHtml contain no raw quote, and \s already excludes
    // spaces), and force them through the external browser with rel guards.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"']+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>')
    // Bare https URLs (agent finish messages often dump the Docs/Sheets link).
    .replace(
      /(^|[\s(>])(https?:\/\/[^\s<)"']+)/g,
      '$1<a href="$2" rel="noopener noreferrer">$2</a>',
    );
}

/**
 * Which agent steps the user has opened, keyed "<agentId>/<index>".
 * The transcript is re-rendered from scratch on every delta, so without this a
 * step's reasoning snapped shut the instant the next step arrived — which is
 * exactly when someone is reading it.
 */
export const expandedAgentSteps = new Set();

/** Reasoning arrives as one line of " · "-joined parts; show them as lines. */
export function splitStepDetail(detail) {
  return String(detail || "")
    .split("·")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function renderMarkdown(md) {
  const lines = escapeHtml(md).split("\n");
  let html = "";
  let listType = null;
  let para = [];
  const closeList = () => {
    if (listType) {
      html += `</${listType}>`;
      listType = null;
    }
  };
  const flushPara = () => {
    if (para.length) {
      html += `<p>${renderInline(para.join(" "))}</p>`;
      para = [];
    }
  };
  const stepMarkerRe =
    /^!\[([^\]]*)\]\((https?:\/\/[^\s)]+|lykn-vault:\/\/[^\s)]+|lykn-artifact:\/\/[^\s)]+|lykn-agent-step:\/\/[^\s)]+)(?:\s+(?:&quot;|")(.+?)(?:&quot;|"))?\)$/;
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    // Standalone image / card line — generated images, artifacts, videos,
    // and Vault pull-ups (lykn_vault: → Open card in Glass).
    // Lines are escapeHtml'd first, so optional title attrs use &quot; not ".
    let m = stepMarkerRe.exec(line.trim());
    if (m) {
      flushPara();
      closeList();
      // Lines are escapeHtml'd above — decode before URL checks / src attrs
      // so query strings (&w=, signed tokens, QuickChart c=) stay intact.
      const altText = unescapeHtml(m[1]);
      const mediaUrl = unescapeHtml(m[2]);
      const previewText = m[3] ? unescapeHtml(m[3]) : "";
      const altLower = altText.toLowerCase();
      // Accept lykn_artifact:, lykn-artifact:, LYKN-artifact:, etc.
      const isArtifact = /^lykn[-_]artifact\s*:/.test(altLower);
      const isVideo = /^lykn[-_]video\s*:/.test(altLower);
      const isStep = /^lykn[-_]step\s*:/.test(altLower) || /^lykn-agent-step:\/\//i.test(mediaUrl);
      const isVault = /^lykn[-_]vault\s*:/.test(altLower) || /^lykn-vault:\/\//i.test(mediaUrl);
      if (isStep) {
        let stepKind = "text";
        let stepTitle = altText.replace(/^lykn[-_]step\s*:/i, "").trim() || "Step";
        const kindTitle = altText.match(/^lykn[-_]step\s*:([^:]+):(.+)$/i);
        if (kindTitle) {
          stepKind = (kindTitle[1] || "text").trim();
          stepTitle = (kindTitle[2] || stepTitle).trim();
        }
        let stepAgentId = "";
        let stepIndex = "";
        const stepMatch = /^lykn-agent-step:\/\/([^/]+)\/(\d+)(?:\/(live|pending|done))?/i.exec(
          mediaUrl,
        );
        if (stepMatch) {
          stepAgentId = stepMatch[1] || "";
          stepIndex = stepMatch[2] || "";
        }
        const stepStatus = String(stepMatch?.[3] || "done").toLowerCase();
        const shortTitle = stepTitle
          .replace(/^\s*step\s+\d+\s*[—–\-·:]\s*/i, "")
          .trim() || stepTitle;
        // A step's reasoning travels in the marker's own title. Prose after the
        // marker used to be swallowed into the dropdown as the step's body, but
        // that text is now the agent narrating to the user between steps, so
        // folding it away hid the explanation rather than the detail. Kept in
        // its escaped form — this is model-written text on its way into
        // innerHTML, and renderInline does not escape what it is handed.
        const reasonLines = splitStepDetail(m[3] || "");
        const hasBody = reasonLines.length > 0;
        const icon =
          stepStatus === "live"
            ? `<svg class="md-step-spin lykn-outline-spinner" width="14" height="14" viewBox="0 0 204.29 204.29" fill="none" aria-hidden="true"><path d="${SPINNER_PATH}" pathLength="1" fill="currentColor" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" /></svg>`
            : stepStatus === "pending"
              ? `<span class="md-step-dot" aria-hidden="true"></span>`
              : `<span class="md-step-check" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg></span>`;
        // Expandable while live too: the whole point of the thinking box is
        // being able to look at what it is working through before it acts.
        const expandable = hasBody && stepStatus !== "pending";
        const titleAttr = expandable
          ? "Show what the agent was doing"
          : stepStatus === "done"
            ? "Open this step"
            : "";
        const rowInner = (tag) =>
          `<${tag} class="md-step-summary" title="${escapeAttr(titleAttr)}">` +
          icon +
          `<span class="md-step-title">${escapeHtml(shortTitle)}</span>` +
          (expandable ? `<span class="md-step-caret" aria-hidden="true">›</span>` : "") +
          `</${tag}>`;
        const attrs =
          `class="md-step md-step-${escapeAttr(stepStatus)}" data-agent-id="${escapeAttr(stepAgentId)}" data-step-index="${escapeAttr(stepIndex)}" data-kind="${escapeAttr(stepKind)}" data-status="${escapeAttr(stepStatus)}"`;
        if (expandable) {
          const stepKey = `${stepAgentId}/${stepIndex}`;
          const openAttr = expandedAgentSteps.has(stepKey) ? " open" : "";
          const body = reasonLines.map((l) => `<p>${renderInline(l)}</p>`).join("");
          const openLink =
            stepStatus === "done" && stepIndex !== ""
              ? `<button type="button" class="md-step-open">Open in the browser</button>`
              : "";
          html +=
            `<details ${attrs} data-expandable="1"${openAttr}>` +
            rowInner("summary") +
            `<div class="md-step-body">${body}${openLink}</div>` +
            `</details>`;
        } else {
          html += `<div ${attrs}>${rowInner("div")}</div>`;
        }
        continue;
      }
      if (isVault) {
        let itemId = "";
        const vaultMatch = /^lykn-vault:\/\/([^/]+)\/(.+)$/i.exec(mediaUrl);
        if (vaultMatch) {
          try {
            itemId = decodeURIComponent(vaultMatch[2]) || "";
          } catch {
            itemId = vaultMatch[2] || "";
          }
        }
        const vaultTitle =
          altText.replace(/^lykn[-_]vault\s*:/i, "").trim() || "Saved item";
        const safeTitle = escapeHtml(vaultTitle);
        const safeId = escapeAttr(itemId);
        const safePreview = previewText
          ? `<div class="md-vault-preview">${escapeHtml(previewText)}</div>`
          : "";
        const openAttrs = `data-kind="vault"${itemId ? ` data-note-id="${safeId}"` : ""}`;
        html +=
          `<div class="md-vault" ${openAttrs}>` +
          `<div class="md-vault-head"><span class="md-vault-kind">Vault</span>` +
          `<button class="md-vault-open" type="button" ${openAttrs}>Open</button></div>` +
          `<div class="md-vault-title">${safeTitle}</div>` +
          safePreview +
          `</div>`;
        continue;
      }
      if (isArtifact) {
        if (!isAllowedMediaUrl(mediaUrl)) {
          html += `<p><a href="${escapeAttr(mediaUrl)}" rel="noopener noreferrer">Open artifact ↗</a></p>`;
        } else {
        const artTitle = altText.slice(altText.indexOf(":") + 1).trim() || "Interactive artifact";
        const artFile =
          (artTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) ||
            "artifact") + ".html";
        const safeUrl = escapeAttr(mediaUrl);
        const safeTitle = escapeAttr(artTitle);
        const safeFile = escapeAttr(artFile);
        html +=
          `<div class="md-artifact">` +
          `<div class="md-artifact-head"><span>${safeTitle}</span>` +
          `<span class="md-artifact-actions">` +
          `<button class="md-edit-build" type="button" data-url="${safeUrl}" data-title="${safeTitle}">Edit</button>` +
          `<button class="md-code" type="button" data-url="${safeUrl}">Code</button>` +
          `<button class="md-dl" type="button" data-url="${safeUrl}" data-name="${safeFile}" data-title="${safeTitle}">Download</button>` +
          `<a href="${safeUrl}" rel="noopener noreferrer">Open ↗</a>` +
          `</span></div>` +
          // Host-allowlisted above; same-origin kept so in-page Babel/React
          // artifacts can use their own origin storage. Parent is file:// so
          // the iframe cannot touch the Glass session either way.
          `<iframe src="${safeUrl}" sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals" loading="lazy" referrerpolicy="no-referrer"></iframe>` +
          `<div class="md-artifact-code" hidden>` +
          `<div class="md-artifact-code-bar"><span>Component source (JSX)</span>` +
          `<button class="md-code-copy" type="button" data-url="${safeUrl}" aria-label="Copy code">Copy</button></div>` +
          `<pre></pre>` +
          `</div>` +
          `</div>`;
        }
      } else if (isVideo) {
        // Remotion render (lykn_render_video): inline playable mp4 card.
        const vidTitle = altText.slice(altText.indexOf(":") + 1).trim() || "Video";
        const vidFile =
          (vidTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) ||
            "video") + ".mp4";
        if (!isAllowedMediaUrl(mediaUrl)) {
          html += `<p><a href="${escapeAttr(mediaUrl)}" rel="noopener noreferrer">${escapeAttr(vidTitle)} ↗</a></p>`;
        } else {
        const safeUrl = escapeAttr(mediaUrl);
        const safeTitle = escapeAttr(vidTitle);
        const safeFile = escapeAttr(vidFile);
        html +=
          `<div class="md-artifact md-video">` +
          `<div class="md-artifact-head"><span>${safeTitle}</span>` +
          `<span class="md-artifact-actions">` +
          `<button class="md-dl" type="button" data-url="${safeUrl}" data-name="${safeFile}" data-title="${safeTitle}">Download</button>` +
          `<a href="${safeUrl}" rel="noopener noreferrer">Open ↗</a>` +
          `</span></div>` +
          `<video src="${safeUrl}" controls playsinline preload="metadata"></video>` +
          `</div>`;
        }
      } else if (isAllowedMediaUrl(mediaUrl)) {
        const safeUrl = escapeAttr(mediaUrl);
        const safeAlt = escapeAttr(altText);
        html +=
          `<div class="md-img"><img src="${safeUrl}" alt="${safeAlt}" loading="lazy" />` +
          `<div class="md-img-actions">` +
          `<button class="md-edit-image" type="button" data-url="${safeUrl}" data-title="${safeAlt || "Image"}">Edit</button>` +
          `<button class="md-dl md-img-dl" type="button" data-url="${safeUrl}" data-name="" data-title="${safeAlt || "Generated image"}">Download</button>` +
          `</div>` +
          `</div>`;
      } else {
        // Unknown host — show a link instead of dropping the line (avoids
        // silent chart/image loss when a new preview host is introduced).
        const safeUrl = escapeAttr(mediaUrl);
        const safeAlt = escapeAttr(altText || "Open media");
        html += `<p><a href="${safeUrl}" rel="noopener noreferrer">${safeAlt} ↗</a></p>`;
      }
      continue;
    }
    // Mangled chart dumps (model truncated ![alt](https://quickchart…) mid-URL)
    // look like "!Title…%22%2C%22data…&bkg=white)" — hide them; the shell
    // injects a clean markdown image from the tool result when available.
    if (
      /^!/.test(line.trim()) &&
      /(quickchart\.io|kroki\.io|%22%2C%22data|&amp;w=\d|&amp;bkg=white|bkg=white\))/i.test(line)
    ) {
      continue;
    }
    m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flushPara();
      closeList();
      html += `<div class="md-h">${renderInline(m[2])}</div>`;
      continue;
    }
    m = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (m) {
      flushPara();
      if (listType !== "ul") {
        closeList();
        html += "<ul>";
        listType = "ul";
      }
      html += `<li>${renderInline(m[1])}</li>`;
      continue;
    }
    m = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (m) {
      flushPara();
      if (listType !== "ol") {
        closeList();
        html += "<ol>";
        listType = "ol";
      }
      html += `<li>${renderInline(m[1])}</li>`;
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  flushPara();
  closeList();
  return html;
}

